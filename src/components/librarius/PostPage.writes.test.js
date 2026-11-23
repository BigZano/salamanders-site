// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { API_BASE } from '../../lib/buildsApi'
import { draftKey } from '../../lib/librarius/composer'
import { budget } from '../../../server/src/librariusForm.js'
import { POLL_MS, PENDING_MS, useLibrarius } from '../../stores/librarius'
import { useAuth } from '../../stores/auth'
import PostPage from './PostPage.vue'

// Replying, quoting, editing and deleting from the post page, through the real store and the real API client, against a fake of
// the server's routes (fetch). Every id and name here is invented.
const mid = (n) => String(200000000000000000n + BigInt(n))
const GUILD = mid(400)
const FORUM = mid(401)
const POST = mid(402)
const TOR = mid(410)
const IXEN = mid(411)
const SELF = mid(412)
const m = (n) => mid(450 + n)
const TOKEN = 'tok-invented'
const SIGNED_IN = 'salamanders-discord-member'
const CONFIRM = 'Delete this message? It goes from Discord too.'

const PEOPLE = {
  [TOR]: { name: 'Tor Mardan', avatar: null },
  [IXEN]: { name: 'Ixen Calloway', avatar: null },
  [SELF]: { name: 'Sefa Orrin', avatar: null },
}
const CAN = { reply: true, attach: true, delete: true, manageMessages: false, manageThreads: false }
const me = (over = {}) => ({ access: true, ready: true, tags: [], roles: [], guildId: GUILD, forumId: FORUM, form: 'v2', can: CAN, ...over })
const info = (over = {}) => ({ id: POST, ownerId: TOR, title: 'The Long Road', tagIds: [], pinned: false, locked: false, archived: false, createdAt: '2026-11-08T21:14:00.000Z', replies: 3, ...over })
const minutes = (n) => new Date(Date.parse('2026-11-09T10:00:00.000Z') + n * 60_000).toISOString()
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
const opener = () => msg(0, { id: POST, content: 'The opening words', createdAt: '2026-11-08T21:14:00.000Z' })
/** A reply of the reader's own, written on the site. */
const mine = (n, over = {}) => msg(n, { authorId: SELF, authorName: 'Sefa Orrin', origin: 'site', content: `My reply ${n}`, source: `My reply ${n}`, ...over })
const entry = (key, over = {}) => ({ key, kind: 'send', state: 'sending', error: null, source: 'On its way', createdAt: '2026-11-09T12:00:00.000Z', ...over })

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * The server, as the routes answer: each route answers what the test set for it (`answer`), and every request is kept, with its
 * method, path, query, body (JSON parsed, or the FormData) and headers.
 */
function fakeServer() {
  const requests = []
  const routes = []
  const answer = (method, path, reply) => routes.unshift({ method, path, reply })
  const fetch = vi.fn(async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url)
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    const request = { method, path: pathname, query: Object.fromEntries(searchParams), body, headers: init.headers ?? {} }
    requests.push(request)
    const route = routes.find((r) => r.method === method && (typeof r.path === 'string' ? r.path === pathname : r.path.test(pathname)))
    if (route === undefined) return json({ error: 'No such route.' }, 404)
    const out = await route.reply(request)
    return out instanceof Response ? out : json(out)
  })
  const sent = (method, path) => requests.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path)))
  return { fetch, requests, answer, sent }
}

let server
let mounted = []
let store

