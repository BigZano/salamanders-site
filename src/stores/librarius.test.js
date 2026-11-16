import { describe, it, expect, vi, beforeEach } from 'vitest'
import fc from 'fast-check'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('../lib/librarius/api')
import { getMe, listPosts, getPost, listMessages, getChanges, markRead } from '../lib/librarius/api'
import { useLibrarius } from './librarius'

const apiError = (status, message = 'nope') => Object.assign(new Error(message), { status })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
// Let a call that is already running get as far as its API request.
const tick = () => new Promise((r) => setTimeout(r, 0))

// Every id here is invented: 18 digits, from the range the Librarius fixtures use.
const mid = (n) => String(200000000000000000n + BigInt(n))
const POST = mid(500)
const SELF = mid(2)
const msg = (n, extra = {}) => ({ id: mid(n), authorId: SELF, authorName: 'Invented Author', content: `Message ${n}`, ...extra })
const ids = (messages) => messages.map((m) => m.id)
const person = (name) => ({ name, avatar: null })

const INITIAL = { status: 'idle', me: null, posts: [], people: {}, post: null, error: '' }
const ME = { access: true, ready: true, tags: [{ id: mid(3), name: 'Invented tag' }], roles: [], guildId: mid(4), forumId: mid(5) }
const info = () => ({ id: POST, ownerId: SELF, title: 'Invented post', tagIds: [], pinned: false, locked: false, archived: false, createdAt: '2026-11-01T00:00:00.000Z', replies: 3 })
const found = (extra = {}) => ({ post: info(), lastRead: null, rev: '40', ...extra })
const pageOf = (ns, extra = {}) => ({ messages: ns.map((n) => msg(n)), hasOlder: false, hasNewer: false, people: {}, rev: '40', ...extra })
const changesOf = (extra = {}) => ({ messages: [], deleted: [], rev: '60', people: {}, ...extra })

let s
beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  s = useLibrarius()
})

/** An open post, set straight into the store: messages given as numbers (ids), and what lies beyond them. */
const seed = (ns, { hasOlder = false, hasNewer = false, lastRead = null, rev = '40' } = {}) => {
  s.$patch((state) => {
    state.status = 'allowed'
    state.post = { id: POST, info: info(), messages: ns.map((n) => msg(n)), hasOlder, hasNewer, rev, lastRead }
  })
}
/** Everything the store can hold for a reader, so that a refusal has something to empty. */
const fill = () => {
  s.$patch((state) => {
    state.status = 'allowed'
    state.me = ME
    state.posts = [{ id: POST, title: 'Invented post' }]
    state.people = { [SELF]: person('Invented Author') }
    state.post = { id: POST, info: info(), messages: [msg(401)], hasOlder: true, hasNewer: true, rev: '40', lastRead: mid(401) }
  })
}
const snapshot = () => JSON.parse(JSON.stringify(s.$state))
const refused = (status) => ({ ...INITIAL, status })

describe('librarius store: who may read', () => {
  it('starts idle with nothing in it', () => {
    expect(s.$state).toEqual(INITIAL)
  })

  it('does not keep an earlier visit\'s clearance while it checks again, not even for an instant', () => {
    s.$patch({ status: 'allowed' })
    getMe.mockReturnValue(deferred().promise)
    s.load('tok') // not awaited: the state straight after the call is what a render would see
    expect(s.status).toBe('checking')
  })

  it('forgets an earlier error when it checks again, with a token or without', async () => {
    s.error = 'old trouble'
    getMe.mockResolvedValue(ME)
    await s.load('tok')
    expect(s.error).toBe('')
    s.error = 'old trouble'
    await s.load(null)
    expect(s.error).toBe('')
  })

  it('sends someone with no token to sign in without asking the server, and empties what was held', async () => {
    for (const token of [null, undefined, '']) {
      fill()
      await s.load(token)
      expect(s.$state, String(token)).toEqual(refused('signin'))
    }
    expect(getMe).not.toHaveBeenCalled()
  })

  it('shows checking while it asks with the token, then allowed with what the server said', async () => {
    const d = deferred()
    getMe.mockReturnValue(d.promise)
    const p = s.load('tok')
    await tick()
    expect(s.status).toBe('checking')
    expect(getMe).toHaveBeenCalledWith('tok')
    d.resolve(ME)
    await p
    expect(s.status).toBe('allowed')
    expect(s.me).toEqual(ME)
  })

  it('is importing while the server has not finished its import, and says what it knows', async () => {
    getMe.mockResolvedValue({ ...ME, ready: false })
    await s.load('tok')
    expect(s.status).toBe('importing')
    expect(s.me).toEqual({ ...ME, ready: false })
  })

  it('counts only a plain true as ready', async () => {
    for (const ready of ['yes', 'true', 1, null, undefined, [true], {}]) {
      getMe.mockResolvedValue({ ...ME, ready })
      await s.load('tok')
      expect(s.status, String(ready)).toBe('importing')
    }
  })

  it('is denied, with nothing held, for someone who may not read', async () => {
    fill()
    getMe.mockResolvedValue({ access: false })
    await s.load('tok')
    expect(s.$state).toEqual(refused('denied'))
  })

  it('fails closed on an answer that is not a plain yes', async () => {
    for (const body of [{}, null, undefined, 'access', 7, { access: 'yes' }, { access: 1 }, { access: 'true' }, { access: [true] }, { access: null }]) {
      fill()
      getMe.mockResolvedValue(body)
      await s.load('tok')
      expect(s.$state, JSON.stringify(body)).toEqual(refused('denied'))
    }
  })

  it('answers 401 with signin and 403 with denied, each with nothing held', async () => {
    fill()
    getMe.mockRejectedValue(apiError(401))
    await s.load('tok')
    expect(s.$state).toEqual(refused('signin'))
    fill()
    getMe.mockRejectedValue(apiError(403))
    await s.load('tok')
    expect(s.$state).toEqual(refused('denied'))
  })

  it('answers anything else with unavailable, and keeps what it held (an outage takes no one\'s page away)', async () => {
    for (const err of [apiError(500), apiError(503), apiError(404), apiError(undefined), new TypeError('Failed to fetch'), undefined, null, 'down']) {
      fill()
      const held = snapshot()
      getMe.mockRejectedValue(err)
      await s.load('tok')
      expect(s.status, String(err)).toBe('unavailable')
      expect({ ...snapshot(), status: 'allowed' }).toEqual(held)
    }
  })

  it('does not keep the earlier me, or let in someone who is no longer let in', async () => {
    getMe.mockResolvedValue(ME)
    await s.load('tok')
    getMe.mockResolvedValue({ access: false })
    await s.load('tok')
    expect(s.me).toBeNull()
    expect(s.status).toBe('denied')
  })
})

describe('librarius store: reset()', () => {
  it('puts everything back as it was at the start, the people and the open post included', () => {
    fill()
    s.error = 'broken'
    s.reset()
    expect(s.$state).toEqual(INITIAL)
    expect(s.people).toEqual({})
    expect(s.post).toBeNull()
  })

  it('leaves a store of its own: what was held is not shared with what comes next', () => {
    fill()
    s.reset()
    s.people[mid(9)] = person('Later')
    s.reset()
    expect(s.people).toEqual({})
  })
})

