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
 * Then the confluences. Each tributary is traced on a course aimed at the trunk, meeting it at 18 to 26 degrees (S5.4 allows
 * 30). Its last stretch (about three widths, a little more where the 12 degrees a chord needs it) turns its heading onto the
 * trunk's with a cubic ease, the V between the two banks, and lands it on the trunk's centreline a little below where it
 * was aimed (`turnOnto`): that is the join. The feeder is cut there and drains into the trunk (`drain` 0, `drainAt` the
 * place along it), and the trunk widens below the join (`joinWidthProfile`, composed in join order). A tributary no trunk
 * row in its window suits, whose approach is over 30 degrees (drawn or aimed), or that cannot turn in the room it has, is
 * traced again as a stream of its own and runs to the pool, and the builder says so in dev (S5.3).
 *
 * Last, on desktop, the fork (S5.3): 2.5 to 3.5 trunk widths above the pool the trunk splits in two and both streams run
 * into the pool, each by its own entry, with an island of dark ground between them that ends at the pool's arc. The arm is a
 * flow of its own, fed from the trunk at `attach`; the trunk narrows from the split to the pool. (A split-and-rejoin braid
 * needs about 5 widths below the last join, and the S5.3 windows leave 3.1 to 4.5: it cannot fit, so the arm does not rejoin.)
 * A trunk with under 2.5 widths between its last join (and half a width of clear trunk below it) and the arc gets no fork, and
 * the builder says so in dev.
 */

// How far in from the rim corner each crest's base reaches, in crater widths: the rest of the rim is the mouth the
// trunk leaves by. MountDeathfire.vue builds the crown with it and imports it from here (the mountain data does not carry it).
export const CROWN_BASE = 0.55
// A stream stays inside this fraction of the face's half width, as the old `trace` did.
const U_MAX = 0.94

/** Largest angle, in degrees, between a feeder's tangent and its trunk's at a join (the confluence rule). */
export const CONFLUENCE_MAX_DEG = 30

const GROWTH = 0.15 // a stream is 15% wider at its end than at its source, as the levees spread
const FLARE = 0.2 // and flares another 20% over its last two rows as it enters the pool
const FLARE_ROWS = 2
const POOL_RX = 0.45 // the pool's width, as a fraction of the cone's base width
const SOLO_ENTRY = [0.45, 0.8] // a stream on its own enters the pool this far out, as a fraction of its half width
const POOL_SINK = 0.2 // how far, in pool half heights (ry), the centre sits above the lowest row: on the foreground ridge line
const PHONE_POOL_SINK = 0.4 // on a phone the centre sits this far, in pool half heights (ry), below the screen's bottom edge
const PHONE_POOL_ROWS = 1 // ...but its arc stays at least this many rows above the cone's foot, so the streams reach it
const FISSURE_GAP_ROWS = 6 // a fissure source sits at least this many rows above the pool's upper arc
const JOIN_RUN_ROWS = 3 // a tributary has at least this many rows between its source and its meeting with the trunk
const JOIN_MIN_ROW = 3 // ...and the trunk row it is aimed at is no higher than this (just below the mouth)
const MAX_TURN_DEG = 10 // no stream bends more than this between one chord and the next, as far as the relaxing can get it
const RESAMPLE_ROWS = 0.5 // the chord a stream is resampled at, in rows: half a row, so 10 degrees a chord allows twice the curvature
const HARD_TURN_DEG = 12 // the rule itself (S10): a stream left over this is reported in dev
const RELAX_FROM_DEG = 8 // the relaxing leaves points whose bend is under this alone (and takes full hold at twice it)
const ARRIVE_DEG = [18, 26] // a tributary is aimed to meet its trunk at an angle in this range, before the turn (S5.4: at most 30)
const START_DEG = 45 // ...coming in from its source no steeper than this to the trunk
const DRAWN_DEG = 34 // ...and no steeper than this over its last DRAWN_WIDTHS widths above the turn (a coarse gate: the drawn feeder is checked against 30 after)
const DRAWN_WIDTHS = 8
const PARTING = 1.3 // a feeder runs beside its trunk no nearer than this many bank-to-bank gaps (half the two widths), so the V has a mouth
const PARTING_ROWS = 2 // ...if it has this many rows to part in
const PARTING_TAN = 0.4 // ...and leaves the trunk no steeper than this (tangent) doing it
const TURN_WIDTHS = 3 // a joining feeder turns onto its trunk's heading over its last three widths (S5.4)
const TURN_EXTRA = 10 // ...and its walk starts up to this many chords higher if the turn is too sharp for that
const LAG_WIDTHS = 2.5 // the turn lands about this many feeder widths below the aim: the S5.3 window leaves that room at its end
const BULGE = 1.1 // the trunk's outer bank swells to this much of the joined width...
const BULGE_RISE = 1 // ...one width below the join (the swell starts one width above it),
const BULGE_SETTLE = 3 // ...then settles to the joined width over three more widths
const MAX_TILT = (15 * Math.PI) / 180 // a fissure leans at most this far from vertical
// The fork (S5.3, as ruled after the braid could not fit): low on the trunk, below its last join, the trunk splits in two and
// both streams run into the pool, each by its own entry, with an island of dark ground between them that ends at the pool's
// arc. Lengths in trunk widths (`W`: the trunk's composed width at the split) unless said otherwise.
const FORK_GAP = 0.5 // ...with this much clear trunk between the last join's landing and the split (the join's swell is not narrowed away, and the arm does not leave from the feeder's node)
const FORK_WIDTH = 0.5 // the fork's arm is this much of W at the split (and grows 15% as any stream does)
const FORK_NARROW = 0.6 // the trunk is this much of its composed width from the split to the pool
const FORK_ABOVE = [2.5, 3.5] // the split is this far above the pool arc: as far up as the room below the last join allows, at most the larger
const FORK_OFFSET = 0.9 // the arm ends this far from the trunk's line (square on), where the trunk meets the arc
const FORK_EASE = 0.8 // the arm leaves the trunk's heading over this far, and the trunk narrows over it
const FORK_CHORD = 0.12 // the arm is cut at this much of W, or half a row if that is less, so its bends can be as tight as its size
const FORK_APART = 0.15 // the two entries are at least this far apart, in pool half widths
const FORK_EDGE = 0.95 // ...and the arm's entry is no further out than this, in pool half widths
// Where on the trunk, as a fraction of its length, each tributary is to join (the S5.3 windows).
const JOIN_AT = { rim: [0.2, 0.35], upper: [0.45, 0.6], mid: [0.65, 0.8] }
// A phone's one join: S5.3's mid window with its end moved to 0.85, because the join is where the turn lands, a little
// below the aim. S8 wants it clear of the title box; on a phone the box covers y 0.46 to 0.76 of the height and the cone's
// summit stands at about 0.31 of it, so a join above the box is out of reach (the vent is 96 px above its top, and the turn
// alone is 3 widths, 70 px, on a 582 px cone): this is the window that puts it below the box, at 0.79 to 0.90 of the height.
const PHONE_JOIN_AT = [0.66, 0.85]

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

