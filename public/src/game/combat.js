// public/src/game/combat.js
// Client combat controller implementing the TPS aiming model exactly:
//
//   1. A ray from the CAMERA through screen center finds the aim POINT
//      (first world/hitbox intersection, or a far point).
//   2. Aim assist may nudge that point toward the nearest enemy hitbox
//      within a small screen-space cone (stronger while ADS).
//   3. The bullet is a hitscan ray from the GUN MUZZLE toward the aim point,
//      so shots line up with the crosshair despite the shoulder offset. The
//      near-wall case is inherent: the server traces from ITS muzzle, so a
//      blocked barrel hits the obstruction.
//   4. Only a direction (+ the remote-timeline timestamp we're rendering)
//      is sent; the SERVER re-resolves the shot and owns all damage.
//
// Also here: reticle slowdown + optional ADS soft-lock (trackpad aim assist),
// client-side spread/bloom/recoil (feel only — the server never applies
// spread, a trade-off noted in the README), and the combat event handlers.

import { WEAPONS, DEFAULT_WEAPON, muzzleFor, targetPoint, rayVsWorld, rayVsPlayer, hasLOS } from '/shared/combat.js';

const DEG = Math.PI / 180;
const _vmuz = { x: 0, y: 0, z: 0 }; // reused muzzle scratch (barrel-tip world pos)

export class Combat {
  // opts: { camera, input, net, remotes, effects, hud, audio, settings,
  //         getPose():{x,y,z,yaw,crouch}, isAlive():bool, onLocalShot() }
  constructor(opts) {
    Object.assign(this, opts);
    this.weapon = WEAPONS[DEFAULT_WEAPON];
    this.bloomDeg = 0;
    this.lastShotAt = -1e9;
    this.localMag = this.weapon.magSize;
    this._autoReloaded = false;
    this._best = null; // current aim-assist candidate {id, angle, point}
    this._registerNet();
  }

  _registerNet() {
    const room = this.net.room;

    room.onMessage('hitconf', (m) => {
      const at = { x: m.at[0], y: m.at[1], z: m.at[2] };
      this.effects.damageNumber(at, m.dmg, m.part === 'head' || m.killed);
      this.effects.impact(at, true);
      this.hud.hitmarker(m.killed);
      if (m.killed) this.audio.kill(); else this.audio.hit();
    });

    room.onMessage('shot', (m) => {
      const to = { x: m.to[0], y: m.to[1], z: m.to[2] };
      if (m.id === this.net.sessionId) return; // own visuals already played
      const ent = this.remotes.map.get(m.id);
      if (ent && ent.lastPose) {
        ent.combatUntil = performance.now() + 1200; // combat stance: face aim
        // flash/tracer from the ACTUAL rendered barrel tip, not the body-offset
        // estimate (which ignores pitch and mismatches the visible gun)
        const muz = (ent.char.getMuzzle && ent.char.getMuzzle(_vmuz)) || muzzleFor(ent.lastPose);
        this.effects.tracer(muz, to);
        this.effects.flash(muz, 0.45);
        ent.char.kick();
        // positional audio: distance + rough stereo pan
        const cp = this.camera.position;
        const dx = muz.x - cp.x, dz = muz.z - cp.z;
        const dist = Math.hypot(dx, muz.y - cp.y, dz);
        const yaw = Math.atan2(-dx, -dz);
        const camYaw = this.input.yaw;
        this.audio.shotAt(dist, Math.sin(yaw - camYaw) * -0.8);
      }
      if (m.wall) this.effects.impact(to, false);
    });

    room.onMessage('kill', (m) => this.hud.killfeed(m));
    room.onMessage('died', (m) => { this.hud.death(m); this.audio.died(); });
    room.onMessage('damaged', () => {
      this.hud.damageFlash();
      this.audio.damaged();
      this.onDamaged && this.onDamaged(); // e.g. local avatar hit-flinch clip
    });
  }

  reload() {
    const self = this.net.myPlayer();
    if (!self || !self.alive || self.reloading) return;
    if (self.mag >= this.weapon.magSize || self.reserve <= 0) return;
    this.net.room.send('reload');
    this.audio.reload();
  }

