// shared/constants.js
// SINGLE SOURCE OF TRUTH shared by the browser client AND the Node server.
// - Server imports it directly:   import { ... } from './shared/constants.js'
// - Client imports it over HTTP:  import { ... } from '/shared/constants.js'
// Movement/netcode constants living here is what keeps client-side prediction
// in lock-step with the authoritative server simulation.
// Plain ESM, no build step, runs identically in Node 18+ and modern browsers.

// Bump whenever the client<->server contract changes so a stale client can be
// detected and told to refresh (checked in later phases).
export const PROTOCOL_VERSION = '0.2.0-phase2';

// Authoritative simulation cadence.
//  - Client samples input at INPUT_HZ fixed steps and predicts locally.
//  - Server drains input queues at SIM_HZ, integrating each input at the same
//    fixed 1/INPUT_HZ dt (dt is NEVER client-supplied — no speed-by-dt cheats).
//  - Colyseus flushes state deltas at PATCH_HZ; remotes render INTERP_MS in
//    the past, lerping between the two bracketing snapshots.
export const NET = {
  SIM_HZ: 30,
  PATCH_HZ: 20,
  INPUT_HZ: 60,
  INTERP_MS: 100,        // remote render delay ≈ 2 patch intervals
  ROOM_ARENA: 'arena',
  // Server-side input pacing (anti-speedup): a token bucket refilled at
  // INPUT_HZ tokens/sec (burst TOKENS_MAX) bounds how many input steps a
  // client can have integrated over any window — flooding extra packets
  // cannot move you faster, it just gets dropped. Catch-up bursts after
  // network jitter are additionally bounded by the queue cap (0.2s of sim),
  // so the worst-case "lurch" a cheater or a hiccup can produce is ~1m.
  TOKENS_MAX: 30,
  INPUT_QUEUE_MAX: 12,   // ~200ms of backlog; older packets are discarded
  MAX_STEPS_PER_TICK: 5, // drain cap per sim tick (jitter catch-up)
};

// Room population. ~50 players are spread across MANY rooms of this size by
// joinOrCreate matchmaking (full room -> a new one spins up automatically).
export const ROOM = {
  MAX_PLAYERS: 10,       // hard room cap (both modes)
  TEAM_SIZE: 5,          // Tag Team is 5v5
};

// Movement tuning (fun-first arcade, PUBG-ish proportions).
// Used verbatim by server sim AND client prediction — do not fork these.
export const MOVE = {
  FIXED_DT: 1 / 60,      // seconds per input step (== 1/INPUT_HZ)
  RUN: 4.7,              // default speed (auto-run design: unmodified = run)
  WALK: 2.6,             // Shift precision walk
  CROUCH: 1.5,           // slower crouch — closer to the crouch-walk clip's pace
  ADS_CAP: 3.2,          // speed ceiling while aiming
  ACCEL_GROUND: 45,      // m/s^2 toward wish velocity (also brakes to 0)
  ACCEL_AIR: 9,          // low air control preserves jump momentum
  GRAVITY: 14,
  JUMP_V: 5.0,           // apex ~0.89m — obstacles are >= 2m so tops are N/A
  RADIUS: 0.4,           // player capsule radius (XZ collision circle)
  HEIGHT: 1.8,
  CROUCH_HEIGHT: 1.25,
  MAX_PITCH: 1.5533,     // ±89° in radians
};

// Third-person camera rig (client-only feel, but centralised here so the
// settings UI and camera agree on ranges).
export const CAM = {
  PIVOT_Y: 1.5,          // shoulder-height pivot above player origin
  ARM_HIP: 2.8,          // spring-arm length, relaxed
  ARM_ADS: 1.5,          // spring-arm length, aiming
  SIDE: 0.45,            // right-shoulder lateral offset (Z swaps sign)
  FOV_HIP: 75,
  FOV_ADS: 52,
  FOV_SCOPE: 28,         // deep zoom for the scope — far easier long-range aim
  COLLIDE_PAD: 0.22,     // pull-in this far in front of whatever the arm hits
  MIN_ARM: 0.35,
};

