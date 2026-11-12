import { describe, expect, test } from 'vitest'
import { DEFAULTS, RANDOMIZE_DEFAULTS, ROUTE_PROFILE_DEFAULTS } from '../../../src/lib/fireTuning.js'
import { hashString, mountainForRoute } from '../../../src/lib/mountain.js'
import { buildNetwork } from '../../../src/lib/lavaNetwork.js'
import { BUCKETS, BLEED } from '../../../src/lib/plate.js'
import { offsetMountain } from './input.js'
import { SUMMIT, buildWorld, coneFrame, distToPolyline, insidePoly, keepOut, keepOutGap, outline, planHills, rowCrossings, smax, terraces } from './world.js'

// The home mountain at a bucket's reference size, its lava and its pool as the page's network makes them, moved by the
// bleed as the scene moves them: the scene's own input, in canvas pixels.
function homeInput(bucket = 'wide') {
  const size = BUCKETS[bucket]
  const { mountain, rng } = mountainForRoute({ path: '/', w: size.w, h: size.h, tune: DEFAULTS.bed, prof: ROUTE_PROFILE_DEFAULTS['/'], randomize: RANDOMIZE_DEFAULTS })
  const net = buildNetwork(mountain, { w: size.w, h: size.h, phone: false, rng: () => rng() })
  const { arcY, ...pool } = net.pool
  const dx = BLEED * size.w, dy = BLEED * size.h
  const canvas = { w: Math.round(size.w * (1 + 2 * BLEED)), h: Math.round(size.h * (1 + 2 * BLEED)) }
  const m = offsetMountain({ ...mountain, pool }, dx, dy)
  const channels = net.flows.map((f) => f.pts.map((p) => ({ x: p.x + dx, y: p.y + dy })))
  return { mountain: m, channels, canvas, offset: { x: dx, y: dy }, seed: hashString('/'), bucket }
}
const home = () => homeInput('wide').mountain
const canvas = { w: 2400, h: 1350 }

describe('outline', () => {
  test('runs up the left flank, over the rim and the crown, down the right flank, in the page fill order', () => {
    const m = home()
    const poly = outline(m, canvas)
    const L = m.left.length
    // poly[0] is the left foot carried to below the canvas; then left[last..0], rimL, the crown, rimR, right[0..last]
    expect(poly[1]).toEqual(m.left[L - 1])
    expect(poly[L]).toEqual(m.left[0])
    expect(poly[L + 1]).toEqual(m.rimL)
    expect(poly.slice(L + 2, L + 2 + m.crown.length)).toEqual(m.crown)
    expect(poly[L + 2 + m.crown.length]).toEqual(m.rimR)
    expect(poly.at(-2)).toEqual(m.right.at(-1))
    expect(poly).toHaveLength(1 + L + 1 + m.crown.length + 1 + m.right.length + 1)
  })

  test('each foot carries on along the flank to just below the canvas, outward', () => {
    const m = home()
    const poly = outline(m, canvas)
    expect(poly[0].y).toBeGreaterThan(canvas.h)
    expect(poly.at(-1).y).toBeGreaterThan(canvas.h)
    expect(poly[0].x).toBeLessThanOrEqual(m.left.at(-1).x)
    expect(poly.at(-1).x).toBeGreaterThanOrEqual(m.right.at(-1).x)
  })

  test('a foot already below the canvas stays where it is', () => {
    const cone = { left: [{ x: 5, y: 0 }, { x: 4, y: 10 }], right: [{ x: 6, y: 0 }, { x: 7, y: 10 }], rimL: { x: 5, y: 0 }, rimR: { x: 6, y: 0 }, crown: [] }
    const poly = outline(cone, { w: 20, h: 5 })
    expect(poly[0]).toEqual({ x: 4, y: 10 })
    expect(poly.at(-1)).toEqual({ x: 7, y: 10 })
  })
})

