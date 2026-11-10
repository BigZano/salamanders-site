/**
 * Lava channel centrelines turned into triangle strips for the field pass.
 *
 * Pure, so it can be tested without a GL context. A flow is the object
 * `buildFlows` makes in MountDeathfire.vue: `pts` (the centreline), `head`
 * (true for the sheet), `heat`, and `widthAt(s)` giving the channel's width in
 * pixels at `s` along it (0 at the vent, 1 at the toe).
 *
 * Each channel gets two strips. The channel strip runs bank to bank at `across`
 * -1 and +1. The levee strip is a wider ring at `across` -levee and +levee, so
 * the shader has room to draw the crust the sim grows on the outer rows (1.25
 * half widths: room for the bank feather, no painted rubble). The levee keeps
 * the channel's `halfWidth` so the shader can turn `across` back into a distance
 * in pixels from either strip.
 *
 * Two more shapes join the channels when the network gives them:
 * - The pool is a grid over its ellipse, one more channel after the flows (id
 *   `flows.length`): `across` -1..1 runs left to right across its entry arc (the
 *   upper half of the ellipse), linear in x, `across = (x - cx) / rx`, so the sim's
 *   entry position `(endX - cx) / rx` lands under the stream; `along` 0..1 runs
 *   down each vertical chord from the arc to the far shore. It has no levee.
 * - A fillet fan per join fills the tip of the V of dark ground between a feeder's
 *   inner bank and the trunk's bank. It carries the trunk's id, so the shader
 *   colours it as the trunk's bank.
 */

// Floats per vertex: x, y, across, along, halfWidth, heat, id.
export const STRIDE = 7

// Columns of the pool's grid (steps of angle across the entry arc, so the columns bunch toward the tips where the
// ellipse curves) and rings (even steps down each vertical chord from the arc, through the centre line, to the far
// shore). 24 x 6 covers the ellipse well enough that the corners of a quad stay inside it.
const POOL_COLS = 24
const POOL_RINGS = 6
// The half width of a bank's edge, lava to nothing, in drawing-buffer px: the lava pass's BANK_PX in
// lavaShader.glsl.js (a test pins the two equal). Its alpha is smoothstep(1 + BANK_PX / hw, 1 - BANK_PX / hw, across),
// solid inside 1 - BANK_PX / hw and gone past 1 + BANK_PX / hw.
export const BANK_PX = 1.0
// How far past the fan's arc its feather row sits, in px. The arc carries the solid across (1 - BANK_PX / hw) and the row
// the 0-alpha across (1 + BANK_PX / hw), a span of 2 * BANK_PX px of ramp in the strips' banks, so the fan's edge fades
// over the same 2 * BANK_PX px as every other bank.
const FILLET_FEATHER = 2 * BANK_PX
// A fillet fan is the V's tip T plus FILLET_ARC points on an arc (the solid fan, 6 triangles), plus a feather row of
// FILLET_ARC points just outside the arc (a 12-triangle strip): 1 + 7 + 7 = 15 vertices, 54 indices. The arc
// ends FILLET_ARM feeder widths up each bank from the tip (1.5 to 3 reads right; 2 is the middle).
const FILLET_ARC = 7
const FILLET_ARM = 2
const FILLET_VERTS = 2 * FILLET_ARC + 1
const FILLET_INDICES = (FILLET_ARC - 1) * 3 + (FILLET_ARC - 1) * 6
// The side of the join is read off the feeder's point FILLET_REACH feeder widths back from its end.
const FILLET_REACH = 3

// Vertices of one channel are laid out channel strip first, then levee strip.
// The indices go the other way round, levee first, because the levee is the
// wider shape and must be painted underneath the channel.
//
// Indices for channel k start after those of every channel before it, 12 per
// point pair (2 triangles * 3 indices * 2 strips); `ranges` records the offsets.
// They are 16-bit, which holds 65535 vertices, far more than the dozen or so
// channels ever need. After the flows' vertices come the pool's, then the
// fillet fans', 15 each, 54 indices.

