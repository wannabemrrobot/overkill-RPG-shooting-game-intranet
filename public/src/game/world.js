// public/src/game/world.js
// Builds the visible arena from the SAME shared/map.js data the movement
// simulation collides against — geometry and physics can't drift apart.
//
// Two layers:
//  1. buildWorld() — synchronous procedural base: sky, light, ground, fence,
//     grass billboards, and plain wooden blocks over every collision box.
//     The world is complete and playable the instant the page loads.
//  2. enhance() — async: loads the craftpix packs (assets.js) and dresses the
//     world properly — palm/tree forest ring, bush/stone undergrowth, and
//     props (crates/barrels/wells/haystacks) replacing the plain blocks on
//     non-wall slots. If assets fail to load, the procedural look stays and
//     a procedural forest fills in — nothing user-facing ever breaks.
//
// Gameplay geometry NEVER changes here: props are scale-to-fit dressings of
// the exact AABBs in shared/map.js, so what you collide with is what you see.

import * as THREE from 'three';
import { MAP } from '/shared/map.js';
import { rng, grassTexture, woodTexture, grassBladeTexture, skyTexture, sunTexture } from './textures.js';
import { loadScenery, fitScale } from './assets.js';

const SHADOW_MAP = 1024;  // perf: 4x cheaper than 2048 on weak GPUs
const SHADOW_HALF = 28;   // tight frustum = sharp shadows + fewer casters
// Sun bearing: front-RIGHT of the default view and fairly low, so the disc
// is clearly visible to the side and shadows stretch long across the ground.
const SUN_DIR = new THREE.Vector3(55, 44, -28).normalize();

export function buildWorld(scene, { shadows = true } = {}) {
  const horizon = new THREE.Color(0xaed0d6);
  scene.fog = new THREE.Fog(horizon, 62, 170);

  // --- sky dome ---------------------------------------------------------
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(220, 24, 12),
    new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false })
  );
  sky.renderOrder = -1;
  scene.add(sky);

  // visible sun: crisp disc + soft round halo (radial texture — untextured
  // sprites render as SQUARES and had white-washed the whole sky)
  {
    const sunTex = sunTexture();
    const sunPos = SUN_DIR.clone().multiplyScalar(205);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: sunTex, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    halo.position.copy(sunPos);
    halo.scale.setScalar(38);
    const disc = new THREE.Sprite(new THREE.SpriteMaterial({
      map: sunTex, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    disc.position.copy(sunPos);
    disc.scale.setScalar(11);
    scene.add(halo, disc);
  }

  // --- lighting: hemisphere fill + warm shadow-casting sun ------------------
  // (no full-scene IBL — it flattened contrast and cost per-pixel everywhere;
  //  only the gun gets an env map for sun glints, see props.js)
  // Fill light lifted so the side facing away from the front-right sun no
  // longer reads as near-black: brighter hemisphere + a low ambient floor.
  scene.add(new THREE.HemisphereLight(0xd6e8ec, 0x4a5647, 0.85));
  scene.add(new THREE.AmbientLight(0x9fb2bd, 0.28));
  const sun = new THREE.DirectionalLight(0xfff0d6, 1.75);
  sun.position.copy(SUN_DIR).multiplyScalar(90);
  const sunTarget = new THREE.Object3D();
  scene.add(sun, sunTarget);
  sun.target = sunTarget;

  if (shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    const c = sun.shadow.camera;
    c.left = -SHADOW_HALF; c.right = SHADOW_HALF;
    c.top = SHADOW_HALF; c.bottom = -SHADOW_HALF;
    c.near = 15; c.far = 130;
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.05;
    sun.shadow.intensity = 0.5; // half-strength shadows — cast areas stay legible
  }

  // Keep the shadow frustum centred on the action, snapped to shadow-map
  // texels so the shadows don't shimmer as the player moves.
  const texel = (SHADOW_HALF * 2) / SHADOW_MAP;
  function updateShadowFocus(x, z) {
    const sx = Math.round(x / texel) * texel;
    const sz = Math.round(z / texel) * texel;
    sunTarget.position.set(sx, 0, sz);
    sun.position.set(sx + SUN_DIR.x * 90, SUN_DIR.y * 90, sz + SUN_DIR.z * 90);
  }
  updateShadowFocus(0, 0);

  const colliders = [];

  // --- ground ---------------------------------------------------------------
  // Extends WELL past the forest (trees reach radius MAP.half+70 = 100): the
  // ground half-extent is 180 so every tree stands on grass, and the ground
  // edge (180) sits beyond the fog far-plane (170) where it's fully hazed out —
  // no hard green edge against the sky, just forest fading into overcast.
  const GROUND = MAP.half * 2 + 300; // 360 wide -> half-extent 180
  const groundTex = grassTexture();
  groundTex.repeat.set(62, 62); // keep ~6m/tile density over the larger plane
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND, GROUND),
    new THREE.MeshStandardMaterial({ map: groundTex, color: 0x9fbf85, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = MAP.groundY;
  ground.receiveShadow = true;
  scene.add(ground);
  colliders.push(ground);

  const wood = woodTexture();

  // --- initial dressing: plain wooden blocks over EVERY collision slot ------
  const allBlocks = buildBlocks(scene, wood, MAP.boxes);
  colliders.push(allBlocks);

  // --- boundary fence --------------------------------------------------------
  const fence = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ map: wood, color: 0x9a8a6e, roughness: 1 }),
    4
  );
  {
    const m = new THREE.Matrix4();
    const L = MAP.half * 2, t = 0.35, h = 1.1, H = MAP.half;
    const sides = [
      [0, -H, L + t, t], [0, H, L + t, t],
      [-H, 0, t, L + t], [H, 0, t, L + t],
    ];
    for (let i = 0; i < 4; i++) {
      const [cx, cz, sx, sz] = sides[i];
      m.makeScale(sx, h, sz);
      m.setPosition(cx, h / 2, cz);
      fence.setMatrixAt(i, m);
    }
    fence.instanceMatrix.needsUpdate = true;
  }
  fence.castShadow = true;
  fence.receiveShadow = true;
  scene.add(fence);
  colliders.push(fence);

  // --- billboard grass tufts (complement the 3D undergrowth) ----------------
  {
    const blade = grassBladeTexture();
    const tuftGeo = new THREE.PlaneGeometry(0.9, 0.55);
    tuftGeo.translate(0, 0.27, 0);
    const tuftMat = new THREE.MeshStandardMaterial({
      map: blade, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 1,
    });
    const tufts = scatterInstances(tuftGeo, tuftMat, 500, rng(5150), () => 0.7 + Math.random() * 0, (r) => 0.7 + r() * 0.9);
    scene.add(tufts);
  }

  const world = { colliders, updateShadowFocus };

  // --- async upgrade to the craftpix packs, procedural forest as fallback ---
  enhance(scene, world, allBlocks, wood).catch((err) => {
    console.warn('[assets] scenery load failed — keeping procedural look:', err);
    buildProceduralForest(scene);
  });

  return world;
}

