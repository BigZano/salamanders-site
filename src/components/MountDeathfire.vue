<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { forge, forgeAdvance, forgeSample, devNumber } from '../lib/forge'
import { useRoute } from 'vue-router'
import { motionAllowed } from '../lib/doomfire'
import { buildNetwork } from '../lib/lavaNetwork'
import { mulberry32, hashString, peakHeight, buildMountain, faceFor, REF } from '../lib/mountain'
import { fireTuning, randomize, profileFor, profileKeyFor, NEUTRAL_PROFILE, DEFAULTS } from '../lib/fireTuning'
import { deathfireHeat } from '../lib/deathfireHeat'
import { bucketFor, plateSlug, fitPlate, mapMountain, anchorFor } from '../lib/plate'
import { createPlateLoader, plateState } from '../lib/plateLoader'

/**
 * Mount Deathfire — the great volcano of Nocturne, sitting behind every page.
 *
 * Built procedurally rather than drawn, so it costs nothing to ship and adapts
 * to any viewport: a basalt cone with a lit caldera, lava running down the
 * flanks, a plume of sparks off the summit, and ash falling through it all.
 *
 * The peak is deliberately set off-centre so it never sits directly behind the
 * centred hero wordmark, and the whole thing is anchored low — this is the
 * horizon of the world the site lives on, not the subject of the page.
 *
 * The landing page is the baked reference: fireTuning's DEFAULTS describe it
 * exactly. Every other route is a departure from it, declared as a profile of
 * bearing (where you stand), variance (how far the seeded detail strays) and
 * density (how loud the plume, ash and sky are). The hero's profile is
 * 0 / 1 / 1, which is neutral in every expression below — so `/` consumes the
 * identical sequence of seeded random numbers it did before profiles existed
 * and renders unchanged. Keep it that way when editing here.
 *
 * Where a 3D-rendered plate exists for the route and the window's shape (lib/plate, lib/plateLoader; made offline from this
 * same mountain data), it is drawn over the painted sky and rock: the sky plate before the moon, the rock plate where the
 * painted rock is, with the mountain taken from the plate's own sidecar so the lava, lip, plume and ash sit on the plate's
 * rock. Everything else is as it was. Where there is none (nothing yet, a route with no plate of its own is given the default
 * one, a plate that fails to load or to make sense), the painted rock is all there is, and nothing says otherwise.
 */

const tune = fireTuning.bed

const host = ref(null)
const canvas = ref(null)
const glowEl = ref(null)
// Pages flagged meta.ashOver (the archive) get the near ash on a second
// canvas above their content, so it drifts across the page, not behind it.
const veil = ref(null)
const mode = ref('off')

const FPS = 30

let raf = 0
let stopped = false
let last = 0
let t = 0
let hidden = false

let mountain = null // { peak, left, right, profile, crater }
let ridges = [] // distant silhouettes, for depth
let flows = [] // lava running down the flanks
let fissures = [] // the cracks the flank streams start from: { x, y, rows, tilt, len, bloom, heat }, the lower end first
let lavaPool = null // the pool at the foot of the cone every stream ends in: { cx, cy, rx, ry, arcTop, arcY(x) }, or null
let joins = [] // where a tributary meets the trunk, for the lava layer's fillets
let lava = null // the WebGL lava layer (lib/lavaShader), once loaded; null while loading and where WebGL2 is missing
let lavaFade = 0 // how much of the channels the shader paints, 0 (the ribbons alone) to 1; rises over a second
let lavaWanted = false // cleared on unmount, so a chunk that arrives late does not build a layer for a gone volcano
let lip = null // the molten lip along the crater rim, brimming over
let moon = null // Prometheus: { sprites: [lit from below-right, lit from below-left], r }
let calmRects = [] // where reading text sits over the canvas, in viewport pixels, as of calmScroll
let calmScroll = 0
let calmShift = 0 // how far the page has scrolled since the text was measured
let calmAt = -1 // when the text was last measured, in seconds
// One Nocturne year, in the lore the moon's closest pass and the Time of Trial, is 15 Terran years; here 15 minutes.
const CYCLE_MS = 15 * 60 * 1000
let lastCycle = -1 // the cycle whose closest pass has been seen
let trialAt = -1 // seconds into the Time of Trial in progress; -1 when none
let trialTier = 1 // 1 a trial, 2 a great trial, 3 a cataclysm
let trialClock = 0 // seconds until the blast throws again

/** Where the moon is in its cycle, 0 to 1. The sky is shared: it follows the clock, so every visitor sees the same moon. */
function moonPhase() {
  // The forge playground can pin the phase; otherwise ?moon=0.5 puts the moon at its closest pass on load (dev only).
  if (forge && forge.moon !== null) return { cycle: 0, phase: forge.moon % 1 }
  const dev = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('moon') : null
  if (dev !== null && Number.isFinite(parseFloat(dev))) return { cycle: 0, phase: parseFloat(dev) % 1 }
  const now = Date.now()
  return { cycle: Math.floor(now / CYCLE_MS), phase: (now % CYCLE_MS) / CYCLE_MS }
}

/** How hard the Time of Trial is raging, 0 to 1, eased in, held, and let go slowly. Nothing flashes. */
const trialLength = (tier) => 6 + (6 + 8 * tier) + (30 + 10 * tier)
function trialLevel(sec, tier) {
  const rise = 6
  const hold = 6 + 8 * tier
  const fall = 30 + 10 * tier
  const peak = [0, 0.55, 0.8, 1][tier]
  if (sec < rise) return peak * sstep(sec / rise)
  if (sec < rise + hold) return peak
  return peak * (1 - sstep((sec - rise - hold) / fall))
}
let spits = [] // lava spat up off the lip, and bubbles popping on it
const SPIT_MAX = 18
let silhouette = null // cached painted cone, redrawn only on resize
let farRidges = null // cached far ridges, their own layer so a plate's rock can go over them; redrawn only on resize
// The 3D plate (lib/plate, lib/plateLoader), when there is one for this route and window shape. The loader is the page view's:
// what it has failed to get it does not ask for again.
const plateLoader = createPlateLoader({ base: `${import.meta.env.BASE_URL}plates/` })
const plateFade = plateState()
let plate = null // the plate in use: { id, sky, rock, sidecar, fit }. null is the painted rock alone
let plateWanted = '' // `slug/bucket` of the plate last asked for, so a layout asks again only when the plate it wants has changed
let plateToken = 0 // bumped for every ask: an answer that comes back under an older one belongs to a page or a window shape we have left
let plateSnap = false // the plate arrived under reduced motion (or on a frozen playground): it is drawn whole, with no fade
let cancelPrefetch = null // takes back the idle prefetch if the page goes first
let drift = [] // continuous sparks/embers off the summit
let burst = [] // sparks thrown by an eruption pulse
let ashBack = [] // ash falling behind the rock
let ashFront = [] // ash falling between the rock and the viewer
let spriteGlow = null
let nextPulse = 0
let relayoutPending = 0
let resizeObserver = null
let lastW = 0
let lastH = 0

// Runtime randomness — particles, which should never repeat.
const rand = (a, b) => a + Math.random() * (b - a)

/** The area of the viewport the tuning panel's numbers were dialled in against (REF, in lib/mountain). */
const REF_AREA = REF.w * REF.h

const route = useRoute()
const ashOver = computed(() => !!route.meta?.ashOver)
let rng = mulberry32(1)
/** Seeded generation randomness. */
const grand = (a, b) => a + rng() * (b - a)

/**
 * This route's departure from the hero. Held as a plain binding rather than
 * read through the reactive store inside the build functions, so a whole
 * mountain is always generated against one consistent profile.
 */
let prof = NEUTRAL_PROFILE

// Where this page's peak sits, derived from the route seed around tune.offsetX.
// Reactive so the painted sky glow follows it.
const face = ref(0.5)
let faceOffset = 0.5

/**
 * Reseed for the current route: its profile, its seeded stream and where its peak sits (faceFor, in lib/mountain, which
 * also says how the position is made up).
 */
function seedForRoute() {
  prof = profileFor(route.path)
  const r = faceFor({ path: route.path, tune, prof, randomize })
  rng = r.rng
  faceOffset = r.face
  face.value = faceOffset
}

// Read through profileFor rather than the `prof` binding so the painted sky
// tracks a profile edit in the tuning panel without waiting for a rebuild.
const glowStyle = computed(() => {
  // x1.4: the layer's opacity runs 0.62 to 1 with the caldera's breathing and flare (see draw), so the gradient has headroom
  const g = tune.glow * profileFor(route.path).density * 1.4
  return {
    // Two layers: the glow at the foot of the cone, and a faint wash over the heavens above the crater, orange
    // at the heart and sulphur-ochre toward its edge.
    background: `radial-gradient(90% 55% at ${(face.value * 100).toFixed(0)}% 100%,
    rgba(224, 67, 29, ${g.toFixed(3)}),
    rgba(150, 35, 15, ${(g * 0.35).toFixed(3)}) 40%,
    transparent 76%),
    radial-gradient(80% 62% at ${(face.value * 100).toFixed(0)}% 30%,
    rgba(255, 112, 36, ${(g * 0.17).toFixed(3)}),
    rgba(176, 128, 34, ${(g * 0.09).toFixed(3)}) 48%,
    transparent 78%)`,
  }
})

