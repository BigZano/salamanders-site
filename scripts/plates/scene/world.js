// The plate scene's ground, built on the CPU once from the page's own mountain (src/lib/mountain.js, in canvas pixels).
// Pure JS (no three.js) so it can be checked under node.
//
// Everything is laid out in SCREEN space: grids over the canvas, each vertex given a depth (toward the camera) and then
// pushed along the camera ray through its own pixel. Every vertex therefore projects to exactly its own pixel whatever its
// depth, so relief lights the rock but can never move an outline. The cone's outline is the page's polygon (the shader
// cuts it with a mask of the same polygon, filled the way the page fills it); the hills that join it, and the ridge in
// the foreground, have outlines of their own, planned here from the same mountain (planHills).
//
// Three depths, near to far: the foreground ridge (its own mesh, in front of everything), the cone and the hills joined
// to it (ONE surface: where a hill meets a flank the two merge with a fillet, so the slopes run into each other), and
// beyond them the far peaks, which are not here at all: the page paints them, under the plate.
//
// World units are canvas pixels on the z = 0 plane: x right, y up (y = canvas.h - pixel y), z toward the camera.

// ------------------------------------------------------------------ noise (seeded; the mock's)
function hash2(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
export function vnoise(x, y, s = 0) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}
export function fbm(x, y, oct = 4, s = 0) {
  let a = 0.5, t = 0, f = 1
  for (let i = 0; i < oct; i++) {
    t += a * vnoise(x * f, y * f, s + i * 17)
    f *= 2.03
    a *= 0.5
  }
  return t / (1 - Math.pow(0.5, oct))
}
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
export function smooth(e0, e1, x) {
  const t = sat((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}
const lerp = (a, b, t) => a + (b - a) * t
const ridged = (n) => 1 - Math.abs(2 * n - 1)

/** A seeded stream of numbers in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

/** The union of two surfaces (larger z is nearer), with a fillet about `k` wide where they meet. */
export function smax(a, b, k) {
  const h = sat(0.5 + (0.5 * (b - a)) / k)
  return a + (b - a) * h + k * h * (1 - h)
}

// ------------------------------------------------------------------ the outline
/**
 * The mountain's silhouette as one closed polygon in canvas pixels, in the order MountDeathfire.vue's buildSilhouette
 * fills it: up the left flank from its foot, the rim, the crown, the rim, down the right flank. Below each foot the
 * page drops straight off the bottom of its window; a plate has bleed there, so each flank carries on along its last
 * segment to just below the canvas instead (that part is only ever seen in a cover-fit crop).
 */
export function outline(m, canvas) {
  const bottom = canvas.h + 4
  const foot = (pts) => {
    const a = pts[pts.length - 2], b = pts[pts.length - 1]
    const dy = b.y - a.y
    if (dy <= 1e-6 || b.y >= bottom) return { x: b.x, y: Math.max(b.y, bottom) }
    const t = (bottom - b.y) / dy
    const x = b.x + (b.x - a.x) * t
    return { x: Math.max(-canvas.w, Math.min(2 * canvas.w, x)), y: bottom }
  }
  const poly = [foot(m.left)]
  for (let i = m.left.length - 1; i >= 0; i--) poly.push({ x: m.left[i].x, y: m.left[i].y })
  poly.push({ x: m.rimL.x, y: m.rimL.y })
  for (const p of m.crown) poly.push({ x: p.x, y: p.y })
  poly.push({ x: m.rimR.x, y: m.rimR.y })
  for (const p of m.right) poly.push({ x: p.x, y: p.y })
  poly.push(foot(m.right))
  return poly
}

/** @returns {number[]} where the horizontal line at y crosses the closed polygon, sorted (pairs bound the inside, even-odd) */
export function rowCrossings(poly, y) {
  const xs = []
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n]
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y))
  }
  return xs.sort((p, q) => p - q)
}

/** @returns {boolean} whether (x, y) is inside the closed polygon (even-odd) */
export function insidePoly(poly, x, y) {
  let k = 0
  for (const c of rowCrossings(poly, y)) if (c <= x) k++
  return k % 2 === 1
}

/** @returns {{ d: number, s: number }} the distance from (x, y) to a polyline and the arc length along it to the nearest point */
export function distToPolyline(pts, x, y) {
  let best = Infinity, bestS = 0, acc = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    const ex = b.x - a.x, ey = b.y - a.y
    const L2 = ex * ex + ey * ey
    const L = Math.sqrt(L2)
    let t = L2 > 0 ? ((x - a.x) * ex + (y - a.y) * ey) / L2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const d = Math.hypot(x - a.x - ex * t, y - a.y - ey * t)
    if (d < best) {
      best = d
      bestS = acc + L * t
    }
    acc += L
  }
  return { d: best, s: bestS }
}

