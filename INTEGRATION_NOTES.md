# Integration notes

Systems that need something changed in a file they do not own write it here,
under a heading with their system name. The integrator reads this and makes the
change. Do not edit another system's section.

## duck-model (`src/entities/duck.js`)

No changes needed in files I do not own. Notes for `duckPlayer.js` / `family.js`:

* **Facing.** The duck model faces **+Z** in local space, up is +Y, +X is its
  right, and `y = 0` is the floating waterline (`duck.waterlineY`). If your
  system orients with `Object3D.lookAt()` (which points −Z at the target), pass
  `createDuck({ forward: '-z' })` and the factory inserts the flip for you.
  `duck.forwardAxis` is the unit facing vector for whichever you chose.
* **Duckling size.** `variant: 'duckling'` already applies a 0.72 base scale
  (`duck.baseScale`), so `scale: 1` gives a ~0.20 m duckling next to a ~0.58 m
  adult. `duck.scale` reports the effective world scale.
* **Wetness** is per-duck. Either pass `params.wetness` every frame or let it
  manage itself: it goes to 1 while `params.submerged` and decays over ~18 s.
* **Spray hook.** `duck.onSpray` is called once when the duck surfaces and
  shakes. Wire it to `EVENTS.SPLASH` / particles; `duck.headPosition(out)`
  gives the emission point.
* Shadows: the body casts, the (optional) down shell never does.

## player + camera (`src/entities/duckPlayer.js`, `src/entities/cameraRig.js`)

Requests for `src/main.js` (I did not edit it — everything below is worked
around at runtime, but the workarounds are ugly and should move into main.js):

* **`window.__duck` is missing `forceDive`.** `tools/screenshot.mjs` calls
  `__duck.forceDive?.(depth)` in two of the six default shots, but main.js only
  publishes `setTime` / `teleport` / `screenshotMode`, so those two shots
  silently do nothing. `duckPlayer.init()` therefore installs an accessor on
  `window.__duck` that augments the object main.js assigns, adding
  `forceDive(depth)`, `surface()`, `player` and a default `cinematic = false`.
  Please add to the `window.__duck = { … }` literal instead:

  ```js
  forceDive: (d = 2) => this.sys.player?.forceDive?.(d),
  surface:   ()      => this.sys.player?.surface?.(true),
  cinematic: false,
  ```

* **`ctx.camera` is overwritten by the camera *system*.** Because the manifest
  key is `camera`, `ctx.camera` stops being the `PerspectiveCamera` after the
  rig boots. `sky.js` and `water.js` already work around it via
  `ctx.engine.camera`; `CameraRig` also proxies `.position`, `.quaternion`,
  `.matrixWorld`, `.fov`, `.near`, `.far` and `.isUnderwater` so old reads keep
  working. Renaming the manifest key to `cameraRig` (or assigning
  `ctx.cameraRig`) would remove the trap for everyone.

Notes for other systems (no change needed from you):

* `player.state` is `'float' | 'swim' | 'dive' | 'underwater' | 'land' | 'fly'`.
  `player.depthBelow` is metres of the *waterline origin* below the surface, so
  it is ~0 while floating and is the number to key underwater effects off.
* Also public: `player.wetness`, `player.stamina`, `player.breath`,
  `player.grounded`, `player.airborne`, `player.yaw`, `player.waterHeight`,
  `player.bedHeight`, `player.duck` (the `createDuck` handle).
* `rig.underwater` / `rig.camera.isUnderwater` and `rig.focusDistance` (metres
  to the duck) are published every frame for postfx. `rig.setTarget(object3D)`
  hands the camera to a cutscene, `rig.setTarget(null)` gives it back, and
  `rig.snap()` reframes instantly (call it after you teleport anything).
* **The waterline shot (`05-surface-line`) cannot be a true split.** The water
  is one mesh that flips to its underside look based on the camera's Y, so the
  rig deliberately keeps the eye at least 8.5 cm clear of the surface plane and
  never coplanar. A real half-in/half-out frame needs a screen-space mask in
  `postfx` driven by the surface height at the near plane — `rig.eyeDepth`
  (metres of eye below the surface, 0 when above) is published for that.

## fish (`src/entities/fish.js`)

No changes needed in files I do not own. What other systems can use:

```js
const fish = ctx.get('fish');
fish.count            // fish currently simulated (streamed, ~100-200 near you)
fish.population       // total the river holds across all shoals (~1300)
fish.drawnCount       // instances actually submitted this frame
fish.speciesInfo      // [{ key, name, color, length }] for HUD / lessons
fish.nearest(pos, maxDist = 6)     // → descriptor | null
fish.tryCatch(pos, radius = 0.45)  // → descriptor | null  (rolls for escape)
fish.startle(pos, radius, strength) // 0..1 strength, propagates through shoals
fish.setSpawnRate(x)               // 0..2, re-seeds the shoals near you
```

A **descriptor** is `{ species, name, length, weight, position, distance,
startled, color }`. `species` is one of `minnow | perch | pike | loach`.

* On a successful `tryCatch` I emit `FISH_CAUGHT { fish, position, species }`,
  `BUBBLES` and `SFX { name: 'fish-catch' }`; on a miss `FISH_ESCAPED` plus
  `SFX { name: 'fish-escape' }`. Escape chance rises steeply with the fish's
  wariness and whether it is already startled, so **charging a shoal makes it
  uncatchable** — the intended loop is drift in slowly, then strike.
* I listen for `EVENTS.DIVE` (always a startle) and `EVENTS.SPLASH` with
  `strength >= 0.45`. My own surface rises emit `SPLASH` at strength ~0.2 so
  they do not scare the shoal that made them — keep incidental splashes below
  0.45 unless you mean to scatter the fish.
* Surface rises call `ctx.water.addRipple()` directly and emit
  `SFX { name: 'fish-rise' }`. Audio may want `fish-rise`, `fish-catch`,
  `fish-escape`.
* Fish never cast or receive shadows and are excluded from nothing — they are
  drawn in the water's refraction pass, which is what makes them visible from
  above the surface.

Requests for other owners (all optional, nothing is broken without them):

* **vegetation**: if you publish a query like `vegetation.coverAt(s, u)` or a
  list of weed-bed centres, perch and pike would shelter in the real weed
  instead of the species' preferred `|u|` lane, which is all I can do today.
* **minigames / quests**: `tryCatch` is the whole catching contract; call it
  from the player's bill position with a radius around 0.35–0.5 m.

---

## vegetation (`src/world/vegetation.js`, `src/world/trees.js`)

What I publish on `ctx.vegetation`:

```js
vegetation.wind(worldPos, out) -> Vector3   // shared wind, world space, horizontal
vegetation.windPhase                        // scalar, advances with time
vegetation.windDir                          // Vector3, unit, horizontal
vegetation.windStrength                     // ~0.7 … 1.15, breathes slowly
vegetation.uniforms                         // { uWindDir, uWindPhase, uWindStrength,
                                            //   uCamPos, uSunDir, uSunColor, uSkyColor }
vegetation.group                            // Object3D: reeds, grass, lilies
vegetation.trees                            // Trees (trees.group, trees.trees[])
vegetation.reedHeightAt(s, u)               // rough reed canopy height, 0 where none
vegetation.coverAt(s, u)                    // 0..1 plant cover (reed drift density)
vegetation.lilyPads                         // [{x, z, size, rot}] for anything that lands
```

The same wind exists in GLSL as `WIND_GLSL` / `WIND_DECL` (exported from
`vegetation.js`). **Dragonflies, particles, smoke and cloth should use
`vegetation.wind()`** so the whole world gusts together rather than each system
inventing its own breeze.

Requests for other owners:

* **water** — `_renderSceneBehind()` (refraction) and `_renderReflection()`
  traverse the whole scene, and `postfx`'s normal/depth pass makes a third. With
  the main pass that is **four scene traversals per frame**, so every vegetation
  triangle is charged four times, not the three the budget assumes. I already
  keep grass and lilies off the reflection with layer **11**
  (`NO_REFLECT_LAYER`, exported from `vegetation.js`), and I move distant tree
  chunks onto it too. If `water._reflCam` is ever rebuilt, please keep layer 11
  disabled on it. If `postfx`'s normal/depth camera and the water refraction
  camera also dropped layer 11, I could give back roughly 250k triangles per
  frame at the `high` tier and spend them on more grass.
