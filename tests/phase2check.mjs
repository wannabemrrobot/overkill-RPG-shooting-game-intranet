// tests/phase2check.mjs
// Headless end-to-end verification of Phase 2 combat against a RUNNING server:
//   node server.js               (terminal 1)
//   node tests/phase2check.mjs   (terminal 2)
//
// Uses a real colyseus.js client and the practice dummy at its known post:
//   - torso shot: hitconf arrives, damage matches shared damage formula
//   - headshot: multiplier applied
//   - kill -> 'kill' broadcast, dummy dies, then respawns at its post
//   - wall shot: no hitconf (server ray blocked by world AABB)
//   - fire-rate cap: a 20-shot burst lands only ~interval-paced hits
//   - ammo: 30-round mag empties, further shots rejected, reload restores
//   - the chaser bot eventually finds and damages us ('damaged' arrives)
//
// The test walks the shooter near the dummy using real inputs (there is no
// teleport — by design), then aims using server-side state positions.

import { Client } from 'colyseus.js';
import { NET, MOVE, COMBAT } from '../shared/constants.js';
import { WEAPONS, DEFAULT_WEAPON, muzzleFor, targetPoint, damageFor, hasLOS } from '../shared/combat.js';

const ENDPOINT = 'ws://localhost:3000';
const weapon = WEAPONS[DEFAULT_WEAPON];
let failed = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const watchdog = setTimeout(() => {
  console.error('\nWATCHDOG: test exceeded 120s — aborting.');
  process.exit(2);
}, 120000);

// ---------------------------------------------------------------------------
console.log('connecting…');
const client = new Client(ENDPOINT);
const room = await client.joinOrCreate(NET.ROOM_ARENA, { name: 'marksman' });

const events = { hitconf: [], kill: [], shot: [], damaged: [], died: [] };
for (const type of Object.keys(events)) {
  room.onMessage(type, (m) => events[type].push(m));
}
room.onMessage('pong', () => {});

await sleep(300);

const me = () => room.state.players.get(room.sessionId);
const dummy = () => room.state.players.get('bot:dummy');
const serverTime = () => room.state.serverTime;

check('joined arena', !!me());
check('practice bots present', !!dummy() && !!room.state.players.get('bot:strafer') && !!room.state.players.get('bot:chaser'));

// ---------------------------------------------------------------------------
// Walk until we have clear LOS to the dummy within 25m (real movement inputs).
// ---------------------------------------------------------------------------
console.log('walking toward the dummy…');
let seq = 0;
async function walkTowards(txf, tzf, closerThan, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const p = me();
    const tx = txf(), tz = tzf();
    const dist = Math.hypot(tx - p.x, tz - p.z);
    const m = muzzleFor({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, crouch: false });
    if (dist < closerThan &&
        hasLOS(m.x, m.y, m.z, tx, (dummy()?.y ?? 0) + 1.2, tz)) return true;
    const yaw = Math.atan2(-(tx - p.x), -(tz - p.z));
    room.send('i', [{ seq: ++seq, mx: 0, mz: 1, yaw, pitch: 0, jump: false, crouch: false, walk: false, ads: false }]);
    await sleep(16);
  }
  return false;
}
const reached = await walkTowards(() => dummy().x, () => dummy().z, 20);
check('reached firing position with LOS', reached);
await sleep(250); // settle (stop inputs -> braking)

// ---------------------------------------------------------------------------
// Helper: one aimed shot at a given body height offset of a target.
// ---------------------------------------------------------------------------
function fireAt(targetId, part) {
  const p = me();
  const q = room.state.players.get(targetId);
  const pose = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, crouch: p.crouch };
  // aim yaw straight at the target so muzzle sits correctly
  pose.yaw = Math.atan2(-(q.x - p.x), -(q.z - p.z));
  const m = muzzleFor(pose);
  const tp = targetPoint({ x: q.x, y: q.y, z: q.z, crouch: q.crouch }, part);
  let dx = tp.x - m.x, dy = tp.y - m.y, dz = tp.z - m.z;
  const dl = Math.hypot(dx, dy, dz) || 1;
  room.send('fire', { o: [m.x, m.y, m.z], d: [dx / dl, dy / dl, dz / dl], t: serverTime() });
  return Math.hypot(tp.x - m.x, tp.y - m.y, tp.z - m.z); // distance for falloff
}

// ---- torso shot ------------------------------------------------------------
events.hitconf.length = 0;
const hpBefore = dummy().hp;
const dist1 = fireAt('bot:dummy', 'torso');
await sleep(300);
check('torso shot confirms a hit', events.hitconf.length === 1, `${events.hitconf.length} hitconf`);
if (events.hitconf.length) {
  const h = events.hitconf[0];
  const expected = damageFor(weapon, dist1, h.part);
  check('damage matches shared formula', h.dmg === expected, `dmg ${h.dmg} vs expected ${expected} (${h.part} @ ${dist1.toFixed(1)}m)`);
  check('hp dropped on the dummy', dummy().hp === Math.max(0, hpBefore - h.dmg), `hp ${hpBefore} -> ${dummy().hp}`);
}

