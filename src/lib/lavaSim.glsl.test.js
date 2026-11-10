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
    // The spec's first cut, as tuned in Task 7a against the sim harness (task-7a-report.md has the before and after).
    const want = {
      T_CRUST: '0.42', T_MELT: '0.55', K_CRUST: '5.0', K_MELT: '2.5', K_P: '0.8', P_BREAK: '0.6', SPEED0: '0.28', SRC_ROW: '0.03',
      FLICKER: '0.15', SURGE_V: '1.6', COOL0: '0.02', COOL_CORE: '0.3', COOL_BANK: '4.0', COOL_HEAD: '0.3', COOL_TOE: '3.0',
      CRUST_DAMP: '0.6', LICK: '0.12', Q: '1.0 / 255.0',
    }
    for (const [k, v] of Object.entries(want)) expect(SIM_FRAG).toMatch(new RegExp(`const float ${k} = ${v.replace(/\./g, '\\.')};`))
    expect(Number(want.K_CRUST) * (1 / 30) * Number(want.T_CRUST)).toBeGreaterThan(1 / 255)
    for (const k of ['COOL_CORE', 'COOL_BANK', 'COOL_HEAD', 'COOL_TOE', 'CRUST_DAMP', 'LICK']) expect(uses(SIM_FRAG, k)).toBeGreaterThanOrEqual(2)
  })
  it('lets a surge only raise the vent, up to the palette top, however hot the source', () => {
    const code = SIM_FRAG.replace(/\/\/.*$/gm, '')
    // The gap to the top is guarded: unguarded, a source past 1 (a page's flare) made the spike negative.
    expect(code).toMatch(/max\(0\.0, 1\.0 - vent\)/)
    expect(code).not.toMatch(/\(1\.0 - uSource\)/)
    // Mirror of the vent row's formula: at the surge's start the vent reaches 1 for any source, and never drops.
    const ease = (s) => s * s * (3 - 2 * s)
    const heat = (vent, s) => Math.min(1, vent + ease(s) * Math.max(0, 1 - vent))
    for (const vent of [0.5, 0.9, 1.2, 1.8]) {
      expect(heat(vent, 1)).toBe(1)
      for (const s of [0, 0.25, 0.5, 0.75, 1]) expect(heat(vent, s)).toBeGreaterThanOrEqual(Math.min(1, vent))
    }
  })
  it('keeps a block no channel uses empty, and still feeds the sheet from the vent', () => {
    const code = SIM_FRAG.replace(/\/\/.*$/gm, '')
    expect(code).toMatch(/if \(uParent\[id\] < -1\.5\) \{\s*fragColor = vec4\(0\.0\);\s*return;/)
    expect(code).toMatch(/bool sheet = uParent\[id\] < 0\.0;/)
  })
})
