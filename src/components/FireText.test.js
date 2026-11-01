// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import FireText from './FireText.vue'

/*
 * jsdom has no canvas, so the 2D context here is a stand-in that records what the component asks of it.
 * One piece of real behaviour is kept on purpose, because it is the piece that broke in Chrome:
 * createImageData takes integers and throws a TypeError for NaN or Infinity.
 */
const label = () => wrapper.get('.firetext-label')
const canvas = () => wrapper.get('canvas').element

let wrapper
let rect // what the label's getBoundingClientRect reports
let observers // every ResizeObserver the component created
let createImageData
let releaseFonts // lets start() go on, for the tests that hold it back

function strictCreateImageData(w, h) {
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    throw new TypeError(
      "Failed to execute 'createImageData' on 'CanvasRenderingContext2D': Value is not of type 'long'.",
    )
  }
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
}

function context() {
  return {
    createImageData,
    measureText: () => ({ actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 5 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    setTransform() {},
    clearRect() {},
    fillRect() {},
    drawImage() {},
    putImageData() {},
    fillText() {},
  }
}

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback
    observers.push(this)
  }
  observe() {}
  disconnect() {}
}

/** Tell the component its label changed size, the way the browser does. */
const resize = () => observers.forEach((o) => o.callback([], o))

beforeEach(() => {
  rect = { width: 400, height: 80 }
  observers = []
  createImageData = vi.fn(strictCreateImageData)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => rect)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(context)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  // Reduced motion: start() paints one frame and stops, so no animation loop outlives a test.
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  delete document.fonts
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Hold start() at its wait for the display face, as it is when the first resize arrives. */
function holdFonts() {
  const ready = new Promise((resolve) => (releaseFonts = resolve))
  Object.defineProperty(document, 'fonts', { value: { ready }, configurable: true })
}

describe('FireText layout', () => {
  it('lays the fire out at the measured size', async () => {
    wrapper = mount(FireText, { props: { text: 'SALAMANDERS' } })
    await flushPromises()

    // 400px label plus 4px of bleed either side, at a device pixel ratio of 1.
    expect(canvas().width).toBe(408)
    expect(canvas().height).toBe(80)
    expect(createImageData).toHaveBeenCalledWith(204, 30)
    expect(label().classes()).toContain('lit')
  })

  it.each([
    ['a NaN width', { width: NaN, height: 80 }],
    ['a NaN height', { width: 400, height: NaN }],
    ['an infinite width', { width: Infinity, height: 80 }],
    ['an infinite height', { width: 400, height: Infinity }],
  ])('skips a resize measured with %s, then lays out once it can be measured', async (_, bad) => {
    holdFonts()
    rect = bad
    wrapper = mount(FireText, { props: { text: 'SALAMANDERS' } })
    const untouched = { width: canvas().width, height: canvas().height }

    expect(resize).not.toThrow()
    expect(createImageData).not.toHaveBeenCalled()
    expect(canvas().width).toBe(untouched.width)
    expect(canvas().height).toBe(untouched.height)
    expect(canvas().style.width).toBe('')

    rect = { width: 400, height: 80 }
    expect(resize).not.toThrow()
    expect(canvas().width).toBe(408)
    expect(canvas().style.width).toBe('408px')
    expect(createImageData).toHaveBeenCalledTimes(1)
    expect(createImageData).toHaveBeenCalledWith(204, 30)

    releaseFonts()
    await flushPromises()
  })
})
