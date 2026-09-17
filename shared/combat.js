// shared/combat.js
// Combat contract shared by the authoritative server and the client:
// weapon definitions, per-body-region hitboxes, ray math against hitboxes and
// world geometry, and the damage formula. The server is the only side that
// APPLIES any of this to health — the client uses the same functions purely
// for prediction/feedback (crosshair, aim assist, expected damage numbers).
//
// Hitboxes are axis-aligned (they ignore body yaw): our characters are slim
// and near-cylindrical, so an AABB per region is a good, cheap, deterministic
// approximation on both sides.

import { MOVE } from './constants.js';
import { MAP } from './map.js';

// ---------------------------------------------------------------------------
// Weapons (Phase 2 ships the assault rifle; the rest arrive in Phase 4).
// ---------------------------------------------------------------------------
export const WEAPONS = {
  rifle: {
    id: 'rifle',
    name: 'AR-9',
    damage: 13,             // base body damage (~8 torso / 4 head to down 100hp)
    headMult: 2.0,
    legMult: 0.75,
    intervalMs: 100,        // 600 rpm, full-auto
    magSize: 30,
    reserve: 120,
    reloadMs: 1800,
    range: 120,             // hard max distance (m)
    falloffStart: 28,       // full damage inside this
    falloffEnd: 65,         // linear decay to minMult by here
    minMult: 0.55,
    // client feel (server never applies spread/recoil — aim is client-side):
    spreadHipDeg: 1.5,
    spreadAdsDeg: 0.3,
    bloomPerShotDeg: 0.38,
    bloomMaxDeg: 2.6,
    bloomDecayDegPerSec: 5.5,
    recoilPitch: 0.0042,    // rad per shot
    recoilYawJitter: 0.0018,
  },
};

export const DEFAULT_WEAPON = 'rifle';

// ---------------------------------------------------------------------------
// Hitboxes. pose: { x, y, z, crouch } (y = feet). Regions stack:
//   legs 0..~0.95, torso ..~1.45, head ..~1.78 (proportionally squashed
//   while crouched). Multiplier applied via WEAPONS[..].headMult/legMult.
// ---------------------------------------------------------------------------
export const HIT_PARTS = { HEAD: 'head', TORSO: 'torso', LEGS: 'legs' };

export function hitboxesFor(pose, out) {
  const k = pose.crouch ? 0.72 : 1;           // crouch squashes heights
  const x = pose.x, y = pose.y, z = pose.z;
  const legsTop = 0.95 * k, torsoTop = 1.48 * k, headTop = 1.8 * k;
  out = out || [{}, {}, {}];

  fillBox(out[0], HIT_PARTS.LEGS, x - 0.16, y, z - 0.16, x + 0.16, y + legsTop, z + 0.16);
  fillBox(out[1], HIT_PARTS.TORSO, x - 0.21, y + legsTop, z - 0.21, x + 0.21, y + torsoTop, z + 0.21);
  fillBox(out[2], HIT_PARTS.HEAD, x - 0.12, y + torsoTop, z - 0.12, x + 0.12, y + headTop, z + 0.12);
  return out;
}

function fillBox(b, part, x0, y0, z0, x1, y1, z1) {
  b.part = part;
  b.minX = x0; b.minY = y0; b.minZ = z0;
  b.maxX = x1; b.maxY = y1; b.maxZ = z1;
}

// The point aim assist and bots aim for.
export function targetPoint(pose, part = HIT_PARTS.TORSO) {
  const k = pose.crouch ? 0.72 : 1;
  const yOff = part === HIT_PARTS.HEAD ? 1.64 * k : part === HIT_PARTS.LEGS ? 0.5 * k : 1.2 * k;
  return { x: pose.x, y: pose.y + yOff, z: pose.z };
}

