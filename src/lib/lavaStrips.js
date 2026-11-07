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
 * the shader has room to draw the cooled crust that piles up beside a flow. The
 * levee keeps the channel's `halfWidth` so the shader can turn `across` back
 * into a distance in pixels from either strip.
 */

// Floats per vertex: x, y, across, along, halfWidth, heat, id.
export const STRIDE = 7

// Vertices of one channel are laid out channel strip first, then levee strip.
// The indices go the other way round, levee first, because the levee is the
// wider shape and must be painted underneath the channel.
//
// Indices for channel k start after those of every channel before it, 12 per
// point pair (2 triangles * 3 indices * 2 strips); `ranges` records the offsets.
// They are 16-bit, which holds 65535 vertices, far more than the dozen or so
// channels ever need.

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
 * Build the vertex and index arrays for every flow.
 *
 * Returns `order`, the channel indices in the order to draw them: every channel
 * that is not a head first, in array order, then the heads (the sheet) last so
 * it lies over the arms it feeds. `count` is the number of vertices.
 *
 * `ranges[k]` says where channel k's triangles sit in `indices`, as
 * `[start, count]` index offsets (not vertex offsets) for its levee strip and
 * its channel strip. To draw channel k, draw its levee range and then its
 * channel range, walking `order`.
 */
export function buildStrips(flows, { levee }) {
  let count = 0
  let indexCount = 0
  for (const f of flows) {
    count += f.pts.length * 4
    indexCount += Math.max(0, f.pts.length - 1) * 12
  }
  const vertices = new Float32Array(count * STRIDE)
  const indices = new Uint16Array(indexCount)

  const ranges = []
  let v = 0 // next vertex to write
  let ix = 0 // next index to write
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
          const at = o + side * STRIDE
          vertices[at] = pts[i].x + nx * off
          vertices[at + 1] = pts[i].y + ny * off
          vertices[at + 2] = across
          vertices[at + 3] = along
          vertices[at + 4] = halfWidth
          vertices[at + 5] = f.heat
          vertices[at + 6] = id
        }
      }
    }

    // Two triangles per point pair: (left, right, next left) and (right, next right, next left).
    const run = Math.max(0, n - 1) * 6
    ranges.push({ levee: [ix, run], channel: [ix + run, run] })
    for (const base of [leveeBase, channelBase]) {
      for (let i = 0; i < n - 1; i++) {
        const a = base + i * 2
        indices[ix++] = a
        indices[ix++] = a + 1
        indices[ix++] = a + 2
        indices[ix++] = a + 1
        indices[ix++] = a + 3
        indices[ix++] = a + 2
      }
    }

    v += n * 4
  })

  const order = []
  flows.forEach((f, i) => {
    if (!f.head) order.push(i)
  })
  flows.forEach((f, i) => {
    if (f.head) order.push(i)
  })

  return { vertices, indices, count, order, ranges }
}

/**
 * The box that holds every flow's centreline, grown by `pad` pixels on every
 * side so the widest channel and its levee fit inside. `{ x: 0, y: 0, w: 0,
 * h: 0 }` when there are no points at all.
 */
export function bounds(flows, pad) {
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
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 }
}
