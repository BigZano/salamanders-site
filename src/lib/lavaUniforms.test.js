import { describe, it, expect } from 'vitest'
import { uploadFrame, uploadSim } from './lavaUniforms'
import { UNIFORMS } from './lavaShader.glsl'
import { SIM_UNIFORMS } from './lavaSim.glsl'
import { packUniforms } from './lavaProfile'
import { simUniforms, channelMap } from './lavaSim'

// A context that records every uniform by name. Locations come only from the table a test hands over, so an
// upload that reaches for a name outside it gets `undefined` and throws here.
function recorder() {
  const set = {}
  const gl = {}
  for (const name of ['uniform1f', 'uniform1i', 'uniform1fv', 'uniform2f', 'uniform4f', 'uniform4fv']) {
    gl[name] = (loc, ...v) => {
      set[loc.name] = v.length === 1 ? (ArrayBuffer.isView(v[0]) ? Array.from(v[0]) : v[0]) : v
    }
  }
  return { gl, set }
}
const locations = (names) => Object.fromEntries(names.map((name) => [name, { name }]))

const tune = { crust: 0.5, heat: 1.2, viscosity: 0.6, cracks: 0.8, foldScale: 1.5, breakoutRate: 2 }
const flows = [{ heat: 0.9, surge: 0.4, flowDist: 3, drain: -1, drainAt: 1 }, { heat: 0.5, parent: 0, attach: 0.3, drain: 0, drainAt: 0.7 }]

describe('uploadFrame', () => {
  // packUniforms hands back one shared object that its next call refills, so each test packs its own.
  const pack = () => packUniforms({
    flows, calmRects: [{ l: 1, t: 2, r: 3, b: 4 }], calmShift: 10, tune, density: 0.7, t: 5, phone: false,
  })
  const extras = {
    lengths: new Float32Array(12).fill(9),
    width: 195,
    height: 422,
    box: { x: 1, y: 2, w: 3, h: 4 },
    size: { along: 256, across: 32 },
    poolId: 2,
    plateH: 77,
  }

  it('sets exactly the lava pass uniforms, from the packed values and the layer extras', () => {
    const { gl, set } = recorder()
    uploadFrame(gl, locations(UNIFORMS), pack(), extras)
    expect(Object.keys(set).sort()).toEqual([...UNIFORMS].sort())
    expect(UNIFORMS).toHaveLength(17)
    expect(set).toMatchObject({
      uViscosity: 0.6,
      uCracks: 0.8,
      uFoldScale: 1.5,
      uDensity: 0.7,
      uOctaves: 4,
      uCalmCount: 1,
      uResolution: [195, 422],
      uBounds: [1, 2, 3, 4],
      uSimSize: [256, 32],
      uPoolId: 2,
      uPlateH: 77,
    })
    expect(set.uLength).toEqual(Array(12).fill(9))
    expect(set.uCalm.slice(0, 4)).toEqual([1, 12, 3, 14])
    expect(set.uFlow[0]).toBe(3)
    // The pool is slot 2, past the two flows: its flow clock is at rest (see packUniforms).
    expect(set.uFlow[2]).toBe(0)
  })

  it('sends uPoolId as -1 when the layer has no pool, and takes the plate height from the bounds box when it has none', () => {
    const { gl, set } = recorder()
    const { poolId, plateH, ...bare } = extras
    uploadFrame(gl, locations(UNIFORMS), pack(), bare)
    expect(set.uPoolId).toBe(-1)
    expect(set.uPlateH).toBe(4)
    uploadFrame(gl, locations(UNIFORMS), pack(), { ...bare, poolId: null })
    expect(set.uPoolId).toBe(-1)
    uploadFrame(gl, locations(UNIFORMS), pack(), { ...bare, poolId: 0 })
    expect(set.uPoolId).toBe(0)
  })

  it('puts the field on texture unit 0, the sim on 1 and the palette on 2', () => {
    const { gl, set } = recorder()
    uploadFrame(gl, locations(UNIFORMS), pack(), extras)
    expect([set.uField, set.uSim, set.uPalette]).toEqual([0, 1, 2])
  })

  it('does not touch the uniforms the sim took over', () => {
    const { gl, set } = recorder()
    uploadFrame(gl, locations(UNIFORMS), pack(), extras)
    // And heat counts once, in the sim: neither the tuner heat nor a per-channel heat reaches the lava pass.
    for (const gone of ['uTime', 'uPhase', 'uSurge', 'uCrust', 'uBreakoutRate', 'uHeat', 'uHeatPer']) expect(set).not.toHaveProperty(gone)
  })
})