/** What the server holds: the post, its messages (oldest first), and what the reader has on its way. */
function serve({ post = info(), messages = [opener(), msg(1), msg(2)], pending = [], emoji = [], members = [] } = {}) {
  const first = messages.find((message) => message.id === POST)
  server.answer('GET', `/librarius/posts/${POST}`, () => ({ post, lastRead: null, rev: '40' }))
  server.answer('GET', `/librarius/posts/${POST}/messages`, (r) =>
    r.query.limit === '2'
      ? { messages: first ? [first] : [], hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' }
      : { messages, hasOlder: false, hasNewer: false, people: PEOPLE, rev: '40' },
  )
  server.answer('GET', `/librarius/posts/${POST}/changes`, () => ({ messages: [], deleted: [], rev: '41', people: {} }))
  server.answer('GET', `/librarius/posts/${POST}/pending`, () => ({ pending }))
  server.answer('GET', '/librarius/posts', () => ({ posts: [], people: {} }))
  server.answer('PUT', `/librarius/posts/${POST}/read`, () => new Response(null, { status: 204 }))
  server.answer('GET', '/librarius/emoji', () => ({ emoji }))
  server.answer('GET', '/librarius/members', () => ({ members }))
  server.answer('POST', `/librarius/posts/${POST}/messages`, () => json({ pending: { key: 'k-1', state: 'sending' } }, 202))
  server.answer('PATCH', /^\/librarius\/messages\/\d+$/, (r) => json({ pending: { key: r.path.split('/').at(-1), state: 'sending' } }, 202))
  server.answer('DELETE', /^\/librarius\/messages\/\d+$/, (r) => json({ pending: { key: r.path.split('/').at(-1), state: 'sending' } }, 202))
  server.answer('POST', '/librarius/uploads', () => json({ id: '7001' }, 201))
}

const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

/** Mounts the page for the post, the reader signed in as Sefa Orrin, with the store holding `me` and the server as `serve` sets it. */
async function show({ who = me(), arrange = () => {}, ...served } = {}) {
  serve(served)
  // A test that wants an answer of its own sets it here, before the page asks.
  arrange()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] })
  router.push(`/reliquarium/librarius/${POST}`)
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  store = useLibrarius()
  store.$patch((s) => {
    s.status = 'allowed'
    s.me = who
  })
  const w = mount(PostPage, { props: { postId: POST }, global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(w)
  await settle()
  return w
}

const composer = (w) => w.find('.lb-dock .lb-composer')
const area = (w) => w.get('.lb-dock textarea')
const sendButton = (w) => w.get('.lb-dock .lb-send')
const el = (w, id) => w.get(`#m-${id}`)
const tool = (w, id, name) => el(w, id).findAll('.lb-actions button').find((b) => b.text() === name)
const tools = (w, id) => el(w, id).findAll('.lb-actions button').map((b) => b.text())
const outgoing = (w) => w.findAll('.lb-outgoing')
async function type(w, text) {
  await area(w).setValue(text)
  area(w).element.setSelectionRange(text.length, text.length)
}
async function reply(w, text) {
  await type(w, text)
  await sendButton(w).trigger('click')
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem(SIGNED_IN, JSON.stringify({ id: SELF, username: 'sefa', isMember: true, librarius: true, accessToken: TOKEN, expiresAt: Date.now() + 86_400_000 }))
  server = fakeServer()
  vi.stubGlobal('fetch', server.fetch)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  Element.prototype.scrollIntoView = () => {}
  window.scrollBy = () => {}
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete document.visibilityState
  delete Element.prototype.scrollIntoView
  document.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

describe('PostPage: the composer', () => {
  it('is docked under the thread for a member who may reply, apart from the messages the page reads', async () => {
    const w = await show()
    const dock = w.get('.lb-dock')
    expect(dock.find('.lb-composer').exists()).toBe(true)
    expect(dock.findAll('.lb-msg')).toHaveLength(0)
    expect(w.get('.lb-thread').find('.lb-composer').exists()).toBe(false)
    expect(w.get('.lb-post-body').element.nextElementSibling).toBe(dock.element)
    expect(w.findAll('.lb-msg').map((e) => e.attributes('id'))).toEqual([`m-${POST}`, `m-${m(1)}`, `m-${m(2)}`])
    expect(w.get('.lb-dock .lb-composer-where').text()).toBe('Replying in: The Long Road')
    expect(w.get('.lb-dock .lb-posting-as').text()).toContain('Sefa Orrin')
  })

  it('is not there for a member who may not reply, nor when the server says nothing of what the reader may do', async () => {
    for (const who of [me({ can: { ...CAN, reply: false } }), me({ can: undefined }), me({ can: null }), me({ can: 'yes' })]) {
      const w = await show({ who })
      expect(composer(w).exists(), JSON.stringify(who.can)).toBe(false)
      expect(w.find('.lb-locked').exists()).toBe(false)
      mounted.splice(0).forEach((x) => x.unmount())
    }
  })

  it('says "This post is locked." in its place in a locked post', async () => {
    const w = await show({ post: info({ locked: true }) })
    expect(composer(w).exists()).toBe(false)
    expect(w.get('.lb-dock .lb-locked').text()).toBe('This post is locked.')
  })

  it('is there in a locked post for a member who manages threads, as Discord lets them reply', async () => {
    const w = await show({ post: info({ locked: true }), who: me({ can: { ...CAN, manageThreads: true } }) })
    expect(composer(w).exists()).toBe(true)
    expect(w.find('.lb-locked').exists()).toBe(false)
  })

  it('goes, keeping the draft, when the post is locked while a reply is being written (the post is read again every 6th poll)', async () => {
    const w = await show()
    await type(w, 'Half a reply')
    server.answer('GET', `/librarius/posts/${POST}`, () => ({ post: info({ locked: true }), lastRead: null, rev: '40' }))
    for (let i = 0; i < 6; i++) await settle(POLL_MS)
    expect(composer(w).exists()).toBe(false)
    expect(w.get('.lb-locked').text()).toBe('This post is locked.')
    expect(localStorage.getItem(draftKey(POST))).toBe('Half a reply')
  })

  it('queues the reply through the store with the reader\'s token, and shows it on its way, greyed, with "sending…"', async () => {
    const w = await show()
    await reply(w, 'Through the ash plain')
    const [sent] = server.sent('POST', `/librarius/posts/${POST}/messages`)
    expect(sent.body).toEqual({ source: 'Through the ash plain', replyTo: null, pingReply: false, mentions: [], uploads: [] })
    expect(sent.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(area(w).element.value).toBe('')
    const [on] = outgoing(w)
    expect(on.classes()).toContain('lb-pending')
    expect(on.get('.lb-state').text()).toBe('sending…')
    expect(on.get('.lb-body').text()).toBe('Through the ash plain')
    expect(on.get('.lb-name').text()).toBe('Sefa Orrin')
    expect(on.get('.lb-site-tag').text()).toBe('site')
    // Never one of the messages the page reads.
    expect(w.findAll('.lb-msg')).toHaveLength(3)
  })

  it('measures in the form the server checks replies in, and in Components V2 when it does not say', async () => {
    const text = 'a'.repeat(10)
    const opts = (form) => ({ form, authorId: SELF, siteUrl: `https://sm2salamanders.site/reliquarium/librarius/${POST}`, images: [] })
    expect(budget(text, opts('plain')).limit).not.toBe(budget(text, opts('v2')).limit)
    for (const [form, measured] of [['plain', 'plain'], ['v2', 'v2'], [undefined, 'v2'], ['html', 'v2'], [null, 'v2']]) {
      const w = await show({ who: me({ form }) })
      await type(w, text)
      expect(w.get('.lb-dock meter').attributes('max'), String(form)).toBe(String(budget(text, opts(measured)).limit))
      mounted.splice(0).forEach((x) => x.unmount())
    }
  })

  it('searches the members through the server for a mention, and sends the one picked as a mention of the reply', async () => {
    const w = await show({ members: [{ id: IXEN, name: 'Ixen Calloway', avatar: null }] })
    await w.get('.lb-dock button[aria-label="Mention someone"]').trigger('click')
    await w.get('.lb-dock [role="dialog"] input').setValue('Ix')
    await settle(250)
    const [asked] = server.sent('GET', '/librarius/members')
    expect(asked.query).toEqual({ q: 'Ix' })
    expect(asked.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    await w.get('.lb-dock [role="option"]').trigger('click')
    await settle()
    expect(area(w).element.value).toBe(`<@${IXEN}>`)
    await sendButton(w).trigger('click')
    await settle()
    expect(server.sent('POST', `/librarius/posts/${POST}/messages`)[0].body.mentions).toEqual([IXEN])
  })

  it('offers the server\'s own emoji, asked for once', async () => {
    const w = await show({ emoji: [{ id: mid(430), name: 'wolf', animated: false }] })
    expect(server.sent('GET', '/librarius/emoji')).toHaveLength(1)
    await w.get('.lb-dock button[aria-label="Emoji"]').trigger('click')
    await settle()
    await w.get('.lb-dock button[aria-label="This server"]').trigger('click')
    const custom = w.findAll('.lb-dock .lb-picker-grid img').map((img) => img.attributes('src'))
    expect(custom).toEqual([`https://cdn.discordapp.com/emojis/${mid(430)}.webp?size=48`])
  })

  it('goes on with no emoji of the server\'s when they cannot be had, or the answer is none', async () => {
    for (const down of [() => json({ error: 'Down.' }, 503), () => ({ emoji: 'none' }), () => ({})]) {
      const w = await show({ arrange: () => server.answer('GET', '/librarius/emoji', down) })
      await w.get('.lb-dock button[aria-label="Emoji"]').trigger('click')
      await settle()
      expect(w.findAll('.lb-dock .lb-picker-emoji').length).toBeGreaterThan(0)
      await w.get('.lb-dock button[aria-label="This server"]').trigger('click')
      expect(w.get('.lb-dock .lb-picker-empty').text()).toBe('This server has no emoji of its own.')
      mounted.splice(0).forEach((x) => x.unmount())
    }
  })

  it('sends a picture through the store, puts it in the text, and sends it with the reply', async () => {
    const w = await show()
    const file = new File(['not really a picture'], 'The map.png', { type: 'image/png' })
    Object.defineProperty(w.get('.lb-dock input[type="file"]').element, 'files', { value: [file], configurable: true })
    await w.get('.lb-dock input[type="file"]').trigger('change')
    await settle()
    const [up] = server.sent('POST', '/librarius/uploads')
    expect(up.body.get('file')).toBe(file)
    expect(up.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(area(w).element.value).toBe('![The map](upload:1)')
    expect(w.find('.lb-dead-pictures').exists()).toBe(false)
    await sendButton(w).trigger('click')
    await settle()
    expect(server.sent('POST', `/librarius/posts/${POST}/messages`)[0].body.uploads).toEqual(['7001'])
  })

  it('says pictures from before the reload need adding again, keeps the text, and sends nothing with them', async () => {
    localStorage.setItem(draftKey(POST), 'Look ![The map](upload:1)')
    const w = await show()
    expect(area(w).element.value).toBe('Look ![The map](upload:1)')
    expect(w.get('.lb-dead-pictures').text()).toBe('Pictures from before the reload need adding again.')
    expect(sendButton(w).attributes('disabled')).toBeDefined()
  })

  it('keeps what was typed in the last second when the server ends the sign-in in the middle of reading', async () => {
    const w = await show()
    await settle(POLL_MS - 500)
    await type(w, 'Typed as the sign-in ran out')
    server.answer('GET', `/librarius/posts/${POST}/changes`, () => json({ error: 'Sign in with Discord.' }, 401))
    await settle(500)
    expect(useAuth().signedIn).toBe(false)
    expect(composer(w).exists()).toBe(false)
    expect(localStorage.getItem(draftKey(POST))).toBe('Typed as the sign-in ran out')
  })

  it('asks what the reader has on its way when the post opens, and not of a server that says nothing of writing', async () => {
    await show()
    expect(server.sent('GET', `/librarius/posts/${POST}/pending`)).toHaveLength(1)
    mounted.splice(0).forEach((x) => x.unmount())
    await show({ who: me({ can: undefined }) })
    expect(server.sent('GET', `/librarius/posts/${POST}/pending`)).toHaveLength(1)
  })

  it('shows the reply once it is in the post as it was previewed, with the "site" tag', async () => {
    const source = `# The ford\n\nA **table** of <@${IXEN}>:\n\n| Road | Days |\n| --- | --- |\n| South | 3 |\n\n---\n\nwith a note[^1]\n\n[^1]: from the map`
    const w = await show()
    await type(w, source)
    const preview = w.get('.lb-dock .lb-tabpanel .lb-rendered').element.innerHTML
    await sendButton(w).trigger('click')
    await settle()
    const posted = mine(5, { content: source, source })
    server.answer('GET', `/librarius/posts/${POST}/pending`, () => ({ pending: [] }))
    await settle(PENDING_MS)
    server.answer('GET', `/librarius/posts/${POST}/changes`, () => ({ messages: [posted], deleted: [], rev: '41', people: {} }))
    await settle(POLL_MS)
    expect(outgoing(w)).toHaveLength(0)
    expect(el(w, m(5)).get('.lb-body').element.innerHTML).toBe(preview)
    expect(el(w, m(5)).get('.lb-site-tag').text()).toBe('site')
  })
})

describe('PostPage: replying to a message, and quoting it', () => {
  it('Reply sets the message the composer replies to, and the reply goes to it with a ping', async () => {
    const w = await show()
    await tool(w, m(1), 'Reply').trigger('click')
    await settle()
    expect(w.get('.lb-dock .lb-replying-to').text()).toContain('replying to Tor Mardan')
    expect(document.activeElement).toBe(area(w).element)
    await reply(w, 'Agreed')
    expect(server.sent('POST', `/librarius/posts/${POST}/messages`)[0].body).toMatchObject({ replyTo: m(1), pingReply: true })
    // Once it is on its way, the next reply is to the post again.
    expect(w.find('.lb-dock .lb-replying-to').exists()).toBe(false)
  })

  it('Quote puts the words selected in the message in as a quote, and replies to it', async () => {
    const w = await show({ messages: [opener(), msg(1, { content: 'The road south is closed\nuntil the thaw' })] })
    const text = el(w, m(1)).get('.lb-body').element
    const range = document.createRange()
    const node = [...text.querySelectorAll('*')].flatMap((e) => [...e.childNodes]).find((n) => n.nodeType === 3 && n.textContent.includes('road south'))
    range.setStart(node, node.textContent.indexOf('road'))
    range.setEnd(node, node.textContent.indexOf(' is'))
    document.getSelection().removeAllRanges()
    document.getSelection().addRange(range)
    await tool(w, m(1), 'Quote').trigger('click')
    await settle()
    expect(area(w).element.value).toBe('> road south\n')
    expect(w.get('.lb-dock .lb-replying-to').text()).toContain('Tor Mardan')
    expect(area(w).element.selectionStart).toBe('> road south\n'.length)
  })

  it('Quote puts the whole message in when nothing of it is selected, or what is selected is elsewhere', async () => {
    const w = await show({ messages: [opener(), msg(1, { content: 'First line\nSecond line' }), msg(2)] })
    await tool(w, m(1), 'Quote').trigger('click')
    await settle()
    expect(area(w).element.value).toBe('> First line\n> Second line\n')
    const range = document.createRange()
    range.selectNodeContents(el(w, m(2)).get('.lb-body').element)
    document.getSelection().addRange(range)
    await type(w, '')
    await tool(w, m(1), 'Quote').trigger('click')
    await settle()
    expect(area(w).element.value).toBe('> First line\n> Second line\n')
  })

  it('Quote of a whole message that mentions people writes them as the page names them, so the reply pings nobody and goes', async () => {
    const ROLE = mid(420)
    const who = me({ roles: [{ id: ROLE, name: 'Ash Wardens', color: '#aa5500' }] })
    const w = await show({ who, messages: [opener(), msg(1, { content: `See <@${IXEN}> and <@&${ROLE}> about the caravans, not \`<@${TOR}>\`.` })] })
    await tool(w, m(1), 'Quote').trigger('click')
    await settle()
    expect(area(w).element.value).toBe(`> See @Ixen Calloway and @Ash Wardens about the caravans, not \`<@${TOR}>\`.\n`)
    await sendButton(w).trigger('click')
    await settle()
    const [sent] = server.sent('POST', `/librarius/posts/${POST}/messages`)
    expect(sent.body).toMatchObject({ source: `> See @Ixen Calloway and @Ash Wardens about the caravans, not \`<@${TOR}>\`.\n`, replyTo: m(1), mentions: [] })
  })

  it('Quote of a reply written on the site quotes its source', async () => {
    const w = await show({ messages: [opener(), mine(1, { source: 'With **marks**', content: 'With **marks**' })] })
    await tool(w, m(1), 'Quote').trigger('click')
    await settle()
    expect(area(w).element.value).toBe('> With **marks**\n')
  })

  it('Quote of a message with no words only replies to it', async () => {
    const w = await show({ messages: [opener(), msg(1, { content: '', stickers: [{ id: mid(470), name: 'wave' }] })] })
    await tool(w, m(1), 'Quote').trigger('click')
    await settle()
    expect(area(w).element.value).toBe('')
    expect(w.get('.lb-dock .lb-replying-to').text()).toContain('Tor Mardan')
  })

  it('offers Reply and Quote on every message to a member who may reply, and on none otherwise', async () => {
    const w = await show()
    for (const id of [POST, m(1), m(2)]) expect(tools(w, id)).toEqual(['Reply', 'Quote'])
    mounted.splice(0).forEach((x) => x.unmount())
    const locked = await show({ post: info({ locked: true }) })
    for (const id of [POST, m(1), m(2)]) expect(locked.find(`#m-${id} .lb-actions`).exists()).toBe(false)
  })
})

describe('PostPage: pictures', () => {
  const pictureTool = (w) => w.get('.lb-dock [aria-label="Add a picture"]')
  const paste = (w) => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'map.png', { type: 'image/png' })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    event.clipboardData = { files: [file] }
    area(w).element.dispatchEvent(event)
    return event
  }

  it('offers no picture to a member who may not attach files, and sends none of theirs to the server', async () => {
    const w = await show({ who: me({ can: { ...CAN, attach: false } }) })
    expect(pictureTool(w).attributes('aria-disabled')).toBe('true')
    expect(paste(w).defaultPrevented).toBe(false)
    await settle()
    expect(server.sent('POST', '/librarius/uploads')).toEqual([])
  })

  it('holds the pictures of each draft apart, so that a picture added to one never goes with another', async () => {
    localStorage.setItem(draftKey(POST, m(1)), 'Draft for the first')
    let next = 7001
    const w = await show({ arrange: () => server.answer('POST', '/librarius/uploads', () => json({ id: String(next++) }, 201)) })
    // A picture for the reply to the post, at place 1.
    paste(w)
    await settle()
    expect(area(w).element.value).toBe('![map](upload:1)')
    // Reply on the first message, which has a draft of its own: the composer opens it, and its picture is given place 1 of its own.
    await tool(w, m(1), 'Reply').trigger('click')
    await settle()
    expect(area(w).element.value).toBe('Draft for the first')
    paste(w)
    await settle()
    expect(area(w).element.value).toContain('![map](upload:1)')
    await sendButton(w).trigger('click')
    await settle()
    // Sent, the composer replies to the post again, and opens its draft: its picture is the one it was given, not the other draft's.
    expect(w.find('.lb-dock .lb-replying-to').exists()).toBe(false)
    expect(area(w).element.value).toBe('![map](upload:1)')
    expect(w.find('.lb-dock .lb-dead-pictures').exists()).toBe(false)
    await sendButton(w).trigger('click')
    await settle()
    const sent = server.sent('POST', `/librarius/posts/${POST}/messages`).map((r) => [r.body.replyTo, r.body.uploads])
    expect(sent).toEqual([
      [m(1), ['7002']],
      [null, ['7001']],
    ])
  })

  it('moves the pictures of a draft with it when it replies to a message that has no draft', async () => {
    const w = await show()
    paste(w)
    await settle()
    await tool(w, m(2), 'Reply').trigger('click')
    await settle()
    expect(area(w).element.value).toBe('![map](upload:1)')
    expect(w.find('.lb-dock .lb-dead-pictures').exists()).toBe(false)
    await sendButton(w).trigger('click')
    await settle()
    expect(server.sent('POST', `/librarius/posts/${POST}/messages`).map((r) => [r.body.replyTo, r.body.uploads])).toEqual([[m(2), ['7001']]])
  })

  it('takes a picture from a member who may attach files', async () => {
    const w = await show()
    expect(pictureTool(w).attributes('aria-disabled')).toBeUndefined()
    expect(paste(w).defaultPrevented).toBe(true)
    await settle()
    expect(server.sent('POST', '/librarius/uploads')).toHaveLength(1)
  })
})

describe('PostPage: editing a reply', () => {
  it('Edit opens the composer with the reply\'s source, and the edit goes through the store', async () => {
    const w = await show({ messages: [opener(), msg(1), mine(2, { source: 'My **first** words', content: 'My **first** words' })] })
    await type(w, 'A reply I was writing')
    expect(tools(w, m(2))).toEqual(['Reply', 'Quote', 'Edit', 'Delete'])
    await tool(w, m(2), 'Edit').trigger('click')
    await settle()
    expect(area(w).element.value).toBe('My **first** words')
    expect(w.get('.lb-dock .lb-editing').text()).toContain('Editing')
    await type(w, 'My **second** words')
    await w.get('.lb-dock .lb-send').trigger('click')
    await settle()
    const [edit] = server.sent('PATCH', `/librarius/messages/${m(2)}`)
    expect(edit.body).toEqual({ source: 'My **second** words', mentions: [] })
    expect(edit.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(el(w, m(2)).classes()).toContain('lb-pending')
    expect(el(w, m(2)).get('.lb-state').text()).toBe('sending…')
    expect(el(w, m(2)).find('.lb-actions').exists()).toBe(false)
    expect(w.find('.lb-dock .lb-editing').exists()).toBe(false)
    expect(area(w).element.value).toBe('A reply I was writing')
  })

  it('measures an edit with the line of the message the reply answered, so an edit it pushes into a fourth message is over', async () => {
    const opts = { form: 'v2', authorId: SELF, siteUrl: `https://sm2salamanders.site/reliquarium/librarius/${POST}`, images: [] }
    const answering = { ...opts, replyTo: { authorId: TOR, url: `https://discord.com/channels/${GUILD}/${POST}/${m(1)}` } }
    const words = (n) => Array.from({ length: 3 }, () => 'a'.repeat(n)).join('\n\n')
    // The first length the line of the message replied to pushes into a fourth message, found by halving: the parts only grow with
    // the length, and budget() of 12,000 characters is slow.
    let length = 3500
    let hi = 4000
    while (length < hi) {
      const half = (length + hi) >> 1
      if (budget(words(half), answering).parts >= 4) hi = half
      else length = half + 1
    }
    expect([budget(words(length), opts).parts, budget(words(length), answering).parts]).toEqual([3, 4])
    const source = words(length)
    const replied = { id: m(1), authorId: TOR, authorName: 'Tor Mardan', content: 'Reply number 1' }
    const w = await show({ messages: [opener(), msg(1), mine(2, { source, content: source.slice(0, 4000), replyTo: replied }), mine(3, { source, content: source.slice(0, 4000) })] })
    await tool(w, m(3), 'Edit').trigger('click')
    await settle()
    expect(w.get('.lb-dock .lb-send').attributes('disabled')).toBeUndefined()
    await tool(w, m(2), 'Edit').trigger('click')
    await settle()
    expect(area(w).element.value).toBe(source)
    expect(w.get('.lb-dock .lb-send').attributes('disabled')).toBeDefined()
  })

  it('sends the people picked for an edit as its mentions', async () => {
    const w = await show({ members: [{ id: IXEN, name: 'Ixen Calloway', avatar: null }], messages: [opener(), mine(1)] })
    await tool(w, m(1), 'Edit').trigger('click')
    await settle()
    await w.get('.lb-dock button[aria-label="Mention someone"]').trigger('click')
    await w.get('.lb-dock [role="dialog"] input').setValue('Ix')
    await settle(250)
    await w.get('.lb-dock [role="option"]').trigger('click')
    await settle()
    await w.get('.lb-dock .lb-send').trigger('click')
    await settle()
    expect(server.sent('PATCH', `/librarius/messages/${m(1)}`)[0].body.mentions).toEqual([IXEN])
  })

  it('Cancel leaves the edit and changes nothing', async () => {
    const w = await show({ messages: [opener(), mine(1)] })
    await tool(w, m(1), 'Edit').trigger('click')
    await settle()
    await w.get('.lb-dock .lb-unedit').trigger('click')
    await settle()
    expect(area(w).element.value).toBe('')
    expect(server.sent('PATCH', /./)).toHaveLength(0)
  })

  it('Reply or Quote leaves an edit for a reply', async () => {
    const w = await show({ messages: [opener(), msg(1), mine(2)] })
    await tool(w, m(2), 'Edit').trigger('click')
    await settle()
    await tool(w, m(1), 'Quote').trigger('click')
    await settle()
    expect(w.find('.lb-dock .lb-editing').exists()).toBe(false)
    expect(area(w).element.value).toBe('> Reply number 1\n')
    await tool(w, m(2), 'Edit').trigger('click')
    await settle()
    await tool(w, m(1), 'Reply').trigger('click')
    await settle()
    expect(w.find('.lb-dock .lb-editing').exists()).toBe(false)
    expect(area(w).element.value).toBe('> Reply number 1\n')
  })

  it('is offered for the reader\'s own replies written on the site only', async () => {
    const w = await show({
      messages: [opener(), mine(1, { authorId: TOR, authorName: 'Tor Mardan' }), msg(2, { authorId: SELF }), mine(3, { source: undefined }), mine(4)],
    })
    expect(tools(w, m(1))).not.toContain('Edit')
    expect(tools(w, m(2))).not.toContain('Edit')
    expect(tools(w, m(3))).not.toContain('Edit')
    expect(tools(w, m(4))).toContain('Edit')
  })
})

describe('PostPage: deleting a message', () => {
  it('asks first, and deletes the reader\'s own message through the store, greying it while it goes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const w = await show({ messages: [opener(), msg(1, { authorId: SELF })] })
    await tool(w, m(1), 'Delete').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledWith(CONFIRM)
    const [gone] = server.sent('DELETE', `/librarius/messages/${m(1)}`)
    expect(gone.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(el(w, m(1)).classes()).toContain('lb-pending')
    expect(el(w, m(1)).get('.lb-state').text()).toBe('deleting…')
  })

  it('deletes nothing when the reader thinks better of it', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const w = await show({ messages: [opener(), mine(1)] })
    await tool(w, m(1), 'Delete').trigger('click')
    await settle()
    expect(server.sent('DELETE', /./)).toHaveLength(0)
    expect(el(w, m(1)).classes()).not.toContain('lb-pending')
  })

  // The owner's ruling (2026-11-22): a member who is timed out may delete their own reply, as the server lets them.
  it('is offered on the reader\'s own messages when they may delete them, timed out and unable to reply, and on nobody else\'s', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const timedOut = { reply: false, attach: false, delete: true, manageMessages: false, manageThreads: false }
    const w = await show({ who: me({ can: timedOut }), messages: [opener(), mine(1), msg(2)] })
    expect(w.find('.lb-dock .lb-composer').exists()).toBe(false)
    expect(tools(w, m(1))).toEqual(['Delete'])
    expect(el(w, m(2)).find('.lb-actions').exists()).toBe(false)
    await tool(w, m(1), 'Delete').trigger('click')
    await settle()
    expect(server.sent('DELETE', `/librarius/messages/${m(1)}`)).toHaveLength(1)
    mounted.splice(0).forEach((x) => x.unmount())
    // A server that says the reader may reply, and not that they may delete, is taken at its word.
    const replying = await show({ who: me({ can: { ...CAN, delete: false } }), messages: [opener(), mine(1)] })
    expect(tools(replying, m(1))).not.toContain('Delete')
  })

  it('is offered on anyone\'s message to a member who may manage messages, and never on the post\'s opening message', async () => {
    const w = await show({ who: me({ can: { ...CAN, manageMessages: true } }) })
    expect(tools(w, m(1))).toContain('Delete')
    expect(tools(w, POST)).not.toContain('Delete')
    mounted.splice(0).forEach((x) => x.unmount())
    const plain = await show()
    expect(tools(plain, m(1))).not.toContain('Delete')
  })

  it('is offered to a member who may manage messages though they may not reply, and not to one who may do neither', async () => {
    const w = await show({ who: me({ can: { ...CAN, reply: false, manageMessages: true } }), messages: [opener(), msg(1), msg(2, { authorId: SELF })] })
    expect(tools(w, m(1))).toEqual(['Delete'])
    mounted.splice(0).forEach((x) => x.unmount())
    const none = await show({ who: me({ can: { ...CAN, reply: false, delete: false } }), messages: [opener(), msg(1, { authorId: SELF })] })
    expect(none.find(`#m-${m(1)} .lb-actions`).exists()).toBe(false)
  })

  it('is not offered in a locked post but to a member who manages threads', async () => {
    const w = await show({ post: info({ locked: true }), who: me({ can: { ...CAN, manageMessages: true } }), messages: [opener(), mine(1)] })
    expect(w.find(`#m-${m(1)} .lb-actions`).exists()).toBe(false)
    mounted.splice(0).forEach((x) => x.unmount())
    const managing = await show({ post: info({ locked: true }), who: me({ can: { ...CAN, manageThreads: true } }), messages: [opener(), mine(1)] })
    expect(tools(managing, m(1))).toEqual(['Reply', 'Quote', 'Edit', 'Delete'])
  })

  it('says why when the server refuses, by the message', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const w = await show({ messages: [opener(), mine(1)] })
    server.answer('DELETE', /^\/librarius\/messages\/\d+$/, () => json({ error: 'This post is locked.' }, 403))
    await tool(w, m(1), 'Delete').trigger('click')
    await settle()
    expect(el(w, m(1)).get('.lb-action-error').text()).toBe('This post is locked.')
    server.answer('DELETE', /^\/librarius\/messages\/\d+$/, () => {
      throw new TypeError('Failed to fetch')
    })
    await tool(w, m(1), 'Delete').trigger('click')
    await settle()
    expect(el(w, m(1)).get('.lb-action-error').text()).toBe("Couldn't send. Try again.")
  })
})

describe('PostPage: what is on its way', () => {
  it('shows a reply sent before the page was loaded again, greyed, "sending…", until it is in the post', async () => {
    const w = await show({ pending: [entry('k-old', { source: 'From before' })] })
    const [on] = outgoing(w)
    expect(on.get('.lb-body').text()).toBe('From before')
    expect(on.get('.lb-state').text()).toBe('sending…')
    server.answer('GET', `/librarius/posts/${POST}/pending`, () => ({ pending: [] }))
    await settle(PENDING_MS)
    // Sent, not yet in the post: it stays until the poll brings it.
    expect(outgoing(w)).toHaveLength(1)
    server.answer('GET', `/librarius/posts/${POST}/changes`, () => ({ messages: [mine(3, { content: 'From before', source: 'From before' })], deleted: [], rev: '41', people: {} }))
    await settle(POLL_MS)
    expect(outgoing(w)).toHaveLength(0)
    expect(el(w, m(3)).get('.lb-body').text()).toBe('From before')
  })

  it('says a blocked reply was blocked, and Edit puts it back in the composer while Discard lets it go', async () => {
    const w = await show({ pending: [entry('k-1', { state: 'blocked', error: 'Discord blocked this reply.', source: 'Heresy here' }), entry('k-2', { state: 'blocked', source: 'Second' })] })
    expect(outgoing(w).map((o) => o.get('.lb-state').text())).toEqual([
      "Blocked by the server's rules. Edit it or discard it.",
      "Blocked by the server's rules. Edit it or discard it.",
    ])
    expect(outgoing(w)[0].classes()).not.toContain('lb-pending')
    await type(w, 'Already here')
    await outgoing(w)[0].findAll('button').find((b) => b.text() === 'Edit').trigger('click')
    await settle()
    expect(area(w).element.value).toBe('Already here\nHeresy here\n')
    expect(outgoing(w)).toHaveLength(1)
    const confirm = vi.spyOn(window, 'confirm')
    await outgoing(w)[0].findAll('button').find((b) => b.text() === 'Discard').trigger('click')
    await settle()
    expect(confirm).not.toHaveBeenCalled()
    expect(outgoing(w)).toHaveLength(0)
    expect(server.sent('DELETE', /./)).toHaveLength(0)
  })

  it('says a failed reply could not be sent, with the server\'s reason, and Retry sends it again', async () => {
    const w = await show({ pending: [entry('k-1', { state: 'failed', error: 'This post is locked in Discord.', source: 'Try me' })] })
    const [on] = outgoing(w)
    expect(on.get('.lb-state').text()).toBe("Couldn't send. Try again. This post is locked in Discord.")
    await on.findAll('button').find((b) => b.text() === 'Retry').trigger('click')
    await settle()
    expect(server.sent('POST', `/librarius/posts/${POST}/messages`)[0].body).toEqual({ source: 'Try me', replyTo: null, pingReply: false, mentions: [], uploads: [] })
    expect(outgoing(w)[0].get('.lb-state').text()).toBe('sending…')
  })

  it('lets a failed reply go on Dismiss, and says why when Retry is refused', async () => {
    const w = await show({ pending: [entry('k-1', { state: 'failed', source: 'One' }), entry('k-2', { state: 'failed', source: 'Two' })] })
    expect(outgoing(w)[0].get('.lb-state').text()).toBe("Couldn't send. Try again.")
    server.answer('POST', `/librarius/posts/${POST}/messages`, () => json({ error: 'Slow down a little: try again in 20 seconds.' }, 429))
    await outgoing(w)[0].findAll('button').find((b) => b.text() === 'Retry').trigger('click')
    await settle()
    expect(outgoing(w)[0].get('.lb-action-error').text()).toBe('Slow down a little: try again in 20 seconds.')
    await outgoing(w)[1].findAll('button').find((b) => b.text() === 'Dismiss').trigger('click')
    await settle()
    expect(outgoing(w).map((o) => o.get('.lb-body').text())).toEqual(['One'])
  })

  it('shows a blocked edit on its message, and Edit opens that edit again', async () => {
    const w = await show({ messages: [opener(), mine(1)], pending: [entry(m(1), { kind: 'edit', state: 'blocked', source: 'The blocked words' })] })
    expect(el(w, m(1)).get('.lb-state').text()).toBe("Blocked by the server's rules. Edit it or discard it.")
    expect(el(w, m(1)).classes()).not.toContain('lb-pending')
    await el(w, m(1)).findAll('.lb-state-tools button').find((b) => b.text() === 'Edit').trigger('click')
    await settle()
    expect(area(w).element.value).toBe('The blocked words')
    expect(w.get('.lb-dock .lb-editing').exists()).toBe(true)
    expect(el(w, m(1)).find('.lb-state').exists()).toBe(false)
  })

  it('opens a blocked edit whose words the server does not say with the reply\'s own source, and Discard lets the edit go', async () => {
    const w = await show({ messages: [opener(), mine(1), mine(2)], pending: [entry(m(1), { kind: 'edit', state: 'blocked', source: null }), entry(m(2), { kind: 'edit', state: 'blocked', source: null })] })
    await el(w, m(1)).findAll('.lb-state-tools button').find((b) => b.text() === 'Edit').trigger('click')
    await settle()
    expect(area(w).element.value).toBe('My reply 1')
    await el(w, m(2)).findAll('.lb-state-tools button').find((b) => b.text() === 'Discard').trigger('click')
    await settle()
    expect(el(w, m(2)).find('.lb-state').exists()).toBe(false)
    expect(server.sent('DELETE', /./)).toHaveLength(0)
  })

  it('shows a failed delete on its message, and Retry deletes it again', async () => {
    const w = await show({ messages: [opener(), mine(1)], pending: [entry(m(1), { kind: 'delete', state: 'failed', source: null })] })
    expect(el(w, m(1)).get('.lb-state').text()).toBe("Couldn't delete. Try again.")
    await el(w, m(1)).findAll('.lb-state-tools button').find((b) => b.text() === 'Retry').trigger('click')
    await settle()
    expect(server.sent('DELETE', `/librarius/messages/${m(1)}`)).toHaveLength(1)
    expect(el(w, m(1)).get('.lb-state').text()).toBe('deleting…')
  })

  it('says so when a failed edit cannot be sent again from here', async () => {
    const w = await show({ messages: [opener(), mine(1)], pending: [entry(m(1), { kind: 'edit', state: 'failed', source: null })] })
    await el(w, m(1)).findAll('.lb-state-tools button').find((b) => b.text() === 'Retry').trigger('click')
    await settle()
    expect(el(w, m(1)).get('.lb-action-error').text()).toBe("This edit can't be sent again from here: edit the message again.")
    expect(server.sent('PATCH', /./)).toHaveLength(0)
  })

  it('offers no way to edit what is blocked to a member who may no longer reply', async () => {
    const w = await show({ who: me({ can: { ...CAN, reply: false } }), pending: [entry('k-1', { state: 'blocked' })] })
    expect(outgoing(w)[0].findAll('button').map((b) => b.text())).toEqual(['Discard'])
  })

  it('leaves a message with nothing on its way as it is', async () => {
    const w = await show({ messages: [opener(), mine(1), mine(2)], pending: [entry(m(1), { kind: 'edit', state: 'sending', source: 'New words' })] })
    expect(el(w, m(1)).classes()).toContain('lb-pending')
    expect(el(w, m(2)).classes()).not.toContain('lb-pending')
    expect(el(w, m(2)).find('.lb-state').exists()).toBe(false)
  })
})

describe('PostPage: a reply written on the site', () => {
  it('has the "site" tag, and a message from Discord has none', async () => {
    const w = await show({ messages: [opener(), msg(1), mine(2)] })
    expect(el(w, m(2)).get('.lb-site-tag').text()).toBe('site')
    expect(el(w, m(1)).find('.lb-site-tag').exists()).toBe(false)
  })
})

describe('PostPage: another post', () => {
  it('leaves the reply and the edit of the post before when the page shows another', async () => {
    const w = await show({ messages: [opener(), msg(1), mine(2)] })
    await tool(w, m(1), 'Reply').trigger('click')
    await settle()
    const other = mid(403)
    server.answer('GET', `/librarius/posts/${other}`, () => ({ post: info({ id: other, title: 'Another Road' }), lastRead: null, rev: '40' }))
    server.answer('GET', `/librarius/posts/${other}/messages`, () => ({ messages: [], hasOlder: false, hasNewer: false, people: {}, rev: '40' }))
    server.answer('GET', `/librarius/posts/${other}/pending`, () => ({ pending: [] }))
    await w.setProps({ postId: other })
    await settle()
    expect(w.get('.lb-dock .lb-composer-where').text()).toBe('Replying in: Another Road')
    expect(w.find('.lb-dock .lb-replying-to').exists()).toBe(false)
  })
})