  // Called once per frame from the main loop.
  update(dt, now, ads) {
    const w = this.weapon;
    this.bloomDeg = Math.max(0, this.bloomDeg - w.bloomDecayDegPerSec * dt);

    const self = this.net.myPlayer();
    if (!self) return;

    // Adopt the authoritative magazine when it advances (reload/respawn).
    if (self.mag >= this.localMag || self.reloading) {
      this.localMag = self.mag;
      if (self.mag > 0) this._autoReloaded = false;
    }

    this._updateAssist(dt, ads);

    // full-auto fire
    if (this.input.fireHeld && this.isAlive() && !self.reloading) {
      if (this.localMag <= 0) {
        if (!this._autoReloaded) { this._autoReloaded = true; this.reload(); }
      } else if (now - this.lastShotAt >= w.intervalMs) {
        this._shoot(now, ads);
      }
    }

    // spread (degrees) -> screen px for the crosshair gap; ADS shows the
    // red-dot sight instead (dead players get neither).
    const spreadRad = this.spreadDeg(ads) * DEG;
    const halfFov = (this.camera.fov / 2) * DEG;
    const px = 4 + (Math.tan(spreadRad) / Math.tan(halfFov)) * (window.innerHeight / 2);
    this.hud.setCrosshair(px);
    this.hud.setAds(ads && this.isAlive());
  }

  spreadDeg(ads) {
    return (ads ? this.weapon.spreadAdsDeg : this.weapon.spreadHipDeg) + this.bloomDeg;
  }

  // ---- aim assist: reticle slowdown + optional gentle ADS soft-lock --------
  _updateAssist(dt, ads) {
    const assist = this.settings.aimAssist;
    this._best = null;
    if (assist <= 0) { this.input.aimSlow = 1; return; }

    const cp = this.camera.position;
    const fx = -Math.sin(this.input.yaw) * Math.cos(this.input.pitch);
    const fy = Math.sin(this.input.pitch);
    const fz = -Math.cos(this.input.yaw) * Math.cos(this.input.pitch);

    let best = null;
    for (const ent of this.remotes.map.values()) {
      const pose = ent.lastPose;
      if (!pose || pose.alive === false) continue;
      const tp = targetPoint(pose);
      const dx = tp.x - cp.x, dy = tp.y - cp.y, dz = tp.z - cp.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 1.5 || dist > 80) continue;
      const dot = (dx * fx + dy * fy + dz * fz) / dist;
      const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
      if (best && angle >= best.angle) continue;
      if (angle > 6 * DEG) continue;
      if (!hasLOS(cp.x, cp.y, cp.z, tp.x, tp.y, tp.z)) continue;
      best = { id: ent.id, angle, point: tp, dist };
    }
    this._best = best;

    // (a) reticle slowdown while the crosshair is over/near an enemy
    const slowCone = (ads ? 5 : 3.8) * DEG;
    this.input.aimSlow = best && best.angle < slowCone ? 1 - 0.5 * assist : 1;

