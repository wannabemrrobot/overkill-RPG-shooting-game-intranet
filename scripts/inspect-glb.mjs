// scripts/inspect-glb.mjs
// Container-level GLB inspector: validates the binary layout and reports what
// the client's avatar system cares about — skinned or not, animation clip
// names (drives the state->clip mapping), triangle counts (perf budget),
// texture count, and rough node names (bone naming scheme detection).
// Pure Node, no three.js needed: GLB = 12-byte header + JSON chunk + BIN chunk.
//
//   node scripts/inspect-glb.mjs                       # everything in assets/characters
//   node scripts/inspect-glb.mjs path/to/model.glb ...

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let files = process.argv.slice(2);
if (!files.length) {
  const dir = path.join(root, 'assets/characters');
  files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.glb')).map((f) => path.join(dir, f))
    : [];
}

let failed = 0;

for (const file of files) {
  const rel = path.relative(root, file);
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (bad magic)');
    const version = buf.readUInt32LE(4);
    const total = buf.readUInt32LE(8);
    if (total !== buf.length) throw new Error(`length mismatch: header ${total} vs file ${buf.length}`);
    const jsonLen = buf.readUInt32LE(12);
    if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first chunk is not JSON');
    const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

    const meshes = gltf.meshes || [];
    const skins = gltf.skins || [];
    const anims = gltf.animations || [];
    const images = gltf.images || [];
    const accessors = gltf.accessors || [];
    const nodes = gltf.nodes || [];

    let tris = 0;
    for (const mesh of meshes) {
      for (const prim of mesh.primitives || []) {
        if (prim.indices !== undefined) tris += (accessors[prim.indices]?.count || 0) / 3;
        else if (prim.attributes?.POSITION !== undefined) tris += (accessors[prim.attributes.POSITION]?.count || 0) / 3;
      }
    }

    const clipNames = anims.map((a, i) => a.name || `clip_${i}`);
    const boneish = nodes.filter((n) => /hand|arm|spine|head|hips|leg/i.test(n.name || '')).slice(0, 4).map((n) => n.name);
    const ext = (gltf.extensionsRequired || []).join(',');

    console.log(`OK   ${rel}`);
    console.log(`     glb v${version} · ${Math.round(buf.length / 1024)}KB · meshes=${meshes.length} tris=${Math.round(tris)} skins=${skins.length} images=${images.length}` +
      (ext ? ` · REQUIRES EXT: ${ext}` : ''));
    console.log(`     clips(${anims.length}): ${clipNames.slice(0, 8).join(', ') || '(none)'}`);
    console.log(`     bones sample: ${boneish.join(', ') || '(no humanoid-named nodes)'}`);
    if (ext && /draco|meshopt|basisu/i.test(ext)) {
      console.log('     WARNING: needs a decoder we have not vendored');
      failed++;
    }
  } catch (e) {
    failed++;
    console.log(`FAIL ${rel}  ${e.message}`);
  }
}

console.log(failed ? `\n${failed} PROBLEM(S)` : '\nALL GLB FILES LOOK USABLE');
process.exit(failed ? 1 : 0);