// The unit direction of a polyline at `at` (0 to 1, by point index): the chord one point either side, so a bend is mitred.
function tangentAlong(pts, at) {
  const step = 1 / (pts.length - 1)
  const a = pointAlong(pts, at - step)
  const b = pointAlong(pts, at + step)
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
}

// The index of the point of `pts` nearest to `q`.
function nearestIndex(pts, q) {
  let best = 0
  let bd = Infinity
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i].x - q.x) ** 2 + (pts[i].y - q.y) ** 2
    if (d < bd) [best, bd] = [i, d]
  }
  return best
}

// The nearest distance from the point `q` to the polyline `pts`.
function distToLine(pts, q) {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const dx = pts[i].x - a.x
    const dy = pts[i].y - a.y
    const l2 = dx * dx + dy * dy
    const r = l2 ? clamp(((q.x - a.x) * dx + (q.y - a.y) * dy) / l2, 0, 1) : 0
    best = Math.min(best, Math.hypot(q.x - (a.x + dx * r), q.y - (a.y + dy * r)))
  }
  return best
}

/**
 * The angle, in degrees, between a feeder and its trunk where they meet: the feeder's heading as it arrives at the point
 * of it nearest the trunk's point `at` (0 to 1 along the trunk, by point index), against the trunk's tangent there. The
 * feeder's heading is the chord of its last two steps up to that point, so a feeder that carries on past the join is
 * read where it gets there; a feeder already cut at the join is read at its end.
 */
export function approachAngleDeg(feederPts, trunkPts, at) {
  if (feederPts.length < 2) return 0
  const k = nearestIndex(feederPts, pointAlong(trunkPts, at))
  const a = feederPts[Math.max(0, k - 2)]
  const b = feederPts[Math.max(1, k)]
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const t = tangentAlong(trunkPts, at)
  const cos = clamp(((b.x - a.x) * t.x + (b.y - a.y) * t.y) / len, -1, 1)
  return (Math.acos(cos) * 180) / Math.PI
}

/**
 * A trunk's width in px at `s` (0 to 1 along it) across one join, S5.4: the feeder `wf` joining the trunk `wt` at `sj`
 * makes it `wj = joinedWidth(wt, wf)`. The trunk keeps `wt` until one width above the join, swells to 1.1 wj one width
 * below it, and settles to wj over the next three widths (both moves eased with t*t*(3-2t)). "A width" is `wj`, the width
 * of the joined channel the bulge and the settling happen in; `wScale` turns px into `s` (1 over the trunk's length).
 */
export function joinWidthProfile(wt, wf, sj, wScale) {
  const wj = joinedWidth(wt, wf)
  const one = wj * wScale
  const peak = BULGE * wj
  return (s) => {
    const rise = BULGE_RISE * one
    if (s <= sj - rise) return wt
    if (s < sj + rise) return wt + (peak - wt) * sstep((s - (sj - rise)) / (2 * rise))
    const settle = BULGE_SETTLE * one
    if (s < sj + rise + settle) return peak + (wj - peak) * sstep((s - (sj + rise)) / settle)
    return wj
  }
}

// The segment of `pts` nearest `p`, looking from segment `hint` a few back and on a good way (both the stream and the
// trunk run down the page, so what was found for one point is where to start for the next). `{ i, r }`: segment and place on it.
function nearestOn(pts, p, hint) {
  const n = pts.length - 1
  let best = Infinity
  let bi = 0
  let br = 0
  for (let i = Math.max(0, hint - 4); i <= Math.min(n - 1, hint + 12); i++) {
    const a = pts[i]
    const dx = pts[i + 1].x - a.x
    const dy = pts[i + 1].y - a.y
    const l2 = dx * dx + dy * dy
    const r = l2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0
    const d = Math.hypot(p.x - (a.x + dx * r), p.y - (a.y + dy * r))
    if (d < best) [best, bi, br] = [d, i, r]
  }
  return { i: bi, r: br }
}

// The trunk's unit direction at the place `q` (from `nearestOn`): its segment's, blended into the next one's across the
// segment so a bend is not stepped.
function trunkDir(pts, q) {
  const seg = (i) => {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) || 1
    return { x: (pts[i + 1].x - pts[i].x) / l, y: (pts[i + 1].y - pts[i].y) / l }
  }
  const d = seg(q.i)
  const j = q.r < 0.5 ? q.i - 1 : q.i + 1
  const o = j >= 0 && j < pts.length - 1 ? seg(j) : d
  const w = Math.abs(q.r - 0.5)
  const x = d.x * (1 - w) + o.x * w
  const y = d.y * (1 - w) + o.y * w
  const l = Math.hypot(x, y) || 1
  return { x: x / l, y: y / l }
}

// Which side of the trunk's segment `q.i` the point `p` lies, and how far: positive on the right of its direction.
const sideOf = (pts, q, p) => {
  const a = pts[q.i]
  const b = pts[q.i + 1]
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / l
}