// ===========================================================================
async function enhance(scene, world, allBlocks, wood) {
  const packs = await loadScenery();
  const r = rng(31337);

  // ---- dense forest enclosing the arena: a clearing in the woods -----------
  // Every tree variant, scattered THICK right behind the fence and thinning
  // into the fog. The arena becomes a clearing, not a walled ring with empty
  // space behind it — the fog swallows the far edge so the horizon reads as
  // endless forest. No shadows (a depth pass over ~700 trees kills perf).
  {
    const variants = [
      ...packs.palm.map((e) => ({ e, hMin: 4.5, hMax: 7.5, weight: 3 })),
      ...packs.tree.map((e) => ({ e, hMin: 4.0, hMax: 7.2, weight: 4 })),
    ];
    placeForest(scene, variants, 700, r, MAP.half + 1.5, MAP.half + 70, 1.8);
  }

  // ---- undergrowth inside the arena (cosmetic, never colliding) ------------
  {
    const bushes = packs.shrub.filter((e) => e.name.includes('bush'));
    const grasses = packs.shrub.filter((e) => e.name.includes('grass'));
    const stones = packs.shrub.filter((e) => e.name.includes('stone'));
    scatterInArena(scene, bushes, 85, r, 0.45, 0.95);
    scatterInArena(scene, grasses, 110, r, 0.3, 0.55);
    scatterInArena(scene, stones, 26, r, 0.2, 0.45);
  }

  // ---- props over the crate/pillar slots; walls keep the wooden look -------
  {
    const byName = {};
    for (const e of packs.prop) byName[e.name.replace('.fbx', '')] = e;
    const pillarProps = [byName.Well, byName.Haystack_02, byName.Well, byName.Haystack_02].filter(Boolean);
    const crateProps = [byName.Box, byName.Barrel, byName.Chest, byName.Haystack_01].filter(Boolean);
    if (!crateProps.length) throw new Error('prop pack empty');

    const wallSlots = [];
    let pillarIdx = 0, crateIdx = 0;
    for (const b of MAP.boxes) {
      const isWall = b.hx >= 2.5 || b.hz >= 2.5;
      if (isWall) { wallSlots.push(b); continue; }
      const isPillar = b.h >= 2.8;
      const list = isPillar && pillarProps.length ? pillarProps : crateProps;
      const idx = isPillar ? pillarIdx++ : crateIdx++;
      const entry = list[idx % list.length];

      const s = fitScale(entry, b.hx * 2, b.h, b.hz * 2) * 0.98;
      const mesh = new THREE.Mesh(entry.geo, entry.mat);
      mesh.scale.setScalar(s);
      mesh.position.set(b.cx, 0, b.cz);
      mesh.rotation.y = Math.floor(r() * 4) * (Math.PI / 2); // axis-aligned-ish
      mesh.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      world.colliders.push(mesh);
    }

    // village-ish decor between fence and forest (outside play space)
    const decor = [byName.Stump, byName.Firewood, byName.Trough].filter(Boolean);
    if (decor.length) {
      for (let i = 0; i < 14; i++) {
        const e = decor[i % decor.length];
        const ang = r() * Math.PI * 2;
        const rad = MAP.half + 1.2 + r() * 1.8;
        const s = fitScale(e, 1.4, 0.8, 1.4) * (0.7 + r() * 0.5);
        const mesh = new THREE.Mesh(e.geo, e.mat);
        mesh.scale.setScalar(s);
        mesh.position.set(Math.cos(ang) * rad, 0, Math.sin(ang) * rad);
        mesh.rotation.y = r() * Math.PI * 2;
        mesh.castShadow = true;
        scene.add(mesh);
      }
    }

    // rebuild the block dressing to cover ONLY wall slots
    const wallBlocks = buildBlocks(scene, wood, wallSlots);
    scene.remove(allBlocks);
    const ci = world.colliders.indexOf(allBlocks);
    if (ci !== -1) world.colliders.splice(ci, 1);
    allBlocks.dispose();
    world.colliders.push(wallBlocks);
  }

  console.log('[assets] craftpix scenery active');
}

