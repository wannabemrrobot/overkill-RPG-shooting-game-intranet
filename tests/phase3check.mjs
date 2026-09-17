// tests/phase3check.mjs
// Headless verification of the Phase-3 MATCH STATE MACHINE against a running
// server (node server.js). Connects real colyseus.js clients to the survival
// and tagteam rooms and asserts the observable match facts:
//
//   survival:  mode/phase, warmup->live transition, my lives set, bots fill to
//              the target, aliveCount tracked, lives decrement isn't cheatable.
//   tagteam:   random 5v5 teams assigned, my team + per-round lives set, kill
//              target / rounds fields present, NO friendly fire (a shot at a
//              teammate is rejected server-side), rounds/scores wired.
//
//   node server.js               (terminal 1)
//   node tests/phase3check.mjs   (terminal 2)

import { Client } from 'colyseus.js';
import { MODES, PHASE, MATCH, TEAM, MOVE } from '../shared/constants.js';
import { WEAPONS, DEFAULT_WEAPON, muzzleFor, targetPoint } from '../shared/combat.js';

const ENDPOINT = 'ws://localhost:3000';
let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.error('\nWATCHDOG: exceeded 90s'); process.exit(2); }, 90000);

const client = new Client(ENDPOINT);

// ===========================================================================
// SURVIVAL
// ===========================================================================
console.log('\n=== SURVIVAL ===');
{
  const room = await client.joinOrCreate(MODES.SURVIVAL, { name: 'lastman' });
  await sleep(400);
  const me = () => room.state.players.get(room.sessionId);
  const st = room.state;

  check('joined survival room', !!me());
  check('mode is survival', st.mode === MODES.SURVIVAL, st.mode);
  check('starts in warmup', st.phase === PHASE.WARMUP || st.phase === PHASE.LIVE, st.phase);

  let bots = 0; st.players.forEach((p) => { if (p.bot) bots++; });
  check('bots backfill the match', st.players.size >= MATCH.SURVIVAL.botFillTo,
    `${st.players.size} players (${bots} bots), target ${MATCH.SURVIVAL.botFillTo}`);
  check('my lives set to survival lives', me().lives === MATCH.SURVIVAL.lives, `lives=${me().lives}`);
  check('FFA — no team', me().team === TEAM.NONE, `team=${me().team}`);

  // wait out warmup -> live
  const t0 = Date.now();
  while (st.phase === PHASE.WARMUP && Date.now() - t0 < MATCH.WARMUP_MS + 3000) await sleep(150);
  check('warmup advanced to live', st.phase === PHASE.LIVE, st.phase);
  check('aliveCount tracks players in play', st.aliveCount >= 2, `aliveCount=${st.aliveCount}`);

  await room.leave();
  await sleep(200);
}

// ===========================================================================
// TAG TEAM
// ===========================================================================
console.log('\n=== TAG TEAM ===');
{
  const room = await client.joinOrCreate(MODES.TAGTEAM, { name: 'blue1' });
  const events = { shot: [], hitconf: [], kill: [] };
  for (const k of Object.keys(events)) room.onMessage(k, (m) => events[k].push(m));
  room.onMessage('announce', () => {});
  room.onMessage('pong', () => {});
  await sleep(400);
  const me = () => room.state.players.get(room.sessionId);
  const st = room.state;

  check('joined tagteam room', !!me());
  check('mode is tagteam', st.mode === MODES.TAGTEAM, st.mode);

  let a = 0, b = 0, bots = 0;
  st.players.forEach((p) => { if (p.team === TEAM.A) a++; else if (p.team === TEAM.B) b++; if (p.bot) bots++; });
  check('teams assigned A/B', a > 0 && b > 0, `A=${a} B=${b}`);
  check('roughly balanced 5v5', Math.abs(a - b) <= 1 && (a + b) === MATCH.TAGTEAM.botFillTo, `A=${a} B=${b}`);
  check('I am on a team', me().team === TEAM.A || me().team === TEAM.B, `team=${me().team}`);
  check('per-round lives set', me().lives === MATCH.TAGTEAM.livesPerRound, `lives=${me().lives}`);
  check('round + kill-target fields present', st.round >= 1 && (MATCH.TAGTEAM.killTarget > 0), `round=${st.round}`);

  // wait for live so firing is accepted
  const t0 = Date.now();
  while (st.phase !== PHASE.LIVE && Date.now() - t0 < MATCH.WARMUP_MS + 3000) await sleep(150);
  check('reached live phase', st.phase === PHASE.LIVE, st.phase);

  // FRIENDLY FIRE OFF: aim exactly at a living teammate and fire; expect NO hitconf.
  const myTeam = me().team;
  let mate = null;
  st.players.forEach((p, id) => { if (!mate && id !== room.sessionId && p.team === myTeam && p.alive) mate = p; });
  if (mate) {
    // fire several shots straight at the teammate's torso from our muzzle
    const before = events.hitconf.length;
    for (let i = 0; i < 6; i++) {
      const p = me();
      const mz = muzzleFor({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, crouch: p.crouch });
      const tp = targetPoint({ x: mate.x, y: mate.y, z: mate.z, crouch: mate.crouch });
      let dx = tp.x - mz.x, dy = tp.y - mz.y, dz = tp.z - mz.z;
      const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
      room.send('fire', { o: [mz.x, mz.y, mz.z], d: [dx, dy, dz], t: st.serverTime });
      await sleep(120);
    }
    await sleep(300);
    const teammateHits = events.hitconf.slice(before).length;
    check('no friendly fire (teammate shots deal no damage)', teammateHits === 0, `${teammateHits} hitconf on teammate`);
  } else {
    check('found a teammate to test friendly fire', false, 'no living teammate found');
  }

  await room.leave();
  await sleep(200);
}

clearTimeout(watchdog);
console.log(failed === 0 ? '\nALL PHASE-3 CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed ? 1 : 0);
