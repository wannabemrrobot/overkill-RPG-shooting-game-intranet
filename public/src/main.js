// public/src/main.js — Phase 2 client orchestrator (+ character selection).
// Wires together: renderer/world, trackpad input, settings UI, character
// avatars (procedural + GLB), the network room, local prediction, remote
// interpolation, combat, and the fixed-step input loop.
//
// Join flow: the page boots into a MENU state — world rendering, character
// picker, and a live rotating preview of the selected avatar. Joining the
// arena only happens on CLICK TO PLAY (no room slot is held while idling on
// the menu). The choice persists in localStorage; picking a different
// character later swaps it live via the server ('setchar').
//
// Failure-visibility rules (a dead "CLICK TO PLAY" must be impossible):
//  - any uncaught error / rejection is painted onto the overlay,
//  - the world renders and errors surface BEFORE any network dependency,
//  - connection state is always readable on the overlay itself.

import * as THREE from 'three';
import { PROTOCOL_VERSION, MOVE, AMMO, PAINKILLER } from '/shared/constants.js';
import { AMMO_STATIONS } from '/shared/map.js';
import { skyTexture } from './game/textures.js';
import { loadSettings, saveSettings, buildSettingsPanel } from './ui/settings.js';
import { Input } from './input/input.js';
import { buildWorld } from './game/world.js';
import { ThirdPersonCamera } from './game/camera.js';
import { Predictor } from './game/predictor.js';
import { Remotes } from './game/remotes.js';
import { Effects } from './game/effects.js';
import { Pickups } from './game/pickups.js';
import { Rain } from './game/rain.js';
import { GameAudio } from './game/audio.js';
import { Combat } from './game/combat.js';
import { AvatarFactory } from './game/avatars.js';
import { PropLibrary } from './game/props.js';
import { NetRoom } from './net/room.js';
import { Hud } from './ui/hud.js';
import { buildCharSelect } from './ui/charselect.js';

const el = (id) => document.getElementById(id);
console.log(`[tdm] client booted — protocol ${PROTOCOL_VERSION}`);

// ---------------------------------------------------------------------------
// Overlay status + global error surfacing (registered FIRST).
// ---------------------------------------------------------------------------
const overlay = el('overlay');
const overlayStatus = el('overlay-status');
const overlayMsg = el('overlay-msg');
const settingsPanel = el('settings');

function setStatus(text, cls = '') {
  overlayStatus.textContent = text;
  overlayStatus.className = 'status ' + cls;
}
function setMsg(html) {
  overlayMsg.innerHTML = html;
}
window.addEventListener('error', (e) => {
  console.error('[tdm] uncaught error:', e.error || e.message);
  setMsg(`⚠ script error: <code>${escapeHtml(String(e.message || e.error))}</code>`);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[tdm] unhandled rejection:', e.reason);
  setMsg(`⚠ error: <code>${escapeHtml(String(e.reason && e.reason.message || e.reason))}</code>`);
});
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Renderer / scene — up and drawing before anything network-related.
// (settings load first: the shadow pipeline is decided at boot)
// ---------------------------------------------------------------------------
const settings = loadSettings();
const dynamicShadows = settings.shadows !== false;

const canvas = el('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// DPR cap 1.5: on retina screens this renders ~44% fewer pixels than 2.0 for
// a barely-visible sharpness cost — the single biggest win on slow GPUs.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
// Filmic tone mapping is the single cheapest "looks like a real game" switch.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
if (dynamicShadows) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // cheaper filter than PCFSoft
  renderer.shadowMap.autoUpdate = false;        // re-rendered every 2nd frame
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 500);
const world = buildWorld(scene, { shadows: dynamicShadows });
const colliders = world.colliders;

