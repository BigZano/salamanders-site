/**
 * The lava network: where the streams start, where they run, how wide they are, and the pool every one of them ends in.
 *
 * Pure, so it can be tested without a canvas or a GL context. It takes the mountain as data (as `buildMountain` in
 * MountDeathfire.vue returns it), a viewport width, a `phone` flag and a seeded `rng` (a function returning 0..1: the
 * builder never seeds itself and never calls Math.random), and returns flows in the shape the strips, the sim, the riders
 * and the canvas already read, plus the pool and the fissure cracks.
 *
 * Positions are a fraction `u` across the cone's width at each mountain row (-1 left, 1 right), the convention
 * `buildFlows`'s old `trace` used, so a stream follows the face as the cone flares. Each stream is traced once per
 * mountain row, cut where it meets the pool's upper arc, then resampled at equal arc length through a Catmull-Rom curve
 * (`resample`), so no straight run is longer than one row.
 *
 * The rows are a straight nominal line from the top row's y to the bottom row's. `buildMountain` jitters each flank's y
 * independently (up to a fifth of a row either way), and a centreline that took its y from the flanks would kink at
 * every row; only the flanks' x values (where the face is) are read per row.
 *
 * This half lays out the sources, the streams, the widths and the pool; every stream drains to the pool here. The
 * confluences (a tributary turning onto the trunk, the trunk widening below each join) come after, in the same file:
 * they rewrite `drain`, `drainAt`, `joins` and the trunk's `widthAt`. Each tributary is already traced on a course that
 * meets the trunk at a shallow angle, and its flow records where (`aim`), so a join has something to land on.
 */

// How far in from the rim corner each crest's base reaches, in crater widths: the rest of the rim is the mouth the
// trunk leaves by. The same constant as MountDeathfire.vue's CROWN_BASE (the mountain data does not carry it).
const CROWN_BASE = 0.55
// A stream stays inside this fraction of the face's half width, as the old `trace` did.
const U_MAX = 0.94

/** Largest angle, in degrees, between a feeder's tangent and its trunk's at a join (the confluence rule). */
export const CONFLUENCE_MAX_DEG = 30

