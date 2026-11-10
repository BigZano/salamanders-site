import { describe, it, expect } from 'vitest'
import { deflateSync, crc32 } from 'node:zlib'
import {
  findChrome,
  plan,
  probe,
  probeRects,
  judge,
  judgeIgnition,
  judgeJunction,
  judgePool,
  judgeToes,
  judgeCta,
  ctaRatio,
  ctaMeanRatio,
  faceTiles,
  junctionMeans,
  contrastRatio,
  parseCssColor,
  decodePng,
  parseArgs,
  lavaWanted,
  burnFrames,
  BURN_CAP,
  EMBER_RED,
  TOE_RED,
  chromeArgs,
  lowerPriorityCommand,
} from './lib/forge-render.mjs'

describe('findChrome', () => {
  it('prefers CHROME, then the known installs', () => {
    expect(findChrome({ CHROME: 'x' }, () => true)).toBe('x')
    expect(findChrome({}, (p) => p.includes('Program Files\\Google'))).toMatch(/chrome\.exe$/)
    expect(findChrome({}, () => false)).toBeNull()
  })
})

describe('plan', () => {
  it('is the product of paths, sizes, phases and presets with stable names', () => {
    const p = plan({ paths: ['/'], sizes: ['phone', 'desktop'], phases: [0.42], presets: ['crust=0.3'] })
    expect(p).toHaveLength(2)
    expect(p[0]).toMatchObject({ name: 'home-phone-p0.42-crust0.3', width: 390, height: 844, mobile: true, deviceScaleFactor: 2 })
    // pictured at 120 s: opened 24 s early and burned 720 frozen frames to get there, so the sim is not cold
    expect(p[0]).toMatchObject({ at: 120, burn: 720, kind: 'grid' })
    expect(p[0].url).toBe('/?moon=0.42&t=96&calm=0&lava=1&crust=0.3')
  })

  it('carries each entry\'s path, so a probe that only the home page has can tell where it is', () => {
    const p = plan({ paths: ['/', '/armoury'], sizes: ['phone'], phases: [0.42], presets: [null], smoke: true })
    expect(p.map((e) => e.path)).toEqual(['/', '/', '/armoury', '/armoury'])
  })

  it('burns min(t * 30, the cap) frames, the still frame\'s 720 at most', () => {
    expect(BURN_CAP).toBe(720)
    expect(burnFrames(2)).toBe(60)
    expect(burnFrames(120)).toBe(720)
    expect(burnFrames(0)).toBe(0)
  })

  it('puts an ignition entry first for each path and size with --smoke: two seconds from a cold load', () => {
    const p = plan({ paths: ['/'], sizes: ['phone', 'desktop'], phases: [0.1, 0.7], presets: [null, 'crust=1'], smoke: true })
    expect(p.map((e) => e.name)).toEqual([
      'home-phone-ignite',
      'home-phone-p0.1',
      'home-phone-p0.1-crust1',
      'home-phone-p0.7',
      'home-phone-p0.7-crust1',
      'home-desktop-ignite',
      'home-desktop-p0.1',
      'home-desktop-p0.1-crust1',
      'home-desktop-p0.7',
      'home-desktop-p0.7-crust1',
    ])
    expect(p[0]).toMatchObject({ kind: 'ignite', at: 2, burn: 60, url: '/?moon=0.1&t=0&calm=0&lava=1' })
    expect(plan({ paths: ['/'], sizes: ['phone'], phases: [0.42], presets: [null] }).some((e) => e.kind === 'ignite')).toBe(false)
  })

  it('names other pages by their path, drops the suffix for no preset, and knows the three sizes', () => {
    const p = plan({ paths: ['/armoury'], sizes: ['tablet', 'desktop'], phases: [0.1, 0.7], presets: [null] })
    expect(p.map((e) => e.name)).toEqual([
      'armoury-tablet-p0.1',
      'armoury-tablet-p0.7',
      'armoury-desktop-p0.1',
      'armoury-desktop-p0.7',
    ])
    expect(p[0]).toMatchObject({ width: 768, height: 1024, mobile: true, deviceScaleFactor: 2 })
    expect(p[2]).toMatchObject({ width: 1600, height: 1000, mobile: false, deviceScaleFactor: 1 })
    expect(p[0].url).toBe('/armoury?moon=0.1&t=96&calm=0&lava=1')
  })

  it('refuses a size it does not know', () => {
    expect(() => plan({ paths: ['/'], sizes: ['watch'], phases: [0.42], presets: [null] })).toThrow(/watch/)
  })
})

