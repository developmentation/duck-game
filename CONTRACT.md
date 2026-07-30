# Integration contract

Read this before touching anything. Systems are built in parallel by separate
agents; the only thing keeping them coherent is this document.

## Hard rules

1. **Own only your files.** Never edit a file another system owns (see the
   ownership table). If you need something from another system, get it off
   `ctx` or emit an event.
2. **Never edit** `src/main.js`, `src/core/*`, `src/world/river.js`,
   `index.html`, `package.json`, or `tools/*`. If your system genuinely needs a
   change there, write the request into `INTEGRATION_NOTES.md` under a heading
   with your system name instead.
3. **No new npm dependencies.** `three` (0.180) only, plus `three/addons/*`.
   Everything else is procedural: no external textures, models, audio files or
   fonts. The game must run fully offline from a static build.
4. **Everything is procedural and seeded.** Use `Noise` / `makeRandom` from
   `src/core/noise.js` with a fixed seed so the world is identical every run.
   Never call `Math.random()` at build time.
5. **No per-frame allocation** in `update()`. Hoist `Vector3`/`Quaternion`
   scratch objects to instance fields. This is a 60fps game.
6. **Dispose properly.** Geometries and materials you create get released in
   `dispose()`.

## System module shape

Every manifest entry is a class with this shape:

```js
export class Water {
  constructor(ctx) { this.ctx = ctx; }
  async init() {}                 // build meshes, add to ctx.scene
  update(dt, elapsed) {}          // per frame; omit if static
  resize(w, h, dpr) {}            // optional
  dispose() {}                    // optional
}
```

`init()` may be async, and is awaited during boot. If your class throws, the
game logs it and keeps running without you — so failing loudly is safe, but a
broken system means a missing feature.

## The shared `ctx`

| field | what |
| --- | --- |
| `ctx.THREE` | the three namespace (import it yourself too, same module instance) |
| `ctx.scene` | the root `THREE.Scene` |
| `ctx.camera` | the active `PerspectiveCamera` |
| `ctx.renderer` | `WebGLRenderer` |
| `ctx.composer` | `EffectComposer`; only `postfx` touches the pass list |
| `ctx.engine` | `Engine` — `.width`, `.height`, `.fps`, `.maxAnisotropy`, `.onResize(fn)` |
| `ctx.input` | `Input` — `.move` (Vector2), `.look`, `.zoom`, `.isDown(a)`, `.justPressed(a)` |
| `ctx.events` | `EventBus` — `.on(type, fn)`, `.emit(type, payload)` |
| `ctx.EVENTS` | canonical event name constants (see `src/core/events.js`) |
| `ctx.settings` | tunables and `settings.quality` tier, `settings.timeOfDay` (0..1) |
| `ctx.river` | the `River` — **the geometric authority**, see below |
| `ctx.time` | `{ elapsed, dt, frame }` |
| `ctx.WATER_LEVEL` | still water plane height (0) |
| `ctx.get('key')` | another booted system by manifest key, or undefined |

Systems are also exposed directly: `ctx.sky`, `ctx.water`, `ctx.terrain`,
`ctx.player`, `ctx.fish`, … **Always guard**: a system may be missing while it
is still being built. `ctx.sky?.sunDirection ?? fallback`.

## The River API (`ctx.river`)

Coordinates: `s` = metres downstream along the centreline (0 … `river.length`,
about 2170m). `u` = signed fraction across the channel, −1 = left bank,
0 = centre, +1 = right bank. `y` = world height, still water at `WATER_LEVEL` (0).
The river broadly advances along +Z and meanders in X.

```js
river.length                     // ≈ 2169
river.point(s, out?)             // Vector3 centreline point (y = 0)
river.tangent(s, out?)           // unit downstream direction, horizontal
river.right(s, out?)             // unit vector toward +u bank
river.halfWidth(s)               // metres, ~10.7 … 19.1
river.width(s)
river.toWorld(s, u, y, out?)     // river coords → world Vector3
river.toRiver(worldPos, out?)    // → { s, u, distance }  (0.3µs, safe per-frame)
river.depth(s, u)                // water depth in metres, 0 at/past the bank
river.bedHeight(s, u)            // world Y of the river bed
river.bankHeight(s, u)           // world Y of dry land for |u| > 1
river.groundAt(worldPos)         // ground Y anywhere, water or land
river.curvature(s)               // signed 1/m, + turning right
river.flow(worldPos, out?)       // current velocity Vector3 (m/s)
river.flowAt(s, u, out?)
river.isOverWater(worldPos)      // bool
river.pools                      // [{ s, radius, position, fishDensity }] × 9
river.poolNear(s)
river.noise                      // shared seeded Noise instance
```

`out` params let you avoid allocation — pass your scratch vectors.

## Sky / lighting contract (owned by `world/sky.js`)

Every lit system reads these. They exist from `sky.init()` onward:

```js
sky.sunDirection   // Vector3, unit, points FROM the scene TOWARD the sun
sky.sunLight       // THREE.DirectionalLight (casts the scene shadow)
sky.sunColor       // Color, current sun tint
sky.ambientColor   // Color, sky bounce
sky.fogColor       // Color, matches the horizon
sky.envMap         // THREE.Texture (PMREM cube) for PBR reflections
sky.exposure       // number
sky.timeOfDay      // 0..1 mirror of settings.timeOfDay
sky.horizonColor   // Color at the horizon along the view direction
sky.setTimeOfDay(t)
```

Materials that want image-based lighting should set
`scene.environment` — sky owns that, do not overwrite it.

## Water contract (owned by `world/water.js`)

