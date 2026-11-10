import { describe, it, expect } from 'vitest'
import { buildStrips, bounds, STRIDE, BANK_PX } from './lavaStrips'
import { LAVA_FRAG } from './lavaShader.glsl'

const flow = (pts, extra = {}) => ({ pts, kind: 'arm', head: false, heat: 1, widthAt: () => 10, ...extra })

describe('buildStrips', () => {
  it('makes two vertices per point for the channel and two for the levee, with across at ±1 and ±2.2', () => {
    const { vertices, count } = buildStrips([flow([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 20 }])], { levee: 2.2 })
    expect(count).toBe(3 * 2 + 3 * 2)
    const across = []
    for (let i = 0; i < count; i++) across.push(vertices[i * STRIDE + 2])
    expect(across.slice(0, 2)).toEqual([-1, 1])
    // vertices are 32-bit floats, which cannot hold 2.2 exactly, so compare against the rounded value
    expect(across.slice(6, 8)).toEqual([-Math.fround(2.2), Math.fround(2.2)])
  })
  it('runs along from 0 at the head to 1 at the toe and offsets by the half width', () => {
    const { vertices } = buildStrips([flow([{ x: 0, y: 0 }, { x: 0, y: 10 }])], { levee: 2.2 })
    expect(vertices[3]).toBe(0) // along, first vertex
    expect(vertices[STRIDE * 2 + 3]).toBe(1) // along, first vertex of the last point
    expect(vertices[0]).toBeCloseTo(-5) // x of the left bank: half width 5 to the left of a downward line
    expect(vertices[4]).toBe(5) // halfWidth
  })
  it('draws non-heads first and the sheet last', () => {
    const { order } = buildStrips([flow([{ x: 0, y: 0 }, { x: 0, y: 1 }], { head: true }), flow([{ x: 0, y: 0 }, { x: 0, y: 1 }]), flow([{ x: 0, y: 0 }, { x: 0, y: 1 }])], { levee: 2.2 })
    expect(order).toEqual([1, 2, 0])
  })
  it('is empty for no flows', () => {
    const s = buildStrips([], { levee: 2.2 })
    expect(s.count).toBe(0)
    expect(s.order).toEqual([])
  })

  it('puts the right bank on the opposite side of the line from the left, and levee banks wider by the ring factor', () => {
    const { vertices } = buildStrips([flow([{ x: 0, y: 0 }, { x: 0, y: 10 }])], { levee: 2.2 })
    // channel: point 0 left, right; levee starts at vertex 4
    expect(vertices[0]).toBeCloseTo(-5)
    expect(vertices[STRIDE]).toBeCloseTo(5)
    expect(vertices[4 * STRIDE]).toBeCloseTo(-11) // 5 * 2.2
    expect(vertices[5 * STRIDE]).toBeCloseTo(11)
    // the levee keeps the channel's half width so the shader can still tell how wide the channel is
    expect(vertices[4 * STRIDE + 4]).toBe(5)
  })
  it('takes the normal from the chord between neighbours, so a bend is mitred rather than stepped', () => {
    // the middle point of an L has neighbours (0,0) and (10,10): chord (10,10), normal (-1,1)/sqrt2
    const { vertices } = buildStrips([flow([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }])], { levee: 2.2 })
    const m = 2 * STRIDE // left bank of the middle point
    expect(vertices[m]).toBeCloseTo(0 - 5 * Math.SQRT1_2)
    expect(vertices[m + 1]).toBeCloseTo(10 + 5 * Math.SQRT1_2)
  })
  it('reads the half width from widthAt at each point and carries heat and the channel index', () => {
    const f0 = flow([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 20 }], { widthAt: (s) => 10 + 10 * s, heat: 0.25 })
    const f1 = flow([{ x: 50, y: 0 }, { x: 50, y: 10 }], { heat: 0.75 })
    const { vertices } = buildStrips([f0, f1], { levee: 2.2 })
    expect(vertices[2 * STRIDE + 4]).toBe(7.5) // point 1 of 3, along 0.5: width 15
    expect(vertices[4 * STRIDE + 4]).toBe(10) // toe, width 20
    expect(vertices[5]).toBe(0.25)
    expect(vertices[6]).toBe(0)
    const second = 12 * STRIDE // first vertex of the second channel
    expect(vertices[second + 5]).toBe(0.75)
    expect(vertices[second + 6]).toBe(1)
  })
  it('indexes two triangles per point pair, the levee strip before the channel strip', () => {
    const { indices } = buildStrips([flow([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 20 }])], { levee: 2.2 })
    expect(indices).toBeInstanceOf(Uint16Array)
    expect([...indices]).toEqual([
      6, 7, 8, 7, 9, 8, 8, 9, 10, 9, 11, 10, // levee, vertices 6..11
      0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, // channel, vertices 0..5
    ])
  })
  it('offsets the indices of later channels past the vertices of earlier ones', () => {
    const { indices, count } = buildStrips([flow([{ x: 0, y: 0 }, { x: 0, y: 10 }]), flow([{ x: 9, y: 0 }, { x: 9, y: 10 }])], { levee: 2.2 })
    expect(count).toBe(16)
    expect(indices.length).toBe(24) // 2 triangles * 3 * 1 pair * 2 strips * 2 channels
    expect([...indices.slice(12)]).toEqual([12, 13, 14, 13, 15, 14, 8, 9, 10, 9, 11, 10])
    expect(Math.max(...indices)).toBe(count - 1)
  })
  it('reports where each channel keeps its levee and channel indices, so the layer can draw by order', () => {
    const one = buildStrips([flow([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 20 }])], { levee: 2.2 })
    expect(one.ranges).toEqual([{ levee: [0, 12], channel: [12, 12] }])
    const two = buildStrips([flow([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 20 }]), flow([{ x: 9, y: 0 }, { x: 9, y: 10 }])], { levee: 2.2 })
    expect(two.ranges[1].levee[0]).toBe(two.ranges[0].channel[0] + two.ranges[0].channel[1])
    expect(two.ranges[1]).toEqual({ levee: [24, 6], channel: [30, 6] })
    expect(two.ranges[1].channel[0] + two.ranges[1].channel[1]).toBe(two.indices.length)
  })
  it('has no ranges for no flows', () => {
    expect(buildStrips([], { levee: 2.2 }).ranges).toEqual([])
  })
  it('makes no triangles for a flow with fewer than two points and does not poison the vertices with NaN', () => {
    const { vertices, indices, count } = buildStrips([flow([{ x: 3, y: 4 }])], { levee: 2.2 })
    expect(count).toBe(4)
    expect(indices.length).toBe(0)
    expect([...vertices].every(Number.isFinite)).toBe(true)
  })
})

