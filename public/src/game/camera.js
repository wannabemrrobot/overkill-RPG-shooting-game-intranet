// public/src/game/camera.js
// Over-the-shoulder third-person camera on a colliding spring arm.
//
// Every frame: compute the desired camera position (pivot at shoulder height,
// pushed back along the aim direction and sideways over the active shoulder),
// then raycast pivot -> desired against world geometry. If anything is hit the
// arm shortens to just in front of the hit (COLLIDE_PAD) so the camera never
// clips inside walls/crates or sees under the map. Pull-in is instant-ish,
// release eases back out — the standard feel that avoids popping.
//
// Camera orientation comes straight from yaw/pitch (YXZ euler), which keeps
// the crosshair mathematically centered: the Phase-2 aim ray is just "from
// camera through screen center".

import * as THREE from 'three';
import { CAM } from '/shared/constants.js';

const _dir = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _right = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _hits = [];

export class ThirdPersonCamera {
  constructor(camera, colliders) {
    this.camera = camera;
    this.colliders = colliders;
    this.raycaster = new THREE.Raycaster();

    this.shoulder = 1;            // +1 right, -1 left (Z swaps via setter)
    this._shoulderLerp = 1;
    this._armLen = CAM.ARM_HIP;   // smoothed arm length target tracker
    this._dist = CAM.ARM_HIP;     // smoothed actual (post-collision) distance
    this._fov = CAM.FOV_HIP;

    camera.fov = this._fov;
    camera.near = 0.05;
    camera.updateProjectionMatrix();
  }

  swapShoulder() { this.shoulder *= -1; }

  // Aim-feel compensation for the input pipeline: scale look speed by zoom.
  get fovScale() {
    return Math.tan(THREE.MathUtils.degToRad(this._fov / 2)) /
           Math.tan(THREE.MathUtils.degToRad(CAM.FOV_HIP / 2));
  }

  // pose: { x, y, z, yaw, pitch, ads, crouch }
  // Returns the current camera distance (main.js hides the local character
  // when the camera is pulled all the way into it).
  update(dt, pose) {
    // --- FOV zoom (scope > ADS > hip) ---
    const fovTarget = pose.scope ? CAM.FOV_SCOPE : pose.ads ? CAM.FOV_ADS : CAM.FOV_HIP;
    this._fov += (fovTarget - this._fov) * (1 - Math.exp(-dt * 12));
    if (Math.abs(this.camera.fov - this._fov) > 0.01) {
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }

    // --- pivot at shoulder height (drops while crouched) ---
    const pivotY = pose.crouch ? CAM.PIVOT_Y - 0.35 : CAM.PIVOT_Y;
    _pivot.set(pose.x, pose.y + pivotY, pose.z);

    // --- aim basis ---
    const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
    const sy = Math.sin(pose.yaw), cy = Math.cos(pose.yaw);
    _dir.set(-sy * cp, sp, -cy * cp);       // forward (matches movement basis)
    _right.set(cy, 0, -sy);

    // --- desired position on the spring arm ---
    const armTarget = pose.ads ? CAM.ARM_ADS : CAM.ARM_HIP;
    this._armLen += (armTarget - this._armLen) * (1 - Math.exp(-dt * 10));
    this._shoulderLerp += (this.shoulder - this._shoulderLerp) * (1 - Math.exp(-dt * 12));
    const side = CAM.SIDE * this._shoulderLerp;

    _desired.copy(_pivot)
      .addScaledVector(_right, side)
      .addScaledVector(_dir, -this._armLen);
    _desired.y += 0.12;                      // slight over-shoulder rise

    // --- collision: pivot -> desired ---
    _dir.copy(_desired).sub(_pivot);
    const wantDist = _dir.length();
    _dir.multiplyScalar(1 / wantDist);
    this.raycaster.set(_pivot, _dir);
    this.raycaster.far = wantDist;
    _hits.length = 0;
    this.raycaster.intersectObjects(this.colliders, false, _hits);

    let allowed = wantDist;
    if (_hits.length) allowed = Math.max(CAM.MIN_ARM, _hits[0].distance - CAM.COLLIDE_PAD);

    // Snap in fast (never clip), ease out slow (no pop).
    const k = allowed < this._dist ? 1 - Math.exp(-dt * 40) : 1 - Math.exp(-dt * 6);
    this._dist += (allowed - this._dist) * k;

    this.camera.position.copy(_pivot).addScaledVector(_dir, this._dist);

    // --- orientation straight from aim angles (crosshair stays centered) ---
    _euler.set(pose.pitch, pose.yaw, 0);
    this.camera.quaternion.setFromEuler(_euler);

    return this._dist;
  }
}
