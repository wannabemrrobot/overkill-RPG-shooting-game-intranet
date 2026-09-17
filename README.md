# TDM Shooter — LAN, trackpad-first, third-person browser shooter

A fast, fun Team Deathmatch shooter that runs entirely on your office LAN. One Node
process serves the web client **and** runs the authoritative game server on **one port**.
Colleagues just open a URL in their browser — no installs.

> **Status: Phase 2 (combat) + character selection.** Full combat with one
> assault rifle — camera→muzzle TPS aiming, trackpad aim assist (reticle
> slowdown + bullet magnetism + optional ADS soft-lock), server-side hitscan with
> per-region hitboxes and headshots, lag compensation, health/death/respawn,
> hit markers, damage numbers, kill feed, procedural sound — three practice
> bots (stationary dummy, strafing dummy, chase-and-shoot), and **playable
> characters**: pick Recruit or any .glb in `assets/characters/` on the login
> screen (live 3D preview, remembered per browser, re-pickable mid-match).
> Teams/score/rounds arrive in Phase 3.

---

## Run it

Requires **Node.js 18+** (tested on Node 22).

```bash
npm install
node server.js
```

You'll see a banner like:

```
============================================================
  TDM Shooter — server running   (Phase 1: movement)
============================================================
  Local:    http://localhost:3000
  Network:  http://192.168.1.42:3000   <-- share this  (en0)
  Health:   http://localhost:3000/health
============================================================
```

- Open the **Local** URL yourself, or the **Network** URL from another machine.
- Change the port with `PORT=8080 node server.js`.

### Verify the netcode (headless, no browser needed)

```bash
node tests/phase1check.mjs     # movement netcode: 16 end-to-end checks
node tests/phase2check.mjs     # combat: 21 checks (hitboxes, headshots, rate,
                               # ammo, walls, spoofed origins, bots, lag comp)
```

### See a moving player without a second human

```bash
node tests/walkerbot.mjs       # "strollbot" walks a loop through the map
node tests/walkerbot.mjs bob   # run more with distinct names
```

Open the game in your browser while a bot runs — you'll see it walking around
(remote interpolation, locomotion animation, name tag), no colleague required.

---

## How colleagues connect (LAN)

1. Make sure everyone is on the **same network/subnet** as your Mac.
2. Share the **Network** URL the server printed (e.g. `http://192.168.1.42:3000`).

**Find your Mac's LAN IP manually** (if the banner didn't show it):

```bash
ipconfig getifaddr en0     # Wi-Fi on most Macs
ipconfig getifaddr en1     # Ethernet / dongle (try if en0 is blank)
```

or **System Settings → Network → (your connection) → Details → TCP/IP → IP Address**.

### macOS firewall
If the macOS firewall is on, the **first** time the server listens macOS may pop up
*"Do you want the application 'node' to accept incoming network connections?"* —
click **Allow**. If you dismissed it or get no connections from other machines:

- **System Settings → Network → Firewall → Options…** → ensure `node` is set to
  *Allow incoming connections* (or toggle the firewall off briefly to test).

### If colleagues still can't connect
- **Same Wi-Fi, but blocked:** many corporate/guest Wi-Fi networks enable **client
  isolation** (AP isolation), which blocks device-to-device traffic. If so, use a wired
  switch, a dedicated router, or an unmanaged access point. That's network policy, not a bug.
- **VPN on:** disconnect it — it can reroute LAN traffic.
- Confirm reachability: from another machine, open `http://<your-ip>:3000/health`.

---

## Controls (Phase 1 defaults — all rebindable in ⚙ settings)

| Input | Action |
|---|---|
| **trackpad swipe** | look / aim (pointer lock) |
| **trackpad click** | fire — full auto (or keyboard **F** via settings) |
| **W A S D** | move, camera-relative (auto-run on) |
| **Q** | ADS / aim (toggle; zoom + stronger aim assist) |
| **R** | reload |
| **Shift** (hold) | precision walk |
| **Space** | jump |
| **C** | crouch (toggle) |
| **Z** | shoulder swap |
| **Esc** | menu / release cursor |

**Trackpad tuning** lives in ⚙ settings: sensitivity, flick acceleration (fast swipes
turn much further — 180s without running out of pad), smoothing, invert-Y,
toggle-vs-hold for ADS/crouch, auto-run, fire-on-click vs fire-on-key (used in
Phase 2), full key rebinding. Settings persist in the browser (localStorage).
A steady-aim damper also briefly softens look input right after each click, cancelling
the cursor wobble a physical trackpad press causes.

---

## Characters

- The login screen shows a **CHARACTER** row (first visit: it pulses until you
  pick). The selected model stands on a pedestal in the world behind the menu,
  rotating — that's a live render, what you pick is what everyone sees.
- Choice persists per browser; picking a different chip mid-match swaps your
  model live for everyone (`setchar` — server-validated).