describe('geometry helpers', () => {
  test('rowCrossings bounds the inside of a square, and insidePoly reads it', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    expect(rowCrossings(sq, 5)).toEqual([0, 10])
    expect(rowCrossings(sq, 11)).toEqual([])
    expect(insidePoly(sq, 5, 5)).toBe(true)
    expect(insidePoly(sq, 11, 5)).toBe(false)
  })

  test('distToPolyline measures the distance and the arc length to the nearest point', () => {
    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
    expect(distToPolyline(line, 5, 3)).toEqual({ d: 3, s: 5 })
    expect(distToPolyline(line, 13, 6)).toEqual({ d: 3, s: 16 })
  })

  test('terraces finds the outward steps buildMountain cut into a flank, on both sides', () => {
    const m = home()
    const l = terraces(m.left, -1)
    const r = terraces(m.right, 1)
    expect(l.length).toBeGreaterThan(0)
    expect(r.length).toBeGreaterThan(0)
    for (const t of [...l, ...r]) expect(t.out).toBeGreaterThan(6)
    // a smooth flank has none
    const smoothFlank = Array.from({ length: 27 }, (_, i) => ({ x: 100 - Math.pow(i / 26, 2.4) * 300, y: i * 20 }))
    expect(terraces(smoothFlank, -1)).toEqual([])
  })

  test('smax is the nearer surface away from the seam and rounds the seam', () => {
    expect(smax(0, 100, 10)).toBe(100)
    expect(smax(100, 0, 10)).toBe(100)
    expect(smax(5, 5, 10)).toBeCloseTo(7.5)
  })
})

// ------------------------------------------------------------------ the hills that join the cone, and the foreground ridge
// Every pixel a plan's region covers, sampled every `step` px: { x, y, inCone } for the hills' regions, or the foreground's.
function covered(regions, poly, { step = 4, w, h }) {
  const out = []
  for (let y = 0; y < h; y += step)
    for (const region of regions) {
      const xs = rowCrossings(region, y)
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.max(0, Math.ceil(xs[k] / step) * step); x <= Math.min(w, xs[k + 1]); x += step) out.push({ x, y, inCone: insidePoly(poly, x, y) })
    }
  return out
}

