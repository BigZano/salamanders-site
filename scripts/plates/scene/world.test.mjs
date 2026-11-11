import { describe, expect, test } from 'vitest'
import { DEFAULTS, RANDOMIZE_DEFAULTS, ROUTE_PROFILE_DEFAULTS } from '../../../src/lib/fireTuning.js'
import { hashString, mountainForRoute } from '../../../src/lib/mountain.js'
import { offsetMountain } from './input.js'
import { buildRidges, buildWorld, distToPolyline, outline, rowCrossings, terraces } from './world.js'

// the home mountain at the wide plate's reference size, moved by the bleed as the scene moves it
const size = { w: 2000, h: 1125 }
const canvas = { w: 2400, h: 1350 }
const home = () => {
  const { mountain } = mountainForRoute({ path: '/', w: size.w, h: size.h, tune: DEFAULTS.bed, prof: ROUTE_PROFILE_DEFAULTS['/'], randomize: RANDOMIZE_DEFAULTS })
  return offsetMountain(mountain, 200, 112.5)
}

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
  test('rowCrossings bounds the inside of a square', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    expect(rowCrossings(sq, 5)).toEqual([0, 10])
    expect(rowCrossings(sq, 11)).toEqual([])
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
})

describe('buildWorld', () => {
  const world = buildWorld({ mountain: home(), canvas, channels: [], seed: hashString('/'), cell: 8 })

  test('every vertex lies on the camera ray through its own pixel, so relief never moves the outline', () => {
    const { x: cx, y: cy, z: D } = world.camera
    let worst = 0
    for (let k = 0; k < world.plate.length / 2; k++) {
      const X = world.positions[k * 3], Y = world.positions[k * 3 + 1], Z = world.positions[k * 3 + 2]
      // project: scale back by D / (D - Z) about the camera's axis
      const s = D / (D - Z)
      const px = cx + (X - cx) * s
      const py = canvas.h - (cy + (Y - cy) * s)
      worst = Math.max(worst, Math.abs(px - world.plate[k * 2]), Math.abs(py - world.plate[k * 2 + 1]))
    }
    expect(worst).toBeLessThan(1e-3)
  })

  test('the camera maps the z = 0 plane one world unit to one pixel', () => {
    const { z: D, fov } = world.camera
    expect(2 * D * Math.tan((fov * Math.PI) / 360)).toBeCloseTo(canvas.h, 6)
  })

  test('the mesh covers the whole outline inside the canvas', () => {
    const { x0, y0, nx, ny, cell } = world.grid
    for (const p of world.outline) {
      if (p.x < 0 || p.x > canvas.w || p.y > canvas.h) continue
      expect(p.x).toBeGreaterThanOrEqual(x0)
      expect(p.x).toBeLessThanOrEqual(x0 + (nx - 1) * cell)
      expect(p.y).toBeGreaterThanOrEqual(y0)
      expect(p.y).toBeLessThanOrEqual(Math.min(canvas.h, y0 + (ny - 1) * cell))
    }
  })

  test('the inside comes toward the camera and the glow sits on the vent', () => {
    let zin = 0, n = 0
    for (let k = 0; k < world.inside.length; k++) if (world.inside[k]) (zin += world.positions[k * 3 + 2]), n++
    expect(zin / n).toBeGreaterThan(0)
    const { x0, y0, nx, cell } = world.grid
    const m = home()
    const k = Math.round((m.vent.y - y0) / cell) * nx + Math.round((m.vent.x - x0) / cell)
    expect(world.glow[k]).toBeGreaterThan(0.8)
  })

  test('same seed, same world; another seed, another surface', () => {
    const again = buildWorld({ mountain: home(), canvas, channels: [], seed: hashString('/'), cell: 8 })
    expect(Buffer.from(again.positions.buffer).equals(Buffer.from(world.positions.buffer))).toBe(true)
    const other = buildWorld({ mountain: home(), canvas, channels: [], seed: 12345, cell: 8 })
    expect(Buffer.from(other.positions.buffer).equals(Buffer.from(world.positions.buffer))).toBe(false)
  })

  test('a pool sinks the rock a little and lights it around and above the arc, with no edge of its own', () => {
    const m = home()
    const baseW = m.right.at(-1).x - m.left.at(-1).x
    const rx = 0.225 * baseW, ry = rx / 4
    const pool = { cx: m.vent.x, cy: m.left.at(-1).y - 0.2 * ry, rx, ry, arcTop: m.left.at(-1).y - 1.2 * ry }
    const w = buildWorld({ mountain: { ...m, pool }, canvas, seed: 1, cell: 8 })
    const { x0, y0, nx, cell } = w.grid
    const at = (x, y) => Math.round((y - y0) / cell) * nx + Math.round((x - x0) / cell)
    expect(w.poolMask[at(pool.cx, pool.cy)]).toBe(1)
    expect(w.glow[at(pool.cx, pool.arcTop - 0.3 * ry)]).toBeGreaterThan(0.2)
    // the glow falls off smoothly across the shore: no step between neighbouring cells along the centre line
    let jump = 0
    for (let y = pool.arcTop - 2 * ry; y < pool.cy; y += cell) jump = Math.max(jump, Math.abs(w.glow[at(pool.cx, y + cell)] - w.glow[at(pool.cx, y)]))
    expect(jump).toBeLessThan(0.15)
    expect(w.poolLight).not.toBeNull()
  })
})

