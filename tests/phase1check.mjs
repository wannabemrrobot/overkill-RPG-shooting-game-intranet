// tests/phase1check.mjs
// Headless end-to-end verification of Phase 1 netcode against a RUNNING server:
//   node server.js               (terminal 1)
//   node tests/phase1check.mjs   (terminal 2)
//
// Exercises the real network path with real colyseus.js clients:
//   1. two clients matchmake into the same arena room
//   2. walker sends paced 60Hz inputs; observer must SEE it move the right
//      distance in the right direction (authoritative sim + state sync)
//   3. observed speed never exceeds RUN (server is the only integrator)
//   4. a client-side replica of the same inputs matches the server's result
//      (i.e. prediction reconciles to ~zero error)
//   5. bounds clamp holds; players never end up inside an obstacle
//   6. flooding 600 inputs as rapid small messages yields almost no extra
//      distance (queue cap + token pacing = no speed hack)
//   7. one oversized message (>4KB transport cap) kills only that client's
//      socket; the room and other clients keep running
//   8. ping round-trips; seq acks match what was actually accepted

import { Client } from 'colyseus.js';
import { NET, MOVE } from '../shared/constants.js';
import { MAP } from '../shared/map.js';
import { stepPlayer, makeMoveState } from '../shared/movement.js';

const ENDPOINT = 'ws://localhost:3000';
let failed = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failed++;
}