const polylineLength = (pts) => pts.reduce((acc, p, i) => (i ? acc + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0)

/**
 * The terraces buildMountain cut into a flank: where the flank steps outward by more than its own curve does from one
 * row to the next. `dir` is -1 for the left flank, 1 for the right.
 * @returns {{ i: number, y: number, out: number }[]} the row the step lands on, its y and how far it steps out (px)
 */
export function terraces(flank, dir, minStep = 6) {
  const out = []
  for (let i = 2; i < flank.length; i++) {
    const step = dir * (flank[i].x - flank[i - 1].x) - Math.max(0, dir * (flank[i - 1].x - flank[i - 2].x))
    if (step > minStep) out.push({ i, y: (flank[i].y + flank[i - 1].y) / 2, out: step })
  }
  return out
}

// ------------------------------------------------------------------ what the hills must leave alone
/** The share of the cone's height, from its tip down, that no hill may cover. */
export const SUMMIT = 0.45

/**
 * The cone's measures in canvas pixels: its tip (the crown's highest point), the reference frame's bottom edge (the floor
 * the cone stands on; below it is only bleed), its height between the two, its half base, the rim's level and the line
 * above which nothing may cover the summit.
 */
export function coneFrame(m, canvas, offset = { x: 0, y: 0 }) {
  const tipY = Math.min(m.peakY, ...m.crown.map((p) => p.y))
  const floorY = canvas.h - offset.y
  const Hm = Math.max(1, floorY - tipY)
  const S = Math.max(1, (m.right[m.right.length - 1].x - m.left[m.left.length - 1].x) / 2)
  return {
    tipY,
    floorY,
    Hm,
    S,
    rimY: (m.rimL.y + m.rimR.y) / 2,
    summitY: tipY + SUMMIT * Hm,
    frame: { x0: offset.x, x1: canvas.w - offset.x, y0: offset.y, y1: floorY },
  }
}

/**
 * The places the live page draws on that no hill may cover: the vent, the lava's streams (`channels`; without them the
 * vent-to-pool line), the pool's ellipse at 1.08 times its size, and the summit (everything above `summitY`).
 */
export function keepOut(m, channels, F) {
  const ch = m.craterHalf
  const lines = channels.length ? channels : m.pool ? [[m.vent, { x: m.pool.cx, y: m.pool.arcTop }]] : []
  return {
    vent: { x: m.vent.x, y: m.vent.y, r: Math.max(12, 0.6 * ch) },
    lines,
    lineR: Math.max(10, 0.3 * ch),
    pool: m.pool ? { cx: m.pool.cx, cy: m.pool.cy, rx: 1.08 * m.pool.rx, ry: 1.08 * m.pool.ry } : null,
    summitY: F.summitY,
  }
}

/** How far (px) a point is clear of every keep-out place; negative inside one. A lower bound near the pool. */
export function keepOutGap(k, x, y) {
  let g = y - k.summitY
  g = Math.min(g, Math.hypot(x - k.vent.x, y - k.vent.y) - k.vent.r)
  for (const line of k.lines) g = Math.min(g, distToPolyline(line, x, y).d - k.lineR)
  if (k.pool) {
    const q = Math.hypot((x - k.pool.cx) / k.pool.rx, (y - k.pool.cy) / k.pool.ry)
    g = Math.min(g, (q - 1) * Math.min(k.pool.rx, k.pool.ry))
  }
  return g
}

/**
 * The skyline of one hill: from the join on the flank out to past the canvas edge, never above the join (so the flank
 * keeps its outline down to it), never into the summit. A shoulder out of the flank, one or two broken massifs, then the
 * long skirt that carries the flank out toward the frame's edge. Small cliffs and a wandering crest; no spires.
 */
function hillSkyline({ J, side, edgeX, floorY, summitY, draws, s0, portrait, S, Hm, step = 3 }) {
  const L = Math.abs(edgeX - J.x)
  const room = Math.max(1, floorY - J.y)
  const pick = (i, a, b) => a + (b - a) * draws[i]
  // the skirt reaches the floor part of the way out, so beyond it the far peaks (the page paints them) stand clear
  // (a quiet hill's shoulder runs out flatter, past the canvas edge before it is down: a ledge the flank steps onto)
  const uEnd = portrait ? pick(1, 1.2, 1.6) : pick(1, 0.5, 0.72)
  const gam = pick(2, 1.25, 1.8)
  // from the join out and down: a rounded shoulder first (nearly level out of the flank), steepening as it goes, the way
  // a volcano's skirt carries its flank down to the plain
  const skirt = (u) => {
    const t = Math.min(1, u / uEnd)
    return 1.08 * (0.35 * t + 0.65 * Math.pow(t, gam))
  }
  // close to the flank nothing stands above the join; beyond that a broad lower peak may stand clear of it (never into
  // the summit), with a saddle between it and the flank
  const gapU = Math.min(0.45, (0.24 * S) / L)
  const rise = portrait ? 0 : Math.max(0, Math.min(pick(5, 0.0, 0.07) * Hm, J.y - summitY - 0.03 * Hm))
  const massif = (c, top, wMin) => {
    const amp = (skirt(c) - top) * room // px it stands above the skirt
    const w = Math.max(wMin, (amp * 1.35) / L) // never steeper than about 50 degrees on its sides
    return { c, top, w }
  }
  const c1 = Math.min(0.6 * uEnd, gapU + pick(3, 0.04, 0.14))
  // a quiet hill (a portrait plate's, or the one on the lava's side) is the shoulder and its skirt alone; a wide plate's
  // other hill has a broad massif near the flank and a lesser one further down the skirt
  const peaks = portrait ? [] : [massif(c1, -rise / room, Math.max(pick(4, 0.07, 0.12), (0.22 * S) / L))]
  if (!portrait) {
    const c2 = Math.min(0.85 * uEnd, c1 + peaks[0].w + pick(6, 0.04, 0.12))
    peaks.push(massif(c2, skirt(c2) - pick(8, 0.1, 0.2), Math.max(pick(7, 0.05, 0.09), (0.14 * S) / L)))
  }
  // small cliffs: the skyline steps down going out
  const cliffs = Array.from({ length: 4 }, (_, k) => ({ u: 0.1 + 0.8 * hash2(k, side + 2, s0 + 87), h: 0.01 + 0.022 * hash2(k, side + 2, s0 + 89) }))
  const n = Math.max(2, Math.ceil(L / step))
  const pts = []
  const ceiling = -(J.y - summitY - 2) / room
  for (let k = 0; k <= n; k++) {
    const u = k / n
    const x = J.x + side * L * u
    let P = skirt(u)
    for (const p of peaks) {
      const t = (u - p.c) / p.w
      if (Math.abs(t) >= 1) continue
      // a rounded massif, its top broken
      const bump = 0.5 + 0.5 * Math.cos(Math.PI * t)
      const top = p.top + 0.035 * (fbm(x / 70, 7.5, 3, s0 + 91) - 0.5)
      P = Math.min(P, lerp(P, top, bump))
    }
    for (const c of cliffs) P += c.h * smooth(c.u, c.u + 0.006, u)
    // broken: a wandering crest and small teeth, faded in from the join so the join is exact
    P += ((fbm(x / 150, 2.5, 4, s0 + 81) - 0.5) * 0.08 + (vnoise(x / 29, 4.5, s0 + 83) - 0.5) * 0.025 + (vnoise(x / 9, 6.5, s0 + 85) - 0.5) * 0.008) * smooth(0, 0.05, u)
    // near the flank, never above the join, and a hair below it at once, so nothing of the hill sits on the flank above
    // the join; further out, never into the summit
    P = u < gapU ? Math.max(P, 0.012 * Math.sqrt(u) + (k ? 0.002 : 0)) : Math.max(P, ceiling, lerp(0.012 * Math.sqrt(gapU), ceiling, smooth(gapU, gapU + 0.08, u)))
    pts.push({ x, y: Math.max(J.y + room * P, summitY + 2) })
  }
  pts[0] = { x: J.x, y: J.y }
  return pts
}

/**
 * Where the hills join the cone, and the ridge in the foreground, from the mountain, the lava and the seed.
 *
 * Hills (`hills`): at most one per side. A side gets one if its flank has a row below the summit line (a portrait plate:
 * in the cone's lower part only) with room out to the canvas edge and clear of the lava; the join is one of the highest
 * such rows, picked by the seed. A portrait plate gets one hill at most, on the side with more room. Each hill's depth
 * falls away from the join (it runs back from the cone), which is what the shader's haze reads.
 *
 * The foreground ridge (`foreground`): on the side away from the pool, rising toward the canvas edge, its crest kept
 * below every keep-out place near its columns.
 *
 * Every draw is made whether or not it is used, so one part's fate never reshuffles another's.
 */
export function planHills({ mountain: m, canvas, channels = [], seed = 0, bucket = 'wide', offset = { x: 0, y: 0 } }) {
  const F = coneFrame(m, canvas, offset)
  const K = keepOut(m, channels, F)
  const rng = mulberry32(((seed >>> 0) ^ 0x4d415353) >>> 0)
  const s0 = (seed >>> 0) % 100003
  const portrait = bucket === 'portrait'
  const { Hm, S } = F
  const candidates = []
  for (const side of [1, -1]) {
    const draws = Array.from({ length: 12 }, rng)
    const flank = side > 0 ? m.right : m.left
    const top = portrait ? F.tipY + 0.62 * Hm : F.summitY + 0.05 * Hm
    const bottom = F.floorY - (portrait ? 0.16 : 0.24) * Hm
    const roomOf = (p) => (side > 0 ? canvas.w - p.x : p.x)
    const minRoom = 0.3 * S
    const rows = []
    for (let i = 1; i < flank.length - 1; i++) {
      const p = flank[i]
      if (p.y < top || p.y > bottom || roomOf(p) < minRoom) continue
      if (keepOutGap(K, p.x, p.y) < 0.06 * S) continue
      rows.push(i)
    }
    if (!rows.length) continue
    const i = rows[Math.min(rows.length - 1, Math.floor(draws[0] * Math.min(rows.length, 3)))]
    const J = { x: flank[i].x, y: flank[i].y }
    const edgeX = side > 0 ? canvas.w + 8 : -8
    // on the lava's side the hill stays low and quiet (no peak of its own), so the pool and the streams keep the stage
    const lavaSide = m.pool ? Math.sign(m.pool.cx - m.peakX) === side : false
    const skyline = hillSkyline({ J, side, edgeX, floorY: F.floorY, summitY: F.summitY, draws, s0: s0 + (side > 0 ? 0 : 400), portrait: portrait || lavaSide, S, Hm })
    const zr = (portrait ? 0.7 : 1) * (0.9 + 0.5 * draws[9]) * Hm
    const L = Math.abs(edgeX - J.x)
    // it runs back slowly at first, so its slopes and the flank's meet, then away into the air (by distance from the join,
    // so a short hill near a canvas edge merges as well as a long one)
    const z0 = skyline.map((p) => -zr * Math.pow(Math.min(1, Math.abs(p.x - J.x) / (2.2 * S)), 1.8))
    const bottomY = canvas.h + 40
    const inner = { x: J.x - side * 0.45 * S, y: bottomY }
    const region = [...skyline, { x: edgeX, y: bottomY }, inner]
    candidates.push({ side, join: { i, x: J.x, y: J.y }, skyline, z0, region, zr, slope: 0.9 + 0.4 * draws[10], room: roomOf(J) })
  }
  // a hill whose own part (outside the cone) would sit on a keep-out place is not had
  const poly = outline(m, canvas)
  const clear = (h) => {
    let xa = Infinity, xb = -Infinity, ya = Infinity
    for (const p of h.skyline) (xa = Math.min(xa, p.x)), (xb = Math.max(xb, p.x)), (ya = Math.min(ya, p.y))
    for (let y = ya; y < canvas.h; y += 6) {
      const xs = rowCrossings(h.region, y)
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.max(xa, xs[k]); x <= Math.min(xb, xs[k + 1]); x += 6) if (!insidePoly(poly, x, y) && keepOutGap(K, x, y) < 2) return false
    }
    return true
  }
  let hills = candidates.filter(clear)
  if (portrait && hills.length > 1) hills = [hills.reduce((a, b) => (b.room > a.room ? b : a))]

  return { hills, foreground: planForeground({ m, canvas, F, K, rng, s0, portrait }), frame: F, keep: K }
}

