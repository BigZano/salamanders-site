import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildNetwork, joinedWidth, joinWidthProfile, approachAngleDeg, resample, tangentAt, CONFLUENCE_MAX_DEG } from './lavaNetwork'

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A mountain as `buildMountain` returns it, as plain data: a symmetric cone with the same concave profile (the
 * flank is x = peakX +- (craterHalf + f^2.4 * (halfBase - craterHalf)), one row per step from the peak down), the
 * vent in the breach just off the peak's centre. `terraces` steps the flanks out as the real ones do. `jitter` moves
 * each flank's y, left and right independently, by up to that many px (as buildMountain does: up to +-20 px on rows
 * about 26 px apart), every row but the shared rim; unlike the real thing it does not taper toward the rim, so it is the
 * harsher case. `halfBase` sets the cone's half base outright (by default the wider of the viewport's share and the slope's).
 */
function cone({ w = 1600, rows = 60, height = 640, peakY = 240, peakFrac = 0.42, craterHalf = 40, ventSide = 1, terraces = false, jitter = 0, halfBase: base } = {}) {
  const jr = mulberry32(99)
  const jit = (i) => (i > 0 ? (jr() * 2 - 1) * jitter : 0)
  const peakX = w * peakFrac
  const halfBase = base ?? Math.max((w * 0.55) / 2, height * 0.6)
  const left = []
  const right = []
  for (let i = 0; i < rows; i++) {
    const f = i / (rows - 1)
    const dx = craterHalf + Math.pow(f, 2.4) * (halfBase - craterHalf)
    left.push({ x: peakX - dx, y: peakY + f * height + jit(i) })
    right.push({ x: peakX + dx, y: peakY + f * height + jit(i) })
  }
  if (terraces) {
    for (const [k, out] of [[Math.floor(rows * 0.3), 0.04], [Math.floor(rows * 0.55), 0.06], [Math.floor(rows * 0.75), 0.05]]) {
      for (let i = k; i < rows; i++) {
        left[i].x -= out * halfBase
        right[i].x += out * halfBase * 0.6
      }
    }
  }
  return {
    peakX,
    peakY,
    craterHalf,
    left,
    right,
    rimL: { ...left[0] },
    rimR: { ...right[0] },
    vent: { x: peakX + ventSide * 0.12 * craterHalf, y: peakY + 0.36 * craterHalf },
  }
}

// the builder says (console.debug, in dev) when a stream falls back to the pool; the tests that do not care keep it quiet
beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

const opts = (seed, extra = {}) => ({ w: 1600, h: 1000, phone: false, rng: mulberry32(seed), ...extra })
const kinds = (flows) => flows.map((f) => f.kind)
const count = (flows, kind) => flows.filter((f) => f.kind === kind).length
// the nominal row spacing: the top and bottom rows' mean y, so a flank's own jitter does not count
const rowHeight = (m) => {
  const n = m.left.length - 1
  return ((m.left[n].y + m.right[n].y) / 2 - (m.left[0].y + m.right[0].y) / 2) / n
}
const length = (pts) => pts.slice(1).reduce((a, p, i) => a + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0)
const seeds = Array.from({ length: 25 }, (_, i) => i + 1)
// the point `at` (0 to 1, by point index) along a polyline
const along = (pts, at) => {
  const f = Math.max(0, Math.min(1, at)) * (pts.length - 1)
  const i = Math.min(pts.length - 2, Math.floor(f))
  const r = f - i
  return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * r, y: pts[i].y + (pts[i + 1].y - pts[i].y) * r }
}
// the nearest distance from a point to a polyline
const distTo = (pts, q) => {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
    const r = l2 ? Math.max(0, Math.min(1, ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / l2)) : 0
    best = Math.min(best, Math.hypot(q.x - (a.x + (b.x - a.x) * r), q.y - (a.y + (b.y - a.y) * r)))
  }
  return best
}
// where a stream ends: a stream into the pool on its arc, with `drainAt` the entry across it (-1 to 1); one that joins on
// its trunk's centreline at `drainAt`
function expectEnd(f, flows, pool, withinPool = true) {
  const end = f.pts[f.pts.length - 1]
  if (f.drain === -1) {
    expect(Math.abs(end.y - pool.arcY(end.x))).toBeLessThan(1e-3)
    if (withinPool) expect(Math.abs(end.x - pool.cx)).toBeLessThan(pool.rx)
    expect(f.drainAt).toBeGreaterThanOrEqual(-1)
    expect(f.drainAt).toBeLessThanOrEqual(1)
    expect(f.drainAt).toBeCloseTo(Math.max(-1, Math.min(1, (end.x - pool.cx) / pool.rx)), 9)
  } else {
    expect(flows[f.drain].role).toBe('trunk')
    const t = along(flows[f.drain].pts, f.drainAt)
    expect(Math.hypot(end.x - t.x, end.y - t.y)).toBeLessThan(1e-6)
  }
}

// The steepest angle, in degrees, a drawn feeder makes with its trunk over its last `span` px: each chord against the
// direction of the trunk's nearest segment (the stretch above the turn counts, not the aim, and not the very end where the
// turn has made it 0).
function drawnWorst(f, T, span) {
  const unit = (a, b) => {
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
  }
  const nearestSeg = (p) => {
    let best = Infinity
    let bi = 0
    for (let i = 1; i < T.length; i++) {
      const a = T[i - 1]
      const b = T[i]
      const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
      const r = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0
      const d = Math.hypot(p.x - (a.x + (b.x - a.x) * r), p.y - (a.y + (b.y - a.y) * r))
      if (d < best) [best, bi] = [d, i - 1]
    }
    return bi
  }
  let arc = 0
  let worst = 0
  for (let k = f.pts.length - 1; k >= 1; k--) {
    arc += Math.hypot(f.pts[k].x - f.pts[k - 1].x, f.pts[k].y - f.pts[k - 1].y)
    if (arc > span) break
    const a = unit(f.pts[k - 1], f.pts[k])
    const i = nearestSeg(f.pts[k])
    const b = unit(T[i], T[i + 1])
    worst = Math.max(worst, (Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))) * 180) / Math.PI)
  }
  return worst
}

describe('buildNetwork sources', () => {
  test('desktop has a trunk, one rim overflow, three fissures and the fork arm', () => {
    const { flows, fissures, joins } = buildNetwork(cone(), opts(7))
    // the sixth is the arm of the trunk's fork (the standard cone has the room for it)
    expect(flows).toHaveLength(6)
    expect(count(flows, 'trunk')).toBe(1)
    expect(count(flows, 'rim')).toBe(1)
    expect(count(flows, 'fissure')).toBe(3)
    expect(count(flows, 'braid')).toBe(1)
    expect(flows.filter((f) => f.head)).toHaveLength(1)
    expect(flows.find((f) => f.head).kind).toBe('trunk')
    expect(fissures).toHaveLength(3)
    expect(Array.isArray(joins)).toBe(true)
    // and without it, the five
    expect(buildNetwork(cone(), opts(7, { braid: false })).flows).toHaveLength(5)
  })

  test('phone has a trunk and one fissure', () => {
    const { flows, fissures } = buildNetwork(cone(), opts(7, { phone: true }))
    expect(kinds(flows)).toEqual(['trunk', 'fissure'])
    expect(fissures).toHaveLength(1)
    expect(flows.filter((f) => f.head)).toHaveLength(1)
  })

  test('every flow carries the shape the strips, sim and riders read', () => {
    const { flows, fissures } = buildNetwork(cone(), opts(7))
    for (const f of flows) {
      expect(f.pts.length).toBeGreaterThan(4)
      for (const p of f.pts) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.u)).toBe(true)
        expect(Math.abs(p.u)).toBeLessThanOrEqual(0.94 + 1e-9)
      }
      expect(typeof f.widthAt).toBe('function')
      // every source is a vent row of its own, the fork's arm excepted: it leaves the trunk part way down
      if (f.role === 'fork') {
        expect(f.parent).toBe(0)
        expect(f.attach).toBeGreaterThan(0)
        expect(f.attach).toBeLessThan(1)
      } else {
        expect(f.parent).toBe(-1)
        expect(f.attach).toBe(0)
      }
      // into the pool (-1, `drainAt` the entry across its arc) or onto the trunk (0, `drainAt` the place along it)
      expect([-1, 0]).toContain(f.drain)
      if (f.drain === -1) expect(Math.abs(f.drainAt)).toBeLessThanOrEqual(1)
      else expect(f.drainAt).toBeGreaterThan(0)
    }
    // fissure flows point at their crack; the others at none
    flows.forEach((f) => {
      if (f.kind === 'fissure') expect(fissures[f.sourceIndex]).toBeDefined()
      else expect(f.sourceIndex).toBe(-1)
    })
    const fl = flows.filter((f) => f.kind === 'fissure')
    fl.forEach((f) => {
      const c = fissures[f.sourceIndex]
      expect(f.pts[0].x).toBeCloseTo(c.x, 6)
      expect(f.pts[0].y).toBeCloseTo(c.y, 6)
    })
  })

  test('source heat: breach 1, rim 0.8, fissures 0.7 to 0.85', () => {
    for (const seed of seeds) {
      const { flows } = buildNetwork(cone(), opts(seed))
      expect(flows[0].heat).toBe(1)
      expect(flows.find((f) => f.kind === 'rim').heat).toBe(0.8)
      for (const f of flows.filter((x) => x.kind === 'fissure')) {
        expect(f.heat).toBeGreaterThanOrEqual(0.7)
        expect(f.heat).toBeLessThanOrEqual(0.85)
      }
    }
  })

  test('the trunk leaves from the vent', () => {
    const m = cone()
    const { flows } = buildNetwork(m, opts(7))
    expect(flows[0].pts[0].x).toBeCloseTo(m.vent.x, 6)
    expect(flows[0].pts[0].y).toBeCloseTo(m.vent.y, 6)
  })

  test('the rim overflow starts on the lip on the far side of the peak from the breach', () => {
    for (const ventSide of [1, -1]) {
      const m = cone({ ventSide })
      const { flows } = buildNetwork(m, opts(7))
      const rim = flows.find((f) => f.kind === 'rim')
      const lip = ventSide > 0 ? m.rimL : m.rimR
      // on the lip, and a crater half width or so from the breach
      expect(Math.abs(rim.pts[0].x - lip.x)).toBeLessThan(0.1 * m.craterHalf)
      expect(Math.abs(rim.pts[0].y - lip.y)).toBeLessThan(1)
      expect(Math.sign(rim.pts[0].x - m.peakX)).toBe(-ventSide)
      expect(Math.abs(rim.pts[0].x - m.vent.x)).toBeGreaterThan(0.9 * m.craterHalf)
      expect(Math.abs(rim.pts[0].x - m.vent.x)).toBeLessThan(2 * m.craterHalf)
    }
  })

  test('fissures sit upper face on the breach side, mid and lower on the far side, top to bottom', () => {
    for (const seed of seeds) {
      const m = cone()
      const { fissures } = buildNetwork(m, opts(seed))
      expect(fissures[0].x).toBeGreaterThan(m.peakX)
      expect(fissures[1].x).toBeLessThan(m.peakX)
      expect(fissures[2].x).toBeLessThan(m.peakX)
      expect(fissures[0].y).toBeLessThan(fissures[1].y)
      expect(fissures[1].y).toBeLessThan(fissures[2].y)
    }
  })

  test('a phone fissure sits on the side the page shows', () => {
    // peak left of centre: the face is to the right
    const right = buildNetwork(cone({ w: 1600, peakFrac: 0.42 }), opts(7, { phone: true }))
    expect(right.fissures[0].x).toBeGreaterThan(672)
    const left = buildNetwork(cone({ w: 1600, peakFrac: 0.6 }), opts(7, { phone: true }))
    expect(left.fissures[0].x).toBeLessThan(960)
  })

  test('each crack is 3 to 5 rows tall and within 15 degrees of vertical, and stays on the face', () => {
    for (const seed of seeds) {
      const m = cone()
      const { fissures } = buildNetwork(m, opts(seed))
      for (const c of fissures) {
        expect(c.rows).toBeGreaterThanOrEqual(3)
        expect(c.rows).toBeLessThanOrEqual(5)
        expect(Math.abs(c.tilt)).toBeLessThanOrEqual((15 * Math.PI) / 180 + 1e-9)
        const topX = c.x + Math.sin(c.tilt) * c.rows * rowHeight(m)
        const topY = c.y - Math.cos(c.tilt) * c.rows * rowHeight(m)
        const row = Math.round((topY - m.left[0].y) / rowHeight(m))
        expect(Math.abs(topX - (m.left[row].x + m.right[row].x) / 2)).toBeLessThan((m.right[row].x - m.left[row].x) / 2)
      }
    }
  })
})