/**
 * The perpendicular of the chord between a point's neighbours, as a unit
 * vector. Same convention as `ribbon()` in MountDeathfire.vue: the left bank is
 * `p + n * hw` and the right bank is `p - n * hw`. Using the chord rather than
 * the segment ahead means a bend is mitred instead of stepped.
 */
function normalAt(pts, i) {
  const n = pts.length
  const a = pts[Math.max(0, i - 1)]
  const b = pts[Math.min(n - 1, i + 1)]
  const nx = -(b.y - a.y)
  const ny = b.x - a.x
  const len = Math.hypot(nx, ny) || 1
  return [nx / len, ny / len]
}

/**
 * The trunk's centreline point and unit tangent (downstream) at `at`, 0..1 by point index, the way the strips'
 * `along` runs. The tangent is the chord between a point's neighbours, as `normalAt` takes it, blended between the
 * two points either side of `at`, so the fan agrees with the trunk strip about which bank is which.
 */
function trunkAt(pts, at) {
  const n = pts.length
  const u = Math.min(1, Math.max(0, at)) * (n - 1)
  const i = Math.min(n - 2, Math.floor(u))
  const t = u - i
  const chord = (j) => {
    const a = pts[Math.max(0, j - 1)]
    const b = pts[Math.min(n - 1, j + 1)]
    return [b.x - a.x, b.y - a.y]
  }
  const [ax, ay] = chord(i)
  const [bx, by] = chord(i + 1)
  const tx = ax + (bx - ax) * t
  const ty = ay + (by - ay) * t
  const len = Math.hypot(tx, ty) || 1
  return {
    x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
    y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
    tx: tx / len,
    ty: ty / len,
  }
}

/**
 * The point `dist` pixels back from a polyline's last point, with the unit tangent (in the flow's direction) of the
 * segment it sits on. A polyline shorter than `dist` gives its first point.
 */
function walkBack(pts, dist) {
  let remaining = dist
  let tx = 0
  let ty = 1
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1]
    const b = pts[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len === 0) continue
    tx = (b.x - a.x) / len
    ty = (b.y - a.y) / len
    if (remaining <= len) {
      const t = remaining / len
      return { x: b.x + (a.x - b.x) * t, y: b.y + (a.y - b.y) * t, tx, ty }
    }
    remaining -= len
  }
  return { x: pts[0].x, y: pts[0].y, tx, ty }
}

/**
 * One bank of a flow as a polyline: every centreline point moved out by its half width along the chord normal, on the
 * side whose `across` is `s` (-1 the left bank, +n; +1 the right bank, -n), the same offset the strips make.
 */
function bankOf(f, s, fallbackHw) {
  const n = f.pts.length
  return f.pts.map((p, i) => {
    const w = f.widthAt ? f.widthAt(n > 1 ? i / (n - 1) : 0) / 2 : 0
    const hw = w > 0 ? w : fallbackHw
    const [nx, ny] = normalAt(f.pts, i)
    return { x: p.x - s * hw * nx, y: p.y - s * hw * ny }
  })
}

// Where segment a-b crosses segment c-d, as the fraction along each, or null.
function crossing(a, b, c, d) {
  const rx = b.x - a.x
  const ry = b.y - a.y
  const sx = d.x - c.x
  const sy = d.y - c.y
  const den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-9) return null
  const qx = c.x - a.x
  const qy = c.y - a.y
  const u = (qx * sy - qy * sx) / den
  const v = (qx * ry - qy * rx) / den
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { u, v } : null
}

// The point `dist` pixels back (toward the first point) from the place a fraction `u` along segment i of `pts`.
// A polyline shorter than that gives its first point.
function walkFrom(pts, i, u, dist) {
  let cur = { x: pts[i].x + (pts[i + 1].x - pts[i].x) * u, y: pts[i].y + (pts[i + 1].y - pts[i].y) * u }
  let k = i
  let remaining = dist
  for (;;) {
    const dx = pts[k].x - cur.x
    const dy = pts[k].y - cur.y
    const len = Math.hypot(dx, dy)
    if (len > 0 && remaining <= len) return { x: cur.x + (dx * remaining) / len, y: cur.y + (dy * remaining) / len }
    remaining -= len
    cur = pts[k]
    if (k === 0) return { x: cur.x, y: cur.y }
    k--
  }
}