function planForeground({ m, canvas, F, K, rng, s0, portrait }) {
  const W = canvas.w
  const d = Array.from({ length: 6 }, rng)
  const side = m.pool ? (m.pool.cx < W / 2 ? 1 : -1) : m.peakX < W / 2 ? 1 : -1
  // the lowest keep-out point near each column: the crest stays below it
  const margin = 0.03 * W
  const lowest = new Float32Array(W + 1).fill(-Infinity)
  const avoid = [m.vent]
  if (K.pool) for (let t = 0; t < 128; t++) avoid.push({ x: K.pool.cx + K.pool.rx * Math.cos((t / 128) * 2 * Math.PI), y: K.pool.cy + K.pool.ry * Math.sin((t / 128) * 2 * Math.PI) })
  for (const line of K.lines)
    for (let i = 0; i < line.length - 1; i++) for (let f = 0; f < 1; f += 0.2) avoid.push({ x: line[i].x + (line[i + 1].x - line[i].x) * f, y: line[i].y + (line[i + 1].y - line[i].y) * f + K.lineR })
  for (const p of avoid) for (let x = Math.max(0, Math.floor(p.x - margin)); x <= Math.min(W, Math.ceil(p.x + margin)); x++) lowest[x] = Math.max(lowest[x], p.y)
  const frameH = F.floorY - F.frame.y0
  const rise = (0.09 + 0.04 * d[0]) * Math.min(F.Hm, frameH * 0.9) * (portrait ? 0.8 : 1)
  const start = (portrait ? 0.56 : 0.5) + 0.1 * d[1]
  const boulders = Array.from({ length: 5 }, (_, k) => ({ u: start + 0.08 + (0.85 - start) * ((k + d[(k + 2) % 6]) / 5), w: 0.012 + 0.02 * d[(k + 3) % 6], h: 0.05 + 0.08 * d[(k + 4) % 6] }))
  const crest = []
  for (let x = -8; x <= W + 8; x += 3) {
    const u = side > 0 ? x / W : 1 - x / W // 0 on the pool's side, 1 at the far edge
    const k = smooth(start, start + 0.3, u)
    if (k <= 0.001) continue
    let shape = 0.78 + 0.32 * fbm(x / 260, 5.5, 3, s0 + 71) - 0.12 * smooth(0.85, 1, u)
    for (const b of boulders) shape += b.h * Math.sqrt(Math.max(0, 1 - Math.pow((u - b.u) / b.w, 2)))
    const jag = (vnoise(x / 31, 8.8, s0 + 73) - 0.5) * 0.08 + (vnoise(x / 9, 9.9, s0 + 75) - 0.5) * 0.03
    // it rises out of the bottom bleed, not off the frame's floor line
    const foot = F.floorY + (canvas.h + 12 - F.floorY) * (1 - smooth(0, 0.45, k))
    let y = foot - rise * k * (shape + jag)
    const keep = lowest[Math.max(0, Math.min(W, Math.round(x)))]
    if (Number.isFinite(keep)) y = Math.max(y, keep + 0.03 * F.Hm)
    y = Math.max(y, F.summitY + 2)
    if (y < canvas.h + 2) crest.push({ x, y })
  }
  if (crest.length < 4) return null
  if (side < 0) crest.reverse() // left to right
  const bottom = canvas.h + 40
  const region = [{ x: crest[0].x, y: bottom }, ...crest, { x: crest[crest.length - 1].x, y: bottom }]
  return { side, crest, region, z0: 0.3, rise }
}

// ------------------------------------------------------------------ grids
// A grid of vertices every `cell` px over [x0, x1] x [y0, y1], the last column and row on the far edges.
function makeGrid(x0, x1, y0, y1, cell) {
  const nx = Math.max(2, Math.ceil((x1 - x0) / cell) + 1)
  const ny = Math.max(2, Math.ceil((y1 - y0) / cell) + 1)
  const xs = new Float32Array(nx), ys = new Float32Array(ny)
  for (let i = 0; i < nx; i++) xs[i] = Math.min(x1, x0 + i * cell)
  for (let j = 0; j < ny; j++) ys[j] = Math.min(y1, y0 + j * cell)
  return { x0, y0, nx, ny, cell, xs, ys, N: nx * ny }
}

// The distance from each vertex to the segments of `pts` (closed or not), out to `band` px; Infinity beyond.
function stampDistance(dist, g, pts, closed, band) {
  const n = pts.length
  const last = closed ? n : n - 1
  for (let s = 0; s < last; s++) {
    const a = pts[s], b = pts[(s + 1) % n]
    const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - band - g.x0) / g.cell))
    const i1 = Math.min(g.nx - 1, Math.ceil((Math.max(a.x, b.x) + band - g.x0) / g.cell))
    const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - band - g.y0) / g.cell))
    const j1 = Math.min(g.ny - 1, Math.ceil((Math.max(a.y, b.y) + band - g.y0) / g.cell))
    if (i0 > i1 || j0 > j1) continue
    const ex = b.x - a.x, ey = b.y - a.y
    const L2 = ex * ex + ey * ey || 1e-9
    for (let j = j0; j <= j1; j++) {
      const y = g.ys[j]
      for (let i = i0; i <= i1; i++) {
        const x = g.xs[i]
        let t = ((x - a.x) * ex + (y - a.y) * ey) / L2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const dx = x - a.x - ex * t, dy = y - a.y - ey * t
        const d2 = dx * dx + dy * dy
        const k = j * g.nx + i
        if (d2 < dist[k]) dist[k] = d2
      }
    }
  }
}
function finishDistance(dist, band) {
  for (let k = 0; k < dist.length; k++) dist[k] = dist[k] < band * band ? Math.sqrt(dist[k]) : Infinity
}

// Inside flags for a closed polygon, row by row.
function fillInside(inside, g, poly, value = 1) {
  for (let j = 0; j < g.ny; j++) {
    const xs = rowCrossings(poly, g.ys[j])
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.cell))
      const i1 = Math.min(g.nx - 1, Math.floor((xs[k + 1] - g.x0) / g.cell))
      for (let i = i0; i <= i1; i++) inside[j * g.nx + i] = value
    }
  }
}

