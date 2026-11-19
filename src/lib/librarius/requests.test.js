import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fc from 'fast-check'
import { SEARCHES, UPLOADS, createUploadQueue, paced, retryDelay } from './requests'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// Lets every promise that is ready run, without moving the clock.
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

// A call the test answers when it likes: what it was asked with, and how to answer it.
function deferredCalls() {
  const calls = []
  const fn = (...args) =>
    new Promise((resolve, reject) => {
      calls.push({ args, at: Date.now(), resolve, reject, open: true })
    })
  const answer = (call, value) => {
    call.open = false
    call.resolve(value)
  }
  return { calls, fn, answer, open: () => calls.filter((c) => c.open) }
}

// What paced() should ask, and when, for queries given at times in order: the reference the property holds it to.
function modelPaced(given, limit, windowMs) {
  const asked = []
  let waiting = null
  let timerAt = null
  const fire = (until) => {
    if (timerAt !== null && timerAt <= until) {
      asked.push({ q: waiting, at: timerAt })
      waiting = null
      timerAt = null
    }
  }
  const inWindow = (t) => asked.filter((a) => a.at > t - windowMs)
  for (const { q, at } of given) {
    fire(at)
    if (waiting === null && inWindow(at).length < limit) asked.push({ q, at })
    else {
      if (waiting === null) timerAt = inWindow(at)[0].at + windowMs
      waiting = q
    }
  }
  fire(Infinity)
  return asked
}