describe('buildNetwork pool', () => {
  test('an ellipse on the foreground ridge line, 0.45 of the base wide (rx 0.225) and a quarter of that tall', () => {
    const m = cone()
    const { pool } = buildNetwork(m, opts(7))
    const base = m.right[59].x - m.left[59].x
    expect(pool.rx).toBeCloseTo(0.225 * base, 6) // S5.6: the width is 0.4 to 0.5 of the base
    expect(2 * pool.rx).toBeGreaterThanOrEqual(0.4 * base)
    expect(2 * pool.rx).toBeLessThanOrEqual(0.5 * base)
    expect(pool.ry).toBeCloseTo(pool.rx / 4, 6)
    expect(pool.cy).toBeCloseTo(m.left[59].y - pool.ry * 0.2, 6)
    expect(pool.arcTop).toBeCloseTo(pool.cy - pool.ry, 6)
    expect(pool.arcY(pool.cx)).toBeCloseTo(pool.arcTop, 6)
    expect(pool.arcY(pool.cx + pool.rx * 0.6)).toBeCloseTo(pool.cy - pool.ry * 0.8, 6)
  })

  test('it sits under the trunk', () => {
    for (const seed of seeds) {
      const { flows, pool } = buildNetwork(cone(), opts(seed))
      const end = flows[0].pts[flows[0].pts.length - 1]
      expect(Math.abs(end.x - pool.cx)).toBeLessThan(8)
    }
  })

  test('every stream ends on the pool arc or on the centreline of its drain at drainAt', () => {
    for (const phone of [false, true]) {
      for (const seed of seeds) {
        const { flows, pool } = buildNetwork(cone(), opts(seed, { phone }))
        for (const f of flows) {
          expectEnd(f, flows, pool)
          // and never runs through the pool first
          for (const p of f.pts) expect(p.y).toBeLessThanOrEqual(pool.arcY(p.x) + 1)
        }
        // the trunk and the lower fissure never join
        expect(flows[0].drain).toBe(-1)
        const lower = flows.find((f) => f.role === 'lower')
        if (lower) expect(lower.drain).toBe(-1)
      }
    }
  })

  test('it holds on a narrow phone cone and on a mountain with terraces', () => {
    for (const m of [cone({ w: 390, height: 500, rows: 27, craterHalf: 18 }), cone({ rows: 27, terraces: true })]) {
      for (const phone of [false, true]) {
        const { flows, pool } = buildNetwork(m, { w: 390, h: 844, phone, rng: mulberry32(3) })
        // five on desktop, and the fork's arm where the trunk has the room
        expect(flows.filter((f) => f.kind !== 'braid').length).toBe(phone ? 2 : 5)
        expect(flows.length).toBeLessThanOrEqual(phone ? 2 : 6)
        for (const f of flows) expectEnd(f, flows, pool)
      }
    }
  })

  test('a phone pool sits below the screen: centre under the bottom edge, the arc a little above it', () => {
    // a phone page: the cone's foot is the screen's bottom edge (buildMountain puts the base at y = h)
    const h = 844
    for (const seed of seeds) {
      const m = cone({ w: 390, rows: 27, height: 560, peakY: h - 560, craterHalf: 18, jitter: 20 })
      const { pool, flows } = buildNetwork(m, { w: 390, h, phone: true, rng: mulberry32(seed) })
      expect(pool.cy).toBeGreaterThan(h)
      expect(pool.arcTop).toBeGreaterThan(h - pool.ry)
      expect(pool.cy).toBeCloseTo(h + 0.4 * pool.ry, 6)
      expect(pool.arcTop).toBeCloseTo(h - 0.6 * pool.ry, 6)
      // the streams still land on it (or on the trunk above it), inside the cone
      for (const f of flows) {
        expectEnd(f, flows, pool)
        expect(f.pts[f.pts.length - 1].y).toBeLessThan(h)
      }
    }
  })

  test('a desktop pool ignores the screen height: it sits on the ridge line', () => {
    const m = cone({ jitter: 20 })
    const a = buildNetwork(m, { w: 1600, h: 1000, phone: false, rng: mulberry32(7) }).pool
    const b = buildNetwork(m, { w: 1600, h: 400, phone: false, rng: mulberry32(7) }).pool
    expect(a.cy).toBe(b.cy)
    const foot = (m.left[59].y + m.right[59].y) / 2
    expect(a.cy).toBeCloseTo(foot - a.ry * 0.2, 6)
  })

  test('every stream into the pool enters inside its arc; the lower fissure enters well away from the trunk', () => {
    // unclamped: the entry (end x - cx) / rx is what `drainAt` says, and it never needs clamping to -1..1
    const cases = [cone(), cone({ rows: 27, jitter: 20 }), cone({ rows: 27, terraces: true, jitter: 20 }), cone({ rows: 27, height: 276, jitter: 20 })]
    for (const m of cases) {
      for (let seed = 1; seed <= 100; seed++) {
        const { flows, pool } = buildNetwork(m, opts(seed))
        for (const f of flows) {
          if (f.drain !== -1) continue
          const e = (f.pts[f.pts.length - 1].x - pool.cx) / pool.rx
          expect(Math.abs(e)).toBeLessThanOrEqual(1)
          expect(f.drainAt).toBeCloseTo(e, 9)
          if (f.role === 'trunk') expect(Math.abs(e)).toBeLessThan(0.05)
          // the fork's arm enters 0.15 or more from the trunk's, inside the arc (its own tests say more)
          else if (f.role === 'fork') expect(Math.abs(e)).toBeGreaterThanOrEqual(0.15)
          // the others (the lower fissure, and any tributary that drains alone) come in 0.4 to 0.9 out, never at the trunk's entry
          else {
            expect(Math.abs(e)).toBeGreaterThanOrEqual(0.4)
            expect(Math.abs(e)).toBeLessThanOrEqual(0.9)
          }
        }
      }
    }
  })

  test('a phone pool whose cone stops well short of the screen is lifted onto the cone', () => {
    // the foot is far above h: the pool top must still be reachable by the streams
    const m = cone({ w: 390, rows: 27, height: 300, peakY: 100, craterHalf: 18 })
    const { pool, flows } = buildNetwork(m, { w: 390, h: 844, phone: true, rng: mulberry32(3) })
    expect(pool.arcTop).toBeLessThan(400)
    for (const f of flows) expectEnd(f, flows, pool)
  })
})

