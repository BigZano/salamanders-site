import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import { createUploadSweeper } from './librariusSweeper.js'

const HOUR = 3_600_000

/** A sweeper on a clock and timers the test owns. `fire()` runs the timer that is waiting, as its time coming would. */
function rig(options = {}) {
  const clock = { t: Date.parse('2026-11-18T12:00:00.000Z') }
  const timers = { waiting: [], cleared: [] }
  const fakeTimers = {
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, id: timers.waiting.length + timers.cleared.length }
      timers.waiting.push(handle)
      return handle
    },
    clearTimeout: (handle) => {
      timers.cleared.push(handle)
      timers.waiting = timers.waiting.filter((h) => h !== handle)
    },
  }
  const store = { sweepUploads: vi.fn(async () => 0), pruneOutbox: vi.fn(async () => ({ entries: 0 })) }
  const calls = { get all() { return store.sweepUploads.mock.calls.map(([arg]) => arg) } }
  const logged = []
  const sweeper = createUploadSweeper({ store, now: () => clock.t, timers: fakeTimers, log: (line) => logged.push(line), ...options })
  const fire = async () => {
    const [next] = timers.waiting
    timers.waiting = timers.waiting.slice(1)
    await next.fn()
    await flush()
  }
  return { sweeper, store, clock, timers, calls, logged, fire }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('sweep', () => {
  it('asks the store to delete what is held from before an hour ago, and answers how many it deleted', async () => {
    const { sweeper, store, clock, calls } = rig()
    store.sweepUploads.mockResolvedValueOnce(3)
    expect(await sweeper.sweep()).toBe(3)
    expect(calls.all).toStrictEqual([{ olderThan: clock.t - HOUR }])
  })

  it('takes the age it was given, and reads the clock at each sweep', async () => {
    const { sweeper, clock, calls } = rig({ maxAgeMs: 90_000 })
    const first = clock.t
    await sweeper.sweep()
    clock.t += 1_000
    await sweeper.sweep()
    expect(calls.all).toStrictEqual([{ olderThan: first - 90_000 }, { olderThan: first + 1_000 - 90_000 }])
  })

  it('never rejects: a store that fails is a sweep of nothing, and the next sweep goes ahead', async () => {
    const { sweeper, store, logged } = rig()
    store.sweepUploads.mockRejectedValueOnce(new Error('the database is down at https://db.example/x?token=secret'))
    expect(await sweeper.sweep()).toBe(0)
    expect(logged).toHaveLength(1)
    expect(logged[0]).not.toContain('secret')
    store.sweepUploads.mockResolvedValueOnce(2)
    expect(await sweeper.sweep()).toBe(2)
  })

  it('never throws for a store that throws at once, or rejects with something that is no error', async () => {
    for (const fail of [() => { throw new Error('sync') }, () => Promise.reject('text'), () => Promise.reject(null), () => Promise.reject(undefined)]) {
      const { sweeper, store } = rig()
      store.sweepUploads.mockImplementation(fail)
      expect(await sweeper.sweep()).toBe(0)
    }
  })

  it('has two sweeps asked at once share one trip to the store', async () => {
    const { sweeper, store } = rig()
    let release
    store.sweepUploads.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(4))))
    const first = sweeper.sweep()
    const second = sweeper.sweep()
    await flush()
    release()
    expect(await first).toBe(4)
    expect(await second).toBe(4)
    expect(store.sweepUploads).toHaveBeenCalledTimes(1)
    await sweeper.sweep()
    expect(store.sweepUploads).toHaveBeenCalledTimes(2)
  })
})