// A trunk straight down x = 0 (eleven points, 100 px, 20 wide) and a feeder from one side that ends on it at y = 50.
const trunk = () => flow(Array.from({ length: 11 }, (_, i) => ({ x: 0, y: i * 10 })), { head: true, widthAt: () => 20 })
const feederFrom = (side) => flow([{ x: side * 60, y: 0 }, { x: side * 40, y: 20 }, { x: side * 20, y: 38 }, { x: side * 8, y: 46 }, { x: 0, y: 50 }])
const join = { feeder: 1, trunk: 0, at: 0.5, wf: 10, wt: 20, wj: 28 }
const LEVEE = 1.25
const indicesOf = (s, [start, count]) => [...s.indices.slice(start, start + count)]
const vertex = (s, i) => Array.from(s.vertices.slice(i * STRIDE, (i + 1) * STRIDE))

// A Task 3 feeder by hand: it comes in `deg` degrees off the trunk's heading, then eases (cubic) onto it over its last
// `easeLen` px and ends on the trunk's centreline at (0, 0). Built backward from the join in 4 px steps. `side` -1
// comes from the left (x < 0), 1 from the right.
const ease = (u) => (u >= 1 ? 1 : 3 * u * u - 2 * u * u * u)
const easedPts = (side, { deg = 25, easeLen = 48, total = 240, ds = 4 } = {}) => {
  const back = [{ x: 0, y: 0 }]
  for (let s = 0; s < total; s += ds) {
    const a = ((deg * Math.PI) / 180) * ease(s / easeLen)
    const p = back[back.length - 1]
    back.push({ x: p.x + side * Math.sin(a) * ds, y: p.y - Math.cos(a) * ds })
  }
  return back.reverse()
}
// The trunk runs straight down x = 0 from y = -300 to 300 (61 points), so the join at y = 0 is at = 0.5 and a point's
// along is (y + 300) / 600.
const longTrunk = (hw = 20) => flow(Array.from({ length: 61 }, (_, i) => ({ x: 0, y: -300 + i * 10 })), { head: true, widthAt: () => hw * 2 })
const easedFeeder = (side, hw = 8, opts) => flow(easedPts(side, opts), { widthAt: () => hw * 2 })
const vee = { feeder: 1, trunk: 0, at: 0.5, wf: 16, wt: 40, wj: 55 }
// The last fan's 15 vertices: the tip, the 7 arc points, then the 7 feather points just outside the arc.
const fanOf = (s) => Array.from({ length: 15 }, (_, i) => vertex(s, s.count - 15 + i))
// Distance from (x, y) to a polyline.
const distTo = (pts, x, y) => {
  let best = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const dx = pts[i + 1].x - a.x
    const dy = pts[i + 1].y - a.y
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)))
    best = Math.min(best, Math.hypot(x - a.x - dx * t, y - a.y - dy * t))
  }
  return best
}
const inTriangle = (px, py, a, b, c) => {
  const d = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
  const d1 = d([px, py], a, b)
  const d2 = d([px, py], b, c)
  const d3 = d([px, py], c, a)
  const neg = d1 < -1e-6 || d2 < -1e-6 || d3 < -1e-6
  const pos = d1 > 1e-6 || d2 > 1e-6 || d3 > 1e-6
  return !(neg && pos)
}
const fanCovers = (s, x, y) => {
  const idx = indicesOf(s, s.filletRange)
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => vertex(s, idx[t + k]))
    if (inTriangle(x, y, a, b, c)) return true
  }
  return false
}

