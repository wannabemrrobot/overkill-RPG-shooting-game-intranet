// public/src/game/healthkits.js
// Renders the server's health-kit pickups: a floating red-cross med-kit that
// bobs, spins, and casts a soft green ground glow so it's easy to spot. The
// server owns spawn/pickup (see ArenaRoom.updateKits); this just mirrors the
// synced `state.kits` and animates them.

import * as THREE from 'three';

export class HealthKits {
  constructor(scene) {
    this.scene = scene;
    this.map = new Map(); // kitId -> { group, box }

    // shared geo/materials (one set for every kit)
    this._boxGeo = new THREE.BoxGeometry(0.34, 0.24, 0.26);
    this._boxMat = new THREE.MeshStandardMaterial({
      color: 0xf3f4f5, roughness: 0.55, metalness: 0.05,
      emissive: 0x203020, emissiveIntensity: 0.35,
    });
    this._crossH = new THREE.BoxGeometry(0.22, 0.055, 0.07);
    this._crossV = new THREE.BoxGeometry(0.07, 0.055, 0.22);
    this._crossMat = new THREE.MeshStandardMaterial({
      color: 0xff3b30, emissive: 0xff3b30, emissiveIntensity: 0.6, roughness: 0.4,
    });
    this._discMat = new THREE.MeshBasicMaterial({
      color: 0x3bff8c, transparent: true, opacity: 0.16, depthWrite: false,
    });
    this._discGeo = new THREE.CircleGeometry(0.62, 22);
  }

  _make() {
    const group = new THREE.Group();

    // bobbing/rotating body
    const box = new THREE.Group();
    const body = new THREE.Mesh(this._boxGeo, this._boxMat);
    body.castShadow = true;
    const ch = new THREE.Mesh(this._crossH, this._crossMat); ch.position.y = 0.145;
    const cv = new THREE.Mesh(this._crossV, this._crossMat); cv.position.y = 0.145;
    box.add(body, ch, cv);
    box.position.y = 0.55;
    group.add(box);

    // green ground glow (stays on the floor)
    const disc = new THREE.Mesh(this._discGeo, this._discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.02;
    group.add(disc);

    this.scene.add(group);
    return { group, box };
  }

  // Mirror state.kits: create meshes, position them, show only active kits.
  sync(state) {
    if (!state || !state.kits) return;
    const seen = new Set();
    state.kits.forEach((kit, id) => {
      seen.add(id);
      let e = this.map.get(id);
      if (!e) { e = this._make(); this.map.set(id, e); }
      e.group.visible = !!kit.active;
      e.group.position.x = kit.x;
      e.group.position.z = kit.z;
    });
    for (const [id, e] of this.map) {
      if (!seen.has(id)) { this.scene.remove(e.group); this.map.delete(id); }
    }
  }

  update(dt, nowMs) {
    for (const e of this.map.values()) {
      if (!e.group.visible) continue;
      e.box.rotation.y += dt * 1.3;
      e.box.position.y = 0.55 + Math.sin(nowMs * 0.003 + e.group.position.x) * 0.08;
    }
  }

  disposeAll() {
    for (const e of this.map.values()) this.scene.remove(e.group);
    this.map.clear();
  }
}