const GROWTH = 0.15 // a stream is 15% wider at its end than at its source, as the levees spread
const FLARE = 0.2 // and flares another 20% over its last two rows as it enters the pool
const FLARE_ROWS = 2
const POOL_RX = 0.45 // the pool's half width, as a fraction of the cone's base width
const POOL_SINK = 0.2 // how far, in pool heights, the centre sits above the lowest row: on the foreground ridge line
const PHONE_POOL_SINK = 0.4 // on a phone the centre sits this far, in pool heights, below the screen's bottom edge
const FISSURE_GAP_ROWS = 6 // a fissure source sits at least this many rows above the pool's upper arc
const JOIN_RUN_ROWS = 3 // a tributary has at least this many rows between its source and its meeting with the trunk
const MAX_TURN_DEG = 10 // no stream bends more than this between one chord and the next, as far as the relaxing can get it
const RESAMPLE_ROWS = 0.5 // the chord a stream is resampled at, in rows: half a row, so 10 degrees a chord allows twice the curvature
const HARD_TURN_DEG = 12 // the rule itself (S10): a stream left over this is reported in dev
const RELAX_FROM_DEG = 8 // the relaxing leaves points whose bend is under this alone (and takes full hold at twice it)
const EASE_ROOM = 0.2 // sideways travel, in row heights per row run squared, a tributary may ease across (see joinRow)
const MAX_TILT = (15 * Math.PI) / 180 // a fissure leans at most this far from vertical
// Where on the trunk, as a fraction of its length, each tributary is to join (the S5.3 windows).
const JOIN_AT = { rim: [0.2, 0.35], upper: [0.45, 0.6], mid: [0.65, 0.8] }

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
// An ease with the least peak curvature for its travel: two parabolas, slope zero at both ends (a smoothstep bends half again as hard in the middle).
const ease = (x) => {
  const t = clamp(x, 0, 1)
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
}
const sstep = (x) => {
  const t = clamp(x, 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * The width of two streams once they are one, as rivers add: (wt^1.5 + wf^1.5)^(1/1.5). Equal streams make 1.59 times
 * either; a thin feeder on a wide trunk adds a little.
 */
export function joinedWidth(wt, wf) {
  return Math.pow(Math.pow(wt, 1.5) + Math.pow(wf, 1.5), 1 / 1.5)
}

// A point on the centripetal Catmull-Rom segment p1 to p2 (Barry-Goldman), t in 0..1. Centripetal, so control points
// spaced unevenly (the short last piece of a cut stream) never loop or overshoot.
function crPoint(p0, p1, p2, p3, t) {
  const k1 = Math.sqrt(Math.max(1e-6, Math.hypot(p1.x - p0.x, p1.y - p0.y)))
  const k2 = Math.sqrt(Math.max(1e-6, Math.hypot(p2.x - p1.x, p2.y - p1.y)))
  const k3 = Math.sqrt(Math.max(1e-6, Math.hypot(p3.x - p2.x, p3.y - p2.y)))
  const t1 = k1
  const t2 = t1 + k2
  const t3 = t2 + k3
  const tt = t1 + k2 * t
  const mix = (a, b, r) => ({ x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r })
  const a1 = mix(p0, p1, tt / t1)
  const a2 = mix(p1, p2, (tt - t1) / k2)
  const a3 = mix(p2, p3, (tt - t2) / k3)
  const b1 = mix(a1, a2, tt / t2)
  const b2 = mix(a2, a3, (tt - t1) / (t3 - t1))
  return mix(b1, b2, (tt - t1) / k2)
}

/**
 * The polyline `pts` ({x, y, u?}) as a smooth curve sampled at equal arc length: a centripetal Catmull-Rom spline
 * through every input point, cut into the fewest equal pieces none longer than `step`. The first and last points are
 * kept exactly. `u` (the place across the cone) is carried by linear interpolation between the input points.
 */
export function resample(pts, step) {
  const n = pts.length
  if (n < 2 || !(step > 0)) return pts.map((p) => ({ ...p }))
  const hasU = pts.every((p) => typeof p.u === 'number')
  const ctl = (i) => {
    if (i < 0) return { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y }
    if (i >= n) return { x: 2 * pts[n - 1].x - pts[n - 2].x, y: 2 * pts[n - 1].y - pts[n - 2].y }
    return pts[i]
  }
  const SUB = 12
  const dense = []
  for (let i = 0; i < n - 1; i++) {
    const p0 = ctl(i - 1)
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = ctl(i + 2)
    for (let k = 0; k < SUB; k++) {
      const t = k / SUB
      const c = crPoint(p0, p1, p2, p3, t)
      if (hasU) c.u = p1.u + (p2.u - p1.u) * t
      dense.push(c)
    }
  }
  dense.push({ ...pts[n - 1] })
  const cum = [0]
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y))
  const total = cum[cum.length - 1]
  if (!(total > 0)) return [{ ...pts[0] }, { ...pts[n - 1] }]
  const pieces = Math.max(1, Math.ceil(total / step - 1e-9))
  const out = []
  let j = 1
  for (let k = 0; k <= pieces; k++) {
    if (k === 0) {
      out.push({ ...pts[0] })
      continue
    }
    if (k === pieces) {
      out.push({ ...pts[n - 1] })
      continue
    }
    const at = (total * k) / pieces
    while (j < dense.length - 1 && cum[j] < at) j++
    const a = dense[j - 1]
    const b = dense[j]
    const r = cum[j] > cum[j - 1] ? (at - cum[j - 1]) / (cum[j] - cum[j - 1]) : 0
    const p = { x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r }
    if (hasU) p.u = a.u + (b.u - a.u) * r
    out.push(p)
  }
  return out
}

// The sharpest bend, in degrees, between consecutive chords of a polyline.
const maxTurnDeg = (pts) => {
  let worst = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const ax = pts[i].x - pts[i - 1].x
    const ay = pts[i].y - pts[i - 1].y
    const bx = pts[i + 1].x - pts[i].x
    const by = pts[i + 1].y - pts[i].y
    const d = Math.hypot(ax, ay) * Math.hypot(bx, by)
    if (d > 0) worst = Math.max(worst, Math.acos(clamp((ax * bx + ay * by) / d, -1, 1)))
  }
  return (worst * 180) / Math.PI
}

const polylineLength = (pts) => {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return len
}

