// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { flushPromises, mount } from '@vue/test-utils'
import { h, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory, useRoute } from 'vue-router'

const state = vi.hoisted(() => ({ auth: null }))
vi.mock('../../stores/auth', () => ({ useAuth: () => state.auth }))
vi.mock('../../lib/librarius/api')
import { getPost, listMessages, listPosts, getChanges, markRead } from '../../lib/librarius/api'
import { useLibrarius } from '../../stores/librarius'
import { snowflakeAt } from '../../lib/librarius/snowflake'
import PostPage from './PostPage.vue'

// Every id and name here is invented. Ids that do not need to mean a date come from the range the Librarius fixtures use;
// the date rail needs ids that do, and takes them from snowflakeAt.
const mid = (n) => String(200000000000000000n + BigInt(n))
const GUILD = mid(400)
const FORUM = mid(401)
const POST = mid(402)
const OTHER = mid(403)
const TOR = mid(410)
const IXEN = mid(411)
const TAG_A = mid(420)
const TAG_B = mid(421)
const m = (n) => mid(450 + n)
const NOW = '2026-11-10T10:00:00.000Z'

const ME = { access: true, ready: true, tags: [{ id: TAG_A, name: 'Lore' }, { id: TAG_B, name: 'Rules' }], roles: [], guildId: GUILD, forumId: FORUM }
const PEOPLE = {
  [TOR]: { name: 'Tor Mardan', avatar: null },
  [IXEN]: { name: 'Ixen Calloway', avatar: null },
}
const info = (over = {}) => ({
  id: POST,
  ownerId: TOR,
  title: 'The Long Road',
  tagIds: [TAG_A],
  pinned: false,
  locked: false,
  archived: false,
  createdAt: '2026-11-08T21:14:00.000Z',
  replies: 42,
  ...over,
})
const minutes = (n) => new Date(Date.parse('2026-11-09T10:00:00.000Z') + n * 60_000).toISOString()
/** A message in the full shape the routes answer. `n` makes its id, and its time is `n` minutes into the day unless given. */
const msg = (n, over = {}) => ({
  id: m(n),
  authorId: TOR,
  authorName: 'Tor Mardan',
  authorAvatar: null,
  content: `Reply number ${n}`,
  createdAt: minutes(n * 30),
  editedAt: null,
  replyTo: null,
  attachments: [],
  embeds: [],
  stickers: [],
  reactions: [],
  origin: 'discord',
  ...over,
})
const opener = (over = {}) => msg(0, { id: POST, content: 'The opening words', createdAt: '2026-11-08T21:14:00.000Z', ...over })
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

const visibility = (value) => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

/** A browser's IntersectionObserver that does what it is told: the page's callback gets the entries a test reports. */
class FakeObserver {
  static instances = []
  constructor(callback) {
    this.callback = callback
    this.targets = new Set()
    this.disconnected = false
    FakeObserver.instances.push(this)
  }
  observe(el) {
    this.targets.add(el)
  }
  unobserve(el) {
    this.targets.delete(el)
  }
  disconnect() {
    this.targets.clear()
    this.disconnected = true
  }
}
const live = () => FakeObserver.instances.filter((o) => !o.disconnected).at(-1)
/** Says that the messages are now in view (or out of it). */
const report = (ids, isIntersecting = true) => live().callback(ids.map((id) => ({ target: document.getElementById(`m-${id}`), isIntersecting })))

// What the page scrolled to, as the element's id or its class, with the options it was given.
let scrolled
let tops
const mounted = []
let store
let router

// What the Reliquarium does with the page: shows it for the post the route names, so that a change of route changes the post
// and the address together.
const Host = {
  setup() {
    const route = useRoute()
    return () => h(PostPage, { postId: route.params.postId })
  },
}

// The page asks for a post's messages twice: for a page of them, and for the post's opening message (one message, `limit: 1`).
const asksForOpening = (opts) => opts?.limit === 1
/**
 * The server as it answers: `page` (a { messages, hasOlder, ... } answer) for a page of messages, and for the question about the
 * opening message the one message `first`, or none.
 */
function serve(page, first = null) {
  listMessages.mockImplementation(async (_token, _id, opts) => {
    if (!asksForOpening(opts)) return typeof page === 'function' ? page(opts) : page
    return { messages: first ? [first] : [], hasOlder: false, hasNewer: false, people: page.people ?? PEOPLE, rev: '40' }
  })
}
const run = (messages, over = {}) => ({ messages, hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40', ...over })
/** The page asks of the server that came last, the questions about the opening message left out: [token, post, options]. */
const lastPageAsk = () => listMessages.mock.calls.filter((call) => !asksForOpening(call[2])).at(-1)

/**
 * Mounts the page on a router, with the store holding `me` (and `held`, a post kept from an earlier visit) and the API
 * answering as given. `messages` is the run the server sends when the post is opened (oldest first). `arrange` runs after
 * the default answers are set and before the page asks, for a test that wants a different one.
 */
async function show({
  messages = [opener(), msg(1), msg(2)],
  hasOlder = false,
  hasNewer = false,
  lastRead = null,
  post = info(),
  me = ME,
  people = PEOPLE,
  posts = [],
  postId = POST,
  hash = '',
  held = null,
  host = false,
  // The post's own message, as the server answers the question about it; by default the one among `messages`, if any.
  opening = messages.find((message) => message.id === postId) ?? null,
  arrange = () => {},
  flush = true,
} = {}) {
  getPost.mockResolvedValue({ post, lastRead, rev: '40' })
  serve({ messages, hasOlder, hasNewer, people, rev: '40' }, opening)
  listPosts.mockResolvedValue({ posts: [], people: {} })
  getChanges.mockResolvedValue({ messages: [], deleted: [], rev: '41', people: {} })
  markRead.mockResolvedValue(null)
  // A test that wants an answer of its own sets it here, before the page asks.
  arrange()
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/reliquarium', component: { template: '<div />' } },
      { path: '/reliquarium/librarius', component: { template: '<div />' } },
      { path: '/reliquarium/librarius/:postId', component: { template: '<div />' } },
    ],
  })
  router.push(`/reliquarium/librarius/${postId}${hash}`)
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  store = useLibrarius()
  store.$patch((s) => {
    s.status = 'allowed'
    s.me = me
    s.posts = posts
    s.post = held
  })
  const w = host
    ? mount(Host, { global: { plugins: [pinia, router] }, attachTo: document.body })
    : mount(PostPage, { props: { postId }, global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(w)
  if (flush) await settle()
  return w
}
const leave = (w) => {
  mounted.splice(mounted.indexOf(w), 1)
  w.unmount()
}
const el = (w, id) => w.find(`#m-${id}`)
const shownIds = (w) => w.findAll('.lb-msg').map((e) => e.attributes('id').slice(2))
const button = (w, text) => w.findAll('button').find((b) => b.text() === text)
const divider = (w) => w.find('.lb-divider')
const afterDivider = (w) => divider(w).element.nextElementSibling.id.slice(2)

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date(NOW))
  state.auth = reactive({ token: 'tok', signedIn: true })
  visibility('visible')
  FakeObserver.instances = []
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  scrolled = []
  tops = new Map()
  Element.prototype.scrollIntoView = function (options) {
    scrolled.push({ at: this.id || this.className, options })
  }
  Element.prototype.getBoundingClientRect = function () {
    // A message that is no longer on the page has no place, as in a browser.
    return { top: this.isConnected ? (tops.get(this.id) ?? 0) : 0 }
  }
  window.scrollBy = vi.fn()
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete document.visibilityState
  window.history.replaceState(null, '')
  sessionStorage.clear()
  vi.restoreAllMocks()
  delete Element.prototype.scrollIntoView
  delete Element.prototype.getBoundingClientRect
})

