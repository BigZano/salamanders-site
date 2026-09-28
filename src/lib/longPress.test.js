import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLongPress, HOLD_MS } from './longPress'

const el = { id: 'hex' }
const touch = (over = {}) => ({ pointerType: 'touch', currentTarget: el, ...over })

describe('createLongPress', () => {
  let onHold, lp
  beforeEach(() => {
    vi.useFakeTimers()
    onHold = vi.fn()
    lp = createLongPress(onHold)
  })
  afterEach(() => vi.useRealTimers())

  it('fires onHold with the pressed element once a touch is held for HOLD_MS', () => {
    lp.down(touch())
    vi.advanceTimersByTime(HOLD_MS - 1)
    expect(onHold).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onHold).toHaveBeenCalledTimes(1)
    expect(onHold).toHaveBeenCalledWith(el)
  })

  it('swallows exactly the click that ends a hold', () => {
    lp.down(touch())
    vi.advanceTimersByTime(HOLD_MS)
    expect(lp.consumeClick()).toBe(true)
    expect(lp.consumeClick()).toBe(false)
  })

  it('lets a quick tap through as a normal click', () => {
    lp.down(touch())
    vi.advanceTimersByTime(HOLD_MS - 1)
    lp.cancel()
    vi.advanceTimersByTime(HOLD_MS * 4)
    expect(onHold).not.toHaveBeenCalled()
    expect(lp.consumeClick()).toBe(false)
  })

  it.each(['mouse', 'pen', undefined, ''])('ignores %s pointers — they already hover', (pointerType) => {
    lp.down(touch({ pointerType }))
    vi.advanceTimersByTime(HOLD_MS * 4)
    expect(onHold).not.toHaveBeenCalled()
    expect(lp.consumeClick()).toBe(false)
  })

  it('a new press drops a hold whose click never came (Android sends contextmenu, not click)', () => {
    lp.down(touch())
    vi.advanceTimersByTime(HOLD_MS)
    lp.down(touch())
    lp.cancel()
    expect(lp.consumeClick()).toBe(false)
  })

  it('a second press restarts the timer rather than stacking a second hold', () => {
    lp.down(touch())
    vi.advanceTimersByTime(HOLD_MS - 10)
    lp.down(touch())
    vi.advanceTimersByTime(HOLD_MS - 1)
    expect(onHold).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onHold).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(HOLD_MS * 4)
    expect(onHold).toHaveBeenCalledTimes(1)
  })

  it('cancel after a hold fired leaves the click swallowed', () => {
    lp.down(touch())
    vi.advanceTimersByTime(HOLD_MS)
    lp.cancel()
    expect(lp.consumeClick()).toBe(true)
  })

  it('cancel with nothing pending is harmless', () => {
    expect(() => lp.cancel()).not.toThrow()
    expect(lp.consumeClick()).toBe(false)
  })

  it('honours a custom delay', () => {
    const custom = createLongPress(onHold, 100)
    custom.down(touch())
    vi.advanceTimersByTime(99)
    expect(onHold).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onHold).toHaveBeenCalledTimes(1)
  })

  it('HOLD_MS is long enough to tell a hold from a tap but short enough to feel responsive', () => {
    expect(HOLD_MS).toBeGreaterThanOrEqual(300)
    expect(HOLD_MS).toBeLessThanOrEqual(700)
  })

  it.each([null, undefined, 'fn', 42, {}])('rejects a non-function onHold (%s)', (bad) => {
    expect(() => createLongPress(bad)).toThrow(new TypeError('onHold must be a function'))
  })

  it.each([0, -1, NaN, Infinity, '450', null])('rejects a bad delay (%s)', (bad) => {
    expect(() => createLongPress(onHold, bad)).toThrow(
      new RangeError('delay must be a positive number of milliseconds'),
    )
  })
})
