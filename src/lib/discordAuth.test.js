// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  currentMember,
  getAccessToken,
  signOut,
  scrubCallbackHash,
  finishSignIn,
  beginSignIn,
  sanitizeReturnPath,
  RETURN_FALLBACK_MS,
} from './discordAuth'
import { API_BASE } from './buildsApi'

const STORAGE_KEY = 'salamanders-discord-member'
// Invented ids. Whether a person is a member is the server's answer to /membership, not a property of the id.
const A_MEMBER_ID = '300000000000000001'
const NOT_A_MEMBER_ID = '300000000000000002'

function setHash(hash) {
  window.location.hash = hash
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.location.hash = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getAccessToken', () => {
  it('returns null when nothing is stored', () => {
    expect(getAccessToken()).toBeNull()
  })

  it('returns null on corrupt JSON instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(() => getAccessToken()).not.toThrow()
    expect(getAccessToken()).toBeNull()
  })

  it('returns the token when it has not expired yet', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ accessToken: 'abc', expiresAt: Date.now() + 60_000 }),
    )
    expect(getAccessToken()).toBe('abc')
  })

  it('returns null once expiresAt has passed', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ accessToken: 'abc', expiresAt: Date.now() - 1 }),
    )
    expect(getAccessToken()).toBeNull()
  })

  it('treats the expiry boundary itself (now === expiresAt) as expired', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ accessToken: 'abc', expiresAt: now }))
    expect(getAccessToken()).toBeNull()
  })

  it('returns null when expiresAt is present but the token itself is missing', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ expiresAt: Date.now() + 60_000 }))
    expect(getAccessToken()).toBeNull()
  })
})

describe('currentMember', () => {
  it('returns null when nothing is stored', () => {
    expect(currentMember()).toBeNull()
  })

  it('never exposes the access token, even though it lives in the same record', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: '1',
        username: 'bob',
        isMember: true,
        checkedAt: 1,
        accessToken: 'super-secret',
        expiresAt: Date.now() + 60_000,
      }),
    )
    const member = currentMember()
    expect(member).toEqual({ id: '1', username: 'bob', isMember: true, checkedAt: 1 })
    expect(member).not.toHaveProperty('accessToken')
    expect(member).not.toHaveProperty('expiresAt')
  })
})

describe('signOut', () => {
  it('clears both membership info and the access token', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ id: '1', accessToken: 'abc', expiresAt: Date.now() + 60_000 }),
    )
    signOut()
    expect(currentMember()).toBeNull()
    expect(getAccessToken()).toBeNull()
  })
})

