<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useForge } from '../../composables/useForge'
import { DOOM_PALETTE } from '../../lib/doomfire'

/**
 * The sim: the lava layer's heat simulation read back every frame and drawn one strip per channel, vent at the left and
 * toe at the right. Heat goes through the Doom palette, crust lies over it as grey, and pressure is the red line above
 * each strip. The sim only advances when the volcano draws, so the rail's Freeze, Step and Speed govern it.
 */
const { forge } = useForge()

const CHANNELS = 12 // the sim texture stacks this many channel blocks (the layer's MAX_CHANNELS)
const NATIVE_WIDTH = 512 // the canvas is about this wide in px: the zoom is the whole number nearest to it
const PRESSURE_FLOOR = 40 // the pressure line's red at no pressure, so an idle channel still shows a line
const CRUST_GREY = 150
const CRUST_ALPHA = 0.8 / 255 // a crust byte to the grey's alpha, at most 0.8
const REFRESH = 30 // frames between looks at the channel kinds and the paint time

// The Doom palette entry for every heat byte, as r, g, b: round(heat / 255 * 36), looked up once.
const HEAT = new Uint8Array(256 * 3)
for (let h = 0; h < 256; h++) HEAT.set(DOOM_PALETTE[Math.round((h / 255) * (DOOM_PALETTE.length - 1))], h * 3)

const canvas = ref(null)
const live = ref(false) // the lava layer is up and answers with its sim
const dims = ref({ along: 0, across: 0, zoom: 1, stride: 0 })
const kinds = ref([]) // each channel's kind, in the sim's block order
const cost = ref(0) // ms per frame to read the sim and draw it, over the last REFRESH frames

const names = computed(() =>
  Array.from({ length: CHANNELS }, (_, id) => ({
    id,
    kind: kinds.value.length ? (kinds.value[id] ?? 'unused') : '',
  })),
)

// Outside the reactive state: these are rewritten every frame.
let sim = null // the layer's cells as RGBA bytes: heat, crust, pressure, age
let pixels = null // the strips at the sim's own size, as ImageData
let small = null // a canvas that holds pixels until it is scaled up
let column = null // the highest pressure in each column of the strip being painted
let raf = 0
let frames = 0
let spent = 0

/** Sizes everything for a sim of this many cells: one strip per channel is the pressure row, the cells, and a gap. */
function allocate({ along, across }) {
  const zoom = Math.max(1, Math.round(NATIVE_WIDTH / along))
  const stride = across + 2
  sim = new Uint8Array(along * CHANNELS * across * 4)
  pixels = new ImageData(along, CHANNELS * stride)
  column = new Uint8Array(along)
  small = document.createElement('canvas')
  small.width = along
  small.height = CHANNELS * stride
  canvas.value.width = along * zoom
  canvas.value.height = CHANNELS * stride * zoom
  dims.value = { along, across, zoom, stride }
  readKinds()
}

function readKinds() {
  const next = forge.actions.geometry?.()?.flows?.map((f) => f.kind) ?? []
  if (next.join() !== kinds.value.join()) kinds.value = next
}

/**
 * Colours the sim's `cells` into `out`. Block `id` is rows id * across and up, GL's bottom row first, and becomes strip
 * `id`, flipped so its top row is on top: a pressure row, then the cells, then one row left clear. The pressure row
 * takes the highest pressure in its column.
 */
function paint(cells, out, along, across) {
  const stride = across + 2
  for (let id = 0; id < CHANNELS; id++) {
    const top = id * stride
    column.fill(0)
    for (let r = 0; r < across; r++) {
      let i = (id * across + r) * along * 4
      let o = (top + 1 + across - 1 - r) * along * 4
      for (let x = 0; x < along; x++, i += 4, o += 4) {
        const h = cells[i] * 3
        const a = cells[i + 1] * CRUST_ALPHA
        out[o] = HEAT[h] + (CRUST_GREY - HEAT[h]) * a
        out[o + 1] = HEAT[h + 1] + (CRUST_GREY - HEAT[h + 1]) * a
        out[o + 2] = HEAT[h + 2] + (CRUST_GREY - HEAT[h + 2]) * a
        out[o + 3] = 255
        if (cells[i + 2] > column[x]) column[x] = cells[i + 2]
      }
    }
    for (let x = 0, o = top * along * 4; x < along; x++, o += 4) {
      out[o] = PRESSURE_FLOOR + (column[x] * (255 - PRESSURE_FLOOR)) / 255
      out[o + 1] = 0
      out[o + 2] = 0
      out[o + 3] = 255
    }
  }
}

function tick() {
  raf = requestAnimationFrame(tick)
  const size = forge.actions.simSize?.()
  live.value = Boolean(size)
  if (!size) return
  const t0 = performance.now()
  if (size.along !== dims.value.along || size.across !== dims.value.across) allocate(size)
  forge.actions.readSim(sim)
  paint(sim, pixels.data, size.along, size.across)
  small.getContext('2d').putImageData(pixels, 0, 0)
  const ctx = canvas.value.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(small, 0, 0, canvas.value.width, canvas.value.height)
  spent += performance.now() - t0
  if (++frames % REFRESH === 0) {
    cost.value = spent / REFRESH
    spent = 0
    readKinds()
  }
}

onMounted(() => {
  raf = requestAnimationFrame(tick)
})
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <section class="fg-sim" aria-labelledby="fg-sim-h">
    <h3 id="fg-sim-h" class="fg-h">Sim</h3>
    <p v-if="!live" class="fg-note" aria-live="polite">
      The lava layer is not running, so there is no sim to show. It loads a moment after the page, and not at all with
      <code>?lava=0</code> or without WebGL2.
    </p>
    <p v-else class="fg-note">
      Heat through the Doom palette, crust as grey over it, pressure as the red line above each strip. Vent at the left,
      toe at the right. {{ dims.along }} × {{ dims.across }} cells a channel; {{ cost.toFixed(1) }} ms a frame to read and draw.
    </p>
    <div v-show="live" class="fg-sim-body">
      <ol class="fg-sim-names" aria-label="Channels">
        <li v-for="n in names" :key="n.id" class="fg-label" :style="{ height: `${dims.stride * dims.zoom}px` }">
          {{ n.id }} {{ n.kind }}
        </li>
      </ol>
      <canvas ref="canvas" class="fg-sim-cv" role="img" aria-label="The heat, crust and pressure of each lava channel"></canvas>
    </div>
  </section>
</template>

<style scoped>
.fg-sim {
  padding: 1rem 2.5rem 1rem 1rem; /* clear of the tuner, which is a little wider than the margin the main area leaves for it */
  overflow-x: auto;
}
.fg-sim-body {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
}
.fg-sim-names {
  flex: 0 0 5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.fg-sim-names li {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fg-sim-cv {
  display: block;
  flex: 0 0 auto;
  background: var(--color-obsidian);
  box-shadow: 0 0 0 1px var(--color-ash);
}
</style>
