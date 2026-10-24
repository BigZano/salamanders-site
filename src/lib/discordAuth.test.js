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

const STORAGE_KEY = 'salamanders-discord-member'
// Real ids from src/data/discord-members.json, so isMember exercises the
// actual membership list rather than a stubbed one.
const A_MEMBER_ID = '75633559351595008'
const NOT_A_MEMBER_ID = '1'

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

describe('scrubCallbackHash + finishSignIn', () => {
  function stubIdentify(user, ok = true) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(user) }),
    )
  }

  it('stores id, username, isMember, accessToken and an expiresAt derived from expires_in', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: A_MEMBER_ID, username: 'salamander' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    setHash('#access_token=tok-1&token_type=Bearer&expires_in=604800&scope=identify')
    scrubCallbackHash()
    const before = Date.now()
    await finishSignIn()

    expect(fetchMock).toHaveBeenCalledWith('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer tok-1' },
    })

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY))
    expect(stored.id).toBe(A_MEMBER_ID)
    expect(stored.username).toBe('salamander')
    expect(stored.isMember).toBe(true)
    expect(stored.accessToken).toBe('tok-1')
    expect(stored.expiresAt).toBeGreaterThanOrEqual(before + 604800 * 1000)
  })

  it('marks isMember false for a real, non-member id', async () => {
    stubIdentify({ id: NOT_A_MEMBER_ID, username: 'outsider' })
    setHash('#access_token=tok-2&expires_in=3600')
    scrubCallbackHash()
    await finishSignIn()

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).isMember).toBe(false)
  })

  it('falls back to a 1-hour expiry when expires_in is missing from the callback', async () => {
    stubIdentify({ id: A_MEMBER_ID, username: 'x' })
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
    stubIdentify({ message: '401: Unauthorized', code: 0 }, false)
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