describe('librarius store: the topic list', () => {
  const topic = (n, extra = {}) => ({ id: mid(n), title: `Topic ${n}`, unread: 0, ...extra })

  it('fills the list from what the server answers, asking with the token', async () => {
    listPosts.mockResolvedValue({ posts: [topic(1), topic(2)], people: {} })
    await s.loadPosts('tok')
    expect(listPosts).toHaveBeenCalledWith('tok')
    expect(s.posts).toEqual([topic(1), topic(2)])
  })

  it('replaces the list rather than adding to it', async () => {
    s.posts = [topic(9)]
    listPosts.mockResolvedValue({ posts: [topic(1)], people: {} })
    await s.loadPosts('tok')
    expect(s.posts).toEqual([topic(1)])
    listPosts.mockResolvedValue({ posts: [], people: {} })
    await s.loadPosts('tok')
    expect(s.posts).toEqual([])
  })

  it('keeps the people the answer names, merged with those already known, the newest answer winning', async () => {
    s.people = { [mid(10)]: person('Old ten'), [mid(11)]: person('Old eleven') }
    listPosts.mockResolvedValue({ posts: [], people: { [mid(11)]: { name: 'New eleven', avatar: 'a1' }, [mid(12)]: person('New twelve') } })
    await s.loadPosts('tok')
    expect(s.people).toEqual({ [mid(10)]: person('Old ten'), [mid(11)]: { name: 'New eleven', avatar: 'a1' }, [mid(12)]: person('New twelve') })
  })

  it('takes a whole new entry for a person, not a mix of the old entry and the new', async () => {
    s.people = { [mid(10)]: { name: 'Old', avatar: 'old-avatar', extra: 'x' } }
    listPosts.mockResolvedValue({ posts: [], people: { [mid(10)]: { name: 'New', avatar: null } } })
    await s.loadPosts('tok')
    expect(s.people[mid(10)]).toEqual({ name: 'New', avatar: null })
  })

  it.each([[null], [undefined], ['abc'], [42], [['x', 'y']], [true]])('ignores people that is %j, which is no table of them', async (junk) => {
    s.people = { [mid(10)]: person('Held') }
    listPosts.mockResolvedValue({ posts: [], people: junk })
    await s.loadPosts('tok')
    expect(s.people).toEqual({ [mid(10)]: person('Held') })
  })

  it('ignores an answer with no people at all', async () => {
    s.people = { [mid(10)]: person('Held') }
    listPosts.mockResolvedValue({ posts: [topic(1)] })
    await s.loadPosts('tok')
    expect(s.people).toEqual({ [mid(10)]: person('Held') })
    expect(s.posts).toEqual([topic(1)])
  })

  it('cannot be made to change what every object inherits by a person called __proto__', async () => {
    listPosts.mockResolvedValue({ posts: [], people: JSON.parse(`{"__proto__":{"polluted":true},"${mid(10)}":{"name":"N","avatar":null}}`) })
    await s.loadPosts('tok')
    expect(Object.getPrototypeOf(s.people)).toBe(Object.prototype)
    expect({}.polluted).toBeUndefined()
    expect(s.people.polluted).toBeUndefined()
    expect(s.people[mid(10)]).toEqual(person('N'))
  })

  it('forgets an earlier error when it asks', async () => {
    s.error = 'old trouble'
    listPosts.mockResolvedValue({ posts: [], people: {} })
    await s.loadPosts('tok')
    expect(s.error).toBe('')
  })

  it('that fails keeps what was there, reports the message and rethrows', async () => {
    s.posts = [topic(9)]
    listPosts.mockRejectedValue(apiError(503, 'Discord is not answering.'))
    await expect(s.loadPosts('tok')).rejects.toMatchObject({ status: 503 })
    expect(s.posts).toEqual([topic(9)])
    expect(s.error).toBe('Discord is not answering.')
  })

  it('that fails with no message reports a plain one', async () => {
    for (const err of [apiError(500, ''), undefined, null, 'down']) {
      s.error = ''
      listPosts.mockRejectedValue(err)
      await s.loadPosts('tok').catch(() => {})
      expect(s.error, String(err)).toBe('Something went wrong.')
    }
  })

  it('a 401 is the caller\'s to handle: it is reported and rethrown, and the store does not pretend to know why', async () => {
    s.status = 'allowed'
    listPosts.mockRejectedValue(apiError(401, 'Sign in with Discord.'))
    await expect(s.loadPosts('tok')).rejects.toMatchObject({ status: 401 })
    expect(s.status).toBe('allowed')
    expect(s.error).toBe('Sign in with Discord.')
  })
})

describe('librarius store: a 403 on any read takes the page away', () => {
  const REFUSED = apiError(403, 'Restricted to those who can read the Librarius in Discord.')
  const calls = {
    loadPosts: { run: () => s.loadPosts('tok'), setup: () => listPosts.mockRejectedValue(REFUSED) },
    'openPost (the post)': { run: () => s.openPost('tok', POST), setup: () => getPost.mockRejectedValue(REFUSED) },
    'openPost (the messages)': {
      run: () => s.openPost('tok', POST),
      setup: () => {
        getPost.mockResolvedValue(found())
        listMessages.mockRejectedValue(REFUSED)
      },
    },
    loadOlder: { run: () => s.loadOlder('tok'), setup: () => listMessages.mockRejectedValue(REFUSED), after: () => seed([401, 402], { hasOlder: true }) },
    loadNewer: { run: () => s.loadNewer('tok'), setup: () => listMessages.mockRejectedValue(REFUSED), after: () => seed([401, 402], { hasNewer: true }) },
    poll: { run: () => s.poll('tok'), setup: () => getChanges.mockRejectedValue(REFUSED), after: () => seed([401, 402]) },
    markRead: { run: () => s.markRead('tok', mid(450)), setup: () => markRead.mockRejectedValue(REFUSED), after: () => seed([401, 402], { lastRead: mid(401) }) },
  }

  it.each(Object.keys(calls))('%s: denied, everything emptied, nothing thrown and no error text', async (name) => {
    const { run, setup, after } = calls[name]
    setup()
    fill()
    after?.()
    s.error = 'earlier'
    await expect(run()).resolves.toBeUndefined()
    expect(s.$state).toEqual(refused('denied'))
  })

  it('drops every other answer that is still on its way', async () => {
    seed([401, 402], { hasOlder: true })
    const older = deferred()
    listMessages.mockReturnValue(older.promise)
    const loading = s.loadOlder('tok')
    await tick()
    getChanges.mockRejectedValue(REFUSED)
    await s.poll('tok')
    expect(s.$state).toEqual(refused('denied'))
    older.resolve(pageOf([399, 400], { hasOlder: false }))
    await loading
    expect(s.$state).toEqual(refused('denied'))
  })

  it('is no refusal when it is a stale call that got it: the newer call has its own answer', async () => {
    seed([401, 402])
    const first = deferred()
    getChanges.mockReturnValueOnce(first.promise).mockResolvedValueOnce(changesOf({ messages: [msg(403)], rev: '70' }))
    const a = s.poll('tok')
    await tick()
    await s.poll('tok')
    first.reject(REFUSED)
    await a
    expect(s.status).toBe('allowed')
    expect(ids(s.post.messages)).toEqual([mid(401), mid(402), mid(403)])
  })
})

