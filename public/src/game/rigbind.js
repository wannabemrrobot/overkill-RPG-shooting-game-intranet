// public/src/game/rigbind.js
// Rig calibration for arbitrary humanoid GLBs — the reason every character
// animates the SAME way regardless of who exported it.
//
// Downloaded models disagree about everything: bone naming schemes, rest pose
// (T-pose vs A-pose), local bone axes, internal armature scale, even which way
// is forward. So instead of trusting names/axes, this module:
//   1. maps bones with fuzzy, scheme-aware name matching (mixamo / Ben10_* /
//      LegL / e_*_m_* styles), with graceful per-limb fallbacks,
//   2. auto-lowers raised rest arms by MEASURING the shoulder->wrist direction
//      and rotating it toward "down" (T-pose becomes relaxed),
//   3. calibrates a swing axis PER BONE by test-rotating it and measuring
//      which local axis actually moves the foot/hand toward model-forward
//      (+Z in glTF) — so legs kick forward on every rig, never sideways,
//   4. computes a rifle mount (position/rotation/scale) on the best right-arm
//      bone using world transforms, immune to internal armature scaling.
//
// Pure three.js math — imported by the browser client AND the Node-side
// verification script (scripts/check-avatars.mjs). Keep it DOM-free.

import * as THREE from 'three';

const FORWARD = new THREE.Vector3(0, 0, 1); // glTF-standard model forward
const DOWN = new THREE.Vector3(0, -1, 0);

// Add an empty marker at the rifle's BARREL TIP (its geometry's -Z extent — the
// gun template faces -Z) as a child of the rifle, so its world position tracks
// the actual rendered muzzle through the hand animation, recoil, aim and body
// rotation. Muzzle flash + tracers read this instead of a hardcoded body offset.
export function attachMuzzle(rifle) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  rifle.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(rifle.matrixWorld).invert();
  rifle.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
      o.localToWorld(v);          // mesh-local -> world
      v.applyMatrix4(inv);        // world -> rifle-local
      box.expandByPoint(v);
    }
  });
  const marker = new THREE.Object3D();
  marker.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z);
  rifle.add(marker);
  return marker;
}

// ---------------------------------------------------------------------------
// 1. bone mapping
// ---------------------------------------------------------------------------
function norm(name) { return String(name || '').toLowerCase(); }

function side(name) {
  const n = norm(name);
  if (/left/.test(n)) return 'L';
  if (/right/.test(n)) return 'R';
  // token "l"/"r": LegL_03, e_shoulder_r_010, ArmR, Ben10_RThigh
  if (/(^|[^a-z])l([^a-z]|$)/.test(n) || /[a-z](?:l)(?=[^a-z]|$)/.test(n) && /(leg|arm|hand|foot|shoulder|thigh|calf)l(?=[^a-z]|$)/.test(n)) return 'L';
  if (/(^|[^a-z])r([^a-z]|$)/.test(n) || /(leg|arm|hand|foot|shoulder|thigh|calf)r(?=[^a-z]|$)/.test(n)) return 'R';
  if (/(^|[^a-z])l(thigh|calf|upperarm|forearm|arm|hand|leg|foot|shoulder)/.test(n)) return 'L';
  if (/(^|[^a-z])r(thigh|calf|upperarm|forearm|arm|hand|leg|foot|shoulder)/.test(n)) return 'R';
  return null;
}

// score-based part detection; higher wins
function partScores(name) {
  const n = norm(name);
  const s = {};
  const fingerish = /thumb|index|middle|ring|pinky|finger|_end|end_|tip/.test(n);

  if (/upleg|thigh/.test(n)) s.thigh = 3;
  else if (/(^|[^a-z])hip(?!s)/.test(n)) s.thigh = 2;               // e_hip_l style
  else if (/leg/.test(n) && !/lower|calf|shin/.test(n)) s.thigh = 1; // plain "leg" MAY be a thigh (LegL) or a shin (mixamo Leg)
  if (/calf|shin|lowerleg|knee/.test(n)) s.shin = 3;
  if (/foot|ankle/.test(n)) s.foot = 3;
  if (/hand|wrist|palm/.test(n)) s.hand = fingerish ? 1 : 3;         // fingers lose to the actual hand
  if (/forearm|lowerarm|elbow/.test(n)) s.forearm = 3;
  if (/upperarm/.test(n)) s.arm = 3;
  else if (/(^|[^a-z])arm|arm(l|r)?([^a-z]|$)/.test(n) && !/forearm|lowerarm/.test(n)) s.arm = 2;
  if (/shoulder|clavicle|scapula/.test(n)) s.shoulder = 2;
  if (/head(?!.*(top|end))/.test(n)) s.head = 3;
  if (/neck/.test(n)) s.head = Math.max(s.head || 0, 1);
  if (/spine|chest|torso/.test(n)) s.spine = 2;
  if (/hips|pelvis/.test(n)) s.hips = 3;
  return s;
}

