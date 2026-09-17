// src/server/characters.js
// Server-side character registry: the .glb files in assets/characters/ ARE
// the list (drop a new file in, restart nothing — the scan is cached briefly).
// 'recruit' is the built-in procedural character and always valid.
// Characters are cosmetic only: hitboxes/speed/damage are identical for all.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DIR = path.join(ROOT, 'assets/characters');
const ANIM_DIR = path.join(ROOT, 'assets/anims');
const CACHE_MS = 10_000;

let cache = null;      // [{id, file}]
let cachedAt = 0;

// Character files that exist but are NOT wearable characters — the client's
// assembly gate (rigbind.validateAssembly) rejects them and would fall back to
// the procedural avatar, which we no longer want to show. Hidden everywhere:
// picker, defaults, and bot assignment.
const EXCLUDED = new Set(['military']);

function scanCharacters() {
  const now = Date.now();
  if (!cache || now - cachedAt > CACHE_MS) {
    try {
      cache = fs.readdirSync(DIR)
        .filter((f) => /\.(glb|fbx)$/i.test(f))
        .map((f) => ({ id: f.replace(/\.(glb|fbx)$/i, ''), file: `/assets/characters/${f}` }))
        .filter((c) => !EXCLUDED.has(c.id));
    } catch {
      cache = [];
    }
    cachedAt = now;
  }
  return cache;
}

export function characterIds() {
  return scanCharacters().map((c) => c.id);
}

// Default character for invalid/missing picks (Recruit no longer exists).
export function defaultCharacter() {
  const ids = characterIds();
  return ids.includes('vanguard') ? 'vanguard' : (ids[0] || 'vanguard');
}

// A random real character — used to dress bots so they never appear as the
// old procedural recruit.
export function randomCharacter() {
  const ids = characterIds();
  return ids.length ? ids[Math.floor(Math.random() * ids.length)] : defaultCharacter();
}

// Gender drives only the LOBBY preview idle (idle_m vs idle_w) — purely
// cosmetic. New characters default to 'm'; add female ids here.
const FEMALE_IDS = new Set(['arissa', 'erika', 'eve', 'kachujin']);

export function characterManifest() {
  return {
    characters: scanCharacters().map((c) => ({
      id: c.id,
      label: prettyLabel(c.id),
      file: c.file,
      gender: FEMALE_IDS.has(c.id) ? 'f' : 'm',
    })),
  };
}

// Shared animation clip library (mixamo FBX files, retargeted client-side
// onto any character whose skeleton matches).
export function animsManifest() {
  let files = [];
  try {
    files = fs.readdirSync(ANIM_DIR).filter((f) => f.toLowerCase().endsWith('.fbx'));
  } catch { /* no anims dir */ }
  return {
    anims: files.map((f) => ({
      key: f.replace(/\.fbx$/i, '').toLowerCase(),
      file: `/assets/anims/${f}`,
    })),
  };
}

// Coerce a client-supplied character id to a real, loadable character.
export function sanitizeCharacter(raw) {
  const id = String(raw || '').slice(0, 32);
  return characterIds().includes(id) ? id : defaultCharacter();
}

function prettyLabel(id) {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
