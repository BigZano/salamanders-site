// THROWAWAY MOCK VIEWER. Loads the real page in a same-origin frame and swaps only the volcano canvas for the mock
// drawing, so the nav, the fire title, the buttons and the muster list are all the real ones.
//
// URL switches: ?mode=live|mock  ?comp=a|b  ?pal=forge|molten|doom  ?size=full|1200|768|390|WxH (360x740)  ?moon=0..1  ?freeze=1
//               ?t=seconds  ?bare=1 (no rail)  ?off=plume,ash  ?path=/companies
//               ?phone=roof|stack (default stack; only acts when the frame is at or under the cut-off)
//               ?cut=px (the phone and tablet cut-off, default 768; 600 was the first guess)
//               ?gap=px (stack: how far the spire tip stands under the lowest button, default 14)  ?debug=1 (numbers)
//               ?px=0..1 (peak position across the screen, phones only)
//               ?inner=left|right (where the mountain stands on pages other than home, desktop only; default right)
//               ?tn=key:value,key:value (tuner values that differ from their defaults; the rail writes this for you)
//               ?dw=1 (draw the mountain on Deathwatch pages too; without it they show no mountain: Deathwatch is off planet)
import { createScene } from './mock.js'

const q = new URLSearchParams(location.search)
const LAYERS = ['sky', 'moon', 'plume', 'ridges', 'relief', 'river', 'lake', 'monolith', 'embers', 'ash']
const off = new Set((q.get('off') || '').split(',').filter(Boolean))
const state = {
  mode: q.get('mode') || 'mock',
  size: q.get('size') || 'full',
  moon: q.has('moon') ? parseFloat(q.get('moon')) : 0.42,
  frozen: q.get('freeze') === '1',
  layers: Object.fromEntries(LAYERS.map((l) => [l, !off.has(l)])),
  // where the peak stands: 'a' is where the live hero has it; 'b' moves it left and turns the breach to face right,
  // so the spire and the river both stand clear of the title
  comp: q.get('comp') || 'b',
  // the lava's colours: 'molten' is the title's Doom ramp graded toward deep orange; 'doom' is that ramp untouched;
  // 'forge' blends the two (tuner: Doom tint, Red depth)
  pal: q.get('pal') || 'forge',
  // phone layouts: 'roof' keeps the hero text mid-screen and roofs the river over wherever text sits on it; 'stack'
  // lifts the hero text to the top of the screen and stands the whole mountain below it
  phone: q.get('phone') === 'roof' ? 'roof' : 'stack',
  // pages other than home: 'left' keeps the home composition, 'right' mirrors the mountain to the right edge, clear of
  // the page header
  inner: q.get('inner') === 'left' ? 'left' : 'right',
}
const COMPS = { a: { faceX: 0.29, flip: false }, b: { faceX: 0.14, flip: true } }
const INNER_RIGHT = { faceX: 0.86, flip: false }
// At or under this width the page gets the phone drawing and the stack layout. 768 is the live site's own breakpoint.
const CUT = parseInt(q.get('cut'), 10) || 768
// The tuner: named numbers handed to the scene as `tune`. To add a knob: add a row here, read `o.tune.<key>` in mock.js.
const TUNE = [
  { key: 'peakH', label: 'Peak height', min: 0.5, max: 1.05, step: 0.01, def: 0.72 },
  { key: 'baseW', label: 'Base width', min: 0.4, max: 1.6, step: 0.01, def: 1.35 },
  { key: 'crown', label: 'Crown size', min: 0.6, max: 1.8, step: 0.02, def: 1.25 },
  { key: 'ranges', label: 'Far peaks', min: 0, max: 3, step: 0.05, def: 1 },
  { key: 'rangeH', label: 'Far peak height', min: 0.4, max: 2, step: 0.02, def: 1 },
  { key: 'haze', label: 'Haze', min: 0, max: 1, step: 0.02, def: 0.5 },
  { key: 'lavaTint', label: 'Doom tint', min: 0, max: 1, step: 0.02, def: 0.5 },
  { key: 'lavaRed', label: 'Red depth', min: 0, max: 1, step: 0.02, def: 0.5 },
  { key: 'lavaHeat', label: 'Lava heat', min: 0.5, max: 1.5, step: 0.02, def: 1.12 },
  { key: 'plume', label: 'Plume', min: 0, max: 2, step: 0.05, def: 1.3 },
  { key: 'embers', label: 'Embers', min: 0, max: 3, step: 0.05, def: 2.3 },
  { key: 'lake', label: 'Lake size', min: 0.6, max: 1.8, step: 0.02, def: 1 },
]
const tuneState = Object.fromEntries(TUNE.map((d) => [d.key, d.def]))
for (const pair of (q.get('tn') || '').split(',')) {
  const [k, v] = pair.split(':')
  if (k in tuneState && Number.isFinite(parseFloat(v))) tuneState[k] = parseFloat(v)
}
let tuneTimer = 0
// What the stack layout asks of the real page: the hero starts under the nav instead of centring in the screen.
// .landing > section.hero is (0,2,1) against the scoped .hero[data-v] (0,2,0), so it wins whatever the style order.
// Stack layout: the text block starts under the nav and closes up a little, so the mountain keeps its height.
const STACK_CSS = [
  '.landing > section.hero { align-items: flex-start; padding-top: 1.5rem; }',
  '.landing > section.hero .hero-mark { margin-top: 0.9rem; }',
  '.landing > section.hero .tagline { margin-top: 0.6rem; }',
  '.landing > section.hero .cta-row { margin-top: 1.4rem; gap: 0.6rem; }',
].join('\n')
if (q.get('bare') === '1') document.body.classList.add('bare')

