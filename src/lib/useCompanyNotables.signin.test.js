// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import fc from 'fast-check'
import { useAuth } from '../stores/auth'
import { useCompanyNotables } from './useCompanyNotables'

// The Notable Server Members against a stored sign-in, with everything real but the edges: the sign-in in
// localStorage, the clock and the network. A sign-in outlives its Discord token, and the membership flag stored with
// it can be days old or wrong, so these pin what the page does then. Invented names and tokens only.
const KEY = 'salamanders-discord-member'
const NOW = 1_800_000_000_000
const NAMES = { alpha: [['Test Member One', 'A line about them.']] }

const stored = (over = {}) =>
  JSON.stringify({ id: '200000000000000001', username: 'tester', isMember: true, checkedAt: 0, accessToken: 'invented-token', expiresAt: NOW + 60_000, ...over })

const json = (status, body) => new Response(JSON.stringify(body), { status })
const ANSWERS = {
  names: () => json(200, { companies: NAMES }),
  401: () => json(401, { error: 'Sign in with Discord.' }),
  403: () => json(403, { error: 'Notable members are shown to guild members.' }),
  500: () => json(500, { error: 'Internal error.' }),
  503: () => json(503, { error: 'Discord could not be reached. Try again.' }),
  'not JSON': () => new Response('<html>Bad gateway</html>', { status: 502 }),
  network: () => {
    throw new TypeError('Failed to fetch')
  },
}
const STATE_AFTER = { names: 'ready', 401: 'expired', 403: 'denied', 500: 'error', 503: 'error', 'not JSON': 'error', network: 'error' }

let requests
function serve(answer) {
  requests = []
  vi.stubGlobal('fetch', async (url, init) => {
    requests.push({ url: String(url), authorization: init.headers.Authorization })
    return ANSWERS[answer]()
  })
}

const hosts = []
async function open() {
  setActivePinia(createPinia())
  let notables
  hosts.push(mount({ setup() { notables = useCompanyNotables(); return () => null } }))
  await flushPromises()
  return notables
}
function closeAll() {
  hosts.splice(0).forEach((w) => w.unmount())
  localStorage.clear()
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  localStorage.clear()
  serve('names')
})
afterEach(() => {
  closeAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a sign-in whose Discord token has run out', () => {
  it('is told to sign in again and nothing is sent, at the exact moment of expiry and after', async () => {
    for (const expiresAt of [NOW, NOW - 1, NOW - 7 * 86_400_000]) {
      localStorage.setItem(KEY, stored({ expiresAt }))
      const n = await open()
      expect(n.state.value, expiresAt).toBe('expired')
      expect(requests, expiresAt).toStrictEqual([])
      expect(n.entriesFor('alpha'), expiresAt).toBeNull()
    }
  })

  it('is still good one millisecond before it runs out, and its token is what is sent', async () => {
    localStorage.setItem(KEY, stored({ expiresAt: NOW + 1 }))
    const n = await open()
    expect(n.state.value).toBe('ready')
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url).pathname).toBe('/company-notables')
    expect(requests[0].authorization).toBe('Bearer invented-token')
  })

  it('goes back to the plain note on signing out', async () => {
    localStorage.setItem(KEY, stored({ expiresAt: NOW }))
    const n = await open()
    expect(n.state.value).toBe('expired')
    useAuth().signOut()
    await flushPromises()
    expect(n.state.value).toBe('denied')
    expect(requests).toStrictEqual([])
  })

  it('is told the same when the server no longer takes a token that looks good', async () => {
    serve('401')
    localStorage.setItem(KEY, stored())
    const n = await open()
    expect(n.state.value).toBe('expired')
    expect(n.entriesFor('alpha')).toBeNull()
  })
})

describe('the membership flag stored at sign-in decides nothing: the server does', () => {
  it.each([
    ['false, as a slow answer at sign-in stores', false],
    ['missing', undefined],
    ['null', null],
    ['the string "true"', 'true'],
  ])('a stored flag of %s still gets the cards from a server that says yes', async (_label, isMember) => {
    localStorage.setItem(KEY, stored({ isMember }))
    const n = await open()
    expect(n.state.value).toBe('ready')
    expect(n.entriesFor('alpha')).toStrictEqual(NAMES.alpha)
  })

  it('a stored flag of true gets no names from a server that says no', async () => {
    serve('403')
    localStorage.setItem(KEY, stored({ isMember: true }))
    const n = await open()
    expect(n.state.value).toBe('denied')
    expect(n.entriesFor('alpha')).toBeNull()
  })
})

describe('a stored sign-in that is damaged', () => {
  it.each([
    ['not JSON', '{not json', 'denied'],
    ['null', 'null', 'denied'],
    ['no token', stored({ accessToken: undefined }), 'expired'],
    ['an empty token', stored({ accessToken: '' }), 'expired'],
    ['no expiry', stored({ expiresAt: undefined }), 'expired'],
    ['an expiry of zero', stored({ expiresAt: 0 }), 'expired'],
  ])('%s: nothing is sent and no names', async (_label, raw, state) => {
    localStorage.setItem(KEY, raw)
    const n = await open()
    expect(n.state.value).toBe(state)
    expect(requests).toStrictEqual([])
    expect(n.entriesFor('alpha')).toBeNull()
  })
})

describe('over every stored sign-in and every answer', () => {
  it('asks only with a live token, follows the answer, and has names only when ready', async () => {
    const domain = fc.record({
      signedIn: fc.boolean(),
      msToExpiry: fc.oneof(fc.integer({ min: -2, max: 2 }), fc.integer({ min: -1e10, max: 1e10 })),
      isMember: fc.constantFrom(true, false, 'true', 1, 0, null, undefined),
      answer: fc.constantFrom(...Object.keys(ANSWERS)),
    })
    await fc.assert(
      fc.asyncProperty(domain, async ({ signedIn, msToExpiry, isMember, answer }) => {
        closeAll()
        serve(answer)
        if (signedIn) localStorage.setItem(KEY, stored({ isMember, expiresAt: NOW + msToExpiry }))
        const n = await open()

        const live = signedIn && msToExpiry > 0
        expect(requests).toHaveLength(live ? 1 : 0)
        const expected = !signedIn ? 'denied' : !live ? 'expired' : STATE_AFTER[answer]
        expect(n.state.value).toBe(expected)
        expect(n.entriesFor('alpha')).toStrictEqual(expected === 'ready' ? NAMES.alpha : null)
      }),
    )
  })
})
