// public/src/game/props.js
// Small rigid props loaded from assets/props/*.glb:
//   - gun.glb   -> the rifle every character holds (replaces the box rifle)
//   - grave.glb -> the death marker placed where a player died
//
// Both are optional: if a file is missing or fails to parse the game keeps
// its procedural stand-ins. Orientation facts baked below were MEASURED
// offline (scripts/… probes), not guessed:
//   gun.glb: barrel points +X (slimmer end) -> rotated so the muzzle faces -Z
//   grave.glb: mound + slab diorama -> normalized by longest side, laid flat

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class PropLibrary {
  // weaponEnv: PMREM environment texture — sun/sky glints on the gun metal
  constructor({ weaponEnv = null } = {}) {
    this.weaponEnv = weaponEnv;
    this.gun = null;    // { template, length }
    this.grave = null;  // { template }
    this.ammoBox = null;    // resupply crate
    this.bullets = null;    // scattered loose rounds
    this.healthpack = null; // instant full-heal medkit
    this.painkiller = null; // regen-over-time energy can
    this.ready = this._load();
  }

  async _load() {
    const loader = new GLTFLoader();

    try {
      const gltf = await loader.loadAsync('/assets/props/gun.glb');
      const inner = gltf.scene;
      inner.rotation.y = Math.PI / 2; // +X (muzzle) -> -Z (our forward)
      const wrap = new THREE.Group();
      wrap.add(inner);
      // recentre on the grip area so hand mounting math stays simple
      const box = new THREE.Box3().setFromObject(wrap);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      inner.position.sub(center);
      wrap.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (this.weaponEnv && 'envMap' in m) {
            m.envMap = this.weaponEnv;
            m.envMapIntensity = 0.9;
            m.needsUpdate = true;
          }
        }
      });
      this.gun = { template: wrap, length: Math.max(size.z, 0.01) };
    } catch (e) {
      console.warn('[props] gun.glb unavailable — procedural rifle kept:', e.message);
    }

    try {
      const gltf = await loader.loadAsync('/assets/props/grave.glb');
      const inner = gltf.scene;
      const wrap = new THREE.Group();
      wrap.add(inner);
      const box = new THREE.Box3().setFromObject(wrap);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = 1.5 / Math.max(size.x, size.y, size.z, 0.01); // longest side = 1.5m
      inner.position.set(-center.x, -box.min.y, -center.z);
      wrap.scale.setScalar(scale);
      wrap.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.grave = { template: wrap };
    } catch (e) {
      console.warn('[props] grave.glb unavailable — corpses stay:', e.message);
    }

    // Generic pickup loader: centre on XZ, sit on the ground (min-Y = 0), scale
    // so the longest dimension == targetSize metres. Applies the sun env map to
    // metallic materials for a bit of shine.
    const loadModel = async (file, targetSize) => {
      const gltf = await loader.loadAsync(file);
      const inner = gltf.scene;
      const wrap = new THREE.Group();
      wrap.add(inner);
      const box = new THREE.Box3().setFromObject(wrap);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const longest = Math.max(size.x, size.y, size.z, 1e-4);
      inner.position.set(-center.x, -box.min.y, -center.z);
      wrap.scale.setScalar(targetSize / longest);
      wrap.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (this.weaponEnv && m && 'envMap' in m) { m.envMap = this.weaponEnv; m.envMapIntensity = 0.8; m.needsUpdate = true; }
        }
      });
      return wrap;
    };

    try { this.ammoBox = await loadModel('/assets/props/ammo_box.glb', 0.5); }
    catch (e) { console.warn('[props] ammo_box.glb:', e.message); }

    try { this.bullets = await loadModel('/assets/props/ammo_bullets.glb', 0.3); }
    catch (e) { console.warn('[props] ammo_bullets.glb:', e.message); }

    // painkiller = energy can (regen-over-time)
    try { this.painkiller = await loadModel('/assets/props/monster_can.glb', 0.26); }
    catch (e) { console.warn('[props] monster_can.glb:', e.message); }

    // healthpack: the medkit's pbrSpecularGlossiness materials don't load in
    // three r160, so give it a clean red medical-case look with a white cross.
    try {
      const mk = await loadModel('/assets/props/health_kits.glb', 0.5);
      mk.traverse((o) => {
        if (o.isMesh) o.material = new THREE.MeshStandardMaterial({
          color: 0xcf2b22, roughness: 0.5, metalness: 0.1, emissive: 0x3a0603, emissiveIntensity: 0.4,
        });
      });
      // setFromObject is WORLD size (mk is already scaled by S); the cross bars
      // become CHILDREN of the S-scaled group, so build them in LOCAL units
      // (world / S) or they'd be scaled by S a second time (a ~2mm speck).
      const world = new THREE.Box3().setFromObject(mk).getSize(new THREE.Vector3());
      const S = mk.scale.x || 1;
      const barLW = Math.min(world.x, world.z) * 0.66; // world length of a bar
      const bl = barLW / S, bw = (barLW * 0.32) / S, bt = 0.03 / S; // local dims
      const y = (world.y + 0.002) / S;                 // local y at the case lid
      const crossMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.4, roughness: 0.4 });
      const h1 = new THREE.Mesh(new THREE.BoxGeometry(bl, bt, bw), crossMat);
      const v1 = new THREE.Mesh(new THREE.BoxGeometry(bw, bt, bl), crossMat);
      h1.position.y = y; v1.position.y = y;
      mk.add(h1, v1);
      this.healthpack = mk;
    } catch (e) { console.warn('[props] health_kits.glb:', e.message); }
  }

  makeAmmoBox() { return this.ammoBox ? this.ammoBox.clone(true) : null; }
  makeBullets() { return this.bullets ? this.bullets.clone(true) : null; }
  makeHealthpack() { return this.healthpack ? this.healthpack.clone(true) : null; }
  makePainkiller() { return this.painkiller ? this.painkiller.clone(true) : null; }

  // A gun instance scaled to `targetLen` metres at world scale 1.
  makeGun(targetLen = 0.72) {
    if (!this.gun) return null;
    const g = this.gun.template.clone(true);
    g.scale.setScalar(targetLen / this.gun.length);
    return g;
  }

  makeGrave() {
    if (!this.grave) return null;
    return this.grave.template.clone(true);
  }
}