describe('fillet fans', () => {
  it('adds, per join, 6 triangles from the tip over the arc and a 12-triangle feather strip, on 15 new vertices that all carry the trunk id and the trunk heat', () => {
    const flows = [trunk(), feederFrom(-1)]
    const plain = buildStrips(flows, { levee: LEVEE })
    const s = buildStrips(flows, { levee: LEVEE, joins: [join] })
    expect(s.count).toBe(plain.count + 15)
    expect(s.filletRange).toEqual([plain.indices.length, 54])
    expect(s.indices.length).toBe(plain.indices.length + 54)
    const fan = indicesOf(s, s.filletRange)
    expect(fan.length / 3).toBe(18)
    expect([...new Set(fan)].sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, i) => plain.count + i))
    // a triangle fan: every triangle starts at the tip, then steps along the arc (vertices 1-7)
    for (let t = 0; t < 6; t++) expect(fan.slice(t * 3, t * 3 + 3)).toEqual([plain.count, plain.count + 1 + t, plain.count + 2 + t])
    // then the strip from arc point k (1-7) out to its feather point (8-14): two triangles per step, never touching the tip
    for (let k = 0; k < 6; k++) {
      const [a, b, c, d] = [1 + k, 2 + k, 8 + k, 9 + k].map((i) => plain.count + i)
      expect(fan.slice(18 + k * 6, 24 + k * 6)).toEqual([a, b, c, b, d, c])
    }
    for (const i of fan) {
      const [, , , , , heat, id] = vertex(s, i)
      expect(id).toBe(0)
      expect(heat).toBe(1)
    }
  })
  it('gives each join its own fan', () => {
    const s = buildStrips([trunk(), feederFrom(-1), feederFrom(1)], { levee: LEVEE, joins: [join, { ...join, feeder: 2, at: 0.7 }] })
    expect(s.filletRange[1]).toBe(108)
    expect(s.count).toBe(11 * 4 + 5 * 4 + 5 * 4 + 30)
    const second = indicesOf(s, [s.filletRange[0] + 54, 54])
    expect(Math.min(...second)).toBe(s.count - 15)
    expect(Math.max(...second)).toBe(s.count - 1)
  })

  for (const [name, side, sign] of [['from the left', -1, -1], ['from the right', 1, 1]]) {
    describe(`a feeder ${name}, 25 degrees off the trunk, eased on over its last 48 px (trunk half width 20, feeder 8)`, () => {
      // Trunk tangent (0, 1), so +n is -x and the left bank (across -1) is x < 0: a feeder from the left has the inner bank at -1.
      const s = buildStrips([longTrunk(), easedFeeder(side)], { levee: LEVEE, joins: [vee] })
      const feederLine = easedPts(side)
      const fan = fanOf(s)

      it('anchors the tip on both banks: on the trunk bank on the feeder side and on the feeder inner bank, a long way up from the join', () => {
        const [x, y] = fan[0]
        expect(x).toBeCloseTo(side * 20, 2) // the trunk's bank
        expect(distTo(feederLine, x, y)).toBeCloseTo(8, 1) // the feeder's bank (half width 8)
        // Task 3's ease keeps the feeder off the trunk's heading until its last 48 px, so the banks only meet far upstream.
        expect(y).toBeLessThan(-80)
        expect(y).toBeGreaterThan(-95)
      })
      it('runs its arc from the feeder bank to the trunk bank, 2 feeder widths up each from the tip', () => {
        const [tx, ty] = fan[0]
        const e0 = fan[1]
        const e1 = fan[7]
        expect(distTo(feederLine, e0[0], e0[1])).toBeCloseTo(8, 1)
        expect(Math.hypot(e0[0] - tx, e0[1] - ty)).toBeCloseTo(32, 0)
        expect(e1[0]).toBeCloseTo(side * 20, 2)
        expect(ty - e1[1]).toBeCloseTo(32, 0)
        // the middle of the arc is pulled toward the tip: a quadratic Bezier with the tip as its control point
        const mid = fan[4]
        expect(mid[0]).toBeCloseTo(0.25 * e0[0] + 0.5 * tx + 0.25 * e1[0], 3)
        expect(mid[1]).toBeCloseTo(0.25 * e0[1] + 0.5 * ty + 0.25 * e1[1], 3)
      })
      it('keeps every vertex off the feeder centreline, and the arc in the bare ground between the strips', () => {
        for (const [x, y] of fan) expect(distTo(feederLine, x, y)).toBeGreaterThan(16 / 4)
        for (const [x, y] of fan.slice(2, 7)) {
          expect(distTo(feederLine, x, y)).toBeGreaterThan(8 - 0.1) // outside the feeder body
          expect(side * x).toBeGreaterThan(20 - 0.1) // outside the trunk body
        }
      })
      it('covers the ground in the V, from just above the tip up the middle of the V', () => {
        // Find the V independently of the fan: its tip is the row nearest the join (largest y) that has ground between
        // the feeder body and the trunk body, on the trunk's side of the feeder.
        const feederX = (y) => {
          for (let i = 0; i < feederLine.length - 1; i++) {
            const a = feederLine[i]
            const b = feederLine[i + 1]
            if (y >= a.y && y <= b.y) return a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y)
          }
          return NaN
        }
        const row = (y) => {
          const xs = []
          const x0 = feederX(y)
          for (let k = 0; k < 800; k++) {
            const x = x0 - side * 0.05 * k // stepping from the feeder's centreline toward the trunk
            if (side * x <= 20.05) break // into the trunk body
            if (distTo(feederLine, x, y) > 8.05) xs.push(x)
          }
          return xs
        }
        let tipY = null
        for (let y = -75; y > -140; y -= 0.25) {
          if (row(y).length) {
            tipY = y
            break
          }
        }
        expect(tipY).not.toBeNull()
        for (const up of [2, 4, 6]) {
          const xs = row(tipY - up)
          expect(xs.length).toBeGreaterThan(0)
          const mid = xs.reduce((a, b) => a + b, 0) / xs.length
          expect(fanCovers(s, mid, tipY - up)).toBe(true)
        }
      })
      it('does not cover the feeder body, the trunk body or the trunk centre', () => {
        expect(fanCovers(s, 0, -100)).toBe(false)
        expect(fanCovers(s, side * 5, -88)).toBe(false)
        for (const p of feederLine.filter((q) => q.y > -125 && q.y < -85)) expect(fanCovers(s, p.x, p.y)).toBe(false)
      })
      it('puts the tip and the arc at the solid edge of the bank, across sign * (1 - BANK_PX / hw)', () => {
        for (const v of fan.slice(0, 8)) expect(v[2]).toBeCloseTo(sign * (1 - BANK_PX / 20), 5)
      })
      it('puts a feather row 2 * BANK_PX outside the arc (the strips banks ramp width), along its normal and away from the tip, at the 0-alpha across', () => {
        const [tx, ty] = fan[0]
        const e0 = fan[1]
        const e1 = fan[7]
        for (let k = 0; k < 7; k++) {
          const inner = fan[1 + k]
          const outer = fan[8 + k]
          const dx = outer[0] - inner[0]
          const dy = outer[1] - inner[1]
          expect(Math.hypot(dx, dy)).toBeCloseTo(2 * BANK_PX, 3)
          expect(outer[2]).toBeCloseTo(sign * (1 + BANK_PX / 20), 5)
          // perpendicular to the arc: the Bezier's derivative at t is 2 (1 - t) (T - E0) + 2 t (E1 - T)
          const t = k / 6
          const bx = 2 * (1 - t) * (tx - e0[0]) + 2 * t * (e1[0] - tx)
          const by = 2 * (1 - t) * (ty - e0[1]) + 2 * t * (e1[1] - ty)
          expect(dx * bx + dy * by).toBeCloseTo(0, 2)
          // away from the tip (the ends sit on the banks, where the normal has no component along the leg to test)
          if (k > 0 && k < 6) {
            expect(dx * (inner[0] - tx) + dy * (inner[1] - ty)).toBeGreaterThan(0)
            expect(Math.hypot(outer[0] - tx, outer[1] - ty)).toBeGreaterThan(Math.hypot(inner[0] - tx, inner[1] - ty))
          }
        }
      })
      it('gives each vertex the trunk along at its own projection, highest at the tip and below the join', () => {
        const alongs = fan.slice(0, 8).map((v) => v[3])
        for (const v of fan) expect(v[3]).toBeCloseTo((v[1] + 300) / 600, 4)
        expect(Math.max(...alongs)).toBeLessThan(0.5)
        expect(alongs[0]).toBeGreaterThanOrEqual(Math.max(...alongs.slice(1)) - 1e-6)
        expect(new Set(alongs.map((a) => a.toFixed(4))).size).toBeGreaterThan(4)
        // along the arc it rises toward the tip's side then falls: one peak, no dips
        const arc = alongs.slice(1)
        const peak = arc.indexOf(Math.max(...arc))
        for (let k = 1; k <= peak; k++) expect(arc[k]).toBeGreaterThanOrEqual(arc[k - 1] - 1e-6)
        for (let k = peak + 1; k < arc.length; k++) expect(arc[k]).toBeLessThanOrEqual(arc[k - 1] + 1e-6)
      })
      it("takes the trunk's half width at each vertex's own along", () => {
        const wide = { ...longTrunk(), widthAt: (a) => 40 + 40 * a }
        const g = buildStrips([wide, easedFeeder(side)], { levee: LEVEE, joins: [vee] })
        for (const v of fanOf(g)) expect(v[4]).toBeCloseTo((40 + 40 * v[3]) / 2, 3)
        // and the bank edge follows it: 1 - 1/hw solid on the arc, 1 + 1/hw gone on the feather row
        for (const v of fanOf(g).slice(0, 8)) expect(Math.abs(v[2])).toBeCloseTo(1 - BANK_PX / v[4], 4)
        for (const v of fanOf(g).slice(8)) expect(Math.abs(v[2])).toBeCloseTo(1 + BANK_PX / v[4], 4)
        for (const v of fan) expect(v[4]).toBe(20)
      })
    })
  }

  it('anchors on the trunk bank at the join when the feeder bank never meets it, and stays finite', () => {
    // A feeder running parallel to the trunk, 30 px off with half width 8: its inner bank is at x = -22, the trunk's at -20.
    const parallel = flow(Array.from({ length: 21 }, (_, i) => ({ x: -30, y: -200 + i * 10 })), { widthAt: () => 16 })
    const s = buildStrips([longTrunk(), parallel], { levee: LEVEE, joins: [vee] })
    const fan = fanOf(s)
    expect(fan[0][0]).toBeCloseTo(-20, 3)
    expect(fan[0][1]).toBeCloseTo(0, 3)
    expect([...s.vertices].every(Number.isFinite)).toBe(true)
    expect(s.filletRange[1]).toBe(54)
  })
  it('limits the bank edge to half a channel for a trunk under 2 px of half width, and the feather row to the levee', () => {
    const s = buildStrips([longTrunk(1.5), easedFeeder(-1, 1)], { levee: LEVEE, joins: [{ ...vee, wf: 2, wt: 3, wj: 4 }] })
    const fan = fanOf(s)
    for (const v of fan.slice(0, 8)) expect(v[2]).toBeCloseTo(-0.5, 5)
    for (const v of fan.slice(8)) expect(v[2]).toBeCloseTo(-LEVEE, 5) // 1 + 1 / 1.5 would be 1.5, past what the field holds
    expect([...s.vertices].every(Number.isFinite)).toBe(true)
  })
  it("uses the lava pass's BANK_PX", () => {
    expect(Number(/const float BANK_PX\s*=\s*([0-9.]+)/.exec(LAVA_FRAG)[1])).toBe(BANK_PX)
  })
  it('skips a join it cannot resolve, and makes none for no joins', () => {
    const flows = [trunk(), feederFrom(-1)]
    const plain = buildStrips(flows, { levee: LEVEE })
    expect(plain.filletRange).toEqual([plain.indices.length, 0])
    const bad = [
      { ...join, feeder: 5 },
      { ...join, trunk: -1 },
      { ...join, feeder: 0 },
      { ...join, wf: 0 },
      { ...join, at: NaN },
      { ...join, feeder: undefined },
    ]
    const s = buildStrips(flows, { levee: LEVEE, joins: bad })
    expect(s.count).toBe(plain.count)
    expect(s.filletRange).toEqual([plain.indices.length, 0])
    expect(buildStrips(flows, { levee: LEVEE, joins: null }).filletRange[1]).toBe(0)
  })
  it('stays inside the vertex count, and all its vertices are finite', () => {
    const s = buildStrips([trunk(), feederFrom(-1)], { levee: LEVEE, joins: [join] })
    expect(Math.max(...s.indices)).toBe(s.count - 1)
    expect([...s.vertices].every(Number.isFinite)).toBe(true)
  })
})