// Muzzle position derived from a player pose — IDENTICAL on client and
// server, so tracers/hits line up and the server never trusts an origin.
export function muzzleFor(pose) {
  const k = pose.crouch ? 0.72 : 1;
  const sy = Math.sin(pose.yaw), cy = Math.cos(pose.yaw);
  const h = 1.42 * k;
  // shoulder-forward offset along aim yaw (+ right-hand side nudge)
  return {
    x: pose.x + (-sy) * 0.45 + cy * 0.18,
    y: pose.y + h,
    z: pose.z + (-cy) * 0.45 - sy * 0.18,
  };
}

// ---------------------------------------------------------------------------
// Ray math (slab method). Rays are {ox,oy,oz} + t*{dx,dy,dz}, dir normalized.
// ---------------------------------------------------------------------------
export function rayVsAABB(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
  let tmin = 0, tmax = Infinity;

  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? ox : axis === 1 ? oy : oz;
    const d = axis === 0 ? dx : axis === 1 ? dy : dz;
    const lo = axis === 0 ? minX : axis === 1 ? minY : minZ;
    const hi = axis === 0 ? maxX : axis === 1 ? maxY : maxZ;
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return -1;
    } else {
      let t1 = (lo - o) / d, t2 = (hi - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

// Static world occlusion set: map obstacle boxes (full 3D with height) plus
// the boundary fence slabs. Ground is handled analytically.
const WORLD_AABBS = [];
for (const b of MAP.boxes) {
  WORLD_AABBS.push({ minX: b.cx - b.hx, minY: 0, minZ: b.cz - b.hz, maxX: b.cx + b.hx, maxY: b.h, maxZ: b.cz + b.hz });
}
{
  const H = MAP.half, t = 0.35, h = 1.1;
  const slabs = [
    [-H - t, -H - t, H + t, -H + t], // north edge (z ~ -H)
    [-H - t, H - t, H + t, H + t],   // south
    [-H - t, -H - t, -H + t, H + t], // west
    [H - t, -H - t, H + t, H + t],   // east
  ];
  for (const [x0, z0, x1, z1] of slabs) {
    WORLD_AABBS.push({ minX: x0, minY: 0, minZ: z0, maxX: x1, maxY: h, maxZ: z1 });
  }
}

// Nearest world-geometry hit distance along the ray, or Infinity.
export function rayVsWorld(ox, oy, oz, dx, dy, dz, maxDist = Infinity) {
  let best = maxDist;
  for (let i = 0; i < WORLD_AABBS.length; i++) {
    const b = WORLD_AABBS[i];
    const t = rayVsAABB(ox, oy, oz, dx, dy, dz, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
    if (t >= 0 && t < best) best = t;
  }
  if (dy < -1e-9) { // ground plane y=0
    const t = (MAP.groundY - oy) / dy;
    if (t >= 0 && t < best) best = t;
  }
  return best;
}

// Nearest hitbox hit for one player pose. Returns {part, t} or null.
const _boxes = [{}, {}, {}];
export function rayVsPlayer(ox, oy, oz, dx, dy, dz, pose, maxDist) {
  hitboxesFor(pose, _boxes);
  let best = null;
  for (let i = 0; i < 3; i++) {
    const b = _boxes[i];
    const t = rayVsAABB(ox, oy, oz, dx, dy, dz, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
    if (t >= 0 && t <= maxDist && (!best || t < best.t)) best = { part: b.part, t };
  }
  return best;
}

// Line-of-sight between two points (eye level to eye level), used by bots
// and by client-side aim assist. True if no world geometry blocks.
export function hasLOS(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1e-6) return true;
  const inv = 1 / dist;
  return rayVsWorld(ax, ay, az, dx * inv, dy * inv, dz * inv, dist) >= dist - 1e-3;
}

// ---------------------------------------------------------------------------
export function damageFor(weapon, dist, part) {
  let mult = part === HIT_PARTS.HEAD ? weapon.headMult : part === HIT_PARTS.LEGS ? weapon.legMult : 1;
  if (dist > weapon.falloffStart) {
    const f = Math.min(1, (dist - weapon.falloffStart) / (weapon.falloffEnd - weapon.falloffStart));
    mult *= 1 - f * (1 - weapon.minMult);
  }
  return Math.max(1, Math.round(weapon.damage * mult));
}