function makeGlow() {
  const s = 64
  const cv = document.createElement('canvas')
  cv.width = cv.height = s
  const g = cv.getContext('2d')
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  // Yellow-white at the heart (about 1100 C), not pure white: added to the dark sky, white reads as a moon.
  grd.addColorStop(0, 'rgba(255,238,190,1)')
  grd.addColorStop(0.18, 'rgba(255,190,110,0.9)')
  grd.addColorStop(0.45, 'rgba(255,106,43,0.42)')
  grd.addColorStop(0.75, 'rgba(224,67,29,0.12)')
  grd.addColorStop(1, 'rgba(180,40,18,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, s, s)
  return cv
}

/**
 * Prometheus, Nocturne's oversized moon, painted as Io, the most volcanically active world we know (the Galileo and
 * Juno images: sulphur-ochre plains in broad bands, pale frost, rust-red plume fallout, dark paterae with ragged
 * edges and no raised rims). Painted once at layout, pixel by pixel, as a lit sphere: the light is the caldera's,
 * from below and to the left, so the face turned to the volcano is lit and the far side falls softly into the
 * sky's own dark, never to black. The terrain is noise on the sphere's surface, so it stretches toward the limb as a
 * sphere's does, and the edge fades over its last two percent so the disc is not a cut-out. Sized for its closest
 * pass; the draw loop scales it.
 */
function buildMoon(w, h) {
  const r = Math.max(20, Math.min(w * 0.11, h * 0.14))
  const size = Math.ceil(r * 2)
  // Two bakes of the same terrain: lit from below-right while the moon is left of the summit, from below-left once it
  // has crossed. The draw loop fades between them as it passes, so the lit face always turns toward the crater.
  const lights = [
    [0.55, 0.72, 0.4],
    [-0.55, 0.72, 0.4],
  ].map(([x, y, z]) => {
    const l = Math.hypot(x, y, z)
    return [x / l, y / l, z / l]
  })
  const sprites = lights.map(() => {
    const cv = document.createElement('canvas')
    cv.width = cv.height = size
    const g = cv.getContext('2d')
    return { cv, g, img: g.createImageData(size, size) }
  })
  const rr = mulberry32(0x10ba)
  // paterae: five dark floors with ragged edges, in all sizes; the two largest keep a dim hot floor and a fallout stain
  const pats = []
  for (let i = 0; i < 5; i++) {
    const a = rr() * Math.PI * 2
    const d = Math.sqrt(rr()) * 0.78
    pats.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, s: i < 2 ? 0.13 + rr() * 0.06 : 0.03 + rr() * 0.06, seed: rr() * 40, hot: i < 2 })
  }
  const sky = [14, 9, 8]
  const sm = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const nx = (i + 0.5 - r) / r
      const ny = (j + 0.5 - r) / r
      const d2 = nx * nx + ny * ny
      if (d2 >= 1) continue // outside the disc: alpha stays 0
      const o = (j * size + i) * 4
      const nz = Math.sqrt(1 - d2)
      // terrain on the sphere's surface, large to small: regions, bands, mottling, frost
      const sx = nx / (nz + 0.35)
      const sy = ny / (nz + 0.35)
      const region = vnoise(sx * 1.4 + 40, sy * 1.4 + 40) // bright and dark provinces
      const band = vnoise(sx * 0.7 + 3.1 + region, sy * 2.6 + 7.7) // broad bands of sulphur deposit, wandering
      const mott = vnoise(sx * 3 + 11, sy * 3 + 5) * 0.65 + vnoise(sx * 7 + 2, sy * 7 + 9) * 0.35 // mottling
      const frost = vnoise(sx * 5 + 21, sy * 5 + 17)
      // sulphur ochre in the bright provinces, rust and brown in the dark, frost where the fine noise peaks
      const tone = 0.55 + 0.45 * region
      let R = (140 + 80 * band - 30 * (1 - mott)) * tone + 20
      let G = (90 + 78 * band - 34 * (1 - mott)) * tone + 10
      let B = (30 + 28 * band - 14 * (1 - mott)) * tone + 6
      if (frost > 0.66) {
        const f = ((frost - 0.66) / 0.34) * 0.75 * tone
        R += (226 - R) * f
        G += (214 - G) * f
        B += (180 - B) * f
      }
      for (const p of pats) {
        const dx = nx - p.x
        const dy = ny - p.y
        const dd = Math.sqrt(dx * dx + dy * dy)
        if (dd > p.s * 2.6) continue
        const ang = Math.atan2(dy, dx)
        // the floor's edge wanders gently around the crater: noise over the angle, so it closes on itself
        const edge = p.s * (0.7 + 0.5 * vnoise(Math.cos(ang) * 1.3 + p.seed, Math.sin(ang) * 1.3 + p.seed))
        if (p.hot) {
          // plume fallout: a broad rust-red stain
          const stain = sm((p.s * 2.6 - dd) / (p.s * 1.8)) * 0.4
          R += (160 - R) * stain
          G += (52 - G) * stain
          B += (28 - B) * stain
        }
        const k = sm((edge - dd) / (p.s * 0.45)) * 0.75 // 1 inside, 0 outside, a soft edge
        if (k > 0) {
          R += (40 - R) * k
          G += (22 - G) * k
          B += (14 - B) * k
        }
        if (p.hot) {
          // a hot dot at the floor's heart
          const hk = sm((p.s * 0.2 - dd) / (p.s * 0.12)) * 0.8
          R += (240 - R) * hk
          G += (110 - G) * hk
          B += (30 - B) * hk
        }
      }
      // the limb: a soft edge over the last two percent of the radius
      const alpha = 255 * sm((1 - Math.sqrt(d2)) / 0.025)
      for (let k = 0; k < 2; k++) {
        const [lx, ly, lz] = lights[k]
        const px = sprites[k].img.data
        // lighting: Lambert with a little wrap, squared for a firm terminator; the dark side falls to the sky, not black
        const ndl = nx * lx + ny * ly + nz * lz
        const lit = Math.max(0, Math.min(1, (ndl + 0.18) / 1.18))
        const lum = 0.05 + 0.95 * lit * lit
        // and the warm rim where the limb faces the crater
        const rim = Math.pow(1 - nz, 3) * Math.max(0, ndl) * 0.55
        px[o] = sky[0] + (R - sky[0]) * lum + 255 * rim
        px[o + 1] = sky[1] + (G - sky[1]) * lum + 140 * rim
        px[o + 2] = sky[2] + (B - sky[2]) * lum + 70 * rim
        px[o + 3] = alpha
      }
    }
  }
  for (const s of sprites) s.g.putImageData(s.img, 0, 0)
  return { sprites: sprites.map((s) => s.cv), r }
}

/** Lower, dimmer cones behind the main peak so the horizon has depth. */
function buildRidges(w, h) {
  const count = Math.max(0, Math.round(tune.ridges))
  return Array.from({ length: count }, () => {
    const height = peakHeight(h, prof.scale, tune.height) * grand(0.22, 0.42)
    // Bias away from the main peak so the far range isn't swallowed by it.
    const side = rng() < 0.5 ? -1 : 1
    const parallax = randomize.ridges ? grand(-0.18, 0.18) * prof.variance : 0
    const peakX = (faceOffset + side * grand(0.32, 0.72) + parallax) * w
    const halfBase = grand(w * 0.16, w * 0.4)
    const pts = []
    const steps = 14
    for (let i = steps; i >= 0; i--) {
      const f = i / steps
      pts.push({
        x: peakX - (Math.pow(f, 1.4) * halfBase),
        y: h - height + f * height + grand(-1, 1) * height * 0.05,
      })
    }
    for (let i = 0; i <= steps; i++) {
      const f = i / steps
      pts.push({
        x: peakX + Math.pow(f, 1.4) * halfBase,
        y: h - height + f * height + grand(-1, 1) * height * 0.05,
      })
    }
    return { pts, depth: grand(0.45, 0.85) }
  })
}

/** A small irregular rock silhouette, in unit space — scaled and rotated at draw time. */
function buildRockShape() {
  const n = 5 + ((rng() * 2) | 0)
  const pts = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const r = 0.7 + rng() * 0.4
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r })
  }
  return pts
}

/**
 * Riders on a flow: dark rock chunks, rafts of crust carried along. They move
 * along the channel's own point list over time rather than drawn as part of
 * the static line. `u` is 0 at the crater end, 1 at the base, and wraps back
 * to 0 — an endless procession rather than a one-shot particle.
 * (The glow inside a channel is not a rider: it is a pattern of crust windows, see the lava pass in draw.)
 */
function buildRiders(lo = 3, hi = 7) {
  return {
    // Rafts of crust: three to seven on a trunk, one or two on a branch, spread along it at random and in all sizes,
    // so it reads as scattered rockfall and not a pattern. About one in five is a big slab.
    chunks: Array.from({ length: lo + ((rng() * (hi - lo + 1)) | 0) }, () => ({
      boost: 0, // extra speed from being thrown out by a blast; it dies away
      u: rng(),
      speed: grand(0.0007, 0.0014), // rock is heavier than the glow riding past it
      size: rng() < 0.2 ? grand(4.5, 7) : grand(1.8, 4.5),
      angle: grand(0, Math.PI * 2),
      spin: grand(-1.4, 1.4),
      shape: buildRockShape(),
    })),
  }
}

/**
 * Lava spat up off the crater lip ("lava spat and bubbled", Lords of Nocturne), and bubbles that burst on it. A glob is
 * thrown up from a random point on the lip and falls back under gravity; a bubble swells to a bright flash and goes.
 * Both scale with the crater, and thin out on the pages that are mostly reading.
 */
function spawnSpit(m) {
  const p = lip.pts[(Math.random() * lip.pts.length) | 0]
  const k = m.craterHalf / 90
  const bubble = Math.random() < 0.4
  return bubble
    ? { bubble: true, x: p.x, y: p.y, vx: 0, vy: 0, age: 0, life: rand(0.35, 0.7), size: rand(5, 11) * k }
    : { bubble: false, x: p.x, y: p.y, vx: rand(-0.7, 0.7) * k, vy: -rand(1.4, 3.8) * k, age: 0, life: rand(0.6, 1.5), size: rand(1.2, 2.8) * Math.max(0.7, k) }
}

/**
 * The crater lip: a molten edge along the rim that is rough, uneven and different on every route. A slow
 * undulation, crags and a little grit are stacked, tapering to nothing at both corners so the ends meet the rock
 * outline exactly; some stretches burn brighter than others, as a crust forms and breaks. It has its own random
 * stream, so the seeded one that shapes the mountain is not touched, and a resize redraws the same lip.
 * `base` is the resting line; the draw loop heaves `pts` around it.
 */
function buildLip(m) {
  const r = mulberry32(hashString(route.path || '/') ^ 0x11b5)
  const n = 64
  const bump = Math.max(2.5, m.craterHalf * 0.11)
  // The pool fills the breach to half its depth. Its surface runs from wall to wall at that level; the walls below
  // the surface close the pool's shape.
  const level = m.mouthL.y + m.valleyDepth * 0.5
  const cross = (a, b) => ({ x: a.x + ((b.x - a.x) * (level - a.y)) / (b.y - a.y || 1), y: level })
  const v = m.valley
  let iL = 0
  while (iL < v.length - 1 && v[iL + 1].y < level) iL++
  let iR = v.length - 1
  while (iR > 0 && v[iR - 1].y < level) iR--
  const L = cross(v[iL], v[iL + 1])
  const R = cross(v[iR], v[iR - 1])
  const walls = v.slice(iL + 1, iR) // the valley points under the surface, left to right
  const coarse = Array.from({ length: 9 }, () => r())
  const crags = Array.from({ length: 24 }, () => r())
  const at = (arr, u) => {
    const x = u * (arr.length - 1)
    const i = Math.floor(x)
    const f = x - i
    return arr[i] + (arr[Math.min(arr.length - 1, i + 1)] - arr[i]) * (f * f * (3 - 2 * f))
  }
  const pts = []
  const w = []
  for (let i = 0; i <= n; i++) {
    const u = i / n
    const edge = Math.sqrt(Math.sin(Math.PI * u))
    const lift = (at(coarse, u) * 0.55 + at(crags, u) * 0.35 + r() * 0.35 - 0.3) * edge
    w.push(edge)
    pts.push({
      x: L.x + (R.x - L.x) * u + (r() - 0.5) * m.craterHalf * 0.014 * edge,
      y: level - lift * bump,
    })
  }
  const stops = Array.from({ length: 13 }, (_, i) => [i / 12, 0.4 + r() * 0.6])
  return { pts, base: pts.map((p) => ({ x: p.x, y: p.y })), w, stops, walls }
}

/** The lip's bloom, body and core as horizontal gradients whose strength varies along the rim. */
function lipGlow(ctx, lip, m) {
  const make = (rgb) => {
    const g = ctx.createLinearGradient(m.mouthL.x, 0, m.mouthR.x, 0)
    for (const [at, a] of lip.stops) g.addColorStop(at, `rgba(${rgb},${a.toFixed(2)})`)
    return g
  }
  return { bloom: make('255,106,43'), body: make('255,154,77'), core: make('255,212,138') }
}

/** Trace the stretch of a flow between fractions `lo` and `hi` of its length onto the current path. */
function traceSlice(ctx, f, lo, hi) {
  const nSeg = f.pts.length - 1
  const start = pointOnFlow(f, lo)
  ctx.moveTo(start.x, start.y)
  for (let k = Math.floor(lo * nSeg) + 1; k < hi * nSeg; k++) ctx.lineTo(f.pts[k].x, f.pts[k].y)
  const end = pointOnFlow(f, hi)
  ctx.lineTo(end.x, end.y)
}

/**
 * Lava running down the face of the cone as a network, as the USGS record of Kilauea 2018 and Mauna Loa 2022 shows it:
 * the breach stream is the trunk, a rim overflow and flank fissures start streams of their own, tributaries meet the trunk
 * at a shallow angle and the trunk widens below each join, and every stream that is left ends in the pool at the foot.
 * Where they run, how wide they are and where they meet is lib/lavaNetwork's (pure, and tested without a canvas); this
 * keeps what the page draws from it. Each channel is a segment: a centreline (`pts`), a width profile along it
 * (`widthAt`), and three ribbons built from both, the body, the core and the crust skin over it. The ribbons are the
 * fallback where the WebGL layer is not running. There are no painted banks: the layer's strips and its heat sim make
 * the banks (the crusted outer rows), so a channel here is only the lava.
 *
 * `fissures` (the cracks the flank streams start from), `lavaPool` and `joins` are set beside the flows, from the same
 * network, and the layer is handed the last two. A trunk starts at the mouth (`head`).
 *
 * `prev` is the outgoing flow list, if any. The geometry doesn't need it: the seed is fixed per route, so re-running
 * this after a resize retraces the same network against the new mountain. But the riders (buildRiders) use unseeded
 * progress so rockfall and the crust pattern never repeat in lockstep, and without carrying that progress across,
 * every rider would snap back to a fresh random position the moment the window resizes.
 */
