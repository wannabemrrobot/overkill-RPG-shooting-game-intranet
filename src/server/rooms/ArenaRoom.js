// src/server/rooms/ArenaRoom.js
// The authoritative arena: movement (Phase 1) + combat (Phase 2) + the
// Phase-3 MATCH STATE MACHINE (modes, teams, lives, rounds, win conditions).
//
// One room class, three modes (chosen in the lobby -> one room type each):
//   practice  — Phase-2 behaviour verbatim: FFA, unlimited respawn, the fixed
//               practice bots (dummy/strafer/chaser). This is the 'arena' room
//               the headless tests join, so its behaviour must not drift.
//   survival  — free-for-all, LIMITED LIVES; last player with lives wins.
//   tagteam   — 5v5, random teams, best-of-N rounds; a round is won by wiping
//               the enemy team (all lives spent) OR reaching the kill target.
// Empty slots are backfilled with chaser bots so matches are fair.
//
// Combat design (unchanged): clients send a fire DIRECTION + rewind timestamp;
// the server owns the muzzle, rewinds hitboxes (lag comp), raycasts and applies
// all damage. Rate/ammo/reload/LOS are server-enforced. Bots are virtual
// players through the SAME sim + fire path.

import colyseus from 'colyseus';
import { Schema, MapSchema, defineTypes } from '@colyseus/schema';
import { NET, ROOM, COMBAT, TEAM, MODES, PHASE, MATCH, HEALTHPACK, PAINKILLER, AMMO } from '../../../shared/constants.js';
import { MAP, spawnPoint, AMMO_STATIONS } from '../../../shared/map.js';
import { stepPlayer, sanitizeInput, makeMoveState, NEUTRAL_INPUT } from '../../../shared/movement.js';
import { WEAPONS, DEFAULT_WEAPON, muzzleFor, rayVsWorld, rayVsPlayer, damageFor } from '../../../shared/combat.js';
import { BOT_SPECS, createBotState, botThink } from '../ai/bots.js';
import { sanitizeCharacter, randomCharacter } from '../characters.js';

const { Room } = colyseus;

const BOT_NAMES = ['Ash', 'Ryu', 'Nova', 'Zed', 'Kilo', 'Vex', 'Orin', 'Bly', 'Rune', 'Cyra'];

// Lobby team preference ('blue'/'red') -> team id; anything else = auto.
function parseTeamPref(raw) {
  if (raw === 'blue') return TEAM.A;
  if (raw === 'red') return TEAM.B;
  return TEAM.NONE;
}

// ---------------------------------------------------------------------------
class Player extends Schema {
  constructor() {
    super();
    this.name = 'player';
    this.bot = false;
    this.character = 'recruit'; // cosmetic only — hitboxes identical for all
    this.team = TEAM.NONE;      // -1 FFA; 0/1 in tag team
    this.lives = 0;            // remaining spawns (match modes); 0 = unused/out
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = 0; this.pitch = 0;
    this.crouch = false; this.ads = false; this.walk = false;
    this.grounded = true;
    this.seq = 0;
    // combat
    this.hp = COMBAT.MAX_HP;
    this.alive = true;
    this.protected = false;
    this.mag = WEAPONS[DEFAULT_WEAPON].magSize;
    this.reserve = WEAPONS[DEFAULT_WEAPON].reserve;
    this.reloading = false;
    this.kills = 0;
    this.deaths = 0;
  }
}
defineTypes(Player, {
  name: 'string', bot: 'boolean', character: 'string',
  team: 'int8', lives: 'uint8',
  x: 'float32', y: 'float32', z: 'float32',
  vx: 'float32', vy: 'float32', vz: 'float32',
  yaw: 'float32', pitch: 'float32',
  crouch: 'boolean', ads: 'boolean', walk: 'boolean',
  grounded: 'boolean',
  seq: 'uint32',
  hp: 'uint8', alive: 'boolean', protected: 'boolean',
  mag: 'uint8', reserve: 'uint16', reloading: 'boolean',
  kills: 'uint16', deaths: 'uint16',
});

class HealthKit extends Schema {
  constructor() {
    super();
    this.x = 0; this.z = 0;
    this.type = 'pack';   // 'pack' (full heal) | 'pain' (regen buff)
    this.active = true;
  }
}
defineTypes(HealthKit, { x: 'float32', z: 'float32', type: 'string', active: 'boolean' });

class ArenaState extends Schema {
  constructor() {
    super();
    this.serverTime = 0;
    this.players = new MapSchema();
    this.kits = new MapSchema();
    // match state (single source for the client HUD)
    this.mode = MODES.PRACTICE;
    this.phase = PHASE.LIVE;
    this.phaseEndsAt = 0;
    this.round = 0;          // tagteam current round (1-based)
    this.roundsA = 0;        // tagteam round wins
    this.roundsB = 0;
    this.scoreA = 0;         // tagteam kills this round (per team)
    this.scoreB = 0;
    this.aliveCount = 0;     // survival: players still in
    this.winnerTeam = TEAM.NONE;
    this.winnerText = '';
  }
}
defineTypes(ArenaState, {
  serverTime: 'float64',
  players: { map: Player },
  kits: { map: HealthKit },
  mode: 'string', phase: 'string', phaseEndsAt: 'float64',
  round: 'uint8', roundsA: 'uint8', roundsB: 'uint8',
  scoreA: 'uint16', scoreB: 'uint16',
  aliveCount: 'uint8', winnerTeam: 'int8', winnerText: 'string',
  botFill: 'boolean',
});

