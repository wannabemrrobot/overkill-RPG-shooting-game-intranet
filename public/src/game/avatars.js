// public/src/game/avatars.js
// Character avatar system.
//
// AvatarFactory loads every .glb listed by /assets/characters/manifest.json
// once at boot (template scene + clips + normalization), then stamps out
// per-player instances via SkeletonUtils.clone (required for skinned meshes).
// 'recruit' is the built-in procedural rig (character.js); any GLB that is
// missing or fails to parse silently falls back to it.
//
// Uniform behaviour across wildly different rigs comes from rigbind.js:
// bones are found by fuzzy matching, raised rest arms are auto-lowered, and
// every swing axis is CALIBRATED by measurement (rotate the bone, check the
// foot/hand actually moves model-forward) — so all characters walk, aim and
// die with the same visual language. glTF models face +Z while our engine
// convention is -Z, so the model is flipped 180° inside its root.
//
// Characters are COSMETIC ONLY: the server hitboxes (shared/combat.js) are
// identical for everyone regardless of the model's real silhouette.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { MOVE } from '/shared/constants.js';
import { Character, makeNameSprite } from './character.js';
import { ClipAvatar } from './clipavatar.js';
import { bindRig, measureAvatar, validateAssembly, attachMuzzle } from './rigbind.js';

const TARGET_HEIGHT = 1.75; // metres — all avatars normalized to this

// Kill the root motion in a mixamo clip: pin the hips' X/Z to frame 0 (the
// netcode owns world position; un-stripped clips walk the model away from
// its player). Y is kept — that's the run bob and the death fall.
// Visual bind-pose bounds of the skinned mesh: the true sole height (minY) and
// the XZ centre. Used to place every character IDENTICALLY (grounded + centred
// on the body) regardless of how its skeleton is offset — the bone cloud put
// some characters floating and at slightly different depths. Returns Infinity
// fields if not measurable.
function skinnedBounds(root) {
  root.updateWorldMatrix(true, true);
  const v = new THREE.Vector3();
  let minY = Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    if (o.skeleton && o.skeleton.update) o.skeleton.update();
    const pos = o.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 500));
    for (let i = 0; i < pos.count; i += step) {
      o.getVertexPosition(i, v);      // applies bone skinning
      v.applyMatrix4(o.matrixWorld);
      if (v.y < minY) minY = v.y;
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    }
  });
  return { minY, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}

function stripRootXZ(clip) {
  for (const tr of clip.tracks) {
    if (!/hips\.position/i.test(tr.name)) continue;
    const v = tr.values;
    // Record how far the hips travel in XZ (clip units) BEFORE pinning them, so
    // the avatar can match playback rate to ground speed (no foot sliding).
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      if (v[i] < minX) minX = v[i]; if (v[i] > maxX) maxX = v[i];
      if (v[i + 2] < minZ) minZ = v[i + 2]; if (v[i + 2] > maxZ) maxZ = v[i + 2];
    }
    clip.userData = clip.userData || {};
    clip.userData.travelUnits = Math.hypot(maxX - minX, maxZ - minZ);
    const x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
  }
  return clip;
}

export class AvatarFactory {
  // props: PropLibrary (gun/grave models) — shared by every avatar
  // blobShadows: true when dynamic shadow maps are off (cheap grounding)
  constructor(scene, props = null, { blobShadows = false } = {}) {
    this.scene = scene;
    this.props = props;
    this.blobShadows = blobShadows;
    this.templates = new Map(); // id -> {root, clips, scale, offX/offY/offZ}
    // The picker lists only real, loadable characters (no procedural 'recruit').
    // The procedural Character remains an INTERNAL fallback for any id whose
    // model failed to load — it's just never offered as a choice.
    this.list = [];
    this.ready = this._load();
  }

