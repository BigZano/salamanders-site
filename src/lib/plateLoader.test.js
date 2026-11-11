import { describe, test, expect, vi, afterEach } from 'vitest'
import { createPlateLoader, detectAvif, plateState, sidecarOk, FADE_MS } from './plateLoader'
import { makeSidecar } from '../test-utils/plateSidecar'

// The loader never touches the network or the decoder itself: both come in, so a test hands it a fake server and a fake
// decoder and reads back what it asked for.

const SIZE = { width: 2400, height: 1350 }

/** A fake server: every url answers 200 with the sidecar or a blob that names its url, unless `missing` says 404. */
function makeFetch({ json = makeSidecar(), missing = () => false, throws = () => false } = {}) {
  return vi.fn(async (url) => {
    if (throws(url)) throw new TypeError('network down')
    if (missing(url)) return { ok: false, status: 404 }
    if (url.endsWith('.json')) return { ok: true, status: 200, json: async () => json }
    return { ok: true, status: 200, blob: async () => ({ url }) }
  })
}

/** A fake decoder: a bitmap that remembers which blob it came from and can be closed. */
const makeDecode = (size = SIZE, fails = () => false) =>
  vi.fn(async (blob) => {
    if (fails(blob)) throw new Error('bad image data')
    return { ...size, url: blob.url, close: vi.fn() }
  })

const loaderWith = (over = {}) => {
  const fetchImpl = over.fetchImpl ?? makeFetch()
  const decode = over.decode ?? makeDecode()
  const loader = createPlateLoader({ fetchImpl, decode, supportsAvif: Promise.resolve(true), ...over })
  return { loader, fetchImpl, decode }
}

const urlsAsked = (fetchImpl) => fetchImpl.mock.calls.map(([u]) => u)

afterEach(() => vi.unstubAllGlobals())

describe('createPlateLoader: a plate that is there', () => {
  test('resolves the sky, the rock, the sidecar and the token it was asked with', async () => {
    const { loader } = loaderWith()
    const plate = await loader.load('/', 'wide', 7)
    expect(plate.token).toBe(7)
    expect(plate.sky.url).toBe('/plates/home/wide.sky.avif')
    expect(plate.rock.url).toBe('/plates/home/wide.rock.avif')
    expect(plate.sidecar).toEqual(makeSidecar())
  })

  test('asks the sidecar first and the two images after it', async () => {
    const { loader, fetchImpl } = loaderWith()
    await loader.load('/', 'wide', 1)
    const asked = urlsAsked(fetchImpl)
    expect(asked[0]).toBe('/plates/home/wide.json')
    expect(asked.slice(1).sort()).toEqual(['/plates/home/wide.rock.avif', '/plates/home/wide.sky.avif'])
  })

  test('the urls follow the base it is given', async () => {
    const { loader, fetchImpl } = loaderWith({ base: '/sub/plates/' })
    await loader.load('/', 'portrait', 1)
    expect(urlsAsked(fetchImpl)[0]).toBe('/sub/plates/home/portrait.json')
  })

  test('a plate is fetched once: asking again gives the same pictures, with the new token', async () => {
    const { loader, fetchImpl } = loaderWith()
    const a = await loader.load('/', 'wide', 1)
    const b = await loader.load('/', 'wide', 2)
    expect(urlsAsked(fetchImpl)).toHaveLength(3)
    expect(b.sky).toBe(a.sky)
    expect(b.rock).toBe(a.rock)
    expect([a.token, b.token]).toEqual([1, 2])
  })

  test('two asks while it is still loading share the one fetch', async () => {
    const { loader, fetchImpl } = loaderWith()
    const [a, b] = await Promise.all([loader.load('/', 'wide', 1), loader.load('/', 'wide', 2)])
    expect(urlsAsked(fetchImpl)).toHaveLength(3)
    expect([a.token, b.token]).toEqual([1, 2])
  })

  test('a stale token resolves all the same, and the caller can tell', async () => {
    const { loader } = loaderWith()
    let latest = 0
    const slow = loader.load('/', 'wide', ++latest)
    latest++ // the route changed while it was loading
    const result = await slow
    expect(result).not.toBeNull()
    expect(result.token).not.toBe(latest)
  })

  test('the route and the bucket are the key: the default plate is shared by every route that has none of its own', async () => {
    const { loader, fetchImpl } = loaderWith()
    await loader.load('/planner', 'wide', 1)
    await loader.load('/roster', 'wide', 2)
    await loader.load('*', 'wide', 3)
    await loader.load('/deathwatch/*', 'wide', 4)
    expect(urlsAsked(fetchImpl).filter((u) => u.endsWith('.json'))).toEqual(['/plates/default/wide.json'])
    await loader.load('/', 'wide', 5) // home has its own
    await loader.load('/roster', 'portrait', 6) // so does every bucket
    expect(urlsAsked(fetchImpl).filter((u) => u.endsWith('.json'))).toEqual([
      '/plates/default/wide.json',
      '/plates/home/wide.json',
      '/plates/default/portrait.json',
    ])
  })
})

