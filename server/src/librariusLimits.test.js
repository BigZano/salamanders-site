import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { createLimits, LIMITS, tooFast } from './librariusLimits.js'

// Invented ids, all in the 400-499 range. None of them is a real member.
const ALICE = '300000000000000401'
const BOB = '300000000000000402'

/** Limits on a clock the test owns, in milliseconds. */
function rig() {
  const clock = { t: 1_000_000 }
  return { limits: createLimits({ now: () => clock.t }), clock }
}

describe('the numbers', () => {
  it('are the spec: 3 replies and 20 edits a minute, 30 uploads an hour', () => {
    expect(LIMITS).toStrictEqual({
      reply: { limit: 3, windowMs: 60_000 },
      edit: { limit: 20, windowMs: 60_000 },
      upload: { limit: 30, windowMs: 3_600_000 },
    })
  })

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(LIMITS)).toBe(true)
    expect(Object.isFrozen(LIMITS.reply)).toBe(true)
  })

  it('are what snapshot() tells a member, with what they have left', () => {
    const { limits } = rig()
    expect(limits.snapshot(ALICE)).toStrictEqual({
      reply: { limit: 3, windowSeconds: 60, remaining: 3 },
      edit: { limit: 20, windowSeconds: 60, remaining: 20 },
      upload: { limit: 30, windowSeconds: 3600, remaining: 30 },
    })
    limits.take('reply', ALICE)
    limits.take('upload', ALICE)
    limits.take('upload', ALICE)
    const now = limits.snapshot(ALICE)
    expect(now.reply.remaining).toBe(2)
    expect(now.edit.remaining).toBe(20)
    expect(now.upload.remaining).toBe(28)
  })
})

describe('tooFast', () => {
  it('is the copy a member reads, with the seconds to wait', () => {
    expect(tooFast(30)).toBe('Slow down a little: try again in 30 seconds.')
    expect(tooFast(2)).toBe('Slow down a little: try again in 2 seconds.')
  })

  it('says one second, not "1 seconds"', () => {
    expect(tooFast(1)).toBe('Slow down a little: try again in 1 second.')
  })
})

describe('take: at the edge', () => {
  it('lets 3 replies in a minute through and refuses the 4th, saying when to come back', () => {
    const { limits, clock } = rig()
    for (let i = 0; i < 3; i++) {
      expect(limits.take('reply', ALICE)).toStrictEqual({ ok: true })
      clock.t += 1_000
    }
    // The first went 3 s ago: it leaves the window in 57 s.
    expect(limits.take('reply', ALICE)).toStrictEqual({ ok: false, retryAfter: 57, error: 'Slow down a little: try again in 57 seconds.' })
  })

  it('frees the place at the very millisecond the oldest one is a window old, and not before', () => {
    const { limits, clock } = rig()
    const start = clock.t
    limits.take('reply', ALICE)
    clock.t = start + 10_000
    limits.take('reply', ALICE)
    clock.t = start + 20_000
    limits.take('reply', ALICE)
    clock.t = start + 59_999
    expect(limits.take('reply', ALICE)).toMatchObject({ ok: false, retryAfter: 1 })
    clock.t = start + 60_000
    expect(limits.take('reply', ALICE)).toStrictEqual({ ok: true })
    // That one took the place of the first: the second leaves at start + 70 s.
    clock.t = start + 60_001
    expect(limits.take('reply', ALICE)).toMatchObject({ ok: false, retryAfter: 10 })
  })

  it('rounds the wait up to whole seconds, and never to less than one', () => {
    const { limits, clock } = rig()
    const start = clock.t
    for (let i = 0; i < 3; i++) limits.take('reply', ALICE)
    clock.t = start + 100
    expect(limits.take('reply', ALICE).retryAfter).toBe(60)
    clock.t = start + 59_001
    expect(limits.take('reply', ALICE).retryAfter).toBe(1)
    clock.t = start + 59_999
    expect(limits.take('reply', ALICE).retryAfter).toBe(1)
  })

  it('does not count a refused try: hammering does not push the wait out', () => {
    const { limits, clock } = rig()
    const start = clock.t
    for (let i = 0; i < 3; i++) limits.take('reply', ALICE)
    for (let i = 0; i < 50; i++) {
      clock.t += 1_000
      expect(limits.take('reply', ALICE).ok).toBe(false)
    }
    clock.t = start + 60_000
    expect(limits.take('reply', ALICE).ok).toBe(true)
  })

  it('lets 20 edits a minute through, and 30 uploads an hour', () => {
    const { limits, clock } = rig()
    for (let i = 0; i < 20; i++) expect(limits.take('edit', ALICE).ok).toBe(true)
    expect(limits.take('edit', ALICE)).toMatchObject({ ok: false, retryAfter: 60 })
    for (let i = 0; i < 30; i++) {
      expect(limits.take('upload', ALICE).ok).toBe(true)
      clock.t += 100
    }
    expect(limits.take('upload', ALICE)).toMatchObject({ ok: false, retryAfter: 3597 })
    clock.t += 3_600_000
    expect(limits.take('upload', ALICE).ok).toBe(true)
  })

  it('keeps each kind and each member apart', () => {
    const { limits } = rig()
    for (let i = 0; i < 3; i++) limits.take('reply', ALICE)
    expect(limits.take('reply', ALICE).ok).toBe(false)
    expect(limits.take('reply', BOB).ok).toBe(true)
    expect(limits.take('edit', ALICE).ok).toBe(true)
    expect(limits.take('upload', ALICE).ok).toBe(true)
  })
})