describe('probe', () => {
  it('reports the mean colour and whether anything is bright in a rect', () => {
    const w = 4,
      h = 1
    const px = new Uint8Array([0, 0, 0, 255, 255, 220, 150, 255, 0, 0, 0, 255, 0, 0, 0, 255])
    expect(probe(px, w, h, { x: 0, y: 0, w: 2, h: 1 })).toEqual({ mean: [127.5, 110, 75], max: 255, bright: true })
    expect(probe(px, w, h, { x: 2, y: 0, w: 2, h: 1 }).bright).toBe(false)
  })

  it('clips a rect that runs off the buffer and reports an empty one as black', () => {
    const px = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255])
    expect(probe(px, 2, 1, { x: 1, y: 0, w: 5, h: 5 })).toEqual({ mean: [40, 50, 60], max: 60, bright: false })
    expect(probe(px, 2, 1, { x: 5, y: 5, w: 2, h: 2 })).toEqual({ mean: [0, 0, 0], max: 0, bright: false })
  })
})

describe('probeRects', () => {
  // a sheet running straight down from the vent, an arm continuing it and bending right
  const geometry = {
    vent: { x: 100, y: 50 },
    flows: [
      { head: true, widthAt0: 20, widthMid: 24, pts: [0, 1, 2, 3, 4].map((i) => ({ x: 100, y: 50 + i * 20 })) },
      { head: false, widthAt0: 16, pts: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ x: 100 + i * 5, y: 130 + i * 20 })) },
    ],
  }

  it('puts the head under the vent, the toe 90 percent down the sheet, and the levee beside the sheet middle', () => {
    const r = probeRects(geometry)
    expect(r.head).toEqual({ x: 88, y: 50, w: 24, h: 24 })
    // the ignition probe: near the sheet's far end, which the front has not reached two seconds in (and short of the pool's
    // glow). The sheet's five points are y 50 to 130; 0.9 of the way is the fourth, y = 110
    expect(r.toe).toEqual({ x: 88, y: 98, w: 24, h: 24 })
    // the sheet's middle is (100, 90) and its half width 12: 1.1 half widths to the left, a 4 px box about that: inside the
    // levee ring's feather (the shader is clear past 1 + BANK_PX / hw), outside the core
    expect(r.levee.x + r.levee.w / 2).toBeCloseTo(100 - 1.1 * 12, 5)
    expect(r.levee.y + r.levee.h / 2).toBeCloseTo(90, 5)
    expect(r.toeWide).toBeUndefined()
  })

  it('puts the toe on a point of the sheet that is on the screen, a phone\'s trunk running off its edge', () => {
    // a screen 100 high with a 24 px box leaves points down to y = 88: the third, (100, 90), is just over, so the second
    expect(probeRects(geometry, { width: 400, height: 100 }).toe).toEqual({ x: 88, y: 58, w: 24, h: 24 })
    // all of it on the screen: the point 0.9 of the way
    expect(probeRects(geometry, { width: 400, height: 600 }).toe).toEqual({ x: 88, y: 98, w: 24, h: 24 })
    const leaning = { ...geometry, flows: [{ ...geometry.flows[0], pts: [0, 1, 2, 3, 4].map((i) => ({ x: 100 - i * 30, y: 50 + i * 20 })) }, geometry.flows[1]] }
    // x = 100, 70, 40, 10, -20: the box needs x of at least 12, so of the first four (0.9 of the way) the last that fits is (40, 90)
    expect(probeRects(leaning, { width: 400, height: 600 }).toe).toEqual({ x: 28, y: 78, w: 24, h: 24 })
  })

  it('has nothing to probe without a sheet', () => {
    expect(probeRects(null)).toBeNull()
    expect(probeRects({ vent: { x: 1, y: 1 }, flows: [] })).toBeNull()
    expect(probeRects({ vent: { x: 1, y: 1 }, flows: [geometry.flows[1]] })).toBeNull()
    expect(probeRects({ vent: { x: 1, y: 1 }, flows: [geometry.flows[0]] })).not.toBeNull() // a trunk with no tributary is still probed
  })

  it('boxes every channel\'s last 4 px and its middle, 4 x 4, for the toe probe', () => {
    const r = probeRects(geometry)
    // the sheet's middle point is (100, 90); its last is (100, 130), the box centred 2 px back along it
    expect(r.mid0).toEqual({ x: 98, y: 88, w: 4, h: 4 })
    expect(r.end0).toEqual({ x: 98, y: 126, w: 4, h: 4 })
    expect(r.mid1).toEqual({ x: 118, y: 208, w: 4, h: 4 })
    // the arm ends heading (5, 20): 2 px back along that is (144.5, 308.1)
    expect(r.end1).toEqual({ x: 143, y: 306, w: 4, h: 4 })
    expect(Object.keys(r).filter((k) => /^(end|mid)\d+$/.test(k))).toHaveLength(4)
  })

  it('does not ask for a box that is off the screen: a phone\'s trunk ends past its left edge', () => {
    // a screen 300 high holds the sheet (ending at (100, 130)) but not the arm's end at (145, 310), only its middle (120, 210)
    const r = probeRects(geometry, { width: 400, height: 300 })
    expect(r.end0).toBeDefined()
    expect(r.end1).toBeUndefined()
    expect(r.mid1).toBeDefined()
    // a screen 120 wide holds the sheet's x = 100 but not the arm's end at x = 145
    const narrow = probeRects(geometry, { width: 120, height: 600 })
    expect(narrow.end1).toBeUndefined()
    expect(narrow.end0).toBeDefined()
  })

  // a trunk straight down x = 100 (y 0 to 400, 41 points) and a feeder from the upper left to join it at y = 200
  const trunk = { head: true, widthAt0: 20, widthMid: 22, pts: Array.from({ length: 41 }, (_, i) => ({ x: 100, y: i * 10 })) }
  const feeder = (side) => ({
    head: false,
    widthAt0: 8,
    pts: Array.from({ length: 9 }, (_, i) => ({ x: 100 - side * (80 - i * 10), y: 120 + i * 10 })),
  })
  const network = (side = 1) => ({
    vent: { x: 100, y: 0 },
    flows: [trunk, feeder(side)],
    joins: [{ feeder: 1, trunk: 0, at: 0.5, wf: 8, wt: 20, wj: 22, angle: 20 }],
    pool: { cx: 100, cy: 430, rx: 80, ry: 20, arcTop: 410 },
  })

  it('lays six 1 px samples across the trunk\'s inner bank where the feeder\'s centreline crosses it, along the trunk\'s normal', () => {
    // the trunk is wt = 20 wide above the join, so its bank is 10 out; the feeder runs (20, 120) to (100, 200) and is
    // 10 px from the trunk's centreline at (90, 190): there it crosses the bank, and the line runs through it along x
    const left = probeRects(network(1))
    const samples = [0, 1, 2, 3, 4, 5].map((k) => left[`junction${k}`])
    expect(samples.every((s) => s.w === 1 && s.h === 1)).toBe(true)
    expect(samples.map((s) => s.x)).toEqual([92, 91, 90, 89, 88, 87]) // three a side of x = 90, the trunk side first
    expect(samples.map((s) => s.y)).toEqual([190, 190, 190, 190, 190, 190])
    // a feeder from the right crosses the bank on the right
    const right = probeRects(network(-1))
    expect([0, 1, 2, 3, 4, 5].map((k) => right[`junction${k}`].x)).toEqual([107, 108, 109, 110, 111, 112])
  })

  it('still samples a join whose feeder never leaves the trunk\'s bank, from a point on the feeder', () => {
    const close = { ...network(), flows: [trunk, { head: false, pts: [{ x: 97, y: 150 }, { x: 98, y: 175 }, { x: 100, y: 200 }] }] }
    const r = probeRects(close)
    expect(Object.keys(r).filter((k) => /^junction\d+$/.test(k))).toHaveLength(6)
  })

  it('has no junction samples without a join to read, or a feeder that is not there', () => {
    expect(Object.keys(probeRects(geometry)).some((k) => k.startsWith('junction'))).toBe(false)
    const bad = { ...network(), joins: [{ feeder: 7, trunk: 0, at: 0.5, wf: 8, wt: 20, wj: 22 }] }
    expect(Object.keys(probeRects(bad)).some((k) => k.startsWith('junction'))).toBe(false)
  })

  it('boxes the pool\'s arc under the trunk on a desktop, and the bottom 24 px of the page under the pool when it sits below the screen', () => {
    // 24 wide, hanging from the arc's top, 24 tall (or the pool's height when that is less: here ry is 20)
    expect(probeRects(network(), { width: 400, height: 600 }).pool).toEqual({ x: 88, y: 410, w: 24, h: 20 })
    expect(probeRects(network(), { width: 400, height: 600 }).poolEdge).toBeUndefined()
    // the pool's centre (430) is below the screen's bottom (420): a phone. The strip is as wide as the pool is, cx 100 +- rx 80
    const phone = probeRects(network(), { width: 400, height: 420 })
    expect(phone.poolEdge).toEqual({ x: 20, y: 396, w: 160, h: 24 })
    expect(phone.pool).toBeUndefined()
    // a pool centred off the screen's left edge (as a phone's can be) is cut to what is on the screen
    const off = probeRects({ ...network(), pool: { cx: -6, cy: 430, rx: 80, ry: 20, arcTop: 410 } }, { width: 400, height: 420 })
    expect(off.poolEdge).toEqual({ x: 0, y: 396, w: 74, h: 24 })
    // a pool wholly off the screen has nothing to read
    const gone = probeRects({ ...network(), pool: { cx: -200, cy: 430, rx: 80, ry: 20, arcTop: 410 } }, { width: 400, height: 420 })
    expect(gone.poolEdge).toBeUndefined()
    // no view given: read as a desktop
    expect(probeRects(network()).pool).toBeDefined()
    // no pool: neither
    const none = probeRects({ ...network(), pool: null }, { width: 400, height: 600 })
    expect(none.pool ?? none.poolEdge).toBeUndefined()
  })
})

