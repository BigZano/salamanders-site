<script setup>
// The plaque every archive page sits on: a darkened brass backing, heat-
// tempered along the edge that faces Mount Deathfire, engraved with scrollwork
// whose fresh cuts show bright metal, and a blackened-iron inlay for the text.
// Its halo swells and flares with the volcano itself (deathfireHeat); the near
// ash falls across it (MountDeathfire, meta.ashOver).
import { ref, h, onMounted, onBeforeUnmount } from 'vue'
import { deathfireHeat } from '../../lib/deathfireHeat'
import { motionAllowed } from '../../lib/doomfire'
import * as wrought from './wrought'
import { drakeSkull } from './drakeSkull'

defineProps({ narrow: { type: Boolean, default: false } })

const wrap = ref(null)
let raf = 0
function tick() {
  raf = requestAnimationFrame(tick)
  const heat = 0.55 + deathfireHeat.breathe * 0.3 + deathfireHeat.flare * 0.7
  wrap.value?.style.setProperty('--heat', heat.toFixed(3))
}
onMounted(() => { if (motionAllowed()) raf = requestAnimationFrame(tick) })
onBeforeUnmount(() => cancelAnimationFrame(raf))

// A cut in darkened brass: a shadow edge, then the bright metal the graver exposed.
const CUT = '#f3c45c'
const SHADOW = '#140a02'

/** A piece as SVG nodes: the bright cuts and punched beads, then (on the lit pass) the dark veins cut into them. */
function svgNodes(p, color, veins) {
  return [
    ['path', { d: p.cuts, fill: color }],
    ...p.beads.map((b) => ['circle', { cx: b.cx, cy: b.cy, r: b.r, fill: color }]),
    ...(veins && p.veins ? [['path', { d: p.veins, fill: SHADOW, opacity: 0.85 }]] : []),
  ]
}
const toVNodes = (nodes) => nodes.map(([tag, attrs]) => h(tag, attrs))
const toMarkup = (nodes) => nodes.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('')

const Engraving = (props) => h('svg', { viewBox: props.box, class: props.class, 'aria-hidden': 'true' }, [
  h('g', { transform: 'translate(0.45 0.65)', opacity: 0.85 }, toVNodes(svgNodes(props.piece, SHADOW, false))),
  h('g', { opacity: 0.92 }, toVNodes(svgNodes(props.piece, CUT, true))),
])
Engraving.props = ['piece', 'box', 'class']

// Each corner is its own cut, with its own tremor of the hand.
const CORNER_PIECES = { tl: wrought.corner(11), tr: wrought.corner(23), bl: wrought.corner(37), br: wrought.corner(41) }
const CREST = wrought.crest(19)
// The centrepiece on the top edge: a drake skull, cast and applied.
const SKULL = drakeSkull(5)

// The running border repeats, so it becomes a background image.
const RUN = { w: 320, p: wrought.runner(3) }
function tile(rotate) {
  const inner = `<g transform="translate(0.45 0.65)" opacity="0.85">${toMarkup(svgNodes(RUN.p, SHADOW, false))}</g><g opacity="0.92">${toMarkup(svgNodes(RUN.p, CUT, true))}</g>`
  const svg = rotate
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 ${RUN.w}"><g transform="rotate(90) translate(0 -40)">${inner}</g></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${RUN.w} 40">${inner}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}
const runnerStyle = { '--run-x': tile(false), '--run-y': tile(true), '--run-len': RUN.w / 40 }

const CORNERS = ['tl', 'tr', 'bl', 'br']
const EDGES = ['top-l', 'top-r', 'bottom-l', 'bottom-r', 'left', 'right']
</script>

