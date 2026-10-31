import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fc from 'fast-check'
import { createBuildsView } from './buildsView'
import { Upstream } from './discordRoles'

// Invented ids only: real user ids never enter the repo.
const HOLDER = '300000000000000001'
const OTHER = '300000000000000002'
const OUTSIDER = '300000000000000003'
const ME = '300000000000000004'

const req = (token) =>
  new Request('https://api.test/builds', { headers: token ? { Authorization: `Bearer ${token}` } : {} })

const SIGNED_OUT_HEADERS = { Vary: 'Authorization' }
const SIGNED_IN_HEADERS = { Vary: 'Authorization', 'Cache-Control': 'private, no-store' }

// The names and the flag come from two distinct, recognisable functions, so a
// test can tell the view hands back the directory's own resolvers.
const nameFor = (id) => `name-of-${id}`
const holders = new Set([HOLDER, ME])
const isMember = (id) => holders.has(id)

// A fake directory. A signed-out view must not ask it who the members are, so
// memberResolver fails loudly with a distinctive error unless a test lets it.
const NO_MEMBER_LOOKUP = new Error('memberResolver must not be reached when signed out')
const fakeNames = ({ resolver = async () => nameFor, memberResolver = async () => isMember } = {}) => ({
  resolver,
  memberResolver,
})
const signedOutNames = () =>
  fakeNames({
    memberResolver: async () => {
      throw NO_MEMBER_LOOKUP
    },
  })

// ME holds a valid token; anything else is an unknown token (identify → null).
const identifies = async (request) =>
  request.headers.get('Authorization') === 'Bearer tok-me' ? { id: ME, username: 'invented-name' } : null

describe('buildsView.view — signed in or out, and what the list may say', () => {
  it('signed out: no flag function, headers exactly { Vary: "Authorization" }', async () => {
    const view = createBuildsView({ roles: { identify: identifies }, displayNames: signedOutNames() })
    const out = await view.view(req())
    expect(out.isMember).toBeNull()
    expect(out.headers).toStrictEqual(SIGNED_OUT_HEADERS)
    expect(Object.keys(out).sort()).toEqual(['headers', 'isMember', 'nameFor'])
  })

  it('an invalid or expired token (identify → null) is treated as signed out', async () => {
    const view = createBuildsView({ roles: { identify: identifies }, displayNames: signedOutNames() })
    const out = await view.view(req('stale-token'))
    expect(out.isMember).toBeNull()
    expect(out.headers).toStrictEqual(SIGNED_OUT_HEADERS)
  })

  it.each([
    ['Upstream (Discord down)', new Upstream('Discord is unreachable.')],
    ['a plain Error', new Error('boom')],
    ['a TypeError', new TypeError('x is not a function')],
    ['a rejection that is not an Error', 'just a string'],
    ['an undefined rejection', undefined],
  ])('Discord down or any error from identify (%s) is treated as signed out, not thrown', async (_label, failure) => {
    const roles = {
      identify: async () => {
        throw failure
      },
    }
    const view = createBuildsView({ roles, displayNames: signedOutNames() })
    const out = await view.view(req('tok-me'))
    expect(out.isMember).toBeNull()
    expect(out.headers).toStrictEqual(SIGNED_OUT_HEADERS)
    expect(out.nameFor).toBe(nameFor)
  })

  it('a synchronous throw from identify is treated as signed out too', async () => {
    const roles = {
      identify: () => {
        throw new Error('thrown before any promise')
      },
    }
    const view = createBuildsView({ roles, displayNames: signedOutNames() })
    const out = await view.view(req('tok-me'))
    expect(out.isMember).toBeNull()
    expect(out.headers).toStrictEqual(SIGNED_OUT_HEADERS)
  })

  it.each([[undefined], [false], [0], ['']])('identify resolving %j is signed out', async (nobody) => {
    const view = createBuildsView({ roles: { identify: async () => nobody }, displayNames: signedOutNames() })
    const out = await view.view(req('tok-me'))
    expect(out.isMember).toBeNull()
    expect(out.headers).toStrictEqual(SIGNED_OUT_HEADERS)
  })

  it('signed in: isMember is true for holders, false for others and for ids not in the guild', async () => {
    const view = createBuildsView({ roles: { identify: identifies }, displayNames: fakeNames() })
    const out = await view.view(req('tok-me'))
    expect(typeof out.isMember).toBe('function')
    expect(out.isMember(HOLDER)).toBe(true)
    expect(out.isMember(OTHER)).toBe(false)
    expect(out.isMember(OUTSIDER)).toBe(false)
    expect(out.headers).toStrictEqual(SIGNED_IN_HEADERS)
  })

  it('signed in: the flag is the directory\'s own member resolver, not something re-derived', async () => {
    const theirs = (id) => id === OTHER
    const displayNames = fakeNames({ memberResolver: async () => theirs })
    const view = createBuildsView({ roles: { identify: identifies }, displayNames })
    const out = await view.view(req('tok-me'))
    expect(out.isMember).toBe(theirs)
    expect(out.isMember(OTHER)).toBe(true)
    expect(out.isMember(HOLDER)).toBe(false)
  })

  it('the caller is identified from the very request the view was given', async () => {
    const view = createBuildsView({ roles: { identify: identifies }, displayNames: fakeNames() })
    expect((await view.view(req('tok-me'))).isMember).toBeTypeOf('function')
    expect((await view.view(req('someone-else'))).isMember).toBeNull()
    expect((await view.view(req())).isMember).toBeNull()
  })

  it('nameFor is the display-name resolver in every case', async () => {
    const down = new Upstream('Discord is unreachable.')
    const cases = [
      { identify: identifies, token: 'tok-me' }, // signed in
      { identify: identifies, token: undefined }, // no token
      { identify: identifies, token: 'stale' }, // identify → null
      {
        identify: async () => {
          throw down
        },
        token: 'tok-me',
      }, // Discord down
    ]
    for (const { identify, token } of cases) {
      const view = createBuildsView({ roles: { identify }, displayNames: fakeNames() })
      const out = await view.view(req(token))
      expect(out.nameFor).toBe(nameFor)
      expect(out.nameFor(HOLDER)).toBe(`name-of-${HOLDER}`)
    }
  })

  it('failures of the directory itself are not hidden: only identify is forgiven', async () => {
    const roles = { identify: identifies }
    const noDirectory = new Error('directory failed')
    const namesDown = fakeNames({
      resolver: async () => {
        throw noDirectory
      },
    })
    await expect(createBuildsView({ roles, displayNames: namesDown }).view(req())).rejects.toBe(noDirectory)
    await expect(createBuildsView({ roles, displayNames: namesDown }).view(req('tok-me'))).rejects.toBe(noDirectory)

    const membersDown = fakeNames({
      memberResolver: async () => {
        throw noDirectory
      },
    })
    await expect(createBuildsView({ roles, displayNames: membersDown }).view(req('tok-me'))).rejects.toBe(noDirectory)
  })

  it('property: whatever identify rejects with, the view is the signed-out view', async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (failure) => {
        const roles = {
          identify: async () => {
            throw failure
          },
        }
        const out = await createBuildsView({ roles, displayNames: signedOutNames() }).view(req('tok-me'))
        expect(out.isMember).toBeNull()
        expect(out.headers).toStrictEqual(SIGNED_OUT_HEADERS)
        expect(out.nameFor).toBe(nameFor)
      }),
    )
  })

  it('property: any truthy caller is signed in, and gets the private headers', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.anything().filter((v) => !!v),
        async (caller) => {
          const out = await createBuildsView({
            roles: { identify: async () => caller },
            displayNames: fakeNames(),
          }).view(req('tok-me'))
          expect(out.isMember).toBe(isMember)
          expect(out.headers).toStrictEqual(SIGNED_IN_HEADERS)
        },
      ),
    )
  })
})

