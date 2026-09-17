// public/src/ui/settings.js
// Player-tunable input/comfort settings: defaults, localStorage persistence,
// and the settings panel UI (sliders, toggles, key rebinding).
// Trackpad-first philosophy: everything combat-critical must be reachable and
// comfortable with one hand on the keyboard and one finger on the trackpad.

const STORAGE_KEY = 'tdm.settings.v1';

export const DEFAULTS = {
  // Look feel (trackpad-tuned; see input.js pipeline for how each is applied)
  sens: 1.0,        // 0.2..3.0 — base look scale
  accelOn: true,    // flick acceleration: fast swipes turn disproportionally more
  accel: 0.5,       // 0..1 — acceleration strength
  smooth: 0.35,     // 0..1 — look smoothing (EMA); small default hides tap jitter
  invertY: false,
  aimAssist: 0.6,   // 0..1 — reticle slowdown + bullet magnetism strength
  adsSoftLock: true, // gentle ease toward the target while ADS
  shadows: true,     // dynamic sun shadow maps (off = cheap blob shadows)
  rain: false,       // optional rain weather (toggles live)

  // Comfort toggles (prefer toggles over holds for trackpad hands)
  adsToggle: true,      // Q toggles aim; false = hold-to-aim
  crouchToggle: true,   // C toggles crouch; false = hold-to-crouch
  autoRun: true,        // true: default speed is run, Shift = precision walk
  fireMode: 'click',    // 'click' (trackpad tap) | 'key' (keyboard F) — Phase 2

  shoulder: 1,          // +1 right shoulder, -1 left (Z swaps at runtime)

  binds: {
    forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
    jump: 'Space', crouch: 'KeyC', walkMod: 'ShiftLeft',
    ads: 'KeyQ', scope: 'KeyE', swap: 'KeyZ', reload: 'KeyR',
    fireKey: 'KeyF', interact: 'KeyF', scoreboard: 'Tab',
  },
};

export function loadSettings() {
  let s = structuredClone(DEFAULTS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      s = { ...s, ...saved, binds: { ...s.binds, ...(saved.binds || {}) } };
    }
  } catch { /* corrupted storage -> defaults */ }
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------------------
// Panel UI. Rows are generated from a declarative spec -> less DOM boilerplate,
// and the spec doubles as documentation of every tunable.
// ---------------------------------------------------------------------------
const SLIDERS = [
  { key: 'sens',      label: 'Look sensitivity',   min: 0.2, max: 3.0, step: 0.05 },
  { key: 'accel',     label: 'Flick acceleration', min: 0,   max: 1,   step: 0.05, gate: 'accelOn' },
  { key: 'smooth',    label: 'Look smoothing',     min: 0,   max: 0.8, step: 0.05 },
  { key: 'aimAssist', label: 'Aim assist strength', min: 0, max: 1,   step: 0.05 },
];

const TOGGLES = [
  { key: 'rain',         label: 'Rain (weather)' },
  { key: 'shadows',      label: 'Dynamic sun shadows (reload to apply)' },
  { key: 'accelOn',      label: 'Aim acceleration' },
  { key: 'adsSoftLock',  label: 'ADS soft-lock (aim assist)' },
  { key: 'invertY',      label: 'Invert Y' },
  { key: 'adsToggle',    label: 'ADS as toggle (off = hold)' },
  { key: 'crouchToggle', label: 'Crouch as toggle (off = hold)' },
  { key: 'autoRun',      label: 'Auto-run (Shift walks)' },
];

const BIND_LABELS = {
  forward: 'Move forward', back: 'Move back', left: 'Move left', right: 'Move right',
  jump: 'Jump', crouch: 'Crouch', walkMod: 'Precision walk (hold)',
  ads: 'Aim (ADS)', scope: 'Scope (deep zoom)', interact: 'Interact / resupply', swap: 'Shoulder swap', reload: 'Reload (phase 2)',
  fireKey: 'Fire key (alt to click)', scoreboard: 'Scoreboard',
};

