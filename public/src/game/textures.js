// public/src/game/textures.js
// Procedural CanvasTextures — the cheap trick that carries most of the
// perceived visual quality. No image files, no CDNs; everything is painted
// once at boot into small canvases (fully offline, ~zero load time).
// Deterministic via a seeded RNG so every client sees the same world.

import * as THREE from 'three';

// mulberry32 — tiny seeded PRNG (visual-only; never used in the simulation).
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// Patchy tropical grass: two scales of tonal blotches + fine speckle.
export function grassTexture() {
  const c = canvas(256), ctx = c.getContext('2d');
  const r = rng(1337);
  ctx.fillStyle = '#4a7f3f';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 60; i++) { // large soft patches (dry/lush variation)
    const g = 110 + r() * 40;
    ctx.fillStyle = `rgba(${g * 0.55}, ${g}, ${g * 0.45}, 0.16)`;
    const x = r() * 256, y = r() * 256, rad = 20 + r() * 45;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
  }
  for (let i = 0; i < 4200; i++) { // fine blade speckle
    const v = r();
    ctx.fillStyle = v < 0.5
      ? `rgba(30, ${70 + r() * 50}, 30, 0.35)`
      : `rgba(${120 + r() * 60}, ${150 + r() * 55}, 60, 0.28)`;
    ctx.fillRect(r() * 256, r() * 256, 1 + r() * 1.6, 1 + r() * 2.2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Weathered wood planks for crates/walls.
export function woodTexture() {
  const c = canvas(128), ctx = c.getContext('2d');
  const r = rng(4242);
  ctx.fillStyle = '#8a6a44';
  ctx.fillRect(0, 0, 128, 128);
  const planks = 5;
  for (let p = 0; p < planks; p++) {
    const y0 = (128 / planks) * p;
    const tone = 118 + r() * 34;
    ctx.fillStyle = `rgb(${tone}, ${tone * 0.72}, ${tone * 0.46})`;
    ctx.fillRect(0, y0 + 1, 128, 128 / planks - 2);
    ctx.fillStyle = 'rgba(40, 24, 12, 0.55)';           // plank seams
    ctx.fillRect(0, y0, 128, 1.5);
    for (let i = 0; i < 46; i++) {                      // grain streaks
      ctx.fillStyle = `rgba(60, 38, 18, ${0.10 + r() * 0.16})`;
      ctx.fillRect(r() * 128, y0 + 2 + r() * (128 / planks - 4), 10 + r() * 40, 1);
    }
    const nx = 8 + r() * 112;                           // the odd nail/knot
    ctx.fillStyle = 'rgba(25, 15, 8, 0.8)';
    ctx.beginPath(); ctx.arc(nx, y0 + 6 + r() * 12, 1.6, 0, 7); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Grass-blade card (alpha-tested) for instanced tufts.
export function grassBladeTexture() {
  const c = canvas(64), ctx = c.getContext('2d');
  const r = rng(777);
  ctx.clearRect(0, 0, 64, 64);
  for (let i = 0; i < 22; i++) {
    const x = 4 + r() * 56, h = 26 + r() * 34, w = 1.6 + r() * 2.2, lean = (r() - 0.5) * 14;
    const g = 120 + r() * 70;
    ctx.strokeStyle = `rgba(${g * 0.5}, ${g}, ${g * 0.4}, 0.95)`;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x, 64);
    ctx.quadraticCurveTo(x + lean * 0.4, 64 - h * 0.6, x + lean, 64 - h);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Vertical sky gradient for the dome — saturated tropical blue (a pale sky
// reads as "white washed" under ACES tone mapping).
export function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 512;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.0, '#2b62a8');   // zenith — deep blue
  grad.addColorStop(0.45, '#5b9bcf');
  grad.addColorStop(0.72, '#a8cfdd');  // horizon haze
  grad.addColorStop(1.0, '#c3ddd6');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Radial sun glow. IMPORTANT: an untextured Sprite renders as a solid SQUARE
// — the old sun was two huge white quads smearing the sky. This is the soft
// round falloff the sun disc + halo actually need.
export function sunTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.0, 'rgba(255,252,240,1)');
  g.addColorStop(0.12, 'rgba(255,244,205,0.95)');
  g.addColorStop(0.35, 'rgba(255,220,140,0.35)');
  g.addColorStop(1.0, 'rgba(255,200,110,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