describe('createPlateLoader: the format', () => {
  test('avif when the browser decodes it', async () => {
    const { loader } = loaderWith({ supportsAvif: Promise.resolve(true) })
    expect((await loader.load('/', 'wide', 1)).sky.url).toMatch(/\.sky\.avif$/)
  })

  test('webp when it does not', async () => {
    const { loader, fetchImpl } = loaderWith({ supportsAvif: Promise.resolve(false) })
    const plate = await loader.load('/', 'wide', 1)
    expect(plate.sky.url).toBe('/plates/home/wide.sky.webp')
    expect(plate.rock.url).toBe('/plates/home/wide.rock.webp')
    expect(urlsAsked(fetchImpl).some((u) => u.endsWith('.avif'))).toBe(false)
  })

  test('a plain boolean answers as well as a promise', async () => {
    const { loader } = loaderWith({ supportsAvif: false })
    expect((await loader.load('/', 'wide', 1)).rock.url).toMatch(/\.webp$/)
  })

  test('a detection that rejects is a no', async () => {
    const { loader } = loaderWith({ supportsAvif: Promise.reject(new Error('no')) })
    expect((await loader.load('/', 'wide', 1)).rock.url).toMatch(/\.webp$/)
  })

  test('with nothing said, it asks the decoder once, and takes its answer', async () => {
    const decode = makeDecode()
    const { loader } = loaderWith({ decode, supportsAvif: undefined })
    const a = await loader.load('/', 'wide', 1)
    await loader.load('/', 'portrait', 2)
    const probes = decode.mock.calls.filter(([b]) => b instanceof Blob)
    expect(probes).toHaveLength(1)
    expect(probes[0][0].type).toBe('image/avif')
    expect(a.sky.url).toMatch(/\.avif$/)
  })

  test('with nothing said and a decoder that cannot read avif, it is webp', async () => {
    const decode = makeDecode(SIZE, (blob) => blob instanceof Blob)
    const { loader } = loaderWith({ decode, supportsAvif: undefined })
    expect((await loader.load('/', 'wide', 1)).sky.url).toMatch(/\.webp$/)
  })
})

