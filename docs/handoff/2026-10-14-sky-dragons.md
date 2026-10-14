# Handoff: sky dragons for Mount Deathfire (2026-10-14)

For a fresh session. This repo is public, so this document holds no secrets and
no real member names. Branch `feat/sky-dragons` was cut from `feat/roster-design`
at `6b9601c` (the volcano profile work lives there). **Nothing under `src/` has
changed yet.** Everything here is design work and throwaway prototypes.

## Where we are

- Process: superpowers **brainstorming, architectural path**. Design has been
  iterated through prototypes and Bret likes the direction ("this is starting to
  look really good"). **The spec is not written.** Next: write
  `docs/superpowers/specs/2026-10-14-sky-dragons-design.md`, leave it
  **uncommitted and ask Bret to read it**, then `writing-plans`, then
  `executing-plans` (native, one fresh opus reviewer at the end).
- Bret is installing Blender in parallel (see "Blender studio track"). He chose
  to pause here and continue in a new session.

## What Bret asked for (his words)

- Background "creatures flying / gliding between the mountain peaks, just to add
  some more background life"; "a mix of small drakes with a huge rarity is fine".
- "I'd like to make the volcano look more realistic if at all possible... use
  real footage of lahar flow and lava flow for inspiration... it's still all
  going to be CGI."
- Easter egg: a rare "super explosion" similar to St. Helens, "fun easter egg
  for myself personally"; "fire on the anniversary of recorded eruptions in
  recent history, as well as a tiered randomness for the higher level
  explosions".
- Order chosen: **dragons first**, then flow/glow/sky/eruption realism, then the
  easter egg, then more ambient life. Each is its own spec, plan and build.
- On style: dragon / drake / wyrm from 40K and other fantasy, **not pterosaurs**.
- Latest direction: "draw our own dragons"; "Ancalagon the Black for inspiration
  on size"; the great wyrm "showing the wingspan vertically... dorsal side
  visible... further back in the background"; wings must attach "near to the
  shoulder joint"; "a true Wyrm, a winged dragon with no legs"; "use the small
  model from the first render to add more variety along with the more
  traditional drake looking one"; "the flapping is kinda mechanical looking, but
  we can fix that in refinement".

## Decisions so far

1. **Four models**, all drawn by us (not traced silhouettes):
   - **Drake**: traditional, side view, horned head, dorsal spines, barbed tail,
     tucked legs, bone-and-membrane wings.
   - **True wyrm**: legless, serpentine, undulating body (travelling wave),
     side view, wings off the shoulders.
   - **Small planform dragon**: top-down and symmetric (liftarn, Openclipart
     `321130`, public domain). Whole wing bends from the body. Unreadable under
     about 40 px, so only near and mid-sized flyers use it.
   - **Great wyrm** (Ancalagon scale): **dorsal (top-down) view**, wingspan
     vertical on screen, body horizontal, far back, hazed toward the sky colour,
     **glides only** (slight flex and bank, no flap). Partly hidden behind the
     cone and ridges. It needs a high lane clear of the cone.
2. Wings hinge at the **shoulder**: top of the chest, right behind the neck base,
   over the forelegs. The membrane's trailing edge runs back to the hips.
3. Ember rim light = draw an ember-coloured copy offset down by 1 to 5 px
   under the dark silhouette. No offscreen canvas needed.
4. The flap still looks mechanical. Refine later, not blocking.
5. A **Blender studio** may later produce better shape packs. The spec should
   define a shape-frame format so the engine plays shapes from either source,
   and so the engine can be built now on the 2D shapes.

## Design plan to put in the spec

- Files: `src/lib/skyDragons.js` (pure sim, warp, skyline), `src/lib/skyDragonShapes.js`
  (inline shape data; consider a lazy `import()` to keep the main bundle lean),
  a generator script for shapes, a small hook in `src/components/MountDeathfire.vue`,
  a `dragons` entry in `src/lib/fireTuning.js` plus a `FireTuner.vue` panel.
- Draw order in `draw(dt)` (`MountDeathfire.vue` around lines 615 to 867:
  1 ash, 2 caldera light, 3 rock, 4 lava flanks, 5 crater mouth, 6 plume,
  7 eruption sparks): far dragons **between steps 2 and 3** so ridges occlude
  them; the great wyrm crosses behind the cone; near dragons **after step 5**.
- Scale counts by `profileFor(route.path).density`. Caps: 4 small plus 1 giant.
  Phones (`mobile`, a `matchMedia('(max-width: 768px)')`) get fewer and no near
  layer. **None under reduced motion** (`motionAllowed()` from `src/lib/doomfire`;
  still mode draws one frame). Paused when the tab is hidden (the frame loop
  returns). FPS is 30 (`FPS` constant). Zero per-frame allocations.
- Behaviour: fly both directions, aim along travel, bank and bob, flap in bursts
  then glide, paths just above the skyline envelope with thermal lift near the
  crater and a bias to the glow band. Ember rim light for near and giant ones.
- `/` (the hero) is "the baked reference" and must render unchanged unless
  deliberately changed, so dragons are **default-on with a tuning toggle**.
- Tests: unit tests for the pure functions plus visual verification in Chrome.
- Credit: a code comment crediting the public-domain art; no footer credit is
  required.

## The prototype (throwaway, in `prototype/`)

Run: `node docs/handoff/sky-dragons/prototype/serve.mjs` (serves that folder on
port 5180), then open:

- `http://localhost:5180/own3.html?t=30&gx=430&gy=150&gs=40`: the live scene
  (sky, great wyrm, ridges, cone, drake, wyrm and planform dragons). Params:
  `t` (fixed time, paused), `t0` (start offset), `gx`, `gy`, `gs` (giant x, y,
  scale), `gdir` (1 or -1).
- `http://localhost:5180/own3s.html`: flap sheets for each model.

`own.js` API (a prototype, not production style): `spineData(P, wave)` builds a
Catmull-Rom spine with a thickness profile; `drawDragon(ctx, P, D, u, S, {swing})`
draws far wing, body, near wing, where `u` is 0 (wings up) to 1 (wings down);
`SWIFT` and `WYRM` are the parameter sets (units: 1 = hips to shoulder, x
forward, y down); `wyrmWave(t, amp)` is the body wave; `drawDorsal(ctx, S,
{flex, bank})` is the great wyrm; `warpPlan` and `drawPlan` are the planform
dragon. Orientation lessons: for side-view models, translate, then
`scale(flip, 1)`, then `rotate(pitch)` with `pitch = atan2(vy, |vx|)`; planform
art has its head up, so rotate by heading plus 90 degrees and foreshorten the
span about 0.8. `drakes2.html` holds the older proven techniques: planform
arc-bend flap, and rigid-piece wings for the ragged GDJ wyrm (smooth warps tear
it). `dragons.json` is the polygon data converted from the Openclipart SVGs in
`prototype/openclipart/` (`321130` liftarn planform, `315379` GDJ ragged wyrm).
FreeSVG files embed an outline-text credit line (about 44 tiny glyph paths):
filter paths smaller than about 3.5% of the canvas. `svg2shapes.cjs` and
`svg2pts.cjs` are the converters (SVG to RDP-simplified polygons).

Known weak spots and refinements:

- The flap is mechanical; add secondary motion (membrane lag, tail follow-through).
- The wings-up pose of small drakes reads fan-like.
- The wyrm's tail barb can look detached where the tail is very thin.
- The planform dragon is unreadable under about 40 px.
- **Not tested yet:** the real site canvas colours (the prototype sky is a
  stand-in), real-time motion and frame rate on the real page, mobile cost.
  Dark silhouettes vanish on a dark sky unless they fly in the glow band, so
  route them there and tune on the real canvas.

## Blender studio track

- Bret is installing Blender (`winget install BlenderFoundation.Blender`).
  Confirm `blender --background --python script.py` works first: that is the
  repeatable production path and needs no MCP.
- MCP, verified 2026-10-14: PyPI `mcp-for-blender` 2.1.9 (uploaded 2026-10-06),
  author Siddharth Ahuja, repo `github.com/ahujasid/blender-mcp`, MIT, about 30k
  stars; older name `blender-mcp` is 2.0.0. Tools: `execute_blender_code`,
  `look` (viewport shots, multi-angle sheets, animation frames),
  `get_scene_info`, `search_assets` / `import_asset` (Poly Haven, Sketchfab, Poly
  Pizza), `generate_3d` (AI generators; skip, API keys and murky licences).
  Install **not yet done**. When Bret agrees:
  `claude mcp add blender -e DISABLE_TELEMETRY=true -- uvx mcp-for-blender`, and
  `uvx mcp-for-blender install-addon`, then enable the add-on in Blender and
  press Start MCP Server. Telemetry is **on by default** (anonymous usage; the
  README says data may train AI models), so set `DISABLE_TELEMETRY=true`.
  `execute_blender_code` runs arbitrary Python on a socket with no
  authentication: keep it on localhost, save work first, consider
  `BLENDER_MCP_SAFE_MODE=1`. Do **not** use the `irm | iex` one-liner installer
  from a different domain. `uv` and `uvx` are already installed.
- Pipeline idea: rig a dragon (wing bone chain, membrane following), render flat
  black silhouettes headless per flap frame and angle, trace to polygons (the
  converters here), ship compact shape frames, draw polygons on the canvas.
  Sources: build procedurally with `bpy` and let Bret sculpt on top. CC0
  references: Cethiel's Dragon (`opengameart.org/content/cethiels-dragon-3d`,
  CC0, rigged and animated, cartoony, flight cycle unconfirmed) and a CC0
  flying-dragon `.blend` with an adjustable flight path
  (`opengameart.org/node/96662`, not yet opened). Verify CC0 on each page.
  Avoid CC-BY-SA models.