// The rounded edge of a body: 0 a quarter-circle of radius rho in from the edge (and on in), falling to -rho at the edge,
// so the surface turns away there (its normal at right angles to the view: the limb), then away behind it outside.
function edgeRound(d, rho) {
  if (d >= rho) return 0
  if (d >= 0) return -(rho - Math.sqrt(d * (2 * rho - d)))
  return -rho + 2 * d
}

// a value along a polyline sampled at even x steps (a skyline), by x; clamped at the ends
function alongX(pts, vals, x) {
  const n = pts.length
  const x0 = pts[0].x, x1 = pts[n - 1].x
  const t = ((x - x0) / (x1 - x0 || 1)) * (n - 1)
  if (t <= 0) return vals(0)
  if (t >= n - 1) return vals(n - 1)
  const i = Math.floor(t), f = t - i
  return lerp(vals(i), vals(i + 1), f)
}

// box blur of a field, `r` cells each way, twice
function blurField(src, g, r) {
  const { nx, ny } = g
  const tmp = new Float32Array(src.length)
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < ny; j++) {
      const row = j * nx
      for (let i = 0; i < nx; i++) {
        let s = 0
        for (let d = -r; d <= r; d++) s += src[row + Math.min(nx - 1, Math.max(0, i + d))]
        tmp[row + i] = s / (2 * r + 1)
      }
    }
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let s = 0
        for (let d = -r; d <= r; d++) s += tmp[Math.min(ny - 1, Math.max(0, j + d)) * nx + i]
        src[j * nx + i] = s / (2 * r + 1)
      }
  }
}

// ------------------------------------------------------------------ light on the relief
const MOON = (() => {
  const v = [-0.6, 0.72, -0.2]
  const l = Math.hypot(...v)
  return v.map((c) => c / l)
})()

/**
 * Ambient occlusion and the moon's shadow, from the depth field itself.
 *
 * Occlusion: for each vertex, how far the ground around it (out to `reach` px, eight ways) rises above the plane tangent
 * to it: the inside of a gully or a crease is shut in, a rib's crest is open. Shadow: a march toward the moon across the
 * field; the vertex is in shadow where the march passes behind the surface (within `thick` px of it, so a body far in
 * front does not shadow everything behind it). Both 0 (dark) to 1 (open, lit).
 */
function shadeField(z, g, inside, { reach, thick, march, light = MOON }) {
  const { nx, ny, cell } = g
  const ao = new Float32Array(g.N).fill(1)
  const vis = new Float32Array(g.N).fill(1)
  const at = (i, j) => z[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))]
  const bil = (fx, fy) => {
    const i = Math.floor(fx), j = Math.floor(fy)
    const tx = fx - i, ty = fy - j
    return lerp(lerp(at(i, j), at(i + 1, j), tx), lerp(at(i, j + 1), at(i + 1, j + 1), tx), ty)
  }
  const dirs = []
  for (let a = 0; a < 8; a++) dirs.push([Math.cos((a / 8) * 2 * Math.PI + 0.3), Math.sin((a / 8) * 2 * Math.PI + 0.3)])
  const radii = [1, 2, 4, 7, 11, 16].map((r) => r * (reach / 16) / cell).filter((r) => r >= 0.75)
  // the march: screen x follows light x, screen y (down) follows -light y; depth changes by light z per unit
  const lxy = Math.hypot(light[0], light[1])
  const sx = light[0] / lxy, sy = -light[1] / lxy
  const dzds = light[2] / lxy // depth per px of screen travel
  const stepPx = Math.max(1, 1.5 * cell)
  const nSteps = Math.ceil(march / stepPx)
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      if (!inside[k]) continue
      const z0 = z[k]
      const gxz = (at(i + 1, j) - at(i - 1, j)) / 2, gyz = (at(i, j + 1) - at(i, j - 1)) / 2 // per cell
      let occ = 0
      for (const [dx, dy] of dirs) {
        let h = 0
        for (const r of radii) {
          const rel = bil(i + dx * r, j + dy * r) - z0 - (gxz * dx + gyz * dy) * r
          const s = rel / (r * cell)
          if (s > h) h = s
        }
        occ += h / Math.sqrt(1 + h * h)
      }
      ao[k] = 1 - occ / 8
      let pen = 0
      for (let n = 1; n <= nSteps; n++) {
        const s = n * stepPx
        const zs = bil(i + (sx * s) / cell, j + (sy * s) / cell)
        const zr = z0 + dzds * s + 0.6
        const p = zs - zr
        if (p > pen && p < thick) pen = p
      }
      vis[k] = 1 - smooth(0, 6, pen)
    }
  return { ao, vis }
}

// ------------------------------------------------------------------ the world
const BAND = 72 // px: how far out the exact distance to an outline is kept

/**
 * Everything the scene needs, from the mountain in canvas pixels.
 *
 * `channels` are the lava's streams (polylines in canvas pixels); without them the vent-to-pool line stands in. `seed`
 * is the only source of noise. `cell` is the grids' spacing in pixels. `connected: false` leaves the hills and the
 * foreground ridge out (the cone alone). `offset` is the bleed (the reference frame's corner in the canvas).
 */
