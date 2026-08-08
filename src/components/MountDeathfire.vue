<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { motionAllowed } from '../lib/doomfire'
import { fireTuning, randomize } from '../lib/fireTuning'

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
 */

const tune = fireTuning.bed

const host = ref(null)
const canvas = ref(null)
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
let silhouette = null // cached rock, redrawn only on resize
let drift = [] // continuous sparks/embers off the summit
let burst = [] // sparks thrown by an eruption pulse
let ash = []
let spriteGlow = null
let nextPulse = 0

// Runtime randomness — particles, which should never repeat.
const rand = (a, b) => a + Math.random() * (b - a)

/**
 * Terrain randomness is *seeded*, so each route gets its own face of the
 * mountain and keeps it. Walk away from the Armoury and come back and you're
 * standing on the same side of Deathfire you left.
 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

const hashString = (s) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const route = useRoute()
let rng = mulberry32(1)
/** Seeded generation randomness. */
const grand = (a, b) => a + rng() * (b - a)

// Where this page's peak sits, derived from the route seed around tune.offsetX.
// Reactive so the painted sky glow follows it.
const face = ref(0.5)
let faceOffset = 0.5

/**
 * Reseed for the current route. tune.offsetX is the centre of the range and
 * faceSpread is how far a page may wander from it, so spread 0 puts every page
 * on the same face and larger values give each page its own side of the peak.
 */
function seedForRoute() {
  rng = mulberry32(hashString(route.path || '/') ^ 0x5a1a)
  const spread = randomize.offsetX ? tune.faceSpread : 0
  faceOffset = Math.max(0.1, Math.min(0.9, tune.offsetX + grand(-spread, spread)))
  face.value = faceOffset
}

const glowStyle = computed(() => ({
  background: `radial-gradient(90% 55% at ${(face.value * 100).toFixed(0)}% 100%,
    rgba(224, 67, 29, ${tune.glow}),
    rgba(150, 35, 15, ${(tune.glow * 0.35).toFixed(3)}) 40%,
    transparent 72%)`,
}))

function makeGlow() {
  const s = 64
  const cv = document.createElement('canvas')
  cv.width = cv.height = s
  const g = cv.getContext('2d')
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.2, 'rgba(255,214,150,0.9)')
  grd.addColorStop(0.5, 'rgba(255,106,43,0.4)')
  grd.addColorStop(1, 'rgba(224,67,29,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, s, s)
  return cv
}

/**
 * A cone with a broken crater at the top. Slopes are walked in steps with
 * jitter so the flanks read as fractured basalt rather than a clean triangle,
 * and the jitter shrinks near the summit where the rock is younger.
 */
function buildMountain(w, h) {
  const peakX = w * faceOffset
  const peakY = h - tune.height
  const halfBase = (w * tune.width) / 2
  const craterHalf = Math.max(18, tune.height * 0.13)

  // The cone's own profile. Static by default: varying it per route stops it
  // being Deathfire seen from another side and makes it a different mountain.
  // Turn on "Cone profile" in the panel to let each face reshape it.
  const vary = randomize.asymmetry
  const leftSpread = vary ? grand(0.78, 1.24) : 1
  const rightSpread = vary ? grand(0.78, 1.24) : 1
  const leftCurve = vary ? grand(1.3, 1.7) : 1.45
  const rightCurve = vary ? grand(1.3, 1.7) : 1.45

  const flank = (dir) => {
    const pts = []
    const steps = 26
    const spread = dir < 0 ? leftSpread : rightSpread
    const curve = dir < 0 ? leftCurve : rightCurve
    for (let i = 0; i <= steps; i++) {
      const f = i / steps // 0 at crater rim, 1 at base
      // Concave profile: volcanoes flare out as they descend.
      const eased = Math.pow(f, curve)
      const x = peakX + dir * (craterHalf + eased * (halfBase * spread - craterHalf))
      const y = peakY + f * tune.height
      // Less jitter high up, more on the old broken skirts below.
      const jitter = (vary ? grand(-1, 1) : 0) * tune.height * 0.03 * (0.25 + f)
      pts.push({ x, y: y + jitter })
    }
    return pts
  }

  const left = flank(-1)
  const right = flank(1)

  return {
    peakX,
    peakY,
    craterHalf,
    left,
    right,
    // Crater rim dips slightly on one side, as if blown out.
    rimL: { x: peakX - craterHalf, y: peakY + (vary ? grand(0, 6) : 2) },
    rimR: { x: peakX + craterHalf, y: peakY + (vary ? grand(4, 12) : 8) },
  }
}