describe('PostPage: opening the post', () => {
  it('asks for the post and its messages with the reader\'s token, and shows nothing of the post while it waits', async () => {
    const w = await show({ arrange: () => getPost.mockReturnValue(deferred().promise) })
    expect(getPost).toHaveBeenCalledWith('tok', POST)
    expect(w.text()).toContain('Loading…')
    expect(w.find('[aria-busy="true"]').exists()).toBe(true)
    expect(w.findAll('.lb-msg')).toHaveLength(0)
  })

  it('shows the messages once they are in, and no loading note', async () => {
    const w = await show()
    expect(w.text()).not.toContain('Loading…')
    expect(shownIds(w)).toEqual([POST, m(1), m(2)])
    // The page, and the question about the opening message.
    expect(listMessages).toHaveBeenCalledTimes(2)
  })

  it('opens around the place the reader had reached', async () => {
    await show({ lastRead: m(1), messages: [msg(1), msg(2)] })
    expect(listMessages.mock.calls[0][2]).toStrictEqual({ around: m(1) })
  })

  it('keeps the reader\'s place the store already holds when it is further on than the server knows, and shows none of the held messages meanwhile', async () => {
    const held = { id: POST, info: info(), messages: [opener(), msg(1)], hasOlder: false, hasNewer: false, rev: '40', lastRead: m(5) }
    const d = deferred()
    const w = await show({ held, messages: [opener(), msg(1), msg(2), msg(3), msg(4), msg(5), msg(6)], lastRead: m(1), arrange: () => getPost.mockReturnValueOnce(d.promise) })
    expect(w.findAll('.lb-msg')).toHaveLength(0)
    d.resolve({ post: info(), lastRead: m(1), rev: '40' })
    await settle()
    expect(listMessages.mock.calls[0][2]).toStrictEqual({ around: m(5) })
    expect(divider(w).text()).toBe('SINCE YOUR LAST VISIT · 1 NEW')
    expect(afterDivider(w)).toBe(m(6))
  })

  it('says the Librarius could not be reached when the post cannot be asked for, and asks again on "Retry"', async () => {
    const w = await show({ arrange: () => getPost.mockRejectedValue(apiError(503)) })
    expect(w.find('[role="alert"]').text()).toBe('The Librarius couldn\'t be reached.')
    expect(w.findAll('.lb-msg')).toHaveLength(0)
    getPost.mockResolvedValue({ post: info(), lastRead: null, rev: '40' })
    listMessages.mockResolvedValue({ messages: [opener()], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await button(w, 'Retry').trigger('click')
    await settle()
    expect(shownIds(w)).toEqual([POST])
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it('says so, with a way back to the list, for a post that is not there', async () => {
    const w = await show({ arrange: () => getPost.mockRejectedValue(apiError(404)) })
    expect(w.find('[role="alert"]').text()).toBe('That post couldn\'t be found.')
    expect(w.find('a[href="/reliquarium/librarius"]').text()).toBe('Back to the Librarius')
  })

  it('says the Librarius could not be reached when the messages fail', async () => {
    const w = await show({ arrange: () => listMessages.mockRejectedValue(apiError(500)) })
    expect(w.find('[role="alert"]').text()).toBe('The Librarius couldn\'t be reached.')
  })

  it('shows none of the post, and does not fall over, when the server refuses the reader (the store goes to "denied")', async () => {
    const w = await show({ arrange: () => getPost.mockRejectedValue(apiError(403)) })
    expect(store.status).toBe('denied')
    expect(w.findAll('.lb-msg')).toHaveLength(0)
    expect(w.find('h2').exists()).toBe(false)
    expect(w.text()).not.toContain('Loading…')
  })

  it('shows nothing, and does not fall over, when the store has taken the post away (the reader may no longer read)', async () => {
    const w = await show()
    store.$patch((s) => {
      s.post = null
      s.status = 'denied'
    })
    await settle()
    expect(w.findAll('.lb-msg')).toHaveLength(0)
  })

  it('shows a post with no messages at all without a scroll, a divider or a failure', async () => {
    const w = await show({ messages: [] })
    expect(w.findAll('.lb-msg')).toHaveLength(0)
    expect(divider(w).exists()).toBe(false)
    expect(scrolled).toEqual([])
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })
})

describe('PostPage: the header', () => {
  it('shows the breadcrumb Reliquarium › Librarius › the title, the first two as links', async () => {
    const w = await show()
    const crumbs = w.find('nav[aria-label="Breadcrumb"]')
    expect(crumbs.text().replace(/\s+/g, ' ')).toBe('Reliquarium › Librarius › The Long Road')
    expect(crumbs.findAll('a').map((a) => [a.text(), a.attributes('href')])).toEqual([
      ['Reliquarium', '/reliquarium'],
      ['Librarius', '/reliquarium/librarius'],
    ])
    expect(crumbs.find('[aria-current="page"]').text()).toBe('The Long Road')
  })

  it('shows the title as the heading', async () => {
    const w = await show()
    expect(w.find('h2').text()).toBe('The Long Road')
  })

  it('names the tags the post carries, in order, and skips a tag the forum does not list', async () => {
    const w = await show({ post: info({ tagIds: [TAG_B, mid(499), TAG_A] }) })
    expect(w.findAll('.lb-post-meta .lb-tag').map((t) => t.text())).toEqual(['Rules', 'Lore'])
  })

  it('shows no tags for a post with none, or for a forum that lists none, or when the ids are no list', async () => {
    for (const [tagIds, me] of [[[], ME], [[TAG_A], { ...ME, tags: [] }], [[TAG_A], { ...ME, tags: null }], [null, ME], ['x', ME], [undefined, ME]]) {
      const w = await show({ post: info({ tagIds }), me })
      expect(w.findAll('.lb-tag'), JSON.stringify([tagIds, me.tags])).toHaveLength(0)
      expect(w.find('h2').text()).toBe('The Long Road')
      leave(w)
    }
  })

  it.each([
    [0, '0 replies'],
    [1, '1 reply'],
    [2, '2 replies'],
    [42, '42 replies'],
    [7931, '7,931 replies'],
  ])('counts %i replies as "%s"', async (replies, text) => {
    const w = await show({ post: info({ replies }) })
    expect(w.find('.lb-post-meta').text()).toContain(text)
  })

  it('shows the day the post was started, as a time element', async () => {
    const w = await show()
    const time = w.find('.lb-post-meta time')
    expect(time.attributes('datetime')).toBe('2026-11-08T21:14:00.000Z')
    expect(w.find('.lb-post-meta').text()).toMatch(/started\s+\S/)
  })

  it('shows no start day for a date that is no date, and still shows the post', async () => {
    for (const createdAt of ['never', '', null, undefined, 7]) {
      const w = await show({ post: info({ createdAt }) })
      expect(w.find('.lb-post-meta time').exists(), String(createdAt)).toBe(false)
      expect(w.find('.lb-post-meta').text(), String(createdAt)).not.toContain('started')
      expect(shownIds(w)).toEqual([POST, m(1), m(2)])
      leave(w)
    }
  })

  it('shows the post, with no count, when the reply count is no number', async () => {
    for (const replies of [undefined, null, '7', {}, NaN, Infinity, -1, 1.5]) {
      const w = await show({ post: info({ replies }) })
      expect(w.find('.lb-post-meta').text(), String(replies)).not.toMatch(/repl/)
      expect(shownIds(w), String(replies)).toEqual([POST, m(1), m(2)])
      leave(w)
    }
  })

  it('links "Open in Discord ↗" to the post in the guild, in a new tab', async () => {
    const w = await show()
    const link = w.findAll('a').find((a) => a.text() === 'Open in Discord ↗')
    expect(link.attributes('href')).toBe(`https://discord.com/channels/${GUILD}/${POST}`)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
  })

  it('offers no Discord link when the guild is not an id, and still shows the post', async () => {
    for (const guildId of ['', 'abc', '1'.repeat(16), '1'.repeat(21), `${GUILD}/../x`, 12, null, undefined, {}]) {
      const w = await show({ me: { ...ME, guildId } })
      expect(w.findAll('a').some((a) => /Open in Discord/.test(a.text())), String(guildId)).toBe(false)
      expect(shownIds(w), String(guildId)).toEqual([POST, m(1), m(2)])
      leave(w)
    }
  })

  it('offers no Discord link for a post id that is no id', async () => {
    const w = await show({ postId: 'not-an-id' })
    expect(w.findAll('a').some((a) => /Open in Discord/.test(a.text()))).toBe(false)
  })

  it('shows the post when the store holds no answer from /me at all', async () => {
    const w = await show({ me: null })
    expect(shownIds(w)).toEqual([POST, m(1), m(2)])
    expect(w.findAll('a').some((a) => /Open in Discord/.test(a.text()))).toBe(false)
  })

  it('writes what Discord sent as text: a title and a tag with markup in them make no element', async () => {
    const evil = '<img src="x" onerror="alert(1)"><script>alert(2)</script>'
    const w = await show({ post: info({ title: evil, tagIds: [TAG_A] }), me: { ...ME, tags: [{ id: TAG_A, name: evil }] } })
    expect(w.find('h2').text()).toBe(evil)
    expect(w.find('.lb-tag').text()).toBe(evil)
    expect(w.find('img[src="x"]').exists()).toBe(false)
    expect(w.find('.lb-post-head script').exists()).toBe(false)
  })
})

describe('PostPage: the messages', () => {
  it('lays the opening message out as an article, even a short one, and a short reply as a plain message', async () => {
    const w = await show()
    expect(el(w, POST).classes()).toContain('lb-article')
    expect(el(w, m(1)).classes()).not.toContain('lb-article')
  })

  it('lays out a reply with a heading, or a long one, or one with two pictures, as an article too', async () => {
    const image = (n) => ({ id: mid(470 + n), filename: `p${n}.png`, contentType: 'image/png', size: 10, width: 4, height: 4, url: `https://cdn.discordapp.com/attachments/${FORUM}/${mid(470 + n)}/p${n}.png` })
    const w = await show({
      messages: [
        opener(),
        msg(1, { content: '## A heading\nthen words' }),
        msg(2, { content: 'long '.repeat(130) }),
        msg(3, { attachments: [image(1), image(2)] }),
        msg(4, { content: 'short', authorId: IXEN, authorName: 'Ixen Calloway' }),
      ],
    })
    expect([1, 2, 3, 4].map((n) => el(w, m(n)).classes().includes('lb-article'))).toEqual([true, true, true, false])
  })

  it('groups the consecutive short replies of one person, as Discord does, and the first of a run keeps its header', async () => {
    const w = await show({
      messages: [
        opener(),
        msg(1, { createdAt: minutes(10) }),
        msg(2, { createdAt: minutes(12) }),
        msg(3, { createdAt: minutes(14), authorId: IXEN, authorName: 'Ixen Calloway' }),
        msg(4, { createdAt: minutes(15), authorId: IXEN, authorName: 'Ixen Calloway' }),
        msg(5, { createdAt: minutes(60), authorId: IXEN, authorName: 'Ixen Calloway' }),
      ],
    })
    expect([1, 2, 3, 4, 5].map((n) => el(w, m(n)).classes().includes('lb-grouped'))).toEqual([false, true, false, true, false])
  })

  it('does not group the first reply under the opening message, though the same person wrote both a minute apart', async () => {
    const w = await show({ messages: [opener({ createdAt: minutes(0) }), msg(1, { createdAt: minutes(1) })] })
    expect(el(w, m(1)).classes()).not.toContain('lb-grouped')
  })

  it('does not group a reply that answers another message', async () => {
    const replyTo = { id: m(1), authorId: TOR, authorName: 'Tor Mardan', content: 'Reply number 1' }
    const w = await show({ messages: [opener(), msg(1, { createdAt: minutes(1) }), msg(2, { createdAt: minutes(2), replyTo })] })
    expect(el(w, m(2)).classes()).not.toContain('lb-grouped')
    expect(el(w, m(2)).find('.lb-reply').attributes('href')).toBe(`#m-${m(1)}`)
  })

  it('shows the names people have now, from what the server said about them', async () => {
    const w = await show({ messages: [opener(), msg(1, { authorName: 'Stale Name' })], people: { [TOR]: { name: 'Fresh Name', avatar: null } } })
    expect(el(w, m(1)).find('.lb-name').text()).toBe('Fresh Name')
  })

  it('shows a post whose opening message is not among the messages (a later page), and lays no reply out as the opening', async () => {
    const w = await show({ messages: [msg(1), msg(2)], hasOlder: true })
    expect(shownIds(w)).toEqual([m(1), m(2)])
    expect(w.findAll('.lb-article')).toHaveLength(0)
  })

  it('writes message text as text, never as markup', async () => {
    const w = await show({ messages: [opener({ content: '<img src="x" onerror="alert(1)">' })] })
    expect(w.find('img[src="x"]').exists()).toBe(false)
    expect(w.text()).toContain('<img src="x" onerror="alert(1)">')
  })
})

describe('PostPage: the topic names that messages mention', () => {
  const mention = (id) => ({ messages: [opener({ content: `see <#${id}>` })] })

  it('asks for the topic list when the store holds none (a deep link), with the reader\'s token', async () => {
    await show()
    expect(listPosts).toHaveBeenCalledTimes(1)
    expect(listPosts).toHaveBeenCalledWith('tok')
  })

  it('does not ask for it when the store already holds one', async () => {
    await show({ posts: [{ id: OTHER, title: 'Another Road' }] })
    expect(listPosts).not.toHaveBeenCalled()
  })

  it('names a post a channel mention points at, once the list has come', async () => {
    const d = deferred()
    const w = await show({ ...mention(OTHER), arrange: () => listPosts.mockReturnValue(d.promise) })
    expect(w.find('.lb-body').text()).toContain('#channel')
    d.resolve({ posts: [{ id: OTHER, title: 'Another Road' }], people: {} })
    await settle()
    expect(w.find('.lb-body').text()).toContain('Another Road')
    expect(w.find('.lb-body').text()).not.toContain('#channel')
  })

  it('names it at once when the list was already held', async () => {
    const w = await show({ ...mention(OTHER), posts: [{ id: OTHER, title: 'Another Road' }] })
    expect(w.find('.lb-body').text()).toContain('Another Road')
  })

  it('names the open post itself even before the list has come', async () => {
    const w = await show({ ...mention(POST), arrange: () => listPosts.mockReturnValue(deferred().promise) })
    expect(w.find('.lb-body').text()).toContain('The Long Road')
  })

  it('shows the post when the topic list cannot be had', async () => {
    const w = await show({ arrange: () => listPosts.mockRejectedValue(apiError(503)) })
    expect(shownIds(w)).toEqual([POST, m(1), m(2)])
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it('links to a message of another post by its address in this site, with its #m- anchor', async () => {
    const w = await show({
      messages: [opener({ content: `https://discord.com/channels/${GUILD}/${OTHER}/${m(7)}` })],
      posts: [{ id: OTHER, title: 'Another Road' }],
    })
    expect(w.find('.lb-body a').attributes('href')).toBe(`/reliquarium/librarius/${OTHER}#m-${m(7)}`)
  })

  it('names a member a mention points at, by the name the server gave', async () => {
    const w = await show({ messages: [opener({ content: `hello <@${IXEN}>` })] })
    expect(w.find('.lb-body').text()).toContain('@Ixen Calloway')
  })

  it('survives guild and roles that are not what /me promised', async () => {
    for (const me of [{ ...ME, guildId: 'x', roles: 'x' }, { ...ME, roles: null }, { ...ME, guildId: null, roles: undefined }]) {
      const w = await show({ me, messages: [opener({ content: 'hello <@&200000000000000430> and <@200000000000000410>' })] })
      expect(shownIds(w)).toEqual([POST])
      leave(w)
    }
  })
})

describe('PostPage: older and newer messages', () => {
  it('has no button for either while nothing lies beyond the run', async () => {
    const w = await show()
    expect(button(w, 'Load older')).toBeUndefined()
    expect(button(w, 'Load newer')).toBeUndefined()
  })

  it('shows "Load older" above the messages while older ones lie beyond, and "Load newer" below while newer ones do', async () => {
    const w = await show({ messages: [msg(2), msg(3)], hasOlder: true, hasNewer: true })
    const buttons = w.findAll('.lb-more')
    expect(buttons.map((b) => b.text())).toEqual(['Load older', 'Load newer'])
    const kids = [...w.find('.lb-thread').element.children]
    expect(kids[0]).toBe(buttons[0].element)
    expect(kids.at(-1)).toBe(buttons[1].element)
  })

  it('asks the store for the page before the oldest message held, and shows it above, the button gone when no more lie that way', async () => {
    const w = await show({ messages: [msg(3), msg(4)], hasOlder: true })
    listMessages.mockResolvedValue({ messages: [msg(1), msg(2)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await button(w, 'Load older').trigger('click')
    await settle()
    expect(listMessages).toHaveBeenLastCalledWith('tok', POST, { before: m(3) })
    expect(shownIds(w)).toEqual([m(1), m(2), m(3), m(4)])
    expect(button(w, 'Load older')).toBeUndefined()
  })

  it('asks for the page after the newest message held, and shows it below', async () => {
    const w = await show({ messages: [msg(1), msg(2)], hasNewer: true })
    listMessages.mockResolvedValue({ messages: [msg(3), msg(4)], hasOlder: false, hasNewer: true, people: PEOPLE, rev: '40' })
    await button(w, 'Load newer').trigger('click')
    await settle()
    expect(listMessages).toHaveBeenLastCalledWith('tok', POST, { after: m(2) })
    expect(shownIds(w)).toEqual([m(1), m(2), m(3), m(4)])
    expect(button(w, 'Load newer')).toBeDefined()
  })

  it('does not ask again while an answer is on its way, and says it is busy', async () => {
    const w = await show({ messages: [msg(3)], hasOlder: true })
    const d = deferred()
    listMessages.mockReturnValue(d.promise)
    await button(w, 'Load older').trigger('click')
    await button(w, 'Load older').trigger('click')
    await settle()
    expect(listMessages).toHaveBeenCalledTimes(3)
    expect(button(w, 'Load older').attributes('disabled')).toBeDefined()
    d.resolve({ messages: [msg(2)], hasOlder: true, hasNewer: false, people: PEOPLE, rev: '40' })
    await settle()
    expect(button(w, 'Load older').attributes('disabled')).toBeUndefined()
  })

  it('does the same for the newer page: one request, the button disabled meanwhile', async () => {
    const w = await show({ messages: [msg(1)], hasNewer: true })
    const d = deferred()
    listMessages.mockReturnValue(d.promise)
    await button(w, 'Load newer').trigger('click')
    await button(w, 'Load newer').trigger('click')
    await settle()
    expect(listMessages).toHaveBeenCalledTimes(3)
    expect(button(w, 'Load newer').attributes('disabled')).toBeDefined()
    expect(button(w, 'Load older')).toBeUndefined()
    d.resolve({ messages: [msg(2)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await settle()
    expect(shownIds(w)).toEqual([m(1), m(2)])
  })

  it('keeps the messages, and says so, when a page cannot be had; the button stays to try again', async () => {
    const w = await show({ messages: [msg(3)], hasOlder: true })
    listMessages.mockRejectedValue(apiError(503))
    await button(w, 'Load older').trigger('click')
    await settle()
    expect(w.find('[role="alert"]').text()).toBe('The Librarius couldn\'t be reached.')
    expect(shownIds(w)).toEqual([m(3)])
    listMessages.mockResolvedValue({ messages: [msg(2)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await button(w, 'Load older').trigger('click')
    await settle()
    expect(w.find('[role="alert"]').exists()).toBe(false)
    expect(shownIds(w)).toEqual([m(2), m(3)])
  })

  it('does not move the page to the top or bottom when it loads older messages: what the reader looked at stays where it was', async () => {
    const w = await show({ messages: [msg(3), msg(4)], hasOlder: true })
    scrolled.length = 0
    tops.set(`m-${m(3)}`, 120)
    listMessages.mockImplementation(async () => {
      tops.set(`m-${m(3)}`, 520)
      return { messages: [msg(1), msg(2)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' }
    })
    await button(w, 'Load older').trigger('click')
    await settle()
    expect(window.scrollBy).toHaveBeenCalledTimes(1)
    expect(window.scrollBy).toHaveBeenCalledWith({ top: 400, behavior: 'instant' })
    expect(scrolled).toEqual([])
  })

  it('moves the page by nothing when the browser has already kept the place', async () => {
    const w = await show({ messages: [msg(3)], hasOlder: true })
    tops.set(`m-${m(3)}`, 120)
    listMessages.mockResolvedValue({ messages: [msg(2)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await button(w, 'Load older').trigger('click')
    await settle()
    expect(window.scrollBy).not.toHaveBeenCalled()
  })

  it('moves the page by nothing when the message it kept in place is gone by the time the page has come', async () => {
    const w = await show({ messages: [msg(3), msg(4)], hasOlder: true })
    tops.set(`m-${m(3)}`, 120)
    listMessages.mockImplementation(async () => {
      // A poll deletes the first message while the page is on its way.
      store.post.messages = store.post.messages.filter((x) => x.id !== m(3))
      return { messages: [msg(1), msg(2)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' }
    })
    await button(w, 'Load older').trigger('click')
    await settle()
    expect(shownIds(w)).toEqual([m(1), m(2), m(4)])
    expect(window.scrollBy).not.toHaveBeenCalled()
  })

  it('does not move the page when it loads newer messages', async () => {
    const w = await show({ messages: [msg(1)], hasNewer: true })
    scrolled.length = 0
    listMessages.mockResolvedValue({ messages: [msg(2)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await button(w, 'Load newer').trigger('click')
    await settle()
    expect(window.scrollBy).not.toHaveBeenCalled()
    expect(scrolled).toEqual([])
  })
})

describe('PostPage: since your last visit', () => {
  const six = () => [opener(), msg(1), msg(2), msg(3), msg(4), msg(5), msg(6)]

  it('puts a divider before the first message newer than the reader\'s mark, counting how many are new', async () => {
    const w = await show({ messages: six(), lastRead: m(3) })
    expect(w.findAll('.lb-divider')).toHaveLength(1)
    expect(divider(w).text()).toBe('SINCE YOUR LAST VISIT · 3 NEW')
    expect(afterDivider(w)).toBe(m(4))
  })

  it('puts none on a first visit', async () => {
    const w = await show({ messages: six(), lastRead: null })
    expect(divider(w).exists()).toBe(false)
  })

  it('puts none when the reader has read to the newest message', async () => {
    const w = await show({ messages: six(), lastRead: m(6) })
    expect(divider(w).exists()).toBe(false)
  })

  it('counts one new message as "1 NEW"', async () => {
    const w = await show({ messages: six(), lastRead: m(5) })
    expect(divider(w).text()).toBe('SINCE YOUR LAST VISIT · 1 NEW')
  })

  it('says the count is at least that when newer messages lie beyond the run', async () => {
    const w = await show({ messages: six(), lastRead: m(3), hasNewer: true })
    expect(divider(w).text()).toBe('SINCE YOUR LAST VISIT · 3+ NEW')
  })

  it('puts none at the very top of a run that has older messages beyond it: nothing says those are the first unread', async () => {
    const w = await show({ messages: [msg(4), msg(5)], lastRead: m(1), hasOlder: true })
    expect(divider(w).exists()).toBe(false)
  })

  it('puts one at the top of a run that reaches the start of the post', async () => {
    const w = await show({ messages: [msg(4), msg(5)], lastRead: m(1), hasOlder: false })
    expect(divider(w).text()).toBe('SINCE YOUR LAST VISIT · 2 NEW')
    expect(afterDivider(w)).toBe(m(4))
  })

  it('stays where it was while the reader reads on: the mark moves, the divider does not', async () => {
    const w = await show({ messages: six(), lastRead: m(3) })
    report([m(4), m(5), m(6)])
    await settle(2000)
    expect(markRead).toHaveBeenCalledWith('tok', POST, m(6))
    expect(store.post.lastRead).toBe(m(6))
    expect(divider(w).text()).toBe('SINCE YOUR LAST VISIT · 3 NEW')
    expect(afterDivider(w)).toBe(m(4))
  })

  it('counts what a poll brings as new, with the divider still where it was', async () => {
    const w = await show({ messages: six(), lastRead: m(3) })
    getChanges.mockResolvedValue({ messages: [msg(7)], deleted: [], rev: '42', people: {} })
    await settle(10_000)
    expect(shownIds(w)).toContain(m(7))
    expect(divider(w).text()).toBe('SINCE YOUR LAST VISIT · 4 NEW')
    expect(afterDivider(w)).toBe(m(4))
  })

  it('has the divider before the first message newer than the mark, however many there are (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 0, max: 12 }), async (count, read) => {
        const messages = Array.from({ length: count }, (_, i) => msg(i + 1))
        const w = await show({ messages, lastRead: m(read) })
        const unread = messages.filter((x) => BigInt(x.id) > BigInt(m(read)))
        if (unread.length === 0) {
          expect(w.findAll('.lb-divider')).toHaveLength(0)
        } else {
          expect(w.findAll('.lb-divider')).toHaveLength(1)
          expect(afterDivider(w)).toBe(unread[0].id)
          expect(divider(w).text()).toBe(`SINCE YOUR LAST VISIT · ${unread.length} NEW`)
        }
        leave(w)
      }),
      { numRuns: 30 },
    )
  })
})

describe('PostPage: where it opens', () => {
  const six = () => [opener(), msg(1), msg(2), msg(3), msg(4), msg(5), msg(6)]

  it('scrolls to the divider when there is one, to its top', async () => {
    await show({ messages: six(), lastRead: m(3) })
    expect(scrolled).toEqual([{ at: expect.stringContaining('lb-divider'), options: { block: 'start', behavior: 'instant' } }])
  })

  it('scrolls to the newest message, to its end, when there is no divider', async () => {
    await show({ messages: six(), lastRead: null })
    expect(scrolled).toEqual([{ at: `m-${m(6)}`, options: { block: 'end', behavior: 'instant' } }])
  })

  it('scrolls to the newest message when the reader has read to the end', async () => {
    await show({ messages: six(), lastRead: m(6) })
    expect(scrolled.map((s) => s.at)).toEqual([`m-${m(6)}`])
  })

  it('scrolls to the message the address names, when there is no divider', async () => {
    await show({ messages: six(), lastRead: null, hash: `#m-${m(2)}` })
    expect(scrolled).toEqual([{ at: `m-${m(2)}`, options: { block: 'start', behavior: 'instant' } }])
  })

  it('goes to the message the address names before the divider when both are there: a link to a message is where the reader means to be', async () => {
    await show({ messages: six(), lastRead: m(3), hash: `#m-${m(2)}` })
    expect(scrolled).toEqual([{ at: `m-${m(2)}`, options: { block: 'start', behavior: 'instant' } }])
  })

  it('goes to the opening message when the address names it, asking for nothing more', async () => {
    await show({ messages: six(), lastRead: m(3), hash: `#m-${POST}` })
    expect(scrolled).toEqual([{ at: `m-${POST}`, options: { block: 'start', behavior: 'instant' } }])
    expect(listMessages.mock.calls.filter((c) => !asksForOpening(c[2]))).toHaveLength(1)
  })

  it('asks for nothing more when the messages held hold the one the address names', async () => {
    await show({ messages: six(), lastRead: null, hash: `#m-${m(2)}` })
    expect(listMessages.mock.calls.filter((c) => !asksForOpening(c[2]))).toHaveLength(1)
  })

  describe('an address that names a message the messages held do not reach', () => {
    const newest = () => run([msg(4), msg(5), msg(6)], { hasOlder: true })
    const around = () => run([msg(1), msg(2), msg(3)], { hasOlder: true, hasNewer: true })
    const answer = (opts) => (opts.around === m(2) ? around() : newest())
    const named = (over = {}) => ({ messages: newest().messages, hasOlder: true, hash: `#m-${m(2)}`, arrange: () => serve(answer, opener()), ...over })

    it('opens the post around it, once, and scrolls to it', async () => {
      const w = await show(named())
      expect(listMessages.mock.calls.filter((c) => !asksForOpening(c[2])).map((c) => c[2])).toEqual([{}, { around: m(2) }])
      expect(shownIds(w)).toEqual([POST, m(1), m(2), m(3)])
      expect(scrolled).toEqual([{ at: `m-${m(2)}`, options: { block: 'start', behavior: 'instant' } }])
    })

    it('shows nothing of the first run meanwhile, and no failure', async () => {
      const w = await show(named())
      expect(w.find('[role="alert"]').exists()).toBe(false)
      expect(w.text()).not.toContain('Loading…')
    })

    it('goes to the message even when there are unread ones, and still puts the divider by the reader\'s mark, newer ones lying beyond the run', async () => {
      const w = await show(named({ lastRead: m(1) }))
      expect(scrolled.map((s) => s.at)).toEqual([`m-${m(2)}`])
      expect(divider(w).text()).toBe('SINCE YOUR LAST VISIT · 2+ NEW')
      expect(afterDivider(w)).toBe(m(2))
    })

    it('goes on with the divider, with no error, when the message is not there after all (deleted)', async () => {
      const w = await show(named({ lastRead: m(5), arrange: () => serve(() => newest(), opener()) }))
      expect(w.find('[role="alert"]').exists()).toBe(false)
      expect(scrolled.map((s) => s.at)).toEqual([expect.stringContaining('lb-divider')])
      expect(listMessages.mock.calls.filter((c) => !asksForOpening(c[2]))).toHaveLength(2)
    })

    it('goes on with the newest message when there is no divider either', async () => {
      await show(named({ lastRead: null, arrange: () => serve(() => newest(), opener()) }))
      expect(scrolled.map((s) => s.at)).toEqual([`m-${m(6)}`])
    })

    it('goes on with the run it has, quietly, when the page around the message cannot be had', async () => {
      const w = await show(
        named({
          lastRead: m(5),
          arrange: () =>
            serve((opts) => {
              if (opts.around === m(2)) throw apiError(503)
              return newest()
            }, opener()),
        }),
      )
      expect(w.find('[role="alert"]').exists()).toBe(false)
      expect(shownIds(w)).toEqual([POST, m(4), m(5), m(6)])
      expect(scrolled.map((s) => s.at)).toEqual([expect.stringContaining('lb-divider')])
    })

    it('shows nothing of the post, and does not fall over, when the server refuses the reader on that page', async () => {
      const w = await show(
        named({
          arrange: () =>
            serve((opts) => {
              if (opts.around === m(2)) throw apiError(403)
              return newest()
            }, opener()),
        }),
      )
      expect(store.status).toBe('denied')
      expect(w.findAll('.lb-msg')).toHaveLength(0)
      expect(w.text()).not.toContain('Loading…')
      expect(w.find('[role="alert"]').exists()).toBe(true)
      expect(scrolled).toEqual([])
      await settle(60_000)
      expect(getChanges).not.toHaveBeenCalled()
    })

    it('drops the opening if the reader has left the post meanwhile, and polls nothing', async () => {
      const slow = deferred()
      const w = await show({ ...named(), flush: false, arrange: () => serve((opts) => (opts.around === m(2) ? slow.promise : newest()), opener()) })
      await settle()
      leave(w)
      slow.resolve(around())
      await settle(60_000)
      expect(scrolled).toEqual([])
      expect(getChanges).not.toHaveBeenCalled()
    })
  })

  it('falls back on the newest message when the address names one that is not on the page', async () => {
    await show({ messages: six(), lastRead: null, hash: `#m-${m(40)}` })
    expect(scrolled.map((s) => s.at)).toEqual([`m-${m(6)}`])
  })

  it('takes nothing but a message anchor from the address, and never falls over on one', async () => {
    const hostile = ['#', '#m-', '#m-abc', '#m- 1', `#m-${m(2)}x`, `#x-${m(2)}`, `#M-${m(2)}`, '#m-"]', '#m-1,#m-2', `#m-${'9'.repeat(21)}`, '#m-<img>', `#m-${m(2)}%20`, '#%00']
    for (const hash of hostile) {
      const w = await show({ messages: six(), lastRead: null, hash })
      expect(scrolled.map((s) => s.at), hash).toEqual([`m-${m(6)}`])
      scrolled.length = 0
      leave(w)
    }
  })

  it('scrolls once only: not when a poll brings messages, nor for older ones, nor as the reader reads on', async () => {
    const w = await show({ messages: six(), lastRead: m(3), hasOlder: true })
    expect(scrolled).toHaveLength(1)
    getChanges.mockResolvedValue({ messages: [msg(7)], deleted: [], rev: '42', people: {} })
    await settle(10_000)
    listMessages.mockResolvedValue({ messages: [msg(-1)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await button(w, 'Load older').trigger('click')
    await settle()
    report([m(5)])
    await settle(2000)
    expect(scrolled).toHaveLength(1)
  })

  it('scrolls once more for a different post, after it has loaded', async () => {
    const w = await show({ messages: six(), lastRead: null })
    expect(scrolled).toHaveLength(1)
    getPost.mockResolvedValue({ post: info({ id: OTHER }), lastRead: null, rev: '40' })
    listMessages.mockResolvedValue({ messages: [msg(8), msg(9)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await w.setProps({ postId: OTHER })
    await settle()
    expect(scrolled.map((s) => s.at)).toEqual([`m-${m(6)}`, `m-${m(9)}`])
  })

  it('scrolls to a message that a link in this post names, when the address changes while the page is open', async () => {
    await show({ messages: six(), lastRead: null })
    scrolled.length = 0
    await router.push(`/reliquarium/librarius/${POST}#m-${m(2)}`)
    await settle()
    expect(scrolled).toEqual([{ at: `m-${m(2)}`, options: { block: 'start', behavior: 'instant' } }])
  })

  it('opens the post around a message that a link followed while the page is open names, when it is not held, and scrolls to it', async () => {
    const w = await show({ messages: [msg(4), msg(5), msg(6)], hasOlder: true, arrange: () => serve((opts) => (opts.around === m(2) ? run([msg(1), msg(2), msg(3)]) : run([msg(4), msg(5), msg(6)], { hasOlder: true })), opener()) })
    scrolled.length = 0
    await router.push(`/reliquarium/librarius/${POST}#m-${m(2)}`)
    await settle()
    expect(lastPageAsk()).toEqual(['tok', POST, { around: m(2) }])
    expect(shownIds(w)).toEqual([POST, m(1), m(2), m(3)])
    expect(scrolled).toEqual([{ at: `m-${m(2)}`, options: { block: 'start', behavior: 'instant' } }])
  })

  it('asks for nothing when the link followed names a message that is held', async () => {
    await show({ messages: six(), lastRead: null })
    const before = listMessages.mock.calls.length
    await router.push(`/reliquarium/librarius/${POST}#m-${m(2)}`)
    await settle()
    expect(listMessages.mock.calls).toHaveLength(before)
  })

  it('does nothing when the address changes to a message that is not on the page even after the page around it, or to no message', async () => {
    await show({ messages: six(), lastRead: null })
    scrolled.length = 0
    await router.push(`/reliquarium/librarius/${POST}#m-${m(40)}`)
    await settle()
    await router.push(`/reliquarium/librarius/${POST}#top`)
    await settle()
    expect(scrolled).toEqual([])
  })

  it('leaves a change of address that comes with another post to that post\'s own opening: it asks around the message once, for the new post', async () => {
    await show({ messages: six(), lastRead: null, host: true })
    getPost.mockResolvedValue({ post: info({ id: OTHER }), lastRead: null, rev: '40' })
    serve(run([msg(8)]))
    await router.push(`/reliquarium/librarius/${OTHER}#m-${m(40)}`)
    await settle()
    expect(listMessages.mock.calls.filter((c) => c[2].around).map((c) => c[1])).toEqual([OTHER])
  })

  it('asks for the new post once while it is still on its way, whatever the address says', async () => {
    await show({ messages: six(), host: true })
    getPost.mockReturnValue(deferred().promise)
    const before = getPost.mock.calls.length
    await router.push(`/reliquarium/librarius/${OTHER}#m-${m(40)}`)
    await settle()
    expect(getPost.mock.calls.slice(before)).toEqual([['tok', OTHER]])
  })

  it('does not scroll to an address while the post is still loading', async () => {
    const w = await show({ arrange: () => getPost.mockReturnValue(deferred().promise) })
    await router.push(`/reliquarium/librarius/${POST}#m-${m(2)}`)
    await settle()
    expect(scrolled).toEqual([])
    leave(w)
  })
})

describe('PostPage: the date rail', () => {
  // Ids that mean a date, so that "the first message from this month on" can be told. They are made, not real.
  const sf = (iso, extra = 0) => String(BigInt(snowflakeAt(new Date(iso))) + BigInt(extra))
  const dated = (iso, n) => msg(n, { id: sf(iso, n), createdAt: iso })
  const created = '2026-09-20T12:00:00.000Z'
  const rail = (w) => w.findAll('.lb-rail .lb-month')

  it('lists each month from the post\'s start to now, oldest first, as buttons', async () => {
    const w = await show({ post: info({ createdAt: created }) })
    expect(rail(w).map((b) => b.text())).toEqual(['Sep 2026', 'Oct 2026', 'Nov 2026'])
    expect(rail(w).every((b) => b.attributes('type') === 'button')).toBe(true)
    expect(w.find('nav.lb-rail').attributes('aria-label')).toBe('Jump to a month')
  })

  it('has no rail for a post that has lived in one month', async () => {
    const w = await show({ post: info({ createdAt: '2026-11-02T00:00:00.000Z' }) })
    expect(w.find('.lb-rail').exists()).toBe(false)
  })

  it('has a rail for a post that has lived in two months', async () => {
    const w = await show({ post: info({ createdAt: '2026-10-20T12:00:00.000Z' }) })
    expect(rail(w).map((b) => b.text())).toEqual(['Oct 2026', 'Nov 2026'])
  })

  it('opens the post around the first instant of the month that is clicked', async () => {
    const w = await show({ post: info({ createdAt: created }) })
    listMessages.mockResolvedValue({ messages: [msg(1)], hasOlder: true, hasNewer: true, people: PEOPLE, rev: '40' })
    await rail(w)[1].trigger('click')
    await settle()
    expect(lastPageAsk()).toEqual(['tok', POST, { around: snowflakeAt(new Date(Date.UTC(2026, 9, 1))) }])
    expect(getPost).toHaveBeenCalledTimes(2)
  })

  it('opens around the start of the post, not before it, for the first month, which began before the post did', async () => {
    const w = await show({ post: info({ createdAt: created }) })
    await rail(w)[0].trigger('click')
    await settle()
    expect(lastPageAsk()).toEqual(['tok', POST, { around: snowflakeAt(new Date(created)) }])
  })

  it('opens around now, not after it, for a month that began after the reader\'s clock says it is (the clock runs behind)', async () => {
    vi.setSystemTime(new Date('2026-10-30T00:00:00.000Z'))
    const w = await show({ post: info({ createdAt: created }), messages: [msg(1, { createdAt: '2026-11-02T08:00:00.000Z' })] })
    expect(rail(w).map((b) => b.text())).toEqual(['Sep 2026', 'Oct 2026', 'Nov 2026'])
    await rail(w)[2].trigger('click')
    await settle()
    expect(lastPageAsk()).toEqual(['tok', POST, { around: snowflakeAt(new Date('2026-10-30T00:00:00.000Z')) }])
  })

  it('adds a month to the rail when a poll brings a message from one', async () => {
    const w = await show({ post: info({ createdAt: created }) })
    expect(rail(w).map((b) => b.text())).toEqual(['Sep 2026', 'Oct 2026', 'Nov 2026'])
    getChanges.mockResolvedValue({ messages: [msg(3, { createdAt: '2026-12-02T08:00:00.000Z' })], deleted: [], rev: '42', people: {} })
    await settle(10_000)
    expect(rail(w).map((b) => b.text())).toEqual(['Sep 2026', 'Oct 2026', 'Nov 2026', 'Dec 2026'])
  })

  it('draws the rail from the messages it has even when one of them has a date that is no date', async () => {
    const w = await show({ post: info({ createdAt: created }), messages: [msg(1, { createdAt: 'never' }), msg(2, { createdAt: null })] })
    expect(rail(w).map((b) => b.text())).toEqual(['Sep 2026', 'Oct 2026', 'Nov 2026'])
  })

  it('always asks for an id the server takes: 17 digits or more', async () => {
    const w = await show({ post: info({ createdAt: '2026-01-31T23:59:59.999Z' }) })
    for (const month of rail(w)) {
      listMessages.mockClear()
      await month.trigger('click')
      await settle()
      expect(lastPageAsk()[2].around, month.text()).toMatch(/^\d{17,20}$/)
    }
  })

  it('shows the new run in place of the old, and scrolls to the first message from the month on', async () => {
    const w = await show({ post: info({ createdAt: created }), messages: [dated('2026-09-21T00:00:00.000Z', 1)] })
    scrolled.length = 0
    const run = [dated('2026-09-30T22:00:00.000Z', 2), dated('2026-10-01T01:00:00.000Z', 3), dated('2026-10-02T01:00:00.000Z', 4)]
    listMessages.mockResolvedValue({ messages: run, hasOlder: true, hasNewer: true, people: PEOPLE, rev: '40' })
    await rail(w)[1].trigger('click')
    await settle()
    expect(shownIds(w)).toEqual(run.map((x) => x.id))
    expect(scrolled).toEqual([{ at: `m-${run[1].id}`, options: { block: 'start', behavior: 'instant' } }])
  })

  it('counts a message made at the very instant of the date as the first from it on', async () => {
    const w = await show({ post: info({ createdAt: created }), messages: [dated('2026-09-21T00:00:00.000Z', 1)] })
    scrolled.length = 0
    const month = snowflakeAt(new Date(Date.UTC(2026, 9, 1)))
    const run = [dated('2026-09-30T22:00:00.000Z', 2), msg(3, { id: month }), dated('2026-10-02T01:00:00.000Z', 4)]
    listMessages.mockResolvedValue({ messages: run, hasOlder: true, hasNewer: true, people: PEOPLE, rev: '40' })
    await rail(w)[1].trigger('click')
    await settle()
    expect(scrolled.map((x) => x.at)).toEqual([`m-${month}`])
  })

  it('compares the ids as numbers when it looks for the first message from the date on', async () => {
    const w = await show({ post: info({ createdAt: created }), messages: [dated('2026-09-21T00:00:00.000Z', 1)] })
    scrolled.length = 0
    // The first is an id of 18 digits, older than any date of this year, which as text sorts after the date's 19 digits.
    const run = [msg(2, { id: '999999999999999999' }), dated('2026-10-02T01:00:00.000Z', 4)]
    listMessages.mockResolvedValue({ messages: run, hasOlder: true, hasNewer: true, people: PEOPLE, rev: '40' })
    await rail(w)[1].trigger('click')
    await settle()
    expect(scrolled.map((x) => x.at)).toEqual([`m-${run[1].id}`])
  })

  it('disables the whole rail while a jump is on its way', async () => {
    const w = await show({ post: info({ createdAt: created }) })
    listMessages.mockReturnValue(deferred().promise)
    await rail(w)[1].trigger('click')
    await settle()
    expect(rail(w).map((b) => b.attributes('disabled') !== undefined)).toEqual([true, true, true])
  })

  it('opens the post around the first instant of the month that is clicked', async () => {
    const w = await show({ post: info({ createdAt: created }), messages: [dated('2026-09-21T00:00:00.000Z', 1)] })
    scrolled.length = 0
    const run = [dated('2026-09-28T22:00:00.000Z', 2), dated('2026-09-29T01:00:00.000Z', 3)]
    listMessages.mockResolvedValue({ messages: run, hasOlder: true, hasNewer: false, people: PEOPLE, rev: '40' })
    await rail(w)[1].trigger('click')
    await settle()
    expect(scrolled.map((s) => s.at)).toEqual([`m-${run[1].id}`])
  })

  it('does not scroll when the run holds no message at all', async () => {
    const w = await show({ post: info({ createdAt: created }) })
    scrolled.length = 0
    listMessages.mockResolvedValue({ messages: [], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await rail(w)[1].trigger('click')
    await settle()
    expect(scrolled).toEqual([])
  })

  it('keeps the messages on the page while the jump is on its way', async () => {
    const w = await show({ post: info({ createdAt: created }) })
    const d = deferred()
    listMessages.mockReturnValue(d.promise)
    await rail(w)[1].trigger('click')
    await settle()
    expect(shownIds(w)).toEqual([POST, m(1), m(2)])
    d.resolve({ messages: [msg(5)], hasOlder: true, hasNewer: true, people: PEOPLE, rev: '40' })
    await settle()
    expect(shownIds(w)).toEqual([m(5)])
  })

  it('does not take a second jump while one is on its way', async () => {
    const w = await show({ post: info({ createdAt: created }) })
    const d = deferred()
    listMessages.mockReturnValue(d.promise)
    await rail(w)[1].trigger('click')
    await rail(w)[2].trigger('click')
    await settle()
    // The page and the opening message when the post opened, and again for the one jump.
    expect(listMessages).toHaveBeenCalledTimes(4)
    d.resolve({ messages: [msg(5)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await settle()
  })

  it('says so, and keeps the page, when the jump fails', async () => {
    const w = await show({ post: info({ createdAt: created }) })
    listMessages.mockRejectedValue(apiError(503))
    await rail(w)[1].trigger('click')
    await settle()
    expect(w.find('[role="alert"]').text()).toBe('The Librarius couldn\'t be reached.')
    expect(shownIds(w)).toEqual([POST, m(1), m(2)])
  })

  it('does not move the divider when the reader jumps', async () => {
    const w = await show({ post: info({ createdAt: created }), messages: [opener(), msg(1), msg(2), msg(3)], lastRead: m(1) })
    expect(afterDivider(w)).toBe(m(2))
    listMessages.mockResolvedValue({ messages: [msg(2), msg(3), msg(4)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await rail(w)[1].trigger('click')
    await settle()
    expect(divider(w).text()).toBe('SINCE YOUR LAST VISIT · 3 NEW')
    expect(afterDivider(w)).toBe(m(2))
  })

  it('draws no rail, and does not fall over, for a start that is no date or is before Discord began', async () => {
    for (const createdAt of ['never', '2014-12-31T23:59:59.999Z', '', null, undefined, 7]) {
      const w = await show({ post: info({ createdAt }) })
      expect(w.find('.lb-rail').exists(), String(createdAt)).toBe(false)
      expect(shownIds(w), String(createdAt)).toEqual([POST, m(1), m(2)])
      leave(w)
    }
  })
})

describe('PostPage: marking messages read', () => {
  const six = () => [opener(), msg(1), msg(2), msg(3), msg(4), msg(5), msg(6)]

  it('watches every message on the page, and the ones that come later', async () => {
    const w = await show({ messages: [msg(2), msg(3)], hasOlder: true })
    expect([...live().targets].map((e) => e.id)).toEqual([`m-${m(2)}`, `m-${m(3)}`])
    listMessages.mockResolvedValue({ messages: [msg(1)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await button(w, 'Load older').trigger('click')
    await settle()
    expect([...live().targets].map((e) => e.id).sort()).toEqual([`m-${m(1)}`, `m-${m(2)}`, `m-${m(3)}`])
    getChanges.mockResolvedValue({ messages: [msg(4)], deleted: [], rev: '42', people: {} })
    await settle(10_000)
    expect([...live().targets].map((e) => e.id)).toContain(`m-${m(4)}`)
  })

  it('does not watch the same message twice', async () => {
    await show({ messages: [msg(2), msg(3)] })
    const seen = []
    const observe = live().observe.bind(live())
    live().observe = (e) => {
      seen.push(e.id)
      observe(e)
    }
    getChanges.mockResolvedValue({ messages: [msg(2, { content: 'edited' }), msg(4)], deleted: [], rev: '42', people: {} })
    await settle(10_000)
    expect(seen).toEqual([`m-${m(4)}`])
  })

  it('sends the newest message in view, two seconds after the last change in what is in view, and not before', async () => {
    await show({ messages: six() })
    report([m(4), m(5)])
    await settle(1999)
    expect(markRead).not.toHaveBeenCalled()
    await settle(1)
    expect(markRead).toHaveBeenCalledTimes(1)
    expect(markRead).toHaveBeenCalledWith('tok', POST, m(5))
  })

  it('waits two seconds from the last change: more coming into view puts the report off', async () => {
    await show({ messages: six() })
    report([m(2)])
    await settle(1500)
    report([m(3)])
    await settle(1500)
    expect(markRead).not.toHaveBeenCalled()
    await settle(500)
    expect(markRead).toHaveBeenCalledTimes(1)
    expect(markRead).toHaveBeenCalledWith('tok', POST, m(3))
  })

  it('counts only what is in view now: a message that has left it is not the newest in view', async () => {
    await show({ messages: six() })
    report([m(2), m(5)])
    report([m(5)], false)
    await settle(2000)
    expect(markRead).toHaveBeenCalledTimes(1)
    expect(markRead).toHaveBeenCalledWith('tok', POST, m(2))
  })

  it('compares ids as numbers, not as text', async () => {
    const messages = [msg(1, { id: '99999999999999999' }), msg(2, { id: '100000000000000000' })]
    await show({ messages })
    report(['99999999999999999', '100000000000000000'])
    await settle(2000)
    expect(markRead).toHaveBeenCalledWith('tok', POST, '100000000000000000')
  })

  it('sends nothing when nothing is in view', async () => {
    await show({ messages: six() })
    report([m(2)])
    report([m(2)], false)
    await settle(5000)
    expect(markRead).not.toHaveBeenCalled()
  })

  it('sends nothing for a reader who has not looked at anything yet', async () => {
    await show({ messages: six() })
    await settle(5000)
    expect(markRead).not.toHaveBeenCalled()
  })

  it('sends it once, not again until something else comes into view', async () => {
    await show({ messages: six() })
    report([m(3)])
    await settle(2000)
    await settle(10_000)
    expect(markRead).toHaveBeenCalledTimes(1)
    report([m(4)])
    await settle(2000)
    expect(markRead).toHaveBeenCalledTimes(2)
    expect(markRead).toHaveBeenLastCalledWith('tok', POST, m(4))
  })

  it('uses the token the reader has when it is sent', async () => {
    await show({ messages: six() })
    report([m(3)])
    state.auth.token = 'tok2'
    await settle(2000)
    expect(markRead).toHaveBeenCalledWith('tok2', POST, m(3))
  })

  it('goes on after a report fails, and does not say so on the page', async () => {
    const w = await show({ messages: six() })
    markRead.mockRejectedValue(apiError(503))
    report([m(3)])
    await settle(2000)
    expect(markRead).toHaveBeenCalledTimes(1)
    expect(w.find('[role="alert"]').exists()).toBe(false)
    markRead.mockResolvedValue(null)
    report([m(4)])
    await settle(2000)
    expect(markRead).toHaveBeenCalledTimes(2)
  })

  it('ignores a report for something that is no message of the page', async () => {
    await show({ messages: six() })
    live().callback([{ target: document.body, isIntersecting: true }, { target: document.createElement('div'), isIntersecting: true }])
    await settle(2000)
    expect(markRead).not.toHaveBeenCalled()
  })

  it('does not send after the page is left, and stops watching', async () => {
    const w = await show({ messages: six() })
    const observer = live()
    report([m(3)])
    leave(w)
    await settle(5000)
    expect(markRead).not.toHaveBeenCalled()
    expect(observer.disconnected).toBe(true)
  })

  it('counts nothing of the post the reader has left among what is in view in the next', async () => {
    const w = await show({ messages: six() })
    report([m(6)])
    getPost.mockResolvedValue({ post: info({ id: OTHER }), lastRead: null, rev: '40' })
    listMessages.mockResolvedValue({ messages: [msg(1), msg(2)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await w.setProps({ postId: OTHER })
    await settle()
    report([m(2)])
    await settle(2000)
    expect(markRead).toHaveBeenCalledTimes(1)
    expect(markRead).toHaveBeenCalledWith('tok', OTHER, m(2))
  })

  it('does not send a report for the post the reader has left, when the next one is opened', async () => {
    const w = await show({ messages: six() })
    const first = live()
    report([m(3)])
    getPost.mockResolvedValue({ post: info({ id: OTHER }), lastRead: null, rev: '40' })
    listMessages.mockResolvedValue({ messages: [msg(8)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await w.setProps({ postId: OTHER })
    await settle(5000)
    expect(markRead).not.toHaveBeenCalled()
    expect(first.disconnected).toBe(true)
    expect(live()).not.toBe(first)
    expect([...live().targets].map((e) => e.id)).toEqual([`m-${m(8)}`])
  })

  it('still shows the post in a browser that has no IntersectionObserver, and sends nothing', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const w = await show({ messages: six() })
    expect(shownIds(w)).toHaveLength(7)
    await settle(5000)
    expect(markRead).not.toHaveBeenCalled()
  })
})

describe('PostPage: polling', () => {
  it('asks what changed every 10 seconds, with the token the reader has then', async () => {
    await show()
    expect(getChanges).not.toHaveBeenCalled()
    await settle(9999)
    expect(getChanges).not.toHaveBeenCalled()
    await settle(1)
    expect(getChanges).toHaveBeenCalledTimes(1)
    expect(getChanges).toHaveBeenLastCalledWith('tok', POST, '40')
    state.auth.token = 'tok2'
    await settle(10_000)
    expect(getChanges).toHaveBeenCalledTimes(2)
    expect(getChanges.mock.calls[1][0]).toBe('tok2')
    await settle(10_000)
    expect(getChanges).toHaveBeenCalledTimes(3)
  })

  it('shows what a poll brings: a new message, an edit, a deletion', async () => {
    const w = await show({ messages: [opener(), msg(1), msg(2)] })
    getChanges.mockResolvedValue({ messages: [msg(1, { content: 'Edited reply' }), msg(3)], deleted: [m(2)], rev: '42', people: {} })
    await settle(10_000)
    expect(shownIds(w)).toEqual([POST, m(1), m(3)])
    expect(el(w, m(1)).text()).toContain('Edited reply')
  })

  it('does not ask while the tab is hidden, and asks again at the first look once it is visible', async () => {
    await show()
    visibility('hidden')
    await settle(10_000)
    await settle(10_000)
    expect(getChanges).not.toHaveBeenCalled()
    visibility('visible')
    await settle(10_000)
    expect(getChanges).toHaveBeenCalledTimes(1)
  })

  it('keeps asking after a poll fails, without a word on the page, and keeps what it has', async () => {
    const w = await show()
    getChanges.mockRejectedValue(apiError(503))
    await settle(10_000)
    expect(getChanges).toHaveBeenCalledTimes(1)
    expect(w.find('[role="alert"]').exists()).toBe(false)
    expect(shownIds(w)).toEqual([POST, m(1), m(2)])
    getChanges.mockResolvedValue({ messages: [msg(3)], deleted: [], rev: '42', people: {} })
    await settle(10_000)
    expect(shownIds(w)).toEqual([POST, m(1), m(2), m(3)])
  })

  it('does not ask again while an answer is still on its way', async () => {
    await show()
    const slow = deferred()
    getChanges.mockReturnValue(slow.promise)
    await settle(10_000)
    expect(getChanges).toHaveBeenCalledTimes(1)
    await settle(60_000)
    expect(getChanges).toHaveBeenCalledTimes(1)
    slow.resolve({ messages: [], deleted: [], rev: '42', people: {} })
    await settle(0)
    await settle(10_000)
    expect(getChanges).toHaveBeenCalledTimes(2)
  })

  it('stops when the page is left, while it waits', async () => {
    const w = await show()
    leave(w)
    await settle(60_000)
    expect(getChanges).not.toHaveBeenCalled()
  })

  it('stops when the page is left, with an answer still on its way, and leaves no timer behind', async () => {
    const w = await show()
    const slow = deferred()
    getChanges.mockReturnValue(slow.promise)
    await settle(10_000)
    leave(w)
    slow.resolve({ messages: [], deleted: [], rev: '42', people: {} })
    await settle(60_000)
    expect(getChanges).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no timer behind when the page is left while it waits, nor when the reader goes to another post', async () => {
    const w = await show()
    expect(vi.getTimerCount()).toBe(1)
    getPost.mockReturnValue(deferred().promise)
    await w.setProps({ postId: OTHER })
    await settle()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start before the post is open', async () => {
    await show({ arrange: () => getPost.mockReturnValue(deferred().promise) })
    await settle(60_000)
    expect(getChanges).not.toHaveBeenCalled()
  })

  it('stops asking about a post when the reader goes to another, and asks about the new one from its own start', async () => {
    const w = await show()
    await settle(10_000)
    expect(getChanges).toHaveBeenCalledTimes(1)
    getPost.mockResolvedValue({ post: info({ id: OTHER }), lastRead: null, rev: '90' })
    listMessages.mockResolvedValue({ messages: [msg(8)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '90' })
    await w.setProps({ postId: OTHER })
    await settle(9999)
    expect(getChanges).toHaveBeenCalledTimes(1)
    await settle(1)
    expect(getChanges).toHaveBeenCalledTimes(2)
    expect(getChanges).toHaveBeenLastCalledWith('tok', OTHER, '90')
    await settle(10_000)
    expect(getChanges.mock.calls.filter((c) => c[1] === POST)).toHaveLength(1)
  })

  it('does not go on asking for a post whose opening was overtaken by another', async () => {
    const slow = deferred()
    const w = await show({ flush: false, arrange: () => getPost.mockReturnValueOnce(slow.promise) })
    getPost.mockResolvedValue({ post: info({ id: OTHER }), lastRead: null, rev: '90' })
    await w.setProps({ postId: OTHER })
    await settle()
    slow.resolve({ post: info(), lastRead: null, rev: '40' })
    await settle(10_000)
    expect(getChanges).toHaveBeenCalledTimes(1)
    expect(getChanges.mock.calls.every((c) => c[1] === OTHER)).toBe(true)
    await settle(10_000)
    expect(getChanges).toHaveBeenCalledTimes(2)
    expect(scrolled).toHaveLength(1)
  })
})

describe('PostPage: the opening message', () => {
  const page = (messages, over = {}) => run(messages, { hasOlder: true, ...over })

  it('is pinned on top, above "Load older", with the messages held below', async () => {
    const w = await show({ messages: [msg(4), msg(5)], hasOlder: true, opening: opener() })
    const kids = [...w.find('.lb-thread').element.children]
    expect(kids[0].id).toBe(`m-${POST}`)
    expect(kids[1]).toBe(button(w, 'Load older').element)
    expect(shownIds(w)).toEqual([POST, m(4), m(5)])
  })

  it('is laid out as an article, whatever its length, and shows its words', async () => {
    const w = await show({ messages: [msg(4)], hasOlder: true, opening: opener({ content: 'Short.' }) })
    expect(el(w, POST).classes()).toContain('lb-article')
    expect(el(w, POST).text()).toContain('Short.')
  })

  it('is shown once when the messages held bring it too', async () => {
    const w = await show({ messages: [opener(), msg(1)] })
    expect(w.findAll(`#m-${POST}`)).toHaveLength(1)
    expect(shownIds(w)).toEqual([POST, m(1)])
  })

  it('is not grouped with the first reply, by the same person a minute after', async () => {
    const w = await show({ messages: [msg(1, { createdAt: minutes(1) })], opening: opener({ createdAt: minutes(0) }) })
    expect(el(w, m(1)).classes()).not.toContain('lb-grouped')
  })

  it('leaves "Load older" first when the post has none (it was deleted)', async () => {
    const w = await show({ messages: [msg(4)], hasOlder: true, opening: null })
    expect(w.find('.lb-thread').element.children[0]).toBe(button(w, 'Load older').element)
    expect(shownIds(w)).toEqual([m(4)])
  })

  it('keeps the first message of the run where it was when older ones are added below it, not the opening message', async () => {
    const w = await show({ messages: [msg(3), msg(4)], hasOlder: true, opening: opener() })
    tops.set(`m-${POST}`, 10)
    tops.set(`m-${m(3)}`, 120)
    listMessages.mockImplementation(async () => {
      tops.set(`m-${m(3)}`, 520)
      return run([msg(1), msg(2)])
    })
    await button(w, 'Load older').trigger('click')
    await settle()
    expect(window.scrollBy).toHaveBeenCalledTimes(1)
    expect(window.scrollBy).toHaveBeenCalledWith({ top: 400, behavior: 'instant' })
  })

  it('is the newest message, and the place to scroll to, in a post with nothing else', async () => {
    await show({ messages: [], opening: opener() })
    expect(scrolled).toEqual([{ at: `m-${POST}`, options: { block: 'end', behavior: 'instant' } }])
  })

  it('is watched for reading like any message', async () => {
    const w = await show({ messages: [msg(4)], hasOlder: true, opening: opener() })
    expect([...live().targets].map((e) => e.id)).toEqual([`m-${POST}`, `m-${m(4)}`])
    report([POST])
    await settle(2000)
    expect(markRead).toHaveBeenCalledWith('tok', POST, POST)
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it('stays on top when the reader jumps to a month, and shows once', async () => {
    const created = '2026-09-20T12:00:00.000Z'
    const w = await show({ post: info({ createdAt: created }), messages: [msg(3)], hasOlder: true, opening: opener() })
    serve(page([msg(5)]), opener())
    await w.findAll('.lb-rail .lb-month')[1].trigger('click')
    await settle()
    expect(shownIds(w)).toEqual([POST, m(5)])
  })

  it('is changed on the page when a poll says it was edited, and is not added to the messages', async () => {
    const w = await show({ messages: [msg(4)], hasOlder: true, opening: opener() })
    getChanges.mockResolvedValue({ messages: [opener({ content: 'Edited words' })], deleted: [], rev: '42', people: {} })
    await settle(10_000)
    expect(el(w, POST).text()).toContain('Edited words')
    expect(shownIds(w)).toEqual([POST, m(4)])
  })

  it('is taken off the page when a poll says it was deleted', async () => {
    const w = await show({ messages: [msg(4)], hasOlder: true, opening: opener() })
    getChanges.mockResolvedValue({ messages: [], deleted: [POST], rev: '42', people: {} })
    await settle(10_000)
    expect(shownIds(w)).toEqual([m(4)])
  })

  it('is watched once a poll brings it', async () => {
    const w = await show({ messages: [msg(4)], hasOlder: true, opening: null })
    expect(shownIds(w)).toEqual([m(4)])
    getChanges.mockResolvedValue({ messages: [opener()], deleted: [], rev: '42', people: {} })
    await settle(10_000)
    expect(shownIds(w)).toEqual([POST, m(4)])
    expect([...live().targets].map((e) => e.id)).toContain(`m-${POST}`)
  })
})

describe('PostPage: Back', () => {
  const six = () => [msg(1), msg(2), msg(3), msg(4), msg(5), msg(6)]
  const key = `lb-anchor:${POST}`
  /** What the router leaves in the history entry the reader comes back to, and what the page kept when it was left. */
  const comeBack = (place, forward = '/reliquarium/librarius/other') => () => {
    window.history.replaceState({ forward }, '')
    if (place !== null) sessionStorage.setItem(key, place)
  }
  const around = (id) => (opts) => (opts.around === id ? run([msg(1), msg(2), msg(3), msg(4)], { hasOlder: true, hasNewer: true }) : run([msg(5), msg(6)], { hasOlder: true }))

  describe('leaving a post', () => {
    it('keeps the topmost message in view, under the post\'s own key, when the page is left', async () => {
      const w = await show({ messages: six() })
      report([m(3), m(4), m(2)])
      leave(w)
      expect(sessionStorage.getItem(key)).toBe(m(2))
    })

    it('takes the topmost by its number, not its text', async () => {
      const w = await show({ messages: [msg(1, { id: '99999999999999999' }), msg(2, { id: '100000000000000000' })] })
      report(['100000000000000000', '99999999999999999'])
      leave(w)
      expect(sessionStorage.getItem(key)).toBe('99999999999999999')
    })

    it('keeps the opening message when it is the topmost in view', async () => {
      const w = await show({ messages: [msg(4)], hasOlder: true, opening: opener() })
      report([m(4), POST])
      leave(w)
      expect(sessionStorage.getItem(key)).toBe(POST)
    })

    it('keeps it too when the reader goes to another post, under the id of the post they leave', async () => {
      const w = await show({ messages: six() })
      report([m(3)])
      getPost.mockResolvedValue({ post: info({ id: OTHER }), lastRead: null, rev: '40' })
      serve(run([msg(8)]))
      await w.setProps({ postId: OTHER })
      await settle()
      expect(sessionStorage.getItem(key)).toBe(m(3))
      expect(sessionStorage.getItem(`lb-anchor:${OTHER}`)).toBeNull()
    })

    it('forgets a place it kept when nothing is in view as the reader leaves', async () => {
      sessionStorage.setItem(key, m(2))
      const w = await show({ messages: six() })
      report([m(3)])
      report([m(3)], false)
      leave(w)
      expect(sessionStorage.getItem(key)).toBeNull()
    })

    it('leaves what it kept alone when the post never came up', async () => {
      sessionStorage.setItem(key, m(2))
      const w = await show({ arrange: () => getPost.mockReturnValue(deferred().promise) })
      leave(w)
      expect(sessionStorage.getItem(key)).toBe(m(2))
    })

    it('leaves what it kept alone when the post never came up and the reader goes to another', async () => {
      sessionStorage.setItem(key, m(2))
      const w = await show({ arrange: () => getPost.mockReturnValue(deferred().promise) })
      getPost.mockResolvedValue({ post: info({ id: OTHER }), lastRead: null, rev: '40' })
      serve(run([msg(8)]))
      await w.setProps({ postId: OTHER })
      await settle()
      expect(sessionStorage.getItem(key)).toBe(m(2))
    })

    it('leaves what it kept alone when the reader leaves while the next post is still coming', async () => {
      const w = await show({ messages: six() })
      report([m(3)])
      getPost.mockReturnValue(deferred().promise)
      await w.setProps({ postId: OTHER })
      await settle()
      expect(sessionStorage.getItem(key)).toBe(m(3))
      leave(w)
      expect(sessionStorage.getItem(`lb-anchor:${OTHER}`)).toBeNull()
    })

    it('is not troubled by a browser that keeps nothing', async () => {
      const w = await show({ messages: six() })
      report([m(3)])
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError')
      })
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new DOMException('off', 'SecurityError')
      })
      expect(() => leave(w)).not.toThrow()
    })

    it('keeps nothing in a browser without a topmost message to name (no observer), and forgets the old place', async () => {
      sessionStorage.setItem(key, m(2))
      vi.stubGlobal('IntersectionObserver', undefined)
      const w = await show({ messages: six() })
      leave(w)
      expect(sessionStorage.getItem(key)).toBeNull()
    })
  })

  describe('coming back', () => {
    it('opens around the place that was kept, and scrolls that message to the top', async () => {
      await show({ messages: six(), arrange: () => { serve(around(m(2))); comeBack(m(2))() } })
      expect(listMessages.mock.calls.filter((c) => !asksForOpening(c[2])).map((c) => c[2])).toEqual([{ around: m(2) }])
      expect(scrolled).toEqual([{ at: `m-${m(2)}`, options: { block: 'start', behavior: 'instant' } }])
    })

    it('takes it in place of the divider and of the address', async () => {
      await show({ messages: six(), lastRead: m(1), hash: `#m-${m(4)}`, arrange: () => { serve(around(m(2))); comeBack(m(2))() } })
      expect(scrolled.map((s) => s.at)).toEqual([`m-${m(2)}`])
      expect(listMessages.mock.calls.filter((c) => !asksForOpening(c[2])).map((c) => c[2])).toEqual([{ around: m(2) }])
    })

    it('does not go on to open around the address too, when the address names a message the run does not reach', async () => {
      await show({ messages: six(), lastRead: null, hash: `#m-${m(40)}`, arrange: () => { serve(around(m(2))); comeBack(m(2))() } })
      expect(listMessages.mock.calls.filter((c) => !asksForOpening(c[2])).map((c) => c[2])).toEqual([{ around: m(2) }])
      expect(scrolled.map((s) => s.at)).toEqual([`m-${m(2)}`])
    })

    it('still puts the divider by the reader\'s mark in the run it opened', async () => {
      const w = await show({ messages: six(), lastRead: m(2), arrange: () => { serve(around(m(1))); comeBack(m(1))() } })
      expect(afterDivider(w)).toBe(m(3))
    })

    it('does not open around it for a reader who did not come back (nothing forward in the history)', async () => {
      await show({ messages: six(), lastRead: null, arrange: () => { sessionStorage.setItem(key, m(2)) } })
      expect(listMessages.mock.calls.filter((c) => !asksForOpening(c[2])).map((c) => c[2])).toEqual([{}])
      expect(scrolled.map((s) => s.at)).toEqual([`m-${m(6)}`])
    })

    it.each([[null], [undefined], [''], [0], [false]])('counts a forward of %p as nothing', async (forward) => {
      await show({ messages: six(), lastRead: null, arrange: () => { window.history.replaceState({ forward }, ''); sessionStorage.setItem(key, m(2)) } })
      expect(scrolled.map((s) => s.at)).toEqual([`m-${m(6)}`])
    })

    it('uses the usual order for a reader who came back to a post with no place kept', async () => {
      await show({ messages: six(), lastRead: m(3), arrange: comeBack(null) })
      expect(scrolled.map((s) => s.at)).toEqual([expect.stringContaining('lb-divider')])
    })

    it('uses the address for a reader who came back with no place kept', async () => {
      await show({ messages: six(), lastRead: null, hash: `#m-${m(2)}`, arrange: comeBack(null) })
      expect(scrolled.map((s) => s.at)).toEqual([`m-${m(2)}`])
    })

    it('keeps no place of another post to hand to this one', async () => {
      await show({ messages: six(), lastRead: null, arrange: () => { window.history.replaceState({ forward: '/x' }, ''); sessionStorage.setItem(`lb-anchor:${OTHER}`, m(2)) } })
      expect(scrolled.map((s) => s.at)).toEqual([`m-${m(6)}`])
    })

    it.each([[''], ['abc'], ['1'.repeat(16)], ['1'.repeat(21)], [`${m(2)} `], [`${m(2)}x`], ['<script>'], ['-1']])('ignores a place kept as %p, which is no message id', async (kept) => {
      await show({ messages: six(), lastRead: null, arrange: () => { window.history.replaceState({ forward: '/x' }, ''); sessionStorage.setItem(key, kept) } })
      expect(listMessages.mock.calls.filter((c) => !asksForOpening(c[2])).map((c) => c[2])).toEqual([{}])
      expect(scrolled.map((s) => s.at)).toEqual([`m-${m(6)}`])
    })

    it('goes on with the divider, quietly, when the message that was kept is gone', async () => {
      const w = await show({ messages: six(), lastRead: m(3), arrange: () => { serve(() => run(six())); comeBack(m(40))() } })
      expect(w.find('[role="alert"]').exists()).toBe(false)
      expect(scrolled.map((s) => s.at)).toEqual([expect.stringContaining('lb-divider')])
    })

    it('goes on with the newest message when it is gone and there is no divider', async () => {
      await show({ messages: six(), lastRead: null, arrange: () => { serve(() => run(six())); comeBack(m(40))() } })
      expect(scrolled.map((s) => s.at)).toEqual([`m-${m(6)}`])
    })

    it('goes on in the usual way, and does not fall over, in a browser that keeps nothing', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('off', 'SecurityError')
      })
      await show({ messages: six(), lastRead: null, arrange: () => window.history.replaceState({ forward: '/x' }, '') })
      expect(scrolled.map((s) => s.at)).toEqual([`m-${m(6)}`])
    })

    it('does so for a post the reader comes back to by a change of post, too', async () => {
      const w = await show({ messages: six() })
      scrolled.length = 0
      window.history.replaceState({ forward: '/x' }, '')
      sessionStorage.setItem(`lb-anchor:${OTHER}`, m(7))
      getPost.mockResolvedValue({ post: info({ id: OTHER }), lastRead: null, rev: '40' })
      serve((opts) => (opts.around === m(7) ? run([msg(6), msg(7), msg(8)]) : run([msg(9)])))
      await w.setProps({ postId: OTHER })
      await settle()
      expect(lastPageAsk()).toEqual(['tok', OTHER, { around: m(7) }])
      expect(scrolled.map((s) => s.at)).toEqual([`m-${m(7)}`])
    })
  })
})

describe('PostPage: another post', () => {
  it('keeps saying it is loading, not that it failed, when an opening that was overtaken answers while the new one is still on its way', async () => {
    const slow = deferred()
    const w = await show({ flush: false, arrange: () => getPost.mockReturnValueOnce(slow.promise) })
    getPost.mockReturnValue(deferred().promise)
    await w.setProps({ postId: OTHER })
    await settle()
    slow.resolve({ post: info(), lastRead: null, rev: '40' })
    await settle()
    expect(w.text()).toContain('Loading…')
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it('shows the new post in place of the old, and the old one\'s messages no more', async () => {
    const w = await show()
    getPost.mockResolvedValue({ post: info({ id: OTHER, title: 'Another Road' }), lastRead: null, rev: '40' })
    listMessages.mockResolvedValue({ messages: [msg(8)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await w.setProps({ postId: OTHER })
    await settle()
    expect(w.find('h2').text()).toBe('Another Road')
    expect(shownIds(w)).toEqual([m(8)])
    expect(getPost).toHaveBeenLastCalledWith('tok', OTHER)
  })

  it('shows loading, not the old post, while the new one comes', async () => {
    const w = await show()
    getPost.mockReturnValue(deferred().promise)
    await w.setProps({ postId: OTHER })
    await settle()
    expect(w.text()).toContain('Loading…')
    expect(w.findAll('.lb-msg')).toHaveLength(0)
  })

  it('forgets a note about the old post\'s trouble', async () => {
    const w = await show({ messages: [msg(3)], hasOlder: true })
    listMessages.mockRejectedValue(apiError(503))
    await button(w, 'Load older').trigger('click')
    await settle()
    expect(w.find('.lb-notice').exists()).toBe(true)
    getPost.mockResolvedValue({ post: info({ id: OTHER }), lastRead: null, rev: '40' })
    listMessages.mockResolvedValue({ messages: [msg(8)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await w.setProps({ postId: OTHER })
    await settle()
    expect(w.find('.lb-notice').exists()).toBe(false)
  })

  it('takes a divider of its own for the new post, not the old one\'s', async () => {
    const w = await show({ messages: [opener(), msg(1), msg(2)], lastRead: m(1) })
    expect(divider(w).exists()).toBe(true)
    getPost.mockResolvedValue({ post: info({ id: OTHER }), lastRead: null, rev: '40' })
    listMessages.mockResolvedValue({ messages: [msg(8), msg(9)], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' })
    await w.setProps({ postId: OTHER })
    await settle()
    expect(divider(w).exists()).toBe(false)
  })
})