export function mapBones(root) {
  const found = {}; // key -> {bone, score, depth}
  const put = (key, bone, score, depth) => {
    const cur = found[key];
    // prefer higher score; tie-break: deeper for hands/feet, shallower for spine
    const deeper = /hand|foot|forearm/.test(key);
    if (!cur || score > cur.score || (score === cur.score && (deeper ? depth > cur.depth : depth < cur.depth))) {
      found[key] = { bone, score, depth };
    }
  };

  // CRITICAL: only real skeleton joints qualify. Models ship MESH nodes named
  // "Headphones", "Vest_arm", "Backpack_black"… — matching those as bones
  // means rotating actual geometry every frame (gear flying off the body, a
  // giant dark mesh swinging through the sky — seen in the field). Only if a
  // model has NO THREE.Bone at all do we fall back to name-based nodes.
  let hasRealBones = false;
  root.traverse((o) => { if (o.isBone) hasRealBones = true; });

  const walk = (o, depth) => {
    if (!hasRealBones || o.isBone) {
      const sd = side(o.name);
      const scores = partScores(o.name);
      for (const [part, score] of Object.entries(scores)) {
        if (part === 'head' || part === 'spine' || part === 'hips') put(part, o, score, depth);
        else if (sd) put(part + sd, o, score, depth);
      }
    }
    for (const c of o.children) walk(c, depth + 1);
  };
  walk(root, 0);

  // mixamo-style disambiguation: plain "Leg" bones are shins when an
  // "UpLeg" thigh exists on the same side
  for (const sd of ['L', 'R']) {
    const thigh = found['thigh' + sd];
    if (thigh && thigh.score === 1) {
      // plain "leg" won thigh: fine unless a real thigh (upleg) also matched
    }
    if (!found['shin' + sd] && thigh && thigh.score === 3) {
      // look for a plain-"leg" child under the thigh to use as shin
      thigh.bone.traverse((c) => {
        if (c !== thigh.bone && /leg/.test(norm(c.name)) && side(c.name) === sd && !found['shin' + sd]) {
          found['shin' + sd] = { bone: c, score: 2, depth: 0 };
        }
      });
    }
  }

  const bones = {};
  for (const [k, v] of Object.entries(found)) bones[k] = v.bone;

  // Rigs where the "shoulder" bone IS the upper arm (e_shoulder_l style):
  // fall back so arm swing/raise still works.
  for (const sd of ['L', 'R']) {
    if (!bones['arm' + sd] && bones['shoulder' + sd]) bones['arm' + sd] = bones['shoulder' + sd];
  }
  return bones;
}

// ---------------------------------------------------------------------------
// helpers on posed skeletons
// ---------------------------------------------------------------------------
const _wp1 = new THREE.Vector3();
const _wp2 = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _tq = new THREE.Quaternion();
const _v = new THREE.Vector3();

function isDescendant(ancestor, node) {
  let p = node;
  while (p) { if (p === ancestor) return true; p = p.parent; }
  return false;
}

function deepestDescendant(bone) {
  let best = bone, bestD = 0;
  bone.traverse((o) => {
    let d = 0, p = o;
    while (p && p !== bone) { d++; p = p.parent; }
    if (d > bestD) { bestD = d; best = o; }
  });
  return best;
}

