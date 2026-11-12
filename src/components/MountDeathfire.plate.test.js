// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import MountDeathfire from './MountDeathfire.vue'
import { makeSidecar } from '../test-utils/plateSidecar'
import { fitPlate, mapMountain, anchorFor } from '../lib/plate'
import { mountainForRoute } from '../lib/mountain'
import { fireTuning, randomize } from '../lib/fireTuning'

// The hero over a fake canvas: MountDeathfire.vue is mounted for real (jsdom has no 2D context, so every canvas gets a
// recording stand-in), the server is a fake `fetch` that serves or withholds plates, and the frame clock is the test's
// own. What is asserted is what the page drew, and what it asked the server for.

vi.mock('../lib/plate', async (orig) => {
  const real = await orig()
  return { ...real, mapMountain: vi.fn(real.mapMountain) }
})

const contexts = new Map() // canvas -> its recording context

function fakeContext(canvas) {
  const calls = []
  const gradient = { addColorStop() {} }
  const own = {
    canvas,
    calls,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    drawImage: (...args) => calls.push({ fn: 'drawImage', args, alpha: own.globalAlpha }),
    fill: () => calls.push({ fn: 'fill', style: own.fillStyle }),
    moveTo: (...args) => calls.push({ fn: 'moveTo', args }),
    lineTo: (...args) => calls.push({ fn: 'lineTo', args }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  }
  // anything else a canvas can do is a no-op
  return new Proxy(own, { get: (t, k) => (k in t ? t[k] : () => undefined), set: (t, k, v) => ((t[k] = v), true) })
}

let clock
let rafId
let rafQueue
let reduced
let wrapper
let router

beforeEach(() => {
  clock = 1000
  rafId = 0
  rafQueue = new Map()
  reduced = false
  contexts.clear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (type) {
    if (type !== '2d') return null
    if (!contexts.has(this)) contexts.set(this, fakeContext(this))
    return contexts.get(this)
  })
  vi.stubGlobal('Path2D', class { moveTo() {} lineTo() {} arc() {} closePath() {} })
  vi.stubGlobal('requestAnimationFrame', (cb) => (rafQueue.set(++rafId, cb), rafId))
  vi.stubGlobal('cancelAnimationFrame', (id) => rafQueue.delete(id))
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  window.matchMedia = (q) => ({ matches: reduced && q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {} })
  window.history.replaceState(null, '', '/?lava=0') // the WebGL layer is not under test, and is not fetched
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {}) // the lava network says in dev when a stream drains to the pool
  mapMountain.mockReset()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete window.matchMedia
  delete window.requestIdleCallback
  delete window.cancelIdleCallback
})

const setViewport = (w, h) => {
  for (const [k, v] of [['innerWidth', w], ['innerHeight', h]]) Object.defineProperty(window, k, { value: v, configurable: true, writable: true })
}

const IMAGE = { width: 1920, height: 1200 }

/** A fake server. `serve(url)` says 'ok', 'missing' (404) or 'page' (200 with a page, not JSON), and may be async to hold a plate. */
function installServer({ serve = () => 'ok', sidecar = makeSidecar(), size = IMAGE } = {}) {
  const asked = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      asked.push(url)
      const verdict = await serve(url)
      if (verdict === 'missing') return { ok: false, status: 404 }
      if (url.endsWith('.json')) return { ok: true, status: 200, json: async () => (verdict === 'page' ? JSON.parse('<html>') : sidecar) }
      return { ok: true, status: 200, blob: async () => ({ url }) }
    }),
  )
  vi.stubGlobal('createImageBitmap', vi.fn(async (blob) => ({ ...size, url: blob.url, close() {} })))
  return { asked, jsons: () => asked.filter((u) => u.endsWith('.json')) }
}

/** A gate: `serve` can await `gate.wait` to keep a plate in flight until the test opens it. */
function gate() {
  let open
  const wait = new Promise((resolve) => (open = resolve))
  return { wait, open }
}

/** Mounts the hero on `path` in a window of w by h. Does not let anything settle: the caller does. */
async function openPage(path, { w = 1300, h = 773, ...server } = {}) {
  setViewport(w, h)
  const s = installServer(server)
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] })
  await router.push(path)
  await router.isReady()
  wrapper = mount(MountDeathfire, { global: { plugins: [router] }, attachTo: document.body })
  return s
}

