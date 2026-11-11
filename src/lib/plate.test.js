import { describe, test, expect } from 'vitest'
import {
  BUCKETS,
  BLEED,
  PLATE_SLUGS,
  bucketFor,
  profileSlug,
  plateSlug,
  plateUrls,
  fitPlate,
  mapPoint,
  mapMountain,
  anchorFor,
} from './plate'
import { mountainForRoute } from './mountain'
import { DEFAULTS, RANDOMIZE_DEFAULTS, ROUTE_PROFILE_DEFAULTS } from './fireTuning'

// The plan's own anchors are made up; these are the sort of numbers a real wide plate carries (2000x1125 plus 10 percent
// bleed on every side is a 2400x1350 image; the peak sits a little right of centre, the pool arc's top near the foot).
const IMG = { imageW: 2400, imageH: 1350 }
const REAL = { peak: { x: 1240, y: 461 }, poolTop: { x: 1200, y: 1150 } }

const VIEWPORTS = [
  [390, 844],
  [768, 1024],
  [1300, 773],
  [1600, 1000],
  [3440, 1440],
  [1000, 2200],
]

describe('bucketFor', () => {
  test('bucket boundaries: 0.8 is portrait, 1.4 is squarish', () => {
    expect(bucketFor(800, 1000)).toBe('portrait')
    expect(bucketFor(801, 1000)).toBe('squarish')
    expect(bucketFor(1400, 1000)).toBe('squarish')
    expect(bucketFor(1401, 1000)).toBe('wide')
  })

  test('an aspect of exactly 0.8 is portrait however the size reaches it', () => {
    for (const [w, h] of [[800, 1000], [1120, 1400], [400, 500], [1600, 2000], [4, 5], [720, 900]]) {
      expect(w / h).toBe(0.8)
      expect(bucketFor(w, h)).toBe('portrait')
    }
  })

  test('an aspect of exactly 1.4 is squarish however the size reaches it', () => {
    for (const [w, h] of [[1400, 1000], [2800, 2000], [700, 500], [7, 5], [1260, 900]]) {
      expect(w / h).toBe(1.4)
      expect(bucketFor(w, h)).toBe('squarish')
    }
  })

  test('the same size picks the same bucket every time it is asked, at both boundaries', () => {
    for (const [w, h] of [[800, 1000], [1400, 1000]]) {
      const first = bucketFor(w, h)
      for (let i = 0; i < 5; i++) expect(bucketFor(w, h)).toBe(first)
    }
  })

  test('the common sizes', () => {
    expect(bucketFor(390, 844)).toBe('portrait')
    expect(bucketFor(768, 1024)).toBe('portrait') // 0.75
    expect(bucketFor(1000, 2200)).toBe('portrait')
    expect(bucketFor(1024, 768)).toBe('squarish') // 1.33
    expect(bucketFor(1000, 1000)).toBe('squarish')
    expect(bucketFor(1300, 773)).toBe('wide')
    expect(bucketFor(1600, 1000)).toBe('wide')
    expect(bucketFor(3440, 1440)).toBe('wide')
  })

  test('the reference sizes and the bleed are the plan\'s', () => {
    expect(BUCKETS).toEqual({
      portrait: { w: 900, h: 1600 },
      squarish: { w: 1600, h: 1200 },
      wide: { w: 2000, h: 1125 },
    })
    expect(BLEED).toBe(0.1)
  })

  test('each reference size lands in its own bucket', () => {
    for (const [name, { w, h }] of Object.entries(BUCKETS)) expect(bucketFor(w, h)).toBe(name)
  })
})

