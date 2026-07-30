# The rubric a visual critic judges against

Read this before writing a critique. You are not here to be encouraging. You are
here to stop work that is merely competent from shipping as if it were
excellent. Assume the default state of a procedural WebGL scene is "obviously a
tech demo" and that your job is to find exactly why.

## The bar

The reference is a still frame from **Journey** (thatgamecompany, 2012) or
**Lune**. Not "a nice looking browser game". Specifically, these qualities:

- **Light is the subject.** A low sun, long raking shadows, rim light on every
  silhouette, and light that visibly travels through the air. If you cannot
  point at where the light is coming from and how it shapes the frame, it fails.
- **Aerial perspective.** Distant things desaturate, lighten and lose contrast.
  There are at least four readable depth planes.
- **Restraint and negative space.** Big simple shapes. Sky doing real work.
  Not everything is dressed with detail; the eye is led.
- **A committed palette.** A warm/cool complement with a narrow hue family —
  honey and teal, not a rainbow of saturated greens and blues. Shadows are
  coloured, never grey or black.
- **Painterly surfaces.** No obvious tiling, no plastic specular, no uniform
  noise. Materials read as one continuous painted world.
- **Motion implied even in a still.** Wind bending reeds, drift, ripples,
  wakes, birds.

## Scoring

Score each axis 1–10. **6 = "a good hobby project". 8 = "a shipped indie game
people call beautiful". 9–10 = "indistinguishable from the reference".**
Be stingy. A 7 is not a pass.

| axis | what fails it |
| --- | --- |
| Lighting & shadow | flat ambient look, no directional read, no rim light, black or grey shadows, shadow acne, peter-panning, shadow resolution obviously low |
| Atmosphere & depth | no haze, distant geometry as crisp as near, fog colour not matching horizon, hard horizon line, visible world edge |
| Water | mirror-flat or plastic, waves not travelling downstream, no depth colour ramp, no refraction, no sun glitter, foam as a hard white line, seams between chunks, z-fighting at the bank |
| Terrain & materials | visible texture tiling, one flat green, no wet band at the waterline, stair-stepping, rocks reading as spheres, no macro colour variation |
| Vegetation | cardboard cutouts, no wind, uniform scale/rotation/colour, obvious billboard rotation popping, reeds not standing in plausible depth, silhouettes mushy against the sky |
| Character (duck) | reads as spheres and cones, plumage as noise not feathers, dead eyes, snapping animation, sliding on the water instead of floating, no wet/dry change, feet not paddling correctly |
| Composition & camera | duck badly framed, horizon dead centre, camera clipping geometry, nothing in the foreground, dead still frame, FOV distortion |
| Colour & grade | greyed out, oversaturated, no warm/cool separation, crushed blacks, blown highlights, a single hue dominating |
| Post & finish | no bloom or bloom as a white smear, aliasing on the reed and duck silhouettes, DOF haloing, banding in the sky gradient, grain crawling |
| Cohesion | systems look like they were built by different people — mismatched palettes, water not reflecting the actual sky, vegetation lit differently from terrain |

## Mandatory procedure

1. Run the capture and the analyzer yourself. Do not trust a previous run.
   ```bash
   cd /home/user/duck-game
   node tools/screenshot.mjs --out shots/<label>
   node tools/analyze.mjs shots/<label>
   ```
2. **Read every PNG with the Read tool and actually look at it.** Read
   `contact.png` for the overview, then the individual shots at full size.
3. Read `report.json` (console errors, missing systems, draw calls, triangles)
   and `analysis.json` (objective flags). Objective flags are evidence, not the
   verdict — a frame can pass every statistic and still be ugly.
4. For each axis, give the score AND cite the specific shot and the specific
   region of it. "Water is a 5" is useless. "In 02-wide-river the water from the
   mid-ground to the far bank is a single unbroken teal with no glitter or
   normal detail, so it reads as painted vinyl" is a finding.
5. Write findings as **the smallest concrete change that would raise the
   score**, ordered by how much they would move the frame. Name the file that
   must change.
6. Give an overall verdict: `AAA` only if every axis is 8+ and at least four are
   9+. Otherwise `NOT_AAA`.

## The side-by-side question

You cannot download real reference frames — the sandbox has no image network
access. So do the comparison from memory, explicitly and honestly:

> Recall a specific frame from Journey or Lune (name it — e.g. the sunlit dune
> descent, the flooded sunken city, the red desert at dusk). Describe what that
> frame does with light, palette, depth and negative space. Then put our shot
> beside it in your mind and say which you would rather look at, and why.

State plainly which one is better. If ours is worse, say so and say what the
gap is. Never claim to have made a pixel-level comparison you could not make.

## Things that are automatic failures

- The frame does not render, or a system is missing/stubbed.
- Console errors in `report.json`.
- Any visible placeholder: a magenta material, an untextured grey mesh, a
  wireframe, a debug axis helper, a leftover preview object.
- Draw calls over 380 or triangles over 2.2M (the budget in CONTRACT.md).
- The duck is not visible or not correctly framed in the third-person shots.
