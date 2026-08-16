// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  currentMember,
  getAccessToken,
  signOut,
  scrubCallbackHash,
  finishSignIn,
  beginSignIn,
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

describe('beginSignIn', () => {
  it("redirects to Discord's authorize endpoint with the implicit-grant params", () => {
    // Own the seam: swap window.location for a plain object we control, rather
    // than letting jsdom's real Location try (and refuse) to cross-origin
    // navigate. Restored after, so later describe blocks get the real one back.
    const realLocation = window.location
    const fakeLocation = {
      origin: 'https://bigzano.github.io',
      pathname: '/salamanders-site/',
      href: '',
    }
    Object.defineProperty(window, 'location', { value: fakeLocation, writable: true, configurable: true })

    try {
      beginSignIn()
      const url = new URL(fakeLocation.href)
      expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize')
      expect(url.searchParams.get('client_id')).toBe('1538255597810483210')
      expect(url.searchParams.get('response_type')).toBe('token')
      expect(url.searchParams.get('scope')).toBe('identify')
      // redirect_uri is origin+pathname only — the hash-route fragment must not
      // ride along, or Discord would echo the access_token back past the point
      // scrubCallbackHash looks, and the token would be lost.
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://bigzano.github.io/salamanders-site/',
      )
    } finally {
      Object.defineProperty(window, 'location', { value: realLocation, writable: true, configurable: true })
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

  it('strips the hash but preserves the path and query exactly', () => {
    history.pushState(null, '', '/salamanders-site/planner?ref=discord')
    setHash('#access_token=t&expires_in=1')

    scrubCallbackHash()

    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/salamanders-site/planner')
    expect(window.location.search).toBe('?ref=discord')
  })
})
