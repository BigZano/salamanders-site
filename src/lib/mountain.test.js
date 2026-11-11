import { describe, test, expect } from 'vitest'
import { buildMountain, faceFor, mountainForRoute, peakHeight, mulberry32, hashString } from './mountain'
import { fireTuning, profileFor, DEFAULTS, RANDOMIZE_DEFAULTS } from './fireTuning'
import home from './__fixtures__/mountain-home-1600x1000.json'
import planner from './__fixtures__/mountain-planner-390x844.json'

// The fixtures were captured by running MountDeathfire.vue's own functions, before they moved here, with the inputs
// recorded under "input" (the tuning, the randomize switches and the route's profile as they were then). They hold the
// mountain, the face and the next three draws of the seeded stream after buildMountain.
const fixtures = [
  ['home at 1600x1000', home],
  ['planner at 390x844', planner],
]

describe.each(fixtures)('%s', (_name, fx) => {
  const { path, w, h, tune, randomize, prof } = fx.input

  test('is identical to what the vue built (every number, to the bit)', () => {
    const { mountain } = mountainForRoute({ path, w, h, tune, randomize, prof })
    expect(mountain).toEqual(fx.mountain)
  })

  test('the face is the fixture face and the stream is left where the vue left it', () => {
    const { face, rng } = mountainForRoute({ path, w, h, tune, randomize, prof })
    expect(face).toBe(fx.face)
    expect([rng(), rng(), rng()]).toEqual(fx.next)
  })

  test('with the profile read from the live store it is the same mountain (the store is at its defaults)', () => {
    const { mountain } = mountainForRoute({ path, w, h, tune: fireTuning.bed, randomize: RANDOMIZE_DEFAULTS })
    expect(profileFor(path)).toEqual(prof)
    expect(mountain).toEqual(fx.mountain)
  })

  test('faceFor then buildMountain is mountainForRoute taken apart', () => {
    const { face, rng } = faceFor({ path, tune, prof, randomize })
    const mountain = buildMountain({ w, h, face, prof, tune, rng, path, randomize })
    expect(mountain).toEqual(fx.mountain)
    expect([rng(), rng(), rng()]).toEqual(fx.next)
  })
})

describe('peakHeight', () => {
  test('caps at 0.7 h and floors at 40', () => {
    expect(peakHeight(100, 1, 690)).toBe(69) // 690 * 100 / 1000 = 69, under the cap of 70
    expect(peakHeight(100, 2, 690)).toBe(70) // 138 wanted, capped at 0.7 h
    expect(peakHeight(10, 1, 690)).toBe(40) // 6.9 wanted, floored
  })

  test('is the tuned height times the profile scale times h over 1000', () => {
    expect(peakHeight(1000, 1, 690)).toBe(690)
    expect(peakHeight(1000, 0.5, 690)).toBe(345)
    expect(peakHeight(1000, 1, 400)).toBe(400)
    expect(peakHeight(844, 0.4, 690)).toBe(690 * 0.4 * (844 / 1000))
  })

  test('the tuned height defaults to the baked hero', () => {
    expect(peakHeight(1000, 1)).toBe(DEFAULTS.bed.height)
  })

  test('non-finite input collapses to the floor and never propagates', () => {
    expect(peakHeight(1000, 1, NaN)).toBe(40)
    expect(peakHeight(1000, NaN, 690)).toBe(40)
    expect(peakHeight(1000, 1, Infinity)).toBe(40)
  })
})

