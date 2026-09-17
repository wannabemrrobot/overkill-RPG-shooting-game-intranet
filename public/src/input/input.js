// public/src/input/input.js
// Trackpad-first input: pointer-lock look + rebindable keyboard movement.
//
// Look pipeline (per event -> per frame):
//   raw movementX/Y
//     -> per-event dead zone   (drops resting-finger subpixel noise)
//     -> accumulate for frame
//   per frame:
//     -> base sensitivity      (settings.sens)
//     -> flick acceleration    (gain grows with swipe speed: fast flick turns
//                               far more than a slow drag -> 180s fit on a pad)
//     -> ADS fov scaling       (aim feel constant across zoom levels)
//     -> steady-aim damper     (briefly soften look right after a click, to
//                               cancel the wobble a trackpad press causes)
//     -> smoothing EMA         (frame-rate independent; hides tap jitter)
//     -> invert-Y, integrate yaw/pitch (pitch clamped)
//
// Movement intent is sampled per fixed step by sampleStep() — edges (jump)
// are latched between steps so a fast tap can never fall between samples.

import { MOVE } from '/shared/constants.js';
import { wrapAngle } from '/shared/movement.js';

const DEADZONE_PX = 0.06;     // per-event; trackpad noise floor
const BASE_RAD_PER_PX = 0.0022;
const ACCEL_REF_SPEED = 700;  // px/s where acceleration starts to matter
const ACCEL_MAX_GAIN = 2.8;   // cap so a violent flick can't spin the world
const STEADY_HOLD_MS = 70;    // full damping right after click...
const STEADY_RAMP_MS = 110;   // ...then ease back to normal
const STEADY_SCALE = 0.4;

export class Input {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;

    this.locked = false;
    this.onLockChange = null;   // (locked:boolean) => void
    this.onLockError = null;    // () => void
    this.onSwapShoulder = null; // () => void

    // Look state
    this.yaw = 0;
    this.pitch = 0;
    this.fovScale = 1;          // camera sets this while ADS zooms
    this.aimSlow = 1;           // combat sets <1 while crosshair is on a target
    this.onReload = null;       // () => void
    this._rawDX = 0; this._rawDY = 0;
    this._outDX = 0; this._outDY = 0; // smoothed per-frame deltas
    this._speedEma = 0;         // px/s swipe speed estimate
    this._steadyAt = -1e9;      // timestamp of last primary press

    // Keyboard state
    this._down = new Set();     // KeyboardEvent.code currently held
    this._codeToAction = {};
    this.refreshBinds();

    // Latched/toggled intents
    this._jumpLatch = false;
    this._crouchToggled = false;
    this._adsToggled = false;
    this._scopeToggled = false;
    this._interactLatch = false; // F press (resupply at the ammo table)
    this.fireHeld = false;      // Phase 2 consumes this
    this.scoreboardHeld = false;