  async _load() {
    const gltfLoader = new GLTFLoader();
    const fbxLoader = new FBXLoader();

    const loadModel = async (file) => {
      if (/\.fbx$/i.test(file)) {
        const grp = await fbxLoader.loadAsync(file);
        return { root: grp, animations: grp.animations || [] };
      }
      const gltf = await gltfLoader.loadAsync(file);
      return { root: gltf.scene, animations: gltf.animations || [] };
    };

    // ---- shared animation clip library (mixamo FBX, one per file) ----------
    this.animLib = new Map();
    const animsP = (async () => {
      try {
        const m = await (await fetch('/assets/anims/manifest.json')).json();
        await Promise.all((m.anims || []).map(async (a) => {
          try {
            const grp = await fbxLoader.loadAsync(a.file);
            const clip = (grp.animations || [])[0];
            if (!clip) throw new Error('no clip inside');
            clip.name = a.key;
            this.animLib.set(a.key, stripRootXZ(clip));
          } catch (e) {
            console.warn(`[avatars] anim "${a.key}" failed:`, e.message);
          }
        }));
        if (this.animLib.size) {
          console.log(`[avatars] animation library: ${[...this.animLib.keys()].join(', ')}`);
        }
      } catch { /* no anims — procedural animation everywhere */ }
    })();

    // ---- characters ----------------------------------------------------------
    let manifest;
    try {
      manifest = await (await fetch('/assets/characters/manifest.json')).json();
    } catch (e) {
      console.warn('[avatars] no character manifest — recruit only:', e.message);
      await animsP;
      return;
    }

    await Promise.all((manifest.characters || []).map(async (c) => {
      try {
        const { root, animations } = await loadModel(c.file);

        // validity gate: reject gear-set/flatlay assets that never assemble
        // onto their skeleton (they render as a pile of equipment, not a
        // character). Rejected ids fall back to the procedural recruit.
        const assembly = validateAssembly(root);
        if (!assembly.ok) {
          throw new Error(`not a wearable character — only ${(assembly.fraction * 100).toFixed(0)}% of its skin sits on the skeleton (gear-set/flatlay asset)`);
        }

        // Scale to TARGET_HEIGHT from the skeleton height, but PLACE the model
        // (ground + centre) by the VISUAL MESH bounds — the bone cloud floated
        // some characters, sank others, and sat them at slightly different
        // depths. validateAssembly above has gated out flatlay assets, so the
        // mesh bounds are trustworthy here.
        const m = measureAvatar(root);
        const scale = TARGET_HEIGHT / m.height;
        const b = skinnedBounds(root);
        const boneNames = new Set();
        root.traverse((o) => { if (o.isBone) boneNames.add(o.name); });
        this.templates.set(c.id, {
          root,
          clips: animations,
          boneNames,
          scale,
          offX: -(Number.isFinite(b.cx) ? b.cx : m.centerX) * scale,
          offY: -(Number.isFinite(b.minY) ? b.minY : m.minY) * scale,
          offZ: -(Number.isFinite(b.cz) ? b.cz : m.centerZ) * scale,
        });
        this.list.push({ id: c.id, label: c.label, gender: c.gender });
      } catch (e) {
        console.warn(`[avatars] failed to load "${c.id}" — falling back to recruit:`, e.message);
      }
    }));

    await animsP;

    // ---- which templates can use the clip library? --------------------------
    // A template is clip-driven when >=90% of the first clip's tracks bind to
    // bones that exist on its skeleton (mixamo-family naming).
    const probe = this.animLib.get('run_forward') || [...this.animLib.values()][0];
    if (probe) {
      for (const [id, tpl] of this.templates) {
        let ok = 0;
        for (const tr of probe.tracks) {
          if (tpl.boneNames.has(tr.name.split('.')[0])) ok++;
        }
        tpl.clipDriven = probe.tracks.length > 0 && ok / probe.tracks.length >= 0.9;
        if (tpl.clipDriven) console.log(`[avatars] "${id}" is clip-driven (real animations)`);
      }
    }
  }

  // Synchronous — safe to call any time after `await factory.ready`.
  // opts.scene overrides the target scene (the lobby preview renders the avatar
  // into its own scene so the game canvas behind it can be blurred).
  create(id, opts = {}) {
    const scene = opts.scene || this.scene;
    const withProps = { ...opts, props: this.props, blobShadows: this.blobShadows };
    const tpl = this.templates.get(id);
    if (!tpl) return new Character(scene, withProps);
    if (tpl.clipDriven && this.animLib && this.animLib.size) {
      return new ClipAvatar(scene, tpl, this.animLib, withProps);
    }
    return new GlbAvatar(scene, tpl, withProps);
  }
}

// ---------------------------------------------------------------------------
const RIFLE_MAT = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.55, metalness: 0.35 });