describe('buildNetwork streams', () => {
  test('same seed same network, different seed different', () => {
    const a = buildNetwork(cone(), opts(7))
    const b = buildNetwork(cone(), opts(7))
    const c = buildNetwork(cone(), opts(8))
    expect(a.flows.map((f) => f.pts)).toEqual(b.flows.map((f) => f.pts))
    expect(a.flows.map((f) => [f.heat, f.role, f.aim, f.widthAt(0), f.widthAt(0.5), f.widthAt(1)])).toEqual(
      b.flows.map((f) => [f.heat, f.role, f.aim, f.widthAt(0), f.widthAt(0.5), f.widthAt(1)]),
    )
    const pa = buildNetwork(cone(), opts(7, { phone: true }))
    const pb = buildNetwork(cone(), opts(7, { phone: true }))
    expect(pa.flows.map((f) => f.pts)).toEqual(pb.flows.map((f) => f.pts))
    expect(pa.pool.cy).toBe(pb.pool.cy)
    expect(a.fissures).toEqual(b.fissures)
    expect(a.joins).toEqual(b.joins)
    expect(a.pool.cx).toBe(b.pool.cx)
    expect(a.flows.map((f) => f.pts)).not.toEqual(c.flows.map((f) => f.pts))
  })

  test('the builder only ever uses the rng it is given', () => {
    const spy = vi.spyOn(Math, 'random')
    buildNetwork(cone(), opts(7))
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  test('no segment turns more than 12 degrees', () => {
    const turn = (a, b, c) => {
      const d1x = b.x - a.x
      const d1y = b.y - a.y
      const d2x = c.x - b.x
      const d2y = c.y - b.y
      const cos = (d1x * d2x + d1y * d2y) / (Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y))
      return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
    }
    const mountains = [
      cone(),
      cone({ rows: 30 }),
      cone({ rows: 27, terraces: true }),
      cone({ w: 390, height: 500, rows: 27, craterHalf: 18 }),
      // as buildMountain draws it: each flank's y jittered on its own, by up to +-20 px on rows ~26 px apart
      cone({ rows: 27, jitter: 20 }),
      cone({ rows: 27, terraces: true, jitter: 20 }),
      cone({ rows: 60, jitter: 20 }),
      cone({ w: 390, height: 500, rows: 27, craterHalf: 18, jitter: 20 }),
      // low routes: /planner's 276 px, and a cone so short the vent sits a pixel above its first row
      cone({ rows: 27, height: 276, jitter: 20 }),
      cone({ rows: 14, height: 200, jitter: 20 }),
    ]
    for (const m of mountains) {
      for (const phone of [false, true]) {
        for (const seed of seeds) {
          const { flows } = buildNetwork(m, { w: 1600, h: 1000, phone, rng: mulberry32(seed) })
          for (const f of flows) {
            for (let i = 1; i < f.pts.length - 1; i++) expect(turn(f.pts[i - 1], f.pts[i], f.pts[i + 1])).toBeLessThanOrEqual(12)
          }
        }
      }
    }
  })

  test('a jittered mountain builds in under 2 ms (median of 50 seeds)', () => {
    const m = cone({ rows: 27, jitter: 20 })
    for (const phone of [false, true]) {
      buildNetwork(m, opts(0, { phone })) // warm the code up
      const ms = seeds.concat(seeds).map((seed) => {
        const t = performance.now()
        buildNetwork(m, opts(seed, { phone }))
        return performance.now() - t
      })
      ms.sort((a, b) => a - b)
      expect(ms[ms.length >> 1]).toBeLessThan(2)
    }
  })

  test('no straight run is longer than half a row, and the points are evenly spaced', () => {
    // the spec asks for no run longer than one row; the builder cuts at half a row so a bend of 12 degrees a chord can be
    // twice as tight (which is what lets a tributary on a 24 px row join its trunk at all)
    for (const m of [cone(), cone({ rows: 27, jitter: 20 })]) {
      const { flows } = buildNetwork(m, opts(7))
      for (const f of flows) {
        const d = f.pts.slice(1).map((p, i) => Math.hypot(p.x - f.pts[i].x, p.y - f.pts[i].y))
        expect(Math.max(...d)).toBeLessThanOrEqual(0.5 * rowHeight(m) + 1e-6)
        expect(Math.max(...d) - Math.min(...d)).toBeLessThan(0.3 * rowHeight(m))
      }
    }
  })

  test('streams run downhill', () => {
    for (const seed of seeds) {
      const { flows } = buildNetwork(cone(), opts(seed))
      for (const f of flows) for (let i = 1; i < f.pts.length; i++) expect(f.pts[i].y).toBeGreaterThan(f.pts[i - 1].y)
    }
  })

  test('the fissures start one under another, top to bottom', () => {
    const m = cone()
    for (const seed of seeds) {
      const { flows } = buildNetwork(m, opts(seed))
      const ys = flows.filter((f) => f.kind === 'fissure').map((f) => f.pts[0].y)
      expect(ys[0]).toBeLessThan(ys[1])
      expect(ys[1]).toBeLessThan(ys[2])
    }
  })

  test('no two fissures share a row, on a low route or a short cone', () => {
    // /planner stands the cone 276 px high on 27 rows; the rest are short or low cones the band can run out on
    for (const [rows, height] of [[27, 276], [27, 640], [14, 200], [20, 276], [30, 276], [30, 640], [60, 640]]) {
      const m = cone({ rows, height, jitter: 20 })
      const rowH = rowHeight(m)
      for (const seed of seeds) {
        const { fissures, flows } = buildNetwork(m, opts(seed))
        const rowsUsed = fissures.map((c) => Math.round((c.y - (m.left[0].y + m.right[0].y) / 2) / rowH))
        expect(new Set(rowsUsed).size).toBe(rowsUsed.length)
        for (let i = 1; i < fissures.length; i++) expect(fissures[i].y).toBeGreaterThan(fissures[i - 1].y)
        // a fissure that drops out drops its stream too, and the lower ones go first
        expect(flows.filter((f) => f.kind === 'fissure')).toHaveLength(fissures.length)
        expect(flows.filter((f) => f.kind === 'fissure').map((f) => f.role)).toEqual(['upper', 'mid', 'lower'].slice(0, fissures.length))
      }
    }
  })

  test('a cone with a one-row band keeps one fissure, not three stacked on a row', () => {
    for (const [rows, height] of [[16, 200], [20, 160], [27, 100], [30, 100]]) {
      const { fissures, flows } = buildNetwork(cone({ rows, height }), opts(7))
      expect(fissures).toHaveLength(1)
      expect(flows.map((f) => f.role)).toEqual(['trunk', 'rim', 'upper'])
    }
  })

  test('a fissure source sits at least 6 rows above the pool arc', () => {
    // a short cone (30 rows), the same cone stretched thin, and the full one
    for (const m of [cone({ rows: 30 }), cone({ rows: 30, height: 300 }), cone()]) {
      for (const phone of [false, true]) {
        for (const seed of seeds) {
          const { fissures, pool } = buildNetwork(m, opts(seed, { phone }))
          for (const c of fissures) {
            expect(pool.arcY(c.x) - c.y).toBeGreaterThanOrEqual(6 * rowHeight(m) - 1e-6)
          }
        }
      }
    }
  })

  test('an impossible cone drops the fissures rather than put one in the pool', () => {
    const m = cone({ rows: 12, height: 120 })
    const { fissures, flows, pool } = buildNetwork(m, opts(7))
    for (const c of fissures) expect(pool.arcY(c.x) - c.y).toBeGreaterThanOrEqual(6 * rowHeight(m) - 1e-6)
    expect(flows.filter((f) => f.kind === 'fissure')).toHaveLength(fissures.length)
  })

  test('a mountain too short to lay out returns nothing', () => {
    expect(buildNetwork(cone({ rows: 5 }), opts(7))).toEqual({ flows: [], pool: null, fissures: [], joins: [] })
  })
})

describe('roles and aims', () => {
  // the S5.3 windows: where along the trunk each tributary is to join
  const windows = { rim: [0.2, 0.35], upper: [0.45, 0.6], mid: [0.65, 0.8], 'phone-fissure': [0.66, 0.85] }
  const mountains = [cone(), cone({ jitter: 20 }), cone({ rows: 27, jitter: 20 }), cone({ rows: 27, terraces: true, jitter: 20 }), cone({ rows: 30 })]

  test('every flow names its role', () => {
    expect(buildNetwork(cone(), opts(7)).flows.map((f) => f.role)).toEqual(['trunk', 'rim', 'upper', 'mid', 'lower', 'fork'])
    expect(buildNetwork(cone(), opts(7, { braid: false })).flows.map((f) => f.role)).toEqual(['trunk', 'rim', 'upper', 'mid', 'lower'])
    expect(buildNetwork(cone(), opts(7, { phone: true })).flows.map((f) => f.role)).toEqual(['trunk', 'phone-fissure'])
  })

  test('every feeder that is to join carries a numeric aim inside its S5.3 window; the rest carry none', () => {
    let aimed = 0
    for (const m of mountains) {
      for (const phone of [false, true]) {
        for (const seed of seeds) {
          const { flows } = buildNetwork(m, opts(seed, { phone }))
          for (const f of flows) {
            const win = windows[f.role]
            if (!win || f.aim === null) {
              // the trunk and the lower fissure never join; a tributary with no row that fits runs to the pool alone
              expect(f.aim).toBeNull()
              continue
            }
            aimed++
            expect(Number.isFinite(f.aim.at)).toBe(true)
            expect(f.aim.at).toBeGreaterThanOrEqual(win[0])
            expect(f.aim.at).toBeLessThanOrEqual(win[1])
            expect(Number.isInteger(f.aim.row)).toBe(true)
            expect(f.aim.row).toBeGreaterThanOrEqual(6)
          }
        }
      }
    }
    expect(aimed).toBeGreaterThan(0)
  })

  test('on the full cone the rim, the upper and the mid fissure all have an aim', () => {
    for (const phone of [false, true]) {
      for (const seed of seeds) {
        const { flows } = buildNetwork(cone(), opts(seed, { phone }))
        for (const f of flows.filter((x) => windows[x.role])) expect(f.aim).not.toBeNull()
        expect(flows.find((f) => f.role === 'lower')?.aim ?? null).toBeNull()
      }
    }
  })

  test('the feeder comes onto the trunk where it was aimed, at under 30 degrees to it', () => {
    // distance from a point to a polyline, and the index of the nearest vertex
    const nearest = (pts, q) => {
      let best = Infinity
      let bi = 0
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]
        const b = pts[i]
        const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
        const r = l2 ? Math.max(0, Math.min(1, ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / l2)) : 0
        const d = Math.hypot(q.x - (a.x + (b.x - a.x) * r), q.y - (a.y + (b.y - a.y) * r))
        if (d < best) [best, bi] = [d, r < 0.5 ? i - 1 : i]
      }
      return { dist: best, index: bi }
    }
    for (const m of [cone(), cone({ rows: 27, jitter: 20 }), cone({ rows: 27, terraces: true, jitter: 20 })]) {
      for (const seed of seeds) {
        const { flows } = buildNetwork(m, opts(seed))
        const trunk = flows[0]
        for (const f of flows.filter((x) => x.aim)) {
          const i = f.aim.at * (trunk.pts.length - 1)
          const q = {
            x: trunk.pts[Math.floor(i)].x + (trunk.pts[Math.ceil(i)].x - trunk.pts[Math.floor(i)].x) * (i - Math.floor(i)),
            y: trunk.pts[Math.floor(i)].y + (trunk.pts[Math.ceil(i)].y - trunk.pts[Math.floor(i)].y) * (i - Math.floor(i)),
          }
          const { dist, index } = nearest(f.pts, q)
          // within a third of a row of the trunk's own line, where it was aimed
          expect(dist).toBeLessThan(0.35 * rowHeight(m))
          const ta = tangentAt(f.pts, index)
          const tb = tangentAt(trunk.pts, Math.round(i))
          const deg = (Math.acos(Math.max(-1, Math.min(1, ta.x * tb.x + ta.y * tb.y))) * 180) / Math.PI
          expect(deg).toBeLessThanOrEqual(CONFLUENCE_MAX_DEG)
        }
      }
    }
  })

  test('on a real-height cone the tributaries join: the mid fissure on at least 90% of seeds, the upper fissure on a low route too', () => {
    const rate = (m, role) => {
      let joined = 0
      let n = 0
      for (let seed = 1; seed <= 100; seed++) {
        const f = buildNetwork(m, opts(seed)).flows.find((x) => x.role === role)
        if (!f) continue
        n++
        if (f.aim) joined++
      }
      return joined / n
    }
    // 27 rows, as buildMountain makes them (flank y jittered), plain and terraced
    expect(rate(cone({ rows: 27, jitter: 20 }), 'mid')).toBeGreaterThanOrEqual(0.9)
    expect(rate(cone({ rows: 27, terraces: true, jitter: 20 }), 'mid')).toBeGreaterThanOrEqual(0.9)
    // /planner stands the cone 276 px high: the V's turn needs room the short trunk has less of; the upper fissure joins on
    // nearly every seed, the rim and the mid fissure on about 4 in 10
    expect(rate(cone({ rows: 27, height: 276, jitter: 20 }), 'upper')).toBeGreaterThanOrEqual(0.9)
    expect(rate(cone({ rows: 27, height: 276, jitter: 20 }), 'rim')).toBeGreaterThanOrEqual(0.3)
    // the rim and the upper fissure join on the plain 27-row cone too
    expect(rate(cone({ rows: 27, jitter: 20 }), 'rim')).toBeGreaterThanOrEqual(0.9)
    expect(rate(cone({ rows: 27, jitter: 20 }), 'upper')).toBeGreaterThanOrEqual(0.9)
  })

  test('the stream that cannot find a row runs to the pool alone', () => {
    // a cone too short for any window: aims drop out, the streams still end on the arc
    const m = cone({ rows: 14, height: 200 })
    const { flows, pool } = buildNetwork(m, opts(7))
    expect(flows.some((f) => f.role !== 'trunk' && f.aim === null)).toBe(true)
    for (const f of flows) expectEnd(f, flows, pool)
  })
})