describe('the prune of the outbox, on the same timer', () => {
  const DAY = 86_400_000

  it('prunes the entries done more than a day ago, at the first sweep', async () => {
    const { sweeper, store, clock } = rig()
    await sweeper.sweep()
    expect(store.pruneOutbox.mock.calls).toStrictEqual([[{ sentBefore: clock.t - DAY }]])
  })

  it('never asks for the events to be pruned, however old they are: they are the Librarians\' record', async () => {
    const { sweeper, store, clock } = rig()
    for (let i = 0; i < 3; i++) {
      await sweeper.sweep()
      clock.t += 400 * DAY
    }
    expect(store.pruneOutbox).toHaveBeenCalledTimes(3)
    for (const [options] of store.pruneOutbox.mock.calls) expect(Object.keys(options)).toEqual(['sentBefore'])
  })

  it('prunes once an hour, not at every sweep, reading the clock when it does', async () => {
    const { sweeper, store, clock } = rig()
    const first = clock.t
    await sweeper.sweep()
    clock.t += HOUR - 1
    await sweeper.sweep()
    expect(store.pruneOutbox).toHaveBeenCalledTimes(1)
    clock.t += 1
    await sweeper.sweep()
    expect(store.pruneOutbox.mock.calls).toStrictEqual([[{ sentBefore: first - DAY }], [{ sentBefore: first + HOUR - DAY }]])
  })

  it('prunes on every sweep that the timer makes, an hour apart', async () => {
    const { sweeper, store, clock, fire } = rig()
    sweeper.start()
    await flush()
    expect(store.pruneOutbox).toHaveBeenCalledTimes(1)
    clock.t += 60_000
    await fire()
    expect(store.pruneOutbox).toHaveBeenCalledTimes(1)
    clock.t += HOUR
    await fire()
    expect(store.pruneOutbox).toHaveBeenCalledTimes(2)
  })

  it('never fails the sweep, and tries again at the next one, with nothing of the error but its words', async () => {
    const { sweeper, store, logged, clock } = rig()
    store.pruneOutbox.mockRejectedValueOnce(new Error('the database is down at https://db.example/x?token=secret'))
    store.sweepUploads.mockResolvedValueOnce(4)
    expect(await sweeper.sweep()).toBe(4)
    expect(logged).toHaveLength(1)
    expect(logged[0]).not.toContain('secret')
    clock.t += 1
    await sweeper.sweep()
    expect(store.pruneOutbox).toHaveBeenCalledTimes(2)
  })

  it('prunes though the sweep of the pictures failed, and still answers 0 for it', async () => {
    const { sweeper, store } = rig()
    store.sweepUploads.mockRejectedValueOnce(new Error('down'))
    expect(await sweeper.sweep()).toBe(0)
    expect(store.pruneOutbox).toHaveBeenCalledTimes(1)
  })

  it('is one trip with the sweep: sweeps asked for together share the prune', async () => {
    const { sweeper, store } = rig()
    await Promise.all([sweeper.sweep(), sweeper.sweep(), sweeper.sweep()])
    expect(store.pruneOutbox).toHaveBeenCalledTimes(1)
  })

  it('does not hold the next sweep up for ever when the prune never answers: the sweep waits for it, as it does for its own work', async () => {
    const { sweeper, store } = rig()
    let release
    store.pruneOutbox.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ entries: 0 }))))
    let done = false
    const sweeping = sweeper.sweep().then(() => (done = true))
    await flush()
    expect(done).toBe(false)
    release()
    await sweeping
    expect(done).toBe(true)
  })
})

describe('start and stop', () => {
  it('sweeps at once, then every minute from the end of the last sweep', async () => {
    const { sweeper, store, timers, fire } = rig()
    sweeper.start()
    await flush()
    expect(store.sweepUploads).toHaveBeenCalledTimes(1)
    expect(timers.waiting.map((t) => t.ms)).toStrictEqual([60_000])
    await fire()
    expect(store.sweepUploads).toHaveBeenCalledTimes(2)
    expect(timers.waiting.map((t) => t.ms)).toStrictEqual([60_000])
    await fire()
    expect(store.sweepUploads).toHaveBeenCalledTimes(3)
  })

  it('takes the interval it was given', async () => {
    const { sweeper, timers } = rig({ intervalMs: 5_000 })
    sweeper.start()
    await flush()
    expect(timers.waiting.map((t) => t.ms)).toStrictEqual([5_000])
  })

  it('goes on after a sweep that failed', async () => {
    const { sweeper, store, timers, fire } = rig()
    store.sweepUploads.mockRejectedValueOnce(new Error('down'))
    sweeper.start()
    await flush()
    expect(timers.waiting).toHaveLength(1)
    await fire()
    expect(store.sweepUploads).toHaveBeenCalledTimes(2)
  })

  it('sets no second timer for a second start, and sweeps once', async () => {
    const { sweeper, store, timers } = rig()
    sweeper.start()
    sweeper.start()
    await flush()
    expect(store.sweepUploads).toHaveBeenCalledTimes(1)
    expect(timers.waiting).toHaveLength(1)
  })

  it('waits for no timer before the first sweep is over: the next is timed from its end', async () => {
    const { sweeper, store, timers } = rig()
    let release
    store.sweepUploads.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(0))))
    sweeper.start()
    await flush()
    expect(timers.waiting).toHaveLength(0)
    release()
    await flush()
    expect(timers.waiting).toHaveLength(1)
  })

  it('stop clears the timer and sweeps no more', async () => {
    const { sweeper, store, timers } = rig()
    sweeper.start()
    await flush()
    const [pending] = timers.waiting
    await sweeper.stop()
    expect(timers.cleared).toStrictEqual([pending])
    expect(timers.waiting).toHaveLength(0)
    expect(store.sweepUploads).toHaveBeenCalledTimes(1)
  })

  it('stop waits for a sweep that is running, and sets no timer after it', async () => {
    const { sweeper, store, timers } = rig()
    let release
    store.sweepUploads.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(0))))
    sweeper.start()
    await flush()
    let stopped = false
    const stopping = sweeper.stop().then(() => {
      stopped = true
    })
    await flush()
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(stopped).toBe(true)
    expect(timers.waiting).toHaveLength(0)
  })

  it('stop is for good: a start after it sweeps nothing, and stop twice is fine', async () => {
    const { sweeper, store, timers } = rig()
    sweeper.start()
    await flush()
    await sweeper.stop()
    await sweeper.stop()
    sweeper.start()
    await flush()
    expect(store.sweepUploads).toHaveBeenCalledTimes(1)
    expect(timers.waiting).toHaveLength(0)
    // The one timer it had was cleared once: a second stop has none to clear.
    expect(timers.cleared).toHaveLength(1)
  })

  it('stop before start is fine too, and start after it does nothing', async () => {
    const { sweeper, store, timers } = rig()
    await sweeper.stop()
    sweeper.start()
    await flush()
    expect(store.sweepUploads).not.toHaveBeenCalled()
    expect(timers.cleared).toHaveLength(0)
  })

  it('does not let a timer that was already due sweep after a stop', async () => {
    const { sweeper, store, timers } = rig()
    sweeper.start()
    await flush()
    const [due] = timers.waiting
    await sweeper.stop()
    await due.fn()
    await flush()
    expect(store.sweepUploads).toHaveBeenCalledTimes(1)
    expect(timers.waiting).toHaveLength(0)
  })

  it('uses the real clock and timers when it is given none', async () => {
    vi.useFakeTimers()
    try {
      const asked = []
      const store = { sweepUploads: async (arg) => asked.push(arg) && 0, pruneOutbox: async () => ({ entries: 0 }) }
      const sweeper = createUploadSweeper({ store, log: () => {} })
      await sweeper.sweep()
      expect(asked[0].olderThan).toBe(Date.now() - HOUR)
      sweeper.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(asked).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(asked).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(asked).toHaveLength(3)
      await sweeper.stop()
      await vi.advanceTimersByTimeAsync(300_000)
      expect(asked).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not set a timer after a tick whose sweep a stop came in the middle of', async () => {
    const { sweeper, store, timers, fire } = rig()
    sweeper.start()
    await flush()
    let release
    store.sweepUploads.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(0))))
    const ticking = fire()
    await flush()
    const stopping = sweeper.stop()
    release()
    await ticking
    await stopping
    expect(timers.waiting).toHaveLength(0)
  })
})

