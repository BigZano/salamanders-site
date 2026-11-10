import { describe, it, expect } from 'vitest'
import { simSize, paletteBytes, parents, channelMap, simUniforms, NO_CHANNEL, POOL } from './lavaSim'
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
describe('channelMap', () => {
  const net = [
    { head: true, drain: -1, drainAt: 1 },
    { parent: -1, drain: 0, drainAt: 0.3 },
    { parent: 0, attach: 0.8, drain: 0, drainAt: 0.95 },
    { head: false },
  ]
  it('writes drain and drainAt beside parent and attach: -1 for the pool, NO_CHANNEL for none', () => {
    const m = channelMap(net, null)
    expect(Object.keys(m).sort()).toEqual(['attach', 'drain', 'drainAt', 'parent', 'vent'])
    expect(Array.from(m.drain.slice(0, 5))).toEqual([-1, 0, 0, NO_CHANNEL, NO_CHANNEL])
    expect(Array.from(m.drainAt.slice(0, 5))).toEqual([1, 0.3, 0.95, 0, 0].map((x) => Math.fround(x)))
    expect(Array.from(m.parent.slice(0, 3))).toEqual([-1, -1, 0])
    expect(Array.from(m.attach.slice(0, 3))).toEqual([0, 0, 0.8].map((x) => Math.fround(x)))
    for (const a of [m.parent, m.attach, m.drain, m.drainAt, m.vent]) expect(a).toHaveLength(12)
    expect(channelMap(net, null)).toBe(m)
  })
  it('turns a drain that names no channel, or its own, into no drain, and clamps drainAt to 0..1', () => {
    const m = channelMap([{ drain: 7, drainAt: 0.5 }, { drain: 1, drainAt: 0.5 }, { drain: 0, drainAt: 3 }, { drain: 0, drainAt: -1 }, { drain: 0 }], null)
    expect(Array.from(m.drain.slice(0, 5))).toEqual([NO_CHANNEL, NO_CHANNEL, 0, 0, 0])
    expect(Array.from(m.drainAt.slice(0, 5))).toEqual([0, 0, 1, 0, 1])
  })
  it('reads drainAt of a pool feeder as its entry across the arc, -1..1 and 0 when it says none, not an along fraction', () => {
    const m = channelMap([{ drain: -1, drainAt: 0 }, { drain: -1, drainAt: -0.6 }, { drain: -1, drainAt: -4 }, { drain: -1, drainAt: 4 }, { drain: -1 }, { drain: 0, drainAt: -0.6 }, { drain: -1, drainAt: NaN }], null)
    expect(Array.from(m.drainAt.slice(0, 7))).toEqual([0, -0.6, -1, 1, 0, 0, 0].map((x) => Math.fround(x)))
    // A channel that drains into another channel still reads 0..1 along it, 1 when it says none.
    expect(Array.from(channelMap([{}, { drain: 0, drainAt: -0.6 }, { drain: 0 }, { drain: 0, drainAt: 7 }], null).drainAt.slice(1, 4))).toEqual([0, 1, 1])
  })
  it('writes vent from flow.heat clamped 0..1: 1 for a flow with none, 1 at the pool slot, 0 past it', () => {
    const m = channelMap([{ heat: 1 }, { heat: 0.8 }, { heat: 1.7 }, { heat: -2 }, {}, { heat: NaN }], { cx: 0 })
    expect(Array.from(m.vent)).toEqual([1, Math.fround(0.8), 1, 0, 1, 1, 1, 0, 0, 0, 0, 0])
    // No pool: the slot after the last flow is 0 like the rest.
    expect(Array.from(channelMap([{ heat: 0.5 }], null).vent)).toEqual([0.5, ...Array(11).fill(0)])
    expect(Array.from(channelMap([], null).vent)).toEqual(Array(12).fill(0))
  })
  it('puts the pool in the slot at flows.length, flagged POOL, with nothing of its own to feed', () => {
    expect(POOL).toBe(-3)
    const m = channelMap(net, { cx: 1 })
    expect(m.parent[net.length]).toBe(POOL)
    expect(m.drain[net.length]).toBe(NO_CHANNEL)
    expect(m.attach[net.length]).toBe(0)
    expect(m.drainAt[net.length]).toBe(0)
    expect(Array.from(m.parent.slice(0, net.length))).toEqual([-1, -1, 0, -1])
  })
  it('marks every slot past the pool as no channel, and clears a longer list left in the shared arrays', () => {
    const m = channelMap(net, {})
    expect(Array.from(m.parent.slice(net.length + 1))).toEqual(Array(12 - net.length - 1).fill(NO_CHANNEL))
    expect(Array.from(m.drain.slice(net.length))).toEqual(Array(12 - net.length).fill(NO_CHANNEL))
    // No pool: the slot after the last flow is no channel's.
    expect(channelMap(net, null).parent[net.length]).toBe(NO_CHANNEL)
    // Twelve flows leave no slot for the pool: it is dropped, not written over a stream.
    const full = Array.from({ length: 12 }, () => ({ head: true, drain: -1 }))
    expect(Array.from(channelMap(full, {}).parent)).toEqual(Array(12).fill(-1))
    expect(Array.from(channelMap([], {}).parent)).toEqual([POOL, ...Array(11).fill(NO_CHANNEL)])
  })
  it('keeps parents() as an alias of channelMap(flows, null) until the caller is rewired', () => {
    const p = parents(net)
    expect(p).toBe(channelMap(net, null))
    expect(Array.from(p.drain.slice(0, 3))).toEqual([-1, 0, 0])
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