- **Add characters**: drop any `model.glb` into `assets/characters/` — it
  appears in the picker automatically (id = filename). Best results: rigged
  humanoids under ~20k triangles. Models without animation clips get
  procedural leg/arm swing driven by our netcode; a bundled idle clip is used
  when standing. Everything is cosmetic — hitboxes are identical for everyone.
- `node scripts/inspect-glb.mjs` sanity-checks every .glb (rig, clips, tris).
- Credits/licenses: see `assets/README.md`.

## What to test in Phase 2

On your MacBook trackpad (everything below works solo — the bots are in):

- [ ] Walk to the **[BOT] Dummy** (stands still) — shoot it: crosshair blooms as
      you fire, hit markers + damage numbers pop (24 body / 48 head), its hp
      drops, it dies, the kill feed shows you ✕ it, and it respawns in ~2s.
- [ ] **Headshots**: aim at the head — the number doubles and shows red.
- [ ] The **[BOT] Strafer** side-steps — practice tracking; aim assist gently
      slows your reticle over it (feel the difference with the slider at 0).
- [ ] The **[BOT] Chaser** hunts you: it chases, strafes, fires in bursts, and
      is beatable (flank it — its turn rate is capped). You'll see tracers, hear
      its shots (positional), take damage (red vignette), and can die + respawn
      with a countdown banner.
- [ ] **ADS (Q)**: tighter crosshair, stronger assist, gentle soft-lock eases
      your aim onto the target (toggle it off in ⚙ settings to compare).
- [ ] **Reload (R)** and the auto-reload on an empty mag; ammo counter updates.
- [ ] Shooting through crates/walls does nothing (server-side occlusion).
- [ ] `node tests/phase2check.mjs` → `ALL CHECKS PASSED`.

## What to test in Phase 1

On a **real MacBook trackpad** (Chrome and Safari):

- [ ] Click **CLICK TO PLAY** → pointer locks; Esc brings the menu back. (Chrome
      enforces a ~1s cooldown between unlock/relock — the overlay tells you.)
- [ ] Swiping looks around smoothly; a **fast flick** turns much further than a slow
      drag (acceleration); sensitivity/smoothing sliders visibly change feel.
- [ ] WASD moves **relative to the camera**; character faces movement direction;
      auto-run default, Shift walks; Space jumps; C crouches; Q zooms (ADS) and the
      character raises its arms toward your aim pitch.
- [ ] **Camera never clips through** the crates/walls: back up against any box — the
      camera pulls in instead of seeing inside geometry; Z swaps shoulder.
- [ ] Run `node tests/walkerbot.mjs`, then watch it in-game: smooth motion (no
      stutter/teleporting), leg animation, name tag, blob shadow.
- [ ] Open a **second browser window** side by side: each sees the other move/jump/
      crouch/aim smoothly; your own movement feels instant (prediction) even though
      the server owns every position.
- [ ] `node tests/phase1check.mjs` → `ALL CHECKS PASSED`.
- [ ] HUD: ping a few ms on LAN, 55–60 fps, speed tops out at 5.2 m/s.

---

## Project layout

```
.
├── server.js                     # entry: Express static + Colyseus on ONE port
├── shared/                       # SINGLE SOURCE OF TRUTH (client + server import this)
│   ├── constants.js              #   net rates, room caps, movement/camera tuning
│   ├── map.js                    #   arena bounds + obstacle AABBs + spawn ring
│   └── movement.js               #   THE deterministic step: prediction == server sim
├── src/server/rooms/
│   └── ArenaRoom.js              # authoritative room: input queues, pacing, sim, sync
├── tests/
│   ├── phase1check.mjs           # 16-check headless netcode verification
│   └── walkerbot.mjs             # network puppet for solo visual testing
└── public/                       # static web client (served at /)
    ├── index.html                # import map + HUD/overlay/settings DOM
    ├── styles.css
    └── src/
        ├── main.js               # orchestrator: fixed-step loop, wiring
        ├── net/ colyseus.js      #   ESM wrapper over the colyseus.js browser UMD
        │        room.js          #   join/state/ping/input-send lifecycle
        ├── input/ input.js       #   trackpad look pipeline + rebindable keys
        ├── game/ world.js        #   meshes from shared/map.js (+ camera colliders)
        │        character.js     #   procedural humanoid + locomotion animation
        │        camera.js        #   colliding over-the-shoulder spring arm
        │        predictor.js     #   client prediction + reconciliation
        │        remotes.js       #   snapshot buffer + interpolation
        └── ui/  hud.js  settings.js
```

## How the netcode works (Phase 1)

- Client samples input at a fixed **60Hz** (`shared/constants.js` → `MOVE.FIXED_DT`),
  applies each step **instantly** to its predicted state, and sends it to the server.