function withFakeLocation(fakeLocation, fn) {
  const realLocation = window.location
  Object.defineProperty(window, 'location', { value: fakeLocation, writable: true, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(window, 'location', { value: realLocation, writable: true, configurable: true })
  }
}

describe('beginSignIn', () => {
  it("redirects to Discord's authorize endpoint with the implicit-grant params", () => {
    // Own the seam: swap window.location for a plain object we control, rather
    // than letting jsdom's real Location try (and refuse) to cross-origin
    // navigate. Restored after, so later describe blocks get the real one back.
    const fakeLocation = {
      origin: 'https://sm2salamanders.site',
      pathname: '/planner',
      search: '',
      href: '',
    }

    withFakeLocation(fakeLocation, () => {
      beginSignIn()
      const url = new URL(fakeLocation.href)
      expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize')
      expect(url.searchParams.get('client_id')).toBe('1538255597810483210')
      expect(url.searchParams.get('response_type')).toBe('token')
      expect(url.searchParams.get('scope')).toBe('identify')
      // redirect_uri is the fixed site root regardless of which page sign-in
      // started from — Discord requires an exact whitelist match per URI, and
      // sign-in is reachable from every route (nav bar) plus the wildcard
      // 404 route, so per-page entries can never be fully enumerated.
      expect(url.searchParams.get('redirect_uri')).toBe('https://sm2salamanders.site/')
    })
  })

  it('sends the same redirect_uri no matter which route sign-in starts from', () => {
    const routes = ['/', '/planner', '/armoury', '/builds', '/companies', '/some/deep/404/path']
    for (const pathname of routes) {
      const fakeLocation = { origin: 'https://sm2salamanders.site', pathname, search: '', href: '' }
      withFakeLocation(fakeLocation, () => {
        beginSignIn()
        const url = new URL(fakeLocation.href)
        expect(url.searchParams.get('redirect_uri')).toBe('https://sm2salamanders.site/')
      })
    }
  })
})

const USER_URL = 'https://discord.com/api/users/@me'
const MEMBERSHIP_URL = `${API_BASE}/membership`
// The longest sign-in waits to learn whether the person is a member: 3 s, spelled out here so a change to it is seen.
const MEMBERSHIP_WAIT_MS = 3000

const answer = (body, status = 200) => ({ ok: status < 400, status, json: () => Promise.resolve(body) })

/**
 * A fetch stub that tells the two servers apart by address. Discord's user lookup answers `user` (or a 401 when
 * `userOk` is false); the membership call answers whatever `membership(options)` returns, a promise of a response.
 * Any other address answers { member: true }, so asking the wrong one can never read as "not a member".
 * `sent[url]` is the options each address was last handed.
 */
function stubServer({
  user = { id: A_MEMBER_ID, username: 'salamander' },
  userOk = true,
  membership = () => Promise.resolve(answer({ member: false })),
} = {}) {
  const sent = {}
  const fetchMock = vi.fn((url, options) => {
    sent[url] = options
    if (url === USER_URL) return Promise.resolve(answer(user, userOk ? 200 : 401))
    if (url === MEMBERSHIP_URL) return membership(options)
    return Promise.resolve(answer({ member: true }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, sent }
}

const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY))

// Discord's bounce with a token, then the sign-in itself. Not awaited, for the tests that watch it wait.
function beginFinish(token = 'tok', expiresIn = 3600) {
  setHash(`#access_token=${token}&expires_in=${expiresIn}`)
  scrubCallbackHash()
  return finishSignIn()
}

describe('scrubCallbackHash + finishSignIn', () => {
  it('stores id, username, isMember, accessToken and an expiresAt derived from expires_in', async () => {
    const { fetchMock } = stubServer({ membership: () => Promise.resolve(answer({ member: true })) })
    setHash('#access_token=tok-1&token_type=Bearer&expires_in=604800&scope=identify')
    scrubCallbackHash()
    const before = Date.now()
    await finishSignIn()

    expect(fetchMock).toHaveBeenCalledWith('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer tok-1' },
    })

    expect(stored().id).toBe(A_MEMBER_ID)
    expect(stored().username).toBe('salamander')
    expect(stored().isMember).toBe(true)
    expect(stored().accessToken).toBe('tok-1')
    expect(stored().expiresAt).toBeGreaterThanOrEqual(before + 604800 * 1000)
    expect(stored().checkedAt).toBeGreaterThanOrEqual(before)
  })

  it('stores isMember true when the server says member', async () => {
    stubServer({ membership: () => Promise.resolve(answer({ member: true })) })
    await beginFinish('tok-2')

    expect(stored().isMember).toBe(true)
    expect(currentMember()).toMatchObject({ id: A_MEMBER_ID, username: 'salamander', isMember: true })
  })

  it('false when the server says not a member', async () => {
    stubServer({
      user: { id: NOT_A_MEMBER_ID, username: 'outsider' },
      membership: () => Promise.resolve(answer({ member: false })),
    })
    await beginFinish('tok-2')

    expect(stored().isMember).toBe(false)
    expect(currentMember()).toMatchObject({ id: NOT_A_MEMBER_ID, username: 'outsider', isMember: false })
  })

  it('a failed or non-boolean answer stores false and still signs the person in', async () => {
    const answers = {
      'the request is refused (fetch rejects)': () => Promise.reject(new Error('offline')),
      'a 503 because Discord cannot be reached': () =>
        Promise.resolve(answer({ error: 'Discord is unreachable.' }, 503)),
      'a 401 because the token was refused': () => Promise.resolve(answer({ error: 'Sign in again.' }, 401)),
      "a string 'yes'": () => Promise.resolve(answer({ member: 'yes' })),
      "a string 'true'": () => Promise.resolve(answer({ member: 'true' })),
      'the number 1': () => Promise.resolve(answer({ member: 1 })),
      'a missing key': () => Promise.resolve(answer({})),
      'null': () => Promise.resolve(answer({ member: null })),
      'a body that is not JSON': () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) }),
    }
    for (const [label, membership] of Object.entries(answers)) {
      localStorage.clear()
      stubServer({ membership })
      const before = Date.now()
      await expect(beginFinish('tok-fail'), label).resolves.toBeUndefined()

      // Signed in, as a person who is not (known to be) a member; everything else as it always was.
      expect(stored().isMember, label).toBe(false)
      expect(stored().id, label).toBe(A_MEMBER_ID)
      expect(stored().username, label).toBe('salamander')
      expect(stored().accessToken, label).toBe('tok-fail')
      expect(stored().expiresAt, label).toBeGreaterThanOrEqual(before + 3600 * 1000)
      expect(getAccessToken(), label).toBe('tok-fail')
    }
  })

  it('the membership call carries the same token', async () => {
    const { sent } = stubServer({ membership: () => Promise.resolve(answer({ member: true })) })
    await beginFinish('tok-same')

    expect(sent[USER_URL].headers.Authorization).toBe('Bearer tok-same')
    expect(sent[MEMBERSHIP_URL].headers.Authorization).toBe('Bearer tok-same')
  })

  it('falls back to a 1-hour expiry when expires_in is missing from the callback', async () => {
    stubServer({ user: { id: A_MEMBER_ID, username: 'x' } })
    setHash('#access_token=tok-3')
    scrubCallbackHash()
    const before = Date.now()
    await finishSignIn()

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY))
    expect(stored.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(stored.expiresAt).toBeLessThan(before + 3600 * 1000 + 5000)
  })

  it('stores nothing when Discord rejects the token', async () => {
    // A real 401 body has no id/username but still parses fine — using it
    // (rather than null) proves the early-return actually fires, instead of
    // this only passing because reading .id off a null body happens to throw.
    stubServer({ user: { message: '401: Unauthorized', code: 0 }, userOk: false })
    setHash('#access_token=bad-tok&expires_in=3600')
    scrubCallbackHash()
    await finishSignIn()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('does not throw and stores nothing on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    setHash('#access_token=tok-4&expires_in=3600')
    scrubCallbackHash()

    await expect(finishSignIn()).resolves.toBeUndefined()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('is a no-op when there is no pending token (finishSignIn called without a callback)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await finishSignIn()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores a hash with no access_token param', () => {
    setHash('#tune=1')
    scrubCallbackHash()
    expect(window.location.hash).toBe('#tune=1')
  })

  it('strips the hash but preserves the path and query exactly when nothing was stashed', () => {
    // No beginSignIn() call precedes this — simulates a stray/manually-crafted
    // callback URL, or a browser session where sessionStorage never held a
    // stash. Falls back to wherever the browser already landed.
    history.pushState(null, '', '/salamanders-site/planner?ref=discord')
    setHash('#access_token=t&expires_in=1')

    scrubCallbackHash()

    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/salamanders-site/planner')
    expect(window.location.search).toBe('?ref=discord')
  })

  it('restores the page sign-in started from, even though Discord always bounces back to the fixed root redirect_uri', () => {
    withFakeLocation(
      { origin: 'https://sm2salamanders.site', pathname: '/planner', search: '?draft=1', href: '' },
      () => beginSignIn(),
    )

    // Discord's bounce lands on the registered redirect_uri (site root),
    // token in the hash fragment.
    history.pushState(null, '', '/')
    setHash('#access_token=tok&expires_in=3600')

    scrubCallbackHash()

    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/planner')
    expect(window.location.search).toBe('?draft=1')
  })

  it('never lets the hash fragment present at sign-in time leak into the restored path', () => {
    withFakeLocation(
      { origin: 'https://sm2salamanders.site', pathname: '/planner', search: '', hash: '#junk', href: '' },
      () => beginSignIn(),
    )

    history.pushState(null, '', '/')
    setHash('#access_token=tok&expires_in=3600')
    scrubCallbackHash()

    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/planner',
    )
  })

  it('leaves a pending stash alone when the hash has no token, so a later real callback still restores it', () => {
    withFakeLocation(
      { origin: 'https://sm2salamanders.site', pathname: '/planner', search: '', href: '' },
      () => beginSignIn(),
    )

    // An unrelated page load / navigation in between, no access_token.
    history.pushState(null, '', '/some/other/page')
    setHash('#unrelated=1')
    scrubCallbackHash()
    expect(window.location.pathname).toBe('/some/other/page')

    // The real callback arrives later — the original stash is still honored.
    history.pushState(null, '', '/')
    setHash('#access_token=tok&expires_in=3600')
    scrubCallbackHash()
    expect(window.location.pathname).toBe('/planner')
  })

  it('consumes the stash on use, so a second callback does not silently reuse a stale return path', () => {
    withFakeLocation(
      { origin: 'https://sm2salamanders.site', pathname: '/planner', search: '', href: '' },
      () => beginSignIn(),
    )

    history.pushState(null, '', '/')
    setHash('#access_token=tok1&expires_in=3600')
    scrubCallbackHash()
    expect(window.location.pathname).toBe('/planner')

    // A second, unrelated callback with no fresh stash falls back to wherever
    // it currently is rather than replaying the consumed '/planner' stash.
    history.pushState(null, '', '/armoury')
    setHash('#access_token=tok2&expires_in=3600')
    scrubCallbackHash()
    expect(window.location.pathname).toBe('/armoury')
  })
})