describe('planHills', () => {
  for (const bucket of ['wide', 'portrait']) {
    describe(bucket, () => {
      const inp = homeInput(bucket)
      const m = inp.mountain
      const plan = planHills(inp)
      const F = coneFrame(m, inp.canvas, inp.offset)
      const K = keepOut(m, inp.channels, F)
      const poly = outline(m, inp.canvas)
      const own = covered(
        plan.hills.map((h) => h.region),
        poly,
        { w: inp.canvas.w, h: inp.canvas.h },
      ).filter((p) => !p.inCone)

      test('there are hills, and each joins its flank at one of the flank\'s own points, below the summit line', () => {
        expect(plan.hills.length).toBeGreaterThan(0)
        for (const h of plan.hills) {
          const flank = h.side > 0 ? m.right : m.left
          expect(flank[h.join.i]).toEqual({ x: h.join.x, y: h.join.y })
          expect(h.join.y).toBeGreaterThan(F.summitY)
          expect(h.skyline[0]).toEqual({ x: h.join.x, y: h.join.y })
        }
      })

      test('near the flank a hill never rises above its join, so the flank keeps its outline from the rim down to the join', () => {
        // within a quarter of the cone's half base of the join, out from the flank, the skyline stays below the join
        for (const h of plan.hills) {
          const near = h.skyline.slice(1).filter((p) => Math.abs(p.x - h.join.x) < 0.24 * F.S)
          expect(near.length).toBeGreaterThan(0)
          expect(Math.min(...near.map((p) => p.y))).toBeGreaterThan(h.join.y)
        }
        // and no part of a hill outside the cone comes within 2 px of the outline above the join (the crown, the rims,
        // the flank's own points down to the join and the segments between them)
        for (const h of plan.hills) {
          const flank = h.side > 0 ? m.right : m.left
          const above = h.side > 0 ? [...m.crown, m.rimR, ...flank.slice(0, h.join.i + 1)] : [...[...flank.slice(0, h.join.i + 1)].reverse(), m.rimL, ...m.crown]
          // (at the join itself the two meet: that is where the hill's skyline leaves the flank)
          let nearest = Infinity
          for (const p of own) if (Math.hypot(p.x - h.join.x, p.y - h.join.y) > 6) nearest = Math.min(nearest, distToPolyline(above, p.x, p.y).d)
          expect(nearest).toBeGreaterThan(2)
        }
      })

      test('nothing of a hill is in the summit\'s top 45 percent, and none of it outside the cone is on the vent, the lava or the pool', () => {
        expect(SUMMIT).toBe(0.45)
        for (const h of plan.hills) expect(Math.min(...h.skyline.map((p) => p.y))).toBeGreaterThan(F.tipY + SUMMIT * F.Hm)
        expect(own.length).toBeGreaterThan(0)
        expect(Math.min(...own.map((p) => keepOutGap(K, p.x, p.y)))).toBeGreaterThan(0)
      })

      test('no hill carries a spike: its skyline never climbs more than gently', () => {
        for (const h of plan.hills) {
          // rising (y falling) going out, over 12 px, anywhere along it: at most 1.6 px up per px out
          let steepest = 0
          for (let k = 4; k < h.skyline.length; k++) {
            const a = h.skyline[k - 4], b = h.skyline[k]
            steepest = Math.max(steepest, (a.y - b.y) / Math.abs(b.x - a.x))
          }
          expect(steepest).toBeLessThan(1.6)
        }
      })

      test('the foreground ridge stands on the side away from the pool, and covers no keep-out place', () => {
        const fg = plan.foreground
        expect(fg).not.toBeNull()
        expect(fg.side).toBe(m.pool.cx < inp.canvas.w / 2 ? 1 : -1)
        const pts = covered([fg.region], poly, { w: inp.canvas.w, h: inp.canvas.h })
        expect(pts.length).toBeGreaterThan(0)
        expect(Math.min(...pts.map((p) => keepOutGap(K, p.x, p.y)))).toBeGreaterThan(0)
        const meanX = pts.reduce((a, p) => a + p.x, 0) / pts.length
        expect(Math.sign(meanX - inp.canvas.w / 2)).toBe(fg.side)
      })

      test('seeded: the same seed plans the same hills, another seed others', () => {
        const again = planHills(inp)
        expect(again.hills.map((h) => h.skyline)).toEqual(plan.hills.map((h) => h.skyline))
        expect(again.foreground.crest).toEqual(plan.foreground.crest)
        const other = planHills({ ...inp, seed: 12345 })
        expect(other.hills.map((h) => h.skyline)).not.toEqual(plan.hills.map((h) => h.skyline))
      })
    })
  }

  test('portrait keeps them low and sparse: one hill at most, joined in the cone\'s lower part', () => {
    const inp = homeInput('portrait')
    const F = coneFrame(inp.mountain, inp.canvas, inp.offset)
    const { hills } = planHills(inp)
    expect(hills.length).toBeLessThanOrEqual(1)
    for (const h of hills) expect(h.join.y).toBeGreaterThan(F.tipY + 0.6 * F.Hm)
  })

  test('a side with no room to the canvas edge gets no hill', () => {
    const inp = homeInput('wide')
    expect(planHills(inp).hills.some((h) => h.side < 0)).toBe(true)
    // the same mountain moved left, so its left flank runs up against the canvas edge
    const shifted = { ...inp, mountain: offsetMountain(inp.mountain, -420, 0), channels: inp.channels.map((l) => l.map((p) => ({ x: p.x - 420, y: p.y }))) }
    expect(planHills(shifted).hills.some((h) => h.side < 0)).toBe(false)
  })
})