// The trunk's `along` (0..1 by point index) of the centreline point nearest (x, y).
function alongOf(pts, x, y) {
  let best = Infinity
  let at = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const dx = pts[i + 1].x - a.x
    const dy = pts[i + 1].y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0
    const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t))
    if (d < best) {
      best = d
      at = (i + t) / (pts.length - 1)
    }
  }
  return at
}

/**
 * The fan for one join, or null if the join cannot be resolved (a feeder or trunk that is not there, is not the other,
 * or has no line; a feeder with no width; an `at` that is not a number).
 *
 * The V is the dark ground between the feeder's inner bank (its centreline offset by its half width, on the side that
 * faces the trunk) and the trunk's bank on the side the feeder comes from. Walking back up the feeder's bank from the
 * join, the first place it crosses the trunk's bank is the V's tip T. The fan fills the tip: T is the first vertex, and
 * seven more run along a quadratic Bezier arc with T as its control point, from a point FILLET_ARM feeder widths up the
 * feeder's bank to a point as far up the trunk's bank. The arc leaves each bank tangent to it, so the lava's edge goes
 * feeder bank, arc, trunk bank in one continuous curve and the dark ground ends in a rounded tip. The triangles run T,
 * arc k, arc k + 1: 6 of them.
 *
 * The lava pass fades a bank over BANK_PX px either side of `across` +-1, so the fan's vertices are not left on the bank
 * itself (half alpha, and a hard arc edge): T and the arc sit at the bank's solid edge, `across` = sign * (1 - b) with
 * b = BANK_PX / hw (hw the trunk's half width there, b at most 0.5 for a very thin trunk), and a feather row, one more
 * point per arc point FILLET_FEATHER (2 * BANK_PX) px past it along the arc's normal away from T, sits at sign * (1 + b), where the
 * alpha is 0 (at most `levee`, the largest across the field holds). A 12-triangle strip joins the arc to that row.
 *
 * Every vertex carries the trunk's id and its own `along`, the trunk's along at the vertex's nearest point on the
 * trunk's centreline, so the sim cell it reads is the trunk's own there. No vertex lies on the feeder's centreline: the
 * fan is all in the ground the strips leave bare.
 * If the feeder's bank never crosses the trunk's (a feeder wider than the trunk can hold), T is the trunk's bank at
 * the join.
 *
 * Which of the trunk's banks is the inner one: the side the feeder comes from. The sign of the cross product of the
 * trunk's tangent at `at` and the vector from the trunk's point to the feeder's point FILLET_REACH feeder widths back
 * says which side that is; a positive cross is the +n side, which is the left bank, across -1.
 */