// jsdom's style parser drops a gradient, so the glow is read from the component's own computed style
const glowBackground = () => wrapper.vm.glowStyle.background
const mainContext = () => wrapper.find('canvas.deathfire-canvas').element.getContext('2d') // made on first ask, like the page's own

/** Runs the frame callbacks that are queued, `ms` later on the clock. */
function runFrame(ms = 40) {
  clock += ms
  const queued = [...rafQueue.values()]
  rafQueue.clear()
  for (const cb of queued) cb(clock)
}

// the far ridges' fill (MountDeathfire.vue buildRidgeLayer), which nothing else on the page is filled with
const RIDGE_FILL = 'rgba(9, 18, 15,'

function kindOf(img) {
  if (img.url?.includes('.sky.')) return 'sky'
  if (img.url?.includes('.rock.')) return 'rock'
  if (img.width === window.innerWidth && img.height === window.innerHeight) {
    // a cached layer of the rock, one window big: the far ridges (every fill in their colour) or the painted cone
    const fills = contexts.get(img)?.calls.filter((c) => c.fn === 'fill') ?? []
    return fills.length && fills.every((c) => String(c.style).startsWith(RIDGE_FILL)) ? 'ridges' : 'painted'
  }
  return img.width === 64 ? 'glow' : 'moon'
}

/** The points a cached layer was painted through, as [x, y] pairs: every moveTo and lineTo, in order. */
const pathOf = (image) =>
  contexts
    .get(image)
    .calls.filter((c) => c.fn === 'moveTo' || c.fn === 'lineTo')
    .map((c) => c.args)

/** What the main canvas was handed to draw, in order, as { kind, alpha, args } (args after the image). */
const drawn = () =>
  mainContext()
    .calls.filter((c) => c.fn === 'drawImage')
    .map((c) => ({ kind: kindOf(c.args[0]), alpha: c.alpha, args: c.args.slice(1), image: c.args[0] }))

/** One frame, and what it drew. */
function frameDraws(ms) {
  mainContext().calls.length = 0
  runFrame(ms)
  return drawn()
}

const only = (draws, kind) => draws.filter((d) => d.kind === kind)

async function resizeTo(w, h) {
  setViewport(w, h)
  window.dispatchEvent(new Event('resize'))
  runFrame()
  await flushPromises()
}

const expectedFit = (w, h) => fitPlate({ imageW: IMAGE.width, imageH: IMAGE.height, w, h, anchor: anchorFor(makeSidecar()) })