// a probe() result with this mean red (green 0.6 of it), for judges that read the mean
const lit = (r) => ({ mean: [r, r * 0.6, 40], max: Math.min(255, r + 40), bright: r + 40 > 200 })

describe('judge', () => {
  const bright = { mean: [200, 120, 40], max: 255, bright: true }
  const dark = { mean: [60, 40, 30], max: 120, bright: false }
  const grey = { mean: [55, 45, 40], max: 90, bright: false }
  // the probes every grid entry has: a head, a levee and one channel's end and middle
  const base = (over = {}) => ({ head: bright, levee: grey, end0: lit(180), mid0: lit(150), ...over })

  it('passes a hot head, a grey levee and a channel that is no darker at its end; the probes it was not given are not in the verdict', () => {
    expect(judge(base())).toEqual({ head: true, toe: true, levee: true, ok: true })
  })

  it('names the probe that failed', () => {
    expect(judge(base({ head: dark }))).toMatchObject({ head: false, ok: false })
    expect(judge(base({ levee: bright }))).toMatchObject({ levee: false, ok: false })
    expect(judge(base({ end0: lit(60) }))).toMatchObject({ toe: false, ok: false })
  })

  it('adds the junction, the pool and the contrast to the verdict when they were sampled', () => {
    const probes = base({ junction0: lit(180), junction1: lit(180), pool: lit(200) })
    const cta = [{ text: [26, 13, 6], bg: [240, 140, 70] }, { text: [89, 214, 108], bg: [10, 10, 10] }]
    expect(judge(probes, cta)).toEqual({ head: true, toe: true, levee: true, junction: true, pool: true, cta: true, ok: true })
    expect(judge({ ...probes, junction0: lit(20), junction1: lit(20) }, cta)).toMatchObject({ junction: false, ok: false })
    expect(judge({ ...probes, pool: lit(100) }, cta)).toMatchObject({ pool: false, ok: false })
    expect(judge(probes, [{ text: [200, 200, 200], bg: [240, 200, 100] }, cta[1]])).toMatchObject({ cta: false, ok: false })
  })

  // a 4 x 4 box of RGBA pixels, every one `base`, with the given pixels (index -> rgb) swapped in
  const box = (rgb, swaps = {}) => {
    const px = new Uint8Array(4 * 4 * 4)
    for (let i = 0; i < 16; i++) px.set([...(swaps[i] ?? rgb), 255], i * 4)
    return probe(px, 4, 4, { x: 0, y: 0, w: 4, h: 4 })
  }

  it('judges the levee on the mean: grey rubble with one ember pixel passes', () => {
    const levee = box([55, 45, 40], { 5: [171, 45, 40] })
    expect(levee.max).toBe(171) // the old single-pixel test (max under 160) failed this box
    expect(judge(base({ levee }))).toMatchObject({ levee: true, ok: true })
    // the box that flaked the smoke run: an ember over rubble, mean rgb 78,60,45
    expect(judge(base({ levee: { mean: [78, 60, 45], max: 200, bright: false } }))).toMatchObject({ levee: true })
  })

  it('judges the levee on the mean: lava fails it, even when it is evenly yellow-red', () => {
    expect(judge(base({ levee: box([230, 120, 30]) }))).toMatchObject({ levee: false, ok: false })
    // red and green close together, so only the mean red can tell this from rubble
    expect(judge(base({ levee: box([150, 130, 60]) }))).toMatchObject({ levee: false, ok: false })
  })
})

