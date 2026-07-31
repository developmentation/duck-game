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
* **anyone reading `ctx.camera`** — after boot `main.js` replaces `ctx.camera`
  with the camera *rig* system, so `ctx.camera.matrixWorld` does not exist. Use
  `ctx.engine.camera`. This cost me an hour; it is worth a line in CONTRACT.md.
* **fish** — `vegetation.coverAt(s, u)` is the weed-density query you asked for.
  It returns the same 0..1 drift density that decides where reeds and submerged
  weed actually get planted, so `coverAt > 0.5` really is a weed bed.
