// public/src/ui/hud.js
// All 2D combat feedback: debug rows, health bar, ammo counter, dynamic
// crosshair (blooms with spread), hit markers, kill feed, damage vignette,
// and the death/respawn banner. DOM writes only happen on change or on
// rate-limited ticks — never wholesale per frame.

import { MATCH } from '/shared/constants.js';

const el = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.n = {
      conn: el('hud-conn'), ping: el('hud-ping'), fps: el('hud-fps'),
      players: el('hud-players'), pos: el('hud-pos'), speed: el('hud-speed'),
      hpBar: el('hp-bar'), hpNum: el('hp-num'), hpRegen: el('hp-regen'), hpStatus: el('hp-status'),
      ammoMag: el('ammo-mag'), ammoMagMax: el('ammo-magmax'), ammoRes: el('ammo-res'),
      ammoCap: el('ammo-cap'), ammoState: el('ammo-state'), ammoWpn: el('ammo-wpn'),
      ammoReserve: el('ammo-reserve'), ammoMagBox: el('ammo-mag-box'),
      crosshair: el('crosshair'), reddot: el('reddot'), scope: el('scope'), hitmarker: el('hitmarker'),
      killfeed: el('killfeed'), vignette: el('vignette'),
      death: el('death-banner'), deathSub: el('death-sub'),
      healFlash: el('heal-flash'), healNum: el('heal-num'),
      matchbar: el('matchbar'),
      announce: el('announce'), announceText: el('announce-text'), announceSub: el('announce-sub'),
      scoreboard: el('scoreboard'), scoreboardInner: el('scoreboard-inner'),
      playerlist: el('playerlist'),
    };
    this._fpsFrames = 0; this._fpsAccum = 0; this._slowAccum = 0;
    this._lastCrossPx = -1;
    this._hitT = null;
    this._deathTimer = null;
    this._vigT = null;
    this._announceTimer = null;
    this._matchAccum = 0;
    this.myName = '';
    this.myTeam = -1;
  }

  // ---- match HUD (Phase 3) ---------------------------------------------------
  // Center banner for warmup / round start / winner moments (server 'announce').
  announce({ text, sub, ms }, win = false) {
    const a = this.n.announce;
    if (!a) return;
    this.n.announceText.textContent = text || '';
    this.n.announceSub.textContent = sub || '';
    a.classList.toggle('win', !!win);
    a.classList.add('show');
    clearTimeout(this._announceTimer);
    this._announceTimer = setTimeout(() => a.classList.remove('show'), Math.max(1200, ms || 2500));
  }

  // Top-center strip: mode + round/score (tagteam) or players-left (survival)
  // + phase countdown + my lives. Rate-limited; driven from match state.
  matchbar(state, myTeam, myLives) {
    const bar = this.n.matchbar;
    if (!bar || !state) return;
    if (state.mode === 'practice') { bar.classList.remove('show'); return; }
    bar.classList.add('show');

    // waiting for humans (bots disabled, not enough players yet)
    if (state.phase === 'waiting') {
      let humans = 0; state.players.forEach((p) => { if (!p.bot) humans++; });
      const h = `<span class="mb-timer">⏳ WAITING FOR PLAYERS</span><span class="mb-sep"> · </span><span class="mb-lives">${humans} joined</span>`;
      if (bar._html !== h) { bar._html = h; bar.innerHTML = h; }
      return;
    }

    const now = state.serverTime;
    const left = Math.max(0, (state.phaseEndsAt - now) / 1000);
    const clock = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    const timed = state.mode === 'tdm' || state.mode === 'dm';
    const phaseLabel = state.phase === 'warmup' ? `starts ${left.toFixed(0)}s`
      : state.phase === 'intermission' ? `next ${left.toFixed(0)}s`
      : state.phase === 'ended' ? `ends ${left.toFixed(0)}s`
      : (timed && state.phase === 'live') ? clock : 'LIVE';

    let mid;
    if (state.mode === 'tagteam') {
      mid = `<span class="mb-a">BLUE ${state.scoreA}</span><span class="mb-sep"> · R${state.round} (${state.roundsA}-${state.roundsB}) · </span><span class="mb-b">${state.scoreB} RED</span>`;
    } else if (state.mode === 'tdm') {
      mid = `<span class="mb-a">BLUE ${state.scoreA}</span><span class="mb-sep"> · TDM · </span><span class="mb-b">${state.scoreB} RED</span>`;
    } else if (state.mode === 'dm') {
      let leadName = '—', leadK = 0;
      state.players.forEach((p) => { if (p.kills > leadK) { leadK = p.kills; leadName = p.name; } });
      mid = `<span class="mb-a">DEATHMATCH</span><span class="mb-sep"> · </span><span class="mb-lives">👑 ${esc(leadName)} ${leadK}</span>`;
    } else {
      mid = `<span>SURVIVAL</span><span class="mb-sep"> · </span><span class="mb-lives">${state.aliveCount} left</span>`;
    }
    const livesTxt = (myLives != null && !timed) ? `<span class="mb-sep"> · </span><span class="mb-lives">♥ ${myLives}</span>` : '';
    const html = `${mid}<span class="mb-sep"> · </span><span class="mb-timer">${phaseLabel}</span>${livesTxt}`;
    if (bar._html !== html) { bar._html = html; bar.innerHTML = html; }
  }

  hideMatchHud() {
    this.n.matchbar && this.n.matchbar.classList.remove('show');
    this.n.announce && this.n.announce.classList.remove('show');
    this.showScoreboard(false);
  }

  // ---- scoreboard (hold Tab) --------------------------------------------------
  showScoreboard(on) {
    const sb = this.n.scoreboard;
    if (sb) sb.classList.toggle('show', !!on);
  }

  renderScoreboard(state, mySessionId, roomCode) {
    const sb = this.n.scoreboardInner;
    if (!sb || !state) return;
    const rows = [];
    state.players.forEach((p, id) => rows.push({ id, p }));
    rows.sort((a, b) => b.p.kills - a.p.kills || a.p.deaths - b.p.deaths);

    const line = (r) => {
      const p = r.p;
      const cls = [r.id === mySessionId ? 'me' : '', !p.alive ? 'dead' : '',
        p.team === 0 ? 'team-a' : p.team === 1 ? 'team-b' : ''].filter(Boolean).join(' ');
      const endless = state.mode === 'practice' || state.mode === 'tdm' || state.mode === 'dm';
      const lives = endless ? '<td>∞</td>' : `<td>${p.lives}</td>`;
      return `<tr class="${cls}"><td>${esc(p.name)}</td><td>${p.kills}</td><td>${p.deaths}</td>${lives}</tr>`;
    };
    const head = `<tr><th>player</th><th>K</th><th>D</th><th>lives</th></tr>`;

    let body;
    if (state.mode === 'tagteam') {
      const A = rows.filter((r) => r.p.team === 0), B = rows.filter((r) => r.p.team === 1);
      body = `<tr><td colspan="4" class="sb-teamhdr a">BLUE — round wins ${state.roundsA}</td></tr>` +
        A.map(line).join('') +
        `<tr><td colspan="4" class="sb-teamhdr b">RED — round wins ${state.roundsB}</td></tr>` +
        B.map(line).join('');
    } else {
      body = rows.map(line).join('');
    }
    const title = { tagteam: 'TAG TEAM · 5v5', tdm: 'TEAM DEATHMATCH · 5v5', dm: 'DEATHMATCH · FFA', survival: 'SURVIVAL' }[state.mode] || 'PRACTICE';
    let sub = state.mode === 'survival' ? `${state.aliveCount} still standing`
      : state.mode === 'tagteam' ? `first to ${Math.ceil(MATCH.TAGTEAM.rounds / 2)} rounds`
      : state.mode === 'tdm' ? `first team to ${MATCH.TDM.killTarget} kills`
      : state.mode === 'dm' ? `first to ${MATCH.DM.killTarget} kills`
      : 'free play';
    if (roomCode) sub += ` · room code <b>${esc(roomCode)}</b>`;
    sb.innerHTML = `<h3>${title}</h3><div class="sb-sub">${sub}</div><table>${head}${body}</table>`;
  }

  // ---- live player list (top-left, always on during a networked match) -------
  // Compact roster: room code header (if any), then every player with K/D,
  // team-tinted, self highlighted, dead dimmed, teams grouped when applicable.
  renderPlayerList(state, mySessionId, roomCode) {
    const box = this.n.playerlist;
    if (!box || !state) return;
    if (state.mode === 'practice' && !roomCode) { box.classList.remove('show'); return; }
    box.classList.add('show');

    const rows = [];
    state.players.forEach((p, id) => rows.push({ id, p }));
    rows.sort((a, b) => b.p.kills - a.p.kills || a.p.deaths - b.p.deaths);

    const teamed = state.mode === 'tagteam' || state.mode === 'tdm';
    const line = (r) => {
      const p = r.p;
      const cls = ['pl-row', r.id === mySessionId ? 'me' : '', !p.alive ? 'dead' : '',
        teamed ? (p.team === 0 ? 'team-a' : p.team === 1 ? 'team-b' : '') : ''].filter(Boolean).join(' ');
      const botTag = p.bot ? '<span class="pl-bot">BOT</span>' : '';
      return `<div class="${cls}"><span class="pl-name">${esc(p.name)}${botTag}</span>` +
        `<span class="pl-kd">${p.kills}<i>/</i>${p.deaths}</span></div>`;
    };

    let body;
    if (teamed) {
      const A = rows.filter((r) => r.p.team === 0), B = rows.filter((r) => r.p.team === 1);
      const na = rows.filter((r) => r.p.team !== 0 && r.p.team !== 1);
      body = `<div class="pl-team a">BLUE${state.mode === 'tdm' ? ` · ${state.scoreA}` : ''}</div>` + A.map(line).join('') +
        `<div class="pl-team b">RED${state.mode === 'tdm' ? ` · ${state.scoreB}` : ''}</div>` + B.map(line).join('') +
        na.map(line).join('');
    } else {
      body = rows.map(line).join('');
    }

    const head = roomCode
      ? `<div class="pl-head"><span class="pl-room">ROOM <b>${esc(roomCode)}</b></span><span class="pl-count">${rows.length}/10</span></div>`
      : `<div class="pl-head"><span class="pl-room">PLAYERS</span><span class="pl-count">${rows.length}</span></div>`;
    box.innerHTML = head + body;
  }

  hidePlayerList() {
    this.n.playerlist && this.n.playerlist.classList.remove('show');
  }

  set(key, text, cls) {
    const node = this.n[key];
    if (!node) return;
    const t = String(text);
    if (node.textContent !== t) node.textContent = t;
    if (cls !== undefined) node.className = 'v ' + cls;
  }

  // ---- per-frame -------------------------------------------------------------
  tick(dt, { ping, players, pos, speed, hp, mag, magMax, reserve, reserveCap, reloading, resupply, regen, weapon, alive }) {
    this._fpsFrames++; this._fpsAccum += dt;
    if (this._fpsAccum >= 1) {
      const fps = Math.round(this._fpsFrames / this._fpsAccum);
      this.set('fps', fps, fps >= 55 ? 'good' : fps >= 30 ? 'warn' : 'bad');
      this._fpsFrames = 0; this._fpsAccum = 0;
    }

    // --- health (bar fill + colour, regen glow, low/regen status) ---
    if (hp != null) {
      const pct = Math.max(0, Math.min(100, hp));
      const bar = this.n.hpBar;
      if (bar._pct !== pct) {
        bar._pct = pct;
        bar.style.width = pct + '%';
        bar.style.background = pct > 55 ? 'linear-gradient(90deg,#2fbf6a,#57d98a)'
          : pct > 25 ? 'linear-gradient(90deg,#e0a92e,#ffd166)'
          : 'linear-gradient(90deg,#c92f2f,#ff6b6b)';
        this.set('hpNum', Math.round(pct));
      }
      if (this.n.hpRegen) this.n.hpRegen.classList.toggle('on', !!regen);
      const st = this.n.hpStatus;
      if (st) {
        const cls = regen ? 'regen' : (pct <= 25 && alive !== false ? 'low' : '');
        if (st._cls !== cls) {
          st._cls = cls; st.className = ''; if (cls) st.classList.add(cls);
          st.textContent = regen ? '▲ REGEN' : (cls === 'low' ? 'LOW' : '');
        }
      }
    }

    // --- ammo (mag big, reserve/cap, weapon, resupply/reload state) ---
    if (mag != null) {
      this.set('ammoMag', mag);
      const box = this.n.ammoMagBox;
      if (box) { box.classList.toggle('empty', mag === 0); box.classList.toggle('low', mag > 0 && mag <= 6); }
    }
    if (magMax != null) this.set('ammoMagMax', '/' + magMax);
    if (reserve != null) this.set('ammoRes', reserve);
    if (reserveCap != null) {
      this.set('ammoCap', '/ ' + reserveCap);
      if (this.n.ammoReserve) this.n.ammoReserve.classList.toggle('full', reserve >= reserveCap);
    }
    if (weapon) this.set('ammoWpn', weapon);
    {
      const stEl = this.n.ammoState;
      const txt = resupply ? '⟳ PRESS F — RESUPPLY' : reloading ? 'RELOADING…' : (mag === 0 ? 'PRESS R' : '');
      if (stEl && stEl._txt !== txt) {
        stEl._txt = txt; stEl.textContent = txt;
        stEl.className = ''; if (resupply) stEl.classList.add('resupply');
      }
    }
    this.n.crosshair.style.opacity = alive === false ? '0' : '1';

    this._slowAccum += dt;
    if (this._slowAccum < 0.25) return;
    this._slowAccum = 0;
    if (ping != null) this.set('ping', ping + ' ms', ping < 60 ? 'good' : ping < 140 ? 'warn' : 'bad');
    if (players != null) this.set('players', players);
    if (pos) this.set('pos', `${pos.x.toFixed(1)}, ${pos.z.toFixed(1)}`);
    if (speed != null) this.set('speed', speed.toFixed(1) + ' m/s');
  }

  // ---- crosshair --------------------------------------------------------------
  // gapPx: half-gap between the center and each bar.
  setCrosshair(gapPx) {
    const px = Math.round(gapPx);
    if (px === this._lastCrossPx) return;
    this._lastCrossPx = px;
    this.n.crosshair.style.setProperty('--gap', px + 'px');
  }

  // ADS swaps the crosshair for the red-dot sight.
  setAds(on) {
    if (this._ads === on) return;
    this._ads = on;
    this.n.reddot.classList.toggle('on', on);
    this.n.crosshair.classList.toggle('ads', on);
  }

  // Scope: full-screen sniper reticle + vignette. While scoped the red-dot and
  // crosshair are suppressed (the scope reticle replaces them).
  setScope(on) {
    on = !!on;
    if (this._scope === on) return;
    this._scope = on;
    if (this.n.scope) this.n.scope.classList.toggle('show', on);
    this.n.reddot.classList.toggle('scoped-off', on);
    this.n.crosshair.classList.toggle('scoped-off', on);
  }

  hitmarker(kill) {
    const hm = this.n.hitmarker;
    hm.classList.remove('show', 'kill');
    void hm.offsetWidth; // restart the CSS animation
    hm.classList.add('show');
    if (kill) hm.classList.add('kill');
  }

  damageFlash() {
    const v = this.n.vignette;
    v.classList.remove('show');
    void v.offsetWidth;
    v.classList.add('show');
  }

  // Pickup flash + floating label. kind 'pack' (green, full heal) or 'pain'
  // (cyan, regen-over-time).
  healFlash(label, kind) {
    const f = this.n.healFlash;
    if (!f) return;
    if (this.n.healNum) this.n.healNum.textContent = label != null ? String(label) : '';
    f.classList.remove('show', 'pain', 'pack', 'ammo');
    void f.offsetWidth; // restart the animation
    f.classList.add('show', kind === 'pain' ? 'pain' : kind === 'ammo' ? 'ammo' : 'pack');
  }

  // ---- kill feed ----------------------------------------------------------------
  killfeed({ killer, victim, headshot, killerTeam, victimTeam }) {
    const row = document.createElement('div');
    row.className = 'kf-row';
    const me = this.myName;
    const nameCls = (n, team) => {
      if (n === me) return 'kf-me';
      if (team === 0) return 'kf-name kf-a';
      if (team === 1) return 'kf-name kf-b';
      return 'kf-name';
    };
    row.innerHTML =
      `<span class="${nameCls(killer, killerTeam)}">${esc(killer)}</span>` +
      `<span class="kf-x">${headshot ? '⦿' : '✕'}</span>` +
      `<span class="${nameCls(victim, victimTeam)}">${esc(victim)}</span>`;
    this.n.killfeed.prepend(row);
    while (this.n.killfeed.children.length > 5) this.n.killfeed.lastChild.remove();
    setTimeout(() => { row.classList.add('fade'); setTimeout(() => row.remove(), 600); }, 4200);
  }

  // ---- death banner ---------------------------------------------------------------
  // msg: { by, respawnMs, eliminated?, lives? }
  death(msg) {
    const by = typeof msg === 'object' ? msg.by : msg;
    const respawnMs = typeof msg === 'object' ? msg.respawnMs : arguments[1];
    const eliminated = typeof msg === 'object' && msg.eliminated;
    const d = this.n.death;
    d.classList.add('show');
    clearInterval(this._deathTimer);
    if (eliminated) {
      // out of lives: no respawn countdown — spectating until the round resets
      this.n.deathSub.innerHTML =
        `killed by <span class="ds-killer">${esc(by)}</span>` +
        `<span class="ds-sep">·</span><span class="ds-elim">out of lives — spectating</span>`;
      return;
    }
    // build the line once; the ticker only rewrites the green timer number.
    const until = performance.now() + respawnMs;
    this.n.deathSub.innerHTML =
      `killed by <span class="ds-killer">${esc(by)}</span>` +
      `<span class="ds-sep">·</span><span class="ds-lbl">respawning in</span> ` +
      `<span class="ds-timer">0.0s</span>`;
    const timerEl = this.n.deathSub.querySelector('.ds-timer');
    const paint = () => {
      const left = Math.max(0, until - performance.now());
      if (timerEl) timerEl.textContent = `${(left / 1000).toFixed(1)}s`;
      if (left <= 0) clearInterval(this._deathTimer);
    };
    paint();
    this._deathTimer = setInterval(paint, 100);
  }

  clearDeath() {
    clearInterval(this._deathTimer);
    this.n.death.classList.remove('show');
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