const frame = document.getElementById('frame')
const stage = document.getElementById('stage')
const note = document.getElementById('note')
let cv = null
let ctx = null
let scene = null
let host = null
let t = q.has('t') ? parseFloat(q.get('t')) : 0
let last = 0
let nextPulse = 3
let calmRects = []
let calmAt = -1
let costAvg = 0
let stacked = false // the stack layout is on in the frame right now
let built = null // the hero measurement the scene was built from (stack only)
let relayouts = 0
let debugLines = null

const PHONE_H = 844
function sizeFrame() {
  const sw = stage.clientWidth
  const sh = stage.clientHeight
  let w = sw
  let h = sh
  if (state.size !== 'full') {
    const [ws, hs] = state.size.split('x')
    w = parseInt(ws, 10)
    h = parseInt(hs, 10) || (w <= 500 ? PHONE_H : w <= 800 ? 1024 : 760)
  }
  const k = Math.min(1, sw / w, sh / h)
  frame.style.width = `${w}px`
  frame.style.height = `${h}px`
  frame.style.transform = k < 1 ? `scale(${k})` : ''
}

function measureCalm() {
  const win = frame.contentWindow
  const doc = frame.contentDocument
  const w = win.innerWidth
  const h = win.innerHeight
  const out = []
  const range = doc.createRange()
  for (const el of doc.querySelectorAll('h1, h2, h3, p, li, label, button, a, dt, dd, input, textarea, select, td')) {
    if (el.closest('.deathfire')) continue
    // stacked, the hero text is wholly above the river, so it casts no roof (its 48 px margin would otherwise
    // reach the first stretch of the river, which stands 18 px clear of it)
    if (stacked && el.closest('.hero')) continue
    let boxes
    if (/^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) boxes = [el.getBoundingClientRect()]
    else {
      range.selectNodeContents(el)
      boxes = range.getClientRects()
    }
    for (const r of boxes) {
      if (out.length >= 80) break
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > h || r.right < 0 || r.left > w) continue
      if (r.width * r.height > w * h * 0.2) continue
      out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom })
    }
  }
  calmRects = out
}
const sstep = (x) => {
  const c = x < 0 ? 0 : x > 1 ? 1 : x
  return c * c * (3 - 2 * c)
}
function calm(x, y) {
  let k = 1
  for (const r of calmRects) {
    const d = Math.hypot(Math.max(r.l - x, 0, x - r.r), Math.max(r.t - y, 0, y - r.b))
    if (d < 48) k = Math.min(k, 0.1 + 0.9 * sstep(d / 48))
  }
  return k
}

