// public/src/game/clipavatar.js
// Clip-driven avatar: a character whose skeleton matches the shared mixamo
// animation library gets REAL animation instead of procedural bone swings.
//
// Locomotion base (looping, crossfaded):
//   idle  -> 'rifle_idle' (a rifle-ready stand) if present, else 'idle', else
//            a frozen 'rifle_run_to_stop' final pose as a last resort
//   run   -> 'run_forward', playback rate tied to actual speed (gently, so it
//            never fast-forwards into a clunky sprint). Body yaw already faces
//            velocity, so one forward run covers strafes/backpedal in stance.
//
// Firing is NOT a full-body clip. The mixamo 'firing_rifle' clip rewrites the
// whole upper body every shot — at 10 rounds/s that thrashes the torso and
// flings the off-hand, and (because the rifle is parented to the hand) points
// the barrel wherever the clip's hand goes (down). Instead kick() adds a small
// ADDITIVE recoil punch on top of the stable idle/run pose: the rifle recoils
// and the shoulders snap back a touch, then settle. Tracers/flash/audio come
// from the effects system, so the gun keeps pointing where the idle/run pose
// holds it — forward, at the crosshair.
//
//   flinch() -> 'hit_react' one-shot (occasional, standing only) — kept, since
//               it fires rarely and reads as a real reaction.
//   dead     -> 'dying' plays through in full (clamped on the ground); the
//               grave marker only replaces the body AFTER the fall has settled.
//
// Aim: spine/head lean is applied ADDITIVELY after mixer.update — the mixer
// rewrites those bones every frame from the active looping clip, so additive
// can't accumulate.
//
// All library clips had their hips X/Z travel stripped at load (netcode owns
// position; un-stripped mixamo clips would walk the model away from it).

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { MOVE, COMBAT } from '/shared/constants.js';
import { makeNameSprite } from './character.js';
import { bindRig, attachMuzzle } from './rigbind.js';

const CROSSFADE = 0.2;

