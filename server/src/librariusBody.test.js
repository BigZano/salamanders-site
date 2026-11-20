import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { FORM_SLACK, MAX_PICTURE_BYTES, pictureOf, readBounded, readJsonWithin, receivePicture } from './librariusBody.js'

const URL_ = 'https://api.test/librarius/x'

/** A request whose body is the stream of `chunks`, pulled one at a time; `seen` says how many were pulled, and whether it was cancelled. */
function streamed(chunks, headers = {}) {
  const seen = { pulled: 0, cancelled: false }
  let i = 0
  const body = new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return controller.close()
      seen.pulled++
      controller.enqueue(chunks[i++])
    },
    cancel() {
      seen.cancelled = true
    },
  }, { highWaterMark: 0 })
  const request = new Request(URL_, { method: 'POST', body, headers, duplex: 'half' })
  return { request, seen }
}

const json = (text, extra = {}) => new Request(URL_, { method: 'POST', body: text, headers: { 'Content-Type': 'application/json', ...extra } })

/** A multipart request made of `parts`: [{ name, bytes | text, filename?, type? }]. */
function multipart(parts) {
  const form = new FormData()
  for (const p of parts) {
    if (p.text !== undefined) form.append(p.name, p.text)
    else form.append(p.name, new Blob([p.bytes], { type: p.type ?? 'image/png' }), p.filename ?? 'x.png')
  }
  return new Request(URL_, { method: 'POST', body: form })
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

/** A picture as the write route reads one: what arrived, then the one file of that form. */
async function readPicture(request) {
  const came = await receivePicture(request)
  return came.error === undefined ? pictureOf(came.form) : came
}

/**
 * A request whose body sends `chunks` and then neither ends nor sends more: a picture still on its way. `seen` says how many were
 * pulled, and whether the stream was cancelled.
 */
function stalled(chunks, headers = {}) {
  const seen = { pulled: 0, cancelled: false }
  let i = 0
  const body = new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return new Promise(() => {})
      seen.pulled++
      controller.enqueue(chunks[i++])
    },
    cancel() {
      seen.cancelled = true
    },
  }, { highWaterMark: 0 })
  return { request: new Request(URL_, { method: 'POST', body, headers, duplex: 'half' }), seen }
}

const turns = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('the numbers', () => {
  it('are 10 MiB for a picture, with 64 KB over it for the form around it', () => {
    expect(MAX_PICTURE_BYTES).toBe(10 * 1024 * 1024)
    expect(FORM_SLACK).toBe(65_536)
  })
})

