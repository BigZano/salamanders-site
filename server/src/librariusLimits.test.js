import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { BUSY, IN_FLIGHT, createLimits, LIMITS, tooFast } from './librariusLimits.js'

// Invented ids, all in the 400-499 range. None of them is a real member.
const ALICE = '300000000000000401'
const BOB = '300000000000000402'

/** Limits on a clock the test owns, in milliseconds. */
function rig() {
  const clock = { t: 1_000_000 }
  return { limits: createLimits({ now: () => clock.t }), clock }
}

describe('the numbers', () => {
  it('are the spec: 3 replies and 20 edits a minute, 30 uploads an hour; and, counted whether or not they are let through, 20 writes and 10 upload tries a minute and 30 member searches a minute', () => {
    expect(LIMITS).toStrictEqual({
      reply: { limit: 3, windowMs: 60_000 },
      edit: { limit: 20, windowMs: 60_000 },
      upload: { limit: 30, windowMs: 3_600_000 },
      writeTry: { limit: 20, windowMs: 60_000 },
      uploadTry: { limit: 10, windowMs: 60_000 },
      search: { limit: 30, windowMs: 60_000 },
    })
  })

  it('are, for the pictures in flight, 2 for a member and 4 for all, with the copy a member reads', () => {
    expect(IN_FLIGHT).toStrictEqual({ perMember: 2, total: 4 })
    expect(Object.isFrozen(IN_FLIGHT)).toBe(true)
    expect(BUSY).toStrictEqual({ member: 'One picture at a time, please.', site: 'The site is busy with pictures; try again in a moment.' })
    expect(Object.isFrozen(BUSY)).toBe(true)
  })

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(LIMITS)).toBe(true)
    expect(Object.isFrozen(LIMITS.reply)).toBe(true)
  })

  it('are what snapshot() tells a member, with what they have left: the three they can be told of, and not the tries that are counted for the server', () => {
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

  it('lets 20 write tries a minute through, and 10 upload tries, and 30 searches, each refused after that and let through a minute later', () => {
    for (const [kind, limit] of [['writeTry', 20], ['uploadTry', 10], ['search', 30]]) {
      const { limits, clock } = rig()
      for (let i = 0; i < limit; i++) {
        expect(limits.take(kind, ALICE).ok, `${kind} ${i}`).toBe(true)
        clock.t += 100
      }
      const wait = Math.ceil((60_000 - limit * 100) / 1000)
      expect(limits.take(kind, ALICE), kind).toMatchObject({ ok: false, retryAfter: wait, error: tooFast(wait) })
      expect(limits.take(kind, BOB).ok, kind).toBe(true)
      clock.t += wait * 1000
      expect(limits.take(kind, ALICE).ok, kind).toBe(true)
    }
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
      refuses(() => limits.take(kind, ALICE), RangeError, 'kind must be one of reply, edit, upload, writeTry, uploadTry, search.', String(kind))
      refuses(() => limits.check(kind, ALICE), RangeError, 'kind must be one of reply, edit, upload, writeTry, uploadTry, search.', String(kind))
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
  const SHOWN = ['reply', 'edit', 'upload']
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
          if (SHOWN.includes(o.kind)) expect(limits.snapshot(o.key)[o.kind].remaining).toBe(LIMITS[o.kind].limit - inside.length - (should && o.take ? 1 : 0))
          else expect(limits.snapshot(o.key)[o.kind]).toBeUndefined()
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

describe('hold: the pictures in flight', () => {
  const holds = (limits, key, n) => Array.from({ length: n }, () => limits.hold(key))

  it('lets a member have 2 in flight and refuses the 3rd with 429 and the copy for a member', () => {
    const { limits } = rig()
    const [a, b] = holds(limits, ALICE, 2)
    expect([a.ok, b.ok]).toStrictEqual([true, true])
    expect(limits.hold(ALICE)).toStrictEqual({ ok: false, status: 429, error: 'One picture at a time, please.' })
  })

  it('lets 4 in flight in all, and refuses the 5th, of anyone, with 503 and the copy for the site', () => {
    const { limits } = rig()
    const people = ['300000000000000411', '300000000000000412', '300000000000000413', '300000000000000414', '300000000000000415']
    expect(people.slice(0, 4).map((p) => limits.hold(p).ok)).toStrictEqual([true, true, true, true])
    expect(limits.hold(people[4])).toStrictEqual({ ok: false, status: 503, error: 'The site is busy with pictures; try again in a moment.' })
  })

  it('tells a member who is at their own cap of that, before it tells them the site is busy', () => {
    const { limits } = rig()
    holds(limits, ALICE, 2)
    holds(limits, BOB, 2)
    expect(limits.hold(ALICE)).toMatchObject({ ok: false, status: 429 })
    expect(limits.hold(BOB)).toMatchObject({ ok: false, status: 429 })
    expect(limits.hold('300000000000000416')).toMatchObject({ ok: false, status: 503 })
  })

  it('counts a refused hold for nothing: refusing again and again takes no place', () => {
    const { limits } = rig()
    const [a] = holds(limits, ALICE, 2)
    for (let i = 0; i < 5; i++) limits.hold(ALICE)
    a.release()
    expect(limits.hold(ALICE).ok).toBe(true)
    expect(limits.hold(ALICE).ok).toBe(false)
  })

  it('frees the member place and the place in all when a hold is released, and frees it once however often it is released', () => {
    const { limits } = rig()
    const [a, b] = holds(limits, ALICE, 2)
    a.release()
    a.release()
    a.release()
    const c = limits.hold(ALICE)
    expect(c.ok).toBe(true)
    expect(limits.hold(ALICE)).toMatchObject({ ok: false, status: 429 }) // b and c: two, not three released
    b.release()
    c.release()
    // Nothing in flight: all four places are free again.
    expect(['300000000000000411', '300000000000000412', '300000000000000413', '300000000000000414'].map((p) => limits.hold(p).ok)).toStrictEqual([true, true, true, true])
  })

  it('forgets a member with their last place: holding() counts the members who hold one', () => {
    const { limits } = rig()
    expect(limits.holding()).toBe(0)
    const [a, b] = holds(limits, ALICE, 2)
    const c = limits.hold(BOB)
    expect(limits.holding()).toBe(2)
    a.release()
    expect(limits.holding()).toBe(2) // Alice still holds one
    b.release()
    expect(limits.holding()).toBe(1)
    c.release()
    expect(limits.holding()).toBe(0)
    limits.hold(ALICE).release()
    expect(limits.holding()).toBe(0)
  })

  it('keeps each member apart, and the names an object has are members like any other', () => {
    const { limits } = rig()
    for (const key of ['__proto__', 'constructor']) {
      expect(limits.hold(key).ok).toBe(true)
      expect(limits.hold(key).ok).toBe(true)
      expect(limits.hold(key)).toMatchObject({ ok: false, status: 429 })
    }
  })

  it('is not the window of any limit: holding takes no try, and a try takes no hold', () => {
    const { limits } = rig()
    for (let i = 0; i < 3; i++) limits.take('uploadTry', ALICE)
    holds(limits, ALICE, 2)
    expect(limits.snapshot(ALICE).upload.remaining).toBe(30)
    for (let i = 0; i < 7; i++) expect(limits.take('uploadTry', ALICE).ok).toBe(true)
    expect(limits.take('uploadTry', ALICE).ok).toBe(false)
    expect(limits.hold(BOB).ok).toBe(true)
  })

  it('needs a key that is a non-empty string, as a window does', () => {
    const { limits } = rig()
    for (const key of ['', undefined, null, 1, {}, [], ['a'], Symbol('x'), true]) refuses(() => limits.hold(key), TypeError, 'key must be a non-empty string.', String(key))
  })

  it('holds the places the way a plain model counts them, whatever the order of holds and releases (property)', () => {
    const keys = [ALICE, BOB, '300000000000000403']
    const op = fc.oneof(fc.record({ do: fc.constant('hold'), who: fc.constantFrom(...keys) }), fc.record({ do: fc.constant('release'), which: fc.nat(30) }))
    fc.assert(
      fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
        const { limits } = rig()
        const live = [] // { key, release, freed }
        for (const o of ops) {
          if (o.do === 'hold') {
            const mine = live.filter((h) => !h.freed && h.key === o.who).length
            const all = live.filter((h) => !h.freed).length
            const got = limits.hold(o.who)
            const want = mine >= 2 ? { ok: false, status: 429 } : all >= 4 ? { ok: false, status: 503 } : { ok: true }
            expect(got).toMatchObject(want)
            if (got.ok) live.push({ key: o.who, release: got.release, freed: false })
          } else if (live.length > 0) {
            const h = live[o.which % live.length]
            h.release()
            h.freed = true
          }
        }
      }),
      { numRuns: 300 },
    )
  })
})
