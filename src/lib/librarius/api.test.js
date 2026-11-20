import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { API_BASE, BuildsApiError } from '../buildsApi'
import { getMe, listPosts, getPost, listMessages, getChanges, markRead, listEmoji, getPending, postReply, editMessage, deleteMessage, uploadPicture, searchMembers } from './api'

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
/** What is no id, built afresh by each test that wants it. */
const NOT_IDS = () => [
  '',
  ' ',
  'abc',
  '12345',
  '1234567890123456',
  '123456789012345678901',
  '-200000000000000402',
  '+200000000000000402',
  '200000000000000402.5',
  '2e17',
  '0x2c68af0bb140402',
  ' 200000000000000402',
  '200000000000000402 ',
  '200000000000000402\n',
  '2000000000000004\n02',
  '２０００００００００００００４０２',
  '٢٠٠٠٠٠٠٠٠٠٠٠٠٠٤٠٢',
  200000000000000402,
  200000000000000402n,
  true,
  null,
  undefined,
  {},
  { toString: () => '200000000000000402' },
  ['200000000000000402'],
  new String('200000000000000402'),
  Symbol('id'),
]

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
  const base = () => `${API_BASE}/librarius/posts/${POST}/messages`

  it.each([
    ['before', { before: MSG }, `?before=${MSG}`],
    ['after', { after: MSG }, `?after=${MSG}`],
    ['around', { around: MSG }, `?around=${MSG}`],
    ['limit', { limit: 25 }, '?limit=25'],
    ['a cursor and a limit', { before: MSG, limit: 100 }, `?before=${MSG}&limit=100`],
    ['after and a limit', { after: MSG, limit: 1 }, `?after=${MSG}&limit=1`],
    ['around and a limit', { around: MSG, limit: 10 }, `?around=${MSG}&limit=10`],
  ])('asks only for %s', async (_name, options, query) => {
    expect(await urlOf(options)).toBe(`${base()}${query}`)
  })

  it('leaves out every option that is undefined or null, so the newest page is the plain route', async () => {
    expect(await urlOf({ before: undefined, after: undefined, around: undefined, limit: undefined })).toBe(base())
    expect(await urlOf({ before: null, after: null, around: null, limit: null })).toBe(base())
    expect(await urlOf({ around: null, limit: 20 })).toBe(`${base()}?limit=20`)
  })

  it('sends a limit that is falsy but given, such as 0, for the server to judge', async () => {
    expect(await urlOf({ limit: 0 })).toBe(`${base()}?limit=0`)
  })

  it('URL-encodes the limit, so a hostile one cannot add a parameter or end the query', async () => {
    expect(await urlOf({ limit: '5&around=1' })).toBe(`${base()}?limit=5%26around%3D1`)
    expect(await urlOf({ limit: 'a b#c?d/e' })).toBe(`${base()}?limit=a%20b%23c%3Fd%2Fe`)
  })

  it('ignores an option it does not know', async () => {
    expect(await urlOf({ unknown: 'x', before: MSG })).toBe(`${base()}?before=${MSG}`)
    expect(await urlOf({ unknown: 'x' })).toBe(base())
  })

  it.each(['before', 'after', 'around'])('refuses a %s that is no id, and sends nothing', async (name) => {
    // Undefined and null are no cursor at all: they are left out, not refused.
    for (const value of NOT_IDS().filter((v) => v !== undefined && v !== null)) {
      fetchMock.mockClear()
      await expect(listMessages(TOKEN, POST, { [name]: value }), `${name}: ${String(value)}`).rejects.toThrow(
        new TypeError(`${name} must be an id: a string of 17 to 20 digits.`),
      )
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('refuses a falsy cursor that is given, such as an empty string or 0, which the server would have judged before', async () => {
    await expect(listMessages(TOKEN, POST, { before: '' })).rejects.toBeInstanceOf(TypeError)
    await expect(listMessages(TOKEN, POST, { after: 0 })).rejects.toBeInstanceOf(TypeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a bad cursor even next to a good one, rather than send the good one alone', async () => {
    await expect(listMessages(TOKEN, POST, { before: MSG, around: 'x' })).rejects.toThrow(new TypeError('around must be an id: a string of 17 to 20 digits.'))
    expect(fetchMock).not.toHaveBeenCalled()
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
  it('refuses a message id that is no id, and sends nothing', async () => {
    for (const value of NOT_IDS()) {
      fetchMock.mockClear()
      await expect(markRead(TOKEN, POST, value), String(value)).rejects.toThrow(new TypeError('messageId must be an id: a string of 17 to 20 digits.'))
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

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
  // The routes it makes, for one post id.
  const routes = (id) => [
    () => getPost(TOKEN, id),
    () => listMessages(TOKEN, id),
    () => getChanges(TOKEN, id, '1'),
    () => markRead(TOKEN, id, MSG),
    () => getPending(TOKEN, id),
    () => postReply(TOKEN, id, { source: 'Hi' }),
  ]

  it('is on the path of every route that has one, as it is', async () => {
    fetchMock.mockImplementation(async () => json({}))
    for (const call of routes(POST)) await call()
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${API_BASE}/librarius/posts/${POST}`,
      `${API_BASE}/librarius/posts/${POST}/messages`,
      `${API_BASE}/librarius/posts/${POST}/changes?since=1`,
      `${API_BASE}/librarius/posts/${POST}/read`,
      `${API_BASE}/librarius/posts/${POST}/pending`,
      `${API_BASE}/librarius/posts/${POST}/messages`,
    ])
  })

  it('is refused when it is no id, on every route, and nothing is sent: a dot or two cannot climb out of the path', async () => {
    const hostile = [...NOT_IDS(), '.', '..', '../posts', '..%2f', '%2e%2e', 'a/b?c', '1/2', 'x?since=1', '200000000000000401/read', '200000000000000401/../me']
    for (const id of hostile) {
      for (const call of routes(id)) {
        await expect(call(), String(id)).rejects.toThrow(new TypeError('The post id must be an id: a string of 17 to 20 digits.'))
      }
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is accepted at 17 and at 20 digits, and refused at 16 and at 21', async () => {
    fetchMock.mockImplementation(async () => json({}))
    for (const id of ['10000000000000000', '18446744073709551615']) {
      for (const call of routes(id)) await call()
    }
    expect(fetchMock).toHaveBeenCalledTimes(12)
    fetchMock.mockClear()
    for (const id of ['1000000000000000', '184467440737095516150']) {
      for (const call of routes(id)) await expect(call()).rejects.toBeInstanceOf(TypeError)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stays one path segment of digits, and anything else is refused (property)', async () => {
    fetchMock.mockImplementation(async () => json({}))
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary' }), async (id) => {
        fetchMock.mockClear()
        const isId = /^\d{17,20}$/.test(id)
        if (isId) {
          await getPost(TOKEN, id)
          expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/librarius/posts/${id}`)
        } else {
          await expect(getPost(TOKEN, id)).rejects.toBeInstanceOf(TypeError)
          expect(fetchMock).not.toHaveBeenCalled()
        }
      }),
    )
  })

  it('takes any string of 17 to 20 digits (property)', async () => {
    fetchMock.mockImplementation(async () => json({}))
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^\d{17,20}$/), async (id) => {
        fetchMock.mockClear()
        await markRead(TOKEN, id, id)
        expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/librarius/posts/${id}/read`)
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ messageId: id })
      }),
    )
  })
})

describe('what cannot be URL-encoded', () => {
  // A lone surrogate is no text a URL can carry: encodeURIComponent throws, and nothing malformed goes on the wire.
  it.each([
    ['getChanges since', () => getChanges(TOKEN, POST, '\ud800')],
    ['listMessages limit', () => listMessages(TOKEN, POST, { limit: '\udc00' })],
  ])('%s: fails with a URIError and sends nothing', async (_name, call) => {
    await expect((async () => call())()).rejects.toBeInstanceOf(URIError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is no id either: a lone surrogate in an id is refused as one', async () => {
    await expect(getPost(TOKEN, '\ud800')).rejects.toBeInstanceOf(TypeError)
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
    ['getPending', () => getPending(TOKEN, POST)],
    ['postReply', () => postReply(TOKEN, POST, { source: 'Hi' })],
    ['editMessage', () => editMessage(TOKEN, MSG, { source: 'Hi' })],
    ['deleteMessage', () => deleteMessage(TOKEN, MSG)],
    ['uploadPicture', () => uploadPicture(TOKEN, new Blob(['x']))],
    ['searchMembers', () => searchMembers(TOKEN, 'Inv')],
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

describe('the writes', () => {
  const REPLY = { source: 'A reply <@200000000000000403>', replyTo: MSG, pingReply: true, mentions: ['200000000000000403'], uploads: ['7'] }

  it('getPending asks for the caller\'s own entries of a post, never from the cache', async () => {
    fetchMock.mockResolvedValue(json({ pending: [] }))
    await expect(getPending(TOKEN, POST)).resolves.toEqual({ pending: [] })
    const [url, init] = sent()
    expect(url).toBe(`${API_BASE}/librarius/posts/${POST}/pending`)
    expect(init.method).toBe('GET')
    expect(init.cache).toBe('no-store')
    expect(headersOf(init).Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('postReply POSTs the reply as JSON, with the token in a header, never from the cache, and answers what the server said', async () => {
    fetchMock.mockResolvedValue(json({ pending: { key: 'k-1', state: 'sending' } }, 202))
    await expect(postReply(TOKEN, POST, REPLY)).resolves.toEqual({ pending: { key: 'k-1', state: 'sending' } })
    const [url, init] = sent()
    expect(url).toBe(`${API_BASE}/librarius/posts/${POST}/messages`)
    expect(init.method).toBe('POST')
    expect(init.cache).toBe('no-store')
    expect(headersOf(init)).toEqual({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual(REPLY)
  })

  it('editMessage PATCHes the message by its id, with the new text as JSON', async () => {
    fetchMock.mockResolvedValue(json({ pending: { key: MSG, state: 'sending' } }, 202))
    await expect(editMessage(TOKEN, MSG, { source: 'Changed', mentions: [] })).resolves.toEqual({ pending: { key: MSG, state: 'sending' } })
    const [url, init] = sent()
    expect(url).toBe(`${API_BASE}/librarius/messages/${MSG}`)
    expect(init.method).toBe('PATCH')
    expect(init.cache).toBe('no-store')
    expect(headersOf(init)).toEqual({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual({ source: 'Changed', mentions: [] })
  })

  it('deleteMessage DELETEs the message by its id, with no body, and answers what the server said', async () => {
    fetchMock.mockResolvedValue(json({ pending: { key: MSG, state: 'sending' } }, 202))
    await expect(deleteMessage(TOKEN, MSG)).resolves.toEqual({ pending: { key: MSG, state: 'sending' } })
    const [url, init] = sent()
    expect(url).toBe(`${API_BASE}/librarius/messages/${MSG}`)
    expect(init.method).toBe('DELETE')
    expect(init.cache).toBe('no-store')
    expect(init.body).toBeUndefined()
    expect(headersOf(init)).toEqual({ Authorization: `Bearer ${TOKEN}` })
  })

  it('answers null for an empty reply', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteMessage(TOKEN, MSG)).resolves.toBeNull()
  })

  it('uploadPicture POSTs the file as the one part of a form, and leaves its type to the browser (it carries the boundary)', async () => {
    fetchMock.mockResolvedValue(json({ id: '7' }, 201))
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'invented.png', { type: 'image/png' })
    await expect(uploadPicture(TOKEN, file)).resolves.toEqual({ id: '7' })
    const [url, init] = sent()
    expect(url).toBe(`${API_BASE}/librarius/uploads`)
    expect(init.method).toBe('POST')
    expect(init.cache).toBe('no-store')
    expect(headersOf(init)).toEqual({ Authorization: `Bearer ${TOKEN}` })
    expect(init.body).toBeInstanceOf(FormData)
    const parts = [...init.body.values()]
    expect(parts).toHaveLength(1)
    expect(parts[0]).toBeInstanceOf(Blob)
    expect(parts[0].size).toBe(4)
  })

  it('sends no Authorization header without a token: the server answers that with 401', async () => {
    fetchMock.mockResolvedValue(json({ pending: { key: MSG, state: 'sending' } }, 202))
    await deleteMessage(null, MSG)
    expect(headersOf(sent()[1])).toEqual({})
  })

  it.each([
    ['editMessage', (id) => editMessage(TOKEN, id, { source: 'Hi' })],
    ['deleteMessage', (id) => deleteMessage(TOKEN, id)],
  ])('%s refuses a message id that is no id, and sends nothing: a dot or two cannot climb out of the path', async (_name, call) => {
    for (const id of [...NOT_IDS(), '.', '..', '../uploads', '200000000000000402/../../me']) {
      await expect(call(id), String(id)).rejects.toThrow(new TypeError('The message id must be an id: a string of 17 to 20 digits.'))
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  describe('a refusal', () => {
    const refuse = (body, status) => fetchMock.mockImplementation(async () => json(body, status))

    it("carries an AutoMod refusal's rule and match, with the status and the server's words (422)", async () => {
      refuse({ error: 'Blocked by the server\'s AutoMod rule "Invented rule".', rule: 'Invented rule', match: { start: 2, end: 7 } }, 422)
      const err = await postReply(TOKEN, POST, { source: 'a zorp b' }).catch((e) => e)
      expect(err).toBeInstanceOf(BuildsApiError)
      expect(err).toMatchObject({ status: 422, message: 'Blocked by the server\'s AutoMod rule "Invented rule".', rule: 'Invented rule', match: { start: 2, end: 7 } })
    })

    it('carries a match of null as the server said it, when the words are not in the source', async () => {
      refuse({ error: 'Blocked.', rule: 'Invented rule', match: null }, 422)
      const err = await editMessage(TOKEN, MSG, { source: 'x' }).catch((e) => e)
      expect(err).toMatchObject({ status: 422, rule: 'Invented rule', match: null })
    })

    it.each([
      [429, 'Slow down a little: try again in 20 seconds.'],
      [403, "You can't reply in this post."],
      [409, 'This message is already being changed. Try again in a moment.'],
    ])('carries the status and the server\'s words (%i), and no rule or match it was not given', async (status, error) => {
      refuse({ error }, status)
      for (const call of [() => postReply(TOKEN, POST, { source: 'x' }), () => editMessage(TOKEN, MSG, { source: 'x' }), () => deleteMessage(TOKEN, MSG)]) {
        const err = await call().catch((e) => e)
        expect(err).toBeInstanceOf(BuildsApiError)
        expect(err.status).toBe(status)
        expect(err.message).toBe(error)
        expect('rule' in err).toBe(false)
        expect('match' in err).toBe(false)
      }
    })

    it('names the status when the words are missing, empty or no text, and takes nothing from a body that is no object', async () => {
      for (const body of [{}, { error: '' }, { error: 42 }, { error: { text: 'x' } }, [{ error: 'x', rule: 'r' }], 'Blocked', null, 7]) {
        fetchMock.mockClear()
        refuse(body, 400)
        const err = await postReply(TOKEN, POST, { source: 'x' }).catch((e) => e)
        expect(err.message, JSON.stringify(body)).toBe('Request failed (400)')
        expect(err.status).toBe(400)
        expect('rule' in err).toBe(false)
      }
    })

    it('names the status when the body is no JSON', async () => {
      fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }))
      await expect(uploadPicture(TOKEN, new Blob(['x']))).rejects.toMatchObject({ message: 'Request failed (502)', status: 502 })
    })

    it('carries any refusal body\'s words, rule and match through, whatever they are (property)', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1 }), fc.string(), fc.record({ start: fc.integer(), end: fc.integer() }), fc.integer({ min: 400, max: 599 }), async (error, rule, match, status) => {
          refuse({ error, rule, match }, status)
          const err = await postReply(TOKEN, POST, { source: 'x' }).catch((e) => e)
          expect(err).toMatchObject({ status, message: error, rule, match })
        }),
      )
    })
  })
})

describe('searchMembers', () => {
  const MEMBERS = [{ id: '200000000000000403', name: 'Invented Member', avatar: null }]

  it('asks for the members by name, never from the cache, and answers the list', async () => {
    fetchMock.mockResolvedValue(json({ members: MEMBERS }))
    await expect(searchMembers(TOKEN, 'Inv')).resolves.toEqual(MEMBERS)
    const [url, init] = sent()
    expect(url).toBe(`${API_BASE}/librarius/members?q=Inv`)
    expect(init.cache).toBe('no-store')
    expect(headersOf(init).Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('answers no one for an answer of any other shape', async () => {
    for (const body of [{}, { members: null }, { members: 'x' }, { members: { 0: MEMBERS[0] } }, []]) {
      fetchMock.mockResolvedValueOnce(json(body))
      await expect(searchMembers(TOKEN, 'Inv'), JSON.stringify(body)).resolves.toEqual([])
    }
  })

  it('refuses a search that is no text, and sends nothing', async () => {
    for (const q of [undefined, null, 7, ['Inv'], { toString: () => 'Inv' }]) {
      await expect(searchMembers(TOKEN, q)).rejects.toThrow(new TypeError('The search must be text.'))
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails with a URIError for a lone surrogate, and sends nothing', async () => {
    await expect(searchMembers(TOKEN, '\ud800')).rejects.toBeInstanceOf(URIError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('puts any text in the query as one value, whatever it holds (property)', async () => {
    fetchMock.mockImplementation(async () => json({ members: [] }))
    await fc.assert(
      fc.asyncProperty(fc.string(), async (q) => {
        fetchMock.mockClear()
        await searchMembers(TOKEN, q)
        const url = new URL(fetchMock.mock.calls[0][0])
        expect(url.pathname).toBe('/librarius/members')
        expect(url.searchParams.getAll('q')).toEqual([q])
        expect([...url.searchParams.keys()]).toEqual(['q'])
      }),
    )
  })
})