// Sun/sky reflections: one PMREM bake. The scene gets it DIMMED (the sky
// dome material is darkened in the bake, so ambient stays low and contrast
// survives) while the sun ball stays HDR-hot — real glints on the gun and any
// smooth surface without the washed-out flatness of a full-brightness env.
let weaponEnv = null;
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(
    new THREE.SphereGeometry(50, 16, 8),
    new THREE.MeshBasicMaterial({ map: skyTexture(), color: 0x555555, side: THREE.BackSide })
  ));
  const sunBall = new THREE.Mesh(
    new THREE.SphereGeometry(4, 8, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(10, 8.5, 6) }) // HDR-hot
  );
  sunBall.position.set(55, 44, -28).normalize().multiplyScalar(46); // matches SUN_DIR
  envScene.add(sunBall);
  weaponEnv = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();
  scene.environment = weaponEnv; // dim ambient + hot sun glints everywhere
}

// ---------------------------------------------------------------------------
// Lobby character preview — its OWN renderer/scene so the game canvas behind
// can be blurred while the selected character shows crisp on the right.
// ---------------------------------------------------------------------------
const previewCanvas = el('preview-gl');
const previewRenderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true, alpha: true });
previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
previewRenderer.toneMappingExposure = 1.1;
const previewScene = new THREE.Scene();
previewScene.add(new THREE.HemisphereLight(0xd6e8ec, 0x4a5647, 1.0));
{
  const key = new THREE.DirectionalLight(0xfff0d6, 2.4); key.position.set(2.5, 4, 3); previewScene.add(key);
  const rim = new THREE.DirectionalLight(0x9fc0ff, 0.7); rim.position.set(-3, 2.5, -2.5); previewScene.add(rim);
}
const previewCam = new THREE.PerspectiveCamera(36, 1, 0.05, 100);