// The membership answer is only a display hint, so sign-in never waits long for it: a slow answer reads as "not a member".
describe('finishSignIn: a slow membership answer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Answers `body` once `ms` have passed on the (fake) clock.
  const answersAfter = (ms, body) => () => new Promise((resolve) => setTimeout(() => resolve(answer(body)), ms))
  const failsAfter = (ms, error) => () => new Promise((_, reject) => setTimeout(() => reject(error), ms))
  const neverAnswers = () => new Promise(() => {})
  // jsdom queues zero-delay timers of its own (a hashchange event for the callback hash, a storage event for
  // each write). Let those run, then count what is left: anything still pending is a timer sign-in forgot.
  const timersLeft = () => {
    vi.advanceTimersByTime(0)
    return vi.getTimerCount()
  }
  const watch = (promise) => {
    const seen = { settled: false }
    promise.then(() => {
      seen.settled = true
    })
    return seen
  }

  it('waits for the answer up to the 3 s limit, and not a millisecond beyond it', async () => {
    stubServer({ membership: neverAnswers })
    const seen = watch(beginFinish('tok-slow'))

    await vi.advanceTimersByTimeAsync(MEMBERSHIP_WAIT_MS - 1)
    expect(seen.settled).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()

    await vi.advanceTimersByTimeAsync(1)
    expect(seen.settled).toBe(true)
    expect(stored().isMember).toBe(false)
    expect(stored().id).toBe(A_MEMBER_ID)
    expect(stored().username).toBe('salamander')
    expect(stored().accessToken).toBe('tok-slow')
    expect(getAccessToken()).toBe('tok-slow')
  })

  it('counts an answer that arrives just inside the limit, and leaves no timer behind', async () => {
    stubServer({ membership: answersAfter(MEMBERSHIP_WAIT_MS - 100, { member: true }) })
    const seen = watch(beginFinish())

    await vi.advanceTimersByTimeAsync(MEMBERSHIP_WAIT_MS - 101)
    expect(seen.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(101)
    expect(seen.settled).toBe(true)
    expect(stored().isMember).toBe(true)
    expect(timersLeft()).toBe(0)
  })

  it('a fast answer stores it and leaves no timer behind', async () => {
    stubServer({ membership: () => Promise.resolve(answer({ member: true })) })
    await beginFinish()
    expect(stored().isMember).toBe(true)
    expect(timersLeft()).toBe(0)
  })

  it('a fast failure stores false and leaves no timer behind', async () => {
    stubServer({ membership: () => Promise.resolve(answer({ error: 'Discord is unreachable.' }, 503)) })
    await beginFinish()
    expect(stored().isMember).toBe(false)
    expect(timersLeft()).toBe(0)
  })

  it('an answer that comes after the limit changes nothing', async () => {
    stubServer({ membership: answersAfter(MEMBERSHIP_WAIT_MS + 2000, { member: true }) })
    const seen = watch(beginFinish())
    await vi.advanceTimersByTimeAsync(MEMBERSHIP_WAIT_MS)
    expect(seen.settled).toBe(true)
    expect(stored().isMember).toBe(false)

    await vi.advanceTimersByTimeAsync(2000)
    await vi.runAllTimersAsync()
    expect(stored().isMember).toBe(false)
    expect(currentMember()).toMatchObject({ id: A_MEMBER_ID, isMember: false })
    expect(timersLeft()).toBe(0)
  })

  it('a failure that comes after the limit is not an unhandled rejection', async () => {
    // Vitest fails the run on an unhandled rejection; this also listens, so that the test itself fails
    // rather than only the run.
    const escaped = []
    const onEscape = (reason) => escaped.push(reason)
    process.on('unhandledRejection', onEscape)
    try {
      stubServer({ membership: failsAfter(MEMBERSHIP_WAIT_MS + 2000, new Error('Discord answered too late')) })
      const seen = watch(beginFinish())
      await vi.advanceTimersByTimeAsync(MEMBERSHIP_WAIT_MS)
      expect(seen.settled).toBe(true)
      expect(stored().isMember).toBe(false)

      await vi.runAllTimersAsync()
      expect(stored().isMember).toBe(false)
      // Unhandled rejections are reported once the microtask queue has drained and a turn of the real
      // event loop has passed.
      vi.useRealTimers()
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      process.off('unhandledRejection', onEscape)
    }
    expect(escaped).toEqual([])
  })
})