describe('with no plate on the server', () => {
  test('a plate is asked for once however the page moves: a route change to a route with the same plate, a resize that keeps the bucket', async () => {
    const s = await openPage('/planner', { serve: () => 'missing' })
    await flushPromises()
    runFrame()
    expect(s.jsons()).toEqual(['/plates/default/wide.json'])
    await router.push('/roster')
    await flushPromises()
    await router.push('/armoury')
    await flushPromises()
    await resizeTo(1280, 720)
    await resizeTo(1500, 800)
    runFrame()
    expect(s.asked).toEqual(['/plates/default/wide.json']) // one request: the images are not asked for when the sidecar is not there
  })

  test('another window shape is another plate, asked for once, and back again is not asked for twice', async () => {
    const s = await openPage('/planner', { serve: () => 'missing' })
    await flushPromises()
    await resizeTo(390, 844)
    await resizeTo(1300, 773)
    await resizeTo(390, 844)
    expect(s.jsons()).toEqual(['/plates/default/wide.json', '/plates/default/portrait.json'])
  })

  test('the painted rock draws whole, at full alpha, from the mountain the builder makes: its far ridges, then the cone', async () => {
    await openPage('/planner', { serve: () => 'missing' })
    await flushPromises()
    const draws = frameDraws()
    expect(only(draws, 'sky')).toHaveLength(0)
    expect(only(draws, 'rock')).toHaveLength(0)
    const [painted, ...extra] = only(draws, 'painted')
    expect(extra).toHaveLength(0)
    expect(painted.alpha).toBe(1)
    expect(painted.args).toEqual([0, 0, 1300, 773])
    // what it painted: the mountain mountainForRoute makes at this size for this route, alone on its layer
    const { mountain } = mountainForRoute({ path: '/planner', w: 1300, h: 773, tune: fireTuning.bed, randomize })
    const lines = contexts.get(painted.image).calls.filter((c) => c.fn === 'lineTo').map((c) => c.args)
    expect(lines).toContainEqual([mountain.rimL.x, mountain.rimL.y])
    expect(lines).toContainEqual([mountain.rimR.x, mountain.rimR.y])
    for (const p of mountain.crown) expect(lines).toContainEqual([p.x, p.y])
    expect(contexts.get(painted.image).calls.filter((c) => c.fn === 'moveTo')).toHaveLength(1)
    // and the far ridges on a layer of their own, whole, just before it: one moveTo each, as many as the tuning asks for
    const kinds = draws.map((d) => d.kind)
    expect(only(draws, 'ridges')).toHaveLength(1)
    const [ridges] = only(draws, 'ridges')
    expect(ridges.alpha).toBe(1)
    expect(ridges.args).toEqual([0, 0, 1300, 773])
    expect(kinds.indexOf('ridges')).toBe(kinds.indexOf('painted') - 1)
    expect(contexts.get(ridges.image).calls.filter((c) => c.fn === 'moveTo')).toHaveLength(Math.round(fireTuning.bed.ridges))
  })

  test('the same on the hero', async () => {
    await openPage('/', { serve: () => 'missing' })
    await flushPromises()
    const [painted] = only(frameDraws(), 'painted')
    expect(painted.alpha).toBe(1)
    const { mountain } = mountainForRoute({ path: '/', w: 1300, h: 773, tune: fireTuning.bed, randomize })
    const lines = contexts.get(painted.image).calls.filter((c) => c.fn === 'lineTo').map((c) => c.args)
    expect(lines).toContainEqual([mountain.rimL.x, mountain.rimL.y])
  })

  test('there is no console error or warning', async () => {
    await openPage('/planner', { serve: () => 'missing' })
    await flushPromises()
    runFrame()
    await resizeTo(390, 844)
    expect(console.error).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })

  test('the glow stays under the route\'s own peak', async () => {
    await openPage('/planner', { serve: () => 'missing' })
    await flushPromises()
    const { face } = mountainForRoute({ path: '/planner', w: 1300, h: 773, tune: fireTuning.bed, randomize })
    expect(glowBackground()).toContain(`at ${(face * 100).toFixed(0)}% 100%`)
  })
})