<template>
  <div ref="wrap" :class="['plaque-wrap', { 'plaque-narrow': narrow }]">
    <div class="plaque-halo" aria-hidden="true" />
    <div class="plaque">
      <div class="plaque-filigree" :style="runnerStyle" aria-hidden="true">
        <span v-for="e in EDGES" :key="e" :class="['run', `run-${e}`]" />
        <Engraving v-for="c in CORNERS" :key="c" :piece="CORNER_PIECES[c]" box="0 0 160 160" :class="`scroll scroll-${c}`" />
        <Engraving :piece="CREST" box="0 0 200 40" class="crest crest-bottom" />
      </div>
      <div class="plaque-inlay"><slot /></div>
      <svg class="skull" viewBox="0 0 200 200" aria-hidden="true">
        <defs>
          <!-- One light for the whole trophy: dark ivory above, soot-stained toward the jaw. -->
          <linearGradient id="skull-bone" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="30" y2="155">
            <stop offset="0" stop-color="#d9cca6" /><stop offset="0.45" stop-color="#b3a17a" /><stop offset="0.8" stop-color="#6e604a" /><stop offset="1" stop-color="#3a3129" />
          </linearGradient>
          <linearGradient id="skull-bronze" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#6e4f14" /><stop offset="0.5" stop-color="#4a340b" /><stop offset="1" stop-color="#231704" />
          </linearGradient>
          <linearGradient id="skull-tooth" gradientUnits="userSpaceOnUse" x1="0" y1="95" x2="0" y2="150"><stop offset="0" stop-color="#efe4c4" /><stop offset="1" stop-color="#b9a47a" /></linearGradient>
          <radialGradient id="skull-glow"><stop offset="0" stop-color="#ffb066" stop-opacity="0.9" /><stop offset="0.45" stop-color="#ff6a2b" stop-opacity="0.45" /><stop offset="1" stop-color="#e0431d" stop-opacity="0" /></radialGradient>
          <radialGradient id="skull-soot"><stop offset="0.35" stop-color="#1a130c" stop-opacity="0.7" /><stop offset="1" stop-color="#1a130c" stop-opacity="0" /></radialGradient>
          <!-- Living bone, not cast metal: fine pitting and a slow mottle over everything painted. -->
          <filter id="skull-tex" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="1.3" numOctaves="2" seed="7" result="fine" />
            <feColorMatrix in="fine" type="matrix" values="0 0 0 0 0.12  0 0 0 0 0.09  0 0 0 0 0.05  1.7 0 0 0 -1.12" result="pits" />
            <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="3" result="slow" />
            <feColorMatrix in="slow" type="matrix" values="0 0 0 0 0.12  0 0 0 0 0.09  0 0 0 0 0.06  0.9 0 0 0 -0.38" result="mottle" />
            <feMerge result="stains"><feMergeNode in="mottle" /><feMergeNode in="pits" /></feMerge>
            <feComposite in="stains" in2="SourceAlpha" operator="in" result="onBone" />
            <feMerge><feMergeNode in="SourceGraphic" /><feMergeNode in="onBone" /></feMerge>
          </filter>
        </defs>
        <g filter="url(#skull-tex)">
          <path v-for="(op, i) in SKULL" :key="i" :d="op.d" :fill="op.fill ?? 'none'" :stroke="op.stroke" :stroke-width="op.sw" :opacity="op.opacity" :class="op.cls" stroke-linejoin="round" stroke-linecap="round" />
        </g>
      </svg>
    </div>
  </div>
</template>

<style scoped>
.plaque-wrap { --heat: 0.8; --rim: clamp(24px, 4.6vw, 56px); position: relative; max-width: 62rem; margin: calc(1.25rem + var(--rim) * 3.3) auto 5rem; padding: 0 1rem; isolation: isolate; }
.plaque-narrow { max-width: 38rem; margin-top: calc(3rem + var(--rim) * 3.3); }

/* Deathfire's light spilling round the plaque, strongest from below where
   the mountain is. Follows the volcano's breathing and eruptions. */
.plaque-halo {
  position: absolute; inset: -1.5rem -0.5rem -3rem; z-index: -1; pointer-events: none; filter: blur(32px);
  opacity: calc(var(--heat) * 0.95);
  transform: scale(calc(0.97 + var(--heat) * 0.04));
  background:
    radial-gradient(75% 45% at 50% 100%, rgba(255, 106, 43, 0.55), transparent 72%),
    radial-gradient(55% 30% at 50% 0%, rgba(253, 184, 37, 0.18), transparent 70%),
    radial-gradient(30% 55% at 0% 60%, rgba(255, 106, 43, 0.22), transparent 70%),
    radial-gradient(30% 55% at 100% 60%, rgba(255, 106, 43, 0.22), transparent 70%);
}