describe('readBounded', () => {
  it('reads a body to the end and answers its bytes', async () => {
    const got = await readBounded(streamed([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])]).request, 100)
    expect(got).toStrictEqual({ bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) })
  })

  it('answers no bytes for a request with no body', async () => {
    expect(await readBounded(new Request(URL_, { method: 'POST' }), 10)).toStrictEqual({ bytes: new Uint8Array(0) })
  })

  it('takes exactly the limit and refuses one byte more', async () => {
    const at = await readBounded(streamed([new Uint8Array(10)]).request, 10)
    expect(at.bytes).toHaveLength(10)
    expect(await readBounded(streamed([new Uint8Array(11)]).request, 10)).toStrictEqual({ tooLarge: true })
    expect(await readBounded(streamed([new Uint8Array(5), new Uint8Array(6)]).request, 10)).toStrictEqual({ tooLarge: true })
  })

  it('stops pulling and cancels the stream as soon as the count is over the limit', async () => {
    const chunks = Array.from({ length: 1000 }, () => new Uint8Array(1_000))
    const { request, seen } = streamed(chunks)
    expect(await readBounded(request, 3_500)).toStrictEqual({ tooLarge: true })
    // 4 chunks pass the limit; the stream may have been asked for a few more ahead of the reader, never for all.
    expect(seen.pulled).toBeLessThan(20)
    expect(seen.cancelled).toBe(true)
  })

  it('refuses from the Content-Length alone, without reading', async () => {
    const { request, seen } = streamed([new Uint8Array(5)], { 'Content-Length': '11' })
    expect(await readBounded(request, 10)).toStrictEqual({ tooLarge: true })
    expect(seen.pulled).toBe(0)
  })

  it('does not trust a Content-Length that is smaller than the body: the count is what counts', async () => {
    const { request } = streamed([new Uint8Array(50)], { 'Content-Length': '5' })
    expect(await readBounded(request, 10)).toStrictEqual({ tooLarge: true })
  })

  it('takes a Content-Length that is no number, or negative, as no word about the size, and still counts', async () => {
    for (const length of ['abc', '-5', '', ' ']) {
      const { request } = streamed([new Uint8Array(4)], { 'Content-Length': length })
      expect((await readBounded(request, 10)).bytes, length).toHaveLength(4)
    }
  })

  it('takes a Content-Length at the limit', async () => {
    const { request } = streamed([new Uint8Array(10)], { 'Content-Length': '10' })
    expect((await readBounded(request, 10)).bytes).toHaveLength(10)
  })

  it('reads whatever the chunking, to the same bytes (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 20 }), async (bytes, sizes) => {
        const chunks = []
        let at = 0
        for (let i = 0; at < bytes.length; i++) {
          const size = sizes[i % sizes.length]
          chunks.push(bytes.slice(at, at + size))
          at += size
        }
        const got = await readBounded(streamed(chunks).request, 300)
        expect(got).toStrictEqual({ bytes: new Uint8Array(bytes) })
      }),
      { numRuns: 100 },
    )
  })

  it('refuses exactly when the body is over the limit, whatever the chunking (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 1, max: 60 }), fc.integer({ min: 1, max: 25 }), async (limit, total, size) => {
        const chunks = []
        for (let left = total; left > 0; left -= size) chunks.push(new Uint8Array(Math.min(size, left)))
        const got = await readBounded(streamed(chunks).request, limit)
        if (total > limit) expect(got).toStrictEqual({ tooLarge: true })
        else expect(got.bytes).toHaveLength(total)
      }),
      { numRuns: 150 },
    )
  })
})

describe('readBounded: a deadline', () => {
  it('ends a read that is still waiting when its signal is aborted: the stream is cancelled, and what came of it is dropped', async () => {
    const { request, seen } = stalled([new Uint8Array([1, 2, 3])])
    const control = new AbortController()
    const reading = readBounded(request, 100, { signal: control.signal })
    await turns()
    expect(seen.pulled).toBe(1)
    control.abort()
    expect(await reading).toStrictEqual({ late: true })
    expect(seen.cancelled).toBe(true)
  })

  it('ends a read whose signal is aborted already, before anything is pulled', async () => {
    const { request, seen } = stalled([new Uint8Array([1, 2, 3])])
    expect(await readBounded(request, 100, { signal: AbortSignal.abort() })).toStrictEqual({ late: true })
    expect(seen.pulled).toBe(0)
    expect(seen.cancelled).toBe(true)
  })

  it('answers the bytes of a body that ends before its signal is aborted, and an abort after that changes nothing', async () => {
    const { request } = streamed([new Uint8Array([1, 2]), new Uint8Array([3])])
    const control = new AbortController()
    const got = await readBounded(request, 100, { signal: control.signal })
    control.abort()
    await turns()
    expect(got).toStrictEqual({ bytes: new Uint8Array([1, 2, 3]) })
  })

  it('refuses a Content-Length over the limit as too large, aborted or not, without reading', async () => {
    const { request, seen } = stalled([new Uint8Array(5)], { 'Content-Length': '101' })
    expect(await readBounded(request, 100, { signal: AbortSignal.abort() })).toStrictEqual({ tooLarge: true })
    expect(seen.pulled).toBe(0)
  })

  it('answers no bytes for a request with no body, whatever its signal', async () => {
    expect(await readBounded(new Request(URL_), 100, { signal: AbortSignal.abort() })).toStrictEqual({ bytes: new Uint8Array(0) })
  })

  // A cancel that fails and is left unhandled is an error of the whole run (Vitest fails it), as it would be the end of the server.
  it('answers late when the stream fails to cancel, and leaves that failure handled', async () => {
    const body = new ReadableStream({ pull: () => new Promise(() => {}), cancel() { throw new Error('the socket is gone') } }, { highWaterMark: 0 })
    const control = new AbortController()
    const reading = readBounded(new Request(URL_, { method: 'POST', body, duplex: 'half' }), 100, { signal: control.signal })
    await turns()
    control.abort()
    expect(await reading).toStrictEqual({ late: true })
    await turns()
  })

  it('lets a stream that breaks throw as it did, signal or not', async () => {
    const broken = new Request(URL_, { method: 'POST', body: new ReadableStream({ start: (c) => c.error(new Error('the connection dropped')) }), duplex: 'half' })
    await expect(readBounded(broken, 100, { signal: new AbortController().signal })).rejects.toThrow('the connection dropped')
  })
})