describe('with a plate', () => {
  test('the sky goes down before the moon, the rock after the painted one, and both are the plate\'s pictures', async () => {
    const s = await openPage('/planner')
    await flushPromises()
    expect(s.asked).toEqual(
      expect.arrayContaining(['/plates/default/wide.json', '/plates/default/wide.sky.avif', '/plates/default/wide.rock.avif']),
    )
    clock += 400 // the fade is over
    const draws = frameDraws(0)
    const kinds = draws.map((d) => d.kind)
    expect(kinds).toContain('sky')
    expect(kinds).toContain('moon')
    expect(kinds).toContain('rock')
    expect(kinds.indexOf('sky')).toBeLessThan(kinds.indexOf('moon'))
    expect(kinds.indexOf('moon')).toBeLessThan(kinds.indexOf('rock'))
    expect(only(draws, 'sky')[0].image.url).toBe('/plates/default/wide.sky.avif')
    expect(only(draws, 'rock')[0].image.url).toBe('/plates/default/wide.rock.avif')
    expect(only(draws, 'sky')[0].alpha).toBe(1)
    expect(only(draws, 'rock')[0].alpha).toBe(1)
    expect(only(draws, 'painted')).toHaveLength(0) // once it has faded in, only the plate's rock
  })

  test('both pictures are drawn with the cover-fit of the decoded image to the window', async () => {
    await openPage('/planner')
    await flushPromises()
    clock += 400
    const draws = frameDraws(0)
    const fit = expectedFit(1300, 773)
    const box = [fit.dx, fit.dy, IMAGE.width * fit.scale, IMAGE.height * fit.scale]
    expect(only(draws, 'sky')[0].args).toEqual(box)
    expect(only(draws, 'rock')[0].args).toEqual(box)
  })

  test('the mountain is the sidecar\'s, mapped through that fit: the painted rock under it, the lava and the plume follow it', async () => {
    await openPage('/planner')
    await flushPromises()
    const mapped = mapMountain(makeSidecar(), expectedFit(1300, 773))
    expect(mapMountain).toHaveBeenCalledWith(makeSidecar(), expectedFit(1300, 773))
    const draws = frameDraws(10)
    const [painted] = only(draws, 'painted')
    const calls = contexts.get(painted.image).calls
    expect(calls.filter((c) => c.fn === 'lineTo').map((c) => c.args)).toContainEqual([mapped.rimL.x, mapped.rimL.y])
    expect(calls.filter((c) => c.fn === 'moveTo')).toHaveLength(1) // the painted cone's layer is the cone alone
    expect(calls.find((c) => c.fn === 'moveTo').args).toEqual([mapped.left[mapped.left.length - 1].x, 773 + 20])
    // and the vent the lava leaves from (live mode: the forge's hands are on the page in dev)
    expect(window.__forge.actions.geometry().vent).toEqual(mapped.vent)
  })

  test('the plate is asked for with the route\'s profile key and the window\'s bucket: / is home', async () => {
    const s = await openPage('/')
    await flushPromises()
    expect(s.jsons()).toContain('/plates/home/wide.json')
  })

  test('it fades in over 400 ms: the painted cone goes down at 1 - a and the plate over it at a, the far ridges whole under both', async () => {
    await openPage('/planner')
    await flushPromises() // arrived at clock 1000
    let draws = frameDraws(0)
    expect(only(draws, 'sky')).toHaveLength(0) // not yet: nothing of it is visible at a = 0
    expect(only(draws, 'painted')[0].alpha).toBe(1)
    expect(only(draws, 'ridges')[0].alpha).toBe(1)
    draws = frameDraws(200)
    expect(only(draws, 'sky')[0].alpha).toBeCloseTo(0.5)
    expect(only(draws, 'rock')[0].alpha).toBeCloseTo(0.5)
    expect(only(draws, 'painted')[0].alpha).toBeCloseTo(0.5)
    expect(only(draws, 'ridges')[0].alpha).toBe(1)
    const kinds = draws.map((d) => d.kind)
    expect(kinds.indexOf('ridges')).toBeLessThan(kinds.indexOf('painted'))
    expect(kinds.indexOf('painted')).toBeLessThan(kinds.indexOf('rock')) // the plate goes over the painted rock
    draws = frameDraws(200)
    expect(only(draws, 'sky')[0].alpha).toBe(1)
    expect(only(draws, 'rock')[0].alpha).toBe(1)
    expect(only(draws, 'painted')).toHaveLength(0)
    expect(only(draws, 'ridges')[0].alpha).toBe(1)
  })

  test('under reduced motion there is no crossfade: the plate is whole the moment it lands, and the painted rock is not drawn', async () => {
    reduced = true
    await openPage('/planner')
    mainContext().calls.length = 0 // the still frame at mount is painted; what matters is what the plate's arrival draws
    await flushPromises()
    const draws = drawn()
    expect(draws.length).toBeGreaterThan(0)
    expect(only(draws, 'sky')[0].alpha).toBe(1)
    expect(only(draws, 'rock')[0].alpha).toBe(1)
    expect(only(draws, 'painted')).toHaveLength(0)
    expect(wrapper.find('.deathfire').attributes('data-mode')).toBe('still')
  })

  test('the painted glow follows the plate\'s peak while it fades in', async () => {
    await openPage('/planner')
    await flushPromises()
    const mapped = mapMountain(makeSidecar(), expectedFit(1300, 773))
    expect(glowBackground()).toContain(`at ${((mapped.peakX / 1300) * 100).toFixed(0)}% 100%`)
  })

  test('a route that shares the plate keeps it, with no new request and no gap', async () => {
    const s = await openPage('/planner')
    await flushPromises()
    runFrame(500)
    const before = s.asked.length
    await router.push('/roster')
    await flushPromises()
    expect(s.asked).toHaveLength(before)
    const draws = frameDraws()
    expect(only(draws, 'sky')[0].alpha).toBe(1)
    expect(only(draws, 'rock')[0].alpha).toBe(1)
    expect(only(draws, 'painted')).toHaveLength(0)
  })

  test('a route with a plate of its own drops the other one at once, and fades its own in', async () => {
    const home = gate()
    const s = await openPage('/planner', { serve: async (url) => (url.includes('/home/') ? (await home.wait, 'ok') : 'ok') })
    await flushPromises()
    runFrame(500)
    await router.push('/')
    await nextTick()
    // the home plate is on its way: until it is here the painted rock is up, and the default plate is not drawn under the new mountain
    let draws = frameDraws()
    expect(only(draws, 'sky')).toHaveLength(0)
    expect(only(draws, 'painted')).toHaveLength(1)
    home.open()
    await flushPromises()
    expect(s.jsons()).toEqual(['/plates/default/wide.json', '/plates/home/wide.json'])
    draws = frameDraws(500)
    expect(only(draws, 'sky')[0].image.url).toBe('/plates/home/wide.sky.avif')
  })

  test('a resize that changes the bucket drops the plate for the new window, then fits the right one', async () => {
    const s = await openPage('/planner')
    await flushPromises()
    runFrame(500)
    expect(only(frameDraws(), 'sky')[0].image.url).toBe('/plates/default/wide.sky.avif')
    const hold = gate()
    s.asked.length = 0
    // the portrait plate is held back
    fetch.mockImplementation(async (url) => {
      s.asked.push(url)
      await hold.wait
      if (url.endsWith('.json')) return { ok: true, status: 200, json: async () => makeSidecar() }
      return { ok: true, status: 200, blob: async () => ({ url }) }
    })
    await resizeTo(390, 844)
    const draws = frameDraws()
    expect(only(draws, 'sky')).toHaveLength(0) // the wide plate is not stretched over a phone
    expect(only(draws, 'painted')).toHaveLength(1)
    hold.open()
    await flushPromises()
    clock += 500
    const after = frameDraws(0)
    expect(only(after, 'sky')[0].image.url).toBe('/plates/default/portrait.sky.avif')
    const fit = expectedFit(390, 844)
    expect(only(after, 'sky')[0].args).toEqual([fit.dx, fit.dy, IMAGE.width * fit.scale, IMAGE.height * fit.scale])
  })
})