function fillet(flows, join, levee) {
  const { feeder, trunk, at, wf } = join
  const ff = flows[feeder]
  const ft = flows[trunk]
  if (!ff || !ft || feeder === trunk || ff.pts.length < 2 || ft.pts.length < 2) return null
  if (!(wf > 0) || !Number.isFinite(at)) return null
  const along = Math.min(1, Math.max(0, at))
  const j = trunkAt(ft.pts, along)
  const far = walkBack(ff.pts, wf * FILLET_REACH)
  const cross = j.tx * (far.y - j.y) - j.ty * (far.x - j.x)
  const sign = cross > 0 ? -1 : 1
  // Unit vector from the trunk's centreline toward the feeder's side.
  const mx = sign * j.ty
  const my = -sign * j.tx
  const trunkHw = (join.wj > 0 ? join.wj : join.wt > 0 ? join.wt : 0) / 2
  const tb = bankOf(ft, sign, trunkHw)
  // The feeder's own bank on the side that faces the trunk: its across sign puts the bank at -sign * hw * n, which must
  // point away from the trunk's side (against m).
  const [fnx, fny] = normalAt(ff.pts, ff.pts.length - 1)
  const fSide = fnx * mx + fny * my >= 0 ? 1 : -1
  const fb = bankOf(ff, fSide, wf / 2)

  // The tip: the crossing nearest the feeder's end (largest feeder segment first, then the largest fraction along it).
  let tip = null
  for (let i = fb.length - 2; i >= 0 && !tip; i--) {
    for (let k = 0; k < tb.length - 1; k++) {
      const hit = crossing(fb[i], fb[i + 1], tb[k], tb[k + 1])
      if (hit && (!tip || hit.u > tip.fu)) tip = { fi: i, fu: hit.u, tk: k, tu: hit.v }
    }
  }
  let fi = fb.length - 2
  let fu = 1
  let tk
  let tu
  if (tip) {
    ;({ fi, fu, tk, tu } = tip)
  } else {
    const u = along * (tb.length - 1)
    tk = Math.min(tb.length - 2, Math.floor(u))
    tu = u - tk
  }
  const T = { x: tb[tk].x + (tb[tk + 1].x - tb[tk].x) * tu, y: tb[tk].y + (tb[tk + 1].y - tb[tk].y) * tu }
  const e0 = walkFrom(fb, fi, fu, wf * FILLET_ARM)
  const e1 = walkFrom(tb, tk, tu, wf * FILLET_ARM)

  const pts = [T]
  for (let k = 0; k < FILLET_ARC; k++) {
    const t = k / (FILLET_ARC - 1)
    const a = (1 - t) * (1 - t)
    const b = 2 * t * (1 - t)
    const c = t * t
    pts.push({ x: a * e0.x + b * T.x + c * e1.x, y: a * e0.y + b * T.y + c * e1.y })
  }
  // A vertex of the fan at (x, y): the trunk's along and half width there, and the bank edge b (in across) from it.
  const vertexAt = (x, y, bank) => {
    const al = alongOf(ft.pts, x, y)
    const w = ft.widthAt ? ft.widthAt(al) / 2 : 0
    const hw = w > 0 ? w : trunkHw
    const b = hw > 0 ? Math.min(BANK_PX / hw, 0.5) : 0.5
    return { x, y, across: sign * (bank ? Math.min(1 + b, Math.max(levee, 1)) : 1 - b), along: al, hw }
  }
  const verts = pts.map((q) => vertexAt(q.x, q.y, false))
  // The feather row: each arc point moved FILLET_FEATHER along the arc's normal, on the side away from T. The normal is
  // taken from the Bezier's derivative, and its side from the middle of the arc, where it is not along a bank.
  const dir = (k) => {
    const t = k / (FILLET_ARC - 1)
    const dx = 2 * (1 - t) * (T.x - e0.x) + 2 * t * (e1.x - T.x)
    const dy = 2 * (1 - t) * (T.y - e0.y) + 2 * t * (e1.y - T.y)
    const len = Math.hypot(dx, dy) || 1
    return [-dy / len, dx / len]
  }
  const mid = (FILLET_ARC - 1) >> 1
  const [mnx, mny] = dir(mid)
  const out = mnx * (pts[1 + mid].x - T.x) + mny * (pts[1 + mid].y - T.y) >= 0 ? 1 : -1
  const feather = []
  for (let k = 0; k < FILLET_ARC; k++) {
    const [nx, ny] = dir(k)
    feather.push(vertexAt(pts[1 + k].x + out * nx * FILLET_FEATHER, pts[1 + k].y + out * ny * FILLET_FEATHER, true))
  }
  return { id: trunk, heat: ft.heat, verts: verts.concat(feather) }
}

