// src/server/ai/bots.js
// Phase-2 minimal server-side bots: two practice DUMMIES (stationary +
// strafing) for verifying hit registration, and one CHASER with a tiny
// state machine (wander -> chase -> shoot bursts) so combat is testable solo.
//
// Bots are authoritative "virtual players": the room feeds their synthetic
// inputs through the SAME stepPlayer simulation and their shots through the
// SAME fire-resolution path as humans. Remote clients need no special code.
//
// Bot aim is deliberately human-ish and beatable: capped turn rate, an aim
// error cone, reaction bursts with cooldowns, and hard LOS gating. This is
// NOT the human aim-assist code — bots get their own model (and Phase 6
// turns these knobs into Easy/Normal/Hard difficulty tiers).

import { targetPoint, hasLOS, WEAPONS, DEFAULT_WEAPON } from '../../../shared/combat.js';
import { MAP } from '../../../shared/map.js';
import { wrapAngle } from '../../../shared/movement.js';

export const BOT_SPECS = [
  { id: 'bot:dummy', name: '[BOT] Dummy', kind: 'dummy', spawn: { x: 6, z: 10, yaw: 2.6 } },
  { id: 'bot:strafer', name: '[BOT] Strafer', kind: 'strafer', spawn: { x: -6, z: -10, yaw: -0.55 } },
  { id: 'bot:chaser', name: '[BOT] Chaser', kind: 'chaser', spawn: { x: 0, z: -17, yaw: 0 } },
];

const CHASER = {
  SIGHT_RANGE: 60,
  FIRE_RANGE: 34,          // must close in — no cross-map instakills
  TURN_RATE: 2.2,          // rad/s cap — easier to flank/outturn
  AIM_ERR_RAD: 0.085,      // ~5 degree error cone (was 1.6) — misses a lot more
  ALIGN_TO_FIRE: 0.06,     // must be aimed within ~3.4 degrees to shoot
  REPLAN_MS: 240,          // think on a timer, NOT every tick (cheap CPU)
  REACTION_MS: [380, 620], // delay after ACQUIRING a target before it can fire
  BURST: [2, 3],           // shorter bursts
  BURST_PAUSE_MS: [1000, 1700], // long downtime between bursts — beatable
  HEADSHOT_CHANCE: 0.05,   // rarely aims for the head
};

export function createBotState(spec) {
  return {
    id: spec.id,
    kind: spec.kind,
    spec,
    yaw: spec.spawn.yaw,
    pitch: 0,
    replanAt: 0,
    targetId: null,
    lastKnown: null,          // {x, z} last seen target position
    wander: null,             // {x, z} current wander waypoint
    strafeDir: 1,
    strafeFlipAt: 0,
    burstLeft: 0,
    nextBurstAt: 0,
    lastShotAt: 0,
    engageAt: 0,              // earliest time this bot may fire at a fresh target
  };
}

// Produces this tick's intent for a bot.
//   bot:     mutable bot state (above)
//   selfPose:{x,y,z,crouch} bot's current sim state
//   targets: [{id, pose:{x,y,z,crouch}, alive, protected}] — human players only
//   now:     server time (ms)
//   dt:      tick delta (s)
// Returns { input, fireDir|null, wantReload }
export function botThink(bot, selfPose, targets, now, dt, mag) {
  switch (bot.kind) {
    case 'dummy': return dummyThink(bot);
    case 'strafer': return straferThink(bot, now);
    case 'chaser': return chaserThink(bot, selfPose, targets, now, dt, mag);
    default: return dummyThink(bot);
  }
}

function baseInput(bot) {
  return {
    seq: 0, mx: 0, mz: 0, yaw: bot.yaw, pitch: bot.pitch,
    jump: false, crouch: false, walk: false, ads: false,
  };
}

function dummyThink(bot) {
  return { input: baseInput(bot), fireDir: null, wantReload: false };
}

function straferThink(bot, now) {
  const input = baseInput(bot);
  // square-wave strafe: full-speed side steps, flipping every ~1.4s
  input.mx = Math.sin(now * 0.0045) >= 0 ? 1 : -1;
  return { input, fireDir: null, wantReload: false };
}

