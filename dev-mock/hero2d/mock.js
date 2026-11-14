// THROWAWAY MOCK. A 2D canvas repaint of the hero drawing, shown over the real page by viewer.js.
// Nothing here ships: it exists so the look can be judged in Chrome before any product code changes.
//
// References looked at before drawing (docs/design/refs):
//   usgs-mauna-loa-2022-12-08-fissure-3-channel.png  : one wide river, bright margins, crust plates mid-stream, dark levees
//   usgs-halemaumau-2021-01-19-lake-channel-evening.jpg : a lake of dark crust plates netted with thin orange seams, hot only at the inlet
//   zzArchive/dev-mock-lava3d/shots/desktop-r3-4.png   : the round-3 3D mock, the one that felt alive (one river, lit relief, jagged crown, sphere moon)

import { DoomFire, DOOM_PALETTE } from '../../src/lib/doomfire.js'

const TAU = Math.PI * 2
// The title's fire palette, flat, so the lava and the title burn in the same colours.
const TOP = DOOM_PALETTE.length - 1
const DOOM = new Float32Array(DOOM_PALETTE.length * 3)
DOOM_PALETTE.forEach((c, i) => DOOM.set(c, i * 3))
// The same 37 steps graded for rock that glows rather than gas that burns. The Doom ramp's upper middle is a mustard
// yellow (183,183,47): right for flame on black, sulphurous for lava. Here red is pushed up and green pulled down, so
// the middle of the ramp is a deep orange, and the top four steps run warm white instead of pure white.
const MOLTEN = new Float32Array(DOOM_PALETTE.length * 3)
DOOM_PALETTE.forEach(([r, g, b], i) => MOLTEN.set([Math.min(255, r * 1.18 + (i ? 12 : 0)), g * 0.84, b * 0.8], i * 3))
;[[255, 222, 128], [255, 234, 166], [255, 243, 202], [255, 251, 232]].forEach((c, k) => MOLTEN.set(c, (TOP - 3 + k) * 3))
let PAL = MOLTEN
// "Forge": the two ramps blended. Doom's own orange and gold tint the hot middle of the molten ramp (`tint`, 0..1),
// and the cool end runs a deeper red (`red`, 0..1). The top steps stay the molten warm white.
function forgePalette(tint, red) {
  const out = new Float32Array(MOLTEN.length)
  const s3 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
  for (let i = 0; i <= TOP; i++) {
    const s = i / TOP
    const a = i * 3
    // Doom comes in across the middle and fades out again under the white-hot top
    const wt = tint * s3((s - 0.18) / 0.3) * (1 - s3((s - 0.84) / 0.12))
    let r = MOLTEN[a] + (DOOM[a] - MOLTEN[a]) * wt
    let g = MOLTEN[a + 1] + (DOOM[a + 1] - MOLTEN[a + 1]) * wt
    let b = MOLTEN[a + 2] + (DOOM[a + 2] - MOLTEN[a + 2]) * wt
    // the cool end: less green and blue, a touch more red, so cooling lava reads blood red and not brown
    const cool = red * (1 - s3(s / 0.5))
    r = Math.min(255, r * (1 + 0.14 * cool))
    g *= 1 - 0.42 * cool
    b *= 1 - 0.5 * cool
    out[a] = r
    out[a + 1] = g
    out[a + 2] = b
  }
  return out
}
/** The palette colour at a fractional heat, written into out[o..o+2]. */
function heatColour(hv, out, o) {
  const v = hv < 0 ? 0 : hv > TOP ? TOP : hv
  const i0 = v | 0
  const f = v - i0
  const a = i0 * 3
  const b = (i0 < TOP ? i0 + 1 : i0) * 3
  out[o] = PAL[a] + (PAL[b] - PAL[a]) * f
  out[o + 1] = PAL[a + 1] + (PAL[b + 1] - PAL[a + 1]) * f
  out[o + 2] = PAL[a + 2] + (PAL[b + 2] - PAL[a + 2]) * f
}

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}
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
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const sm = (x) => {
  const c = clamp01(x)
  return c * c * (3 - 2 * c)
}
const lerp = (a, b, t) => a + (b - a) * t
const css = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a.toFixed(3)})`
/** Linear lookup in a ramp of [position, [r, g, b]] stops. */
function ramp(stops, s) {
  let k = 1
  while (k < stops.length - 1 && stops[k][0] < s) k++
  const a = stops[k - 1]
  const b = stops[k]
  const u = clamp01((s - a[0]) / (b[0] - a[0] || 1))
  return [lerp(a[1][0], b[1][0], u), lerp(a[1][1], b[1][1], u), lerp(a[1][2], b[1][2], u)]
}
/** Catmull-Rom through `pts`, resampled to n + 1 points evenly spaced by arc length. */
function smoothPath(pts, n) {
  const dense = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    for (let k = 0; k < 8; k++) {
      const t = k / 8
      const t2 = t * t
      const t3 = t2 * t
      dense.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      })
    }
  }
  dense.push(pts[pts.length - 1])
  const len = [0]
  for (let i = 1; i < dense.length; i++) len.push(len[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y))
  const total = len[len.length - 1]
  const out = []
  let j = 0
  for (let i = 0; i <= n; i++) {
    const want = (i / n) * total
    while (j < len.length - 2 && len[j + 1] < want) j++
    const u = (want - len[j]) / (len[j + 1] - len[j] || 1)
    out.push({ x: lerp(dense[j].x, dense[j + 1].x, u), y: lerp(dense[j].y, dense[j + 1].y, u) })
  }
  return { pts: out, length: total }
}
function makeCanvas(w, h, dpr = 1) {
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.ceil(w * dpr))
  cv.height = Math.max(1, Math.ceil(h * dpr))
  const g = cv.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { cv, g }
}
function makeGlow() {
  const s = 64
  const { cv, g } = makeCanvas(s, s)
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grd.addColorStop(0, 'rgba(255,238,190,1)')
  grd.addColorStop(0.18, 'rgba(255,190,110,0.9)')
  grd.addColorStop(0.45, 'rgba(255,106,43,0.42)')
  grd.addColorStop(0.75, 'rgba(224,67,29,0.12)')
  grd.addColorStop(1, 'rgba(180,40,18,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, s, s)
  return cv
}

const WARM = [
  [0, [0, 0, 0]],
  [0.25, [30, 9, 5]],
  [0.5, [82, 26, 11]],
  [0.75, [146, 54, 19]],
  [1, [210, 98, 36]],
]

export function createScene(w, h, o = {}) {
  const seed = o.seed ?? 0x5a1a
  const R = mulberry32(seed)
  const rr = (a, b) => a + R() * (b - a)
  const rand = (a, b) => a + Math.random() * (b - a)
  // one cut-off for phones and tablets held upright: at 768 the desktop composition puts the river under the title
  const phone = w <= (o.phoneMax ?? 768)
  // Stack layout (phones only): the page sets the hero text at the top of the screen and tells us where its lowest
  // button ends, so the whole mountain stands below it and nothing of the river lies under reading text.
  const stack = phone && Number.isFinite(o.textBottom)
  const dpr = o.dpr ?? 1
  const L = { sky: true, moon: true, plume: true, ridges: true, relief: true, river: true, lake: true, monolith: true, embers: true, ash: true, ...(o.layers || {}) }
  // the tuner's numbers (viewer.js TUNE): read as tn.<key> ?? default
  const tn = o.tune || {}
  // `quiet`: the far ranges stand without their live volcanoes (no pin of light, no wisp, no halo), for pages where small
  // text stands over them. The ranges keep their shape: the notches are still cut and the seeded streams run as before.
  const quietFar = !!o.quiet
  PAL =o.palette === 'doom' ? DOOM : o.palette === 'molten' ? MOLTEN : forgePalette(tn.lavaTint ?? 0.5, tn.lavaRed ?? 0.5)

  // ---------------------------------------------------------------- the mountain's frame (same numbers as the live hero)
  // The tuner's three numbers for the mountain: peakH (the rim's height as a fraction of the screen), baseW (the half-base
  // as a multiple of that height) and crown (the crown's size). A massif and not a needle: broad, and tall enough that
  // the tip of the spire stands in the nav bar.
  const peakFrac = Math.max(0.3, Math.min(1.2, tn.peakH ?? 0.72))
  const crown = Math.max(0.4, Math.min(2.4, tn.crown ?? 1.25))
  const baseW = Math.max(0.2, Math.min(2, tn.baseW ?? 1.35))
  const groundH = Math.round(Math.max(56, h * 0.125))
  // on a phone the page text sets the height (the stack block below), so peakH does not act there
  let H = stack ? Math.max(40, Math.min(690 * (h / 1000), h * 0.7)) : Math.max(40, h * peakFrac)
  const peakX = w * (o.faceX ?? (phone ? 0.36 : 0.29))
  const chOf = (hh) => Math.max(18, Math.min(hh * 0.13, w * 0.11))
  let chb = chOf(H) // the crater before the crown multiplier: the river keeps its width whatever the crown does
  let ch = chb * crown
  if (stack) {
    // Lower the rim until the tall spire tip (2.3 ch above it, jitter included) stands `gap` px under the lowest button
    // (14 unless asked), so the whole crown shows and no button sits on the mountain's head. The crown size follows the
    // height, so settle it in a few passes. The floor only keeps the shape sane on a very short screen; if it ever
    // wins, the crown rises behind the buttons.
    const roofH = H
    const gap = o.textGap ?? 14
    const floorH = Math.max(groundH * 2.5, h * 0.3)
    for (let i = 0; i < 4; i++) {
      const rim = o.textBottom + gap + 2.3 * ch
      H = Math.max(floorH, Math.min(roofH, h - rim))
      chb = chOf(H)
      ch = chb * crown
    }
  }
  const rimY = h - H
  // The half-base: baseW heights. A phone is only as wide as it is, so there it takes a little over half of that.
  const halfBase = Math.max(w * 0.22, H * baseW * (phone ? 0.62 : 1))
  // The rim is as wide as the crown's tower is thick: the crown is a touch broader than it is tall, so it carries weight
  const rw = ch * 1.2
  const shoreY = h - groundH
  const ROWS = 48

  const flip = !!o.flip // mirror the crown and the river, so the breach faces right
  const mx = flip ? -1 : 1
  // How far across the half-base a flank has come at depth f (0 rim, 1 foot). Sheer under the rim, then it fills out
  // fast: the old curve was f^2.4, a hollow flank under a needle. This one is f^2.5 at the top and f^1.5 below the
  // upper third, so the middle of the cone is nearly twice as wide.
  const fill = (f) => lerp(Math.pow(f, 2.5), Math.pow(f, 1.5), sm((f - 0.15) / 0.6))
  // Each flank falls in cliffs and benches. A bench pushes the rock outward over a few rows, at a slant, so the outline
  // breaks like fractured rock and never like stair treads. A spine of rock stands on one of them.
  const flank = (dir) => {
    const spread = dir < 0 ? 0.92 : 1.14
    // benches at uneven heights, a few of them deep; one spine per flank, on a bench in the upper half
    const ledges = []
    for (let k = 8 + Math.floor(R() * 4); k < ROWS - 8 && ledges.length < 4; k += 6 + Math.floor(R() * 10)) {
      ledges.push({ k, out: (R() < 0.35 ? 0.03 + R() * 0.025 : 0.008 + R() * 0.014) * halfBase * spread, tooth: 0 })
    }
    // (the one spine this flank used to carry is gone: the left shoulder peak stands where it was)
    const pts = []
    const outline = []
    for (let i = 0; i <= ROWS; i++) {
      const f = i / ROWS
      let x = rw + fill(f) * (halfBase * spread - rw) + (vnoise(f * 7 + dir * 3.7, 1.9) - 0.5) * 0.05 * H * Math.min(1, f * 3)
      let tooth = 0
      for (const l of ledges) {
        x += l.out * sm((i - l.k + 1) / 4)
        if (i === l.k) tooth = l.tooth
      }
      const p = { x: peakX + dir * x, y: rimY + f * H + (R() - 0.5) * 2 * H * 0.012 * f }
      pts.push(p)
      outline.push(p)
      if (tooth) {
        const tw = tooth * (0.42 + R() * 0.2)
        outline.push(
          { x: p.x + dir * tw * 0.2, y: p.y - tooth * 0.55 },
          { x: p.x + dir * tw * 0.45, y: p.y - tooth },
          { x: p.x + dir * tw * 0.62, y: p.y - tooth * 0.78 },
          { x: p.x + dir * tw * 0.8, y: p.y - tooth * 0.84 },
          { x: p.x + dir * tw * 1.1, y: p.y - tooth * 0.15 },
        )
      }
    }
    pts.outline = outline
    return pts
  }
  const left = flank(-1)
  const right = flank(1)
  /** A point on the mountain's face: u across (-1 left edge, 1 right edge), f down (0 rim, 1 foot). */
  const P = (u, f) => {
    const x = clamp01(f) * ROWS
    const i = Math.min(ROWS - 1, Math.floor(x))
    const t = x - i
    const xl = lerp(left[i].x, left[i + 1].x, t)
    const xr = lerp(right[i].x, right[i + 1].x, t)
    const yl = lerp(left[i].y, left[i + 1].y, t)
    const yr = lerp(right[i].y, right[i + 1].y, t)
    const k = (u + 1) / 2
    return { x: lerp(xl, xr, k), y: lerp(yl, yr, k) + (1 - u * u) * H * 0.03 * f }
  }

  // Crests and gullies down the face, as u(row). Edge, gully, crest, gully ... crest, gully, edge.
  const K = phone ? 5 : 8
  const crests = []
  for (let k = 0; k < K; k++) {
    const u0 = -0.86 + ((k + 0.5) / K) * 1.72 + rr(-0.085, 0.085)
    const arr = new Float32Array(ROWS + 1)
    for (let i = 0; i <= ROWS; i++) {
      const f = i / ROWS
      arr[i] = u0 + (vnoise(f * 3.1 + k * 7.3, 2.7 + k) - 0.5) * 0.17 * (0.3 + 0.7 * f) + Math.sign(u0) * 0.03 * f
    }
    crests.push(arr)
  }
  const edgeL = new Float32Array(ROWS + 1).fill(-1)
  const edgeR = new Float32Array(ROWS + 1).fill(1)
  const bounds = [edgeL, ...crests, edgeR]
  const lines = [] // { u: Float32Array, crest: boolean }
  for (let j = 0; j < bounds.length - 1; j++) {
    lines.push({ u: bounds[j], crest: true })
    const g = new Float32Array(ROWS + 1)
    for (let i = 0; i <= ROWS; i++) {
      const f = i / ROWS
      const gap = bounds[j + 1][i] - bounds[j][i]
      g[i] = (bounds[j][i] + bounds[j + 1][i]) / 2 + (vnoise(f * 4.7 + j * 3.1, 9.1) - 0.5) * 0.7 * gap
    }
    lines.push({ u: g, crest: false })
  }
  lines.push({ u: edgeR, crest: true })

  // ---------------------------------------------------------------- the river: one gully carries it, breach to lake
  // The lake sits where it always has, whatever the mountain's width: the river's place across the face is solved from
  // where it should reach the foot, and the gully nearest to that carries it.
  const footAim = o.footX ?? (phone ? peakX + 0.075 * w : w * (flip ? 0.276 : 0.24))
  const rowFoot = Math.round(ROWS * 0.8)
  const aimU = Math.max(-0.55, Math.min(0.55, ((footAim - left[rowFoot].x) / (right[rowFoot].x - left[rowFoot].x)) * 2 - 1))
  const riverU = o.riverU !== undefined ? o.riverU * mx : aimU
  let riverLine = null
  for (const ln of lines) {
    if (ln.crest) continue
    if (!riverLine || Math.abs(ln.u[rowFoot] - riverU) < Math.abs(riverLine.u[rowFoot] - riverU)) riverLine = ln
  }
  const breach = { x: peakX - 0.26 * rw * mx, y: rimY - 0.04 * ch }

  // the lake: a wide flat basin at the mountain's foot, its near half below the bottom edge. Tuner `lake` sets how much
  // of it shows: its depth up the screen (`vis`, px; the far shore rises over the mountain's foot) and, with it, its
  // width. The mountain's rim does not move. The shore is an ellipse with a ragged edge, kept as one outline so the
  // river, the monolith and the lake's own pixels all agree on where the water stops.
  const lakeK = Math.max(0.6, Math.min(1.8, tn.lake ?? 1))
  const lake = (() => {
    const vis = groundH * (phone ? 0.4 + 0.75 * lakeK : 0.45 + lakeK)
    const rx = (phone ? w * 0.66 : Math.min(w * 0.235, 380)) * (0.55 + 0.45 * lakeK)
    const ry = vis * 1.12
    const foot = P(riverLine.u[Math.round(ROWS * 0.8)], 0.8)
    const cx = phone ? w * 0.5 : foot.x - (rx / (0.55 + 0.45 * lakeK)) * 0.18 * mx
    const cy = h - vis + ry * 0.97
    return { rx, ry, cx, cy, vis }
  })()
  // how far out the ragged shore stands at an angle, as a fraction of the ellipse
  const shoreAt = (ang) => {
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    return 0.97 + 0.1 * (vnoise(c * 2.3 + 5, s * 2.3 + 1) - 0.5) + 0.03 * (vnoise(c * 9 + 3, s * 9 + 8) - 0.5)
  }
  const SHORE_N = 240
  const shore = Array.from({ length: SHORE_N }, (_, i) => {
    const a = (i / SHORE_N) * TAU
    const k = shoreAt(a)
    return { x: lake.cx + Math.cos(a) * lake.rx * k, y: lake.cy + Math.sin(a) * lake.ry * k, a }
  })
  /** The far shore's y at x (the lake's top edge there); the side shore's y where x is past the ends. */
  const lakeTopAt = (x) => {
    // the top half runs from angle PI to TAU: left to right
    const lo = SHORE_N / 2
    if (x <= shore[lo].x) return shore[lo].y
    for (let i = lo + 1; i < SHORE_N; i++) {
      if (shore[i].x >= x) return lerp(shore[i - 1].y, shore[i].y, (x - shore[i - 1].x) / (shore[i].x - shore[i - 1].x || 1))
    }
    return shore[SHORE_N - 1].y
  }

  const river = (() => {
    const raw = [breach]
    for (let i = 2; i <= ROWS; i++) {
      const p = P(riverLine.u[i], i / ROWS)
      if (p.y > lakeTopAt(p.x) - 5) break
      raw.push(p)
    }
    // The river does not stop at the shore: it runs on into the lake, a third of the way across the visible crust, so
    // it can pour in and fan out there.
    const lastX = raw[raw.length - 1].x
    raw.push({ x: lastX - 2 * mx, y: lakeTopAt(lastX) + 3 })
    raw.push({ x: lastX - 11 * mx, y: lakeTopAt(lastX) + lake.vis * 0.3 })
    const N = 80
    const { pts, length } = smoothPath(raw, N)
    // the first sample on the lake: the mouth. The channel opens a little from just above it.
    let mouthI = N
    for (let i = 0; i <= N; i++) {
      if (pts[i].y >= lakeTopAt(pts[i].x)) {
        mouthI = i
        break
      }
    }
    const mouthS = mouthI / N
    const nx = new Float32Array(N + 1)
    const ny = new Float32Array(N + 1)
    const hw = new Float32Array(N + 1)
    for (let i = 0; i <= N; i++) {
      const a = pts[Math.max(0, i - 1)]
      const b = pts[Math.min(N, i + 1)]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const l = Math.hypot(dx, dy) || 1
      nx[i] = -dy / l
      ny[i] = dx / l
      const s = i / N
      hw[i] = chb * (0.13 + 0.3 * Math.pow(s, 1.25)) * (phone ? 0.78 : 1) * (1 + 0.1 * (vnoise(s * 6, 4.4) - 0.5)) * (1 + 0.5 * sm((s - (mouthS - 0.1)) / 0.2))
    }
    return { pts, N, nx, ny, hw, length, inlet: pts[N], mouth: pts[mouthI], mouthI, mouthS }
  })()
  // the dry land above the lake: levees and shoulders are clipped to it, so the channel crosses the shore and never
  // shows a cut end on the lake
  const aboveLake = new Path2D()
  aboveLake.rect(0, 0, w, h)
  // the shore, pushed out a little so the levees stop at the basin's rim and do not run over it
  shore.forEach((p, i) => {
    if (i % 3) return
    const gx = (p.x - lake.cx) / (lake.rx * lake.rx)
    const gy = (p.y - lake.cy) / (lake.ry * lake.ry)
    const gl = Math.hypot(gx, gy) || 1
    const x = p.x + (gx / gl) * 7
    const y = p.y + (gy / gl) * 7
    if (i) aboveLake.lineTo(x, y)
    else aboveLake.moveTo(x, y)
  })
  aboveLake.closePath()
  const riverXAt = (y) => {
    const p = river.pts
    if (y <= p[0].y) return p[0].x
    for (let i = 1; i <= river.N; i++) if (p[i].y >= y) return lerp(p[i - 1].x, p[i].x, (y - p[i - 1].y) / (p[i].y - p[i - 1].y || 1))
    return p[river.N].x
  }
  const riverHwAt = (y) => {
    const p = river.pts
    if (y <= p[0].y) return river.hw[0]
    for (let i = 1; i <= river.N; i++) if (p[i].y >= y) return lerp(river.hw[i - 1], river.hw[i], (y - p[i - 1].y) / (p[i].y - p[i - 1].y || 1))
    return river.hw[river.N]
  }
  /** A frame on the river at fraction s: centre, normal, half-width. */
  const riverAt = (s) => {
    const x = clamp01(s) * river.N
    const i = Math.min(river.N - 1, Math.floor(x))
    const t = x - i
    return {
      x: lerp(river.pts[i].x, river.pts[i + 1].x, t),
      y: lerp(river.pts[i].y, river.pts[i + 1].y, t),
      nx: lerp(river.nx[i], river.nx[i + 1], t),
      ny: lerp(river.ny[i], river.ny[i + 1], t),
      hw: lerp(river.hw[i], river.hw[i + 1], t),
    }
  }
  const ribbon = (g, k, grow = 0, last = river.N) => {
    g.beginPath()
    for (let i = 0; i <= last; i++) {
      const p = river.pts[i]
      const d = river.hw[i] * k + grow
      if (i === 0) g.moveTo(p.x + river.nx[i] * d, p.y + river.ny[i] * d)
      else g.lineTo(p.x + river.nx[i] * d, p.y + river.ny[i] * d)
    }
    for (let i = last; i >= 0; i--) {
      const p = river.pts[i]
      const d = river.hw[i] * k + grow
      g.lineTo(p.x - river.nx[i] * d, p.y - river.ny[i] * d)
    }
    g.closePath()
  }

  // ---------------------------------------------------------------- the molten body: Doom fire laid along the channel
  // The site's own fire (src/lib/doomfire.js, the engine and palette behind the title). The breach is the fire's source
  // row and "up" in the fire is downstream: every step a cell takes the heat of the cell upstream of it, a column to
  // one side or the other, and may lose a step of heat. So heat licks down the river in flickering tongues, cools as
  // it goes, and the streaks it leaves are the flow lines. Only the cooling differs from the title's fire: it follows
  // a curve along the river (white-hot at the breach, deep orange by the lake). Two more things shape it so the river
  // has grain from its first row: crust that forms in specks and heals again (the specks come as often all down the
  // river, but live longer as it cools, so they grow downstream), and a per-pixel shade on top of the fire's heat: a
  // hot core near the breach, bright margins, a chilled lip against the levee.
  // tuner `lavaHeat`: every heat is read a little higher (or lower) up the palette, so crust stays dark and the hot lava
  // runs toward gold. The lake takes it too, so its open lava still matches the river where the two meet.
  const lavaHeatK = Math.max(0.5, Math.min(1.5, tn.lavaHeat ?? 1))
  const lava = (() => {
    const cell = 2 // a fine grain, as the title's fire has
    const rows = Math.max(40, Math.round(river.length / cell))
    // Across the channel a cell is the same size all the way down, so the grain at the breach matches the grain at the
    // lake. (It was stretched to the channel's width: 28 columns squeezed into 17 px at the top, which averaged the
    // top third to a flat orange.) The narrow top only looks at the middle columns.
    const cellPx = phone ? 1.5 : 2
    let maxHw = 0
    for (let i = 0; i <= river.N; i++) maxHw = Math.max(maxHw, river.hw[i])
    const cols = Math.max(12, Math.ceil((2 * maxHw) / cellPx) + 6)
    const mid = (cols - 1) / 2
    const SOURCE = 34 // warm white at the breach; an eruption pushes it to the top of the ramp
    const WAVE = 0.3 // how far the source rolls and dips: tongues, without starving the river
    const fire = new DoomFire(cols, rows, { maxHeat: SOURCE, variation: 1 })
    // The mean heat wanted along the river, as [fraction, heat]; its slope is the chance of losing a step per row.
    // It falls fast below the breach and then holds: the river is still a deep orange where it meets the lake. (The
    // rolling source takes about three more steps off, so the lake end sits near 16.)
    const target = o.lavaCurve ?? [[0, SOURCE], [0.1, 27], [0.4, 23], [1, 20.5]]
    const lose = new Float32Array(rows)
    const mean = new Float32Array(rows) // where a cell settles if nothing crusts it: the curve less the source's dip
    const heal = new Float32Array(rows) // the chance a crusted cell takes back two steps of heat this row
    const speck = new Float32Array(rows) // the chance a cell in the channel crusts over this row
    const span = new Float32Array(rows) // how many cells either side of the middle are inside the channel here
    for (let y = 0; y < rows; y++) {
      const s = 1 - y / (rows - 1)
      let k = 1
      while (k < target.length - 1 && target[k][0] < s) k++
      lose[y] = Math.min(0.95, (target[k - 1][1] - target[k][1]) / (target[k][0] - target[k - 1][0]) / (rows - 1))
      mean[y] = lerp(target[k - 1][1], target[k][1], clamp01((s - target[k - 1][0]) / (target[k][0] - target[k - 1][0]))) - 3.2
      heal[y] = 0.5 - 0.3 * s // a speck lives about 8 rows near the breach and about 20 by the lake
      speck[y] = 0.02 + 0.004 * s
      span[y] = riverAt(s).hw / cellPx + 1
    }
    const step = () => {
      const cells = fire.cells
      for (let y = 1; y < rows; y++) {
        const row = y * cols
        const above = row - cols
        const p = lose[y]
        const settle = mean[y] - 2.5
        const hl = heal[y]
        const sp = speck[y]
        const rch = span[y]
        for (let x = 0; x < cols; x++) {
          let dx = x - ((Math.random() * 3) | 0) + 1
          if (dx < 0) dx = 0
          else if (dx >= cols) dx = cols - 1
          let next = cells[row + x] - (Math.random() < p ? 1 : 0)
          if (next < settle) {
            // crust, and it heals from beneath
            if (Math.random() < hl) next += 2
          } else if (Math.abs(x - mid) < rch && Math.random() < sp) {
            // a speck two cells wide where it can be
            next = 2 + ((Math.random() * 6) | 0)
            cells[above + (dx + 1 < cols ? dx + 1 : dx)] = next
          }
          cells[above + dx] = next > 0 ? next : 0
        }
      }
    }
    // already burning when the page opens: the river is full from the first frame
    for (let i = 0; i < rows * 1.6; i++) {
      fire.stokeCoals(i * 0.1, WAVE, 0.6)
      step()
    }
    const prev = new Uint8Array(fire.cells)
    const heat = new Float32Array(cols * rows)

    // which fire cell each pixel of the ribbon looks at, worked out once
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let i = 0; i <= river.N; i++) {
      const p = river.pts[i]
      const d = river.hw[i] + 3
      x0 = Math.min(x0, p.x - d)
      x1 = Math.max(x1, p.x + d)
      y0 = Math.min(y0, p.y - d)
      y1 = Math.max(y1, p.y + d)
    }
    x0 = Math.floor(x0)
    y0 = Math.floor(y0)
    const bw = Math.ceil(x1) - x0
    const bh = Math.ceil(y1) - y0
    const { cv, g } = makeCanvas(bw, bh)
    const img = g.createImageData(bw, bh)
    const claimed = new Uint8Array(bw * bh)
    const pix = []
    const pr = []
    const pc = []
    const pa = []
    const po = []
    // What a pixel's colour gets besides the fire's heat, in palette steps: a hot core thread near the breach (toward
    // gold), a bright margin just inside each bank, and a chilled lip right against the levee. On the lake the
    // margins let go, as there are no banks there.
    const into = (s) => sm((s - river.mouthS) / (1 - river.mouthS || 1))
    const shade = (s, across, hwHere) => {
      const edge = Math.abs(across) / hwHere
      const core = 8 * (1 - sm(s / 0.55)) * Math.exp(-Math.pow(across / (0.28 * hwHere), 2))
      const rim = 6 * (1 - 0.4 * s) * Math.exp(-Math.pow((edge - 0.84) / 0.1, 2))
      const lip = -6 * sm((edge - 0.92) / 0.08)
      return core + (rim + lip) * (1 - into(s))
    }
    // How opaque it is. Over its last stretch the river melts into the lake's open lava: the sides feather away and the
    // end fades, rather than stopping at an edge.
    const melt = (s, across, hwHere) => (1 - sm((s - river.mouthS) / (1 - river.mouthS || 1))) * (1 - 0.85 * into(s) * sm((Math.abs(across) / hwHere - 0.45) / 0.55))
    for (let i = 0; i < river.N; i++) {
      const a = river.pts[i]
      const b = river.pts[i + 1]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len2 = dx * dx + dy * dy || 1
      const len = Math.sqrt(len2)
      const nx = -dy / len
      const ny = dx / len
      const reach = Math.max(river.hw[i], river.hw[i + 1]) + 2
      const bx0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - reach) - x0)
      const bx1 = Math.min(bw - 1, Math.ceil(Math.max(a.x, b.x) + reach) - x0)
      const by0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - reach) - y0)
      const by1 = Math.min(bh - 1, Math.ceil(Math.max(a.y, b.y) + reach) - y0)
      for (let py = by0; py <= by1; py++) {
        for (let px = bx0; px <= bx1; px++) {
          const off = py * bw + px
          if (claimed[off]) continue
          const qx = px + 0.5 + x0 - a.x
          const qy = py + 0.5 + y0 - a.y
          const tt = (qx * dx + qy * dy) / len2
          if (tt < -0.2 || tt > 1.2) continue
          const tc = clamp01(tt)
          const hwHere = lerp(river.hw[i], river.hw[i + 1], tc)
          const across = qx * nx + qy * ny
          if (Math.abs(across) > hwHere + 0.5) continue
          claimed[off] = 1
          pix.push(off * 4)
          const s = (i + tc) / river.N
          pr.push((rows - 1) * (1 - s))
          pc.push(across / cellPx + mid)
          pa.push(255 * clamp01(hwHere + 0.5 - Math.abs(across)) * melt(s, across, hwHere))
          po.push(shade(s, across, hwHere))
        }
      }
    }
    // Round joints: where the channel bends, the straight slabs above leave a wedge on the outside of the bend. Any
    // pixel still unclaimed within a half-width of a sample point belongs to that point. (Not past the river's end: a
    // joint's circle reaches out beyond it, and what it painted there lay on the lake as a lit crescent.)
    const endP = river.pts[river.N]
    const endQ = river.pts[river.N - 1]
    const endL = Math.hypot(endP.x - endQ.x, endP.y - endQ.y) || 1
    const endTx = (endP.x - endQ.x) / endL
    const endTy = (endP.y - endQ.y) / endL
    for (let i = 1; i < river.N - 3; i++) {
      const p = river.pts[i]
      const reach = river.hw[i] + 0.5
      const bx0 = Math.max(0, Math.floor(p.x - reach) - x0)
      const bx1 = Math.min(bw - 1, Math.ceil(p.x + reach) - x0)
      const by0 = Math.max(0, Math.floor(p.y - reach) - y0)
      const by1 = Math.min(bh - 1, Math.ceil(p.y + reach) - y0)
      for (let py = by0; py <= by1; py++) {
        for (let px = bx0; px <= bx1; px++) {
          const off = py * bw + px
          if (claimed[off]) continue
          const qx = px + 0.5 + x0 - p.x
          const qy = py + 0.5 + y0 - p.y
          const dist = Math.hypot(qx, qy)
          if (dist > reach) continue
          if ((px + 0.5 + x0 - endP.x) * endTx + (py + 0.5 + y0 - endP.y) * endTy > 0) continue
          claimed[off] = 1
          pix.push(off * 4)
          pr.push((rows - 1) * (1 - i / river.N))
          const across = qx * river.nx[i] + qy * river.ny[i]
          pc.push(across / cellPx + mid)
          pa.push(255 * clamp01(reach - dist) * melt(i / river.N, across, river.hw[i]))
          po.push(shade(i / river.N, across, river.hw[i]))
        }
      }
    }
    const n = pix.length
    const PIX = Int32Array.from(pix)
    const PR = Float32Array.from(pr)
    const PC = Float32Array.from(pc)
    const PA = Uint8Array.from(pa)
    const PO = Float32Array.from(po)
    let acc = 0
    const RATE = o.lavaRate ?? 12 // fire steps a second (24 px): lava is thick, so far slower than the title's flames
    const paint = (secs, t, flare) => {
      acc += secs * RATE
      let guard = 0
      while (acc >= 1 && guard++ < 4) {
        acc -= 1
        prev.set(fire.cells)
        // an eruption sends hotter lava out of the breach, and the surge travels down with the fire
        fire.maxHeat = SOURCE + 2 * flare
        fire.stokeCoals(t, WAVE * (1 - flare), 0.6)
        step()
      }
      if (acc > 1) acc = 1
      const cur = fire.cells
      for (let i = 0; i < heat.length; i++) heat[i] = prev[i] + (cur[i] - prev[i]) * acc
      const d = img.data
      for (let k = 0; k < n; k++) {
        const r = PR[k]
        const c = PC[k] < 0 ? 0 : PC[k] > cols - 1 ? cols - 1 : PC[k]
        const r0 = r | 0
        const c0 = c | 0
        const fr = r - r0
        const fc = c - c0
        const ra = r0 * cols
        const rb = (r0 + 1 < rows ? r0 + 1 : r0) * cols
        const c1 = c0 + 1 < cols ? c0 + 1 : c0
        const top = heat[ra + c0] + (heat[ra + c1] - heat[ra + c0]) * fc
        const bot = heat[rb + c0] + (heat[rb + c1] - heat[rb + c0]) * fc
        const off = PIX[k]
        heatColour((top + (bot - top) * fr + PO[k]) * lavaHeatK, d, off)
        d[off + 3] = PA[k]
      }
      g.putImageData(img, 0, 0)
    }
    return { cv, x0, y0, bw, bh, paint, rows, cols, n }
  })()

  // ---------------------------------------------------------------- light on the rock
  // `n` is how far a plane leans, -1 facing left to 1 facing right; 0 is flat to the viewer. Light falls off fast: this
  // is a forge at night, and only the rock near the lava is lit.
  const fall = Math.max(34, w * 0.034)
  const lightAt = (x, y, n, f) => {
    const d = x - riverXAt(y)
    const toward = d > 0 ? -1 : 1 // the way a plane must lean to see the river
    const lit = Math.pow(clamp01(0.5 + 0.5 * n * toward), 1.6)
    const below = y > shoreY - 10
    // above the breach (the crown) the river's light is the breach's light, and it thins with height
    const up = y < breach.y ? (breach.y - y) / (ch * 0.9) : 0
    let warm = below ? 0 : (0.9 - 0.25 * f) * Math.exp(-Math.abs(d) / fall) * (0.05 + 0.95 * lit) * Math.exp(-up)
    // the breach lights the chute below it; the spear and the stub shade the rock to either side
    const dc = Math.hypot(x - breach.x, (y - breach.y) * 0.7)
    const sdx = (x - breach.x) * mx
    const side = sdx > rw * 0.45 ? (sdx - rw * 0.45) / (rw * 0.5) : sdx < -rw * 0.4 ? (-rw * 0.4 - sdx) / (rw * 0.5) : 0
    warm += 0.8 * Math.exp(-dc / (ch * 1.5)) * (0.2 + 0.8 * lit) * Math.exp(-side)
    const dl = Math.hypot((x - river.mouth.x) * 0.6, y - river.mouth.y)
    warm += 0.42 * Math.exp(-dl / (groundH * 0.9)) * (0.3 + 0.7 * lit)
    // the moon's side: planes leaning right, more on the right of the mountain and higher up
    const cool = Math.pow(clamp01(0.5 + 0.5 * n), 1.4) * (0.3 + 0.7 * (1 - f)) * (0.25 + 0.75 * clamp01((x - (peakX - ch)) / halfBase))
    return { warm: Math.min(1, warm), cool }
  }
  const rockColour = (x, y, n, f, tint) => {
    const { warm, cool } = lightAt(x, y, n, f)
    const amb = 1 - f
    const wc = ramp(WARM, warm)
    const foot = 1 - 0.55 * sm((f - 0.72) / 0.25)
    return [
      (5 + 3 * amb + 20 * cool + wc[0]) * tint * foot + 2,
      (9 + 5 * amb + 32 * cool + wc[1]) * tint * foot + 3,
      (8 + 4 * amb + 28 * cool + wc[2]) * tint * foot + 3,
    ]
  }
  /** How sharply a plane leans at this height: crests come and go down the face, and the sheer top is nearly smooth. */
  const lean = (j, f) => sm((vnoise(f * 2.3 + j * 1.7, 5.5) - 0.22) / 0.4) * (0.3 + 0.7 * sm(f / 0.3))

  // ---------------------------------------------------------------- the broken crown, in crater widths from the rim centre
  // A thick tower snapped off at a slant, its left third gone (the breach), and a low broken stub left of the breach.
  // Both outer walls carry on up from the flanks, so the crown is the top of the mountain and not something set on it.
  // The walls break at uneven angles, mostly steep with a few slants (fractured basalt), never tread and riser.
  const crownPts = [
    [-1, 0], [-0.98, -0.34], [-0.92, -0.6], [-0.88, -0.86], [-0.78, -0.98], [-0.66, -1.06], [-0.58, -0.84], [-0.54, -0.52], [-0.45, -0.26], [-0.4, -0.06],
    [-0.26, 0.02], [-0.12, -0.03],
    [-0.14, -0.58], [-0.04, -0.92], [-0.06, -1.4], [0.04, -1.62], [0.03, -1.98], [0.2, -2.12], [0.36, -2.25], [0.46, -2.0], [0.54, -2.04],
    [0.58, -1.66], [0.7, -1.5], [0.72, -1.1], [0.8, -0.92], [0.84, -0.58], [0.95, -0.4], [0.97, -0.2], [1, 0],
  ].map(([x, y], i, all) => {
    const pin = i === 0 || i === all.length - 1
    return { x: peakX + (x + (pin ? 0 : rr(-0.012, 0.012))) * rw * mx, y: rimY + (y + (pin ? 0 : rr(-0.02, 0.02))) * ch }
  })
  const cpt = (x, y) => ({ x: peakX + x * rw * mx, y: rimY + y * ch })
  // the tall spire's tip: the highest point of the mountain. In the stack layout the moon keeps clear above it.
  const tipY = Math.min(...crownPts.map((p) => p.y))
  const moonCeil = stack ? tipY - 14 : Infinity

  // ---------------------------------------------------------------- shoulder peaks
  // Heavy buttresses of the same chain: each stands in front of a flank, rising out of it at a col, its far side running
  // on down to the ground. They are as dark as the flank beside them (the paint samples it), broad (the base at least
  // 1.3 times the height above the shore) and low: they step the flank down toward the ground like a ridge line. No
  // summit may stand in the title block (x 20% to 80%, y 33% to 57%), and no two stand at one height.
  //   on: what it rises from (-1 the flank, or an earlier shoulder's far side)   fc: where on that line the col is
  //   out: how far the summit stands out from that line   rise: how far above the col   reach: how far the far side
  //   runs out at the ground. All in mountain heights.
  const shoulders = (() => {
    const SR = mulberry32(seed ^ 0x5b0c) // its own stream, so the flanks and the relief keep their rolls
    const sr = (a, b) => a + SR() * (b - a)
    // a broken line from a to b: n points between, each knocked sideways
    const crag = (a, b, n, amp) => {
      const out = [a]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      for (let k = 1; k <= n; k++) {
        const t = (k + sr(-0.3, 0.3)) / (n + 1)
        const j = sr(-1, 1) * amp * len
        out.push({ x: a.x + dx * t - (dy / len) * j, y: a.y + dy * t + (dx / len) * j })
      }
      out.push(b)
      return out
    }
    const specs = [
      { dir: 1, on: -1, fc: 0.5, out: 0.2, rise: 0.06, reach: 0.6 },
      { dir: 1, on: 0, fc: 0.3, out: 0.1, rise: 0.095, reach: 0.5 },
      { dir: -1, on: -1, fc: 0.34, out: 0.1, rise: 0.08, reach: 0.7 },
    ]
    const made = []
    for (const s of specs) {
      const d = s.dir
      const base = s.on < 0 ? (d < 0 ? left : right) : made[s.on].outer
      const ci = Math.round(s.fc * (base.length - 1))
      const c0 = base[ci]
      const col = { x: c0.x - d * 0.012 * H, y: c0.y }
      const sx = c0.x + d * s.out * H
      // the summit, kept out of the title block whatever the sliders say
      const so = { x: sx, y: sx > w * 0.2 && sx < w * 0.8 ? Math.max(c0.y - s.rise * H, h * 0.585) : c0.y - s.rise * H }
      const bottom = h + 30
      // The far side runs from the summit to the ground in segments, each at its own slant (sheer, then a bench, then
      // sheer again, easing out toward the foot): never a straight edge and never a horizontal tread.
      const slants = [0.3, 0.42, 0.26, 0.75, 0.34, 0.6, 0.85, 0.95, 0.9]
      const drop = bottom - so.y
      const cut = [0, 0.1, 0.22, 0.34, 0.44, 0.56, 0.7, 0.82, 0.92, 1]
      let wsum = 0
      const wide = slants.map((v, k) => {
        const wv = v * sr(0.75, 1.25) * (cut[k + 1] - cut[k])
        wsum += wv
        return wv
      })
      const outer = [so]
      let acc = 0
      for (let k = 0; k < wide.length; k++) {
        acc += wide[k]
        outer.push({ x: so.x + d * (acc / wsum) * s.reach * H, y: so.y + drop * cut[k + 1] + (k < wide.length - 1 ? sr(-0.006, 0.006) * H : 0) })
      }
      // Broad: stretch the far side until the base (col to where it meets the shore) is 1.3 times the height above it.
      const need = 1.3 * Math.max(0, shoreY - so.y)
      let fx = so.x
      for (let k = 1; k < outer.length; k++) {
        if (outer[k].y >= shoreY) {
          fx = lerp(outer[k - 1].x, outer[k].x, (shoreY - outer[k - 1].y) / (outer[k].y - outer[k - 1].y || 1))
          break
        }
      }
      if (d * (fx - col.x) < need) {
        const m = Math.min(2.2, (need - d * (so.x - col.x)) / (d * (fx - so.x) || 1))
        for (let k = 1; k < outer.length; k++) outer[k].x = so.x + (outer[k].x - so.x) * m
      }
      // The near side: the ridge from the col climbs in knees, with a lesser horn and a notch before the summit, so the
      // line is never a smooth slope. [along the chord, share of the rise]
      const knees = [[0, 0], [0.16, 0.07], [0.32, 0.19], [0.47, 0.5], [0.56, 0.36], [0.7, 0.58], [0.84, 0.77], [0.93, 0.9], [1, 1]]
      const ridge = knees.map(([t, up], k) => {
        if (k === 0) return col
        if (k === knees.length - 1) return so
        return { x: lerp(col.x, so.x, t) + sr(-0.006, 0.006) * H, y: col.y - (col.y - so.y) * up }
      })
      const inner = { x: col.x - d * 0.1 * H, y: bottom } // where the shoulder's body ends, inside the flank
      // a spine from just under the summit to the ground: it splits the body into the face toward the volcano and the
      // face away from it, two tones a few points apart
      const lastP = outer[outer.length - 1]
      const spine = crag({ x: so.x - d * 0.012 * H, y: so.y + 0.03 * H }, { x: lerp(lastP.x, inner.x, 0.7), y: bottom }, 4, 0.05)
      // broken gullies down the near face
      const gullies = [0.2, 0.42, 0.62].map((t) => {
        const a = { x: lerp(spine[0].x, spine[spine.length - 1].x, t) - d * sr(0.02, 0.06) * H, y: lerp(spine[0].y, bottom, t) }
        return [a, { x: a.x - d * sr(0.005, 0.03) * H, y: a.y + sr(0.08, 0.16) * H }]
      })
      // which way is out of the flank here (the mask that melts the shoulder into the flank follows it)
      const b2 = base[Math.min(base.length - 1, ci + 6)]
      const tl = Math.hypot(b2.x - c0.x, b2.y - c0.y) || 1
      made.push({ d, col, so, ridge, outer, spine, gullies, inner, bottom, base, ci, nx: (d * (b2.y - c0.y)) / tl, ny: (-d * (b2.x - c0.x)) / tl })
    }
    return made
  })()

  // ---------------------------------------------------------------- baked layers
  const sky = makeCanvas(w, h, dpr)
  const land = makeCanvas(w, h, dpr)
  const fore = makeCanvas(w, h, dpr)

  const paintSky = () => {
    const g = sky.g
    const base = g.createLinearGradient(0, 0, 0, h)
    base.addColorStop(0, 'rgb(4,7,8)')
    base.addColorStop(0.42, 'rgb(8,10,10)')
    base.addColorStop(0.76, 'rgb(24,13,9)')
    base.addColorStop(1, 'rgb(52,19,9)')
    g.fillStyle = base
    g.fillRect(0, 0, w, h)
    // the heavens lit from the crater: orange at the heart, sulphur-ochre toward the edge
    const rad = Math.max(w, h) * 0.56
    const dome = g.createRadialGradient(breach.x, breach.y - ch, 0, breach.x, breach.y - ch, rad)
    dome.addColorStop(0, 'rgba(255,122,44,0.26)')
    dome.addColorStop(0.22, 'rgba(226,96,36,0.15)')
    dome.addColorStop(0.5, 'rgba(176,118,38,0.06)')
    dome.addColorStop(1, 'rgba(120,90,30,0)')
    g.fillStyle = dome
    g.fillRect(0, 0, w, h)
    // the glow of the lava fields along the horizon
    g.save()
    g.translate(peakX, h)
    g.scale(1, 0.42)
    const hz = g.createRadialGradient(0, 0, 0, 0, 0, w * 0.62)
    hz.addColorStop(0, 'rgba(224,67,29,0.34)')
    hz.addColorStop(0.5, 'rgba(150,35,15,0.14)')
    hz.addColorStop(1, 'rgba(150,35,15,0)')
    g.fillStyle = hz
    g.fillRect(-w, -h * 2, w * 2, h * 2)
    g.restore()
  }

  /** A jagged ridge line through control points, by midpoint displacement. Returns points and the indices of the controls. */
  const jagged = (ctrl, rough, levels = 4, rnd = rr) => {
    let pts = ctrl.map((p) => ({ ...p }))
    let idx = ctrl.map((_, i) => i)
    for (let l = 0; l < levels; l++) {
      const next = []
      const nidx = []
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]
        const b = pts[i + 1]
        const len = Math.hypot(b.x - a.x, b.y - a.y)
        next.push(a)
        if (idx.includes(i)) nidx.push(next.length - 1)
        next.push({ x: (a.x + b.x) / 2 + rnd(-1, 1) * len * rough * 0.25, y: (a.y + b.y) / 2 + rnd(-1, 1) * len * rough })
      }
      next.push(pts[pts.length - 1])
      nidx.push(next.length - 1)
      pts = next
      idx = nidx
      rough *= 0.62
    }
    return { pts, idx }
  }

  // ---------------------------------------------------------------- the far country
  // Nocturne is webbed with chains of volcanoes, and Deathfire is only the largest of them. So behind it stand bands of
  // small sharp peaks, far to near. Each band is one silhouette made of its own seeded peaks (craggy slopes, a few
  // spires, a few cones cut off flat with a notch for a crater), with an ash plain left open here and there. The far
  // bands are lighter and warmer, seen through the haze; the near ones are darker and cooler. The nearest band joins
  // Deathfire's right shoulder and is painted on the land layer, so the mountain stands in front of it; the others are
  // baked into the sky layer, behind the moon and the plume. A few far cones are alive: a pin of light in the notch and a
  // thin thread of smoke leaning with the same wind as the main plume.
  // Tuner: `ranges` is the density (0 none, 1 the default look, 3 crowded), `rangeH` the height, `haze` the wash between bands.
  const far = (() => {
    const density = Math.max(0, Math.min(3, tn.ranges ?? 1))
    const heightK = Math.max(0.2, Math.min(2.5, tn.rangeH ?? 1))
    const hazeK = Math.max(0, Math.min(1, tn.haze ?? 0.5)) * 2
    const S = h / 728 // the size of small things (notches, cracks), made for a screen this tall
    const STEP = 2
    const X0 = -24
    const N = Math.ceil((w + 48) / STEP) + 1
    // The mountain's tints and rills draw from the shared stream just after the near band. The old range drew 162 numbers
    // there; drawing them still keeps the mountain's own random values where they were.
    const burn = () => {
      for (let i = 0; i < 162; i++) R()
    }
    if (density < 0.02) return { lives: [], paintBands() {}, paintNear: burn }

    // peak heights are fractions of the screen height above the shore, before the zone, the tuner and the soft cap
    // `asp` is a peak's half width over its height (small is sharp); `space` the mean gap between peaks, as a fraction of
    // the screen height. Peaks are narrower than they are tall and crowd each other, so the skyline is the top of many
    // overlapping spurs and not a row of separate triangles. `dip` is how far the zone below lowers that band.
    const DEFS = phone
      ? [
          { foot: 0.07, ridge: [0.02, 0.04], apex: [0.04, 0.1], space: 0.05, asp: [0.45, 0.9], top: [44, 24, 16], bot: [64, 33, 19], haze: 0.14, dip: 0 },
          { foot: 0.04, ridge: [0.03, 0.05], apex: [0.05, 0.14], space: 0.06, asp: [0.45, 0.9], top: [28, 16, 12], bot: [44, 23, 15], haze: 0.12, dip: 0 },
          { near: true, ridge: [0.025, 0.05], apex: [0.05, 0.17], space: 0.07, asp: [0.45, 0.9], dip: 0 },
        ]
      : [
          { foot: 0.12, ridge: [0.02, 0.04], apex: [0.07, 0.18], space: 0.03, asp: [0.4, 0.85], top: [46, 25, 16], bot: [72, 37, 21], haze: 0.12, dip: 0.25 },
          { foot: 0.09, ridge: [0.03, 0.055], apex: [0.09, 0.26], space: 0.036, asp: [0.4, 0.85], top: [28, 16, 12], bot: [48, 25, 16], haze: 0.11, dip: 0.25 },
          { foot: 0.06, ridge: [0.035, 0.065], apex: [0.11, 0.36], space: 0.046, asp: [0.4, 0.85], top: [16, 11, 9], bot: [30, 17, 12], haze: 0.09, dip: 0.25 },
          { near: true, ridge: [0.03, 0.05], apex: [0.07, 0.3], space: 0.052, asp: [0.45, 0.9], dip: 0.65 },
        ]
    // The title stands in the middle of the screen: there the peaks stay under the tagline (a quarter lower, the near band
    // a half), and the tuner's height cannot lift them past it unchecked. Past the knee a height is squeezed toward a ceiling.
    const zoneAmt = (x) => (phone ? 0 : sm((x - w * 0.22) / (w * 0.08)) * (1 - sm((x - w * 0.84) / (w * 0.07))))
    const soft = (v) => (v < 0.28 ? v : 0.28 + 0.14 * (1 - Math.exp(-(v - 0.28) / 0.14)))
    // a ceiling for the far bands: the tagline line in the zone (0.2), a little over a quarter outside it; the tuner
    // lifts the ceiling more slowly than the heights
    const squeeze = (v, c) => (v < 0.85 * c ? v : 0.85 * c + 0.15 * c * (1 - Math.exp(-(v - 0.85 * c) / (0.15 * c))))
    // ash plains: one or two stretches where every band drops low, a little out of step from band to band
    const gr = mulberry32((seed ^ 0x51ed) >>> 0)
    const gaps = phone ? [{ c: 0.72 + 0.16 * gr(), hw: 0.12 }] : [{ c: 0.44 + 0.18 * gr(), hw: 0.045 + 0.03 * gr() }, { c: 0.8 + 0.14 * gr(), hw: 0.04 + 0.03 * gr() }]
    const slide = [0, 0.03, -0.025, 0.015]
    const dipAt = (x, b) => {
      let d = 0
      for (const gp of gaps) d = Math.max(d, 1 - sm((Math.abs(x / w - gp.c - slide[b]) / gp.hw - 0.4) / 0.6))
      return d
    }
    /** Where one of the mountain's flanks (`left` or `right`) stands at a height. */
    const flankX = (side, y) => {
      for (let i = 0; i <= ROWS; i++) if (side[i].y >= y) return side[i].x
      return side[ROWS].x
    }

    const bands = DEFS.map((def, b) => {
      const rng = mulberry32(((seed ^ 0x9e3779b1) + b * 0x85ebca6b) >>> 0)
      const space = def.space * h
      const env = new Float32Array(N) // the skyline, in px above the shore
      const ridge = new Float32Array(N) // the low rolling ground under the peaks
      for (let i = 0; i < N; i++) {
        const x = X0 + i * STEP
        ridge[i] = h * lerp(def.ridge[0], def.ridge[1], vnoise(x / (w * 0.14) + b * 5.3, 2.2)) * Math.sqrt(heightK) * (1 - 0.55 * dipAt(x, b))
        env[i] = ridge[i]
      }
      // the near band starts on Deathfire's flank, half way up, and falls away from it
      const flank = right[ROWS >> 1]
      const startX = def.near ? flank.x - 30 : X0
      const from = def.near ? Math.max(0, Math.min(N - 1, Math.ceil((startX - X0) / STEP))) : 0
      const ruler = space / Math.max(1, density)
      let px = X0 - space * rng()
      for (;;) {
        // spacing wanders at two scales: a slow swell (clusters and thin stretches) and a roll of the dice per peak
        px += ruler * (0.4 + 1.3 * rng()) * (0.55 + 0.9 * vnoise(px / (w * 0.2) + b * 11.3, 3.1))
        if (px > w + 40) break
        const rank = rng()
        const kind = rng()
        const pick = rng()
        const asp = rng()
        const a1 = rng()
        const a2 = rng()
        const kx = rng()
        if (rank >= density || px < startX - 20) continue
        const mass = vnoise(px / (w * 0.25) + b * 7.7, 1.7) // massifs: ranges of the tall ones
        const t = clamp01(0.35 * mass + 0.65 * Math.pow(pick, 1.3) + (kind < 0.12 ? 0.2 : 0))
        const za = zoneAmt(px)
        let f = lerp(def.apex[0], def.apex[1], t) * (1 - def.dip * za) * heightK * (1 - 0.82 * dipAt(px, b))
        if (!def.near) f = squeeze(f, (0.3 - 0.1 * za) * (1 + 0.5 * Math.max(0, heightK - 1)))
        let ht = soft(f) * h
        if (ht < 3 * S) continue
        const cone = kind < 0.34
        const spire = !cone && kind < 0.46
        let hw = ht * lerp(def.asp[0], def.asp[1], asp)
        let k
        if (cone) {
          hw *= 1.35
          k = 1.2 + 0.25 * kx
        } else if (spire) {
          hw *= 0.55
          ht *= 1.1
          k = 1.5 + 0.5 * kx
        } else k = 1.05 + 0.5 * kx
        const wl = Math.max(7 * S, hw * (0.78 + 0.5 * a1))
        const wr = Math.max(7 * S, hw * (0.78 + 0.5 * a2))
        const tw = cone ? Math.min(7 * S, Math.max(2, 0.04 * (wl + wr))) : 0 // half the crater's width
        const notch = cone ? Math.max(2.5 * S, 0.1 * ht) : 0 // and how deep it sits
        const i0 = Math.max(0, Math.floor((px - wl - X0) / STEP))
        const i1 = Math.min(N - 1, Math.ceil((px + wr - X0) / STEP))
        const lump = px * 0.013 // where this peak's slopes break: ledges and bulges, so no flank is a straight line
        for (let i = i0; i <= i1; i++) {
          const dx = X0 + i * STEP - px
          const ad = Math.abs(dx)
          const side = dx < 0 ? wl : wr
          let y
          if (ad < tw) y = ht - notch * (1 - ad / tw)
          else {
            const u = clamp01((ad - tw) / (side - tw))
            y = ht * (Math.pow(1 - u, k) + (cone ? 0.18 : 0.34) * (vnoise(ad * 0.07 + lump, 4.1 + b) - 0.5) * Math.sin(Math.PI * u))
          }
          if (y > env[i]) env[i] = y
        }
      }
      if (def.near) {
        const flankH = shoreY - flank.y
        const span = w * 0.16
        for (let i = from; i < N; i++) {
          const u = (X0 + i * STEP - startX) / span
          if (u < 1) env[i] = Math.max(env[i], flankH * Math.pow(1 - u, 1.7))
        }
      }
      // craggy: noise at the size of a rock and at the size of a ridge, growing with the height above the ground
      for (let i = 0; i < N; i++) {
        const x = X0 + i * STEP
        const above = env[i] - ridge[i]
        if (above > 1) env[i] += (vnoise(x * 0.19 + b * 3.3, b + 0.5) - 0.5) * Math.min(above * 0.16, 7 * S) + (vnoise(x * 0.06 + b * 9, 2.2) - 0.5) * above * 0.1
        if (env[i] < ridge[i]) env[i] = ridge[i]
        if (i < from) env[i] = 0
      }
      return { b, def, env, from }
    })

    // The live cones: a few of the far bands' own summits, spread across the bands and across the width, picked where the
    // skyline really shows them (clear of the nearer bands, Deathfire and the title, and never the highest summit of the
    // nearest far band). A notch is cut into each summit for the crater.
    const lives = []
    {
      const lr = mulberry32((seed ^ 0x11f3) >>> 0)
      const farBands = bands.filter((bd) => !bd.def.near)
      const want = phone ? [1, 2] : [2, 2, 2]
      farBands.forEach((bd, fi) => {
        const nearer = bands.slice(bd.b + 1)
        const summits = []
        for (let i = 10; i < N - 10; i++) {
          const e = bd.env[i]
          if (e < 0.06 * h) continue
          let top = true
          for (let k = -10; k <= 10 && top; k++) if (bd.env[i + k] > e) top = false
          if (top) summits.push({ i, e, x: X0 + i * STEP })
        }
        let big = null
        if (fi === farBands.length - 1) for (const p of summits) if (!big || p.e > big.e) big = p
        const shows = (p) => {
          if (p === big || p.x < w * 0.08 || p.x > w - 14) return false
          if (!phone && Math.hypot((p.x - w * 0.54) / (w * 0.37), (shoreY - p.e - h * 0.45) / (h * 0.21)) < 1) return false // no light behind the title
          if (p.x > flankX(left, shoreY - p.e) - 18 * S && p.x < flankX(right, shoreY - p.e) + 18 * S) return false // behind the mountain
          for (const nb of nearer) for (let i = p.i - 3; i <= p.i + 3; i++) if (nb.env[i] > p.e - 6 * S) return false
          return true
        }
        const order = summits.filter(shows).map((p) => ({ p, k: lr() })).sort((a, z) => a.k - z.k)
        let n = 0
        for (const { p } of order) {
          if (n >= (want[fi] ?? 1)) break
          if (lives.some((v) => Math.abs(v.x - p.x) < w * 0.07)) continue
          const tw = 3.5 * S
          const notch = Math.max(2.5 * S, 0.08 * p.e)
          for (let i = Math.ceil((p.x - tw - X0) / STEP); i <= Math.floor((p.x + tw - X0) / STEP); i++) bd.env[i] -= notch * (1 - Math.abs(X0 + i * STEP - p.x) / tw)
          lives.push({ b: bd.b, x: p.x, y: shoreY - (p.e - notch * 0.8), r: lerp(6, 9, lr()) * S, ph: lr() * TAU, len: h * (0.036 + 0.024 * lr()), lean: 0.45 + 0.3 * lr(), sway: lr() - 0.3 })
          n++
        }
      })
    }
    // the silhouettes, now the notches are cut
    for (const bd of bands) {
      bd.top = 0
      for (let i = 0; i < N; i++) bd.top = Math.max(bd.top, bd.env[i])
      bd.path = new Path2D()
      bd.path.moveTo(X0 + bd.from * STEP, h + 10)
      for (let i = bd.from; i < N; i++) bd.path.lineTo(X0 + i * STEP, shoreY - bd.env[i])
      bd.path.lineTo(X0 + (N - 1) * STEP, h + 10)
      bd.path.closePath()
    }

    /** A wisp of smoke from a crater: soft grey-brown puffs, a little lighter than the sky, rising straight at first and then
        bent right by the main plume's wind, widening and thinning as they climb. Not lit: no warm colour. */
    const smoke = (g, v) => {
      const M = 9
      for (let k = 0; k < M; k++) {
        const u = (k + 0.5) / M
        const x = v.x + v.len * v.lean * Math.pow(u, 1.9) + v.len * 0.05 * v.sway * Math.sin(u * 4)
        const y = v.y - 2 * S - v.len * u
        const r = (2 + 6 * u) * S
        const a = 0.5 * Math.pow(1 - u, 1) + 0.04
        const puff = g.createRadialGradient(x, y, 0, x, y, r)
        puff.addColorStop(0, `rgba(60,48,42,${a.toFixed(3)})`)
        puff.addColorStop(0.55, `rgba(60,48,42,${(a * 0.55).toFixed(3)})`)
        puff.addColorStop(1, 'rgba(60,48,42,0)')
        g.fillStyle = puff
        g.fillRect(x - r, y - r, r * 2, r * 2)
      }
    }
    /** Warm haze rising from a band's foot: a base wash and some thicker banks, so it does not read as a stripe. */
    const haze = (g, def, b) => {
      const a = Math.min(0.8, def.haze * hazeK)
      if (a < 0.01) return
      const hr = mulberry32((seed ^ 0xc0ffee) + b * 977)
      const footY = shoreY - def.foot * h
      const hh = h * 0.17
      const wash = g.createLinearGradient(0, footY - hh, 0, footY + 0.02 * h)
      wash.addColorStop(0, 'rgba(120,70,28,0)')
      wash.addColorStop(0.55, `rgba(150,86,34,${(a * 0.4).toFixed(3)})`)
      wash.addColorStop(1, `rgba(176,110,44,${(a * 0.6).toFixed(3)})`)
      g.fillStyle = wash
      g.fillRect(-10, footY - hh, w + 20, h + 10 - (footY - hh))
      for (let i = 0; i < 6; i++) {
        const rx = w * (0.12 + 0.14 * hr())
        const ry = hh * (0.45 + 0.5 * hr())
        g.save()
        g.translate(hr() * w, footY - hh * 0.1)
        g.scale(1, ry / rx)
        const bank = g.createRadialGradient(0, 0, 0, 0, 0, rx)
        bank.addColorStop(0, `rgba(190,118,46,${(a * 0.4).toFixed(3)})`)
        bank.addColorStop(1, 'rgba(190,118,46,0)')
        g.fillStyle = bank
        g.fillRect(-rx, -rx, rx * 2, rx * 2)
        g.restore()
      }
    }

    /** The far bands, far to near, each with the haze that lies in front of it, on the sky layer. */
    const paintBands = (g) => {
      const behind = new Path2D() // every band so far: the haze in front of a band lies on them and not on the empty sky
      for (const bd of bands) {
        const def = bd.def
        if (def.near) continue
        const footY = shoreY - def.foot * h
        const body = g.createLinearGradient(0, Math.min(shoreY - bd.top - 4, footY - 24), 0, footY)
        body.addColorStop(0, `rgb(${def.top})`)
        body.addColorStop(1, `rgb(${def.bot})`)
        g.fillStyle = body
        g.fill(bd.path)
        if (!phone) {
          // behind the title the peaks go near-black, however tall the tuner has made them
          g.save()
          g.clip(bd.path)
          g.translate(w * 0.54, h * 0.45)
          g.scale(1, (h * 0.21) / (w * 0.37))
          const veil = g.createRadialGradient(0, 0, 0, 0, 0, w * 0.37)
          veil.addColorStop(0, 'rgba(6,9,9,0.94)')
          veil.addColorStop(0.7, 'rgba(6,9,9,0.9)')
          veil.addColorStop(1, 'rgba(6,9,9,0)')
          g.fillStyle = veil
          g.fillRect(-w * 0.37, -w * 0.37, w * 0.74, w * 0.74)
          g.restore()
        }
        behind.addPath(bd.path)
        g.save()
        g.clip(behind)
        haze(g, def, bd.b)
        g.restore()
      }
      // the live cones last, so no haze dims them (quiet: none, only the notch in the summit stays)
      if (!quietFar) {
        for (const v of lives) {
          smoke(g, v)
          g.save()
          g.globalCompositeOperation = 'lighter'
          const pin = g.createRadialGradient(v.x, v.y, 0, v.x, v.y, v.r)
          pin.addColorStop(0, 'rgba(255,196,120,0.95)')
          pin.addColorStop(0.18, 'rgba(255,120,50,0.6)')
          pin.addColorStop(0.5, 'rgba(210,60,26,0.2)')
          pin.addColorStop(1, 'rgba(180,40,18,0)')
          g.fillStyle = pin
          g.fillRect(v.x - v.r, v.y - v.r, v.r * 2, v.r * 2)
          g.restore()
        }
      }
    }

    /** The nearest band, joined to Deathfire's right shoulder: dark, with a warm face toward the volcano and a cool face away. */
    const paintNear = (g) => {
      burn()
      const bd = bands[bands.length - 1]
      if (!bd.def.near) return
      g.fillStyle = 'rgb(7,11,10)'
      g.fill(bd.path)
      const env = bd.env
      const found = []
      for (let i = bd.from + 10; i < N - 10; i++) {
        const e = env[i]
        if (e < h * 0.1) continue
        let crest = true
        for (let k = -10; k <= 10 && crest; k++) if (env[i + k] > e) crest = false
        const x = X0 + i * STEP
        if (crest && (phone || x < w * 0.24 || x > w * 0.86)) found.push({ i, e })
      }
      found.sort((p, q) => q.e - p.e)
      const fr = mulberry32((seed ^ 0x77a1) >>> 0)
      const chosen = []
      for (const p of found) if (chosen.length < (phone ? 2 : 3) && chosen.every((c) => Math.abs(c.i - p.i) * STEP > w * 0.1)) chosen.push(p)
      for (const { i: ia, e } of chosen) {
        const reach = Math.round(Math.max(14 * S, Math.min(90 * S, e * 0.7)) / STEP)
        const il = Math.max(bd.from, ia - reach)
        const ir = Math.min(N - 1, ia + reach)
        const ax = X0 + ia * STEP
        const ay = shoreY - env[ia]
        const baseY = shoreY - Math.min(env[il], env[ir]) + h * 0.05
        const zig = [{ x: ax, y: ay }]
        for (let k = 1; k <= 6; k++) zig.push({ x: ax + (k % 2 ? 1 : -1) * (4 + 10 * fr()) * (k / 6 + 0.3) + k * 3, y: ay + ((baseY - ay) * k) / 6 })
        const face = (to, colour) => {
          g.beginPath()
          const dir = ia < to ? 1 : -1
          for (let i = ia; i !== to + dir; i += dir) g.lineTo(X0 + i * STEP, shoreY - env[i])
          g.lineTo(X0 + to * STEP, baseY)
          for (let k = zig.length - 1; k >= 0; k--) g.lineTo(zig[k].x, zig[k].y)
          g.closePath()
          const grd = g.createLinearGradient(0, ay, 0, baseY)
          grd.addColorStop(0, colour)
          grd.addColorStop(1, 'rgba(7,11,10,0)')
          g.fillStyle = grd
          g.fill()
        }
        face(il, 'rgba(66,30,17,0.9)') // toward the volcano
        face(ir, 'rgba(24,38,33,0.95)') // away from it, under the moon
      }
    }
    return { lives: quietFar ? [] : lives, paintBands, paintNear } // (quiet: no lives left for the halo pass in `draw`)
  })()

  /** The shoulder peaks, laid over the mountain: each on a canvas of its own, so its inner side can melt into the flank. */
  const paintShoulders = (g, detail) => {
    const probeCv = document.createElement('canvas')
    probeCv.width = 3
    probeCv.height = 3
    const probe = probeCv.getContext('2d', { willReadFrequently: true })
    for (const s of shoulders) {
      const d = s.d
      const all = [...s.ridge, ...s.outer, s.inner]
      const x0 = Math.floor(Math.min(...all.map((p) => p.x)) - 4)
      const x1 = Math.ceil(Math.max(...all.map((p) => p.x)) + 4)
      const y0 = Math.floor(s.so.y - 4)
      const y1 = Math.ceil(Math.min(h, s.bottom))
      const bw = x1 - x0
      const bh = y1 - y0
      if (bw < 2 || bh < 2) continue
      const { cv, g: sg } = makeCanvas(bw, bh, dpr)
      sg.translate(-x0, -y0)
      const path = (pts) => {
        sg.beginPath()
        pts.forEach((p, i) => (i ? sg.lineTo(p.x, p.y) : sg.moveTo(p.x, p.y)))
      }
      const bodyPts = [...s.ridge, ...s.outer.slice(1), s.inner]
      path(bodyPts)
      sg.closePath()
      // The flank beside it, as painted: two samples just inside the flank's line (at the col, and lower down) give the
      // shoulder its colour, so it is as dark as the rock it stands on and no paler.
      const sample = (p, fallback) => {
        // (read through a 3 px canvas of its own, so the big layer is never read back and stays on the GPU)
        probe.clearRect(0, 0, 3, 3)
        probe.drawImage(g.canvas, Math.round((p.x - s.nx * 0.05 * H) * dpr) - 1, Math.round((p.y - s.ny * 0.05 * H) * dpr) - 1, 3, 3, 0, 0, 3, 3)
        const im = probe.getImageData(0, 0, 3, 3)
        if (!im || !im.data) return fallback
        const o = [0, 0, 0]
        for (let k = 0; k < 9; k++) for (let c = 0; c < 3; c++) o[c] += im.data[k * 4 + c] / 9
        return o
      }
      const low = s.base[Math.min(s.base.length - 1, s.ci + 12)]
      const c0 = sample(s.col, [14, 23, 20])
      const c1 = sample(low, [8, 14, 12])
      const lowAt = clamp01((low.y - s.so.y) / (h - s.so.y))
      const grd = sg.createLinearGradient(0, s.so.y, 0, h)
      grd.addColorStop(0, css(c0))
      grd.addColorStop(lowAt, css(c1))
      grd.addColorStop(1, css(c1.map((v) => v * 0.7)))
      sg.fillStyle = grd
      sg.fill()
      if (detail) {
        // the planes stay inside the body: only the rim below lies on its edge
        sg.save()
        path(bodyPts)
        sg.closePath()
        sg.clip()
        // the face away from the volcano, from the spine to the far side: a few points paler and cooler than the near
        // face, no more, and gone by half way down
        const lastP = s.outer[s.outer.length - 1]
        path([...s.outer, { x: s.spine[s.spine.length - 1].x, y: lastP.y }, ...s.spine.slice().reverse()])
        sg.closePath()
        const og = sg.createLinearGradient(0, s.so.y, 0, s.so.y + 0.55 * (h - s.so.y))
        const pale = [c0[0] * 1.1 + 0.5, c0[1] * 1.16 + 1.5, c0[2] * 1.16 + 1.5]
        og.addColorStop(0, css(pale, 1))
        og.addColorStop(1, css(pale, 0))
        sg.fillStyle = og
        sg.fill()
        // a little warm light on the near face where the lava is close enough to reach it
        const wm = lightAt(s.col.x, s.col.y, -d * 0.5, clamp01((s.col.y - rimY) / H)).warm
        if (wm > 0.03) {
          path(bodyPts)
          sg.closePath()
          const wg = sg.createLinearGradient(s.col.x, 0, s.so.x, 0)
          wg.addColorStop(0, `rgba(190,80,30,${(wm * 0.4).toFixed(3)})`)
          wg.addColorStop(0.7, 'rgba(190,80,30,0)')
          sg.fillStyle = wg
          sg.fill()
        }
        // a few broken gullies down the near face
        sg.strokeStyle = 'rgba(0,0,0,0.28)'
        sg.lineWidth = 1.2
        for (const [a, b] of s.gullies) {
          sg.beginPath()
          sg.moveTo(a.x, a.y)
          sg.lineTo(b.x, b.y)
          sg.stroke()
        }
        sg.restore()
        // a hairline of cool light down the far side and along the ridge
        sg.lineJoin = 'round'
        for (const [pts, colour] of [
          [s.outer.slice(0, 6), d > 0 ? 'rgba(150,190,176,0.16)' : 'rgba(150,190,176,0.07)'],
          [s.ridge.slice(-4), d > 0 ? 'rgba(150,190,176,0.08)' : 'rgba(150,190,176,0.14)'],
        ]) {
          path(pts)
          sg.strokeStyle = colour
          sg.lineWidth = 1
          sg.stroke()
        }
      }
      // melt into the flank: opaque out in the open, clear a little way inside the flank's own line
      sg.globalCompositeOperation = 'destination-in'
      const inset = 0.1 * H
      const ramp = 0.22 * H
      const mask = sg.createLinearGradient(s.col.x - s.nx * inset, s.col.y - s.ny * inset, s.col.x + s.nx * (ramp - inset), s.col.y + s.ny * (ramp - inset))
      mask.addColorStop(0, 'rgba(0,0,0,0)')
      mask.addColorStop(1, 'rgba(0,0,0,1)')
      sg.fillStyle = mask
      sg.fillRect(x0, y0, bw, bh)
      g.drawImage(cv, x0, y0, bw, bh)
    }
  }

  const paintMountain = (g) => {
    // silhouette
    const trace = () => {
      g.beginPath()
      g.moveTo(left[ROWS].x, h + 20)
      for (let i = left.outline.length - 1; i >= 0; i--) g.lineTo(left.outline[i].x, left.outline[i].y)
      for (const p of flip ? [...crownPts].reverse() : crownPts) g.lineTo(p.x, p.y)
      for (const p of right.outline) g.lineTo(p.x, p.y)
      g.lineTo(right[ROWS].x, h + 20)
      g.closePath()
    }
    trace()
    const body = g.createLinearGradient(0, rimY - ch * 2, 0, h)
    body.addColorStop(0, 'rgb(11,19,16)')
    body.addColorStop(1, 'rgb(4,8,7)')
    g.fillStyle = body
    g.fill()
    if (!L.relief) {
      paintShoulders(g, false)
      return
    }

    g.save()
    g.clip()
    // The relief does not stop at the rim: above it the planes carry on as strips (rows e < 0, up to CRH) and the
    // silhouette clips them, so the towers are cut from the same rock as the flanks and there is no line where they meet.
    const CR = 14
    const CRH = ch * 2.4
    const ue = (ln, e) => (e >= 0 ? ln.u[e] : ln.u[0] + (vnoise(ln.u[0] * 3.7 + (-e / CR) * 1.9, 6.3) - 0.5) * 0.05 * (-e / CR))
    const PE = (u, e) => {
      if (e >= 0) return P(u, e / ROWS)
      const s = -e / CR
      return { x: peakX + u * rw * (1 + 0.07 * s), y: rimY - s * CRH }
    }
    // planes between each crest and gully, lit by the river, the crater, the lake and the moon
    for (let j = 0; j < lines.length - 1; j++) {
      const A = lines[j]
      const B = lines[j + 1]
      const facing = A.crest ? 1 : -1
      const tint = 0.88 + R() * 0.24
      g.beginPath()
      for (let e = -CR; e <= ROWS; e++) {
        const p = PE(ue(A, e), e)
        if (e === -CR) g.moveTo(p.x, p.y)
        else g.lineTo(p.x, p.y)
      }
      for (let e = ROWS; e >= -CR; e--) {
        const p = PE(ue(B, e), e)
        g.lineTo(p.x, p.y)
      }
      g.closePath()
      const top = rimY - CRH
      const bot = P((A.u[ROWS] + B.u[ROWS]) / 2, 1).y
      const grd = g.createLinearGradient(0, top, 0, bot)
      const jj = (j + 1) >> 1
      const l0 = lean(jj, 0)
      for (let e = -CR; e <= ROWS; e += 2) {
        const f = Math.max(0, e) / ROWS
        const c = PE((ue(A, e) + ue(B, e)) / 2, e)
        // up the crown the lean eases from the flank's value to one that still reads in the dark
        const lc = e >= 0 ? lean(jj, f) : l0 + (0.2 + 0.5 * vnoise((-e / CR) * 2.1 + jj * 2.9, 3.1) - l0) * sm(-e / 4)
        grd.addColorStop(clamp01((c.y - top) / (bot - top)), css(rockColour(c.x, c.y, facing * lc, f, tint)))
      }
      g.fillStyle = grd
      g.fill()
      // rills: two broken lines down each plane, one dark and one faintly light
      for (const [k, style] of [[0.36, 'rgba(0,0,0,0.3)'], [0.7, 'rgba(255,214,170,0.045)']]) {
        g.beginPath()
        for (let i = 3; i <= ROWS; i++) {
          const p = P(lerp(A.u[i], B.u[i], k + (vnoise(i * 0.4, j * 5.1) - 0.5) * 0.3), i / ROWS)
          if (i === 3) g.moveTo(p.x, p.y)
          else g.lineTo(p.x, p.y)
        }
        g.setLineDash([rr(10, 34), rr(6, 22), rr(4, 16), rr(8, 26)])
        g.strokeStyle = style
        g.lineWidth = 1
        g.stroke()
      }
      g.setLineDash([])
    }
    // cliff bands: where the face breaks in a step, a line of shadow under the lip and a little caught light on it
    for (const fb of [0.34, 0.56]) {
      const shadow = []
      for (let k = 0; k <= 60; k++) {
        const u = -0.97 + (k / 60) * 1.94
        const f = fb + (vnoise(u * 3.4 + fb * 20, 3.3) - 0.5) * 0.09 + (vnoise(u * 11 + fb * 9, 7.1) - 0.5) * 0.025
        shadow.push({ ...P(u, f), gap: vnoise(u * 2.6 + fb * 31, 1.9) < 0.36 })
      }
      for (const [dy, style, lw] of [[2.5, 'rgba(0,0,0,0.34)', 3.2], [0, 'rgba(255,196,150,0.06)', 1]]) {
        g.beginPath()
        let pen = false
        for (const p of shadow) {
          if (p.gap || Math.abs(p.x - riverXAt(p.y)) < fall * 0.5) {
            pen = false
            continue
          }
          if (pen) g.lineTo(p.x, p.y + dy)
          else g.moveTo(p.x, p.y + dy)
          pen = true
        }
        g.strokeStyle = style
        g.lineWidth = lw
        g.stroke()
      }
    }
    // crest edges catch the light: a thin warm line where a crest faces the lava
    for (let j = 2; j < lines.length - 2; j += 2) {
      const C = lines[j]
      const top = rimY - CRH
      const bot = P(C.u[ROWS], 1).y
      const grd = g.createLinearGradient(0, top, 0, bot)
      for (let e = -CR; e <= ROWS; e += 2) {
        const f = Math.max(0, e) / ROWS
        const c = PE(ue(C, e), e)
        const d = c.x - riverXAt(c.y)
        const { warm } = lightAt(c.x, c.y, d > 0 ? -1 : 1, f)
        const edge = warm * 0.5 * (1 - 0.6 * sm((f - 0.72) / 0.25)) * (0.2 + 0.8 * lean(j >> 1, f))
        grd.addColorStop(clamp01((c.y - top) / (bot - top)), `rgba(255,170,96,${edge.toFixed(3)})`)
      }
      g.beginPath()
      for (let e = -CR; e <= ROWS; e++) {
        const p = PE(ue(C, e), e)
        if (e === -CR) g.moveTo(p.x, p.y)
        else g.lineTo(p.x, p.y)
      }
      g.strokeStyle = grd
      g.lineWidth = 1.1
      g.stroke()
    }
    // Mass reads from darkness: out on the broad flanks, away from the crater and the river, the rock goes toward black
    // and only the edge (the moon's rim, below) and a few planes keep a hint of light.
    for (const [dir, alpha] of [[1, 0.36], [-1, 0.3]]) {
      const dk = g.createLinearGradient(peakX + dir * rw * 2.4, 0, peakX + dir * halfBase * 0.95, 0)
      dk.addColorStop(0, 'rgba(3,6,6,0)')
      dk.addColorStop(1, `rgba(3,6,6,${alpha})`)
      g.fillStyle = dk
      g.fillRect(0, rimY - ch * 3, w, h)
    }
    g.restore()

    // the crown: the faces the breach lights and the faces the moon finds, laid over the relief. Each fades out below
    // the rim (clipped to the mountain, so the fade runs on down the flank) instead of ending in a flat edge there.
    g.save()
    trace()
    g.clip()
    const face = (pts, stops) => {
      g.beginPath()
      pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)))
      g.closePath()
      const y0 = stops[0][0]
      const y1 = stops[stops.length - 1][0]
      const grd = g.createLinearGradient(0, y0, 0, y1)
      for (const [at, c] of stops) grd.addColorStop(clamp01((at - y0) / (y1 - y0)), c)
      g.fillStyle = grd
      g.fill()
    }
    const cp = crownPts
    const spine = [cp[18], cpt(0.3, -1.7), cpt(0.38, -1.2), cpt(0.3, -0.6), cpt(0.34, 0.2)]
    // the tower's inner face, toward the breach: lit from below, dark by the top
    face([...cp.slice(11, 19), ...spine.slice(1), cpt(0.2, 0.42), cpt(-0.02, 0.36)], [
      [rimY - ch * 1.9, 'rgba(30,12,8,0.1)'],
      [rimY + ch * 0.1, 'rgba(200,88,32,0.78)'],
      [rimY + ch * 0.45, 'rgba(200,88,32,0)'],
    ])
    // its outer face, under the moon
    face([...cp.slice(18, 29), cpt(1.04, 0.4), cpt(0.34, 0.4), ...spine.slice(1).reverse()], [
      [rimY - ch * 2.2, flip ? 'rgba(20,31,27,0.5)' : 'rgba(34,52,45,0.6)'],
      [rimY, 'rgba(12,20,17,0.14)'],
      [rimY + ch * 0.4, 'rgba(12,20,17,0)'],
    ])
    // the stub's inner face, toward the breach
    face([cp[5], cp[6], cp[7], cp[8], cp[9], cpt(-0.5, 0.3), cpt(-0.74, -0.55)], [
      [rimY - ch, 'rgba(50,20,11,0.2)'],
      [rimY, 'rgba(186,80,30,0.8)'],
      [rimY + ch * 0.3, 'rgba(186,80,30,0)'],
    ])
    g.restore()
    // the facets where the walls break: a thin line of caught light on each
    g.lineWidth = 1
    for (const [a, b, colour] of [[12, 13, 'rgba(255,170,96,0.5)'], [14, 15, 'rgba(255,170,96,0.28)'], [21, 22, 'rgba(120,160,144,0.3)'], [23, 24, 'rgba(120,160,144,0.24)'], [25, 26, 'rgba(120,160,144,0.18)']]) {
      g.beginPath()
      g.moveTo(cp[a].x, cp[a].y)
      g.lineTo(cp[b].x, cp[b].y)
      g.strokeStyle = colour
      g.stroke()
    }
    // the moon's rim: a thin cool line down each outline, where the flank turns to face the sky. Brighter on the right
    // (the moon's side) and near the top, gone by the foot.
    for (const [side, a] of [[right, 0.34], [left, 0.12]]) {
      const rg = g.createLinearGradient(0, rimY - ch, 0, h)
      rg.addColorStop(0, `rgba(150,190,176,${a})`)
      rg.addColorStop(0.5, `rgba(150,190,176,${a * 0.4})`)
      rg.addColorStop(1, 'rgba(150,190,176,0.02)')
      g.beginPath()
      side.outline.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)))
      g.strokeStyle = rg
      g.lineWidth = 1.3
      g.stroke()
    }
    paintShoulders(g, true)
  }

  const paintGround = (g) => {
    g.beginPath()
    g.moveTo(-10, h + 10)
    for (let x = -10; x <= w + 10; x += 14) g.lineTo(x, shoreY - 2 + (vnoise(x * 0.012, 6.6) - 0.5) * 9)
    g.lineTo(w + 10, h + 10)
    g.closePath()
    const grd = g.createLinearGradient(0, shoreY - 6, 0, h)
    grd.addColorStop(0, 'rgb(12,10,9)')
    grd.addColorStop(1, 'rgb(4,6,6)')
    g.fillStyle = grd
    g.fill()
  }

  const paintFore = (g) => {
    const ctrl = phone
      ? [{ x: w * 0.56, y: h + 6 }, { x: w * 0.8, y: h - h * 0.045 }, { x: w + 10, y: h - h * 0.07 }]
      : [{ x: w * 0.47, y: h + 6 }, { x: w * 0.6, y: h - h * 0.07 }, { x: w * 0.73, y: h - h * 0.105 }, { x: w * 0.88, y: h - h * 0.17 }, { x: w + 10, y: h - h * 0.14 }]
    const { pts } = jagged(ctrl, 0.07, 4)
    g.beginPath()
    g.moveTo(pts[0].x, h + 10)
    for (const p of pts) g.lineTo(p.x, p.y)
    g.lineTo(w + 10, h + 10)
    g.closePath()
    g.fillStyle = 'rgb(3,5,5)'
    g.fill()
    // its edge toward the lake catches the glow
    const grd = g.createLinearGradient(pts[0].x, 0, pts[0].x + w * 0.22, 0)
    grd.addColorStop(0, 'rgba(255,128,60,0.2)')
    grd.addColorStop(1, 'rgba(255,128,60,0)')
    g.beginPath()
    pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)))
    g.strokeStyle = grd
    g.lineWidth = 1.2
    g.stroke()
  }

  paintSky()
  if (L.ridges) {
    far.paintBands(sky.g)
    far.paintNear(land.g)
  }
  paintMountain(land.g)
  paintGround(land.g)
  paintFore(fore.g)

  // N'bel's monolith, the memorial Vulkan raised for his foster father: one plain basalt stone on the shore, right of the
  // river's mouth, and the only thing in the frame whose size is known. About 2.2% of the screen tall, slim, a touch
  // tapered, its top sheared flat. Dark, lit warm from the lake side. Drawn on the foreground layer, over the lake's glow.
  const mono = (() => {
    const mh = Math.max(10, h * 0.022)
    const mw = Math.max(3.4, mh * 0.3)
    const x = river.mouth.x + lake.rx * 0.2
    const y = lakeTopAt(x) - 4 // on the basin's rim, a few px back from the water
    return { x, y, h: mh, w: mw }
  })()
  if (L.monolith) {
    const g = fore.g
    const { x, y, h: mh, w: mw } = mono
    g.beginPath()
    g.moveTo(x - mw * 0.5, y)
    g.lineTo(x - mw * 0.3, y - mh)
    g.lineTo(x + mw * 0.34, y - mh * 0.93)
    g.lineTo(x + mw * 0.5, y)
    g.closePath()
    const stone = g.createLinearGradient(0, y - mh, 0, y)
    stone.addColorStop(0, 'rgb(5,7,7)')
    stone.addColorStop(0.55, 'rgb(8,8,8)')
    stone.addColorStop(1, 'rgb(74,28,13)')
    g.fillStyle = stone
    g.fill()
    // the lake side: the foot and the edge toward the river catch the glow
    const rim = g.createLinearGradient(0, y - mh, 0, y)
    rim.addColorStop(0, 'rgba(255,140,70,0)')
    rim.addColorStop(0.35, 'rgba(255,140,70,0.1)')
    rim.addColorStop(1, 'rgba(255,150,80,0.55)')
    g.beginPath()
    g.moveTo(x - mw * 0.3, y - mh)
    g.lineTo(x - mw * 0.5, y)
    g.strokeStyle = rim
    g.lineWidth = 1
    g.stroke()
  }

  // ---------------------------------------------------------------- Prometheus (the approved lit sphere from feat/volcano-polish)
  const moon = (() => {
    const r = Math.max(20, Math.min(w * 0.11, h * 0.14))
    const size = Math.ceil(r * 2)
    const { cv, g } = makeCanvas(size, size)
    const img = g.createImageData(size, size)
    const mr = mulberry32(0x10ba)
    const pats = []
    for (let i = 0; i < 5; i++) {
      const a = mr() * TAU
      const d = Math.sqrt(mr()) * 0.78
      pats.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, s: i < 2 ? 0.13 + mr() * 0.06 : 0.03 + mr() * 0.06, seed: mr() * 40, hot: i < 2 })
    }
    let [lx, ly, lz] = [-0.55, 0.72, 0.4]
    const ll = Math.hypot(lx, ly, lz)
    lx /= ll
    ly /= ll
    lz /= ll
    const skyc = [14, 9, 8]
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const nx = (i + 0.5 - r) / r
        const ny = (j + 0.5 - r) / r
        const d2 = nx * nx + ny * ny
        if (d2 >= 1) continue
        const o4 = (j * size + i) * 4
        const nz = Math.sqrt(1 - d2)
        const sx = nx / (nz + 0.35)
        const sy = ny / (nz + 0.35)
        const region = vnoise(sx * 1.4 + 40, sy * 1.4 + 40)
        const band = vnoise(sx * 0.7 + 3.1 + region, sy * 2.6 + 7.7)
        const mott = vnoise(sx * 3 + 11, sy * 3 + 5) * 0.65 + vnoise(sx * 7 + 2, sy * 7 + 9) * 0.35
        const frost = vnoise(sx * 5 + 21, sy * 5 + 17)
        const tone = 0.55 + 0.45 * region
        let Rr = (140 + 80 * band - 30 * (1 - mott)) * tone + 20
        let G = (90 + 78 * band - 34 * (1 - mott)) * tone + 10
        let B = (30 + 28 * band - 14 * (1 - mott)) * tone + 6
        if (frost > 0.66) {
          const f = ((frost - 0.66) / 0.34) * 0.75 * tone
          Rr += (226 - Rr) * f
          G += (214 - G) * f
          B += (180 - B) * f
        }
        for (const p of pats) {
          const dx = nx - p.x
          const dy = ny - p.y
          const dd = Math.sqrt(dx * dx + dy * dy)
          if (dd > p.s * 2.6) continue
          const ang = Math.atan2(dy, dx)
          const edge = p.s * (0.7 + 0.5 * vnoise(Math.cos(ang) * 1.3 + p.seed, Math.sin(ang) * 1.3 + p.seed))
          if (p.hot) {
            const stain = sm((p.s * 2.6 - dd) / (p.s * 1.8)) * 0.4
            Rr += (160 - Rr) * stain
            G += (52 - G) * stain
            B += (28 - B) * stain
          }
          const k = sm((edge - dd) / (p.s * 0.45)) * 0.75
          if (k > 0) {
            Rr += (40 - Rr) * k
            G += (22 - G) * k
            B += (14 - B) * k
          }
          if (p.hot) {
            const hk = sm((p.s * 0.2 - dd) / (p.s * 0.12)) * 0.8
            Rr += (240 - Rr) * hk
            G += (110 - G) * hk
            B += (30 - B) * hk
          }
        }
        const ndl = nx * lx + ny * ly + nz * lz
        const lit = clamp01((ndl + 0.18) / 1.18)
        const lum = 0.05 + 0.95 * lit * lit
        const rim = Math.pow(1 - nz, 3) * Math.max(0, ndl) * 0.55
        img.data[o4] = skyc[0] + (Rr - skyc[0]) * lum + 255 * rim
        img.data[o4 + 1] = skyc[1] + (G - skyc[1]) * lum + 140 * rim
        img.data[o4 + 2] = skyc[2] + (B - skyc[2]) * lum + 70 * rim
        img.data[o4 + 3] = 255 * sm((1 - Math.sqrt(d2)) / 0.025)
      }
    }
    g.putImageData(img, 0, 0)
    return { cv, r }
  })()

  // ---------------------------------------------------------------- the lake's surface
  // A basin of dark basalt crust: plates, each a slightly different grey, with the heat showing only in the seams between
  // them, and an open pool of liquid lava where the river pours in (the Halemaumau frame: hot at the inlet, dull red
  // hairlines far from it, big old plates out toward the near shore). The plates are a diagram of jittered cells laid on
  // the lake as a plane seen at a low angle, so they foreshorten with distance (wide and flat far off, larger and rounder
  // near) and no seam runs toward a point. Where each pixel sits on that plane never changes, so it is worked out once.
  // A repaint finds each pixel's two nearest sites (the drift only slides the plane under them), turns the distance to
  // the seam into a smooth hairline, and maps heat to colour. It runs about eight times a second.
  const SITES = 64
  const siteR = mulberry32(seed ^ 0x1ac3)
  const SJX = new Float32Array(SITES * SITES)
  const SJY = new Float32Array(SITES * SITES)
  const SW = new Float32Array(SITES * SITES)
  const ST = new Float32Array(SITES * SITES)
  const SR = new Float32Array(SITES * SITES)
  for (let i = 0; i < SITES * SITES; i++) {
    SJX[i] = 0.1 + 0.8 * siteR()
    SJY[i] = 0.1 + 0.8 * siteR()
    SW[i] = 0.35 * siteR() // a weight, so some plates are big and some small
    ST[i] = siteR() // the plate's tone
    SR[i] = siteR() // the seam's rank: far from the inlet only some seams show, so old plates read as big ones
  }
  const PLATE = new Float32Array(3) // the last lookup: px to the seam, the plate's tone, the seam's rank
  /**
   * The two nearest plate sites at (u, v) in plate units. iw2 and ih2 are the squared px-per-unit the plane has across
   * and down here, so the distance to the seam comes out in screen px along the seam's own normal, and a seam is the
   * same hairline whichever way it runs.
   */
  const crustAt = (u, v, iw2, ih2) => {
    const ui = Math.floor(u)
    const vi = Math.floor(v)
    let d1 = 99
    let d2 = 99
    let i1 = 0
    let i2 = 0
    let x1 = 0
    let y1 = 0
    let x2 = 0
    let y2 = 0
    for (let j = -1; j <= 1; j++) {
      const cy = vi + j
      const row = (cy & 63) << 6
      const oy = cy - v
      for (let i = -1; i <= 1; i++) {
        const cx = ui + i
        const ci = row | (cx & 63)
        const dx = cx + SJX[ci] - u
        const dy = oy + SJY[ci]
        const d = dx * dx + dy * dy - SW[ci]
        if (d < d1) {
          d2 = d1
          i2 = i1
          x2 = x1
          y2 = y1
          d1 = d
          i1 = ci
          x1 = dx
          y1 = dy
        } else if (d < d2) {
          d2 = d
          i2 = ci
          x2 = dx
          y2 = dy
        }
      }
    }
    const lx = x1 - x2
    const ly = y1 - y2
    PLATE[0] = (d2 - d1) / (2 * Math.sqrt(lx * lx * iw2 + ly * ly * ih2) + 1e-6)
    PLATE[1] = ST[i1]
    const r = SR[i1] + SR[i2]
    PLATE[2] = r >= 1 ? r - 1 : r
  }
  const PLATE_B = 2.2 // the fresh small plates by the inlet: the same plane, 2.2 times finer
  const DRIFT = 0.03 // plate units a second, toward the viewer (about a px a second on the near shore)
  const lakeBox = (() => {
    const S = phone ? 0.75 : 1
    const RIMW = 13
    const x0 = Math.max(0, Math.floor(lake.cx - lake.rx * 1.06 - RIMW))
    const x1 = Math.min(w, Math.ceil(lake.cx + lake.rx * 1.06 + RIMW))
    const y0 = Math.floor(h - lake.vis - RIMW - 4)
    const lw = Math.max(2, Math.ceil((x1 - x0) * S))
    const lh = Math.max(2, Math.ceil((h - y0) * S))
    const surf = makeCanvas(lw, lh)
    const img = surf.g.createImageData(lw, lh)
    const data = img.data
    // heat to colour, in the river's own palette (and its lavaHeat): a lookup in eighths of a palette step
    const lut = new Float32Array(3 * 320)
    for (let i = 0; i < 320; i++) heatColour((i / 8) * lavaHeatK, lut, i * 3)
    // the plane: the lake seen from low down. q is how far a screen row sits below the horizon the plane runs off to;
    // plates are Wc wide and Hc tall there, in px, and shrink with distance (Hc as the square, as a plane does).
    const topY = h - lake.vis
    const yh = topY - 1.3 * lake.vis
    const qn = h - yh
    const Wn = Math.max(44, Math.min(84, w * 0.052))
    const Hn = Wn * 0.42
    // the stream: where the river ends. Heat falls away from it, mostly sideways, and more slowly toward the viewer
    const ix = river.inlet.x
    const iy = river.inlet.y
    const Rh = Math.max(lake.rx * 0.2, 36)
    const poolRx = Math.max(river.hw[river.N] * 2, lake.rx * 0.11)
    const poolRy = poolRx * 0.42
    const pcy = iy + poolRy * 0.25
    // where the river crosses the shore: the rim glows brightest there
    const mx0 = river.mouth.x
    const my0 = river.mouth.y
    const mk = () => ({ n: 0, off: [], ua: [], va: [], iw: [], ih: [], hn: [], phi: [], gr: [], p1c: [], p1s: [], p2c: [], p2s: [], cool: [], shore: [] })
    const grpNear = mk()
    const grpFar = mk()
    const edge = { off: [], r: [], g: [], b: [] } // the lit lip on the water's own edge
    for (let j = 0; j < lh; j++) {
      const sy = y0 + (j + 0.5) / S
      const q = sy - yh
      const m = q / qn
      const Wc = Wn * m
      const Hc = Hn * m * m
      const vv = ((qn * qn) / Hn) * (1 / qn - 1 / q)
      const dys = (sy - iy) / (Rh * 0.42)
      for (let i = 0; i < lw; i++) {
        const sx = x0 + (i + 0.5) / S
        const ex = (sx - lake.cx) / lake.rx
        const ey = (sy - lake.cy) / lake.ry
        const rho = Math.hypot(ex, ey) || 1e-6
        const rim = shoreAt(Math.atan2(ey, ex))
        // px to the shore: negative inside the water
        const dpx = (rho / rim - 1) / (Math.hypot(ex / lake.rx, ey / lake.ry) / (rho * rim))
        if (dpx > RIMW) continue
        const o4 = (j * lw + i) * 4
        const dxs = (sx - ix) / Rh
        const rr2 = dxs * dxs + dys * dys
        const hn = 0.95 * Math.exp(-rr2) + 0.17 * Math.exp(-0.1 * rr2)
        // the lit lip: brightest where the river crosses the shore, a thin line along the rock's inner edge
        const dm = Math.exp(-(((sx - mx0) / (Rh * 0.95)) ** 2) - ((sy - my0) / (Rh * 1.3)) ** 2)
        const lipHeat = 0.05 + 0.95 * dm * dm
        const lp = Math.exp(-(((dpx - 0.9) / 1.3) ** 2))
        const la = Math.min(1, lp * (0.3 + 0.7 * lipHeat) * (0.55 + 0.45 * vnoise(sx * 0.08 + 4, sy * 0.1 + 6)))
        const li = Math.min(319, ((3.5 + 17 * lipHeat) * 8) | 0) * 3
        if (dpx >= 0.5) {
          // the rim: dark rock a few px deep, ragged, with the lava's light on it near the inlet. It never changes, so it
          // goes straight into the image once.
          const rw = 8 + 4 * vnoise(sx * 0.045 + 9, sy * 0.09 + 2)
          const ra = 1 - sm((dpx - rw * 0.5) / (rw * 0.55))
          const gb = hash2(i * 5 + 3, j * 11 + 7) - 0.5
          const base = 9 + 6 * gb + 4 * vnoise(sx * 0.2, sy * 0.4)
          const wash = Math.min(1, hn) * (1 - sm(dpx / rw))
          const wp = Math.exp(-(((dpx - 1.6) / 4.5) ** 2)) * 0.2 * lipHeat * lipHeat
          const lq = Math.min(1, la + wp)
          data[o4] = base * 1.1 + 30 * wash + lut[li] * lq
          data[o4 + 1] = base + 8 * wash + lut[li + 1] * lq
          data[o4 + 2] = base * 0.95 + 2 * wash + lut[li + 2] * lq
          data[o4 + 3] = 255 * Math.max(ra, lq)
          continue
        }
        data[o4 + 3] = 255 // (opaque to the very edge: a half-clear edge dimmed the lip on every other pixel and it read as beads)
        if (dpx > -1.5) {
          edge.off.push(o4)
          edge.r.push(lut[li] * la)
          edge.g.push(lut[li + 1] * la)
          edge.b.push(lut[li + 2] * la)
        }
        // the pool: the stream's own ellipse, ragged by angle, joined to a lane as wide as the channel so the river's
        // last stretch lies on open lava from the shore on
        const pdx = (sx - ix) / poolRx
        const pdy = (sy - pcy) / poolRy
        const pa = Math.atan2(pdy, pdx)
        const pr =
          1 + 0.3 * (vnoise(Math.cos(pa) * 1.7 + 11, Math.sin(pa) * 1.7 + 4) - 0.5) * 2 + 0.1 * (vnoise(Math.cos(pa) * 5 + 2, Math.sin(pa) * 5 + 9) - 0.5) * 2
        let phi = 1 - Math.hypot(pdx, pdy) / pr
        if (sy < iy + 14) {
          const wl = 1.5 * riverHwAt(sy) + 6
          const lat = Math.abs(sx - riverXAt(sy))
          const lane = lat < wl * 0.6 ? 0.95 : 0.95 * clamp01((wl * 1.15 - lat) / (wl * 0.55))
          const lg = lane * (1 - sm((sy - iy) / 14))
          if (lg > phi) phi = lg
        }
        const farK = clamp01(1 - (sy - topY) / lake.vis)
        const side = 0.35 + 0.65 * clamp01((sx - (lake.cx - lake.rx)) / (2 * lake.rx))
        const grp = hn > 0.26 || phi > -0.2 || dpx > -1.5 ? grpNear : grpFar
        grp.n++
        grp.off.push(o4)
        // a slow warp laid on the plane, so the seams bend and wander and the cells do not read as a honeycomb
        const wu = 0.15 * (vnoise(sx / 120 + 31, sy / 34 + 7) - 0.5) * 2 + 0.06 * (vnoise(sx / 34 + 3, sy / 9 + 19) - 0.5) * 2
        const wvv = 0.15 * (vnoise(sx / 120 + 8, sy / 34 + 41) - 0.5) * 2 + 0.06 * (vnoise(sx / 34 + 27, sy / 9 + 5) - 0.5) * 2
        grp.ua.push((sx - lake.cx) / Wc + wu)
        grp.va.push(vv + wvv)
        grp.iw.push(1 / (Wc * Wc))
        grp.ih.push(1 / (Hc * Hc))
        grp.hn.push(hn)
        grp.phi.push(phi)
        grp.gr.push(hash2(i * 3 + 11, j * 7 + 5) * 2 - 1)
        const f1 = TAU * 1.6 * vnoise(sx * 0.012 + 3.1, sy * 0.034 + 1.7)
        const f2 = TAU * 1.4 * vnoise(sx * 0.07 + 7, sy * 0.14 + 2)
        grp.p1c.push(Math.cos(f1))
        grp.p1s.push(Math.sin(f1))
        grp.p2c.push(Math.cos(f2))
        grp.p2s.push(Math.sin(f2))
        grp.cool.push((0.25 + 0.75 * farK) * side * clamp01(1 - hn * 2))
        grp.shore.push(clamp01(-dpx / 7))
      }
    }
    const cat = (key, Type) => Type.from(grpNear[key].concat(grpFar[key]))
    return {
      x0, y0, S, lw, lh,
      cv: surf.cv,
      g: surf.g,
      img,
      lut,
      n: grpNear.n + grpFar.n,
      nNear: grpNear.n,
      OFF: cat('off', Int32Array),
      UA: cat('ua', Float32Array),
      VA: cat('va', Float32Array),
      IW2: cat('iw', Float32Array),
      IH2: cat('ih', Float32Array),
      HN: cat('hn', Float32Array),
      PHI: cat('phi', Float32Array),
      GR: cat('gr', Float32Array),
      P1C: cat('p1c', Float32Array),
      P1S: cat('p1s', Float32Array),
      P2C: cat('p2c', Float32Array),
      P2S: cat('p2s', Float32Array),
      COOL: cat('cool', Float32Array),
      SHORE: cat('shore', Float32Array),
      EOFF: Int32Array.from(edge.off),
      ER: Float32Array.from(edge.r),
      EG: Float32Array.from(edge.g),
      EB: Float32Array.from(edge.b),
      done: false,
      par: 0,
      t: 0,
      fl: 0,
    }
  })()
  /**
   * One pass over the water's pixels: all of those by the inlet (they have the most going on), and every other one of
   * the rest (`par` picks which half; the crust far out moves under a px a second, so the half that waits is never
   * more than a fraction of a px behind).
   */
  const lakePass = (t, flare, par) => {
    const B = lakeBox
    const data = B.img.data
    const lut = B.lut
    const { OFF, UA, VA, IW2, IH2, HN, PHI, GR, P1C, P1S, P2C, P2S, COOL, SHORE } = B
    const nNear = B.nNear
    const hk = 1 + 0.4 * flare // an eruption lights the whole lake
    const dv = t * DRIFT
    const s1 = Math.sin(t * 0.62)
    const c1 = Math.cos(t * 0.62)
    const s2 = Math.sin(t * 1.55)
    const c2 = Math.cos(t * 1.55)
    const nUpd = nNear + ((B.n - nNear - par + 1) >> 1)
    for (let q = 0; q < nUpd; q++) {
      const k = q < nNear ? q : nNear + par + ((q - nNear) << 1)
      const hn = HN[k] * hk
      const iw2 = IW2[k]
      const ih2 = IH2[k]
      const u = UA[k]
      const v = VA[k] - dv
      crustAt(u, v, iw2, ih2)
      const ep = PLATE[0]
      let tone = PLATE[1]
      const hs = hn * 2.2 > 1 ? 1 : hn * 2.2
      // a seam only shows if its rank is under a line that rises toward the inlet: far out, only some of the seams show,
      // and the old crust reads as big plates
      let wv = (0.16 + 0.84 * hs - PLATE[2]) * 6 + 0.5
      wv = wv < 0 ? 0 : wv > 1 ? 1 : wv
      // the seam: an antialiased line whose half-width is a little under a px far out and 2 px by the inlet, and a soft
      // glow bleeding onto the plate edges
      let core = 0
      let gl = 0
      if (wv > 0.004) {
        core = 0.92 + 1.4 * hn - ep
        core = core < 0 ? 0 : core > 1 ? 1 : core
        core *= wv * (0.4 + 0.6 * hs) // far out the seams only smoulder
        gl = 1 - ep / (2.4 + 5 * hn)
        gl = gl > 0 ? gl * gl * wv * (0.12 + 0.55 * hn) : 0
      }
      let lf = 0
      if (k < nNear) {
        // by the inlet the crust breaks into small fresh plates, and the pool's edge is eaten by them
        crustAt(u * PLATE_B + 17.3, v * PLATE_B + 29.1, iw2 * PLATE_B * PLATE_B, ih2 * PLATE_B * PLATE_B)
        const toneB = PLATE[1]
        let wb = (hn - 0.26) * 4
        wb = wb < 0 ? 0 : wb > 1 ? 1 : wb
        if (wb > 0) {
          const epB = PLATE[0]
          let wvB = (0.55 + 0.45 * (hn * 1.6 > 1 ? 1 : hn * 1.6) - PLATE[2]) * 6 + 0.5
          wvB = wvB < 0 ? 0 : wvB > 1 ? 1 : wvB
          wvB *= wb
          if (wvB > 0.004) {
            let coreB = 0.9 + 1.1 * hn - epB
            coreB = coreB < 0 ? 0 : coreB > 1 ? 1 : coreB
            coreB *= wvB
            let glB = 1 - epB / (2.4 + 5 * hn)
            glB = glB > 0 ? glB * glB * wvB * (0.12 + 0.55 * hn) : 0
            if (coreB > core) core = coreB
            if (glB > gl) gl = glB
          }
          tone += (toneB - tone) * wb
        }
        const phi = PHI[k]
        if (phi > -0.3) {
          lf = (phi - (0.06 + 0.42 * toneB)) * 14 + 0.5
          lf = lf < 0 ? 0 : lf > 1 ? 1 : lf
        }
      }
      const gr = GR[k]
      // the plate: basalt, each one a different grey, a touch lighter than the ground round the lake (a faint lit edge
      // where the seam's glow would catch it, and a slow mottle from the shimmer's phase); warm by the inlet, a cool
      // sheen far off on the moon's side, and dark where it meets the shore
      let bev = 1 - ep / 6
      bev = bev > 0 ? bev * bev * 4 * wv : 0
      let r = 19 + 13 * tone + gr * 2.4 + 1.8 * P2C[k] + bev
      let g = r * 0.965
      let b = r * 0.985
      const wm = hn > 1 ? 1 : hn
      const cw = COOL[k]
      r += 34 * wm - 3 * cw
      g += 9 * wm + 2.5 * cw
      b += 3 * wm + 9 * cw
      const dark = 0.55 + 0.45 * SHORE[k]
      r *= dark
      g *= dark
      b *= dark
      if (core > 0.004 || gl > 0.004) {
        // heat in the seam, on the fire's own scale: dull red far out, orange to gold toward the inlet; it breathes
        const T = (3.6 + 17 * hn) * (1 + 0.16 * (s1 * P1C[k] + c1 * P1S[k]))
        let li = (T * 8) | 0
        li = (li > 319 ? 319 : li) * 3
        const sr = lut[li]
        const sg = lut[li + 1]
        const sb = lut[li + 2]
        r += gl * sr * 0.5
        g += gl * sg * 0.5
        b += gl * sb * 0.5
        r += (sr - r) * core
        g += (sg - g) * core
        b += (sb - b) * core
      }
      if (lf > 0) {
        // open lava: the river's own heat where the stream comes in, cooling outward; it shimmers
        const hq = hn > 1.05 ? 1.05 : hn
        const To = 5.5 + 14 * hq * hq + 1.8 * (s2 * P2C[k] + c2 * P2S[k]) + 1 * gr + 3 * flare
        let lo = (To * 8) | 0
        lo = (lo > 319 ? 319 : lo < 0 ? 0 : lo) * 3
        r += (lut[lo] - r) * lf
        g += (lut[lo + 1] - g) * lf
        b += (lut[lo + 2] - b) * lf
      }
      const o4 = OFF[k]
      data[o4] = r
      data[o4 + 1] = g
      data[o4 + 2] = b
    }
  }
  const paintLake = (t, flare) => {
    const B = lakeBox
    // about three repaints a second: the crust drifts and breathes slowly (a px a second at most), and between repaints
    // the last image stands. A flare repaints at once.
    if (B.done && Math.abs(t - B.t) < 0.34 && Math.abs(flare - B.fl) < 0.12) return
    if (!B.done) lakePass(t, flare, 1) // the very first one fills everything
    lakePass(t, flare, B.par)
    B.par ^= 1
    B.done = true
    B.t = t
    B.fl = flare
    // the lit lip on the water's own edge (the rim's is in the image already)
    const data = B.img.data
    const lip = 0.75 + 0.25 * Math.min(1.5, 1 + 0.4 * flare)
    for (let e = 0; e < B.EOFF.length; e++) {
      const o4 = B.EOFF[e]
      data[o4] += B.ER[e] * lip
      data[o4 + 1] += B.EG[e] * lip
      data[o4 + 2] += B.EB[e] * lip
    }
    B.g.putImageData(B.img, 0, 0)
  }

  // ---------------------------------------------------------------- moving things
  const glow = makeGlow()
  // The plume's puffs, baked once: three lumpy shapes, each in two layers. The body is a grey-brown that sits just
  // above the sky; the warm layer is the same shape in forge orange, weighted to the underside, and is added on top
  // for the first third of the column, where the breach lights it from beneath.
  const puffs = (() => {
    const S = 128
    const make = (seed) => {
      const r = mulberry32(seed)
      // eight big blobs for the body and eight small ones out on the rim, so the edge is cauliflower and not a disc
      const blobs = Array.from({ length: 16 }, (_, i) => {
        const a = r() * TAU
        const d = i < 8 ? Math.sqrt(r()) * 0.16 : 0.2 + r() * 0.1
        return { x: 0.5 + Math.cos(a) * d, y: 0.5 + Math.sin(a) * d * 0.85, rad: i < 8 ? 0.2 + r() * 0.1 : 0.09 + r() * 0.05, a: 0.55 + r() * 0.45 }
      })
      const layer = (rgb, under) => {
        const { cv, g } = makeCanvas(S, S)
        for (const b of blobs) {
          const k = under ? clamp01(0.45 + (b.y - 0.5) * 3) : 1
          const grd = g.createRadialGradient(b.x * S, b.y * S, 0, b.x * S, b.y * S, b.rad * S)
          grd.addColorStop(0, `rgba(${rgb},${(b.a * k).toFixed(3)})`)
          grd.addColorStop(0.55, `rgba(${rgb},${(b.a * k * 0.8).toFixed(3)})`)
          grd.addColorStop(1, `rgba(${rgb},0)`)
          g.fillStyle = grd
          g.fillRect(0, 0, S, S)
        }
        return cv
      }
      return { body: layer('96,76,66', false), warm: layer('255,132,54', true) }
    }
    return [make(0x51), make(0x52), make(0x53)]
  })()
  const PLUME_N = phone ? 16 : 24
  // tuner `plume`: how strong (alpha) and how far (reach) the column is. 0 is no smoke, 1 is the plain look.
  const plumeK = Math.max(0, Math.min(2, tn.plume ?? 1))
  const plumeReach = phone ? Math.min(1, 0.7 + 0.3 * plumeK) : 0.7 + 0.3 * plumeK // a phone has text over the crown: no taller
  const plumeBuf = new Float32Array(PLUME_N * 4) // x, y, radius, how far up the column (0 to 1), per puff
  // Plates of crust: none near the breach (too hot to skin over), long along the flow, growing toward the lake.
  // (Mauna Loa frame: the rafts are small against the channel and the channel stays mostly bright.)
  const PLATE_FROM = 0.2
  const plates = Array.from({ length: phone ? 5 : 7 }, () => ({
    s: PLATE_FROM + (1 - PLATE_FROM) * Math.pow(Math.random(), 0.8),
    c: rand(-0.4, 0.4),
    len: rand(1.1, 2.7),
    wid: rand(0.22, 0.58),
    shape: Array.from({ length: 7 }, (_, i) => ({ a: (i / 7) * TAU + rand(-0.3, 0.3), r: rand(0.5, 1.15) })),
  }))
  // tuner `embers` scales the count; the cap keeps a frame's drawImage calls sane
  const emberCount = Math.min(phone ? 80 : 300, Math.round((phone ? 44 : 110) * Math.max(0, Math.min(3, tn.embers ?? 1))))
  const spawnEmber = (fresh) => {
    const roll = Math.random()
    let x
    let y
    if (roll < 0.55) {
      x = breach.x + rand(-0.2, 0.2) * ch
      y = breach.y - rand(0, 0.3) * ch
    } else if (roll < 0.85) {
      const fr = riverAt(Math.random())
      x = fr.x + rand(-1, 1) * fr.hw
      y = fr.y
    } else {
      x = river.inlet.x + rand(-0.4, 0.5) * lake.rx * 0.5
      y = river.inlet.y + rand(4, 26)
    }
    const big = Math.random() < 0.07
    const e = {
      x, y,
      vx: rand(0.02, 0.2),
      vy: big ? rand(0.25, 0.5) : rand(0.5, 1.5),
      size: big ? rand(14, 24) : rand(2.6, 7.5),
      age: 0,
      life: big ? rand(2, 5) : rand(2.5, 8),
      phase: rand(0, TAU),
      sway: rand(0.3, 1.3),
      alpha: big ? rand(0.16, 0.3) : rand(0.4, 0.9),
      green: !big && Math.random() < 0.05,
    }
    if (!fresh) {
      // already in the air when the page opens
      const pre = Math.random() * e.life
      e.age = pre
      e.y -= e.vy * pre * 60 * 0.7
      e.x += (e.vx + 0.25) * pre * 60 * 0.7
    }
    return e
  }
  const embers = Array.from({ length: emberCount }, () => spawnEmber(false))
  const ash = Array.from({ length: Math.round((phone ? 60 : 150) * ((w * h) / 1.6e6 + 0.3)) }, () => ({
    x: rand(-30, w + 30),
    y: rand(0, h),
    vy: rand(0.12, 0.6),
    drift: rand(0.02, 0.3),
    size: rand(1, 2.8),
    phase: rand(0, TAU),
    alpha: rand(0.08, 0.28),
  }))
  let sparks = []
  let spits = []
  let flare = 0
  // Where reading text sits behind a bright thing, the thing dims. `k` is the lowest `env.calm` over the thing (1 clear,
  // about 0.1 right under text) and `floor` the least light it keeps. The factors ease, so a drifting moon or a page
  // that is measured again never makes the light pop.
  const dimFor = (k, floor) => floor + (1 - floor) * clamp01((k - 0.1) / 0.9)
  const DIM_EASE = 0.4 // seconds for a dimmed thing to come most of the way (one time constant)
  let moonK = 1 // the moon's alpha factor
  let breachK = 1 // the breach's light factor: the glow, the crown walls' light and the plume's warm underside
  let dimPrimed = false // the first frame takes its target at once, so a new scene does not fade in from full light

  const erupt =(scale = 1) => {
    const n = Math.round(rand(10, 30) * scale)
    for (let i = 0; i < n; i++) {
      const speed = rand(2.2, 6.5)
      const angle = -Math.PI / 2 + rand(-0.45, 0.5)
      sparks.push({ x: breach.x + rand(-0.15, 0.15) * ch, y: breach.y, px: 0, py: 0, vx: Math.cos(angle) * speed + 0.4, vy: Math.sin(angle) * speed, size: rand(0.9, 2.2), age: 0, life: rand(0.7, 2.4), alpha: rand(0.75, 1) })
    }
    flare = 1
  }

  // ---------------------------------------------------------------- one frame
  function draw(ctx, t, dt, env = {}) {
    const secs = (dt * 16.7) / 1000
    const calm = env.calm || (() => 1)
    const phase = env.moonPhase ?? 0.42
    const breathe = 0.6 + Math.sin(t * 0.45) * 0.4
    const heat = 0.78 + 0.22 * breathe + flare * 0.5
    // how far a dimmed thing eases this frame; a frozen frame (dt 0) takes its target whole
    const dimStep = dimPrimed && dt > 0 ? 1 - Math.exp(-secs / DIM_EASE) : 1
    // the breach lights the sky and the crown right behind it: where text sits on it (the mountain on the left, under a
    // page header), that light steps back. The lowest of the breach and a point half a crater-width above it.
    breachK += (dimFor(Math.min(calm(breach.x, breach.y), calm(breach.x, breach.y - 0.5 * rw)), 0.25) - breachK) * dimStep
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    if (L.sky) ctx.drawImage(sky.cv, 0, 0, w, h)
    else {
      ctx.fillStyle = '#050a08'
      ctx.fillRect(0, 0, w, h)
    }

    // Prometheus, on the live site's own path across the sky
    if (L.moon) {
      const near = Math.sin(Math.PI * phase)
      const scale = 0.55 + 0.6 * near * near
      const mx = (-0.12 + 1.24 * phase) * w + (vnoise(t * 0.02, 3) - 0.5) * w * 0.02
      let my = (0.27 - 0.12 * near) * h + (vnoise(t * 0.017, 9) - 0.5) * h * 0.03
      const rad = (moon.r * scale) / 1.15
      if (my + rad > moonCeil) my = moonCeil - rad // stack layout only: the whole disc stays above the spire tip
      // behind reading text the disc dims: the lowest calm at its centre and on a ring at 0.6 of its radius
      const ring = rad * 0.6
      const under = Math.min(calm(mx, my), calm(mx + ring, my), calm(mx - ring, my), calm(mx, my + ring), calm(mx, my - ring))
      moonK += (dimFor(under, 0.3) - moonK) * dimStep
      ctx.globalAlpha = 0.85 * (0.6 + 0.4 * near) * moonK
      ctx.drawImage(moon.cv, mx - rad, my - rad, rad * 2, rad * 2)
      ctx.globalAlpha = 1
    }
    dimPrimed = true

    // the plume: smoke off the breach, lit from beneath, leaning with the wind
    // A slow column: puffs are born at the breach, climb, lean with the wind, swell and thin. They draw from baked
    // sprites, so a frame costs only drawImage calls. The column fades out before it reaches the top edge.
    if (L.plume && plumeK > 0.01) {
      const N = PLUME_N
      // (on a phone the text sits just above the crown, so there the column is shorter and fainter)
      const rise = Math.min(Math.max(ch * 3, Math.min(breach.y - h * 0.12, ch * (phone ? 4.5 : 7.5))) * plumeReach, Math.max(ch * 3, breach.y - h * 0.05))
      const quiet = (phone ? 0.6 : 1) * plumeK
      const drift = Math.min(w * 0.2, rise * 0.55)
      for (let i = 0; i < N; i++) {
        const k = (i / N + t * 0.016) % 1
        const rad = ch * (0.5 + 1.25 * k)
        plumeBuf[i * 4] = breach.x + ch * 0.3 + drift * Math.pow(k, 1.4) + (vnoise(i * 3.7, t * 0.06) - 0.5) * rad * 0.7
        plumeBuf[i * 4 + 1] = breach.y - ch * 0.5 - rise * k + (vnoise(i * 1.9 + 4, t * 0.05) - 0.5) * rad * 0.4
        plumeBuf[i * 4 + 2] = rad
        plumeBuf[i * 4 + 3] = k
      }
      ctx.globalCompositeOperation = 'source-over'
      for (let i = 0; i < N; i++) {
        const k = plumeBuf[i * 4 + 3]
        const rad = plumeBuf[i * 4 + 2]
        ctx.globalAlpha = Math.min(1, 0.4 * quiet * sm(k / 0.08) * (1 - sm((k - 0.3) / 0.7)))
        ctx.drawImage(puffs[i % 3].body, plumeBuf[i * 4] - rad, plumeBuf[i * 4 + 1] - rad, rad * 2, rad * 2)
      }
      // lit from beneath: the first third of the column takes the breach's light
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < N; i++) {
        const k = plumeBuf[i * 4 + 3]
        const lit = 1 - sm(k / 0.36)
        if (lit < 0.02) continue
        const rad = plumeBuf[i * 4 + 2]
        ctx.globalAlpha = Math.min(1, 0.3 * quiet * lit * sm(k / 0.06) * (1 + 0.6 * flare)) * breachK
        ctx.drawImage(puffs[i % 3].warm, plumeBuf[i * 4] - rad, plumeBuf[i * 4 + 1] - rad, rad * 2, rad * 2)
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    // the live far volcanoes: the pin of light baked into the notch gets a halo that breathes, very slowly
    if (L.ridges && far.lives.length) {
      ctx.globalCompositeOperation = 'lighter'
      for (const v of far.lives) {
        ctx.globalAlpha = 0.14 + 0.16 * (0.5 + 0.5 * Math.sin(t * 0.35 + v.ph))
        ctx.drawImage(glow, v.x - v.r * 1.6, v.y - v.r * 1.6, v.r * 3.2, v.r * 3.2)
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    // light thrown up out of the breach, behind the rock
    ctx.globalCompositeOperation = 'lighter'
    const cs = ch * (6 + flare * 2)
    ctx.globalAlpha = Math.min(1, heat * 0.55) * breachK
    ctx.drawImage(glow, breach.x - cs / 2, breach.y - cs * 0.6, cs, cs * 0.9)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1

    ctx.drawImage(land.cv, 0, 0, w, h)

    // the lake
    if (L.lake) {
      paintLake(t, flare)
      ctx.imageSmoothingEnabled = true
      const lb = lakeBox
      // the basin: its rim, its water and the lit lip along the shore are all in the one image
      ctx.drawImage(lb.cv, lb.x0, lb.y0, lb.lw / lb.S, lb.lh / lb.S)
      // what it lights: the rock above the inlet
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = 0.11 * heat
      const gs = groundH * 4.2
      ctx.drawImage(glow, river.mouth.x - gs * 0.75, river.mouth.y - gs * 0.34, gs * 1.5, gs * 0.6)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    // the river
    if (L.river) {
      const a = river.pts[0]
      const b = river.pts[river.N]
      // its light on the rock either side (down to the mouth only: on the lake the river's end is open lava, and a wash
      // laid over it showed as a lit box)
      ctx.globalCompositeOperation = 'lighter'
      ribbon(ctx, 3.4, 6, river.mouthI)
      const bloom = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
      bloom.addColorStop(0, 'rgba(255,140,60,0.16)')
      bloom.addColorStop(1, 'rgba(224,67,29,0.1)')
      ctx.fillStyle = bloom
      ctx.globalAlpha = heat
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      // cooled banks, wider than the channel: a soft dark shoulder, then the levee itself
      // (clipped to dry land: where the river reaches the lake it opens into it)
      ctx.save()
      ctx.clip(aboveLake, 'evenodd')
      ribbon(ctx, 1.7, 3)
      ctx.fillStyle = 'rgba(9,6,5,0.42)'
      ctx.fill()
      ribbon(ctx, 1.08, 1.5)
      ctx.fillStyle = 'rgba(44,17,10,0.9)'
      ctx.fill()
      ctx.restore()
      // the molten body: the Doom fire, laid along the channel
      lava.paint(secs, t, flare)
      ctx.drawImage(lava.cv, lava.x0, lava.y0)
      // just below the breach the margins shear against the banks and burn bright
      ctx.globalCompositeOperation = 'lighter'
      const margin = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
      margin.addColorStop(0, 'rgba(255,224,150,0.34)')
      margin.addColorStop(0.35, 'rgba(255,170,90,0.15)')
      margin.addColorStop(Math.max(0.4, river.mouthS - 0.04), 'rgba(255,150,80,0.07)')
      margin.addColorStop(1, 'rgba(255,140,70,0)')
      ctx.strokeStyle = margin
      ctx.lineWidth = 1.4
      for (const sgn of [1, -1]) {
        ctx.beginPath()
        for (let i = 0; i <= river.N; i++) {
          const p = river.pts[i]
          const d = river.hw[i] * 0.93 * sgn
          if (i === 0) ctx.moveTo(p.x + river.nx[i] * d, p.y + river.ny[i] * d)
          else ctx.lineTo(p.x + river.nx[i] * d, p.y + river.ny[i] * d)
        }
        ctx.stroke()
      }
      ctx.globalCompositeOperation = 'source-over'
      // plates of crust carried down it
      for (const p of plates) {
        p.s += secs * 0.035 * (1.5 - 1.05 * p.s) * (1 + flare * 0.6)
        if (p.s > river.mouthS + 0.03) {
          p.s = PLATE_FROM + rand(0, 0.06)
          p.c = rand(-0.4, 0.4)
        }
        const fr = riverAt(p.s)
        const grow = 0.45 + 0.55 * sm((p.s - PLATE_FROM) / 0.5)
        const fadeIn = sm((p.s - PLATE_FROM) / 0.12)
        const fadeOut = 1 - sm((p.s - (river.mouthS - 0.15)) / 0.07) // rafts melt back into the lava before the shore (their noses reach about 0.08 on)
        const len = p.len * fr.hw * grow
        const wid = Math.min(p.wid * fr.hw * grow, fr.hw * 0.86 * 2 * (0.5 - Math.abs(p.c)))
        ctx.beginPath()
        for (let k = 0; k < p.shape.length; k++) {
          const q = p.shape[k]
          const along = (Math.cos(q.a) * q.r * len) / 2
          const across = p.c * fr.hw * 1.7 + (Math.sin(q.a) * q.r * wid) / 2
          const f2 = riverAt(p.s + along / river.length)
          const x = f2.x + f2.nx * across
          const y = f2.y + f2.ny * across
          if (k === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.closePath()
        // a skin, not a rock: dark red, and the lava still shows through it
        ctx.fillStyle = `rgba(44,13,7,${(0.62 * fadeIn * fadeOut).toFixed(3)})`
        ctx.fill()
      }
      // Where reading text sits over the river, it steps aside. Not a hole in the river: the channel roofs over with
      // dark red crust, as a lava tube does. Each run of covered river is one shape with one gradient, so no seams.
      const ks = river.pts.map((p) => calm(p.x, p.y))
      for (let i0 = 0; i0 <= river.N; i0++) {
        if (ks[i0] > 0.98) continue
        let i1 = i0
        while (i1 < river.N && ks[i1 + 1] <= 0.98) i1++
        const lo = Math.max(0, i0 - 1)
        const hi = Math.min(river.N, i1 + 1)
        if (hi > lo) {
          ctx.beginPath()
          for (let i = lo; i <= hi; i++) {
            const p = river.pts[i]
            const d = river.hw[i] * 1.12
            if (i === lo) ctx.moveTo(p.x + river.nx[i] * d, p.y + river.ny[i] * d)
            else ctx.lineTo(p.x + river.nx[i] * d, p.y + river.ny[i] * d)
          }
          for (let i = hi; i >= lo; i--) {
            const p = river.pts[i]
            const d = river.hw[i] * 1.12
            ctx.lineTo(p.x - river.nx[i] * d, p.y - river.ny[i] * d)
          }
          ctx.closePath()
          const roof = ctx.createLinearGradient(river.pts[lo].x, river.pts[lo].y, river.pts[hi].x, river.pts[hi].y)
          for (let i = lo; i <= hi; i++) roof.addColorStop((i - lo) / (hi - lo), `rgba(46,13,7,${((1 - ks[i]) * 0.94).toFixed(3)})`)
          ctx.fillStyle = roof
          ctx.fill()
        }
        i0 = i1
      }
    }

    // the breach: the brightest thing in the frame, and what it lights on the crown's inner walls
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const inner = [crownPts.slice(5, 11), crownPts.slice(11, 17)]
    for (const edge of inner) {
      ctx.beginPath()
      edge.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
      const eg = ctx.createLinearGradient(0, rimY - ch * 1.6, 0, rimY)
      eg.addColorStop(0, 'rgba(255,150,80,0)')
      eg.addColorStop(1, 'rgba(255,176,102,1)')
      ctx.strokeStyle = eg
      ctx.globalAlpha = Math.min(1, heat * 0.3) * breachK
      ctx.lineWidth = Math.max(3, ch * 0.07)
      ctx.stroke()
      ctx.globalAlpha = Math.min(1, heat * 0.8) * breachK
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    const ms = ch * 2.4
    ctx.globalAlpha = Math.min(1, heat * 0.9) * breachK
    ctx.drawImage(glow, breach.x - ms / 2, breach.y - ms * 0.42, ms, ms * 0.75)
    // lava spat up off the breach
    if (spits.length < 14 && Math.random() < 0.16 * dt) spits.push({ x: breach.x + rand(-0.14, 0.14) * ch, y: breach.y, vx: rand(-0.7, 0.7) * (ch / 70), vy: -rand(1.4, 3.8) * (ch / 70), age: 0, life: rand(0.6, 1.5), size: rand(1.2, 2.8) })
    for (let i = spits.length - 1; i >= 0; i--) {
      const s = spits[i]
      s.age += secs
      const life = s.age / s.life
      if (life >= 1) {
        spits.splice(i, 1)
        continue
      }
      s.vy += 0.13 * dt
      s.x += s.vx * dt
      s.y += s.vy * dt
      const r = s.size * 3.2
      ctx.globalAlpha = 0.6 * (1 - life)
      ctx.drawImage(glow, s.x - r, s.y - r, r * 2, r * 2)
      ctx.globalAlpha = 1 - life * 0.6
      ctx.fillStyle = life < 0.5 ? '#ffe0a0' : '#ff9a4d'
      ctx.fillRect(s.x - s.size / 2, s.y - s.size / 2, s.size, s.size)
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1

    ctx.drawImage(fore.cv, 0, 0, w, h)

    // embers: off the breach, the river and the inlet, carried up and downwind
    ctx.globalCompositeOperation = 'lighter'
    if (L.embers) {
      for (const e of embers) {
        e.age += secs
        e.y -= e.vy * dt * 0.7
        e.phase += 0.026 * dt
        e.x += (e.vx + 0.25 * Math.min(1, e.age / 3) + Math.sin(e.phase) * 0.15 * e.sway) * dt * 0.7
        if (e.age >= e.life || e.y < -30) {
          Object.assign(e, spawnEmber(true))
          continue
        }
        const p = e.age / e.life
        const fade = p < 0.1 ? p / 0.1 : p > 0.6 ? 1 - (p - 0.6) / 0.4 : 1
        const flick = 0.74 + Math.sin(e.phase * 2.4) * 0.26
        ctx.globalAlpha = Math.max(0, e.alpha * fade * flick)
        ctx.drawImage(glow, e.x - e.size / 2, e.y - e.size / 2, e.size, e.size)
        if (e.green) {
          ctx.globalAlpha = Math.max(0, e.alpha * fade * flick * 0.5)
          ctx.fillStyle = '#59d66c'
          ctx.beginPath()
          ctx.arc(e.x, e.y, e.size * 0.3, 0, TAU)
          ctx.fill()
        }
      }
    }
    // eruption sparks
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]
      s.age += secs
      s.px = s.x
      s.py = s.y
      s.vy += 0.07 * dt
      s.x += s.vx * 1.5 * dt
      s.y += s.vy * 1.5 * dt
      if (s.age >= s.life || s.y > h + 30) {
        sparks.splice(i, 1)
        continue
      }
      const fade = 1 - s.age / s.life
      ctx.globalAlpha = Math.max(0, s.alpha * fade)
      ctx.strokeStyle = '#ffb872'
      ctx.lineWidth = s.size * 1.1
      ctx.beginPath()
      ctx.moveTo(s.px, s.py)
      ctx.lineTo(s.x, s.y)
      ctx.stroke()
      const hs = s.size * 5
      ctx.globalAlpha = Math.max(0, s.alpha * fade * 0.7)
      ctx.drawImage(glow, s.x - hs / 2, s.y - hs / 2, hs, hs)
    }
    ctx.globalCompositeOperation = 'source-over'
    if (L.ash) {
      ctx.fillStyle = '#6b6560'
      for (const a of ash) {
        a.y += a.vy * dt
        a.phase += 0.02 * dt
        a.x += (a.drift + Math.sin(a.phase) * 0.2) * dt
        if (a.y > h + 10 || a.x > w + 40) {
          a.y = rand(-40, -5)
          a.x = rand(-30, w + 30)
        }
        ctx.globalAlpha = a.alpha
        ctx.fillRect(a.x, a.y, a.size, a.size)
      }
    }
    ctx.globalAlpha = 1
    if (flare) flare = Math.max(0, flare - secs * 1.8)
  }

  return { draw, erupt, info: { peakX, rimY, ch, H, shoreY, breach, tipY, stack, inlet: river.inlet, lake, monolith: mono } }
}
