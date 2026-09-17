// shared/movement.js
// THE deterministic movement step — the heart of prediction/reconciliation.
// The exact same function advances:
//   - the server's authoritative simulation (from validated client inputs),
//   - the client's local prediction (from the same inputs, instantly).
// Given identical (state, input) both sides produce identical results, so
// reconciliation replay is normally a no-op. Keep this file dependency-free
// (plain objects, plain Math) and allocation-free (mutates in place).
//
// Note on floats: V8 (server) and JavaScriptCore (Safari) may differ in the
// last ulp of Math.sin/cos. Irrelevant here — the client re-anchors to the
// authoritative state every patch (~50ms), so sub-nanometre drift never
// accumulates.

import { MOVE } from './constants.js';

// Movement intent for one fixed 1/60s step. `yaw` is the camera yaw the step
// was taken under (aim is client-authoritative; positions never are).
//   { seq, mx, mz, yaw, pitch, jump, crouch, walk, ads }
// mx: strafe (-1 left .. +1 right), mz: forward (+1 = W). |(mx,mz)| <= 1.

export function makeMoveState(x = 0, y = 0, z = 0) {
  return { x, y, z, vx: 0, vy: 0, vz: 0, grounded: true };
}

export const NEUTRAL_INPUT = Object.freeze({
  seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0,
  jump: false, crouch: false, walk: false, ads: false,
});

function targetSpeed(input) {
  let s = input.walk ? MOVE.WALK : MOVE.RUN;
  if (input.crouch) s = Math.min(s, MOVE.CROUCH);
  if (input.ads) s = Math.min(s, MOVE.ADS_CAP);
  return s;
}

// Advance `s` by one step of `input` over `dt` seconds (defaults to the fixed
// step; the server also uses a 1/SIM_HZ neutral step when a client's input
// queue runs dry, so gravity/braking never stall).
export function stepPlayer(s, input, map, dt = MOVE.FIXED_DT) {
  // --- wish velocity (camera-relative -> world) -----------------------------
  let mx = input.mx, mz = input.mz;
  const m2 = mx * mx + mz * mz;
  if (m2 > 1) { const inv = 1 / Math.sqrt(m2); mx *= inv; mz *= inv; }

  const sin = Math.sin(input.yaw), cos = Math.cos(input.yaw);
  // right = (cos, -sin), forward = (-sin, -cos)  [three.js -Z-forward at yaw 0]
  const speed = targetSpeed(input);
  const wishX = (mx * cos - mz * sin) * speed;
  const wishZ = (-mx * sin - mz * cos) * speed;

  // --- accelerate toward wish (also brakes toward 0 when no intent) --------
  const accel = (s.grounded ? MOVE.ACCEL_GROUND : MOVE.ACCEL_AIR) * dt;
  let dvx = wishX - s.vx, dvz = wishZ - s.vz;
  const dlen2 = dvx * dvx + dvz * dvz;
  if (dlen2 > accel * accel) {
    const k = accel / Math.sqrt(dlen2);
    dvx *= k; dvz *= k;
  }
  s.vx += dvx; s.vz += dvz;

  // --- jump & gravity -------------------------------------------------------
  if (input.jump && s.grounded) { s.vy = MOVE.JUMP_V; s.grounded = false; }
  if (!s.grounded) s.vy -= MOVE.GRAVITY * dt;

  // --- integrate ------------------------------------------------------------
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.z += s.vz * dt;

  // --- flat ground ----------------------------------------------------------
  if (s.y <= map.groundY) { s.y = map.groundY; s.vy = 0; s.grounded = true; }

  // --- obstacles + bounds ---------------------------------------------------
  resolveObstacles(s, map.boxes);
  const lim = map.half - MOVE.RADIUS;
  if (s.x < -lim) { s.x = -lim; if (s.vx < 0) s.vx = 0; }
  else if (s.x > lim) { s.x = lim; if (s.vx > 0) s.vx = 0; }
  if (s.z < -lim) { s.z = -lim; if (s.vz < 0) s.vz = 0; }
  else if (s.z > lim) { s.z = lim; if (s.vz > 0) s.vz = 0; }

  return s;
}

// Circle (player, radius MOVE.RADIUS) vs AABB push-out in the XZ plane.
// Two passes so corner/pair overlaps settle; fixed iteration order keeps it
// deterministic across client and server.
function resolveObstacles(s, boxes) {
  const r = MOVE.RADIUS;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const nx = clamp(s.x, b.cx - b.hx, b.cx + b.hx);
      const nz = clamp(s.z, b.cz - b.hz, b.cz + b.hz);
      let dx = s.x - nx, dz = s.z - nz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;

      if (d2 > 1e-9) {
        // outside the box but overlapping: push straight out of the surface
        const d = Math.sqrt(d2);
        const push = (r - d) / d;
        s.x += dx * push;
        s.z += dz * push;
      } else {
        // center is INSIDE the box: exit along the axis of least penetration
        const left = s.x - (b.cx - b.hx), right = (b.cx + b.hx) - s.x;
        const near = s.z - (b.cz - b.hz), far = (b.cz + b.hz) - s.z;
        const minX = Math.min(left, right), minZ = Math.min(near, far);
        if (minX < minZ) s.x = left < right ? b.cx - b.hx - r : b.cx + b.hx + r;
        else s.z = near < far ? b.cz - b.hz - r : b.cz + b.hz + r;
      }
    }
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Server-side input sanitiser: coerce/clamp every field of a network-received
// step so nothing non-finite or out-of-range ever reaches the simulation.
// Returns null if the payload is not usable at all.
export function sanitizeInput(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const seq = raw.seq >>> 0;
  let mx = +raw.mx, mz = +raw.mz, yaw = +raw.yaw, pitch = +raw.pitch;
  if (!Number.isFinite(mx)) mx = 0;
  if (!Number.isFinite(mz)) mz = 0;
  if (!Number.isFinite(yaw)) yaw = 0;
  if (!Number.isFinite(pitch)) pitch = 0;
  return {
    seq,
    mx: clamp(mx, -1, 1),
    mz: clamp(mz, -1, 1),
    yaw: wrapAngle(yaw),
    pitch: clamp(pitch, -MOVE.MAX_PITCH, MOVE.MAX_PITCH),
    jump: !!raw.jump,
    crouch: !!raw.crouch,
    walk: !!raw.walk,
    ads: !!raw.ads,
  };
}

export function wrapAngle(a) {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  else if (a < -Math.PI) a += Math.PI * 2;
  return a;
}