```js
water.mesh                 // the surface mesh
water.level                // WATER_LEVEL
water.heightAt(x, z)       // surface Y including waves — CPU-cheap, matches the shader
water.normalAt(x, z, out?) // surface normal, for buoyant orientation
water.causticsTexture      // Texture projected by underwater/terrain systems
water.addRipple(x, z, strength, radius)   // reacts to entities
water.setUnderwater(bool)  // flips the surface to its underside look
```

Anything that floats calls `heightAt`/`normalAt`. Anything that hits the
surface emits `EVENTS.SPLASH` and calls `addRipple`.

## Player contract (owned by `entities/duckPlayer.js`)

```js
player.object          // THREE.Object3D root, in world space
player.position        // Vector3 (alias of object.position)
player.velocity        // Vector3
player.submerged       // bool
player.depthBelow      // metres under the surface, 0 when floating
player.breath          // 0..1
player.riverCoord      // { s, u, distance }, refreshed each frame
player.headPosition(out?)   // Vector3, for camera + bubble emission
player.forward(out?)        // unit facing
player.speed                // m/s scalar
player.teleportRiver(s, u)  // used by the capture harness
player.forceDive(depth)     // used by the capture harness
player.state                // 'float' | 'swim' | 'dive' | 'underwater' | 'land' | 'fly'
```

The camera rig (`entities/cameraRig.js`) is the **only** system that writes
`ctx.camera.position`/`quaternion`.

## Duck model contract (owned by `entities/duck.js`)

```js
import { createDuck } from './duck.js';
const duck = createDuck({ variant: 'adult' | 'duckling', scale, palette, seed });
// duck.object   Object3D
// duck.update(dt, params)  params: { speed, paddle, turn, submerged, look, flap, preen, quack }
// duck.setPose(name)
// duck.bones = { head, neck, body, tailFeathers, wingL, wingR, footL, footR, beak }
// duck.dispose()
```

`family.js` and `duckPlayer.js` both build ducks through this factory. It must
support at least 24 simultaneous instances cheaply (share geometry/material).

## Events

Emit and listen using `ctx.EVENTS.*` constants. Payload shapes are documented
in `src/core/events.js`. Notably:

- `EVENTS.SPLASH { position, strength }` — particles + audio + water react
- `EVENTS.BUBBLES { position, count, spread }`
- `EVENTS.FISH_CAUGHT { fish, position, species }`
- `EVENTS.TOAST { text, icon?, duration? }` — HUD shows a message
- `EVENTS.LESSON { title, body }` — HUD shows a learning card
- `EVENTS.SHAKE { strength, duration }` — camera rig reacts
- `EVENTS.SFX { name, position?, volume?, rate? }` — audio plays a procedural sound

## Ownership table

| files | system |
| --- | --- |
| `src/world/sky.js`, `src/render/atmosphere.js` | sky & lighting |
| `src/world/terrain.js`, `src/render/groundMaterial.js` | banks, bed, rocks |
| `src/world/water.js`, `src/render/waterMaterial.js` | water surface |
| `src/world/underwater.js`, `src/render/caustics.js` | submerged look |
| `src/world/vegetation.js`, `src/world/trees.js` | reeds, grass, lilies, trees |
| `src/entities/duck.js` | duck mesh, rig, animation |
| `src/entities/duckPlayer.js` | player physics & state |
| `src/entities/cameraRig.js` | camera |
| `src/entities/family.js` | duckling flock AI |
| `src/entities/fish.js` | fish schools |
| `src/entities/particles.js` | bubbles, splashes, spray, motes |
| `src/entities/wildlife.js` | dragonflies, birds, frogs |
| `src/render/postfx.js` | post chain |
| `src/gameplay/quests.js` | quests & lessons |
| `src/gameplay/minigames.js` | game modes |
| `src/gameplay/hud.js`, `src/ui/hud-*.css` | interface |
| `src/gameplay/audio.js` | procedural audio |
| `src/core/*`, `src/world/river.js`, `src/main.js`, `tools/*` | integration (do not edit) |

Shared helper modules you may create inside your own namespace: e.g.
`src/render/waterMaterial.js` is fine for the water owner. Do not create files
in another owner's namespace.

## Art direction

The target is *Journey* / *Lune*: painterly, generous, warm, readable. Not
photoreal, not cartoon-flat.

- **Light is the subject.** Low sun, long shadows, strong rim light on duck
  down and reed tips, visible atmospheric depth. Aerial perspective on distant
  banks. Above all: contrast between warm sunlight and cool shadow.
- **Silhouette first.** Reed clumps, tree canopies and bank lines must read as
  clean shapes against the sky.
- **Layered depth.** Foreground reeds, mid river, far bank, distant hills,
  haze. Something in at least four depth planes in every wide shot.
- **Water is the hero.** Sky reflection, refracted bed, depth-tinted colour,
  foam at the banks, wakes behind the ducks, caustics on the bed.
- **Colour discipline.** A warm/cool complementary scheme: honeyed sunlight
  against teal shadow. Avoid saturated primaries and avoid grey mud.
- **Movement everywhere.** Wind in the reeds, drifting motes, ripples, birds,
  the family paddling — never a static frame.
- No hard geometric edges where nature wouldn't have one. No visible tiling.
  No z-fighting at the waterline. No popping LODs in frame.

## Performance budget

At `high` on a mid laptop, target 60fps at 1600×900:

- ≤ 380 draw calls, ≤ 2.2M triangles per frame
- instancing for reeds/grass/fish/trees, one draw call per kind
- one shadow map, one reflection/refraction pass at ≤ 1024²
- shaders compile in under 4s total

## Verifying your work

```bash
npm run dev &                       # http://127.0.0.1:5173
node tools/screenshot.mjs --out shots/mine
```

`shots/mine/report.json` lists console errors, missing systems, fps and draw
calls. **A shot that shows your system is the deliverable** — look at the PNG
before you claim it works.