function buildFlows(prev, w) {
  const out = []
  fissures = []
  joins = []
  lavaPool = null
  // tune.flows used to be the number of distributaries; the network decides that now (a phone gets a trunk and one
  // fissure), so it is only the switch for the lava: 0 puts it out.
  if (!Math.round(tune.flows)) return out
  // The seeded rng is reassigned for each route (seedForRoute, which has already run), so it is read through a wrapper.
  const net = buildNetwork(mountain, { w, h: lastH, phone: isPhone(), rng: () => rng() })
  // A stream with no length would shift the indices the drains and the joins name; the network never makes one.
  if (!net.flows.length || net.flows.some((f) => f.pts.length < 2)) return out

  const push = (nf) => {
    const { pts, widthAt, head } = nf
    // The glow is sampled at GLOW_STOPS places along the channel. Where each sits in the pattern, how much crust it
    // carries (little near the vent, more toward the toe), and its heat colours depend only on its place: worked out once.
    const phs = new Float32Array(GLOW_STOPS)
    const thrs = new Float32Array(GLOW_STOPS)
    const bodyA = new Float32Array(GLOW_STOPS * 4)
    const coreA = new Float32Array(GLOW_STOPS * 4)
    const gx = new Float32Array(GLOW_STOPS)
    const gy = new Float32Array(GLOW_STOPS)
    for (let gi = 0; gi < GLOW_STOPS; gi++) {
      const s = gi / (GLOW_STOPS - 1)
      // Pattern phase: its wavelength follows the lava's speed (1.5 at the vent, 0.3 at the toe), so it bunches up downstream.
      phs[gi] = (5 * Math.log(1.5 / lavaSpeed(s))) / 1.2
      thrs[gi] = (head ? 0.18 : 0.3) + 0.5 * Math.pow(s, 0.8)
      bodyA.set(rampAt(BODY_STOPS, s), gi * 4)
      coreA.set(rampAt(CORE_STOPS, s), gi * 4)
      const at = s * (pts.length - 1)
      const i0 = Math.min(pts.length - 2, Math.floor(at))
      gx[gi] = pts[i0].x + (pts[i0 + 1].x - pts[i0].x) * (at - i0)
      gy[gi] = pts[i0].y + (pts[i0 + 1].y - pts[i0].y) * (at - i0)
    }
    const i = out.length
    const riders = prev?.[i] ? { chunks: prev[i].chunks, seed: prev[i].seed } : { ...(head ? buildRiders() : buildRiders(1, 3)), seed: rand(0, 900) }
    out.push({
      pts,
      kind: nf.kind, // 'trunk' | 'rim' | 'fissure' | 'braid'
      role: nf.role,
      widthAt, // the channel's width in px at s along it (0 to 1): the shader cuts its strips from it
      head, // starts at the vent: gets the spill, the pool and the full rider count
      ribbon: ribbon(pts, widthAt, 1, 0.08, 1.1, i * 3 + 2),
      core: ribbon(pts, widthAt, 0.42),
      skin: ribbon(pts, widthAt, 0.6, 0.6, 1.5, i * 3 + 2),
      phs,
      thrs,
      bodyA,
      coreA,
      gx,
      gy,
      calm: new Float32Array(GLOW_STOPS),
      D: rand(0, 40), // how far the pattern has been carried: it moves at a speed that wanders
      tau: rand(0, 40), // how far it has evolved
      surge: -1, // where a pulse from an eruption has got to, 0 at the vent to 1 at the toe; -1 when none
      width: widthAt(0) * 0.3, // the spill, the pool and the bloom at the head are sized from this
      phase: grand(0, Math.PI * 2),
      rate: grand(0.12, 0.4),
      // The source's share of the vent heat: 1 for the trunk, less for the others. The sim scales each vent by it
      // (uVentHeat), so it is passed on as it is: the tuner's heat, the page's density and the breathing do not belong in it.
      heat: nf.heat,
      parent: nf.parent, // the channel this one starts on, as an index into the flow list: -1 for a source with a vent row of its own, 0 for the fork's arm (it leaves the trunk)
      attach: nf.attach, // how far along that channel, 0 to 1, this one leaves it
      drain: nf.drain, // where it ends: a flow's index (the trunk it joins), or -1 for the pool
      drainAt: nf.drainAt, // how far along that flow it joins (0 to 1), or where it enters the pool's arc (-1 to 1)
      sourceIndex: nf.sourceIndex,
      ...riders,
    })
  }
  for (const nf of net.flows) push(nf)

  // The cracks the flank streams start from. A crack is `rows` mountain rows tall, but a row is 25 to 50 px on a real cone,
  // so it is also held to 2.5 breach widths (the trunk's first width): a seam, not a wire. Each carries its stream's heat,
  // its jagged seam (crackShape) and a bloom the width of the stream it feeds.
  const last = mountain.left.length - 1
  const rowH = (mountain.left[last].y + mountain.right[last].y - mountain.left[0].y - mountain.right[0].y) / 2 / last
  const breach = net.flows[0].widthAt(0)
  fissures = net.fissures.map((c, i) => {
    const stream = net.flows.find((f) => f.sourceIndex === i)
    const len = Math.min(c.rows * rowH, 2.5 * breach)
    return {
      ...c,
      len,
      ...crackShape(c, i, len),
      bloom: Math.max(14, 2.2 * (stream?.widthAt(0) ?? 0.35 * breach)),
      heat: stream?.heat ?? 0.8,
    }
  })
  joins = net.joins
  lavaPool = net.pool
  return out
}

/**
 * A ribbon along a centreline: the polygon between the left and right offsets of each point at the width profile
 * `w(s)` times `k`, with a round head and toe, and edges roughened by `jit` (a fraction of the half width) at
 * `freq` per point. Built once per channel; the draw loop fills it with a gradient.
 */
function ribbon(pts, w, k, jit = 0, freq = 0.7, seed = 0) {
  const n = pts.length
  const L = []
  const R = []
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    let nx = -(b.y - a.y)
    let ny = b.x - a.x
    const len = Math.hypot(nx, ny) || 1
    nx /= len
    ny /= len
    // a ragged edge where asked: plates on the skin
    const jl = jit ? 1 + jit * (vnoise(i * freq + seed, 1.7) - 0.5) * 2 : 1
    const jr = jit ? 1 + jit * (vnoise(i * freq + seed, 9.3) - 0.5) * 2 : 1
    const hw = (w(i / (n - 1)) * k) / 2
    L.push([pts[i].x + nx * hw * jl, pts[i].y + ny * hw * jl])
    R.push([pts[i].x - nx * hw * jr, pts[i].y - ny * hw * jr])
  }
  const p = new Path2D()
  p.moveTo(L[0][0], L[0][1])
  for (let i = 1; i < n; i++) p.lineTo(L[i][0], L[i][1])
  const t = pts[n - 1]
  const angT = Math.atan2(t.y - pts[n - 2].y, t.x - pts[n - 2].x)
  p.arc(t.x, t.y, (w(1) * k) / 2, angT + Math.PI / 2, angT - Math.PI / 2, true)
  for (let i = n - 2; i >= 0; i--) p.lineTo(R[i][0], R[i][1])
  const h = pts[0]
  const angH = Math.atan2(pts[1].y - h.y, pts[1].x - h.x)
  p.arc(h.x, h.y, (w(0) * k) / 2, angH - Math.PI / 2, angH + Math.PI / 2, true)
  p.closePath()
  return p
}

/**
 * The calm band. The canvas sits behind the page, so lava can run behind text and make it hard to read (measured at
 * 1.2 to 1.5:1 on the hero). Where reading text overlaps a channel, the channel's glow steps aside. This measures the
 * text on the page: headings, paragraphs, controls. Big containers are skipped, since a panel has its own backing.
 */
function measureCalm() {
  const w = window.innerWidth
  const h = window.innerHeight
  const out = []
  const range = document.createRange()
  for (const el of document.querySelectorAll('h1, h2, h3, p, li, label, button, a, dt, dd, input, textarea, select, td')) {
    // controls have a box of their own; for text, take the line boxes of the words themselves, since a centred line sits
    // in a block as wide as its container and the lava beside the words is not in their way
    let boxes
    if (/^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) boxes = [el.getBoundingClientRect()]
    else {
      range.selectNodeContents(el)
      boxes = range.getClientRects()
    }
    if (el.closest('.deathfire, [data-forge]')) continue // the forge playground's controls are not reading text
    for (const r of boxes) {
      if (out.length >= 80) break
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > h || r.right < 0 || r.left > w) continue
      if (r.width * r.height > w * h * 0.2) continue // a whole card or panel: it has its own backing
      out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom })
    }
  }
  // The shader takes only the first few rects (lib/lavaProfile MAX_CALM), and the page's own order puts the header's links
  // first, which would fill every slot and leave the hero's text with no calm at all. So the rects nearest a channel go
  // first; the ribbons take the whole list and do not care about its order.
  for (const r of out) {
    r.gap = Infinity
    for (const f of flows) {
      for (const p of f.pts) r.gap = Math.min(r.gap, Math.hypot(Math.max(r.l - p.x, 0, p.x - r.r), Math.max(r.t - p.y, 0, p.y - r.b)))
    }
  }
  out.sort((a, b) => a.gap - b.gap || 0)
  // dev: ?calm=0 switches the band off, to compare a page with and without it
  const off = import.meta.env.DEV && new URLSearchParams(window.location.search).get('calm') === '0'
  calmRects = off ? [] : out
  calmScroll = window.scrollY
}

/** How much of its glow a channel keeps at this point, 1 in the clear and 0.1 under text, easing out over 48px. */
function calmFactor(x, y) {
  let k = 1
  for (const r of calmRects) {
    const d = Math.hypot(Math.max(r.l - x, 0, x - r.r), Math.max(r.t + calmShift - y, 0, y - (r.b + calmShift)))
    if (d < 48) k = Math.min(k, 0.1 + 0.9 * sstep(d / 48))
  }
  return k
}

/** Non-repeating smooth value noise in two dimensions: hashed lattice, smoothly interpolated. */
function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0
  h = ((h ^ (h >>> 13)) * 1274126177) | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