/** Is the stack layout wanted in the frame as it is now? Only on a phone width, and only when picked. */
function wantStack() {
  return state.phone === 'stack' && frame.contentWindow.innerWidth <= CUT
}
/** Put the stack layout's one style element into the frame, or take it out. */
function syncStackStyle(on) {
  const doc = frame.contentDocument
  const have = doc.getElementById('mock-phone-stack')
  if (on && !have) {
    const el = doc.createElement('style')
    el.id = 'mock-phone-stack'
    el.textContent = STACK_CSS
    doc.head.appendChild(el)
  } else if (!on && have) have.remove()
}
/** Where the hero text ends, in page px (the same as viewport px at scroll 0): the lowest button, and the big title. */
function measureHero() {
  const doc = frame.contentDocument
  const sy = frame.contentWindow.scrollY
  let text = 0
  for (const el of doc.querySelectorAll('.hero .cta-row > *')) text = Math.max(text, el.getBoundingClientRect().bottom)
  if (!text) return null
  const title = doc.querySelector('.hero .wordmark')
  return { text: text + sy, title: title ? title.getBoundingClientRect().bottom + sy : 0 }
}
/** The numbers ?debug=1 prints on the canvas, taken once per rebuild. */
function debugFor(w, h) {
  const doc = frame.contentDocument
  const info = scene.info
  const nav = doc.querySelector('header.nav')
  const eyebrow = doc.querySelector('.hero .eyebrow')
  const sy = frame.contentWindow.scrollY
  const f = (n) => (Number.isFinite(n) ? n.toFixed(1) : '-')
  return [
    `${w}x${h} ${info.stack ? 'stack' : state.phone === 'roof' && w <= CUT ? 'roof' : 'plain'}`,
    `nav bottom ${f(nav && nav.getBoundingClientRect().bottom + sy)}  eyebrow top ${f(eyebrow && eyebrow.getBoundingClientRect().top + sy)}`,
    `title bottom ${f(built?.title)}  text bottom ${f(built?.text)}`,
    `breach y ${f(info.breach.y)}  tip y ${f(info.tipY)}  rim y ${f(info.rimY)}`,
    `H ${f(info.H)}  ch ${f(info.ch)}  peak x ${f(info.peakX)}  shore y ${f(info.shoreY)}`,
  ]
}

function rebuild() {
  if (!cv) return
  const win = frame.contentWindow
  const w = win.innerWidth
  const h = win.innerHeight
  if (w < 2 || h < 2) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  cv.width = Math.ceil(w * dpr)
  cv.height = Math.ceil(h * dpr)
  ctx = cv.getContext('2d')
  const comp = COMPS[state.comp] || COMPS.a
  // the stack layout is a style in the page: set it first, then measure, then the calm rects (the text has moved)
  stacked = wantStack()
  syncStackStyle(stacked)
  built = stacked ? measureHero() : null
  measureCalm()
  // phones keep one composition for now: the peak a little left of centre
  scene = createScene(w, h, {
    dpr,
    layers: state.layers,
    palette: state.pal,
    phoneMax: CUT,
    quiet: framePath() !== '/', // no live far volcanoes behind the small text of the other pages
    tune: { ...tuneState },
    ...(w > CUT ? (framePath() === '/' || state.inner === 'left' ? comp : INNER_RIGHT) : { flip: comp.flip, ...(q.has('px') ? { faceX: Math.min(0.9, Math.max(0.1, parseFloat(q.get('px')) || 0.36)) } : {}) }),
    ...(built ? { textBottom: built.text, titleBottom: built.title, textGap: q.has('gap') ? parseFloat(q.get('gap')) : undefined } : {}),
  })
  window.__mock = { scene, w, h }
  if (q.get('debug') === '1') debugLines = debugFor(w, h)
  calmAt = -1
}

