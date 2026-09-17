// scripts/inspect-fbx.mjs
// Headless sanity check for the craftpix FBX assets: parses each file with the
// SAME three.js FBXLoader the browser uses (DOM stubbed just enough for the
// loader), and prints mesh count / bounding box / skinning info. Proves the
// files are loadable before the client ever touches them, and provides real
// dimensions for scale normalization.
//
//   node scripts/inspect-fbx.mjs                 # inspect the curated set
//   node scripts/inspect-fbx.mjs path/to/x.fbx   # inspect specific files

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- minimal DOM stubs so FBXLoader's texture path doesn't explode ----------
const fakeElement = () => ({
  style: {}, addEventListener() {}, removeEventListener() {},
  setAttribute() {}, getContext: () => null,
});
globalThis.document = globalThis.document || {
  createElementNS: fakeElement,
  createElement: fakeElement,
};
globalThis.self = globalThis.self || globalThis;
globalThis.window = globalThis.window || globalThis; // FBX embedded textures use window.URL

const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const CURATED = [
  'assets/craftpix/tropical-palm-tree/Fbx/Tree_Tropic_001.fbx',
  'assets/craftpix/tropical-palm-tree/Fbx/Tree_Tropic_004.fbx',
  'assets/craftpix/tropical-palm-tree/Fbx/Tree_Tropic_008.fbx',
  'assets/craftpix/tropical-palm-tree/Fbx/Tree_Tropic_012.fbx',
  'assets/craftpix/tropical-palm-tree/Fbx/Tree_Tropic_016.fbx',
  'assets/craftpix/tree/Fbx/Tree_temp_climate_003.FBX',
  'assets/craftpix/tree/Fbx/Tree_temp_climate_007.FBX',
  'assets/craftpix/tree/Fbx/Tree_temp_climate_012.FBX',
  'assets/craftpix/tree/Fbx/Tree_temp_climate_018.FBX',
  'assets/craftpix/shrubs-flowers-and-mushrooms/fbx/_bush_1.fbx',
  'assets/craftpix/shrubs-flowers-and-mushrooms/fbx/_bush_2.fbx',
  'assets/craftpix/shrubs-flowers-and-mushrooms/fbx/_bush_3.fbx',
  'assets/craftpix/shrubs-flowers-and-mushrooms/fbx/_bush_4.fbx',
  'assets/craftpix/shrubs-flowers-and-mushrooms/fbx/_grass_1.fbx',
  'assets/craftpix/shrubs-flowers-and-mushrooms/fbx/_grass_2.fbx',
  'assets/craftpix/shrubs-flowers-and-mushrooms/fbx/_stones_1.fbx',
  'assets/craftpix/shrubs-flowers-and-mushrooms/fbx/_stone_2.fbx',
  'assets/craftpix/shrubs-flowers-and-mushrooms/fbx/_stone_3.fbx',
  'assets/craftpix/medieval-props/Fbx/Barrel.fbx',
  'assets/craftpix/medieval-props/Fbx/Box.fbx',
  'assets/craftpix/medieval-props/Fbx/Chest.fbx',
  'assets/craftpix/medieval-props/Fbx/Haystack_01.fbx',
  'assets/craftpix/medieval-props/Fbx/Haystack_02.fbx',
  'assets/craftpix/medieval-props/Fbx/Well.fbx',
  'assets/craftpix/medieval-props/Fbx/Stump.fbx',
  'assets/craftpix/medieval-props/Fbx/Firewood.fbx',
  'assets/craftpix/medieval-props/Fbx/Trough.fbx',
  'assets/craftpix/medieval/fbx/people_unity/peasant_1.fbx',
];

const files = process.argv.slice(2).length ? process.argv.slice(2) : CURATED;
const loader = new FBXLoader();
let failures = 0;

for (const rel of files) {
  const file = path.isAbsolute(rel) ? rel : path.join(root, rel);
  const short = path.relative(root, file);
  try {
    const buf = fs.readFileSync(file);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const group = loader.parse(ab, path.dirname(file) + '/');

    let meshes = 0, verts = 0, skinned = 0, materials = new Set();
    group.updateMatrixWorld(true);
    const bbox = new THREE.Box3();
    group.traverse((o) => {
      if (o.isMesh) {
        meshes++;
        verts += o.geometry.attributes.position.count;
        if (o.isSkinnedMesh) skinned++;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => materials.add(m.name || m.uuid.slice(0, 6)));
        bbox.expandByObject(o);
      }
    });
    const size = bbox.getSize(new THREE.Vector3());
    console.log(
      `OK   ${short}` +
      `  meshes=${meshes} verts=${verts} skinned=${skinned}` +
      `  size=${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)}` +
      `  mats=[${[...materials].slice(0, 4).join(',')}]`
    );
  } catch (e) {
    failures++;
    console.log(`FAIL ${short}  ${e.message.slice(0, 120)}`);
  }
}

console.log(failures ? `\n${failures} FILE(S) FAILED` : '\nALL FILES PARSE OK');
process.exit(failures ? 1 : 0);
