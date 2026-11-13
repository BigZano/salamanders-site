// THROWAWAY MOCK VIEWER. Loads the real page in a same-origin frame and swaps only the volcano canvas for the mock
// drawing, so the nav, the fire title, the buttons and the muster list are all the real ones.
//
// URL switches: ?mode=live|mock  ?comp=a|b  ?pal=molten|doom  ?size=full|1200|768|390  ?moon=0..1  ?freeze=1
//               ?t=seconds  ?bare=1 (no rail)  ?off=plume,ash  ?path=/companies
import { createScene } from './mock.js'

const q = new URLSearchParams(location.search)
const LAYERS = ['sky', 'moon', 'plume', 'ridges', 'relief', 'river', 'lake', 'embers', 'ash']
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
  // the lava's colours: 'molten' is the title's Doom ramp graded toward deep orange; 'doom' is that ramp untouched
  pal: q.get('pal') || 'molten',
}
const COMPS = { a: { faceX: 0.29, flip: false }, b: { faceX: 0.14, flip: true } }
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

const PHONE_H = 844
function sizeFrame() {
  const sw = stage.clientWidth
  const sh = stage.clientHeight
  let w = sw
  let h = sh
  if (state.size !== 'full') {
    w = parseInt(state.size, 10)
    h = w <= 500 ? PHONE_H : w <= 800 ? 1024 : 760
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
  // phones keep one composition for now: the peak a little left of centre
  scene = createScene(w, h, { dpr, layers: state.layers, palette: state.pal, ...(w > 600 ? comp : { flip: comp.flip }) })
  window.__mock = { scene, w, h }
  calmAt = -1
}

function applyMode() {
  if (!host) return
  const mock = state.mode === 'mock'
  for (const el of host.querySelectorAll('.deathfire-canvas, .deathfire-glow')) el.style.visibility = mock ? 'hidden' : ''
  cv.style.display = mock ? '' : 'none'
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
  frame.contentWindow.addEventListener('resize', rebuild)
  rebuild()
  applyMode()
  requestAnimationFrame(tick)
}

function tick(now) {
  requestAnimationFrame(tick)
  if (!scene || state.mode !== 'mock') return
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
  }
  const t0 = performance.now()
  scene.draw(ctx, t, dt, { calm, moonPhase: state.moon })
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