describe('receivePicture', () => {
  const TYPE = 'multipart/form-data; boundary=xyz'

  it('answers the bytes that came and the type they came as, not read as a form yet', async () => {
    const { request } = streamed([new TextEncoder().encode('not a form, '), new TextEncoder().encode('yet')], { 'Content-Type': TYPE })
    expect(await receivePicture(request)).toStrictEqual({ form: { bytes: new TextEncoder().encode('not a form, yet'), type: TYPE } })
  })

  it('refuses a type that is not multipart with 415, and leaves the body unread', async () => {
    const { request, seen } = streamed([PNG], { 'Content-Type': 'image/png' })
    expect(await receivePicture(request, { signal: new AbortController().signal })).toStrictEqual({ status: 415, error: 'Send the picture as multipart/form-data.' })
    expect(seen.pulled).toBe(0)
  })

  it('is 400 "That picture took too long to arrive." when its signal is aborted before all of it has come, and cancels the stream', async () => {
    // Not 408: a browser may send a request again on its own after a 408 on a connection it reuses, and this one is too slow, not idle.
    const { request, seen } = stalled([new Uint8Array(1000)], { 'Content-Type': TYPE })
    const control = new AbortController()
    const receiving = receivePicture(request, { signal: control.signal })
    await turns()
    control.abort()
    expect(await receiving).toStrictEqual({ status: 400, error: 'That picture took too long to arrive.' })
    expect(seen.cancelled).toBe(true)
  })

  it('is 400 for a signal aborted before anything was read, and never answers 408', async () => {
    const { request } = stalled([new Uint8Array(10)], { 'Content-Type': TYPE })
    const got = await receivePicture(request, { signal: AbortSignal.abort() })
    expect(got).toStrictEqual({ status: 400, error: 'That picture took too long to arrive.' })
  })

  it('is 413 for a body past the limit and the form around it, before it is late', async () => {
    const { request, seen } = stalled([new Uint8Array(MAX_PICTURE_BYTES), new Uint8Array(FORM_SLACK + 1)], { 'Content-Type': TYPE })
    expect(await receivePicture(request, { signal: new AbortController().signal })).toStrictEqual({ status: 413, error: 'That picture is over 10 MB.' })
    expect(seen.cancelled).toBe(true)
  })

  it('takes a body of exactly the limit and the form around it', async () => {
    const { request } = streamed([new Uint8Array(MAX_PICTURE_BYTES), new Uint8Array(FORM_SLACK)], { 'Content-Type': TYPE })
    expect((await receivePicture(request)).form.bytes).toHaveLength(MAX_PICTURE_BYTES + FORM_SLACK)
  })
})