describe('confluences', () => {
  const mountains = [
    ['the 60-row cone', cone()],
    ['27 rows, jittered', cone({ rows: 27, jitter: 20 })],
    ['27 rows, terraced', cone({ rows: 27, terraces: true, jitter: 20 })],
    ['276 px high', cone({ rows: 27, height: 276, jitter: 20 })],
  ]
  // desktop and phone, the full cone, the 27 rows buildMountain makes (plain and terraced) and the 276 px /planner route
  const angleCases = [
    ['desktop, 60 rows', cone(), false],
    ['desktop, 27 rows jittered', cone({ rows: 27, jitter: 20 }), false],
    ['desktop, 27 rows terraced', cone({ rows: 27, terraces: true, jitter: 20 }), false],
    ['desktop, 276 px high', cone({ rows: 27, height: 276, jitter: 20 }), false],
    ['phone, 60 rows', cone(), true],
    ['phone, 27 rows jittered', cone({ rows: 27, jitter: 20 }), true],
    ['phone, 27 rows terraced', cone({ rows: 27, terraces: true, jitter: 20 }), true],
    ['phone, 276 px high', cone({ rows: 27, height: 276, jitter: 20 }), true],
  ]
  const joinOf = (net, role) => net.joins.find((j) => net.flows[j.feeder].role === role)
  // where the trunk's pool flare begins, as a fraction of its length, and its growth at s: 15% by there
  const sfOf = (m, flows) => 1 - (2 * rowHeight(m)) / length(flows[0].pts)
  const growth = (s, sf) => 1 + 0.15 * Math.min(1, s / sf)

  test('rim joins the trunk between 20% and 35%', () => {
    for (const [name, m] of mountains) {
      let joined = 0
      for (const seed of seeds) {
        const j = joinOf(buildNetwork(m, opts(seed)), 'rim')
        if (!j) continue
        joined++
        expect(j.at, name).toBeGreaterThanOrEqual(0.2)
        expect(j.at, name).toBeLessThanOrEqual(0.35)
      }
      expect(joined, name).toBeGreaterThan(0)
    }
  })

  test('upper fissure joins mid, mid fissure joins low or drains to the pool', () => {
    for (const [name, m] of mountains) {
      for (const seed of seeds) {
        const net = buildNetwork(m, opts(seed))
        const up = joinOf(net, 'upper')
        if (up) {
          expect(up.at, name).toBeGreaterThanOrEqual(0.45)
          expect(up.at, name).toBeLessThanOrEqual(0.6)
        }
        const mid = joinOf(net, 'mid')
        const midFlow = net.flows.find((f) => f.role === 'mid')
        if (mid) {
          expect(mid.at, name).toBeGreaterThanOrEqual(0.65)
          expect(mid.at, name).toBeLessThanOrEqual(0.8)
        } else if (midFlow) {
          expect(midFlow.drain, name).toBe(-1)
        }
      }
    }
    // on the full cone both of them get there
    for (const seed of seeds) {
      const net = buildNetwork(cone(), opts(seed))
      expect(joinOf(net, 'upper')).toBeDefined()
      expect(joinOf(net, 'mid')).toBeDefined()
    }
  })

  test('lower fissure drains to the pool', () => {
    for (const [name, m] of mountains) {
      for (const seed of seeds) {
        const net = buildNetwork(m, opts(seed))
        const i = net.flows.findIndex((f) => f.role === 'lower')
        if (i < 0) continue
        expect(net.flows[i].drain, name).toBe(-1)
        expect(net.flows[i].aim, name).toBeNull()
        expect(
          net.joins.some((j) => j.feeder === i),
          name,
        ).toBe(false)
      }
    }
  })

  test('every join approaches at 30 degrees or less', () => {
    let n = 0
    for (const [name, m] of mountains) {
      for (const phone of [false, true]) {
        for (const seed of seeds) {
          const { flows, joins } = buildNetwork(m, opts(seed, { phone }))
          for (const j of joins) {
            n++
            const f = flows[j.feeder]
            // the angle it came in at, before the turn, and the angle it has at its end
            expect(j.angle, name).toBeLessThanOrEqual(CONFLUENCE_MAX_DEG)
            expect(approachAngleDeg(f.pts, flows[0].pts, j.at), name).toBeLessThanOrEqual(CONFLUENCE_MAX_DEG)
          }
        }
      }
    }
    expect(n).toBeGreaterThan(100)
  })

  test('a feeder ends exactly on its trunk centreline, on a full cone, a phone and a low route', () => {
    let n = 0
    for (const [name, m] of mountains) {
      for (const phone of [false, true]) {
        for (const seed of seeds) {
          const { flows, joins } = buildNetwork(m, opts(seed, { phone }))
          const trunk = flows[0]
          for (const j of joins) {
            n++
            const f = flows[j.feeder]
            expect(f.drain, name).toBe(0)
            expect(j.trunk, name).toBe(0)
            expect(f.drainAt, name).toBe(j.at)
            // the end is on the trunk's centreline, as a fraction of the trunk's width there
            const end = f.pts[f.pts.length - 1]
            const at = along(trunk.pts, j.at)
            expect(Math.hypot(end.x - at.x, end.y - at.y), name).toBeLessThan(1e-6)
            expect(distTo(trunk.pts, end), name).toBeLessThan(1e-6)
            // and it is cut there: nothing of it runs on below the join
            for (const p of f.pts) expect(p.y, name).toBeLessThanOrEqual(at.y + 1e-6)
          }
        }
      }
    }
    expect(n).toBeGreaterThan(200)
  })

  test('the last three feeder widths turn it onto the trunk heading', () => {
    let eased = 0
    const deg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))) * 180) / Math.PI
    for (const [name, m] of mountains) {
      for (const phone of [false, true]) {
        for (const seed of seeds) {
          const { flows, joins } = buildNetwork(m, opts(seed, { phone }))
          for (const j of joins) {
            const f = flows[j.feeder]
            const tb = tangentAt(flows[0].pts, Math.round(j.at * (flows[0].pts.length - 1)))
            // the heading at its end lies along the trunk's, inside the 12 degrees a chord may turn
            const last = f.pts.length - 1
            const end = { x: f.pts[last].x - f.pts[last - 1].x, y: f.pts[last].y - f.pts[last - 1].y }
            const len = Math.hypot(end.x, end.y)
            expect(deg({ x: end.x / len, y: end.y / len }, tb), name).toBeLessThanOrEqual(12)
            // an approach that was well off the trunk's heading was turned toward it
            if (j.angle > 12) {
              eased++
              expect(approachAngleDeg(f.pts, flows[0].pts, j.at), name).toBeLessThan(j.angle)
            }
          }
        }
      }
    }
    expect(eased).toBeGreaterThan(0)
  })

  test('the joins are recorded in order down the trunk, with the widths the rule gives', () => {
    for (const [name, m] of mountains) {
      for (const seed of seeds) {
        const { flows, joins } = buildNetwork(m, opts(seed))
        expect(joins.length, name).toBe(flows.filter((f) => f.drain === 0).length)
        const sf = sfOf(m, flows)
        const seen = new Set()
        let settled = 1
        let prev = 0
        for (const j of joins) {
          expect(j.at, name).toBeGreaterThan(prev)
          prev = j.at
          expect(seen.has(j.feeder), name).toBe(false)
          seen.add(j.feeder)
          expect(flows[j.feeder].drain, name).toBe(0)
          expect(j.wf, name).toBeCloseTo(flows[j.feeder].widthAt(1), 9)
          expect(j.wj, name).toBeCloseTo(joinedWidth(j.wt, j.wf), 9)
          // the trunk above a join is what its own growth and the joins above it have made of it
          expect(j.wt, name).toBeCloseTo(flows[0].widthAt(0) * growth(j.at, sf) * settled, 6)
          settled *= j.wj / j.wt
        }
      }
    }
  })

  test('trunk width after a join follows joinedWidth within 1%', () => {
    // read once the bulge has settled (one width to its peak and three more to settle), where that comes before the next
    // join's swell and before the pool flare begins: the joins above have settled by then, and the ones below have not begun
    let checked = 0
    for (const [name, m] of mountains) {
      for (const phone of [false, true]) {
        for (const seed of seeds) {
          const net = buildNetwork(m, opts(seed, { phone }))
          const trunk = net.flows[0]
          const L = length(trunk.pts)
          const sf = sfOf(m, net.flows)
          net.joins.forEach((j, k) => {
            const s = j.at + (4.25 * j.wj) / L
            const next = net.joins[k + 1]
            if (s >= sf || (next && s >= next.at - next.wj / L)) return
            checked++
            const want = joinedWidth(j.wt, j.wf) * (growth(s, sf) / growth(j.at, sf))
            expect(Math.abs(trunk.widthAt(s) / want - 1), name).toBeLessThan(0.01)
          })
        }
      }
    }
    expect(checked).toBeGreaterThan(30)
  })

  test('joinWidthProfile: wt above, 1.1 of the joined width one width below the join, settling to it over three more', () => {
    const wt = 20
    const wf = 8
    const sj = 0.5
    const wScale = 0.002 // a 500 px trunk
    const f = joinWidthProfile(wt, wf, sj, wScale)
    const wj = joinedWidth(wt, wf)
    const one = wj * wScale
    expect(f(0)).toBe(wt)
    expect(f(sj - one - 1e-9)).toBe(wt)
    expect(f(sj + one)).toBeCloseTo(1.1 * wj, 9)
    expect(f(sj + 4 * one)).toBeCloseTo(wj, 9)
    expect(f(1)).toBeCloseTo(wj, 9)
    // it rises from one width above the join to the peak and settles from there, both without a step
    let peakAt = 0
    let peak = 0
    let prev = wt
    for (let k = 0; k <= 2000; k++) {
      const s = k / 2000
      const w = f(s)
      if (s > sj - one && s <= sj + one) expect(w).toBeGreaterThanOrEqual(prev - 1e-9)
      if (s > sj + one + 1 / 2000 && s <= sj + 4 * one) expect(w).toBeLessThanOrEqual(prev + 1e-9)
      expect(Math.abs(w - prev)).toBeLessThan(0.5)
      if (w > peak) [peak, peakAt] = [w, s]
      prev = w
    }
    expect(peak).toBeCloseTo(1.1 * wj, 1)
    expect(peakAt).toBeCloseTo(sj + one, 2)
  })

  test('the bulge peaks at 1.1 of the joined width one width below the join then settles', () => {
    // a phone makes one join, so the trunk's width after it is that join's alone
    let checked = 0
    for (const m of [cone(), cone({ rows: 27, jitter: 20 })]) {
      for (const seed of seeds) {
        const net = buildNetwork(m, opts(seed, { phone: true }))
        const j = net.joins[0]
        if (!j) continue
        const trunk = net.flows[0]
        const L = length(trunk.pts)
        const sf = sfOf(m, net.flows)
        // the width with the trunk's own growth taken out, so the swell reads on its own
        let peak = 0
        let peakAt = 0
        for (let k = 0; k <= 1000; k++) {
          const s = j.at + (k / 1000) * (sf - j.at)
          const w = trunk.widthAt(s) / (growth(s, sf) / growth(j.at, sf))
          if (w > peak) [peak, peakAt] = [w, s]
        }
        checked++
        expect(peak / (1.1 * j.wj)).toBeGreaterThan(0.98)
        expect(peak / (1.1 * j.wj)).toBeLessThan(1.02)
        expect(Math.abs(peakAt - (j.at + j.wj / L))).toBeLessThan(0.015)
        // then it settles: four widths on it is back to the joined width, within 1%
        const s4 = j.at + (4.25 * j.wj) / L
        if (s4 < sf) expect(trunk.widthAt(s4) / (growth(s4, sf) / growth(j.at, sf)) / j.wj).toBeCloseTo(1, 2)
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  test('after the last join the growth and the pool flare continue from the joined width', () => {
    // widthAt(1) = the trunk's own growth and flare (1.15 and 1.2 of W0), each join's step taken as the product says; no
    // case skipped, so a swell still settling at the pool is counted too
    // (the fork narrows the trunk below the last join to 0.6: it has its own tests, so it is left out here)
    let checked = 0
    for (const [name, m] of mountains) {
      for (const phone of [false, true]) {
        for (const seed of seeds) {
          const net = buildNetwork(m, opts(seed, { phone, braid: false }))
          if (!net.joins.length) continue
          const trunk = net.flows[0]
          const L = length(trunk.pts)
          let want = trunk.widthAt(0) * growth(1, sfOf(m, net.flows)) * 1.2
          for (const j of net.joins) want *= joinWidthProfile(j.wt, j.wf, j.at, 1 / L)(1) / j.wt
          checked++
          expect(trunk.widthAt(1) / want, name).toBeCloseTo(1, 6)
        }
      }
    }
    expect(checked).toBeGreaterThan(100)
  })

  test('a narrow cone builds fast, never loops, and every stream ends on the pool or the trunk', () => {
    // a 320 px viewport: 40 rows, the cone's base 320 px across (two thin ones and a short one besides)
    const narrow = [
      cone({ w: 320, rows: 40, height: 400, craterHalf: 14, halfBase: 160 }),
      cone({ w: 320, rows: 40, height: 640, craterHalf: 14, halfBase: 160 }),
      cone({ w: 320, rows: 40, height: 300, craterHalf: 10, halfBase: 100 }),
      cone({ w: 320, rows: 40 }),
    ]
    for (const m of narrow) {
      for (const phone of [false, true]) {
        for (const seed of seeds) {
          const t = performance.now()
          const { flows, pool, joins } = buildNetwork(m, { w: 320, h: 640, phone, rng: mulberry32(seed) })
          expect(performance.now() - t).toBeLessThan(50)
          for (const f of flows) {
            // (on a cone this thin a stream can come down past the pool's side: it still ends on the line, entering at the edge)
            expectEnd(f, flows, pool, false)
            // no loops: every stream keeps going down
            for (let i = 1; i < f.pts.length; i++) expect(f.pts[i].y).toBeGreaterThan(f.pts[i - 1].y)
          }
          for (const j of joins) expect(j.angle).toBeLessThanOrEqual(CONFLUENCE_MAX_DEG)
        }
      }
    }
  })

  test('a cone too short for any join sends every tributary to the pool and never loops', () => {
    // no trunk row falls in a window with room to reach it
    for (const m of [cone({ rows: 14, height: 200 }), cone({ rows: 10, height: 200 })]) {
      for (const seed of seeds) {
        const t = performance.now()
        const { flows, pool, joins } = buildNetwork(m, opts(seed))
        expect(performance.now() - t).toBeLessThan(50)
        expect(joins).toEqual([])
        for (const f of flows) {
          expect(f.drain).toBe(-1)
          expectEnd(f, flows, pool)
          for (let i = 1; i < f.pts.length; i++) expect(f.pts[i].y).toBeGreaterThan(f.pts[i - 1].y)
        }
      }
    }
  })

  test('a join that cannot be made drains to the pool, and says so in dev', () => {
    // 276 px high: the upper fissure's turn does not fit in the room it has on about 2 seeds in 5
    const m = cone({ rows: 27, height: 276, jitter: 20 })
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    let fell = 0
    for (let seed = 1; seed <= 100; seed++) {
      spy.mockClear()
      const net = buildNetwork(m, opts(seed))
      const said = spy.mock.calls.filter((c) => c.join(' ').includes('drains to the pool'))
      if (!said.length) continue
      fell++
      const fallen = net.flows.filter((f) => f.role !== 'trunk' && f.aim === null)
      expect(fallen.length).toBeGreaterThanOrEqual(said.length)
      for (const f of fallen) {
        expect(f.drain).toBe(-1)
        expectEnd(f, net.flows, net.pool)
        for (let i = 1; i < f.pts.length; i++) expect(f.pts[i].y).toBeGreaterThan(f.pts[i - 1].y)
      }
      expect(net.joins.every((j) => net.flows[j.feeder].drain === 0)).toBe(true)
    }
    expect(fell).toBeGreaterThan(0)
  })

  test('a feeder arrives at its aim at 15 to 28 degrees to the trunk, about 20 at the median', () => {
    // the angle before the turn (`joins[].angle`): the feeder's heading at the join against the trunk's tangent
    for (const [name, m, phone] of angleCases) {
      const angles = []
      for (let seed = 1; seed <= 100; seed++) {
        const { joins } = buildNetwork(m, opts(seed, { phone }))
        for (const j of joins) angles.push(j.angle)
      }
      expect(angles.length, name).toBeGreaterThan(80)
      const inBand = angles.filter((a) => a >= 15 && a <= 28).length / angles.length
      expect(inBand, name).toBeGreaterThanOrEqual(0.95)
      angles.sort((a, b) => a - b)
      const median = angles[angles.length >> 1]
      expect(median, name).toBeGreaterThanOrEqual(17)
      expect(median, name).toBeLessThanOrEqual(25)
      // and the rule's own ceiling
      expect(angles[angles.length - 1], name).toBeLessThanOrEqual(CONFLUENCE_MAX_DEG)
    }
  })

  test('the banks first touch a bounded way above the join: the V has a mouth', () => {
    // The feeder's bank and the trunk's meet when their centrelines are (wt + wf) / 2 apart. The distance along the feeder
    // from first contact to the join, in feeder widths. A straight approach at the 28 degree top of the band, a feeder
    // 0.4 of the trunk's width and a turn that keeps to 12 degrees a chord put the floor at about 5 widths for the rim and
    // the fissures (the 3 asked for needs 50 degrees); measured medians are 7 to 10.5. Pinned at 11 (p90 14) for the rim,
    // the mid fissure and the phone fissure; the upper fissure's source stands on the trunk's bank on a 27-row cone, so it is
    // left out of the pin. The join is where the turn lands, a little below the aim.
    const widthsOf = (net) =>
      net.joins.map((j) => {
        const f = net.flows[j.feeder]
        const T = net.flows[0].pts
        let run = 0
        for (let k = f.pts.length - 1; k > 0; k--) {
          if (distTo(T, f.pts[k]) > (j.wt + j.wf) / 2) break
          run += Math.hypot(f.pts[k].x - f.pts[k - 1].x, f.pts[k].y - f.pts[k - 1].y)
        }
        return { role: f.role, w: run / j.wf }
      })
    for (const [name, m, phone] of angleCases) {
      const ws = []
      for (let seed = 1; seed <= 100; seed++) for (const c of widthsOf(buildNetwork(m, opts(seed, { phone })))) if (c.role !== 'upper') ws.push(c.w)
      ws.sort((a, b) => a - b)
      expect(ws[ws.length >> 1], name).toBeLessThanOrEqual(11)
      expect(ws[Math.floor(ws.length * 0.9)], name).toBeLessThanOrEqual(14)
    }
  })

  test('the DRAWN feeder keeps to 30 degrees to the local trunk tangent over its last 8 feeder widths', () => {
    // read on the finished feeder (see drawnWorst): not at the aim, not at the very end, but the stretch above the turn
    for (const [name, m, phone] of angleCases) {
      let n = 0
      for (let seed = 1; seed <= 100; seed++) {
        const { flows, joins } = buildNetwork(m, opts(seed, { phone }))
        for (const j of joins) {
          n++
          expect(drawnWorst(flows[j.feeder], flows[0].pts, 8 * j.wf), name + ' seed ' + seed).toBeLessThanOrEqual(30)
        }
      }
      expect(n, name).toBeGreaterThan(50)
    }
  })

  test('the join is where the turn meets the trunk: aim, drainAt and joins agree, inside the S5.3 window', () => {
    const windows = { rim: [0.2, 0.35], upper: [0.45, 0.6], mid: [0.65, 0.8], 'phone-fissure': [0.66, 0.85] }
    let n = 0
    for (const [name, m, phone] of angleCases) {
      for (const seed of seeds) {
        const { flows, joins } = buildNetwork(m, opts(seed, { phone }))
        for (const j of joins) {
          const f = flows[j.feeder]
          n++
          expect(f.drainAt, name).toBe(j.at)
          expect(f.aim.at, name).toBe(j.at)
          expect(j.at, name).toBeGreaterThanOrEqual(windows[f.role][0])
          expect(j.at, name).toBeLessThanOrEqual(windows[f.role][1])
          // its row is the trunk row nearest the landing
          const y = along(flows[0].pts, j.at).y
          expect(Math.abs(f.aim.row - (y - (m.left[0].y + m.right[0].y) / 2) / rowHeight(m)), name).toBeLessThanOrEqual(0.5 + 1e-9)
        }
      }
    }
    expect(n).toBeGreaterThan(300)
  })

  test('a stream the trunk cannot be reached by (no row in its window fits) runs to the pool and says so in dev', () => {
    // 10 rows, 200 px: no trunk row falls in the rim's window with room to reach it
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const net = buildNetwork(cone({ rows: 10, height: 200 }), opts(7))
    const rim = net.flows.find((f) => f.role === 'rim')
    expect(rim.drain).toBe(-1)
    expect(rim.aim).toBeNull()
    const said = spy.mock.calls.filter((c) => c.join(' ').includes('rim') && c.join(' ').includes('no trunk row in its window fits'))
    expect(said).toHaveLength(1)
    // the lower fissure was never to join: it does not say so
    spy.mockClear()
    buildNetwork(cone(), opts(7))
    expect(spy.mock.calls.filter((c) => c.join(' ').includes('lower'))).toHaveLength(0)
  })

  test('approachAngleDeg reads the angle between the feeder and the trunk where they meet', () => {
    const trunk = Array.from({ length: 101 }, (_, i) => ({ x: 0, y: i * 10 }))
    const feeder = (deg) => {
      const r = (deg * Math.PI) / 180
      return Array.from({ length: 30 }, (_, i) => ({ x: -Math.sin(r) * (29 - i) * 5, y: 500 - Math.cos(r) * (29 - i) * 5 }))
    }
    expect(approachAngleDeg(feeder(0), trunk, 0.5)).toBeCloseTo(0, 6)
    expect(approachAngleDeg(feeder(25), trunk, 0.5)).toBeCloseTo(25, 6)
    expect(approachAngleDeg(feeder(40), trunk, 0.5)).toBeCloseTo(40, 6)
    expect(approachAngleDeg(feeder(90), trunk, 0.5)).toBeCloseTo(90, 6)
  })
})

describe('the fork', () => {
  // The trunk splits 2.5 to 3.5 trunk widths above the pool arc and both streams run into the pool, each by its own entry.
  // The hero and the two 27-row cones are the standard desktop cones; the 276 px cone is a low route, where the room
  // below the trunk's last join is often short of 2.5 widths.
  const standard = [
    ['60 rows', cone()],
    ['27 rows jittered', cone({ rows: 27, jitter: 20 })],
    ['27 rows terraced', cone({ rows: 27, terraces: true, jitter: 20 })],
  ]
  const forkOf = (net) => net.flows.find((f) => f.role === 'fork')
  const ofSeeds = (m, extra, n = 40) => Array.from({ length: n }, (_, i) => buildNetwork(m, opts(i + 1, extra)))
  // how far above the arc the arm leaves the trunk, in trunk widths (the trunk ends on the arc); `at` is by point index
  const aboveArc = (net) => {
    const T = net.flows[0]
    const f = forkOf(net)
    const i = Math.floor(f.attach * (T.pts.length - 1))
    return (length(T.pts.slice(i)) - Math.hypot(T.pts[i].x - along(T.pts, f.attach).x, T.pts[i].y - along(T.pts, f.attach).y)) / T.widthAt(f.attach)
  }
  const lastJoinOf = (net) => Math.max(0, ...net.joins.map((j) => j.at))
  // the arc length down a polyline to `at` (0 to 1, by point index)
  const arcAt = (pts, at) => {
    const k = Math.max(0, Math.min(1, at)) * (pts.length - 1)
    const i = Math.min(pts.length - 2, Math.floor(k))
    return length(pts.slice(0, i + 1)) + (k - i) * Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
  }

  test('desktop forks on at least 90% of seeds on the hero and both 27-row cones: one arm, below the last join, 2.5 to 3.5 widths above the arc', () => {
    for (const [name, m] of standard) {
      let forked = 0
      const nets = ofSeeds(m, {}, 100)
      for (const net of nets) {
        const arms = net.flows.filter((f) => f.kind === 'braid')
        expect(arms.length, name).toBeLessThanOrEqual(1)
        if (!arms.length) continue
        forked++
        const f = arms[0]
        // the sixth flow: the rim, three fissures and the arm after the trunk
        expect(net.flows, name).toHaveLength(6)
        expect(net.flows[5], name).toBe(f)
        expect(f.role).toBe('fork')
        expect(f.head).toBe(false)
        expect(f.heat).toBe(1)
        expect(f.sourceIndex).toBe(-1)
        expect(f.aim).toBeNull()
        // fed from the trunk where it leaves it, and into the pool by its own entry
        expect(f.parent).toBe(0)
        expect(f.drain).toBe(-1)
        expect(f.attach, name).toBeGreaterThan(lastJoinOf(net))
        expect(f.attach, name).toBeLessThan(1)
        // 2.5 to 3.5 widths above the arc: the cap in the trunk's width at the split, the room (as the skip rule counts it) in its
        // width at the join, which the swell below the join makes up to 10% less than the width at the split
        const above = aboveArc(net)
        expect(above, name).toBeLessThanOrEqual(3.5 + 0.05)
        expect((above * net.flows[0].widthAt(f.attach)) / net.flows[0].widthAt(lastJoinOf(net)), name).toBeGreaterThanOrEqual(2.5 - 0.05)
        // half a width (the trunk's, at the join) of clear trunk between the last join's landing and the split, and as far up
        // as the room allows: either 3.5 above the arc, or exactly that half width below the join
        const T = net.flows[0]
        const clear = (arcAt(T.pts, f.attach) - arcAt(T.pts, lastJoinOf(net))) / T.widthAt(lastJoinOf(net))
        expect(clear, name).toBeGreaterThanOrEqual(0.5 - 0.03)
        if (above < 3.5 - 0.05) expect(clear, name).toBeLessThan(0.5 + 0.1)
        // it leaves the trunk's centreline where `attach` says
        const s = along(T.pts, f.attach)
        expect(Math.hypot(f.pts[0].x - s.x, f.pts[0].y - s.y), name).toBeLessThan(1e-6)
        // and the fork is not a join: no entry in joins[], so no fillet
        expect(net.joins.every((j) => net.flows[j.feeder] !== f)).toBe(true)
        expectEnd(f, net.flows, net.pool)
      }
      expect(forked / nets.length, name).toBeGreaterThanOrEqual(0.9)
    }
  })

  test('both entries are inside the arc, unclamped, and at least 0.15 of the half width apart', () => {
    for (const [name, m] of standard) {
      for (const net of ofSeeds(m, {}, 60)) {
        const f = forkOf(net)
        if (!f) continue
        const T = net.flows[0]
        const { pool } = net
        const entry = (fl) => (fl.pts[fl.pts.length - 1].x - pool.cx) / pool.rx
        for (const fl of [f, T]) {
          expect(Math.abs(entry(fl)), name).toBeLessThan(1)
          expect(fl.drainAt, name).toBeCloseTo(entry(fl), 9)
          const end = fl.pts[fl.pts.length - 1]
          expect(Math.abs(end.y - pool.arcY(end.x)), name).toBeLessThan(1e-3)
        }
        expect(Math.abs(f.drainAt - T.drainAt), name).toBeGreaterThanOrEqual(0.15)
        // and from the other streams that run into the pool
        for (const o of net.flows.filter((x) => x.drain === -1 && x !== f && x !== T)) expect(Math.abs(f.drainAt - o.drainAt), name).toBeGreaterThanOrEqual(0.15)
      }
    }
  })

  test('the arm is half the trunk wide at the split and only grows; the trunk is 0.6 of its width from the split to the pool', () => {
    let n = 0
    for (const [name, m] of standard) {
      for (let seed = 1; seed <= 40; seed++) {
        const net = buildNetwork(m, opts(seed))
        const f = forkOf(net)
        if (!f) continue
        n++
        const without = buildNetwork(m, opts(seed, { braid: false })).flows[0]
        const T = net.flows[0]
        const L = length(T.pts)
        const W = T.widthAt(f.attach)
        // the arm: half the trunk's width at the split, 15% more by its end (no flare), never narrower on the way
        expect(f.widthAt(0), name).toBeCloseTo(0.5 * W, 9)
        expect(f.widthAt(1), name).toBeCloseTo(0.5 * W * 1.15, 9)
        let prev = 0
        for (let s = 0; s <= 1; s += 0.05) {
          expect(f.widthAt(s)).toBeGreaterThanOrEqual(prev)
          prev = f.widthAt(s)
        }
        // the trunk against the same trunk without the fork
        const ratio = (s) => T.widthAt(s) / without.widthAt(s)
        for (let s = 0; s <= f.attach; s += 0.02) expect(ratio(s), name).toBeCloseTo(1, 9)
        // it narrows over the first 0.8 widths of the arm (the ease is by point index, so read from 1.1 on), then holds 0.6 to the pool
        let prevRatio = 1
        for (let s = f.attach; s <= 1; s += 0.002) {
          expect(ratio(s), name).toBeLessThanOrEqual(prevRatio + 1e-9)
          expect(ratio(s), name).toBeGreaterThanOrEqual(0.6 - 1e-9)
          prevRatio = ratio(s)
        }
        for (let s = f.attach + (1.1 * W) / L; s <= 1; s += 0.01) expect(ratio(s), name).toBeCloseTo(0.6, 9)
        expect(ratio(1), name).toBeCloseTo(0.6, 9)
      }
    }
    expect(n).toBeGreaterThan(100)
  })

  test('the arm leans off the trunk at 30 degrees or less over its whole length, to one side, and never crosses it', () => {
    let n = 0
    for (const [name, m] of standard) {
      for (const net of ofSeeds(m, {}, 40)) {
        const f = forkOf(net)
        if (!f) continue
        n++
        const T = net.flows[0].pts
        expect(drawnWorst(f, T, length(f.pts)), name).toBeLessThanOrEqual(CONFLUENCE_MAX_DEG)
        // the side: the sign of the cross product of the trunk's direction and the way to the arm, at each point past the split
        const side = (p) => {
          let best = Infinity
          let sg = 0
          for (let i = 1; i < T.length; i++) {
            const a = T[i - 1]
            const c = T[i]
            const dx = c.x - a.x
            const dy = c.y - a.y
            const r = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)))
            const d = Math.hypot(p.x - (a.x + dx * r), p.y - (a.y + dy * r))
            if (d < best) [best, sg] = [d, (dx * (p.y - a.y) - dy * (p.x - a.x)) / Math.hypot(dx, dy)]
          }
          return sg
        }
        const sides = f.pts.slice(2).map(side)
        expect(sides.every((x) => x > 0) || sides.every((x) => x < 0), name).toBe(true)
        // and it gets further from the trunk the whole way down (two streams, not one that bends back)
        const gap = f.pts.map((p) => distTo(T, p))
        for (let i = 1; i < gap.length; i++) expect(gap[i], name).toBeGreaterThanOrEqual(gap[i - 1] - 0.5)
      }
    }
    expect(n).toBeGreaterThan(100)
  })

  test('it runs downhill, on the face, no chord turns over 12 degrees, its points are evenly spaced no further than half a row, and it keeps clear of the other pool streams', () => {
    for (const [name, m] of standard) {
      for (const net of ofSeeds(m, {}, 25)) {
        const f = forkOf(net)
        if (!f) continue
        for (let i = 1; i < f.pts.length; i++) expect(f.pts[i].y, name).toBeGreaterThan(f.pts[i - 1].y)
        for (const p of f.pts) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.u)).toBe(true)
          expect(Math.abs(p.u), name).toBeLessThanOrEqual(0.94 + 1e-9)
        }
        for (let i = 1; i < f.pts.length - 1; i++) {
          const a = f.pts[i - 1]
          const c = f.pts[i]
          const d = f.pts[i + 1]
          const cos = ((c.x - a.x) * (d.x - c.x) + (c.y - a.y) * (d.y - c.y)) / (Math.hypot(c.x - a.x, c.y - a.y) * Math.hypot(d.x - c.x, d.y - c.y))
          expect((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI, name).toBeLessThanOrEqual(12)
        }
        const d = f.pts.slice(1).map((p, i) => Math.hypot(p.x - f.pts[i].x, p.y - f.pts[i].y))
        expect(Math.max(...d), name).toBeLessThanOrEqual(0.5 * rowHeight(m) + 1e-6)
        expect(Math.max(...d) - Math.min(...d), name).toBeLessThan(0.3 * rowHeight(m))
        for (const o of net.flows.filter((x) => x.drain === -1 && x.role !== 'trunk' && x !== f)) {
          for (const p of f.pts) expect(distTo(o.pts, p), name).toBeGreaterThan(0.5 * net.flows[0].widthAt(f.attach))
        }
      }
    }
  })

  test('everything else is as it was without the fork, and the same seed gives the same fork', () => {
    for (const [name, m] of standard) {
      for (let seed = 1; seed <= 20; seed++) {
        const net = buildNetwork(m, opts(seed))
        const f = forkOf(net)
        if (!f) continue
        const without = buildNetwork(m, opts(seed, { braid: false }))
        expect(without.flows.every((x) => x.kind !== 'braid')).toBe(true)
        expect(net.flows.slice(0, 5).map((x) => x.pts), name).toEqual(without.flows.map((x) => x.pts))
        expect(net.fissures).toEqual(without.fissures)
        expect(net.joins).toEqual(without.joins)
        expect(net.pool.cx).toBe(without.pool.cx)
        const again = buildNetwork(m, opts(seed))
        expect(forkOf(again).pts).toEqual(f.pts)
        expect(forkOf(again).attach).toBe(f.attach)
        expect(forkOf(again).drainAt).toBe(f.drainAt)
        expect(again.flows[0].widthAt(0.9)).toBe(net.flows[0].widthAt(0.9))
      }
    }
    // another seed, another fork
    const m = standard[1][1]
    expect(forkOf(buildNetwork(m, opts(7))).pts).not.toEqual(forkOf(buildNetwork(m, opts(8))).pts)
  })

  test('a phone never has one', () => {
    for (const [name, m] of standard) {
      for (const net of ofSeeds(m, { phone: true }, 10)) {
        expect(net.flows.map((f) => f.kind), name).toEqual(['trunk', 'fissure'])
      }
    }
  })

  test('a trunk with under 2.5 widths between its last join and the arc gets no fork, and says so in dev', () => {
    // a cone so short its trunk is about a width long
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    for (const m of [cone({ rows: 14, height: 120, craterHalf: 90 }), cone({ rows: 12, height: 100, craterHalf: 60 })]) {
      for (let seed = 1; seed <= 10; seed++) {
        spy.mockClear()
        const net = buildNetwork(m, opts(seed))
        expect(forkOf(net)).toBeUndefined()
        expect(net.flows.every((f) => f.kind !== 'braid')).toBe(true)
        const said = spy.mock.calls.filter((c) => c.join(' ').includes('no fork'))
        expect(said).toHaveLength(1)
        expect(said[0].join(' ')).toMatch(/trunk widths between the last join and the pool/)
        // left out on purpose, nothing is said
        spy.mockClear()
        buildNetwork(m, opts(seed, { braid: false }))
        expect(spy.mock.calls.filter((c) => c.join(' ').includes('no fork'))).toHaveLength(0)
      }
    }
    // on a low route (276 px) the room is short on some seeds and not on others: the ones that skip say so, the rest fork
    const low = cone({ rows: 27, height: 276, jitter: 20 })
    let skipped = 0
    let forked = 0
    for (let seed = 1; seed <= 60; seed++) {
      spy.mockClear()
      const net = buildNetwork(low, opts(seed))
      const said = spy.mock.calls.filter((c) => c.join(' ').includes('no fork'))
      if (forkOf(net)) {
        forked++
        expect(said).toHaveLength(0)
      } else {
        skipped++
        expect(said).toHaveLength(1)
      }
    }
    expect(skipped).toBeGreaterThan(0)
    expect(forked).toBeGreaterThan(0)
  })
})