/**
 * The unit direction `{x, y}` of a polyline at `pts[i]`: the chord between its neighbours, so a bend is mitred rather
 * than stepped (one-sided at the ends). The tangent a join compares a feeder's against the trunk's.
 */
export function tangentAt(pts, i) {
  const a = pts[Math.max(0, i - 1)]
  const b = pts[Math.min(pts.length - 1, i + 1)]
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
}

// How far along a downhill polyline, 0 to 1, the height y falls. By point index, which on a resampled stream is by arc
// length: the same `s` that `widthAt` and the sim take.
function alongAtY(pts, y) {
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].y >= y) {
      const a = pts[i - 1]
      const b = pts[i]
      return (i - 1 + (b.y > a.y ? clamp((y - a.y) / (b.y - a.y), 0, 1) : 0)) / (pts.length - 1)
    }
  }
  return 1
}

// The point at `at` (0 to 1, by point index) along a polyline, between its two neighbouring points.
function pointAlong(pts, at) {
  const f = clamp(at, 0, 1) * (pts.length - 1)
  const i = Math.min(pts.length - 2, Math.floor(f))
  const r = f - i
  const a = pts[i]
  const b = pts[i + 1]
  return { x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r, u: a.u + (b.u - a.u) * r }
}

/**
 * A stream's width in px at `s` along it (0 to 1): `w0` at the source, 15% more by `sf` (where the flare begins, the
 * last two rows), then a smooth 20% flare on top of that to the pool, so `widthAt(1)` is w0 * 1.15 * 1.2.
 */
function widthProfile(w0, sf) {
  return (s) => {
    const t = clamp(s, 0, 1)
    const growth = 1 + GROWTH * Math.min(1, t / sf)
    const flare = t > sf ? 1 + FLARE * sstep((t - sf) / (1 - sf)) : 1
    return w0 * growth * flare
  }
}

// One slow meander per stream, as an offset in u at `dist` (the fraction of the stream's length run). Its amplitude grows
// with the distance from the source and shrinks with the width, so a thin tributary wanders more than the trunk:
// amp = a0 (1 + dist) / (0.5 + width / W0). It is zero at the source, so the stream leaves where it should; `freq` is in
// radians over the stream's length, so 2 to 4 is a fraction of a cycle: one bend, not a ripple.
const meander = (a0, freq, phase, w0f) => (dist) => {
  const wf = w0f * (1 + GROWTH * Math.min(1, dist))
  const amp = (a0 * (1 + dist)) / (0.5 + wf)
  return amp * (Math.sin(freq * dist + phase) - Math.sin(phase))
}

/**
 * The pool's size and height from the cone: an ellipse 0.45 of the base wide and a quarter of that tall. On desktop its
 * centre sits on the foreground ridge line (the lowest row's y, a fifth of a pool height above it), so the ridges
 * cover its far half. On a phone it sits below the screen's bottom edge `h` (0.4 pool heights below it, so the arc's
 * top is 0.6 above): the glow shows and the surface mostly does not. Either way its top stays two rows above the cone's
 * foot, so every stream can land on it.
 */
function poolShape(baseW, yBot, rowH, phone, h) {
  const rx = POOL_RX * baseW
  const ry = rx / 4
  let cy = yBot - ry * POOL_SINK
  if (phone && Number.isFinite(h)) cy = Math.min(h + ry * PHONE_POOL_SINK, yBot - FLARE_ROWS * rowH + ry)
  return { rx, ry, cy }
}

// The pool: `arcY(x)` is the y of its upper edge at x (its centre line outside the ellipse's span), `arcTop` that edge at cx.
function makePool(cx, cy, rx, ry) {
  return {
    cx,
    cy,
    rx,
    ry,
    arcTop: cy - ry,
    arcY: (x) => {
      const d = (x - cx) / rx
      return d * d >= 1 ? cy : cy - ry * Math.sqrt(1 - d * d)
    },
  }
}

