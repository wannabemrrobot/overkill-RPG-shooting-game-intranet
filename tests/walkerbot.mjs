// tests/walkerbot.mjs
// Solo-testing companion: joins the arena as a real network client and strolls
// a loop through the middle of the map forever (occasionally jumping), sending
// the same 60Hz input steps a browser would. Open the game in your browser and
// you'll see "strollbot" running around — live proof of remote interpolation,
// locomotion animation and name tags, no second human needed.
//
//   node server.js            (terminal 1)
//   node tests/walkerbot.mjs  (terminal 2, Ctrl-C to stop)
//
// Optional: node tests/walkerbot.mjs <name> <character> — run several with
// distinct names/skins (character ids come from /assets/characters/manifest.json).
// (The full server-side AI bots with combat arrive in the Bots phase; this is
// a dumb network puppet purely for movement/netcode eyeballing.)

import { Client } from 'colyseus.js';
import { NET } from '../shared/constants.js';

const ENDPOINT = process.env.ENDPOINT || 'ws://localhost:3000';
const NAME = process.argv[2] || 'strollbot';
const CHARACTER = process.argv[3] || 'recruit';

// Waypoint loop through the mid lanes (open corridors of shared/map.js).
const WAYPOINTS = [
  { x: 12, z: 9 }, { x: -12, z: 9 }, { x: -12, z: -9 }, { x: 12, z: -9 },
];

const client = new Client(ENDPOINT);
const room = await client.joinOrCreate(NET.ROOM_ARENA, { name: NAME, character: CHARACTER });
console.log(`[bot] "${NAME}" joined room ${room.roomId} as ${room.sessionId} — Ctrl-C to stop`);

let wp = 0;
let seq = 0;
let lastJump = Date.now();

setInterval(() => {
  const me = room.state.players?.get(room.sessionId);
  if (!me) return;

  const target = WAYPOINTS[wp];
  const dx = target.x - me.x, dz = target.z - me.z;
  if (Math.hypot(dx, dz) < 1.5) { wp = (wp + 1) % WAYPOINTS.length; return; }

  // forward = (-sin yaw, -cos yaw)  ->  yaw = atan2(-dx, -dz) faces the target
  const yaw = Math.atan2(-dx, -dz);
  const jump = Date.now() - lastJump > 4000 && Math.random() < 0.3;
  if (jump) lastJump = Date.now();

  seq++;
  room.send('i', [{ seq, mx: 0, mz: 1, yaw, pitch: 0, jump, crouch: false, walk: false, ads: false }]);
}, 1000 / NET.INPUT_HZ);

room.onLeave((code) => {
  console.log(`[bot] left (${code})`);
  process.exit(0);
});