describe('a phone on a mountain made the way buildMountain makes it', () => {
  // MountDeathfire.vue buildMountain, as plain data: the cone's height from peakHeight (690 * scale * h / 1000, at most
  // 0.7 h), the peak at w * face, a spread and a curve per flank, 27 rows with the y jitter tapering to 0 at the rim, three
  // terraces a flank, and the vent at the valley floor's low point of the breach. The probe the Task 2 reviewer used, kept.
  function like(seed, w, h, scale, face) {
    const r = mulberry32(seed * 7919 + 13)
    const grand = (a, b) => a + (b - a) * r()
    const height = Math.max(40, Math.min(690 * scale * (h / 1000), h * 0.7))
    const peakX = w * face
    const peakY = h - height
    const halfBase = Math.max((w * 0.6) / 2, height * 0.6)
    const craterHalf = Math.max(18, height * 0.13)
    const spread = [grand(0.78, 1.24), grand(0.78, 1.24)]
    const curve = [grand(2.15, 2.65), grand(2.15, 2.65)]
    const dip = grand(-1.5, 1.5)
    const rimL = { x: peakX - craterHalf, y: peakY - dip }
    const rimR = { x: peakX + craterHalf, y: peakY + dip }
    const flank = (dir, k) => {
      const pts = []
      for (let i = 0; i <= 26; i++) {
        const f = i / 26
        pts.push({ x: peakX + dir * (craterHalf + Math.pow(f, curve[k]) * (halfBase * spread[k] - craterHalf)), y: peakY + f * height + grand(-1, 1) * height * 0.03 * f })
      }
      const lr = mulberry32((seed * 31 + (dir < 0 ? 0x1ed9e : 0x2fa7)) >>> 0)
      for (let n = 0; n < 3; n++) {
        const at = 4 + Math.floor(lr() * 17)
        const out = (0.03 + lr() * 0.05) * halfBase * spread[k]
        for (let i = at; i <= 26; i++) pts[i].x += dir * out
      }
      pts[0] = { ...(dir < 0 ? rimL : rimR) }
      return pts
    }
    const left = flank(-1, 0)
    const right = flank(1, 1)
    const low = 0.42 + (r() * 2 - 1) * 0.08
    const depth = (0.3 + 0.12 * r()) * craterHalf
    const vent = { x: rimL.x + 0.55 * craterHalf + 2 * craterHalf * 0.45 * low, y: rimL.y + (rimR.y - rimL.y) * low + depth }
    return { peakX, peakY, craterHalf, left, right, rimL, rimR, vent }
  }
  const W = 390
  const H = 844
  const trunkY = (net, at) => along(net.flows[0].pts, at).y

  test('the phone fissure joins on at least 90% of seeds, and below the title box (the join stands at 0.79 to 0.90 of the height)', () => {
    // the title box covers about 0.46 to 0.76 of the height; scale 1 is the hero, the others the smaller cones of the other pages
    for (const scale of [1, 0.85, 0.7]) {
      let n = 0
      let joined = 0
      for (const face of [0.1, 0.18, 0.28, 0.4, 0.5]) {
        for (let seed = 1; seed <= 30; seed++) {
          const m = like(seed, W, H, scale, face)
          const net = buildNetwork(m, { w: W, h: H, phone: true, rng: mulberry32(seed) })
          n++
          const j = net.joins[0]
          if (!j) continue
          joined++
          expect(net.flows[j.feeder].role).toBe('phone-fissure')
          expect(trunkY(net, j.at) / H, 'scale ' + scale).toBeGreaterThanOrEqual(0.76)
          expect(trunkY(net, j.at) / H, 'scale ' + scale).toBeLessThanOrEqual(0.95)
          expect(j.angle).toBeLessThanOrEqual(CONFLUENCE_MAX_DEG)
        }
      }
      expect(joined / n, 'scale ' + scale).toBeGreaterThanOrEqual(0.9)
    }
  })

  test('every stream ends on the pool or the trunk, no chord turns over 12 degrees, the pool sits below the screen', () => {
    for (const scale of [1, 0.7]) {
      for (let seed = 1; seed <= 40; seed++) {
        const m = like(seed, W, H, scale, 0.1 + 0.02 * (seed % 20))
        const { flows, pool } = buildNetwork(m, { w: W, h: H, phone: true, rng: mulberry32(seed) })
        for (const f of flows) {
          expectEnd(f, flows, pool)
          for (let i = 1; i < f.pts.length - 1; i++) {
            const a = f.pts[i - 1]
            const b = f.pts[i]
            const c = f.pts[i + 1]
            const cos = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y))
            expect((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI).toBeLessThanOrEqual(12)
          }
        }
        // the centre is under the screen's bottom edge and the arc's top a little above it (the glow shows)
        expect(pool.cy).toBeGreaterThan(H)
        expect(pool.arcTop).toBeLessThan(H)
        expect(pool.arcTop).toBeGreaterThan(H - pool.ry)
      }
    }
  })

  test('a join above the title box (0.46 of the height) is out of reach: the stretch above it is shorter than a join needs', () => {
    // the vent stands 96 px above the box top on the hero cone; the turn alone is 3 feeder widths (a phone fissure is 23 px
    // wide), and a fissure's crack is 3 to 5 rows tall below the mouth, its run 3 rows, so no join lands up there
    const m = like(1, W, H, 1, 0.18)
    const net = buildNetwork(m, { w: W, h: H, phone: true, rng: mulberry32(1) })
    const wf = net.flows[1].widthAt(1)
    expect(0.46 * H - m.vent.y).toBeLessThan(3 * wf + 3 * ((m.left[26].y - m.left[0].y) / 26))
    for (let seed = 1; seed <= 100; seed++) {
      const mm = like(seed, W, H, 1, 0.1 + 0.4 * ((seed * 7) % 10) / 10)
      const n = buildNetwork(mm, { w: W, h: H, phone: true, rng: mulberry32(seed) })
      for (const j of n.joins) expect(trunkY(n, j.at)).toBeGreaterThan(0.46 * H)
    }
  })
})