// The return path: where sign-in brings the visitor back to. Discord's redirect is a fixed address, so the
// page is kept across the round trip: in sessionStorage, and (for a phone whose Discord app hands the
// redirect to a different browser context, where sessionStorage is empty) in a short-lived localStorage copy.
const RETURN_PATH_KEY = 'salamanders-discord-return-path'
const RETURN_FALLBACK_KEY = 'salamanders-discord-return-fallback'
const NOW = 1_700_000_000_000

const startSignIn = (options, page = { pathname: '/planner', search: '?x=1' }) =>
  withFakeLocation({ origin: 'https://sm2salamanders.site', href: '', ...page }, () => beginSignIn(options))
const stashFallback = (value) => localStorage.setItem(RETURN_FALLBACK_KEY, JSON.stringify(value))
// Discord's bounce: the fixed root, token in the fragment.
const callback = () => {
  history.pushState(null, '', '/')
  setHash('#access_token=tok&expires_in=3600')
  scrubCallbackHash()
}

describe('sanitizeReturnPath', () => {
  it('accepts a path on this site', () => {
    for (const p of ['/', '/deathwatch', '/a/b?x=1#h', '/deathwatch/eventtracker/standings', '/' + 'a'.repeat(511)]) {
      expect(sanitizeReturnPath(p), p).toBe(p)
    }
  })

  it('rejects anything that could leave the site or is malformed', () => {
    const bad = [
      '//evil.example',
      'https://evil.example',
      '/\\evil',
      '/a\\b',
      'javascript:alert(1)',
      '',
      'deathwatch',
      ' /x',
      '/ x',
      '/x\t',
      '/x\n',
      '/' + 'a'.repeat(512), // 513 characters
    ]
    for (const p of bad) expect(sanitizeReturnPath(p), JSON.stringify(p)).toBeNull()
  })

  it('rejects anything that is not a string', () => {
    for (const p of [null, undefined, 5, ['/x'], {}, true]) expect(sanitizeReturnPath(p), String(p)).toBeNull()
  })
})

