import { describe, it, expect } from 'vitest'
import { uploadFrame, uploadSim } from './lavaUniforms'
import { UNIFORMS } from './lavaShader.glsl'
import { SIM_UNIFORMS } from './lavaSim.glsl'
import { packUniforms } from './lavaProfile'
import { simUniforms, parents } from './lavaSim'

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
const flows = [{ heat: 0.9, surge: 0.4, flowDist: 3 }, { heat: 0.5, parent: 0, attach: 0.3 }]

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
  }

  it('sets exactly the lava pass uniforms, from the packed values and the layer extras', () => {
    const { gl, set } = recorder()
    uploadFrame(gl, locations(UNIFORMS), pack(), extras)
    expect(Object.keys(set).sort()).toEqual([...UNIFORMS].sort())
    expect(set).toMatchObject({
      uHeat: 1.2,
      uViscosity: 0.6,
      uCracks: 0.8,
      uFoldScale: 1.5,
      uDensity: 0.7,
      uOctaves: 4,
      uCalmCount: 1,
      uResolution: [195, 422],
      uBounds: [1, 2, 3, 4],
      uSimSize: [256, 32],
    })
    expect(set.uLength).toEqual(Array(12).fill(9))
    expect(set.uCalm.slice(0, 4)).toEqual([1, 12, 3, 14])
    expect(set.uHeatPer[0]).toBeCloseTo(0.9)
    expect(set.uHeatPer[1]).toBeCloseTo(0.5)
    expect(set.uFlow[0]).toBe(3)
  })

  it('puts the field on texture unit 0, the sim on 1 and the palette on 2', () => {
    const { gl, set } = recorder()
    uploadFrame(gl, locations(UNIFORMS), pack(), extras)
    expect([set.uField, set.uSim, set.uPalette]).toEqual([0, 1, 2])
  })

  it('does not touch the uniforms the sim took over', () => {
    const { gl, set } = recorder()
    uploadFrame(gl, locations(UNIFORMS), pack(), extras)
    for (const gone of ['uTime', 'uPhase', 'uSurge', 'uCrust', 'uBreakoutRate']) expect(set).not.toHaveProperty(gone)
  })
})

describe('uploadSim', () => {
  const s = simUniforms(tune, 0.02, false)
  const map = parents(flows)
  const extras = {
    size: { along: 128, across: 16 },
    time: 12.5,
    ignite: false,
    surge: packUniforms({ flows, calmRects: [], calmShift: 0, tune, density: 1, t: 0, phone: false }).uSurge,
    parent: map.parent,
    attach: map.attach,
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
    expect(set.uParent.slice(0, 3)).toEqual([-1, 0, -1])
    expect(set.uAttach[1]).toBeCloseTo(0.3)
    expect(set.uSurge[0]).toBeCloseTo(0.4)
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