function vnoise(x, y) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const a = hash2(xi, yi)
  const b = hash2(xi + 1, yi)
  const c = hash2(xi, yi + 1)
  const d = hash2(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/** Linear lookup in a ramp of [position, r, g, b, a] stops. */
function rampAt(stops, s) {
  let k = 1
  while (k < stops.length - 1 && stops[k][0] < s) k++
  const a = stops[k - 1]
  const b = stops[k]
  const u = Math.max(0, Math.min(1, (s - a[0]) / (b[0] - a[0] || 1)))
  return [1, 2, 3, 4].map((j) => a[j] + (b[j] - a[j]) * u)
}

// The heat colours of a channel's glow, vent to toe, as [position, r, g, b, a] (the same ramp flowRamp paints).
const BODY_STOPS = [[0, 255, 196, 110, 1], [0.25, 255, 138, 61, 1], [0.6, 224, 67, 29, 1], [0.92, 150, 40, 18, 0.6], [1, 110, 28, 12, 0.3]]
// The crust skin that closes over a channel (the banks are the layer's: the sim's crusted outer rows).
const SKIN_RGB = '20,11,7'
const CORE_STOPS = [[0, 255, 226, 150, 1], [0.2, 255, 190, 100, 0.9], [0.42, 255, 150, 70, 0], [1, 255, 150, 70, 0]]
// How many places along a channel its glow is sampled; the gradient between them is smooth.
const GLOW_STOPS = 12
// How fast things are carried at `u` (0 vent, 1 toe), relative: lava is thick, quick off the steep top and crawling
// toward the toe as it cools and stiffens. The glow pattern and the rock chunks both follow it.
const lavaSpeed = (u) => 1.5 - 1.2 * u
const sstep = (x) => {
  const c = x < 0 ? 0 : x > 1 ? 1 : x
  return c * c * (3 - 2 * c)
}

/**
 * Heat along one channel, vent to toe: yellow-white, orange, red, then dark crust (USGS: about 1100 C reads
 * yellow, 900 orange, 700 red, cooler is black). Built once per flow and reused every frame. The colours run
 * along the line from the channel's first point to its last, which for a channel running down the cone is the
 * line of flow. Alpha does the cooling, not a dark colour, because the pass is additive.
 */
function flowRamp(ctx, f) {
  const a = f.pts[0]
  const b = f.pts[f.pts.length - 1]
  const make = (stops) => {
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
    for (const [at, color] of stops) g.addColorStop(at, color)
    return g
  }
  return {
    bloom: make([[0, 'rgba(255,150,70,1)'], [0.4, 'rgba(224,67,29,1)'], [0.85, 'rgba(140,35,15,0.55)'], [1, 'rgba(90,22,10,0)']]),
    body: make([[0, 'rgba(255,196,110,1)'], [0.25, 'rgba(255,138,61,1)'], [0.6, 'rgba(224,67,29,1)'], [0.92, 'rgba(150,40,18,0.6)'], [1, 'rgba(100,26,12,0)']]),
    // the white-hot core only near the vent
    core: make([[0, 'rgba(255,226,150,1)'], [0.2, 'rgba(255,190,100,0.9)'], [0.42, 'rgba(255,150,70,0)'], [1, 'rgba(255,150,70,0)']]),
  }
}

/** A point at fraction `u` (0 = crater end, 1 = base) along a flow's path. */
function pointOnFlow(f, u) {
  const n = f.pts.length - 1
  const idx = Math.min(n - 0.001, Math.max(0, u * n))
  const i0 = Math.floor(idx)
  const frac = idx - i0
  const a = f.pts[i0]
  const b = f.pts[i0 + 1] || a
  return { x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac }
}

/**
 * The seam of a crack, built once: from its lower end (where the stream leaves) up `len` px along its lean, as 4 to 6
 * segments with lateral jags, a polygon that tapers from 2 px to 1 px. The jags come from `hash2` of this route and the
 * crack's index, so they are the same on every visit and a resize, and the seeded stream is not drawn from.
 */
function crackShape(c, i, len) {
  const key = (hashString(route.path || '/') % 9973) + i * 131
  const h = (k) => hash2(key, k)
  const n = 4 + Math.floor(h(0) * 3)
  const dx = Math.sin(c.tilt)
  const dy = -Math.cos(c.tilt)
  const jag = len * 0.09
  const pts = []
  for (let k = 0; k <= n; k++) {
    const along = k === 0 || k === n ? k / n : (k + (h(10 + k) - 0.5) * 0.6) / n
    // the lower end stays on the stream's head; the kinks alternate sides so the seam zigzags
    const side = k === 0 ? 0 : (k % 2 ? 1 : -1) * (0.45 + 0.55 * h(20 + k)) * (k === n ? 0.6 : 1)
    pts.push({
      x: c.x + dx * len * along - dy * side * jag,
      y: c.y + dy * len * along + dx * side * jag,
      hw: (2 - along) / 2,
    })
  }
  const L = []
  const R = []
  for (let k = 0; k <= n; k++) {
    const a = pts[Math.max(0, k - 1)]
    const b = pts[Math.min(n, k + 1)]
    const tl = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const nx = -(b.y - a.y) / tl
    const ny = (b.x - a.x) / tl
    L.push([pts[k].x + nx * pts[k].hw, pts[k].y + ny * pts[k].hw])
    R.push([pts[k].x - nx * pts[k].hw, pts[k].y - ny * pts[k].hw])
  }
  const path = new Path2D()
  path.moveTo(L[0][0], L[0][1])
  for (let k = 1; k <= n; k++) path.lineTo(L[k][0], L[k][1])
  for (let k = n; k >= 0; k--) path.lineTo(R[k][0], R[k][1])
  path.closePath()
  return { path, topX: pts[n].x, topY: pts[n].y }
}

/**
 * The cracks the flank streams start from: a jagged seam (see crackShape) a few stream widths long, lit brightest over
 * its lower third where the stream leaves it, with a small bloom there. Under the channels, over the rock. They are painted
 * here whatever paints the channels, since the layer draws streams and not cracks. Where reading text sits over one it steps aside.
 */
function drawFissures(ctx, breathe, flare) {
  if (!fissures.length) return
  const k = tune.flowHeat * prof.density * (0.82 + 0.18 * breathe + flare * 0.5)
  ctx.globalCompositeOperation = 'lighter'
  for (const c of fissures) {
    const a = Math.min(1, c.heat * k * ((calmFactor(c.x, c.y) + calmFactor(c.topX, c.topY)) / 2))
    if (a <= 0.01) continue
    const seam = (c.seam ??= (() => {
      const g = ctx.createLinearGradient(c.x, c.y, c.topX, c.topY)
      g.addColorStop(0, 'rgba(255,196,110,1)')
      g.addColorStop(0.33, 'rgba(255,150,70,0.9)')
      g.addColorStop(1, 'rgba(224,67,29,0.3)')
      return g
    })())
    ctx.globalAlpha = a
    ctx.fillStyle = seam
    ctx.fill(c.path)
    ctx.globalAlpha = Math.min(1, a * 0.8)
    ctx.drawImage(spriteGlow, c.x - c.bloom / 2, c.y - c.bloom / 2, c.bloom, c.bloom)
  }
  ctx.globalAlpha = 1
}

/**
 * The pool's paint for the canvas fallback, built once per layout from the ribbons' own colours (BODY_STOPS, SKIN_RGB):
 * the body from red-orange at the arc to the deep red of a cooled toe, a hot fan on the arc where the trunk comes in, a
 * crust gradient toward the far shore, and the bloom (a gradient in a space centred on the arc's top with 1.1 pool half
 * widths as its radius).
 */
function makePoolPaint(ctx, p) {
  const rgba = (s, a) => `rgba(${s[1]},${s[2]},${s[3]},${a})`
  const trunk = flows[0]?.pts
  const end = trunk && trunk[trunk.length - 1]
  const entryX = Math.min(p.cx + p.rx, Math.max(p.cx - p.rx, end ? end.x : p.cx))
  const fanR = 0.55 * p.rx
  const base = ctx.createLinearGradient(0, p.arcTop, 0, p.cy + p.ry)
  base.addColorStop(0, rgba(BODY_STOPS[2], 1))
  base.addColorStop(1, rgba(BODY_STOPS[3], 1))
  const fan = ctx.createRadialGradient(0, 0, 0, 0, 0, fanR)
  fan.addColorStop(0, rgba(BODY_STOPS[0], 1))
  fan.addColorStop(0.4, rgba(BODY_STOPS[1], 0.9))
  fan.addColorStop(1, rgba(BODY_STOPS[2], 0))
  const crust = ctx.createLinearGradient(0, p.arcTop + 0.35 * p.ry, 0, p.cy + 0.3 * p.ry)
  crust.addColorStop(0, `rgba(${SKIN_RGB},0)`)
  crust.addColorStop(1, `rgba(${SKIN_RGB},1)`)
  const bloom = ctx.createRadialGradient(0, 0, 0, 0, 0, 1.1 * p.rx)
  bloom.addColorStop(0, 'rgba(255,150,70,0.55)')
  bloom.addColorStop(0.45, 'rgba(224,67,29,0.24)')
  bloom.addColorStop(1, 'rgba(140,35,15,0)')
  return { entryX, fanR, fanSy: (1.6 * p.ry) / fanR, base, fan, crust, bloom }
}

/**
 * The pool at the foot of the cone, the ribbons' fallback, and what it must look like for the first second of every load
 * and under ?lava=0: the shader's pool, flatter. Inside the ellipse: the body (red-orange at the arc to deep red), a hot fan
 * on the arc where the trunk comes in, and the crust (the ribbons' skin colour) laid over the far half. Those are at 0.8 of the
 * ribbons' body alpha times `keep` (1 where the layer is not painting, falling to 0 as the layer's own pool takes over).
 * Then the bloom: an orange glow on the rock above the arc, clipped so it never lights the pool itself, at full strength
 * always, since the layer makes no bloom into the rock. Drawn after the channels. Nothing is laid over the lava after the
 * rock, so the far half of the ellipse is the part below the canvas: the pool sits on the bottom edge (a phone's below it).
 */
function drawPool(ctx, keep, breathe, flare) {
  const p = lavaPool
  if (!p) return
  // the page's dimming and the caldera's breathing reach it as they reach the channels, and reading text parts it (three samples)
  const k = Math.min(1, tune.flowHeat * prof.density * (0.82 + 0.18 * breathe + flare * 0.5))
  const calm = (calmFactor(p.cx - p.rx / 2, p.cy) + calmFactor(p.cx, p.cy) + calmFactor(p.cx + p.rx / 2, p.cy)) / 3
  const paint = (p.paint ??= makePoolPaint(ctx, p))
  if (keep > 0) {
    ctx.save()
    ctx.beginPath()
    ctx.ellipse(p.cx, p.cy, p.rx, p.ry, 0, 0, Math.PI * 2)
    ctx.clip()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = Math.max(0, 0.8 * keep * k * calm)
    ctx.fillStyle = paint.base
    ctx.fillRect(p.cx - p.rx, p.arcTop, 2 * p.rx, 2 * p.ry)
    ctx.save()
    ctx.translate(paint.entryX, p.arcTop)
    ctx.scale(1, paint.fanSy)
    ctx.fillStyle = paint.fan
    ctx.fillRect(-paint.fanR, -paint.fanR, 2 * paint.fanR, 2 * paint.fanR)
    ctx.restore()
    // the crust: a second ellipse a little toward the far shore, fading in from the middle of the pool
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 0.5 * keep
    ctx.fillStyle = paint.crust
    ctx.beginPath()
    ctx.ellipse(p.cx, p.cy + 0.3 * p.ry, 0.98 * p.rx, 0.95 * p.ry, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  // The bloom, in a space centred on the arc's top and squashed to the pool's height. The pool in that space is the
  // ellipse centred half a pool width down (ry / scale = rx / 2), and it is cut out of the clip: the bloom is the rock's.
  ctx.save()
  ctx.translate(p.cx, p.arcTop)
  ctx.scale(1, (2 * p.ry) / p.rx)
  const R = 1.1 * p.rx
  ctx.beginPath()
  ctx.rect(-R, -R, 2 * R, 2 * R)
  ctx.ellipse(0, p.rx / 2, p.rx, p.rx / 2, 0, 0, Math.PI * 2)
  ctx.clip('evenodd')
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = Math.max(0, k * calm)
  ctx.fillStyle = paint.bloom
  ctx.fillRect(-R, -R, 2 * R, 2 * R)
  ctx.restore()
  ctx.globalAlpha = 1
}

/** Sparks and embers leave from the crater, or off a lava channel. */
function driftSource(w, h) {
  if (!mountain) return { x: rand(0, w), y: h }
  if (flows.length && Math.random() < 0.3) {
    const f = flows[(Math.random() * flows.length) | 0]
    const p = f.pts[(Math.random() * f.pts.length) | 0]
    return { x: p.x + rand(-6, 6), y: p.y - rand(0, 6) }
  }
  return {
    x: mountain.peakX + rand(-mountain.craterHalf, mountain.craterHalf),
    y: mountain.peakY + rand(-4, 10),
  }
}

function spawnDrift(w, h, atSource) {
  const src = atSource ? driftSource(w, h) : { x: rand(0, w), y: rand(0, h) }

  if (Math.random() < tune.sparkMix) {
    const speed = rand(1.4, 4.2)
    const angle = -Math.PI / 2 + rand(-0.7, 0.7)
    return {
      kind: 'spark',
      x: src.x,
      y: src.y,
      px: src.x,
      py: src.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: rand(0.9, 2),
      age: 0,
      life: rand(0.45, 1.7),
      alpha: rand(0.7, 1),
      green: Math.random() < 0.07,
    }
  }

  const big = Math.random() < 0.12
  return {
    kind: 'ember',
    x: src.x,
    y: src.y,
    vy: big ? rand(0.14, 0.36) : rand(0.28, 0.95),
    vx: rand(-0.13, 0.13),
    size: big ? rand(7, 16) : rand(1.5, 5),
    age: 0,
    life: big ? rand(1.4, 4.5) : rand(3.5, 11),
    phase: rand(0, Math.PI * 2),
    sway: rand(0.3, 1.3),
    alpha: big ? rand(0.25, 0.5) : rand(0.45, 0.9),
    green: !big && Math.random() < 0.09,
  }
}

function lifeFade(e) {
  const p = e.age / e.life
  if (p >= 1) return 0
  if (p < 0.1) return p / 0.1
  if (p > 0.68) return 1 - (p - 0.68) / 0.32
  return 1
}

/**
 * A falling flake.
 *
 * `front` flakes are drawn after the rock instead of behind it. Ash only ever
 * fell behind the silhouette, and the cone covers most of the lower screen, so
 * a large share of every flake spawned was painted over and lost — the fall
 * read as a thin band of sky rather than weather across the whole window.
 * Nearer flakes are bigger and faster, which is what makes the two layers read
 * as depth rather than as one layer at two brightnesses.
 */
function spawnAsh(w, h, atTop, front) {
  return {
    front,
    x: rand(-30, w + 30),
    y: atTop ? rand(-60, -10) : rand(0, h),
    vy: front ? rand(0.34, 0.86) : rand(0.12, 0.42),
    drift: rand(-0.22, 0.22) * (front ? 1.5 : 1),
    size: front ? rand(1.6, 3.8) : rand(1, 2.6),
    phase: rand(0, Math.PI * 2),
    sway: rand(0.4, 1.5),
    alpha: front ? rand(0.14, 0.4) : rand(0.1, 0.32),
  }
}

/** A window-sized canvas for a cached layer of the rock, drawn on in window pixels. */
function layerCanvas(w, h) {
  const cv = document.createElement('canvas')
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  cv.width = Math.ceil(w * dpr)
  cv.height = Math.ceil(h * dpr)
  const g = cv.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { cv, g }
}

/**
 * Cache the distant ridges, dimmer the further back they sit. They only change on resize, and they are a layer of their
 * own: the painted cone goes over them, and so does a plate's rock, which has no far ridges of its own.
 */
function buildRidgeLayer(w, h) {
  const { cv, g } = layerCanvas(w, h)
  for (const r of ridges) {
    g.beginPath()
    g.moveTo(r.pts[0].x, h + 20)
    for (const p of r.pts) g.lineTo(p.x, p.y)
    g.lineTo(r.pts[r.pts.length - 1].x, h + 20)
    g.closePath()
    g.fillStyle = `rgba(9, 18, 15, ${r.depth})`
    g.fill()
  }
  return cv
}

/** Cache the painted cone, which only changes on resize. */
function buildSilhouette(w, h) {
  const { cv, g } = layerCanvas(w, h)
  const m = mountain
  g.beginPath()
  g.moveTo(m.left[m.left.length - 1].x, h + 20)
  for (let i = m.left.length - 1; i >= 0; i--) g.lineTo(m.left[i].x, m.left[i].y)
  g.lineTo(m.rimL.x, m.rimL.y)
  for (const p of m.crown) g.lineTo(p.x, p.y)
  g.lineTo(m.rimR.x, m.rimR.y)
  for (const p of m.right) g.lineTo(p.x, p.y)
  g.lineTo(m.right[m.right.length - 1].x, h + 20)
  g.closePath()

  const grd = g.createLinearGradient(0, m.peakY, 0, h)
  grd.addColorStop(0, '#0d1a15')
  grd.addColorStop(1, '#030806')
  g.fillStyle = grd
  g.fill()
  return cv
}

/** A plate's picture, cover-fitted, over what is already drawn. */
function drawPlate(ctx, img, alpha) {
  const { scale, dx, dy } = plate.fit
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = alpha
  ctx.drawImage(img, dx, dy, img.width * scale, img.height * scale)
  ctx.globalAlpha = 1
}

/** Back to the painted rock alone. */
function dropPlate() {
  plate = null
  plateFade.set(null, 0)
}

/** A plate that came but is no good (its numbers made nothing drawable): painted rock, and the loader will not hand it out again. */
function badPlate(key, bucket) {
  dropPlate()
  plateLoader.fail(key, bucket)
}

/**
 * The plate for this route and window shape, as a mountain: the sidecar's, mapped through the plate's cover-fit to the window
 * (the fit is refreshed on every layout, so a resize that keeps the shape just moves it). `null` when the painted mountain is
 * to be used: no plate is up. If the plate that is up is for another shape of window, or for a route with another plate, it is
 * put down first (it would not fit this mountain), and the one wanted is asked for, once; the answer comes to takePlate.
 *
 * A plate whose numbers throw here is put down and marked bad: painted rock, no error, no more asking. The route's profile
 * key is what the loader maps to the plate's folder (so `/planner` and `/roster` share the default one).
 */
function plateMountain(w, h) {
  const key = profileKeyFor(route.path)
  const bucket = bucketFor(w, h)
  const id = `${plateSlug(key)}/${bucket}`
  if (plate && plate.id !== id) dropPlate()
  if (plate) {
    try {
      plate.fit = fitPlate({ imageW: plate.rock.width, imageH: plate.rock.height, w, h, anchor: anchorFor(plate.sidecar) })
      return mapMountain(plate.sidecar, plate.fit)
    } catch {
      badPlate(key, bucket)
      return null
    }
  }
  if (plateWanted !== id) {
    plateWanted = id
    plateLoader.load(key, bucket, ++plateToken).then(takePlate)
  }
  return null
}

/**
 * A plate has come in. Only a plate that is the latest asked for is taken up: `null` is a plate that cannot be had, and an
 * older token is an answer for a route or a window shape the page has left (it must never be painted over the new one).
 * The mountain, its channels, the lip and the painted rock are rebuilt on the plate's mountain; the particles, the moon and
 * the heat sim carry on, so nothing that is burning stops. Under reduced motion it is shown whole, with no fade.
 */
function takePlate(result) {
  if (stopped || !result || result.token !== plateToken || !mountain) return
  plate = { id: plateWanted, sky: result.sky, rock: result.rock, sidecar: result.sidecar, fit: null }
  plateSnap = !motionAllowed() || !!forge?.frozen
  plateFade.set(plate, performance.now())
  buildTerrain(lastW, lastH)
  const cold = !!lava?.cold // before the draw, as in relayout
  draw(1)
  if (cold && mode.value === 'still' && !forge?.frozen) burnStill()
}

/**
 * Everything that follows the mountain, for a viewport of w by h: the mountain (the plate's, if one is up for this route and
 * window shape, else the painted builder's), the far ridges, the lava network, the shader's channels, the lip and the cached
 * rock (the far ridges and the painted cone, a layer each). The painted mountain and the ridges are built whether a plate is
 * up or not, so the seeded stream is where it always was when the network draws from it. Under a plate the cone is the
 * plate's (mapped from its sidecar), the far ridges are the painted ones all the same (the plate has none: they are drawn
 * under its rock), and the glow under the sky follows the plate's peak.
 */
function buildTerrain(w, h) {
  seedForRoute()
  mountain = buildMountain({ w, h, face: faceOffset, prof, tune, rng, path: route.path, randomize })
  ridges = buildRidges(w, h)
  const fromPlate = plateMountain(w, h)
  if (fromPlate) {
    mountain = fromPlate
    face.value = mountain.peakX / w
  }
  flows = buildFlows(flows, w)
  lavaResize(w, h) // the shader's channels follow the same centrelines
  lip = buildLip(mountain)
  farRidges = ridges.length ? buildRidgeLayer(w, h) : null
  silhouette = buildSilhouette(w, h)
}

/** Calls `fn` when the browser is idle; a timer where there is no requestIdleCallback. Returns what takes it back. */
function whenIdle(fn) {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout: 4000 })
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(fn, 2000)
  return () => window.clearTimeout(id)
}

const isPhone = () => window.matchMedia?.('(max-width: 768px)').matches

// The shader's per-frame arguments: two objects rewritten each frame, so handing it a frame allocates nothing.
const lavaTuning = { crust: 0, heat: 0, viscosity: 0, cracks: 0, foldScale: 0, breakoutRate: 0 }
const lavaFrame = { t: 0, secs: 0, flows: null, calmRects: null, calmShift: 0, tune: lavaTuning, density: 1 }

/**
 * What the shader draws this frame. Its heat takes everything the ribbons' heat does that is not per channel: the tuner's
 * Lava heat, this page's own lava heat, the old Lava heat slider (against its default) and the caldera's breathing and
 * flare, so a flare lights the channels whichever paints them. `secs` is this frame's length in seconds: the heat
 * simulation advances by it.
 */
function lavaArgs(breathe, flare, secs) {
  const l = fireTuning.lava
  lavaTuning.crust = l.crust
  lavaTuning.heat = l.heat * (prof.lavaHeat ?? 1) * (tune.flowHeat / DEFAULTS.bed.flowHeat) * (0.82 + 0.18 * breathe + flare * 0.5)
  lavaTuning.viscosity = l.viscosity
  lavaTuning.cracks = l.cracks
  lavaTuning.foldScale = l.foldScale
  lavaTuning.breakoutRate = l.breakoutRate
  lavaFrame.t = t
  lavaFrame.secs = secs
  lavaFrame.flows = flows
  lavaFrame.calmRects = calmRects
  lavaFrame.calmShift = calmShift
  lavaFrame.density = prof.density
  return lavaFrame
}

/** Gives the lava layer up and puts the ribbons back at full strength: for anything that throws while it is in use. */
function dropLava(err) {
  lava?.dispose()
  lava = null
  lavaFade = 0
  if (import.meta.env.DEV) console.warn('The lava shader failed; the ribbons stay.', err)
}

function lavaResize(w, h) {
  try {
    lava?.resize(w, h, flows, { joins, pool: lavaPool })
  } catch (err) {
    dropLava(err)
  }
}

// Steps of 1/30 s a still frame burns: 24 s of flow. The front reaches the sheet's toe at about 11.5 s and the arms
// and side streams are lit to nine tenths of their reach by about 23 s (heat-sim spec 10.1 and 10.2), measured on the
// old sheet-and-arms layout; the network's streams and the pool are checked against it in the network spec 13.4 and
// 13.6. About 1.2 s on SwiftShader at the desktop grid, a quarter of that on a phone's, once at mount.
const STILL_STEPS = 720

/**
 * Burns the sim for a still frame: the sim starts cold and a still page has no frames to warm it, so run STILL_STEPS of
 * flow and repaint. The caller draws once before this, which hands the layer this page's tune and channels.
 */
function burnStill() {
  try {
    lava.stepN(STILL_STEPS)
  } catch (err) {
    dropLava(err)
  }
  draw(1)
}

/**
 * Dev, for the forge's seek: the sim as it stands `sec` seconds after a cold start, run as one batch (30 steps a second, no
 * more than a still frame burns) and not a frame at a time, so a page parked at a late second is ready at once.
 */
function forgeBurn(sec) {
  try {
    lava.ignite()
    lava.stepN(Math.min(Math.round(sec * 30), STILL_STEPS))
  } catch (err) {
    dropLava(err)
  }
  draw(1)
}

/**
 * Fetches the WebGL lava layer once the first frame is up, so the page never waits on it: until it lands, and anywhere it
 * cannot run (no WebGL2, no context, ?lava=0), the ribbons paint the channels. ?lava=0 is read here, before the import,
 * because the shader's own switch (supportsLavaShader) lives in the chunk this would fetch.
 */
function loadLava() {
  if (stopped || new URLSearchParams(window.location.search).get('lava') === '0') return
  lavaWanted = true
  import('../lib/lavaShader')
    .then(({ createLavaLayer }) => {
      if (!lavaWanted) return
      lava = createLavaLayer({ phone: isPhone() })
      if (!lava || !mountain) return
      lavaResize(lastW, lastH)
      // A still frame (reduced motion) never runs the fade, and a frozen playground does not advance it, so both
      // take the shader at once and repaint.
      if (lava && (mode.value === 'still' || forge?.frozen)) {
        lavaFade = 1
        draw(1)
        // The still frame has to have burned, and the draw above comes first because it hands the layer this page's tune
        // and channels. A frozen playground is parked at a moment of its own choosing, so it keeps the sim as it is (the
        // render harness steps it to its second itself; the forge's seek burns it, see forgeBurn).
        if (lava && mode.value === 'still' && !forge?.frozen) burnStill()
      }
    })
    .catch(dropLava)
}

function layout() {
  const cv = canvas.value
  if (!cv) return false
  const w = window.innerWidth
  const h = window.innerHeight
  // Finite check first: `NaN < 2` is false, so a non-finite viewport used to
  // walk straight past this guard and NaN-poison the whole build, throwing on
  // createLinearGradient once it reached the silhouette.
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) return false
  lastW = w
  lastH = h

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  cv.width = Math.ceil(w * dpr)
  cv.height = Math.ceil(h * dpr)
  cv.style.width = `${w}px`
  cv.style.height = `${h}px`
  if (veil.value) {
    veil.value.width = cv.width
    veil.value.height = cv.height
  }

  if (!spriteGlow) spriteGlow = makeGlow()
  buildTerrain(w, h)
  moon = buildMoon(w, h)

  const mobile = isPhone()
  burst = []
  // Honour the slider. This used to be min(w/16, count), which silently capped
  // a requested 112 to 94 on a 1500px screen and made the plume look thin.
  // Profile density thins the plume and ash on pages that are mostly reading.
  const n = Math.round(tune.count * prof.density * (mobile ? 0.45 : 1))
  drift = Array.from({ length: n }, () => spawnDrift(w, h, false))

  // Ash is weather: it has to hold the same density per screen area at every
  // size. A flat count spread the same handful of flakes over a 2M-pixel
  // desktop as over a phone, which is what made it look muted on a wide window.
  const areaScale = (w * h) / REF_AREA
  const total = Math.round(tune.ash * prof.density * areaScale * (mobile ? 0.5 : 1))
  const frontCount = Math.round(total * 0.4)
  ashBack = Array.from({ length: total - frontCount }, () => spawnAsh(w, h, false, false))
  ashFront = Array.from({ length: frontCount }, () => spawnAsh(w, h, false, true))
  return true
}