/* ---- darkened brass backing ---- */
.plaque {
  position: relative; border-radius: 6px; padding: var(--rim);
  background:
    /* hammered grain */
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .1 0 0 0 0 .06 0 0 0 0 .01 0 0 0 .45 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"),
    /* temper colours where the heat has hit it again and again: blue, violet, bronze */
    radial-gradient(60% 9% at 50% 100%, rgba(53, 85, 126, 0.5), transparent 80%),
    radial-gradient(75% 14% at 46% 100%, rgba(107, 63, 115, 0.45), transparent 80%),
    radial-gradient(90% 22% at 54% 100%, rgba(140, 70, 30, 0.5), transparent 80%),
    radial-gradient(10% 30% at 0% 85%, rgba(107, 63, 115, 0.3), transparent 80%),
    radial-gradient(10% 30% at 100% 85%, rgba(107, 63, 115, 0.3), transparent 80%),
    /* a soft burnish across the upper face */
    linear-gradient(115deg, transparent 22%, rgba(255, 220, 150, 0.12) 34%, transparent 46%),
    /* the brass: Averland Sunset aged down to a dark patina */
    linear-gradient(180deg,
      color-mix(in srgb, var(--color-averland) 38%, #1c0f04) 0%,
      color-mix(in srgb, var(--color-averland) 28%, #150a03) 30%,
      color-mix(in srgb, var(--color-averland) 21%, #100702) 70%,
      color-mix(in srgb, var(--color-averland) 13%, #0a0401) 100%);
  box-shadow:
    0 0 0 1px #0a0501,
    inset 0 1px 0 rgba(255, 220, 150, 0.35),
    inset 0 -2px 0 rgba(0, 0, 0, 0.55),
    0 30px 60px -22px rgba(0, 0, 0, 0.95),
    0 12px 50px -12px rgba(255, 106, 43, calc(var(--heat) * 0.55));
}

/* ---- engraving ---- */
.plaque-filigree { position: absolute; inset: 0; pointer-events: none; }
/* Framing line cut just inside the outer edge. */
.plaque-filigree::before {
  content: ''; position: absolute; inset: calc(var(--rim) * 0.09); border-radius: 3px;
  border: 1px solid rgba(243, 196, 92, 0.55); box-shadow: 0.5px 0.7px 0 rgba(20, 10, 2, 0.8);
}
.run { position: absolute; background-repeat: repeat-x; background-size: calc(var(--rim) * var(--run-len)) var(--rim); background-image: var(--run-x); }
.run-top-l, .run-top-r, .run-bottom-l, .run-bottom-r { height: var(--rim); }
.run-top-l, .run-bottom-l { left: calc(var(--rim) * 4); }
.run-top-r, .run-bottom-r { right: calc(var(--rim) * 4); transform: scaleX(-1); }
/* Top runs meet the skull's own scrolls; bottom runs meet the flame crest. */
.run-top-l { right: calc(50% + var(--rim) * 1.3); }
.run-top-r { left: calc(50% + var(--rim) * 1.3); }
.run-bottom-l { right: calc(50% + var(--rim) * 2.5); }
.run-bottom-r { left: calc(50% + var(--rim) * 2.5); }
.run-top-l, .run-top-r { top: 0; }
.run-bottom-l, .run-bottom-r { bottom: 0; }
.run-bottom-l { transform: scaleY(-1); }
.run-bottom-r { transform: scale(-1); }
.run-left, .run-right {
  top: calc(var(--rim) * 4); bottom: calc(var(--rim) * 4); width: var(--rim);
  background-repeat: repeat-y; background-size: var(--rim) calc(var(--rim) * var(--run-len)); background-image: var(--run-y);
}
.run-left { left: 0; }
.run-right { right: 0; transform: scaleX(-1); }

.scroll, .crest { position: absolute; overflow: visible; }
.scroll { width: calc(var(--rim) * 4); height: calc(var(--rim) * 4); }
.scroll-tl { top: 0; left: 0; }
.scroll-tr { top: 0; right: 0; transform: scaleX(-1); }
.scroll-bl { bottom: 0; left: 0; transform: scaleY(-1); }
.scroll-br { bottom: 0; right: 0; transform: scale(-1); }
.crest { left: 50%; width: calc(var(--rim) * 5); height: var(--rim); transform: translateX(-50%); }
.crest-bottom { bottom: 0; transform: translateX(-50%) scaleY(-1); }

/* The drake-skull trophy on its bronze mount: the mount sits on the rim, the skull rises above the plaque. */
.skull {
  position: absolute; z-index: 2; left: 50%; top: calc(var(--rim) * -3.3); width: calc(var(--rim) * 4.4); height: calc(var(--rim) * 4.4);
  transform: translateX(-50%); overflow: visible; pointer-events: none;
  filter: drop-shadow(0 4px 5px rgba(0, 0, 0, 0.75)) drop-shadow(0 0 14px rgba(255, 106, 43, calc(var(--heat) * 0.25)));
}
/* Embers deep in the sockets and cracks: very faint, breathing with the volcano. */
.skull .skull-ember { opacity: calc(var(--heat) * 0.4); }

/* ---- the iron inlay ---- */
.plaque-inlay {
  position: relative; border-radius: 3px; padding: clamp(2rem, 5vw, 3.25rem) clamp(1.25rem, 5vw, 3.5rem) clamp(2.25rem, 5vw, 3.5rem);
  background:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .9 0 0 0 0 .88 0 0 0 0 .86 0 0 0 .05 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"),
    radial-gradient(90% 30% at 50% 100%, rgba(255, 106, 43, 0.05), transparent 70%),
    /* Blackened iron: neutral, faintly warm, opaque enough that the green night behind doesn't tint it. */
    linear-gradient(180deg, rgba(24, 23, 22, 0.97), rgba(16, 15, 14, 0.97) 60%, rgba(18, 15, 13, 0.97));
  /* Set down into the brass: a dark seat, a bronze lip, deep inner shadow. */
  box-shadow:
    0 0 0 1px #000,
    0 0 0 3px #5a3a10,
    0 0 0 4px rgba(10, 5, 0, 0.9),
    inset 0 3px 10px rgba(0, 0, 0, 0.85),
    inset 0 -30px 60px -30px rgba(255, 106, 43, calc(var(--heat) * 0.14)),
    inset 0 0 90px rgba(0, 0, 0, 0.5);
}

@media (max-width: 640px) {
  .plaque-wrap { padding: 0 0.5rem; }
}
</style>