describe('beginSignIn: the return path', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps an explicit returnTo in the session and in the fallback', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    startSignIn({ returnTo: '/deathwatch' })
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBe('/deathwatch')
    expect(JSON.parse(localStorage.getItem(RETURN_FALLBACK_KEY))).toEqual({ path: '/deathwatch', at: NOW })
  })

  it('keeps the current page, in both places, when there is no returnTo', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    startSignIn()
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBe('/planner?x=1')
    expect(JSON.parse(localStorage.getItem(RETURN_FALLBACK_KEY))).toEqual({ path: '/planner?x=1', at: NOW })
  })

  it('ignores a returnTo that is not a path on this site, and keeps the current page', () => {
    for (const returnTo of ['//evil.example', 'https://evil.example', '/\\evil', 'javascript:alert(1)', '', 5, null]) {
      sessionStorage.clear()
      localStorage.clear()
      startSignIn({ returnTo })
      expect(sessionStorage.getItem(RETURN_PATH_KEY), String(returnTo)).toBe('/planner?x=1')
      expect(JSON.parse(localStorage.getItem(RETURN_FALLBACK_KEY)).path, String(returnTo)).toBe('/planner?x=1')
    }
  })

  it('still signs in when the fallback cannot be written', () => {
    const realSet = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (this === localStorage) throw new Error('quota')
      return realSet.call(this, key, value)
    })
    const page = { origin: 'https://sm2salamanders.site', pathname: '/planner', search: '', href: '' }
    expect(() => withFakeLocation(page, () => beginSignIn({ returnTo: '/deathwatch' }))).not.toThrow()
    expect(page.href).toContain('https://discord.com/oauth2/authorize')
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBe('/deathwatch')
  })
})