/**
 * Rebuild for a new viewport, at most once a frame.
 *
 * layout() throws away the cached silhouette and every particle, so running it
 * raw on a resize stream meant a full rebuild per event for the length of a
 * drag. Coalescing to the next frame and skipping same-size events keeps a
 * resize cheap; mobile chrome in particular fires resize constantly as the URL
 * bar slides without the viewport really changing.
 */
function relayout() {
  if (relayoutPending) return
  relayoutPending = requestAnimationFrame(() => {
    relayoutPending = 0
    if (window.innerWidth === lastW && window.innerHeight === lastH) return
    if (layout()) {
      // Asked before the draw: a draw steps the sim once, and that step writes the cold state and clears the flag.
      const cold = !!lava?.cold
      draw(1)
      // A still page runs no frames, and a resize across the phone breakpoint changes the channel count, which lights
      // the sim cold again: burn it once more, or the page would show grey crust for good. Only then: a resize that
      // keeps the channel count (a phone's URL bar sliding) leaves the sim lit, and a burn would be wasted passes.
      if (cold && mode.value === 'still' && !forge?.frozen) burnStill()
    }
  })
}

/** A pulse from the vent: a burst of sparks straight up out of the crater. */
function erupt(scale = 1) {
  if (!mountain) return
  const n = Math.round(rand(6, 22) * tune.sparks * scale)
  for (let i = 0; i < n; i++) {
    if (burst.length > 500) break
    const speed = rand(2.2, 6.5)
    const angle = -Math.PI / 2 + rand(-0.5, 0.5)
    burst.push({
      x: mountain.peakX + rand(-mountain.craterHalf * 0.8, mountain.craterHalf * 0.8),
      y: mountain.peakY + rand(-2, 8),
      px: 0,
      py: 0,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: rand(0.9, 2.2),
      age: 0,
      life: rand(0.7, 2.4),
      alpha: rand(0.75, 1),
      green: Math.random() < 0.05,
    })
  }
  mountain.flare = 1
  for (const f of flows) {
    f.surge = 0
    // the blast throws rocks out of the vent: they start at the crater, fast, and the lava slows them
    for (const c of f.chunks) {
      if (Math.random() < 0.35) {
        c.u = 0
        c.boost = 2.2
      }
    }
  }
}