describe('buildRidges', () => {
  const m = home()
  const baseW = m.right.at(-1).x - m.left.at(-1).x
  const rx = 0.225 * baseW, ry = rx / 4
  const floor = canvas.h - 112.5
  const pool = { cx: m.vent.x - 150, cy: floor - 0.2 * ry, rx, ry, arcTop: floor - 1.2 * ry }
  const channels = [[m.vent, { x: pool.cx, y: pool.arcTop }]]
  const r = buildRidges({ mountain: { ...m, pool }, canvas, floor, channels, seed: 7 })

  test('far ridges: a horizon across the width and two cones, haziest first, all below the summit', () => {
    expect(r.far).toHaveLength(3)
    for (let i = 1; i < r.far.length; i++) expect(r.far[i].fade).toBeLessThanOrEqual(r.far[i - 1].fade)
    expect(r.far[0].crest.every(Number.isFinite)).toBe(true)
    const tip = Math.min(...m.crown.map((p) => p.y))
    for (const f of r.far) for (const y of f.crest) if (Number.isFinite(y)) expect(y).toBeGreaterThan(tip)
  })

  test('the foreground ridge stands on the side away from the pool and never rises over the pool or a stream', () => {
    expect(r.fg.side).toBe(pool.cx < canvas.w / 2 ? 1 : -1)
    const cols = [...r.fg.crest.keys()].filter((x) => Number.isFinite(r.fg.crest[x]))
    expect(cols.length).toBeGreaterThan(0)
    const mean = cols.reduce((a, x) => a + x, 0) / cols.length
    expect(Math.sign(mean - canvas.w / 2)).toBe(r.fg.side)
    for (let t = 0; t < 64; t++) {
      const x = Math.round(pool.cx + pool.rx * Math.cos((t / 64) * 2 * Math.PI))
      const y = pool.cy + pool.ry * Math.sin((t / 64) * 2 * Math.PI)
      if (x >= 0 && x < canvas.w) expect(r.fg.crest[x]).toBeGreaterThan(y)
    }
    for (let f = 0; f <= 1; f += 0.05) {
      const x = Math.round(m.vent.x + (pool.cx - m.vent.x) * f)
      expect(r.fg.crest[x]).toBeGreaterThan(m.vent.y + (pool.arcTop - m.vent.y) * f)
    }
  })

  test('seeded: the same seed draws the same ridges, another seed others', () => {
    const again = buildRidges({ mountain: { ...m, pool }, canvas, floor, channels, seed: 7 })
    expect(Array.from(again.fg.crest)).toEqual(Array.from(r.fg.crest))
    expect(Array.from(again.far[1].crest)).toEqual(Array.from(r.far[1].crest))
    const other = buildRidges({ mountain: { ...m, pool }, canvas, floor, channels, seed: 8 })
    expect(Array.from(other.far[0].crest)).not.toEqual(Array.from(r.far[0].crest))
  })
})