describe('check', () => {
  it('answers as take would, and takes nothing', () => {
    const { limits } = rig()
    for (let i = 0; i < 10; i++) expect(limits.check('reply', ALICE)).toStrictEqual({ ok: true })
    expect(limits.snapshot(ALICE).reply.remaining).toBe(3)
    for (let i = 0; i < 3; i++) limits.take('reply', ALICE)
    expect(limits.check('reply', ALICE)).toStrictEqual({ ok: false, retryAfter: 60, error: 'Slow down a little: try again in 60 seconds.' })
    expect(limits.check('reply', BOB)).toStrictEqual({ ok: true })
  })

  it('agrees with take at the boundary', () => {
    const { limits, clock } = rig()
    const start = clock.t
    for (let i = 0; i < 3; i++) limits.take('reply', ALICE)
    clock.t = start + 59_999
    expect(limits.check('reply', ALICE).ok).toBe(false)
    clock.t = start + 60_000
    expect(limits.check('reply', ALICE).ok).toBe(true)
  })
})

describe('snapshot', () => {
  it('counts only what is still inside its window', () => {
    const { limits, clock } = rig()
    const start = clock.t
    limits.take('reply', ALICE)
    clock.t = start + 30_000
    limits.take('reply', ALICE)
    expect(limits.snapshot(ALICE).reply.remaining).toBe(1)
    clock.t = start + 60_000
    expect(limits.snapshot(ALICE).reply.remaining).toBe(2)
    clock.t = start + 90_000
    expect(limits.snapshot(ALICE).reply.remaining).toBe(3)
  })

  it('takes nothing, and does not remember a member it was only asked about', () => {
    const { limits } = rig()
    limits.snapshot(BOB)
    expect(limits.size()).toBe(0)
  })
})

describe('what it keeps', () => {
  it('forgets a member whose every try has left its window', () => {
    const { limits, clock } = rig()
    limits.take('reply', ALICE)
    limits.take('edit', ALICE)
    limits.take('upload', BOB)
    expect(limits.size()).toBe(3)
    clock.t += 60_000
    limits.take('reply', BOB)
    // Alice's reply and edit were looked at only through BOB's key, so they are still held until they are asked about.
    limits.check('reply', ALICE)
    limits.check('edit', ALICE)
    expect(limits.size()).toBe(2)
    clock.t += 3_600_000
    limits.snapshot(BOB)
    limits.check('reply', BOB)
    expect(limits.size()).toBe(0)
  })
})

// What a call throws: the error, or null.
function thrown(run) {
  try {
    run()
  } catch (e) {
    return e
  }
  return null
}

function refuses(run, type, message, label) {
  const e = thrown(run)
  expect(e, label).toBeInstanceOf(type)
  expect(e.message, label).toBe(message)
}

