// scripts/check-anims.mjs
// Verifies mixamo animation FBX files against a character skeleton:
//   - each file parses and contains exactly one clip (name, duration, tracks)
//   - clip track targets exist on the character's skeleton (retargetability)
//   - root-motion report: how far the hips travel in X/Z (tells us which
//     locomotion clips need in-place stripping at load)
//
//   node scripts/check-anims.mjs <character.(fbx|glb)> <anim.fbx> [...more]
//   node scripts/check-anims.mjs               # defaults: assets/characters/vanguard.fbx + assets/anims/*.fbx

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fakeImg() {
  const l = {};
  return { width: 1, height: 1, style: {},
    addEventListener(t, fn) { (l[t] = l[t] || []).push(fn); }, removeEventListener() {},
    set src(_v) { setTimeout(() => (l.load || []).forEach((fn) => fn()), 0); } };
}
globalThis.document = globalThis.document || {
  createElementNS: () => fakeImg(),
  createElement: (t) => (t === 'img' ? fakeImg() : { getContext: () => null, style: {} }),
};
globalThis.self = globalThis.self || globalThis;
globalThis.window = globalThis.window || globalThis; // FBX embedded textures use window.URL

const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

let charFile, animFiles;
if (args.length >= 2) {
  [charFile, ...animFiles] = args.map((f) => path.resolve(f));
} else {
  charFile = path.join(root, 'assets/characters/vanguard.fbx');
  const dir = path.join(root, 'assets/anims');
  animFiles = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.fbx')).map((f) => path.join(dir, f))
    : [];
}

async function load(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (file.toLowerCase().endsWith('.glb') || file.toLowerCase().endsWith('.gltf')) {
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, path.dirname(file) + '/', res, rej));
    return { root: gltf.scene, animations: gltf.animations || [] };
  }
  const grp = new FBXLoader().parse(ab, path.dirname(file) + '/');
  return { root: grp, animations: grp.animations || [] };
}

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failed++;
};

// --- character skeleton ---
console.log(`=== character: ${path.basename(charFile)} ===`);
const ch = await load(charFile);
const boneNames = new Set();
let skinned = 0;
ch.root.traverse((o) => {
  if (o.isBone) boneNames.add(o.name);
  if (o.isSkinnedMesh) skinned++;
});
check('character is skinned', skinned > 0, `${skinned} skinned meshes`);
check('skeleton present', boneNames.size >= 15, `${boneNames.size} bones`);
const sampleBones = [...boneNames].slice(0, 3).join(', ');
console.log(`  bones sample: ${sampleBones}`);

// --- animations ---
for (const file of animFiles) {
  console.log(`\n=== anim: ${path.basename(file)} ===`);
  try {
    const a = await load(file);
    check('contains a clip', a.animations.length >= 1, `${a.animations.length} clip(s)`);
    if (!a.animations.length) continue;
    const clip = a.animations[0];

    // retargetability: what fraction of tracks bind to the character's bones
    let bindable = 0;
    const missing = new Set();
    for (const tr of clip.tracks) {
      const node = tr.name.split('.')[0];
      if (boneNames.has(node)) bindable++;
      else missing.add(node);
    }
    const frac = clip.tracks.length ? bindable / clip.tracks.length : 0;
    check('tracks bind to character skeleton', frac >= 0.9,
      `${(frac * 100).toFixed(0)}% of ${clip.tracks.length} tracks` +
      (missing.size ? ` — unmatched: ${[...missing].slice(0, 3).join(', ')}` : ''));
    console.log(`  clip "${clip.name}" duration ${clip.duration.toFixed(2)}s`);

    // root motion: hips position travel in X/Z
    const hips = clip.tracks.find((t) => /hips\.position/i.test(t.name));
    if (hips) {
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (let i = 0; i < hips.values.length; i += 3) {
        minX = Math.min(minX, hips.values[i]); maxX = Math.max(maxX, hips.values[i]);
        minZ = Math.min(minZ, hips.values[i + 2]); maxZ = Math.max(maxZ, hips.values[i + 2]);
      }
      const travel = Math.hypot(maxX - minX, maxZ - minZ);
      console.log(`  root motion: hips XZ travel ${travel.toFixed(1)} units ${travel > 20 ? '-> NEEDS in-place stripping' : '(near in-place)'}`);
    } else {
      console.log('  root motion: no hips position track');
    }
  } catch (e) {
    check('parses', false, e.message.slice(0, 100));
  }
}

console.log(failed === 0 ? '\nALL ANIMATION CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed ? 1 : 0);