describe('what it refuses', () => {
  const store = { sweepUploads: async () => 0, pruneOutbox: async () => ({ entries: 0 }) }

  it('needs a store with sweepUploads', () => {
    for (const bad of [undefined, null, {}, { sweepUploads: 1 }, 'store']) {
      expect(() => createUploadSweeper({ store: bad }), String(bad)).toThrow(new TypeError('store.sweepUploads must be a function.'))
    }
  })

  it('needs a store with pruneOutbox too', () => {
    for (const bad of [undefined, null, 1, 'prune', {}]) {
      expect(() => createUploadSweeper({ store: { sweepUploads: async () => 0, pruneOutbox: bad } }), String(bad)).toThrow(new TypeError('store.pruneOutbox must be a function.'))
    }
  })

  it('needs an interval and an age that are whole numbers of milliseconds the timer can hold', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, '60000', null, 2 ** 31]) {
      expect(() => createUploadSweeper({ store, intervalMs: bad }), String(bad)).toThrow(new RangeError('intervalMs must be a whole number of milliseconds from 1 to 2147483647.'))
    }
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, '3600000', null]) {
      expect(() => createUploadSweeper({ store, maxAgeMs: bad }), String(bad)).toThrow(new RangeError('maxAgeMs must be a whole number of milliseconds of at least 1.'))
    }
    expect(() => createUploadSweeper({ store, intervalMs: 2 ** 31 - 1, maxAgeMs: 1 })).not.toThrow()
    expect(() => createUploadSweeper({ store, intervalMs: 1 })).not.toThrow()
  })
})

describe('whatever the order of starts, stops and sweeps (property)', () => {
  it('never sweeps twice at once, and nothing after a stop', async () => {
    const steps = fc.array(fc.constantFrom('start', 'sweep', 'stop', 'fire', 'flush'), { maxLength: 30 })
    await fc.assert(
      fc.asyncProperty(steps, async (list) => {
        const { sweeper, store, timers, fire } = rig()
        let running = 0
        let worst = 0
        store.sweepUploads.mockImplementation(async () => {
          running++
          worst = Math.max(worst, running)
          await flush()
          running--
          return 0
        })
        let stopped = false
        let afterStop = 0
        const count = () => store.sweepUploads.mock.calls.length
        let atStop = 0
        for (const step of list) {
          if (step === 'start') sweeper.start()
          else if (step === 'sweep') sweeper.sweep()
          else if (step === 'stop') {
            await sweeper.stop()
            if (!stopped) atStop = count()
            stopped = true
          } else if (step === 'fire') {
            if (timers.waiting.length > 0) await fire()
          } else await flush()
          if (stopped && step !== 'sweep') afterStop = count() - atStop
        }
        await flush()
        expect(worst).toBeLessThanOrEqual(1)
        // A sweep asked for by hand after a stop is the caller's; the timer's are never.
        if (!list.includes('sweep')) expect(afterStop).toBe(0)
      }),
      { numRuns: 100 },
    )
  })
})
