// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

const state = vi.hoisted(() => ({ auth: null }))
vi.mock('../../stores/auth', () => ({ useAuth: () => state.auth }))
vi.mock('../../lib/librarius/api')
import { listPosts } from '../../lib/librarius/api'
import { useLibrarius } from '../../stores/librarius'
import TopicList from './TopicList.vue'

// Every id and name here is invented; ids come from the range the Librarius fixtures use.
const mid = (n) => String(200000000000000000n + BigInt(n))
const GUILD = mid(400)
const FORUM = mid(401)
const TOR = mid(410)
const IXEN = mid(411)
const MARA = mid(412)
const KEL = mid(413)
const TAG_A = mid(420)
const TAG_B = mid(421)
const NOW = '2026-11-10T10:02:00.000Z'
const CDN = 'https://cdn.discordapp.com/attachments/200000000000000401/200000000000000460/file.png?ex=65f0&hm=ab12'
const AVATAR = 'https://cdn.discordapp.com/avatars/200000000000000410/aaaa.png?size=64'

const ME = { access: true, ready: true, tags: [{ id: TAG_A, name: 'Lore' }, { id: TAG_B, name: 'Rules' }], roles: [], guildId: GUILD, forumId: FORUM }
const PEOPLE = {
  [TOR]: { name: 'Tor Mardan', avatar: AVATAR },
  [IXEN]: { name: 'Ixen Calloway', avatar: null },
  [MARA]: { name: 'Mara Venn', avatar: null },
  [KEL]: { name: 'Kel Dorrin', avatar: null },
}
const post = (n, over = {}) => ({
  id: mid(n),
  title: `Invented post ${n}`,
  tagIds: [],
  pinned: false,
  locked: false,
  archived: false,
  createdAt: '2026-11-01T10:00:00.000Z',
  lastActivityAt: '2026-11-10T10:00:00.000Z',
  replies: 3,
  unread: 0,
  latest: { id: mid(n + 50), authorId: TOR, authorName: 'Tor Mardan', authorAvatar: AVATAR, content: 'Hello there', image: null },
  posterIds: [TOR],
  ...over,
})
// A post with its two dates set: the "activity" one and the creation one.
const dated = (n, activity, created, over = {}) => post(n, { lastActivityAt: activity, createdAt: created, ...over })

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

