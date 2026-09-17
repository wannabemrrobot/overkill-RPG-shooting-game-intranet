// shared/map.js
// Phase 1 flat test arena — the SAME data drives:
//   - server + prediction collision (circle-vs-AABB push-out in XZ),
//   - client world meshes (visuals + camera-collision geometry).
// Phase 4 replaces this with the Sanhok-style heightmap map behind the same
// interface: { half, boxes } for movement, plus visual metadata.
//
// Collision model (deliberate Phase 1 simplification): the ground is flat at
// y=0 and every obstacle is a FULL-HEIGHT wall you cannot stand on. All box
// heights are >= 2m while the jump apex is ~0.89m, so ignoring Y in player
// collision is exact, not approximate. Camera collision (client) still uses
// real 3D raycasts against the rendered meshes.

// Axis-aligned boxes: cx/cz center, hx/hz half-extents, h visual height.
// Layout is point-symmetric about the origin (fair for two teams later):
// a center block flanked by pillar pairs, side walls forming outer lanes,
// and crate clusters as partial cover between them.
export const BOXES = [
  // center block — the mid fight anchor
  { cx: 0,   cz: 0,   hx: 3.0, hz: 1.2, h: 2.6 },

  // inner pillars around center (flank cover)
  { cx: -7,  cz: -5,  hx: 1.0, hz: 1.0, h: 3.0 },
  { cx: 7,   cz: 5,   hx: 1.0, hz: 1.0, h: 3.0 },
  { cx: 7,   cz: -5,  hx: 1.0, hz: 1.0, h: 3.0 },
  { cx: -7,  cz: 5,   hx: 1.0, hz: 1.0, h: 3.0 },

  // long lane walls (chokepoints left/right of mid)
  { cx: -16, cz: 0,   hx: 1.0, hz: 6.0, h: 2.8 },
  { cx: 16,  cz: 0,   hx: 1.0, hz: 6.0, h: 2.8 },

  // crate clusters (partial cover, camera-collision playground)
  { cx: -9,  cz: 14,  hx: 1.4, hz: 1.4, h: 2.0 },
  { cx: -12, cz: 16,  hx: 1.1, hz: 1.1, h: 2.2 },
  { cx: 9,   cz: -14, hx: 1.4, hz: 1.4, h: 2.0 },
  { cx: 12,  cz: -16, hx: 1.1, hz: 1.1, h: 2.2 },
  { cx: 14,  cz: 12,  hx: 1.2, hz: 1.2, h: 2.0 },
  { cx: -14, cz: -12, hx: 1.2, hz: 1.2, h: 2.0 },

  // back walls near spawn areas (safe peek cover)
  { cx: 0,   cz: -22, hx: 5.0, hz: 0.8, h: 2.6 },
  { cx: 0,   cz: 22,  hx: 5.0, hz: 0.8, h: 2.6 },
];

// Ammo resupply stations — a table of bullets + an ammo crate at each spawn
// end (just in front of the back walls at cz=±22). Stand within AMMO.STATION_
// RADIUS to refill your bag. Shared so the server (refill logic) and client
// (rendering) agree on where they are.
export const AMMO_STATIONS = [
  { x: -1.6, z: -20.1, yaw: 0 },        // south base
  { x: 1.6, z: 20.1, yaw: Math.PI },    // north base
];

// Playable half-extent. Kept tighter than ARENA.SIZE/2 so Phase 1 fights stay
// close; the fence at this radius is both visual and the hard movement clamp.
export const MAP = {
  half: 30,
  boxes: BOXES,
  groundY: 0,
};

// Spawn ring: players enter facing the arena center so another player crossing
// mid is immediately visible (also what the automated visual test relies on).
export function spawnPoint(index) {
  const angle = (index % 12) * (Math.PI * 2 / 12) + 0.35;
  const r = MAP.half * 0.72;
  const x = Math.cos(angle) * r;
  const z = Math.sin(angle) * r;
  // forward = (-sin yaw, -cos yaw), so yaw = atan2(x, z) points at the origin
  return { x, y: 0, z, yaw: Math.atan2(x, z) };
}
