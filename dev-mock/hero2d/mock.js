// THROWAWAY MOCK. A 2D canvas repaint of the hero drawing, shown over the real page by viewer.js.
// Nothing here ships: it exists so the look can be judged in Chrome before any product code changes.
//
// References looked at before drawing (docs/design/refs):
//   usgs-mauna-loa-2022-12-08-fissure-3-channel.png  : one wide river, bright margins, crust plates mid-stream, dark levees
//   usgs-halemaumau-2021-01-19-lake-channel-evening.jpg : a lake of dark crust plates netted with thin orange seams, hot only at the inlet
//   dev-mock/lava3d/shots/desktop-r3-4.png             : the round-3 3D mock, the one that felt alive (one river, lit relief, jagged crown, sphere moon)

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
  const phone = w <= 600
  const dpr = o.dpr ?? 1
  const L = { sky: true, moon: true, plume: true, ridges: true, relief: true, river: true, lake: true, embers: true, ash: true, ...(o.layers || {}) }
  PAL = o.palette === 'doom' ? DOOM : MOLTEN

  // ---------------------------------------------------------------- the mountain's frame (same numbers as the live hero)
  const H = Math.max(40, Math.min(690 * (h / 1000), h * 0.7))
  const peakX = w * (o.faceX ?? (phone ? 0.36 : 0.29))
  const rimY = h - H
  const ch = Math.max(18, Math.min(H * 0.13, w * 0.11))
  const halfBase = Math.max((w * 0.6) / 2, H * 0.6)
  const groundH = Math.round(Math.max(56, h * 0.125))
  const shoreY = h - groundH
  const ROWS = 48

  const flip = !!o.flip // mirror the crown and the river, so the breach faces right
  const mx = flip ? -1 : 1
  // Each flank falls in cliffs and shelves: a shelf steps the rock outward at once, and a spine of rock stands on its lip.
  const flank = (dir) => {
    const spread = dir < 0 ? 0.92 : 1.14
    // shelves at uneven heights, a few of them deep; one spine per flank, on a shelf in the upper half
    const ledges = []
    for (let k = 5 + Math.floor(R() * 5); k < ROWS - 6 && ledges.length < 5; k += 4 + Math.floor(R() * 10)) {
      ledges.push({ k, out: (R() < 0.35 ? 0.05 + R() * 0.04 : 0.012 + R() * 0.02) * halfBase * spread, tooth: 0 })
    }
    // one spine on the whole mountain, on the flank away from the title: a pair at one height reads as ears
    const high = ledges.filter((l) => l.k > ROWS * 0.25 && l.k < ROWS * 0.62)
    if (dir < 0 && high.length) high[Math.floor(R() * high.length)].tooth = (0.05 + R() * 0.045) * H
    const pts = []
    const outline = []
    for (let i = 0; i <= ROWS; i++) {
      const f = i / ROWS
      let x = ch + Math.pow(f, 2.4) * (halfBase * spread - ch)
      let tooth = 0
      for (const l of ledges) {
        if (i >= l.k) x += l.out
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
  const riverU = (o.riverU ?? (phone ? -0.3 : -0.36)) * mx
  let riverLine = null
  for (const ln of lines) {
    if (ln.crest) continue
    if (!riverLine || Math.abs(ln.u[ROWS >> 1] - riverU) < Math.abs(riverLine.u[ROWS >> 1] - riverU)) riverLine = ln
  }
  const breach = { x: peakX - 0.26 * ch * mx, y: rimY - 0.04 * ch }

  // the lake: a wide flat ellipse at the mountain's foot, its near half below the bottom edge
  const lake = (() => {
    const rx = phone ? w * 0.66 : Math.min(w * 0.235, 380)
    const ry = groundH * 1.1
    const foot = P(riverLine.u[Math.round(ROWS * 0.8)], 0.8)
    const cx = phone ? w * 0.5 : foot.x - rx * 0.18 * mx
    const cy = shoreY + 3 + ry
    return { rx, ry, cx, cy }
  })()
  const lakeTopAt = (x) => {
    const e = clamp01(Math.abs((x - lake.cx) / lake.rx))
    return lake.cy - lake.ry * Math.sqrt(1 - e * e)
  }

  const river = (() => {
    const raw = [breach]
    for (let i = 2; i <= ROWS; i++) {
      const p = P(riverLine.u[i], i / ROWS)
      if (p.y > shoreY - 6) break
      raw.push(p)
    }
    const lastX = raw[raw.length - 1].x
    raw.push({ x: lastX - 2 * mx, y: lakeTopAt(lastX) + 5 })
    const N = 80
    const { pts, length } = smoothPath(raw, N)
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
      hw[i] = ch * (0.13 + 0.3 * Math.pow(s, 1.25)) * (phone ? 0.78 : 1) * (1 + 0.1 * (vnoise(s * 6, 4.4) - 0.5))
    }
    return { pts, N, nx, ny, hw, length, inlet: pts[N] }
  })()
  const riverXAt = (y) => {
    const p = river.pts
    if (y <= p[0].y) return p[0].x
    for (let i = 1; i <= river.N; i++) if (p[i].y >= y) return lerp(p[i - 1].x, p[i].x, (y - p[i - 1].y) / (p[i].y - p[i - 1].y || 1))
    return p[river.N].x
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
  // a curve along the river (white-hot at the breach, deep orange by the lake) and the banks cool a little faster.
  const lava = (() => {
    const cell = 2 // a fine grain, as the title's fire has
    const rows = Math.max(40, Math.round(river.length / cell))
    const cols = phone ? 16 : 28
    const SOURCE = 34 // warm white at the breach; an eruption pushes it to the top of the ramp
    const WAVE = 0.3 // how far the source rolls and dips: tongues, without starving the river
    const fire = new DoomFire(cols, rows, { maxHeat: SOURCE, variation: 1 })
    // The mean heat wanted along the river, as [fraction, heat]; its slope is the chance of losing a step per row.
    // It falls fast below the breach and then holds: the river is still a deep orange where it meets the lake. (The
    // rolling source and the cooler banks take about four more steps off, so the lake end sits near 16.)
    const target = o.lavaCurve ?? [[0, SOURCE], [0.1, 27], [0.4, 23], [1, 20.5]]
    const lose = new Float32Array(rows)
    for (let y = 0; y < rows; y++) {
      const s = 1 - y / (rows - 1)
      let k = 1
      while (k < target.length - 1 && target[k][0] < s) k++
      lose[y] = Math.min(0.95, (target[k - 1][1] - target[k][1]) / (target[k][0] - target[k - 1][0]) / (rows - 1))
    }
    const step = () => {
      const cells = fire.cells
      for (let y = 1; y < rows; y++) {
        const row = y * cols
        const above = row - cols
        const p = lose[y]
        for (let x = 0; x < cols; x++) {
          const src = cells[row + x]
          if (src === 0) {
            cells[above + x] = 0
            continue
          }
          let dx = x - ((Math.random() * 3) | 0) + 1
          if (dx < 0) dx = 0
          else if (dx >= cols) dx = cols - 1
          const bank = x < 2 || x > cols - 3 ? 1.7 : 1
          const next = src - (Math.random() < p * bank ? 1 : 0)
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
          pc.push((across / hwHere) * 0.5 * (cols - 1) + 0.5 * (cols - 1))
          // over its last stretch the river melts into the lake's open lava rather than ending in an edge
          pa.push(255 * clamp01(hwHere + 0.5 - Math.abs(across)) * (1 - sm((s - 0.95) / 0.05)))
        }
      }
    }
    // Round joints: where the channel bends, the straight slabs above leave a wedge on the outside of the bend. Any
    // pixel still unclaimed within a half-width of a sample point belongs to that point.
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
          claimed[off] = 1
          pix.push(off * 4)
          pr.push((rows - 1) * (1 - i / river.N))
          pc.push(((qx * river.nx[i] + qy * river.ny[i]) / river.hw[i]) * 0.5 * (cols - 1) + 0.5 * (cols - 1))
          pa.push(255 * clamp01(reach - dist))
        }
      }
    }
    const n = pix.length
    const PIX = Int32Array.from(pix)
    const PR = Float32Array.from(pr)
    const PC = Float32Array.from(pc)
    const PA = Uint8Array.from(pa)
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
        heatColour(top + (bot - top) * fr, d, off)
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
    let warm = below ? 0 : (0.9 - 0.25 * f) * Math.exp(-Math.abs(d) / fall) * (0.05 + 0.95 * lit)
    // the breach lights the chute below it; the spear and the stub shade the rock to either side
    const dc = Math.hypot(x - breach.x, (y - breach.y) * 0.7)
    const sdx = (x - breach.x) * mx
    const side = sdx > ch * 0.45 ? (sdx - ch * 0.45) / (ch * 0.5) : sdx < -ch * 0.4 ? (-ch * 0.4 - sdx) / (ch * 0.5) : 0
    warm += 0.8 * Math.exp(-dc / (ch * 1.5)) * (0.2 + 0.8 * lit) * Math.exp(-side)
    const dl = Math.hypot((x - river.inlet.x) * 0.6, y - river.inlet.y)
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
  const crownPts = [
    [-1, 0], [-1, -0.3], [-0.93, -0.62], [-0.84, -0.7], [-0.8, -0.95], [-0.66, -1.05], [-0.6, -0.8], [-0.5, -0.72], [-0.44, -0.3], [-0.4, -0.06],
    [-0.26, 0.02], [-0.12, -0.03],
    [-0.1, -0.62], [-0.03, -0.7], [0, -1.3], [0.08, -1.38], [0.12, -1.95], [0.2, -2.1], [0.36, -2.25], [0.46, -2.02], [0.52, -2.05],
    [0.6, -1.72], [0.66, -1.66], [0.72, -1.18], [0.8, -1.12], [0.86, -0.62], [0.93, -0.56], [0.98, -0.22], [1, 0],
  ].map(([x, y], i, all) => {
    const pin = i === 0 || i === all.length - 1
    return { x: peakX + (x + (pin ? 0 : rr(-0.012, 0.012))) * ch * mx, y: rimY + (y + (pin ? 0 : rr(-0.02, 0.02))) * ch }
  })
  const cpt = (x, y) => ({ x: peakX + x * ch * mx, y: rimY + y * ch })

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
  const jagged = (ctrl, rough, levels = 4) => {
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
        next.push({ x: (a.x + b.x) / 2 + rr(-1, 1) * len * rough * 0.25, y: (a.y + b.y) / 2 + rr(-1, 1) * len * rough })
      }
      next.push(pts[pts.length - 1])
      nidx.push(next.length - 1)
      pts = next
      idx = nidx
      rough *= 0.62
    }
    return { pts, idx }
  }

  const paintFarRange = (g, baseFrac, amp, top, bottom, shift) => {
    g.beginPath()
    g.moveTo(-10, h + 10)
    const n = 90
    for (let i = 0; i <= n; i++) {
      const x = (i / n) * (w + 20) - 10
      const u = (i / n) * 5.2 + shift
      const ridge = 1 - Math.abs(2 * vnoise(u, 1.3 + shift) - 1)
      const fine = vnoise(u * 3.7, 8.2 + shift)
      g.lineTo(x, h - h * (baseFrac + amp * (0.7 * ridge * ridge + 0.3 * fine)))
    }
    g.lineTo(w + 10, h + 10)
    g.closePath()
    const grd = g.createLinearGradient(0, h - h * (baseFrac + amp), 0, h)
    grd.addColorStop(0, top)
    grd.addColorStop(1, bottom)
    g.fillStyle = grd
    g.fill()
  }

  /** The peaks joined to Deathfire's right shoulder: dark, with a warm face toward the volcano and a cool face away. */
  const paintConnected = (g) => {
    const start = { x: right[Math.round(ROWS * 0.5)].x - 30, y: right[Math.round(ROWS * 0.5)].y }
    const ctrl = [
      start,
      { x: w * 0.58, y: h - h * 0.215 },
      { x: w * 0.725, y: h - h * 0.365 },
      { x: w * 0.835, y: h - h * 0.19 },
      { x: w * 0.945, y: h - h * 0.3 },
      { x: w + 30, y: h - h * 0.2 },
    ]
    const { pts, idx } = jagged(ctrl, 0.1, 4)
    g.beginPath()
    g.moveTo(pts[0].x, h + 10)
    for (const p of pts) g.lineTo(p.x, p.y)
    g.lineTo(w + 30, h + 10)
    g.closePath()
    g.fillStyle = 'rgb(7,11,10)'
    g.fill()
    for (const [ai, li, ri] of [[idx[2], idx[1], idx[3]], [idx[4], idx[3], idx[5]]]) {
      const apex = pts[ai]
      const baseY = Math.max(pts[li].y, pts[ri].y) + h * 0.05
      const zig = [apex]
      const steps = 6
      for (let k = 1; k <= steps; k++) zig.push({ x: apex.x + (k % 2 ? 1 : -1) * rr(4, 14) * (k / steps + 0.3) + k * 3, y: apex.y + ((baseY - apex.y) * k) / steps })
      const face = (from, to, colour) => {
        g.beginPath()
        const dir = from < to ? 1 : -1
        for (let i = from; i !== to + dir; i += dir) g.lineTo(pts[i].x, pts[i].y)
        g.lineTo(pts[to].x, baseY)
        for (let k = zig.length - 1; k >= 0; k--) g.lineTo(zig[k].x, zig[k].y)
        g.closePath()
        const grd = g.createLinearGradient(0, apex.y, 0, baseY)
        grd.addColorStop(0, colour)
        grd.addColorStop(1, 'rgba(7,11,10,0)')
        g.fillStyle = grd
        g.fill()
      }
      face(ai, li, 'rgba(66,30,17,0.9)') // toward the volcano
      face(ai, ri, 'rgba(24,38,33,0.95)') // away from it, under the moon
    }
  }

  const paintMountain = (g) => {
    // silhouette
    g.beginPath()
    g.moveTo(left[ROWS].x, h + 20)
    for (let i = left.outline.length - 1; i >= 0; i--) g.lineTo(left.outline[i].x, left.outline[i].y)
    for (const p of flip ? [...crownPts].reverse() : crownPts) g.lineTo(p.x, p.y)
    for (const p of right.outline) g.lineTo(p.x, p.y)
    g.lineTo(right[ROWS].x, h + 20)
    g.closePath()
    const body = g.createLinearGradient(0, rimY - ch * 2, 0, h)
    body.addColorStop(0, 'rgb(11,19,16)')
    body.addColorStop(1, 'rgb(4,8,7)')
    g.fillStyle = body
    g.fill()
    if (!L.relief) return

    g.save()
    g.clip()
    // planes between each crest and gully, lit by the river, the crater, the lake and the moon
    for (let j = 0; j < lines.length - 1; j++) {
      const A = lines[j]
      const B = lines[j + 1]
      const facing = A.crest ? 1 : -1
      const tint = 0.88 + R() * 0.24
      g.beginPath()
      for (let i = 0; i <= ROWS; i++) {
        const p = P(A.u[i], i / ROWS)
        if (i === 0) g.moveTo(p.x, p.y)
        else g.lineTo(p.x, p.y)
      }
      for (let i = ROWS; i >= 0; i--) {
        const p = P(B.u[i], i / ROWS)
        g.lineTo(p.x, p.y)
      }
      g.closePath()
      const top = P((A.u[0] + B.u[0]) / 2, 0).y
      const bot = P((A.u[ROWS] + B.u[ROWS]) / 2, 1).y
      const grd = g.createLinearGradient(0, top, 0, bot)
      for (let i = 0; i <= ROWS; i += 2) {
        const f = i / ROWS
        const c = P((A.u[i] + B.u[i]) / 2, f)
        grd.addColorStop(clamp01((c.y - top) / (bot - top)), css(rockColour(c.x, c.y, facing * lean((j + 1) >> 1, f), f, tint)))
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
      const top = P(C.u[0], 0).y
      const bot = P(C.u[ROWS], 1).y
      const grd = g.createLinearGradient(0, top, 0, bot)
      for (let i = 0; i <= ROWS; i += 2) {
        const f = i / ROWS
        const c = P(C.u[i], f)
        const d = c.x - riverXAt(c.y)
        const { warm } = lightAt(c.x, c.y, d > 0 ? -1 : 1, f)
        const edge = warm * 0.5 * (1 - 0.6 * sm((f - 0.72) / 0.25)) * (0.2 + 0.8 * lean(j >> 1, f))
        grd.addColorStop(clamp01((c.y - top) / (bot - top)), `rgba(255,170,96,${edge.toFixed(3)})`)
      }
      g.beginPath()
      for (let i = 0; i <= ROWS; i++) {
        const p = P(C.u[i], i / ROWS)
        if (i === 0) g.moveTo(p.x, p.y)
        else g.lineTo(p.x, p.y)
      }
      g.strokeStyle = grd
      g.lineWidth = 1.1
      g.stroke()
    }
    g.restore()

    // the crown: dark, then the faces the breach lights and the faces the moon finds
    const face = (pts, c0, c1, y0, y1) => {
      g.beginPath()
      pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)))
      g.closePath()
      const grd = g.createLinearGradient(0, y0, 0, y1)
      grd.addColorStop(0, c0)
      grd.addColorStop(1, c1)
      g.fillStyle = grd
      g.fill()
    }
    const cp = crownPts
    const spine = [cp[18], cpt(0.33, -1.4), cpt(0.4, -0.7), cpt(0.36, 0.1)]
    // the tower's inner face, toward the breach: lit from below, dark by the top
    face([...cp.slice(11, 19), ...spine.slice(1), cpt(-0.12, 0.1)], 'rgba(30,12,8,0.1)', 'rgba(200,88,32,0.9)', rimY - ch * 1.9, rimY + ch * 0.1)
    // its outer face, under the moon
    face([...cp.slice(18, 29), ...spine.slice(1).reverse()], flip ? 'rgba(20,31,27,0.7)' : 'rgba(34,52,45,0.85)', 'rgba(12,20,17,0.25)', rimY - ch * 2.2, rimY)
    // the stub's inner face, toward the breach
    face([cp[5], cp[6], cp[7], cp[8], cp[9], cpt(-0.6, 0.06), cpt(-0.74, -0.55)], 'rgba(50,20,11,0.2)', 'rgba(186,80,30,0.85)', rimY - ch, rimY)
    // the ledges where the tower's walls step: a thin line of caught light on each
    g.lineWidth = 1
    for (const [a, b, colour] of [[12, 13, 'rgba(255,170,96,0.5)'], [14, 15, 'rgba(255,170,96,0.28)'], [21, 22, 'rgba(120,160,144,0.3)'], [23, 24, 'rgba(120,160,144,0.24)'], [25, 26, 'rgba(120,160,144,0.18)']]) {
      g.beginPath()
      g.moveTo(cp[a].x, cp[a].y)
      g.lineTo(cp[b].x, cp[b].y)
      g.strokeStyle = colour
      g.stroke()
    }
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
    paintFarRange(land.g, 0.2, 0.13, 'rgb(40,21,15)', 'rgb(18,11,9)', 0)
    paintFarRange(land.g, 0.15, 0.1, 'rgb(22,15,13)', 'rgb(10,9,8)', 11.3)
    paintConnected(land.g)
  }
  paintMountain(land.g)
  paintGround(land.g)
  paintFore(fore.g)

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
  // Mostly dark crust in plates, netted with thin seams; hot only in a fan where the river arrives (Halemaumau frame).
  // Where each pixel sits on the lake never changes, so that is worked out once; a repaint only finds the plate edges
  // and colours them, in the same fire palette as the river, and it runs every other frame.
  const lakeBox = (() => {
    const x0 = Math.max(0, Math.floor(lake.cx - lake.rx - 4))
    const x1 = Math.min(w, Math.ceil(lake.cx + lake.rx + 4))
    const y0 = Math.floor(lake.cy - lake.ry - 4)
    const S = phone ? 0.7 : 0.8
    const lw = Math.max(2, Math.ceil((x1 - x0) * S))
    const lh = Math.max(2, Math.ceil((h - y0) * S))
    const { cv, g } = makeCanvas(lw, lh)
    const img = g.createImageData(lw, lh)
    const inletEx = (river.inlet.x - lake.cx) / lake.rx
    const off = []
    const U = []
    const V = []
    const HEAT = []
    for (let j = 0; j < lh; j++) {
      const sy = y0 + (j + 0.5) / S
      const ey = (sy - lake.cy) / lake.ry
      const z = (sy - (lake.cy - lake.ry)) / (2 * lake.ry)
      if (z < 0) continue
      for (let i = 0; i < lw; i++) {
        const sx = x0 + (i + 0.5) / S
        const ex = (sx - lake.cx) / lake.rx
        const ang = Math.atan2(ey, ex)
        const rim = 0.955 + 0.07 * vnoise(Math.cos(ang) * 2.3 + 5, Math.sin(ang) * 2.3 + 1)
        const d = Math.hypot(ex, ey) / rim
        if (d >= 1) continue
        // plate coordinates, foreshortened with distance. The plates are small and crowded near the inlet and large
        // toward the far shores, and a slow warp keeps them from lining up as a grid.
        const dIn = Math.hypot(ex - inletEx, z * 2.5)
        const fine = 1.25 - 0.6 * sm(dIn / 0.9)
        const u0 = ((ex - inletEx) * 8.5 * fine) / (0.5 + 1.2 * z)
        const v0 = Math.pow(z, 0.72) * 12 * fine
        off.push((j * lw + i) * 4)
        U.push(u0 + (vnoise(u0 * 0.45 + 3, v0 * 0.45 + 11) - 0.5) * 1.3)
        V.push(v0 + (vnoise(u0 * 0.45 + 17, v0 * 0.45 + 5) - 0.5) * 1.3)
        HEAT.push(Math.exp(-dIn * dIn * 5.2))
        img.data[(j * lw + i) * 4 + 3] = 255 * sm((1 - d) / 0.05)
      }
    }
    return { x0, y0, S, lw, lh, cv, g, img, n: off.length, off: Int32Array.from(off), U: Float32Array.from(U), V: Float32Array.from(V), HEAT: Float32Array.from(HEAT), tick: 0 }
  })()
  const paintLake = (t, flare) => {
    const B = lakeBox
    if (B.tick++ % 2) return
    const data = B.img.data
    const drift = t * 0.045 // the crust drifts toward the viewer
    const col = [0, 0, 0]
    for (let k = 0; k < B.n; k++) {
      const u = B.U[k]
      const v = B.V[k] - drift
      const ui = Math.floor(u)
      const vi = Math.floor(v)
      let f1 = 9
      let f2 = 9
      let id = 0
      for (let b = -1; b <= 1; b++) {
        for (let a = -1; a <= 1; a++) {
          const cx = ui + a
          const cy = vi + b
          const dx = u - (cx + 0.04 + 0.92 * hash2(cx, cy))
          const dy = (v - (cy + 0.04 + 0.92 * hash2(cx + 57, cy + 131))) * 1.15
          const dd = Math.sqrt(dx * dx + dy * dy)
          if (dd < f1) {
            f2 = f1
            f1 = dd
            id = cx * 31 + cy * 17
          } else if (dd < f2) f2 = dd
        }
      }
      const heat = B.HEAT[k] * (1 + 0.35 * flare)
      const seam = 1 - sm((f2 - f1) / (0.045 + 0.2 * heat))
      const flick = 0.72 + 0.28 * vnoise(u * 2.1 + t * 0.35, v * 2.1)
      const open = sm((heat - 0.6) / 0.3)
      // heat on the fire's own scale: seams run from a dull red far out to gold at the inlet, and the open lava where
      // the river arrives sits at the river's own heat
      const T = Math.max(seam * (3 + 27 * clamp01(0.08 + heat * 1.1)) * flick, open * (13 + 7 * flick))
      heatColour(T, col, 0)
      const kk = sm((T - 2.5) / 5)
      const shade = ((hash2(id, 7) - 0.5) * 9) | 0
      const o4 = B.off[k]
      data[o4] = 17 + shade + 46 * heat + (col[0] - 17 - shade - 46 * heat) * kk
      data[o4 + 1] = 13 + shade + 12 * heat + (col[1] - 13 - shade - 12 * heat) * kk
      data[o4 + 2] = 12 + shade + 5 * heat + (col[2] - 12 - shade - 5 * heat) * kk
    }
    B.g.putImageData(B.img, 0, 0)
  }

  // ---------------------------------------------------------------- moving things
  const glow = makeGlow()
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
  const emberCount = phone ? 44 : 110
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

  const erupt = (scale = 1) => {
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
      const my = (0.27 - 0.12 * near) * h + (vnoise(t * 0.017, 9) - 0.5) * h * 0.03
      const rad = (moon.r * scale) / 1.15
      ctx.globalAlpha = 0.85 * (0.6 + 0.4 * near)
      ctx.drawImage(moon.cv, mx - rad, my - rad, rad * 2, rad * 2)
      ctx.globalAlpha = 1
    }

    // the plume: smoke off the breach, lit from beneath, leaning with the wind
    if (L.plume) {
      const N = phone ? 18 : 26
      for (let i = 0; i < N; i++) {
        const k = (i / N + t * 0.012) % 1
        const rad = ch * (0.75 + 3.6 * k)
        const x = breach.x + ch * 0.25 + w * 0.2 * Math.pow(k, 1.5) + (vnoise(i * 3.7, t * 0.06) - 0.5) * rad * 0.9
        const y = breach.y - ch * 0.7 - (breach.y + ch) * k + (vnoise(i * 1.9 + 4, t * 0.05) - 0.5) * rad * 0.5
        const lit = Math.exp(-k * 6) * (0.8 + 0.5 * flare)
        const c = [58 + 150 * lit, 44 + 40 * lit, 38 + 2 * lit]
        const a = 0.24 * Math.sin(Math.PI * Math.min(1, k * 1.15)) + 0.1 * lit
        const grd = ctx.createRadialGradient(x, y, 0, x, y, rad)
        grd.addColorStop(0, css(c, a))
        grd.addColorStop(0.55, css(c, a * 0.55))
        grd.addColorStop(1, css(c, 0))
        ctx.fillStyle = grd
        ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2)
      }
    }

    // light thrown up out of the breach, behind the rock
    ctx.globalCompositeOperation = 'lighter'
    const cs = ch * (6 + flare * 2)
    ctx.globalAlpha = Math.min(1, heat * 0.55)
    ctx.drawImage(glow, breach.x - cs / 2, breach.y - cs * 0.6, cs, cs * 0.9)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1

    ctx.drawImage(land.cv, 0, 0, w, h)

    // the lake
    if (L.lake) {
      paintLake(t, flare)
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(lakeBox.cv, lakeBox.x0, lakeBox.y0, lakeBox.lw / lakeBox.S, lakeBox.lh / lakeBox.S)
      // what it lights: the rock above the inlet
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = 0.3 * heat
      const gs = groundH * 4.2
      ctx.drawImage(glow, river.inlet.x - gs * 0.75, river.inlet.y - gs * 0.34, gs * 1.5, gs * 0.6)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    // the river
    if (L.river) {
      const a = river.pts[0]
      const b = river.pts[river.N]
      // its light on the rock either side
      ctx.globalCompositeOperation = 'lighter'
      ribbon(ctx, 3.4, 6)
      const bloom = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
      bloom.addColorStop(0, 'rgba(255,140,60,0.16)')
      bloom.addColorStop(1, 'rgba(224,67,29,0.1)')
      ctx.fillStyle = bloom
      ctx.globalAlpha = heat
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      // cooled banks, wider than the channel: a soft dark shoulder, then the levee itself
      // (they stop short of the lake, where the river opens into it)
      ribbon(ctx, 1.7, 3, river.N - 3)
      ctx.fillStyle = 'rgba(9,6,5,0.42)'
      ctx.fill()
      ribbon(ctx, 1.08, 1.5, river.N - 3)
      ctx.fillStyle = 'rgba(44,17,10,0.9)'
      ctx.fill()
      // the molten body: the Doom fire, laid along the channel
      lava.paint(secs, t, flare)
      ctx.drawImage(lava.cv, lava.x0, lava.y0)
      // just below the breach the margins shear against the banks and burn bright
      ctx.globalCompositeOperation = 'lighter'
      const margin = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
      margin.addColorStop(0, 'rgba(255,224,150,0.3)')
      margin.addColorStop(0.35, 'rgba(255,170,90,0.1)')
      margin.addColorStop(0.6, 'rgba(255,140,70,0)')
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
        if (p.s > 1) {
          p.s = PLATE_FROM + rand(0, 0.06)
          p.c = rand(-0.4, 0.4)
        }
        const fr = riverAt(p.s)
        const grow = 0.45 + 0.55 * sm((p.s - PLATE_FROM) / 0.5)
        const fadeIn = sm((p.s - PLATE_FROM) / 0.12)
        const fadeOut = 1 - sm((p.s - 0.93) / 0.07)
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
      ctx.globalAlpha = Math.min(1, heat * 0.3)
      ctx.lineWidth = Math.max(3, ch * 0.07)
      ctx.stroke()
      ctx.globalAlpha = Math.min(1, heat * 0.8)
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    const ms = ch * 2.4
    ctx.globalAlpha = Math.min(1, heat * 0.9)
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

  return { draw, erupt, info: { peakX, rimY, ch, H, shoreY, breach, inlet: river.inlet, lake } }
}