function sizePreview() {
  const w = Math.max(1, Math.round(window.innerWidth * 0.58)), h = window.innerHeight;
  previewRenderer.setSize(w, h, false);
  previewCam.aspect = w / h;
  previewCam.updateProjectionMatrix();
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  sizePreview();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Input + camera rig + subsystems
// ---------------------------------------------------------------------------
const input = new Input(canvas, settings);
const cam3p = new ThirdPersonCamera(camera, colliders);
cam3p.shoulder = settings.shoulder === -1 ? -1 : 1;

input.onSwapShoulder = () => {
  cam3p.swapShoulder();
  settings.shoulder = cam3p.shoulder;
  saveSettings(settings);
};

buildSettingsPanel(el('settings-body'), settings, () => { input.refreshBinds(); applyRain(settings.rain); });

const hud = new Hud();
const net = new NetRoom();
const props = new PropLibrary({ weaponEnv });
const factory = new AvatarFactory(scene, props, { blobShadows: !dynamicShadows });
const remotes = new Remotes(scene, factory);
const effects = new Effects(scene);
const pickups = new Pickups(scene, props);
const audio = new GameAudio();
const rain = new Rain(scene, camera);
// Live weather toggle: visuals (rain.js) + ambience (audio.js). audio.setRain
// remembers its state and (re)starts once the context unlocks on first click.
function applyRain(on) { rain.setEnabled(!!on); audio.setRain(!!on); }
applyRain(settings.rain);

// ---------------------------------------------------------------------------
// Character selection + menu preview
// ---------------------------------------------------------------------------
const CHAR_KEY = 'tdm.character.v1';
const savedChar = localStorage.getItem(CHAR_KEY);
const firstLogin = !savedChar;
let selectedChar = savedChar || ''; // resolved to a real character once the factory loads
let previewChar = null;

function refreshPreview() {
  if (previewChar) { previewChar.dispose(); previewChar = null; }
  if (net.room) return; // once in the arena, your actual character IS the preview
  // lobby preview: rendered into its OWN scene (crisp over the blurred game),
  // no weapon, gender-specific idle (idle_m men / idle_w women)
  const entry = factory.list.find((c) => c.id === selectedChar);
  const lobbyIdle = entry && entry.gender === 'f' ? 'idle_w' : 'idle_m';
  previewChar = factory.create(selectedChar, { scene: previewScene, showName: false, colorSeed: selectedChar, lobby: true, lobbyIdle });
}

function onPickCharacter(id) {
  selectedChar = id;
  localStorage.setItem(CHAR_KEY, id);
  el('charsel').classList.remove('attention');
  if (net.room) {
    net.room.send('setchar', id);
    swapLocalAvatar(id);
  } else {
    refreshPreview();
  }
}

// ---- game mode selection (lobby) ------------------------------------------
const MODE_KEY = 'tdm.mode.v1';
const MODE_DESC = {
  practice: 'Free play with practice bots. No rounds.',
  dm: 'Free-for-all Deathmatch. Everyone for themselves — unlimited respawns, first to 25 kills (or top fragger at time-up).',
  survival: 'Free-for-all. 3 lives — last one standing wins.',
  tdm: '5v5 Team Deathmatch. Unlimited respawns — first team to 60 kills (or most at time-up).',
  tagteam: '5v5, random teams. Best of 5 rounds — wipe the enemy or hit the kill target.',
};
let selectedMode = localStorage.getItem(MODE_KEY) || 'practice';
{
  const row = el('modesel-row');
  const desc = el('mode-desc');
  const paint = () => {
    for (const b of row.querySelectorAll('.chip.mode')) b.classList.toggle('on', b.dataset.mode === selectedMode);
    if (desc) desc.textContent = MODE_DESC[selectedMode] || '';
  };
  row.addEventListener('click', (e) => {
    const b = e.target.closest('.chip.mode');
    if (!b) return;
    selectedMode = b.dataset.mode;
    localStorage.setItem(MODE_KEY, selectedMode);
    paint();
    updatePartyUI();
  });
  paint();
}

// ---- name + party (host / join / quick-match) -----------------------------
const NAME_KEY = 'tdm.name.v1';
const HOSTCODE_KEY = 'tdm.hostcode.v1';
const JOINCODE_KEY = 'tdm.joincode.v1';
const PARTY_KEY = 'tdm.partymode.v1';
const TEAM_KEY = 'tdm.team.v1';
const BOTS_KEY = 'tdm.bots.v1';
let playerName = localStorage.getItem(NAME_KEY) || 'guest-' + String(Math.floor(1000 + Math.random() * 9000));
let teamPref = localStorage.getItem(TEAM_KEY) || 'auto';
let botsEnabled = localStorage.getItem(BOTS_KEY) !== 'off'; // default: fill with bots

// Party model is explicit so it's obvious who's hosting vs joining:
//   quick → no code (public match-make into any room of the mode)
//   host  → you own a code; friends join it (shown + regenerate-able)
//   join  → you type a friend's code
function genRoomCode() {
  const ax = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  let s = '';
  for (let i = 0; i < 5; i++) s += ax[Math.floor(Math.random() * ax.length)];
  return s;
}
let partyMode = localStorage.getItem(PARTY_KEY) || 'quick';
let hostCode = localStorage.getItem(HOSTCODE_KEY) || genRoomCode();
let joinCode = localStorage.getItem(JOINCODE_KEY) || '';
localStorage.setItem(HOSTCODE_KEY, hostCode);
// roomCode is the effective code sent to the server + shown in the HUD.
let roomCode = '';
function syncCode() {
  roomCode = partyMode === 'host' ? hostCode : partyMode === 'join' ? joinCode : '';
}
syncCode();

function updatePartyUI() {
  // party controls only matter for the match modes; team pick only for the
  // team modes (Tag Team + TDM). Survival has no teams.
  const isMatch = selectedMode !== 'practice';
  el('partysel').style.display = isMatch ? '' : 'none';
  el('teamsel-row').style.display = (selectedMode === 'tagteam' || selectedMode === 'tdm') ? '' : 'none';
  el('host-row').style.display = (isMatch && partyMode === 'host') ? '' : 'none';
  el('join-row').style.display = (isMatch && partyMode === 'join') ? '' : 'none';
  const hc = el('host-code'); if (hc) hc.textContent = hostCode;
}
{
  const nameIn = el('name-input');
  nameIn.value = playerName;
  nameIn.addEventListener('input', () => {
    playerName = nameIn.value.replace(/[^\w \-\[\]]/g, '').slice(0, 20);
    localStorage.setItem(NAME_KEY, playerName);
  });

  // party mode: quick / host / join
  const partyRow = el('partymode-row');
  const paintParty = () => {
    for (const b of partyRow.querySelectorAll('.chip.party')) b.classList.toggle('on', b.dataset.party === partyMode);
  };
  partyRow.addEventListener('click', (e) => {
    const b = e.target.closest('.chip.party');
    if (!b) return;
    partyMode = b.dataset.party;
    localStorage.setItem(PARTY_KEY, partyMode);
    syncCode();
    paintParty();
    updatePartyUI();
  });
  paintParty();

  // host: regenerate your shareable code
  const regen = el('host-regen');
  regen && regen.addEventListener('click', () => {
    hostCode = genRoomCode();
    localStorage.setItem(HOSTCODE_KEY, hostCode);
    syncCode();
    updatePartyUI();
  });

  // join: type a friend's code
  const joinIn = el('join-code');
  joinIn.value = joinCode;
  joinIn.addEventListener('input', () => {
    joinCode = joinIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    joinIn.value = joinCode;
    localStorage.setItem(JOINCODE_KEY, joinCode);
    syncCode();
  });

  const teamRow = el('teamsel-row');
  const paintTeam = () => {
    for (const b of teamRow.querySelectorAll('.chip.team')) b.classList.toggle('on', b.dataset.team === teamPref);
  };
  teamRow.addEventListener('click', (e) => {
    const b = e.target.closest('.chip.team');
    if (!b) return;
    teamPref = b.dataset.team;
    localStorage.setItem(TEAM_KEY, teamPref);
    paintTeam();
  });
  paintTeam();

  const botRow = el('botsel-row');
  const paintBots = () => {
    for (const b of botRow.querySelectorAll('.chip.bots')) b.classList.toggle('on', (b.dataset.bots === 'on') === botsEnabled);
  };
  botRow.addEventListener('click', (e) => {
    const b = e.target.closest('.chip.bots');
    if (!b) return;
    botsEnabled = b.dataset.bots === 'on';
    localStorage.setItem(BOTS_KEY, botsEnabled ? 'on' : 'off');
    paintBots();
  });
  paintBots();
  updatePartyUI();
}

function swapLocalAvatar(id) {
  if (!localChar) return;
  localChar.dispose();
  localChar = factory.create(id, { showName: false, colorSeed: net.sessionId || id });
}

Promise.all([factory.ready, props.ready]).then(() => {
  pickups.buildStations(); // ammo resupply tables (needs the loaded prop models)
  // saved choice might be empty, 'recruit' (removed), or a deleted file — fall
  // back to the first real character.
  if (!factory.list.some((c) => c.id === selectedChar)) {
    selectedChar = factory.list.length ? factory.list[0].id : '';
  }
  buildCharSelect(el('charsel-row'), factory.list, selectedChar, onPickCharacter);
  if (firstLogin) {
    el('charsel').classList.add('attention');
    setStatus('first time here — pick your character, then click play', 'good');
  } else {
    setStatus('ready — click to play', 'good');
  }
  refreshPreview();
});

// ---------------------------------------------------------------------------
// Overlay buttons + pointer-lock feedback
// ---------------------------------------------------------------------------
let joinPending = false;
el('btn-play').addEventListener('click', () => {
  // Pointer lock MUST be requested synchronously inside the click gesture —
  // requesting it after `await join()` is denied by the browser (the gesture
  // is gone), which left the overlay stuck up ("can't start"). Lock now and
  // connect in parallel; the game loop begins once the server spawns us.
  input.requestLock();
  if (!net.room && !joinPending) {
    joinPending = true;
    join().then((ok) => {
      joinPending = false;
      if (!ok && document.pointerLockElement) document.exitPointerLock();
    });
  }
});
el('btn-settings').addEventListener('click', () => settingsPanel.classList.toggle('open'));

input.onLockChange = (locked) => {
  overlay.classList.toggle('hidden', locked);
  if (locked) {
    settingsPanel.classList.remove('open');
    setMsg('');
    audio.unlock(); // WebAudio needs a user gesture — this is one
  }
};
input.onLockError = (reason) => {
  if (reason === 'unsupported') {
    setMsg('This embedded view does not support pointer lock — open this URL in Chrome, Edge, Firefox or Safari directly.');
  } else {
    setMsg('Browser refused mouse capture (Esc cooldown or embedded-view policy). Wait a second and click again — or open this URL in a normal browser window.');
  }
};

function showDisconnected(reason) {
  overlay.classList.remove('hidden');
  el('btn-play').style.display = 'none';
  setStatus('disconnected', 'bad');
  setMsg(`Disconnected — ${escapeHtml(reason)}. <a href="javascript:location.reload()">Reload</a> to rejoin.`);
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
let predictor = null;   // created once the server hands us a spawn
let localChar = null;
let localRegenUntil = 0; // client-side painkiller regen glow window (from 'heal')
let combat = null;
let seq = 0;
let lastStep = null;
let wasAlive = true;
const renderPos = { x: 0, y: 0, z: 0 };
const inputBatch = [];

async function join() {
  const name = (playerName && playerName.trim()) || ('guest-' + String(Math.floor(1000 + Math.random() * 9000)));
  setStatus('connecting to server…');
  hud.set('conn', 'connecting…', 'warn');
  try {
    await Promise.all([factory.ready, props.ready]);
    // code routes the room (share to squad up); team is the tag-team preference.
    // Practice has no party UI, so it must ignore any stale/persisted code and
    // always use the public ('') quick-match pool.
    const code = selectedMode === 'practice' ? '' : roomCode;
    await net.connect(name, { character: selectedChar, mode: selectedMode, code, team: teamPref, bots: botsEnabled });
  } catch (e) {
    console.error('[tdm] join failed', e);
    hud.set('conn', 'failed', 'bad');
    setStatus('server unreachable', 'bad');
    setMsg(`Could not reach the game server at <code>${location.host}</code> — is <code>node server.js</code> running? <a href="javascript:location.reload()">Retry</a>`);
    return false;
  }

  hud.set('conn', 'connected', 'good');
  setStatus('connected', 'good');
  net.onDrop = (reason) => { hud.set('conn', reason, 'bad'); showDisconnected(reason); };

  // Spawn: adopt the server-assigned position/facing exactly once.
  const me = await waitForSelf();
  predictor = new Predictor({ x: me.x, y: me.y, z: me.z });
  input.yaw = me.yaw;
  input.pitch = 0;
  if (previewChar) { previewChar.dispose(); previewChar = null; }
  localChar = factory.create(selectedChar, { showName: false, colorSeed: net.sessionId });
  hud.myName = name;

  combat = new Combat({
    camera, input, net, remotes, effects, hud, audio, settings,
    getPose: () => ({
      x: renderPos.x, y: renderPos.y, z: renderPos.z,
      yaw: input.yaw, crouch: lastStep ? lastStep.crouch : false,
    }),
    isAlive: () => { const p = net.myPlayer(); return p ? p.alive : false; },
    getMuzzle: (out) => (localChar && localChar.getMuzzle) ? localChar.getMuzzle(out) : null,
    onLocalShot: () => localChar.kick(),
    onDamaged: () => { if (localChar.flinch) localChar.flinch(); },
  });
  input.onReload = () => combat.reload();

  // match banners: the server pushes 'announce' at warmup/round/winner moments
  net.room.onMessage('announce', (m) => {
    const win = /win|wins/i.test(m.text || '');
    hud.announce(m, win);
  });

  // health pickup feedback: pack = full heal, pain = regen-over-time
  net.room.onMessage('heal', (m) => {
    audio.heal();
    if (m.kind === 'pain') { hud.healFlash('REGEN', 'pain'); localRegenUntil = performance.now() + PAINKILLER.DURATION_MS; }
    else hud.healFlash('FULL', 'pack');
  });
  // ammo bag refilled at a station
  net.room.onMessage('resupplied', () => { audio.reload(); hud.healFlash('AMMO +', 'ammo'); });

  net.onState = (state) => {
    const self = state.players.get(net.sessionId);
    if (self && predictor) predictor.reconcile(self);
    remotes.onPatch(state, net.sessionId, performance.now());
    pickups.syncHealth(state);
  };
  return true;
}

function waitForSelf() {
  return new Promise((resolve) => {
    const check = () => {
      const p = net.myPlayer();
      if (p) return resolve(p);
      setTimeout(check, 30);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Main loop. Menu state: slow orbit around the character preview. Game state:
// fixed-step input/prediction inside a variable render frame.
// ---------------------------------------------------------------------------
let lastT = performance.now();
let acc = 0;

let frameNo = 0;
let plAccum = 0; // throttle for the live player-list rebuild

function frame() {
  requestAnimationFrame(frame);
  frameNo++;
  if (dynamicShadows && (frameNo & 1) === 0) renderer.shadowMap.needsUpdate = true;
  const now = performance.now();
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.1) dt = 0.1; // tab-switch guard

  // When the menu overlay is up (lobby OR in-match Esc), hide the in-game HUD so
  // it never bleeds out from behind the card. CSS does the actual hiding.
  document.body.classList.toggle('menu-open', !overlay.classList.contains('hidden'));

  if (!predictor) {
    // LOBBY: the game renders as a slowly-orbiting BLURRED backdrop (via CSS),
    // and the selected character shows CRISP in its own canvas on the right.
    const menuShown = !overlay.classList.contains('hidden');
    canvas.classList.toggle('menu-blur', menuShown);
    previewCanvas.classList.toggle('show', menuShown);
    hud.hideMatchHud();
    hud.hidePlayerList();
    world.updateShadowFocus(0, 5);
    const bt = now * 0.00012;
    camera.position.set(Math.sin(bt) * 5.5, 2.1, 5 + Math.cos(bt) * 5.5);
    camera.lookAt(0, 1.05, 5);
    rain.update(dt);
    renderer.render(scene, camera);

    if (menuShown && previewChar) {
      // Face the camera (front visible) with a gentle ±30° sway — a character
      // PICKER should show the face, not spin away to the back. Camera sits in
      // FRONT (−Z) of the character; bodyYaw 0 already faces −Z.
      const sway = Math.sin(now * 0.0004) * 0.55;
      previewChar.bodyYaw = sway;
      previewChar.update(dt, {
        x: 0, y: 0, z: 0, vx: 0, vz: 0,
        yaw: sway, pitch: 0,
        crouch: false, ads: false, grounded: true, alive: true,
      });
      previewCam.position.set(0, 1.28, -3.35);
      previewCam.lookAt(0, 0.82, 0);
      previewRenderer.render(previewScene, previewCam);
    }
    return;
  }

  // in-game: make sure the lobby blur/preview are off
  canvas.classList.remove('menu-blur');
  previewCanvas.classList.remove('show');

  input.fovScale = cam3p.fovScale; // ADS zoom compensation for look speed
  input.update(dt);

  const self = net.myPlayer();
  const alive = self ? self.alive : true;
  if (alive && !wasAlive) hud.clearDeath(); // respawned
  if (!alive && wasAlive) localRegenUntil = 0; // clear the regen glow on death
  wasAlive = alive;

  // Fixed 60Hz input steps: predict locally, batch for the server.
  // While dead the server freezes our sim, so we stop predicting/sending too
  // (stale pending inputs would replay from the respawn point otherwise).
  acc += dt;
  if (!alive) {
    acc = 0;
    predictor.pending.length = 0;
  } else {
    inputBatch.length = 0;
    let steps = 0;
    while (acc >= MOVE.FIXED_DT && steps < 5) {
      seq++;
      const step = input.sampleStep(seq);
      predictor.applyInput(step);
      inputBatch.push(step);
      lastStep = step;
      acc -= MOVE.FIXED_DT;
      steps++;
    }
    if (steps === 5) acc = 0; // dropped time after a long stall
    if (inputBatch.length) net.sendInputs(inputBatch);
  }

  // Local character + camera from the predicted (smoothed) state.
  predictor.renderInto(renderPos, dt);
  const st = predictor.state;
  const stance = lastStep || { crouch: false, ads: false };
  const ads = alive && stance.ads;
  const scope = alive && input.locked && input.scope; // ADS + deep zoom + reticle (not while paused)

  localChar.update(dt, {
    x: renderPos.x, y: renderPos.y, z: renderPos.z,
    vx: st.vx, vz: st.vz,
    yaw: input.yaw, pitch: input.pitch,
    crouch: stance.crouch, ads,
    grounded: st.grounded,
    alive,
    protected: self ? self.protected : false,
    combat: combat ? now - combat.lastShotAt < 1200 : false,
  });

  const camDist = cam3p.update(dt, {
    x: renderPos.x, y: renderPos.y, z: renderPos.z,
    yaw: input.yaw, pitch: input.pitch,
    ads, scope, crouch: stance.crouch,
  });
  hud.setScope(scope); // scope reticle overlay (replaces the red dot while scoped)
  // camera-inside-character hiding — only while alive (death owns visibility:
  // the body is swapped for a grave marker)
  if (alive) localChar.root.visible = camDist > 0.75;

  world.updateShadowFocus(renderPos.x, renderPos.z);
  remotes.update(dt, now);
  pickups.update(dt, now);
  if (combat) combat.update(dt, now, ads);
  effects.update(dt);

  // near a resupply station? press F (interact) to top up the bag.
  let nearStation = false;
  if (self && alive) {
    const r2 = AMMO.STATION_RADIUS * AMMO.STATION_RADIUS;
    for (const s of AMMO_STATIONS) {
      const dx = renderPos.x - s.x, dz = renderPos.z - s.z;
      if (dx * dx + dz * dz <= r2) { nearStation = true; break; }
    }
  }
  const canResupply = nearStation && self && self.reserve < AMMO.RESERVE_CAP;
  const wantInteract = input.takeInteract();
  if (canResupply && wantInteract) net.room.send('resupply');

  hud.tick(dt, {
    ping: net.pingMs,
    players: net.state ? net.state.players.size : null,
    pos: renderPos,
    speed: Math.hypot(st.vx, st.vz),
    hp: self ? self.hp : null,
    mag: combat ? combat.localMag : null,
    magMax: combat ? combat.weapon.magSize : 30,
    reserve: self ? self.reserve : null,
    reserveCap: AMMO.RESERVE_CAP,
    reloading: self ? self.reloading : false,
    resupply: canResupply,
    regen: now < localRegenUntil && alive,
    weapon: combat ? combat.weapon.name : 'AR-9',
    alive,
  });

  // match HUD strip + scoreboard (multiplayer modes)
  if (net.state) {
    hud.matchbar(net.state, self ? self.team : -1, self ? self.lives : null);
    const showSb = input.scoreboardHeld || (net.state.phase === 'ended');
    hud.showScoreboard(showSb);
    if (showSb) hud.renderScoreboard(net.state, net.sessionId, roomCode);

    // live player list (top-left) — rebuilt a few times a second
    plAccum += dt;
    if (plAccum >= 0.4) { plAccum = 0; hud.renderPlayerList(net.state, net.sessionId, roomCode); }
  }

  rain.update(dt);
  renderer.render(scene, camera);
}

requestAnimationFrame(frame);