// The wait for Discord is bounded, so these tests drive it with fake timers.
describe('buildsView.view — a viewer is not kept waiting on Discord', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const NEVER = () => new Promise(() => {})
  // A lookup that settles after `ms` of (fake) time.
  const answersAfter = (ms, caller) => () => new Promise((resolve) => setTimeout(resolve, ms, caller))
  const failsAfter = (ms, failure) => () => new Promise((_, reject) => setTimeout(reject, ms, failure))
  const ME_CALLER = { id: ME, username: 'invented-name' }
  // Tells whether a promise has settled yet, without waiting for it.
  const watch = (promise) => {
    const seen = { settled: false }
    seen.result = promise.then((out) => {
      seen.settled = true
      return out
    })
    return seen
  }

  it('a lookup that never answers: the plain list comes back once the wait is over, not before', async () => {
    const view = createBuildsView({ roles: { identify: NEVER }, displayNames: signedOutNames(), identifyWaitMs: 50 })
    const seen = watch(view.view(req('tok-me')))
    await vi.advanceTimersByTimeAsync(49)
    expect(seen.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(seen.settled).toBe(true)
    const out = await seen.result
    expect(out.isMember).toBeNull()
    expect(out.headers).toStrictEqual(SIGNED_OUT_HEADERS)
    expect(out.nameFor).toBe(nameFor)
  })

  it('the default wait is 1500 ms', async () => {
    const view = createBuildsView({ roles: { identify: NEVER }, displayNames: signedOutNames() })
    const seen = watch(view.view(req('tok-me')))
    await vi.advanceTimersByTimeAsync(1499)
    expect(seen.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(seen.settled).toBe(true)
    const out = await seen.result
    expect(out.isMember).toBeNull()
    expect(out.headers).toStrictEqual(SIGNED_OUT_HEADERS)
  })

  it('a lookup that answers within the wait is flagged', async () => {
    const roles = { identify: answersAfter(10, ME_CALLER) }
    const view = createBuildsView({ roles, displayNames: fakeNames(), identifyWaitMs: 50 })
    const seen = watch(view.view(req('tok-me')))
    await vi.advanceTimersByTimeAsync(10)
    expect(seen.settled).toBe(true)
    const out = await seen.result
    expect(out.isMember).toBe(isMember)
    expect(out.isMember(HOLDER)).toBe(true)
    expect(out.isMember(OTHER)).toBe(false)
    expect(out.headers).toStrictEqual(SIGNED_IN_HEADERS)
  })

  it('a lookup that answers after the wait is ignored', async () => {
    const roles = { identify: answersAfter(100, ME_CALLER) }
    const view = createBuildsView({ roles, displayNames: signedOutNames(), identifyWaitMs: 50 })
    const seen = watch(view.view(req('tok-me')))
    await vi.advanceTimersByTimeAsync(50)
    expect(seen.settled).toBe(true)
    const out = await seen.result
    expect(out.isMember).toBeNull()
    expect(out.headers).toStrictEqual(SIGNED_OUT_HEADERS)
    // Lets the late answer arrive, so an error thrown by it would fail the run.
    await vi.runAllTimersAsync()
  })

  it('a lookup that fails after the wait is not an unhandled rejection', async () => {
    // Vitest fails the run on an unhandled rejection; this also listens, so
    // that the test itself fails rather than only the run.
    const escaped = []
    const onEscape = (reason) => escaped.push(reason)
    process.on('unhandledRejection', onEscape)
    try {
      const roles = { identify: failsAfter(100, new Error('Discord answered too late')) }
      const view = createBuildsView({ roles, displayNames: signedOutNames(), identifyWaitMs: 50 })
      const seen = watch(view.view(req('tok-me')))
      await vi.runAllTimersAsync()
      const out = await seen.result
      expect(out.isMember).toBeNull()
      expect(out.headers).toStrictEqual(SIGNED_OUT_HEADERS)
      // Unhandled rejections are reported once the microtask queue has drained
      // and a turn of the real event loop has passed.
      vi.useRealTimers()
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      process.off('unhandledRejection', onEscape)
    }
    expect(escaped).toEqual([])
  })

  it('a lookup that rejects within the wait is signed out, as before', async () => {
    const roles = { identify: failsAfter(10, new Upstream('Discord is unreachable.')) }
    const view = createBuildsView({ roles, displayNames: signedOutNames(), identifyWaitMs: 50 })
    const seen = watch(view.view(req('tok-me')))
    await vi.advanceTimersByTimeAsync(10)
    expect(seen.settled).toBe(true)
    const out = await seen.result
    expect(out.isMember).toBeNull()
    expect(out.headers).toStrictEqual(SIGNED_OUT_HEADERS)
  })

  it('a lookup that answers null is signed out, as before', async () => {
    const roles = { identify: answersAfter(10, null) }
    const view = createBuildsView({ roles, displayNames: signedOutNames(), identifyWaitMs: 50 })
    const seen = watch(view.view(req('tok-me')))
    await vi.advanceTimersByTimeAsync(10)
    expect(seen.settled).toBe(true)
    const out = await seen.result
    expect(out.isMember).toBeNull()
    expect(out.headers).toStrictEqual(SIGNED_OUT_HEADERS)
  })

  it('a request with no token does not wait for the timer', async () => {
    const view = createBuildsView({ roles: { identify: identifies }, displayNames: signedOutNames() })
    const seen = watch(view.view(req()))
    await vi.advanceTimersByTimeAsync(0)
    expect(seen.settled).toBe(true)
    const out = await seen.result
    expect(out.isMember).toBeNull()
    expect(out.headers).toStrictEqual(SIGNED_OUT_HEADERS)
  })

  it('a fast lookup leaves no timer running', async () => {
    const view = createBuildsView({ roles: { identify: identifies }, displayNames: fakeNames() })
    const out = await view.view(req('tok-me'))
    expect(out.isMember).toBe(isMember)
    // Pins the cleared timer: it has no other observable effect.
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['answers nobody', async () => null],
    [
      'fails',
      async () => {
        throw new Upstream('Discord is unreachable.')
      },
    ],
    [
      'throws before returning a promise',
      () => {
        throw new Error('thrown before any promise')
      },
    ],
  ])('a lookup that %s leaves no timer running either', async (_label, identify) => {
    const view = createBuildsView({ roles: { identify }, displayNames: fakeNames() })
    const out = await view.view(req('tok-me'))
    expect(out.isMember).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('property: a lookup is flagged exactly when it answers before the wait is over', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 300 }), fc.integer({ min: 0, max: 300 }), async (wait, delay) => {
        fc.pre(delay !== wait) // a tie is decided by timer registration order, and is deliberately not pinned
        const roles = { identify: answersAfter(delay, ME_CALLER) }
        const view = createBuildsView({ roles, displayNames: fakeNames(), identifyWaitMs: wait })
        const seen = watch(view.view(req('tok-me')))
        await vi.runAllTimersAsync()
        const out = await seen.result
        const inTime = delay < wait
        expect(out.isMember === null).toBe(!inTime)
        expect(out.headers).toStrictEqual(inTime ? SIGNED_IN_HEADERS : SIGNED_OUT_HEADERS)
      }),
    )
  })
})
