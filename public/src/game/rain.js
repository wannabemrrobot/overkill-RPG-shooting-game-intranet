// public/src/game/rain.js
// Optional weather: a camera-following rain volume. Off by default; toggled
// live from ⚙ settings (no reload). Three layers make it read as real rain:
//   1. streaks   — ~1600 thin instanced boxes stretched along their fall
//                  direction, recycled in a cylinder that follows the camera,
//                  with a slight wind slant and varied speed/length.
//   2. atmosphere — greyer, nearer fog while it rains (stored + restored),
//                  so the forest hazes out and the scene feels overcast.
//   3. splashes  — a pool of flat ring ripples that pop on the ground around
//                  the player, expanding and fading (rain hitting the floor).
//
// All CPU-animated (no custom shaders): a few hundred matrix writes per frame,
// well within budget, and nothing that can fail to compile mid-match. Ambience
// audio is separate (audio.js setRain), wired alongside this in main.js.

import * as THREE from 'three';

const COUNT = 1600;         // streaks
const RADIUS = 18;          // cylinder radius around the camera (m)
const TOP = 18;             // spawn this far ABOVE the camera
const BOTTOM = -6;          // recycle once this far BELOW the camera
const FALL_MIN = 16, FALL_MAX = 26; // m/s
const WIND_X = 2.4, WIND_Z = 1.1;   // gentle slant/drift

const SPLASHES = 26;

function ringTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(214,228,238,0.9)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(32, 32, 26, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(214,228,238,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(32, 32, 16, 0, Math.PI * 2);
  ctx.stroke();
  return new THREE.CanvasTexture(c);
}

export class Rain {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.enabled = false;
    this._origFog = scene.fog;
    this._splashTimer = 0;

    // --- streaks --------------------------------------------------------------
    const geo = new THREE.BoxGeometry(0.02, 1, 0.02);
    geo.translate(0, -0.5, 0);   // pivot at the top; scale.y stretches downward
    const mat = new THREE.MeshBasicMaterial({
      color: 0xcdd9e6, transparent: true, opacity: 0.32, depthWrite: false, fog: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    this.mesh.frustumCulled = false; // surrounds the camera; never fully off-screen
    this.mesh.visible = false;
    scene.add(this.mesh);

    // fixed fall direction (down + wind) -> tilt the vertical box onto it
    const fall = new THREE.Vector3(WIND_X, -((FALL_MIN + FALL_MAX) / 2), WIND_Z).normalize();
    this._tilt = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), fall);

    // per-drop world state
    this.px = new Float32Array(COUNT);
    this.py = new Float32Array(COUNT);
    this.pz = new Float32Array(COUNT);
    this.speed = new Float32Array(COUNT);
    this.len = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) this._seed(i, true);

    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();

    // --- ground splash ripples (pool of flat rings) --------------------------
    const ringGeo = new THREE.RingGeometry(0.15, 0.5, 14);
    ringGeo.rotateX(-Math.PI / 2); // lie flat on the ground
    const ringTex = ringTexture();
    this.splashes = [];
    for (let i = 0; i < SPLASHES; i++) {
      const s = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        map: ringTex, color: 0xd6e4ee, transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide, fog: true,
      }));
      s.visible = false;
      scene.add(s);
      this.splashes.push({ mesh: s, life: 0, max: 1 });
    }
  }

  // place drop i around the camera; anywhere=true fills the whole column at
  // start/enable so rain doesn't fall in as a single sheet.
  _seed(i, anywhere) {
    const cam = this.camera.position;
    const a = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * RADIUS;
    this.px[i] = cam.x + Math.cos(a) * rr;
    this.pz[i] = cam.z + Math.sin(a) * rr;
    this.py[i] = cam.y + (anywhere ? BOTTOM + Math.random() * (TOP - BOTTOM) : TOP);
    this.speed[i] = FALL_MIN + Math.random() * (FALL_MAX - FALL_MIN);
    this.len[i] = 0.5 + Math.random() * 0.8;
  }

  setEnabled(on) {
    on = !!on;
    if (on === this.enabled) return;
    this.enabled = on;
    this.mesh.visible = on;
    if (on) {
      for (let i = 0; i < COUNT; i++) this._seed(i, true); // re-center on the player
      this._origFog = this.scene.fog;                       // overcast: nearer, greyer
      this.scene.fog = new THREE.Fog(0x8b939c, 26, 130);
    } else {
      this.scene.fog = this._origFog;
      for (const sp of this.splashes) { sp.life = 0; sp.mesh.visible = false; }
    }
  }

  update(dt) {
    if (!this.enabled) return;
    const cam = this.camera.position;
    const floorRecycle = cam.y + BOTTOM;
    const topY = cam.y + TOP;

    for (let i = 0; i < COUNT; i++) {
      this.py[i] -= this.speed[i] * dt;
      this.px[i] += WIND_X * dt;
      this.pz[i] += WIND_Z * dt;

      // recycle when it drops below the camera or drifts out of the cylinder
      const dx = this.px[i] - cam.x, dz = this.pz[i] - cam.z;
      if (this.py[i] < floorRecycle || dx * dx + dz * dz > (RADIUS + 3) * (RADIUS + 3)) {
        this._seed(i, false);
      }

      this._p.set(this.px[i], this.py[i], this.pz[i]);
      this._s.set(1, this.len[i], 1);
      this._m.compose(this._p, this._tilt, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;

    this._updateSplashes(dt, cam);
  }

  _updateSplashes(dt, cam) {
    // spawn a few ripples per second on the ground near the player
    this._splashTimer -= dt;
    while (this._splashTimer <= 0) {
      this._splashTimer += 0.05; // ~20/s
      const s = this.splashes.find((x) => x.life <= 0);
      if (s) {
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * 14;
        s.mesh.position.set(cam.x + Math.cos(a) * rr, 0.03, cam.z + Math.sin(a) * rr);
        s.mesh.scale.setScalar(0.3 + Math.random() * 0.3);
        s.life = s.max = 0.45;
        s.mesh.visible = true;
      } else break; // pool exhausted this frame
    }
    for (const s of this.splashes) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const k = 1 - s.life / s.max;       // 0 -> 1 over its life
      s.mesh.scale.setScalar(0.3 + k * 1.1);
      s.mesh.material.opacity = 0.5 * (1 - k);
      if (s.life <= 0) s.mesh.visible = false;
    }
  }
}