describe('slugs', () => {
  test('slugs', () => {
    expect(profileSlug('/')).toBe('home')
    expect(profileSlug('/deathwatch/*')).toBe('deathwatch')
    expect(profileSlug('*')).toBe('default')
  })

  test('every route profile key has its own disk name, and nothing else does', () => {
    expect(Object.keys(ROUTE_PROFILE_DEFAULTS).map(profileSlug)).toEqual([
      'home',
      'planner',
      'armoury',
      'builds',
      'companies',
      'roster',
      'deathwatch',
      'default',
    ])
  })

  test('a key that is not a route profile falls to default, prototype names included', () => {
    for (const key of ['/nowhere', '', 'constructor', '__proto__', 'toString', undefined, null]) {
      expect(profileSlug(key)).toBe('default')
    }
  })

  test('only home and default have plates in this pass', () => {
    expect(PLATE_SLUGS).toEqual(['home', 'default'])
    expect(PLATE_SLUGS).toContain('default') // every fall-through lands on a plate that exists
  })

  test('home and default resolve to themselves; every other profile key resolves to default', () => {
    expect(plateSlug('/')).toBe('home')
    expect(plateSlug('*')).toBe('default')
    for (const key of Object.keys(ROUTE_PROFILE_DEFAULTS).filter((k) => k !== '/' && k !== '*')) {
      expect(plateSlug(key)).toBe('default')
    }
    expect(plateSlug('/nowhere')).toBe('default')
    expect(plateSlug('constructor')).toBe('default')
  })
})

describe('plateUrls', () => {
  test('the home wide plate, both images in both formats, and the sidecar', () => {
    expect(plateUrls('/', 'wide')).toEqual({
      sky: { avif: '/plates/home/wide.sky.avif', webp: '/plates/home/wide.sky.webp' },
      rock: { avif: '/plates/home/wide.rock.avif', webp: '/plates/home/wide.rock.webp' },
      json: '/plates/home/wide.json',
    })
  })

  test('a route with no plate of its own gets the default plate\'s urls', () => {
    expect(plateUrls('/planner', 'portrait')).toEqual(plateUrls('*', 'portrait'))
    expect(plateUrls('/deathwatch/*', 'squarish').json).toBe('/plates/default/squarish.json')
    expect(plateUrls('/roster', 'wide').rock.webp).toBe('/plates/default/wide.rock.webp')
  })

  test('the base can move', () => {
    expect(plateUrls('/', 'squarish', '/assets/p/').sky.avif).toBe('/assets/p/home/squarish.sky.avif')
    expect(plateUrls('*', 'wide', 'https://cdn.example/plates/').json).toBe('https://cdn.example/plates/default/wide.json')
  })
})

