import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { alongside } from './librariusDispatch.js'

// Every event the gateway hands over is an invented one.
const EVENT = { id: '200000000000000450', content: 'invented' }

/** A handler that records what it was given, and answers what it is told to. */
function handler(answer = () => undefined) {
  const calls = []
  const fn = (...args) => {
    calls.push(args)
    return answer(...args)
  }
  return { fn, calls }
}

/** → a promise that has not settled once the microtasks and one timer tick have run. */
const settledWithin = async (promise, ms = 20) => {
  let done = false
  promise.then(
    () => (done = true),
    () => (done = true),
  )
  await new Promise((resolve) => setTimeout(resolve, ms))
  return done
}

describe('alongside', () => {
  it('gives the main handler the event, and answers what it answers', async () => {
    const main = handler(async () => 'main answer')
    const aside = handler()
    const dispatch = alongside(main.fn, aside.fn, () => {})
    expect(await dispatch('MESSAGE_CREATE', EVENT)).toBe('main answer')
    expect(main.calls).toEqual([['MESSAGE_CREATE', EVENT]])
    expect(main.calls[0][1]).toBe(EVENT)
  })

  it('gives the aside handler the very same event', async () => {
    const main = handler(async () => undefined)
    const aside = handler(async () => undefined)
    await alongside(main.fn, aside.fn, () => {})('READY', EVENT)
    expect(aside.calls).toEqual([['READY', EVENT]])
    expect(aside.calls[0][1]).toBe(EVENT)
  })

  it('gives a handler no arguments but the type and the data', async () => {
    const main = handler(async () => undefined)
    const aside = handler(async () => undefined)
    await alongside(main.fn, aside.fn, () => {})('READY', EVENT, 'extra')
    expect(main.calls[0]).toHaveLength(2)
    expect(aside.calls[0]).toHaveLength(2)
  })

  it('does not wait for the aside handler: the main answer is the whole answer', async () => {
    const main = handler(async () => 'done')
    const aside = handler(() => new Promise(() => {})) // never settles
    const answer = alongside(main.fn, aside.fn, () => {})('INTERACTION_CREATE', EVENT)
    expect(await settledWithin(answer)).toBe(true)
    expect(await answer).toBe('done')
  })

  it('starts the aside handler before the main one has finished, so the two run side by side', async () => {
    let releaseMain
    const main = handler(() => new Promise((resolve) => (releaseMain = resolve)))
    const aside = handler(async () => undefined)
    const answer = alongside(main.fn, aside.fn, () => {})('READY', EVENT)
    expect(main.calls).toHaveLength(1)
    expect(aside.calls).toHaveLength(1)
    releaseMain('late')
    expect(await answer).toBe('late')
  })

  it('starts the aside handler of an event at once, whatever the main handler is still doing with the events before it: it waits for no earlier event', () => {
    const main = handler(() => new Promise(() => {}))
    const aside = handler(async () => undefined)
    const dispatch = alongside(main.fn, aside.fn, () => {})
    dispatch('A_THING', { n: 1 })
    dispatch('B_THING', { n: 2 })
    dispatch('INTERACTION_CREATE', { n: 3 })
    // Nothing has been awaited: all three asides have begun, before any main handler has finished.
    expect(aside.calls.map(([type]) => type)).toEqual(['A_THING', 'B_THING', 'INTERACTION_CREATE'])
  })

  it('does not hold the main answer back when the main handler is the slow one', async () => {
    const main = handler(() => new Promise(() => {}))
    const aside = handler(async () => 'quick')
    const answer = alongside(main.fn, aside.fn, () => {})('READY', EVENT)
    expect(await settledWithin(answer)).toBe(false)
  })

  it('passes the main handler\'s failure on, for the gateway to deal with', async () => {
    const boom = new Error('main failed')
    const main = handler(async () => {
      throw boom
    })
    const aside = handler(async () => undefined)
    await expect(alongside(main.fn, aside.fn, () => {})('READY', EVENT)).rejects.toBe(boom)
    expect(aside.calls).toHaveLength(1)
  })

  it('passes on a throw of the main handler', () => {
    const boom = new Error('main threw')
    const main = handler(() => {
      throw boom
    })
    expect(() => alongside(main.fn, () => {}, () => {})('READY', EVENT)).toThrow(boom)
  })

  describe('when the aside handler fails', () => {
    it.each([
      ['rejects', () => Promise.reject(new Error('aside rejected'))],
      ['throws', () => {
        throw new Error('aside threw')
      }],
      ['throws a bare value', () => {
        throw 'a bare text' // eslint-disable-line no-throw-literal
      }],
      ['rejects with nothing', () => Promise.reject(undefined)],
      ['answers a thenable that fails', () => ({ then: (_, reject) => reject(new Error('thenable failed')) })],
      ['answers a thenable that throws', () => ({
        then: () => {
          throw new Error('thenable threw')
        },
      })],
    ])('still runs the main handler, and answers its answer, when it %s', async (_, failing) => {
      const main = handler(async () => 'main answer')
      const failures = []
      const dispatch = alongside(main.fn, failing, (err) => failures.push(err))
      expect(await dispatch('INTERACTION_CREATE', EVENT)).toBe('main answer')
      expect(main.calls).toEqual([['INTERACTION_CREATE', EVENT]])
      // Let the failure of a promise reach its handler.
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(failures).toHaveLength(1)
    })

    it('hands the failure to the one who asked, once', async () => {
      const boom = new Error('aside rejected')
      const failures = []
      await alongside(async () => undefined, () => Promise.reject(boom), (err) => failures.push(err))('READY', EVENT)
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(failures).toEqual([boom])
      expect(failures[0]).toBe(boom)
    })

    it('hands a throw to the one who asked too, before the main handler runs', () => {
      const boom = new Error('aside threw')
      const failures = []
      const main = handler(() => 'x')
      alongside(main.fn, () => {
        throw boom
      }, (err) => failures.push(err))('READY', EVENT)
      expect(failures).toEqual([boom])
      expect(main.calls).toHaveLength(1)
    })

    it('is not stopped by a failure report that itself throws', async () => {
      const main = handler(async () => 'main answer')
      const dispatch = alongside(main.fn, () => Promise.reject(new Error('aside rejected')), () => {
        throw new Error('the log is gone')
      })
      expect(await dispatch('READY', EVENT)).toBe('main answer')
      await new Promise((resolve) => setTimeout(resolve, 5))
      const sync = alongside(main.fn, () => {
        throw new Error('aside threw')
      }, () => {
        throw new Error('the log is gone')
      })
      expect(await sync('READY', EVENT)).toBe('main answer')
      expect(main.calls).toHaveLength(2)
    })
  })

  it('accepts an aside handler that answers no promise at all', async () => {
    const main = handler(async () => 'main answer')
    for (const value of [undefined, null, 0, 'text', {}, 42]) {
      expect(await alongside(main.fn, () => value, () => {})('READY', EVENT)).toBe('main answer')
    }
  })

  it('refuses handlers that are no functions, and a reporter that is none', () => {
    const fn = () => {}
    for (const bad of [undefined, null, 'READY', 7, {}, []]) {
      expect(() => alongside(bad, fn, fn)).toThrow(new TypeError('main must be a function.'))
      expect(() => alongside(fn, bad, fn)).toThrow(new TypeError('aside must be a function.'))
    }
    for (const bad of [null, 'log', 7, {}]) {
      expect(() => alongside(fn, fn, bad)).toThrow(new TypeError('onError must be a function.'))
    }
  })

  it('keeps no state: every event reaches both handlers, in any order and any number', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.string(), fc.jsonValue()), { maxLength: 20 }), async (events) => {
        const main = handler(async (type) => type)
        const aside = handler(async () => undefined)
        const dispatch = alongside(main.fn, aside.fn, () => {})
        const answers = []
        for (const [type, data] of events) answers.push(await dispatch(type, data))
        expect(answers).toEqual(events.map(([type]) => type))
        expect(main.calls).toEqual(events.map(([type, data]) => [type, data]))
        expect(aside.calls).toEqual(events.map(([type, data]) => [type, data]))
      }),
      { numRuns: 100 },
    )
  })
})
