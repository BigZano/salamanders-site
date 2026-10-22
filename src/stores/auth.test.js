// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('../lib/discordAuth', async (orig) => ({ ...(await orig()), beginSignIn: vi.fn() }))
const { useAuth } = await import('./auth')
const { useRoster } = await import('./roster')
const { takeAnchor } = await import('../lib/archive/anchor')

beforeEach(() => {
  setActivePinia(createPinia())
  sessionStorage.clear()
})

describe('auth.signIn keeps the archive message anchor, whichever button started it', () => {
  it('on an archive thread with a message hash, the anchor is stashed for that page', () => {
    history.replaceState(null, '', '/ranks/200000000000000001#m-200000000000000011')
    useAuth().signIn()
    expect(takeAnchor('/ranks/200000000000000001')).toBe('#m-200000000000000011')
  })
  it('elsewhere nothing is stashed', () => {
    history.replaceState(null, '', '/builds#m-200000000000000011')
    useAuth().signIn()
    expect(takeAnchor('/builds')).toBeNull()
  })
})

// The store's `token` is a getter, and a getter caches. If nothing reactive is inside it, the first
// value it returns is the last: after signOut() it kept handing back the old, still valid token,
// and anything that re-asked ("a refresh after sign-out") came back signed in.
describe('auth.token', () => {
  const KEY = 'salamanders-discord-member'
  const stored = (extra = {}) =>
    localStorage.setItem(KEY, JSON.stringify({ id: '200000000000000001', username: 'tester', isMember: true, checkedAt: Date.now(), accessToken: 'old-token', expiresAt: Date.now() + 3_600_000, ...extra }))
  beforeEach(() => localStorage.clear())

  it('is the stored token while signed in', () => {
    stored()
    setActivePinia(createPinia()) // a page load: the store reads the storage when it is created
    expect(useAuth().token).toBe('old-token')
  })

  it('is gone as soon as the member signs out, even though it was read while signed in', () => {
    stored()
    setActivePinia(createPinia())
    const auth = useAuth()
    expect(auth.token).toBe('old-token') // read once, so the getter has cached it
    auth.signOut()
    expect(auth.member).toBeNull()
    expect(auth.token).toBeNull()
  })

  it('is null when nobody is signed in, and for a token that has expired', () => {
    setActivePinia(createPinia())
    expect(useAuth().token).toBeNull()
    stored({ expiresAt: Date.now() - 1000 })
    setActivePinia(createPinia())
    expect(useAuth().token).toBeNull()
  })
})

describe('auth.signOut', () => {
  it('drops the roster and Infirmary list from memory', () => {
    const roster = useRoster()
    roster.$patch({ status: 'ready', roster: { fetchedAt: 'x' }, infirmaryStatus: 'ready', infirmary: { count: 1 } })
    useAuth().signOut()
    expect(roster).toMatchObject({ status: 'idle', roster: null, infirmary: null, infirmaryStatus: 'idle' })
  })
})

describe('auth.signIn passes where to come back to', () => {
  it('forwards returnTo to the sign-in redirect', async () => {
    const { beginSignIn } = await import('../lib/discordAuth')
    beginSignIn.mockClear()
    useAuth().signIn({ returnTo: '/deathwatch' })
    expect(beginSignIn).toHaveBeenCalledWith({ returnTo: '/deathwatch' })
  })

  it('still works with no options', async () => {
    const { beginSignIn } = await import('../lib/discordAuth')
    beginSignIn.mockClear()
    useAuth().signIn()
    expect(beginSignIn).toHaveBeenCalledWith(undefined)
  })
})

describe('auth.signOut clears the Deathwatch clearance', () => {
  it('returns the Deathwatch store to idle, not a commander', async () => {
    const { useDeathwatch } = await import('./deathwatch')
    const dw = useDeathwatch()
    dw.$patch({ status: 'allowed', commander: true })
    useAuth().signOut()
    expect(dw).toMatchObject({ status: 'idle', commander: false })
  })
})
