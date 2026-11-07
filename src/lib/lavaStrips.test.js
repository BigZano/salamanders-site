import { describe, it, expect } from 'vitest'
import { buildStrips, bounds, STRIDE } from './lavaStrips'

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

describe('bounds', () => {
  it('is the padded union of every channel, or empty', () => {
    expect(bounds([flow([{ x: 10, y: 10 }, { x: 20, y: 40 }]), flow([{ x: 0, y: 50 }, { x: 5, y: 60 }])], 11)).toEqual({ x: -11, y: -1, w: 42, h: 72 })
    expect(bounds([], 11)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})
