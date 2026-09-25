import { describe, it, expect } from 'vitest'
import * as wrought from './wrought'
import { drakeSkull } from './drakeSkull'

// Every coordinate pair in a path string, in order.
const coords = (d) => [...d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => [+m[1], +m[2]])
const paths = (p) => [p.cuts, p.veins]

describe('wrought engraving', () => {
  const pieces = [
    ['corner', wrought.corner(11), 160, 160],
    ['crest', wrought.crest(7), 200, 40],
    ['runner', wrought.runner(3), 320, 40],
  ]
  it.each(pieces)('%s is finite and inside its box', (_, p, w, h) => {
    const all = paths(p).join('')
    expect(all).not.toMatch(/NaN|Infinity/)
    expect(all.length).toBeGreaterThan(100)
    for (const [x, y] of paths(p).flatMap(coords)) {
      expect(x).toBeGreaterThanOrEqual(-2)
      expect(x).toBeLessThanOrEqual(w + 2)
      expect(y).toBeGreaterThanOrEqual(-2)
      expect(y).toBeLessThanOrEqual(h + 2)
    }
    for (const b of p.beads) expect(Number.isFinite(b.cx) && Number.isFinite(b.cy) && b.r > 0).toBe(true)
  })
})

describe('drake skull', () => {
  it('is finite, inside its 200 × 200 box, and paints something', () => {
    const ops = drakeSkull(5)
    expect(ops.length).toBeGreaterThan(50)
    for (const op of ops) {
      expect(op.d).not.toMatch(/NaN|Infinity/)
      // Relative arc segments (rivets, embers) carry offsets, not positions.
      for (const [x, y] of coords(op.d.replace(/a[^MLZa]*/g, ''))) {
        expect(x).toBeGreaterThanOrEqual(-2)
        expect(x).toBeLessThanOrEqual(202)
        expect(y).toBeGreaterThanOrEqual(-2)
        expect(y).toBeLessThanOrEqual(202)
      }
    }
  })
})

describe('wrought hand', () => {
  it('gives each seed its own tremor but repeats exactly for the same seed', () => {
    expect(wrought.corner(11).cuts).toBe(wrought.corner(11).cuts)
    expect(wrought.corner(11).cuts).not.toBe(wrought.corner(23).cuts)
  })
})
