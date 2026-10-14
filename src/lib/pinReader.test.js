// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, watch } from 'vue'
import { INSTANT_CLASS, openNow, withReaderPinned } from './pinReader'

let frames
let scrollBy
const root = () => document.documentElement
const flushFrames = () => {
  // each pass runs the callbacks queued so far; settle needs two
  for (let i = 0; i < 2; i++) frames.splice(0).forEach((cb) => cb(0))
}

// An element whose rect we control. `rect` is mutable so a test can move it "during" mutate.
const box = (top, bottom) => {
  const el = document.createElement('div')
  el.rect = { top, bottom }
  el.getBoundingClientRect = () => ({ ...el.rect, height: el.rect.bottom - el.rect.top })
  return el
}

beforeEach(() => {
  frames = []
  scrollBy = vi.fn()
  window.scrollBy = scrollBy
  window.innerHeight = 800
  vi.stubGlobal('requestAnimationFrame', (cb) => frames.push(cb))
})
afterEach(() => {
  vi.unstubAllGlobals()
  root().classList.remove(INSTANT_CLASS)
})

describe('withReaderPinned', () => {
  it('pins the branch that contains the reading line', async () => {
    const [a, b, c] = [box(-300, 100), box(100, 500), box(500, 900)] // the line is at 280, inside b
    await withReaderPinned([a, b, c], () => { b.rect = { top: 400, bottom: 800 } })
    expect(scrollBy).toHaveBeenCalledWith({ top: 300, behavior: 'instant' })
  })

  it('falls back to the nearest branch when none contains the line', async () => {
    const [a, b] = [box(100, 200), box(600, 900)]
    await withReaderPinned([a, b], () => { a.rect = { top: 150, bottom: 250 } })
    expect(scrollBy).toHaveBeenCalledWith({ top: 50, behavior: 'instant' })
  })

  it('clamps the pinned bar between 90 and 60% of the viewport', async () => {
    const high = box(20, 400) // contains the line, sits above 90: pinned to 90
    await withReaderPinned([high], () => {})
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -70, behavior: 'instant' })
    const low = box(900, 1200) // nearest, sits below 480: pinned to 480
    await withReaderPinned([low], () => {})
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 420, behavior: 'instant' })
  })

  it('does not scroll when nothing moved', async () => {
    await withReaderPinned([box(100, 500)], () => {})
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('with no items just runs mutate and never scrolls', async () => {
    const mutate = vi.fn()
    await withReaderPinned([], mutate)
    expect(mutate).toHaveBeenCalledOnce()
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('waits one Vue tick, so the DOM is patched before it measures', async () => {
    const order = []
    const state = ref(0)
    watch(state, () => order.push('patched'), { flush: 'post' })
    scrollBy.mockImplementation(() => order.push('scrolled'))
    const b = box(100, 500)
    await withReaderPinned([b], () => { state.value = 1; b.rect = { top: 400, bottom: 800 } })
    expect(order).toEqual(['patched', 'scrolled'])
  })

  it('has the instant class during mutate, and removes it two frames later', async () => {
    let during
    await withReaderPinned([box(100, 500)], () => { during = root().classList.contains(INSTANT_CLASS) })
    expect(during).toBe(true)
    expect(root().classList.contains(INSTANT_CLASS)).toBe(true) // still waiting on the frames
    flushFrames()
    expect(root().classList.contains(INSTANT_CLASS)).toBe(false)
  })

  it('removes the class even when mutate throws', async () => {
    await expect(withReaderPinned([box(0, 100)], () => { throw new Error('boom') })).rejects.toThrow('boom')
    flushFrames()
    expect(root().classList.contains(INSTANT_CLASS)).toBe(false)
  })
})

describe('openNow', () => {
  it('runs open once, waits a tick, and cleans up', async () => {
    const open = vi.fn()
    let during
    await openNow(() => { open(); during = root().classList.contains(INSTANT_CLASS) })
    expect(open).toHaveBeenCalledOnce()
    expect(during).toBe(true)
    flushFrames()
    expect(root().classList.contains(INSTANT_CLASS)).toBe(false)
  })

  it('removes the class even when open throws', async () => {
    await expect(openNow(() => { throw new Error('nope') })).rejects.toThrow('nope')
    flushFrames()
    expect(root().classList.contains(INSTANT_CLASS)).toBe(false)
  })

  it('also waits for the Vue tick', async () => {
    const seen = []
    const state = ref(0)
    watch(state, () => seen.push('patched'), { flush: 'post' })
    await openNow(() => { state.value = 1 })
    expect(seen).toEqual(['patched'])
  })
})
