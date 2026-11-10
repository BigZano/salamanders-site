import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { SIM_VERT, SIM_FRAG, SIM_UNIFORMS } from './lavaSim.glsl'

// The module's own source, for the header comment, which is not in SIM_FRAG.
const SIM_GLSL_SOURCE = readFileSync(new URL('./lavaSim.glsl.js', import.meta.url), 'utf8')

const balanced = (s) => (s.match(/\{/g) || []).length === (s.match(/\}/g) || []).length
// Whole words only, and not in comments: a plain substring count passes vacuously for names that only
// appear inside a longer name or a comment. One match is the declaration, so a second is a use.
const uses = (src, name) => (src.replace(/\/\/.*$/gm, '').match(new RegExp(`\\b${name}\\b`, 'g')) || []).length

describe('the sim shaders', () => {
  it('are GLSL ES 3.00, balanced, under 180 lines', () => {
    for (const s of [SIM_VERT, SIM_FRAG]) {
      expect(s.trimStart().startsWith('#version 300 es')).toBe(true)
      expect(balanced(s)).toBe(true)
      expect(s.split('\n').length).toBeLessThan(180)
    }
  })
  it('declare and use every sim uniform', () => {
    expect(SIM_UNIFORMS).toHaveLength(15)
    expect(SIM_UNIFORMS.slice(-3)).toEqual(['uDrain', 'uDrainAt', 'uVentHeat'])
    for (const u of SIM_UNIFORMS) {
      expect(SIM_FRAG).toMatch(new RegExp(`uniform\\s+\\w+\\s+${u}\\b`))
      expect(uses(SIM_FRAG, u)).toBeGreaterThanOrEqual(2)
    }
  })
  it('names the constants with the spec values, and a crust step clears one 8-bit level', () => {
    // The spec's first cut, as tuned in Task 7a against the sim harness (heat-sim spec section 10.1 has each built value and why).
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
  it('keeps a block no channel uses empty, but not the pool block, which is also under -1.5', () => {
    const code = SIM_FRAG.replace(/\/\/.*$/gm, '')
    expect(code).toMatch(/if \(!pool && uParent\[id\] < -1\.5\) \{\s*fragColor = vec4\(0\.0\);\s*return;/)
  })
  it('declares uDrain[12], uDrainAt[12] and uVentHeat[12], and documents the two meanings of uDrainAt', () => {
    expect(SIM_FRAG).toMatch(/uniform float uDrain\[12\];/)
    expect(SIM_FRAG).toMatch(/uniform float uDrainAt\[12\];/)
    expect(SIM_FRAG).toMatch(/uniform float uVentHeat\[12\];/)
    expect(SIM_FRAG).toMatch(/uDrainAt\[12\];[^\n]*entry across the arc, -1\.\.1/)
    expect(SIM_GLSL_SOURCE).toMatch(/ENTRY POSITION across the pool's arc, -1\.\.1, 0 under the trunk's end/)
  })
  it('holds a vent row at uSource times its own uVentHeat, with the flicker and a surge that still reaches the top', () => {
    const code = SIM_FRAG.replace(/\/\/.*$/gm, '')
    expect(code).toMatch(/float vent = uSource \* uVentHeat\[id\] \* \(1\.0 - FLICKER \+ FLICKER \* hash\(/)
    expect(code).toMatch(/up = vec4\(uSource \* uVentHeat\[id\], 0\.0, 0\.0, 0\.0\)/)
    expect(code).toMatch(/heat = vent \+ surgeActive \* surgeActive \* \(3\.0 - 2\.0 \* surgeActive\) \* max\(0\.0, 1\.0 - vent\);/)
    // The vent is read for a vent-fed block only: an arm's block never reaches the vent row.
    expect(code).toMatch(/if \(sheet && along < SRC_ROW\)/)
  })
  it('tests the pool flag (uParent == POOL, -3.0) before the sheet test, so the pool is never a sheet', () => {
    const code = SIM_FRAG.replace(/\/\/.*$/gm, '')
    expect(code).toMatch(/const float POOL = -3\.0;/)
    const pool = code.indexOf('bool pool = abs(uParent[id] - POOL) < 0.5;')
    const sheet = code.indexOf('bool sheet = !pool && uParent[id] < 0.0;')
    expect(pool).toBeGreaterThan(0)
    expect(sheet).toBeGreaterThan(pool)
    // The unused-block test comes after the pool test too: -3 is below its -1.5.
    expect(code.indexOf('if (!pool && uParent[id] < -1.5)')).toBeGreaterThan(pool)
  })
  it('runs the drain read over all 12 slots, so two feeders at one cell both apply', () => {
    const code = SIM_FRAG.replace(/\/\/.*$/gm, '')
    expect(code.match(/for \(int k = 0; k < 12; k\+\+\)/g)).toHaveLength(1)
    // A channel cell takes the highest toe among the feeders that join within a cell of it: max over the loop,
    // not the first found.
    expect(code).toMatch(/join = max\(join, toe\(k\)\);/)
    expect(code).toMatch(/abs\(x - uDrainAt\[k\] \* \(uSimSize\.x - 1\.0\)\) <= 1\.0/)
  })
  it('gives each pool feeder a Gaussian fan around its entry, the hottest taken, cold between and with none', () => {
    const code = SIM_FRAG.replace(/\/\/.*$/gm, '')
    expect(code).toMatch(/const float FAN = 0\.35;/)
    expect(code).toMatch(/float g = \(across - uDrainAt\[k\]\) \/ FAN;/)
    expect(code).toMatch(/fan = max\(fan, toe\(k\) \* exp\(-g \* g\)\);/)
    expect(code).toMatch(/return vec2\(join, fan\);/)
    // pow() of a negative base is undefined in GLSL: the square is taken by hand.
    expect(code).not.toMatch(/pow\(\(across/)
    // Mirror of the loop: a toe at its entry gives the whole toe, 0.35 off gives 1/e of it, 1 off gives nearly nothing.
    const fan = (across, feeders) => feeders.reduce((m, [toe, entry]) => Math.max(m, toe * Math.exp(-(((across - entry) / 0.35) ** 2))), 0)
    const feeders = [[0.7, 0], [0.68, -0.6]]
    expect(fan(0, feeders)).toBeCloseTo(0.7, 2)
    expect(fan(-0.6, feeders)).toBeCloseTo(0.68, 2)
    expect(fan(0.35, [[0.7, 0]])).toBeCloseTo(0.7 / Math.E, 5)
    expect(fan(1, [[0.7, 0]])).toBeLessThan(0.001)
    expect(fan(0.5, [])).toBe(0)
  })
  it('reads a toe as the last cell of the channel on its centre rows', () => {
    const code = SIM_FRAG.replace(/\/\/.*$/gm, '')
    expect(code).toMatch(/cell\(k, uSimSize\.x - 1\.0, \(uSimSize\.y - 1\.0\) \* 0\.5\)\.r/)
  })
  it('puts the drain after the advect and the source and before the cooling, so the melt step sees the raised heat', () => {
    const code = SIM_FRAG.replace(/\/\/.*$/gm, '')
    const at = (re) => code.search(re)
    const advect = at(/float heat = up\.r;/)
    const drain = at(/heat = max\(heat, fed\.x\);/)
    const cool = at(/float cool = uDt \* COOL0/)
    const melt = at(/if \(heat > T_MELT\)/)
    expect(advect).toBeGreaterThan(0)
    expect(drain).toBeGreaterThan(advect)
    expect(cool).toBeGreaterThan(drain)
    expect(melt).toBeGreaterThan(cool)
  })
  it('gives the pool a source row of the feeders\' entry fans, no breakouts, no surge, and an outward drift', () => {
    const code = SIM_FRAG.replace(/\/\/.*$/gm, '')
    // 1.2, not the 0.6 first tried: at 0.6 the front stalled at 0.69 of the radius on the GPU harness (network spec 13.4).
    expect(code).toMatch(/const float POOL_SPEED = 1\.2 \* SPEED0;/)
    expect(code).toMatch(/const float POOL_COOL = 2\.0;/)
    // The pool cools POOL_COOL times as fast along its radius; no other block does.
    expect(code).toMatch(/\(COOL_HEAD \+ COOL_TOE \* along\) \* \(pool \? POOL_COOL : 1\.0\)/)
    expect(code).toMatch(/pool \? POOL_SPEED : velocity\(across, along\) \* SPEED0/)
    expect(code).toMatch(/float sg = pool \? -1\.0 : uSurge\[id\];/)
    expect(code).toMatch(/if \(pool && along < SRC_ROW\) \{ heat = fed\.y; crust = 0\.0; \}/)
    // Step 5 is skipped for the pool.
    expect(code).toMatch(/if \(!pool\) \{[^}]*press \+= uDt \* K_P/)
    // The sheet's own vent row is not the pool's: the sheet test excludes it.
    expect(code).toMatch(/if \(sheet && along < SRC_ROW\)/)
  })
  it('still feeds the sheet from the vent and an arm from its parent', () => {
    const code = SIM_FRAG.replace(/\/\/.*$/gm, '')
    expect(code).toMatch(/if \(ua < 0\.0 && sheet\) up = vec4\(uSource/)
    expect(code).toMatch(/bool arm = ua < 0\.0 && !sheet && !pool;/)
  })
})
