import { describe, it, expect } from 'vitest'
import { findChrome, plan, probe, probeRects, judge, parseArgs, lavaWanted } from './lib/forge-render.mjs'

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
    expect(p[0].url).toBe('/?moon=0.42&t=120&calm=0&lava=1&crust=0.3')
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
    expect(p[0].url).toBe('/armoury?moon=0.1&t=120&calm=0&lava=1')
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

  it('puts the head under the vent, the toe on the arm end, and the levee beside the sheet middle', () => {
    const r = probeRects(geometry)
    expect(r.head).toEqual({ x: 88, y: 50, w: 24, h: 24 })
    expect(r.toe).toEqual({ x: 133, y: 298, w: 24, h: 24 })
    // the sheet's middle is (100, 90) and its half width 12: 1.6 half widths to the left, a 4 px box about that
    expect(r.levee.x + r.levee.w / 2).toBeCloseTo(100 - 1.6 * 12, 5)
    expect(r.levee.y + r.levee.h / 2).toBeCloseTo(90, 5)
    // the wide box takes the lower 40 % of the arm (points 6 to 9) and pads it by the arm width and 4 px
    expect(r.toeWide).toEqual({ x: 130 - 20, y: 250 - 20, w: 15 + 40, h: 60 + 40 })
  })

  it('has nothing to probe without a sheet and an arm', () => {
    expect(probeRects(null)).toBeNull()
    expect(probeRects({ vent: { x: 1, y: 1 }, flows: [geometry.flows[0]] })).toBeNull()
  })
})

describe('judge', () => {
  const bright = { mean: [200, 120, 40], max: 255, bright: true }
  const dark = { mean: [60, 40, 30], max: 120, bright: false }
  const grey = { mean: [55, 45, 40], max: 90, bright: false }

  it('passes a hot head, a crusted toe with lava behind it and a grey levee', () => {
    expect(judge({ head: bright, toe: dark, toeWide: bright, levee: grey })).toEqual({ head: true, toe: true, levee: true, ok: true })
  })

  it('names the probe that failed', () => {
    expect(judge({ head: dark, toe: dark, toeWide: bright, levee: grey })).toMatchObject({ head: false, ok: false })
    expect(judge({ head: bright, toe: bright, toeWide: bright, levee: grey })).toMatchObject({ toe: false, ok: false })
    expect(judge({ head: bright, toe: dark, toeWide: dark, levee: grey })).toMatchObject({ toe: false, ok: false })
    expect(judge({ head: bright, toe: dark, toeWide: bright, levee: bright })).toMatchObject({ levee: false, ok: false })
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