* **settings** — I currently clamp `quality.grassCount` to 20000 and
  `quality.reedCount` to 6800 regardless of tier, because at the documented
  `high` values (38000 / 9000) the four traversals put the frame over the 2.2M
  triangle ceiling on their own. If the extra passes get the layer treatment
  above, remove the clamps in `Vegetation.init()`.
* **measured cost, `medium` tier, hero shot**: vegetation adds **21 draw calls
  and 988k triangles** (frame goes 367 → 388 calls, 769k → 1.757M triangles).
  Of those 21 calls, 10 are the three instanced fields (reeds 4 passes, grass 3,
  lilies 3) and 11 are the tree chunks. The frame is already at 367 calls
  *without* vegetation and five systems are still stubs, so the 380 ceiling is
  going to need a project-level decision, not just my trimming. The cheapest
  single lever is the layer-11 treatment for the refraction and normal/depth
  cameras above: that is −6 calls and about −300k triangles on its own.
* **anyone reading `ctx.camera`** — after boot `main.js` replaces `ctx.camera`
  with the camera *rig* system, so `ctx.camera.matrixWorld` does not exist. Use
  `ctx.engine.camera`. This cost me an hour; it is worth a line in CONTRACT.md.
* **fish** — `vegetation.coverAt(s, u)` is the weed-density query you asked for.
  It returns the same 0..1 drift density that decides where reeds and submerged
  weed actually get planted, so `coverAt > 0.5` really is a weed bed.

## family (`src/entities/family.js`)

* **What is on `ctx`** — `ctx.family` / `ctx.get('family')` exposes
  `family.mother` (agent), `family.ducklings` (array of agents),
  `family.leader` (the mother agent, or the player system when most of the
  brood has defected to you), `family.distanceToPlayer` (player → mother),
  `family.distanceToNearest`, `family.followingPlayer` (count),
  `family.gather()` and `family.setTarget(worldPos)`. Every agent has
  `.position`, `.velocity`, `.yaw`, `.coord` ({s,u,distance}), `.duck` (the
  `createDuck` handle), `.leader`, `.state` and `.gap`. Quests / minigames can
  read `family.mother.coord.s` for "how far downstream is the family".
* **measured cost, hero view, `high` tier**: the family adds **27 draw calls
  and 102k triangles** to the frame (157 → 130 calls and 1.062M → 959k
  triangles when `family.group.visible` is toggled between two consecutive
  frames). That is 9 skinned meshes drawn about 2.7× each — main pass,
  planar reflection and shadow map. Measurement harness is in
  `tools/shots/family.json` (`window.__famDelta()`).
* **duckling down shell is OFF** — `createDuck({ downShell: true })` adds a
  second transparent pass per duckling, measured at +16 draw calls and +24k
  triangles for a brood of eight. The frame is already over the 380 budget
  before the family exists, so `downShell` is hard-coded `false` in
  `Family.init()`. One-line flip when there is headroom.
* **water** — the family shares the 24 global ripple slots, so it only sheds
  wake rings for ducks inside 15 m of camera (24 m for the mother) and only
  every 0.85–1.25 m of travel. If `RIPPLE_SLOTS` ever grows, the family can
  afford a ring every ~0.4 m and the line will read much wetter.
* **player scale mismatch (`duckPlayer.js`)** — the player is built as
  `variant: 'drake', scale: 1.0` (~0.55 m long) but the story says the player
  *is* one of these ducklings. The family is sized so the mother reads as an
  adult (~0.75 m) and the brood as ducklings (~0.24–0.33 m), which makes the
  player duck read as an adult drake swimming with a hen and her chicks. If
  the player switched to `variant: 'duckling', scale: ~1.5` the premise would
  land; the family sizes are then already correct and need no change.
* **terrain** — I use `terrain.rocks` (position/radius/submerged) to build a
  bucketed index of boulders that break the surface, for avoidance and for
  letting a duck clamber onto a barely-submerged rock. There is no
  `terrain.surfaceHeightAt()`; `river.bedHeight()` plus that rock index is
  what the family stands on. A real `surfaceHeightAt(x, z)` that includes the
  boulder instances would let me drop ~40 lines.

---

## particles (`src/entities/particles.js`)

What I publish on `ctx.particles` / `ctx.get('particles')`:

```js
particles.emit(kind, positionOrOptions, options)
//  'bubbles'|'bubble'  { count, spread, size, rise }
//  'splash'            { strength, dir }        crown + curtain + spray + foam ring
//  'droplets'          { count, strength, spread }
//  'spray'             { count, strength, dir }
//  'mist'              { radius, amount }
//  'dust'              { count }
//  'down'|'feather'    { count, spread }
//  'marker'            { color, strength }      REQUIRED nav confirmation
//  'ring'|'foam'       { radius, strength }
particles.counts        // { bubbles, droplets, motes, sheets }
particles.wind(pos,out) // vegetation.wind() when it exists, local breeze otherwise
particles.enabled       // set false to mute every effect
```

Position may be a `Vector3`, a `{x,y,z}` literal, or `{ position, ... }`.
I listen for `SPLASH`, `BUBBLES`, `DIVE`, `SURFACE`, `FISH_CAUGHT`, and for
`SFX { name:'wingbeat'|'preen' }` (feather down). I also chain onto
`player.duck.onSpray` the first frame the player exists — the previous handler
is still called.

Cost: **4 draw calls, ~300 triangles** in the main pass (bubbles / droplets /
motes are `Points`, all the sheets are one instanced quad mesh). Everything is
on layer 11 (`NO_REFLECT_LAYER`) so the planar reflection skips it, every
material is `transparent + depthWrite:false` so postfx's g-buffer drops it, and
nothing casts a shadow. Only the water's refraction traversal draws it a second
time (+4 calls).

Requests / findings for other owners:

* **water — the ripple decal is currently rendering as hard white polygons.**
  With `water.addRipple()` stubbed out my markers and splashes look correct;
  with it live, every ripple site becomes a cluster of flat, hard-edged white
  quads that blow out the frame (see `shots/particles6/01-dawn-mist-splash.png`
  versus `shots/particles6/iso-marker-noripple.png`, which is the same setup
  with `addRipple` monkey-patched to a no-op). I have cut my ripple usage to at
  most 3 per frame and only for real events, but the decal itself needs a look.
* **tools/screenshot.mjs — `requestAnimationFrame` is effectively frozen in the
  headless capture.** `game.time.frame` reaches ~5 and then stops advancing;
  `settle` waits do not simulate anything, so every capture is "five frames
  after boot". Anything transient (particles, wakes, animation blends, fish
  behaviour) is therefore invisible in the default shots even when it works.
  Timers still fire, so a shot can drive the loop itself:

  ```js
  setInterval(function(){ try { window.game._loop(); } catch (e) {} }, 40);
  ```

  `tools/shots/particles.json` does exactly that. It would be worth doing in
  the harness itself (drive N frames, then grab) so every agent's transient
  work is actually captured.
* **anyone writing GLSL for this target**: reversed-edge `smoothstep(hi, lo, x)`
  returns 1.0 on the SwiftShader GL used for capture, so radial masks written
  that way fill the whole quad. Write `1.0 - smoothstep(lo, hi, x)`.
* **InstancedBufferGeometry**: a `uv` attribute shared from a `PlaneGeometry`
  came through constant on this driver; deriving uv from `position.xy + 0.5`
  fixed it. Worth knowing if another system instances quads.
* **duckPlayer**: I implement `emit('marker', {x,y,z})` — call it on tap-to-move
  and the tap gets a warm expanding ring plus rising motes.

## shoreline + buoyancy (terrain.js, groundMaterial.js, water.js, waterMaterial.js)

Two player-reported bugs, both diagnosed offline before touching pixels
(`node` harness driving the real `River` + `Water` classes, no DOM needed).

### 1. The waterline — root cause was in `river.depth`, not in the shaders

`river.depth(s, u)` clamps a *skewed* cross-channel profile:

```js
const uu = clamp((u - skew) / (1 - Math.abs(skew) * 0.6), -1, 1);
let profile = Math.pow(Math.max(0, 1 - uu * uu), 0.62);
```

so on a bend the profile saturates and the bed reaches WATER_LEVEL **well
inside |u| = 1**. Measured over the whole river at 2 m steps:

* the waterline sits at |u| ≤ 0.3 on 278 of 2028 (station, side) samples;
* the widest dry point bar is **10.9 m of nominal channel at exactly y = 0**;
* the waterline |u| can move **0.40 (≈ 7 m) between two adjacent 2.14 m rows**.