    this._bindDom();
  }

  // ---- pointer lock ---------------------------------------------------------
  // Never fail silently: every dead-end reports through onLockError(reason)
  // so the UI can tell the player exactly what's wrong.
  requestLock() {
    const el = this.canvas;
    if (typeof el.requestPointerLock !== 'function') {
      this.onLockError && this.onLockError('unsupported');
      return;
    }
    const plain = () => {
      try {
        const q = el.requestPointerLock();
        if (q && typeof q.catch === 'function') {
          q.catch(() => this.onLockError && this.onLockError('denied'));
        }
      } catch {
        this.onLockError && this.onLockError('denied');
      }
    };
    try {
      // unadjustedMovement disables OS pointer accel where supported (Chrome).
      // Safari ignores the options argument; some builds throw — fall back.
      const p = el.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') p.catch(plain);
    } catch {
      plain();
    }
  }

  _bindDom() {
    const doc = document;

    doc.addEventListener('pointerlockchange', () => {
      this.locked = doc.pointerLockElement === this.canvas;
      if (!this.locked) {
        // Menu open: drop transient intents so nothing "sticks" while paused.
        this._rawDX = this._rawDY = 0;
        this.fireHeld = false;
        this._jumpLatch = false;
      }
      this.onLockChange && this.onLockChange(this.locked);
    });

    doc.addEventListener('pointerlockerror', () => {
      // Chrome enforces ~1.25s cooldown between unlock and next lock; embedded
      // webviews may deny pointer lock outright via permissions policy.
      this.onLockError && this.onLockError('denied');
    });

    doc.addEventListener('pointermove', (e) => {
      if (!this.locked) return;
      const dx = e.movementX, dy = e.movementY;
      if (Math.abs(dx) < DEADZONE_PX && Math.abs(dy) < DEADZONE_PX) return;
      this._rawDX += dx;
      this._rawDY += dy;
    });

    doc.addEventListener('pointerdown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) {
        this._steadyAt = performance.now();
        if (this.settings.fireMode === 'click') this.fireHeld = true;
      }
    });
    doc.addEventListener('pointerup', (e) => {
      if (e.button === 0 && this.settings.fireMode === 'click') this.fireHeld = false;
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    doc.addEventListener('keydown', (e) => {
      if (!this.locked) return;                 // menus own the keyboard
      // interact (resupply) — direct code check so it can share the fire key
      if (!e.repeat && e.code === (this.settings.binds.interact || 'KeyF')) { this._interactLatch = true; e.preventDefault(); }
      const action = this._codeToAction[e.code];
      if (action) e.preventDefault();           // Tab/Space etc. stay in-game
      if (e.repeat || !action) return;
      this._down.add(e.code);
      switch (action) {
        case 'jump': this._jumpLatch = true; break;
        case 'crouch': if (this.settings.crouchToggle) this._crouchToggled = !this._crouchToggled; break;
        case 'ads': if (this.settings.adsToggle) this._adsToggled = !this._adsToggled; break;
        case 'scope': if (this.settings.adsToggle) this._scopeToggled = !this._scopeToggled; break;
        case 'swap': this.onSwapShoulder && this.onSwapShoulder(); break;
        case 'reload': this.onReload && this.onReload(); break;
        case 'fireKey': if (this.settings.fireMode === 'key') this.fireHeld = true; break;
        case 'scoreboard': this.scoreboardHeld = true; break;
      }
    });

    doc.addEventListener('keyup', (e) => {
      this._down.delete(e.code);
      const action = this._codeToAction[e.code];
      if (action === 'fireKey' && this.settings.fireMode === 'key') this.fireHeld = false;
      if (action === 'scoreboard') this.scoreboardHeld = false;
    });

    // Tab-away safety: clear all held state.
    window.addEventListener('blur', () => {
      this._down.clear();
      this.fireHeld = false;
      this.scoreboardHeld = false;
    });
  }

  refreshBinds() {
    this._codeToAction = {};
    for (const [action, code] of Object.entries(this.settings.binds)) {
      if (action === 'interact') continue; // handled directly (may share the fire key)
      this._codeToAction[code] = action;
    }
    // Both shifts feel identical for the walk modifier.
    if (this.settings.binds.walkMod === 'ShiftLeft') this._codeToAction['ShiftRight'] = 'walkMod';
  }

  _held(action) {
    const code = this.settings.binds[action];
    if (this._down.has(code)) return true;
    return action === 'walkMod' && code === 'ShiftLeft' && this._down.has('ShiftRight');
  }

  // ---- per-frame look integration -------------------------------------------
  update(dt) {
    const s = this.settings;
    const dx = this._rawDX, dy = this._rawDY;
    this._rawDX = 0; this._rawDY = 0;

    // Swipe speed estimate (px/s) — EMA so single-event spikes don't whiplash.
    const mag = Math.hypot(dx, dy);
    const inst = dt > 0 ? mag / dt : 0;
    this._speedEma += (inst - this._speedEma) * Math.min(1, dt * 12);

    // Flick acceleration gain.
    let gain = 1;
    if (s.accelOn && s.accel > 0) {
      const t = Math.pow(Math.max(0, this._speedEma / ACCEL_REF_SPEED), 1.2);
      gain = 1 + Math.min(t * s.accel * 1.8, ACCEL_MAX_GAIN - 1);
    }

    // Steady-aim damper right after a click.
    const since = performance.now() - this._steadyAt;
    let steady = 1;
    if (since < STEADY_HOLD_MS) steady = STEADY_SCALE;
    else if (since < STEADY_HOLD_MS + STEADY_RAMP_MS) {
      const k = (since - STEADY_HOLD_MS) / STEADY_RAMP_MS;
      steady = STEADY_SCALE + (1 - STEADY_SCALE) * k;
    }

    const scale = BASE_RAD_PER_PX * s.sens * gain * steady * this.fovScale * this.aimSlow;
    const tx = dx * scale;
    const ty = dy * scale * (s.invertY ? -1 : 1);

    // Frame-rate-independent smoothing EMA over the delta stream.
    const tau = s.smooth * 0.045; // 0..36ms
    if (tau < 0.001) {
      this._outDX = tx; this._outDY = ty;
    } else {
      const a = 1 - Math.exp(-dt / tau);
      this._outDX += (tx - this._outDX) * a;
      this._outDY += (ty - this._outDY) * a;
    }

    this.yaw = wrapAngle(this.yaw - this._outDX);
    this.pitch = Math.max(-MOVE.MAX_PITCH, Math.min(MOVE.MAX_PITCH, this.pitch - this._outDY));
  }

  // ---- fixed-step movement sample -------------------------------------------
  // Neutral while unlocked (menu open) so the character brakes to a stop but
  // physics/reconciliation keep flowing.
  sampleStep(seq) {
    const s = this.settings;
    const live = this.locked;

    const mx = live ? (this._held('right') ? 1 : 0) - (this._held('left') ? 1 : 0) : 0;
    const mz = live ? (this._held('forward') ? 1 : 0) - (this._held('back') ? 1 : 0) : 0;

    const crouch = live && (s.crouchToggle ? this._crouchToggled : this._held('crouch'));
    // Scope is "ADS+": it forces ads on (server speed-cap + aim assist + remote
    // stance all treat it as aiming), and the client layers on a deeper zoom +
    // scope reticle. So no new field crosses the wire.
    const scope = live && (s.adsToggle ? this._scopeToggled : this._held('scope'));
    const ads = scope || (live && (s.adsToggle ? this._adsToggled : this._held('ads')));

    // autoRun ON: default run, Shift = walk. OFF: default walk, Shift = run.
    const shiftHeld = live && this._held('walkMod');
    const walk = s.autoRun ? shiftHeld : !shiftHeld;

    const jump = live && this._jumpLatch;
    this._jumpLatch = false;

    return { seq, mx, mz, yaw: this.yaw, pitch: this.pitch, jump, crouch, walk, ads };
  }

  get ads() {
    return this.settings.adsToggle ? this._adsToggled : this._held('ads');
  }

  get scope() {
    return this.settings.adsToggle ? this._scopeToggled : this._held('scope');
  }

  // Consume a single interact (F) press; returns true once per press.
  takeInteract() {
    const v = this._interactLatch;
    this._interactLatch = false;
    return v;
  }
}