describe('librarius store: opening a post', () => {
  it('asks for the post, then the newest page when no message was read, and keeps both', async () => {
    getPost.mockResolvedValue(found())
    listMessages.mockResolvedValue(pageOf([401, 402], { hasOlder: true }))
    await s.openPost('tok', POST)
    expect(getPost).toHaveBeenCalledWith('tok', POST)
    expect(listMessages).toHaveBeenCalledTimes(1)
    const args = listMessages.mock.calls[0]
    expect(args.slice(0, 2)).toEqual(['tok', POST])
    expect(args[2]).toStrictEqual({})
    expect(s.post).toEqual({ id: POST, info: info(), messages: [msg(401), msg(402)], hasOlder: true, hasNewer: false, rev: '40', lastRead: null })
  })

  it('asks for the page around the last message read when there is one', async () => {
    getPost.mockResolvedValue(found({ lastRead: mid(450) }))
    listMessages.mockResolvedValue(pageOf([449, 450, 451], { hasOlder: true, hasNewer: true }))
    await s.openPost('tok', POST)
    expect(listMessages.mock.calls[0].slice(0, 2)).toEqual(['tok', POST])
    expect(listMessages.mock.calls[0][2]).toStrictEqual({ around: mid(450) })
    expect(s.post).toMatchObject({ lastRead: mid(450), hasOlder: true, hasNewer: true })
  })

  describe('opening around a message the caller names', () => {
    it('asks for the page around that message, not the last read, and still puts the reader\'s mark in the post', async () => {
      getPost.mockResolvedValue(found({ lastRead: mid(450) }))
      listMessages.mockResolvedValue(pageOf([409, 410, 411], { hasOlder: true, hasNewer: true }))
      await s.openPost('tok', POST, { around: mid(410) })
      expect(listMessages).toHaveBeenCalledTimes(1)
      expect(listMessages.mock.calls[0].slice(0, 2)).toEqual(['tok', POST])
      expect(listMessages.mock.calls[0][2]).toStrictEqual({ around: mid(410) })
      expect(s.post).toMatchObject({ lastRead: mid(450), hasOlder: true, hasNewer: true })
      expect(ids(s.post.messages)).toEqual([mid(409), mid(410), mid(411)])
    })

    it('does the same for a reader with no mark, who would otherwise be given the newest page', async () => {
      getPost.mockResolvedValue(found())
      listMessages.mockResolvedValue(pageOf([409, 410]))
      await s.openPost('tok', POST, { around: mid(410) })
      expect(listMessages.mock.calls[0][2]).toStrictEqual({ around: mid(410) })
      expect(s.post.lastRead).toBeNull()
    })

    it('keeps the post on the page while the new run is on its way, so that a jump does not blank it', async () => {
      seed([401, 402], { lastRead: mid(402) })
      const d = deferred()
      getPost.mockResolvedValue(found({ lastRead: mid(400) }))
      listMessages.mockReturnValue(d.promise)
      const p = s.openPost('tok', POST, { around: mid(480) })
      await tick()
      expect(ids(s.post.messages)).toEqual([mid(401), mid(402)])
      d.resolve(pageOf([479, 480]))
      await p
      expect(ids(s.post.messages)).toEqual([mid(479), mid(480)])
      expect(s.post.lastRead).toBe(mid(402))
    })

    it('is the same as no option for an option that is undefined or null', async () => {
      for (const opts of [undefined, {}, { around: undefined }, { around: null }]) {
        listMessages.mockClear()
        getPost.mockResolvedValue(found({ lastRead: mid(450) }))
        listMessages.mockResolvedValue(pageOf([449, 450]))
        await s.openPost('tok', POST, opts)
        expect(listMessages.mock.calls[0][2], JSON.stringify(opts)).toStrictEqual({ around: mid(450) })
      }
    })

    it('refuses what is no message id before asking the server anything, and says so in `error`', async () => {
      for (const around of ['', 'abc', '12345', '1'.repeat(21), '20000000000000041x', ' 200000000000000410', 200000000000000410, {}, [], true]) {
        s.error = ''
        await expect(s.openPost('tok', POST, { around }), String(around)).rejects.toThrow(new TypeError('openPost takes the id of a message to open around.'))
        expect(s.error, String(around)).toBe('openPost takes the id of a message to open around.')
      }
      expect(getPost).not.toHaveBeenCalled()
      expect(listMessages).not.toHaveBeenCalled()
    })

    it('a late answer for an older opening around a date does not replace a newer one', async () => {
      const slow = deferred()
      getPost.mockResolvedValue(found())
      listMessages.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(pageOf([490, 491]))
      const a = s.openPost('tok', POST, { around: mid(410) })
      await tick()
      await s.openPost('tok', POST, { around: mid(490) })
      slow.resolve(pageOf([409, 410]))
      await a
      expect(ids(s.post.messages)).toEqual([mid(490), mid(491)])
    })
  })

  it('does not ask for the messages until the post has answered', async () => {
    const d = deferred()
    getPost.mockReturnValue(d.promise)
    listMessages.mockResolvedValue(pageOf([401]))
    const p = s.openPost('tok', POST)
    await tick()
    expect(listMessages).not.toHaveBeenCalled()
    d.resolve(found())
    await p
    expect(listMessages).toHaveBeenCalledTimes(1)
  })

  it('shows no post until both answers are in', async () => {
    const d = deferred()
    getPost.mockResolvedValue(found())
    listMessages.mockReturnValue(d.promise)
    const p = s.openPost('tok', POST)
    await tick()
    expect(s.post).toBeNull()
    d.resolve(pageOf([401]))
    await p
    expect(s.post.id).toBe(POST)
  })

  it('keeps the earlier rev of the two answers, since a poll asks from there (compared as numbers)', async () => {
    for (const [fromPost, fromPage, expected] of [
      ['40', '45', '40'],
      ['45', '40', '40'],
      ['40', '40', '40'],
      ['9', '10', '9'],
      ['10', '9', '9'],
      ['0', '9223372036854775807', '0'],
    ]) {
      getPost.mockResolvedValue(found({ rev: fromPost }))
      listMessages.mockResolvedValue(pageOf([401], { rev: fromPage }))
      await s.openPost('tok', POST)
      expect(s.post.rev, `${fromPost} ${fromPage}`).toBe(expected)
    }
  })

  it('counts only a plain true for what lies beyond the page', async () => {
    for (const flag of ['yes', 'true', 1, null, undefined, [true], {}]) {
      getPost.mockResolvedValue(found())
      listMessages.mockResolvedValue({ ...pageOf([401]), hasOlder: flag, hasNewer: flag })
      await s.openPost('tok', POST)
      expect(s.post, String(flag)).toMatchObject({ hasOlder: false, hasNewer: false })
    }
  })

  it('merges the people the page names', async () => {
    s.people = { [mid(10)]: person('Held'), [mid(11)]: person('Old') }
    getPost.mockResolvedValue(found())
    listMessages.mockResolvedValue(pageOf([401], { people: { [mid(11)]: person('New') } }))
    await s.openPost('tok', POST)
    expect(s.people).toEqual({ [mid(10)]: person('Held'), [mid(11)]: person('New') })
  })

  it('forgets an earlier error when it asks', async () => {
    s.error = 'old trouble'
    getPost.mockResolvedValue(found())
    listMessages.mockResolvedValue(pageOf([401]))
    await s.openPost('tok', POST)
    expect(s.error).toBe('')
  })

  it('takes the earlier post off the page at once when another is asked for', () => {
    seed([401])
    getPost.mockReturnValue(deferred().promise)
    s.openPost('tok', mid(501)) // not awaited
    expect(s.post).toBeNull()
  })

  it('keeps the same post on the page while it is asked for again, then replaces it', async () => {
    seed([401, 402])
    const d = deferred()
    getPost.mockResolvedValue(found())
    listMessages.mockReturnValue(d.promise)
    const p = s.openPost('tok', POST)
    await tick()
    expect(ids(s.post.messages)).toEqual([mid(401), mid(402)])
    d.resolve(pageOf([405, 406]))
    await p
    expect(ids(s.post.messages)).toEqual([mid(405), mid(406)])
  })

  describe('where the reader is put when the post is asked for again', () => {
    it.each([
      ['the server\'s mark is newer', mid(460), mid(450), mid(460)],
      ['the held mark is newer (its report has not landed)', mid(450), mid(460), mid(460)],
      ['the marks are equal', mid(450), mid(450), mid(450)],
      ['only the server has one', mid(450), null, mid(450)],
      ['only the store has one', null, mid(450), mid(450)],
      ['the shorter number is the older, whatever the text says', '99999999999999999', '100000000000000000', '100000000000000000'],
      ['the longer number is the newer, either way round', '100000000000000000', '99999999999999999', '100000000000000000'],
    ])('%s', async (_name, server, held, expected) => {
      seed([401], { lastRead: held })
      getPost.mockResolvedValue(found({ lastRead: server }))
      listMessages.mockResolvedValue(pageOf([401]))
      await s.openPost('tok', POST)
      expect(listMessages.mock.calls[0][2]).toStrictEqual({ around: expected })
      expect(s.post.lastRead).toBe(expected)
    })

    it('opens the newest page when neither has a mark', async () => {
      seed([401], { lastRead: null })
      getPost.mockResolvedValue(found({ lastRead: null }))
      listMessages.mockResolvedValue(pageOf([401]))
      await s.openPost('tok', POST)
      expect(listMessages.mock.calls[0][2]).toStrictEqual({})
      expect(s.post.lastRead).toBeNull()
    })

    it('takes no mark from a different post that was open', async () => {
      seed([401], { lastRead: mid(499) })
      getPost.mockResolvedValue({ ...found({ lastRead: null }), post: { ...info(), id: mid(501) } })
      listMessages.mockResolvedValue(pageOf([401]))
      await s.openPost('tok', mid(501))
      expect(listMessages.mock.calls[0][2]).toStrictEqual({})
      expect(s.post).toMatchObject({ id: mid(501), lastRead: null })
    })

    it('reads the held mark as it stands when the post has answered, not as it stood when it was asked', async () => {
      seed([401], { lastRead: mid(450) })
      const d = deferred()
      getPost.mockReturnValue(d.promise)
      listMessages.mockResolvedValue(pageOf([401]))
      const p = s.openPost('tok', POST)
      await tick()
      s.post.lastRead = mid(470)
      d.resolve(found({ lastRead: mid(450) }))
      await p
      expect(listMessages.mock.calls[0][2]).toStrictEqual({ around: mid(470) })
    })
  })

  describe('that fails', () => {
    it('says why, leaves no post and rethrows (a post that is not there is a 404)', async () => {
      seed([401])
      getPost.mockRejectedValue(apiError(404, 'No such post.'))
      await expect(s.openPost('tok', mid(501))).rejects.toMatchObject({ status: 404 })
      expect(s.error).toBe('No such post.')
      expect(s.post).toBeNull()
      expect(listMessages).not.toHaveBeenCalled()
    })

    it('keeps the same post that was held, when it is that post asked for again', async () => {
      seed([401, 402])
      getPost.mockRejectedValue(apiError(503, 'Discord could not be reached. Try again.'))
      await expect(s.openPost('tok', POST)).rejects.toMatchObject({ status: 503 })
      expect(ids(s.post.messages)).toEqual([mid(401), mid(402)])
      expect(s.error).toBe('Discord could not be reached. Try again.')
    })

    it('after the post answered leaves no new post and rethrows', async () => {
      getPost.mockResolvedValue(found())
      listMessages.mockRejectedValue(apiError(500, 'Boom.'))
      await expect(s.openPost('tok', POST)).rejects.toMatchObject({ status: 500 })
      expect(s.post).toBeNull()
      expect(s.error).toBe('Boom.')
    })
  })

  it('leaves the store untouched when the page it got cannot be read (an id that is no number)', async () => {
    getPost.mockResolvedValue(found({ rev: 'abc' }))
    listMessages.mockResolvedValue(pageOf([401]))
    await expect(s.openPost('tok', POST)).rejects.toBeInstanceOf(SyntaxError)
    expect(s.post).toBeNull()
    expect(s.people).toEqual({})
  })
})