describe('fitPlate', () => {
  test('fit covers and never exposes an edge, 0.45 to 2.4', () => {
    for (const [w, h] of VIEWPORTS) {
      const img = { imageW: 2400, imageH: 1350 } // wide with bleed
      const f = fitPlate({ ...img, w, h, anchor: { peak: { x: 1000, y: 300 }, poolTop: { x: 700, y: 1250 } } })
      expect(f.dx).toBeLessThanOrEqual(0)
      expect(f.dy).toBeLessThanOrEqual(0)
      expect(img.imageW * f.scale + f.dx).toBeGreaterThanOrEqual(w)
      expect(img.imageH * f.scale + f.dy).toBeGreaterThanOrEqual(h)
      const px = 1000 * f.scale + f.dx
      expect(px).toBeGreaterThanOrEqual(0.08 * w)
      expect(px).toBeLessThanOrEqual(0.92 * w)
    }
  })

  test('scale is the cover scale (to within the one ulp that makes it cover in floating point too)', () => {
    for (const [w, h] of VIEWPORTS) {
      const f = fitPlate({ ...IMG, w, h, anchor: REAL })
      expect(f.scale).toBeCloseTo(Math.max(w / IMG.imageW, h / IMG.imageH), 12)
      expect(IMG.imageW * f.scale).toBeGreaterThanOrEqual(w)
      expect(IMG.imageH * f.scale).toBeGreaterThanOrEqual(h)
    }
  })

  test('on the sizes where plain division under-covers by an ulp, the scale is nudged and still covers exactly', () => {
    // 1300x773 against 2400x1350: 1350 * (773 / 1350) is 772.9999999999999
    expect(1350 * (773 / 1350)).toBeLessThan(773)
    const f = fitPlate({ ...IMG, w: 1300, h: 773, anchor: REAL })
    expect(1350 * f.scale).toBeGreaterThanOrEqual(773)
    expect(f.scale).toBeCloseTo(773 / 1350, 12)
    // and where it does not, the scale is the quotient to the last bit
    expect(fitPlate({ ...IMG, w: 1600, h: 900 }).scale).toBe(1600 / 2400)
  })

  test('a sweep from 0.3 to 3 never exposes an edge and keeps the peak and the pool arc in frame', () => {
    for (let aspect = 0.3; aspect <= 3.0001; aspect += 0.05) {
      for (const h of [600, 844, 1000, 1440]) {
        const w = Math.round(aspect * h)
        const f = fitPlate({ ...IMG, w, h, anchor: REAL })
        const at = (p) => ({ x: p.x * f.scale + f.dx, y: p.y * f.scale + f.dy })
        expect(f.dx).toBeLessThanOrEqual(0)
        expect(f.dy).toBeLessThanOrEqual(0)
        expect(IMG.imageW * f.scale + f.dx).toBeGreaterThanOrEqual(w - 1e-9)
        expect(IMG.imageH * f.scale + f.dy).toBeGreaterThanOrEqual(h - 1e-9)
        const peak = at(REAL.peak)
        expect(peak.x).toBeGreaterThanOrEqual(0.08 * w - 1e-9)
        expect(peak.x).toBeLessThanOrEqual(0.92 * w + 1e-9)
        expect(peak.y).toBeGreaterThanOrEqual(0)
        expect(peak.y).toBeLessThanOrEqual(h)
        const pool = at(REAL.poolTop)
        expect(pool.y).toBeGreaterThanOrEqual(0)
        expect(pool.y).toBeLessThanOrEqual(h + 1e-9)
      }
    }
  })

  test('an ultrawide window (3440x1440) keeps the peak and the pool arc in frame, inside the bleed', () => {
    const f = fitPlate({ ...IMG, w: 3440, h: 1440, anchor: REAL })
    const peak = { x: REAL.peak.x * f.scale + f.dx, y: REAL.peak.y * f.scale + f.dy }
    const pool = { x: REAL.poolTop.x * f.scale + f.dx, y: REAL.poolTop.y * f.scale + f.dy }
    expect(peak.x).toBeGreaterThan(0.08 * 3440)
    expect(peak.x).toBeLessThan(0.92 * 3440)
    expect(peak.y).toBeGreaterThanOrEqual(0)
    expect(pool.y).toBeLessThanOrEqual(1440)
    // the pool arc is held at the bottom edge, at 94 percent of the height, rather than the crop being centred
    expect(pool.y).toBeCloseTo(0.94 * 1440, 6)
  })

  test('a tall narrow window (1000x2200) keeps the peak in frame by shifting only along x', () => {
    const f = fitPlate({ ...IMG, w: 1000, h: 2200, anchor: REAL })
    expect(f.dy).toBeCloseTo(0, 9) // no vertical slack at all
    const px = REAL.peak.x * f.scale + f.dx
    expect(px).toBeGreaterThanOrEqual(80)
    expect(px).toBeLessThanOrEqual(920)
  })

  test('with no anchor the crop is centred', () => {
    const f = fitPlate({ ...IMG, w: 3440, h: 1440 })
    expect(f.dx).toBeCloseTo((3440 - 2400 * f.scale) / 2, 9)
    expect(f.dy).toBeCloseTo((1440 - 1350 * f.scale) / 2, 9)
    const g = fitPlate({ ...IMG, w: 390, h: 844, anchor: {} })
    expect(g.dx).toBeCloseTo((390 - 2400 * g.scale) / 2, 9)
    expect(g.dy).toBeCloseTo(0, 9)
  })

  test('at the image\'s own size nothing moves', () => {
    const f = fitPlate({ imageW: 2400, imageH: 1350, w: 2400, h: 1350, anchor: REAL })
    expect(f.scale).toBe(1)
    expect(f.dx).toBeCloseTo(0, 9)
    expect(f.dy).toBeCloseTo(0, 9)
  })

  test('a peak already inside the middle 84 percent is left centred (x moves by the least amount)', () => {
    const f = fitPlate({ ...IMG, w: 390, h: 844, anchor: { peak: { x: 1200, y: 400 } } })
    expect(f.dx).toBeCloseTo((390 - 2400 * f.scale) / 2, 9)
  })

  test('a peak outside the band is shifted in by the least amount, to the band\'s edge', () => {
    // Centred, this peak lands at x = -35 on a 390 wide window; the least shift brings it to 0.08 w.
    const near = fitPlate({ ...IMG, w: 390, h: 844, anchor: { peak: { x: 400, y: 400 } } })
    expect(400 * near.scale + near.dx).toBeCloseTo(0.08 * 390, 6)
    // And the far side: 0.92 w.
    const far = fitPlate({ ...IMG, w: 390, h: 844, anchor: { peak: { x: 2000, y: 400 } } })
    expect(2000 * far.scale + far.dx).toBeCloseTo(0.92 * 390, 6)
  })

  test('a peak the crop cannot bring inside still never exposes the image\'s edge', () => {
    const f = fitPlate({ ...IMG, w: 390, h: 844, anchor: { peak: { x: 10, y: 400 } } })
    expect(f.dx).toBeCloseTo(0, 9) // clamped at the image's left edge
    expect(2400 * f.scale + f.dx).toBeGreaterThanOrEqual(390 - 1e-9)
    const g = fitPlate({ ...IMG, w: 390, h: 844, anchor: { peak: { x: 2390, y: 400 } } })
    expect(2400 * g.scale + g.dx).toBeCloseTo(390, 6) // clamped at the right edge
  })

  test('the pool arc is held at 94 percent of the height when the crop allows', () => {
    const f = fitPlate({ ...IMG, w: 2200, h: 1000, anchor: REAL })
    expect(REAL.poolTop.y * f.scale + f.dy).toBeCloseTo(940, 6)
    expect(f.dy).toBeLessThan(0)
  })

  test('a pool arc the crop cannot bring down is left where the top edge allows', () => {
    // 1600x900 against a 2400x1350 image has no vertical slack to spend
    const f = fitPlate({ ...IMG, w: 1600, h: 900, anchor: { peak: { x: 1200, y: 400 }, poolTop: { x: 1200, y: 600 } } })
    expect(f.dy).toBeCloseTo(0, 9)
  })

  test('a pool arc the crop cannot bring up is left where the bottom edge allows', () => {
    // an image twice the window's height with the arc low in it: slack is -1000, and pushing the arc to 940 would need
    // dy = -1050, past the bottom edge, so the image stops at its bottom edge and the arc sits at 990
    const f = fitPlate({ imageW: 1000, imageH: 2000, w: 1000, h: 1000, anchor: { peak: { x: 500, y: 1500 }, poolTop: { x: 500, y: 1990 } } })
    expect(f.dy).toBeCloseTo(-1000, 9)
    expect(1990 * f.scale + f.dy).toBeCloseTo(990, 9)
  })

  test('when the peak and the pool arc cannot both fit, the peak wins and the pool is cropped', () => {
    // 1090 px of mountain between the peak and the arc's top, in a 1000 px window
    const f = fitPlate({ imageW: 1000, imageH: 2000, w: 1000, h: 1000, anchor: { peak: { x: 500, y: 900 }, poolTop: { x: 500, y: 1990 } } })
    expect(900 * f.scale + f.dy).toBeCloseTo(0, 9)
    expect(1990 * f.scale + f.dy).toBeGreaterThan(1000)
  })

  test('the plan\'s made-up anchors at 3440x1440 keep the peak from crossing the top edge', () => {
    const f = fitPlate({ ...IMG, w: 3440, h: 1440, anchor: { peak: { x: 1000, y: 300 }, poolTop: { x: 700, y: 1250 } } })
    expect(300 * f.scale + f.dy).toBeGreaterThanOrEqual(-1e-9)
    expect(1250 * f.scale + f.dy).toBeGreaterThanOrEqual(0.94 * 1440 - 1e-9)
    expect(1250 * f.scale + f.dy).toBeLessThanOrEqual(1440)
  })
})

