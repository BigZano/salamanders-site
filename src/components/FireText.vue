<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { DoomFire, motionAllowed } from '../lib/doomfire'

/**
 * Pixel fire burning inside the letterforms.
 *
 * The real text stays in the DOM and owns layout and accessibility; the canvas
 * sits on top and repaints the same string, composited so the fire is clipped
 * to the glyphs. A base gradient underneath keeps the letters legible where the
 * fire runs cold, since raw Doom fire goes to black at its tips.
 */
const props = defineProps({
  text: { type: String, required: true },
  /** CSS px per fire pixel — smaller is finer grained. */
  pixel: { type: Number, default: 2 },
  /** Simulation rate multiplier. Below 1 makes the flame roll rather than race. */
  speed: { type: Number, default: 0.75 },
  /** Fraction of the glyph height the fire climbs, leaving cold caps above. */
  maxHeight: { type: Number, default: 0.75 },
  /** Sideways wander and cooling randomness. */
  variation: { type: Number, default: 0.8 },
  /** Heat and brightness multiplier. */
  intensity: { type: Number, default: 1.1 },
  /** Brightness of the un-burnt base of each glyph, 0..1. */
  base: { type: Number, default: 0.35 },
})

const host = ref(null)
const label = ref(null)
const canvas = ref(null)
const lit = ref(false)

let fire = null
let raf = 0
let stopped = false
let off = null
let offCtx = null
let img = null
let io = null
let ro = null
let visible = true
let last = 0
let metrics = null

const BASE_FPS = 30 // Doom ran slow; the chunky cadence is part of the look

const fontString = (cs) => `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`

/**
 * Measure the painted glyph box. The element's own box can't be trusted here:
 * .wordmark sets line-height below 1, so ascenders spill outside it and a canvas
 * sized to the element clips the tops of the letters.
 */
function measure() {
  const el = label.value
  if (!el) return null
  const cs = getComputedStyle(el)
  const box = el.getBoundingClientRect()
  const probe = document.createElement('canvas').getContext('2d')
  probe.font = fontString(cs)
  const spacing = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0
  if ('letterSpacing' in probe) probe.letterSpacing = `${spacing}px`

  const glyphs = cs.textTransform === 'uppercase' ? props.text.toUpperCase() : props.text
  const m = probe.measureText(glyphs)
  const ascent = m.actualBoundingBoxAscent || parseFloat(cs.fontSize) * 0.75
  const descent = m.actualBoundingBoxDescent || parseFloat(cs.fontSize) * 0.25

  // Where the baseline sits inside the element box, then pad out to the glyphs.
  const baseline = box.height / 2 + (ascent - descent) / 2
  const bleedTop = Math.max(0, Math.ceil(ascent - baseline) + 2)
  const bleedBottom = Math.max(0, Math.ceil(descent - (box.height - baseline)) + 2)
  const bleedX = Math.ceil(Math.abs(spacing)) + 4

  return {
    cs,
    box,
    glyphs,
    spacing,
    baseline: baseline + bleedTop,
    width: box.width + bleedX * 2,
    height: box.height + bleedTop + bleedBottom,
    bleedTop,
    bleedX,
  }
}

function layout() {
  const cv = canvas.value
  metrics = measure()
  if (!cv || !metrics || metrics.width < 4 || metrics.height < 4) return false

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  cv.width = Math.ceil(metrics.width * dpr)
  cv.height = Math.ceil(metrics.height * dpr)
  cv.style.width = `${metrics.width}px`
  cv.style.height = `${metrics.height}px`
  cv.style.left = `${-metrics.bleedX}px`
  cv.style.top = `${-metrics.bleedTop}px`

  const gw = Math.max(8, Math.ceil(metrics.width / props.pixel))
  const gh = Math.max(8, Math.ceil((metrics.height * props.maxHeight) / props.pixel))

  const opts = {
    decay: 0.9,
    variation: props.variation,
    intensity: props.intensity,
  }
  if (!fire) fire = new DoomFire(gw, gh, opts)
  else {
    Object.assign(fire, opts)
    fire.resize(gw, gh)
  }

  off = document.createElement('canvas')
  off.width = gw
  off.height = gh
  offCtx = off.getContext('2d')
  img = offCtx.createImageData(gw, gh)
  return true
}

function draw() {
  const cv = canvas.value
  if (!cv || !offCtx || !metrics) return
  const ctx = cv.getContext('2d')
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const { width: w, height: h } = metrics

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  // 1. Base fill — dark ember, so the glyphs never read as black holes. It has
  //    to stay dim: the fire is added on top, and a bright base clips the whole
  //    wordmark to one flat colour.
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#4a1a08')
  grad.addColorStop(0.45, '#8c3410')
  grad.addColorStop(1, '#c9501c')
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = Math.max(0, Math.min(1, props.base))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  ctx.globalAlpha = 1

  // 2. Fire added on top, rising only through the lower maxHeight of the glyphs.
  fire.toImageData(img)
  offCtx.putImageData(img, 0, 0)
  ctx.globalCompositeOperation = 'lighter'
  ctx.imageSmoothingEnabled = false
  const fh = h * props.maxHeight
  ctx.drawImage(off, 0, h - fh, w, fh)

  // 3. Clip it all to the glyphs.
  ctx.globalCompositeOperation = 'destination-in'
  ctx.font = fontString(metrics.cs)
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${metrics.spacing}px`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#fff'
  // Letter-spacing adds a trailing gap that drags centred text left by half.
  ctx.fillText(metrics.glyphs, w / 2 + metrics.spacing / 2, metrics.baseline)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
}

function frame(now) {
  if (stopped) return
  raf = requestAnimationFrame(frame)
  if (!visible) return
  if (now - last < 1000 / (BASE_FPS * props.speed)) return
  last = now
  fire.step()
  draw()
}

async function start() {
  // Glyph metrics are wrong until the display face has actually loaded.
  try {
    await document.fonts?.ready
  } catch {}
  if (stopped || !layout()) return

  if (!motionAllowed()) {
    for (let i = 0; i < 60; i++) fire.step()
    draw()
    lit.value = true
    return
  }
  lit.value = true
  raf = requestAnimationFrame(frame)
}

onMounted(() => {
  start()
  if ('IntersectionObserver' in window && host.value) {
    io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.01 })
    io.observe(host.value)
  }
  if ('ResizeObserver' in window && label.value) {
    ro = new ResizeObserver(() => {
      if (layout()) draw()
    })
    ro.observe(label.value)
  }
})

watch(
  () => [props.pixel, props.maxHeight, props.variation, props.intensity, props.base],
  () => {
    if (layout()) draw()
  },
)

onBeforeUnmount(() => {
  stopped = true
  cancelAnimationFrame(raf)
  io?.disconnect()
  ro?.disconnect()
  fire = null
  off = null
})
</script>

<template>
  <span ref="host" class="firetext">
    <span ref="label" class="firetext-label" :class="{ lit }">{{ text }}</span>
    <canvas ref="canvas" class="firetext-canvas" aria-hidden="true" />
  </span>
</template>

<style scoped>
.firetext {
  position: relative;
  display: inline-block;
}
.firetext-label {
  display: block;
  /* Fallback paint until the canvas takes over, and the text screen readers
     and search engines get either way. */
  background: linear-gradient(180deg, #fff2e0 0%, #ffd6a0 40%, #ff8a3d 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.firetext-label.lit {
  background: none;
}
.firetext-canvas {
  position: absolute;
  pointer-events: none;
}
</style>
