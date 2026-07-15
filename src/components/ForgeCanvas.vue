<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

/**
 * Forge ember field. Renders rising, flickering embers on a transparent
 * WebGL canvas via PixiJS. Mobile-adaptive (particle count scales with
 * screen area + device), pauses when scrolled offscreen, respects
 * prefers-reduced-motion, and degrades to a CSS-only ember drift when
 * WebGL is unavailable.
 */
const props = defineProps({
  // relative density of the ember field
  intensity: { type: Number, default: 1 },
  // occasional green "drake spark" embers among the orange
  drakeSparks: { type: Boolean, default: true },
})

const host = ref(null)
const mode = ref('loading') // 'webgl' | 'css' | 'static'

let app = null
let embers = []
let io = null
let destroyed = false

const reduceMotion =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function hasWebGL() {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

// Small radial-gradient sprite texture, tinted per ember.
function makeEmberTexture(Texture) {
  const s = 48
  const cv = document.createElement('canvas')
  cv.width = cv.height = s
  const g = cv.getContext('2d')
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.35, 'rgba(255,255,255,0.7)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, s, s)
  return Texture.from(cv)
}

const EMBER_COLORS = [0xff6a2b, 0xe0431d, 0xffb066, 0xdfb85b]
const DRAKE_COLOR = 0x59d66c

function rand(a, b) {
  return a + Math.random() * (b - a)
}

function targetCount() {
  const w = host.value?.clientWidth || window.innerWidth
  const h = host.value?.clientHeight || 400
  const area = w * h
  const cores = navigator.hardwareConcurrency || 4
  const mobile = window.matchMedia?.('(max-width: 768px)').matches
  let base = Math.min(area / 5200, 220) // cap
  if (mobile) base *= 0.45
  if (cores <= 4) base *= 0.7
  base *= props.intensity
  return Math.max(18, Math.round(base))
}

function resetEmber(e, W, H, fromBottom) {
  e.x = rand(0, W)
  e.y = fromBottom ? H + rand(0, 40) : rand(0, H)
  e.vy = rand(0.25, 1.1)
  e.vx = rand(-0.18, 0.18)
  e.size = rand(0.12, 0.5)
  e.phase = rand(0, Math.PI * 2)
  e.sway = rand(0.4, 1.4)
  e.baseAlpha = rand(0.3, 0.9)
  const green = props.drakeSparks && Math.random() < 0.12
  e.sprite.tint = green ? DRAKE_COLOR : EMBER_COLORS[(Math.random() * EMBER_COLORS.length) | 0]
}

async function initPixi() {
  const PIXI = await import('pixi.js')
  if (destroyed) return
  const { Application, Container, Sprite, Texture } = PIXI

  app = new Application()
  await app.init({
    antialias: true,
    backgroundAlpha: 0,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    resizeTo: host.value,
    powerPreference: 'high-performance',
  })
  if (destroyed) {
    try { app.destroy({ removeView: true }); } catch {}
    return
  }
  host.value.appendChild(app.canvas)
  app.canvas.style.width = '100%'
  app.canvas.style.height = '100%'

  const tex = makeEmberTexture(Texture)
  const layer = new Container()
  app.stage.addChild(layer)

  // Base forge glow — a couple of big soft sprites near the bottom.
  for (let i = 0; i < 2; i++) {
    const glow = new Sprite(tex)
    glow.anchor.set(0.5)
    glow.tint = i === 0 ? 0xe0431d : 0xff6a2b
    glow.alpha = 0.16
    glow.blendMode = 'add'
    glow.scale.set(14)
    glow._glowSeed = i
    layer.addChild(glow)
    embers.push({ sprite: glow, glow: true, seed: i })
  }

  const count = targetCount()
  const W = app.screen.width
  const H = app.screen.height
  for (let i = 0; i < count; i++) {
    const sprite = new Sprite(tex)
    sprite.anchor.set(0.5)
    sprite.blendMode = 'add'
    const e = { sprite, glow: false }
    layer.addChild(sprite)
    resetEmber(e, W, H, false)
    embers.push(e)
  }

  let t = 0
  app.ticker.add((ticker) => {
    const dt = ticker.deltaTime
    t += dt * 0.02
    const W = app.screen.width
    const H = app.screen.height
    for (const e of embers) {
      if (e.glow) {
        e.sprite.x = W * (e.seed === 0 ? 0.34 : 0.68)
        e.sprite.y = H + 30
        e.sprite.alpha = 0.13 + Math.sin(t + e.seed * 2) * 0.05
        continue
      }
      e.y -= e.vy * dt
      e.phase += 0.03 * dt
      e.x += (e.vx + Math.sin(e.phase) * 0.15 * e.sway) * dt
      const flick = 0.75 + Math.sin(e.phase * 2.3) * 0.25
      // fade near the top
      const fade = Math.min(1, e.y / (H * 0.85))
      e.sprite.x = e.x
      e.sprite.y = e.y
      e.sprite.alpha = e.baseAlpha * flick * fade
      e.sprite.scale.set(e.size)
      if (e.y < -30) resetEmber(e, W, H, true)
    }
  })

  mode.value = 'webgl'
  setupObserver()
}

function setupObserver() {
  if (!('IntersectionObserver' in window) || !host.value) return
  io = new IntersectionObserver(
    ([entry]) => {
      if (!app) return
      if (entry.isIntersecting) app.ticker.start()
      else app.ticker.stop()
    },
    { threshold: 0.01 },
  )
  io.observe(host.value)
}

onMounted(() => {
  if (reduceMotion) {
    mode.value = 'static'
    return
  }
  if (!hasWebGL()) {
    mode.value = 'css'
    return
  }
  initPixi().catch((err) => {
    console.warn('[ForgeCanvas] WebGL init failed, falling back to CSS.', err)
    mode.value = 'css'
  })
})

onBeforeUnmount(() => {
  destroyed = true
  io?.disconnect()
  embers = []
  if (app) {
    try {
      app.destroy({ removeView: true }, { children: true, texture: true })
    } catch {}
    app = null
  }
})
</script>

<template>
  <div ref="host" class="forge-canvas" :data-mode="mode" aria-hidden="true">
    <!-- CSS fallback: cheap drifting embers -->
    <div v-if="mode === 'css'" class="forge-css">
      <span v-for="n in 22" :key="n" class="css-ember" :style="`--i:${n}`" />
    </div>
  </div>
</template>

<style scoped>
.forge-canvas {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.forge-canvas :deep(canvas) {
  position: absolute;
  inset: 0;
}

/* Static + CSS modes get a painted forge glow so it never looks empty */
.forge-canvas[data-mode='static']::after,
.forge-canvas[data-mode='css']::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(
    90% 70% at 50% 118%,
    rgba(224, 67, 29, 0.28),
    transparent 62%
  );
}

.forge-css {
  position: absolute;
  inset: 0;
}
.css-ember {
  position: absolute;
  bottom: -12px;
  left: calc((var(--i) * 4.5%) - 4%);
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: radial-gradient(circle, #ffb066, #ff6a2b 60%, transparent);
  opacity: 0;
  animation: rise calc(6s + (var(--i) * 0.23s)) linear infinite;
  animation-delay: calc(var(--i) * -0.42s);
}
@keyframes rise {
  0% {
    transform: translateY(0) translateX(0);
    opacity: 0;
  }
  12% {
    opacity: 0.9;
  }
  100% {
    transform: translateY(-105%) translateX(18px);
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .css-ember {
    animation: none;
    opacity: 0;
  }
}
</style>
