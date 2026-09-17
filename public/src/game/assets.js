// public/src/game/assets.js
// Loads the craftpix FBX packs (assets/craftpix/*) into instancing-ready
// geometry + shared materials.
//
// Pipeline per model: FBXLoader -> take its (single) mesh -> bake the node's
// world transform into the geometry -> recentre on XZ and drop min-Y to 0
// (so "position at y=0" means "standing on the ground") -> record the native
// size for scale-to-fit at placement time (packs are authored in centimetres;
// bbox-fit makes units irrelevant).
//
// Failure policy: individual files may fail (missing/corrupt) — variants are
// skipped; a pack with ZERO surviving variants rejects the whole load and the
// world falls back to procedural scenery. Nothing user-facing ever breaks.

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const CP = '/assets/craftpix';

const PACKS = {
  // Reuse EVERY tree asset in the packs (all 20 tropical + all 21 temperate).
  // Loads are concurrent + failure-tolerant (a bad variant is skipped), and
  // each surviving variant becomes one instanced mesh, so the forest has real
  // silhouette variety without extra draw-call cost per tree.
  palm: {
    tex: `${CP}/tropical-palm-tree/Textures/T_Tree_tropical.png`,
    dir: `${CP}/tropical-palm-tree/Fbx/`,
    files: Array.from({ length: 20 }, (_, i) => `Tree_Tropic_${String(i + 1).padStart(3, '0')}.fbx`),
  },
  tree: {
    tex: `${CP}/tree/Textures/T_Trees_temp_climate.png`,
    dir: `${CP}/tree/Fbx/`,
    files: Array.from({ length: 21 }, (_, i) => `Tree_temp_climate_${String(i + 1).padStart(3, '0')}.FBX`),
  },
  shrub: {
    tex: `${CP}/shrubs-flowers-and-mushrooms/texture/Ekfs_bush_map.png`,
    dir: `${CP}/shrubs-flowers-and-mushrooms/fbx/`,
    files: ['_bush_1.fbx', '_bush_2.fbx', '_bush_3.fbx', '_bush_4.fbx', '_grass_1.fbx', '_grass_2.fbx', '_stones_1.fbx', '_stone_2.fbx', '_stone_3.fbx'],
  },
  prop: {
    tex: null, // this pack carries flat material colours inside the FBX
    dir: `${CP}/medieval-props/Fbx/`,
    files: ['Barrel.fbx', 'Box.fbx', 'Chest.fbx', 'Haystack_01.fbx', 'Haystack_02.fbx', 'Well.fbx', 'Stump.fbx', 'Firewood.fbx', 'Trough.fbx'],
  },
};

// entry: { name, geo, size:Vector3, mat }
export async function loadScenery() {
  const fbx = new FBXLoader();
  const texLoader = new THREE.TextureLoader();
  const out = {};

  await Promise.all(Object.entries(PACKS).map(async ([key, pack]) => {
    let packMat = null;
    if (pack.tex) {
      const tex = await texLoader.loadAsync(pack.tex);
      tex.colorSpace = THREE.SRGBColorSpace;
      packMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
    }

    const settled = await Promise.allSettled(pack.files.map(async (file) => {
      const group = await fbx.loadAsync(pack.dir + file);
      return toEntry(file, group, packMat);
    }));

    const entries = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) entries.push(s.value);
      else console.warn(`[assets] skipping ${key} variant:`, s.reason && s.reason.message);
    }
    if (!entries.length) throw new Error(`asset pack "${key}" produced no usable variants`);
    out[key] = entries;
  }));

  return out;
}

function toEntry(file, group, packMat) {
  let mesh = null;
  group.updateMatrixWorld(true);
  group.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
  if (!mesh) throw new Error(`${file}: no mesh inside FBX`);

  // Bake node transform into the geometry so instancing matrices are pure
  // placement (no per-variant fixup at draw time).
  const geo = mesh.geometry.clone();
  geo.applyMatrix4(mesh.matrixWorld);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const size = bb.getSize(new THREE.Vector3());
  const cx = (bb.min.x + bb.max.x) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  geo.translate(-cx, -bb.min.y, -cz);   // feet at y=0, centred on XZ
  geo.computeVertexNormals();

  let mat = packMat;
  if (!mat) {
    // Untextured pack: carry the FBX's flat colour over to our PBR material.
    const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const c = (src && src.color) ? src.color.clone() : new THREE.Color(0x8a6a44);
    if (c.r + c.g + c.b > 2.7) c.set(0x8a6a44); // white/unset -> aged wood
    mat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 });
  }

  return { name: file, geo, size, mat };
}

// Uniform scale that fits an entry inside a box of (sx, sy, sz) metres.
// Pass Infinity for axes you don't care about.
export function fitScale(entry, sx, sy, sz) {
  return Math.min(sx / entry.size.x, sy / entry.size.y, sz / entry.size.z);
}
