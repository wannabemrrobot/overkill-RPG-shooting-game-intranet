// public/src/game/pickups.js
// World pickups & resupply, rendered from the authoritative server:
//   - health kits (synced): 'pack' = red medkit (instant full heal),
//     'pain' = energy can (regen-over-time). Both float, spin, and cast a
//     coloured ground glow. Server owns spawn/pickup (ArenaRoom.updateKits).
//   - ammo stations (static): a resupply table at each spawn end with an ammo
//     crate + loose bullets scattered on the table and the ground. Standing
//     near one tops your bag up (server side); this just builds the scene dress.

import * as THREE from 'three';
import { AMMO_STATIONS } from '/shared/map.js';

export class Pickups {
  constructor(scene, props) {
    this.scene = scene;
    this.props = props;
    this.healthMap = new Map(); // kitId -> { group, inner, type }
    this.stationsBuilt = false;
    this.ready = false; // set once the prop GLBs have loaded (buildStations)

    this._discGeo = new THREE.CircleGeometry(0.62, 22);
    this._woodMat = new THREE.MeshStandardMaterial({ color: 0x6a4a2f, roughness: 0.85, metalness: 0.05 });
    this._legMat = new THREE.MeshStandardMaterial({ color: 0x4e3620, roughness: 0.9 });
  }

  // ---- ammo resupply stations (built once, after props load) ---------------
  buildStations() {
    if (this.stationsBuilt) return;
    for (const st of AMMO_STATIONS) {
      const g = new THREE.Group();
      g.position.set(st.x, 0, st.z);
      g.rotation.y = st.yaw || 0;

      // table: a plank top on four legs
      const topH = 0.78, topW = 1.5, topD = 0.8, th = 0.1;
      const top = new THREE.Mesh(new THREE.BoxGeometry(topW, th, topD), this._woodMat);
      top.position.y = topH; top.castShadow = top.receiveShadow = true;
      g.add(top);
      for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, topH, 0.1), this._legMat);
        leg.position.set(lx * (topW / 2 - 0.1), topH / 2, lz * (topD / 2 - 0.1));
        leg.castShadow = true;
        g.add(leg);
      }

      // ammo crate on the table
      const box = this.props.makeAmmoBox && this.props.makeAmmoBox();
      if (box) { box.position.set(-0.35, topH + th / 2, 0); box.rotation.y = 0.3; g.add(box); }

      // loose bullets: piled on the table, spilled on the ground around it
      for (let i = 0; i < 22; i++) {
        const b = this.props.makeBullets && this.props.makeBullets();
        if (!b) break;
        const onTable = i < 14;
        const rx = (Math.random() * 2 - 1) * (onTable ? topW * 0.4 : 1.7);
        const rz = (Math.random() * 2 - 1) * (onTable ? topD * 0.32 : 1.1) + (onTable ? 0 : 0.75);
        b.position.set(onTable ? rx + 0.35 : rx, onTable ? topH + th / 2 : 0.0, rz);
        b.rotation.set((Math.random() - 0.5) * 0.5, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.7);
        b.scale.multiplyScalar(0.65 + Math.random() * 0.8);
        g.add(b);
      }

      // faint amber "resupply" glow on the ground
      const disc = new THREE.Mesh(this._discGeo, new THREE.MeshBasicMaterial({
        color: 0xffca66, transparent: true, opacity: 0.13, depthWrite: false,
      }));
      disc.rotation.x = -Math.PI / 2; disc.position.y = 0.03; disc.scale.setScalar(3.4);
      g.add(disc);

      this.scene.add(g);
    }
    this.stationsBuilt = true;
    this.ready = true; // props are loaded — health meshes can use the real models now
  }

  // ---- health kits (synced) ------------------------------------------------
  _makeHealth(type) {
    const group = new THREE.Group();
    const inner = new THREE.Group();
    let model = type === 'pain'
      ? (this.props.makePainkiller && this.props.makePainkiller())
      : (this.props.makeHealthpack && this.props.makeHealthpack());
    if (!model) {
      model = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.24, 0.24),
        new THREE.MeshStandardMaterial({ color: type === 'pain' ? 0x39b54a : 0xf3f4f5, roughness: 0.5 })
      );
    }
    model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    inner.add(model);
    inner.position.y = 0.5;
    group.add(inner);

    const disc = new THREE.Mesh(this._discGeo, new THREE.MeshBasicMaterial({
      color: type === 'pain' ? 0x39e0a0 : 0x3bff8c, transparent: true, opacity: 0.18, depthWrite: false,
    }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = 0.02;
    group.add(disc);

    this.scene.add(group);
    return { group, inner, type };
  }

  syncHealth(state) {
    if (!state || !state.kits || !this.ready) return; // wait for the prop models
    const seen = new Set();
    state.kits.forEach((kit, id) => {
      seen.add(id);
      let e = this.healthMap.get(id);
      if (!e) { e = this._makeHealth(kit.type); this.healthMap.set(id, e); }
      e.group.visible = !!kit.active;
      e.group.position.set(kit.x, 0, kit.z);
    });
    for (const [id, e] of this.healthMap) {
      if (!seen.has(id)) { this.scene.remove(e.group); this.healthMap.delete(id); }
    }
  }

  update(dt, nowMs) {
    for (const e of this.healthMap.values()) {
      if (!e.group.visible) continue;
      e.inner.rotation.y += dt * 1.3;
      e.inner.position.y = 0.5 + Math.sin(nowMs * 0.003 + e.group.position.x) * 0.07;
    }
  }

  disposeAll() {
    for (const e of this.healthMap.values()) this.scene.remove(e.group);
    this.healthMap.clear();
  }
}
