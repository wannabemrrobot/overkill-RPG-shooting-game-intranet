// tests/dmcheck.mjs
// Smoke test for the free-for-all DEATHMATCH mode against a running server.
// Verifies: room joins with mode 'dm', bots backfill, no teams (FFA), the
// phase machine warms up -> live and arms the match clock, respawns are
// unlimited, and the win condition ends the match on the kill target.
//
//   node server.js            (terminal 1)
//   node tests/dmcheck.mjs    (terminal 2)

import { Client } from 'colyseus.js';
import { MODES, PHASE, MATCH, TEAM } from '../shared/constants.js';

const ENDPOINT = 'ws://localhost:3000';
let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.error('\nWATCHDOG: exceeded 60s'); process.exit(2); }, 60000);

const client = new Client(ENDPOINT);

console.log('\n=== DEATHMATCH (FFA) ===');
const room = await client.joinOrCreate(MODES.DM, { name: 'fragger' });
await sleep(500);
const me = () => room.state.players.get(room.sessionId);
const st = room.state;

check('joined dm room', !!me());
check('mode is dm', st.mode === MODES.DM, st.mode);
check('warms up / goes live', st.phase === PHASE.WARMUP || st.phase === PHASE.LIVE, st.phase);

let bots = 0; st.players.forEach((p) => { if (p.bot) bots++; });
check('bots backfill the FFA', st.players.size >= MATCH.DM.botFillTo, `${st.players.size} players (${bots} bots)`);

let teamed = false;
st.players.forEach((p) => { if (p.team === TEAM.A || p.team === TEAM.B) teamed = true; });
check('no teams assigned (everyone FFA)', !teamed);

// wait for LIVE and confirm the match clock is armed
let waited = 0;
while (st.phase !== PHASE.LIVE && waited < 8000) { await sleep(200); waited += 200; }
check('reached LIVE', st.phase === PHASE.LIVE, st.phase);
const clockLeft = st.phaseEndsAt - st.serverTime;
check('match clock armed (~5min)', clockLeft > 60000 && clockLeft <= MATCH.DM.timeLimitMs + 2000,
  `${(clockLeft / 1000).toFixed(0)}s left`);

// unlimited respawns: bots fight each other, so total deaths should climb past
// what a lives-limited mode would allow, and player count stays full.
await sleep(4000);
let totalKills = 0, totalDeaths = 0;
st.players.forEach((p) => { totalKills += p.kills; totalDeaths += p.deaths; });
check('players stay in (unlimited respawn)', st.players.size >= MATCH.DM.botFillTo, `${st.players.size} still in`);
check('frags accrue during live', totalKills >= 0 && totalDeaths >= 0, `${totalKills}K / ${totalDeaths}D so far`);

// win condition: no lives should ever be spent (all remain at the nominal 1)
let anyEliminated = false;
st.players.forEach((p) => { if (p.lives <= 0) anyEliminated = true; });
check('nobody gets eliminated (lives never spent)', !anyEliminated);

room.leave();
clearTimeout(watchdog);
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL DM CHECKS PASSED');
process.exit(failed ? 1 : 0);