// End-effector used to measure a limb's direction/response. Must be a real
// DESCENDANT of the limb bone (some rigs parent ankles/hands elsewhere, e.g.
// IK setups) — otherwise rotating the bone appears to move nothing.
// (exported for the headless verification script)
export function limbTip(bones, key) {
  const bone = bones[key];
  if (!bone) return null;
  const sd = key.slice(-1);
  let candidates = [];
  if (key.startsWith('thigh')) candidates = [bones['foot' + sd], bones['shin' + sd]];
  else if (key.startsWith('arm')) candidates = [bones['hand' + sd], bones['forearm' + sd]];
  else if (key === 'spine') candidates = [bones.head];
  for (const c of candidates) {
    if (c && c !== bone && isDescendant(bone, c)) return c;
  }
  const deep = deepestDescendant(bone);
  return deep !== bone ? deep : bone;
}

// Rotate `bone` by `angle` about its local `axis` and measure how far the
// limb tip moves along `dir` (model space). Restores the pose afterwards.
function responseAlong(model, bone, tip, axis, angle, dir) {
  bone.updateWorldMatrix(true, true);
  tip.getWorldPosition(_wp1);
  const saved = bone.quaternion.clone();
  _tq.setFromAxisAngle(axis, angle);
  bone.quaternion.multiply(_tq);
  bone.updateWorldMatrix(true, true);
  tip.getWorldPosition(_wp2);
  bone.quaternion.copy(saved);
  bone.updateWorldMatrix(true, true);
  return _wp2.sub(_wp1).dot(dir);
}

// Find the local axis whose rotation moves the tip the most along model
// FORWARD (+Z), signed so +angle = tip moves forward. This is what makes a
// leg "kick forward" on any rig regardless of local bone conventions.
function calibrateSwingAxis(model, bone, tip) {
  const axes = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1),
  ];
  let best = null, bestMag = 0;
  for (const axis of axes) {
    const r = responseAlong(model, bone, tip, axis, 0.35, FORWARD);
    if (Math.abs(r) > Math.abs(bestMag)) { bestMag = r; best = axis.clone(); }
  }
  if (!best || Math.abs(bestMag) < 1e-5) return null;
  if (bestMag < 0) best.negate(); // +angle must swing forward
  return best;
}

// Lower a raised rest arm: rotate the upper-arm bone (about its calibrated
// "lower" axis) until the shoulder->tip direction points mostly down.
function lowerArm(model, bone, tip) {
  bone.updateWorldMatrix(true, true);
  bone.getWorldPosition(_wp1);
  tip.getWorldPosition(_wp2);
  _v.copy(_wp2).sub(_wp1).normalize();
  const raised = _v.dot(DOWN); // 1 = already down, ~0 = T-pose
  if (raised > 0.75) return;   // already relaxed

  // find the local axis that best moves the tip DOWN
  const axes = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1),
  ];
  let best = null, bestMag = 0;
  for (const axis of axes) {
    const r = responseAlong(model, bone, tip, axis, 0.3, DOWN);
    if (Math.abs(r) > Math.abs(bestMag)) { bestMag = r; best = axis.clone(); }
  }
  if (!best || Math.abs(bestMag) < 1e-5) return;
  if (bestMag < 0) best.negate();

  // binary-ish search: rotate until the arm points down-ish (or 100 degrees)
  let applied = 0;
  for (let i = 0; i < 24; i++) {
    if (applied > 1.75) break;
    _tq.setFromAxisAngle(best, 0.08);
    bone.quaternion.multiply(_tq);
    applied += 0.08;
    bone.updateWorldMatrix(true, true);
    bone.getWorldPosition(_wp1);
    tip.getWorldPosition(_wp2);
    _v.copy(_wp2).sub(_wp1).normalize();
    if (_v.dot(DOWN) > 0.82) break;
  }
}

// ---------------------------------------------------------------------------
// Avatar measurement for normalization (scale-to-height, feet-to-ground,
// centre-on-body). For SKINNED models this measures the BONE cloud, not the
// mesh bounding box: skinned geometry is stored in bind space, and some
// models (e.g. equipment "flatlay" exports) lay their pieces out metres away
// from the body — a mesh bbox there recentres the avatar into empty space
// (gear hovering into the camera, rigid accessories floating off the head).
// The skeleton always stands where the body actually renders.
// ---------------------------------------------------------------------------
export function measureAvatar(root) {
  root.updateWorldMatrix(true, true);
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o); });

  const box = new THREE.Box3();
  if (bones.length >= 4) {
    const v = new THREE.Vector3();
    for (const b of bones) box.expandByPoint(b.getWorldPosition(v));
    const s = box.getSize(new THREE.Vector3());
    box.expandByScalar(Math.max(s.y * 0.07, 0.01)); // joints -> add head/feet volume
  } else {
    box.setFromObject(root);
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return {
    height: Math.max(0.01, size.y),
    minY: box.min.y,
    centerX: center.x,
    centerZ: center.z,
  };
}

