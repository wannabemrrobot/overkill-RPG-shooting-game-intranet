// public/src/game/effects.js
// Pooled, allocation-free combat VFX: tracers, muzzle flashes, impact puffs
// and floating damage numbers. Every effect lives in a fixed-size pool that
// is preallocated at boot — spawning an effect only flips state and writes
// transforms, so sustained firefights never touch the GC.

import * as THREE from 'three';

const TRACERS = 24;
const FLASHES = 10;
const IMPACTS = 24;
const SMOKES = 12;
const DMG_NUMBERS = 14;

// Soft round glow — a mapless SpriteMaterial renders as a hard SQUARE (the
// "boxy" flash/impact), so every additive sprite gets this radial falloff.
let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
}

function spriteMaterial(color, opacity = 1) {
  return new THREE.SpriteMaterial({
    map: glowTexture(), color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

// Star-burst texture for muzzle flashes: bright core + 6 irregular spikes.
// Drawn once at boot — this is most of what "realistic flash" means at 50ms.
function flashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.translate(64, 64);
  const spikes = 6;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2 + (i % 2) * 0.25;
    const len = 52 * (0.65 + (i % 3) * 0.18);
    const w = 9 - (i % 3) * 2;
    const grad = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
    grad.addColorStop(0, 'rgba(255,240,190,0.95)');
    grad.addColorStop(0.35, 'rgba(255,180,80,0.55)');
    grad.addColorStop(1, 'rgba(255,120,30,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
    ctx.stroke();
  }
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 22);
  core.addColorStop(0, 'rgba(255,255,235,1)');
  core.addColorStop(0.5, 'rgba(255,215,130,0.85)');
  core.addColorStop(1, 'rgba(255,150,50,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, 22, 0, 7);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Soft round puff for smoke.
function smokeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(200,195,185,0.55)');
  g.addColorStop(0.6, 'rgba(170,165,155,0.28)');
  g.addColorStop(1, 'rgba(150,145,135,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Effects {
  constructor(scene) {
    this.scene = scene;

    // --- tracers: thin additive boxes stretched between two points ---------
    const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffe9a8, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.tracers = [];
    for (let i = 0; i < TRACERS; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat.clone());
      mesh.visible = false;
      scene.add(mesh);
      this.tracers.push({ mesh, life: 0, max: 1 });
    }

    // --- muzzle flashes: star burst + hot core + lingering smoke puff -------
    const flashTex = flashTexture();
    this.flashes = [];
    for (let i = 0; i < FLASHES; i++) {
      const star = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      const core = new THREE.Sprite(spriteMaterial(0xfff3c8));
      star.visible = core.visible = false;
      scene.add(star, core);
      this.flashes.push({ star, core, life: 0, max: 1 });
    }

    const smokeTex = smokeTexture();
    this.smokes = [];
    for (let i = 0; i < SMOKES; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: smokeTex, transparent: true, depthWrite: false, opacity: 0.5,
      }));
      s.visible = false;
      scene.add(s);
      this.smokes.push({ sprite: s, life: 0, max: 1, vx: 0, vy: 0, vz: 0, grow: 0 });
    }

    // --- impacts: dust (world) / blood-less red spark (player) --------------
    this.impacts = [];
    for (let i = 0; i < IMPACTS; i++) {
      const s = new THREE.Sprite(spriteMaterial(0xffffff, 0.85));
      s.visible = false;
      scene.add(s);
      this.impacts.push({ sprite: s, life: 0, max: 1, rise: 0 });
    }

    // --- floating damage numbers (canvas sprites, canvases reused) ----------
    this.dmgs = [];
    for (let i = 0; i < DMG_NUMBERS; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 64;
      const tex = new THREE.CanvasTexture(canvas);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
      s.scale.set(0.9, 0.45, 1);
      s.visible = false;
      scene.add(s);
      this.dmgs.push({ sprite: s, canvas, tex, life: 0, max: 1, vy: 0 });
    }
  }

  tracer(from, to, lifeMs = 70) {
    const t = this.tracers.find((x) => x.life <= 0) || this.tracers[0];
    const m = t.mesh;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05) return;
    m.position.set(from.x + dx / 2, from.y + dy / 2, from.z + dz / 2);
    m.lookAt(to.x, to.y, to.z);
    m.scale.set(0.03, 0.03, len);
    m.material.opacity = 0.9;
    m.visible = true;
    t.life = t.max = lifeMs / 1000;
  }

  flash(at, scale = 0.55) {
    const f = this.flashes.find((x) => x.life <= 0) || this.flashes[0];
    f.star.position.set(at.x, at.y, at.z);
    f.star.material.rotation = Math.random() * Math.PI * 2; // fresh star every shot
    f.star.scale.setScalar(scale * (0.9 + Math.random() * 0.6));
    f.star.material.opacity = 1;
    f.star.visible = true;
    f.core.position.set(at.x, at.y, at.z);
    f.core.scale.setScalar(scale * 0.4);
    f.core.material.opacity = 1;
    f.core.visible = true;
    f.life = f.max = 0.055;

    // a wisp of smoke drifts up from the muzzle
    const s = this.smokes.find((x) => x.life <= 0) || this.smokes[0];
    s.sprite.position.set(at.x, at.y + 0.02, at.z);
    s.sprite.material.opacity = 0.4;
    s.sprite.material.rotation = Math.random() * Math.PI * 2;
    s.sprite.scale.setScalar(0.16);
    s.sprite.visible = true;
    s.vx = (Math.random() - 0.5) * 0.15;
    s.vy = 0.5 + Math.random() * 0.25;
    s.vz = (Math.random() - 0.5) * 0.15;
    s.grow = 0.9;
    s.life = s.max = 0.45;
  }

  impact(at, onPlayer) {
    const i = this.impacts.find((x) => x.life <= 0) || this.impacts[0];
    i.sprite.position.set(at.x, at.y, at.z);
    i.sprite.material.color.set(onPlayer ? 0xff5a4d : 0xcbbfa5);
    i.sprite.material.opacity = 0.85;
    i.sprite.scale.setScalar(onPlayer ? 0.3 : 0.4);
    i.sprite.visible = true;
    i.rise = onPlayer ? 0.4 : 0.9;
    i.life = i.max = 0.28;
  }

  damageNumber(at, dmg, emphasize) {
    const d = this.dmgs.find((x) => x.life <= 0) || this.dmgs[0];
    const ctx = d.canvas.getContext('2d');
    ctx.clearRect(0, 0, 128, 64);
    ctx.font = `800 ${emphasize ? 44 : 36}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(10,10,10,0.9)';
    ctx.strokeText(String(dmg), 64, 32);
    ctx.fillStyle = emphasize ? '#ff5348' : '#ffd166';
    ctx.fillText(String(dmg), 64, 32);
    d.tex.needsUpdate = true;
    d.sprite.position.set(at.x + (Math.random() - 0.5) * 0.3, at.y + 0.25, at.z + (Math.random() - 0.5) * 0.3);
    d.sprite.material.opacity = 1;
    d.sprite.visible = true;
    d.vy = 1.4;
    d.life = d.max = 0.8;
  }

  update(dt) {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.mesh.material.opacity = 0.9 * Math.max(0, t.life / t.max);
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const k = Math.max(0, f.life / f.max);
      f.star.material.opacity = k;
      f.star.scale.multiplyScalar(1 + dt * 6); // rapid expand as it dies
      f.core.material.opacity = k * k;
      if (f.life <= 0) { f.star.visible = false; f.core.visible = false; }
    }
    for (const s of this.smokes) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.sprite.position.x += s.vx * dt;
      s.sprite.position.y += s.vy * dt;
      s.sprite.position.z += s.vz * dt;
      s.sprite.scale.multiplyScalar(1 + s.grow * dt);
      s.sprite.material.opacity = 0.4 * Math.max(0, s.life / s.max);
      if (s.life <= 0) s.sprite.visible = false;
    }
    for (const i of this.impacts) {
      if (i.life <= 0) continue;
      i.life -= dt;
      i.sprite.position.y += i.rise * dt;
      i.sprite.material.opacity = 0.85 * Math.max(0, i.life / i.max);
      if (i.life <= 0) i.sprite.visible = false;
    }
    for (const d of this.dmgs) {
      if (d.life <= 0) continue;
      d.life -= dt;
      d.vy = Math.max(0.25, d.vy - dt * 2.2);
      d.sprite.position.y += d.vy * dt;
      const k = d.life / d.max;
      d.sprite.material.opacity = k < 0.35 ? k / 0.35 : 1;
      if (d.life <= 0) d.sprite.visible = false;
    }
  }
}