describe('judgeJunction', () => {
  const line = (...reds) => Object.fromEntries(reds.map((r, i) => [`junction${i}`, lit(r)]))

  it('passes a line whose mean red is over the ember line: no dark run across the bank', () => {
    expect(judgeJunction(line(200, 180, 170, 160, 180, 190))).toBe(true)
    expect(judgeJunction(line(111, 111, 111, 111, 111, 111))).toBe(true)
    expect(EMBER_RED).toBe(110)
  })

  it('fails a bank that reads as rock, and does not let one bright sample carry a dark run', () => {
    expect(judgeJunction(line(60, 50, 45, 50, 60, 55))).toBe(false)
    expect(judgeJunction(line(110, 110, 110, 110, 110, 110))).toBe(false) // above 110, not at it
    expect(judgeJunction(line(240, 40, 40, 40, 40, 40))).toBe(false) // mean 73
  })

  it('wants each half of the line lava, the trunk\'s side and the feeder\'s: a missing feeder is not carried by a hot trunk', () => {
    expect(judgeJunction(line(200, 200, 200, 40, 40, 40))).toBe(false) // the pooled mean is 120
    expect(judgeJunction(line(40, 40, 40, 200, 200, 200))).toBe(false)
    expect(judgeJunction(line(200, 200, 200, 200, 200, 200))).toBe(true)
    expect(judgeJunction(line(80, 112, 207, 250, 247, 244))).toBe(true) // a healthy phone read: halves 133 and 247
    expect(junctionMeans(line(80, 112, 207, 250, 247, 244)).map(Math.round)).toEqual([133, 247])
    // the halves are in line order, whatever order the probes were read in
    expect(judgeJunction({ junction3: lit(200), junction0: lit(200), junction4: lit(30), junction1: lit(200), junction5: lit(30), junction2: lit(200) })).toBe(false)
  })

  it('splits the halves by k, so a sample dropped off the canvas does not move a trunk sample into the feeder\'s half', () => {
    // k 4 and 5 are missing: the feeder's half is k 3 alone. Split by position (two and two) the 30 would be averaged with a trunk 200
    expect(judgeJunction({ junction0: lit(200), junction1: lit(200), junction2: lit(200), junction3: lit(30) })).toBe(false)
    expect(junctionMeans({ junction0: lit(200), junction1: lit(200), junction2: lit(200), junction3: lit(30) })).toEqual([200, 30])
    expect(judgeJunction({ junction0: lit(200), junction1: lit(200), junction2: lit(200), junction3: lit(200) })).toBe(true)
    // a trunk sample missing (k 1): the trunk's half is k 0 and 2
    expect(judgeJunction({ junction0: lit(200), junction2: lit(200), junction3: lit(200), junction4: lit(200), junction5: lit(200) })).toBe(true)
    expect(judgeJunction({ junction0: lit(40), junction2: lit(40), junction3: lit(200), junction4: lit(200), junction5: lit(200) })).toBe(false)
    // a half with nothing sampled is not judged, and reads NaN in the means
    expect(judgeJunction({ junction3: lit(200), junction4: lit(200), junction5: lit(200) })).toBe(true)
    expect(junctionMeans({ junction3: lit(200), junction4: lit(200), junction5: lit(200) })).toEqual([NaN, 200])
  })

  it('has no verdict without samples', () => {
    expect(judgeJunction({ head: lit(200) })).toBeNull()
    expect(junctionMeans({ head: lit(200) })).toEqual([])
  })
})

