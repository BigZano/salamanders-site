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
    for (const u of UNIFORMS) {
      expect(LAVA_VERT + LAVA_FRAG).toMatch(new RegExp(`uniform\\s+\\w+\\s+${u}\\b`))
      // Whole words only, and not in comments: a plain substring count passes vacuously for uHeat
      // (inside uHeatPer) and uCalm (inside uCalmCount). One match is the declaration, so a second is a use.
      const code = (LAVA_FRAG + LAVA_VERT).replace(/\/\/.*$/gm, '')
      expect((code.match(new RegExp(`\\b${u}\\b`, 'g')) || []).length).toBeGreaterThanOrEqual(2)
    }
  })
  it('keep each shader under 160 lines', () => {
    for (const s of [FIELD_VERT, FIELD_FRAG, LAVA_VERT, LAVA_FRAG]) {
      expect(s.trimEnd().split('\n').length).toBeLessThan(160)
    }
  })
  it('name the look constants so they can be tuned in one place', () => {
    for (const name of ['SPEED', 'GAIN', 'WARP', 'WARP_FREQ', 'CELL', 'FOLD_PX', 'MARGIN', 'CRACK_PX', 'PERIOD']) {
      expect(LAVA_FRAG).toMatch(new RegExp(`const\\s+\\w+\\s+${name}\\s*=`))
    }
  })
  it('carry the spec colours and the field layout', () => {
    expect(LAVA_FRAG).toContain('12.0, 6.0, 4.0')
    expect(LAVA_FRAG).toContain('255.0, 220.0, 150.0')
    expect(LAVA_FRAG).toContain('52.0, 40.0, 34.0')
    expect(FIELD_FRAG).toMatch(/across.*along/s)
  })
})