function prettyKey(code) {
  return code
    .replace(/^Key/, '').replace(/^Digit/, '')
    .replace('Left', ' L').replace('Right', ' R')
    .replace('Space', 'SPACE');
}

// Builds the panel inside `root`. `onChange(settings)` fires after every edit.
export function buildSettingsPanel(root, settings, onChange) {
  root.innerHTML = '';
  const commit = () => { saveSettings(settings); onChange(settings); };

  const h = document.createElement('div');
  h.className = 'set-title';
  h.textContent = 'SETTINGS';
  root.appendChild(h);

  const grid = document.createElement('div');
  grid.className = 'set-grid';
  root.appendChild(grid);

  // --- sliders ---
  for (const spec of SLIDERS) {
    const row = document.createElement('label');
    row.className = 'set-row';
    const name = document.createElement('span');
    name.textContent = spec.label;
    const val = document.createElement('span');
    val.className = 'set-val';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = spec.min; input.max = spec.max; input.step = spec.step;
    input.value = settings[spec.key];
    const paint = () => {
      val.textContent = Number(settings[spec.key]).toFixed(2);
      if (spec.gate) input.disabled = !settings[spec.gate];
    };
    input.addEventListener('input', () => {
      settings[spec.key] = Number(input.value);
      paint(); commit();
    });
    paint();
    row.append(name, input, val);
    grid.appendChild(row);
  }

  // --- toggles ---
  for (const spec of TOGGLES) {
    const row = document.createElement('label');
    row.className = 'set-row';
    const name = document.createElement('span');
    name.textContent = spec.label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!settings[spec.key];
    input.addEventListener('change', () => {
      settings[spec.key] = input.checked;
      buildSettingsPanel(root, settings, onChange); // repaint (slider gating)
      commit();
    });
    const spacer = document.createElement('span');
    row.append(name, spacer, input);
    grid.appendChild(row);
  }

  // --- fire mode (radio pair) ---
  {
    const row = document.createElement('div');
    row.className = 'set-row';
    const name = document.createElement('span');
    name.textContent = 'Fire input';
    const box = document.createElement('span');
    box.className = 'set-radio';
    for (const [v, lbl] of [['click', 'trackpad click'], ['key', 'keyboard key']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (settings.fireMode === v ? ' on' : '');
      b.textContent = lbl;
      b.addEventListener('click', () => {
        settings.fireMode = v;
        buildSettingsPanel(root, settings, onChange);
        commit();
      });
      box.appendChild(b);
    }
    const spacer = document.createElement('span');
    row.append(name, spacer, box);
    grid.appendChild(row);
  }

  // --- rebinding ---
  const bh = document.createElement('div');
  bh.className = 'set-title';
  bh.textContent = 'KEY BINDINGS  (click, then press a key — Esc cancels)';
  root.appendChild(bh);

  const bgrid = document.createElement('div');
  bgrid.className = 'set-grid';
  root.appendChild(bgrid);

  for (const action of Object.keys(settings.binds)) {
    const row = document.createElement('div');
    row.className = 'set-row';
    const name = document.createElement('span');
    name.textContent = BIND_LABELS[action] || action;
    const spacer = document.createElement('span');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip key';
    btn.textContent = prettyKey(settings.binds[action]);
    btn.addEventListener('click', () => {
      btn.textContent = 'press key…';
      btn.classList.add('listening');
      const onKey = (e) => {
        e.preventDefault(); e.stopPropagation();
        window.removeEventListener('keydown', onKey, true);
        if (e.code !== 'Escape') {
          settings.binds[action] = e.code;
          commit();
        }
        buildSettingsPanel(root, settings, onChange);
      };
      window.addEventListener('keydown', onKey, true);
    });
    row.append(name, spacer, btn);
    bgrid.appendChild(row);
  }

  // --- reset ---
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'chip danger';
  reset.textContent = 'Reset to defaults';
  reset.addEventListener('click', () => {
    const d = structuredClone(DEFAULTS);
    for (const k of Object.keys(settings)) delete settings[k];
    Object.assign(settings, d);
    buildSettingsPanel(root, settings, onChange);
    commit();
  });
  root.appendChild(reset);
}
