import { describe, it, expect } from 'vitest'
import { FIELD_VERT, FIELD_FRAG, LAVA_VERT, LAVA_FRAG, UNIFORMS } from './lavaShader.glsl'

const balanced = (s) => (s.match(/\{/g) || []).length === (s.match(/\}/g) || []).length
describe('the GLSL sources', () => {
  it('are GLSL ES 3.00 with balanced braces', () => {
    for (const s of [FIELD_VERT, FIELD_FRAG, LAVA_VERT, LAVA_FRAG]) {
      expect(s.trimStart().startsWith('#version 300 es')).toBe(true)
      expect(balanced(s)).toBe(true)
    }
  })
  it('declare every uniform the layer sets, and the lava fragment uses each', () => {
    expect(UNIFORMS).toHaveLength(17)
    for (const u of ['uSim', 'uPalette', 'uSimSize']) expect(UNIFORMS).toContain(u)
    for (const u of ['uCrust', 'uBreakoutRate', 'uTime', 'uPhase', 'uSurge']) expect(UNIFORMS).not.toContain(u)
    // Whole words only, and not in comments: a plain substring count passes vacuously for uHeat
    // (inside uHeatPer) and uCalm (inside uCalmCount). One match is the declaration, so a second is a use.
    const code = (LAVA_FRAG + LAVA_VERT).replace(/\/\/.*$/gm, '')
    const uses = (u) => (code.match(new RegExp(`\\b${u}\\b`, 'g')) || []).length
    for (const u of UNIFORMS) {
      expect(LAVA_VERT + LAVA_FRAG).toMatch(new RegExp(`uniform\\s+\\w+\\s+${u}\\b`))
      if (u !== 'uHeat') expect(uses(u)).toBeGreaterThanOrEqual(2)
    }
    // Heat counts once, in the sim's source (see fireTuning.js): the layer still sets uHeat, and the lava pass declares
    // it and never reads it, so the tuner's heat is not applied a second time on top of the simulated heat.
    expect(uses('uHeat')).toBe(1)
  })
  it('scale every glow term by the page density, so a dim page is dim throughout', () => {
    expect(LAVA_FRAG).toMatch(/0\.18 \* shear \+ 0\.08 \* pl\.y\) \* uDensity/)
    expect(LAVA_FRAG).toMatch(/\* uDensity \* ORANGE_GLOW/)
  })
  it('leave a strip end the caps hide to the channel under it, with the lava pass\'s own cap sums', () => {
    const sums = ['e * e + a * a * step(0.001, e)', 'h * h + a * a * step(0.001, h)']
    for (const sum of sums) {
      expect(FIELD_FRAG).toContain(`${sum} >= 1.0`)
      expect(LAVA_FRAG).toContain(`smoothstep(1.0, 0.8, ${sum})`)
    }
    expect(FIELD_FRAG).toMatch(/discard;/)
  })
  it('keep each shader under 160 lines', () => {
    for (const s of [FIELD_VERT, FIELD_FRAG, LAVA_VERT, LAVA_FRAG]) {
      expect(s.trimEnd().split('\n').length).toBeLessThan(160)
    }
  })
  it('name the look constants so they can be tuned in one place', () => {
    for (const name of ['SPEED', 'CYCLE', 'WARP', 'WARP_FREQ', 'CELL', 'FOLD_PX', 'MARGIN', 'SOFT', 'NET_CELL', 'NET_HEAT', 'SEAM', 'DEEP', 'HOT']) {
      expect(LAVA_FRAG).toMatch(new RegExp(`const\\s+\\w+\\s+${name}\\s*=`))
    }
  })
  it('carry the spec colours and the field layout', () => {
    expect(LAVA_FRAG).toMatch(/texture\(uPalette/)
    expect(LAVA_FRAG).toContain('52.0, 40.0, 34.0')
    expect(FIELD_FRAG).toMatch(/across.*along/s)
  })
})
