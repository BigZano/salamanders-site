import { describe, it, expect } from 'vitest'
import { FIELD_VERT, FIELD_FRAG, LAVA_VERT, LAVA_FRAG, UNIFORMS } from './lavaShader.glsl'

const balanced = (s) => (s.match(/\{/g) || []).length === (s.match(/\}/g) || []).length
const noComments = (s) => s.replace(/\/\/.*$/gm, '')
// GLSL's smoothstep, as every GPU runs it: reversed edges give the falling ramp (the caps use it too).
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const levee = (source) => Number(/const\s+float\s+LEVEE\s*=\s*([\d.]+)\s*;/.exec(source)?.[1])

describe('the GLSL sources', () => {
  it('are GLSL ES 3.00 with balanced braces', () => {
    for (const s of [FIELD_VERT, FIELD_FRAG, LAVA_VERT, LAVA_FRAG]) {
      expect(s.trimStart().startsWith('#version 300 es')).toBe(true)
      expect(balanced(s)).toBe(true)
    }
  })
  it('declare every uniform the layer sets, and the lava fragment uses each', () => {
    expect(UNIFORMS).toHaveLength(17)
    for (const u of ['uSim', 'uPalette', 'uSimSize', 'uPoolId', 'uPlateH']) expect(UNIFORMS).toContain(u)
    for (const u of ['uCrust', 'uBreakoutRate', 'uTime', 'uPhase', 'uSurge', 'uHeat', 'uHeatPer']) expect(UNIFORMS).not.toContain(u)
    // Whole words only, and not in comments: a plain substring count passes vacuously for uCalm (inside uCalmCount).
    // One match is the declaration, so a second is a use.
    const code = noComments(LAVA_FRAG + LAVA_VERT)
    const uses = (u) => (code.match(new RegExp(`\\b${u}\\b`, 'g')) || []).length
    for (const u of UNIFORMS) {
      expect(LAVA_VERT + LAVA_FRAG).toMatch(new RegExp(`uniform\\s+\\w+\\s+${u}\\b`))
      expect(uses(u)).toBeGreaterThanOrEqual(2)
    }
  })
  it('count heat once, in the sim: no uHeat, no uHeatPer, and no per-channel factor on the heat', () => {
    for (const s of [FIELD_VERT, FIELD_FRAG, LAVA_VERT, LAVA_FRAG]) expect(noComments(s)).not.toMatch(/\buHeat(Per)?\b/)
    expect(LAVA_FRAG).toMatch(/float T = clamp\(\(heat \* mix\(/)
  })
  it('scale every glow term by the page density, so a dim page is dim throughout', () => {
    expect(LAVA_FRAG).toMatch(/0\.18 \* shear \+ 0\.08 \* pl\.y\) \* uDensity/)
    expect(LAVA_FRAG).toMatch(/\* uDensity \* ORANGE_GLOW/)
  })
  it('leave a strip end the caps hide to the channel under it, with the lava pass own cap sums', () => {
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
    for (const name of ['SPEED', 'CYCLE', 'WARP', 'WARP_FREQ', 'CELL', 'FOLD_PX', 'MARGIN', 'SOFT', 'NET_CELL', 'NET_HEAT', 'SEAM', 'DEEP', 'DEEP_POOL', 'HOT', 'BANK_PX', 'LEVEE']) {
      expect(LAVA_FRAG).toMatch(new RegExp(`const\\s+\\w+\\s+${name}\\s*=`))
    }
  })
  it('carry the spec colours and the field layout', () => {
    expect(LAVA_FRAG).toMatch(/texture\(uPalette/)
    expect(LAVA_FRAG).toContain('52.0, 40.0, 34.0')
    expect(FIELD_FRAG).toMatch(/across.*along/s)
  })
})

describe('the levee and the bank', () => {
  it('reach 1.25 half widths in both fragments, as the strip builder ring does, and the RGBA8 packing uses the same range', () => {
    expect(levee(FIELD_FRAG)).toBe(1.25)
    expect(levee(LAVA_FRAG)).toBe(1.25)
    // The field packs across / LEVEE and the lava pass unpacks * LEVEE: the same constant, so a ring vertex round-trips.
    expect(FIELD_FRAG).toContain('(across / LEVEE) * 0.5 + 0.5')
    expect(LAVA_FRAG).toContain('(f.r * 2.0 - 1.0) * LEVEE')
    for (const across of [-1.25, -1, 0, 0.3, 1, 1.25]) {
      const byte = Math.round(((across / levee(FIELD_FRAG)) * 0.5 + 0.5) * 255)
      expect((byte / 255 * 2 - 1) * levee(LAVA_FRAG)).toBeCloseTo(across, 1)
    }
    expect(FIELD_FRAG + LAVA_FRAG).not.toContain('2.2')
  })
  it('paint no rubble: the bank is the crusted outer rows of the sim', () => {
    expect(LAVA_FRAG).not.toContain('RUBBLE * rub')
    expect(noComments(LAVA_FRAG)).not.toMatch(/\brub\b|\brubble\b/)
    // The skin still takes the grey plate colour from the constant.
    expect(LAVA_FRAG).toContain('RUBBLE * 1.4 + col * 0.12')
  })
  it('make the fragment transparent past the bank, except the feather on alpha', () => {
    const feather = 'smoothstep(1.0 + BANK_PX / hw, 1.0 - BANK_PX / hw, a)'
    expect(LAVA_FRAG).toContain(feather)
    const alpha = /float alpha = ([^;]+);/.exec(LAVA_FRAG)[1]
    expect(alpha).toContain(feather)
    // The rubble fade to LEVEE is gone with the rubble.
    expect(alpha).not.toContain('smoothstep(1.2, LEVEE, a)')
    expect(noComments(LAVA_FRAG)).not.toMatch(/mix\(col, rubble/)
    // Evaluate the line itself: calm 1, caps 1, a 20 px channel (hw 10) with a 1 px feather: 0.1 of a half width each side of the bank.
    const f = new Function('calm', 'clamp', 'smoothstep', 'vPx', 'BANK_PX', 'LEVEE', 'hw', 'a', 'caps', `return ${alpha}`)
    const at = (a, hw = 10) => f(() => 1, clamp, smoothstep, null, 1, 1.25, hw, a, 1)
    expect(at(0)).toBe(1)
    expect(at(0.85)).toBe(1) // 1 - BANK_PX / hw = 0.9: inside it the bank is solid
    expect(at(1)).toBeCloseTo(0.5, 5) // the bank itself is the middle of the feather
    expect(at(1.1)).toBe(0) // 1 + BANK_PX / hw: past it nothing is drawn
    expect(at(1.2)).toBe(0)
    expect(at(1.25)).toBe(0)
    // A narrow channel (hw 2): the feather is wider in across units, and the field end still cuts it at LEVEE.
    expect(at(1.4, 2)).toBe(0)
    expect(at(1.2, 2)).toBeGreaterThan(0)
    expect(at(1.2, 2)).toBeLessThan(at(1.0, 2))
  })
})

describe('the pool', () => {
  it('takes its channel id from uPoolId in both passes (-1 when there is none)', () => {
    expect(FIELD_FRAG).toMatch(/uniform float uPoolId;/)
    expect(LAVA_FRAG).toMatch(/uniform float uPoolId;/)
    expect(LAVA_FRAG).toContain('bool pool = float(id) == uPoolId;')
  })
  it('has its own open-core depth, DEEP_POOL 0.75, in place of DEEP, and skips the shear term', () => {
    expect(LAVA_FRAG).toMatch(/const\s+float\s+DEEP_POOL\s*=\s*0\.75\s*;/)
    expect(LAVA_FRAG).toContain('mix(pool ? DEEP_POOL : DEEP, 1.0, open)')
    expect(LAVA_FRAG).toMatch(/float shear = pool \? 0\.0 : smoothstep\(MARGIN\.x, MARGIN\.y, a\);/)
  })
  it('is exempt from the start cap in both passes, so the two still agree on every pixel', () => {
    expect(FIELD_FRAG).toMatch(/h = id < 0\.5 \|\| id == uPoolId \? 0\.0 : max\(0\.0, \(0\.1 - along\) \* 10\.0\)/)
    expect(LAVA_FRAG).toMatch(/h = id == 0 \|\| pool \? 0\.0 : max\(0\.0, \(0\.1 - along\) \* 10\.0\)/)
  })
})

describe('the plates', () => {
  it('scale with the flows own box (uPlateH), not the bounds quad the pool now enlarges', () => {
    expect(LAVA_FRAG).toContain('float scale = max(uPlateH, 200.0) / 600.0;')
    expect(noComments(LAVA_FRAG)).not.toMatch(/uBounds/)
    expect(noComments(LAVA_VERT)).toMatch(/uBounds/)
  })
})
