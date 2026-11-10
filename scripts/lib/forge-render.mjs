/**
 * Pure helpers for scripts/forge-render.mjs, the headless render and smoke harness for the volcano. Nothing here
 * touches Chrome, the network or the disk, so it can be tested without any of them.
 */

import { inflateSync } from 'node:zlib'

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

// Software GL, so a render looks the same on every machine and works with no GPU (CI). --gpu leaves the choice to Chrome.
const SOFTWARE_GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

/**
 * The command line the harness starts Chrome with. One renderer process for every tab (`--renderer-process-limit=1`):
 * the harness renders one entry at a time, and a render must never fan out across the machine's cores.
 */
export function chromeArgs({ profileDir, gpu }) {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    '--disable-gpu-vsync',
    '--renderer-process-limit=1',
    ...(gpu ? [] : SOFTWARE_GL),
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ]
}

/**
 * The command that drops every Chrome process of this run (matched by its profile folder's name) to below-normal
 * priority, so a render never starves the desktop. Windows only (PowerShell); null elsewhere, where the harness lowers
 * the main process alone with os.setPriority.
 */
export function lowerPriorityCommand(profileName, platform) {
  if (platform !== 'win32') return null
  if (!/^[\w.-]+$/.test(profileName)) throw new Error(`profile folder name "${profileName}" is not safe to put in a command`)
  const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '${profileName}' } | ForEach-Object { (Get-Process -Id $_.ProcessId).PriorityClass = 'BelowNormal' }`
  return { cmd: 'powershell', args: ['-NoProfile', '-c', script] }
}

/** Where Chrome is looked for, in order, for the error message when none is found. */
export const chromeCandidates = (env = {}) => (env.CHROME ? [env.CHROME, ...CHROME_PATHS] : CHROME_PATHS)

/**
 * The Chrome to launch: `CHROME` if it names a real file, else the first known install that exists, else null.
 * `exists` is passed in so the lookup is testable without a disk.
 */
export function findChrome(env, exists) {
  return chromeCandidates(env).find((p) => exists(p)) ?? null
}

/**
 * The three viewports the grid renders at. Phone and tablet are mobile with a 2x screen, as a real one would be;
 * desktop is a plain 1x window.
 */
export const SIZES = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
  desktop: { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false },
}

// Every grid page is pictured frozen at the same second (120) with the calm band off and the lava shader forced, so two
// renders differ only in what the grid varies: the moon's phase and the lava preset.
const FROZEN_AT = 120
// The heat sim starts cold on every load and a frozen page draws nothing per frame, so a page opened straight at ?t=120
// would show cold channels. Each entry is opened BURN_CAP / 30 s early instead and stepped that many frozen frames (each
// one 1/30 s of clock and one sim step) to land on its second: min(t * 30, cap) sim steps, as the still frame burns.
// The cap is the volcano's STILL_STEPS (MountDeathfire.vue): change the two together.
export const BURN_CAP = 720
const STEP_HZ = 30
/** Frozen frames an entry pictured at `at` seconds is stepped before its picture: min(at * 30, BURN_CAP). */
export const burnFrames = (at) => Math.min(Math.round(at * STEP_HZ), BURN_CAP)
// The ignition probe's second: two seconds after load the front is part way down the sheet and no arm is lit yet.
export const IGNITE_AT = 2

/** `/` is `home`; any other path is itself with its slashes taken out (`/armoury` is `armoury`). */
const pathName = (path) => path.replace(/\//g, '') || 'home'

/**
 * Every combination of path, size, phase and preset, in that nesting order (the preset varies fastest), each with the
 * file name it renders to and the URL to open (relative to the dev server). A preset is `key=value` query params as
 * the volcano reads them in dev (`crust=0.3`, or `crust=0.3&heat=1.2`), or null for none. Each entry carries `at`, the
 * second it is pictured at, and `burn`, the frozen frames it is stepped to get there from the `t` its URL opens at.
 * With `smoke`, each path and size first gets an ignition entry (`kind: 'ignite'`, pictured at IGNITE_AT from a cold
 * load, the first phase, no preset); the rest are `kind: 'grid'`.
 */
export function plan({ paths, sizes, phases, presets, smoke = false }) {
  const out = []
  const entry = (path, size, phase, preset, at, kind) => {
    const burn = burnFrames(at)
    const open = Math.round((at - burn / STEP_HZ) * 1000) / 1000
    const query = [`moon=${phase}`, `t=${open}`, 'calm=0', 'lava=1']
    if (preset) query.push(preset)
    const label = [pathName(path), size, kind === 'ignite' ? 'ignite' : `p${phase}`]
    if (preset) label.push(preset.replace(/=/g, '').replace(/&/g, '-'))
    return { name: label.join('-'), url: `${path}?${query.join('&')}`, path, at, burn, kind, ...SIZES[size] }
  }
  for (const path of paths) {
    for (const size of sizes) {
      if (!SIZES[size]) throw new Error(`unknown size "${size}" (known: ${Object.keys(SIZES).join(', ')})`)
      if (smoke) out.push(entry(path, size, phases[0], null, IGNITE_AT, 'ignite'))
      for (const phase of phases) {
        for (const preset of presets) out.push(entry(path, size, phase, preset, FROZEN_AT, 'grid'))
      }
    }
  }
  return out
}

/**
 * What an RGBA pixel buffer holds inside a rect (clipped to the buffer): the mean of each of r, g and b, the largest
 * single channel value, and whether any pixel is bright, which is to say hot lava (red above 200).
 */
export function probe(pixels, w, h, rect) {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(w, Math.floor(rect.x + rect.w))
  const y1 = Math.min(h, Math.floor(rect.y + rect.h))
  const sum = [0, 0, 0]
  let max = 0
  let bright = false
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        sum[c] += pixels[i + c]
        if (pixels[i + c] > max) max = pixels[i + c]
      }
      if (pixels[i] > 200) bright = true
      n++
    }
  }
  return { mean: n ? sum.map((s) => s / n) : [0, 0, 0], max, bright }
}

// The probe boxes, in CSS px. The head box sits just under the breach; the toe box is on the trunk 90 percent of the way down
// it (the ignition entry's probe: the front has not reached it two seconds in); the levee box is small enough to fit in the ring beside the
// narrowest sheet (about 6 px of it). The network's probes read three more kinds of box: a channel's end and middle (4 px,
// END_BOX), the six 1 px samples of the junction line, and the pool (POOL_BOX wide, or POOL_STRIP of the page's bottom).
const HEAD_BOX = 24
const TOE_BOX = 24
const LEVEE_BOX = 4
const END_BOX = 4
const JUNCTION_SAMPLES = 6
// How far down the sheet the ignition entry's toe box sits, as a fraction of its points.
const TOE_AT = 0.9
const POOL_BOX = 24
const POOL_STRIP = 24
// How far beside the sheet the levee box sits, in half widths. The ring runs from 1 (the bank) to 1.25 (the strips' LEVEE),
// and the lava pass is clear past 1 + BANK_PX / hw (a pixel, so 1.1 on a 20 px sheet), so a box at 1.1 is in the feather,
// outside the core; at 1.6 (the old ring's middle) it would see bare rock and prove nothing.
const LEVEE_AT = 1.1
// A small probe box whose mean red is under this holds no lava. Real lava reads over 150 there; the one flaky run in 20
// that taught this was an ember over rubble, mean rgb 78,60,45.
export const EMBER_RED = 110
// The grid entry's thresholds (mean red): the line across a join's inner bank, the pool's arc box on a desktop, the bottom
// strip of a phone's page, and the least WCAG contrast of a hero button's text against its face.
export const JUNCTION_RED = EMBER_RED
export const POOL_RED = 150
export const POOL_EDGE_RED = 60
// A channel's last 4 px box that is cooler than its middle is still lit, not bare rock, when its mean red is at least this.
// Bare rock reads 25 to 45 here (the levee box, a cold toe); the dimmest healthy end on a desktop read 102.
export const TOE_RED = 70
export const CTA_CONTRAST = 4.5

// The point of a line nearest `q`: { x, y, d (the distance), tx, ty (the unit direction of that segment) }.
function nearestOnLine(pts, q) {
  let best = { x: pts[0].x, y: pts[0].y, d: Infinity, tx: 0, ty: 1 }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const dx = pts[i].x - a.x
    const dy = pts[i].y - a.y
    const l2 = dx * dx + dy * dy
    const r = l2 ? Math.min(1, Math.max(0, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0
    const x = a.x + dx * r
    const y = a.y + dy * r
    const d = Math.hypot(q.x - x, q.y - y)
    if (d < best.d) {
      const len = Math.sqrt(l2) || 1
      best = { x, y, d, tx: dx / len, ty: dy / len }
    }
  }
  return best
}

// The point `dist` px back from the end of a line, along it (the start of the line if it is shorter than that).
function pointBack(pts, dist) {
  let remaining = dist
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1]
    const b = pts[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len === 0) continue
    if (remaining <= len) return { x: b.x + ((a.x - b.x) * remaining) / len, y: b.y + ((a.y - b.y) * remaining) / len }
    remaining -= len
  }
  return { x: pts[0].x, y: pts[0].y }
}

/**
 * The rects the smoke probes read, in viewport CSS px, worked out from the volcano's `geometry()` and the viewport
 * (`view`: `{ width, height }` in CSS px; without it the page is read as a desktop):
 *   head      a box just below the breach, where the sheet is hottest
 *   toe       a box on the sheet (the trunk) 90 percent of the way down it, or the last point before that which is on the
 *             screen: the ignition entry's probe, a place the front has not reached two seconds after a cold load, and
 *             clear of the pool's own glow, which the canvas fallback lights from the first frame
 *   levee     a small box beside the middle of the sheet, in the levee ring's feather
 *   end<i>    a 4 px box on the last 4 px of every channel i, and mid<i> one on its middle point: the toe probe compares
 *             them. A box wholly off the screen is left out (a phone's trunk can end past its left edge)
 *   junction<k>  six 1 px samples (k 0 to 5) in a line through the first join's inner bank, along the trunk's normal: the
 *             point where the feeder's centreline crosses the trunk's bank above the join (the feeder is as far from the
 *             trunk's centreline there as the trunk's half width), three samples each side of it, the trunk's side first.
 *             None when there is no join to read
 *   pool      on a desktop, a 24 px box hanging from the pool's arc under the trunk (its height if that is less)
 *   poolEdge  on a phone, whose pool sits below the screen's bottom edge, the bottom 24 px of the page under the pool: as
 *             wide as the pool, cut to the screen (the pool can be centred past the screen's edge)
 * Returns null when the volcano has no sheet to probe (a phone with no flows, say).
 */
export function probeRects(geometry, view = {}) {
  const { vent, flows, joins, pool } = geometry ?? {}
  const sheet = flows?.find((f) => f.head)
  if (!vent || !sheet || sheet.pts.length < 3) return null

  const head = { x: vent.x - HEAD_BOX / 2, y: vent.y, w: HEAD_BOX, h: HEAD_BOX }

  // the sheet's point 90 percent of the way down it, or the last one above that whose 24 px box fits on the screen
  const fits = (p) =>
    !(view.width > 0 && view.height > 0) ||
    (p.x >= TOE_BOX / 2 && p.x <= view.width - TOE_BOX / 2 && p.y >= TOE_BOX / 2 && p.y <= view.height - TOE_BOX / 2)
  const cap = Math.floor(TOE_AT * (sheet.pts.length - 1))
  const end = sheet.pts.slice(0, cap + 1).reverse().find(fits) ?? sheet.pts[cap]
  const toe = { x: end.x - TOE_BOX / 2, y: end.y - TOE_BOX / 2, w: TOE_BOX, h: TOE_BOX }

  // beside the sheet's middle point: along the normal to its chord, the same convention the volcano draws with
  const mid = Math.floor((sheet.pts.length - 1) / 2)
  const a = sheet.pts[Math.max(0, mid - 1)]
  const b = sheet.pts[Math.min(sheet.pts.length - 1, mid + 1)]
  const len = Math.hypot(b.y - a.y, b.x - a.x) || 1
  const off = LEVEE_AT * ((sheet.widthMid ?? sheet.widthAt0 ?? 0) / 2)
  const cx = sheet.pts[mid].x - ((b.y - a.y) / len) * off
  const cy = sheet.pts[mid].y + ((b.x - a.x) / len) * off
  const levee = { x: cx - LEVEE_BOX / 2, y: cy - LEVEE_BOX / 2, w: LEVEE_BOX, h: LEVEE_BOX }

  const rects = { head, toe, levee }

  // every channel's last 4 px and its middle, those that are on the screen
  const square = (p) => ({ x: Math.round(p.x - END_BOX / 2), y: Math.round(p.y - END_BOX / 2), w: END_BOX, h: END_BOX })
  const shown = (r) => !(view.width > 0 && view.height > 0) || (r.x + r.w > 0 && r.x < view.width && r.y + r.h > 0 && r.y < view.height)
  flows.forEach((f, i) => {
    if (!f.pts || f.pts.length < 2) return
    const last = square(pointBack(f.pts, END_BOX / 2))
    const middle = square(f.pts[Math.floor((f.pts.length - 1) / 2)])
    if (shown(last)) rects[`end${i}`] = last
    if (shown(middle)) rects[`mid${i}`] = middle
  })

  // A line through the first join's inner bank. Walking back up the feeder from the join, the first point that is as far
  // from the trunk's centreline as the trunk's half width (wt / 2: the trunk keeps wt until one width above the join) is
  // where the feeder's centreline crosses the trunk's bank. The line runs through it along the normal, from the trunk's
  // side to the feeder's, so both ends are lava where the join is lit. (A line at the bank's edge at the join itself reads
  // half lava, half rock, which is no test.) A feeder that never gets that far from the trunk is sampled at two trunk
  // half widths back instead.
  const join = joins?.[0]
  const feeder = join && flows[join.feeder]
  const trunk = join && flows[join.trunk ?? 0]
  if (feeder?.pts?.length >= 2 && trunk?.pts?.length >= 2) {
    const hw = (Number.isFinite(join.wt) && join.wt > 0 ? join.wt : (trunk.widthMid ?? trunk.widthAt0 ?? 2)) / 2
    let cross = null
    for (let i = feeder.pts.length - 1; i > 0 && !cross; i--) {
      const p = feeder.pts[i]
      const o = feeder.pts[i - 1]
      const dp = nearestOnLine(trunk.pts, p).d
      const dq = nearestOnLine(trunk.pts, o).d
      if (dq >= hw && dp < hw) {
        const t = (hw - dp) / (dq - dp)
        cross = { x: p.x + (o.x - p.x) * t, y: p.y + (o.y - p.y) * t }
      }
    }
    cross ??= pointBack(feeder.pts, 2 * hw)
    const near = nearestOnLine(trunk.pts, cross)
    // from the trunk's centreline out to the crossing; along the trunk's normal if they are the same point
    let nx = near.d > 1e-6 ? (cross.x - near.x) / near.d : -near.ty
    let ny = near.d > 1e-6 ? (cross.y - near.y) / near.d : near.tx
    const norm = Math.hypot(nx, ny) || 1
    nx /= norm
    ny /= norm
    for (let k = 0; k < JUNCTION_SAMPLES; k++) {
      const s = k - (JUNCTION_SAMPLES - 1) / 2
      rects[`junction${k}`] = { x: Math.round(cross.x + nx * s - 0.5), y: Math.round(cross.y + ny * s - 0.5), w: 1, h: 1 }
    }
  }

  // the pool: its arc box under the trunk, or, when its centre is below the screen, the page's bottom strip
  if (pool && Number.isFinite(pool.cx) && Number.isFinite(pool.arcTop)) {
    if (Number.isFinite(view.height) && pool.cy >= view.height) {
      const x0 = Math.max(0, pool.cx - pool.rx)
      const x1 = Math.min(view.width ?? Infinity, pool.cx + pool.rx)
      if (x1 > x0) rects.poolEdge = { x: x0, y: view.height - POOL_STRIP, w: x1 - x0, h: POOL_STRIP }
    } else {
      rects.pool = { x: pool.cx - POOL_BOX / 2, y: pool.arcTop, w: POOL_BOX, h: Math.min(POOL_BOX, pool.ry ?? POOL_BOX) }
    }
  }
  return rects
}

const sampled = (probes, prefix) => Object.keys(probes).filter((k) => new RegExp(`^${prefix}\\d+$`).test(k))

// The junction samples, split in two by their index k, not by their place in the list (a sample that was off the canvas is
// left out, and must not move a trunk sample into the feeder's half): k 0 to 2 are the trunk's side, k 3 to 5 the feeder's.
function junctionHalves(probes) {
  const keys = sampled(probes, 'junction')
  const trunk = keys.filter((k) => Number(k.slice(8)) < JUNCTION_SAMPLES / 2)
  return [trunk, keys.filter((k) => !trunk.includes(k))]
}

/**
 * The mean red of each half of the junction line, [trunk's side, feeder's side]; NaN for a half with no samples, and an
 * empty list when there were no samples at all.
 */
export function junctionMeans(probes) {
  const halves = junctionHalves(probes)
  if (halves.every((h) => !h.length)) return []
  return halves.map((h) => (h.length ? h.reduce((sum, k) => sum + probes[k].mean[0], 0) / h.length : NaN))
}

/**
 * The line across a join's inner bank: true when the mean red of EACH half is above JUNCTION_RED, the trunk's side (k 0
 * to 2) and the feeder's (k 3 to 5). So the feeder is lava where it crosses the bank, and a missing or dark feeder (rock
 * on its half) cannot be carried by a hot trunk half the way one pooled mean would carry it (3 hot and 3 rock is 120).
 * Null when there were no samples (no join on the page).
 */
export function judgeJunction(probes) {
  const means = junctionMeans(probes)
  if (!means.length) return null
  return means.filter((m) => !Number.isNaN(m)).every((m) => m > JUNCTION_RED)
}

/**
 * The pool is lit: the arc box's mean red above POOL_RED on a desktop, or the bottom strip's above POOL_EDGE_RED on a
 * phone. Null when neither box was sampled (no pool on the page).
 */
export function judgePool(probes) {
  if (probes.pool) return probes.pool.mean[0] > POOL_RED
  if (probes.poolEdge) return probes.poolEdge.mean[0] > POOL_EDGE_RED
  return null
}

/**
 * Each channel's end box and middle box, in channel order, and whether the end passes: it is no darker (mean red) than the
 * middle, or it is lit all the same (at least TOE_RED), as an end that has cooled from a white-hot middle is.
 */
export function toeRows(probes) {
  return sampled(probes, 'end')
    .map((k) => Number(k.slice(3)))
    .filter((i) => probes[`mid${i}`])
    .sort((x, y) => x - y)
    .map((i) => ({ i, end: probes[`end${i}`].mean[0], mid: probes[`mid${i}`].mean[0], ok: probes[`end${i}`].mean[0] >= Math.min(probes[`mid${i}`].mean[0], TOE_RED) }))
}

/**
 * No channel ends on bare rock: every channel's last 4 px box is at least as red as its middle box, or at least TOE_RED
 * (cooler than the middle is what a channel does toward its toe; dark as rock is what it must not). False when there is
 * nothing to compare.
 */
export function judgeToes(probes) {
  const rows = toeRows(probes)
  return rows.length > 0 && rows.every((r) => r.ok)
}

// ------------------------------------------------------------------------------------------------------------- contrast

const linear = (c) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)

/** The WCAG contrast ratio of two [r, g, b] colours, 1 to 21. */
export function contrastRatio(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * A computed CSS colour as [r, g, b, a], or null if it is not one the page's sRGB colours use: `rgb(26, 13, 6)`,
 * `rgba(89, 214, 108, 0.5)`, `rgb(26 13 6 / 50%)` and `transparent`.
 */
export function parseCssColor(text) {
  if (typeof text !== 'string') return null
  if (text.trim() === 'transparent') return [0, 0, 0, 0]
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(text.trim())
  if (!m) return null
  const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1)
  return [Number(m[1]), Number(m[2]), Number(m[3]), alpha]
}

// The text colour (laid over the face if it has alpha) in ratio to a face colour.
const textOn = (text, face) => {
  const alpha = text[3] ?? 1
  return contrastRatio([0, 1, 2].map((i) => text[i] * alpha + face[i] * (1 - alpha)), face)
}

/**
 * A button's text against the face under it, worst case: the lowest ratio over its `tiles` (the mean colour of each
 * stretch of the content box), or over its mean face `bg` when it has none. A lava stripe behind part of a label must
 * not average away. (Both hero faces are opaque today, so nothing shows through; this guards a face that goes translucent.)
 */
export function ctaRatio({ text, bg, tiles }) {
  return Math.min(...(tiles?.length ? tiles : [bg]).map((face) => textOn(text, face)))
}

/** The same against the mean face of the whole button, for the report. */
export function ctaMeanRatio({ text, bg }) {
  return textOn(text, bg)
}

/** How many tiles a button's content box is cut into across. */
export const CTA_TILES = 6

/**
 * The mean colour of each of `n` equal tiles across a button's content box, left to right, in its picture `img` (from
 * decodePng; a clip of the whole button, `size` = { w, h } in CSS px). `inset` is [top, right, bottom, left]: the border
 * and padding in CSS px, which are left out, so a tile is the label's own band and not the face above and below it. An
 * inset that leaves less than a pixel a tile reads the whole picture.
 */
export function faceTiles(img, size, inset = [0, 0, 0, 0], n = CTA_TILES) {
  const kx = img.width / size.w
  const ky = img.height / size.h
  const [top, right, bottom, left] = inset
  let x0 = left * kx
  let y0 = top * ky
  let w = img.width - (left + right) * kx
  let h = img.height - (top + bottom) * ky
  if (!(w >= n) || !(h >= 1)) {
    x0 = 0
    y0 = 0
    w = img.width
    h = img.height
  }
  return Array.from({ length: n }, (_, i) => probe(img.data, img.width, img.height, { x: x0 + (w * i) / n, y: y0, w: w / n, h }).mean)
}

/** The hero's two buttons read: every button's text is at least CTA_CONTRAST against its worst tile, and there are two. */
export function judgeCta(buttons) {
  return buttons.length >= 2 && buttons.every((b) => ctaRatio(b) >= CTA_CONTRAST)
}

// ---------------------------------------------------------------------------------------------------------------- PNG

/**
 * Reads an 8-bit PNG (RGB or RGBA, not interlaced: what Chrome's screenshots are) into `{ width, height, data }`, data
 * the RGBA bytes row by row. Pure node:zlib; no dependencies. Throws on anything else.
 */
export function decodePng(buf) {
  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
  if (buf.length < 8 || SIGNATURE.some((v, i) => buf[i] !== v)) throw new Error('not a PNG')
  let width = 0
  let height = 0
  let color = 0
  const idat = []
  for (let at = 8; at + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    const data = buf.subarray(at + 8, at + 8 + size)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8) throw new Error(`only 8-bit PNGs are read, this one is ${data[8]}-bit`)
      color = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNGs are not read')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    at += 12 + size
  }
  if (color !== 2 && color !== 6) throw new Error(`only RGB and RGBA PNGs are read, this one is colour type ${color}`)
  const bpp = color === 6 ? 4 : 3
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length < (stride + 1) * height) throw new Error('the PNG has less data than its size says')
  const px = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]
      const a = i >= bpp ? px[y * stride + i - bpp] : 0
      const b = y > 0 ? px[(y - 1) * stride + i] : 0
      const c = i >= bpp && y > 0 ? px[(y - 1) * stride + i - bpp] : 0
      let pred = 0
      if (filter === 1) pred = a
      else if (filter === 2) pred = b
      else if (filter === 3) pred = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`)
      px[y * stride + i] = (x + pred) & 255
    }
  }
  if (color === 6) return { width, height, data: px }
  const data = new Uint8Array(width * height * 4)
  for (let p = 0; p < width * height; p++) data.set([px[p * 3], px[p * 3 + 1], px[p * 3 + 2], 255], p * 4)
  return { width, height, data }
}

