import { describe, it, expect } from 'vitest'
import {
  findChrome,
  plan,
  probe,
  probeRects,
  judge,
  judgeIgnition,
  parseArgs,
  lavaWanted,
  burnFrames,
  BURN_CAP,
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

  // a 4 x 4 box of RGBA pixels, every one `base`, with the given pixels (index -> rgb) swapped in
  const box = (base, swaps = {}) => {
    const px = new Uint8Array(4 * 4 * 4)
    for (let i = 0; i < 16; i++) px.set([...(swaps[i] ?? base), 255], i * 4)
    return probe(px, 4, 4, { x: 0, y: 0, w: 4, h: 4 })
  }

  it('judges the levee on the mean: grey rubble with one ember pixel passes', () => {
    const levee = box([55, 45, 40], { 5: [171, 45, 40] })
    expect(levee.max).toBe(171) // the old single-pixel test (max under 160) failed this box
    expect(judge({ head: bright, toe: dark, toeWide: bright, levee })).toMatchObject({ levee: true, ok: true })
    // the box that flaked the smoke run: an ember over rubble, mean rgb 78,60,45
    expect(judge({ head: bright, toe: dark, toeWide: bright, levee: { mean: [78, 60, 45], max: 200, bright: false } })).toMatchObject({ levee: true })
  })

  it('judges the levee on the mean: lava fails it, even when it is evenly yellow-red', () => {
    const lava = box([230, 120, 30])
    expect(judge({ head: bright, toe: dark, toeWide: bright, levee: lava })).toMatchObject({ levee: false, ok: false })
    // red and green close together, so only the mean red can tell this from rubble
    const glow = box([150, 130, 60])
    expect(judge({ head: bright, toe: dark, toeWide: bright, levee: glow })).toMatchObject({ levee: false, ok: false })
  })
})

describe('judgeIgnition', () => {
  const bright = { mean: [200, 120, 40], max: 255, bright: true }
  const dark = { mean: [60, 40, 30], max: 120, bright: false }

  it('passes a lit head over a dark first arm toe, and fails lava already at the toe', () => {
    expect(judgeIgnition({ head: bright, toe: dark, toeWide: bright })).toEqual({ head: true, toe: true, ok: true })
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