// ------------------------------------------------------------------ the surface
describe('buildWorld', () => {
  const inp = homeInput('wide')
  const world = buildWorld({ ...inp, cell: 8 })
  const cone = buildWorld({ ...inp, cell: 8, connected: false })

  test('every vertex lies on the camera ray through its own pixel, so relief never moves an outline', () => {
    for (const part of [world.body, world.fg]) {
      const { x: cx, y: cy, z: D } = world.camera
      let worst = 0
      for (let k = 0; k < part.plate.length / 2; k++) {
        const X = part.positions[k * 3], Y = part.positions[k * 3 + 1], Z = part.positions[k * 3 + 2]
        const s = D / (D - Z)
        const px = cx + (X - cx) * s
        const py = inp.canvas.h - (cy + (Y - cy) * s)
        worst = Math.max(worst, Math.abs(px - part.plate[k * 2]), Math.abs(py - part.plate[k * 2 + 1]))
      }
      expect(worst).toBeLessThan(1e-3)
    }
  })

  test('the camera maps the z = 0 plane one world unit to one pixel', () => {
    const { z: D, fov } = world.camera
    expect(2 * D * Math.tan((fov * Math.PI) / 360)).toBeCloseTo(inp.canvas.h, 6)
  })

  test('the mesh covers the whole outline inside the canvas', () => {
    const { x0, y0, nx, ny, cell } = world.grid
    for (const p of world.outline) {
      if (p.x < 0 || p.x > inp.canvas.w || p.y > inp.canvas.h) continue
      expect(p.x).toBeGreaterThanOrEqual(x0)
      expect(p.x).toBeLessThanOrEqual(x0 + (nx - 1) * cell)
      expect(p.y).toBeGreaterThanOrEqual(y0)
      expect(p.y).toBeLessThanOrEqual(Math.min(inp.canvas.h, y0 + (ny - 1) * cell))
    }
  })

  test('connected: false is the cone alone: no hills, no foreground ridge', () => {
    expect(cone.hills).toEqual([])
    expect(cone.fg).toBeNull()
    expect(world.hills.length).toBeGreaterThan(0)
    expect(world.fg).not.toBeNull()
  })

  test('inside the cone, the vent, the lava, the pool and the summit show the cone\'s own surface, never a hill\'s', () => {
    const { nx, ny, xs, ys } = world.grid
    let checked = 0, most = 0
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i
        if (!world.insideCone[k] || keepOutGap(world.keep, xs[i], ys[j]) > 0) continue
        most = Math.max(most, world.own[k])
        checked++
      }
    expect(checked).toBeGreaterThan(100)
    expect(most).toBeLessThan(0.02)
  })

  test('a hill merges into the flank below its join: across the flank\'s outline the ground runs on, with no step in depth', () => {
    const { nx, cell, x0, y0 } = world.grid
    const m = inp.mountain
    const flankX = (flank, y) => {
      for (let i = 1; i < flank.length; i++) if (y <= flank[i].y) return flank[i - 1].x + ((flank[i].x - flank[i - 1].x) * (y - flank[i - 1].y)) / (flank[i].y - flank[i - 1].y)
      return flank.at(-1).x
    }
    const at = (x, y) => Math.round((y - y0) / cell) * nx + Math.round((x - x0) / cell)
    expect(world.hills.length).toBeGreaterThan(0)
    for (const h of world.hills) {
      for (const f of [0.08, 0.15, 0.22]) {
        // below the join, either side of the flank's outline: alone, the cone falls away behind its limb (a silhouette);
        // with the hill the ground on the far side is the hill's, at about the limb's own depth (a hollow, not a cliff),
        // and the hill has a share of the surface right at the limb
        const y = h.join.y + f * world.sizes.Hm
        const x = flankX(h.side > 0 ? m.right : m.left, y)
        const kIn = at(x - h.side * cell, y), kOut = at(x + h.side * cell, y)
        const step = Math.abs(world.z[kIn] - world.z[kOut])
        const alone = Math.abs(cone.z[kIn] - cone.z[kOut])
        expect(step).toBeLessThan(0.65 * alone)
        expect(world.own[at(x, y)]).toBeGreaterThan(0.3)
      }
    }
  })

  test('the inside comes toward the camera and the glow sits on the vent', () => {
    let zin = 0, n = 0
    for (let k = 0; k < world.insideCone.length; k++) if (world.insideCone[k]) (zin += world.z[k]), n++
    expect(zin / n).toBeGreaterThan(0)
    const { x0, y0, nx, cell } = world.grid
    const m = inp.mountain
    const k = Math.round((m.vent.y - y0) / cell) * nx + Math.round((m.vent.x - x0) / cell)
    expect(world.body.field[k * 4]).toBeGreaterThan(0.8)
  })

  test('the hills that run back from the cone are hazed, more the further they run; the cone is not', () => {
    const { nx, cell, x0, y0 } = world.grid
    const hazeAt = (x, y) => world.body.shade[(Math.round((y - y0) / cell) * nx + Math.round((x - x0) / cell)) * 4 + 2]
    for (const h of world.hills) {
      const near = h.skyline[Math.floor(h.skyline.length * 0.1)], farther = h.skyline[Math.floor(h.skyline.length * 0.8)]
      expect(hazeAt(farther.x, farther.y + 30)).toBeGreaterThan(hazeAt(near.x, near.y + 30))
    }
    const m = inp.mountain
    expect(hazeAt(m.peakX, m.peakY + 200)).toBe(0)
  })

  test('same seed, same world; another seed, another surface', () => {
    const again = buildWorld({ ...inp, cell: 8 })
    expect(Buffer.from(again.body.positions.buffer).equals(Buffer.from(world.body.positions.buffer))).toBe(true)
    expect(Buffer.from(again.fg.positions.buffer).equals(Buffer.from(world.fg.positions.buffer))).toBe(true)
    const other = buildWorld({ ...inp, cell: 8, seed: 12345 })
    expect(Buffer.from(other.body.positions.buffer).equals(Buffer.from(world.body.positions.buffer))).toBe(false)
  })

  test('a pool sinks the rock a little and lights it around and above the arc, with no edge of its own, and not along the whole foot', () => {
    const w = buildWorld({ ...inp, cell: 8, connected: false })
    const pool = inp.mountain.pool
    const { x0, y0, nx, cell } = w.grid
    const at = (x, y) => Math.round((y - y0) / cell) * nx + Math.round((x - x0) / cell)
    const glow = (x, y) => w.body.field[at(x, y) * 4]
    expect(w.body.field[at(pool.cx, pool.cy) * 4 + 1]).toBe(1)
    expect(glow(pool.cx, pool.arcTop - 0.3 * pool.ry)).toBeGreaterThan(0.2)
    // the glow falls off smoothly across the shore: no step between neighbouring cells along the centre line
    let jump = 0
    for (let y = pool.arcTop - 2 * pool.ry; y < pool.cy; y += cell) jump = Math.max(jump, Math.abs(glow(pool.cx, y + cell) - glow(pool.cx, y)))
    expect(jump).toBeLessThan(0.15)
    // narrow in x: past the lake's ends, just above it, the halo has all but gone (no band along the cone's foot)
    const y = pool.arcTop - 0.3 * pool.ry
    const ends = [pool.cx - 1.25 * pool.rx, pool.cx + 1.25 * pool.rx].filter((x) => x > 0 && x < inp.canvas.w)
    for (const x of ends) expect(glow(x, y)).toBeLessThan(0.25 * glow(pool.cx, y) + 0.05)
    expect(w.poolLight).not.toBeNull()
  })
})