describe('the far ridges with a plate up', () => {
  test('they are drawn under the plate\'s rock, whole, once a frame, after the moon: before it lands, while it fades in and after', async () => {
    await openPage('/planner')
    await flushPromises() // the plate landed at clock 1000
    for (const ms of [0, 100, 200, 300, 100, 500]) {
      const draws = frameDraws(ms)
      const kinds = draws.map((d) => d.kind)
      const ridges = only(draws, 'ridges')
      expect(ridges).toHaveLength(1) // never twice: the painted cone's layer has none of them
      expect(ridges[0].alpha).toBe(1)
      expect(ridges[0].args).toEqual([0, 0, 1300, 773])
      expect(kinds.indexOf('moon')).toBeLessThan(kinds.indexOf('ridges'))
      if (kinds.includes('rock')) expect(kinds.indexOf('ridges')).toBeLessThan(kinds.indexOf('rock'))
      if (kinds.includes('painted')) expect(kinds.indexOf('ridges')).toBeLessThan(kinds.indexOf('painted'))
    }
  })

  test('they are the painted ones the page had before the plate came, point for point: nothing moves when it lands', async () => {
    const held = gate()
    await openPage('/planner', { serve: async () => (await held.wait, 'ok') })
    await flushPromises()
    const before = pathOf(only(frameDraws(), 'ridges')[0].image)
    expect(only(frameDraws(), 'rock')).toHaveLength(0) // still on its way
    held.open()
    await flushPromises()
    clock += 400
    const draws = frameDraws(0)
    expect(only(draws, 'rock')[0].alpha).toBe(1)
    expect(pathOf(only(draws, 'ridges')[0].image)).toEqual(before)
    expect(before.length).toBeGreaterThan(0)
  })

  test('under reduced motion they are under the plate the moment it lands', async () => {
    reduced = true
    await openPage('/planner')
    mainContext().calls.length = 0
    await flushPromises()
    const draws = drawn()
    const kinds = draws.map((d) => d.kind)
    expect(only(draws, 'ridges')[0].alpha).toBe(1)
    expect(kinds.indexOf('ridges')).toBeLessThan(kinds.indexOf('rock'))
    expect(only(draws, 'painted')).toHaveLength(0)
  })

  test('a resize rebuilds them for the new window, still under the plate', async () => {
    await openPage('/planner')
    await flushPromises()
    runFrame(500)
    await resizeTo(1280, 720)
    clock += 500
    const draws = frameDraws(0)
    expect(only(draws, 'ridges')[0].args).toEqual([0, 0, 1280, 720])
    expect(only(draws, 'rock')[0].alpha).toBe(1)
  })
})