/** Lower, dimmer cones behind the main peak so the horizon has depth. */
function buildRidges(w, h) {
  const count = Math.max(0, Math.round(tune.ridges))
  return Array.from({ length: count }, () => {
    const height = tune.height * grand(0.22, 0.42)
    // Bias away from the main peak so the far range isn't swallowed by it.
    const side = rng() < 0.5 ? -1 : 1
    const parallax = randomize.ridges ? grand(-0.18, 0.18) : 0
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

/**
 * Lava spilling from the crater and running down the face of the cone.
 *
 * Positions are expressed as a fraction across the mountain's width at each
 * height, not as an offset from a flank. Offsetting from the flank line pushed
 * the channels off the silhouette entirely and left the front face bare — which
 * is where lava is actually visible.
 */
function buildFlows() {
  const out = []
  const count = Math.max(0, Math.round(tune.flows))
  const rows = mountain.left.length

  for (let i = 0; i < count; i++) {
    // Where it leaves the crater, as a fraction of the rim (-1 left, 1 right).
    let u = randomize.flows ? grand(-0.85, 0.85) : -0.85 + (i / Math.max(1, count - 1)) * 1.7
    const endAt = grand(0.45, 1)
    const pts = []

    for (let s = 0; s < rows; s++) {
      const f = s / (rows - 1)
      if (f > endAt) break
      const l = mountain.left[s]
      const r = mountain.right[s]
      const cx = (l.x + r.x) / 2
      const halfW = (r.x - l.x) / 2

      // Gentle meander, and lava tends to run away from the centreline as the
      // slope broadens rather than tracking straight down.
      u += grand(-0.05, 0.05) + Math.sign(u) * 0.012
      u = Math.max(-0.94, Math.min(0.94, u))

      pts.push({ x: cx + u * halfW, y: (l.y + r.y) / 2 })
    }

    if (pts.length < 2) continue
    out.push({
      pts,
      width: grand(1.6, 4.2),
      phase: grand(0, Math.PI * 2),
      rate: grand(0.12, 0.4),
      heat: grand(0.55, 1),
    })
  }
  return out
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

function spawnAsh(w, h, atTop) {
  return {
    x: rand(-30, w + 30),
    y: atTop ? rand(-60, -10) : rand(0, h),
    vy: rand(0.12, 0.42),
    drift: rand(-0.22, 0.22),
    size: rand(1, 2.6),
    phase: rand(0, Math.PI * 2),
    sway: rand(0.4, 1.5),
    alpha: rand(0.1, 0.32),
  }
}

/** Cache the rock, which only changes on resize. */
function buildSilhouette(w, h) {
  const cv = document.createElement('canvas')
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  cv.width = Math.ceil(w * dpr)
  cv.height = Math.ceil(h * dpr)
  const g = cv.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)

  // Distant ridges first, dimmer the further back they sit.
  for (const r of ridges) {
    g.beginPath()
    g.moveTo(r.pts[0].x, h + 20)
    for (const p of r.pts) g.lineTo(p.x, p.y)
    g.lineTo(r.pts[r.pts.length - 1].x, h + 20)
    g.closePath()
    g.fillStyle = `rgba(9, 18, 15, ${r.depth})`
    g.fill()
  }

  // The mountain itself.
  const m = mountain
  g.beginPath()
  g.moveTo(m.left[m.left.length - 1].x, h + 20)
  for (let i = m.left.length - 1; i >= 0; i--) g.lineTo(m.left[i].x, m.left[i].y)
  g.lineTo(m.rimL.x, m.rimL.y)
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

function layout() {
  const cv = canvas.value
  if (!cv) return false
  const w = window.innerWidth
  const h = window.innerHeight
  if (w < 2 || h < 2) return false

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  cv.width = Math.ceil(w * dpr)
  cv.height = Math.ceil(h * dpr)
  cv.style.width = `${w}px`
  cv.style.height = `${h}px`

  if (!spriteGlow) spriteGlow = makeGlow()
  seedForRoute()
  mountain = buildMountain(w, h)
  ridges = buildRidges(w, h)
  flows = buildFlows()
  silhouette = buildSilhouette(w, h)

  const mobile = window.matchMedia?.('(max-width: 768px)').matches
  burst = []
  // Honour the slider. This used to be min(w/16, count), which silently capped
  // a requested 112 to 94 on a 1500px screen and made the plume look thin.
  const n = Math.round(tune.count * (mobile ? 0.45 : 1))
  drift = Array.from({ length: n }, () => spawnDrift(w, h, false))
  ash = Array.from({ length: Math.round(tune.ash * (mobile ? 0.5 : 1)) }, () =>
    spawnAsh(w, h, false),
  )
  return true
}

/** A pulse from the vent: a burst of sparks straight up out of the crater. */
function erupt() {
  if (!mountain) return
  const n = Math.round(rand(6, 22) * tune.sparks)
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

  // 1. Ash, falling behind the mountain.
  ctx.globalCompositeOperation = 'source-over'
  for (const a of ash) {
    a.y += a.vy * dt
    a.phase += 0.02 * dt
    a.x += (a.drift + Math.sin(a.phase) * 0.2 * a.sway) * dt
    if (a.y > h + 20) Object.assign(a, spawnAsh(w, h, true))
    ctx.globalAlpha = a.alpha
    ctx.fillStyle = '#6b6560'
    ctx.fillRect(a.x, a.y, a.size, a.size)
  }
  ctx.globalAlpha = 1

  // 2. Light thrown up out of the caldera, behind the rock.
  const flare = m.flare || 0
  const breathe = 0.6 + Math.sin(t * 0.45) * 0.4
  const calderaHeat = (tune.caldera * breathe + flare * 0.7) * 1.1
  ctx.globalCompositeOperation = 'lighter'
  const cs = m.craterHalf * (7 + flare * 2)
  ctx.globalAlpha = Math.max(0, calderaHeat * 0.5)
  ctx.drawImage(spriteGlow, m.peakX - cs / 2, m.peakY - cs * 0.62, cs, cs * 0.9)
  if (m.flare) m.flare = Math.max(0, m.flare - secs * 1.8)

  // 3. The rock.
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.drawImage(silhouette, 0, 0, w, h)

  // 4. Lava running down the flanks, drawn over the rock as channels through it.
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const f of flows) {
    const pulse = 0.45 + Math.sin(t * f.rate + f.phase) * 0.55
    const heat = f.heat * pulse * tune.flowHeat
    if (heat <= 0.01) continue
    ctx.beginPath()
    ctx.moveTo(f.pts[0].x, f.pts[0].y)
    for (const p of f.pts) ctx.lineTo(p.x, p.y)

    // Bloom, body, then a tight core — molten rock never reads as one stroke.
    ctx.globalAlpha = Math.max(0, heat * 0.22)
    ctx.strokeStyle = '#e0431d'
    ctx.lineWidth = f.width * 6
    ctx.stroke()
    ctx.globalAlpha = Math.max(0, heat * 0.8)
    ctx.strokeStyle = '#ff8a3d'
    ctx.lineWidth = f.width * 1.8
    ctx.stroke()
    ctx.globalAlpha = Math.max(0, heat)
    ctx.strokeStyle = '#ffe6c0'
    ctx.lineWidth = f.width * 0.55
    ctx.stroke()
  }

  // 5. The lit crater mouth.
  ctx.globalAlpha = Math.max(0, calderaHeat)
  ctx.strokeStyle = '#ffd9a0'
  ctx.lineWidth = 2.4
  ctx.beginPath()
  ctx.moveTo(m.rimL.x, m.rimL.y)
  ctx.lineTo(m.rimR.x, m.rimR.y)
  ctx.stroke()
  const ms = m.craterHalf * 2.6
  ctx.globalAlpha = Math.max(0, calderaHeat * 0.85)
  ctx.drawImage(spriteGlow, m.peakX - ms / 2, m.peakY - ms * 0.35, ms, ms * 0.7)

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
  const elapsed = now - last
  if (elapsed < 1000 / FPS) return
  const dt = Math.min(elapsed / 16.7, 3)
  last = now
  t += elapsed / 1000

  if (tune.sparks > 0 && tune.eruptRate > 0 && t >= nextPulse) {
    erupt()
    nextPulse = t + rand(2.5, 9) / tune.eruptRate
  }

  draw(dt)
}

const onVisibility = () => (hidden = document.hidden)

watch(() => route.path, () => {
  if (layout()) draw(1)
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
  ],
  () => {
    if (layout()) draw(1)
  },
)

onMounted(() => {
  if (!layout()) return

  if (!motionAllowed()) {
    t = 2.5
    draw(1)
    mode.value = 'still'
    return
  }

  mode.value = 'live'
  raf = requestAnimationFrame(frame)
  window.addEventListener('resize', layout, { passive: true })
  document.addEventListener('visibilitychange', onVisibility)
})

onBeforeUnmount(() => {
  stopped = true
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', layout)
  document.removeEventListener('visibilitychange', onVisibility)
  mountain = null
  ridges = []
  flows = []
  drift = []
  burst = []
  ash = []
  silhouette = null
})
</script>

<template>
  <div ref="host" class="deathfire" :data-mode="mode" :style="glowStyle" aria-hidden="true">
    <canvas ref="canvas" class="deathfire-canvas" />
  </div>
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
</style>