describe('judgePool', () => {
  it('wants the arc box over 150 on a desktop', () => {
    expect(judgePool({ pool: lit(151) })).toBe(true)
    expect(judgePool({ pool: lit(150) })).toBe(false)
    expect(judgePool({ pool: lit(80) })).toBe(false)
  })

  it('wants the bottom strip of a phone over 60', () => {
    expect(judgePool({ poolEdge: lit(61) })).toBe(true)
    expect(judgePool({ poolEdge: lit(60) })).toBe(false)
    expect(judgePool({ poolEdge: lit(20) })).toBe(false)
  })

  it('has no verdict without a pool box', () => {
    expect(judgePool({ head: lit(200) })).toBeNull()
  })
})

describe('judgeToes', () => {
  it('passes channels whose last box is no darker than their middle', () => {
    expect(judgeToes({ end0: lit(180), mid0: lit(150), end1: lit(150), mid1: lit(150) })).toBe(true)
  })

  it('passes an end that is cooler than a white-hot middle but plainly lit: red 255 is the most a middle can read', () => {
    // a healthy desktop read (2026-11-09): ends 184, 231 and 102 against middles 255, 234 and 189
    expect(judgeToes({ end0: lit(184), mid0: lit(255), end1: lit(231), mid1: lit(234), end2: lit(102), mid2: lit(189) })).toBe(true)
    expect(TOE_RED).toBe(70)
  })

  it('fails any channel that ends darker than its middle and is as dark as bare rock: a toe on the ground', () => {
    expect(judgeToes({ end0: lit(180), mid0: lit(150), end1: lit(45), mid1: lit(150) })).toBe(false)
    expect(judgeToes({ end0: lit(69), mid0: lit(255) })).toBe(false)
    expect(judgeToes({ end0: lit(71), mid0: lit(255) })).toBe(true)
  })

  it('does not call a dark channel a toe on rock when it is no darker at its end than in its middle', () => {
    expect(judgeToes({ end0: lit(45), mid0: lit(40) })).toBe(true)
  })

  it('cannot pass with nothing to compare', () => {
    expect(judgeToes({ head: lit(200) })).toBe(false)
    expect(judgeToes({ end0: lit(180) })).toBe(false) // an end with no middle is not a pair
  })
})

