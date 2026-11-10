import { describe, it, expect } from 'vitest'
import { velocity, packUniforms, MAX_CHANNELS, MAX_CALM } from './lavaProfile'

describe('velocity', () => {
  it('is zero at the banks and greatest at the centre', () => {
    expect(velocity(1, 0.5, 0.7)).toBe(0)
    expect(velocity(-1, 0.5, 0.7)).toBe(0)
    expect(velocity(0, 0.5, 0.7)).toBeGreaterThan(velocity(0.5, 0.5, 0.7))
  })
  it('slows toward the toe', () => {
    expect(velocity(0, 0.1, 0.7)).toBeGreaterThan(velocity(0, 0.9, 0.7))
  })
  it('sharpens with viscosity: the banks stick more', () => {
    expect(velocity(0.6, 0.5, 1)).toBeLessThan(velocity(0.6, 0.5, 0))
  })
})

describe('packUniforms', () => {
  const tune = { crust: 0.75, heat: 1, viscosity: 0.7, cracks: 0.8, foldScale: 1, breakoutRate: 1 }
  it('packs per-channel surge, flow clock and phase up to twelve channels', () => {
    const flows = Array.from({ length: 14 }, (_, i) => ({ surge: i === 2 ? 0.4 : -1, heat: 0.9, flowDist: i === 2 ? 12.5 : undefined }))
    const u = packUniforms({ flows, calmRects: [], calmShift: 0, tune, density: 1, t: 3, phone: false })
    expect(u.uSurge).toHaveLength(MAX_CHANNELS)
    expect(u.uSurge[2]).toBeCloseTo(0.4)
    expect(u.uSurge[0]).toBe(-1)
    expect(u.uFlow[2]).toBeCloseTo(12.5)
    expect(u.uFlow[0]).toBe(0)
    expect(u.uPhase[1]).not.toBe(u.uPhase[2])
    expect(u.uTime).toBe(3)
    expect(u.uOctaves).toBe(4)
  })
  it('leaves heat to the sim: no per-channel heat and no tuner heat for the lava pass', () => {
    const flows = [{ heat: 0.9, flowDist: 4 }, { heat: 0.3 }]
    const u = packUniforms({ flows, calmRects: [], calmShift: 0, tune, density: 1, t: 0, phone: false })
    expect(u).not.toHaveProperty('uHeatPer')
    expect(u).not.toHaveProperty('uHeat')
  })
  it('keeps the flow clock of the slot after the last flow, where the pool is, at rest, and clears it when the flows shrink', () => {
    const grown = Array.from({ length: 5 }, (_, i) => ({ heat: 1, flowDist: 10 + i }))
    let u = packUniforms({ flows: grown, calmRects: [], calmShift: 0, tune, density: 1, t: 0, phone: false })
    expect(Array.from(u.uFlow.slice(0, 6))).toEqual([10, 11, 12, 13, 14, 0])
    u = packUniforms({ flows: grown.slice(0, 2), calmRects: [], calmShift: 0, tune, density: 1, t: 0, phone: false })
    // Slots 2 to 4 held clocks a moment ago; the pool now sits in slot 2 and must not inherit one.
    expect(Array.from(u.uFlow.slice(0, 6))).toEqual([10, 11, 0, 0, 0, 0])
  })
  it('packs at most eight calm rects, shifted by the scroll', () => {
    const calmRects = Array.from({ length: 10 }, (_, i) => ({ l: i, t: 10, r: i + 5, b: 20 }))
    const u = packUniforms({ flows: [], calmRects, calmShift: 7, tune, density: 1, t: 0, phone: true })
    expect(u.uCalmCount).toBe(MAX_CALM)
    expect(u.uCalm).toHaveLength(MAX_CALM * 4)
    expect(Array.from(u.uCalm.slice(0, 4))).toEqual([0, 17, 5, 27])
    expect(u.uOctaves).toBe(3)
  })
  it('clamps every tunable to its tuner range', () => {
    const u = packUniforms({ flows: [], calmRects: [], calmShift: 0, tune: { crust: 3, heat: -1, viscosity: 2, cracks: 9, foldScale: 0, breakoutRate: 10 }, density: 1, t: 0, phone: false })
    expect(u.uCrust).toBe(1)
    expect(u.uViscosity).toBe(1)
    expect(u.uCracks).toBe(2)
    expect(u.uFoldScale).toBe(0.25)
    expect(u.uBreakoutRate).toBe(4)
  })
  it('reuses its typed arrays between calls (no per-frame allocation)', () => {
    const a = packUniforms({ flows: [], calmRects: [], calmShift: 0, tune, density: 1, t: 0, phone: false })
    const b = packUniforms({ flows: [], calmRects: [], calmShift: 0, tune, density: 1, t: 1, phone: false })
    expect(a.uSurge).toBe(b.uSurge)
  })
})