const mounted = []
let store
/** Mounts the list on a router with the post route, with the store holding `me` and the API answering `posts`. */
async function show(posts, { me = ME, people = PEOPLE, flush = true } = {}) {
  // `posts` is null when the test has set what the API answers itself.
  if (posts !== null) listPosts.mockResolvedValue({ posts, people })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/reliquarium/librarius', component: { template: '<div />' } },
      { path: '/reliquarium/librarius/:postId', component: { template: '<div />' } },
    ],
  })
  router.push('/reliquarium/librarius')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  store = useLibrarius()
  store.$patch((s) => {
    s.status = 'allowed'
    s.me = me
  })
  const w = mount(TopicList, { global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(w)
  if (flush) await flushPromises()
  return w
}
const leave = (w) => {
  mounted.splice(mounted.indexOf(w), 1)
  w.unmount()
}
const titles = (w) => w.findAll('.lb-topic-title').map((t) => t.text())
const buttonNamed = (w, text) => w.findAll('button').find((b) => b.text() === text)
const link = (w) => w.findAll('a').find((a) => a.text() === 'Start a post in Discord ↗')

beforeEach(() => {
  vi.resetAllMocks()
  state.auth = reactive({ token: 'tok', signedIn: true })
  visibility('visible')
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.useRealTimers()
  delete document.visibilityState
})

describe('TopicList: order', () => {
  it('asks for the posts with the reader\'s token when it is shown', async () => {
    await show([post(430)])
    expect(listPosts).toHaveBeenCalledTimes(1)
    expect(listPosts).toHaveBeenCalledWith('tok')
  })

  it('puts a pinned post first, then the rest by latest activity, newest first, whatever order the server sent', async () => {
    const w = await show([
      dated(430, '2026-11-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
      dated(431, '2026-11-09T00:00:00.000Z', '2026-10-02T00:00:00.000Z'),
      dated(432, '2026-10-20T00:00:00.000Z', '2026-10-03T00:00:00.000Z', { pinned: true }),
      dated(433, '2026-11-05T00:00:00.000Z', '2026-10-04T00:00:00.000Z'),
    ])
    expect(titles(w)).toEqual(['Invented post 432', 'Invented post 431', 'Invented post 433', 'Invented post 430'])
  })

  it('marks the pinned posts "Pinned", and only them', async () => {
    const w = await show([post(430, { pinned: true }), post(431)])
    const rows = w.findAll('.lb-topic')
    expect(rows[0].text()).toContain('Pinned')
    expect(rows[1].text()).not.toContain('Pinned')
  })

  it('offers "Latest activity" (the default) and "Newest" in a select', async () => {
    const w = await show([post(430)])
    const select = w.find('select')
    expect(select.findAll('option').map((o) => o.text())).toEqual(['Latest activity', 'Newest'])
    expect(select.element.selectedOptions[0].text).toBe('Latest activity')
  })

  it('sorts by the day a post was made when "Newest" is chosen, a pinned post still on top, and back again', async () => {
    const w = await show([
      dated(430, '2026-11-09T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
      dated(431, '2026-11-02T00:00:00.000Z', '2026-10-05T00:00:00.000Z'),
      dated(432, '2026-11-03T00:00:00.000Z', '2026-09-01T00:00:00.000Z', { pinned: true }),
      dated(433, '2026-11-04T00:00:00.000Z', '2026-10-03T00:00:00.000Z'),
    ])
    expect(titles(w)).toEqual(['Invented post 432', 'Invented post 430', 'Invented post 433', 'Invented post 431'])
    const select = w.find('select')
    await select.setValue(select.findAll('option')[1].element.value)
    expect(titles(w)).toEqual(['Invented post 432', 'Invented post 431', 'Invented post 433', 'Invented post 430'])
    await select.setValue(select.findAll('option')[0].element.value)
    expect(titles(w)).toEqual(['Invented post 432', 'Invented post 430', 'Invented post 433', 'Invented post 431'])
  })

  it('keeps the server\'s order for posts that are level, and survives a date that is no date', async () => {
    const w = await show([
      dated(430, 'later than never', '2026-10-01T00:00:00.000Z'),
      dated(431, '2026-11-02T00:00:00.000Z', '2026-10-05T00:00:00.000Z'),
      dated(432, '2026-11-02T00:00:00.000Z', '2026-10-05T00:00:00.000Z'),
    ])
    expect(titles(w)).toEqual(['Invented post 431', 'Invented post 432', 'Invented post 430'])
  })
})

describe('TopicList: tags', () => {
  it('shows "All" and a chip for each tag of the forum, with "All" pressed', async () => {
    const w = await show([post(430)])
    const chips = w.findAll('.lb-chip')
    expect(chips.map((c) => c.text())).toEqual(['All', 'Lore', 'Rules'])
    expect(chips.map((c) => c.attributes('aria-pressed'))).toEqual(['true', 'false', 'false'])
  })

  it('names the tags of a post on its row, and skips a tag the forum does not list', async () => {
    const w = await show([post(430, { tagIds: [TAG_B, mid(499), TAG_A] })])
    expect(w.findAll('.lb-topic .lb-tag').map((t) => t.text())).toEqual(['Rules', 'Lore'])
  })

  it('lists only the posts that carry the tag chosen, and everything again for "All"', async () => {
    const w = await show([post(430, { tagIds: [TAG_A] }), post(431, { tagIds: [TAG_B] }), post(432), post(433, { tagIds: [TAG_A, TAG_B] })])
    await buttonNamed(w, 'Lore').trigger('click')
    expect(titles(w)).toEqual(['Invented post 430', 'Invented post 433'])
    expect(w.findAll('.lb-chip').map((c) => c.attributes('aria-pressed'))).toEqual(['false', 'true', 'false'])
    await buttonNamed(w, 'Rules').trigger('click')
    expect(titles(w)).toEqual(['Invented post 431', 'Invented post 433'])
    await buttonNamed(w, 'All').trigger('click')
    expect(titles(w)).toHaveLength(4)
  })

  it('says so when no open post carries the tag', async () => {
    const w = await show([post(430, { tagIds: [TAG_A] })])
    await buttonNamed(w, 'Rules').trigger('click')
    expect(titles(w)).toEqual([])
    expect(w.text()).toContain('No open posts here.')
  })

  it('shows no chips for a forum with no tags', async () => {
    const w = await show([post(430)], { me: { ...ME, tags: [] } })
    expect(w.findAll('.lb-chip')).toHaveLength(0)
    expect(titles(w)).toEqual(['Invented post 430'])
  })
})

describe('TopicList: archived posts', () => {
  const posts = () => [
    post(430),
    post(431, { archived: true, tagIds: [TAG_A], lastActivityAt: '2026-10-01T00:00:00.000Z' }),
    post(432, { archived: true, lastActivityAt: '2026-10-02T00:00:00.000Z' }),
    post(433, { archived: true, tagIds: [TAG_A], pinned: true, lastActivityAt: '2026-09-01T00:00:00.000Z' }),
  ]

  it('hides archived posts behind "Show archived (N)", N being how many there are', async () => {
    const w = await show(posts())
    expect(titles(w)).toEqual(['Invented post 430'])
    expect(buttonNamed(w, 'Show archived (3)')).toBeTruthy()
  })

  it('shows them after the open posts when the button is pressed, and hides them again', async () => {
    const w = await show(posts())
    await buttonNamed(w, 'Show archived (3)').trigger('click')
    expect(titles(w)).toEqual(['Invented post 430', 'Invented post 433', 'Invented post 432', 'Invented post 431'])
    expect(buttonNamed(w, 'Show archived (3)')).toBeUndefined()
    await buttonNamed(w, 'Hide archived (3)').trigger('click')
    expect(titles(w)).toEqual(['Invented post 430'])
    expect(buttonNamed(w, 'Show archived (3)')).toBeTruthy()
  })

  it('counts only the archived posts the tag chosen would show', async () => {
    const w = await show(posts())
    await buttonNamed(w, 'Lore').trigger('click')
    expect(buttonNamed(w, 'Show archived (2)')).toBeTruthy()
    await buttonNamed(w, 'Show archived (2)').trigger('click')
    expect(titles(w)).toEqual(['Invented post 433', 'Invented post 431'])
  })

  it('has no button when nothing is archived', async () => {
    const w = await show([post(430), post(431)])
    expect(w.findAll('button').filter((b) => /archived/.test(b.text()))).toHaveLength(0)
  })

  it('has no button when no archived post carries the tag chosen', async () => {
    const w = await show(posts())
    await buttonNamed(w, 'Rules').trigger('click')
    expect(w.findAll('button').filter((b) => /archived/.test(b.text()))).toHaveLength(0)
  })

  it('still offers the archived posts of a forum with nothing open', async () => {
    const w = await show([post(430, { archived: true }), post(431, { archived: true })])
    expect(titles(w)).toEqual([])
    expect(w.text()).toContain('No open posts here.')
    expect(w.text()).not.toContain('Nothing here yet')
    expect(buttonNamed(w, 'Show archived (2)')).toBeTruthy()
  })
})

describe('TopicList: a row', () => {
  it('links to the post', async () => {
    const w = await show([post(430)])
    const row = w.find('a.lb-topic')
    expect(row.attributes('href')).toBe(`/reliquarium/librarius/${mid(430)}`)
  })

  it('shows "N new" when there are unread messages, and nothing when there are none', async () => {
    const w = await show([post(430, { unread: 12 }), post(431, { unread: 0 }), post(432, { unread: 7931 })])
    const rows = w.findAll('.lb-topic')
    expect(rows.map((r) => r.find('.lb-new').exists())).toEqual([true, false, true])
    expect(w.findAll('.lb-new').map((b) => b.text())).toEqual(['12 new', '7,931 new'])
    expect(w.text()).not.toMatch(/\b0 new\b/)
  })

  it('shows who wrote the newest message, by the name they have now, and its first line as plain text', async () => {
    const w = await show([post(430, { latest: { ...post(430).latest, authorName: 'Old Name', content: '## Heading\n**bold** and ||a secret|| and `code`' } })])
    const line = w.find('.lb-topic-latest')
    expect(line.find('.lb-topic-author').text()).toBe('Tor Mardan')
    expect(line.text()).toContain('Heading')
    expect(line.text()).toContain('bold')
    expect(line.text()).toContain('▒▒▒')
    expect(line.text()).not.toContain('secret')
    expect(line.text()).not.toMatch(/[*#`|]/)
  })

  it('falls back on the name the message came with when the author is not among the people', async () => {
    const w = await show([post(430, { latest: { ...post(430).latest, authorId: mid(499), authorName: 'Stored Name' } })], { people: {} })
    expect(w.find('.lb-topic-author').text()).toBe('Stored Name')
  })

  it('cuts a long first line to about 120 characters', async () => {
    const w = await show([post(430, { latest: { ...post(430).latest, content: 'word '.repeat(100) } })])
    const text = w.find('.lb-topic-text').text()
    expect(text.length).toBeLessThanOrEqual(120)
    expect(text.endsWith('…')).toBe(true)
  })

  it('shows a thumbnail when the newest message carries a picture from Discord\'s CDN, and none otherwise', async () => {
    const image = { id: mid(460), url: CDN, expiresAt: '2026-11-11T00:00:00.000Z' }
    const w = await show([post(430, { latest: { ...post(430).latest, image } }), post(431)])
    const rows = w.findAll('.lb-topic')
    expect(rows[0].find('img.lb-thumb').attributes('src')).toBe(CDN)
    expect(rows[1].find('img.lb-thumb').exists()).toBe(false)
  })

  it('shows no thumbnail for a picture that is not on Discord\'s CDN', async () => {
    const hostile = ['https://evil.example/a.png', 'http://cdn.discordapp.com/attachments/1/2/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '', null, 7]
    for (const url of hostile) {
      const w = await show([post(430, { latest: { ...post(430).latest, image: { id: mid(460), url, expiresAt: null } } })])
      expect(w.find('img.lb-thumb').exists(), String(url)).toBe(false)
      expect(titles(w)).toEqual(['Invented post 430'])
    }
  })

  it('drops a thumbnail that fails to load, and keeps the row', async () => {
    const image = { id: mid(460), url: CDN, expiresAt: null }
    const w = await show([post(430, { latest: { ...post(430).latest, image } })])
    await w.find('img.lb-thumb').trigger('error')
    expect(w.find('img.lb-thumb').exists()).toBe(false)
    expect(titles(w)).toEqual(['Invented post 430'])
  })

  it.each([
    [0, '0 replies'],
    [1, '1 reply'],
    [2, '2 replies'],
    [7931, '7,931 replies'],
  ])('counts %i replies as "%s"', async (replies, text) => {
    const w = await show([post(430, { replies })])
    expect(w.find('.lb-topic-meta').text()).toContain(text)
  })

  it('shows up to three posters as avatars, the first three the server names, with initials where there is no picture', async () => {
    const w = await show([post(430, { posterIds: [TOR, IXEN, MARA, KEL] })])
    const posters = w.findAll('.lb-poster')
    expect(posters).toHaveLength(3)
    expect(posters[0].attributes('src')).toBe(AVATAR)
    expect(posters[1].text()).toBe('IC')
    expect(posters[2].text()).toBe('MV')
    expect(w.find('.lb-posters').attributes('aria-label')).toBe('Recent posters: Tor Mardan, Ixen Calloway, Mara Venn')
  })

  it('shows initials, not a picture, for an avatar that is not on Discord\'s CDN, and skips a poster nobody knows', async () => {
    const people = { ...PEOPLE, [TOR]: { name: 'Tor Mardan', avatar: 'https://evil.example/a.png' } }
    const w = await show([post(430, { posterIds: [TOR, mid(499), 'constructor', '__proto__'] })], { people })
    const posters = w.findAll('.lb-poster')
    expect(posters).toHaveLength(1)
    expect(posters[0].element.tagName).toBe('SPAN')
    expect(posters[0].text()).toBe('TM')
  })

  it('shows the author and no text for a newest message with no text, or text that is no text', async () => {
    for (const content of ['', '   ', null, undefined, 42, {}]) {
      const w = await show([post(430, { latest: { ...post(430).latest, content } })])
      expect(w.find('.lb-topic-author').text(), String(content)).toBe('Tor Mardan')
      expect(w.find('.lb-topic-text').text(), String(content)).toBe('')
    }
  })

  it('shows a post with no messages, and no poster, without a line for the newest message', async () => {
    const w = await show([post(430, { latest: null, posterIds: [], replies: 0 })])
    expect(titles(w)).toEqual(['Invented post 430'])
    expect(w.find('.lb-topic-latest').exists()).toBe(false)
    expect(w.find('.lb-posters').exists()).toBe(false)
  })

  it('shows a title and a name from Discord as text, never as markup', async () => {
    const markup = '<img src=x onerror=alert(1)><script>alert(2)</script>'
    const people = { ...PEOPLE, [TOR]: { name: markup, avatar: null } }
    const w = await show([post(430, { title: markup, latest: { ...post(430).latest, content: markup } })], { people })
    expect(w.find('.lb-topic-title').text()).toBe(markup)
    expect(w.find('.lb-topic-author').text()).toBe(markup)
    expect(w.find('.lb-topic img[src="x"]').exists()).toBe(false)
    expect(w.find('script').exists()).toBe(false)
  })
})

describe('TopicList: the time of the last activity', () => {
  const at = (seconds) => new Date(Date.parse(NOW) - seconds * 1000).toISOString()
  const ago = async (seconds) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
    const w = await show([post(430, { lastActivityAt: at(seconds) })])
    return w.find('.lb-topic-meta time')
  }

  it.each([
    [-3600, 'just now'],
    [0, 'just now'],
    [59, 'just now'],
    [60, '1m ago'],
    [120, '2m ago'],
    [59 * 60 + 59, '59m ago'],
    [60 * 60, '1h ago'],
    [23 * 3600 + 3599, '23h ago'],
    [24 * 3600, '1d ago'],
    [6 * 86400, '6d ago'],
    [29 * 86400 + 86399, '29d ago'],
  ])('reads %i seconds as "%s"', async (seconds, text) => {
    const time = await ago(seconds)
    expect(time.text()).toBe(text)
    expect(time.attributes('datetime')).toBe(at(seconds))
  })

  it('writes a date for activity a month or more back', async () => {
    const time = await ago(30 * 86400)
    expect(time.text()).not.toContain('ago')
    expect(time.text()).toMatch(/2026/)
  })

  it('writes no time for a date that is no date', async () => {
    const w = await show([post(430, { lastActivityAt: 'yesterday-ish' })])
    expect(w.find('.lb-topic-meta time').exists()).toBe(false)
    expect(w.find('.lb-topic-meta').text()).toContain('3 replies')
  })
})

describe('TopicList: the button to Discord', () => {
  it('opens the forum in Discord in a new tab, and gives the new page no hold on this one', async () => {
    const w = await show([post(430)])
    const a = link(w)
    expect(a.attributes('href')).toBe(`https://discord.com/channels/${GUILD}/${FORUM}`)
    expect(a.attributes('target')).toBe('_blank')
    expect(a.attributes('rel')).toBe('noopener noreferrer')
  })

  it('is not a link at all when the forum\'s address is not made of ids', async () => {
    for (const bad of [{ guildId: 'abc' }, { forumId: '../x' }, { guildId: undefined }, { forumId: null }, { guildId: 12345678901234567 }, { forumId: `${FORUM}/../..` }]) {
      const w = await show([post(430)], { me: { ...ME, ...bad } })
      expect(link(w), JSON.stringify(bad)).toBeUndefined()
      expect(titles(w)).toEqual(['Invented post 430'])
    }
  })
})

describe('TopicList: an empty forum', () => {
  it('says posts are started in Discord, and offers the same button, with no filters or sort', async () => {
    const w = await show([])
    expect(w.text()).toContain('Nothing here yet. Posts are started in Discord.')
    expect(link(w).attributes('href')).toBe(`https://discord.com/channels/${GUILD}/${FORUM}`)
    expect(w.findAll('a').filter((a) => a.text() === 'Start a post in Discord ↗')).toHaveLength(1)
    expect(w.find('select').exists()).toBe(false)
    expect(w.findAll('.lb-chip')).toHaveLength(0)
  })

  it('has one such button when there are posts, too', async () => {
    const w = await show([post(430)])
    expect(w.findAll('a').filter((a) => a.text() === 'Start a post in Discord ↗')).toHaveLength(1)
    expect(w.text()).not.toContain('Nothing here yet')
  })

  it('says it is loading until the first answer comes, not that the forum is empty', async () => {
    const answer = deferred()
    listPosts.mockReturnValue(answer.promise)
    const w = await show(null)
    expect(w.text()).toContain('Loading…')
    expect(w.text()).not.toContain('Nothing here yet')
    answer.resolve({ posts: [], people: {} })
    await flushPromises()
    expect(w.text()).not.toContain('Loading…')
    expect(w.text()).toContain('Nothing here yet')
  })

  it('says the Librarius could not be reached when the first answer fails, and tries again on Retry', async () => {
    listPosts.mockRejectedValue(Object.assign(new Error('down'), { status: 503 }))
    const w = await show(null)
    expect(w.find('[role="alert"]').text()).toContain("The Librarius couldn't be reached.")
    expect(w.text()).not.toContain('Nothing here yet')
    listPosts.mockResolvedValue({ posts: [post(430)], people: PEOPLE })
    await buttonNamed(w, 'Retry').trigger('click')
    await flushPromises()
    expect(titles(w)).toEqual(['Invented post 430'])
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })
})

describe('TopicList: refreshing', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }))
  const settle = (ms) => vi.advanceTimersByTimeAsync(ms)

  it('asks again every 30 seconds while the page is visible, with the token the reader has then', async () => {
    const w = await show([post(430)], { flush: false })
    await settle(0)
    expect(listPosts).toHaveBeenCalledTimes(1)
    await settle(29_999)
    expect(listPosts).toHaveBeenCalledTimes(1)
    await settle(1)
    expect(listPosts).toHaveBeenCalledTimes(2)
    state.auth.token = 'tok2'
    await settle(30_000)
    expect(listPosts).toHaveBeenCalledTimes(3)
    expect(listPosts).toHaveBeenLastCalledWith('tok2')
    await settle(30_000)
    expect(listPosts).toHaveBeenCalledTimes(4)
    expect(titles(w)).toEqual(['Invented post 430'])
  })

  it('shows what a refresh brings', async () => {
    const w = await show([post(430)], { flush: false })
    await settle(0)
    listPosts.mockResolvedValue({ posts: [post(431), post(430)], people: PEOPLE })
    await settle(30_000)
    expect(titles(w)).toEqual(['Invented post 431', 'Invented post 430'])
  })

  it('does not ask while the page is hidden, and asks again at the first look once it is visible', async () => {
    await show([post(430)], { flush: false })
    await settle(0)
    visibility('hidden')
    await settle(30_000)
    await settle(30_000)
    expect(listPosts).toHaveBeenCalledTimes(1)
    visibility('visible')
    await settle(30_000)
    expect(listPosts).toHaveBeenCalledTimes(2)
  })

  it('keeps asking after a refresh fails, and keeps the list it has', async () => {
    const w = await show([post(430)], { flush: false })
    await settle(0)
    listPosts.mockRejectedValue(Object.assign(new Error('down'), { status: 503 }))
    await settle(30_000)
    expect(listPosts).toHaveBeenCalledTimes(2)
    expect(titles(w)).toEqual(['Invented post 430'])
    expect(w.find('[role="alert"]').exists()).toBe(false)
    listPosts.mockResolvedValue({ posts: [post(431)], people: PEOPLE })
    await settle(30_000)
    expect(titles(w)).toEqual(['Invented post 431'])
  })

  it('does not ask again while an answer is still on its way', async () => {
    await show([post(430)], { flush: false })
    await settle(0)
    const slow = deferred()
    listPosts.mockReturnValue(slow.promise)
    await settle(30_000)
    expect(listPosts).toHaveBeenCalledTimes(2)
    await settle(90_000)
    expect(listPosts).toHaveBeenCalledTimes(2)
    slow.resolve({ posts: [post(430)], people: PEOPLE })
    await settle(0)
    await settle(30_000)
    expect(listPosts).toHaveBeenCalledTimes(3)
  })

  it('stops when the page is left, even with an answer still on its way', async () => {
    const w = await show([post(430)], { flush: false })
    await settle(0)
    const slow = deferred()
    listPosts.mockReturnValue(slow.promise)
    await settle(30_000)
    expect(listPosts).toHaveBeenCalledTimes(2)
    leave(w)
    slow.resolve({ posts: [], people: {} })
    await settle(120_000)
    expect(listPosts).toHaveBeenCalledTimes(2)
  })

  it('stops when the page is left while it waits', async () => {
    const w = await show([post(430)], { flush: false })
    await settle(0)
    leave(w)
    await settle(120_000)
    expect(listPosts).toHaveBeenCalledTimes(1)
  })
})
