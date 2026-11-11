import { describe, expect, test } from 'vitest'
import { decodeInput, offsetMountain, parseInput } from './input.js'

const b64 = (o) => btoa(JSON.stringify(o))

describe('parseInput', () => {
  test('decodes base64 json and offsets by the bleed', () => {
    const input = { mountain: { peakX: 100, peakY: 50, left: [{ x: 0, y: 0 }] }, size: { w: 1000, h: 500 }, bleed: 0.1, seed: 7 }
    const p = parseInput(b64(input))
    expect(p.canvas).toEqual({ w: 1200, h: 600 })
    expect(p.mountain.peakX).toBe(200) // + 0.1 * 1000
    expect(p.mountain.left[0]).toEqual({ x: 100, y: 50 })
    expect(p.seed).toBe(7)
    expect(p.offset).toEqual({ x: 100, y: 50 })
  })

  test('the canvas rounds to whole pixels', () => {
    const p = parseInput(b64({ mountain: { peakX: 0, peakY: 0 }, size: { w: 900, h: 1600 }, bleed: 0.1, seed: 1 }))
    expect(p.canvas).toEqual({ w: 1080, h: 1920 })
  })

  test('accepts url-safe base64, a query string that turned "+" into spaces, and missing padding', () => {
    // the note's '>>>' and '???' put "+" and "/" in the standard encoding
    const input = { mountain: { peakX: 1, peakY: 2 }, size: { w: 10, h: 10 }, bleed: 0, seed: 3, note: '>>>???~~~' }
    const std = b64(input)
    expect(std).toMatch(/[+/]/)
    const urlSafe = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const spaced = std.replace(/\+/g, ' ')
    for (const s of [std, urlSafe, spaced]) expect(parseInput(s).mountain.peakY).toBe(2)
  })

  test('the pool, the lip and channels follow the bleed; the pool radii do not', () => {
    const input = {
      mountain: {
        peakX: 0,
        peakY: 0,
        pool: { cx: 10, cy: 20, rx: 5, ry: 2, arcTop: 18 },
        lip: { x: 1, y: 1 },
      },
      channels: [[{ x: 0, y: 0 }, { x: 5, y: 5 }]],
      size: { w: 100, h: 50 },
      bleed: 0.1,
      seed: 0,
    }
    const p = parseInput(b64(input))
    expect(p.mountain.pool).toEqual({ cx: 20, cy: 25, rx: 5, ry: 2, arcTop: 23 })
    expect(p.mountain.lip).toEqual({ x: 11, y: 6 })
    expect(p.channels).toEqual([[{ x: 10, y: 5 }, { x: 15, y: 10 }]])
  })

  test('channels default to none', () => {
    expect(parseInput(b64({ mountain: { peakX: 0, peakY: 0 }, size: { w: 10, h: 10 }, bleed: 0, seed: 0 })).channels).toEqual([])
  })

  test('refuses input it cannot render', () => {
    expect(() => parseInput('')).toThrow(/input/)
    expect(() => parseInput('not base64 json!')).toThrow(/input/)
    expect(() => parseInput(b64({ size: { w: 10, h: 10 }, bleed: 0, seed: 0 }))).toThrow(/mountain/)
    expect(() => parseInput(b64({ mountain: { peakX: 0, peakY: 0 }, size: { w: 0, h: 10 }, bleed: 0, seed: 0 }))).toThrow(/size/)
    expect(() => parseInput(b64({ mountain: { peakX: 0, peakY: 0 }, size: { w: 10, h: 10 }, bleed: -1, seed: 0 }))).toThrow(/bleed/)
    expect(() => parseInput(b64({ mountain: { peakX: 0, peakY: 0 }, size: { w: 10, h: 10 }, bleed: 0 }))).toThrow(/seed/)
  })

  test('decodeInput is the bare decode', () => {
    expect(decodeInput(b64({ a: 1 }))).toEqual({ a: 1 })
  })
})

describe('offsetMountain', () => {
  const mountain = () => {
    const rimL = { x: 1, y: 2 }
    const edge = { x: 3, y: 4 }
    return {
      peakX: 10,
      peakY: 20,
      craterHalf: 5,
      valleyDepth: 2,
      rimL,
      left: [rimL, { x: 0, y: 9 }],
      valley: [edge, { x: 4, y: 6 }],
      mouthL: edge, // aliased, as buildMountain returns it
      vent: { x: 4, y: 6 },
    }
  }

  test('moves every point and peak, leaves the scalars', () => {
    const m = offsetMountain(mountain(), 100, 1000)
    expect(m.peakX).toBe(110)
    expect(m.peakY).toBe(1020)
    expect(m.craterHalf).toBe(5)
    expect(m.valleyDepth).toBe(2)
    expect(m.left).toEqual([{ x: 101, y: 1002 }, { x: 100, y: 1009 }])
    expect(m.mouthL).toEqual({ x: 103, y: 1004 })
    expect(m.valley[0]).toEqual({ x: 103, y: 1004 })
  })

  test('returns new objects and never mutates, aliased points moved once', () => {
    const src = mountain()
    const before = JSON.stringify(src)
    const m = offsetMountain(src, 7, 7)
    expect(JSON.stringify(src)).toBe(before)
    expect(m.mouthL).not.toBe(src.mouthL)
    expect(m.valley[0]).not.toBe(src.valley[0])
    expect(m.left).not.toBe(src.left)
    expect(m.mouthL).toEqual({ x: 10, y: 11 })
    expect(m.valley[0]).toEqual({ x: 10, y: 11 })
  })

  test('copies fields it does not know as they are', () => {
    const m = offsetMountain({ peakX: 0, peakY: 0, note: 'x', count: 3 }, 1, 1)
    expect(m).toEqual({ peakX: 1, peakY: 1, note: 'x', count: 3 })
  })
})
