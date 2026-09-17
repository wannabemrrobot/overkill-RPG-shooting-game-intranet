// public/src/game/audio.js
// Tiny procedural WebAudio kit — every sound is synthesized (noise bursts +
// oscillators), zero audio files, fully offline. Deliberately arcade-y.
// The context unlocks on the first user gesture (pointer lock click).

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._noise = null;
    this._rain = null;      // { src, g } while the rain loop plays
    this._rainOn = false;   // desired state (may be set before unlock)
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);

    // shared noise buffer (0.15s white noise)
    const len = Math.floor(this.ctx.sampleRate * 0.15);
    this._noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this._noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    if (this._rainOn) this.setRain(true); // requested before the context existed
  }

  // Looping rain ambience: steady filtered white noise (hiss + low roar).
  // Safe to call before unlock() — the desired state is remembered and applied
  // once the context exists. Idempotent.
  setRain(on) {
    this._rainOn = !!on;
    if (!this.ctx) return;
    if (on && !this._rain) {
      const ctx = this.ctx;
      const len = Math.floor(ctx.sampleRate * 2); // 2s loop = no audible tonal seam
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 440;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.setTargetAtTime(0.11, ctx.currentTime, 0.6); // fade in
      src.connect(hp).connect(lp).connect(g).connect(this.master);
      src.start();
      this._rain = { src, g };
    } else if (!on && this._rain) {
      const { src, g } = this._rain;
      g.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.4); // fade out
      try { src.stop(this.ctx.currentTime + 1.2); } catch { /* already stopped */ }
      this._rain = null;
    }
  }

  _noiseBurst(when, dur, freq, q, gain, pan = 0) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(bp).connect(g).connect(p).connect(this.master);
    src.start(when, 0, dur + 0.02);
  }

  _tone(when, freq, dur, gain, type = 'sine', slideTo = 0, pan = 0) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, when);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p).connect(this.master);
    o.start(when);
    o.stop(when + dur + 0.02);
  }

  // Own gunshot: bright crack + low thump.
  shot() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._noiseBurst(t, 0.09, 2100, 0.9, 0.35);
    this._tone(t, 150, 0.07, 0.3, 'square', 70);
  }

  // Someone else's gunshot, attenuated and panned by relative position.
  shotAt(dist, pan) {
    if (!this.ctx) return;
    const v = Math.max(0, 1 - dist / 70) * 0.5;
    if (v < 0.02) return;
    const t = this.ctx.currentTime;
    this._noiseBurst(t, 0.1, 1400, 0.8, v, pan);
  }

  hit() {   // hit-marker tick
    if (!this.ctx) return;
    this._tone(this.ctx.currentTime, 1250, 0.045, 0.16);
  }

  kill() {  // two-tone confirm
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(t, 880, 0.07, 0.2, 'triangle');
    this._tone(t + 0.07, 1320, 0.11, 0.2, 'triangle');
  }

  damaged() {
    if (!this.ctx) return;
    this._tone(this.ctx.currentTime, 95, 0.1, 0.28, 'sawtooth', 55);
  }

  // Health-kit pickup: a bright rising three-note "power-up" chime.
  heal() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(t, 660, 0.08, 0.16, 'sine');
    this._tone(t + 0.07, 880, 0.08, 0.16, 'sine');
    this._tone(t + 0.14, 1320, 0.16, 0.16, 'triangle');
  }

  reload() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._noiseBurst(t, 0.03, 3200, 2.5, 0.18);
    this._noiseBurst(t + 0.09, 0.03, 2400, 2.5, 0.15);
  }

  died() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(t, 220, 0.4, 0.25, 'sawtooth', 55);
  }
}
