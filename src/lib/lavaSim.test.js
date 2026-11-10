import { describe, it, expect } from 'vitest'
import { simSize, paletteBytes, parents, simUniforms, NO_CHANNEL } from './lavaSim'
import { DOOM_PALETTE } from './doomfire'

describe('simSize', () => {
  it('is 256 by 32 on a desktop and 128 by 16 on a phone', () => {
    expect(simSize(false)).toEqual({ along: 256, across: 32 })
    expect(simSize(true)).toEqual({ along: 128, across: 16 })
  })
  it('hands out frozen objects, since the layer shares them with every caller', () => {
    expect(Object.isFrozen(simSize(false))).toBe(true)
    expect(Object.isFrozen(simSize(true))).toBe(true)
  })
})
describe('paletteBytes', () => {
  it('flattens the 37-step Doom palette in order', () => {
    const b = paletteBytes()
    expect(b).toHaveLength(37 * 3)
    expect(Array.from(b.slice(0, 3))).toEqual(DOOM_PALETTE[0])
    expect(Array.from(b.slice(108, 111))).toEqual(DOOM_PALETTE[36])
  })
})
describe('parents', () => {
  it('maps each flow to its parent index and attach point, -1 for the sheet, missing or out of range', () => {
    const flows = [{ head: true }, { parent: 0, attach: 0.3 }, { parent: 1, attach: 0.4 }, { parent: 13, attach: 0.5 }]
    const p = parents(flows)
    expect(Array.from(p.parent.slice(0, 4))).toEqual([-1, 0, 1, -1])
    expect(Array.from(p.attach.slice(0, 4))).toEqual([0, 0.3, 0.4, 0.5].map((x) => Math.fround(x)))
    expect(p.parent).toHaveLength(12)
    expect(parents(flows).parent).toBe(p.parent)
  })
  it('marks the slots past the last flow as no channel, so the sim keeps them empty, and clears them on a longer list', () => {
    expect(NO_CHANNEL).toBe(-2)
    const p = parents([{ head: true }, { parent: 0, attach: 1 }])
    expect(Array.from(p.parent)).toEqual([-1, 0, ...Array(10).fill(NO_CHANNEL)])
    expect(Array.from(p.attach.slice(2))).toEqual(Array(10).fill(0))
    // A real flow whose parent index names no channel still starts on the sheet, not in an empty block.
    expect(Array.from(parents([{ head: true }, { parent: 5 }, {}]).parent.slice(0, 4))).toEqual([-1, -1, -1, NO_CHANNEL])
    expect(Array.from(parents([]).parent)).toEqual(Array(12).fill(NO_CHANNEL))
  })
})
describe('simUniforms', () => {
  it('clamps the dt and maps the tunables', () => {
    const u = simUniforms({ heat: 1, crust: 0.75, viscosity: 0.7, cracks: 0.8, breakoutRate: 1 }, 0.4, false)
    expect(u.uDt).toBe(0.05)
    expect(u.uSource).toBeCloseTo(0.9)
    expect(u.uCool).toBe(0.75)
    expect(u.uBreak).toBe(1)
    expect(simUniforms({ heat: 9, crust: -1, viscosity: 2, cracks: 9, breakoutRate: 9 }, 0.01, true)).toMatchObject({ uDt: 0.01, uSource: 1.8, uCool: 0, uVisc: 1, uCrackGlow: 2, uBreak: 4 })
  })
})