describe('faceFor', () => {
  const prof = (bearing, variance = 1) => ({ bearing, scale: 1, variance, density: 1 })

  test('clamps to 0.1..0.9', () => {
    const high = faceFor({ path: '/companies', tune: { ...fireTuning.bed, offsetX: 0.9, faceSpread: 0.3 }, prof: profileFor('/companies'), randomize: RANDOMIZE_DEFAULTS })
    expect(high.face).toBe(0.9)
    const low = faceFor({ path: '/x', tune: { ...fireTuning.bed, offsetX: 0, faceSpread: 0 }, prof: prof(-0.5), randomize: RANDOMIZE_DEFAULTS })
    expect(low.face).toBe(0.1)
  })

  test('is the offset plus the bearing when the wander is switched off, and the stream still spends the wander draw', () => {
    const tune = { ...fireTuning.bed, offsetX: 0.3, faceSpread: 0.16 }
    const off = faceFor({ path: '/roster', tune, prof: prof(0.2), randomize: { ...RANDOMIZE_DEFAULTS, offsetX: false } })
    const on = faceFor({ path: '/roster', tune, prof: prof(0.2), randomize: RANDOMIZE_DEFAULTS })
    expect(off.face).toBe(0.3 + 0.2)
    expect(on.face).not.toBe(off.face)
    expect(Math.abs(on.face - off.face)).toBeLessThanOrEqual(0.16)
    expect(off.rng()).toBe(on.rng())
  })

  test('is deterministic per path and the path decides the stream', () => {
    const args = { tune: fireTuning.bed, prof: prof(0), randomize: RANDOMIZE_DEFAULTS }
    const a = faceFor({ path: '/builds', ...args })
    const b = faceFor({ path: '/builds', ...args })
    const c = faceFor({ path: '/armoury', ...args })
    expect(a.face).toBe(b.face)
    expect(a.rng()).toBe(b.rng())
    expect(c.face).not.toBe(a.face)
  })

  test('the stream is the path-seeded one, one draw (the wander) in', () => {
    const fresh = mulberry32(hashString('/builds') ^ 0x5a1a)
    fresh()
    const { rng } = faceFor({ path: '/builds', tune: fireTuning.bed, prof: prof(0), randomize: RANDOMIZE_DEFAULTS })
    expect(rng()).toBe(fresh())
  })

  test('an empty path is the hero path', () => {
    const args = { tune: fireTuning.bed, prof: prof(0), randomize: RANDOMIZE_DEFAULTS }
    expect(faceFor({ path: '', ...args }).face).toBe(faceFor({ path: '/', ...args }).face)
    expect(faceFor({ ...args }).face).toBe(faceFor({ path: '/', ...args }).face)
  })
})

describe('mountainForRoute', () => {
  const run = () => mountainForRoute({ path: '/', w: 1600, h: 1000, tune: fireTuning.bed, randomize: RANDOMIZE_DEFAULTS })

  test('the rng it returns continues the same stream', () => {
    const a = run().rng()
    const b = run().rng()
    expect(a).toBe(b)
  })

  test('the stream sits 1 draw (the wander) plus 59 draws (4 cone, 1 rim, 27 per flank) in, and a symmetric cone draws none', () => {
    const { rng } = run()
    const ref = mulberry32(hashString('/') ^ 0x5a1a)
    for (let i = 0; i < 1 + 59; i++) ref()
    expect(rng()).toBe(ref())

    const sym = { ...RANDOMIZE_DEFAULTS, asymmetry: false }
    const flat = mountainForRoute({ path: '/', w: 1600, h: 1000, tune: fireTuning.bed, randomize: sym })
    const ref2 = mulberry32(hashString('/') ^ 0x5a1a)
    ref2()
    expect(flat.rng()).toBe(ref2())
  })

  test('the path shapes the crown and the terraces: two routes at one viewport are two mountains', () => {
    const a = mountainForRoute({ path: '/', w: 1600, h: 1000, tune: fireTuning.bed, randomize: RANDOMIZE_DEFAULTS }).mountain
    const b = mountainForRoute({ path: '/roster', w: 1600, h: 1000, tune: fireTuning.bed, randomize: RANDOMIZE_DEFAULTS }).mountain
    expect(a.crown).not.toEqual(b.crown)
    expect(a.peakX).not.toBe(b.peakX)
  })

  test('returns the fields the page and the lava network read, and nothing else', () => {
    expect(Object.keys(run().mountain).sort()).toEqual(
      ['craterHalf', 'crown', 'left', 'litL', 'litR', 'mouthL', 'mouthR', 'peakX', 'peakY', 'right', 'rimL', 'rimR', 'valley', 'valleyDepth', 'vent'].sort(),
    )
  })
})