export function buildWorld({ mountain: m, canvas, channels = [], seed = 0, cell = 2, depth = 3, bucket = 'wide', offset = { x: 0, y: 0 }, connected = true }) {
  const W = canvas.w, H = canvas.h
  const D = depth * H // camera distance: 1 world unit = 1 px on z = 0
  const s0 = (seed >>> 0) % 100003
  const poly = outline(m, canvas)
  const plan = connected ? planHills({ mountain: m, canvas, channels, seed, bucket, offset }) : { hills: [], foreground: null, frame: coneFrame(m, canvas, offset), keep: null }
  const F = plan.frame
  const K = plan.keep ?? keepOut(m, channels, F)
  const { tipY, Hm, S, floorY } = F
  const ch = m.craterHalf
  const rimY = F.rimY
  const unit = S / 30 // the mock's world unit, so its noise and texture scales carry over
  const hills = plan.hills

  // ---------------------------------------------------------------- the body grid: the cone and its hills
  let top = Math.min(...poly.map((p) => p.y))
  for (const h of hills) for (const p of h.skyline) top = Math.min(top, p.y)
  const g = makeGrid(0, W, Math.max(0, Math.floor(top / cell) * cell - 4 * cell), H, cell)
  const { nx, ny, N } = g

  // the cone: inside, and the exact distance to its outline near it
  const insideC = new Uint8Array(N)
  fillInside(insideC, g, poly)
  // (not the closing edge between the two feet, below the canvas: that is no edge of the mountain's, and rounding the
  // rock away from it would darken the bottom of the plate)
  const distC = new Float32Array(N).fill(Infinity)
  stampDistance(distC, g, poly, false, BAND)
  finishDistance(distC, BAND)

  // the crests: their tips (the crown's highest point either side of the vent) and which is the tall one
  const crestTip = (side) => m.crown.filter((p) => Math.sign(p.x - m.vent.x) === side).reduce((a, p) => (!a || p.y < a.y ? p : a), null)
  const tips = { [-1]: crestTip(-1) ?? { x: m.rimL.x, y: m.rimL.y }, [1]: crestTip(1) ?? { x: m.rimR.x, y: m.rimR.y } }
  const tallSide = tips[-1].y < tips[1].y ? -1 : 1
  const stubTipY = Math.max(tips[-1].y, tips[1].y) // above it only the tall crest's span remains
  const crestOf = (side) => ({
    side,
    tall: side === tallSide,
    tip: tips[side],
    ta: 0.42 + 0.16 * hash2(side + 3, 1, s0 + 101),
    kappa: 1.7 + 0.5 * hash2(side + 3, 2, s0 + 101),
    strips: 4 + Math.floor(3 * hash2(side + 3, 3, s0 + 101)),
  })
  const crests = { [-1]: crestOf(-1), [1]: crestOf(1) }

  // the cone's rows: each row's main span (first to last crossing), smoothed down the slope, for the ribs' frame
  const rowC = new Float32Array(ny), rowR = new Float32Array(ny)
  const rowSpans = new Array(ny)
  for (let j = 0; j < ny; j++) {
    const xs = rowCrossings(poly, g.ys[j])
    rowSpans[j] = xs
    if (xs.length >= 2) {
      rowC[j] = (xs[0] + xs[xs.length - 1]) / 2
      rowR[j] = (xs[xs.length - 1] - xs[0]) / 2
    } else {
      rowC[j] = m.peakX
      rowR[j] = ch
    }
  }
  // the rim row's values carry up through the crown (the ribs fade there); then smooth over about 3 percent of the height
  const jRim = Math.max(0, Math.min(ny - 1, Math.round((Math.max(rimY, m.vent.y) + 0.15 * ch - g.y0) / cell)))
  for (let j = 0; j < jRim; j++) (rowC[j] = rowC[jRim]), (rowR[j] = rowR[jRim])
  {
    const r = Math.max(1, Math.round((0.03 * Hm) / cell))
    const sm = (arr) => {
      const out = new Float32Array(ny)
      for (let j = 0; j < ny; j++) {
        let s = 0, n = 0
        for (let d = -r; d <= r; d++) {
          const jj = j + d
          if (jj < 0 || jj >= ny) continue
          s += arr[jj]
          n++
        }
        out[j] = s / n
      }
      return out
    }
    rowC.set(sm(rowC))
    rowR.set(sm(rowR))
  }
  const terr = [...terraces(m.left, -1).map((t) => ({ ...t, dir: -1 })), ...terraces(m.right, 1).map((t) => ({ ...t, dir: 1 }))]
  const flankX = (flank, y) => {
    for (let i = 1; i < flank.length; i++) {
      const a = flank[i - 1], b = flank[i]
      if (y <= b.y) return a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y || 1)
    }
    return flank[flank.length - 1].x
  }

  const K1 = 6.5 + 1.5 * hash2(7, 7, s0) // main ribs per radian of the cone's turn
  const K2 = K1 * 2.35
  const zC = new Float32Array(N) // the cone's surface (falls away outside it)
  const baseC = new Float32Array(N) // the same without relief, for the shading's large-scale form
  const crestW = new Float32Array(N) // 1 on the crown's blades

  // each row's span a circle seen edge on (a cone's cross-section), so the limbs turn away and the middle comes forward.
  // Where the outline steps out (a terrace), or the crests' two spans become the cone's one under the breach, a row's span
  // jumps, and with it the whole row: the rows are smoothed down the slope, so a step in the outline is a step at the
  // edge and not a seam across the face.
  const zRow = new Float32Array(N)
  for (let j = 0; j < ny; j++) {
    const xs = rowSpans[j]
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const a = xs[q], b = xs[q + 1]
      const Rs = Math.max(0.5, (b - a) / 2)
      const i0 = Math.max(0, Math.ceil((a - g.x0) / cell)), i1 = Math.min(nx - 1, Math.floor((b - g.x0) / cell))
      for (let i = i0; i <= i1; i++) {
        const dr = Math.min(g.xs[i] - a, b - g.xs[i])
        zRow[j * nx + i] = 0.8 * Math.sqrt(Math.max(0, dr * (2 * Rs - dr)))
      }
    }
  }
  {
    const r = Math.max(1, Math.round((0.022 * Hm) / cell))
    const from = 0
    const col = new Float32Array(ny)
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) col[j] = zRow[j * nx + i]
      for (let j = from; j < ny; j++) {
        let s = 0, wsum = 0
        for (let d = -r; d <= r; d++) {
          const jj = j + d
          if (jj < from || jj >= ny) continue
          const wgt = 1 - Math.abs(d) / (r + 1)
          s += col[jj] * wgt
          wsum += wgt
        }
        zRow[j * nx + i] = s / wsum
      }
    }
  }

  for (let j = 0; j < ny; j++) {
    const y = g.ys[j]
    const xs = rowSpans[j]
    const rho = 3 + 26 * smooth(0.02, 0.55, (y - tipY) / Hm)
    const v = (y - rimY) / Math.max(1, floorY - rimY)
    const R = Math.max(1, rowR[j]), c = rowC[j]
    const wBlade = smooth(rimY + 0.2 * ch, rimY - 0.45 * ch, y)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      const x = g.xs[i]
      const d = Number.isFinite(distC[k]) ? (insideC[k] ? distC[k] : -distC[k]) : insideC[k] ? BAND : -BAND
      if (!insideC[k]) {
        zC[k] = edgeRound(d, rho)
        baseC[k] = zC[k]
        continue
      }
      // the span this vertex is in
      let a = x, b = x
      for (let q = 0; q + 1 < xs.length; q += 2)
        if (x >= xs[q] && x <= xs[q + 1]) {
          a = xs[q]
          b = xs[q + 1]
          break
        }
      let zb = zRow[k]

      // the crown: each crest a blade with an arete, its faces broken into vertical fracture planes, the tall one's top
      // snapped off, thicker toward its root; under the rim it hands over to the cone's own rows
      let wB = 0
      if (wBlade > 0 && (xs.length >= 4 || y < stubTipY)) {
        const side = (a + b) / 2 < m.vent.x ? -1 : 1
        const cr = crests[side]
        const wsp = Math.max(1, b - a)
        const t = (x - a) / wsp
        const ta = cr.ta + 0.1 * (vnoise(y / (0.9 * ch), side * 7.1, s0 + 91) - 0.5)
        const tri = t < ta ? t / ta : (1 - t) / (1 - ta)
        const up = sat((rimY - y) / Math.max(1, rimY - cr.tip.y)) // 0 at the rim, 1 at the tip
        let blade = cr.kappa * 0.5 * wsp * Math.pow(Math.max(0, tri), 0.85) * (1.5 - 0.6 * up)
        const fs = t * cr.strips + 0.35 * (vnoise(y / (1.1 * ch), side * 3.3, s0 + 93) - 0.5)
        const fi = Math.floor(fs), ff = fs - fi
        const tilt = (hash2(fi, side + 5, s0 + 95) - 0.5) * 1.8
        blade += tilt * (ff - 0.5) * (wsp / cr.strips) * smooth(0, 0.1, ff) * smooth(1, 0.9, ff) * 2
        if (cr.tall) {
          // the snapped top: a plane facing up and toward the camera, cut across the blade's last stretch
          const dt = Math.hypot((x - cr.tip.x) / (0.7 * ch), (y - cr.tip.y) / (1.1 * ch))
          const zs = 0.12 * ch + (y - cr.tip.y) * 0.95 + side * (cr.tip.x - x) * 0.3
          blade = lerp(blade, Math.min(blade, zs), smooth(1.25, 0.55, dt))
        }
        wB = wBlade
        zb = lerp(zb, Math.max(0, blade), wB)
      }
      const rhoHere = lerp(rho, 3.5, wB)
      const er = edgeRound(d, rhoHere)
      let base = zb + er
      let dz = 0

      // ribs and gullies down the fall line: straight down the cone's turn (constant azimuth), irregular in spacing,
      // slow to change along their length, the second order appearing lower down between the first
      const t = Math.max(-0.985, Math.min(0.985, (x - c) / R))
      const phi = Math.asin(t)
      const fall = smooth(0.0, 0.08, v) * (1 - wB)
      if (fall > 0) {
        const warp = (fbm(v * 1.3, phi * 0.9 + 3.1, 3, s0 + 5) - 0.5) * 0.55
        const n1 = vnoise(phi * K1 + warp + 11.3, v * 1.6, s0 + 7)
        const sharp = 1.3 + 1.7 * vnoise(phi * K1 * 0.37 + 2.2, v * 2.3, s0 + 9)
        const life = 0.4 + 0.6 * smooth(0.2, 0.7, vnoise(phi * K1 * 0.55 + 5.5, v * 3.1, s0 + 13))
        const spacing = (R * Math.sqrt(1 - t * t)) / K1
        dz += (Math.pow(ridged(n1), sharp) - 0.42) * 0.05 * R * life * fall * smooth(5, 14, spacing)
        const n2 = vnoise(phi * K2 + warp * 1.6 + 4.7, v * 3.2, s0 + 8)
        dz += (Math.pow(ridged(n2), 2) - 0.4) * 0.022 * R * smooth(0.1, 0.45, v) * smooth(5, 12, (spacing * K1) / K2) * fall
      }
      // broad lumps (smooth: the fine grain is the shader's)
      dz += (fbm(x / (4 * unit), y / (4 * unit), 4, s0 + 21) - 0.5) * 0.025 * Hm * (1 - 0.7 * wB)

      // where the flank's outline steps out (buildMountain's terraces), a buttress of the same rock comes down from the
      // step along the flank: a broad lump, not a shelf across the face
      for (const tr of terr) {
        const fx = flankX(tr.dir < 0 ? m.left : m.right, tr.y + 0.5 * tr.out)
        const across = tr.dir * (fx - x) // px in from that flank's edge
        const w = 1.6 * tr.out + 0.04 * S
        if (across < -cell || across > 2.5 * w || y < tr.y - w) continue
        const along = smooth(tr.y - 0.6 * w, tr.y + 0.6 * w, y) * smooth(tr.y + 7 * w, tr.y + 2 * w, y)
        dz += along * Math.exp(-Math.pow(across / w - 0.8, 2) * 1.6) * Math.min(tr.out, 0.05 * S) * 0.9
      }
      crestW[k] = wB
      baseC[k] = base
      zC[k] = base + dz * smooth(0, 2 * cell, d)
    }
  }

  // ---------------------------------------------------------------- the hills, merged into the cone
  const z = new Float32Array(zC)
  const base = new Float32Array(baseC)
  const own = new Float32Array(N) // how much of the surface is a hill's (0 the cone)
  const haze = new Float32Array(N)
  const insideAny = new Uint8Array(insideC)
  const kMerge = 0.14 * S // the fillet where a hill meets the cone: a broad hollow, not a fold
  const chanD = channelDistance(K, g, 8) // coarse, for the keep-outs and the glow
  hills.forEach((h, hi) => {
    const inside = new Uint8Array(N)
    fillInside(inside, g, h.region)
    const dist = new Float32Array(N).fill(Infinity)
    stampDistance(dist, g, h.skyline, false, BAND)
    finishDistance(dist, BAND)
    const sk = h.skyline
    const skyY = (x) => (h.side * (x - h.join.x) <= 0 ? h.join.y : alongX(sk, (n) => sk[n].y, x))
    const zOf = (x) => (h.side * (x - h.join.x) <= 0 ? 0 : alongX(sk, (n) => h.z0[n], x))
    // a smoothed skyline for the body's slope, so the face does not ripple with every tooth of the crest
    const smoothSky = (x) => {
      let s = 0
      for (let q = -4; q <= 4; q++) s += skyY(x + q * 12)
      return s / 9
    }
    const lam0 = (0.045 + 0.02 * hash2(hi, 1, s0 + 141)) * S // the gullies' spacing near the join
    const Rmax = 0.3 * S // how far in from a hill's own edge its body has rounded fully forward
    const coneEdgeAt = (j) => {
      const cx = rowSpans[j]
      return cx.length >= 2 ? (h.side > 0 ? cx[cx.length - 1] : cx[0]) : h.side > 0 ? -Infinity : Infinity
    }
    // the body: each row's run of the hill rounds forward from its ends, like the cone's rows, so every massif has limbs
    // that turn away; the end toward the cone does not (there the hill runs on into the cone's flank). Smoothed down the
    // slope, as the cone's rows are, so the rows where a massif's own run joins the skirt's leave no seam.
    const bulgeArr = new Float32Array(N)
    for (let j = 0; j < ny; j++) {
      const rx = rowCrossings(h.region, g.ys[j])
      const coneEdge = coneEdgeAt(j)
      for (let q = 0; q + 1 < rx.length; q += 2) {
        const a = rx[q], b = rx[q + 1]
        const nearEnd = h.side > 0 ? a : b
        const coneSide = h.side > 0 ? nearEnd <= coneEdge + 1 : nearEnd >= coneEdge - 1
        const Rc = Math.max(1, Math.min(coneSide ? b - a : (b - a) / 2, Rmax))
        const i0 = Math.max(0, Math.ceil((a - g.x0) / cell)), i1 = Math.min(nx - 1, Math.floor((b - g.x0) / cell))
        for (let i = i0; i <= i1; i++) {
          const x = g.xs[i]
          const dr = coneSide ? (h.side > 0 ? b - x : x - a) : Math.min(x - a, b - x)
          const drc = Math.min(dr, Rc)
          bulgeArr[j * nx + i] = 0.85 * Math.sqrt(Math.max(0, drc * (2 * Rc - drc)))
        }
      }
    }
    {
      const r = Math.max(1, Math.round((0.03 * Hm) / cell))
      const col = new Float32Array(ny)
      const ins = new Uint8Array(ny)
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) (col[j] = bulgeArr[j * nx + i]), (ins[j] = inside[j * nx + i])
        for (let j = 0; j < ny; j++) {
          if (!ins[j]) continue
          let s = 0, wsum = 0
          for (let d = -r; d <= r; d++) {
            const jj = j + d
            if (jj < 0 || jj >= ny || !ins[jj]) continue
            const wgt = 1 - Math.abs(d) / (r + 1)
            s += col[jj] * wgt
            wsum += wgt
          }
          bulgeArr[j * nx + i] = s / wsum
        }
      }
    }
    for (let j = 0; j < ny; j++) {
      const y = g.ys[j]
      // the cone's edge smoothed down the slope (its terrace steps would otherwise jump the hill's depth row by row)
      const coneEdge = rowSpans[j].length >= 2 ? rowC[j] + h.side * rowR[j] : h.side > 0 ? -Infinity : Infinity
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i
        const x = g.xs[i]
        const dRaw = dist[k]
        if (!inside[k] && !Number.isFinite(dRaw)) continue
        const z0 = zOf(x)
        const far = sat(-z0 / h.zr)
        if (!inside[k]) {
          // above the skyline: falling away behind it, for the normals along the crest
          const zOut = z0 + edgeRound(-dRaw, 14)
          if (zOut > z[k]) z[k] = zOut
          continue
        }
        const d = Number.isFinite(dRaw) ? dRaw : BAND
        const dv = Math.max(0, y - smoothSky(x))
        const rho = 10 + 18 * (1 - far)
        const bulge = bulgeArr[k]
        // at the cone's limb the hill is level with it (they meet in a hollow down the flank); it comes forward only as
        // it gets clear of the cone, so inside the cone's outline it never stands in front for more than a few px
        const out = h.side * (x - coneEdge)
        const clear = smooth(-0.04 * S, 0.3 * S, Number.isFinite(out) ? out : 0.3 * S)
        let zh = z0 + (h.slope * dv + bulge) * clear + edgeRound(d, rho)
        const zBase = zh
        // spurs coming down from the skyline, leaning away from the cone as they fall, more marked lower down; gullies
        // between them that start and stop; lumps. Finer and fainter further back.
        const lamS = 0.11 * S * (1 - 0.35 * far)
        const lean = x - h.side * 0.35 * dv
        const spur = ridged(vnoise(lean / lamS + 0.5 * (fbm(lean / (4 * lamS), dv / (5 * lamS), 2, s0 + 161 + hi) - 0.5), dv / (3.2 * lamS), s0 + 163 + hi))
        zh += (Math.pow(spur, 1.4) - 0.4) * 0.42 * lamS * smooth(0, 1.2 * lamS, dv)
        const lam = lam0 * (1 - 0.45 * far)
        const warp = (fbm(lean / (9 * lam), dv / (10 * lam), 3, s0 + 151 + hi) - 0.5) * 0.8
        const n = vnoise(lean / lam + warp, dv / (3.5 * lam), s0 + 153 + hi)
        const runs = smooth(0.3, 0.65, vnoise(lean / (2 * lam), dv / (2.5 * lam), s0 + 165 + hi))
        let dz = (Math.pow(ridged(n), 1.7) - 0.42) * 0.26 * lam * smooth(0, 3 * lam, dv) * runs
        dz += (fbm(x / (3.2 * lam), y / (3.2 * lam), 4, s0 + 155 + hi) - 0.5) * 1.4 * lam
        zh += dz * smooth(0, 2 * cell, d)
        // inside the cone, anywhere near the lava, the vent or the summit the hill stays behind the cone, so the cone's
        // surface is what shows there (the region's inner edge needs nothing: the cone's front is far ahead of the hill by then)
        let push = 0
        if (insideC[k]) {
          const gap = Math.min(keepGapFast(K, chanD, g, i, j, x, y), y - F.summitY)
          push = (1 - smooth(4, 0.08 * S, gap)) * 2 * Hm
        }
        zh -= push
        // outside the cone the hill is the only ground; the cone's fall-away beyond its outline only counts right at it
        let before = z[k]
        if (!insideC[k]) before -= 1e4 * smooth(kMerge, 2 * kMerge, Number.isFinite(distC[k]) ? distC[k] : Infinity)
        const hw = sat(0.5 + (0.5 * (zh - before)) / kMerge)
        z[k] = smax(before, zh, kMerge)
        base[k] = lerp(base[k], zBase - push, hw)
        own[k] = Math.max(own[k], hw)
        // the air between: some even at the join (a hill stands back from the cone's front), more the further it runs
        haze[k] = Math.max(haze[k] * (1 - hw), hw * (0.22 + 0.78 * far) * smooth(0, 0.25 * S, x * h.side - h.join.x * h.side + 0.1 * S))
        insideAny[k] = 1
      }
    }
  })

  // ---------------------------------------------------------------- glow, the pool, the vent
  const pool = m.pool ?? null
  const streams = K.lines.map((pts, kk) => ({ pts, len: polylineLength(pts) || 1, main: kk === 0 }))
  const glowC = coarseGlow(streams, g, 8, Hm)
  const glow = new Float32Array(N)
  const poolMask = new Float32Array(N)
  const gi = (field, i, j) => sampleCoarse(field, g, i, j)
  for (let j = 0; j < ny; j++) {
    const y = g.ys[j]
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      if (!insideAny[k]) continue
      const x = g.xs[i]
      let gl = gi(glowC, i, j)
      // the vent's own light on the crown and the mouth
      gl = Math.max(gl, 0.9 * Math.exp(-Math.hypot((x - m.vent.x) / 1.2, y - m.vent.y) / (0.75 * ch)))
      // the pool: the same rock, slightly sunk, lit warm by the lake around and above it. The live lake is drawn over it
      // and may come out a little smaller or larger than this ellipse, so nothing here draws an edge; the light stays
      // near the lake's middle in x, so it does not smear along the cone's foot.
      let pw = 0
      if (pool) {
        const q = Math.hypot((x - pool.cx) / pool.rx, (y - pool.cy) / pool.ry)
        pw = 1 - smooth(0.7, 1.15, q)
        z[k] -= 0.012 * Hm * pw
        const above = Math.max(0, pool.arcTop - y)
        const across = Math.exp(-Math.pow((x - pool.cx) / (0.62 * pool.rx), 2))
        const halo = Math.exp(-Math.max(q - 0.9, 0) / 0.5) * Math.exp(-above / (0.07 * Hm)) * across
        gl = Math.max(gl, 0.5 * halo)
      }
      poolMask[k] = pw
      glow[k] = sat(gl) * (1 - own[k] * 0.85)
    }
  }

  // ---------------------------------------------------------------- shading from the shape
  const { ao, vis } = shadeField(z, g, insideAny, { reach: Math.max(18, 0.045 * S), thick: 0.06 * Hm, march: 0.1 * Hm })

  // ---------------------------------------------------------------- along the rays
  const body = meshOf(g, z, insideAny, D, W, H, cell)
  const relief = new Float32Array(N)
  for (let k = 0; k < N; k++) relief[k] = z[k] - base[k]
  body.field = interleave(N, [glow, poolMask, crestW, own])
  body.shade = interleave(N, [ao, vis, haze, relief])

  // ---------------------------------------------------------------- the foreground ridge: its own mesh, in front
  let fg = null
  if (plan.foreground) fg = buildForeground(plan.foreground, { W, H, D, cell, s0, Hm, S, unit, floorY })

  /** a canvas pixel at depth z (toward the camera), in world units */
  const toWorld = (px, py, zz = 0) => {
    const f = (D - zz) / D
    return { x: W / 2 + (px - W / 2) * f, y: H / 2 + (H - py - H / 2) * f, z: zz }
  }
  const depthAt = (px, py) => {
    const i = Math.round((Math.min(W, Math.max(0, px)) - g.x0) / cell)
    const j = Math.round((Math.min(H, Math.max(g.y0, py)) - g.y0) / cell)
    return z[Math.min(ny - 1, j) * nx + Math.min(nx - 1, i)]
  }

  return {
    canvas: { w: W, h: H },
    camera: { x: W / 2, y: H / 2, z: D, fov: (2 * Math.atan(H / 2 / D) * 180) / Math.PI, near: 1, far: D * 2 },
    unit,
    outline: poly,
    hills,
    foreground: plan.foreground,
    frame: F,
    keep: K,
    grid: g,
    body,
    fg,
    z,
    own,
    insideCone: insideC,
    vent: toWorld(m.vent.x, m.vent.y, depthAt(m.vent.x, m.vent.y) + 0.6 * ch),
    poolLight: pool ? toWorld(pool.cx, pool.arcTop - 0.4 * pool.ry, depthAt(pool.cx, pool.arcTop) + pool.ry) : null,
    moon: MOON,
    sizes: { Hm, S, ch, tipY, floorY, rimY, D },
  }
}

