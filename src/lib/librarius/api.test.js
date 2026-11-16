import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { API_BASE, BuildsApiError } from '../buildsApi'
import { getMe, listPosts, getPost, listMessages, getChanges, markRead, listEmoji } from './api'

// Every id and token here is invented.
const TOKEN = 'tok-invented-1'
const POST = '200000000000000401'
const MSG = '200000000000000402'
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

/** The one request the last call made: [url, init]. */
const sent = () => {
  expect(fetchMock).toHaveBeenCalledTimes(1)
  return fetchMock.mock.calls[0]
}
const headersOf = (init) => init.headers ?? {}

describe('the reads', () => {
  it.each([
    ['getMe', () => getMe(TOKEN), '/librarius/me'],
    ['listPosts', () => listPosts(TOKEN), '/librarius/posts'],
    ['listEmoji', () => listEmoji(TOKEN), '/librarius/emoji'],
    ['getPost', () => getPost(TOKEN, POST), `/librarius/posts/${POST}`],
    ['listMessages', () => listMessages(TOKEN, POST), `/librarius/posts/${POST}/messages`],
    ['listMessages with an empty options object', () => listMessages(TOKEN, POST, {}), `/librarius/posts/${POST}/messages`],
    ['getChanges', () => getChanges(TOKEN, POST, '17'), `/librarius/posts/${POST}/changes?since=17`],
  ])('%s: GETs its route with the token in a header, never in the address, and never from the HTTP cache', async (_name, call, path) => {
    fetchMock.mockResolvedValue(json({ ok: 1 }))
    expect(await call()).toEqual({ ok: 1 })
    const [url, init] = sent()
    expect(url).toBe(`${API_BASE}${path}`)
    expect(url).not.toContain(TOKEN)
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store' })
    expect(headersOf(init)).toEqual({ Authorization: `Bearer ${TOKEN}` })
    expect(init.body).toBeUndefined()
  })

  it('answers whatever JSON the server sent, untouched', async () => {
    const body = { messages: [{ id: MSG }], hasOlder: false, hasNewer: true, people: { [MSG]: { name: 'Invented', avatar: null } }, rev: '9' }
    fetchMock.mockResolvedValue(json(body))
    expect(await listMessages(TOKEN, POST)).toEqual(body)
  })
})

describe('listMessages: the page asked for', () => {
  const urlOf = async (options) => {
    fetchMock.mockImplementation(async () => json({}))
    fetchMock.mockClear()
    await listMessages(TOKEN, POST, options)
    return fetchMock.mock.calls[0][0]
  }
  const base = `${API_BASE}/librarius/posts/${POST}/messages`

  it.each([
    ['before', { before: MSG }, `?before=${MSG}`],
    ['after', { after: MSG }, `?after=${MSG}`],
    ['around', { around: MSG }, `?around=${MSG}`],
    ['limit', { limit: 25 }, '?limit=25'],
    ['a cursor and a limit', { before: MSG, limit: 100 }, `?before=${MSG}&limit=100`],
    ['after and a limit', { after: MSG, limit: 1 }, `?after=${MSG}&limit=1`],
    ['around and a limit', { around: MSG, limit: 10 }, `?around=${MSG}&limit=10`],
  ])('asks only for %s', async (_name, options, query) => {
    expect(await urlOf(options)).toBe(`${base}${query}`)
  })

  it('leaves out every option that is undefined or null, so the newest page is the plain route', async () => {
    expect(await urlOf({ before: undefined, after: undefined, around: undefined, limit: undefined })).toBe(base)
    expect(await urlOf({ before: null, after: null, around: null, limit: null })).toBe(base)
    expect(await urlOf({ around: null, limit: 20 })).toBe(`${base}?limit=20`)
  })

  it('sends a value that is falsy but given, such as 0 or an empty string, for the server to judge', async () => {
    expect(await urlOf({ limit: 0 })).toBe(`${base}?limit=0`)
    expect(await urlOf({ before: '' })).toBe(`${base}?before=`)
    expect(await urlOf({ before: 0 })).toBe(`${base}?before=0`)
  })

  it('URL-encodes each value, so a hostile one cannot add a parameter or end the query', async () => {
    expect(await urlOf({ before: 'a b&c=d/e#f?g' })).toBe(`${base}?before=a%20b%26c%3Dd%2Fe%23f%3Fg`)
    expect(await urlOf({ limit: '5&around=1' })).toBe(`${base}?limit=5%26around%3D1`)
  })

  it('ignores an option it does not know', async () => {
    expect(await urlOf({ unknown: 'x', before: MSG })).toBe(`${base}?before=${MSG}`)
    expect(await urlOf({ unknown: 'x' })).toBe(base)
  })
})

