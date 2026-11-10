# Reference frames for the volcano

The images themselves live in `docs/design/refs/` (gitignored: large, and re-fetchable) and show in the forge
playground's Refs tab (`/dev/forge`, dev only). All four are USGS, public domain. Look at a real frame before drawing
a natural phenomenon, and say which one.

| File | Source | What it teaches |
|---|---|---|
| `usgs-kilauea-2018-06-12-braided-channels.png` | [Kīlauea Volcano — Braided Lava Channels](https://www.usgs.gov/media/images/kilauea-volcano-braided-lava-channels), 2018-06-12 | Channels are wide against their length. The surface is grey crust netted with fine orange crack lines; the glow is brightest along the margins where the lava shears on the bank. Channels braid around dark crusted islands and rejoin. The dark crust shoulders are far wider than the channel. The fountain at the vent is the brightest thing in the frame. |
| `usgs-kilauea-2018-07-10-braided-section-aerial.png` | [Aerial view of the braided section of the fissure 8 lava channel](https://www.usgs.gov/media/images/aerial-view-braided-section-fissure-8-lava-channel-captured-dur), 2018-07-10 | The same from higher: a braid is two channels around one island, each narrower than the trunk, with the island's crust darker than the levees. |
| `usgs-mauna-loa-2022-12-08-fissure-3-channel.png` | [December 8, 2022 — Mauna Loa fissure 3 and lava channel](https://www.usgs.gov/media/images/december-8-2022-mauna-loa-fissure-3-and-lava-channel), T. Orr | One wide channel from the vent, red-orange, between grey rubble levees. Crust plates drift mid-stream; the margins are the bright edges. The flow is a river, not a wire: its width is a real fraction of its visible length. |
| `usgs-mauna-loa-2022-12-01-fissure-3-fountain.png` | [December 1, 2022 — Mauna Loa Fissure 3](https://www.usgs.gov/media/images/december-1-2022-mauna-loa-fissure-3), D. Downs | The vent: a spatter rampart, a yellow-orange fountain, white steam, and a sulphur-tinted plume lit from below. The channel leaves the rampart to one side, not from its top. |
| `nasa-eo-waimakariri-2015-10-17-braided.jpg` | [New Zealand: Where River and Winds Weave](https://science.nasa.gov/earth/earth-observatory/new-zealand-where-river-and-winds-weave-89616/), NASA Earth Observatory image by Joshua Stevens, Landsat 8 OLI, 2015-10-17, public domain | A braided river from above (the upper left of the frame, where it leaves the hills). The strands are thin against the gravel bed they wander in, split and rejoin at shallow angles, and the ground between two strands closes to a point where they meet. A tributary comes in at a shallow angle and the river below the join is wider, not twice as wide. No strand ends in open ground: each one rejoins or reaches the sea. |
| `usgs-halemaumau-2021-01-19-lake-channel-evening.jpg` | [Lava lake on the evening of January 19, 2021](https://www.usgs.gov/media/images/lava-lake-evening-january-19-2021), USGS photo by H. Dietterich, public domain | A lava lake at dusk. The surface is mostly grey crust broken into plates by a net of thin orange seams; the one bright thing is the inlet at the left, a short fountain and a channel a few plates long, with a fan of brighter seams spreading from it. The far shore is dark and grey. The glow is local to where lava arrives, and the lake lights the crater wall above it, not the whole frame. |

What the heat sim taught against these (2026-11-09): simulated heat alone gives an established channel one even orange core, which no frame shows; the Kilauea frame's netted grey skin and the Mauna Loa frame's open red with hot spots both come from a skin carried rigidly on the core, closing as the sim cools, while the sim keeps the banks crusted and the breach and pool the brightest.

Heat colours (USGS): yellow about 1000-1200 C, orange 800-1000, red 600-800, black when cooled.

Night sky from the earlier footage notes: blue-violet, not green-black; the plume is orange-lit from beneath; the
fountain core is yellow-white; channels go yellow-white at the vent, orange, then red downstream; the glow is a thin
ribbon on mostly black ground.

What the network pass must take from the two 2026-11-09 frames: confluences at shallow angles with the ground between feeders closing to a point, widths that add below a join without doubling, every strand ending in a join or the pool; and a pool that is crusted grey netted with orange seams, hot only in a fan where the trunk enters, dark at the far shore.