describe('uploadSim', () => {
  const s = simUniforms(tune, 0.02, false)
  const map = channelMap(flows, { cx: 0 })
  const extras = {
    size: { along: 128, across: 16 },
    time: 12.5,
    ignite: false,
    surge: packUniforms({ flows, calmRects: [], calmShift: 0, tune, density: 1, t: 0, phone: false }).uSurge,
    parent: map.parent,
    attach: map.attach,
    drain: map.drain,
    drainAt: map.drainAt,
    vent: map.vent,
  }

  it('sets exactly the sim pass uniforms', () => {
    const { gl, set } = recorder()
    uploadSim(gl, locations(SIM_UNIFORMS), s, extras)
    expect(Object.keys(set).sort()).toEqual([...SIM_UNIFORMS].sort())
    expect(set).toMatchObject({
      uPrev: 0,
      uSimSize: [128, 16],
      uDt: 0.02,
      uTime: 12.5,
      uSource: s.uSource,
      uCool: 0.5,
      uVisc: 0.6,
      uBreak: 2,
      uIgnite: 0,
    })
  })

  it('does not upload the crack glow: that is the lava pass uCracks', () => {
    const { gl, set } = recorder()
    uploadSim(gl, locations(SIM_UNIFORMS), s, extras)
    expect(s).toHaveProperty('uCrackGlow')
    expect(set).not.toHaveProperty('uCrackGlow')
  })

  it('passes the surge, parent and attach arrays whole', () => {
    const { gl, set } = recorder()
    uploadSim(gl, locations(SIM_UNIFORMS), s, extras)
    expect(set.uSurge).toHaveLength(12)
    // Slot 2 is the pool, flagged -3 (lavaSim.js POOL); slot 3 is past it: no channel's (NO_CHANNEL).
    expect(set.uParent.slice(0, 4)).toEqual([-1, 0, -3, -2])
    expect(set.uAttach[1]).toBeCloseTo(0.3)
    expect(set.uSurge[0]).toBeCloseTo(0.4)
  })

  it('uploadSim sends uDrain, uDrainAt and uVentHeat as 1fv, whole, in the slot order of the flows', () => {
    const calls = []
    const gl = { uniform1f() {}, uniform1i() {}, uniform2f() {}, uniform1fv: (loc, v) => calls.push([loc.name, Array.from(v)]) }
    uploadSim(gl, locations(SIM_UNIFORMS), s, extras)
    const sent = Object.fromEntries(calls)
    expect(Object.keys(sent).sort()).toEqual(['uAttach', 'uDrain', 'uDrainAt', 'uParent', 'uSurge', 'uVentHeat'])
    expect(sent.uVentHeat).toHaveLength(12)
    // Each vent-fed channel's heat, 1 at the pool's slot, 0 past it.
    expect(sent.uVentHeat.slice(0, 4).map((v) => Math.round(v * 100) / 100)).toEqual([0.9, 0.5, 1, 0])
    expect(sent.uDrain).toHaveLength(12)
    expect(sent.uDrainAt).toHaveLength(12)
    // The trunk drains into the pool (-1) at its toe; the arm drains into the trunk (0) at 0.7; the pool and past it: none.
    expect(sent.uDrain.slice(0, 4)).toEqual([-1, 0, -2, -2])
    expect(sent.uDrainAt[1]).toBeCloseTo(0.7)
    expect(sent.uDrainAt[0]).toBe(1)
  })

  it('wraps the clock to an hour before upload so the shader hash keeps its precision', () => {
    const { gl, set } = recorder()
    uploadSim(gl, locations(SIM_UNIFORMS), s, { ...extras, time: 3601.5 })
    expect(set.uTime).toBe(1.5)
    uploadSim(gl, locations(SIM_UNIFORMS), s, { ...extras, time: 7199.25 })
    expect(set.uTime).toBe(3599.25)
  })

  it('sends uIgnite as 1 for a step that ignites and 0 for any other', () => {
    const { gl, set } = recorder()
    uploadSim(gl, locations(SIM_UNIFORMS), s, { ...extras, ignite: true })
    expect(set.uIgnite).toBe(1)
    uploadSim(gl, locations(SIM_UNIFORMS), s, { ...extras, ignite: false })
    expect(set.uIgnite).toBe(0)
  })
})