const wrapAngle = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI))

/**
 * The steepest angle, in degrees, the drawn feeder `pts` makes with its trunk `T` over its last `span` px: each chord's
 * direction against the direction of the trunk's nearest segment. The 30 degree rule read on what is drawn (the angle at
 * the join alone says nothing of the stretch above the turn).
 */
export function drawnAngleDeg(pts, T, span) {
  let worst = 0
  let arc = 0
  let hint = 0
  for (let k = pts.length - 1; k >= 1 && arc <= span; k--) {
    arc += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y)
    hint = Math.max(0, Math.floor(alongAtY(T, pts[k].y) * (T.length - 1)) - 1)
    const q = nearestOn(T, pts[k], hint)
    const dx = pts[k].x - pts[k - 1].x
    const dy = pts[k].y - pts[k - 1].y
    const tx = T[q.i + 1].x - T[q.i].x
    const ty = T[q.i + 1].y - T[q.i].y
    const cos = (dx * tx + dy * ty) / ((Math.hypot(dx, dy) * Math.hypot(tx, ty)) || 1)
    worst = Math.max(worst, (Math.acos(clamp(cos, -1, 1)) * 180) / Math.PI)
  }
  return worst
}

/**
 * Cut the feeder `F` where its turn onto the trunk `T` lands, and land it on the trunk's centreline. The feeder is
 * aimed at `at` (a point on the trunk, which S5.3's window picked), arriving at an angle; the V is made over its last
 * TURN_WIDTHS widths (`wf`, in px or more) by easing its heading, against the trunk's local tangent, to nothing with
 * t*t*(3-2t) over a stretch that ends on the trunk's centreline. Every point past it is dropped.
 *
 * The turn is walked from a point of the feeder (`kz`), step by step, each step along the trunk's tangent plus what is
 * left of the feeder's own angle to it. That closes about half the gap a straight line at the same angle would
 * (the angle fades), so the walk crosses the trunk below `at`, about as far below it as `kz` is above: the stretch is
 * solved for, by bisection on its length, so that the heading reaches the trunk's exactly where the walk reaches the
 * centreline. Nothing before `kz` is touched (the approach keeps the angle it was aimed with), and nothing is shifted
 * or blended to make the end meet. If the stretch bends over HARD_TURN_DEG (less a margin) a chord it is started a chord
 * higher, up to TURN_EXTRA more. A feeder whose turn cannot be made in the room it has, or whose approach is over
 * CONFLUENCE_MAX_DEG, comes back as `{ why }`, to run to the pool instead.
 * Returns `{ pts, angle, at }`: the cut feeder, the angle it meets the trunk at before the turn, and where along the
 * trunk (0 to 1, by point index) it lands.
 */
function turnOnto(F, T, at, wf) {
  const J = pointAlong(T, at)
  const angle = approachAngleDeg(F, T, at)
  if (angle > CONFLUENCE_MAX_DEG) return { why: 'approach angle ' + angle.toFixed(1) + ' degrees' }
  // the last point of the feeder above the join
  let kc = -1
  while (kc + 1 < F.length && F[kc + 1].y < J.y - 1e-6) kc++
  if (kc < 2) return { why: 'no room above the join' }
  const nT = T.length - 1
  const chord = polylineLength(F) / (F.length - 1)
  let longest = 0
  for (let i = 1; i < F.length; i++) longest = Math.max(longest, Math.hypot(F[i].x - F[i - 1].x, F[i].y - F[i - 1].y))
  // the walk starts about as far above the join as it will land below it: half the stretch, three widths at least
  const n0 = Math.max(2, Math.ceil((0.5 * TURN_WIDTHS * wf) / chord))
  const nMax = Math.min(n0 + TURN_EXTRA, kc)
  const kLow = kc - nMax + 1
  // the feeder's own angle to the trunk, chord by chord, from the highest start it may take down to the pool
  const cum = new Array(F.length).fill(0)
  const rel = new Array(F.length).fill(0)
  let hint = Math.max(0, Math.floor(alongAtY(T, F[Math.max(0, kLow - 1)].y) * nT) - 1)
  for (let i = 1; i < F.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(F[i].x - F[i - 1].x, F[i].y - F[i - 1].y)
    if (i < kLow) continue
    const mid = { x: (F[i].x + F[i - 1].x) / 2, y: (F[i].y + F[i - 1].y) / 2 }
    const q = nearestOn(T, mid, hint)
    hint = q.i
    const td = trunkDir(T, q)
    rel[i] = wrapAngle(Math.atan2(F[i].y - F[i - 1].y, F[i].x - F[i - 1].x) - Math.atan2(td.y, td.x))
  }
  for (let N = n0; N <= nMax; N++) {
    const kz = kc - N + 1
    const start = F[kz]
    const q0 = nearestOn(T, start, Math.max(0, Math.floor(alongAtY(T, start.y) * nT) - 1))
    const sg = sideOf(T, q0, start) < 0 ? -1 : 1
    // the walk, for a stretch `Z` long: its points, and how far along it crosses the trunk (Infinity if it never does)
    const walk = (Z) => {
      const pts = [{ x: start.x, y: start.y }]
      let p = pts[0]
      let h = q0.i
      let c = kz + 1
      for (let k = 1; k <= Math.ceil(Z / chord) + 6; k++) {
        const mid = (k - 0.5) * chord
        while (c < F.length - 1 && cum[c] < cum[kz] + mid) c++
        const q = nearestOn(T, p, h)
        h = q.i
        const td = trunkDir(T, q)
        const th = Math.atan2(td.y, td.x) + rel[c] * (1 - sstep(mid / Z))
        const np = { x: p.x + Math.cos(th) * chord, y: p.y + Math.sin(th) * chord }
        const g0 = sg * sideOf(T, q, p)
        const g1 = sg * sideOf(T, nearestOn(T, np, h), np)
        if (g1 <= 0) {
          const f = g0 / (g0 - g1)
          pts.push({ x: p.x + (np.x - p.x) * f, y: p.y + (np.y - p.y) * f })
          return { pts, ok: true, s: (k - 1 + f) * chord, h }
        }
        pts.push(np)
        p = np
      }
      return { pts, ok: false, s: Infinity, h }
    }
    let lo = chord
    let hi = 3 * (cum[kc] - cum[kz] + Math.hypot(J.x - F[kc].x, J.y - F[kc].y)) + 4 * chord
    if (!walk(hi).ok) continue
    for (let it = 0; it < 12; it++) {
      const mid = (lo + hi) / 2
      const w = walk(mid)
      if (w.ok && w.s <= mid) hi = mid
      else lo = mid
    }
    const w = walk(hi)
    if (!w.ok || w.s < TURN_WIDTHS * wf) continue
    // land exactly on the trunk's line, where the walk met it
    const cp = w.pts[w.pts.length - 1]
    const qe = nearestOn(T, cp, Math.max(0, w.h - 1))
    const land = (qe.i + qe.r) / nT
    const X = pointAlong(T, land)
    const walked = w.pts.map((p, i) => ({ x: p.x, y: p.y, u: start.u + (X.u - start.u) * (i / (w.pts.length - 1)) }))
    walked[walked.length - 1] = { x: X.x, y: X.y, u: X.u }
    // cut again into even pieces, the ends kept
    const out = resample(F.slice(0, kz).concat(walked), longest)
    let down = true
    for (let i = 1; i < out.length; i++) if (!(out[i].y > out[i - 1].y)) down = false
    if (down && maxTurnDeg(out) <= HARD_TURN_DEG - 0.1) return { pts: out, angle, at: land }
  }
  return { why: 'it cannot turn in the room it has' }
}

