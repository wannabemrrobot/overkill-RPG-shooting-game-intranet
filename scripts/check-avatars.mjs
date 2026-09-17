// scripts/check-avatars.mjs
// Headless verification of the avatar rig calibration (rigbind.js) against
// every .glb in assets/characters/ — the proof that all characters behave
// the SAME way in game:
//   - the humanoid bones the animator needs were found,
//   - raised rest arms got auto-lowered (hands end up below shoulders),
//   - each swing axis is calibrated: +angle on a thigh moves the FOOT toward
//     model-forward (+Z) — i.e. legs kick forward, never sideways/backward,
//   - a rifle mount exists and its computed world size is sane.
//
// Loads GLBs with the real three.js GLTFLoader under minimal DOM stubs
// (images "load" instantly as 1x1 stubs — geometry/skeleton math is what we
// care about here, not pixels).
//
//   node scripts/check-avatars.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- DOM stubs so GLTFLoader's texture pipeline resolves in Node ----------
function fakeImg() {
  const listeners = {};
  return {
    width: 1, height: 1, style: {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    set src(_v) { setTimeout(() => (listeners.load || []).forEach((fn) => fn()), 0); },
  };
}
globalThis.document = globalThis.document || {
  createElementNS: (_ns, _tag) => fakeImg(),
  createElement: (tag) => (tag === 'img' ? fakeImg() : { getContext: () => null, style: {} }),
};
globalThis.self = globalThis.self || globalThis;
globalThis.window = globalThis.window || globalThis; // FBX embedded textures use window.URL

const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { bindRig, limbTip, measureAvatar, validateAssembly } = await import('../public/src/game/rigbind.js');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'assets/characters');
// default: everything in assets/characters; or pass explicit .glb paths
const argFiles = process.argv.slice(2);
const files = argFiles.length
  ? argFiles.map((f) => path.resolve(f))
  : fs.readdirSync(dir).filter((f) => /\.(glb|fbx)$/i.test(f)).map((f) => path.join(dir, f));

const loader = new GLTFLoader();
let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failed++;
};
const warn = (msg) => console.log(`  note  ${msg}`);

for (const file of files) {
  console.log(`\n=== ${path.basename(file)} ===`);
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  let model;
  if (/\.fbx$/i.test(file)) {
    model = new FBXLoader().parse(ab, path.dirname(file) + '/');
  } else {
    const gltf = await new Promise((resolve, reject) => {
      loader.parse(ab, path.dirname(file) + '/', resolve, reject);
    });
    model = gltf.scene;
  }

  // Validity gate first: gear-set/flatlay assets are REJECTED by the game
  // (they render as an equipment pile, not a character) — mirroring that
  // here means a rejected file is an expected verdict, not a test failure.
  {
    const a = validateAssembly(model);
    if (!a.ok) {
      console.log(`  REJECTED — not a wearable character: only ${(a.fraction * 100).toFixed(0)}% of skinned vertices sit on the skeleton.`);
      console.log('  (the game falls back to Recruit for this id)');
      continue;
    }
    check('assembly gate passed', true, `${(a.fraction * 100).toFixed(0)}% of skin on skeleton`);
  }

  // Normalization must measure the SKELETON: bind-space mesh bounds lie for
  // "flatlay" exports (gear meshes stored metres from the body). The body
  // (bone cloud) centre must be near the origin the avatar renders at.
  {
    const m = measureAvatar(model);
    const meshBox = new THREE.Box3().setFromObject(model);
    const meshCenter = meshBox.getCenter(new THREE.Vector3());
    const offset = Math.hypot(m.centerX, m.centerZ) / m.height;
    check('skeleton measure centres on the body', offset < 0.35,
      `bone-centre (${m.centerX.toFixed(2)},${m.centerZ.toFixed(2)}) h=${m.height.toFixed(2)} vs mesh-centre z=${meshCenter.z.toFixed(2)}`);
    check('measured height sane', m.height > 0 && Number.isFinite(m.height), m.height.toFixed(3));
  }

  const rig = bindRig(model);
  const bones = rig.bones;

  const has = (k) => !!bones[k];
  check('found hips/spine', has('hips') || has('spine'), Object.keys(bones).filter((k) => /hips|spine/.test(k)).join(','));
  check('found a head', has('head'));

  // Regression guard for the "rotating meshes" bug: every mapped bone must be
  // a real skeleton joint, never a mesh/group node (models ship meshes named
  // "Headphones", "Vest_arm"… — animating those flings gear off the body).
  const fakes = Object.entries(bones).filter(([, b]) => !b.isBone).map(([k, b]) => `${k}=${b.name}(${b.type})`);
  check('all mapped bones are real joints', fakes.length === 0, fakes.join(', ') || 'all THREE.Bone');

  const legs = has('thighL') && has('thighR');
  const arms = has('armL') && has('armR');
  if (!legs) warn('legs not mapped — this model will glide (cryptic bone names)');
  if (!arms) warn('arms not mapped — no arm swing/raise for this model');

  // arms lowered: hand tip should sit below the shoulder after baseline
  for (const sd of ['L', 'R']) {
    const arm = bones['arm' + sd];
    const tip = bones['hand' + sd] || bones['forearm' + sd];
    if (!arm || !tip) continue;
    model.updateWorldMatrix(true, true);
    const a = arm.getWorldPosition(new THREE.Vector3());
    const t = tip.getWorldPosition(new THREE.Vector3());
    check(`arm ${sd} relaxed (tip below shoulder)`, t.y < a.y + 1e-3, `tipY ${t.y.toFixed(2)} vs shoulderY ${a.y.toFixed(2)}`);
  }

  // calibrated axes: +angle must move the limb tip toward model-forward (+Z)
  for (const key of ['thighL', 'thighR', 'armL', 'armR']) {
    const bone = bones[key];
    const axis = rig.axes[key];
    if (!bone) continue;
    if (!axis) { check(`${key} axis calibrated`, false, 'no responsive axis found'); continue; }
    const tip = limbTip(bones, key) || bone;

    model.updateWorldMatrix(true, true);
    const before = tip.getWorldPosition(new THREE.Vector3());
    const saved = bone.quaternion.clone();
    bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, 0.4));
    model.updateWorldMatrix(true, true);
    const after = tip.getWorldPosition(new THREE.Vector3());
    bone.quaternion.copy(saved);
    const dz = after.z - before.z;
    check(`${key} +swing moves tip forward`, dz > 1e-5, `dz ${dz.toFixed(4)}`);
  }

  // rifle mount
  if (rig.rifleMount) {
    const m = rig.rifleMount;
    model.updateWorldMatrix(true, true);
    const ws = m.bone.getWorldScale(new THREE.Vector3());
    const avg = (ws.x + ws.y + ws.z) / 3;
    const rifleWorld = m.scale * avg; // rifle world factor before template scale
    check('rifle mount computed', Number.isFinite(m.scale) && m.scale > 0,
      `bone "${m.bone.name}" boneWorldScale ${avg.toFixed(4)} -> rifle x${m.scale.toFixed(2)} (net ${rifleWorld.toFixed(2)})`);
    check('rifle net world factor ≈ 1', Math.abs(rifleWorld - 1) < 0.05, rifleWorld.toFixed(3));
  } else {
    warn('no arm/hand bone — this model carries no rifle');
  }
}

console.log(failed === 0 ? '\nALL AVATAR RIG CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed ? 1 : 0);