describe('tangentAt', () => {
  test('is the unit chord between the neighbours, one-sided at the ends', () => {
    const line = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 30 }]
    expect(tangentAt(line, 1)).toEqual({ x: 0, y: 1 })
    expect(tangentAt(line, 0)).toEqual({ x: 0, y: 1 })
    expect(tangentAt(line, 2)).toEqual({ x: 0, y: 1 })
    const bend = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
    const t = tangentAt(bend, 1)
    expect(t.x).toBeCloseTo(Math.SQRT1_2, 9)
    expect(t.y).toBeCloseTo(Math.SQRT1_2, 9)
  })
})

describe('widths', () => {
  const sf = (f, m) => 1 - (2 * rowHeight(m)) / length(f.pts)

  test('sources start at 1, 0.4 and 0.35 of W0 (0.5 for a phone fissure)', () => {
    const m = cone() // craterHalf 40: W0 = 22.4
    const W0 = 22.4
    const d = buildNetwork(m, opts(7)).flows
    expect(d[0].widthAt(0)).toBeCloseTo(W0, 6)
    expect(d.find((f) => f.kind === 'rim').widthAt(0)).toBeCloseTo(0.4 * W0, 6)
    for (const f of d.filter((x) => x.kind === 'fissure')) expect(f.widthAt(0)).toBeCloseTo(0.35 * W0, 6)
    const p = buildNetwork(m, opts(7, { phone: true })).flows
    expect(p[1].widthAt(0)).toBeCloseTo(0.5 * W0, 6)
    // the breach is as wide as the valley floor, clamped to 12..40
    expect(buildNetwork(cone({ craterHalf: 10 }), opts(7)).flows[0].widthAt(0)).toBeCloseTo(12, 6)
    expect(buildNetwork(cone({ craterHalf: 90 }), opts(7)).flows[0].widthAt(0)).toBeCloseTo(40, 6)
  })

  test('widths grow 15% source to end before any join', () => {
    // (without the fork: its arm grows 15% with no flare and the trunk narrows below it, both in the fork's own tests)
    const m = cone()
    for (const seed of seeds) {
      const { flows, joins } = buildNetwork(m, opts(seed, { braid: false }))
      for (const f of flows) {
        if (f.drain === 0) {
          // a feeder ends at its join: 15% wider there than at its source, and no flare (it never reaches the pool)
          expect(f.widthAt(1) / f.widthAt(0)).toBeCloseTo(1.15, 6)
          expect(f.widthAt(0.5) / f.widthAt(0)).toBeCloseTo(1.075, 6)
          for (let k = 1; k <= 20; k++) expect(f.widthAt(k / 20)).toBeGreaterThanOrEqual(f.widthAt((k - 1) / 20) - 1e-9)
          continue
        }
        // `widthAt(1)` is the flared end; the growth is read where the flare begins
        const s = sf(f, m)
        expect(s).toBeGreaterThan(0.5)
        if (f.role === 'trunk' && joins.length) {
          // the joins widen it below them: before the first one it grows as any stream does
          for (const t of [0.04, 0.08]) expect(f.widthAt(t) / f.widthAt(0)).toBeCloseTo(1 + (0.15 * t) / s, 6)
          continue
        }
        expect(f.widthAt(s) / f.widthAt(0)).toBeCloseTo(1.15, 2)
        expect(f.widthAt(s / 2) / f.widthAt(0)).toBeCloseTo(1.075, 2)
        for (let k = 1; k <= 20; k++) expect(f.widthAt(k / 20)).toBeGreaterThanOrEqual(f.widthAt((k - 1) / 20) - 1e-9)
      }
    }
  })

  test('the last two rows flare 20% as a stream enters the pool', () => {
    // the full cone (the trunk and the lower fissure reach the pool, the rest join) and a short one where nothing joins
    for (const m of [cone(), cone({ rows: 14, height: 200 })]) {
      const { flows, joins } = buildNetwork(m, opts(7, { braid: false }))
      let flared = 0
      for (const f of flows) {
        if (f.drain !== -1 || (f.role === 'trunk' && joins.length)) continue
        flared++
        const s = sf(f, m)
        expect(f.widthAt(1) / f.widthAt(s)).toBeCloseTo(1.2, 2)
        expect(f.widthAt(1) / f.widthAt(0)).toBeCloseTo(1.15 * 1.2, 2)
        // no flare above the last two rows
        expect(f.widthAt(s - 0.01) / f.widthAt(0)).toBeLessThan(1.151)
      }
      expect(flared).toBeGreaterThanOrEqual(1)
    }
  })

  test('widthAt clamps outside 0..1', () => {
    const { flows } = buildNetwork(cone(), opts(7))
    expect(flows[0].widthAt(-1)).toBe(flows[0].widthAt(0))
    expect(flows[0].widthAt(2)).toBe(flows[0].widthAt(1))
  })
})