describe('createPlateLoader: a plate that is not there, or not usable, is null and not asked for again', () => {
  test('404 returns null once and is not retried', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }))
    const { loader } = loaderWith({ fetchImpl, decode: vi.fn() })
    expect(await loader.load('/', 'wide', 1)).toBeNull()
    expect(await loader.load('/', 'wide', 2)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('a 404 is one request, not one per file: the images are not asked for', async () => {
    const { loader, fetchImpl } = loaderWith({ fetchImpl: makeFetch({ missing: () => true }) })
    await loader.load('/', 'wide', 1)
    expect(urlsAsked(fetchImpl)).toEqual(['/plates/home/wide.json'])
  })

  test('the memo is per plate: a missing home/wide does not stop home/portrait being asked', async () => {
    const { loader, fetchImpl } = loaderWith({ fetchImpl: makeFetch({ missing: (u) => u.includes('/wide.') }) })
    expect(await loader.load('/', 'wide', 1)).toBeNull()
    expect(await loader.load('/', 'portrait', 2)).not.toBeNull()
    expect(urlsAsked(fetchImpl)).toContain('/plates/home/portrait.json')
  })

  test('a failed fetch (the network, or a server that is a page and not a plate) is null and not retried', async () => {
    const fetchImpl = makeFetch({ throws: () => true })
    const { loader } = loaderWith({ fetchImpl })
    expect(await loader.load('/', 'wide', 1)).toBeNull()
    expect(await loader.load('/', 'wide', 2)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('JSON that is not JSON (a dev server answers 200 with its index page) is null and not retried', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => JSON.parse('<!doctype html>') }))
    const { loader } = loaderWith({ fetchImpl })
    expect(await loader.load('/', 'wide', 1)).toBeNull()
    expect(await loader.load('/', 'wide', 2)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('decode failure after the fetch is null and not retried', async () => {
    const decode = makeDecode(SIZE, () => true)
    const { loader, fetchImpl } = loaderWith({ decode })
    expect(await loader.load('/', 'wide', 1)).toBeNull()
    expect(await loader.load('/', 'wide', 2)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(3) // the sidecar and the two images, once
  })

  test('an image that 404s after a good sidecar is null, and the one that did decode is let go', async () => {
    const decode = makeDecode()
    const fetchImpl = makeFetch({ missing: (u) => u.endsWith('.rock.avif') })
    const { loader } = loaderWith({ fetchImpl, decode })
    expect(await loader.load('/', 'wide', 1)).toBeNull()
    const made = await Promise.all(decode.mock.results.map((r) => r.value))
    expect(made.length).toBe(1)
    expect(made[0].close).toHaveBeenCalled()
  })

  test('one image decodes and the other does not: null, and the good one is let go', async () => {
    const decode = makeDecode(SIZE, (blob) => blob.url.endsWith('.rock.avif'))
    const { loader } = loaderWith({ decode })
    expect(await loader.load('/', 'wide', 1)).toBeNull()
    const made = await Promise.all(decode.mock.results.filter((r) => r.type === 'return').map((r) => r.value.catch(() => null)))
    const good = made.find(Boolean)
    expect(good.close).toHaveBeenCalled()
  })

  test('a decoder with no close (an older browser) does not turn a failure into a throw', async () => {
    const decode = vi.fn(async (blob) => {
      if (blob.url.endsWith('.rock.avif')) throw new Error('bad')
      return { ...SIZE }
    })
    const { loader } = loaderWith({ decode })
    expect(await loader.load('/', 'wide', 1)).toBeNull()
  })

  test('a sky and a rock of different sizes are not one render: null, both let go', async () => {
    const decode = vi.fn(async (blob) => ({ width: blob.url.includes('.sky.') ? 2400 : 2000, height: 1350, close: vi.fn() }))
    const { loader } = loaderWith({ decode })
    expect(await loader.load('/', 'wide', 1)).toBeNull()
    for (const r of decode.mock.results) expect((await r.value).close).toHaveBeenCalled()
  })

  test('a sidecar that is not usable is null, before the images are asked for', async () => {
    const { loader, fetchImpl, decode } = loaderWith({ fetchImpl: makeFetch({ json: { peakX: 1 } }) })
    expect(await loader.load('/', 'wide', 1)).toBeNull()
    expect(await loader.load('/', 'wide', 2)).toBeNull()
    expect(urlsAsked(fetchImpl)).toEqual(['/plates/home/wide.json'])
    expect(decode).not.toHaveBeenCalled()
  })

  test('fail() puts a plate that loaded on the same footing: null from then on, nothing fetched again', async () => {
    const { loader, fetchImpl } = loaderWith()
    expect(await loader.load('/roster', 'wide', 1)).not.toBeNull()
    const before = fetchImpl.mock.calls.length
    loader.fail('/planner', 'wide') // any route that shares the plate
    expect(await loader.load('/roster', 'wide', 2)).toBeNull()
    expect(fetchImpl.mock.calls.length).toBe(before)
  })

  test('fail() on a plate never asked for stops it being asked for', async () => {
    const { loader, fetchImpl } = loaderWith()
    loader.fail('/', 'portrait')
    expect(await loader.load('/', 'portrait', 1)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('createPlateLoader: its defaults are the browser', () => {
  test('fetch and createImageBitmap are read when a plate is asked for', async () => {
    const fetchImpl = makeFetch()
    const decode = makeDecode()
    vi.stubGlobal('fetch', fetchImpl)
    vi.stubGlobal('createImageBitmap', decode)
    const loader = createPlateLoader({ supportsAvif: true })
    const plate = await loader.load('/', 'wide', 1)
    expect(plate.sky.url).toBe('/plates/home/wide.sky.avif')
    expect(fetchImpl).toHaveBeenCalled()
  })

  test('with neither, a plate is null and nothing throws', async () => {
    vi.stubGlobal('fetch', undefined)
    vi.stubGlobal('createImageBitmap', undefined)
    const loader = createPlateLoader()
    expect(await loader.load('/', 'wide', 1)).toBeNull()
  })
})

describe('sidecarOk', () => {
  test('a real sidecar is fine, with the pool and the lip or without them', () => {
    expect(sidecarOk(makeSidecar())).toBe(true)
    expect(sidecarOk(makeSidecar({ pool: undefined, lip: undefined }))).toBe(true)
    expect(sidecarOk(makeSidecar({ pool: null }))).toBe(true)
    expect(sidecarOk(makeSidecar({ pool: { cx: 1, cy: 2 } }))).toBe(true) // no arcTop: nothing for the fit to hold
  })

  const broken = [
    ['null', null],
    ['a string', 'plate'],
    ['an array of nothing', []],
    ['no peakX', makeSidecar({ peakX: undefined })],
    ['peakY a string', makeSidecar({ peakY: '310' })],
    ['craterHalf NaN (null in JSON)', makeSidecar({ craterHalf: null })],
    ['valleyDepth missing', makeSidecar({ valleyDepth: undefined })],
    ['no left flank', makeSidecar({ left: undefined })],
    ['a left flank of one point', makeSidecar({ left: [{ x: 1, y: 2 }] })],
    ['a right flank that is not a list', makeSidecar({ right: { x: 1, y: 2 } })],
    ['a flank point with no y', makeSidecar({ left: [{ x: 1, y: 2 }, { x: 3 }] })],
    ['a flank point that is null', makeSidecar({ right: [{ x: 1, y: 2 }, null] })],
    ['an empty crown', makeSidecar({ crown: [] })],
    ['a valley of one point', makeSidecar({ valley: [{ x: 1, y: 1 }] })],
    ['an empty litL', makeSidecar({ litL: [] })],
    ['no litR', makeSidecar({ litR: undefined })],
    ['no rimL', makeSidecar({ rimL: undefined })],
    ['a mouthR with a string x', makeSidecar({ mouthR: { x: 'a', y: 1 } })],
    ['no vent', makeSidecar({ vent: undefined })],
    ['a pool that is a string', makeSidecar({ pool: 'lake' })],
    ['a pool with a string arcTop', makeSidecar({ pool: { cx: 1, arcTop: 'low' } })],
    ['a pool arcTop with no cx', makeSidecar({ pool: { arcTop: 900 } })],
    ['a lip that is not a point', makeSidecar({ lip: { x: 1 } })],
  ]
  test.each(broken)('%s is not usable', (_name, sidecar) => {
    expect(sidecarOk(sidecar)).toBe(false)
  })
})

describe('detectAvif', () => {
  test('true when the decoder takes a tiny AVIF', async () => {
    const decode = vi.fn(async () => ({ width: 2, height: 2 }))
    expect(await detectAvif(decode)).toBe(true)
    const [blob] = decode.mock.calls[0]
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('image/avif')
    expect(blob.size).toBeGreaterThan(100)
  })

  test('the bytes are an ISO base media file: an ftyp box of the avif brand, then boxes that tile the file', async () => {
    let bytes
    await detectAvif(async (blob) => {
      bytes = new Uint8Array(await blob.arrayBuffer())
    })
    const view = new DataView(bytes.buffer)
    expect(String.fromCharCode(...bytes.slice(4, 12))).toBe('ftypavif')
    let at = 0
    while (at < bytes.length) at += view.getUint32(at)
    expect(at).toBe(bytes.length)
  })

  test('false when the decoder refuses it', async () => {
    expect(await detectAvif(async () => { throw new Error('unsupported') })).toBe(false)
  })

  test('false when there is no decoder', async () => {
    expect(await detectAvif(undefined)).toBe(false)
  })

  test('false when the decoder hands back nothing', async () => {
    expect(await detectAvif(async () => undefined)).toBe(false)
  })
})

describe('plateState', () => {
  test('nothing set: nothing to draw', () => {
    const s = plateState()
    expect(s.current).toBeNull()
    expect(s.incoming).toBeNull()
    expect(s.tick(0, false)).toBe(0)
  })

  test('plateState crossfades over 400 ms and snaps under reduced motion', () => {
    const s = plateState()
    s.set({ id: 'a' }, 0)
    expect(s.tick(200, false)).toBeCloseTo(0.5)
    expect(s.tick(400, false)).toBe(1)
    s.set({ id: 'b' }, 1000)
    expect(s.tick(1000, true)).toBe(1)
  })

  test('FADE_MS is 400', () => {
    expect(FADE_MS).toBe(400)
  })

  test('starts at 0 and climbs in a line, never above 1, never below 0', () => {
    const s = plateState()
    s.set({ id: 'a' }, 1000)
    expect(s.tick(1000, false)).toBe(0)
    expect(s.tick(1100, false)).toBeCloseTo(0.25)
    expect(s.tick(1300, false)).toBeCloseTo(0.75)
    expect(s.tick(5000, false)).toBe(1)
    expect(s.tick(900, false)).toBe(1) // settled: a clock that runs back does not un-show it
  })

  test('a clock behind the start of the fade is 0, not negative', () => {
    const s = plateState()
    s.set({ id: 'a' }, 1000)
    expect(s.tick(500, false)).toBe(0)
  })

  test('the plate is the incoming one while it fades and the current one once it has', () => {
    const s = plateState()
    const a = { id: 'a' }
    s.set(a, 0)
    expect(s.incoming).toBe(a)
    expect(s.current).toBeNull()
    s.tick(100, false)
    expect(s.incoming).toBe(a)
    s.tick(400, false)
    expect(s.incoming).toBeNull()
    expect(s.current).toBe(a)
  })

  test('a second plate fades in over the first, which stays down until it has', () => {
    const s = plateState()
    const a = { id: 'a' }
    const b = { id: 'b' }
    s.set(a, 0)
    s.tick(400, false)
    s.set(b, 1000)
    expect(s.current).toBe(a)
    expect(s.incoming).toBe(b)
    expect(s.tick(1200, false)).toBeCloseTo(0.5)
    expect(s.current).toBe(a)
    expect(s.tick(1400, false)).toBe(1)
    expect(s.current).toBe(b)
    expect(s.incoming).toBeNull()
  })

  test('reduced motion: the plate is whole on its first tick, and is the current one', () => {
    const s = plateState()
    const a = { id: 'a' }
    s.set(a, 50)
    expect(s.tick(50, true)).toBe(1)
    expect(s.current).toBe(a)
    expect(s.incoming).toBeNull()
  })

  test('setting null clears both: the painted rock is all there is', () => {
    const s = plateState()
    s.set({ id: 'a' }, 0)
    s.tick(400, false)
    s.set({ id: 'b' }, 500)
    s.set(null, 600)
    expect(s.current).toBeNull()
    expect(s.incoming).toBeNull()
    expect(s.tick(700, false)).toBe(0)
  })
})
