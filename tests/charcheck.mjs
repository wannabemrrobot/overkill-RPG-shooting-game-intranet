// tests/charcheck.mjs
// Verifies character selection end-to-end against a RUNNING server:
//   - /assets/characters/manifest.json lists the .glb files and they serve
//   - a join with { character } syncs that id to other clients
//   - an unknown character id falls back to 'recruit'
//   - 'setchar' re-picks live and syncs; garbage ids sanitize to 'recruit'

import { Client } from 'colyseus.js';
import { NET } from '../shared/constants.js';

const HTTP = 'http://localhost:3000';
const WS = 'ws://localhost:3000';
let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.error('WATCHDOG'); process.exit(2); }, 30000);

// --- manifest + files ---------------------------------------------------------
const manifest = await (await fetch(`${HTTP}/assets/characters/manifest.json`)).json();
const ids = manifest.characters.map((c) => c.id);
check('manifest lists characters', ids.length >= 1, ids.join(', '));
let allServe = true;
for (const c of manifest.characters) {
  const r = await fetch(`${HTTP}${c.file}`, { method: 'HEAD' }).catch(() => null);
  if (!r || !r.ok) { allServe = false; break; }
}
check('every manifest .glb serves', allServe);

// --- join with character sync ---------------------------------------------------
const picked = ids[0];
const a = await new Client(WS).joinOrCreate(NET.ROOM_ARENA, { name: 'picker', character: picked });
const b = await new Client(WS).joinOrCreate(NET.ROOM_ARENA, { name: 'watcher' });
["hitconf","shot","kill","damaged","died","pong"].forEach((t) => { a.onMessage(t, () => {}); b.onMessage(t, () => {}); });
await sleep(300);

const seenA = () => b.state.players.get(a.sessionId);
check('watcher sees picker character', seenA() && seenA().character === picked, `saw "${seenA()?.character}"`);
check('own character synced too', a.state.players.get(a.sessionId).character === picked);

// --- unknown id falls back to a REAL default (recruit removed) --------------------
const c = await new Client(WS).joinOrCreate(NET.ROOM_ARENA, { name: 'hacker', character: 'not-a-real-model' });
["hitconf","shot","kill","damaged","died","pong"].forEach((t) => c.onMessage(t, () => {}));
await sleep(300);
const fallback = b.state.players.get(c.sessionId).character;
check('unknown character falls back to a real character (not recruit)',
  fallback !== 'recruit' && ids.includes(fallback), `saw "${fallback}"`);

// --- live re-pick ------------------------------------------------------------------
const second = ids[1] || ids[0];
a.send('setchar', second);
await sleep(300);
check('setchar re-picks live', seenA().character === second, `saw "${seenA()?.character}"`);

a.send('setchar', { evil: 'payload' });
await sleep(300);
const sanitized = seenA().character;
check('garbage setchar sanitizes to a real character', sanitized !== 'recruit' && ids.includes(sanitized), `saw "${sanitized}"`);

for (const r of [a, b, c]) { try { await Promise.race([r.leave(), sleep(800)]); } catch { /* gone */ } }
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