- Candid expectation: an LLM sculpting organic dragons through text gets
  primitive results. The gain is the rig (real flap), arbitrary views from one
  model, and Bret's art direction. At 40 to 150 px most detail is invisible;
  it shows on the great wyrm, near dragons and the outlines of wings, horns and
  spines.
- Open questions for Bret: does he want to model by hand too, or art-direct
  while the assistant drives; and should the engine and spec go ahead on the
  current 2D shapes meanwhile (the recommendation).

## Volcano realism notes (for the later specs)

From real public-domain USGS footage (ffmpeg works from PowerShell:
`C:\Users\Bret\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe`):

- Night sky is **blue-violet**, not green-black. The plume is orange-lit from
  beneath. The fountain core is yellow-white. Channels go yellow-white at the
  vent, orange, then red downstream, with wide dark-grey crusted shoulders full
  of fine orange crack lines and rippled crust, and white steam at vents. Glow
  is a thin ribbon on mostly black ground. The 1980 ash column has a billowing
  "cauliflower" texture.
- USGS colour scale: yellow about 1000 to 1200 C, orange 800 to 1000, red 600 to
  800, black cooled.
- Footage (public domain): fissure 8 fountain `multimediaFile-2213.mp4`, aerial
  channel `multimediaFile-2337.mp4`, the 1980 documentary `msh_1980.mp4`, Swanson
  1980 aerial film (21 min) at
  `usgs.gov/media/videos/mount-st-helens-eruption-may-18-1980`, 4K lava lake
  `HVOKilaueauVentLake.mp4` (3.2 GB; stream frames only). Lahar photos still to
  find (licences vary; USGS fact sheet 2018-3024, Pinatubo "Fire and Mud").