describe('what it refuses', () => {
  it('throws a RangeError for a kind it does not know, among them names an object has', () => {
    const { limits } = rig()
    for (const kind of ['', 'replies', 'REPLY', '__proto__', 'constructor', 'toString', 'hasOwnProperty', undefined, null, 1, {}, ['reply']]) {
      refuses(() => limits.take(kind, ALICE), RangeError, 'kind must be one of reply, edit, upload.', String(kind))
      refuses(() => limits.check(kind, ALICE), RangeError, 'kind must be one of reply, edit, upload.', String(kind))
    }
  })

  it('throws a TypeError for a key that is no text, or none', () => {
    const { limits } = rig()
    for (const key of ['', undefined, null, 1, 3.5, {}, [], ['a'], Symbol('x'), true]) {
      refuses(() => limits.take('reply', key), TypeError, 'key must be a non-empty string.', String(key))
      refuses(() => limits.check('reply', key), TypeError, 'key must be a non-empty string.', String(key))
      refuses(() => limits.snapshot(key), TypeError, 'key must be a non-empty string.', String(key))
    }
  })

  it('takes a key that is a name an object has, as any other', () => {
    const { limits } = rig()
    for (const key of ['__proto__', 'constructor', 'toString']) {
      for (let i = 0; i < 3; i++) expect(limits.take('reply', key).ok).toBe(true)
      expect(limits.take('reply', key).ok).toBe(false)
    }
    expect(limits.take('reply', ALICE).ok).toBe(true)
  })

  it('needs a clock that is a function', () => {
    for (const now of [null, 5, 'now', {}]) {
      refuses(() => createLimits({ now }), TypeError, 'now must be a function.', String(now))
    }
  })

  it('uses the real clock when it is given none', () => {
    const limits = createLimits()
    for (let i = 0; i < 3; i++) expect(limits.take('reply', ALICE).ok).toBe(true)
    expect(limits.take('reply', ALICE).ok).toBe(false)
  })

  it('throws a TypeError when the clock gives no time, and counts nothing for it', () => {
    let reading = Number.NaN
    const limits = createLimits({ now: () => reading })
    for (const bad of [Number.NaN, Infinity, -Infinity, undefined, '5', null]) {
      reading = bad
      refuses(() => limits.take('reply', ALICE), TypeError, 'The clock must give a finite number of milliseconds.', String(bad))
      refuses(() => limits.snapshot(ALICE), TypeError, 'The clock must give a finite number of milliseconds.', String(bad))
    }
    reading = 5_000
    expect(limits.snapshot(ALICE).reply.remaining).toBe(3)
  })
})

describe('against a plain model, whatever the order of tries', () => {
  const kinds = Object.keys(LIMITS)
  const op = fc.record({
    kind: fc.constantFrom(...kinds),
    key: fc.constantFrom(ALICE, BOB),
    advance: fc.oneof({ weight: 6, arbitrary: fc.integer({ min: 0, max: 2_000 }) }, { weight: 1, arbitrary: fc.integer({ min: 0, max: 4_000_000 }) }),
    take: fc.boolean(),
  })

  it('lets a try through exactly when fewer than the limit were let through inside the window before it', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 120 }), (ops) => {
        const { limits, clock } = rig()
        const accepted = new Map() // 'kind key' → the times of the tries let through
        for (const o of ops) {
          clock.t += o.advance
          const id = `${o.kind} ${o.key}`
          const times = accepted.get(id) ?? []
          const inside = times.filter((t) => t > clock.t - LIMITS[o.kind].windowMs)
          const should = inside.length < LIMITS[o.kind].limit
          const got = o.take ? limits.take(o.kind, o.key) : limits.check(o.kind, o.key)
          expect(got.ok).toBe(should)
          expect(limits.snapshot(o.key)[o.kind].remaining).toBe(LIMITS[o.kind].limit - inside.length - (should && o.take ? 1 : 0))
          if (!should) {
            const wait = Math.ceil((inside[0] + LIMITS[o.kind].windowMs - clock.t) / 1000)
            expect(got.retryAfter).toBe(wait)
            expect(got.retryAfter).toBeGreaterThanOrEqual(1)
            expect(got.error).toBe(tooFast(wait))
          }
          if (should && o.take) accepted.set(id, [...inside, clock.t])
        }
      }),
      { numRuns: 200 },
    )
  })
})