// Where along a polyline, by arc length. `cum[i]` is the length up to point i.
function arcTable(pts) {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  return cum
}

// The point at arc length `s` along `pts`, with its unit tangent (the chords' mean either side, so a bend is mitred) and
// `at` (0 to 1, by point index, the `along` everything else reads). Past the end it carries straight on.
function atArc(pts, cum, s) {
  const n = pts.length
  let i
  if (s >= cum[n - 1]) i = n - 2
  else {
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= s) lo = mid
      else hi = mid
    }
    i = lo
  }
  const len = cum[i + 1] - cum[i] || 1
  const r = Math.max(0, (s - cum[i]) / len)
  const rc = Math.min(r, 1)
  const a = tangentAt(pts, i)
  const b = tangentAt(pts, i + 1)
  const tx = a.x * (1 - rc) + b.x * rc
  const ty = a.y * (1 - rc) + b.y * rc
  const tl = Math.hypot(tx, ty) || 1
  const p = pts[i]
  const q = pts[i + 1]
  return { x: p.x + (q.x - p.x) * r, y: p.y + (q.y - p.y) * r, tx: tx / tl, ty: ty / tl, at: (i + rc) / (n - 1) }
}

/**
 * The fork arm's centreline as a distance `d(s)` from the trunk's, `s` px down the trunk from the split: it leaves the
 * trunk's heading (slope 0), eases to a climb of slope `m` over `e` px, and keeps that slope, so it ends `peak` px off the
 * trunk's line `len` px down (where the trunk meets the pool arc), still leaning away: two streams, not one that bends back.
 * Returns `{ d(s), slope }`: `slope` is the steady lean, as a tangent.
 */
