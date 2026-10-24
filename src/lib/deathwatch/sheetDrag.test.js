import { describe, it, expect } from 'vitest'
import { DISMISS_RATIO, DISMISS_VELOCITY, MIN_FLICK, dragOffset, shouldDismiss } from './sheetDrag'

describe('the dismiss thresholds', () => {
  it('are a 40% drag, 0.11 px/ms, and a 20px minimum flick', () => {
    expect(DISMISS_RATIO).toBe(0.4)
    expect(DISMISS_VELOCITY).toBe(0.11)
    expect(MIN_FLICK).toBe(20)
  })
})

describe('dragOffset', () => {
  it('follows the finger downwards one to one', () => {
    expect(dragOffset(30)).toBe(30)
    expect(dragOffset(0)).toBe(0) // and a positive zero, not -0
  })

  it('applies friction to an upward drag past the open position', () => {
    expect(dragOffset(-100)).toBe(-10)
    expect(dragOffset(-4)).toBe(-2)
    expect(dragOffset(-0.25)).toBe(-0.5)
  })

  it('gives zero for anything that is not a finite number', () => {
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, '5', {}]) {
      expect(dragOffset(bad), String(bad)).toBe(0)
    }
  })
})

describe('shouldDismiss', () => {
  // A slow drag on a 400px sheet: 5s for up to ~300px is under 0.11 px/ms, so only the distance can dismiss it.
  const sheet = { elapsedMs: 5000, height: 400 }

  it('dismisses once the sheet has been dragged 40% of its height, and not a pixel before', () => {
    expect(shouldDismiss({ ...sheet, distance: 160 })).toBe(true)
    expect(shouldDismiss({ ...sheet, distance: 159 })).toBe(false)
    expect(shouldDismiss({ ...sheet, distance: 300 })).toBe(true)
  })

  it('dismisses on a flick even a short way', () => {
    expect(shouldDismiss({ distance: 40, elapsedMs: 100, height: 400 })).toBe(true) // 0.4 px/ms
  })

  it('needs at least 20px to count as a flick', () => {
    expect(shouldDismiss({ distance: 20, elapsedMs: 10, height: 400 })).toBe(true)
    expect(shouldDismiss({ distance: 19, elapsedMs: 1, height: 400 })).toBe(false)
  })

  it('needs more than 0.11 px/ms, not exactly that', () => {
    expect(shouldDismiss({ distance: 22, elapsedMs: 200, height: 400 })).toBe(false) // exactly 0.11
    expect(shouldDismiss({ distance: 23, elapsedMs: 200, height: 400 })).toBe(true) // 0.115
  })

  it('ignores the velocity rule when the elapsed time is zero, negative or not a number', () => {
    for (const elapsedMs of [0, -5, NaN]) {
      // no division by zero: a 30px drag with no usable clock is not a flick...
      expect(shouldDismiss({ distance: 30, elapsedMs, height: 400 }), String(elapsedMs)).toBe(false)
      // ...but the distance rule still works
      expect(shouldDismiss({ distance: 200, elapsedMs, height: 400 }), String(elapsedMs)).toBe(true)
    }
  })

  it('never dismisses an upward or zero drag', () => {
    expect(shouldDismiss({ distance: -300, elapsedMs: 1, height: 400 })).toBe(false)
    expect(shouldDismiss({ distance: 0, elapsedMs: 1, height: 400 })).toBe(false)
  })

  it('never dismisses when the distance or the sheet height is unusable', () => {
    expect(shouldDismiss({ distance: Infinity, elapsedMs: 100, height: 400 })).toBe(false)
    expect(shouldDismiss({ distance: NaN, elapsedMs: 100, height: 400 })).toBe(false)
    for (const height of [0, -400, NaN, Infinity, undefined]) {
      expect(shouldDismiss({ distance: 50, elapsedMs: 100, height }), String(height)).toBe(false)
    }
  })
})