- The server never accepts positions — only inputs. It sanitises every field, then
  integrates with the **same `stepPlayer()`** the client used, at a dt it controls.
  A token bucket (60 steps/s sustained) + a 12-step queue cap make input flooding
  useless (verified: 600 spoofed steps ≈ 1m of movement).
- Each patch carries `seq` (last processed input). The client rewinds to the
  authoritative state, replays unacked inputs, and folds any residual difference into
  a decaying render offset — corrections are invisible instead of snappy.
- Remote players render **100ms in the past**, interpolating between the two
  bracketing 20Hz snapshots — smooth motion regardless of tick rate.
- Full rooms overflow into new ones automatically via `joinOrCreate` (12 cap).

## Roadmap

- **Phase 0 — Scaffold** ✅ — one-port server, health, offline libs, live state sync.
- **Phase 1 — Movement + camera + trackpad input** ✅
- **Phase 2 — Combat (+ minimal bots)** ✅ *(you are here)* — rifle, camera→muzzle
  aiming + aim assist, server hitscan with hitboxes/headshots + lag compensation,
  health/death/respawn, hit markers/damage numbers/kill feed, procedural audio,
  practice dummies + chase bot.
- **Phase 3 — TDM loop** — teams, score, round timer, win condition, spawns, scoreboard.
- **Phase 4 — Content** — Sanhok-style map (heightmap + dense instanced foliage +
  cover/hideouts), 3–5 weapons, male/female rigs + skins + upper-body aim offset,
  lobby/loadout menu with character preview, bot/Practice controls in the menu.
- **Phase 5 — Polish & scale** — rooms/matchmaking for ~50, audio, minimap, LOD/perf
  pass, reconnection, basic anti-cheat hardening.
- **Phase 6 — Bots (full)** — tunable state machine, waypoint-graph + A* nav, own
  capped-turn/reaction-time aim model, difficulty tiers, `[BOT]` labels, team backfill,
  solo Practice/Warm-up mode.

## How combat works (Phase 2)

- **Aiming model** (the thing TPS games get wrong): the crosshair ray comes from
  the CAMERA through screen center to find the aim point; aim assist may nudge
  that point toward the nearest enemy hitbox in a small cone; the bullet is then
  a hitscan ray **from the gun muzzle toward that point** — so shots match the
  crosshair despite the shoulder offset, and a blocked barrel hits the wall.
- The client sends `{origin, direction, timestamp}`. The server **validates the
  origin sits at the player's muzzle** (≤1.25m tolerance — spoofed origins fall
  back to the server's own estimate), **rewinds all hitboxes** to the timestamp
  (lag compensation, ≤300ms), raycasts against world + per-region hitboxes
  (head 2.0× / torso 1.0× / legs 0.75×, distance falloff), and applies damage.
  Rate, ammo and reload are all enforced server-side.
- **Trackpad aim assist** (client): reticle slowdown over targets, bullet
  magnetism at fire time, optional gentle ADS soft-lock — all scaled by one
  strength slider, all LOS-gated. Fair because everyone's on a trackpad.
- **Bots** run fully server-side through the same simulation and fire pipeline
  as humans (remote clients can't tell the difference). The chaser has a capped
  turn rate, an aim-error cone, and burst pacing — beatable by design.
- Trade-off: **spread/recoil are client-side** (feel), so a modified client
  could remove them. Rate/ammo/damage/LOS/origin are all server-enforced; noted
  as acceptable for an office LAN v1.

## Key trade-offs so far

- **Buildless (import maps + vendored `node_modules`)** — keeps `npm install &&
  node server.js`, fully offline. Cost: no minification (~1.2MB three.js, trivial on LAN).
- **Colyseus** for rooms/matchmaking/state sync — isolated behind `public/src/net/` so a
  raw-`ws` binary fallback stays contained if ever needed. Its transport also caps
  messages at 4KB, which is our outer flood defense (verified).
- **Inputs-only protocol** — strongest possible movement anti-cheat (there is nothing to
  trust), at the cost of the server simulating every player (~60 steps/s each — measured
  negligible on the M3 Pro).
- **Flat-ground collision model in Phase 1** — obstacles are full-height (≥2m vs 0.89m
  jump apex), so 2D circle-vs-AABB push-out is *exact*, not approximate. Real heightmap
  + standable geometry arrives with the Phase 4 map.
- **Dynamic sun shadows + IBL** — PCF-soft shadow maps (2048px, texel-snapped
  frustum following the player) plus a PMREM sky/sun environment for ambient
  light and specular reflections. "Dynamic sun shadows" toggle in ⚙ settings
  falls back to cheap blob shadows for weak GPUs (reload to apply).
- **Hold-newest on packet gaps** (no extrapolation) for remotes — on a LAN, sub-frame
  gaps are rare and rubber-banding looks worse than a 50ms hold.