// ------------------------------------------------------------------------------------------------------------- judging

/**
 * Whether the probes of a grid entry pass, given the `probe()` result for each rect (`probeRects`'s names) and, for the
 * home page, the hero buttons read (`[{ text: [r, g, b, a], bg: [r, g, b] }]`):
 *   head      something is bright: lava is pouring from the breach
 *   toe       no channel ends on bare rock: every end box is at least as red as its middle box or plainly lit (judgeToes)
 *   levee     roughly grey (red and green within 40 of each other, mean red under EMBER_RED): the bank, not glowing lava.
 *             Judged on the mean, not the brightest pixel: a drifting ember can land in a 4 px box (it did, 1 run in 20)
 *             and one pixel of it proves nothing about the rubble.
 *   junction  the line across the first join's inner bank is lava, no dark run (judgeJunction)
 *   pool      the pool is lit (judgePool)
 *   cta       the hero's buttons read (judgeCta)
 * The last three are in the verdict only when their samples were taken.
 */
export function judge(probes, cta = null) {
  const { head, levee } = probes
  const result = {
    head: head.bright,
    toe: judgeToes(probes),
    levee: Math.abs(levee.mean[0] - levee.mean[1]) < 40 && levee.mean[0] < EMBER_RED,
  }
  const junction = judgeJunction(probes)
  if (junction !== null) result.junction = junction
  const pool = judgePool(probes)
  if (pool !== null) result.pool = pool
  if (cta) result.cta = judgeCta(cta)
  return { ...result, ok: Object.values(result).every(Boolean) }
}

