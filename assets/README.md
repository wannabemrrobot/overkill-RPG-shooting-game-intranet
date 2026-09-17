# Third-party assets

`craftpix/` contains low-poly 3D packs downloaded from craftpix.net ("POLYPACK"
free packs) by the project owner. Craftpix's free license permits use inside
games (including commercial); it does NOT permit redistributing the raw asset
files themselves. Keep this repo private / internal accordingly.

Loaded at runtime by the client via three.js FBXLoader (see
public/src/game/assets.js). Nothing here is required to run the server or
tests — the client falls back to procedural stand-ins if a file is missing.

## characters/

Playable character models (.glb), downloaded from Sketchfab by the project
owner. Every file dropped in this folder automatically appears in the in-game
character picker (id = filename). Characters are cosmetic only — hitboxes and
movement are identical for everyone.

Credits:
- `vanguard.fbx` — "Vanguard By T. Choonyung" — Adobe Mixamo (free for use in
  games; no attribution required)
- `military.glb` — "Military tactical suit (lowpoly gameready)" — Sketchfab
  upload (CC-BY; add author) — AUTO-REJECTED by the validity gate (gear set)

## anims/

Mixamo animation clips (FBX, downloaded "without skin"), retargeted at runtime
onto any character whose skeleton matches (mixamo naming). Root motion is
stripped at load — the netcode owns world position. Drop more clips in and
they join the library automatically; recognised keys include `rifle_idle`,
`idle`, `run_forward`, `firing_rifle`, `dying`, `hit_react`.

NOTE: these are fan models of franchise characters. The uploaders' CC licenses
do not clear the underlying IP — fine for an internal office LAN game; do not
ship them in anything public/commercial.

`military.glb` is present but AUTO-REJECTED by the game's character validity
gate: it is a gear-set/flatlay asset (14 equipment pieces, no body mesh) whose
skin never assembles onto its skeleton. Players picking it render as Recruit.

## props/

- `gun.glb` — "gun_m4a1" — Sketchfab upload (CC-BY; add author). Held by every
  character (replaces the procedural box rifle).
- `grave.glb` — grave marker — Sketchfab upload (CC-BY; add author). Placed
  where a player died, until they respawn.