// Deathwatch is off planet: nothing is drawn there unless its keeper switches the mountain on (?dw=1 stands in for
// that switch). In the mock that means no canvas at all and no ash veil over the page.
let lastPath = ''
const framePath = () => {
  try {
    return frame.contentWindow.location.pathname
  } catch {
    return ''
  }
}
const offPlanet = () => /^\/deathwatch(\/|$)/.test(framePath()) && q.get('dw') !== '1'
function applyMode() {
  if (!host) return
  const mock = state.mode === 'mock'
  const dark = mock && offPlanet()
  for (const el of host.querySelectorAll('.deathfire-canvas, .deathfire-glow')) el.style.visibility = mock ? 'hidden' : ''
  cv.style.display = mock && !dark ? '' : 'none'
  const veil = frame.contentDocument?.querySelector('.deathfire-veil')
  if (veil) veil.style.visibility = dark ? 'hidden' : ''
  lastPath = framePath()
  for (const b of document.querySelectorAll('#modes button')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode))
}

function attach() {
  const doc = frame.contentDocument
  host = doc?.querySelector('.deathfire')
  if (!host) return setTimeout(attach, 150)
  cv = doc.createElement('canvas')
  cv.className = 'mock-canvas'
  cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'
  host.appendChild(cv)
  frame.contentWindow.addEventListener('resize', () => {
    relayouts = 0 // a new size starts a new allowance for the layout to settle
    rebuild()
  })
  rebuild()
  applyMode()
  requestAnimationFrame(tick)
}

function tick(now) {
  requestAnimationFrame(tick)
  // the page inside the frame can change route by itself (a nav click): the Deathwatch rule follows it
  if (host && framePath() !== lastPath) {
    applyMode()
    rebuild() // home and the other pages can stand the mountain in different places
  }
  if (!scene || state.mode !== 'mock') return
  if (offPlanet()) return
  const elapsed = now - last
  if (elapsed < 1000 / 30) return
  last = now
  const dt = state.frozen ? 0 : Math.min(elapsed / 16.7, 3)
  if (!state.frozen) t += Math.min(elapsed, 100) / 1000
  if (!state.frozen && t >= nextPulse) {
    scene.erupt()
    nextPulse = t + 2.5 + Math.random() * 6.5
  }
  if (calmAt < 0 || t - calmAt > 0.4 || state.frozen) {
    measureCalm()
    calmAt = t
    // The stack layout hangs on where the hero text ends. It can move after the scene is built (a webfont, the route
    // arriving late), and then the mountain moves with it. The cap stops a layout that never settles from looping.
    if (stacked && relayouts < 12) {
      const now = measureHero()
      if (Math.abs((now?.text ?? 0) - (built?.text ?? 0)) > 2) {
        relayouts++
        rebuild()
        return
      }
    }
  }
  const t0 = performance.now()
  scene.draw(ctx, t, dt, { calm, moonPhase: state.moon })
  if (debugLines) {
    const info = scene.info
    ctx.save()
    ctx.globalAlpha = 1
    ctx.lineWidth = 1
    // ticks on the left edge: cyan the lowest button's bottom, yellow the breach, magenta the spire tip
    for (const [y, c] of [[built ? built.text : -9, '#18e0ff'], [info.breach.y, '#ffe040'], [info.tipY, '#ff40d0']]) {
      ctx.strokeStyle = c
      ctx.beginPath()
      ctx.moveTo(0, y + 0.5)
      ctx.lineTo(36, y + 0.5)
      ctx.stroke()
    }
    ctx.font = 'bold 11px ui-monospace, Consolas, monospace'
    ctx.fillStyle = '#ffffff'
    ctx.shadowColor = '#000'
    ctx.shadowBlur = 3
    debugLines.forEach((s, i) => ctx.fillText(s, 6, scene.info.shoreY + 16 + i * 13))
    ctx.restore()
  }
  costAvg = costAvg * 0.95 + (performance.now() - t0) * 0.05
  note.textContent = `draw ${costAvg.toFixed(2)} ms · t ${t.toFixed(1)} s`
}

