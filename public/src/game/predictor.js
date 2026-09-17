// public/src/game/predictor.js
// Client-side prediction + server reconciliation for the LOCAL player.
//
// Flow:
//  - every fixed step: stepPlayer() advances the predicted state instantly
//    (zero perceived input latency) and the input is remembered as pending.
//  - every server patch: adopt the authoritative state, drop inputs the server
//    acked (seq <= server seq), replay the rest through the SAME stepPlayer().
//    Because both sides run identical code on identical inputs, the replay
//    normally reproduces the prediction exactly and nothing visibly changes.
//  - if it DIDN'T match (dropped packet, server-side pacing), the difference
//    is folded into a decaying render offset instead of a visible snap.

import { stepPlayer, makeMoveState } from '/shared/movement.js';
import { MAP } from '/shared/map.js';

const MAX_PENDING = 240;   // ~4s of inputs; beyond this something is very wrong
const SNAP_DIST = 2;       // offsets larger than this snap instead of easing

export class Predictor {
  constructor(spawn) {
    this.state = makeMoveState(spawn.x, spawn.y, spawn.z);
    this.pending = [];
    this.offX = 0; this.offY = 0; this.offZ = 0;
  }

  applyInput(input) {
    stepPlayer(this.state, input, MAP);
    this.pending.push(input);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
  }

  // auth: schema Player (x,y,z,vx,vy,vz,grounded,seq)
  reconcile(auth) {
    let n = 0;
    while (n < this.pending.length && this.pending[n].seq <= auth.seq) n++;
    if (n > 0) this.pending.splice(0, n);

    const oldX = this.state.x, oldY = this.state.y, oldZ = this.state.z;

    this.state.x = auth.x; this.state.y = auth.y; this.state.z = auth.z;
    this.state.vx = auth.vx; this.state.vy = auth.vy; this.state.vz = auth.vz;
    this.state.grounded = auth.grounded;

    for (let i = 0; i < this.pending.length; i++) {
      stepPlayer(this.state, this.pending[i], MAP);
    }

    // Fold any correction into the render offset (visual continuity).
    this.offX += oldX - this.state.x;
    this.offY += oldY - this.state.y;
    this.offZ += oldZ - this.state.z;
    const mag = Math.hypot(this.offX, this.offY, this.offZ);
    if (mag > SNAP_DIST) { this.offX = 0; this.offY = 0; this.offZ = 0; }
  }

  // Decay the correction offset and write the smooth render position into
  // `out` ({x,y,z}). Call once per frame.
  renderInto(out, dt) {
    const k = Math.exp(-dt * 12);
    this.offX *= k; this.offY *= k; this.offZ *= k;
    out.x = this.state.x + this.offX;
    out.y = this.state.y + this.offY;
    out.z = this.state.z + this.offZ;
  }
}