// ---- headshot ---------------------------------------------------------------
await sleep(150); // respect fire interval
events.hitconf.length = 0;
fireAt('bot:dummy', 'head');
await sleep(300);
check('headshot lands on the head hitbox', events.hitconf.length === 1 && events.hitconf[0].part === 'head',
  events.hitconf[0] ? `part=${events.hitconf[0].part} dmg=${events.hitconf[0].dmg}` : 'no hitconf');
if (events.hitconf[0]) {
  check('headshot deals multiplied damage', events.hitconf[0].dmg > weapon.damage, `dmg ${events.hitconf[0].dmg}`);
}

// ---- kill + respawn -----------------------------------------------------------
console.log('finishing the dummy…');
events.kill.length = 0;
let guard = 0;
while (dummy().alive && guard++ < 12) {
  fireAt('bot:dummy', 'torso');
  await sleep(weapon.intervalMs + 30);
}
check('dummy died', !dummy().alive);
await sleep(200);
check('kill was broadcast', events.kill.some((k) => k.victimId === 'bot:dummy'),
  events.kill.length ? `killer=${events.kill[0].killer}` : 'none');
check('kill credited to shooter', me().kills >= 1, `kills=${me().kills}`);

await sleep(COMBAT.RESPAWN_MS + 400);
check('dummy respawned at its post', dummy().alive && Math.abs(dummy().x - 6) < 1 && Math.abs(dummy().z - 10) < 1,
  `alive=${dummy().alive} at ${dummy().x.toFixed(1)},${dummy().z.toFixed(1)}`);

// ---- wall shot: aim at the dummy THROUGH the center block ---------------------
// The center block spans x[-3,3], z[-1.2,1.2], h=2.6. Fire a ray that passes
// through it: from our position toward a fake target point inside/behind it.
{
  await sleep(150);
  events.hitconf.length = 0;
  const p = me();
  // aim at a point straight through the block's middle at torso height
  const m = muzzleFor({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, crouch: false });
  // target: mirror of our position through the block center (0, 0)
  const tx = -p.x, tz = -p.z;
  let dx = tx - m.x, dy = 0, dz = tz - m.z;
  const dl = Math.hypot(dx, dy, dz) || 1;
  room.send('fire', { d: [dx / dl, 1.1 / dl - m.y / dl, dz / dl], t: serverTime() }); // roughly torso height at target
  await sleep(300);
  check('shot through a wall confirms nothing', events.hitconf.length === 0, `${events.hitconf.length} hitconf`);
}

// ---- spoofed origin: teleported muzzle must be rejected -------------------------
{
  await sleep(200);
  events.hitconf.length = 0;
  const q = dummy();
  // If the server trusted this, it would be a guaranteed point-blank headshot.
  room.send('fire', { o: [q.x, q.y + 2.5, q.z], d: [0, -1, 0], t: serverTime() });
  await sleep(300);
  check('spoofed fire origin is rejected', events.hitconf.length === 0, `${events.hitconf.length} hitconf`);
}

// ---- fire-rate cap -------------------------------------------------------------
{
  await sleep(300);
  events.hitconf.length = 0;
  const magBefore = me().mag;
  for (let i = 0; i < 20; i++) fireAt('bot:dummy', 'torso'); // spam, no pacing
  await sleep(500);
  const spent = magBefore - me().mag;
  check('fire-rate cap holds under spam', spent <= 3, `20 spammed -> ${spent} accepted`);
}

// ---- ammo + reload ---------------------------------------------------------------
{
  console.log('emptying the magazine…');
  const t0 = Date.now();
  while (me().mag > 0 && Date.now() - t0 < 20000) {
    fireAt('bot:dummy', 'torso');
    await sleep(weapon.intervalMs + 20);
  }
  check('magazine emptied', me().mag === 0, `mag=${me().mag}`);

  events.hitconf.length = 0;
  fireAt('bot:dummy', 'torso');
  await sleep(250);
  check('empty mag cannot fire', events.hitconf.length === 0);

  const reserveBefore = me().reserve;
  room.send('reload');
  await sleep(250);
  check('reload starts', me().reloading === true);
  await sleep(weapon.reloadMs);
  check('reload refills the magazine', me().mag === weapon.magSize && me().reserve === reserveBefore - weapon.magSize,
    `mag=${me().mag} reserve=${me().reserve}`);
}

// ---- chaser bot fights back --------------------------------------------------------
{
  console.log('waiting for the chaser to engage (up to 25s)…');
  events.damaged.length = 0;
  const t0 = Date.now();
  while (!events.damaged.length && Date.now() - t0 < 25000) {
    // stand still in the open; the chaser should find us
    await sleep(300);
  }
  check('chaser bot dealt damage to a human', events.damaged.length > 0,
    events.damaged.length ? `first hit for ${events.damaged[0].dmg}` : 'no damage in 25s');
  check('shots were broadcast for tracers', events.shot.length > 0, `${events.shot.length} shot events`);
}

// ---------------------------------------------------------------------------
try { await Promise.race([room.leave(), sleep(1500)]); } catch { /* gone */ }
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
clearTimeout(watchdog);
process.exit(failed === 0 ? 0 : 1);