// Cut a traced stream where it meets the pool's upper arc, the last point exactly on it.
function landOnArc(pts, pool, rowH) {
  const above = (p) => p.y < pool.arcY(p.x)
  for (let i = 1; i < pts.length; i++) {
    if (above(pts[i])) continue
    const a = pts[i - 1]
    const b = pts[i]
    let lo = 0
    let hi = 1
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2
      if (above({ x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid })) lo = mid
      else hi = mid
    }
    const hit = { x: a.x + (b.x - a.x) * hi, y: a.y + (b.y - a.y) * hi }
    if (typeof a.u === 'number') hit.u = a.u + (b.u - a.u) * hi
    const kept = pts.slice(0, i)
    // a point left right beside the landing would pin the curve's heading there to the wrong line
    if (kept.length > 2 && Math.hypot(hit.x - kept[kept.length - 1].x, hit.y - kept[kept.length - 1].y) < 0.6 * rowH) kept.pop()
    return [...kept, hit]
  }
  return pts
}

// A short stream cannot swing as far as a long one, and a terrace steps the face sideways in one row. Rather than cap the
// meander by length, the traced line is relaxed (each point drawn toward its neighbours' mean, across the face only, the
// source fixed, the far end following) until the curve, cut at the arc and resampled, turns no more than MAX_TURN_DEG anywhere. Relaxing before
// the cut keeps the landing on the line the stream is actually taking. Only x (and u with it) moves, so the rows must
// already be a straight line: a kink in y would be beyond it.
function smoothStream(traced, pool, rowH) {
  const step = rowH * RESAMPLE_ROWS
  let ctl = traced
  for (let pass = 0; pass < 120; pass++) {
    const out = resample(landOnArc(ctl, pool, rowH), step)
    if (maxTurnDeg(out) <= MAX_TURN_DEG) return out
    // the sharper the bend at a point, the more it is drawn in: gentle stretches keep the shape they were traced in
    const bend = ctl.map((p, i) => (i === 0 || i === ctl.length - 1 ? 0 : maxTurnDeg([ctl[i - 1], p, ctl[i + 1]])))
    const any = bend.some((b) => b > RELAX_FROM_DEG)
    ctl = ctl.map((p, i) => {
      if (i === 0) return p
      if (i === ctl.length - 1) {
        // the traced end lies below the arc and is cut off; left where it was it would hold the line toward it, so it
        // follows the line before it instead
        const a = ctl[i - 1]
        const b = ctl[i - 2]
        return { x: p.x + 0.5 * (2 * a.x - b.x - p.x), y: p.y, u: p.u + 0.5 * (2 * a.u - b.u - p.u) }
      }
      const k = any ? clamp((bend[i] - RELAX_FROM_DEG) / RELAX_FROM_DEG, 0, 1) * 0.5 : 0.5
      return {
        x: p.x + k * (0.5 * (ctl[i - 1].x + ctl[i + 1].x) - p.x),
        y: p.y,
        u: p.u + k * (0.5 * (ctl[i - 1].u + ctl[i + 1].u) - p.u),
      }
    })
  }
  const out = resample(landOnArc(ctl, pool, rowH), step)
  // out of passes: say so in dev when it is over the 12 degrees the rule allows (a stream a hair over MAX_TURN_DEG is not news)
  if (import.meta.env?.DEV && maxTurnDeg(out) > HARD_TURN_DEG) {
    console.debug('lavaNetwork: a stream still bends', maxTurnDeg(out).toFixed(1), 'degrees after 120 relaxing passes')
  }
  return out
}

/**
 * Lay out the network on a mountain.
 *
 * `mountain`: `left` and `right`, one `{x, y}` per row from the peak down; `peakX`, `craterHalf`, `vent {x, y}` (the
 * valley floor's low point, where the lava leaves). `opts`: `w` the viewport width (which face the page shows), `h` its
 * height (where a phone's pool sits), `phone`, `rng` (a function returning 0..1).
 *
 * Returns `{ flows, pool, fissures, joins }`.
 * - `flows[i]`: `{ pts [{x, y, u}], widthAt(s), head, kind, role, heat, parent: -1, attach: 0, drain, drainAt, sourceIndex, aim }`.
 *   `kind` is 'trunk' | 'rim' | 'fissure' | 'braid'; `head` is true only for the trunk. `role` names the source:
 *   'trunk' | 'rim' | 'upper' | 'mid' | 'lower' (the three desktop fissures) | 'phone-fissure'. Every source is its own sim
 *   channel (`parent: -1`). `drain` is the flow this one ends on, -1 for the pool, `drainAt` how far along that flow
 *   (1 when it drains to the pool). `sourceIndex` is the index into `fissures` for a fissure flow, else -1. `aim` is where
 *   a tributary was eased onto the trunk, `{ row, at }` (the trunk's mountain row and how far along the trunk, 0 to 1, in
 *   its S5.3 window), or null for a stream that runs to the pool on its own.
 * - `pool`: `{ cx, cy, rx, ry, arcTop, arcY(x) }`, an ellipse in the low ground at the foot; see `poolShape`. Null when the
 *   mountain is too short (under 8 rows) to lay anything out.
 * - `fissures`: `{ x, y, rows, tilt }` per fissure source: the crack's lower end (where the stream starts), its height
 *   in mountain rows and its lean from vertical in radians (positive leans to the right going up). A cone too short to
 *   hold three fissures six rows above the pool, one to a row, holds fewer.
 * - `joins`: `[]` here; the confluences fill it.
 * Desktop makes a trunk, one rim overflow and three fissures; a phone makes a trunk and one fissure.
 */