describe('getChanges: the number it asks from', () => {
  const urlOf = async (since) => {
    fetchMock.mockImplementation(async () => json({}))
    fetchMock.mockClear()
    await getChanges(TOKEN, POST, since)
    return fetchMock.mock.calls[0][0]
  }

  it('puts since in the query, URL-encoded', async () => {
    expect(await urlOf('0')).toBe(`${API_BASE}/librarius/posts/${POST}/changes?since=0`)
    expect(await urlOf(0)).toBe(`${API_BASE}/librarius/posts/${POST}/changes?since=0`)
    expect(await urlOf('9223372036854775807')).toBe(`${API_BASE}/librarius/posts/${POST}/changes?since=9223372036854775807`)
    expect(await urlOf('1&since=2')).toBe(`${API_BASE}/librarius/posts/${POST}/changes?since=1%26since%3D2`)
  })
})

describe('markRead', () => {
  it('PUTs the message id as JSON, with the token in a header, and answers null for the empty reply', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    expect(await markRead(TOKEN, POST, MSG)).toBeNull()
    const [url, init] = sent()
    expect(url).toBe(`${API_BASE}/librarius/posts/${POST}/read`)
    expect(url).not.toContain(TOKEN)
    expect(url).not.toContain(MSG)
    expect(init).toMatchObject({ method: 'PUT', cache: 'no-store' })
    expect(headersOf(init)).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` })
    expect(JSON.parse(init.body)).toEqual({ messageId: MSG })
  })
})

describe('the post id', () => {
  const HOSTILE = ['a/b?c', '../posts', '..%2f', '1/2', 'a b', 'a#b', '%', '%2e%2e', 'x?since=1', '\n', 'é', '']

  it('is URL-encoded on every route that has one, so it cannot leave its path segment', async () => {
    fetchMock.mockImplementation(async () => json({}))
    for (const id of HOSTILE) {
      fetchMock.mockClear()
      const enc = encodeURIComponent(id)
      await getPost(TOKEN, id)
      await listMessages(TOKEN, id)
      await getChanges(TOKEN, id, '1')
      await markRead(TOKEN, id, MSG)
      expect(
        fetchMock.mock.calls.map(([url]) => url),
        JSON.stringify(id),
      ).toEqual([
        `${API_BASE}/librarius/posts/${enc}`,
        `${API_BASE}/librarius/posts/${enc}/messages`,
        `${API_BASE}/librarius/posts/${enc}/changes?since=1`,
        `${API_BASE}/librarius/posts/${enc}/read`,
      ])
    }
  })

  it('stays one path segment for any text (property)', async () => {
    fetchMock.mockImplementation(async () => json({}))
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary' }), async (id) => {
        fetchMock.mockClear()
        await getPost(TOKEN, id)
        const url = fetchMock.mock.calls[0][0]
        expect(url.startsWith(`${API_BASE}/librarius/posts/`)).toBe(true)
        const rest = url.slice(`${API_BASE}/librarius/posts/`.length)
        expect(rest).not.toMatch(/[/?#\s]/)
        expect(decodeURIComponent(rest)).toBe(id)
      }),
    )
  })
})

describe('an id that cannot be URL-encoded', () => {
  // A lone surrogate is no text a URL can carry: encodeURIComponent throws, and nothing malformed goes on the wire.
  it.each([
    ['getPost', () => getPost(TOKEN, '\ud800')],
    ['listMessages id', () => listMessages(TOKEN, '\ud800')],
    ['listMessages cursor', () => listMessages(TOKEN, POST, { around: '\udc00' })],
    ['getChanges id', () => getChanges(TOKEN, '\ud800', '1')],
    ['getChanges since', () => getChanges(TOKEN, POST, '\ud800')],
    ['markRead', () => markRead(TOKEN, '\ud800', MSG)],
  ])('%s: fails with a URIError and sends nothing', async (_name, call) => {
    await expect((async () => call())()).rejects.toBeInstanceOf(URIError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('failures', () => {
  const CALLS = [
    ['getMe', () => getMe(TOKEN)],
    ['listPosts', () => listPosts(TOKEN)],
    ['listEmoji', () => listEmoji(TOKEN)],
    ['getPost', () => getPost(TOKEN, POST)],
    ['listMessages', () => listMessages(TOKEN, POST, { around: MSG })],
    ['getChanges', () => getChanges(TOKEN, POST, '1')],
    ['markRead', () => markRead(TOKEN, POST, MSG)],
  ]

  it.each(CALLS)("%s: throws the server's message with the status", async (_name, call) => {
    fetchMock.mockResolvedValue(json({ error: 'Restricted to those who can read the Librarius in Discord.' }, 403))
    const err = await call().catch((e) => e)
    expect(err).toBeInstanceOf(BuildsApiError)
    expect(err).toMatchObject({ message: 'Restricted to those who can read the Librarius in Discord.', status: 403 })
  })

  it.each(CALLS)('%s: names the status when the server sent no message', async (_name, call) => {
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }))
    await expect(call()).rejects.toMatchObject({ message: 'Request failed (502)', status: 502 })
  })

  it.each(CALLS)('%s: lets a network failure reach the caller as it is', async (_name, call) => {
    const down = new TypeError('Failed to fetch')
    fetchMock.mockRejectedValue(down)
    await expect(call()).rejects.toBe(down)
  })
})