class GlbAvatar {
  constructor(scene, tpl, opts = {}) {
    this.scene = scene;

    this.root = new THREE.Group(); // world position + body yaw + death fall

    // pivot holds the +Z->-Z facing flip; model holds scale + normalization
    this.pivot = new THREE.Group();
    this.pivot.rotation.y = Math.PI; // glTF forward (+Z) -> engine forward (-Z)
    this.model = SkeletonUtils.clone(tpl.root);
    this.model.scale.setScalar(tpl.scale);
    this.model.position.set(tpl.offX, tpl.offY, tpl.offZ);
    this.pivot.add(this.model);
    this.root.add(this.pivot);

    // --- rig calibration (bones, rest pose, measured swing axes) ---
    this.rig = bindRig(this.model);
    this._baseModelY = this.model.position.y;

    // --- idle clip if the model ships one ---
    this.mixer = null;
    this.idleAction = null;
    const idle = tpl.clips.find((c) => /idle|stand/i.test(c.name)) || tpl.clips[0];
    if (idle) {
      this.mixer = new THREE.AnimationMixer(this.model);
      this.idleAction = this.mixer.clipAction(idle);
      this.idleAction.play();
      this._mixerActive = true;
    }

    // --- rifle on the calibrated mount (hand -> forearm -> upper arm) ---
    if (this.rig.rifleMount) {
      const m = this.rig.rifleMount;
      let rifle = (opts.props && opts.props.makeGun(0.7)) || null; // pre-scaled to metres
      if (!rifle) {
        rifle = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.07, 0.5), RIFLE_MAT);
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.28, 6), RIFLE_MAT);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 0.01, -0.36);
        rifle.add(body, barrel);
      }
      // m.scale = 1 / (bone world scale incl. the template scale) -> a child
      // scaled by it renders at world scale 1 (gun pre-sized in metres).
      rifle.scale.multiplyScalar(m.scale);
      rifle.quaternion.copy(m.quat);
      m.bone.add(rifle);
      this.rifle = rifle;
      this._muzzle = attachMuzzle(rifle); // real barrel tip for flash/tracers
    }
    this.props = opts.props || null;
    this.graveMesh = null;
    this._graveShown = false;

    if (opts.showName !== false && opts.name) {
      this.nameSprite = makeNameSprite(opts.name);
      this.root.add(this.nameSprite);
    }

    this.shadow = null;
    if (opts.blobShadows) {
      this.shadow = new THREE.Mesh(
        new THREE.CircleGeometry(0.42, 20),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false })
      );
      this.shadow.rotation.x = -Math.PI / 2;
      this.shadow.position.y = 0.025;
      scene.add(this.shadow);
    }

    this.model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(this.root);

    // spawn-protection aura (blue glowing sphere; toggled by pose.protected)
    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 18, 12),
      new THREE.MeshBasicMaterial({
        color: 0x4aa8ff, transparent: true, opacity: 0.2,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    this.shield.position.y = 0.95;
    this.shield.visible = false;
    this.root.add(this.shield);

    this._phase = 0;
    this.bodyYaw = 0;
    this._deathT = 0;
  }

  kick() {
    this._recoilT = 1;
  }

  getMuzzle(out) {
    if (!this._muzzle) return null;
    this._muzzle.getWorldPosition(_tmpMuz);
    out.x = _tmpMuz.x; out.y = _tmpMuz.y; out.z = _tmpMuz.z;
    return out;
  }

  update(dt, pose) {
    this.root.position.set(pose.x, pose.y, pose.z);
    if (this.shadow) {
      this.shadow.position.x = pose.x;
      this.shadow.position.z = pose.z;
      this.shadow.material.opacity = 0.32 * Math.max(0.25, 1 - pose.y / 2.5);
    }

    const alive = pose.alive !== false;

    // spawn shield aura (pulses/rotates while protected)
    if (this.shield) {
      const on = pose.protected === true && alive;
      this.shield.visible = on;
      if (on) {
        this.shield.rotation.y += dt * 1.6;
        this.shield.material.opacity = 0.15 + 0.1 * Math.sin(performance.now() * 0.006);
      }
    }

    this._updateGrave(alive, pose);
    if (!alive) {
      if (!this._graveShown) { // no grave prop -> fall backwards instead
        this._deathT = Math.min(1, this._deathT + dt * 3.2);
        this.root.rotation.x = -this._deathT * (Math.PI / 2);
      }
      return;
    }
    if (this._deathT > 0) { this._deathT = 0; this.root.rotation.x = 0; }

    const speed = Math.hypot(pose.vx, pose.vz);
    const speedN = Math.min(1, speed / MOVE.RUN);

    // combat stance: while aiming OR having recently fired, the body faces
    // the AIM direction (so shots visually leave the rifle, never the spine);
    // otherwise the body faces the direction of movement.
    let targetYaw = this.bodyYaw;
    if (pose.ads || pose.combat) targetYaw = pose.yaw;
    else if (speed > 0.6) targetYaw = Math.atan2(-pose.vx, -pose.vz);
    this.bodyYaw = lerpAngle(this.bodyYaw, targetYaw, 1 - Math.exp(-dt * 10));
    this.root.rotation.y = this.bodyYaw;

    // crouch: no rig-safe way to bend unknown skeletons — sink the model
    const sink = pose.crouch ? -0.3 : 0;
    this.model.position.y += (this._baseModelY + sink - this.model.position.y) * Math.min(1, dt * 14);

    // hysteresis so the idle-clip/procedural boundary can't flicker
    if (this._moving) { if (speedN < 0.06) this._moving = false; }
    else if (speedN > 0.15) this._moving = true;
    const moving = this._moving;

    // aim lean: +angle is calibrated "tip moves forward" = looks like aiming
    // down, hence the sign flip. Applied rest-based in the procedural branch,
    // additively on top of the mixer branch (mixer rewrites bones each frame,
    // so additive there cannot accumulate). Running adds a slight forward lean.
    let spineLean = -pose.pitch * 0.3 + speedN * 0.12;
    const headLean = -pose.pitch * 0.35;
    const raiseArm = pose.ads || pose.combat;

    if (moving || !this.idleAction) {
      if (this.mixer && this._mixerActive) { this.idleAction && this.idleAction.stop(); this._mixerActive = false; }

      this._phase += speed * dt * 2.4;
      const swing = Math.sin(this._phase) * 0.65 * speedN;

      this._pose('thighL', swing);
      this._pose('thighR', -swing);
      // knees counter-bend on the back-swing (calibrated +angle = forward,
      // knee flexion is backward, hence the negative)
      this._pose('shinL', -Math.max(0, -Math.sin(this._phase)) * 0.85 * speedN);
      this._pose('shinR', -Math.max(0, Math.sin(this._phase)) * 0.85 * speedN);
      if (!raiseArm) {
        this._pose('armL', -swing * 0.45);
        this._pose('armR', swing * 0.45);
      }

      // idle breathing for clip-less rigs standing still
      if (!moving) spineLean += Math.sin(performance.now() * 0.0018) * 0.02;

      if (raiseArm) this._pose('armR', 1.15 + pose.pitch * 0.8); // raise rifle arm
      this._pose('spine', spineLean);
      this._pose('head', headLean);
    } else if (this.mixer) {
      if (!this._mixerActive) { this.idleAction.play(); this._mixerActive = true; }
      this.mixer.update(dt);
      if (raiseArm) this._pose('armR', 1.15 + pose.pitch * 0.8);
      this._pose('spine', spineLean, true);
      this._pose('head', headLean, true);
    }

    // weapon kick
    if (this._recoilT > 0 && this.rifle) {
      this._recoilT = Math.max(0, this._recoilT - dt * 7);
      this.rifle.position.z = this._recoilT * 0.06;
    }
  }

  // Apply rest ∘ axisRotation(angle) to a mapped bone (additive=false resets
  // to rest first; additive=true multiplies onto the current pose so spine
  // lean can stack on locomotion).
  _pose(key, angle, additive = false) {
    const bone = this.rig.bones[key];
    const axis = this.rig.axes[key];
    const rest = this.rig.rest[key];
    if (!bone || !axis || !rest) return;
    _tmpQ.setFromAxisAngle(axis, angle);
    if (additive) bone.quaternion.multiply(_tmpQ);
    else bone.quaternion.copy(rest).multiply(_tmpQ);
  }

  // Swap body <-> grave marker on death/respawn (same behaviour as the
  // procedural recruit in character.js).
  _updateGrave(alive, pose) {
    if (!alive && !this._graveShown) {
      if (!this.graveMesh && this.props) {
        this.graveMesh = this.props.makeGrave();
        if (this.graveMesh) this.scene.add(this.graveMesh);
      }
      if (this.graveMesh) {
        this.graveMesh.position.set(pose.x, 0, pose.z);
        this.graveMesh.rotation.y = Math.random() * Math.PI * 2;
        this.graveMesh.visible = true;
        this.root.visible = false;
        if (this.shadow) this.shadow.visible = false;
        this._graveShown = true;
      }
    } else if (alive && this._graveShown) {
      this.graveMesh.visible = false;
      this.root.visible = true;
      if (this.shadow) this.shadow.visible = true;
      this._graveShown = false;
    }
  }

  dispose() {
    this.scene.remove(this.root);
    if (this.shadow) {
      this.scene.remove(this.shadow);
      this.shadow.geometry.dispose();
      this.shadow.material.dispose();
    }
    if (this.graveMesh) this.scene.remove(this.graveMesh);
    if (this.nameSprite) {
      this.nameSprite.material.map.dispose();
      this.nameSprite.material.dispose();
    }
    // cloned skinned meshes share geometry/materials with the template — do
    // NOT dispose those here or every other instance loses them.
  }
}

const _tmpQ = new THREE.Quaternion();
const _tmpMuz = new THREE.Vector3();

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