describe('an answer that comes back after the page has moved on is dropped', () => {
  test('a route change while a plate is loading never paints the old route\'s plate', async () => {
    const home = gate()
    const s = await openPage('/', { serve: async (url) => (url.includes('/home/') ? (await home.wait, 'ok') : 'ok') })
    await flushPromises() // home's plate is in flight
    await router.push('/planner') // and the page goes somewhere else, whose plate is not held
    await flushPromises()
    clock += 500
    let draws = frameDraws(0)
    expect(only(draws, 'sky')[0].image.url).toBe('/plates/default/wide.sky.avif')
    home.open() // the old route's plate lands
    await flushPromises()
    for (const ms of [40, 100, 600]) {
      draws = frameDraws(ms)
      for (const d of [...only(draws, 'sky'), ...only(draws, 'rock')]) expect(d.image.url).toContain('/default/')
      expect(only(draws, 'sky')).toHaveLength(1)
    }
    expect(s.jsons()).toContain('/plates/home/wide.json')
  })

  test('and when the route it went to has no plate, the old one is still not painted: the painted rock stays', async () => {
    const home = gate()
    await openPage('/', { serve: async (url) => (url.includes('/home/') ? (await home.wait, 'ok') : 'missing') })
    await flushPromises()
    await router.push('/planner')
    await flushPromises()
    home.open()
    await flushPromises()
    for (const ms of [40, 100, 600]) {
      const draws = frameDraws(ms)
      expect(only(draws, 'sky')).toHaveLength(0)
      expect(only(draws, 'rock')).toHaveLength(0)
      expect(only(draws, 'painted')[0].alpha).toBe(1)
    }
  })

  test('a resize to another window shape while a plate is loading drops it too', async () => {
    const wide = gate()
    await openPage('/planner', { serve: async (url) => (url.includes('/wide.') ? (await wide.wait, 'ok') : 'ok') })
    await flushPromises()
    await resizeTo(390, 844)
    wide.open()
    await flushPromises()
    clock += 500
    const draws = frameDraws(0)
    expect(only(draws, 'sky')).toHaveLength(1)
    expect(only(draws, 'sky')[0].image.url).toBe('/plates/default/portrait.sky.avif')
  })

  test('a plate that lands after the page is gone is not drawn and does not throw', async () => {
    const late = gate()
    await openPage('/planner', { serve: async () => (await late.wait, 'ok') })
    await flushPromises()
    const ctx = mainContext()
    wrapper.unmount()
    wrapper = null
    const before = ctx.calls.length
    late.open()
    await flushPromises()
    expect(ctx.calls.length).toBe(before)
    expect(console.error).not.toHaveBeenCalled()
  })
})

