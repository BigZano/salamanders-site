import { describe, it, expect } from 'vitest'
import { SIM_VERT, SIM_FRAG, SIM_UNIFORMS } from './lavaSim.glsl'

const balanced = (s) => (s.match(/\{/g) || []).length === (s.match(/\}/g) || []).length
// Whole words only, and not in comments: a plain substring count passes vacuously for names that only
// appear inside a longer name or a comment. One match is the declaration, so a second is a use.
const uses = (src, name) => (src.replace(/\/\/.*$/gm, '').match(new RegExp(`\\b${name}\\b`, 'g')) || []).length

describe('the sim shaders', () => {
  it('are GLSL ES 3.00, balanced, under 160 lines', () => {
    for (const s of [SIM_VERT, SIM_FRAG]) {
      expect(s.trimStart().startsWith('#version 300 es')).toBe(true)
      expect(balanced(s)).toBe(true)
      expect(s.split('\n').length).toBeLessThan(160)
    }
  })
  it('declare and use every sim uniform', () => {
    expect(SIM_UNIFORMS).toHaveLength(12)
    for (const u of SIM_UNIFORMS) {
      expect(SIM_FRAG).toMatch(new RegExp(`uniform\\s+\\w+\\s+${u}\\b`))
      expect(uses(SIM_FRAG, u)).toBeGreaterThanOrEqual(2)
    }
  })
  it('names the constants with the spec values, and a crust step clears one 8-bit level', () => {
    const want = { T_CRUST: 0.35, T_MELT: 0.55, K_CRUST: 1.2, K_MELT: 2.5, K_P: 0.8, P_BREAK: 0.6, SPEED0: 0.06, SRC_ROW: 0.03, FLICKER: 0.15, SURGE_V: 1.6, COOL0: 0.012 }
    for (const [k, v] of Object.entries(want)) expect(SIM_FRAG).toMatch(new RegExp(`const float ${k} = ${v}`))
    expect(want.K_CRUST * (1 / 30) * want.T_CRUST).toBeGreaterThan(1 / 255)
  })
})