describe('paced: the member search, kept under the server\'s searches a minute', () => {
  it('keeps well under the server\'s 30 a minute', () => {
    expect(SEARCHES.windowMs).toBe(60_000)
    expect(SEARCHES.limit).toBeGreaterThan(0)
    expect(SEARCHES.limit).toBeLessThan(30)
  })

  it('asks at once while the window has room, and passes on what the search gave', async () => {
    const asked = []
    const ask = paced(async (q) => {
      asked.push([q, Date.now()])
      return [{ id: q }]
    }, { limit: 2, windowMs: 1000 })
    const start = Date.now()
    await expect(ask('ix')).resolves.toEqual([{ id: 'ix' }])
    await expect(ask('ixe')).resolves.toEqual([{ id: 'ixe' }])
    expect(asked).toEqual([['ix', start], ['ixe', start]])
  })

  it('holds a third query until the oldest leaves the window, to the millisecond', async () => {
    const asked = []
    const ask = paced(async (q) => {
      asked.push([q, Date.now()])
      return [q]
    }, { limit: 2, windowMs: 1000 })
    const start = Date.now()
    await ask('a')
    vi.advanceTimersByTime(300)
    await ask('b')
    const third = ask('c')
    await vi.advanceTimersByTimeAsync(699)
    expect(asked.map(([q]) => q)).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(1)
    expect(asked).toEqual([['a', start], ['b', start + 300], ['c', start + 1000]])
    await expect(third).resolves.toEqual(['c'])
  })

  it('asks only the newest of the queries that waited; the others give [] and are never asked', async () => {
    const asked = []
    const ask = paced(async (q) => {
      asked.push(q)
      return [q]
    }, { limit: 1, windowMs: 1000 })
    await ask('a')
    const b = ask('b')
    const c = ask('c')
    const d = ask('d')
    await expect(b).resolves.toEqual([])
    await expect(c).resolves.toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    await expect(d).resolves.toEqual(['d'])
    expect(asked).toEqual(['a', 'd'])
  })

  it('passes on a refusal, whether the search rejects or throws before it has a promise', async () => {
    const refused = Object.assign(new Error('The member list is not ready yet. Try again.'), { status: 503 })
    await expect(paced(async () => Promise.reject(refused))('ix')).rejects.toBe(refused)
    await expect(paced(() => { throw refused })('ix')).rejects.toBe(refused)
    const late = paced(() => { throw refused }, { limit: 1, windowMs: 100 })
    await expect(late('a')).rejects.toBe(refused)
    const waiting = late('b')
    const caught = expect(waiting).rejects.toBe(refused)
    await vi.advanceTimersByTimeAsync(100)
    await caught
  })

  it('counts a refused search as one asked', async () => {
    let n = 0
    const ask = paced(async () => {
      n++
      throw new Error('no')
    }, { limit: 1, windowMs: 1000 })
    await expect(ask('a')).rejects.toThrow('no')
    const next = ask('b').catch(() => 'refused')
    await settle()
    expect(n).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await next).toBe('refused')
    expect(n).toBe(2)
  })

  it('however the queries come, never asks more than the limit in any window, and always asks the newest', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 3000 }),
        fc.array(fc.integer({ min: 0, max: 1500 }), { minLength: 1, maxLength: 40 }),
        async (limit, windowMs, gaps) => {
          vi.setSystemTime(0)
          const asked = []
          const ask = paced(async (q) => {
            asked.push({ q, at: Date.now() })
            return [q]
          }, { limit, windowMs })
          const answers = []
          const given = []
          for (const [i, gap] of gaps.entries()) {
            await vi.advanceTimersByTimeAsync(gap)
            given.push({ q: `q${i}`, at: Date.now() })
            answers.push(ask(`q${i}`))
          }
          await vi.advanceTimersByTimeAsync(windowMs * (gaps.length + 1))
          const got = await Promise.all(answers)

          // No window of windowMs holds more than `limit` searches.
          for (let i = limit; i < asked.length; i++) expect(asked[i].at - asked[i - limit].at).toBeGreaterThanOrEqual(windowMs)
          // Each is asked once, in the order given, never before it was given; the newest always is.
          const order = asked.map((a) => Number(a.q.slice(1)))
          expect(order).toEqual([...order].sort((x, y) => x - y))
          expect(new Set(order).size).toBe(order.length)
          for (const a of asked) expect(a.at).toBeGreaterThanOrEqual(given[Number(a.q.slice(1))].at)
          expect(asked.at(-1).q).toBe(given.at(-1).q)
          // An asked query gets its answer, one that was not gets [].
          for (const [i, answer] of got.entries()) expect(answer).toEqual(order.includes(i) ? [`q${i}`] : [])
          // And exactly when: at once while nothing waits and the window has room, else the newest when the oldest leaves.
          expect(asked).toEqual(modelPaced(given, limit, windowMs))
        },
      ),
      { numRuns: 60 },
    )
  })

  it('refuses a search that is no function, and a window that is no window', () => {
    for (const bad of [undefined, null, 'search', {}, 1]) expect(() => paced(bad)).toThrow(TypeError)
    for (const limit of [0, -1, 1.5, NaN, Infinity, '2', null]) expect(() => paced(async () => [], { limit })).toThrow(RangeError)
    for (const windowMs of [0, -1, 1.5, NaN, Infinity, '2', null]) expect(() => paced(async () => [], { windowMs })).toThrow(RangeError)
  })
})

describe('retryDelay: how long a picture waits before it is tried again', () => {
  it('doubles from the first wait, up to the cap, and stays there', () => {
    const { firstDelayMs: first, maxDelayMs: cap } = UPLOADS
    expect(retryDelay(0)).toBe(first)
    expect(retryDelay(1)).toBe(first * 2)
    expect(retryDelay(2)).toBe(first * 4)
    for (let k = 0; k < 60; k++) {
      expect(retryDelay(k)).toBe(Math.min(first * 2 ** k, cap))
      expect(retryDelay(k + 1)).toBeGreaterThanOrEqual(retryDelay(k))
    }
    expect(retryDelay(1e6)).toBe(cap)
    expect(retryDelay(Number.MAX_SAFE_INTEGER)).toBe(cap)
  })

  it('is told which retry, as a whole number from 0', () => {
    for (const bad of [-1, 0.5, NaN, Infinity, -Infinity, '1', null, undefined]) {
      expect(() => retryDelay(bad)).toThrow(bad === -1 ? RangeError : TypeError)
    }
  })
})

