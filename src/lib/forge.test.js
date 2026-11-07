import { describe, it, expect } from 'vitest'
import { forgeAdvance, forgeSample, devNumber } from './forge'

describe('forgeAdvance', () => {
  it('passes the elapsed time through when there is no forge', () => {
    expect(forgeAdvance(null, 33, 16)).toBe(33)
  })
  it('scales by the speed when running', () => {
    expect(forgeAdvance({ frozen: false, speed: 0.5, step: 0 }, 40, 16)).toBe(20)
    expect(forgeAdvance({ frozen: false, speed: 4, step: 0 }, 10, 16)).toBe(40)
  })
  it('advances nothing while frozen', () => {
    expect(forgeAdvance({ frozen: true, speed: 1, step: 0 }, 40, 16)).toBe(0)
  })
  it('advances one tick per queued step while frozen, and uses the steps up', () => {
    const f = { frozen: true, speed: 1, step: 2 }
    expect(forgeAdvance(f, 40, 16)).toBe(16)
    expect(forgeAdvance(f, 40, 16)).toBe(16)
    expect(forgeAdvance(f, 40, 16)).toBe(0)
    expect(f.step).toBe(0)
  })
})

describe('forgeSample', () => {
  it('writes mean, worst and fps once per half window', () => {
    const f = { stats: { draw: 0, max: 0, fps: 0 } }
    for (let i = 0; i < 29; i++) forgeSample(f, 1, 33.3)
    expect(f.stats.draw).toBe(0)
    forgeSample(f, 4, 33.3)
    expect(f.stats.draw).toBeCloseTo((29 * 1 + 4) / 30, 3)
    expect(f.stats.max).toBe(4)
    expect(f.stats.fps).toBeCloseTo(30, 0)
  })
  it('does nothing without a forge', () => {
    expect(() => forgeSample(null, 1, 1)).not.toThrow()
  })
})

describe('devNumber', () => {
  it('reads a finite number from the query string and nothing else', () => {
    expect(devNumber('t', '?t=12.5')).toBe(12.5)
    expect(devNumber('t', '?t=abc')).toBeNull()
    expect(devNumber('t', '?moon=0.4')).toBeNull()
  })
})