describe('contrast', () => {
  it('is the WCAG ratio of two colours', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5)
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5)
    expect(contrastRatio([120, 90, 30], [120, 90, 30])).toBeCloseTo(1, 5)
    // a known pair: #ffffff on #767676 is the lightest grey that passes 4.5:1, 4.54
    expect(contrastRatio([255, 255, 255], [118, 118, 118])).toBeCloseTo(4.54, 2)
    expect(contrastRatio([255, 255, 255], [119, 119, 119])).toBeLessThan(4.5)
    // #1a0d06 on the ember button's #ff6a2b: well over 4.5
    expect(contrastRatio([26, 13, 6], [255, 106, 43])).toBeGreaterThan(6)
  })

  it('judges each button\'s text against the face under it, at least 4.5:1, and wants two of them', () => {
    const ok = { text: [26, 13, 6], bg: [255, 106, 43] }
    const green = { text: [89, 214, 108], bg: [10, 10, 10] }
    expect(judgeCta([ok, green])).toBe(true)
    expect(judgeCta([ok, { text: [89, 214, 108], bg: [120, 190, 120] }])).toBe(false)
    expect(judgeCta([ok])).toBe(false)
    expect(judgeCta([])).toBe(false)
    // a text colour with alpha is laid over the face before the ratio
    expect(judgeCta([ok, { text: [255, 255, 255, 0.1], bg: [10, 10, 10] }])).toBe(false)
  })

  it('judges the worst tile, not the mean: lava behind part of a label does not average away', () => {
    const dark = [8, 16, 11]
    const lava = [230, 120, 30]
    const green = [89, 214, 108]
    const tiles = [dark, dark, dark, dark, lava, lava] // a third of the label over lava
    const button = { text: green, bg: [83, 51, 17], tiles } // the mean face of those tiles
    expect(ctaMeanRatio(button)).toBeGreaterThan(3) // the mean face still reads
    expect(ctaRatio(button)).toBeLessThan(2) // the lava tile does not
    expect(judgeCta([{ text: [26, 13, 6], bg: [255, 106, 43] }, button])).toBe(false)
    // all tiles dark: the worst is the same as the best
    expect(judgeCta([{ text: [26, 13, 6], bg: [255, 106, 43] }, { text: green, bg: dark, tiles: [dark, dark, dark] }])).toBe(true)
    // no tiles: the mean face
    expect(ctaRatio({ text: green, bg: dark })).toBeCloseTo(ctaMeanRatio({ text: green, bg: dark }), 8)
  })

  describe('faceTiles', () => {
    // an image of RGBA pixels, w x h, each given by colourAt(x, y)
    const image = (w, h, colourAt) => {
      const data = new Uint8Array(w * h * 4)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...colourAt(x, y), 255], (y * w + x) * 4)
      return { width: w, height: h, data }
    }
    const red = [200, 0, 0]
    const blue = [0, 0, 200]

    it('cuts the content box into equal tiles and reads each one\'s mean', () => {
      const img = image(12, 4, (x) => (x < 6 ? red : blue))
      const tiles = faceTiles(img, { w: 12, h: 4 }, [0, 0, 0, 0], 6)
      expect(tiles).toHaveLength(6)
      expect(tiles.map((t) => t[0])).toEqual([200, 200, 200, 0, 0, 0])
    })

    it('leaves the border and padding out, in device px when the picture is at 2x', () => {
      // 24 x 8 device px for a 12 x 4 CSS button: red on the left 12, blue on the right 12; a CSS inset of 2 left and right is 4 device px
      const img = image(24, 8, (x) => (x < 12 ? red : blue))
      const tiles = faceTiles(img, { w: 12, h: 4 }, [0, 2, 0, 2], 4) // device x 4 to 20, tiles of 4: [4,8) [8,12) [12,16) [16,20)
      expect(tiles.map((t) => t[0])).toEqual([200, 200, 0, 0])
      // the rows above and below are out as well
      const rows = image(4, 4, (x, y) => (y === 0 || y === 3 ? [255, 255, 255] : red))
      expect(faceTiles(rows, { w: 4, h: 4 }, [1, 0, 1, 0], 2).map((t) => t[1])).toEqual([0, 0])
    })

    it('reads the whole picture when the inset leaves nothing', () => {
      const img = image(12, 4, () => red)
      expect(faceTiles(img, { w: 12, h: 4 }, [0, 7, 0, 7], 6).map((t) => t[0])).toEqual([200, 200, 200, 200, 200, 200])
    })
  })

  it('reads the colour strings the page reports', () => {
    expect(parseCssColor('rgb(26, 13, 6)')).toEqual([26, 13, 6, 1])
    expect(parseCssColor('rgba(89, 214, 108, 0.5)')).toEqual([89, 214, 108, 0.5])
    expect(parseCssColor('rgb(26 13 6 / 50%)')).toEqual([26, 13, 6, 0.5])
    expect(parseCssColor('transparent')).toEqual([0, 0, 0, 0])
    expect(parseCssColor('oklch(0.5 0.1 40)')).toBeNull()
    expect(parseCssColor('')).toBeNull()
  })
})

