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

describe('auth.signOut clears the Librarius', () => {
  it('returns the Librarius store to idle, with nothing of the last reader left', async () => {
    const { useLibrarius } = await import('./librarius')
    const lib = useLibrarius()
    lib.$patch({
      status: 'allowed',
      me: { access: true, ready: true },
      posts: [{ id: '200000000000000402', title: 'Invented post' }],
      people: { '200000000000000410': { name: 'Tor Mardan', avatar: null } },
      post: { id: '200000000000000402', messages: [] },
    })
    useAuth().signOut()
    expect(lib).toMatchObject({ status: 'idle', me: null, posts: [], people: {}, post: null })
  })
})

// What the server said about the Librarius at sign-in, kept as the nav hint (see discordAuth.rememberLibrarius). The page learns
// it again on every visit to the Reliquarium, and tells the store here.
describe('auth.noteLibrarius', () => {
  const KEY = 'salamanders-discord-member'
  const stored = () => JSON.parse(localStorage.getItem(KEY))
  const signedIn = (extra = {}) => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ id: '200000000000000001', username: 'tester', isMember: false, checkedAt: 1, accessToken: 'tok', expiresAt: Date.now() + 3_600_000, librarius: false, ...extra }),
    )
    setActivePinia(createPinia()) // a page load: the store reads the storage when it is created
    return useAuth()
  }
  beforeEach(() => localStorage.clear())

  it('keeps a yes in the sign-in record, and the member the store holds follows it', () => {
    const auth = signedIn()
    expect(auth.member.librarius).toBe(false)
    auth.noteLibrarius(true)
    expect(auth.member.librarius).toBe(true)
    expect(stored().librarius).toBe(true)
    expect(auth.member).toMatchObject({ id: '200000000000000001', username: 'tester', isMember: false })
    expect(auth.token).toBe('tok')
  })

  it('keeps a no over an earlier yes', () => {
    const auth = signedIn({ librarius: true })
    auth.noteLibrarius(false)
    expect(auth.member.librarius).toBe(false)
    expect(stored().librarius).toBe(false)
  })

  it('takes anything but a plain true for a no', () => {
    for (const access of [undefined, null, 1, 'true', [true]]) {
      const auth = signedIn({ librarius: true })
      auth.noteLibrarius(access)
      expect(auth.member.librarius, String(access)).toBe(false)
      expect(stored().librarius, String(access)).toBe(false)
    }
  })

  it('learns it for someone whose record is from before the Librarius, without touching isMember', () => {
    const auth = signedIn({ isMember: true, librarius: undefined })
    expect(stored()).not.toHaveProperty('librarius')
    expect(auth.member.librarius).toBe(false)
    auth.noteLibrarius(true)
    expect(auth.member).toMatchObject({ isMember: true, librarius: true })
    expect(stored()).toMatchObject({ isMember: true, librarius: true })
  })

  it('changes nothing for nobody signed in, and never signs anyone in', () => {
    setActivePinia(createPinia())
    const auth = useAuth()
    auth.noteLibrarius(true)
    expect(auth.member).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('does not replace the member when the answer is no news, so that what watches the member does not start over', () => {
    const auth = signedIn({ librarius: true })
    const held = auth.member
    auth.noteLibrarius(true)
    expect(auth.member).toBe(held)
    auth.noteLibrarius(false)
    expect(auth.member).not.toBe(held)
    const second = auth.member
    auth.noteLibrarius(false)
    expect(auth.member).toBe(second)
  })

  it('does not bring a person back after sign-out', () => {
    const auth = signedIn()
    auth.signOut()
    auth.noteLibrarius(true)
    expect(auth.member).toBeNull()
    expect(auth.signedIn).toBe(false)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('keeps the state it had when the storage refuses the write', () => {
    const auth = signedIn()
    const held = auth.member
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    try {
      expect(() => auth.noteLibrarius(true)).not.toThrow()
    } finally {
      vi.restoreAllMocks()
    }
    expect(auth.member.librarius).toBe(false)
    expect(auth.member).toBe(held)
  })
})

// The reader's place in each Librarius post is kept for the tab (see lib/librarius/places.js). It is the last person's reading,
// so it goes with them.
describe('auth.signOut forgets the places kept in the Librarius posts', () => {
  const POST = '200000000000000402'
  const OTHER = '200000000000000403'
  beforeEach(() => sessionStorage.clear())

  it('removes the place kept for every post, and nothing else', () => {
    sessionStorage.setItem(`lb-anchor:${POST}`, '200000000000000450')
    sessionStorage.setItem(`lb-anchor:${OTHER}`, '200000000000000451')
    sessionStorage.setItem('salamanders-discord-return-path', '/planner')
    sessionStorage.setItem('lb-anchor', 'not a place')
    useAuth().signOut()
    expect(sessionStorage.getItem(`lb-anchor:${POST}`)).toBeNull()
    expect(sessionStorage.getItem(`lb-anchor:${OTHER}`)).toBeNull()
    expect(sessionStorage.getItem('salamanders-discord-return-path')).toBe('/planner')
    expect(sessionStorage.getItem('lb-anchor')).toBe('not a place')
  })

  it('still signs out, and still clears the rest, when the browser will not let it look', async () => {
    const { useLibrarius } = await import('./librarius')
    const lib = useLibrarius()
    lib.$patch({ status: 'allowed', posts: [{ id: POST, title: 'Invented post' }] })
    localStorage.setItem('salamanders-discord-member', JSON.stringify({ id: '200000000000000001', accessToken: 'tok' }))
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    try {
      expect(() => useAuth().signOut()).not.toThrow()
    } finally {
      vi.restoreAllMocks()
    }
    expect(localStorage.getItem('salamanders-discord-member')).toBeNull()
    expect(lib).toMatchObject({ status: 'idle', posts: [] })
  })
})