// ------------------------------------------------------------------ helpers of buildWorld
// distance to the lava's lines on a coarse grid (cell `c` px) over the fine grid's extent
function channelDistance(K, g, c) {
  const W = g.xs[g.nx - 1], H = g.ys[g.ny - 1]
  const cg = makeGrid(g.x0, W, g.y0, H, c)
  const d = new Float32Array(cg.N).fill(1e6) // far: finite, so the bilinear read never mixes two infinities into NaN
  for (const line of K.lines) {
    const tmp = new Float32Array(cg.N).fill(Infinity)
    stampDistance(tmp, cg, line, false, 6 * c + K.lineR + 0.1 * (W + H))
    for (let k = 0; k < cg.N; k++) d[k] = Math.min(d[k], Math.sqrt(tmp[k]))
  }
  return { grid: cg, d }
}
function sampleCoarse({ grid: cg, d }, g, i, j) {
  const fx = (g.xs[i] - cg.x0) / cg.cell, fy = (g.ys[j] - cg.y0) / cg.cell
  const i0 = Math.max(0, Math.min(cg.nx - 2, Math.floor(fx))), j0 = Math.max(0, Math.min(cg.ny - 2, Math.floor(fy)))
  const tx = sat(fx - i0), ty = sat(fy - j0)
  const k = j0 * cg.nx + i0
  return lerp(lerp(d[k], d[k + 1], tx), lerp(d[k + cg.nx], d[k + cg.nx + 1], tx), ty)
}
function keepGapFast(K, chanD, g, i, j, x, y) {
  let gap = sampleCoarse(chanD, g, i, j) - K.lineR
  gap = Math.min(gap, Math.hypot(x - K.vent.x, y - K.vent.y) - K.vent.r)
  if (K.pool) gap = Math.min(gap, (Math.hypot((x - K.pool.cx) / K.pool.rx, (y - K.pool.cy) / K.pool.ry) - 1) * Math.min(K.pool.rx, K.pool.ry))
  return gap
}
// the baked glow where the lava will run, on a coarse grid: strongest along each stream, fading with distance down it
function coarseGlow(streams, g, c, Hm) {
  const W = g.xs[g.nx - 1], H = g.ys[g.ny - 1]
  const cg = makeGrid(g.x0, W, g.y0, H, c)
  const out = new Float32Array(cg.N)
  const reach = 0.25 * Hm
  for (const st of streams) {
    let xa = Infinity, xb = -Infinity, ya = Infinity, yb = -Infinity
    for (const p of st.pts) (xa = Math.min(xa, p.x)), (xb = Math.max(xb, p.x)), (ya = Math.min(ya, p.y)), (yb = Math.max(yb, p.y))
    for (let j = 0; j < cg.ny; j++) {
      const y = cg.ys[j]
      if (y < ya - reach || y > yb + reach) continue
      for (let i = 0; i < cg.nx; i++) {
        const x = cg.xs[i]
        if (x < xa - reach || x > xb + reach) continue
        const { d, s } = distToPolyline(st.pts, x, y)
        const heat = (st.main ? 1 : 0.6) * (0.35 + 0.65 * Math.exp(-s / (0.35 * st.len)))
        const v = heat * Math.exp(-Math.pow(d / (0.035 * Hm), 2)) + 0.16 * heat * Math.exp(-d / (0.05 * Hm))
        const k = j * cg.nx + i
        if (v > out[k]) out[k] = v
      }
    }
  }
  return { grid: cg, d: out }
}
function interleave(N, arrays) {
  const n = arrays.length
  const out = new Float32Array(N * n)
  for (let k = 0; k < N; k++) for (let a = 0; a < n; a++) out[k * n + a] = arrays[a][k]
  return out
}
// positions on the camera rays, the plate pixel of each vertex, and the triangles (only cells that touch the inside)
function meshOf(g, z, inside, D, W, H, cell) {
  const { nx, ny, N } = g
  const positions = new Float32Array(N * 3)
  const plate = new Float32Array(N * 2)
  const cx = W / 2, cy = H / 2
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      const X = g.xs[i], Y = H - g.ys[j]
      const f = (D - z[k]) / D
      positions[k * 3] = cx + (X - cx) * f
      positions[k * 3 + 1] = cy + (Y - cy) * f
      positions[k * 3 + 2] = z[k]
      plate[k * 2] = g.xs[i]
      plate[k * 2 + 1] = g.ys[j]
    }
  // a cell is drawn if any vertex within two cells of it is inside
  const near = new Uint8Array(N)
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (!inside[j * nx + i]) continue
      for (let dj = -2; dj <= 2; dj++)
        for (let di = -2; di <= 2; di++) {
          const ii = i + di, jj = j + dj
          if (ii >= 0 && jj >= 0 && ii < nx && jj < ny) near[jj * nx + ii] = 1
        }
    }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6)
  let n = 0
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1
      if (!(near[a] || near[b] || near[c] || near[d])) continue
      // counter-clockwise seen from +z (rows run down the screen, so c is below a)
      idx[n++] = a
      idx[n++] = c
      idx[n++] = b
      idx[n++] = b
      idx[n++] = c
      idx[n++] = d
    }
  return { positions, plate, index: idx.slice(0, n), grid: g }
}