describe('mapPoint', () => {
  test('scales then shifts, and returns a new object', () => {
    const p = { x: 10, y: 20 }
    const q = mapPoint(p, { scale: 2, dx: -5, dy: 7 })
    expect(q).toEqual({ x: 15, y: 47 })
    expect(q).not.toBe(p)
    expect(p).toEqual({ x: 10, y: 20 })
  })
})

describe('mapMountain', () => {
  const { mountain } = mountainForRoute({
    path: '/',
    w: 1600,
    h: 1000,
    tune: DEFAULTS.bed,
    randomize: RANDOMIZE_DEFAULTS,
    prof: ROUTE_PROFILE_DEFAULTS['/'],
  })
  const FIELDS = [
    'peakX', 'peakY', 'craterHalf', 'left', 'right', 'rimL', 'rimR', 'crown', 'mouthL', 'mouthR', 'valley', 'vent',
    'valleyDepth', 'litL', 'litR',
  ]
  // every point of a mountain in a fixed order (aliased ones appear more than once, which is the point)
  const points = (m) => [m.rimL, m.rimR, m.mouthL, m.mouthR, m.vent, ...m.left, ...m.right, ...m.crown, ...m.valley, ...m.litL, ...m.litR]
  const IDENTITY = { scale: 1, dx: 0, dy: 0 }
  const FIT = { scale: 2, dx: -30, dy: 11.5 }

  test('the premise: the built mountain aliases points, so the mapping has to be careful', () => {
    expect(mountain.mouthL).toBe(mountain.valley[0])
    expect(mountain.mouthR).toBe(mountain.valley[mountain.valley.length - 1])
    expect(mountain.crown.includes(mountain.litL[0])).toBe(true)
    expect(mountain.crown.includes(mountain.litR[0])).toBe(true)
  })

  test('it has every field buildMountain returns, and a real mountain has them all', () => {
    expect(Object.keys(mountain).sort()).toEqual([...FIELDS].sort())
    expect(Object.keys(mapMountain(mountain, IDENTITY)).sort()).toEqual([...FIELDS].sort())
  })

  test('at scale 1 and no shift the mapping is the mountain, field for field', () => {
    expect(mapMountain(mountain, IDENTITY)).toEqual(mountain)
  })

  test('scale 2 with a shift moves every point and scales the scalars', () => {
    const out = mapMountain(mountain, FIT)
    expect(out.peakX).toBe(mountain.peakX * 2 - 30)
    expect(out.peakY).toBe(mountain.peakY * 2 + 11.5)
    expect(out.craterHalf).toBe(mountain.craterHalf * 2)
    expect(out.valleyDepth).toBe(mountain.valleyDepth * 2)
    const before = points(mountain)
    const after = points(out)
    expect(after).toHaveLength(before.length)
    before.forEach((p, i) => expect(after[i]).toEqual({ x: p.x * 2 - 30, y: p.y * 2 + 11.5 }))
    for (const name of ['left', 'right', 'crown', 'valley', 'litL', 'litR']) expect(out[name]).toHaveLength(mountain[name].length)
  })

  test('scale 2 doubles the distances: craterHalf, the rim span and the flank width', () => {
    const out = mapMountain(mountain, { scale: 2, dx: 0, dy: 0 })
    expect(out.rimR.x - out.rimL.x).toBeCloseTo(2 * (mountain.rimR.x - mountain.rimL.x), 9)
    expect(out.craterHalf).toBeCloseTo(2 * mountain.craterHalf, 9)
    expect(out.right.at(-1).x - out.left.at(-1).x).toBeCloseTo(2 * (mountain.right.at(-1).x - mountain.left.at(-1).x), 9)
  })

  test('the input is never mutated, even though it aliases points', () => {
    const before = structuredClone(mountain)
    mapMountain(mountain, FIT)
    mapMountain(mountain, IDENTITY)
    expect(mountain).toEqual(before)
  })

  test('the result shares no object with the input, so aliased points are not moved twice', () => {
    const out = mapMountain(mountain, FIT)
    const seen = new Set(points(mountain))
    for (const p of points(out)) expect(seen.has(p)).toBe(false)
    for (const name of ['left', 'right', 'crown', 'valley', 'litL', 'litR']) expect(out[name]).not.toBe(mountain[name])
    // and writing to the result does not reach back into the input
    const before = structuredClone(mountain)
    out.left[0].x = -9999
    out.valley[0].y = -9999
    expect(mountain).toEqual(before)
  })

  test('a sidecar that went through JSON (no aliasing at all) maps to the same numbers', () => {
    const viaJson = JSON.parse(JSON.stringify(mountain))
    expect(mapMountain(viaJson, FIT)).toEqual(mapMountain(mountain, FIT))
  })

  test('the pool and the lip come through mapped, as new objects', () => {
    const pool = { cx: 800, cy: 950, rx: 360, ry: 40, arcTop: 910 }
    const lip = { x: 805, y: 240 }
    const sidecar = { ...mountain, pool, lip }
    const before = structuredClone(sidecar)
    const out = mapMountain(sidecar, FIT)
    expect(out.pool).toEqual({ cx: 800 * 2 - 30, cy: 950 * 2 + 11.5, rx: 720, ry: 80, arcTop: 910 * 2 + 11.5 })
    expect(out.lip).toEqual({ x: 805 * 2 - 30, y: 240 * 2 + 11.5 })
    expect(out.pool).not.toBe(pool)
    expect(out.lip).not.toBe(lip)
    expect(sidecar).toEqual(before)
  })

  test('a pool with fewer fields maps the ones it has and adds none', () => {
    const out = mapMountain({ ...mountain, pool: { cx: 10, cy: 20 } }, FIT)
    expect(out.pool).toEqual({ cx: -10, cy: 51.5 })
  })

  test('with no pool or lip in the sidecar the mapped mountain has none', () => {
    const out = mapMountain(mountain, FIT)
    expect('pool' in out).toBe(false)
    expect('lip' in out).toBe(false)
  })

  test('sidecar fields that are not the mountain (size, bleed, hashes) are not carried across in plate pixels', () => {
    const out = mapMountain({ ...mountain, size: { w: 2000, h: 1125 }, bleed: 0.1, sceneVersion: 3, builderHash: 'abc' }, FIT)
    expect(Object.keys(out).sort()).toEqual([...FIELDS].sort())
  })
})

describe('anchorFor', () => {
  test('the peak and the top of the pool arc, in the sidecar\'s own pixels', () => {
    expect(anchorFor({ peakX: 1240, peakY: 461, pool: { cx: 1200, cy: 1230, rx: 500, ry: 60, arcTop: 1170 } })).toEqual({
      peak: { x: 1240, y: 461 },
      poolTop: { x: 1200, y: 1170 },
    })
  })

  test('a sidecar with no pool gives a peak only, and fitPlate centres the crop in y', () => {
    const anchor = anchorFor({ peakX: 1240, peakY: 461 })
    expect(anchor).toEqual({ peak: { x: 1240, y: 461 } })
    const f = fitPlate({ ...IMG, w: 3440, h: 1440, anchor })
    expect(f.dy).toBeCloseTo((1440 - 1350 * f.scale) / 2, 9)
  })

  test('a pool that has no arcTop gives a peak only', () => {
    expect(anchorFor({ peakX: 1, peakY: 2, pool: { cx: 10, cy: 100, rx: 50, ry: 30 } })).toEqual({ peak: { x: 1, y: 2 } })
  })
})
