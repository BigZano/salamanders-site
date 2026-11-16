import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { STALE, statusOf, unlessStale, attempt } from './asking'

const apiError = (status, message = 'nope') => Object.assign(new Error(message), { status })

describe('statusOf', () => {
  it('maps a 401 to signin, a 403 to denied and everything else to unavailable', () => {
    expect(statusOf(apiError(401))).toBe('signin')
    expect(statusOf(apiError(403))).toBe('denied')
    for (const status of [400, 404, 429, 500, 502, 503, 0, -1, undefined, null]) {
      expect(statusOf(apiError(status)), String(status)).toBe('unavailable')
    }
  })

  it('reads the status as a number and nothing else: no coercion', () => {
    for (const status of ['401', '403', 401.5, [401], { valueOf: () => 401 }, true, NaN]) {
      expect(statusOf({ status }), String(status)).toBe('unavailable')
    }
  })

  it('answers unavailable for whatever was thrown that has no status', () => {
    for (const err of [new TypeError('Failed to fetch'), undefined, null, 'down', 7, {}, [], Symbol('x'), () => 401]) {
      expect(statusOf(err), String(typeof err)).toBe('unavailable')
    }
  })

  it('maps any status the same way whatever else the error carries (property)', () => {
    fc.assert(
      fc.property(fc.anything(), fc.integer({ min: -1000, max: 1000 }), (extra, status) => {
        const expected = status === 401 ? 'signin' : status === 403 ? 'denied' : 'unavailable'
        expect(statusOf({ message: String(extra), status })).toBe(expected)
      }),
    )
  })
})

describe('STALE', () => {
  it('is its own value, which no answer can be', () => {
    expect(typeof STALE).toBe('symbol')
    expect(STALE).toBe(STALE)
    expect(Symbol('stale')).not.toBe(STALE)
  })
})

describe('unlessStale', () => {
  it('answers what `ask` answers when the counter has not moved', async () => {
    const counter = { n: 0 }
    expect(await unlessStale(() => counter.n, async () => 'answer')).toBe('answer')
    expect(await unlessStale(() => counter.n, async () => undefined)).toBeUndefined()
    expect(await unlessStale(() => counter.n, async () => null)).toBeNull()
    expect(await unlessStale(() => counter.n, async () => 0)).toBe(0)
  })

  it('takes the counter before it asks, and compares after', async () => {
    const counter = { n: 5 }
    const seen = []
    await unlessStale(
      () => {
        seen.push(counter.n)
        return counter.n
      },
      async () => {
        seen.push('asked')
        return 1
      },
    )
    expect(seen).toEqual([5, 'asked', 5])
  })

  it('answers STALE when the counter moved while it asked, up or down', async () => {
    for (const move of [1, -1, 100]) {
      const counter = { n: 0 }
      const answer = await unlessStale(
        () => counter.n,
        async () => {
          counter.n += move
          return 'late'
        },
      )
      expect(answer, String(move)).toBe(STALE)
    }
  })

  it('answers what `ask` answers when the counter moved and came back', async () => {
    const counter = { n: 3 }
    const answer = await unlessStale(
      () => counter.n,
      async () => {
        counter.n += 1
        counter.n -= 1
        return 'same'
      },
    )
    expect(answer).toBe('same')
  })

  it('tells a counter that is not a number apart by identity, not by value', async () => {
    const counter = { key: 'a' }
    expect(await unlessStale(() => counter.key, async () => 'x')).toBe('x')
    const moved = await unlessStale(
      () => counter.key,
      async () => {
        counter.key = 'b'
        return 'x'
      },
    )
    expect(moved).toBe(STALE)
    const sameText = { n: '1' }
    const loose = await unlessStale(
      () => sameText.n,
      async () => {
        sameText.n = 1
        return 'x'
      },
    )
    expect(loose).toBe(STALE)
  })

  it('throws the failure of `ask` when the counter has not moved', async () => {
    const down = apiError(503, 'down')
    await expect(unlessStale(() => 0, async () => Promise.reject(down))).rejects.toBe(down)
  })

  it('throws a failure that is not an Error as it is', async () => {
    for (const thrown of ['down', 7, null, undefined, { status: 503 }]) {
      await expect(unlessStale(() => 0, async () => Promise.reject(thrown))).rejects.toBe(thrown)
    }
  })

  it('throws what a `ask` throws before it returns a promise, too', async () => {
    const down = new Error('sync')
    await expect(
      unlessStale(
        () => 0,
        () => {
          throw down
        },
      ),
    ).rejects.toBe(down)
  })

  it('drops a failure, and answers STALE, when the counter moved', async () => {
    const counter = { n: 0 }
    const answer = await unlessStale(
      () => counter.n,
      async () => {
        counter.n++
        throw apiError(503, 'late failure')
      },
    )
    expect(answer).toBe(STALE)
  })

  it('answers STALE or what `ask` answers, and throws only when the counter never moved (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), fc.integer({ min: -3, max: 3 }), fc.boolean(), async (start, move, fails) => {
        const counter = { n: start }
        const run = unlessStale(
          () => counter.n,
          async () => {
            counter.n += move
            if (fails) throw new Error('boom')
            return 'ok'
          },
        )
        if (move === 0 && fails) await expect(run).rejects.toThrow('boom')
        else expect(await run).toBe(move === 0 ? 'ok' : STALE)
      }),
    )
  })
})

describe('attempt', () => {
  it('clears the error before it runs, and answers what the run answers', async () => {
    const store = { error: 'old trouble' }
    let seenInside
    const answer = await attempt(store, async () => {
      seenInside = store.error
      return 'done'
    })
    expect(seenInside).toBe('')
    expect(answer).toBe('done')
    expect(store.error).toBe('')
  })

  it('keeps the message of a failure in `error` and throws the failure on', async () => {
    const store = { error: '' }
    const down = apiError(503, 'Discord is not answering.')
    await expect(attempt(store, async () => Promise.reject(down))).rejects.toBe(down)
    expect(store.error).toBe('Discord is not answering.')
  })

  it('reports a plain message for a failure that has none', async () => {
    for (const thrown of [apiError(500, ''), undefined, null, 'down', 7, {}, new Error()]) {
      const store = { error: '' }
      await expect(attempt(store, async () => Promise.reject(thrown))).rejects.toBe(thrown)
      expect(store.error, String(thrown)).toBe('Something went wrong.')
    }
  })

  it('catches what a run throws before it returns a promise, too', async () => {
    const store = { error: '' }
    const down = new Error('sync')
    await expect(
      attempt(store, () => {
        throw down
      }),
    ).rejects.toBe(down)
    expect(store.error).toBe('sync')
  })

  it('forgets an earlier error even when the run fails', async () => {
    const store = { error: 'old' }
    await attempt(store, async () => Promise.reject(new Error('new'))).catch(() => {})
    expect(store.error).toBe('new')
  })
})