describe('scrubCallbackHash: the return path fallback', () => {
  afterEach(() => vi.restoreAllMocks())

  it('restores the fallback when the session copy is gone, as after a hand-off to another browser context', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    stashFallback({ path: '/deathwatch', at: NOW - 1000 })
    callback()
    expect(window.location.pathname).toBe('/deathwatch')
    expect(window.location.hash).toBe('')
  })

  it('prefers the session copy to the fallback', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    sessionStorage.setItem(RETURN_PATH_KEY, '/builds')
    stashFallback({ path: '/deathwatch', at: NOW })
    callback()
    expect(window.location.pathname).toBe('/builds')
  })

  it('honours a fallback up to ten minutes old and not a millisecond older', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    expect(RETURN_FALLBACK_MS).toBe(10 * 60 * 1000)
    stashFallback({ path: '/deathwatch', at: NOW - RETURN_FALLBACK_MS })
    callback()
    expect(window.location.pathname).toBe('/deathwatch')

    stashFallback({ path: '/deathwatch', at: NOW - RETURN_FALLBACK_MS - 1 })
    callback()
    expect(window.location.pathname).toBe('/')
  })

  it('ignores a fallback that has been tampered with', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const tampered = [
      { path: '//evil.example', at: NOW },
      { path: 'https://evil.example', at: NOW },
      { path: '/deathwatch', at: 'yesterday' },
      { path: '/deathwatch', at: String(NOW) }, // a numeric string is not a stamp we wrote
      { path: '/deathwatch', at: NOW + 60_000 }, // from the future
      { path: '/deathwatch' },
      { at: NOW },
      null,
      [],
    ]
    for (const value of tampered) {
      stashFallback(value)
      callback()
      expect(window.location.pathname, JSON.stringify(value)).toBe('/')
    }
    localStorage.setItem(RETURN_FALLBACK_KEY, '{not json')
    callback()
    expect(window.location.pathname).toBe('/')
  })

  it('ignores a hostile session copy', () => {
    sessionStorage.setItem(RETURN_PATH_KEY, '//evil.example')
    callback()
    expect(window.location.pathname).toBe('/')
    expect(window.location.host).not.toBe('evil.example')
  })

  it('removes both copies, whether it used them or not', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    sessionStorage.setItem(RETURN_PATH_KEY, '/builds')
    stashFallback({ path: '/deathwatch', at: NOW })
    callback()
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull()
    expect(localStorage.getItem(RETURN_FALLBACK_KEY)).toBeNull()

    sessionStorage.setItem(RETURN_PATH_KEY, '//evil.example')
    stashFallback({ path: '//evil.example', at: NOW })
    callback()
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull()
    expect(localStorage.getItem(RETURN_FALLBACK_KEY)).toBeNull()
  })
})
