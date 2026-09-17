// public/src/game/remotes.js
// Remote players: snapshot buffering + interpolation.
//
// Each patch appends a timestamped snapshot per remote. Rendering happens
// NET.INTERP_MS in the past on the server's timeline, lerping between the two
// snapshots that bracket the render time — motion stays smooth even though
// state only arrives at PATCH_HZ. If the buffer runs dry (packet gap) we hold
// the newest snapshot rather than extrapolate; on a LAN this is rare and
// extrapolation artifacts (rubber-banding) look worse than a brief hold.
//
// The server clock is estimated as an EMA of (state.serverTime - clientNow);
// the offset absorbs both clock difference and network delay.

import * as THREE from 'three';
import { NET, MODES, TEAM } from '/shared/constants.js';

const MAX_SNAPS = 40;

// Shared red radial-glow texture for the enemy head marker (drawn once).
let _enemyTex = null;
function enemyDotTexture() {
  if (_enemyTex) return _enemyTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,80,70,1)');
  g.addColorStop(0.6, 'rgba(255,40,40,0.55)');
  g.addColorStop(1, 'rgba(255,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _enemyTex = new THREE.CanvasTexture(c);
  _enemyTex.colorSpace = THREE.SRGBColorSpace;
  return _enemyTex;
}

function makeEnemyDot(scene) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: enemyDotTexture(), color: 0xffffff, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.95,
  }));
  s.scale.setScalar(0.3);
  s.visible = false;
  scene.add(s);
  return s;
}

export class Remotes {
  // factory: AvatarFactory — builds procedural or GLB avatars per player
  constructor(scene, factory) {
    this.scene = scene;
    this.factory = factory;
    this.map = new Map();      // sessionId -> { char, snaps[], scratch }
    this.timeOffset = null;
    this._seen = new Set();
    this.mode = MODES.PRACTICE; // updated from state each patch
    this.myTeam = TEAM.NONE;
  }

  get count() { return this.map.size; }

  onPatch(state, myId, nowMs) {
    const sample = state.serverTime - nowMs;
    this.timeOffset = this.timeOffset === null
      ? sample
      : this.timeOffset + (sample - this.timeOffset) * 0.1;

    // match context for the enemy marker
    this.mode = state.mode;
    const meP = state.players.get(myId);
    this.myTeam = meP ? meP.team : TEAM.NONE;

    this._seen.clear();
    state.players.forEach((p, id) => {
      if (id === myId) return;
      this._seen.add(id);
      let e = this.map.get(id);
      if (!e) {
        e = {
          id,
          char: this.factory.create(p.character, { name: p.name, colorSeed: id }),
          characterId: p.character,
          team: p.team,
          enemyDot: makeEnemyDot(this.scene),
          snaps: [],
          scratch: {
            x: 0, y: 0, z: 0, vx: 0, vz: 0, yaw: 0, pitch: 0,
            crouch: false, ads: false, grounded: true, alive: true, protected: false,
          },
          lastPose: null, // latest rendered pose (combat/aim-assist reads this)
        };
        this.map.set(id, e);
      } else if (e.characterId !== p.character) {
        // player re-picked their character — swap the avatar in place
        e.char.dispose();
        e.char = this.factory.create(p.character, { name: p.name, colorSeed: id });
        e.characterId = p.character;
      }
      e.team = p.team;
      e.snaps.push({
        t: state.serverTime,
        x: p.x, y: p.y, z: p.z, vx: p.vx, vz: p.vz,
        yaw: p.yaw, pitch: p.pitch,
        crouch: p.crouch, ads: p.ads, grounded: p.grounded, alive: p.alive,
        protected: p.protected,
      });
      if (e.snaps.length > MAX_SNAPS) e.snaps.splice(0, e.snaps.length - MAX_SNAPS);
    });

    for (const [id, e] of this.map) {
      if (!this._seen.has(id)) {
        this._disposeEntity(e);
        this.map.delete(id);
      }
    }
  }

  _disposeEntity(e) {
    e.char.dispose();
    if (e.enemyDot) {
      this.scene.remove(e.enemyDot);
      e.enemyDot.material.dispose(); // shared texture is NOT disposed
      e.enemyDot = null;
    }
  }

  update(dt, nowMs) {
    if (this.timeOffset === null) return;
    const rt = nowMs + this.timeOffset - NET.INTERP_MS;

    for (const e of this.map.values()) {
      const s = e.snaps;
      if (!s.length) continue;

      let pose;
      if (rt <= s[0].t) pose = s[0];
      else if (rt >= s[s.length - 1].t) pose = s[s.length - 1]; // hold newest
      else {
        let i = s.length - 2;
        while (i > 0 && s[i].t > rt) i--;
        const a = s[i], b = s[i + 1];
        const k = (rt - a.t) / (b.t - a.t);
        const o = e.scratch;
        o.x = a.x + (b.x - a.x) * k;
        o.y = a.y + (b.y - a.y) * k;
        o.z = a.z + (b.z - a.z) * k;
        o.vx = a.vx + (b.vx - a.vx) * k;
        o.vz = a.vz + (b.vz - a.vz) * k;
        o.yaw = lerpAngle(a.yaw, b.yaw, k);
        o.pitch = a.pitch + (b.pitch - a.pitch) * k;
        o.crouch = b.crouch; o.ads = b.ads; o.grounded = b.grounded;
        o.alive = b.alive; o.protected = b.protected;
        pose = o;
      }

      // combat stance flag: recently-fired players face their aim direction
      pose.combat = (e.combatUntil || 0) > nowMs;

      e.lastPose = pose; // combat (aim assist / tracers) reads this
      e.char.update(dt, pose);

      // enemy marker: a glowing red dot above the heads of the OTHER team,
      // tag-team only, while they're alive.
      const dot = e.enemyDot;
      if (dot) {
        const isEnemy = this.mode === MODES.TAGTEAM &&
          e.team >= 0 && this.myTeam >= 0 && e.team !== this.myTeam;
        const show = isEnemy && pose.alive !== false;
        dot.visible = show;
        if (show) {
          const headY = pose.y + (pose.crouch ? 1.55 : 2.05);
          dot.position.set(pose.x, headY, pose.z);
          const pulse = 0.85 + 0.15 * Math.sin(nowMs * 0.006);
          dot.scale.setScalar(0.3 * pulse);
          dot.material.opacity = 0.7 + 0.25 * pulse;
        }
      }

      // prune well-consumed history
      while (s.length > 2 && s[1].t < rt - 400) s.shift();
    }
  }

  // Server-timeline instant currently being rendered for remotes — the value
  // the server should rewind to when validating our shots (lag compensation).
  renderTime(nowMs) {
    return this.timeOffset === null ? 0 : nowMs + this.timeOffset - NET.INTERP_MS;
  }

  disposeAll() {
    for (const e of this.map.values()) this._disposeEntity(e);
    this.map.clear();
  }
}

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