// ---------------------------------------------------------------------------
function buildBlocks(scene, wood, slots) {
  const mat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.9 });
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, Math.max(1, slots.length));
  const m = new THREE.Matrix4();
  const tint = new THREE.Color();
  const r = rng(9001);
  for (let i = 0; i < slots.length; i++) {
    const b = slots[i];
    m.makeScale(b.hx * 2, b.h, b.hz * 2);
    m.setPosition(b.cx, b.h / 2, b.cz);
    mesh.setMatrixAt(i, m);
    tint.setHSL(0.075 + r() * 0.03, 0.35 + r() * 0.15, 0.5 + r() * 0.16);
    mesh.setColorAt(i, tint);
  }
  mesh.count = slots.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

// Scatter instanced tree variants in an annulus with RADIAL DENSITY FALLOFF
// (thick near radMin, thinning to radMax). densityExp>1 pulls placements inward
// via r()^exp. Two passes: assign a weighted variant + a position per tree,
// then fill each variant's InstancedMesh.
function placeForest(scene, variants, total, r, radMin, radMax, densityExp = 1) {
  const totalWeight = variants.reduce((a, v) => a + v.weight, 0);
  const picks = new Array(total);
  const ang = new Array(total);
  const rad = new Array(total);
  for (let i = 0; i < total; i++) {
    let w = r() * totalWeight, vi = 0;
    while (w > variants[vi].weight) { w -= variants[vi].weight; vi++; }
    picks[i] = vi;
    ang[i] = r() * Math.PI * 2;
    rad[i] = radMin + (radMax - radMin) * Math.pow(r(), densityExp);
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sv = new THREE.Vector3();
  variants.forEach((v, vi) => {
    let count = 0;
    for (let i = 0; i < total; i++) if (picks[i] === vi) count++;
    if (!count) return;
    const inst = new THREE.InstancedMesh(v.e.geo, v.e.mat, count);
    let k = 0;
    for (let i = 0; i < total; i++) {
      if (picks[i] !== vi) continue;
      const h = v.hMin + r() * (v.hMax - v.hMin);
      const s = h / v.e.size.y;
      e.set((r() - 0.5) * 0.05, r() * Math.PI * 2, (r() - 0.5) * 0.05);
      q.setFromEuler(e);
      p.set(Math.cos(ang[i]) * rad[i], 0, Math.sin(ang[i]) * rad[i]);
      sv.setScalar(s);
      m.compose(p, q, sv);
      inst.setMatrixAt(k++, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    // The instances ring the WHOLE arena, but an InstancedMesh frustum-culls by
    // its geometry's bounding sphere (one tree at the origin) — so looking
    // outward from the edge would cull the entire forest. It's always partly
    // on-screen anyway, so just skip culling.
    inst.frustumCulled = false;
    scene.add(inst); // no castShadow: hundreds of trees in the depth pass kill perf
  });
}

// Scatter instanced variants inside the arena, avoiding collision slots.
function scatterInArena(scene, entries, total, r, hMin, hMax) {
  if (!entries.length) return;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sv = new THREE.Vector3();
  const per = Math.ceil(total / entries.length);
  for (const entry of entries) {
    const inst = new THREE.InstancedMesh(entry.geo, entry.mat, per);
    let placed = 0, guard = 0;
    while (placed < per && guard++ < per * 40) {
      const x = (r() * 2 - 1) * (MAP.half - 1);
      const z = (r() * 2 - 1) * (MAP.half - 1);
      if (insideBox(x, z, 0.6)) continue;
      const h = hMin + r() * (hMax - hMin);
      e.set(0, r() * Math.PI * 2, 0);
      q.setFromEuler(e);
      p.set(x, 0, z);
      sv.setScalar(h / entry.size.y);
      m.compose(p, q, sv);
      inst.setMatrixAt(placed++, m);
    }
    inst.count = placed;
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
  }
}

// Generic billboard scatter used by the base layer.
function scatterInstances(geo, mat, total, r, _unused, scaleFn) {
  const inst = new THREE.InstancedMesh(geo, mat, total);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sv = new THREE.Vector3();
  let placed = 0, guard = 0;
  while (placed < total && guard++ < total * 30) {
    const x = (r() * 2 - 1) * (MAP.half - 1);
    const z = (r() * 2 - 1) * (MAP.half - 1);
    if (insideBox(x, z, 0.5)) continue;
    e.set(0, r() * Math.PI, 0);
    q.setFromEuler(e);
    const k = scaleFn(r);
    sv.set(k, k, k);
    p.set(x, 0, z);
    m.compose(p, q, sv);
    inst.setMatrixAt(placed++, m);
  }
  inst.count = placed;
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}

// Fallback forest (pre-assets look) if the packs fail to load.
function buildProceduralForest(scene) {
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 3.2, 6);
  trunkGeo.translate(0, 1.6, 0);
  const canopyGeo = new THREE.IcosahedronGeometry(1.9, 1);
  canopyGeo.translate(0, 4.1, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4f33, roughness: 1 });
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x3f7040, roughness: 1, flatShading: true });
  const COUNT = 110;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, COUNT);
  const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, COUNT);
  const m = new THREE.Matrix4();
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const tint = new THREE.Color();
  const r = rng(2024);
  for (let i = 0; i < COUNT; i++) {
    const ang = r() * Math.PI * 2;
    const rad = MAP.half + 4 + r() * 22;
    const k = 0.8 + r() * 1.3;
    e.set(0, r() * Math.PI * 2, (r() - 0.5) * 0.08);
    q.setFromEuler(e);
    s.set(k, k * (0.85 + r() * 0.5), k);
    p.set(Math.cos(ang) * rad, 0, Math.sin(ang) * rad);
    m.compose(p, q, s);
    trunks.setMatrixAt(i, m);
    canopies.setMatrixAt(i, m);
    tint.setHSL(0.30 + r() * 0.06, 0.42 + r() * 0.2, 0.32 + r() * 0.14);
    canopies.setColorAt(i, tint);
  }
  trunks.instanceMatrix.needsUpdate = true;
  canopies.instanceMatrix.needsUpdate = true;
  canopies.instanceColor.needsUpdate = true;
  scene.add(trunks, canopies);
}

function insideBox(x, z, pad) {
  for (const b of MAP.boxes) {
    if (x > b.cx - b.hx - pad && x < b.cx + b.hx + pad &&
        z > b.cz - b.hz - pad && z < b.cz + b.hz + pad) return true;
  }
  return false;
}