export class ClipAvatar {
  // tpl: { root, scale, offX, offY, offZ }  animLib: Map<key, AnimationClip>
  constructor(scene, tpl, animLib, opts = {}) {
    this.scene = scene;

    this.root = new THREE.Group();
    this.pivot = new THREE.Group();
    this.pivot.rotation.y = Math.PI; // glTF/mixamo +Z forward -> engine -Z
    this.model = SkeletonUtils.clone(tpl.root);
    this.model.scale.setScalar(tpl.scale);
    this.model.position.set(tpl.offX, tpl.offY, tpl.offZ);
    this.pivot.add(this.model);
    this.root.add(this.pivot);

    // rig facts (rifle mount, spine/head lean axes)
    this.rig = bindRig(this.model);
    this._baseModelY = this.model.position.y;
    this.modelScale = tpl.scale; // world metres per clip unit — for foot-sync

    // --- mixer + actions ---
    this.mixer = new THREE.AnimationMixer(this.model);
    const action = (key, cfg = {}) => {
      const clip = animLib.get(key);
      if (!clip) return null;
      const a = this.mixer.clipAction(clip);
      if (cfg.once) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      return a;
    };

    this.runAction = action('run_forward');
    this.deathAction = action('dying', { once: true });
    this.hitAction = action('hit_react', { once: true });

    // idle: the lobby preview can request a gender-specific idle (idle_m/idle_w);
    // in-game it's the rifle-ready idle, else a plain idle, else freeze the
    // run-to-stop ending so a clip-less model still holds still.
    this.idleAction = (opts.lobbyIdle && action(opts.lobbyIdle)) || action('rifle_idle') || action('idle');
    this._idleFrozen = false;
    if (!this.idleAction) {
      const src = action('rifle_run_to_stop') || action('rifle_idle');
      if (src) {
        src.play();
        src.paused = true;
        src.time = Math.max(0, src.getClip().duration - 0.05);
        this.idleAction = src;
        this._idleFrozen = true;
      }
    }

    // crouch stance (optional): a crouched idle + a rifle crouch-walk. Missing
    // clips fall back to standing locomotion + a model sink.
    this.crouchIdleAction = action('crouch_idle') || action('idle_crouching');
    this.crouchWalkAction = action('crouch_walk') || action('rifle_crouch_walk');

    // Only the standing idle plays its own arms (a real rifle-holding idle with
    // subtle breathing). EVERY moving mixamo clip (run, crouch idle, crouch
    // walk) swings the arms, so we pin its arms to the rifle-ready pose (below)
    // to keep the gun steady — measured: crouch_walk swings the arms MORE than
    // crouch_idle, so it must be pinned too (and pinning both avoids a pop at
    // the crouch-idle/crouch-walk boundary).
    this._rifleActions = new Set([this.idleAction].filter(Boolean));

    this._base = null;        // current looping base action
    this._overlay = null;     // one-shot (hit_react) currently overriding base
    this._dead = false;
    this._deadFor = 0;
    this._recoil = 0;         // firing punch, decays to 0
    this._armHold = 0;        // 0..1 blend pinning arms to the rifle-ready pose
    this._idleArmPose = null; // captured in _seatRifleToIdlePose
    this._kickDir = null;     // barrel-axis recoil direction (hand-bone frame)
    this._gripRest = null;    // gun rest position (rear grip at the hand)
    this._kickStep = 0.05;    // recoil travel per unit (scaled per rig)
    this._crouched = false;

    if (this.idleAction && !this._idleFrozen) this.idleAction.play();
    this._setBase(this.idleAction, 0);

    this.mixer.addEventListener('finished', (e) => {
      if (e.action === this._overlay) {
        this._overlay.fadeOut(0.14);
        this._overlay = null;
        this._fadeInBase();
      }
    });

    // --- rifle on the hand mount (skipped in the lobby preview) ---
    if (this.rig.rifleMount && !opts.lobby) {
      const m = this.rig.rifleMount;
      const rifle = (opts.props && opts.props.makeGun(0.7)) || null;
      if (rifle) {
        rifle.scale.multiplyScalar(m.scale);
        rifle.quaternion.copy(m.quat);
        m.bone.add(rifle);
        this.rifle = rifle;
        // rigbind aligns the barrel forward at the lowered-arm REST pose — but
        // the clips rewrite the hand every frame, so at the real grip the gun
        // pointed off (vertical, beside the body). Re-derive the hand->rifle
        // offset from an actual rifle_idle frame so the barrel sits forward in
        // the hands. Same formula rigbind uses (barrel -Z -> model +Z via a
        // 180° yaw), just sampled at the grip pose instead of rest.
        this._seatRifleToIdlePose(m.bone);
        this._muzzle = attachMuzzle(this.rifle); // real barrel tip for flash/tracers
      }
    }

    this.props = opts.props || null;
    this.graveMesh = null;
    this._graveShown = false;

    if (opts.showName !== false && opts.name) {
      this.nameSprite = makeNameSprite(opts.name);
      this.root.add(this.nameSprite);
    }

    this.shadow = null;
    if (opts.blobShadows) {
      this.shadow = new THREE.Mesh(
        new THREE.CircleGeometry(0.42, 20),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false })
      );
      this.shadow.rotation.x = -Math.PI / 2;
      this.shadow.position.y = 0.025;
      scene.add(this.shadow);
    }

    this.model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(this.root);

    // spawn shield: a glowing blue aura while spawn-protected
    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 18, 12),
      new THREE.MeshBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    this.shield.position.y = 0.95;
    this.shield.visible = false;
    this.root.add(this.shield);

    this.bodyYaw = 0;
    this._moving = false;
  }

  // Seat the attached rifle for the REAL grip: pose the skeleton at a stable
  // rifle_idle frame, read the mount bone's world orientation there, and set
  // the rifle's local quaternion so its barrel points model-forward at THAT
  // pose. Every rifle clip keeps a consistent grip, so it then tracks the hand
  // correctly across idle/run/aim instead of only at the (never-shown) rest.
  _seatRifleToIdlePose(bone) {
    if (!this.idleAction || !this.rifle) return;
    const clip = this.idleAction.getClip();
    const savedT = this.idleAction.time;
    if (!this._idleFrozen) this.idleAction.time = Math.min(0.5, (clip.duration || 1) * 0.5);
    this.mixer.update(0);                       // apply the idle pose to the bones
    this.model.updateWorldMatrix(true, true);
    // Barrel must point where the BODY faces (engine -Z). Setting the rifle's
    // WORLD orientation to identity does that (the gun's barrel is -Z, up +Y);
    // the earlier quat(Y,PI) pointed it backward (+Z, toward the camera).
    const handWorld = bone.getWorldQuaternion(new THREE.Quaternion());
    this.rifle.quaternion.copy(handWorld.invert());

    // recoil direction = the gun's own local +Z (barrel is -Z, so +Z is "back
    // toward the shooter"), expressed in the hand-bone frame. Kicking along
    // THIS instead of the raw local Z keeps the kick straight back regardless
    // of how the hand bone is oriented.
    this._kickDir = new THREE.Vector3(0, 0, 1).applyQuaternion(this.rifle.quaternion);

    // Grip offset: mixamo hands grip the gun's CENTRE, so the right hand looks
    // like it's on the foregrip. Shift the gun FORWARD along the barrel (-kick
    // direction) so the rear grip sits at the hand. Scaled into the hand-bone
    // frame (m.scale = 1/boneWorldScale) so it's ~0.12m in world on any rig.
    const gscale = (this.rig.rifleMount && this.rig.rifleMount.scale) || 1;
    this._gripRest = this._kickDir.clone().multiplyScalar(-0.12 * gscale);
    this._kickStep = 0.05 * gscale;
    this.rifle.position.copy(this._gripRest);

    // Capture the rifle-ready ARM pose (local quats) so we can pin the arms to
    // it while the free-arm run/crouch-idle clips play — stops the gun flailing.
    this._idleArmPose = [];
    for (const key of ['shoulderL', 'shoulderR', 'armL', 'armR', 'forearmL', 'forearmR', 'handL', 'handR']) {
      const b = this.rig.bones[key];
      if (b) this._idleArmPose.push({ bone: b, quat: b.quaternion.clone() });
    }

    this.idleAction.time = savedT;              // restore a clean idle start
    this.mixer.update(0);
  }

  // World position of the rendered gun's barrel tip (for muzzle flash/tracers).
  // Writes into `out` ({x,y,z}); returns out, or null if no rifle is attached.
  getMuzzle(out) {
    if (!this._muzzle) return null;
    this._muzzle.getWorldPosition(_tmpV);
    out.x = _tmpV.x; out.y = _tmpV.y; out.z = _tmpV.z;
    return out;
  }

  // ---- events ---------------------------------------------------------------
  // Firing: a light additive punch, NOT a full-body clip (see file header).
  kick() {
    this._recoil = 1;
  }

  flinch() {
    this._playOverlay(this.hitAction);
  }

  _playOverlay(a) {
    // overlays are standing, full-body clips: only while alive, still, upright.
    if (!a || this._dead || this._moving || this._crouched || this._overlay === a) return;
    this._overlay = a;
    if (this._base) this._base.fadeOut(0.08);
    a.reset().fadeIn(0.08).play();
  }

  _setBase(a, fade = CROSSFADE) {
    if (!a || this._base === a) return;
    const prev = this._base;
    this._base = a;
    if (this._overlay) return; // base takes over visually once overlay ends
    if (prev) prev.fadeOut(fade);
    if (this._idleFrozen && a === this.idleAction) {
      a.paused = true;
      a.enabled = true;
      a.fadeIn(fade);
    } else {
      a.reset().fadeIn(fade).play();
    }
  }

  _fadeInBase() {
    if (!this._base) return;
    if (this._idleFrozen && this._base === this.idleAction) {
      this._base.enabled = true;
      this._base.fadeIn(0.14);
      this._base.paused = true;
    } else {
      this._base.reset().fadeIn(0.14).play();
    }
  }

  // ---- per-frame --------------------------------------------------------------
  update(dt, pose) {
    this.root.position.set(pose.x, pose.y, pose.z);
    if (this.shadow) {
      this.shadow.position.x = pose.x;
      this.shadow.position.z = pose.z;
      this.shadow.material.opacity = 0.32 * Math.max(0.25, 1 - pose.y / 2.5);
    }

    const alive = pose.alive !== false;

    // spawn shield aura (pulses/rotates while protected)
    if (this.shield) {
      const on = pose.protected === true && alive;
      this.shield.visible = on;
      if (on) {
        this.shield.rotation.y += dt * 1.6;
        this.shield.material.opacity = 0.15 + 0.1 * Math.sin(performance.now() * 0.006);
      }
    }

    // --- death: play the FULL dying clip, then swap to the grave ---
    if (!alive) {
      if (!this._dead) {
        this._dead = true;
        this._deadFor = 0;
        this._recoil = 0;
        // crossfade INTO the fall from the last living pose (no stopAllAction
        // snap — that popped the body to the death clip's standing frame 0).
        if (this.deathAction) {
          if (this._base) this._base.fadeOut(0.12);
          if (this._overlay) this._overlay.fadeOut(0.12);
          this._overlay = null;
          this.deathAction.reset().fadeIn(0.12).play();
        }
      }
      this._deadFor += dt;
      // un-sink: if we died in the clip-less crouch fallback the model was
      // lowered 0.3m; ease it back so the fall lands ON the ground, not in it.
      this.model.position.y += (this._baseModelY - this.model.position.y) * Math.min(1, dt * 8);
      this.mixer.update(dt);
      // only replace the body with the grave once the fall has hit the ground
      // (never mid-fall — the old code cut at a fixed 2.0s while this 4.4s
      // 'dying' clip was <40% down). The body is grounded ~68% through the
      // clip; clamp the marker safely before the server respawns us so it's
      // actually seen and never overlaps a live body.
      const dur = this.deathAction ? this.deathAction.getClip().duration : 0;
      const respawnS = (COMBAT && COMBAT.RESPAWN_MS ? COMBAT.RESPAWN_MS : 4000) / 1000;
      const graveAt = this.deathAction
        ? Math.min(dur * 0.68, respawnS - 0.7)
        : 0;
      if (this._deadFor >= graveAt) this._updateGrave(false, pose);
      return;
    }

    if (this._dead) {
      // respawned: restore the body and the base state
      this._dead = false;
      this._updateGrave(true, pose);
      this.mixer.stopAllAction();
      this._base = null;
      this._overlay = null;
      this._recoil = 0;
      if (this._idleFrozen) {
        this.idleAction.play();
        this.idleAction.paused = true;
        this.idleAction.time = Math.max(0, this.idleAction.getClip().duration - 0.05);
      } else if (this.idleAction) {
        this.idleAction.play();
      }
      this._setBase(this.idleAction, 0);
    }

    const speed = Math.hypot(pose.vx, pose.vz);
    const speedN = Math.min(1, speed / MOVE.RUN);

    // body yaw: while MOVING, face the direction of travel — the forward-run
    // clip's feet then always match the motion (no sideways/backward foot slide,
    // no facing snap when firing stops mid-strafe). Only face aim when standing
    // still (so aiming/firing in place still reads). Shots stay accurate: they
    // fire from the muzzle toward the crosshair regardless of body facing.
    let targetYaw = this.bodyYaw;
    if (speed > 0.6) targetYaw = Math.atan2(-pose.vx, -pose.vz);
    else if (pose.ads || pose.combat) targetYaw = pose.yaw;
    this.bodyYaw = lerpAngle(this.bodyYaw, targetYaw, 1 - Math.exp(-dt * 10));
    this.root.rotation.y = this.bodyYaw;

    this._crouched = pose.crouch; // gate the standing hit-react overlay

    // locomotion state with hysteresis (needed before we pick the crouch clip)
    if (this._moving) { if (speedN < 0.06) this._moving = false; }
    else if (speedN > 0.15) this._moving = true;

    // pick the base clip for stance x motion. Crouch uses its clip for THIS
    // motion when present; else fall back to standing locomotion + a model sink
    // so a clip-less character still reads as crouched. Gentle rate on the
    // moving clips: tie stride to speed, never fast-forward into a sprint.
    const crouchClip = pose.crouch ? (this._moving ? this.crouchWalkAction : this.crouchIdleAction) : null;
    let want;
    if (pose.crouch) want = crouchClip || (this._moving ? this.runAction : this.idleAction);
    else             want = this._moving ? this.runAction : this.idleAction;
    if (this._moving && want) {
      // foot-sync: play the clip so its stride matches the ACTUAL ground speed
      // (feet don't slide). clipSpeed = how fast the clip's hips travel at our
      // scale; fall back to a gentle speed-scaled rate for in-place clips.
      const ud = want.getClip().userData;
      const clipSpeed = ud && ud.travelUnits ? (ud.travelUnits * this.modelScale) / (want.getClip().duration || 1) : 0;
      want.timeScale = clipSpeed > 0.05
        ? THREE.MathUtils.clamp(speed / clipSpeed, 0.6, 2.0)
        : THREE.MathUtils.clamp(0.7 + speedN * 0.35, 0.7, 1.05);
      if (this._overlay) { this._overlay.fadeOut(0.1); this._overlay = null; }
    }
    this._setBase(want || this.idleAction);

    // crouch height: the crouch clip lowers the body itself; sink the model
    // only when the crouch clip for THIS motion is missing (clip-less fallback).
    const sink = (pose.crouch && !crouchClip) ? -0.3 : 0;
    this.model.position.y += (this._baseModelY + sink - this.model.position.y) * Math.min(1, dt * 14);

    this.mixer.update(dt);

    // Pin the arms to the rifle-ready pose during locomotion (run, crouch idle
    // AND crouch walk): the mixamo movement clips swing the arms and fling the
    // gun around the body. Only the standing idle is exempt (it holds the rifle
    // natively). Ramps in/out for smooth start/stop; skipped while a full-body
    // overlay (hit) plays. Legs and torso keep the clip's motion.
    const wantHold = (this._base && this.rifle && !this._overlay && !this._rifleActions.has(this._base)) ? 0.82 : 0;
    this._armHold += (wantHold - this._armHold) * Math.min(1, dt * 8);
    if (this._armHold > 0.01 && this._idleArmPose) {
      for (const a of this._idleArmPose) a.bone.quaternion.slerp(a.quat, this._armHold);
    }

    // additive aim lean on top of the mixer pose (mixer resets these bones
    // each frame from the active clip, so this can't accumulate)
    const recoilLean = -this._recoil * 0.1;   // torso braces/rises back on fire
    this._lean('spine', -pose.pitch * 0.3 + speedN * 0.08 + recoilLean);
    this._lean('head', -pose.pitch * 0.35);

    // firing recoil: rifle kicks straight back along the barrel from the grip
    // rest position, decays
    if (this._recoil > 0) {
      this._recoil = Math.max(0, this._recoil - dt * 7);
      if (this.rifle && this._gripRest) this.rifle.position.copy(this._gripRest).addScaledVector(this._kickDir, this._recoil * this._kickStep);
    }
  }

  _lean(key, angle) {
    const bone = this.rig.bones[key];
    const axis = this.rig.axes[key];
    if (!bone || !axis) return;
    _tmpQ.setFromAxisAngle(axis, angle);
    bone.quaternion.multiply(_tmpQ);
  }

  _updateGrave(alive, pose) {
    if (!alive && !this._graveShown) {
      if (!this.graveMesh && this.props) {
        this.graveMesh = this.props.makeGrave();
        if (this.graveMesh) this.scene.add(this.graveMesh);
      }
      if (this.graveMesh) {
        this.graveMesh.position.set(pose.x, 0, pose.z);
        this.graveMesh.rotation.y = Math.random() * Math.PI * 2;
        this.graveMesh.visible = true;
        this.root.visible = false;
        if (this.shadow) this.shadow.visible = false;
        this._graveShown = true;
      }
    } else if (alive && this._graveShown) {
      this.graveMesh.visible = false;
      this.root.visible = true;
      if (this.shadow) this.shadow.visible = true;
      this._graveShown = false;
    }
  }

  dispose() {
    this.scene.remove(this.root);
    if (this.shadow) {
      this.scene.remove(this.shadow);
      this.shadow.geometry.dispose();
      this.shadow.material.dispose();
    }
    if (this.graveMesh) this.scene.remove(this.graveMesh);
    if (this.nameSprite) {
      this.nameSprite.material.map.dispose();
      this.nameSprite.material.dispose();
    }
    // geometry/materials are shared with the template — never dispose here
  }
}

const _tmpQ = new THREE.Quaternion();
const _tmpV = new THREE.Vector3();

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