describe('readJsonWithin', () => {
  const LIMITS = { maxBytes: 64, tooLarge: 'Too big.' }

  it('answers the JSON of a request', async () => {
    expect(await readJsonWithin(json('{"a":1}'), LIMITS)).toStrictEqual({ body: { a: 1 }, blank: false })
  })

  it('refuses any other type with 415, and leaves the body unread', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', '', 'application/jsonp', 'application/json-seq']) {
      const { request, seen } = streamed([new Uint8Array(3)], type === '' ? {} : { 'Content-Type': type })
      expect(await readJsonWithin(request, LIMITS), type).toStrictEqual({ status: 415, error: 'Send JSON (Content-Type: application/json).' })
      expect(seen.pulled, type).toBe(0)
    }
  })

  it('takes the type in any case and with parameters', async () => {
    for (const type of ['application/json; charset=utf-8', 'Application/JSON', ' application/json ']) {
      expect(await readJsonWithin(json('[1]', { 'Content-Type': type }), LIMITS), type).toStrictEqual({ body: [1], blank: false })
    }
  })

  it('refuses a body over the limit with 413 and the words it was given, counting bytes and not characters', async () => {
    const text = JSON.stringify('é'.repeat(30)) // 62 bytes with the quotes... plus: 30 two-byte letters
    expect(new TextEncoder().encode(text).length).toBe(62)
    expect((await readJsonWithin(json(text), LIMITS)).body).toBe('é'.repeat(30))
    const more = JSON.stringify('é'.repeat(32))
    expect(new TextEncoder().encode(more).length).toBe(66)
    expect(await readJsonWithin(json(more), LIMITS)).toStrictEqual({ status: 413, error: 'Too big.' })
  })

  it('takes a body of exactly the limit, and refuses one byte more', async () => {
    const text = `["${'a'.repeat(60)}"]`
    expect(text.length).toBe(64)
    expect((await readJsonWithin(json(text), LIMITS)).body).toEqual(['a'.repeat(60)])
    expect((await readJsonWithin(json(`["${'a'.repeat(61)}"]`), LIMITS)).status).toBe(413)
  })

  it('stops reading a body that never ends, at the limit', async () => {
    const { request, seen } = streamed(
      Array.from({ length: 500 }, () => new TextEncoder().encode('        ')),
      { 'Content-Type': 'application/json' },
    )
    expect(await readJsonWithin(request, LIMITS)).toStrictEqual({ status: 413, error: 'Too big.' })
    expect(seen.pulled).toBeLessThan(30)
  })

  it('answers no body for text that is not JSON, and says whether there was none at all', async () => {
    expect(await readJsonWithin(json('{nope'), LIMITS)).toStrictEqual({ body: undefined, blank: false })
    expect(await readJsonWithin(json(''), LIMITS)).toStrictEqual({ body: undefined, blank: true })
    expect(await readJsonWithin(json(' \n\t '), LIMITS)).toStrictEqual({ body: undefined, blank: true })
    expect(await readJsonWithin(new Request(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json' } }), LIMITS)).toStrictEqual({ body: undefined, blank: true })
  })

  it('reads text that is not valid UTF-8 as the replacement character, and never throws', async () => {
    const request = new Request(URL_, { method: 'POST', body: new Uint8Array([0x5b, 0x22, 0xff, 0x22, 0x5d]), headers: { 'Content-Type': 'application/json' } })
    expect(await readJsonWithin(request, LIMITS)).toStrictEqual({ body: ['�'], blank: false })
  })

  it('takes the JSON of any value for what it is: the caller checks the shape', async () => {
    for (const text of ['null', '7', '"x"', 'true', '[]', '{"__proto__":{"x":1}}']) {
      const got = await readJsonWithin(json(text), LIMITS)
      expect(got.blank).toBe(false)
      expect(got.body).toStrictEqual(JSON.parse(text))
    }
  })
})

describe('receivePicture, then pictureOf: the one file of the form', () => {
  it('answers the bytes of the one file of a multipart form', async () => {
    expect(await readPicture(multipart([{ name: 'file', bytes: PNG }]))).toStrictEqual({ bytes: PNG })
  })

  it('takes the file under any field name, and says nothing of its name or type', async () => {
    for (const name of ['file', 'picture', 'x', 'a b', '']) {
      const got = await readPicture(multipart([{ name, bytes: PNG, filename: '../../evil.exe', type: 'text/html' }]))
      expect(got, name).toStrictEqual({ bytes: PNG })
    }
  })

  it('refuses a type that is not multipart with 415, and leaves the body unread', async () => {
    for (const type of ['application/json', 'image/png', 'text/plain', '']) {
      const { request, seen } = streamed([PNG], type === '' ? {} : { 'Content-Type': type })
      expect(await readPicture(request), type).toStrictEqual({ status: 415, error: 'Send the picture as multipart/form-data.' })
      expect(seen.pulled, type).toBe(0)
    }
  })

  it('takes the type in any case', async () => {
    const original = multipart([{ name: 'file', bytes: PNG }])
    const type = original.headers.get('Content-Type').replace('multipart/form-data', 'Multipart/Form-DATA')
    expect(type).toContain('Multipart/Form-DATA')
    const again = new Request(URL_, { method: 'POST', body: await original.arrayBuffer(), headers: { 'Content-Type': type } })
    expect(await readPicture(again)).toStrictEqual({ bytes: PNG })
  })

  it('refuses exactly one file part, or 400: none, two, a text field, a text field and a file', async () => {
    const copy = { status: 400, error: 'Send one picture at a time.' }
    expect(await readPicture(multipart([]))).toStrictEqual(copy)
    expect(await readPicture(multipart([{ name: 'a', bytes: PNG }, { name: 'b', bytes: PNG }]))).toStrictEqual(copy)
    expect(await readPicture(multipart([{ name: 'a', bytes: PNG }, { name: 'a', bytes: PNG }]))).toStrictEqual(copy)
    expect(await readPicture(multipart([{ name: 'a', text: 'hello' }]))).toStrictEqual(copy)
    expect(await readPicture(multipart([{ name: 'note', text: 'hello' }, { name: 'a', bytes: PNG }]))).toStrictEqual(copy)
    expect(await readPicture(multipart([{ name: 'a', bytes: PNG }, { name: 'note', text: 'hello' }]))).toStrictEqual(copy)
  })

  it('refuses an empty file with 400', async () => {
    expect(await readPicture(multipart([{ name: 'file', bytes: new Uint8Array(0) }]))).toStrictEqual({ status: 400, error: 'That file is empty.' })
  })

  it('takes a file of exactly the limit and refuses one byte more with 413', async () => {
    const big = new Uint8Array(MAX_PICTURE_BYTES)
    big.set(PNG)
    const at = await readPicture(multipart([{ name: 'file', bytes: big }]))
    expect(at.bytes).toHaveLength(MAX_PICTURE_BYTES)
    const over = await readPicture(multipart([{ name: 'file', bytes: new Uint8Array(MAX_PICTURE_BYTES + 1) }]))
    expect(over).toStrictEqual({ status: 413, error: 'That picture is over 10 MB.' })
  })

  it('refuses a body past the limit and the form around it with 413, without reading it all', async () => {
    const chunks = Array.from({ length: 200 }, () => new Uint8Array(1_000_000))
    const { request, seen } = streamed(chunks, { 'Content-Type': 'multipart/form-data; boundary=xyz' })
    expect(await readPicture(request)).toStrictEqual({ status: 413, error: 'That picture is over 10 MB.' })
    expect(seen.pulled).toBeLessThan(30)
    expect(seen.cancelled).toBe(true)
  })

  it('refuses from a Content-Length past the limit and the form around it, without reading', async () => {
    const { request, seen } = streamed([PNG], { 'Content-Type': 'multipart/form-data; boundary=xyz', 'Content-Length': String(MAX_PICTURE_BYTES + FORM_SLACK + 1) })
    expect(await readPicture(request)).toStrictEqual({ status: 413, error: 'That picture is over 10 MB.' })
    expect(seen.pulled).toBe(0)
  })

  it('takes a body of exactly the limit and the form around it as far as the size goes', async () => {
    const body = new Uint8Array(MAX_PICTURE_BYTES + FORM_SLACK)
    const { request } = streamed([body], { 'Content-Type': 'multipart/form-data; boundary=xyz' })
    // Not a form, so the form is what is refused, not the size.
    expect(await readPicture(request)).toStrictEqual({ status: 400, error: 'That form could not be read.' })
  })

  it('refuses what is not a readable form with 400, whatever it is', async () => {
    const unreadable = { status: 400, error: 'That form could not be read.' }
    const types = ['multipart/form-data', 'multipart/form-data; boundary=', 'multipart/form-data; boundary=xyz']
    const bodies = [new Uint8Array(0), new TextEncoder().encode('--xyz\r\nContent-Disposition: form-data; name="a"\r\n\r\nno end'), new TextEncoder().encode('garbage'), new Uint8Array([0, 255, 13, 10, 13, 10])]
    for (const type of types) {
      for (const body of bodies) {
        const got = await readPicture(new Request(URL_, { method: 'POST', body, headers: { 'Content-Type': type } }))
        expect(got, `${type} ${body.length}`).toStrictEqual(unreadable)
      }
    }
  })

  it('never throws, whatever bytes come as the form (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 400 }), async (bytes) => {
        const got = await readPicture(new Request(URL_, { method: 'POST', body: bytes, headers: { 'Content-Type': 'multipart/form-data; boundary=xyz' } }))
        expect(got.bytes !== undefined || [400, 413, 415].includes(got.status)).toBe(true)
      }),
      { numRuns: 100 },
    )
  })
})