- Easter egg facts: St. Helens M5.1 quake at 8:32 a.m. PDT on May 18, 1980; north
  flank collapse, lateral blast, vertical Plinian column; **57 people died**.
  Keep it tasteful: an optional quiet memorial line, no strobing, nothing under
  reduced motion. Anniversaries to consider: St. Helens May 18 (flagship),
  Pinatubo June 15 1991, Hunga Tonga Jan 15 2022. Exact list and tiers go in
  that feature's own spec. Bret is a Washington local.

## How Bret likes to work

- He asked for the terse **caveman** style; it stays active until he says "stop
  caveman" or "normal mode" (drop it only for security warnings and
  irreversible-action confirmations).
- Brainstorm before building: classify the path, present the design, wait for
  approval; one question at a time. He also asked for **frontend-design**.
- Ask him to fix blockers (installs, sign-ins) instead of working around them;
  give candid opinions. **Do not commit or push without his say-so.**
- Skill sourcing: Anthropic first-party, else most-installed and trusted; read
  before install. Dispatch subagents sized to the job (haiku transcription,
  sonnet integration/review floor, opus security and final review).
- No local Docker: e2e, compose and DB checks run on the Vulkan server.
- Test and commit command prefix (Node v26 quirk, and the shell inherits
  `VITE_ROSTER_FIXTURE=1`):
  `env -u VITE_ROSTER_FIXTURE NODE_OPTIONS=--no-experimental-webstorage <command>`.
  The pre-commit hook runs the full suite plus the leak guard; the pre-push hook
  adds coverage and mutation. Never `--no-verify`. Commits end with
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Shell: backslash escapes get mangled through heredocs and `node -e`; use the
  Write and Edit tools for files with backslashes or long content.
- The auto-memory directory has the same background
  (`volcano-life-and-realism.md` and others).

## Roster branch status (separate work)

`feat/roster-design` (18 commits, base `b7c85cd`) was pushed on 2026-10-14. No PR
is open. Still pending on it: Bret's merge or PR decision; the real-page
measurements listed in `docs/handoff/2026-10-13-roster.md` (needs a Chrome window
in front); three new e2e specs that run on Vulkan only; seven deferred minors
(findMe `openableKeys` check, screen-reader re-announce, `flash()` animationend
target, status-link touch size, pin clamp if the actions row is sticky,
`backdrop-filter` mobile cost, avatar `@error`).