// Watchdog: a wedged await must never hang the run silently.
const watchdog = setTimeout(() => {
  console.error('\nWATCHDOG: test exceeded 45s — aborting.');
  process.exit(2);
}, 45000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// True circle-vs-AABB penetration: distance from the sample to the CLOSEST
// point on the box must be >= player radius. (A padded point-in-rect test is
// wrong at corners — the legal region there is rounded, not square.)
function insideAnyBox(x, z, radius) {
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  for (const b of MAP.boxes) {
    const nx = clamp(x, b.cx - b.hx, b.cx + b.hx);
    const nz = clamp(z, b.cz - b.hz, b.cz + b.hz);
    if (Math.hypot(x - nx, z - nz) < radius) return b;
  }
  return null;
}

const mkStep = (seq, yaw) => ({ seq, mx: 0, mz: 1, yaw, pitch: 0, jump: false, crouch: false, walk: false, ads: false });

// Paced sender: `count` steps at ~60Hz, one message per step (like a browser frame).
function sendPaced(room, startSeq, count, yaw) {
  return new Promise((resolve) => {
    let i = 0;
    const iv = setInterval(() => {
      if (i >= count) { clearInterval(iv); resolve(startSeq + count); return; }
      try { room.send('i', [mkStep(startSeq + 1 + i, yaw)]); } catch { /* closed */ }
      i++;
    }, 16);
  });
}

async function leaveQuiet(room) {
  try { await Promise.race([room.leave(), sleep(1500)]); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
console.log('connecting two clients…');
const walker = new Client(ENDPOINT);
const observer = new Client(ENDPOINT);
const wRoom = await walker.joinOrCreate(NET.ROOM_ARENA, { name: 'walker' });
const oRoom = await observer.joinOrCreate(NET.ROOM_ARENA, { name: 'observer' });

check('both clients joined', !!wRoom.sessionId && !!oRoom.sessionId);
check('matchmade into the same room', wRoom.roomId === oRoom.roomId);

// Observer records every patch about the walker (true "what remotes see" data).
const seen = [];
oRoom.onStateChange((st) => {
  const p = st.players.get(wRoom.sessionId);
  if (p) seen.push({ t: st.serverTime, x: p.x, y: p.y, z: p.z, seq: p.seq });
});

let gotPong = false;
wRoom.onMessage('pong', () => { gotPong = true; });
wRoom.send('ping', 1);

await sleep(300);
check('observer sees walker in state', seen.length > 0);
check('ping round-trips', gotPong);

const spawn = { ...seen[seen.length - 1] };
const yaw = wRoom.state.players.get(wRoom.sessionId).yaw; // server-assigned facing

// --- 2-4: walk forward 120 steps (2s of sim) --------------------------------
console.log('walking 120 paced steps…');
let seq = await sendPaced(wRoom, 0, 120, yaw);
await sleep(350);

const end = seen[seen.length - 1];
const dist = Math.hypot(end.x - spawn.x, end.z - spawn.z);
check('walker moved ~10m in 2s of input', dist > 8 && dist < 11.2, `moved ${dist.toFixed(2)}m`);

const dirDot = ((end.x - spawn.x) * -Math.sin(yaw) + (end.z - spawn.z) * -Math.cos(yaw)) / (dist || 1);
check('moved in the aimed direction', dirDot > 0.98, `alignment ${dirDot.toFixed(3)}`);

// Speed invariant: instantaneous patch-to-patch speed can legitimately spike
// (server catch-up after network jitter, bounded to <=0.2s of sim by the
// queue cap), so assert the meaningful bounds instead: speed over any 300ms
// window, and the average over the whole walk.
let maxWindowed = 0;
for (let i = 0; i < seen.length; i++) {
  for (let j = i + 1; j < seen.length; j++) {
    const dt = (seen[j].t - seen[i].t) / 1000;
    if (dt < 0.3) continue;
    const v = Math.hypot(seen[j].x - seen[i].x, seen[j].z - seen[i].z) / dt;
    if (v > maxWindowed) maxWindowed = v;
    break; // first snapshot >=300ms ahead is the tightest window from i
  }
}
check('300ms-windowed speed capped at RUN', maxWindowed <= MOVE.RUN * 1.2, `max ${maxWindowed.toFixed(2)} vs ${MOVE.RUN}`);
const avgV = dist / 2.0; // 120 steps == 2s of simulated input
check('average walk speed <= RUN', avgV <= MOVE.RUN * 1.05, `avg ${avgV.toFixed(2)}`);

const replica = makeMoveState(spawn.x, spawn.y, spawn.z);
for (let i = 1; i <= 120; i++) stepPlayer(replica, mkStep(i, yaw), MAP);
const replicaErr = Math.hypot(replica.x - end.x, replica.z - end.z);
check('client replica matches server sim', replicaErr < 0.8, `err ${replicaErr.toFixed(3)}m`);

check('server acked all processed inputs', end.seq === 120, `acked seq ${end.seq}`);

// --- 5: bounds + obstacle integrity ------------------------------------------
console.log('pushing into the boundary for 3s…');
const cur = wRoom.state.players.get(wRoom.sessionId);
const outYaw = Math.atan2(-cur.x, -cur.z); // forward=(-sin,-cos) -> away from origin
seq = await sendPaced(wRoom, seq, 180, outYaw);
await sleep(350);

const lim = MAP.half - MOVE.RADIUS + 0.02;
const atEdge = seen[seen.length - 1];
check('bounds clamp holds', Math.abs(atEdge.x) <= lim && Math.abs(atEdge.z) <= lim,
  `pos ${atEdge.x.toFixed(2)}, ${atEdge.z.toFixed(2)} vs lim ${lim.toFixed(2)}`);

let penetrated = null;
for (const s of seen) {
  const hit = insideAnyBox(s.x, s.z, MOVE.RADIUS - 0.08);
  if (hit) { penetrated = s; break; }
}
check('never penetrated an obstacle', !penetrated,
  penetrated ? `at ${penetrated.x.toFixed(2)},${penetrated.z.toFixed(2)}` : 'all patches clean');

// --- 6: flood as rapid SMALL messages (under the 4KB transport cap) ----------
console.log('flooding 600 steps as 20 rapid messages…');
const floodBase = seen[seen.length - 1];
const backYaw = Math.atan2(cur.x, cur.z); // back toward the origin (open space)
for (let m = 0; m < 20; m++) {
  const batch = [];
  for (let i = 0; i < 30; i++) batch.push(mkStep(seq + m * 30 + i + 1, backYaw));
  wRoom.send('i', batch);
}
seq += 600;
await sleep(1500);

const afterFlood = seen[seen.length - 1];
const floodDist = Math.hypot(afterFlood.x - floodBase.x, afterFlood.z - floodBase.z);
check('input flood gives no speed advantage', floodDist < 2.2, `moved ${floodDist.toFixed(2)}m from 600-step burst`);
check('server ack never exceeded accepted inputs', afterFlood.seq <= seq, `acked ${afterFlood.seq} <= sent ${seq}`);

// --- 7: oversized single message — transport must drop ONLY that client ------
console.log('sending one oversized message from a disposable client…');
const hostileClient = new Client(ENDPOINT);
const hRoom = await hostileClient.joinOrCreate(NET.ROOM_ARENA, { name: 'hostile' });
let hostileDropped = false;
hRoom.onLeave(() => { hostileDropped = true; });
const huge = [];
for (let i = 1; i <= 600; i++) huge.push(mkStep(i, 0));
try { hRoom.send('i', huge); } catch { hostileDropped = true; }
await sleep(800);
check('oversized message drops only the sender', hostileDropped);

// observer still fully alive?
const before = seen.length;
await sleep(300);
check('room and other clients unaffected', seen.length > before, 'observer still receiving patches');

// ---------------------------------------------------------------------------
await leaveQuiet(wRoom);
await leaveQuiet(oRoom);

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
clearTimeout(watchdog);
process.exit(failed === 0 ? 0 : 1);