Nothing knew this. Both ribbons put all their cross-channel resolution at
|u| = 1, so:

* the ground ribbon resolved the real shelf (a 2 m drop inside one metre) with
  columns 1.1 m apart and **undershot the true bed by up to 1.14 m** — those are
  the dark wedges;
* the water ribbon painted opaque water and saturated shore foam across the
  whole bar, **exactly coplanar with the ground** — that is the stair-stepped
  z-fighting patchwork and the blown-out bright patches. Both materials also
  had `polygonOffset` with a slope factor, so at grazing angles they took turns
  winning.

Fix: `terrain.js` now exports `shoreU(river, s, side)` — a bisection on
`river.depth`, cached at 1 m and linearly interpolated (which also removes the
staircase that `curvature()`'s 1 m lookup table puts into the raw edge).
**Both ribbons scale their cross-section by it**, so their channel columns are a
normalised parameter `v` where `v = ±1` is the waterline wherever the bend has
put it. `world/water.js` imports `shoreU` from `world/terrain.js` for this — the
one place the two systems are deliberately coupled, because a few centimetres of
disagreement is the whole bug.

The water's `aDepth` attribute is now the **signed** still-water depth
(`WATER_LEVEL - river.bedHeight`), and the shader's shore alpha, foam band, wet
band and skirt drop all key off it plus `aSU.z` (metres from the same
waterline). The visible edge is therefore an analytic contour of a smoothly
interpolated value, not the intersection of two coarse meshes. `groundMaterial`
shades silt → wet → damp → scum line → dry off the same signed distance
(`aTerrain.x`, now measured from the real waterline).

**Other systems: `aTerrain.x` / `vShoreDist` changed meaning** — it used to be
`-(1 - |u|) * halfWidth`; it is now signed metres from the *actual* waterline.
Nothing outside terrain reads it today, but if you copy the ribbon idea, note it.

**Anything that places props in "the channel" (vegetation, fish, family, rocks)
should stop assuming `|u| < 1` means water.** Use `ctx.water.signedDepthAt(x, z)`
or `ctx.water.isWaterAt(x, z)` (new, see below) — on a fifth of the river,
`|u| = 0.4` is dry gravel.

### 2. The duck being dragged under — the ripple field had a crest at its own origin

`ripplesAt()` used `exp(-(d - r0)^2 / w^2)`, which is at **full crest when
d = 0 and r0 = 0**. Every dive/surface transition emits four rings at the duck's
own position (DIVE/SURFACE + two from the SPLASH handler + one from the player),
so the instant the duck crossed `SUB_ENTER` its own splash lifted
`water.heightAt` by ~0.5 m under its feet, which re-triggered the transition,
which emitted more rings. Measured in the offline harness: after a single dive,
**95 state flips in 14 s and `heightAt` running away to +1.07 m** — the duck is
reported permanently submerged and flapping cannot help because there is nothing
wrong with its position, only with the surface it is being compared to.

Fixed inside `waterMaterial.js` (GLSL and its JS twin together): rings ramp in
over the first 0.45 m of radius, the wave packet is 45% narrower on the inside
(the water a ring has crossed has relaxed), and the summed height is clamped to
±0.26 m. `addRipple` caps a single ring at 0.32 m. After the fix, across 120
dive-and-release tests at stations along the whole river: **worst case 4 flips
in 10 s, `heightAt` never leaves ±0.18 m.** No change needed in duckPlayer.js.

### New on `ctx.water`

```js
water.signedDepthAt(x, z)   // + in the channel, - once the bed is out of the water
water.isWaterAt(x, z, min?) // cheap "is there real water here"
```

`heightAt` and `normalAt` are now hard-guarded: non-finite inputs return the
still level / (0,1,0), the result is clamped to ±0.45 m of the still level, and
the normal can never point below the horizon. **`heightAt` still knows nothing
about boulders** — a duck standing on a rock whose top is above the waterline is
told the water surface is above it, because `duckPlayer` also takes its bed
height from `river.bedHeight`, which has no rocks in it either. Fixing that
needs a rock-aware ground query on the river/terrain side; noted, not done.

### Budget

Water ribbon: 59 → 71 columns for the shore fade, +≈4k triangles, still one
draw call. Terrain: identical column count (`CHANNEL_U` redistributed, not
extended), so no delta.

**Observed, not introduced, not diagnosed**: `shots/shore1`, `shots/family` and
`shots/particles7` all carry a wall of
`GL_INVALID_FRAMEBUFFER_OPERATION: Framebuffer is incomplete: Attachments are
not all the same size` in `report.json`. It appears after the page has lost and
restored its WebGL context (the run that produced it also logged
`Execution context was destroyed … navigation`), and it happens on runs made
before and after this change, so it is not the water's new attributes. Most
likely candidate is a render target whose colour and depth attachments are
rebuilt out of step across a context restore. Worth someone owning.

---

## audio (`src/gameplay/audio.js`)

Everything is synthesised at runtime — no files, no network, one `AudioContext`.
It costs **0 draw calls and 0 triangles**; the only frame cost is one 10 Hz
world sample and a handful of `AudioParam` writes.

### What other systems can use

```js
const audio = ctx.get('audio');
audio.play(name, { position, volume, rate, strength, count })  // same as EVENTS.SFX
audio.setVolume(0..1)      audio.volume        // persisted in localStorage
audio.mute(bool)           audio.muted         audio.toggleMute()
audio.setMusicEnabled(bool)                    // music only, ambience stays
audio.state                // 'running' | 'suspended' | 'unavailable'
audio.running / audio.ready / audio.available / audio.blockedReason
audio.underwater           // 0..1 smoothed, the muffle amount
audio.intensity            // 0..1 "something is happening", drives the score
audio.selfTest()           // node graph + per-voice construction check
audio.names                // every sound name it knows
```

**HUD**: the settings panel wants `setVolume` / `mute` / `volume` / `muted`,
and should show a "click to enable sound" hint while `audio.running === false`
(autoplay is blocked until the first gesture — the system listens for
pointerdown / keydown / touchstart / mousedown / wheel on `window` itself, so
the HUD does not have to forward anything).

**Sound names** currently voiced: `splash dive surface quack peep bubbles
dabble preen waddle wingbeat fish-rise fish-catch fish-escape chime plop
ripple`. An unknown name is not an error — it plays a soft plop, so emitting a
new one is safe. `rate >= 1.45` on `quack` switches to the duckling peep, which
is how `family.js`'s `_peep()` already sounds right without changing.

Events consumed: `SFX`, `SPLASH` (strength scales the voice), `RIPPLE`
(strength ≥ 0.5), `DIVE`, `SURFACE`, `QUACK`, `BUBBLES`, `FISH_CAUGHT`,
`QUEST_COMPLETED`, `GAME_ENDED`, `SHAKE`. Footsteps are generated internally
from `player.grounded / speed`, since nothing emits a step event.

### Notes for other owners

* **`DIVE` / `SURFACE` / `QUACK` are each emitted twice** — the bare event and
  then an `SFX` event with the same meaning (`duckPlayer._enterSubmerged`,
  `duckPlayer._quack`, `family._quack`). Audio parks the bare event for one
  frame and only voices it if no `SFX` followed, because the `SFX` payload is
  the one that carries `rate`. Nothing needs to change, but if a new emitter
  sends only one of the pair it will still be heard exactly once.
* **`ctx.player.submerged` vs the camera.** The listener sits at the camera, so
  the muffle keys off `cameraRig.underwater` when it exists and falls back to
  `player.submerged`. If the rig ever stops publishing `underwater`, the
  transition still works, it just fires when the duck goes under rather than
  when the eye does.
* **`terrain.rocks`** is sampled (bucketed, ≤260 entries per pass at 10 Hz) to
  find surface-breaking boulders — near rocks + fast shallow water is what
  turns the river bed from a low roll into a bright riffle. A
  `terrain.rockNear(x, z)` query would let me drop that scan.
* **`vegetation.windStrength` / `coverAt(s, u)`** drive the reed rustle. They
  are optional; without vegetation the wind falls back to a slow sine.
* **quality tiers**: audio ignores `settings.quality`. If a `low` tier machine
  needs relief, `audio.setMusicEnabled(false)` removes 8 oscillators; the
  ambience is 7 buffer sources and cannot get much cheaper.
* Request for `src/main.js` (not made, worked around): nothing. The system
  boots from the manifest and needs no handle. `window.__duck.sys.audio` is
  enough for the capture harness.
