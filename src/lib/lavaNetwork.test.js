import { describe, test, expect, vi } from 'vitest'
import { buildNetwork, joinedWidth, resample, tangentAt, CONFLUENCE_MAX_DEG } from './lavaNetwork'

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
 * harsher case.
 */
function cone({ w = 1600, rows = 60, height = 640, peakY = 240, peakFrac = 0.42, craterHalf = 40, ventSide = 1, terraces = false, jitter = 0 } = {}) {
  const jr = mulberry32(99)
  const jit = (i) => (i > 0 ? (jr() * 2 - 1) * jitter : 0)
  const peakX = w * peakFrac
  const halfBase = Math.max((w * 0.55) / 2, height * 0.6)
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

describe('buildNetwork sources', () => {
  test('desktop has a trunk, one rim overflow and three fissures', () => {
    const { flows, fissures, joins } = buildNetwork(cone(), opts(7))
    expect(flows).toHaveLength(5)
    expect(count(flows, 'trunk')).toBe(1)
    expect(count(flows, 'rim')).toBe(1)
    expect(count(flows, 'fissure')).toBe(3)
    expect(flows.filter((f) => f.head)).toHaveLength(1)
    expect(flows.find((f) => f.head).kind).toBe('trunk')
    expect(fissures).toHaveLength(3)
    expect(joins).toEqual([])
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
      expect(f.parent).toBe(-1)
      expect(f.attach).toBe(0)
      expect(f.drain).toBe(-1)
      expect(f.drainAt).toBe(1)
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
  test('an ellipse on the foreground ridge line, 0.45 of the base wide and a quarter of that tall', () => {
    const m = cone()
    const { pool } = buildNetwork(m, opts(7))
    const base = m.right[59].x - m.left[59].x
    expect(pool.rx).toBeCloseTo(0.45 * base, 6)
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

  test('every stream ends on the pool arc', () => {
    for (const phone of [false, true]) {
      for (const seed of seeds) {
        const { flows, pool } = buildNetwork(cone(), opts(seed, { phone }))
        for (const f of flows) {
          const end = f.pts[f.pts.length - 1]
          expect(Math.abs(end.y - pool.arcY(end.x))).toBeLessThan(1e-3)
          expect(Math.abs(end.x - pool.cx)).toBeLessThan(pool.rx)
          expect(f.drain).toBe(-1)
          // and never runs through it first
          for (const p of f.pts) expect(p.y).toBeLessThanOrEqual(pool.arcY(p.x) + 1)
        }
      }
    }
  })

  test('it holds on a narrow phone cone and on a mountain with terraces', () => {
    for (const m of [cone({ w: 390, height: 500, rows: 27, craterHalf: 18 }), cone({ rows: 27, terraces: true })]) {
      for (const phone of [false, true]) {
        const { flows, pool } = buildNetwork(m, { w: 390, h: 844, phone, rng: mulberry32(3) })
        expect(flows.length).toBe(phone ? 2 : 5)
        for (const f of flows) {
          const end = f.pts[f.pts.length - 1]
          expect(Math.abs(end.y - pool.arcY(end.x))).toBeLessThan(1e-3)
        }
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
      // the streams still land on it, inside the cone
      for (const f of flows) {
        const end = f.pts[f.pts.length - 1]
        expect(Math.abs(end.y - pool.arcY(end.x))).toBeLessThan(1e-3)
        expect(end.y).toBeLessThan(h)
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

  test('a phone pool whose cone stops well short of the screen is lifted onto the cone', () => {
    // the foot is far above h: the pool top must still be reachable by the streams
    const m = cone({ w: 390, rows: 27, height: 300, peakY: 100, craterHalf: 18 })
    const { pool, flows } = buildNetwork(m, { w: 390, h: 844, phone: true, rng: mulberry32(3) })
    expect(pool.arcTop).toBeLessThan(400)
    for (const f of flows) expect(Math.abs(f.pts[f.pts.length - 1].y - pool.arcY(f.pts[f.pts.length - 1].x))).toBeLessThan(1e-3)
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
    for (const [rows, height] of [[20, 276], [27, 200], [30, 200]]) {
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
  const windows = { rim: [0.2, 0.35], upper: [0.45, 0.6], mid: [0.65, 0.8], 'phone-fissure': [0.65, 0.8] }
  const mountains = [cone(), cone({ jitter: 20 }), cone({ rows: 27, jitter: 20 }), cone({ rows: 27, terraces: true, jitter: 20 }), cone({ rows: 30 })]

  test('every flow names its role', () => {
    expect(buildNetwork(cone(), opts(7)).flows.map((f) => f.role)).toEqual(['trunk', 'rim', 'upper', 'mid', 'lower'])
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

  test('the feeder comes onto the trunk where it was aimed, at a shallow angle', () => {
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

  test('on a real-height cone the tributaries join: the mid fissure on at least 90% of seeds, the rim on a low route too', () => {
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
    // /planner stands the cone 276 px high
    expect(rate(cone({ rows: 27, height: 276, jitter: 20 }), 'rim')).toBeGreaterThanOrEqual(0.9)
    // the rim and the upper fissure join on the plain 27-row cone too
    expect(rate(cone({ rows: 27, jitter: 20 }), 'rim')).toBeGreaterThanOrEqual(0.9)
    expect(rate(cone({ rows: 27, jitter: 20 }), 'upper')).toBeGreaterThanOrEqual(0.9)
  })

  test('the stream that cannot find a row runs to the pool alone', () => {
    // a cone too short for any window: aims drop out, the streams still end on the arc
    const m = cone({ rows: 14, height: 200 })
    const { flows, pool } = buildNetwork(m, opts(7))
    expect(flows.some((f) => f.role !== 'trunk' && f.aim === null)).toBe(true)
    for (const f of flows) expect(Math.abs(f.pts[f.pts.length - 1].y - pool.arcY(f.pts[f.pts.length - 1].x))).toBeLessThan(1e-3)
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
    const m = cone()
    for (const seed of seeds) {
      const { flows } = buildNetwork(m, opts(seed))
      for (const f of flows) {
        // `widthAt(1)` is the flared end; the growth is read where the flare begins
        const s = sf(f, m)
        expect(s).toBeGreaterThan(0.5)
        expect(f.widthAt(s) / f.widthAt(0)).toBeCloseTo(1.15, 2)
        expect(f.widthAt(s / 2) / f.widthAt(0)).toBeCloseTo(1.075, 2)
        for (let k = 1; k <= 20; k++) expect(f.widthAt(k / 20)).toBeGreaterThanOrEqual(f.widthAt((k - 1) / 20) - 1e-9)
      }
    }
  })

  test('the last two rows flare 20% as the stream enters the pool', () => {
    const m = cone()
    const { flows } = buildNetwork(m, opts(7))
    for (const f of flows) {
      const s = sf(f, m)
      expect(f.widthAt(1) / f.widthAt(s)).toBeCloseTo(1.2, 2)
      expect(f.widthAt(1) / f.widthAt(0)).toBeCloseTo(1.15 * 1.2, 2)
      // no flare above the last two rows
      expect(f.widthAt(s - 0.01) / f.widthAt(0)).toBeLessThan(1.151)
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