function chaserThink(bot, selfPose, targets, now, dt, mag) {
  const eye = { x: selfPose.x, y: selfPose.y + 1.55, z: selfPose.z };

  // ---- replan on a timer: acquire/lose target, pick wander points ----------
  if (now >= bot.replanAt) {
    bot.replanAt = now + CHASER.REPLAN_MS;
    let best = null, bestD = CHASER.SIGHT_RANGE;
    for (const t of targets) {
      if (!t.alive) continue;
      const d = Math.hypot(t.pose.x - selfPose.x, t.pose.z - selfPose.z);
      if (d > bestD) continue;
      const tp = targetPoint(t.pose);
      if (!hasLOS(eye.x, eye.y, eye.z, tp.x, tp.y, tp.z)) continue;
      best = t; bestD = d;
    }
    if (best) {
      // reaction time: a freshly-acquired target can't be shot instantly —
      // the bot needs a beat to react, giving the player the first move.
      if (bot.targetId !== best.id) {
        bot.engageAt = now + CHASER.REACTION_MS[0] + Math.random() * (CHASER.REACTION_MS[1] - CHASER.REACTION_MS[0]);
      }
      bot.targetId = best.id;
      bot.lastKnown = { x: best.pose.x, z: best.pose.z };
    } else if (bot.targetId) {
      bot.targetId = null; // keep lastKnown — go investigate
    }
    if (!bot.targetId && !bot.lastKnown && (!bot.wander || now >= (bot.wanderUntil || 0))) {
      bot.wander = randomOpenPoint();
      bot.wanderUntil = now + 6000;
    }
  }

  const target = bot.targetId ? targets.find((t) => t.id === bot.targetId && t.alive) : null;
  if (bot.targetId && !target) bot.targetId = null;

  const input = baseInput(bot);
  let fireDir = null;

  if (target) {
    const dx = target.pose.x - selfPose.x, dz = target.pose.z - selfPose.z;
    const dist = Math.hypot(dx, dz);
    const wantYaw = Math.atan2(-dx, -dz);

    // capped turn toward the target
    bot.yaw = slewAngle(bot.yaw, wantYaw, CHASER.TURN_RATE * dt);
    input.yaw = bot.yaw;

    // spacing: push in when far, back off when hugged, strafe in between
    input.mz = dist > 10 ? 1 : dist < 4.5 ? -0.5 : 0;
    if (now >= bot.strafeFlipAt) {
      bot.strafeDir = -bot.strafeDir;
      bot.strafeFlipAt = now + 700 + Math.random() * 900;
    }
    if (dist <= 14) input.mx = bot.strafeDir;

    // aim pitch (visual + shot direction)
    const aimAt = targetPoint(target.pose, Math.random() < CHASER.HEADSHOT_CHANCE ? 'head' : 'torso');
    const muzzleY = selfPose.y + 1.42;
    bot.pitch = Math.atan2(aimAt.y - muzzleY, dist);
    input.pitch = bot.pitch;

    // ---- fire control: aligned + LOS + burst pacing -----------------------
    const aligned = Math.abs(wrapAngle(wantYaw - bot.yaw)) < CHASER.ALIGN_TO_FIRE;
    if (aligned && dist <= CHASER.FIRE_RANGE && now >= bot.engageAt) {
      if (bot.burstLeft <= 0 && now >= bot.nextBurstAt) {
        bot.burstLeft = CHASER.BURST[0] + Math.floor(Math.random() * (CHASER.BURST[1] - CHASER.BURST[0] + 1));
      }
      const weapon = WEAPONS[DEFAULT_WEAPON];
      if (bot.burstLeft > 0 && now - bot.lastShotAt >= weapon.intervalMs) {
        const m = { x: selfPose.x, y: muzzleY, z: selfPose.z };
        let dxa = aimAt.x - m.x, dya = aimAt.y - m.y, dza = aimAt.z - m.z;
        const len = Math.hypot(dxa, dya, dza) || 1;
        dxa /= len; dya /= len; dza /= len;
        fireDir = jitterCone(dxa, dya, dza, CHASER.AIM_ERR_RAD);
        bot.lastShotAt = now;
        bot.burstLeft--;
        if (bot.burstLeft <= 0) {
          bot.nextBurstAt = now + CHASER.BURST_PAUSE_MS[0] +
            Math.random() * (CHASER.BURST_PAUSE_MS[1] - CHASER.BURST_PAUSE_MS[0]);
        }
      }
    }
  } else if (bot.lastKnown) {
    moveToward(bot, input, selfPose, bot.lastKnown, dt);
    if (Math.hypot(bot.lastKnown.x - selfPose.x, bot.lastKnown.z - selfPose.z) < 2) bot.lastKnown = null;
  } else if (bot.wander) {
    moveToward(bot, input, selfPose, bot.wander, dt);
    if (Math.hypot(bot.wander.x - selfPose.x, bot.wander.z - selfPose.z) < 2) bot.wander = null;
  }

  return { input, fireDir, wantReload: mag <= 0 };
}

function moveToward(bot, input, selfPose, pt, dt) {
  const wantYaw = Math.atan2(-(pt.x - selfPose.x), -(pt.z - selfPose.z));
  bot.yaw = slewAngle(bot.yaw, wantYaw, CHASER.TURN_RATE * dt);
  bot.pitch = 0;
  input.yaw = bot.yaw;
  input.pitch = 0;
  input.mz = 1;
}

function randomOpenPoint() {
  for (let i = 0; i < 20; i++) {
    const x = (Math.random() * 2 - 1) * (MAP.half - 4);
    const z = (Math.random() * 2 - 1) * (MAP.half - 4);
    let blocked = false;
    for (const b of MAP.boxes) {
      if (x > b.cx - b.hx - 1 && x < b.cx + b.hx + 1 && z > b.cz - b.hz - 1 && z < b.cz + b.hz + 1) { blocked = true; break; }
    }
    if (!blocked) return { x, z };
  }
  return { x: 0, z: 0 };
}

function slewAngle(cur, want, maxStep) {
  const d = wrapAngle(want - cur);
  if (Math.abs(d) <= maxStep) return want;
  return wrapAngle(cur + Math.sign(d) * maxStep);
}

// Random direction within a cone around (dx,dy,dz).
function jitterCone(dx, dy, dz, maxAngle) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * maxAngle;
  // build an orthonormal basis around the dir
  let ux = -dz, uy = 0, uz = dx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uz /= ul;
  const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  const sa = Math.sin(r), ca = Math.cos(r);
  const ox = dx * ca + (ux * Math.cos(a) + vx * Math.sin(a)) * sa;
  const oy = dy * ca + (uy * Math.cos(a) + vy * Math.sin(a)) * sa;
  const oz = dz * ca + (uz * Math.cos(a) + vz * Math.sin(a)) * sa;
  const len = Math.hypot(ox, oy, oz) || 1;
  return { x: ox / len, y: oy / len, z: oz / len };
}