describe('librarius store: older and newer messages', () => {
  describe('loadOlder', () => {
    it('asks for the messages before the oldest held, and puts them first', async () => {
      seed([405, 406], { hasOlder: true })
      listMessages.mockResolvedValue(pageOf([403, 404], { hasOlder: true, hasNewer: true }))
      await s.loadOlder('tok')
      expect(listMessages.mock.calls[0].slice(0, 2)).toEqual(['tok', POST])
      expect(listMessages.mock.calls[0][2]).toStrictEqual({ before: mid(405) })
      expect(ids(s.post.messages)).toEqual([mid(403), mid(404), mid(405), mid(406)])
      expect(s.post.hasOlder).toBe(true)
    })

    it('takes hasOlder from the answer, a plain true only, and leaves hasNewer, rev, lastRead and info alone', async () => {
      seed([405], { hasOlder: true, hasNewer: true, rev: '77', lastRead: mid(405) })
      listMessages.mockResolvedValue(pageOf([404], { hasOlder: false, hasNewer: false, rev: '999' }))
      await s.loadOlder('tok')
      expect(s.post).toMatchObject({ hasOlder: false, hasNewer: true, rev: '77', lastRead: mid(405), info: info(), id: POST })
      for (const flag of ['yes', 1, null, undefined]) {
        seed([405], { hasOlder: true })
        listMessages.mockResolvedValue({ ...pageOf([404]), hasOlder: flag })
        await s.loadOlder('tok')
        expect(s.post.hasOlder, String(flag)).toBe(false)
      }
    })

    it('does nothing with no post, none older, or no message to go before', async () => {
      await s.loadOlder('tok')
      seed([405], { hasOlder: false })
      await s.loadOlder('tok')
      seed([], { hasOlder: true })
      await s.loadOlder('tok')
      expect(listMessages).not.toHaveBeenCalled()
      expect(s.error).toBe('')
      expect(s.post.messages).toEqual([])
    })

    it('merges the people it names', async () => {
      seed([405], { hasOlder: true })
      s.people = { [mid(10)]: person('Held') }
      listMessages.mockResolvedValue(pageOf([404], { people: { [mid(11)]: person('New') } }))
      await s.loadOlder('tok')
      expect(s.people).toEqual({ [mid(10)]: person('Held'), [mid(11)]: person('New') })
    })
  })

  describe('loadNewer', () => {
    it('asks for the messages after the newest held, and puts them last', async () => {
      seed([401, 402], { hasNewer: true })
      listMessages.mockResolvedValue(pageOf([403, 404], { hasNewer: true, hasOlder: true }))
      await s.loadNewer('tok')
      expect(listMessages.mock.calls[0].slice(0, 2)).toEqual(['tok', POST])
      expect(listMessages.mock.calls[0][2]).toStrictEqual({ after: mid(402) })
      expect(ids(s.post.messages)).toEqual([mid(401), mid(402), mid(403), mid(404)])
      expect(s.post.hasNewer).toBe(true)
    })

    it('takes hasNewer from the answer, a plain true only, and leaves hasOlder, rev, lastRead and info alone', async () => {
      seed([401], { hasOlder: true, hasNewer: true, rev: '77', lastRead: mid(401) })
      listMessages.mockResolvedValue(pageOf([402], { hasOlder: false, hasNewer: false, rev: '999' }))
      await s.loadNewer('tok')
      expect(s.post).toMatchObject({ hasOlder: true, hasNewer: false, rev: '77', lastRead: mid(401), info: info(), id: POST })
      for (const flag of ['yes', 1, null, undefined]) {
        seed([401], { hasNewer: true })
        listMessages.mockResolvedValue({ ...pageOf([402]), hasNewer: flag })
        await s.loadNewer('tok')
        expect(s.post.hasNewer, String(flag)).toBe(false)
      }
    })

    it('does nothing with no post, none newer, or no message to go after', async () => {
      await s.loadNewer('tok')
      seed([401], { hasNewer: false })
      await s.loadNewer('tok')
      seed([], { hasNewer: true })
      await s.loadNewer('tok')
      expect(listMessages).not.toHaveBeenCalled()
      expect(s.error).toBe('')
    })

    it('merges the people it names', async () => {
      seed([401], { hasNewer: true })
      s.people = { [mid(10)]: person('Held') }
      listMessages.mockResolvedValue(pageOf([402], { people: { [mid(11)]: person('New') } }))
      await s.loadNewer('tok')
      expect(s.people).toEqual({ [mid(10)]: person('Held'), [mid(11)]: person('New') })
    })
  })

  describe.each([
    ['loadOlder', { hasOlder: true }, (n) => [n - 3, n - 2, n - 1]],
    ['loadNewer', { hasNewer: true }, (n) => [n + 1, n + 2, n + 3]],
  ])('%s: the page merged in', (action, flags, nextTo) => {
    const run = () => s[action]('tok')

    it('drops a message the page repeats, keeping the one held', async () => {
      seed([410, 411, 412], flags)
      listMessages.mockResolvedValue({ ...pageOf([]), messages: [msg(410, { content: 'a stale copy' }), msg(412, { content: 'another' }), ...nextTo(411).map((n) => msg(n))] })
      await run()
      expect(s.post.messages.find((m) => m.id === mid(410)).content).toBe('Message 410')
      expect(s.post.messages.find((m) => m.id === mid(412)).content).toBe('Message 412')
      expect(new Set(ids(s.post.messages)).size).toBe(s.post.messages.length)
    })

    it('drops a message the page names twice', async () => {
      seed([410], flags)
      listMessages.mockResolvedValue({ ...pageOf([]), messages: [msg(411), msg(411)] })
      await run()
      expect(ids(s.post.messages).filter((id) => id === mid(411))).toHaveLength(1)
    })

    it('keeps oldest first by number, whatever order or length the ids come in', async () => {
      const short = '99999999999999990'
      const long = '1000000000000000050'
      seed([410], flags)
      listMessages.mockResolvedValue({ ...pageOf([]), messages: [{ id: long }, msg(411), { id: short }, msg(409)] })
      await run()
      expect(ids(s.post.messages)).toEqual([short, mid(409), mid(410), mid(411), long])
    })

    it('an empty page changes nothing and says there is no more that way', async () => {
      seed([410, 411], flags)
      listMessages.mockResolvedValue(pageOf([]))
      await run()
      expect(ids(s.post.messages)).toEqual([mid(410), mid(411)])
      expect(s.post[Object.keys(flags)[0]]).toBe(false)
    })

    it('that fails leaves the post as it was, reports the message and rethrows', async () => {
      seed([410], flags)
      const before = snapshot()
      listMessages.mockRejectedValue(apiError(503, 'Discord could not be reached. Try again.'))
      await expect(run()).rejects.toMatchObject({ status: 503 })
      expect({ ...snapshot(), error: '' }).toEqual(before)
      expect(s.error).toBe('Discord could not be reached. Try again.')
    })

    it('leaves the post, the flags and the people untouched when a page cannot be read', async () => {
      seed([410], flags)
      s.people = { [mid(10)]: person('Held') }
      const before = snapshot()
      listMessages.mockResolvedValue({ ...pageOf([411]), messages: [msg(411), { id: 'not a number' }], people: { [mid(11)]: person('New') } })
      await expect(run()).rejects.toBeInstanceOf(SyntaxError)
      expect({ ...snapshot(), error: '' }).toEqual(before)
    })
  })

  it('walks from an old read mark to the end with no duplicate and no gap, however the pages overlap', async () => {
    // A server of 300 messages, whose pages (cursor included, and a little before it) overlap what is held.
    const all = Array.from({ length: 300 }, (_, i) => msg(1000 + i))
    getPost.mockResolvedValue(found({ lastRead: mid(1100) }))
    listMessages.mockImplementation(async (_token, _id, { before, after, around }) => {
      const at = (id) => all.findIndex((m) => m.id === id)
      const limit = 50
      if (around !== undefined) {
        const i = at(around)
        return { messages: all.slice(Math.max(0, i - 24), i + 26), hasOlder: i - 24 > 0, hasNewer: i + 26 < all.length, people: {}, rev: '1' }
      }
      if (after !== undefined) {
        const from = Math.max(0, at(after) - 4) // starts four before the cursor: an overlapping page
        const to = at(after) + 1 + limit
        return { messages: all.slice(from, to), hasOlder: true, hasNewer: to < all.length, people: {}, rev: '1' }
      }
      const to = at(before) + 5 // ends five past it
      const from = Math.max(0, at(before) - limit)
      return { messages: all.slice(from, to), hasOlder: from > 0, hasNewer: true, people: {}, rev: '1' }
    })
    await s.openPost('tok', POST)
    let guard = 0
    while (s.post.hasNewer && guard++ < 50) await s.loadNewer('tok')
    expect(s.post.hasNewer).toBe(false)
    expect(ids(s.post.messages)).toEqual(ids(all.slice(1100 - 1000 - 24)))
    guard = 0
    while (s.post.hasOlder && guard++ < 50) await s.loadOlder('tok')
    expect(s.post.hasOlder).toBe(false)
    expect(ids(s.post.messages)).toEqual(ids(all))
  })
})