export const TEAM = { A: 0, B: 1, NONE: -1 };

// ---- Game modes (Phase 3) --------------------------------------------------
// Mode is chosen in the lobby; you join a single-mode room of that type.
// PRACTICE preserves the Phase-2 behaviour (FFA, unlimited respawn, the fixed
// practice bots) — it's the 'arena' room the headless tests use.
export const MODES = { PRACTICE: 'practice', DM: 'dm', SURVIVAL: 'survival', TAGTEAM: 'tagteam', TDM: 'tdm' };

// Match lifecycle phases (single source for server machine + client HUD).
// WAITING: bots disabled and not enough humans yet — the match holds here.
export const PHASE = { WAITING: 'waiting', WARMUP: 'warmup', LIVE: 'live', INTERMISSION: 'intermission', ENDED: 'ended' };

// Match/round pacing + per-mode rules. Bots backfill empty slots so matches
// are fair (Survival isn't 1 player; Tag Team can field 5v5).
export const MATCH = {
  MIN_HUMANS: 2,           // with bots disabled, this many humans are needed to start
  RESPAWN_MS: 3000,        // in-round respawn while the player has lives left
  INTERMISSION_MS: 6000,   // between rounds / matches (scoreboard shown)
  WARMUP_MS: 5000,         // countdown before a match starts

  // Deathmatch: free-for-all, UNLIMITED respawns, no teams. First player to
  // the kill target wins, or the top fragger when the clock runs out.
  DM: { killTarget: 25, timeLimitMs: 300000, botFillTo: 8 },

  // Survival: free-for-all, limited lives, last player with lives wins.
  SURVIVAL: { lives: 3, minStart: 2, botFillTo: 6 },

  // TDM: 5v5 team deathmatch, UNLIMITED respawns. First team to the kill
  // target wins, or the higher score when the clock runs out. Individual kill
  // ranking is shown on the scoreboard.
  TDM: { teamSize: 5, killTarget: 60, timeLimitMs: 300000, botFillTo: 10 },

  // Tag Team: 5v5, best-of-N rounds (random teams). Within a round players
  // respawn but only while they have lives; a round is won by hitting the kill
  // target first OR ELIMINATING the enemy team (spending all their lives).
  // NOTE: a team has teamSize*livesPerRound = 5*4 = 20 total lives, so a full
  // wipe = 20 kills. killTarget MUST be < 20 or the kill-race can never decide
  // a round before a wipe (it just becomes dead code). 15 = a dominant team
  // closes out early; a close round still grinds toward elimination.
  TAGTEAM: { teamSize: 5, livesPerRound: 4, killTarget: 15, rounds: 5, botFillTo: 10 },
};

// Health pickups — two tiers, walked over to collect:
//   healthpack  — instant restore to FULL. Rarer, slower to reappear.
//   painkiller  — gradual heal-over-time (a regen buff). Common, quick respawn.
export const HEALTHPACK = {
  COUNT: 2, RADIUS: 1.5, RESPAWN_MS: 26000,
};
export const PAINKILLER = {
  COUNT: 5, RADIUS: 1.5, RESPAWN_MS: 12000,
  REGEN_PER_SEC: 9,     // HP/second while the buff lasts
  DURATION_MS: 6500,    // ~58 HP total if not interrupted
  CAP: 100,             // regen won't push above this
};

// Ammo bag + resupply stations at the spawn ends.
export const AMMO = {
  RESERVE_CAP: 300,     // max rounds carried in the bag
  START_RESERVE: 120,   // rounds on (re)spawn
  STATION_RADIUS: 3.4,  // stand this close to a resupply table to top up
};

// Combat rules shared by server validation and client feedback.
export const COMBAT = {
  MAX_HP: 100,
  RESPAWN_MS: 4000,
  SPAWN_PROTECT_MS: 3000,   // 3s spawn shield (blue aura); cancelled early on firing
  REWIND_MAX_MS: 300,       // lag-compensation rewind clamp
  HISTORY_TICKS: 32,        // ~1s of hitbox history at SIM_HZ
  FIRE_RATE_SLACK: 0.85,    // server accepts shots at >= interval*slack
};