/**
 * Whether the ignition entry passes, two seconds after a cold load:
 *   head     something is bright: the front has left the breach
 *   toe      the trunk's far box (probeRects' `toe`) is cold: mean red under EMBER_RED. Judged on the mean, so a drifting ember (one or
 *            two bright pixels) does not fail it, and lava covering a good part of the box does.
 */
export function judgeIgnition({ head, toe }) {
  const result = { head: head.bright, toe: toe.mean[0] < EMBER_RED }
  return { ...result, ok: result.head && result.toe }
}

/** The lava tuner values a preset may set: the keys the volcano reads from the query in dev (fireTuning.lava). */
export const LAVA_KEYS = ['crust', 'heat', 'viscosity', 'cracks', 'foldScale', 'breakoutRate']

/**
 * Whether a planned URL asks for the lava shader: true for `lava=1`, false for `lava=0`, null when it says nothing
 * (the volcano then decides for itself). The harness checks the page against this.
 */
export function lavaWanted(url) {
  const v = new URL(url, 'http://harness.invalid').searchParams.get('lava')
  return v === '1' ? true : v === '0' ? false : null
}

/**
 * The command line. Flags that take a list (`--paths`, `--sizes`, `--phases`, `--presets`) accept commas, spaces or
 * both (`--paths / /armoury` and `--sizes phone,desktop`); the rest take one value; `--smoke`, `--verbose` and `--gpu` take none.
 */
