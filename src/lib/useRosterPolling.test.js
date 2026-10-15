// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useRosterPolling } from './useRosterPolling'

let hidden
const setHidden = (value) => {
  hidden = value
  document.dispatchEvent(new Event('visibilitychange'))
}
const MIN = 60_000

beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
})
afterEach(() => {
  vi.useRealTimers()
  delete document.hidden
})

const make = (load = vi.fn().mockResolvedValue()) => ({ load, polling: useRosterPolling({ load }) })

describe('useRosterPolling', () => {
  it('start loads once immediately', () => {
    const { load, polling } = make()
    polling.start()
    expect(load).toHaveBeenCalledTimes(1)
    polling.stop()
  })

  it('loads again after 60 s, and not before', async () => {
    const { load, polling } = make()
    polling.start()
    await vi.advanceTimersByTimeAsync(MIN - 1)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(2)
    polling.stop()
  })

  it('never overlaps: a pending load holds the next tick until it settles', async () => {
    let release
    const load = vi.fn().mockReturnValueOnce(new Promise((r) => (release = r))).mockResolvedValue()
    const { polling } = make(load)
    polling.start()
    await vi.advanceTimersByTimeAsync(MIN * 3)
    expect(load).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(MIN)
    expect(load).toHaveBeenCalledTimes(2)
    polling.stop()
  })

  it('skips a tick while the tab is hidden, and keeps ticking', async () => {
    const { load, polling } = make()
    polling.start()
    hidden = true
    await vi.advanceTimersByTimeAsync(MIN * 2)
    expect(load).toHaveBeenCalledTimes(1)
    hidden = false // no event: the chain itself picks it up at the next tick
    await vi.advanceTimersByTimeAsync(MIN)
    expect(load).toHaveBeenCalledTimes(2)
    polling.stop()
  })

  it('refreshes at once when the tab becomes visible after 60 s or more', async () => {
    const { load, polling } = make()
    polling.start()
    hidden = true
    await vi.advanceTimersByTimeAsync(MIN * 2)
    expect(load).toHaveBeenCalledTimes(1)
    setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(2)
    polling.stop()
  })

  it('does not refresh when the tab returns within 60 s', async () => {
    const { load, polling } = make()
    polling.start()
    setHidden(true)
    await vi.advanceTimersByTimeAsync(10_000)
    setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(1)
    polling.stop()
  })

  it('a visibility refresh does not start a second load while one is pending', async () => {
    let release
    const load = vi.fn().mockReturnValueOnce(new Promise((r) => (release = r))).mockResolvedValue()
    const { polling } = make(load)
    polling.start()
    await vi.advanceTimersByTimeAsync(MIN * 2)
    setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(1)
    release()
    polling.stop()
  })

  it('keeps going after a load that rejects', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue()
    const { polling } = make(load)
    polling.start()
    await vi.advanceTimersByTimeAsync(MIN)
    expect(load).toHaveBeenCalledTimes(2)
    polling.stop()
  })

  it('start twice keeps a single chain', async () => {
    const { load, polling } = make()
    polling.start()
    polling.start()
    await vi.advanceTimersByTimeAsync(MIN)
    expect(load).toHaveBeenCalledTimes(2)
    polling.stop()
  })

  it('stop clears the timer and the visibility listener, and a second stop is harmless', async () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    const { load, polling } = make()
    polling.start()
    polling.stop()
    polling.stop()
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    await vi.advanceTimersByTimeAsync(MIN * 5)
    expect(load).toHaveBeenCalledTimes(1)
    remove.mockRestore()
  })

  it('a load that settles after stop does not schedule another', async () => {
    let release
    const load = vi.fn().mockReturnValueOnce(new Promise((r) => (release = r)))
    const { polling } = make(load)
    polling.start()
    polling.stop()
    release()
    await vi.advanceTimersByTimeAsync(MIN * 3)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('can be started again after a stop', async () => {
    const { load, polling } = make()
    polling.start()
    polling.stop()
    polling.start()
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(MIN)
    expect(load).toHaveBeenCalledTimes(3)
    polling.stop()
  })
})