describe('joinedWidth', () => {
  test('joinedWidth adds like a river', () => {
    expect(joinedWidth(1, 1)).toBeCloseTo(1.587, 3)
    expect(joinedWidth(1, 0.4)).toBeCloseTo(1.16, 2)
    expect(joinedWidth(1, 0)).toBeCloseTo(1, 9)
    expect(joinedWidth(0.4, 1)).toBeCloseTo(joinedWidth(1, 0.4), 9)
  })

  test('the confluence limit is 30 degrees', () => {
    expect(CONFLUENCE_MAX_DEG).toBe(30)
  })
})

describe('resample', () => {
  const wave = Array.from({ length: 12 }, (_, i) => ({ x: i * 20 + Math.sin(i) * 6, y: i * 25, u: i / 11 }))

  test('keeps both ends exactly and every piece no longer than the step', () => {
    const out = resample(wave, 15)
    expect(out[0]).toEqual(wave[0])
    expect(out[out.length - 1]).toEqual(wave[wave.length - 1])
    const d = out.slice(1).map((p, i) => Math.hypot(p.x - out[i].x, p.y - out[i].y))
    expect(Math.max(...d)).toBeLessThanOrEqual(15 + 1e-6)
    expect(out.length).toBeGreaterThan(wave.length)
  })

  test('carries u by linear interpolation between the input points', () => {
    const out = resample(wave, 15)
    for (let i = 1; i < out.length; i++) expect(out[i].u).toBeGreaterThanOrEqual(out[i - 1].u - 1e-9)
    expect(out[0].u).toBe(0)
    expect(out[out.length - 1].u).toBe(1)
    // a point near the middle of the line has u near the middle
    const mid = out[Math.floor(out.length / 2)]
    expect(mid.u).toBeGreaterThan(0.4)
    expect(mid.u).toBeLessThan(0.6)
  })

  test('passes through the input points', () => {
    const out = resample(wave, 5)
    for (const p of wave) {
      const near = Math.min(...out.map((q) => Math.hypot(q.x - p.x, q.y - p.y)))
      expect(near).toBeLessThan(2.5)
    }
  })

  test('a straight line stays straight and is cut evenly', () => {
    const line = [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 0, y: 100 }]
    const out = resample(line, 30)
    expect(out).toHaveLength(5) // ceil(100 / 30) pieces
    out.forEach((p, i) => {
      expect(p.x).toBeCloseTo(0, 9)
      expect(p.y).toBeCloseTo(i * 25, 6)
    })
  })

  test('copes with too few points and with repeated ones', () => {
    expect(resample([{ x: 1, y: 2, u: 0.5 }], 10)).toEqual([{ x: 1, y: 2, u: 0.5 }])
    expect(resample([], 10)).toEqual([])
    const out = resample([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 }], 5)
    for (const p of out) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    expect(out[out.length - 1]).toEqual({ x: 10, y: 10 })
  })
})