// ---------------------------------------------------------------------------
// Character validity gate. Some downloads are gear SETS, not characters:
// skinned meshes bound as a floor "flatlay" product display that never
// assembles onto the skeleton (no body mesh at all). Rendering one of those
// as an avatar produces a haunted pile of equipment chasing the player.
// Verdict: sample every skinned vertex against the skeleton's own bounding
// box (padded) — a wearable character has the bulk of its skin ON the bones.
// ---------------------------------------------------------------------------
export function validateAssembly(root) {
  root.updateWorldMatrix(true, true);

  const bones = [];
  const skinned = [];
  root.traverse((o) => {
    if (o.isBone) bones.push(o);
    if (o.isSkinnedMesh) skinned.push(o);
  });
  if (!skinned.length || bones.length < 4) {
    return { ok: true, fraction: 1 }; // rigid/simple model — nothing to verify
  }

  // make sure bone matrices are live (headless callers never rendered)
  const skeletons = new Set(skinned.map((m) => m.skeleton));
  for (const s of skeletons) s.update();

  const boneBox = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const b of bones) boneBox.expandByPoint(b.getWorldPosition(v));
  const size = boneBox.getSize(new THREE.Vector3());
  const pad = Math.max(size.y * 0.3, 0.05);
  boneBox.expandByScalar(pad);

  let inside = 0, total = 0;
  for (const mesh of skinned) {
    const pos = mesh.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 300));
    for (let i = 0; i < pos.count; i += step) {
      mesh.getVertexPosition(i, v);        // applies bone transforms
      v.applyMatrix4(mesh.matrixWorld);
      total++;
      if (boneBox.containsPoint(v)) inside++;
    }
  }
  const fraction = total ? inside / total : 0;
  return { ok: fraction >= 0.6, fraction };
}

// ---------------------------------------------------------------------------
// main entry: bind + calibrate a cloned model. Mutates the model's rest pose
// (arms lowered) and returns everything the animator needs.
// ---------------------------------------------------------------------------
export function bindRig(model) {
  model.updateWorldMatrix(true, true);
  const bones = mapBones(model);

  // relax raised arms BEFORE snapshotting rest pose / calibrating axes
  for (const sd of ['L', 'R']) {
    const arm = bones['arm' + sd];
    const tip = limbTip(bones, 'arm' + sd);
    if (arm && tip && tip !== arm) lowerArm(model, arm, tip);
  }
  model.updateWorldMatrix(true, true);

  const rig = { bones, rest: {}, axes: {} };
  for (const key of ['thighL', 'thighR', 'armL', 'armR', 'spine', 'head', 'shinL', 'shinR']) {
    const bone = bones[key];
    if (!bone) continue;
    rig.rest[key] = bone.quaternion.clone();
    const tip = key.startsWith('shin')
      ? (bones['foot' + key.slice(-1)] && isDescendant(bone, bones['foot' + key.slice(-1)])
          ? bones['foot' + key.slice(-1)] : deepestDescendant(bone))
      : limbTip(bones, key);
    if (tip && tip !== bone) {
      rig.axes[key] = calibrateSwingAxis(model, bone, tip);
    }
  }

  // ---- rifle mount on the best right-arm point ----------------------------
  const mount = bones.handR || bones.forearmR || bones.armR || null;
  if (mount) {
    mount.updateWorldMatrix(true, true);
    const wScale = mount.getWorldScale(new THREE.Vector3());
    const wQuat = mount.getWorldQuaternion(new THREE.Quaternion());
    const s = 1 / Math.max(1e-6, (wScale.x + wScale.y + wScale.z) / 3);
    // orientation: rifle's -Z (barrel) should face model FORWARD (+Z)
    const desired = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    rig.rifleMount = {
      bone: mount,
      scale: s,
      quat: wQuat.clone().invert().multiply(desired),
    };
  } else {
    rig.rifleMount = null;
  }

  return rig;
}