// the foreground ridge: a body of its own in front of everything, near-black, with real relief on its crest
function buildForeground(fgp, { W, H, D, cell, s0, Hm, S, unit }) {
  let xa = Infinity, xb = -Infinity, ya = Infinity
  for (const p of fgp.crest) (xa = Math.min(xa, p.x)), (xb = Math.max(xb, p.x)), (ya = Math.min(ya, p.y))
  const g = makeGrid(Math.max(0, Math.floor(xa / cell) * cell - 4 * cell), Math.min(W, Math.ceil(xb / cell) * cell + 4 * cell), Math.max(0, Math.floor(ya / cell) * cell - 6 * cell), H, cell)
  const { nx, ny, N } = g
  const inside = new Uint8Array(N)
  fillInside(inside, g, fgp.region)
  const dist = new Float32Array(N).fill(Infinity)
  stampDistance(dist, g, fgp.crest, false, BAND)
  finishDistance(dist, BAND)
  const z = new Float32Array(N)
  const base = new Float32Array(N)
  const crest = fgp.crest
  const skyY = (x) => alongX(crest, (n) => crest[n].y, x)
  const smoothSky = (x) => {
    let s = 0
    for (let q = -3; q <= 3; q++) s += skyY(x + q * 10)
    return s / 7
  }
  const z0 = fgp.z0 * D
  const lam = 0.06 * S
  for (let j = 0; j < ny; j++) {
    const y = g.ys[j]
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      const x = g.xs[i]
      const dRaw = dist[k]
      if (!inside[k]) {
        z[k] = z0 + edgeRound(Number.isFinite(dRaw) ? -dRaw : -BAND, 18)
        base[k] = z[k]
        continue
      }
      const d = Number.isFinite(dRaw) ? dRaw : BAND
      const dv = Math.max(0, y - smoothSky(x))
      let zz = z0 + 0.8 * dv + edgeRound(d, 22)
      base[k] = zz
      // big rough relief: boulders and fractured slabs, strongest near the crest
      const nearCrest = 1 - 0.5 * smooth(0, 0.6 * fgp.rise, dv)
      let dz = (fbm(x / (2.2 * lam), y / (2.2 * lam), 5, s0 + 171) - 0.5) * 1.3 * lam
      const fr = vnoise((x + 0.6 * y) / (1.3 * lam), (y - 0.3 * x) / (5 * lam), s0 + 173)
      dz += (Math.pow(ridged(fr), 2.2) - 0.4) * 0.5 * lam
      dz += (vnoise(x / (0.5 * lam), y / (0.5 * lam), s0 + 175) - 0.5) * 0.25 * lam
      zz += dz * nearCrest * smooth(0, 2 * cell, d)
      z[k] = zz
    }
  }
  const { ao, vis } = shadeField(z, g, inside, { reach: Math.max(24, 0.06 * S), thick: 0.08 * Hm, march: 0.12 * Hm })
  const mesh = meshOf(g, z, inside, D, W, H, cell)
  const zeros = new Float32Array(N)
  const ones = new Float32Array(N).fill(1)
  const relief = new Float32Array(N)
  for (let k = 0; k < N; k++) relief[k] = z[k] - base[k]
  mesh.field = interleave(N, [zeros, zeros, zeros, ones])
  mesh.shade = interleave(N, [ao, vis, zeros, relief])
  mesh.z = z
  return mesh
}