// A fake of the server's messages route (server/src/librariusStore.js listMessages) over a post of whole numbered messages.
const serverPage = (all, { before, after, around, limit = 50 } = {}) => {
  const less = (a, b) => BigInt(a) < BigInt(b)
  if (before === undefined && after === undefined && around === undefined) {
    return { messages: all.slice(-limit), hasOlder: all.length > limit, hasNewer: false }
  }
  if (before !== undefined) {
    const rows = all.filter((m) => less(m.id, before))
    return { messages: rows.slice(-limit), hasOlder: rows.length > limit, hasNewer: all.some((m) => !less(m.id, before)) }
  }
  if (after !== undefined) {
    const rows = all.filter((m) => less(after, m.id))
    return { messages: rows.slice(0, limit), hasNewer: rows.length > limit, hasOlder: all.some((m) => !less(after, m.id)) }
  }
  const half = Math.floor(limit / 2)
  const older = all.filter((m) => !less(around, m.id))
  const newer = all.filter((m) => less(around, m.id))
  return {
    messages: [...older.slice(-half), ...newer.slice(0, limit - half)],
    hasOlder: older.length > half,
    hasNewer: newer.length > limit - half,
  }
}

describe('librarius store: walking a post (property)', () => {
  const run = async ({ count, limit, markAt, overlap }) => {
    setActivePinia(createPinia())
    const store = useLibrarius()
    const all = Array.from({ length: count }, (_, i) => msg(1000 + i))
    listMessages.mockReset()
    getPost.mockReset()
    getPost.mockResolvedValue(found({ lastRead: markAt === null ? null : all[markAt].id }))
    listMessages.mockImplementation(async (_t, _id, options) => {
      const page = serverPage(all, { ...options, limit })
      if (overlap > 0 && page.messages.length > 0) {
        // The server also repeats `overlap` messages from the side already held.
        const first = all.findIndex((m) => m.id === page.messages[0].id)
        const last = first + page.messages.length
        if (options.before !== undefined) page.messages = all.slice(first, Math.min(all.length, last + overlap))
        else if (options.after !== undefined) page.messages = all.slice(Math.max(0, first - overlap), last)
      }
      return { ...page, people: {}, rev: '1' }
    })
    await store.openPost('tok', POST)
    let guard = 0
    while (store.post.hasNewer && guard++ < 1000) await store.loadNewer('tok')
    while (store.post.hasOlder && guard++ < 2000) await store.loadOlder('tok')
    return { store, all }
  }

  it('reaches every message exactly once, oldest first, whatever the size of the post, the page, the mark and the overlap', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 300 }),
        fc.integer({ min: 4, max: 100 }),
        fc.nat(299),
        fc.boolean(),
        fc.integer({ min: 0, max: 3 }),
        async (count, limit, mark, hasMark, overlap) => {
          const { store, all } = await run({ count, limit, markAt: hasMark ? mark % count : null, overlap })
          expect(store.post.hasNewer).toBe(false)
          expect(store.post.hasOlder).toBe(false)
          expect(ids(store.post.messages)).toEqual(ids(all))
        },
      ),
      { numRuns: 60 },
    )
  })
})

describe('librarius store: polling for changes', () => {
  it('does nothing with no post open', async () => {
    await s.poll('tok')
    expect(getChanges).not.toHaveBeenCalled()
    expect(s.error).toBe('')
  })

  it('asks what changed since the rev the post holds', async () => {
    seed([401], { rev: '123' })
    getChanges.mockResolvedValue(changesOf())
    await s.poll('tok')
    expect(getChanges).toHaveBeenCalledWith('tok', POST, '123')
  })

  it('replaces an edited message where it stands, by id', async () => {
    seed([401, 402, 403])
    getChanges.mockResolvedValue(changesOf({ messages: [msg(402, { content: 'edited', editedAt: '2026-11-15T00:00:00.000Z' })] }))
    await s.poll('tok')
    expect(s.post.messages).toEqual([msg(401), msg(402, { content: 'edited', editedAt: '2026-11-15T00:00:00.000Z' }), msg(403)])
  })

  it('removes a deleted message, and one that is not held does no harm', async () => {
    seed([401, 402, 403])
    getChanges.mockResolvedValue(changesOf({ deleted: [mid(402), mid(499)] }))
    await s.poll('tok')
    expect(ids(s.post.messages)).toEqual([mid(401), mid(403)])
  })

  it('lets a delete win over a message of the same id in the same answer', async () => {
    seed([401, 402])
    getChanges.mockResolvedValue(changesOf({ messages: [msg(402, { content: 'edited' })], deleted: [mid(402)] }))
    await s.poll('tok')
    expect(ids(s.post.messages)).toEqual([mid(401)])
  })

  it('appends a new message at the end when nothing newer lies unloaded', async () => {
    seed([401, 402], { hasNewer: false })
    getChanges.mockResolvedValue(changesOf({ messages: [msg(403), msg(404)] }))
    await s.poll('tok')
    expect(ids(s.post.messages)).toEqual([mid(401), mid(402), mid(403), mid(404)])
  })

  it('does not append a new message while newer ones lie unloaded: loadNewer will reach it in order', async () => {
    seed([401, 402], { hasNewer: true })
    getChanges.mockResolvedValue(changesOf({ messages: [msg(403, { content: 'new' }), msg(402, { content: 'edited' })] }))
    await s.poll('tok')
    expect(s.post.messages).toEqual([msg(401), msg(402, { content: 'edited' })])
  })

  it('appends to a post with no message yet', async () => {
    seed([], { hasNewer: false })
    getChanges.mockResolvedValue(changesOf({ messages: [msg(401)] }))
    await s.poll('tok')
    expect(ids(s.post.messages)).toEqual([mid(401)])
  })

  it('adds nothing to an empty post while newer ones lie unloaded', async () => {
    seed([], { hasNewer: true })
    getChanges.mockResolvedValue(changesOf({ messages: [msg(401)] }))
    await s.poll('tok')
    expect(s.post.messages).toEqual([])
  })

  it('ignores an edit to a message older than any held, while older ones lie unloaded', async () => {
    seed([405, 406], { hasOlder: true })
    getChanges.mockResolvedValue(changesOf({ messages: [msg(401, { content: 'edited' })] }))
    await s.poll('tok')
    expect(ids(s.post.messages)).toEqual([mid(405), mid(406)])
  })

  it('puts a message older than any held in front when the post is held from its first message', async () => {
    seed([405, 406], { hasOlder: false })
    getChanges.mockResolvedValue(changesOf({ messages: [msg(401)] }))
    await s.poll('tok')
    expect(ids(s.post.messages)).toEqual([mid(401), mid(405), mid(406)])
  })

  it('puts a message that falls between held ones in its place, a late-stored message being one', async () => {
    seed([401, 405], { hasOlder: true, hasNewer: true })
    getChanges.mockResolvedValue(changesOf({ messages: [msg(403)] }))
    await s.poll('tok')
    expect(ids(s.post.messages)).toEqual([mid(401), mid(403), mid(405)])
  })

  it('takes a message at the very edge of what is held as held, by id, whatever lies beyond', async () => {
    seed([401, 405], { hasOlder: true, hasNewer: true })
    getChanges.mockResolvedValue(changesOf({ messages: [msg(401, { content: 'first' }), msg(405, { content: 'last' })] }))
    await s.poll('tok')
    expect(s.post.messages).toEqual([msg(401, { content: 'first' }), msg(405, { content: 'last' })])
  })

  it('orders by number, not by text, when ids differ in length', async () => {
    seed([401], { hasOlder: false, hasNewer: false })
    getChanges.mockResolvedValue(changesOf({ messages: [{ id: '1000000000000000050' }, { id: '99999999999999990' }] }))
    await s.poll('tok')
    expect(ids(s.post.messages)).toEqual(['99999999999999990', mid(401), '1000000000000000050'])
  })

  it('moves rev to the answer\'s, and leaves info, lastRead and the flags alone', async () => {
    seed([401], { rev: '40', lastRead: mid(401), hasOlder: true })
    getChanges.mockResolvedValue(changesOf({ rev: '75' }))
    await s.poll('tok')
    expect(s.post).toMatchObject({ rev: '75', lastRead: mid(401), hasOlder: true, hasNewer: false, info: info(), id: POST })
  })

  it('merges the people it names', async () => {
    seed([401])
    s.people = { [mid(10)]: person('Held'), [mid(11)]: person('Old') }
    getChanges.mockResolvedValue(changesOf({ people: { [mid(11)]: person('New') } }))
    await s.poll('tok')
    expect(s.people).toEqual({ [mid(10)]: person('Held'), [mid(11)]: person('New') })
  })

  it('applies a repeated answer once: the poll asks from a little before, so it may send a change twice', async () => {
    seed([401, 402])
    const answer = changesOf({ messages: [msg(402, { content: 'edited' }), msg(403)], deleted: [mid(401)] })
    getChanges.mockResolvedValue(answer)
    await s.poll('tok')
    await s.poll('tok')
    expect(s.post.messages).toEqual([msg(402, { content: 'edited' }), msg(403)])
  })

  it('decides where a message goes by what is held when the answer lands, not when it was asked for', async () => {
    seed([401], { hasNewer: true })
    const d = deferred()
    getChanges.mockReturnValue(d.promise)
    const p = s.poll('tok')
    await tick()
    s.post.hasNewer = false // a loadNewer reached the end of the post meanwhile
    d.resolve(changesOf({ messages: [msg(402)] }))
    await p
    expect(ids(s.post.messages)).toEqual([mid(401), mid(402)])
  })

  it('forgets an earlier error when it asks', async () => {
    seed([401])
    s.error = 'old trouble'
    getChanges.mockResolvedValue(changesOf())
    await s.poll('tok')
    expect(s.error).toBe('')
  })

  it('that fails leaves the post as it was, reports the message and rethrows', async () => {
    seed([401, 402], { rev: '40' })
    const before = snapshot()
    getChanges.mockRejectedValue(apiError(503, 'Discord could not be reached. Try again.'))
    await expect(s.poll('tok')).rejects.toMatchObject({ status: 503 })
    expect({ ...snapshot(), error: '' }).toEqual(before)
    expect(s.error).toBe('Discord could not be reached. Try again.')
  })

  it('leaves the post untouched when an answer cannot be read', async () => {
    seed([401, 402], { rev: '40' })
    const before = snapshot()
    getChanges.mockResolvedValue(changesOf({ messages: [msg(402, { content: 'edited' }), { id: 'not a number' }], rev: '80' }))
    await expect(s.poll('tok')).rejects.toBeInstanceOf(SyntaxError)
    expect({ ...snapshot(), error: '' }).toEqual(before)
  })

  describe('when the server says to start over', () => {
    it('opens the same post again: its mark as it stands, else the newest page, and rev afresh', async () => {
      seed([401, 402], { rev: '40', lastRead: mid(402) })
      getChanges.mockResolvedValue({ reset: true })
      getPost.mockResolvedValue(found({ lastRead: mid(402), rev: '900' }))
      listMessages.mockResolvedValue(pageOf([401, 402, 403, 404], { hasOlder: true, hasNewer: true, rev: '905' }))
      await s.poll('tok')
      expect(getPost).toHaveBeenCalledWith('tok', POST)
      expect(listMessages.mock.calls[0][2]).toStrictEqual({ around: mid(402) })
      expect(s.post).toEqual({ id: POST, info: info(), messages: [msg(401), msg(402), msg(403), msg(404)], hasOlder: true, hasNewer: true, rev: '900', lastRead: mid(402) })
    })

    it('keeps the reader\'s place when the report of it has not landed, and the newest page when there is none', async () => {
      seed([401], { lastRead: mid(450) })
      getChanges.mockResolvedValue({ reset: true })
      getPost.mockResolvedValue(found({ lastRead: null }))
      listMessages.mockResolvedValue(pageOf([450]))
      await s.poll('tok')
      expect(listMessages.mock.calls[0][2]).toStrictEqual({ around: mid(450) })

      seed([401], { lastRead: null })
      listMessages.mockClear()
      await s.poll('tok')
      expect(listMessages.mock.calls[0][2]).toStrictEqual({})
    })

    it('does not ask for changes again, and does not apply the answer\'s lists', async () => {
      seed([401])
      getChanges.mockResolvedValue({ reset: true, messages: [msg(999)], deleted: [mid(401)], rev: '1' })
      getPost.mockResolvedValue(found())
      listMessages.mockResolvedValue(pageOf([401]))
      await s.poll('tok')
      expect(getChanges).toHaveBeenCalledTimes(1)
      expect(ids(s.post.messages)).toEqual([mid(401)])
    })

    it('counts only a plain true as that', async () => {
      for (const reset of [false, 'true', 1, null, undefined, [true]]) {
        seed([401], { rev: '40' })
        getChanges.mockResolvedValue(changesOf({ reset, rev: '77' }))
        await s.poll('tok')
        expect(s.post.rev, String(reset)).toBe('77')
      }
      expect(getPost).not.toHaveBeenCalled()
    })

    it('keeps the post and says why when opening it again fails', async () => {
      seed([401, 402], { rev: '40' })
      getChanges.mockResolvedValue({ reset: true })
      getPost.mockRejectedValue(apiError(503, 'Discord could not be reached. Try again.'))
      await expect(s.poll('tok')).rejects.toMatchObject({ status: 503 })
      expect(ids(s.post.messages)).toEqual([mid(401), mid(402)])
      expect(s.post.rev).toBe('40')
      expect(s.error).toBe('Discord could not be reached. Try again.')
    })

    it('takes the page away when opening it again is refused', async () => {
      seed([401])
      getChanges.mockResolvedValue({ reset: true })
      getPost.mockRejectedValue(apiError(403))
      await s.poll('tok')
      expect(s.$state).toEqual(refused('denied'))
    })
  })
})