    // (b) gentle soft-lock while ADS: ease the view toward the target
    if (best && ads && this.settings.adsSoftLock && best.angle < 3.2 * DEG && best.angle > 0.15 * DEG) {
      const wantYaw = Math.atan2(-(best.point.x - cp.x), -(best.point.z - cp.z));
      const horiz = Math.hypot(best.point.x - cp.x, best.point.z - cp.z);
      const wantPitch = Math.atan2(best.point.y - cp.y, horiz);
      const ease = Math.min(1, dt * 3.0 * assist) * (1 - best.angle / (3.2 * DEG));
      this.input.yaw += shortAngle(wantYaw - this.input.yaw) * ease;
      this.input.pitch += (wantPitch - this.input.pitch) * ease;
    }
  }

  // ---- one shot --------------------------------------------------------------
  _shoot(now, ads) {
    const w = this.weapon;
    const cp = this.camera.position;
    const fx = -Math.sin(this.input.yaw) * Math.cos(this.input.pitch);
    const fy = Math.sin(this.input.pitch);
    const fz = -Math.cos(this.input.yaw) * Math.cos(this.input.pitch);

    // 1) aim point: camera-center ray vs world and hitboxes
    let aimT = rayVsWorld(cp.x, cp.y, cp.z, fx, fy, fz, w.range);
    for (const ent of this.remotes.map.values()) {
      const pose = ent.lastPose;
      if (!pose || pose.alive === false) continue;
      const hit = rayVsPlayer(cp.x, cp.y, cp.z, fx, fy, fz, pose, w.range);
      if (hit && hit.t < aimT) aimT = hit.t;
    }
    if (!Number.isFinite(aimT)) aimT = w.range;
    let ax = cp.x + fx * aimT, ay = cp.y + fy * aimT, az = cp.z + fz * aimT;

    // 2) bullet magnetism: pull the aim point toward the assist candidate
    const assist = this.settings.aimAssist;
    const magnetCone = (ads ? 3.4 : 2.4) * DEG;
    if (this._best && assist > 0 && this._best.angle < magnetCone) {
      const k = assist * (ads ? 0.55 : 0.4) * (1 - this._best.angle / magnetCone);
      ax += (this._best.point.x - ax) * k;
      ay += (this._best.point.y - ay) * k;
      az += (this._best.point.z - az) * k;
    }

    // 3) bullet ray: muzzle -> (assisted) aim point, plus spread
    const pose = this.getPose();
    const muz = muzzleFor(pose);
    let dx = ax - muz.x, dy = ay - muz.y, dz = az - muz.z;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const spread = this.spreadDeg(ads) * DEG;
    if (spread > 0) {
      const d = jitterCone(dx, dy, dz, spread);
      dx = d.x; dy = d.y; dz = d.z;
    }

    // 4) fire: origin (our rendered muzzle) + direction; the server validates
    //    the origin sits at our muzzle and re-resolves the hit + all damage
    this.net.room.send('fire', {
      o: [muz.x, muz.y, muz.z],
      d: [dx, dy, dz],
      t: this.remotes.renderTime(now),
    });

    // ---- immediate local feedback ----
    let endT = rayVsWorld(muz.x, muz.y, muz.z, dx, dy, dz, w.range);
    let onPlayer = false;
    for (const ent of this.remotes.map.values()) {
      const p2 = ent.lastPose;
      if (!p2 || p2.alive === false) continue;
      const hit = rayVsPlayer(muz.x, muz.y, muz.z, dx, dy, dz, p2, w.range);
      if (hit && hit.t < endT) { endT = hit.t; onPlayer = true; }
    }
    if (!Number.isFinite(endT)) endT = w.range;
    const end = { x: muz.x + dx * endT, y: muz.y + dy * endT, z: muz.z + dz * endT };
    // visual flash/tracer from the rendered barrel tip (falls back to the
    // computed muzzle); the SHOT origin sent to the server stays as `muz`.
    const vmuz = (this.getMuzzle && this.getMuzzle(_vmuz)) || muz;
    this.effects.tracer(vmuz, end);
    this.effects.flash({ x: vmuz.x + dx * 0.05, y: vmuz.y + dy * 0.05, z: vmuz.z + dz * 0.05 });
    if (!onPlayer && endT < w.range) this.effects.impact(end, false);
    this.audio.shot();

    // recoil + bloom (feel)
    this.input.pitch = Math.min(1.55, this.input.pitch + w.recoilPitch);
    this.input.yaw += (Math.random() - 0.5) * 2 * w.recoilYawJitter;
    this.bloomDeg = Math.min(w.bloomMaxDeg, this.bloomDeg + w.bloomPerShotDeg);

    this.localMag -= 1;
    this.lastShotAt = now;
    this.onLocalShot && this.onLocalShot();
  }
}

function shortAngle(d) {
  d = d % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function jitterCone(dx, dy, dz, maxAngle) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * maxAngle;
  let ux = -dz, uy = 0, uz = dx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uz /= ul;
  const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  const sa = Math.sin(r), ca = Math.cos(r);
  const ox = dx * ca + (ux * Math.cos(a) + vx * Math.sin(a)) * sa;
  const oy = dy * ca + (uy * Math.cos(a) + vy * Math.sin(a)) * sa;
  const oz = dz * ca + (uz * Math.cos(a) + vz * Math.sin(a)) * sa;
  const len = Math.hypot(ox, oy, oz) || 1;
  return { x: ox / len, y: oy / len, z: oz / len };
}