describe('createUploadQueue: pictures, at most two at a time, tried again when the server is busy', () => {
  const file = (name) => ({ name })
  const OK = (n, name = `picture-${n}.png`) => ({ n, name })
  const STOPPED = { ok: false, status: null, error: null, stopped: true }

  it('uploads a file at the place it is given, and gives back the place and its name', async () => {
    const up = deferredCalls()
    const queue = createUploadQueue({ upload: up.fn })
    const got = queue.add(file('map.png'), 3)
    expect(queue.pending()).toBe(1)
    await settle()
    expect(up.calls.map((c) => c.args)).toEqual([[file('map.png'), 3]])
    up.answer(up.calls[0], OK(3, 'map.png'))
    await expect(got).resolves.toEqual({ ok: true, n: 3, name: 'map.png' })
    expect(queue.pending()).toBe(0)
  })

  it('has two in flight at most; the third waits for a place, and goes when one comes back', async () => {
    const up = deferredCalls()
    const queue = createUploadQueue({ upload: up.fn })
    const outcomes = [1, 2, 3].map((n) => queue.add(file(`f${n}`), n))
    await settle()
    expect(up.calls.map((c) => c.args[1])).toEqual([1, 2])
    expect(queue.pending()).toBe(3)
    up.answer(up.calls[1], OK(2))
    await settle()
    expect(up.calls.map((c) => c.args[1])).toEqual([1, 2, 3])
    expect(up.open()).toHaveLength(2)
    up.answer(up.calls[0], OK(1))
    up.answer(up.calls[2], OK(3))
    expect(await Promise.all(outcomes)).toEqual([1, 2, 3].map((n) => ({ ok: true, ...OK(n) })))
  })

  it.each([429, 503])('on a %i waits, tells why with the server\'s copy, and tries again: 1 s, 2 s, 4 s, 8 s', async (status) => {
    const up = deferredCalls()
    const told = []
    const queue = createUploadQueue({ upload: up.fn, onRetry: (why) => told.push(why) })
    const got = queue.add(file('f'), 1)
    const copy = status === 429 ? 'One picture at a time, please.' : 'Too many pictures are being sent. Try again soon.'
    const waits = []
    for (let k = 0; k < 4; k++) {
      await settle()
      expect(up.calls).toHaveLength(k + 1)
      up.answer(up.calls[k], { status, error: copy })
      await settle()
      expect(told.at(-1)).toEqual({ n: 1, status, error: copy })
      const before = Date.now()
      await vi.advanceTimersByTimeAsync(retryDelay(k) - 1)
      expect(up.calls).toHaveLength(k + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(up.calls).toHaveLength(k + 2)
      waits.push(up.calls[k + 1].at - before)
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000])
    up.answer(up.calls[4], OK(1))
    await expect(got).resolves.toEqual({ ok: true, ...OK(1) })
    expect(told).toHaveLength(4)
  })

  it(`gives up after ${UPLOADS.tries} tries in all, with the server's last copy`, async () => {
    const up = deferredCalls()
    const told = []
    const queue = createUploadQueue({ upload: up.fn, onRetry: (why) => told.push(why) })
    const got = queue.add(file('f'), 2)
    for (let k = 0; k < UPLOADS.tries; k++) {
      await settle()
      up.answer(up.calls[k], { status: k % 2 ? 503 : 429, error: `busy ${k}` })
      await vi.advanceTimersByTimeAsync(UPLOADS.maxDelayMs)
    }
    await expect(got).resolves.toEqual({ ok: false, status: 429, error: `busy ${UPLOADS.tries - 1}` })
    expect(up.calls).toHaveLength(UPLOADS.tries)
    expect(told).toHaveLength(UPLOADS.tries - 1)
    await vi.advanceTimersByTimeAsync(UPLOADS.maxDelayMs * 4)
    expect(up.calls).toHaveLength(UPLOADS.tries)
    expect(queue.pending()).toBe(0)
  })

  it.each([413, 408, 400, 403, 415, 500])('a %i is said at once and never tried again', async (status) => {
    const up = deferredCalls()
    const told = []
    const queue = createUploadQueue({ upload: up.fn, onRetry: (why) => told.push(why) })
    const got = queue.add(file('f'), 1)
    await settle()
    up.answer(up.calls[0], { status, error: 'The server says no.' })
    await expect(got).resolves.toEqual({ ok: false, status, error: 'The server says no.' })
    await vi.advanceTimersByTimeAsync(UPLOADS.maxDelayMs * 10)
    expect(up.calls).toHaveLength(1)
    expect(told).toEqual([])
  })

  it('keeps a place while a picture waits to be tried again', async () => {
    const up = deferredCalls()
    const queue = createUploadQueue({ upload: up.fn })
    const outcomes = [1, 2, 3].map((n) => queue.add(file(`f${n}`), n))
    await settle()
    up.answer(up.calls[0], { status: 429, error: 'One picture at a time, please.' })
    await settle()
    expect(up.calls.map((c) => c.args[1])).toEqual([1, 2])
    await vi.advanceTimersByTimeAsync(retryDelay(0))
    expect(up.calls.map((c) => c.args[1])).toEqual([1, 2, 1])
    up.answer(up.calls[1], OK(2))
    await settle()
    expect(up.calls.map((c) => c.args[1])).toEqual([1, 2, 1, 3])
    up.answer(up.calls[2], OK(1))
    up.answer(up.calls[3], OK(3))
    expect((await Promise.all(outcomes)).map((o) => o.n)).toEqual([1, 2, 3])
  })

  it('reads anything but a place and a name, or a status, as a failure it does not try again', async () => {
    const answers = [
      undefined, null, 'ok', 7, [], {}, { n: 0, name: 'x' }, { n: 11, name: 'x' }, { n: 1.5, name: 'x' }, { n: '1', name: 'x' },
      { n: 1 }, { n: 1, name: 5 }, { status: '429', error: 'x' }, { status: 429.5, error: 'x' }, { status: NaN },
    ]
    for (const answer of answers) {
      const queue = createUploadQueue({ upload: async () => answer })
      await expect(queue.add(file('f'), 1), JSON.stringify(answer)).resolves.toEqual({ ok: false, status: null, error: null })
    }
    const thrown = createUploadQueue({ upload: async () => { throw new TypeError('Failed to fetch') } })
    await expect(thrown.add(file('f'), 1)).resolves.toEqual({ ok: false, status: null, error: null })
    const sync = createUploadQueue({ upload: () => { throw new Error('boom') } })
    await expect(sync.add(file('f'), 1)).resolves.toEqual({ ok: false, status: null, error: null })
  })

  it('keeps the server\'s copy only when it is words', async () => {
    for (const [error, want] of [['Too big.', 'Too big.'], ['', null], ['   ', null], [undefined, null], [42, null], [{ text: 'x' }, null]]) {
      const queue = createUploadQueue({ upload: async () => ({ status: 413, error }) })
      await expect(queue.add(file('f'), 1)).resolves.toEqual({ ok: false, status: 413, error: want })
    }
    const both = createUploadQueue({ upload: async () => ({ status: 400, error: 'No.', n: 1, name: 'x' }) })
    await expect(both.add(file('f'), 1)).resolves.toEqual({ ok: false, status: 400, error: 'No.' })
  })

  it('once stopped, tries nothing more: what waits, waits for a place or is in flight ends as stopped', async () => {
    const up = deferredCalls()
    const told = []
    const queue = createUploadQueue({ upload: up.fn, onRetry: (why) => told.push(why) })
    const outcomes = [1, 2, 3].map((n) => queue.add(file(`f${n}`), n))
    await settle()
    up.answer(up.calls[0], { status: 503, error: 'busy' })
    await settle()
    queue.stop()
    await expect(outcomes[0]).resolves.toEqual(STOPPED)
    await expect(outcomes[2]).resolves.toEqual(STOPPED)
    up.answer(up.calls[1], OK(2))
    await expect(outcomes[1]).resolves.toEqual(STOPPED)
    await expect(queue.add(file('f4'), 4)).resolves.toEqual(STOPPED)
    await vi.advanceTimersByTimeAsync(UPLOADS.maxDelayMs * 10)
    expect(up.calls).toHaveLength(2)
    expect(told).toHaveLength(1)
    expect(queue.pending()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends a try that comes back as stopped, even a refusal it would have tried again', async () => {
    const up = deferredCalls()
    const told = []
    const queue = createUploadQueue({ upload: up.fn, onRetry: (why) => told.push(why) })
    const got = queue.add(file('f'), 1)
    await settle()
    queue.stop()
    up.answer(up.calls[0], { status: 429, error: 'busy' })
    await expect(got).resolves.toEqual(STOPPED)
    expect(told).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('however the server answers and in whatever order, never has more than two in flight, and ends each file once', async () => {
    const answer = fc.oneof(
      fc.constant({ kind: 'ok' }),
      fc.constantFrom(429, 503).map((status) => ({ kind: 'again', status })),
      fc.constantFrom(408, 413, 400, 415).map((status) => ({ kind: 'final', status })),
      fc.constant({ kind: 'throw' }),
    )
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(answer, { minLength: 1, maxLength: 7 }), { minLength: 1, maxLength: 12 }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 120 }),
        async (scripts, picks) => {
          const up = deferredCalls()
          let most = 0
          const upload = (f, n) => {
            const p = up.fn(f, n)
            most = Math.max(most, up.open().length)
            return p
          }
          const queue = createUploadQueue({ upload })
          const ended = []
          const outcomes = scripts.map((_, i) =>
            queue.add(file(`f${i}`), (i % 10) + 1).then((o) => {
              ended.push(i)
              return o
            }),
          )
          let p = 0
          for (let guard = 0; guard < 1000 && ended.length < scripts.length; guard++) {
            await settle()
            const open = up.open()
            if (open.length === 0) {
              await vi.advanceTimersToNextTimerAsync()
              continue
            }
            const call = open[picks[p++ % picks.length] % open.length]
            const i = Number(call.args[0].name.slice(1))
            const tried = up.calls.filter((c) => c.args[0] === call.args[0]).indexOf(call)
            const step = scripts[i][Math.min(tried, scripts[i].length - 1)]
            if (step.kind === 'throw') {
              call.open = false
              call.reject(new TypeError('Failed to fetch'))
            } else up.answer(call, step.kind === 'ok' ? OK((i % 10) + 1) : { status: step.status, error: `said ${step.status}` })
          }
          const got = await Promise.all(outcomes)

          expect(most).toBeLessThanOrEqual(UPLOADS.inFlight)
          expect(new Set(ended).size).toBe(scripts.length)
          expect(queue.pending()).toBe(0)
          // Files are first tried in the order they were added.
          const firsts = [...new Set(up.calls.map((c) => Number(c.args[0].name.slice(1))))]
          expect(firsts).toEqual(scripts.map((_, i) => i))
          for (const [i, script] of scripts.entries()) {
            // The answers this file got: tried again after each busy one, up to the cap, and ending on the first other one.
            const steps = Array.from({ length: UPLOADS.tries }, (_, k) => script[Math.min(k, script.length - 1)])
            const last = steps.findIndex((s) => s.kind !== 'again')
            const tries = last === -1 ? UPLOADS.tries : last + 1
            expect(up.calls.filter((c) => c.args[0].name === `f${i}`)).toHaveLength(tries)
            const end = steps[tries - 1]
            const want =
              end.kind === 'ok'
                ? { ok: true, ...OK((i % 10) + 1) }
                : end.kind === 'throw'
                  ? { ok: false, status: null, error: null }
                  : { ok: false, status: end.status, error: `said ${end.status}` }
            expect(got[i]).toEqual(want)
          }
        },
      ),
      { numRuns: 60 },
    )
  })

  it('refuses an upload that is no function, and a place that is no place', async () => {
    for (const bad of [undefined, null, 'upload', {}]) expect(() => createUploadQueue({ upload: bad })).toThrow(TypeError)
    expect(() => createUploadQueue()).toThrow(TypeError)
    const queue = createUploadQueue({ upload: async (f, n) => OK(n) })
    for (const n of [0, 11, -1]) expect(() => queue.add(file('f'), n)).toThrow(RangeError)
    for (const n of [1.5, NaN, '1', null, undefined]) expect(() => queue.add(file('f'), n)).toThrow(TypeError)
    await expect(queue.add(file('f'), 1)).resolves.toEqual({ ok: true, ...OK(1) })
    await expect(queue.add(file('f'), 10)).resolves.toEqual({ ok: true, ...OK(10) })
  })
})