export function buildNetwork(mountain, opts) {
  const m = mountain
  const { w, h, phone, rng } = opts
  const rows = m.left.length
  if (rows < 8) return { flows: [], pool: null, fissures: [], joins: [] }
  const last = rows - 1
  const range = (a, b) => a + (b - a) * rng()

  const yTop = (m.left[0].y + m.right[0].y) / 2
  const yBot = (m.left[last].y + m.right[last].y) / 2
  const rowH = (yBot - yTop) / last
  const rowY = (s) => yTop + rowH * s
  const rowCx = (s) => (m.left[s].x + m.right[s].x) / 2
  const rowHalf = (s) => (m.right[s].x - m.left[s].x) / 2
  // the breach is as wide as the valley floor
  const W0 = Math.max(12, Math.min(40, m.craterHalf * 0.56))
  const towardFace = m.peakX < w / 2 ? 1 : -1
  const breachSide = Math.sign(m.vent.x - m.peakX) || towardFace

  // how far the face's width the mouth lets the trunk use at row s, 0.45 at the rim opening to the full width by row 6
  const crown = (s) => 1 - CROWN_BASE + CROWN_BASE * Math.min(1, s / 6)
  // A point of a stream at row s and place u. The trunk leaves through the mouth (`ramp`) and fans out over the face;
  // everything else lives on the face itself.
  const place = (s, u, ramp) => {
    const uc = clamp(u, -U_MAX, U_MAX)
    const k = ramp ? crown(s) : 1
    return { x: rowCx(s) + uc * k * rowHalf(s), y: rowY(s), u: uc }
  }

  // The pool's size and height are known from the cone; only where it sits across waits on the trunk.
  const shape = poolShape(m.right[last].x - m.left[last].x, yBot, rowH, phone, h)
  const arcTop = shape.cy - shape.ry
  // the (fractional) mountain row at which a stream reaches the arc's top
  const arcRow = clamp((arcTop - yTop) / rowH, 0, last)

  // ---- the trunk: from the vent, over the mouth and down the face to the pool
  const uVent = (m.vent.x - m.peakX) / ((1 - CROWN_BASE) * Math.max(1, m.craterHalf))
  let from = 0
  while (from < last && rowY(from) < m.vent.y + 0.5 * rowH) from++ // no first chord shorter than half a row
  const trunkLean = (phone ? towardFace : breachSide) * range(0.02, 0.1)
  const trunkWander = meander(range(0.02, 0.04), range(2, 4), range(0, Math.PI * 2), 1)
  const trunkU = new Array(rows).fill(uVent)
  // the head is the vent itself, so the trunk pours from the floor of the breach
  const trunk = [{ x: m.vent.x, y: m.vent.y, u: uVent }]
  for (let s = from; s <= last; s++) {
    const u = uVent + (trunkLean * (s - from)) / last + trunkWander((s - from) / Math.max(1, arcRow - from))
    const p = place(s, u, true)
    trunkU[s] = p.u
    trunk.push(p)
  }
  // the pool sits under the trunk's end: where the trunk's line passes the arc's top
  let cx = rowCx(last)
  for (let i = 1; i < trunk.length; i++) {
    if (trunk[i].y >= arcTop) {
      const a = trunk[i - 1]
      const b = trunk[i]
      cx = a.x + ((b.x - a.x) * (arcTop - a.y)) / (b.y - a.y || 1)
      break
    }
  }
  const pool = makePool(cx, shape.cy, shape.rx, shape.ry)

  const flows = []
  const finish = (traced, { w0f, kind, role, head, heat, sourceIndex, aim }) => {
    const pts = smoothStream(traced, pool, rowH)
    // the flare covers the last two rows of the stream's length
    const sf = clamp(1 - (FLARE_ROWS * rowH) / (polylineLength(pts) || 1), 0.5, 0.999)
    flows.push({
      pts,
      widthAt: widthProfile(w0f * W0, sf),
      head,
      kind,
      role,
      heat,
      parent: -1,
      attach: 0,
      drain: -1,
      drainAt: 1,
      sourceIndex,
      aim,
    })
  }
  finish(trunk, { w0f: 1, kind: 'trunk', role: 'trunk', head: true, heat: 1, sourceIndex: -1, aim: null })
  const trunkAt = (row) => alongAtY(flows[0].pts, rowY(row))
  // The trunk was relaxed after its rows were traced, so a tributary eases onto the finished line: its u at each row,
  // where the trunk still runs (the rows below the pool arc keep the traced u).
  const trunkEndY = flows[0].pts[flows[0].pts.length - 1].y
  for (let s = from; s <= last; s++) {
    if (rowY(s) <= trunkEndY) trunkU[s] = (pointAlong(flows[0].pts, trunkAt(s)).x - rowCx(s)) / (crown(s) * rowHalf(s))
  }

  // A stream aimed at the trunk: from its source at (row0, u0) it eases onto the trunk's own course by row `rowJ`, so it
  // arrives parallel to it, at a shallow angle, with its wandering damped toward the meeting. Past `rowJ` (this half
  // has no joins, so every stream runs on to the pool) it keeps to the trunk's line, quietly, parting from it by `off`
  // to the `side` it came from: the confluences cut it at the meeting, so this tail is only the scaffold that ends it
  // on the arc, and a wandering one would swing the relaxing's hold on the approach.
  const joiner = ({ row0, u0, rowJ, side, off, w0f }) => {
    const wob = meander(range(0.02, 0.04), range(2, 4), range(0, Math.PI * 2), w0f)
    const pts = []
    for (let s = row0; s <= last; s++) {
      let base
      let gain
      if (s <= rowJ) {
        const e = ease((s - row0) / (rowJ - row0))
        base = u0 + (trunkU[s] - u0) * e
        gain = 1 - 0.9 * e
      } else {
        const e = ease((s - rowJ) / Math.max(1, arcRow - rowJ))
        base = trunkU[s] + side * off * e
        gain = 0.1
      }
      pts.push(place(s, base + gain * wob((s - row0) / Math.max(1, arcRow - row0)), false))
    }
    return pts
  }
  // A stream on its own: down the face, drawing a little toward the middle as it goes, to the pool.
  const solo = ({ row0, u0, w0f }) => {
    const uT = u0 * range(0.7, 0.9)
    const wob = meander(range(0.02, 0.04), range(2, 4), range(0, Math.PI * 2), w0f)
    const pts = []
    for (let s = row0; s <= last; s++) {
      const lean = (uT - u0) * ((s - row0) / Math.max(1, last - row0))
      pts.push(place(s, u0 + lean + wob((s - row0) / Math.max(1, arcRow - row0)), false))
    }
    return pts
  }
  // The trunk row a tributary joins at: a row whose place along the finished trunk falls inside its S5.3 window, at least
  // JOIN_RUN_ROWS below its source, and below the crown-ramp rows (there the trunk's u maps to a different x than a face
  // stream's u does). It must also leave room to get there: easing across `gap` px in n rows turns the line by about
  // 2 gap / (n^2 rowH) radians a chord (two-parabola ease, half-row chords), so `gap <= EASE_ROOM n^2 rowH` bounds the
  // turn. 0.09 would keep it under 10 degrees outright; 0.2 lets the relaxing take up the difference (the cone's flare
  // does some of the sideways work too), and is where the tests hold: the curve comes within a third of a row of the trunk
  // at the aim, at under 30 degrees to it. A smaller room sends the mid fissure and the rim of a low route to the pool.
  // -1 when no row fits: the tributary then runs to the pool on its own, as S5.3 has it when the angle rule cannot be met.
  const joinRow = (win, srcRow, srcX) => {
    const fit = []
    for (let s = Math.max(6, srcRow + JOIN_RUN_ROWS); s <= arcRow - 2; s++) {
      const at = trunkAt(s)
      if (at < win[0] || at > win[1]) continue
      const gap = Math.abs(srcX - pointAlong(flows[0].pts, at).x)
      if (gap <= EASE_ROOM * (s - srcRow) ** 2 * rowH) fit.push(s)
    }
    return fit.length ? fit[Math.floor(rng() * fit.length)] : -1
  }
  const feeder = ({ role, kind, row0, u0, side, off, w0f, win, heat, sourceIndex }) => {
    const rowJ = win ? joinRow(win, row0, place(row0, u0, false).x) : -1
    if (rowJ < 0) {
      finish(solo({ row0, u0, w0f }), { w0f, kind, role, head: false, heat, sourceIndex, aim: null })
      return
    }
    finish(joiner({ row0, u0, rowJ, side, off, w0f }), { w0f, kind, role, head: false, heat, sourceIndex, aim: { row: rowJ, at: trunkAt(rowJ) } })
  }

  // ---- the rim overflow (desktop): over the lip on the far side of the peak from the breach, a crater width or so from it
  if (!phone) {
    const side = -breachSide
    feeder({ role: 'rim', kind: 'rim', row0: 0, u0: side * U_MAX, side, off: range(0.05, 0.1), w0f: 0.4, win: JOIN_AT.rim, heat: 0.8, sourceIndex: -1 })
  }

  // ---- the flank fissures: short cracks lit at their lower end, each the source of a stream
  // The rows a fissure's lower end may sit on: below the mouth, and at least six rows above the pool's upper arc.
  let rBot = 0
  for (let s = 0; s <= last; s++) if (rowY(s) <= arcTop - FISSURE_GAP_ROWS * rowH) rBot = s
  const rTop = Math.min(Math.max(from + 3, 6), rBot)
  const fissures = []
  let prevRow = rTop - 1
  const fissure = ({ role, side, uAbs, t, win, off, w0f }) => {
    const rowsTall = 3 + Math.floor(rng() * 3)
    const row0 = Math.max(prevRow + 1, Math.round(rTop + t * (rBot - rTop)))
    // on a low route the band is used up: the lower fissures drop out rather than stack two on one row
    if (rBot < 4 || row0 > rBot) return
    prevRow = row0
    const u0 = side * uAbs
    const lower = place(row0, u0, false)
    let tilt = range(-MAX_TILT, MAX_TILT)
    // the crack must stay on the face going up: if its top would leave it, it leans the other way
    const topOk = (tl) => {
      const len = rowsTall * rowH
      const tx = lower.x + Math.sin(tl) * len
      const sTop = Math.max(0, row0 - rowsTall)
      return Math.abs(tx - rowCx(sTop)) <= U_MAX * rowHalf(sTop)
    }
    if (!topOk(tilt)) tilt = topOk(-tilt) ? -tilt : 0
    const sourceIndex = fissures.length
    fissures.push({ x: lower.x, y: lower.y, rows: rowsTall, tilt })
    feeder({ role, kind: 'fissure', row0, u0, side, off, w0f, win, heat: range(0.7, 0.85), sourceIndex })
  }

  if (phone) {
    // one fissure, mid face, on the side the page shows
    fissure({ role: 'phone-fissure', side: towardFace, uAbs: range(0.35, 0.55), t: range(0.35, 0.6), win: JOIN_AT.mid, off: range(0.05, 0.1), w0f: 0.5 })
  } else {
    // upper face on the breach side, mid face on the far side, lower on the far flank
    fissure({ role: 'upper', side: breachSide, uAbs: range(0.35, 0.55), t: range(0.05, 0.25), win: JOIN_AT.upper, off: range(0.05, 0.1), w0f: 0.35 })
    fissure({ role: 'mid', side: -breachSide, uAbs: range(0.3, 0.5), t: range(0.35, 0.55), win: JOIN_AT.mid, off: range(0.05, 0.1), w0f: 0.35 })
    fissure({ role: 'lower', side: -breachSide, uAbs: range(0.58, 0.74), t: range(0.8, 1), win: null, off: 0, w0f: 0.35 })
  }

  return { flows, pool, fissures, joins: [] }
}
