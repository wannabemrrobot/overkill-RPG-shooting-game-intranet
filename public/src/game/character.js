// public/src/game/character.js
// Procedural low-poly humanoid (no external assets) with procedural
// locomotion: leg/arm swing driven by horizontal speed, jump tuck, crouch
// pose, ADS arm raise, and pitch hints so remotes can read where a player
// aims. Rounded capsule/sphere construction + a rifle prop so the silhouette
// reads "shooter", not "crash-test dummy". Phase 4 upgrades this to real
// male/female rigs + skins behind the same update() interface.
//
// Geometry is shared module-wide (one set of BufferGeometries total);
// materials are per-character (team/skin colours later).

import * as THREE from 'three';
import { MOVE } from '/shared/constants.js';

const G = {
  hips: new THREE.CapsuleGeometry(0.155, 0.1, 3, 10),
  torso: new THREE.CapsuleGeometry(0.175, 0.3, 3, 10),
  head: new THREE.SphereGeometry(0.115, 14, 12),
  arm: new THREE.CapsuleGeometry(0.05, 0.4, 3, 8),
  thigh: new THREE.CapsuleGeometry(0.068, 0.3, 3, 8),
  shin: new THREE.CapsuleGeometry(0.055, 0.3, 3, 8),
  foot: new THREE.BoxGeometry(0.09, 0.07, 0.2),
  rifleBody: new THREE.BoxGeometry(0.045, 0.07, 0.52),
  rifleBarrel: new THREE.CylinderGeometry(0.014, 0.014, 0.3, 6),
  rifleMag: new THREE.BoxGeometry(0.035, 0.12, 0.05),
  shadow: new THREE.CircleGeometry(0.42, 20),
};
G.foot.translate(0, 0, -0.05);           // toes forward of the ankle
G.rifleBarrel.rotateX(Math.PI / 2);      // barrel along Z

const HIP_Y = 0.95;
const CROUCH_HIP_Y = 0.62;

const RIFLE_MAT = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.55, metalness: 0.35 });

function hueFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (h % 360) / 360;
}