export function parseArgs(argv) {
  const lists = new Set(['paths', 'sizes', 'phases', 'presets'])
  const values = new Set(['base', 'out', 'throttle', 'chrome'])
  const flags = new Set(['smoke', 'verbose', 'gpu'])
  const raw = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`)
    const key = arg.slice(2)
    if (flags.has(key)) raw[key] = true
    else if (values.has(key)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`--${key} needs a value`)
      raw[key] = argv[++i]
    } else if (lists.has(key)) {
      const items = []
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) items.push(...argv[++i].split(',').filter(Boolean))
      if (!items.length) throw new Error(`--${key} needs a value`)
      raw[key] = items
    } else throw new Error(`unknown flag --${key}`)
  }

  const phases = (raw.phases ?? ['0.42']).map(Number)
  if (phases.some((p) => !Number.isFinite(p))) throw new Error(`--phases must be numbers, got ${raw.phases}`)
  const paths = raw.paths ?? ['/']
  const bad = paths.find((p) => !p.startsWith('/'))
  if (bad) throw new Error(`--paths must start with "/", got "${bad}" (Git Bash rewrites a bare / into a Windows path: run with MSYS_NO_PATHCONV=1)`)
  // a preset the volcano would ignore (a typo in a key, a value that is not a number) must fail here, not render a plain picture
  for (const preset of raw.presets ?? []) {
    for (const pair of preset.split('&')) {
      const [key, value = ''] = pair.split('=')
      if (!LAVA_KEYS.includes(key)) throw new Error(`--presets: unknown lava key "${key}" in "${preset}" (known: ${LAVA_KEYS.join(', ')})`)
      if (value.trim() === '' || !Number.isFinite(Number(value))) throw new Error(`--presets: "${key}" needs a number in "${preset}"`)
    }
  }
  const throttle = raw.throttle === undefined ? null : Number(raw.throttle)
  if (throttle !== null && !(throttle >= 1)) throw new Error(`--throttle must be a number of 1 or more, got "${raw.throttle}"`)

  const base = raw.base ?? 'http://127.0.0.1:5191'
  let baseUrl
  try {
    baseUrl = new URL(base)
  } catch {
    throw new Error(`--base must be a URL like http://127.0.0.1:5191, got "${base}"`)
  }
  if (!/^https?:$/.test(baseUrl.protocol)) throw new Error(`--base must be an http or https URL, got "${base}"`)

  return {
    base: base.replace(/\/+$/, ''),
    out: raw.out ?? '.forge/grid',
    paths,
    sizes: raw.sizes ?? ['phone', 'desktop'],
    phases,
    presets: raw.presets ?? [null],
    throttle,
    smoke: Boolean(raw.smoke),
    verbose: Boolean(raw.verbose),
    gpu: Boolean(raw.gpu),
    chrome: raw.chrome ?? null,
  }
}