describe('the pool strip', () => {
  const cx = 100
  const cy = 200
  const rx = 80
  const ry = 20
  const arcY = (x) => {
    const d = (x - cx) / rx
    return d * d >= 1 ? cy : cy - ry * Math.sqrt(1 - d * d)
  }
  const pool = { cx, cy, rx, ry, arcTop: cy - ry, arcY }
  const flows = [trunk(), feederFrom(-1)]

  it('is channel flows.length: poolId says so, and is null without a pool', () => {
    expect(buildStrips(flows, { levee: LEVEE, pool }).poolId).toBe(2)
    expect(buildStrips([], { levee: LEVEE, pool }).poolId).toBe(0)
    expect(buildStrips(flows, { levee: LEVEE }).poolId).toBeNull()
    expect(buildStrips(flows, { levee: LEVEE, pool: null }).poolId).toBeNull()
  })
  it('is a grid of 25 columns by 7 rings, 24 x 6 quads, all vertices id flows.length with heat 1', () => {
    const s = buildStrips(flows, { levee: LEVEE, pool })
    const plain = buildStrips(flows, { levee: LEVEE })
    expect(s.count).toBe(plain.count + 25 * 7)
    expect(s.indices.length).toBe(plain.indices.length + 24 * 6 * 6)
    for (let i = plain.count; i < s.count; i++) {
      const v = vertex(s, i)
      expect(v[6]).toBe(2)
      expect(v[5]).toBe(1)
    }
    expect(Math.max(...s.indices)).toBe(s.count - 1)
  })
  it('puts its range after the flows, with no levee, and draws it first, under the streams', () => {
    const plain = buildStrips(flows, { levee: LEVEE })
    const s = buildStrips(flows, { levee: LEVEE, pool })
    expect(s.ranges).toHaveLength(3)
    expect(s.ranges.slice(0, 2)).toEqual(plain.ranges)
    const end = plain.indices.length
    expect(s.ranges[2]).toEqual({ levee: [end, 0], channel: [end, 864] })
    expect(s.order).toEqual([2, 1, 0]) // the pool, the feeder, then the trunk (the head) last
  })
  it('covers the ellipse: every vertex inside it grown by 1.26, and the along-0 row on the entry arc', () => {
    const s = buildStrips(flows, { levee: LEVEE, pool })
    const plain = buildStrips(flows, { levee: LEVEE })
    let arcRow = 0
    for (let i = plain.count; i < s.count; i++) {
      const [x, y, across, along] = vertex(s, i)
      expect(((x - cx) / (rx * 1.26)) ** 2 + ((y - cy) / (ry * 1.26)) ** 2).toBeLessThanOrEqual(1)
      // and in fact inside the ellipse itself, to float error
      expect(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2).toBeLessThanOrEqual(1 + 1e-4)
      if (along === 0) {
        arcRow++
        expect(y).toBeCloseTo(arcY(x), 3)
        expect(y).toBeLessThanOrEqual(cy + 1e-3) // the upper half
      }
      expect(across).toBeGreaterThanOrEqual(-1)
      expect(across).toBeLessThanOrEqual(1)
    }
    expect(arcRow).toBe(25)
  })
  it('runs across from the left tip to the right tip, and along from the arc to the mirror point on the far shore', () => {
    const s = buildStrips([], { levee: LEVEE, pool })
    const at = (ring, col) => vertex(s, ring * 25 + col)
    expect(at(0, 0).slice(0, 4)).toEqual([expect.closeTo(cx - rx, 3), expect.closeTo(cy, 3), -1, 0])
    expect(at(0, 24).slice(0, 4)).toEqual([expect.closeTo(cx + rx, 3), expect.closeTo(cy, 3), 1, 0])
    expect(at(0, 12)[2]).toBeCloseTo(0)
    expect(at(0, 12)[1]).toBeCloseTo(cy - ry, 3) // the arc's top, over the pool's centre
    // columns step right
    for (let col = 1; col <= 24; col++) expect(at(0, col)[0]).toBeGreaterThan(at(0, col - 1)[0])
    for (let col = 0; col <= 24; col++) {
      expect(at(6, col)[3]).toBe(1)
      expect(at(6, col)[1]).toBeCloseTo(2 * cy - arcY(at(6, col)[0]), 2)
      expect(at(3, col)[1]).toBeCloseTo(cy, 2) // ring 3 of 6 is the centre line
    }
  })
  it('has across linear in x, (x - cx) / rx, so the sim entry position (endX - cx) / rx lands under the stream', () => {
    const s = buildStrips(flows, { levee: LEVEE, pool })
    const plain = buildStrips(flows, { levee: LEVEE })
    for (let i = plain.count; i < s.count; i++) {
      const [x, , across] = vertex(s, i)
      expect(across).toBeCloseTo((x - cx) / rx, 5)
    }
    // A stream entering half a pool width right of centre: the vertices at across 0.5 sit at x = cx + 0.5 rx on the
    // arc, not where the angle's midpoint (60 degrees from the tip) would put them.
    const entry = Array.from({ length: 25 }, (_, col) => vertex(s, plain.count + col)).find((v) => Math.abs(v[2] - 0.5) < 0.02)
    expect(entry).toBeDefined()
    expect(entry[0]).toBeCloseTo(cx + 0.5 * rx, 0)
    expect(entry[1]).toBeCloseTo(arcY(cx + 0.5 * rx), 0)
  })
  it('has the ellipse height over two for its half width: ry at the top, none at the tips', () => {
    const s = buildStrips([], { levee: LEVEE, pool })
    expect(vertex(s, 12)[4]).toBeCloseTo(ry, 3)
    expect(vertex(s, 0)[4]).toBeCloseTo(0, 3)
    expect(vertex(s, 24)[4]).toBeCloseTo(0, 3)
    for (let col = 0; col <= 24; col++) expect(vertex(s, col)[4]).toBeCloseTo(cy - arcY(vertex(s, col)[0]), 3)
  })
  it('works from the ellipse alone when the pool has no arcY, and ignores a pool with no size', () => {
    const bare = buildStrips([], { levee: LEVEE, pool: { cx, cy, rx, ry } })
    const full = buildStrips([], { levee: LEVEE, pool })
    for (let i = 0; i < bare.vertices.length; i++) expect(bare.vertices[i]).toBeCloseTo(full.vertices[i], 3)
    const empty = buildStrips(flows, { levee: LEVEE, pool: { cx, cy, rx: 0, ry } })
    expect(empty.poolId).toBeNull()
    expect(empty.ranges).toHaveLength(2)
  })
  it('keeps the fillet range after the pool range, so it is drawn after every channel', () => {
    const s = buildStrips(flows, { levee: LEVEE, pool, joins: [join] })
    const pr = s.ranges[2].channel
    expect(s.filletRange).toEqual([pr[0] + pr[1], 54])
    expect(s.filletRange[0] + s.filletRange[1]).toBe(s.indices.length)
    // every channel range ends at or before the fillet range starts
    for (const r of s.ranges) expect(r.channel[0] + r.channel[1]).toBeLessThanOrEqual(s.filletRange[0])
  })
})

describe('bounds', () => {
  it('is the padded union of every channel, or empty', () => {
    expect(bounds([flow([{ x: 10, y: 10 }, { x: 20, y: 40 }]), flow([{ x: 0, y: 50 }, { x: 5, y: 60 }])], 11)).toEqual({ x: -11, y: -1, w: 42, h: 72 })
    expect(bounds([], 11)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
  it('grows to hold the pool ellipse, with or without flows', () => {
    const pool = { cx: 100, cy: 200, rx: 80, ry: 20 }
    expect(bounds([flow([{ x: 90, y: 10 }, { x: 100, y: 180 }])], 10, pool)).toEqual({ x: 10, y: 0, w: 180, h: 230 })
    expect(bounds([], 10, pool)).toEqual({ x: 10, y: 170, w: 180, h: 60 })
    expect(bounds([], 10, { cx: 0, cy: 0, rx: 0, ry: 0 })).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})