describe('decodePng', () => {
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  /** A PNG of `px` (channels per pixel from `color`: 6 RGBA, 2 RGB), every row filtered with `filter` (0 to 4). */
  const encode = (w, h, px, { filter = 0, color = 6, depth = 8, interlace = 0 } = {}) => {
    const bpp = color === 6 ? 4 : 3
    const stride = w * bpp
    const raw = Buffer.alloc((stride + 1) * h)
    for (let y = 0; y < h; y++) {
      raw[y * (stride + 1)] = filter
      for (let i = 0; i < stride; i++) {
        const cur = px[y * stride + i]
        const a = i >= bpp ? px[y * stride + i - bpp] : 0
        const b = y > 0 ? px[(y - 1) * stride + i] : 0
        const c = i >= bpp && y > 0 ? px[(y - 1) * stride + i - bpp] : 0
        const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]
        raw[y * (stride + 1) + 1 + i] = (cur - pred) & 255
      }
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(w, 0)
    ihdr.writeUInt32BE(h, 4)
    ihdr[8] = depth
    ihdr[9] = color
    ihdr[12] = interlace
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  }
  const pixels = (w, h, channels) => Uint8Array.from({ length: w * h * channels }, (_, i) => (i * 37 + (i >> 3) * 11 + 5) & 255)

  it('reads RGBA through every filter type', () => {
    const px = pixels(7, 5, 4)
    for (const filter of [0, 1, 2, 3, 4]) {
      const img = decodePng(encode(7, 5, px, { filter }))
      expect(img.width).toBe(7)
      expect(img.height).toBe(5)
      expect(Array.from(img.data)).toEqual(Array.from(px))
    }
  })

  it('reads RGB and gives it a full alpha', () => {
    const px = pixels(3, 2, 3)
    const img = decodePng(encode(3, 2, px, { filter: 4, color: 2 }))
    expect(Array.from(img.data.slice(0, 8))).toEqual([px[0], px[1], px[2], 255, px[3], px[4], px[5], 255])
    expect(img.data).toHaveLength(3 * 2 * 4)
  })

  it('refuses what it cannot read: not a PNG, 16 bit, interlaced', () => {
    expect(() => decodePng(Buffer.from('not a png at all'))).toThrow(/not a PNG/)
    expect(() => decodePng(encode(2, 2, pixels(2, 2, 4), { depth: 16 }))).toThrow(/8-bit/)
    expect(() => decodePng(encode(2, 2, pixels(2, 2, 4), { interlace: 1 }))).toThrow(/interlaced/)
  })
})

describe('judgeIgnition', () => {
  const bright = { mean: [200, 120, 40], max: 255, bright: true }
  const dark = { mean: [60, 40, 30], max: 120, bright: false }

  it('passes a lit head over a dark far end of the trunk, and fails lava already there', () => {
    expect(judgeIgnition({ head: bright, toe: dark })).toEqual({ head: true, toe: true, ok: true })
    expect(judgeIgnition({ head: dark, toe: dark })).toMatchObject({ head: false, ok: false })
    expect(judgeIgnition({ head: bright, toe: { ...bright, bright: false } })).toMatchObject({ toe: false, ok: false })
  })

  it('judges the toe on the mean: a drifting ember passes, a box of lava fails', () => {
    const px = (swaps) => {
      const a = new Uint8Array(24 * 24 * 4)
      for (let i = 0; i < 24 * 24; i++) a.set([...(swaps(i) ?? [60, 40, 30]), 255], i * 4)
      return probe(a, 24, 24, { x: 0, y: 0, w: 24, h: 24 })
    }
    const ember = px((i) => (i === 100 ? [230, 120, 30] : null))
    expect(ember.bright).toBe(true) // the old single-pixel flag failed this
    expect(judgeIgnition({ head: bright, toe: ember })).toMatchObject({ toe: true, ok: true })
    const lava = px((i) => (i % 2 ? [230, 120, 30] : null)) // half the box is lava: mean red 145
    expect(judgeIgnition({ head: bright, toe: lava })).toMatchObject({ toe: false, ok: false })
  })
})

