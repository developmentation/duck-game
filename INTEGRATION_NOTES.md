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