/**
 * Build the vertex and index arrays for every flow, the pool and the fillet fans.
 *
 * Returns `order`, the channel indices in the order to draw them: the pool first when there is one (the streams pour
 * into it, so it lies under their ends), then every channel that is not a head, in array order, then the heads (the
 * sheet) last so it lies over the arms it feeds. `count` is the number of vertices.
 *
 * `ranges[k]` says where channel k's triangles sit in `indices`, as
 * `[start, count]` index offsets (not vertex offsets) for its levee strip and
 * its channel strip. To draw channel k, draw its levee range and then its
 * channel range, walking `order`. The pool is channel `flows.length` and its
 * levee range is empty. `filletRange` is every fan's triangles, `[start, count]`
 * after the last channel's: draw it after every channel body. `poolId` is
 * `flows.length` when there is a pool, else null.
 *
 * `joins` is `[{ feeder, trunk, at, wf, wt, wj }]`: flow indices, `at` the trunk's
 * `along` of the join and widths in pixels. `pool` is `{ cx, cy, rx, ry, arcY(x) }`
 * in the same pixels as the flows: the ellipse, and `arcY` the y of its upper edge at x.
 */
export function buildStrips(flows, { levee, joins = [], pool = null }) {
  const livePool = pool && pool.rx > 0 && pool.ry > 0 ? pool : null
  const fans = []
  for (const join of joins ?? []) {
    const fan = fillet(flows, join, levee)
    if (fan) fans.push(fan)
  }

  let count = 0
  let indexCount = 0
  for (const f of flows) {
    count += f.pts.length * 4
    indexCount += Math.max(0, f.pts.length - 1) * 12
  }
  if (livePool) {
    count += (POOL_COLS + 1) * (POOL_RINGS + 1)
    indexCount += POOL_COLS * POOL_RINGS * 6
  }
  count += fans.length * FILLET_VERTS
  indexCount += fans.length * FILLET_INDICES
  const vertices = new Float32Array(count * STRIDE)
  const indices = new Uint16Array(indexCount)

  const ranges = []
  let v = 0 // next vertex to write
  let ix = 0 // next index to write
  const put = (at, x, y, across, along, halfWidth, heat, id) => {
    vertices[at] = x
    vertices[at + 1] = y
    vertices[at + 2] = across
    vertices[at + 3] = along
    vertices[at + 4] = halfWidth
    vertices[at + 5] = heat
    vertices[at + 6] = id
  }
  // Two triangles for the quad whose corners are vertices a, b (one pair) and c, d (the next pair).
  const quad = (a, b, c, d) => {
    indices[ix++] = a
    indices[ix++] = b
    indices[ix++] = c
    indices[ix++] = b
    indices[ix++] = d
    indices[ix++] = c
  }

  flows.forEach((f, id) => {
    const pts = f.pts
    const n = pts.length
    const channelBase = v
    const leveeBase = v + n * 2

    for (let i = 0; i < n; i++) {
      const along = n > 1 ? i / (n - 1) : 0
      // A flow with no widthAt yet gets zero width rather than NaN vertices.
      const halfWidth = f.widthAt ? f.widthAt(along) / 2 : 0
      const [nx, ny] = normalAt(pts, i)
      // Channel vertices sit at 2 per point from channelBase, levee from leveeBase.
      for (const [base, reach] of [[channelBase, 1], [leveeBase, levee]]) {
        const o = (base + i * 2) * STRIDE
        for (let side = 0; side < 2; side++) {
          const across = side === 0 ? -reach : reach
          // Left bank (across < 0) is +n, right bank is -n.
          const off = -across * halfWidth
          put(o + side * STRIDE, pts[i].x + nx * off, pts[i].y + ny * off, across, along, halfWidth, f.heat, id)
        }
      }
    }

    // Two triangles per point pair: (left, right, next left) and (right, next right, next left).
    const run = Math.max(0, n - 1) * 6
    ranges.push({ levee: [ix, run], channel: [ix + run, run] })
    for (const base of [leveeBase, channelBase]) {
      for (let i = 0; i < n - 1; i++) {
        const a = base + i * 2
        quad(a, a + 1, a + 2, a + 3)
      }
    }

    v += n * 4
  })

  // The pool: a grid of quads over the ellipse. Column i sits at the angle phi = pi at the left tip down to 0 at the
  // right, so x = cx + rx cos phi (the columns bunch toward the tips); its `across` is cos phi = (x - cx) / rx, linear
  // in x, the same measure the sim uses for where a stream enters. Ring j runs down that vertical chord, from the arc
  // point (along 0) through the pool's centre line to the mirror point on the far shore (along 1). halfWidth is half
  // the chord: ry at the arc's top, shrinking to nothing at the tips.
  let poolId = null
  if (livePool) {
    poolId = flows.length
    const { cx, cy, rx } = livePool
    const arcY = typeof livePool.arcY === 'function'
      ? livePool.arcY
      : (x) => {
          const d = (x - cx) / rx
          return d * d >= 1 ? cy : cy - livePool.ry * Math.sqrt(1 - d * d)
        }
    const base = v
    for (let j = 0; j <= POOL_RINGS; j++) {
      const along = j / POOL_RINGS
      for (let i = 0; i <= POOL_COLS; i++) {
        const c = Math.cos(Math.PI * (1 - i / POOL_COLS))
        const across = Math.abs(c) < 1e-12 ? 0 : c // the centre column is exactly 0, not 6e-17
        const x = cx + rx * across
        const top = arcY(x)
        const half = Math.max(0, cy - top)
        put((base + j * (POOL_COLS + 1) + i) * STRIDE, x, top + 2 * half * along, across, along, half, 1, poolId)
      }
    }
    const first = ix
    for (let j = 0; j < POOL_RINGS; j++) {
      for (let i = 0; i < POOL_COLS; i++) {
        const a = base + j * (POOL_COLS + 1) + i
        quad(a, a + 1, a + POOL_COLS + 1, a + POOL_COLS + 2)
      }
    }
    ranges.push({ levee: [first, 0], channel: [first, ix - first] })
    v += (POOL_COLS + 1) * (POOL_RINGS + 1)
  }

  // The fans, after every channel: the tip T first, then the arc, then the feather row. One triangle from T per arc
  // step, then a strip of two triangles per arc step from the arc out to the feather row.
  const filletStart = ix
  for (const fan of fans) {
    const base = v
    fan.verts.forEach((q, k) => put((base + k) * STRIDE, q.x, q.y, q.across, q.along, q.hw, fan.heat, fan.id))
    for (let k = 1; k < FILLET_ARC; k++) {
      indices[ix++] = base
      indices[ix++] = base + k
      indices[ix++] = base + k + 1
    }
    const feather = base + FILLET_ARC
    for (let k = 1; k < FILLET_ARC; k++) {
      indices[ix++] = base + k
      indices[ix++] = base + k + 1
      indices[ix++] = feather + k
      indices[ix++] = base + k + 1
      indices[ix++] = feather + k + 1
      indices[ix++] = feather + k
    }
    v += FILLET_VERTS
  }

  const order = []
  if (livePool) order.push(flows.length)
  flows.forEach((f, i) => {
    if (!f.head) order.push(i)
  })
  flows.forEach((f, i) => {
    if (f.head) order.push(i)
  })

  return { vertices, indices, count, order, ranges, filletRange: [filletStart, ix - filletStart], poolId }
}

/**
 * The box that holds every flow's centreline and the pool's ellipse, grown by
 * `pad` pixels on every side so the widest channel and its levee fit inside.
 * `{ x: 0, y: 0, w: 0, h: 0 }` when there is nothing at all.
 */
export function bounds(flows, pad, pool = null) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const f of flows) {
    for (const p of f.pts) {
      if (p.x < x0) x0 = p.x
      if (p.x > x1) x1 = p.x
      if (p.y < y0) y0 = p.y
      if (p.y > y1) y1 = p.y
    }
  }
  if (pool && pool.rx > 0 && pool.ry > 0) {
    x0 = Math.min(x0, pool.cx - pool.rx)
    x1 = Math.max(x1, pool.cx + pool.rx)
    y0 = Math.min(y0, pool.cy - pool.ry)
    y1 = Math.max(y1, pool.cy + pool.ry)
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 }
}