describe('librarius store: a poll against the post as the server holds it (property)', () => {
  it('leaves the part of the post that was loaded as the server has it now', async () => {
    const edit = fc.record({ at: fc.nat(1000), text: fc.string({ maxLength: 8 }) })
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 40 }), // messages the post had
        fc.nat(40),
        fc.nat(40), // the loaded slice: [from, from + width)
        fc.boolean(),
        fc.boolean(),
        fc.array(edit, { maxLength: 8 }),
        fc.array(fc.nat(1000), { maxLength: 8 }),
        fc.integer({ min: 0, max: 5 }),
        async (count, fromRaw, widthRaw, olderUnloaded, newerUnloaded, edits, deletes, added) => {
          setActivePinia(createPinia())
          const store = useLibrarius()
          getChanges.mockReset()
          const before = Array.from({ length: count }, (_, i) => msg(1000 + i * 3))
          const from = count === 0 ? 0 : fromRaw % count
          const to = count === 0 ? 0 : Math.min(count, from + 1 + (widthRaw % count))
          // The loaded slice is the whole post unless it says more lies beyond it; it must say so truthfully.
          const lo = olderUnloaded ? from : 0
          const hi = newerUnloaded ? to : count
          const hasOlder = lo > 0
          const hasNewer = hi < count
          store.$patch((state) => {
            state.post = { id: POST, info: info(), messages: before.slice(lo, hi), hasOlder, hasNewer, rev: '40', lastRead: null }
          })
          // The server's post now: some messages edited, some deleted, some added at the end.
          const now = new Map(before.map((m) => [m.id, m]))
          const changed = new Map()
          for (const { at, text } of edits) {
            const target = before[at % Math.max(1, count)]
            if (target !== undefined) {
              const next = { ...target, content: `edit ${text}` }
              now.set(target.id, next)
              changed.set(target.id, next)
            }
          }
          const gone = new Set()
          for (const at of deletes) {
            const target = before[at % Math.max(1, count)]
            if (target !== undefined) {
              gone.add(target.id)
              now.delete(target.id)
              changed.delete(target.id)
            }
          }
          for (let i = 0; i < added; i++) {
            const fresh = msg(1000 + (count + i) * 3 + 1)
            now.set(fresh.id, fresh)
            changed.set(fresh.id, fresh)
          }
          getChanges.mockResolvedValue({ messages: [...changed.values()], deleted: [...gone], rev: '90', people: {} })
          await store.poll('tok')

          // The reader holds the server's messages inside the window loaded: from the first held message on when more
          // lies before it, to the last held when more lies after it.
          const first = lo < count && hasOlder ? BigInt(before[lo].id) : null
          const last = hasNewer ? BigInt(before[hi - 1].id) : null
          const expected = [...now.values()]
            .filter((m) => (first === null || BigInt(m.id) >= first) && (last === null || BigInt(m.id) <= last))
            .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
          expect(store.post.messages).toEqual(expected)
          expect(store.post.rev).toBe('90')
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('librarius store: marking messages read', () => {
  it('sends the message when nothing has been read, saying which post, and records it', async () => {
    seed([401, 402], { lastRead: null })
    markRead.mockResolvedValue(null)
    await s.markRead('tok', mid(402))
    expect(markRead).toHaveBeenCalledWith('tok', POST, mid(402))
    expect(s.post.lastRead).toBe(mid(402))
  })

  it('sends a message newer than the last read, and only then', async () => {
    seed([401, 402], { lastRead: mid(450) })
    markRead.mockResolvedValue(null)
    await s.markRead('tok', mid(449))
    await s.markRead('tok', mid(450))
    expect(markRead).not.toHaveBeenCalled()
    expect(s.post.lastRead).toBe(mid(450))
    await s.markRead('tok', mid(451))
    expect(markRead).toHaveBeenCalledTimes(1)
    expect(markRead).toHaveBeenCalledWith('tok', POST, mid(451))
    expect(s.post.lastRead).toBe(mid(451))
  })

  it('compares as numbers: a shorter id is the older one, even when its text sorts later', async () => {
    seed([401], { lastRead: '100000000000000000' })
    markRead.mockResolvedValue(null)
    await s.markRead('tok', '99999999999999999')
    expect(markRead).not.toHaveBeenCalled()
    seed([401], { lastRead: '99999999999999999' })
    await s.markRead('tok', '100000000000000000')
    expect(markRead).toHaveBeenCalledWith('tok', POST, '100000000000000000')
  })

  it('never sends a lower id than one already sent, even while that one is still on its way', async () => {
    seed([401], { lastRead: null })
    const d = deferred()
    markRead.mockReturnValue(d.promise)
    const first = s.markRead('tok', mid(460))
    await tick()
    await s.markRead('tok', mid(455))
    await s.markRead('tok', mid(460))
    expect(markRead).toHaveBeenCalledTimes(1)
    d.resolve(null)
    await first
    expect(s.post.lastRead).toBe(mid(460))
  })

  it('records the mark at once, before the server has answered', async () => {
    seed([401], { lastRead: null })
    markRead.mockReturnValue(deferred().promise)
    s.markRead('tok', mid(460)) // not awaited
    expect(s.post.lastRead).toBe(mid(460))
  })

  it('does nothing with no post open', async () => {
    await s.markRead('tok', mid(460))
    expect(markRead).not.toHaveBeenCalled()
    expect(s.error).toBe('')
    expect(s.post).toBeNull()
  })

  it('puts the mark back when the report fails, reports the message and rethrows', async () => {
    seed([401], { lastRead: mid(450) })
    markRead.mockRejectedValue(apiError(503, 'Discord could not be reached. Try again.'))
    await expect(s.markRead('tok', mid(460))).rejects.toMatchObject({ status: 503 })
    expect(s.post.lastRead).toBe(mid(450))
    expect(s.error).toBe('Discord could not be reached. Try again.')
  })

  it('puts back no mark when there was none', async () => {
    seed([401], { lastRead: null })
    markRead.mockRejectedValue(apiError(500, 'Boom.'))
    await expect(s.markRead('tok', mid(460))).rejects.toMatchObject({ status: 500 })
    expect(s.post.lastRead).toBeNull()
  })

  it('does not take back a later mark when an earlier report fails', async () => {
    seed([401], { lastRead: mid(450) })
    const slow = deferred()
    markRead.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(null)
    const first = s.markRead('tok', mid(460))
    await tick()
    await s.markRead('tok', mid(470))
    slow.reject(apiError(503, 'late failure'))
    await expect(first).rejects.toMatchObject({ status: 503 })
    expect(s.post.lastRead).toBe(mid(470))
  })

  it('forgets an earlier error when it sends', async () => {
    seed([401])
    s.error = 'old trouble'
    markRead.mockResolvedValue(null)
    await s.markRead('tok', mid(460))
    expect(s.error).toBe('')
  })

  it.each([
    ['empty', ''],
    ['letters', 'abc'],
    ['a short number', '12345'],
    ['16 digits', '1234567890123456'],
    ['21 digits', '123456789012345678901'],
    ['a sign', '-200000000000000460'],
    ['a decimal', '200000000000000460.5'],
    ['padded', ' 200000000000000460'],
    ['a trailing newline', '200000000000000460\n'],
    ['hex', '0x2c68af0bb140460'],
    ['full-width digits', '２０００００００００００００４６０'],
    ['a number', 200000000000000460],
    ['a BigInt', 200000000000000460n],
    ['null', null],
    ['undefined', undefined],
    ['an object', { toString: () => '200000000000000460' }],
    ['an array', ['200000000000000460']],
  ])('refuses %s, which is no message id, and sends nothing', async (_name, value) => {
    seed([401], { lastRead: mid(450) })
    await expect(s.markRead('tok', value)).rejects.toThrow(new TypeError('markRead takes the id of a message.'))
    expect(markRead).not.toHaveBeenCalled()
    expect(s.post.lastRead).toBe(mid(450))
  })

  it('accepts ids of 17 and of 20 digits', async () => {
    seed([401], { lastRead: null })
    markRead.mockResolvedValue(null)
    await s.markRead('tok', '10000000000000000')
    expect(markRead).toHaveBeenLastCalledWith('tok', POST, '10000000000000000')
    await s.markRead('tok', '18446744073709551615')
    expect(markRead).toHaveBeenLastCalledWith('tok', POST, '18446744073709551615')
  })

  it('records a mark only on the open post, never on a post asked for later', async () => {
    seed([401], { lastRead: null })
    const d = deferred()
    markRead.mockReturnValue(d.promise)
    const p = s.markRead('tok', mid(460))
    await tick()
    getPost.mockReturnValue(deferred().promise)
    s.openPost('tok', mid(501)) // not awaited: the post is taken off the page
    d.reject(apiError(503, 'late failure'))
    await p
    expect(s.post).toBeNull()
    expect(s.error).toBe('')
  })
})

// An answer that arrives after the store has moved on must change nothing: not after reset(), not after a newer load().
describe('librarius store: late answers', () => {
  const answer = {
    load: ME,
    loadPosts: { posts: [{ id: mid(1), title: 'Late' }], people: { [mid(9)]: person('Late') } },
    getPost: found({ lastRead: null, rev: '41' }),
    openPage: pageOf([701, 702], { people: { [mid(9)]: person('Late') } }),
    older: pageOf([399, 400], { hasOlder: false, people: { [mid(9)]: person('Late') } }),
    newer: pageOf([403, 404], { hasNewer: false, people: { [mid(9)]: person('Late') } }),
    changes: changesOf({ messages: [msg(401, { content: 'late edit' }), msg(403)], deleted: [mid(402)], rev: '999', people: { [mid(9)]: person('Late') } }),
  }

  // Each case starts one action with its API call pending, and says how to settle it.
  const cases = {
    load: (d) => {
      getMe.mockReturnValue(d.promise)
      return { run: () => s.load('tok'), ok: answer.load }
    },
    loadPosts: (d) => {
      listPosts.mockReturnValue(d.promise)
      return { run: () => s.loadPosts('tok'), ok: answer.loadPosts }
    },
    'openPost (waiting for the post)': (d) => {
      getPost.mockReturnValue(d.promise)
      return { run: () => s.openPost('tok', POST), ok: answer.getPost }
    },
    'openPost (waiting for the messages)': (d) => {
      getPost.mockResolvedValue(answer.getPost)
      listMessages.mockReturnValue(d.promise)
      return { run: () => s.openPost('tok', POST), ok: answer.openPage }
    },
    loadOlder: (d) => {
      seed([401, 402], { hasOlder: true })
      listMessages.mockReturnValue(d.promise)
      return { run: () => s.loadOlder('tok'), ok: answer.older }
    },
    loadNewer: (d) => {
      seed([401, 402], { hasNewer: true })
      listMessages.mockReturnValue(d.promise)
      return { run: () => s.loadNewer('tok'), ok: answer.newer }
    },
    poll: (d) => {
      seed([401, 402])
      getChanges.mockReturnValue(d.promise)
      return { run: () => s.poll('tok'), ok: answer.changes }
    },
    'poll (waiting for the post to open again)': (d) => {
      seed([401, 402])
      getChanges.mockResolvedValue({ reset: true })
      getPost.mockResolvedValue(answer.getPost)
      listMessages.mockReturnValue(d.promise)
      return { run: () => s.poll('tok'), ok: answer.openPage }
    },
    markRead: (d) => {
      seed([401, 402], { lastRead: mid(401) })
      markRead.mockReturnValue(d.promise)
      return { run: () => s.markRead('tok', mid(450)), ok: null }
    },
  }
  const names = Object.keys(cases)

  /** Starts the case, lets it reach its pending call, and hands back what is needed to settle it. */
  const start = async (name) => {
    const d = deferred()
    const { run, ok } = cases[name](d)
    const p = run()
    await tick()
    return { d, ok, p }
  }

  describe.each(names)('%s', (name) => {
    it('lands nothing when it arrives after reset()', async () => {
      const { d, ok, p } = await start(name)
      s.reset()
      d.resolve(ok)
      await p
      expect(s.$state).toEqual(INITIAL)
    })

    it('throws and reports nothing when it fails after reset()', async () => {
      const { d, p } = await start(name)
      s.reset()
      d.reject(apiError(503, 'late failure'))
      await expect(p).resolves.toBeUndefined()
      expect(s.$state).toEqual(INITIAL)
    })

    it('lands nothing when it arrives after a newer load() has begun', async () => {
      const { d, ok, p } = await start(name)
      getMe.mockReturnValue(deferred().promise)
      s.load('tok2') // not awaited: it stays pending
      const held = snapshot()
      d.resolve(ok)
      await p
      expect(snapshot()).toEqual(held)
    })

    it('reports nothing when it fails after a newer load() has begun', async () => {
      const { d, p } = await start(name)
      getMe.mockReturnValue(deferred().promise)
      s.load('tok2')
      const held = snapshot()
      d.reject(apiError(503, 'late failure'))
      await expect(p).resolves.toBeUndefined()
      expect(snapshot()).toEqual(held)
    })

    it('lands nothing when it arrives after reset() and a call of its own has begun since', async () => {
      const first = await start(name)
      s.reset()
      await start(name) // the same call asked for again: its answer is still pending
      const held = snapshot()
      first.d.resolve(first.ok)
      await first.p
      expect(snapshot()).toEqual(held)
    })

    it('reports nothing when it fails after reset() and a call of its own has begun since', async () => {
      const first = await start(name)
      s.reset()
      await start(name)
      const held = snapshot()
      first.d.reject(apiError(503, 'late failure'))
      await expect(first.p).resolves.toBeUndefined()
      expect(snapshot()).toEqual(held)
    })
  })

  describe('a newer call of the same kind', () => {
    it('loadPosts: the older answer is dropped, however late, and the newer lands', async () => {
      const slow = deferred()
      listPosts.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ posts: [{ id: mid(2) }], people: {} })
      const a = s.loadPosts('tok')
      await tick()
      await s.loadPosts('tok')
      slow.resolve({ posts: [{ id: mid(1) }], people: { [mid(9)]: person('Late') } })
      await a
      expect(s.posts).toEqual([{ id: mid(2) }])
      expect(s.people).toEqual({})
    })

    it('loadPosts: an older failure is dropped, not thrown', async () => {
      const slow = deferred()
      listPosts.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ posts: [{ id: mid(2) }], people: {} })
      const a = s.loadPosts('tok')
      await tick()
      await s.loadPosts('tok')
      slow.reject(apiError(503, 'late failure'))
      await expect(a).resolves.toBeUndefined()
      expect(s.error).toBe('')
      expect(s.posts).toEqual([{ id: mid(2) }])
    })

    it('load: the older answer is dropped, however late', async () => {
      const slow = deferred()
      getMe.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ access: false })
      const first = s.load('old')
      await tick()
      await s.load('new')
      expect(s.status).toBe('denied')
      slow.resolve(ME)
      await first
      expect(s.$state).toEqual(refused('denied'))
    })

    it('load: an older failure is dropped, too', async () => {
      const slow = deferred()
      getMe.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(ME)
      const first = s.load('old')
      await tick()
      await s.load('new')
      slow.reject(apiError(403))
      await first
      expect(s.status).toBe('allowed')
      expect(s.me).toEqual(ME)
    })

    it('load: every earlier load is dropped after reset(), not only the latest', async () => {
      const first = deferred()
      const second = deferred()
      getMe.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      const a = s.load('a')
      await tick()
      const b = s.load('b')
      await tick()
      s.reset()
      first.resolve(ME)
      await a
      expect(s.$state).toEqual(INITIAL)
      second.resolve(ME)
      await b
      expect(s.$state).toEqual(INITIAL)
    })

    it('openPost: the older call\'s post, answering after the newer call has finished, asks for no messages and lands nothing', async () => {
      const firstPost = deferred()
      getPost.mockReturnValueOnce(firstPost.promise).mockResolvedValueOnce({ ...found(), post: { ...info(), id: mid(501) } })
      listMessages.mockResolvedValueOnce(pageOf([601]))
      const a = s.openPost('tok', POST)
      await tick()
      await s.openPost('tok', mid(501))
      firstPost.resolve(found())
      await a
      expect(listMessages).toHaveBeenCalledTimes(1)
      expect(s.post.id).toBe(mid(501))
      expect(ids(s.post.messages)).toEqual([mid(601)])
    })

    it('openPost: the older call\'s messages, answering late, do not replace the newer post', async () => {
      const firstMessages = deferred()
      getPost.mockResolvedValueOnce(found()).mockResolvedValueOnce({ ...found(), post: { ...info(), id: mid(501) } })
      listMessages.mockReturnValueOnce(firstMessages.promise).mockResolvedValueOnce(pageOf([601]))
      const a = s.openPost('tok', POST)
      await tick()
      await s.openPost('tok', mid(501))
      firstMessages.resolve(pageOf([701, 702], { people: { [mid(9)]: person('Late') } }))
      await a
      expect(s.post.id).toBe(mid(501))
      expect(ids(s.post.messages)).toEqual([mid(601)])
      expect(s.people).toEqual({})
    })

    it('openPost: an older failure is dropped, not thrown', async () => {
      const slow = deferred()
      getPost.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(found())
      listMessages.mockResolvedValue(pageOf([601]))
      const a = s.openPost('tok', POST)
      await tick()
      await s.openPost('tok', POST)
      slow.reject(apiError(404, 'No such post.'))
      await expect(a).resolves.toBeUndefined()
      expect(s.error).toBe('')
      expect(s.post.id).toBe(POST)
    })

    it('poll: an older answer, however late, cannot undo what a newer one did', async () => {
      seed([401, 402])
      const slow = deferred()
      getChanges.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(changesOf({ deleted: [mid(402)], rev: '80' }))
      const a = s.poll('tok')
      await tick()
      await s.poll('tok')
      expect(ids(s.post.messages)).toEqual([mid(401)])
      slow.resolve(changesOf({ messages: [msg(402, { content: 'old copy' })], rev: '70' }))
      await a
      expect(ids(s.post.messages)).toEqual([mid(401)])
      expect(s.post.rev).toBe('80')
    })

    it('poll: an answer from before a post was opened is dropped even when a newer poll has begun since', async () => {
      seed([401, 402])
      const stale = deferred()
      getChanges.mockReturnValueOnce(stale.promise)
      const a = s.poll('tok')
      await tick()
      getPost.mockResolvedValue({ ...found(), post: { ...info(), id: mid(501) }, rev: '5' })
      listMessages.mockResolvedValue(pageOf([601], { rev: '5' }))
      await s.openPost('tok', mid(501))
      getChanges.mockReturnValueOnce(deferred().promise)
      s.poll('tok') // not awaited: it stays pending
      stale.resolve(changesOf({ messages: [msg(601, { content: 'from the old post' })], deleted: [], rev: '999' }))
      await a
      expect(s.post.messages).toEqual([msg(601)])
      expect(s.post.rev).toBe('5')
    })

    it('poll: an answer for the post that was open never lands in the one opened since', async () => {
      seed([401, 402])
      const slow = deferred()
      getChanges.mockReturnValue(slow.promise)
      const a = s.poll('tok')
      await tick()
      getPost.mockResolvedValue({ ...found(), post: { ...info(), id: mid(501) }, rev: '5' })
      listMessages.mockResolvedValue(pageOf([601], { rev: '5' }))
      await s.openPost('tok', mid(501))
      slow.resolve(changesOf({ messages: [msg(402, { content: 'old post' })], deleted: [mid(601)], rev: '999' }))
      await a
      expect(s.post).toMatchObject({ id: mid(501), rev: '5' })
      expect(ids(s.post.messages)).toEqual([mid(601)])
    })
  })

  describe('calls that do not replace each other', () => {
    it('a poll that lands while older messages are loading does not drop them, nor they it', async () => {
      seed([405, 406], { hasOlder: true })
      const older = deferred()
      const changes = deferred()
      listMessages.mockReturnValue(older.promise)
      getChanges.mockReturnValue(changes.promise)
      const a = s.loadOlder('tok')
      const b = s.poll('tok')
      await tick()
      changes.resolve(changesOf({ messages: [msg(407)], rev: '80' }))
      await b
      older.resolve(pageOf([403, 404], { hasOlder: true }))
      await a
      expect(ids(s.post.messages)).toEqual([mid(403), mid(404), mid(405), mid(406), mid(407)])
      expect(s.post).toMatchObject({ rev: '80', hasOlder: true })
    })

    it('older and newer messages loading together both land', async () => {
      seed([405, 406], { hasOlder: true, hasNewer: true })
      const older = deferred()
      const newer = deferred()
      listMessages.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
      const a = s.loadOlder('tok')
      const b = s.loadNewer('tok')
      await tick()
      newer.resolve(pageOf([407, 408], { hasNewer: false }))
      older.resolve(pageOf([403, 404], { hasOlder: false }))
      await Promise.all([a, b])
      expect(ids(s.post.messages)).toEqual([mid(403), mid(404), mid(405), mid(406), mid(407), mid(408)])
      expect(s.post).toMatchObject({ hasOlder: false, hasNewer: false })
    })

    it('a mark being sent does not drop a poll, nor a poll the mark', async () => {
      seed([401, 402], { lastRead: mid(401) })
      const sending = deferred()
      const changes = deferred()
      markRead.mockReturnValue(sending.promise)
      getChanges.mockReturnValue(changes.promise)
      const a = s.markRead('tok', mid(450))
      const b = s.poll('tok')
      await tick()
      changes.resolve(changesOf({ messages: [msg(403)], rev: '80' }))
      await b
      sending.resolve(null)
      await a
      expect(ids(s.post.messages)).toEqual([mid(401), mid(402), mid(403)])
      expect(s.post.lastRead).toBe(mid(450))
    })

    it('a topic list loading does not drop the open post\'s answers, nor they it', async () => {
      seed([401])
      const topics = deferred()
      const changes = deferred()
      listPosts.mockReturnValue(topics.promise)
      getChanges.mockReturnValue(changes.promise)
      const a = s.loadPosts('tok')
      const b = s.poll('tok')
      await tick()
      topics.resolve({ posts: [{ id: mid(1) }], people: {} })
      changes.resolve(changesOf({ messages: [msg(402)], rev: '80' }))
      await Promise.all([a, b])
      expect(s.posts).toEqual([{ id: mid(1) }])
      expect(ids(s.post.messages)).toEqual([mid(401), mid(402)])
    })
  })
})