describe('chromeArgs and lowerPriorityCommand', () => {
  it('holds every tab to one renderer process, with software GL unless --gpu', () => {
    const a = chromeArgs({ profileDir: 'C:\\tmp\\forge-render-x1', gpu: false })
    expect(a).toContain('--renderer-process-limit=1')
    expect(a).toContain('--use-angle=swiftshader')
    expect(a).toContain('--user-data-dir=C:\\tmp\\forge-render-x1')
    expect(chromeArgs({ profileDir: 'p', gpu: true })).not.toContain('--use-angle=swiftshader')
  })

  it('lowers this run\'s Chrome processes by profile name on Windows, and only there', () => {
    const c = lowerPriorityCommand('forge-render-x1', 'win32')
    expect(c.cmd).toBe('powershell')
    expect(c.args.at(-1)).toMatch(/CommandLine -match 'forge-render-x1'.*PriorityClass = 'BelowNormal'/)
    expect(lowerPriorityCommand('forge-render-x1', 'linux')).toBeNull()
    expect(() => lowerPriorityCommand("x'; rm", 'win32')).toThrow(/not safe/)
  })
})

describe('parseArgs', () => {
  it('has the documented defaults', () => {
    expect(parseArgs([])).toEqual({
      base: 'http://127.0.0.1:5191',
      out: '.forge/grid',
      paths: ['/'],
      sizes: ['phone', 'desktop'],
      phases: [0.42],
      presets: [null],
      throttle: null,
      smoke: false,
      verbose: false,
      gpu: false,
      chrome: null,
    })
  })

  it('reads commas and spaces in lists, a throttle and the flags', () => {
    const a = parseArgs(['--paths', '/', '/armoury', '--sizes', 'phone,desktop', '--phases', '0.1,0.7', '--presets', 'crust=0.3,crust=1', '--throttle', '4', '--smoke'])
    expect(a).toMatchObject({ paths: ['/', '/armoury'], sizes: ['phone', 'desktop'], phases: [0.1, 0.7], presets: ['crust=0.3', 'crust=1'], throttle: 4, smoke: true })
  })

  it('takes only the six lava keys with numbers as presets', () => {
    expect(parseArgs(['--presets', 'crust=0.3&heat=1.2,foldScale=2']).presets).toEqual(['crust=0.3&heat=1.2', 'foldScale=2'])
    expect(() => parseArgs(['--presets', 'crst=0.3'])).toThrow(/unknown lava key "crst".*crust, heat, viscosity, cracks, foldScale, breakoutRate/)
    expect(() => parseArgs(['--presets', 'crust=0.3&t=5'])).toThrow(/unknown lava key "t"/)
    expect(() => parseArgs(['--presets', 'crust=high'])).toThrow(/"crust" needs a number/)
    expect(() => parseArgs(['--presets', 'crust'])).toThrow(/"crust" needs a number/)
  })

  it('checks --base is an http(s) URL before anything starts', () => {
    expect(parseArgs(['--base', 'http://localhost:5173/']).base).toBe('http://localhost:5173')
    expect(() => parseArgs(['--base', 'localhost:5173'])).toThrow(/--base must be an http or https URL/)
    expect(() => parseArgs(['--base', 'not a url'])).toThrow(/--base must be a URL/)
  })

  it('refuses what it cannot make sense of', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown flag/)
    expect(() => parseArgs(['--phases', 'x'])).toThrow(/numbers/)
    expect(() => parseArgs(['--paths', 'C:/Program Files/Git/'])).toThrow(/start with/)
    expect(() => parseArgs(['--throttle', '0'])).toThrow(/throttle/)
    expect(() => parseArgs(['--out'])).toThrow(/needs a value/)
  })
})

describe('lavaWanted', () => {
  it('reads the lava switch out of a planned URL', () => {
    expect(lavaWanted('/?moon=0.42&t=120&calm=0&lava=1&crust=0.3')).toBe(true)
    expect(lavaWanted('/armoury?lava=0')).toBe(false)
    expect(lavaWanted('/?moon=0.42')).toBeNull()
  })
})