function forkProfile(peak, e, len) {
  const m = peak / (len - e / 2)
  const d = (s) => {
    if (s <= 0) return 0
    if (s < e) return (m * s * s) / (2 * e)
    return (m * e) / 2 + m * (s - e)
  }
  return { d, slope: m }
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
 * The pool's size and height from the cone: an ellipse 0.45 of the base wide (S5.6 asks 0.4 to 0.5; `rx` is half that) and a
 * quarter of that tall. On desktop its centre sits on the foreground ridge line (the lowest row's y, a fifth of the
 * pool's half height `ry` above it), so the ridges cover its far half. On a phone it sits below the screen's bottom edge
 * `h` (0.4 `ry` below it, so the arc's top is 0.6 `ry` above): the glow shows and the surface mostly does not; its top is kept at
 * least a row above the cone's foot, so every stream can land on it.
 */
function poolShape(baseW, yBot, rowH, phone, h) {
  const rx = (POOL_RX * baseW) / 2
  const ry = rx / 4
  let cy = yBot - ry * POOL_SINK
  if (phone && Number.isFinite(h)) cy = Math.min(h + ry * PHONE_POOL_SINK, yBot - PHONE_POOL_ROWS * rowH + ry)
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
 * height (where a phone's pool sits), `phone`, `rng` (a function returning 0..1), `braid` (false leaves the fork out; a
 * test hook, so the same seed can be built with and without it: everything else is laid down first and does not change).
 *
 * Returns `{ flows, pool, fissures, joins }`.
 * - `flows[i]`: `{ pts [{x, y, u}], widthAt(s), head, kind, role, heat, parent: -1, attach: 0, drain, drainAt, sourceIndex, aim }`.
 *   `kind` is 'trunk' | 'rim' | 'fissure' | 'braid'; `head` is true only for the trunk. `role` names the source:
 *   'trunk' | 'rim' | 'upper' | 'mid' | 'lower' (the three desktop fissures) | 'phone-fissure' | 'fork' (the arm of the
 *   trunk's fork, kind 'braid'). Every source is its own sim channel (`parent: -1`), the fork's arm excepted: it leaves the
 *   trunk (`parent: 0`, `attach` how far along the trunk, 0 to 1, by point index) and runs into the pool. `drain` is the flow this one ends on (0, the trunk, for a tributary that joins it), -1 for the
 *   pool; `drainAt` how far along the trunk (0 to 1) it joins, or, for a stream into the pool, where it enters across the
 *   arc (-1 to 1, 0 under the trunk's end). `sourceIndex` is the index into `fissures` for a fissure flow, else -1. `aim` is where
 *   a tributary meets the trunk, `{ row, at }` (the trunk's nearest mountain row and how far along the trunk, 0 to 1, in
 *   its S5.3 window: the same `at` as `drainAt` and the join's), or null for a stream that runs to the pool on its own.
 * - `pool`: `{ cx, cy, rx, ry, arcTop, arcY(x) }`, an ellipse in the low ground at the foot; see `poolShape`. Null when the
 *   mountain is too short (under 8 rows) to lay anything out.
 * - `fissures`: `{ x, y, rows, tilt }` per fissure source: the crack's lower end (where the stream starts), its height
 *   in mountain rows and its lean from vertical in radians (positive leans to the right going up). A cone too short to
 *   hold three fissures six rows above the pool, one to a row, holds fewer.
 * - `joins`: one per tributary that meets the trunk, in order down it: `{ feeder (flow index), trunk (0), at (along the
 *   trunk, 0 to 1, by point index), wf, wt, wj (px: the feeder at its end, the trunk just above the join, the two as
 *   one), angle (degrees: the feeder's approach before it turns) }`. The fork's arm is not a join: no entry, no fillet.
 * Desktop makes a trunk, one rim overflow, three fissures and, where the trunk has room, the fork's arm; a phone makes a
 * trunk and one fissure.
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
  // the head is the vent itself, so the trunk pours from the floor of the breach
  const trunk = [{ x: m.vent.x, y: m.vent.y, u: uVent }]
  for (let s = from; s <= last; s++) {
    const u = uVent + (trunkLean * (s - from)) / last + trunkWander((s - from) / Math.max(1, arcRow - from))
    trunk.push(place(s, u, true))
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
    const flow = {
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
    }
    flows.push(flow)
    return flow
  }
  const trunkFlow = finish(trunk, { w0f: 1, kind: 'trunk', role: 'trunk', head: true, heat: 1, sourceIndex: -1, aim: null })
  const baseWidth = trunkFlow.widthAt // the trunk's own growth and flare; the joins widen it (below)
  const trunkAt = (row) => alongAtY(flows[0].pts, rowY(row))
  // The trunk was relaxed after its rows were traced, so a tributary is laid against the finished line: its x at each row
  // (above the vent, the vent's; below the pool arc, the end's).
  const trunkX = []
  for (let s = 0; s <= last; s++) trunkX.push(pointAlong(flows[0].pts, trunkAt(s)).x)

  // px of closing per row at the place `at` along the trunk: a feeder on side `sg` heads as the trunk does, turned `alpha`
  // toward it (the trunk's heading from straight down toward +x is `a`, a lean in x per y of tan a)
  const trunkHeading = (at) => {
    const t = tangentAlong(flows[0].pts, at)
    return Math.atan2(t.x, t.y)
  }
  const closeSlope = (at, sg, alpha) => {
    const a = trunkHeading(at)
    return Math.abs(Math.tan(a - sg * alpha) - Math.tan(a)) * rowH
  }
  // the angle to a trunk leaning `a` of a feeder on side `sg` closing `m` px of x per px of y
  const closeAngle = (a, sg, m) => Math.abs(a - Math.atan(Math.tan(a) - sg * m))
  const trunkLen = polylineLength(flows[0].pts) || 1

  // A stream aimed at the trunk: from its source at (row0, u0) it comes down to row `rowJ` and meets the trunk there at
  // `alpha` to it, the angle the confluence rule limits (S5.4). The gap to the trunk, measured across the face from the
  // trunk's own line, closes along a parabola that is slope 0 where it starts and `alpha` where it ends (so a feeder with
  // gap to spare runs beside the trunk, keeping its distance, and turns in only as late as it needs); a feeder short of
  // run for that is shut with a quadratic that leaves its source already leaning in (the gate in `joinRow` keeps that
  // lean under START_DEG). Its wandering is damped toward the meeting. Past `rowJ` it carries on across the trunk's line
  // at the same slope and straightens out: the join cuts it at the meeting (`turnOnto`, which turns its last widths onto
  // the trunk's heading to make the V), so the tail is only the scaffold that lets the relaxing and the landing treat it
  // like any stream, and the meeting keeps the heading it was aimed with.
  const joiner = ({ row0, u0, rowJ, w0f, alpha, bank }) => {
    const wob = meander(range(0.02, 0.04), range(2, 4), range(0, Math.PI * 2), w0f)
    const gap0 = place(row0, u0, false).x - trunkX[row0]
    const sg = gap0 < 0 ? -1 : 1
    const d0 = Math.abs(gap0)
    const slope = closeSlope(trunkAt(rowJ), sg, alpha)
    const run = rowJ - row0
    const reach = slope * run
    let closing
    if (2 * d0 <= reach) {
      // it runs beside the trunk at `d0`, or, if that is nearer than the banks would touch, at PARTING of the gap where they
      // would (a source on the trunk's bank would never show a V), as far as the run has room for, easing out to it, then
      // closes along the parabola
      const room = (slope * (run - PARTING_ROWS)) / 2 // what a parabola can close in the rows left after parting
      let dp = Math.max(d0, Math.min(PARTING * bank, room))
      // the parting leaves the trunk no steeper than PARTING_TAN (the sstep's steepest part is 1.5 times its mean)
      for (let it = 0; it < 4; it++) {
        const cap = d0 + (PARTING_TAN * (rowJ - (2 * dp) / slope - row0) * rowH) / 1.5
        if (dp > cap) dp = Math.max(d0, cap)
      }
      const lc = (2 * dp) / slope
      const sc = rowJ - lc
      closing = (s) => (s <= sc ? d0 + (dp - d0) * sstep((s - row0) / Math.max(1e-9, sc - row0)) : dp * (1 - ((s - sc) / lc) ** 2))
    } else {
      closing = (s) => {
        const t = (s - row0) / run
        return d0 - (2 * d0 - reach) * t + (d0 - reach) * t * t
      }
    }
    const pts = []
    for (let s = row0; s <= last; s++) {
      let d
      let gain
      if (s <= rowJ) {
        d = closing(s)
        gain = 1 - 0.9 * ease((s - row0) / run)
      } else {
        const x = Math.min(1, (s - rowJ) / 3)
        d = -slope * 3 * (x - x ** 3 + (x ** 4) / 2)
        gain = 0.1
      }
      const u = (trunkX[s] + sg * d - rowCx(s)) / rowHalf(s) + gain * wob((s - row0) / Math.max(1, arcRow - row0))
      pts.push(place(s, u, false))
    }
    return pts
  }
  // A stream on its own: down the face, drawing in toward the pool as it goes, to enter it at SOLO_ENTRY of the pool's half
  // width from its middle, on the side it came from (so well apart from the trunk, which enters at the middle).
  const solo = ({ row0, u0, w0f }) => {
    const x0 = place(row0, u0, false).x
    const xT = pool.cx + (x0 < pool.cx ? -1 : 1) * range(SOLO_ENTRY[0], SOLO_ENTRY[1]) * pool.rx
    const wob = meander(range(0.02, 0.04), range(2, 4), range(0, Math.PI * 2), w0f)
    const pts = []
    for (let s = row0; s <= last; s++) {
      const t = clamp((s - row0) / Math.max(1, arcRow - row0), 0, 1)
      // its wandering dies away toward the pool, so the entry is where it was aimed
      pts.push(place(s, (x0 + (xT - x0) * t - rowCx(s)) / rowHalf(s) + (1 - 0.9 * ease(t)) * wob(t), false))
    }
    return pts
  }
  // The trunk rows a tributary may join at, best first: a row whose place along the finished trunk falls inside its S5.3
  // window, at least JOIN_RUN_ROWS below its source and no higher than JOIN_MIN_ROW. It must also leave room to get there: over n rows it closes `gap` px at up to `alpha`
  // at the end (`k` px a row), which a parabola does in `2 gap / k` rows; a run shorter than that needs the quadratic, whose
  // lean at the source is (2 gap - k n) / (n rowH), kept under START_DEG. A source on the trunk's bank (gap under PARTING
  // of `bank`, the gap at which the banks touch) wants its parting room as well, PARTING_ROWS and the parabola from the
  // parted gap. The turn lands a little below the aim (`lag`), so a row with that much window left comes first. In that
  // order: with parting room and window to spare, without parting room (the two longest runs there are) and window to
  // spare, then the same two where the window is short. The first is picked at random, the rest follow, longest runs first
  // (at most four rows in all: the builder tries them in turn). Empty when no row fits: the tributary then runs to the
  // pool on its own, as S5.3 has it when the angle rule cannot be met.
  const joinRows = (win, srcRow, srcX, alpha, bank, wf) => {
    const lag = (LAG_WIDTHS * wf) / trunkLen
    const tiers = [[], [], [], []]
    const sg = srcX < trunkX[srcRow] ? -1 : 1
    const gap = Math.abs(srcX - trunkX[srcRow])
    const parted = Math.max(gap, PARTING * bank)
    for (let s = Math.max(JOIN_MIN_ROW, srcRow + JOIN_RUN_ROWS); s <= arcRow - 2; s++) {
      const at = trunkAt(s)
      if (at < win[0] || at > win[1]) continue
      const k = closeSlope(at, sg, alpha)
      const n = s - srcRow
      if (2 * gap > k * n) {
        // the quadratic: leaning in at the source, easing to `alpha` at the aim; its lean must be under START_DEG, and
        // where the source is within the stretch the drawn feeder is held to (the last DRAWN_WIDTHS widths) that too
        const a = trunkHeading(at)
        const lean = 2 * gap - k * n
        const tw = Math.max(0, 1 - ((DRAWN_WIDTHS + 1) * wf) / (n * rowH))
        const rad = Math.PI / 180
        if (
          closeAngle(a, sg, lean / (n * rowH)) > START_DEG * rad ||
          closeAngle(a, sg, Math.abs(-lean + 2 * (gap - k * n) * tw) / (n * rowH)) > DRAWN_DEG * rad
        )
          continue
      }
      const roomy = n >= PARTING_ROWS + (2 * parted) / k
      tiers[(at <= win[1] - lag ? 0 : 2) + (roomy ? 0 : 1)].push(s)
    }
    const best = tiers.findIndex((t) => t.length)
    if (best < 0) return []
    const pool = best % 2 ? tiers[best].slice(-2) : tiers[best]
    const first = pool[Math.floor(rng() * pool.length)]
    const rest = []
    tiers.forEach((t, ti) => {
      for (const s of ti % 2 ? t.slice(-2).reverse() : t.slice().reverse()) if (s !== first) rest.push(s)
    })
    return [first, ...rest].slice(0, 4)
  }
  // The feeders that join, in the order they were laid: `{ feeder (flow index), at, wf, angle }`. Sorted and filled out
  // (wt, wj) once every feeder is down, because each join's trunk width counts the joins above it.
  const pending = []
  const feeder = ({ role, kind, row0, u0, w0f, win, heat, sourceIndex }) => {
    const alone = () => finish(solo({ row0, u0, w0f }), { w0f, kind, role, head: false, heat, sourceIndex, aim: null })
    const alpha = win ? (range(ARRIVE_DEG[0], ARRIVE_DEG[1]) * Math.PI) / 180 : 0
    // it joins as wide as it has grown by the join: 15% over its length, and no flare (it never reaches the pool); the
    // banks touch when the lines are half the two widths apart (the trunk's own growth, the joins above it left out)
    const w0px = w0f * W0
    const wf = w0px * (1 + GROWTH)
    const bank = (baseWidth(clamp(win ? (win[0] + win[1]) / 2 : 0, 0, 1)) + wf) / 2
    const tries = win ? joinRows(win, row0, place(row0, u0, false).x, alpha, bank, wf) : []
    let why = 'no trunk row in its window fits'
    for (const rowJ of tries) {
      const aim = { row: rowJ, at: trunkAt(rowJ) }
      const flow = finish(joiner({ row0, u0, rowJ, w0f, alpha, bank }), { w0f, kind, role, head: false, heat, sourceIndex, aim })
      let turned = turnOnto(flow.pts, flows[0].pts, aim.at, wf)
      // it lands where its turn meets the trunk, a little below the aim; that is the join, and it stays inside the window
      if (turned.pts && (turned.at < win[0] || turned.at > win[1])) turned = { why: 'its turn lands outside the window' }
      // and what is drawn, not only the aim, keeps to the rule over its last DRAWN_WIDTHS widths
      if (turned.pts && drawnAngleDeg(turned.pts, flows[0].pts, DRAWN_WIDTHS * wf) > CONFLUENCE_MAX_DEG - 0.5) {
        turned = { why: 'it comes in steeper than ' + CONFLUENCE_MAX_DEG + ' degrees above its turn' }
      }
      if (turned.pts) {
        flow.pts = turned.pts
        flow.widthAt = (s) => w0px * (1 + GROWTH * clamp(s, 0, 1))
        flow.drain = 0
        flow.drainAt = turned.at
        flow.aim = { row: clamp(Math.round((pointAlong(flows[0].pts, turned.at).y - yTop) / rowH), 0, last), at: turned.at }
        pending.push({ feeder: flows.length - 1, at: turned.at, wf, angle: turned.angle })
        return
      }
      flows.pop()
      why = turned.why
    }
    // S5.3's fallback: it cannot meet the trunk under the rule, so it runs to the pool on its own, traced afresh (its first
    // course was aimed at the trunk and would cross it); a stream with no window (the lower fissure) was never to join
    if (import.meta.env?.DEV && win) console.debug('lavaNetwork: the', role, 'stream drains to the pool:', why)
    alone()
  }

  // ---- the rim overflow (desktop): over the lip on the far side of the peak from the breach, a crater width or so from it
  if (!phone) {
    const side = -breachSide
    feeder({ role: 'rim', kind: 'rim', row0: 0, u0: side * U_MAX, w0f: 0.4, win: JOIN_AT.rim, heat: 0.8, sourceIndex: -1 })
  }

  // ---- the flank fissures: short cracks lit at their lower end, each the source of a stream
  // The rows a fissure's lower end may sit on: below the mouth, and at least six rows above the pool's upper arc.
  let rBot = 0
  for (let s = 0; s <= last; s++) if (rowY(s) <= arcTop - FISSURE_GAP_ROWS * rowH) rBot = s
  const rTop = Math.min(Math.max(from + 3, 6), rBot)
  const fissures = []
  let prevRow = rTop - 1
  const fissure = ({ role, side, uAbs, t, win, w0f }) => {
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
    feeder({ role, kind: 'fissure', row0, u0, w0f, win, heat: range(0.7, 0.85), sourceIndex })
  }

  if (phone) {
    // one fissure, on the side the page shows, high enough on the face to have the run its join needs
    fissure({ role: 'phone-fissure', side: towardFace, uAbs: range(0.35, 0.55), t: range(0.1, 0.35), win: PHONE_JOIN_AT, w0f: 0.5 })
  } else {
    // upper face on the breach side, mid face on the far side, lower on the far flank
    fissure({ role: 'upper', side: breachSide, uAbs: range(0.35, 0.55), t: range(0.05, 0.25), win: JOIN_AT.upper, w0f: 0.35 })
    fissure({ role: 'mid', side: -breachSide, uAbs: range(0.3, 0.5), t: range(0.35, 0.55), win: JOIN_AT.mid, w0f: 0.35 })
    fissure({ role: 'lower', side: -breachSide, uAbs: range(0.58, 0.74), t: range(0.8, 1), win: null, w0f: 0.35 })
  }

  // ---- the confluences: each join widens the trunk below it, one after another down the trunk
  const joins = pending
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((j) => ({ feeder: j.feeder, trunk: 0, at: j.at, wf: j.wf, wt: 0, wj: 0, angle: j.angle }))
  const wScale = 1 / (polylineLength(flows[0].pts) || 1)
  const steps = []
  let settled = 1 // what the joins above have made of the trunk's width, once they have settled
  for (const j of joins) {
    j.wt = baseWidth(j.at) * settled
    j.wj = joinedWidth(j.wt, j.wf)
    steps.push({ wt: j.wt, step: joinWidthProfile(j.wt, j.wf, j.at, wScale) })
    settled *= j.wj / j.wt
  }
  if (joins.length) {
    flows[0].widthAt = (s) => {
      const t = clamp(s, 0, 1)
      let wd = baseWidth(t)
      for (const st of steps) wd *= st.step(t) / st.wt
      return wd
    }
  }

  // ---- the fork (desktop): low on the trunk, below its last join, the trunk splits and both streams run into the pool (S5.3).
  // The arm is a flow of its own, fed from the trunk's cell at `attach` (the sim's parent/attach) and entering the pool by its
  // own entry like any stream (`drain` -1, `drainAt` across the arc). Its centreline is the trunk's pushed out to one side by
  // `forkProfile`, cut where it meets the arc. The arm is FORK_WIDTH of the trunk's width at the split, and the trunk narrows
  // to FORK_NARROW of its width from the split to the pool. Returns why there is none, or null.
  const trunkWidth = flows[0].widthAt // the trunk's width with its joins and flare, before the fork narrows it
  const uOf = (x, y) => {
    const f = clamp((y - yTop) / rowH, 0, last)
    const i = Math.min(last - 1, Math.floor(f))
    const r = f - i
    return (x - (rowCx(i) + (rowCx(i + 1) - rowCx(i)) * r)) / (rowHalf(i) + (rowHalf(i + 1) - rowHalf(i)) * r)
  }
  const layFork = () => {
    const T = flows[0].pts
    const cum = arcTable(T)
    const LT = cum[cum.length - 1]
    const arcOf = (at) => {
      const f = clamp(at, 0, 1) * (T.length - 1)
      const i = Math.min(T.length - 2, Math.floor(f))
      return cum[i] + (cum[i + 1] - cum[i]) * (f - i)
    }
    // as far up as the room below the last join allows, at most FORK_ABOVE[1] widths above the arc (the trunk ends on it), and
    // FORK_GAP widths (of the trunk at the join) of clear trunk below the join's landing; the width at the split depends on
    // where it is, so settle it in a few steps
    const lastAt = joins.reduce((a, j) => Math.max(a, j.at), 0)
    const wJoin = trunkWidth(clamp(lastAt, 0, 1))
    const room = LT - arcOf(lastAt) - FORK_GAP * wJoin
    let W = wJoin
    let s0 = LT
    for (let it = 0; it < 8; it++) {
      s0 = LT - Math.min(FORK_ABOVE[1], room / W) * W
      W = trunkWidth(atArc(T, cum, s0).at)
    }
    const p0 = atArc(T, cum, s0)
    W = trunkWidth(p0.at) // the width where it really is
    const above = (LT - s0) / W
    // the room is counted in the widths the trunk has at the join (the swell below it makes the trunk up to 10% wider where the
    // fork leaves, which would turn a near thing away)
    if (room / wJoin < FORK_ABOVE[0]) {
      return 'only ' + ((LT - arcOf(lastAt)) / wJoin).toFixed(1) + ' trunk widths between the last join and the pool, the fork needs ' + FORK_ABOVE[0] + ' and ' + FORK_GAP + ' clear below the join'
    }
    const wA = FORK_WIDTH * W
    const e = FORK_EASE * W
    const chord = Math.min(rowH * RESAMPLE_ROWS, FORK_CHORD * W)
    const sh = forkProfile(FORK_OFFSET * W, e, above * W)
    const trunkEnd = T[T.length - 1]
    // the other streams into the pool, where they enter, in pool half widths
    const others = flows.filter((f) => f.drain === -1 && f.role !== 'trunk')
    const entryOf = (p) => (p.x - pool.cx) / pool.rx
    const trunkEntry = entryOf(trunkEnd)
    // each side the arm can leave by, and how much room it leaves it: to the arc's edge and to the streams already entering that way
    const roomOn = (dir) => {
      let r = dir > 0 ? 1 - trunkEntry : 1 + trunkEntry
      for (const f of others) {
        const d = (entryOf(f.pts[f.pts.length - 1]) - trunkEntry) * dir
        if (d > 0) r = Math.min(r, d)
      }
      return r
    }
    let why = 'it does not fit'
    const made = []
    for (const sg of [1, -1]) {
      const dense = []
      for (let s = 0; s <= above * W + 2 * W; s += chord / 2) {
        const q = atArc(T, cum, s0 + s)
        const off = sg * sh.d(s)
        const x = q.x - q.ty * off
        const y = q.y + q.tx * off
        dense.push({ x, y, u: uOf(x, y) })
      }
      const pts = resample(landOnArc(dense, pool, rowH), chord)
      const end = pts[pts.length - 1]
      if (Math.abs(end.y - pool.arcY(end.x)) > 1e-3) {
        why = 'it does not reach the pool'
        continue
      }
      for (const p of pts) p.u = uOf(p.x, p.y)
      if (pts.some((p) => Math.abs(p.u) > U_MAX)) {
        why = 'it leaves the face'
        continue
      }
      let down = true
      for (let i = 1; i < pts.length; i++) if (!(pts[i].y > pts[i - 1].y)) down = false
      if (!down || maxTurnDeg(pts) > HARD_TURN_DEG - 0.1) {
        why = 'it bends too hard'
        continue
      }
      if (drawnAngleDeg(pts, T, polylineLength(pts)) > CONFLUENCE_MAX_DEG - 0.5) {
        why = 'it leans more than ' + CONFLUENCE_MAX_DEG + ' degrees off the trunk'
        continue
      }
      // its entry is inside the arc, apart from the trunk's and from every other stream's
      const entry = entryOf(end)
      if (Math.abs(entry) > FORK_EDGE || Math.abs(entry - trunkEntry) < FORK_APART || others.some((f) => Math.abs(entry - entryOf(f.pts[f.pts.length - 1])) < FORK_APART)) {
        why = 'its entry is too near the arc edge or another stream'
        continue
      }
      // and it keeps its distance from the streams that run into the pool alone
      if (others.some((f) => pts.some((p, j) => j % 2 === 0 && distToLine(f.pts, p) < 0.5 * W))) {
        why = 'it crosses another stream'
        continue
      }
      made.push({ pts, entry, room: roomOn(Math.sign(entry - trunkEntry)) })
    }
    if (!made.length) return why
    // the side with more room
    const { pts, entry } = made.reduce((a, c) => (c.room > a.room ? c : a))
    // it stands: the trunk narrows over the first of the arm and stays narrow to the pool
    const aSplit = p0.at
    const aNarrow = atArc(T, cum, s0 + e).at
    const narrow = (s) => (s <= aSplit ? 1 : s < aNarrow ? 1 - (1 - FORK_NARROW) * sstep((s - aSplit) / (aNarrow - aSplit)) : FORK_NARROW)
    flows[0].widthAt = (s) => trunkWidth(s) * narrow(clamp(s, 0, 1))
    flows.push({
      pts,
      widthAt: (s) => wA * (1 + GROWTH * clamp(s, 0, 1)),
      head: false,
      kind: 'braid',
      role: 'fork',
      heat: 1,
      parent: 0,
      attach: aSplit,
      drain: -1,
      drainAt: clamp(entry, -1, 1),
      sourceIndex: -1,
      aim: null,
    })
    return null
  }
  if (!phone && opts.braid !== false) {
    const why = layFork()
    if (why && import.meta.env?.DEV) console.debug('lavaNetwork: no fork:', why)
  }

  // a stream into the pool says where it enters across its arc, -1 to 1 (0 under the trunk's end)
  for (const f of flows) {
    if (f.drain === -1) f.drainAt = clamp((f.pts[f.pts.length - 1].x - pool.cx) / pool.rx, -1, 1)
  }

  return { flows, pool, fissures, joins }
}