function draw(dt) {
  const cv = canvas.value
  if (!cv || !silhouette || !mountain) return
  const ctx = cv.getContext('2d')
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = cv.width / dpr
  const h = cv.height / dpr
  const secs = (dt * 16.7) / 1000
  const m = mountain

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  // Over the archive plaque the near ash is drawn a shade lighter and a touch
  // larger, or it vanishes against the blackened iron.
  const fallAsh = (flakes, c = ctx, over = false) => {
    c.globalCompositeOperation = 'source-over'
    c.fillStyle = over ? '#9a928a' : '#6b6560'
    const grow = over ? 1.4 : 1
    for (const a of flakes) {
      a.y += a.vy * dt
      a.phase += 0.02 * dt
      a.x += (a.drift + Math.sin(a.phase) * 0.2 * a.sway) * dt
      if (a.y > h + 20) Object.assign(a, spawnAsh(w, h, true, a.front))
      c.globalAlpha = a.alpha
      c.fillRect(a.x, a.y, a.size * grow, a.size * grow)
    }
    c.globalAlpha = 1
  }
  const vctx = veil.value?.getContext('2d')
  if (vctx) {
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    vctx.clearRect(0, 0, w, h)
  }

  // 0. The sky. The moon crosses it once every cycle, swelling as it nears; at its closest pass (mid-cycle) it brings the
  // Time of Trial, how hard decided by chance in tiers. It is drawn far behind everything, on slow non-repeating drifts,
  // and the pages that are mostly reading see it dimmer.
  const { cycle, phase } = moonPhase()
  if (phase >= 0.5 && lastCycle !== cycle) {
    lastCycle = cycle
    // only if the pass is seen: a page opened long after it has nothing to catch
    if (phase < 0.56 && mode.value === 'live' && trialAt < 0) {
      const roll = Math.random()
      trialTier = roll < 0.05 ? 3 : roll < 0.3 ? 2 : 1
      trialAt = 0
      trialClock = 0
    }
  }
  let trial = 0
  if (trialAt >= 0) {
    trialAt += secs
    trial = trialLevel(trialAt, trialTier)
    if (trialAt > trialLength(trialTier)) trialAt = -1
    // the blast keeps throwing: the caldera stays aflame, and rocks and sparks fly
    if (trial > 0.2) {
      if ((m.flare || 0) < trial) m.flare = trial
      trialClock -= secs
      if (trialClock <= 0) {
        erupt(0.5 + trial)
        trialClock = 2.8 - trial * 1.5
      }
    }
  }
  // The plate's sky, before the moon (the plate has none of its own): over the painted sky (the glow layer under the canvas,
  // which shows through while it fades in). plateA is how much of the plate is drawn this frame, 0 to 1; 0 with no plate.
  const plateA = plate ? plateFade.tick(performance.now(), plateSnap) : 0
  if (plateA > 0) drawPlate(ctx, plate.sky, plateA)
  if (moon) {
    const near = Math.sin(Math.PI * phase) // 0 far, 1 closest, at mid-cycle
    const scale = 0.55 + 0.6 * near * near // swells as it nears; 1.15 at its closest
    const x = (-0.12 + 1.24 * phase) * w + (vnoise(t * 0.02, 3) - 0.5) * w * 0.02
    const y = (0.27 - 0.12 * near) * h + (vnoise(t * 0.017, 9) - 0.5) * h * 0.03
    const rad = (moon.r * scale) / 1.15
    ctx.globalCompositeOperation = 'source-over'
    // never fully opaque: the sky's haze sits between us and it
    const alpha = Math.min(0.86, (0.4 + prof.density * 0.6) * (0.6 + 0.4 * near))
    // lit from the summit's side: the bake lit from below-right while it is left of the peak, the other once past,
    // fading between them over a fifth of the width
    const mix = sstep((x - m.peakX) / (w * 0.2) + 0.5)
    if (mix < 1) {
      ctx.globalAlpha = alpha * (1 - mix)
      ctx.drawImage(moon.sprites[0], x - rad, y - rad, rad * 2, rad * 2)
    }
    if (mix > 0) {
      ctx.globalAlpha = alpha * mix
      ctx.drawImage(moon.sprites[1], x - rad, y - rad, rad * 2, rad * 2)
    }
  }
  // Time of Trial: the weak sun is blotted out. A smooth veil, eased in and out, never a flash.
  if (trial > 0.01) {
    ctx.globalAlpha = Math.min(0.7, 0.62 * trial)
    ctx.fillStyle = '#0a0503'
    ctx.fillRect(0, 0, w, h)
  }
  ctx.globalAlpha = 1
  // 1. Ash, falling behind the mountain. The nearer layer falls in step 5b.
  fallAsh(ashBack)

  // 2. Light thrown up out of the caldera, behind the rock.
  const flare = m.flare || 0
  const breathe = 0.6 + Math.sin(t * 0.45) * 0.4
  // Lava and the caldera are the brightest things on screen, so profile density
  // has to reach them — thinning the plume alone leaves a reading page glowing.
  const calderaHeat = (tune.caldera * breathe + flare * 0.7) * 1.1 * prof.density
  ctx.globalCompositeOperation = 'lighter'
  const cs = m.craterHalf * (7 + flare * 2)
  ctx.globalAlpha = Math.max(0, calderaHeat * 0.5)
  ctx.drawImage(spriteGlow, m.peakX - cs / 2, m.peakY - cs * 0.62, cs, cs * 0.9)
  deathfireHeat.breathe = breathe
  deathfireHeat.flare = flare
  // The painted haze breathes and flares with the caldera, so the flash and the glow move together.
  if (glowEl.value) glowEl.value.style.opacity = Math.min(1, 0.62 + 0.18 * ((breathe - 0.2) / 0.8) + 0.3 * flare).toFixed(3)
  if (m.flare) m.flare = Math.max(0, m.flare - secs * 1.8)

  // 3. The rock. First the far ridges, whole, plate or no plate (a plate has none of its own: they go under its rock). Then
  // the painted cone, whole (alone, when there is no plate); while a plate fades in, the painted cone goes down at 1 - a
  // and the plate's rock over it at a; once it is in, the plate's rock alone.
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  if (farRidges) ctx.drawImage(farRidges, 0, 0, w, h)
  if (plateA < 1) {
    ctx.globalAlpha = 1 - plateA
    ctx.drawImage(silhouette, 0, 0, w, h)
  }
  if (plateA > 0) drawPlate(ctx, plate.rock, plateA)
  ctx.globalAlpha = 1

  // The calm band: where reading text sits over the lava, the lava steps aside (see calmFactor). The text is measured a
  // few times a second, since pages scroll and re-flow; between measures the scroll is accounted for.
  if (calmAt < 0 || t - calmAt > 0.4) {
    measureCalm()
    calmAt = t
  }
  calmShift = calmScroll - window.scrollY

  // 4. Lava running down the flanks, drawn over the rock as channels cut through it: the cracks the flank streams start
  // from (under the channels), then for each channel the glow in three ribbons (bloom, body, core) and the crust skin
  // closing over the middle, so the margins stay brightest, which is where real channels shear and glow, and last the pool
  // they end in. The rock (the far ridges and the cone, a cached layer each) is already down, and nothing is laid over the
  // lava after it but the lip and the particles, so no foreground hides the pool's far half: the bottom edge of the canvas
  // does (the pool's centre sits on the cone's lowest row, a phone's below the screen).
  // Once the WebGL layer has loaded it paints the channels instead (composited below, after the ribbons). The two
  // cross-fade over a second, the ribbons at `keep` and the shader at `lavaFade`, so the channels are never dark between
  // them. The shader draws first, and the fade only runs once it has drawn something: a layer that never does (or whose
  // context is lost) leaves the ribbons at full strength until it can.
  if (lava?.ok) {
    try {
      lava.draw(lavaArgs(breathe, flare, secs))
    } catch (err) {
      dropLava(err)
    }
  }
  if (lava) lavaFade = lava.ok && lava.drawCalls > 0 ? Math.min(1, lavaFade + secs) : 0
  const keep = 1 - lavaFade
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  drawFissures(ctx, breathe, flare)
  for (const f of flows) {
    // Floored well clear of zero — this used to run 0.45 +/- 0.55, which
    // touches negative for part of every cycle. heat <= 0.01 then skipped the
    // whole channel, so each flow blinked fully out of existence on its own
    // independent cycle. Breathes between 0.44 and 1 instead of 0 and 1.
    const pulse = 0.76 + (vnoise(t * 0.14, f.seed + 31) - 0.5) * 0.6 // a slow, non-repeating swell
    // the channels follow the caldera too: a flare lights them, a lull dims them
    const heat = f.heat * pulse * tune.flowHeat * prof.density * (0.82 + 0.18 * breathe + flare * 0.5)
    f._heat = heat // read by the chunk pass below, after this loop's dash state is gone
    // The channel's flow clock: a surge is a faster flow, not a brighter one, so it runs up to 1.9x while the
    // pulse is in the channel and settles back; the shader carries its pattern by this, so nothing jumps.
    f.flowDist = (f.flowDist || 0) + secs * (1 + 0.9 * (f.surge >= 0 ? 1 - Math.min(1, f.surge) : 0))
    // An eruption sends a pulse of fresh, hotter lava down the channel: slow, spreading as it goes and fading as it cools.
    // It advances here, ahead of the ribbons' own painting, because the shader reads the same pulse from the flow.
    if (f.surge >= 0) {
      f.surge += dt * 0.0035 * lavaSpeed(Math.min(1, f.surge))
      if (f.surge > 1.15) f.surge = -1
    }
    if (heat <= 0.01) continue
    // Made even when the shader paints the channel: step 5's tongue at the vent reads it, and a relayout builds new flows.
    const ramp = (f.ramp ??= flowRamp(ctx, f))

    // Where text sits over the channel its glow steps aside: how much it keeps at each sampled place.
    let calmSum = 0
    for (let gi = 0; gi < GLOW_STOPS; gi++) {
      f.calm[gi] = calmFactor(f.gx[gi], f.gy[gi])
      calmSum += f.calm[gi]
    }
    // The bloom: one soft stroke along the whole channel, dimmed by how much of it is under text. It is the glow bleeding
    // into the rock, which the shader does not make, so it stays at full strength under the shader too.
    ctx.globalCompositeOperation = 'lighter'
    ctx.beginPath()
    ctx.moveTo(f.pts[0].x, f.pts[0].y)
    for (const p of f.pts) ctx.lineTo(p.x, p.y)
    ctx.globalAlpha = Math.max(0, heat * 0.22 * (calmSum / GLOW_STOPS))
    ctx.strokeStyle = ramp.bloom
    ctx.lineWidth = f.width * 6
    ctx.stroke()
    if (keep <= 0) continue // the shader paints the rest of this channel

    // The glow inside the channel is a continuous ribbon that swells brighter and dimmer along its length. Nothing in it
    // runs on a clock: the pattern is smooth, non-repeating noise carried down the channel at a speed that itself
    // wanders, and it evolves slowly as it goes, so no two moments look alike. Near the vent it burns steadily; toward
    // the toe the swells deepen as a crust forms and breaks (USGS aerials of Kilauea's 2018 channels). Brightness and
    // heat colour are set by a gradient along the channel, so it varies smoothly with no steps.
    f.D += secs * (0.21 + 0.15 * vnoise(t * 0.05, f.seed))
    f.tau += secs * (0.035 + 0.03 * vnoise(t * 0.04, f.seed + 17))
    const tail = f.pts[f.pts.length - 1]
    const body = ctx.createLinearGradient(f.pts[0].x, f.pts[0].y, tail.x, tail.y)
    const core = ctx.createLinearGradient(f.pts[0].x, f.pts[0].y, tail.x, tail.y)
    const skin = ctx.createLinearGradient(f.pts[0].x, f.pts[0].y, tail.x, tail.y)
    for (let gi = 0; gi < GLOW_STOPS; gi++) {
      const s = gi / (GLOW_STOPS - 1)
      const x = f.phs[gi] - f.D
      const y = f.tau + f.seed
      const n = vnoise(x, y) * 0.65 + vnoise(x * 2.3 + 7, y * 1.7 + 3) * 0.35
      // A quiet slow swell from the noise, and the real swells from the rocks: each rock shoves a bright bow wave of
      // fresh lava ahead of it and drags a fading glow behind. Big rocks shove harder. The volcano is spewing rocks
      // and they are pushing the lava down.
      let b = 0.34 + 0.26 * sstep((n - f.thrs[gi] + 0.1) / 0.45)
      for (const c of f.chunks) {
        const w = 0.035 + 0.008 * c.size
        const ahead = (s - c.u - w * 0.6) / w
        const wake = s < c.u ? 0.45 * Math.exp(-(c.u - s) / (w * 3)) : 0
        b += Math.min(1, 0.3 + 0.1 * c.size) * Math.min(1, Math.min(c.u, 1 - c.u) * 8) * (Math.exp(-ahead * ahead) + wake)
      }
      b = Math.min(1, b)
      let fresh = 0
      if (f.surge >= 0) {
        const d = (s - f.surge) / (0.07 + 0.2 * f.surge)
        fresh = (1 - Math.min(1, f.surge)) * Math.exp(-d * d)
        b = Math.min(1, b + fresh)
      }
      b *= f.calm[gi]
      const o = gi * 4
      body.addColorStop(s, `rgba(${f.bodyA[o]},${f.bodyA[o + 1]},${f.bodyA[o + 2]},${(f.bodyA[o + 3] * b).toFixed(3)})`)
      core.addColorStop(s, `rgba(${f.coreA[o]},${f.coreA[o + 1]},${f.coreA[o + 2]},${(f.coreA[o + 3] * b * b).toFixed(3)})`)
      // The crust: where the noise falls under the threshold the skin has closed over the middle of the channel, as
      // plates that drift with the pattern. Little of it near the vent, most toward the toe; fresh lava breaks it.
      const crust = sstep((f.thrs[gi] - n) / 0.3 + 0.5) * (1 - fresh) * (0.25 + 0.75 * s)
      skin.addColorStop(s, `rgba(${SKIN_RGB},${(crust * 0.9).toFixed(3)})`)
    }
    ctx.globalAlpha = Math.max(0, heat * 0.8) * keep
    ctx.fillStyle = body
    ctx.fill(f.ribbon)
    ctx.globalAlpha = Math.max(0, heat) * keep
    ctx.fillStyle = core
    ctx.fill(f.core)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = keep
    ctx.fillStyle = skin
    ctx.fill(f.skin)
  }
  // The shader's channels go over what is left of the ribbons, added the way they are (the layer's canvas is premultiplied).
  if (lava?.ok && lavaFade > 0) {
    try {
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = lavaFade
      ctx.drawImage(lava.canvas, 0, 0, w, h)
    } catch (err) {
      dropLava(err)
    }
    ctx.globalAlpha = 1
  }
  // The pool the streams end in: the ribbons' fallback (at `keep`, so it gives way as the layer's own pool comes in) and the
  // bloom into the rock above it, over everything the channels drew.
  drawPool(ctx, keep, breathe, flare)
  ctx.globalCompositeOperation = 'lighter'

  // 4b. Rock chunks tumbling in the flow — dark against the lava, so this
  // runs source-over rather than the additive blend everything else uses.
  ctx.globalCompositeOperation = 'source-over'
  for (const f of flows) {
    for (const c of f.chunks) {
      c.u += c.speed * dt * lavaSpeed(c.u) * 0.9 * (1 + c.boost) // carried at the lava's own, slow, speed; a rock thrown by a blast starts fast
      c.boost *= Math.pow(0.97, dt)
      if (c.u > 1) {
        c.u -= 1
        c.angle = rand(0, Math.PI * 2) // runtime, not seeded — see `rand` above
      }
      c.angle += c.spin * 0.004 * dt // rafts of crust turn slowly in thick lava
      const pt = pointOnFlow(f, c.u)
      const edge = Math.min(c.u, 1 - c.u)
      const fade = Math.min(1, edge * 8) * Math.max(0, f._heat)
      if (fade <= 0.02) continue
      ctx.save()
      ctx.translate(pt.x, pt.y)
      ctx.rotate(c.angle)
      ctx.globalAlpha = fade
      ctx.fillStyle = '#170b06'
      ctx.beginPath()
      ctx.moveTo(c.shape[0].x * c.size, c.shape[0].y * c.size)
      for (let k = 1; k < c.shape.length; k++) {
        ctx.lineTo(c.shape[k].x * c.size, c.shape[k].y * c.size)
      }
      ctx.closePath()
      ctx.fill()
      // Leading edge catches the heat it's floating in.
      ctx.strokeStyle = '#ff8a3d'
      ctx.globalAlpha = fade * 0.55
      ctx.lineWidth = Math.max(0.6, c.size * 0.12)
      ctx.beginPath()
      ctx.moveTo(c.shape[0].x * c.size, c.shape[0].y * c.size)
      ctx.lineTo(c.shape[1].x * c.size, c.shape[1].y * c.size)
      ctx.stroke()
      ctx.restore()
    }
  }
  ctx.globalCompositeOperation = 'lighter'

  // 5. The lit crater mouth: a molten lip brimming over, and a tongue of lava spilling across it at the head of
  // each channel. The lip swells and eases with the caldera's breathing.
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (lip) {
    const swell = 0.85 + breathe * 0.3
    const lipCalm = calmFactor(m.peakX, m.peakY)
    // The lip is molten, so it heaves: two slow waves around its resting line, none at the corners.
    const heave = m.craterHalf * 0.012
    for (let i = 0; i < lip.pts.length; i++) {
      lip.pts[i].y = lip.base[i].y + (Math.sin(t * 1.3 + i * 0.9) + Math.sin(t * 0.7 - i * 0.4) * 0.6) * heave * lip.w[i]
    }
    const g = (lip.g ??= lipGlow(ctx, lip, m))
    // The pool: the breach filled with lava to the lip's surface, the walls closing it below.
    ctx.beginPath()
    ctx.moveTo(lip.pts[0].x, lip.pts[0].y)
    for (const p of lip.pts) ctx.lineTo(p.x, p.y)
    for (let i = lip.walls.length - 1; i >= 0; i--) ctx.lineTo(lip.walls[i].x, lip.walls[i].y)
    ctx.closePath()
    ctx.globalAlpha = Math.max(0, calderaHeat * 0.7 * lipCalm)
    ctx.fillStyle = g.body
    ctx.fill()
    ctx.globalAlpha = Math.max(0, calderaHeat * 0.5 * lipCalm)
    ctx.fillStyle = g.core
    ctx.fill()
    ctx.lineCap = 'butt' // the ends meet the rock outline instead of poking out past it
    ctx.beginPath()
    ctx.moveTo(lip.pts[0].x, lip.pts[0].y)
    for (const p of lip.pts) ctx.lineTo(p.x, p.y)
    ctx.globalAlpha = Math.max(0, calderaHeat * 0.32 * lipCalm)
    ctx.strokeStyle = g.bloom
    ctx.lineWidth = Math.max(4, m.craterHalf * 0.1) * swell
    ctx.stroke()
    ctx.globalAlpha = Math.max(0, calderaHeat * 0.85 * lipCalm)
    ctx.strokeStyle = g.body
    ctx.lineWidth = Math.max(2.5, m.craterHalf * 0.045) * swell
    ctx.stroke()
    ctx.globalAlpha = Math.max(0, calderaHeat * lipCalm)
    ctx.strokeStyle = g.core
    ctx.lineWidth = 2.2
    ctx.stroke()
    ctx.lineCap = 'round'
  }
  for (const f of flows) {
    if (!f.head || f._heat <= 0.01 || f.pts.length < 3) continue
    // How far the lava has spilled over the lip: it surges with the caldera, and every channel keeps its own rhythm.
    const spill = 0.06 + 0.05 * breathe + 0.03 * Math.sin(t * f.rate * 3 + f.phase)
    const spillCalm = calmFactor(f.pts[1].x, f.pts[1].y)
    ctx.beginPath()
    traceSlice(ctx, f, 0, spill)
    // the channel's own heat ramp, so a tongue is the hot end of its channel and not a white spike
    ctx.globalAlpha = Math.max(0, f._heat * 0.5 * spillCalm)
    ctx.strokeStyle = f.ramp.bloom
    ctx.lineWidth = f.width * 2.6
    ctx.stroke()
    ctx.globalAlpha = Math.max(0, f._heat * 0.7 * spillCalm)
    ctx.strokeStyle = f.ramp.body
    ctx.lineWidth = f.width * 1.8
    ctx.stroke()
    // lava pooling where it tops the rim
    const pool = f.width * 11
    ctx.globalAlpha = Math.max(0, f._heat * 0.2 * (0.7 + breathe * 0.3) * spillCalm)
    ctx.drawImage(spriteGlow, f.pts[0].x - pool / 2, f.pts[0].y - pool / 2, pool, pool)
  }
  if (lip) {
    if (spits.length < SPIT_MAX && Math.random() < 0.11 * dt * tune.sparks * prof.density) spits.push(spawnSpit(m))
    for (let i = spits.length - 1; i >= 0; i--) {
      const s = spits[i]
      s.age += secs
      const life = s.age / s.life
      if (life >= 1) {
        spits[i] = spits[spits.length - 1]
        spits.pop()
        continue
      }
      if (s.bubble) {
        // swells, then bursts in a flash
        const r = s.size * (0.4 + life * 0.9)
        ctx.globalAlpha = Math.max(0, calderaHeat * 0.9 * (1 - life) * (life < 0.7 ? 0.6 : 1))
        ctx.drawImage(spriteGlow, s.x - r, s.y - r * 1.4, r * 2, r * 2)
      } else {
        s.vy += 0.13 * dt
        s.x += s.vx * dt
        s.y += s.vy * dt
        const r = s.size * 3.2
        ctx.globalAlpha = Math.max(0, calderaHeat * 0.6 * (1 - life))
        ctx.drawImage(spriteGlow, s.x - r, s.y - r, r * 2, r * 2)
        ctx.globalAlpha = Math.max(0, calderaHeat * (1 - life * 0.6))
        ctx.fillStyle = life < 0.5 ? '#ffe0a0' : '#ff9a4d'
        ctx.fillRect(s.x - s.size / 2, s.y - s.size / 2, s.size, s.size)
      }
    }
  }
  // The caldera lights the inner walls of the crown: a hot edge down each, so the crests belong to the mouth.
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const edge of [m.litL, m.litR]) {
    ctx.beginPath()
    ctx.moveTo(edge[0].x, edge[0].y)
    for (const p of edge) ctx.lineTo(p.x, p.y)
    ctx.globalAlpha = Math.max(0, calderaHeat * 0.3)
    ctx.strokeStyle = '#ff6a2b'
    ctx.lineWidth = Math.max(3, m.craterHalf * 0.07)
    ctx.stroke()
    ctx.globalAlpha = Math.max(0, calderaHeat * 0.75)
    ctx.strokeStyle = '#ffb066'
    ctx.lineWidth = 1.6
    ctx.stroke()
  }
  const ms = m.craterHalf * 2.6
  ctx.globalAlpha = Math.max(0, calderaHeat * 0.85)
  ctx.drawImage(spriteGlow, m.peakX - ms / 2, m.peakY - ms * 0.35, ms, ms * 0.7)

  // 5b. The near ash, in front of the rock — this is the half that makes the
  // fall read across the whole window rather than only in the open sky.
  if (ashOver.value && vctx) fallAsh(ashFront, vctx, true)
  else fallAsh(ashFront)

  // 6. The plume: continuous sparks and embers off the summit.
  ctx.lineCap = 'round'
  const stepParticle = (e, gravity) => {
    e.age += secs
    if (e.kind === 'spark') {
      e.px = e.x
      e.py = e.y
      e.vy += gravity * dt
      e.x += e.vx * tune.speed * dt
      e.y += e.vy * tune.speed * dt
    } else {
      e.y -= e.vy * tune.speed * dt
      e.phase += 0.026 * dt
      e.x += (e.vx + Math.sin(e.phase) * 0.15 * e.sway) * dt
    }
  }
  const paint = (e, fade) => {
    if (e.kind === 'spark') {
      ctx.globalAlpha = Math.max(0, e.alpha * fade)
      ctx.strokeStyle = e.green ? '#8bf09a' : '#ffd9a0'
      ctx.lineWidth = e.size * tune.scale
      ctx.beginPath()
      ctx.moveTo(e.px, e.py)
      ctx.lineTo(e.x, e.y)
      ctx.stroke()
      const hs = e.size * tune.scale * 3
      ctx.globalAlpha = Math.max(0, e.alpha * fade * 0.7)
      ctx.drawImage(spriteGlow, e.x - hs / 2, e.y - hs / 2, hs, hs)
      return
    }
    const flick = 0.74 + Math.sin(e.phase * 2.4) * 0.26
    const es = e.size * tune.scale
    ctx.globalAlpha = Math.max(0, e.alpha * fade * flick)
    ctx.drawImage(spriteGlow, e.x - es / 2, e.y - es / 2, es, es)
    if (e.green) {
      ctx.globalAlpha = Math.max(0, e.alpha * fade * flick * 0.5)
      ctx.fillStyle = '#59d66c'
      ctx.beginPath()
      ctx.arc(e.x, e.y, es * 0.32, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  for (const e of drift) {
    stepParticle(e, 0.055)
    if (e.age >= e.life || e.y < -40 || e.y > h + 40) {
      Object.assign(e, spawnDrift(w, h, true))
      continue
    }
    paint(e, lifeFade(e))
  }

  // 7. Eruption sparks.
  for (let i = burst.length - 1; i >= 0; i--) {
    const s = burst[i]
    s.kind = 'spark'
    stepParticle(s, 0.07)
    if (s.age >= s.life || s.y > h + 30) {
      burst.splice(i, 1)
      continue
    }
    paint(s, 1 - s.age / s.life)
  }

  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

function frame(now) {
  if (stopped) return
  raf = requestAnimationFrame(frame)
  if (hidden) return
  const real = now - last
  if (real < 1000 / FPS) return
  last = now
  // the forge playground can freeze, step or speed the clock; without it the clock is the clock
  const elapsed = forgeAdvance(forge, real, 1000 / FPS)
  if (elapsed <= 0) return
  const dt = Math.min(elapsed / 16.7, 3)
  t += elapsed / 1000

  if (tune.sparks > 0 && tune.eruptRate > 0 && t >= nextPulse) {
    erupt()
    nextPulse = t + rand(2.5, 9) / tune.eruptRate
  }

  if (forge) {
    const t0 = performance.now()
    draw(dt)
    forgeSample(forge, performance.now() - t0, real)
  } else draw(dt)
}

const onVisibility = () => (hidden = document.hidden)

watch(() => route.path, () => {
  if (!layout()) return
  const cold = !!lava?.cold // before the draw, as in relayout
  draw(1)
  // A new page can have a different number of channels, which lights the sim cold again: a still page burns it once
  // more, as relayout does, or it would show grey crust until the next reload. Only when cold, as relayout does.
  if (cold && mode.value === 'still' && !forge?.frozen) burnStill()
})

watch(
  () => [
    tune.height,
    tune.width,
    tune.offsetX,
    tune.flows,
    tune.ridges,
    tune.ash,
    tune.count,
    tune.faceSpread,
    randomize.offsetX,
    randomize.flows,
    randomize.ridges,
    randomize.asymmetry,
    // This page's profile, so tuning it in the panel rebuilds immediately.
    profileFor(route.path).bearing,
    profileFor(route.path).scale,
    profileFor(route.path).variance,
    profileFor(route.path).density,
  ],
  () => {
    if (layout()) draw(1)
  },
)

onMounted(() => {
  if (!layout()) return

  // Resize handling is set up before the reduced-motion branch: a still frame
  // still has to be the right size. It used to be registered only on the live
  // path, so with reduced motion on, the mountain kept whatever dimensions the
  // first paint gave it for the life of the page.
  window.addEventListener('resize', relayout, { passive: true })
  // The window event misses anything that changes the box without resizing the
  // window — an embedded context, or a scrollbar coming and going.
  if ('ResizeObserver' in window && host.value) {
    resizeObserver = new ResizeObserver(relayout)
    resizeObserver.observe(host.value)
  }

  // The hero's other plate (this window's own was asked for by the layout above): fetched when the browser is idle, so a
  // resize or a turn of the phone does not wait on it. Only the plates that exist, and only from the hero.
  if (route.path === '/') {
    cancelPrefetch = whenIdle(() => {
      plateLoader.load('/', 'wide')
      plateLoader.load('/', 'portrait')
    })
  }

  if (!motionAllowed()) {
    t = 2.5
    draw(1)
    mode.value = 'still'
    loadLava()
    return
  }

  mode.value = 'live'
  raf = requestAnimationFrame(frame)
  requestAnimationFrame(loadLava) // queued behind the first frame, so the shader is fetched only once that has painted
  document.addEventListener('visibilitychange', onVisibility)

  if (forge) {
    // the forge playground's hands on this volcano; ?t=120 opens frozen at that second (the grid uses it)
    forge.actions = {
      erupt: (k = 1) => erupt(k),
      trial: (tier) => {
        trialTier = tier
        trialAt = 0
        trialClock = 0
      },
      seek: (sec) => {
        t = sec
        // The flow at that second comes from the sim run cold to it in one batch, not from stepping frames.
        if (lava?.ok) forgeBurn(sec)
        else draw(1)
      },
      time: () => t,
      snapshot: () => canvas.value,
      // The heat sim's cells as RGBA bytes (the Sim view): size it from simSize, which is the layer's own grid and
      // undefined until the layer is up. The grid is fixed when the layer is made, so it can differ from a phone's now.
      readSim: (out) => lava?.readSim(out),
      simSize: () => (lava?.ok ? lava.simSize : undefined),
      // Where the channels are, in viewport px, for the render harness's smoke probes (scripts/forge-render.mjs). The pool
      // is its ellipse without `arcY` (a function does not survive the harness's JSON).
      geometry: () => ({
        lava: Boolean(lava?.ok) && lavaFade > 0, // the shader is built, running and painting, so a picture is of it and not the ribbons
        vent: mountain?.vent,
        flows: flows.map((f) => ({ kind: f.kind, role: f.role, pts: f.pts, head: f.head, drain: f.drain, widthAt0: f.widthAt?.(0), widthMid: f.widthAt?.(0.5) })),
        joins,
        pool: lavaPool && { cx: lavaPool.cx, cy: lavaPool.cy, rx: lavaPool.rx, ry: lavaPool.ry, arcTop: lavaPool.arcTop },
        fissures,
      }),
    }
    window.__forge = forge
    // The render grid's lava presets arrive as query params (?crust=0.3&heat=1.2), one per tuner value, applied before the first frame.
    for (const key of Object.keys(fireTuning.lava)) {
      const v = devNumber(key)
      if (v !== null) fireTuning.lava[key] = v
    }
    const at = devNumber('t')
    if (at !== null) {
      t = at
      forge.frozen = true
      draw(1)
    }
  }
})

onBeforeUnmount(() => {
  stopped = true
  cancelAnimationFrame(raf)
  cancelAnimationFrame(relayoutPending)
  relayoutPending = 0
  window.removeEventListener('resize', relayout)
  resizeObserver?.disconnect()
  resizeObserver = null
  document.removeEventListener('visibilitychange', onVisibility)
  cancelPrefetch?.()
  cancelPrefetch = null
  dropPlate()
  plateWanted = ''
  lavaWanted = false
  lava?.dispose()
  lava = null
  lavaFade = 0
  mountain = null
  ridges = []
  flows = []
  fissures = []
  joins = []
  lavaPool = null
  lip = null
  moon = null
  calmRects = []
  trialAt = -1
  spits = []
  drift = []
  burst = []
  ashBack = []
  ashFront = []
  silhouette = null
  farRidges = null
})
</script>

<template>
  <div ref="host" class="deathfire" :data-mode="mode" aria-hidden="true">
    <!-- The painted heat haze. A layer of its own, so its opacity can follow the caldera each frame without
         fading the canvas on top of it. -->
    <div ref="glowEl" class="deathfire-glow" :style="glowStyle" />
    <canvas ref="canvas" class="deathfire-canvas" />
  </div>
  <canvas v-show="ashOver" ref="veil" class="deathfire-veil" aria-hidden="true" />
</template>

<style scoped>
.deathfire {
  position: fixed;
  inset: 0;
  /* Behind all content, above the ambient gradient on body::before (-2). */
  z-index: -1;
  pointer-events: none;
}
.deathfire-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.deathfire-glow {
  position: absolute;
  inset: 0;
  will-change: opacity;
}
/* Above page content, below the nav (z 50). */
.deathfire-veil {
  position: fixed;
  inset: 0;
  z-index: 40;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