// ---- rail
const layersEl = document.getElementById('layers')
for (const l of LAYERS) {
  const label = document.createElement('label')
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = state.layers[l]
  box.addEventListener('change', () => {
    state.layers[l] = box.checked
    rebuild()
  })
  label.append(box, l)
  layersEl.append(label)
}
for (const b of document.querySelectorAll('#modes button')) {
  b.addEventListener('click', () => {
    state.mode = b.dataset.mode
    applyMode()
  })
}
const markSize = () => {
  for (const b of document.querySelectorAll('#sizes button')) b.setAttribute('aria-pressed', String(b.dataset.size === state.size))
}
for (const b of document.querySelectorAll('#sizes button')) {
  b.addEventListener('click', () => {
    state.size = b.dataset.size
    markSize()
    sizeFrame()
  })
}
const markComp = () => {
  for (const b of document.querySelectorAll('#comps button')) b.setAttribute('aria-pressed', String(b.dataset.comp === state.comp))
}
for (const b of document.querySelectorAll('#comps button')) {
  b.addEventListener('click', () => {
    state.comp = b.dataset.comp
    markComp()
    rebuild()
  })
}
markComp()
const markPal = () => {
  for (const b of document.querySelectorAll('#pals button')) b.setAttribute('aria-pressed', String(b.dataset.pal === state.pal))
}
for (const b of document.querySelectorAll('#pals button')) {
  b.addEventListener('click', () => {
    state.pal = b.dataset.pal
    markPal()
    rebuild()
  })
}
markPal()
const markPhone = () => {
  for (const b of document.querySelectorAll('#phones button')) b.setAttribute('aria-pressed', String(b.dataset.phone === state.phone))
}
for (const b of document.querySelectorAll('#phones button')) {
  b.addEventListener('click', () => {
    state.phone = b.dataset.phone
    markPhone()
    relayouts = 0
    rebuild()
  })
}
markPhone()
const markInner = () => {
  for (const b of document.querySelectorAll('#inners button')) b.setAttribute('aria-pressed', String(b.dataset.inner === state.inner))
}
for (const b of document.querySelectorAll('#inners button')) {
  b.addEventListener('click', () => {
    state.inner = b.dataset.inner
    markInner()
    relayouts = 0
    rebuild()
  })
}
markInner()
const moonEl = document.getElementById('moon')
moonEl.value = state.moon
moonEl.addEventListener('input', () => (state.moon = parseFloat(moonEl.value)))
const freezeEl = document.getElementById('freeze')
freezeEl.setAttribute('aria-pressed', String(state.frozen))
freezeEl.addEventListener('click', () => {
  state.frozen = !state.frozen
  freezeEl.setAttribute('aria-pressed', String(state.frozen))
})
document.getElementById('erupt').addEventListener('click', () => scene?.erupt())
window.addEventListener('resize', sizeFrame)

markSize()
sizeFrame()
frame.addEventListener('load', attach, { once: true })
frame.src = q.get('path') || '/'

// ---- tuner
function tuneChanged() {
  const diff = TUNE.filter((d) => tuneState[d.key] !== d.def).map((d) => `${d.key}:${tuneState[d.key]}`)
  const u = new URL(location.href)
  if (diff.length) u.searchParams.set('tn', diff.join(','))
  else u.searchParams.delete('tn')
  history.replaceState(null, '', u)
  document.getElementById('tune-out').textContent = diff.join('\n') || 'all defaults'
  clearTimeout(tuneTimer)
  tuneTimer = setTimeout(rebuild, 120)
}
for (const d of TUNE) {
  const row = document.createElement('label')
  row.className = 'tune'
  const name = document.createElement('span')
  name.textContent = d.label
  d.val = document.createElement('output')
  d.val.textContent = String(tuneState[d.key])
  d.input = document.createElement('input')
  d.input.type = 'range'
  d.input.min = d.min
  d.input.max = d.max
  d.input.step = d.step
  d.input.value = tuneState[d.key]
  d.input.addEventListener('input', () => {
    tuneState[d.key] = parseFloat(d.input.value)
    d.val.textContent = d.input.value
    tuneChanged()
  })
  row.append(name, d.val, d.input)
  document.getElementById('tuner').append(row)
}
document.getElementById('tune-reset').addEventListener('click', () => {
  for (const d of TUNE) {
    tuneState[d.key] = d.def
    d.input.value = d.def
    d.val.textContent = String(d.def)
  }
  tuneChanged()
})
document.getElementById('tune-out').textContent =
  TUNE.filter((d) => tuneState[d.key] !== d.def).map((d) => `${d.key}:${tuneState[d.key]}`).join('\n') || 'all defaults'