// ---------------------------------------------------------------------------
export class ArenaRoom extends Room {
  onCreate(options = {}) {
    this.mode = [MODES.DM, MODES.SURVIVAL, MODES.TAGTEAM, MODES.TDM].includes(options.mode) ? options.mode : MODES.PRACTICE;
    this.isMatch = this.mode !== MODES.PRACTICE;
    this.teamMode = this.mode === MODES.TAGTEAM || this.mode === MODES.TDM; // has Blue/Red teams
    // "unlimited respawn" modes: kills never spend lives, players always come back
    this.endlessRespawn = this.mode === MODES.TDM || this.mode === MODES.DM;
    // The room CREATOR (first joiner) decides whether empty slots fill with
    // bots. Default on. Off -> the match waits for MATCH.MIN_HUMANS humans.
    this.botFill = options.bots !== false;
    this.maxClients = ROOM.MAX_PLAYERS;

    this.setState(new ArenaState());
    this.state.mode = this.mode;
    this.state.botFill = this.botFill;
    this.setPatchRate(1000 / NET.PATCH_HZ);

    // Non-synced per-entity simulation bookkeeping, keyed by sessionId/botId.
    this.sims = new Map();
    this.spawnCounter = 0;
    this._teamSpawnN = {};
    this._botN = 0;

    this.onMessage('i', (client, steps) => this.enqueueInputs(client, steps));
    this.onMessage('fire', (client, msg) => this.onFire(client.sessionId, msg));
    this.onMessage('reload', (client) => this.startReload(client.sessionId));
    this.onMessage('resupply', (client) => this.tryResupply(client.sessionId));
    this.onMessage('setchar', (client, id) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.character = sanitizeCharacter(id);
    });
    this.onMessage('ping', (client, t) => client.send('pong', t));

    if (this.isMatch) {
      this.startMatch(0);
    } else {
      // practice: Phase-2 behaviour — the fixed practice bots, always live.
      this.state.phase = PHASE.LIVE;
      for (const spec of BOT_SPECS) this.addBot(spec, createBotState(spec));
    }

    this._kitRespawn = new Map(); // kitId -> serverTime to reappear
    this.spawnKits();

