// public/src/net/room.js
// Connection lifecycle for the arena room + the input/ping send paths.
// Endpoint derives from the page origin, so whatever LAN URL a colleague
// opened is exactly where their WebSocket goes.

import { Client } from './colyseus.js';
import { NET, MODES } from '/shared/constants.js';

export class NetRoom {
  constructor() {
    this.room = null;
    this.sessionId = null;
    this.pingMs = null;
    this.onState = null;   // (state) => void       — every patch
    this.onDrop = null;    // (reason) => void      — left/error
    this._pingTimer = null;
  }

  async connect(name, extra = {}) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const client = new Client(`${proto}://${location.host}`);
    // Room name IS the game mode ('arena'=practice, 'survival', 'tagteam').
    // joinOrCreate fills rooms of that mode to cap, then spins up new ones.
    const { mode, ...opts } = extra;
    const room = mode === MODES.DM ? MODES.DM
      : mode === MODES.SURVIVAL ? MODES.SURVIVAL
      : mode === MODES.TAGTEAM ? MODES.TAGTEAM
      : mode === MODES.TDM ? MODES.TDM
      : NET.ROOM_ARENA;
    this.room = await client.joinOrCreate(room, { name, ...opts });
    this.sessionId = this.room.sessionId;

    this.room.onStateChange((state) => { this.onState && this.onState(state); });
    this.room.onMessage('pong', (t) => { this.pingMs = Math.max(0, Math.round(performance.now() - t)); });
    this.room.onLeave((code) => { this._stopPing(); this.onDrop && this.onDrop(`left (${code})`); });
    this.room.onError((code) => { this._stopPing(); this.onDrop && this.onDrop(`error (${code})`); });

    this._pingTimer = setInterval(() => {
      try { this.room.send('ping', performance.now()); } catch { /* closing */ }
    }, 1000);

    return this.room;
  }

  get state() { return this.room ? this.room.state : null; }

  myPlayer() {
    const st = this.state;
    return st ? st.players.get(this.sessionId) : null;
  }

  sendInputs(batch) {
    if (this.room) this.room.send('i', batch);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }
}