describe('a plate that cannot be used is a plate that is not there', () => {
  test('a sidecar with the numbers missing: painted rock, no error, no second try', async () => {
    const s = await openPage('/planner', { sidecar: { peakX: 100 } })
    await flushPromises()
    await resizeTo(1280, 720)
    await router.push('/roster')
    await flushPromises()
    expect(s.asked).toEqual(['/plates/default/wide.json'])
    const draws = frameDraws()
    expect(only(draws, 'sky')).toHaveLength(0)
    expect(only(draws, 'painted')[0].alpha).toBe(1)
    expect(console.error).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })

  test('a server that answers with a page, not JSON (the dev server does): the same', async () => {
    const s = await openPage('/planner', { serve: () => 'page' })
    await flushPromises()
    await resizeTo(1280, 720)
    expect(s.asked).toEqual(['/plates/default/wide.json'])
    expect(only(frameDraws(), 'painted')[0].alpha).toBe(1)
    expect(console.error).not.toHaveBeenCalled()
  })

  test('a mapping that throws: painted rock, no error, and the plate is not asked for again', async () => {
    mapMountain.mockImplementationOnce(() => {
      throw new Error('not a mountain')
    })
    const s = await openPage('/planner')
    await flushPromises()
    const asked = s.asked.length
    await resizeTo(1280, 720)
    await router.push('/roster')
    await flushPromises()
    expect(s.asked).toHaveLength(asked)
    const draws = frameDraws()
    expect(only(draws, 'sky')).toHaveLength(0)
    expect(only(draws, 'rock')).toHaveLength(0)
    expect(only(draws, 'painted')[0].alpha).toBe(1)
    expect(console.error).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })

  test('a mapping that throws on a resize, with the plate up, drops the plate too', async () => {
    const s = await openPage('/planner')
    await flushPromises()
    runFrame(500)
    expect(only(frameDraws(), 'sky')).toHaveLength(1)
    mapMountain.mockImplementationOnce(() => {
      throw new Error('not a mountain')
    })
    const asked = s.asked.length
    await resizeTo(1280, 720)
    runFrame()
    expect(only(frameDraws(), 'sky')).toHaveLength(0)
    expect(only(frameDraws(), 'painted')[0].alpha).toBe(1)
    await resizeTo(1300, 773)
    expect(s.asked).toHaveLength(asked)
    expect(only(frameDraws(), 'sky')).toHaveLength(0)
  })
})

describe('prefetch on idle', () => {
  test('on / the wide and the portrait plate of the hero are fetched when the browser is idle', async () => {
    const idle = []
    window.requestIdleCallback = vi.fn((cb) => (idle.push(cb), 7))
    window.cancelIdleCallback = vi.fn()
    const s = await openPage('/', { serve: () => 'missing' })
    await flushPromises()
    expect(window.requestIdleCallback).toHaveBeenCalledTimes(1)
    expect(s.jsons()).toEqual(['/plates/home/wide.json']) // the window's own, not waiting for idle
    idle.forEach((cb) => cb())
    await flushPromises()
    expect(s.jsons()).toEqual(['/plates/home/wide.json', '/plates/home/portrait.json'])
  })

  test('where there is no requestIdleCallback it is a timer, and the page still comes up', async () => {
    const timers = vi.spyOn(window, 'setTimeout')
    const s = await openPage('/', { serve: () => 'missing' })
    await flushPromises()
    const idle = timers.mock.calls.find(([, ms]) => ms === 2000)
    expect(idle).toBeTruthy()
    idle[0]()
    await flushPromises()
    expect(s.jsons()).toContain('/plates/home/portrait.json')
  })

  test('on any other route nothing is fetched ahead', async () => {
    const idle = []
    window.requestIdleCallback = vi.fn((cb) => (idle.push(cb), 7))
    window.cancelIdleCallback = vi.fn()
    const s = await openPage('/planner', { serve: () => 'missing' })
    await flushPromises()
    expect(window.requestIdleCallback).not.toHaveBeenCalled()
    expect(s.jsons()).toEqual(['/plates/default/wide.json'])
  })

  test('the idle callback is cancelled when the page goes', async () => {
    window.requestIdleCallback = vi.fn(() => 7)
    window.cancelIdleCallback = vi.fn()
    await openPage('/', { serve: () => 'missing' })
    await flushPromises()
    wrapper.unmount()
    wrapper = null
    expect(window.cancelIdleCallback).toHaveBeenCalledWith(7)
  })

  test('under reduced motion the prefetch is queued all the same', async () => {
    reduced = true
    window.requestIdleCallback = vi.fn(() => 7)
    window.cancelIdleCallback = vi.fn()
    await openPage('/', { serve: () => 'missing' })
    await flushPromises()
    expect(window.requestIdleCallback).toHaveBeenCalledTimes(1)
  })
})