    this.setSimulationInterval((dtMs) => this.update(dtMs), 1000 / NET.SIM_HZ);
    console.log(`[arena] room ${this.roomId} created — mode=${this.mode}`);
  }

  // ---- health kits ----------------------------------------------------------
  // A random point on open ground (not inside an obstacle box, away from edges).
  openPoint() {
    for (let i = 0; i < 30; i++) {
      const x = (Math.random() * 2 - 1) * (MAP.half - 3);
      const z = (Math.random() * 2 - 1) * (MAP.half - 3);
      let blocked = false;
      for (const b of MAP.boxes) {
        if (x > b.cx - b.hx - 1 && x < b.cx + b.hx + 1 && z > b.cz - b.hz - 1 && z < b.cz + b.hz + 1) { blocked = true; break; }
      }
      if (!blocked) return { x, z };
    }
    return { x: 0, z: 0 };
  }

  spawnKits() {
    let i = 0;
    for (let k = 0; k < HEALTHPACK.COUNT; k++) this._addKit(`k${i++}`, 'pack');
    for (let k = 0; k < PAINKILLER.COUNT; k++) this._addKit(`k${i++}`, 'pain');
  }

  _addKit(id, type) {
    const kit = new HealthKit();
    const p = this.openPoint();
    kit.x = p.x; kit.z = p.z; kit.type = type; kit.active = true;
    this.state.kits.set(id, kit);
  }

  // Pickup + respawn. healthpack -> instant full heal; painkiller -> a regen
  // buff (heal over time). Each kit reappears elsewhere after its RESPAWN_MS.
  updateKits(now, dt) {
    this.state.kits.forEach((kit, id) => {
      const cfg = kit.type === 'pain' ? PAINKILLER : HEALTHPACK;
      if (!kit.active) {
        if (now >= (this._kitRespawn.get(id) || 0)) {
          const p = this.openPoint();
          kit.x = p.x; kit.z = p.z; kit.active = true;
        }
        return;
      }
      const r2 = cfg.RADIUS * cfg.RADIUS;
      let taken = false;
      this.state.players.forEach((pl, pid) => {
        if (taken || !pl.alive) return;
        if (!this.isMatch && pl.bot) return; // practice bots don't consume kits (keeps tests deterministic)
        const dx = pl.x - kit.x, dz = pl.z - kit.z;
        if (dx * dx + dz * dz > r2) return;
        const sim = this.sims.get(pid);
        if (kit.type === 'pain') {
          if (pl.hp >= PAINKILLER.CAP) return;   // no point taking it at cap
          sim.regenUntil = now + PAINKILLER.DURATION_MS;
          sim.regenRate = PAINKILLER.REGEN_PER_SEC;
          this.sendTo(pid, 'heal', { kind: 'pain', at: [kit.x, 0, kit.z] });
        } else {
          if (pl.hp >= COMBAT.MAX_HP) return;    // don't waste a full pack
          pl.hp = COMBAT.MAX_HP;
          this.sendTo(pid, 'heal', { kind: 'pack', hp: pl.hp, at: [kit.x, 0, kit.z] });
        }
        kit.active = false;
        this._kitRespawn.set(id, now + cfg.RESPAWN_MS);
        taken = true;
      });
    });
  }

  // F-triggered resupply: refill the bag to the cap if standing at a station.
  tryResupply(id) {
    const p = this.state.players.get(id);
    if (!p || !p.alive || p.reserve >= AMMO.RESERVE_CAP) return;
    const r2 = AMMO.STATION_RADIUS * AMMO.STATION_RADIUS;
    for (const st of AMMO_STATIONS) {
      const dx = p.x - st.x, dz = p.z - st.z;
      if (dx * dx + dz * dz <= r2) { p.reserve = AMMO.RESERVE_CAP; this.sendTo(id, 'resupplied', {}); return; }
    }
  }

  // Apply the painkiller regen buff (integer HP is uint8, so accumulate the
  // fractional heal in the sim and only bump hp by whole points).
  applyRegen(p, sim, now, dt) {
    if (!sim.regenUntil || now >= sim.regenUntil || p.hp >= PAINKILLER.CAP) return;
    sim.regenAccum = (sim.regenAccum || 0) + sim.regenRate * dt;
    const whole = Math.floor(sim.regenAccum);
    if (whole > 0) { p.hp = Math.min(PAINKILLER.CAP, p.hp + whole); sim.regenAccum -= whole; }
  }

  // ---- entity setup ---------------------------------------------------------
  makeSim(x, y, z, yaw) {
    return {
      move: makeMoveState(x, y, z),
      queue: [],
      tokens: NET.TOKENS_MAX,
      lastSeq: 0,
      lastInput: { ...NEUTRAL_INPUT, yaw },
      lastFireAt: -1e9,
      reloadEndsAt: 0,
      respawnAt: 0,
      protectedUntil: 0,
      preferredTeam: TEAM.NONE, // party team pick (tag team) — honored on assign
      regenUntil: 0, regenRate: 0, regenAccum: 0, // painkiller heal-over-time
      history: [], // ring of {t, x, y, z, yaw, crouch} for lag compensation
      bot: null,
    };
  }

  // Spawn point respecting mode/team: FFA uses the whole ring, tag team puts
  // each team on an opposing arc.
  spawnFor(team) {
    if (this.isMatch && (team === TEAM.A || team === TEAM.B)) {
      const base = team === TEAM.A ? 0 : 6;
      const n = (this._teamSpawnN[team] = (this._teamSpawnN[team] || 0) + 1) - 1;
      return spawnPoint(base + (n % 5));
    }
    return spawnPoint(this.spawnCounter++);
  }

  // Reposition + refill a player for a fresh life. Does NOT touch lives/team
  // (those are owned by the round/match setup).
  spawnPose(p, sim) {
    let sp;
    if (this.isMatch) sp = this.spawnFor(p.team);
    else sp = sim.bot ? sim.bot.spec.spawn : spawnPoint(this.spawnCounter++);

    sim.move = makeMoveState(sp.x, 0, sp.z);
    sim.lastInput = { ...NEUTRAL_INPUT, yaw: sp.yaw };
    sim.history.length = 0;
    sim.queue.length = 0;
    p.x = sp.x; p.y = 0; p.z = sp.z; p.yaw = sp.yaw;
    p.hp = COMBAT.MAX_HP;
    p.alive = true;
    p.mag = WEAPONS[DEFAULT_WEAPON].magSize;
    p.reserve = AMMO.START_RESERVE; // fresh bag on (re)spawn; top up at a station
    p.reloading = false;
    sim.reloadEndsAt = 0;
    sim.respawnAt = 0;
    sim.regenUntil = 0; sim.regenAccum = 0; // clear any painkiller regen

    // brief spawn protection: everyone in match modes, humans in practice
    const protect = this.isMatch ? true : !sim.bot;
    if (protect) {
      sim.protectedUntil = this.state.serverTime + COMBAT.SPAWN_PROTECT_MS;
      p.protected = true;
    } else {
      sim.protectedUntil = 0;
      p.protected = false;
    }
  }

  addBot(spec, botState) {
    const p = new Player();
    p.name = spec.name;
    p.bot = true;
    p.character = randomCharacter(); // bots wear real characters, never recruit
    p.x = spec.spawn.x; p.y = 0; p.z = spec.spawn.z; p.yaw = spec.spawn.yaw;
    this.state.players.set(spec.id, p);

    const sim = this.makeSim(spec.spawn.x, 0, spec.spawn.z, spec.spawn.yaw);
    sim.bot = botState;
    sim.protectedUntil = 0;
    p.protected = false;
    this.sims.set(spec.id, sim);
    return p;
  }

  // Returns the new bot's id (its Player is this.state.players.get(id)).
  addBackfillBot() {
    const id = `bot:b${this._botN++}`;
    const name = `[BOT] ${BOT_NAMES[this._botN % BOT_NAMES.length]}`;
    const spec = { id, name, kind: 'chaser', spawn: spawnPoint(this.spawnCounter++) };
    this.addBot(spec, createBotState(spec));
    return id;
  }

  removeOneBot() {
    for (const [id, p] of this.state.players) {
      if (p.bot) { this.state.players.delete(id); this.sims.delete(id); return true; }
    }
    return false;
  }

  countHumans() {
    let n = 0;
    this.state.players.forEach((p) => { if (!p.bot) n++; });
    return n;
  }

  // ---- match state machine --------------------------------------------------
  // A match can start when bots fill the empties, or (bots off) enough humans.
  canStart() { return this.botFill || this.countHumans() >= MATCH.MIN_HUMANS; }

  get cfg() {
    return this.mode === MODES.TDM ? MATCH.TDM
      : this.mode === MODES.DM ? MATCH.DM
      : this.mode === MODES.TAGTEAM ? MATCH.TAGTEAM : MATCH.SURVIVAL;
  }

  // Starting lives per round/match. TDM/DM respawns are unlimited (onKill never
  // decrements), so their nominal value is irrelevant.
  startingLives() {
    if (this.endlessRespawn) return 1;
    if (this.mode === MODES.TAGTEAM) return MATCH.TAGTEAM.livesPerRound;
    return MATCH.SURVIVAL.lives;
  }

  startMatch(now) {
    // clear old bots; refill ONLY when bots are enabled
    for (const id of [...this.state.players.keys()]) {
      if (this.state.players.get(id).bot) { this.state.players.delete(id); this.sims.delete(id); }
    }
    this._botN = 0;
    if (this.botFill) {
      const humans = this.countHumans();
      for (let i = humans; i < this.cfg.botFillTo; i++) this.addBackfillBot();
    }

    this.assignTeams();

    this.state.round = 1;
    this.state.roundsA = 0; this.state.roundsB = 0;
    this.state.scoreA = 0; this.state.scoreB = 0;
    this.state.winnerTeam = TEAM.NONE;
    this.state.winnerText = '';
    this.state.players.forEach((p) => { p.kills = 0; p.deaths = 0; });

    this.resetRound(this.startingLives());

    if (this.canStart()) this.toWarmup(now);
    else {
      this.state.phase = PHASE.WAITING;
      this.state.phaseEndsAt = 0;
      this.announce('WAITING FOR PLAYERS', `need ${MATCH.MIN_HUMANS}+ to start`, 2500);
    }
  }

  toWarmup(now) {
    this.state.phase = PHASE.WARMUP;
    this.state.phaseEndsAt = now + MATCH.WARMUP_MS;
    const title = this.mode === MODES.TAGTEAM ? 'TAG TEAM · 5v5'
      : this.mode === MODES.TDM ? 'TEAM DEATHMATCH · 5v5'
      : this.mode === MODES.DM ? 'DEATHMATCH · free-for-all'
      : 'SURVIVAL · last one standing';
    this.announce(title, 'Get ready…', MATCH.WARMUP_MS);
  }

  // Assign teams honoring party preferences first, then balancing the rest.
  assignTeams() {
    if (!this.teamMode) {
      this.state.players.forEach((p) => { p.team = TEAM.NONE; });
      return;
    }
    this._teamSpawnN = {};
    const ids = [...this.state.players.keys()];
    for (let i = ids.length - 1; i > 0; i--) { // shuffle so unassigned fill fairly
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const counts = { [TEAM.A]: 0, [TEAM.B]: 0 };
    const rest = [];
    for (const id of ids) this.state.players.get(id).team = TEAM.NONE;
    // 1) seat players who requested a team (respecting the 5-per-team cap) —
    //    this keeps a party that all picked "Blue" together on Blue.
    for (const id of ids) {
      const sim = this.sims.get(id);
      const pref = sim ? sim.preferredTeam : TEAM.NONE;
      if ((pref === TEAM.A || pref === TEAM.B) && counts[pref] < ROOM.TEAM_SIZE) {
        this.state.players.get(id).team = pref;
        counts[pref]++;
      } else {
        rest.push(id);
      }
    }
    // 2) balance everyone else (auto pickers + bots) into the smaller team
    for (const id of rest) {
      const t = counts[TEAM.A] <= counts[TEAM.B] ? TEAM.A : TEAM.B;
      this.state.players.get(id).team = t;
      counts[t]++;
    }
  }

  // Set everyone's lives and respawn them for the start of a round.
  resetRound(lives) {
    this._teamSpawnN = {};
    let n = 0;
    this.state.players.forEach((p, id) => {
      const sim = this.sims.get(id);
      if (!sim) return;
      p.lives = lives;
      this.spawnPose(p, sim);
      n++;
    });
    this.state.aliveCount = n; // never show 0 during warmup/first live tick
  }

  // Called every tick while in a match. Advances the phase machine.
  tickMatch(now) {
    switch (this.state.phase) {
      case PHASE.WAITING:
        // bots disabled — hold until enough humans, then set up + warm up
        if (this.canStart()) {
          this.assignTeams();
          this.resetRound(this.startingLives());
          this.toWarmup(now);
        } else {
          this.state.aliveCount = this.countHumans(); // show the join count
        }
        break;
      case PHASE.WARMUP:
        if (now >= this.state.phaseEndsAt) {
          this.state.phase = PHASE.LIVE;
          if (this.endlessRespawn) this.state.phaseEndsAt = now + this.cfg.timeLimitMs; // match clock (TDM/DM)
          this.announce(this.mode === MODES.TAGTEAM ? `Round ${this.state.round}` : 'FIGHT!', '', 1400);
        }
        break;
      case PHASE.LIVE:
        this.checkWin(now);
        break;
      case PHASE.INTERMISSION:
        if (now >= this.state.phaseEndsAt) this.beginNextRound(now);
        break;
      case PHASE.ENDED:
        if (now >= this.state.phaseEndsAt) this.startMatch(now);
        break;
    }
  }

  checkWin(now) {
    if (this.mode === MODES.SURVIVAL) {
      let inPlay = 0, last = null;
      this.state.players.forEach((p) => {
        if (p.lives > 0 || p.alive) { inPlay++; last = p; }
      });
      this.state.aliveCount = inPlay;
      if (inPlay <= 1) this.endMatch(TEAM.NONE, last ? `${last.name} wins!` : 'Draw', now);
      return;
    }
    if (this.mode === MODES.DM) {
      // free-for-all deathmatch: first player to the kill target, or the top
      // fragger when the clock runs out (a tie for the lead at time-up = draw).
      let max = 0;
      this.state.players.forEach((p) => { if (p.kills > max) max = p.kills; });
      const leaders = [];
      this.state.players.forEach((p) => { if (p.kills === max) leaders.push(p); });
      this.state.aliveCount = this.state.players.size;
      if (max >= MATCH.DM.killTarget && leaders.length) {
        return this.endMatch(TEAM.NONE, `${leaders[0].name} WINS`, now);
      }
      if (now >= this.state.phaseEndsAt) {
        this.endMatch(TEAM.NONE, (max > 0 && leaders.length === 1) ? `${leaders[0].name} WINS` : 'DRAW', now);
      }
      return;
    }
    if (this.mode === MODES.TDM) {
      // team deathmatch: first to the kill target, or higher score at time-up
      const t = MATCH.TDM.killTarget;
      if (this.state.scoreA >= t) return this.endMatch(TEAM.A, 'BLUE TEAM WINS', now);
      if (this.state.scoreB >= t) return this.endMatch(TEAM.B, 'RED TEAM WINS', now);
      if (now >= this.state.phaseEndsAt) {
        const a = this.state.scoreA, b = this.state.scoreB;
        const w = a === b ? TEAM.NONE : (a > b ? TEAM.A : TEAM.B);
        this.endMatch(w, w === TEAM.NONE ? 'DRAW' : (w === TEAM.A ? 'BLUE TEAM WINS' : 'RED TEAM WINS'), now);
      }
      return;
    }
    // tag team: eliminate the enemy team OR reach the kill target
    let aliveA = 0, aliveB = 0;
    this.state.players.forEach((p) => {
      const inPlay = p.lives > 0 || p.alive;
      if (!inPlay) return;
      if (p.team === TEAM.A) aliveA++;
      else if (p.team === TEAM.B) aliveB++;
    });
    const target = MATCH.TAGTEAM.killTarget;
    if (this.state.scoreA >= target || aliveB === 0) this.endRound(TEAM.A, now);
    else if (this.state.scoreB >= target || aliveA === 0) this.endRound(TEAM.B, now);
  }

  endRound(team, now) {
    if (team === TEAM.A) this.state.roundsA++; else this.state.roundsB++;
    const toWin = Math.ceil(MATCH.TAGTEAM.rounds / 2);
    const teamName = team === TEAM.A ? 'BLUE' : 'RED';
    if (this.state.roundsA >= toWin || this.state.roundsB >= toWin) {
      this.endMatch(team, `${teamName} TEAM WINS`, now);
    } else {
      this.state.phase = PHASE.INTERMISSION;
      this.state.phaseEndsAt = now + MATCH.INTERMISSION_MS;
      this.announce(`${teamName} wins the round`, `${this.state.roundsA} – ${this.state.roundsB}`, MATCH.INTERMISSION_MS);
    }
  }

  beginNextRound(now) {
    this.state.round++;
    this.state.scoreA = 0; this.state.scoreB = 0;
    this.resetRound(MATCH.TAGTEAM.livesPerRound);
    this.state.phase = PHASE.LIVE;
    this.announce(`Round ${this.state.round}`, 'FIGHT!', 1400);
  }

  endMatch(winnerTeam, text, now) {
    this.state.winnerTeam = winnerTeam;
    this.state.winnerText = text;
    this.state.phase = PHASE.ENDED;
    this.state.phaseEndsAt = now + MATCH.INTERMISSION_MS;
    this.announce(text, 'New match starting…', MATCH.INTERMISSION_MS);
  }

  announce(text, sub, ms) {
    this.broadcast('announce', { text, sub: sub || '', ms: ms || 2500 });
  }

  onJoin(client, options = {}) {
    const p = new Player();
    p.name = String(options.name || 'guest').replace(/[^\w \-\[\]]/g, '').slice(0, 20) || 'guest';
    p.character = sanitizeCharacter(options.character);
    this.state.players.set(client.sessionId, p);
    const sim = this.makeSim(0, 0, 0, 0);
    this.sims.set(client.sessionId, sim);

    if (this.isMatch) {
      sim.preferredTeam = parseTeamPref(options.team);
      if (this.teamMode) {
        this.seatHumanOnTeam(p, sim); // evict a bot so the human gets their side
      } else {
        while (this.state.players.size > ROOM.MAX_PLAYERS && this.removeOneBot()) { /* freed a slot */ }
        p.team = TEAM.NONE;
      }
      p.lives = this.joinLives(); // mid-round tag-team joiners get a single life
      this.spawnPose(p, sim);
    } else {
      this.spawnPose(p, sim);
    }
    console.log(`[arena:${this.mode}] ${this.roomId} +${client.sessionId} "${p.name}" team=${p.team} (${this.clients.length} humans)`);
  }

  smallerTeam() {
    let a = 0, b = 0;
    this.state.players.forEach((p) => { if (p.team === TEAM.A) a++; else if (p.team === TEAM.B) b++; });
    return a <= b ? TEAM.A : TEAM.B;
  }

  teamCount(team) {
    let n = 0;
    this.state.players.forEach((p) => { if (p.team === team) n++; });
    return n;
  }

  // Lives for a player joining/backfilling. Full at round setup; but MID-ROUND
  // in tag team they get a single life — otherwise a fresh full-lives body
  // resurrects a team's spent life pool and undoes elimination progress
  // (resetRound restores everyone to full lives at the next round anyway).
  joinLives() {
    if (this.mode === MODES.TAGTEAM) {
      return this.state.phase === PHASE.LIVE ? 1 : MATCH.TAGTEAM.livesPerRound;
    }
    return this.startingLives(); // survival lives, or TDM's nominal (unlimited)
  }

  removeBotFromTeam(team) {
    for (const [id, p] of this.state.players) {
      if (p.bot && p.team === team) { this.state.players.delete(id); this.sims.delete(id); return true; }
    }
    return false;
  }

  // Seat a joining human on their preferred team (auto -> smaller). Bots pre-fill
  // both teams, so honoring "Blue" means EVICTING a bot from Blue to free the
  // slot — humans always displace bots, keeping 5v5. The room stays at cap
  // because exactly one bot leaves per human that joins a full match.
  seatHumanOnTeam(p, sim) {
    const pref = sim.preferredTeam;
    let desired = (pref === TEAM.A || pref === TEAM.B) ? pref : this.smallerTeam();
    if (this.state.players.size > ROOM.MAX_PLAYERS) {
      if (!this.removeBotFromTeam(desired)) {
        // desired side is all humans — take the other side instead
        const other = desired === TEAM.A ? TEAM.B : TEAM.A;
        if (this.removeBotFromTeam(other)) desired = other;
        else this.removeOneBot();
      }
    }
    p.team = this.teamCount(desired) < ROOM.TEAM_SIZE ? desired : this.smallerTeam();
  }

  onLeave(client) {
    this.state.players.delete(client.sessionId);
    this.sims.delete(client.sessionId);
    // keep matches fair: refill the vacated slot with a bot mid-match (bots on)
    if (this.isMatch && this.botFill && this.state.phase !== PHASE.ENDED) {
      if (this.state.players.size < this.cfg.botFillTo) {
        const id = this.addBackfillBot();
        const bot = this.state.players.get(id);
        bot.team = this.teamMode ? this.smallerTeam() : TEAM.NONE;
        bot.lives = this.joinLives(); // mid-round tag-team backfill gets a single life
        this.spawnPose(bot, this.sims.get(id));
      }
    }
    console.log(`[arena:${this.mode}] ${this.roomId} -${client.sessionId} (${this.clients.length} humans)`);
  }

  onDispose() {
    console.log(`[arena] room ${this.roomId} disposed`);
  }

  // ---- input ingestion (humans) ---------------------------------------------
  enqueueInputs(client, steps) {
    const sim = this.sims.get(client.sessionId);
    if (!sim || !Array.isArray(steps)) return;
    const n = Math.min(steps.length, NET.INPUT_QUEUE_MAX);
    for (let i = 0; i < n; i++) {
      const inp = sanitizeInput(steps[i]);
      if (!inp) continue;
      const last = sim.queue.length ? sim.queue[sim.queue.length - 1].seq : sim.lastSeq;
      if (inp.seq <= last || inp.seq > last + 512) continue;
      if (sim.queue.length >= NET.INPUT_QUEUE_MAX) sim.queue.shift();
      sim.queue.push(inp);
    }
  }

  // ---- combat ----------------------------------------------------------------
  startReload(id) {
    const p = this.state.players.get(id);
    const sim = this.sims.get(id);
    if (!p || !sim || !p.alive || p.reloading) return;
    const weapon = WEAPONS[DEFAULT_WEAPON];
    if (p.mag >= weapon.magSize || p.reserve <= 0) return;
    p.reloading = true;
    sim.reloadEndsAt = this.state.serverTime + weapon.reloadMs;
  }

  finishReloads(now) {
    this.state.players.forEach((p, id) => {
      if (!p.reloading) return;
      const sim = this.sims.get(id);
      if (!sim || now < sim.reloadEndsAt) return;
      const weapon = WEAPONS[DEFAULT_WEAPON];
      const want = weapon.magSize - p.mag;
      const take = Math.min(want, p.reserve);
      p.mag += take;
      p.reserve -= take;
      p.reloading = false;
    });
  }

  // msg: { o: [x,y,z] client muzzle, d: [x,y,z] dir, t: rewind timestamp }
  onFire(shooterId, msg) {
    // no combat outside the live phase (warmup / intermission / ended)
    if (this.isMatch && this.state.phase !== PHASE.LIVE) return;

    const p = this.state.players.get(shooterId);
    const sim = this.sims.get(shooterId);
    if (!p || !sim || !p.alive || p.reloading) return;

    const weapon = WEAPONS[DEFAULT_WEAPON];
    const now = this.state.serverTime;

    if (now - sim.lastFireAt < weapon.intervalMs * COMBAT.FIRE_RATE_SLACK) return;
    if (p.mag <= 0) return;

    if (!msg || !Array.isArray(msg.d) || msg.d.length !== 3) return;
    let dx = +msg.d[0], dy = +msg.d[1], dz = +msg.d[2];
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return;
    const dl = Math.hypot(dx, dy, dz);
    if (dl < 1e-6) return;
    dx /= dl; dy /= dl; dz /= dl;

    let t = Number.isFinite(+msg.t) ? +msg.t : now - NET.INTERP_MS;
    t = Math.min(now, Math.max(now - COMBAT.REWIND_MAX_MS, t));

    const serverMuzzle = muzzleFor({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, crouch: p.crouch });
    let m = serverMuzzle;
    if (Array.isArray(msg.o) && msg.o.length === 3) {
      const ox = +msg.o[0], oy = +msg.o[1], oz = +msg.o[2];
      if (Number.isFinite(ox) && Number.isFinite(oy) && Number.isFinite(oz) &&
          Math.hypot(ox - serverMuzzle.x, oy - serverMuzzle.y, oz - serverMuzzle.z) <= 1.25) {
        m = { x: ox, y: oy, z: oz };
      }
    }

    sim.lastFireAt = now;
    p.mag -= 1;
    if (p.protected) { p.protected = false; sim.protectedUntil = 0; }

    const tWorld = rayVsWorld(m.x, m.y, m.z, dx, dy, dz, weapon.range);

    // nearest ENEMY victim among rewound hitboxes (no friendly fire in tag team)
    let victimId = null, victimPart = null, victimT = Infinity;
    this.state.players.forEach((q, qid) => {
      if (qid === shooterId || !q.alive || q.protected) return;
      if (this.teamMode && q.team === p.team) return; // no friendly fire
      const pose = this.poseAt(qid, t);
      if (!pose) return;
      const hit = rayVsPlayer(m.x, m.y, m.z, dx, dy, dz, pose, weapon.range);
      if (hit && hit.t < victimT) { victimId = qid; victimPart = hit.part; victimT = hit.t; }
    });

    const endT = Math.min(victimT, tWorld, weapon.range);
    this.broadcast('shot', {
      id: shooterId,
      to: [m.x + dx * endT, m.y + dy * endT, m.z + dz * endT],
      wall: victimT > tWorld,
    });

    if (victimId === null || victimT > tWorld) return; // blocked or missed

    const victim = this.state.players.get(victimId);
    const dmg = damageFor(weapon, victimT, victimPart);
    victim.hp = Math.max(0, victim.hp - dmg);
    const killed = victim.hp === 0;

    this.sendTo(shooterId, 'hitconf', {
      id: victimId, part: victimPart, dmg, killed,
      at: [m.x + dx * victimT, m.y + dy * victimT, m.z + dz * victimT],
    });
    this.sendTo(victimId, 'damaged', { from: [p.x, p.y, p.z], dmg });

    if (killed) this.onKill(shooterId, victimId, victimPart === 'head');
  }

  onKill(killerId, victimId, headshot) {
    const killer = this.state.players.get(killerId);
    const victim = this.state.players.get(victimId);
    const vSim = this.sims.get(victimId);
    if (killer) killer.kills += 1;
    victim.deaths += 1;
    victim.alive = false;
    victim.reloading = false;
    vSim.queue.length = 0;

    if (this.isMatch) {
      // team score = kills by the killer's team (tag team + TDM)
      if (this.teamMode && killer) {
        if (killer.team === TEAM.A) this.state.scoreA += 1;
        else if (killer.team === TEAM.B) this.state.scoreB += 1;
      }
      if (this.endlessRespawn) {
        vSim.respawnAt = this.state.serverTime + MATCH.RESPAWN_MS; // unlimited respawns (TDM/DM)
      } else {
        victim.lives = Math.max(0, victim.lives - 1);
        // respawn only if lives remain; otherwise eliminated for the round/match
        vSim.respawnAt = victim.lives > 0 ? this.state.serverTime + MATCH.RESPAWN_MS : Infinity;
      }
    } else {
      vSim.respawnAt = this.state.serverTime + COMBAT.RESPAWN_MS; // practice: unlimited
    }

    this.broadcast('kill', {
      killer: killer ? killer.name : '?', victim: victim.name,
      killerId, victimId, headshot,
      killerTeam: killer ? killer.team : TEAM.NONE, victimTeam: victim.team,
      weapon: WEAPONS[DEFAULT_WEAPON].name,
    });
    this.sendTo(victimId, 'died', {
      by: killer ? killer.name : '?',
      respawnMs: this.isMatch ? MATCH.RESPAWN_MS : COMBAT.RESPAWN_MS,
      eliminated: this.isMatch && victim.lives <= 0,
      lives: victim.lives,
    });
  }

  sendTo(id, type, payload) {
    if (id.startsWith('bot:')) return;
    const client = this.clients.find((c) => c.sessionId === id);
    if (client) client.send(type, payload);
  }

  poseAt(id, t) {
    const sim = this.sims.get(id);
    if (!sim) return null;
    const h = sim.history;
    if (!h.length) {
      const p = this.state.players.get(id);
      return p ? { x: p.x, y: p.y, z: p.z, yaw: p.yaw, crouch: p.crouch } : null;
    }
    if (t <= h[0].t) return h[0];
    const newest = h[h.length - 1];
    if (t >= newest.t) return newest;
    for (let i = h.length - 2; i >= 0; i--) {
      if (h[i].t <= t) {
        const a = h[i], b = h[i + 1];
        const k = (t - a.t) / (b.t - a.t || 1);
        return {
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          z: a.z + (b.z - a.z) * k,
          yaw: b.yaw, crouch: b.crouch,
        };
      }
    }
    return newest;
  }

  // Enemy targets for a bot: humans-only in practice (preserves Phase-2 feel);
  // all alive enemies (different team / everyone in FFA) in match modes.
  enemyTargets(botId, botTeam, roster) {
    const out = [];
    for (const r of roster) {
      if (r.id === botId) continue;
      if (this.isMatch) {
        if (this.mode === MODES.TAGTEAM && r.team === botTeam) continue;
      } else if (r.bot) {
        continue; // practice bots only chase humans
      }
      out.push(r);
    }
    return out;
  }

  // ---- main tick --------------------------------------------------------------
  update(dtMs) {
    const dt = dtMs / 1000;
    this.state.serverTime += dtMs;
    const now = this.state.serverTime;

    this.finishReloads(now);
    this.updateKits(now, dt);
    if (this.isMatch) this.tickMatch(now);

    // roster snapshot for bot targeting (built once per tick)
    const roster = [];
    this.state.players.forEach((p, id) => {
      roster.push({
        id, bot: p.bot, team: p.team, alive: p.alive, protected: p.protected,
        pose: { x: p.x, y: p.y, z: p.z, crouch: p.crouch },
      });
    });

    const combatLive = !this.isMatch || this.state.phase === PHASE.LIVE;

    this.state.players.forEach((p, id) => {
      const sim = this.sims.get(id);
      if (!sim) return;

      // ---- respawn & protection timers ----
      if (!p.alive && now >= sim.respawnAt) {
        if (!this.isMatch || this.endlessRespawn || p.lives > 0) this.spawnPose(p, sim);
      }
      if (p.protected && now >= sim.protectedUntil) p.protected = false;

      if (!p.alive) return; // corpses don't move or think

      this.applyRegen(p, sim, now, dt); // painkiller heal-over-time

      if (sim.bot) {
        const targets = this.enemyTargets(id, p.team, roster);
        const { input, fireDir, wantReload } = botThink(
          sim.bot, { x: sim.move.x, y: sim.move.y, z: sim.move.z, crouch: false },
          targets, now, dt, p.mag
        );
        stepPlayer(sim.move, input, MAP, dt);
        sim.lastInput = input;
        if (wantReload) this.startReload(id);
        if (fireDir && combatLive && !p.reloading) this.onFire(id, { d: [fireDir.x, fireDir.y, fireDir.z], t: now });
      } else {
        sim.tokens = Math.min(sim.tokens + NET.INPUT_HZ * dt, NET.TOKENS_MAX);
        let processed = 0;
        while (sim.queue.length && sim.tokens >= 1 && processed < NET.MAX_STEPS_PER_TICK) {
          const inp = sim.queue.shift();
          stepPlayer(sim.move, inp, MAP);
          sim.lastSeq = inp.seq;
          sim.lastInput = inp;
          sim.tokens -= 1;
          processed++;
        }
        if (processed === 0) {
          const idle = sim.lastInput;
          stepPlayer(sim.move, {
            seq: idle.seq, mx: 0, mz: 0, yaw: idle.yaw, pitch: idle.pitch,
            jump: false, crouch: idle.crouch, walk: idle.walk, ads: idle.ads,
          }, MAP, dt);
        }
      }

      // ---- write-through to synced schema ----
      const m = sim.move, li = sim.lastInput;
      p.x = m.x; p.y = m.y; p.z = m.z;
      p.vx = m.vx; p.vy = m.vy; p.vz = m.vz;
      p.grounded = m.grounded;
      p.yaw = li.yaw; p.pitch = li.pitch;
      p.crouch = li.crouch; p.ads = li.ads; p.walk = li.walk;
      p.seq = sim.lastSeq;

      sim.history.push({ t: now, x: m.x, y: m.y, z: m.z, yaw: li.yaw, crouch: li.crouch });
      if (sim.history.length > COMBAT.HISTORY_TICKS) sim.history.shift();
    });
  }
}