export function makeNameSprite(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = '600 30px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(8,12,10,0.55)';
  const w = Math.min(240, ctx.measureText(name).width + 26);
  ctx.beginPath();
  ctx.roundRect(128 - w / 2, 8, w, 48, 10);
  ctx.fill();
  ctx.fillStyle = '#e8f4ec';
  ctx.fillText(name, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sprite.scale.set(1.5, 0.375, 1);
  sprite.position.y = 2.12;
  return sprite;
}

export class Character {
  // opts: { name, colorSeed, showName }
  constructor(scene, opts = {}) {
    this.scene = scene;

    const hue = hueFromString(opts.colorSeed || opts.name || 'x');
    this.mats = {
      skin: new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.07, 0.42, 0.6), roughness: 0.85 }),
      shirt: new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.5, 0.46), roughness: 0.8 }),
      pants: new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.32, 0.26), roughness: 0.9 }),
    };

    // --- rig ---
    this.root = new THREE.Group();          // world position + body yaw

    this.hips = new THREE.Group();
    this.hips.position.y = HIP_Y;
    this.root.add(this.hips);
    this.hips.add(new THREE.Mesh(G.hips, this.mats.pants));

    this.torso = new THREE.Group();         // pivot at hip top for pitch lean
    this.torso.position.y = 0.09;
    this.hips.add(this.torso);
    const torsoMesh = new THREE.Mesh(G.torso, this.mats.shirt);
    torsoMesh.position.y = 0.33;
    this.torso.add(torsoMesh);

    this.head = new THREE.Group();
    this.head.position.y = 0.68;
    this.torso.add(this.head);
    const headMesh = new THREE.Mesh(G.head, this.mats.skin);
    headMesh.position.y = 0.09;
    this.head.add(headMesh);

    this.armL = this._limb(G.arm, this.mats.shirt, 0.25, 0.57, -0.27);
    this.armR = this._limb(G.arm, this.mats.shirt, -0.25, 0.57, -0.27);
    this.torso.add(this.armL, this.armR);

    // Rifle rides the anatomical-right arm (+X side when facing -Z): hangs at
    // hip height in the relaxed pose and pitches with the arm during ADS.
    // Real gun model when props provide one, procedural boxes otherwise.
    this.rifle = (opts.props && opts.props.makeGun(0.7)) || null;
    if (!this.rifle) {
      this.rifle = new THREE.Group();
      const rifleBody = new THREE.Mesh(G.rifleBody, RIFLE_MAT);
      const rifleBarrel = new THREE.Mesh(G.rifleBarrel, RIFLE_MAT);
      rifleBarrel.position.set(0, 0.01, -0.38);
      const rifleMag = new THREE.Mesh(G.rifleMag, RIFLE_MAT);
      rifleMag.position.set(0, -0.09, -0.06);
      this.rifle.add(rifleBody, rifleBarrel, rifleMag);
    }
    this.rifle.position.set(0, -0.42, -0.12);
    this.armL.add(this.rifle);
    this.props = opts.props || null;
    this.graveMesh = null;
    this._graveShown = false;

    this.thighL = this._limb(G.thigh, this.mats.pants, 0.1, 0, -0.21);
    this.thighR = this._limb(G.thigh, this.mats.pants, -0.1, 0, -0.21);
    this.hips.add(this.thighL, this.thighR);

    this.kneeL = this._limb(G.shin, this.mats.pants, 0, -0.44, -0.2);
    this.kneeR = this._limb(G.shin, this.mats.pants, 0, -0.44, -0.2);
    this.thighL.add(this.kneeL);
    this.thighR.add(this.kneeR);

    const footL = new THREE.Mesh(G.foot, this.mats.pants);
    footL.position.set(0, -0.4, 0);
    const footR = new THREE.Mesh(G.foot, this.mats.pants);
    footR.position.set(0, -0.4, 0);
    this.kneeL.add(footL);
    this.kneeR.add(footR);

    if (opts.showName !== false && opts.name) {
      this.nameSprite = makeNameSprite(opts.name);
      this.root.add(this.nameSprite);
    }

    // Blob shadow (only when dynamic shadow maps are disabled). Lives in the
    // SCENE (not the rig) so it stays on the ground when the character jumps.
    this.shadow = null;
    if (opts.blobShadows) {
      this.shadow = new THREE.Mesh(
        G.shadow,
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false })
      );
      this.shadow.rotation.x = -Math.PI / 2;
      this.shadow.position.y = 0.025;
      scene.add(this.shadow);
    }

    this.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(this.root);

    this._phase = 0;
    this.bodyYaw = 0;
    this._recoilT = 0;
    this._deathT = 0;
  }

  // Brief weapon kick, triggered on every shot (local and remote).
  kick() { this._recoilT = 1; }

  _limb(geo, mat, x, y, meshY) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = meshY;
    pivot.add(mesh);
    return pivot;
  }

  // pose: { x, y, z, vx, vz, yaw, pitch, crouch, ads, grounded, alive }
  update(dt, pose) {
    this.root.position.set(pose.x, pose.y, pose.z);
    if (this.shadow) {
      this.shadow.position.x = pose.x;
      this.shadow.position.z = pose.z;
      this.shadow.material.opacity = 0.32 * Math.max(0.25, 1 - pose.y / 2.5);
    }

    // --- death: a grave marker replaces the body (fallback: fall backwards) --
    const alive = pose.alive !== false;
    this._updateGrave(alive, pose);
    if (!alive) {
      if (!this._graveShown) { // no grave prop available -> old fall anim
        this._deathT = Math.min(1, this._deathT + dt * 3.2);
        this.root.rotation.x = -this._deathT * (Math.PI / 2);
        this.root.rotation.y = this.bodyYaw;
      }
      return; // corpses don't animate limbs
    }
    if (this._deathT > 0) { this._deathT = 0; this.root.rotation.x = 0; }

    const speed = Math.hypot(pose.vx, pose.vz);
    const speedN = Math.min(1, speed / MOVE.RUN);

    // --- body yaw: face movement direction in hip stance; face the AIM while
    // ADS or in combat stance (recently fired) so shots leave the rifle.
    let targetYaw = this.bodyYaw;
    if (pose.ads || pose.combat) targetYaw = pose.yaw;
    else if (speed > 0.6) targetYaw = Math.atan2(-pose.vx, -pose.vz);
    this.bodyYaw = lerpAngle(this.bodyYaw, targetYaw, 1 - Math.exp(-dt * 10));
    this.root.rotation.y = this.bodyYaw;

    // --- locomotion phase ---
    this._phase += speed * dt * 2.4;
    const swing = Math.sin(this._phase) * 0.75 * speedN;
    const idleT = performance.now() * 0.001;

    if (!pose.grounded) {
      // airborne tuck
      setX(this.thighL, -0.55); setX(this.thighR, -0.55);
      setX(this.kneeL, 1.0); setX(this.kneeR, 1.0);
      if (!pose.ads) { setX(this.armL, -0.5); setX(this.armR, -0.5); }
      this.hips.position.y = HIP_Y;
    } else if (pose.crouch) {
      this.hips.position.y = CROUCH_HIP_Y;
      setX(this.thighL, -0.85 + swing * 0.5);
      setX(this.thighR, -0.85 - swing * 0.5);
      setX(this.kneeL, 1.15); setX(this.kneeR, 1.15);
    } else {
      this.hips.position.y = HIP_Y + Math.abs(Math.sin(this._phase)) * 0.045 * speedN
        + (speedN < 0.05 ? Math.sin(idleT * 1.8) * 0.008 : 0); // idle breath
      setX(this.thighL, swing);
      setX(this.thighR, -swing);
      setX(this.kneeL, Math.max(0, -Math.sin(this._phase)) * 1.05 * speedN);
      setX(this.kneeR, Math.max(0, Math.sin(this._phase)) * 1.05 * speedN);
    }

    // --- arms + aim hints ---
    if (pose.ads) {
      // both arms raised along the aim pitch — readable "this player is aiming"
      setX(this.armL, -Math.PI / 2 + pose.pitch);
      setX(this.armR, -Math.PI / 2 + pose.pitch);
    } else if (pose.grounded) {
      // rifle arm stays low and steady; off-hand swings with the stride
      setX(this.armL, -0.28 - swing * 0.15);
      setX(this.armR, swing * 0.65);
    }

    // --- weapon kick decay ---
    if (this._recoilT > 0) {
      this._recoilT = Math.max(0, this._recoilT - dt * 7);
      this.rifle.rotation.x = -this._recoilT * 0.2;
      this.rifle.position.z = -0.12 + this._recoilT * 0.05;
    }

    const crouchLean = pose.crouch ? 0.22 : 0;
    this.torso.rotation.x = pose.pitch * 0.18 + crouchLean;
    this.head.rotation.x = pose.pitch * 0.45;
    // While hip-strafing the body faces the move direction but the head keeps
    // looking where the player aims (cheap but very readable).
    if (!pose.ads) this.head.rotation.y = clampAngleDelta(pose.yaw - this.bodyYaw, 1.1);
    else this.head.rotation.y = 0;
  }

  // Swap body <-> grave marker on death/respawn (shared visual language with
  // GLB avatars; see avatars.js).
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
    if (this.shadow) { this.scene.remove(this.shadow); this.shadow.material.dispose(); }
    if (this.graveMesh) this.scene.remove(this.graveMesh);
    for (const m of Object.values(this.mats)) m.dispose();
    if (this.nameSprite) {
      this.nameSprite.material.map.dispose();
      this.nameSprite.material.dispose();
    }
  }
}

function setX(group, x) { group.rotation.x = x; }

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function clampAngleDelta(d, max) {
  d = d % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return Math.max(-max, Math.min(max, d));
}
