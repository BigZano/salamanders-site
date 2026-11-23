// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('../lib/librarius/api')
import { getMe, getPost, listPosts, listMessages, getChanges, getPending, postReply, editMessage, deleteMessage, uploadPicture, markRead } from '../lib/librarius/api'
import { PENDING_MS, POLL_MS, useLibrarius } from './librarius'
import { useAuth } from './auth'

// Replying, editing, deleting and sending pictures from the post page, the queue of what is on its way (the pending poll), and the
// batch-1 items folded in here: a 401 in the middle of reading, a start-over that keeps coming, and the post's own facts read again.

const apiError = (status, message = 'nope', extra = {}) => Object.assign(new Error(message), { status }, extra)
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

// Every id here is invented: 18 digits, from the range the Librarius fixtures use.
const mid = (n) => String(200000000000000000n + BigInt(n))
const POST = mid(400)
const OTHER = mid(401)
const SELF = mid(402)
const FRIEND = mid(403)
const MSG = mid(450)
const msg = (n, extra = {}) => ({ id: mid(n), authorId: SELF, authorName: 'Invented Author', content: `Message ${n}`, ...extra })
const info = (extra = {}) => ({ id: POST, ownerId: SELF, title: 'Invented post', tagIds: [], pinned: false, locked: false, archived: false, createdAt: '2026-11-01T00:00:00.000Z', replies: 3, ...extra })
const found = (extra = {}) => ({ post: info(), lastRead: null, rev: '40', ...extra })
const pageOf = (ns, extra = {}) => ({ messages: ns.map((n) => msg(n)), hasOlder: false, hasNewer: false, people: {}, rev: '40', ...extra })
const changesOf = (extra = {}) => ({ messages: [], deleted: [], rev: '60', people: {}, ...extra })
const queued = (key) => ({ pending: { key, state: 'sending' } })
/** An entry of the server's /pending answer. */
const entry = (key, extra = {}) => ({ key, kind: 'send', state: 'sending', error: null, source: 'Invented reply', createdAt: '2026-11-18T10:00:00.000Z', ...extra })
const listed = (...entries) => ({ pending: entries })
const picture = (name = 'invented.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })
const SIGNED_IN = 'salamanders-discord-member'

let s
beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  s = useLibrarius()
})
afterEach(() => {
  s.reset()
  vi.useRealTimers()
})

/** An open post, set straight into the store. */
const seed = (id = POST, { messages = [msg(410), msg(411)], rev = '40' } = {}) => {
  s.$patch((state) => {
    state.status = 'allowed'
    state.post = { id, info: info({ id }), opening: null, earliest: null, messages, hasOlder: false, hasNewer: false, rev, lastRead: null }
  })
}
/** The body of the nth request of a mocked write: its last argument. */
const bodyOf = (mock, n = 0) => mock.mock.calls[n].at(-1)
const states = () => s.outbox.map((e) => [e.kind, e.key, e.state])

describe('librarius store: replying', () => {
  it('starts with nothing on its way', () => {
    expect(s.outbox).toEqual([])
  })

  it('queues a reply to the open post with the people it mentions, and holds it as sending', async () => {
    seed()
    postReply.mockResolvedValue(queued('k-1'))
    const source = `Hello <@${FRIEND}> and <@!${SELF}>, and <@${FRIEND}> again`
    const answer = await s.reply('tok', { source, replyTo: MSG, pingReply: true })
    expect(postReply).toHaveBeenCalledWith('tok', POST, { source, replyTo: MSG, pingReply: true, mentions: [FRIEND, SELF], uploads: [] })
    const sending = { key: 'k-1', kind: 'send', state: 'sending', error: null, source, createdAt: null }
    expect(answer).toEqual(sending)
    expect(s.outbox).toEqual([sending])
  })

  it('replies to the post itself, and pings nobody, unless it is told otherwise in so many words', async () => {
    seed()
    postReply.mockResolvedValue(queued('k-1'))
    await s.reply('tok', { source: 'Plain' })
    await s.reply('tok', { source: 'Plain', replyTo: null, pingReply: 'yes' })
    expect(bodyOf(postReply, 0)).toEqual({ source: 'Plain', replyTo: null, pingReply: false, mentions: [], uploads: [] })
    expect(bodyOf(postReply, 1)).toEqual({ source: 'Plain', replyTo: null, pingReply: false, mentions: [], uploads: [] })
  })

  it('forwards the people the composer picked, as it gives them, and no one else the text mentions', async () => {
    seed()
    postReply.mockResolvedValue(queued('k-1'))
    const picked = [FRIEND, 'not checked here: the server takes only members who may read']
    await s.reply('tok', { source: `Hi <@${FRIEND}> and <@${SELF}>`, mentions: picked })
    expect(bodyOf(postReply).mentions).toEqual(picked)
    expect(bodyOf(postReply).mentions).not.toBe(picked)
    await s.reply('tok', { source: `Hi <@${FRIEND}>`, mentions: [] })
    expect(bodyOf(postReply, 1).mentions).toEqual([])
  })

  it('refuses picked people that are not a list of ids as text, before anything is sent', async () => {
    seed()
    for (const mentions of [null, FRIEND, [Number(FRIEND)], [FRIEND, null], { 0: FRIEND }]) {
      await expect(s.reply('tok', { source: 'x', mentions }), JSON.stringify(mentions)).rejects.toThrow(new TypeError('mentions is a list of the ids picked, as text.'))
      await expect(s.edit('tok', MSG, { source: 'x', mentions })).rejects.toThrow(new TypeError('mentions is a list of the ids picked, as text.'))
    }
    expect(postReply).not.toHaveBeenCalled()
    expect(editMessage).not.toHaveBeenCalled()
  })

  it('names, when the composer picks no one, everyone the text mentions, once each, in the order they are first mentioned (property)', async () => {
    seed()
    postReply.mockResolvedValue(queued('k-1'))
    const person = fc.integer({ min: 0, max: 5 }).map((n) => mid(470 + n))
    const piece = fc.oneof(fc.string({ maxLength: 6 }).filter((t) => !t.includes('<')), person.map((id) => `<@${id}>`), person.map((id) => `<@!${id}>`))
    await fc.assert(
      fc.asyncProperty(fc.array(piece, { maxLength: 12 }), async (pieces) => {
        postReply.mockClear()
        const source = pieces.join(' ')
        await s.reply('tok', { source: `x${source}` })
        const expected = [...new Set(pieces.filter((p) => p.startsWith('<@')).map((p) => p.replace(/\D/g, '')))]
        expect(bodyOf(postReply).mentions).toEqual(expected)
      }),
      { numRuns: 100 },
    )
  })

  it.each([
    [422, 'Blocked by the server\'s AutoMod rule "Invented rule".', { rule: 'Invented rule', match: { start: 2, end: 6 } }],
    [429, 'Slow down a little: try again in 20 seconds.', {}],
    [403, "You can't reply in this post.", {}],
    [403, 'This post is locked.', {}],
    [400, 'Pick people to mention from the list (10 at most).', {}],
  ])("rejects a refusal (%i) with the server's words, and its rule and match, and holds nothing", async (status, words, extra) => {
    seed()
    const refusal = apiError(status, words, extra)
    postReply.mockRejectedValue(refusal)
    const err = await s.reply('tok', { source: 'a zorp' }).catch((e) => e)
    expect(err).toBe(refusal)
    expect(err).toMatchObject({ status, message: words, ...extra })
    expect(s.outbox).toEqual([])
    expect(s.error).toBe('')
    expect(s.status).toBe('allowed')
  })

  it('rejects a network failure as it is, and holds nothing', async () => {
    seed()
    const down = new TypeError('Failed to fetch')
    postReply.mockRejectedValue(down)
    await expect(s.reply('tok', { source: 'x' })).rejects.toBe(down)
    expect(s.outbox).toEqual([])
  })

  it('a 401 on a write leaves the page and the sign-in as they are: the composer keeps the text and says why', async () => {
    seed()
    localStorage.setItem(SIGNED_IN, JSON.stringify({ id: SELF, username: 'invented', accessToken: 'tok', expiresAt: Date.now() + 60_000 }))
    const auth = useAuth()
    postReply.mockRejectedValue(apiError(401, 'Sign in with Discord.'))
    await expect(s.reply('tok', { source: 'x' })).rejects.toMatchObject({ status: 401 })
    expect(s.post.id).toBe(POST)
    expect(auth.signedIn).toBe(true)
  })

  it('refuses what is no reply before anything is sent', async () => {
    seed()
    for (const bad of [undefined, null, 7, ['x'], { source: 7 }, { source: null }, { source: 'x', replyTo: 'abc' }, { source: 'x', replyTo: Number(MSG) }, { source: 'x', replyTo: `${MSG}/../x` }]) {
      await expect(s.reply('tok', bad), JSON.stringify(bad)).rejects.toBeInstanceOf(TypeError)
    }
    expect(postReply).not.toHaveBeenCalled()
  })

  it('refuses to reply with no post open', async () => {
    await expect(s.reply('tok', { source: 'x' })).rejects.toThrow(new TypeError('There is no post open to write in.'))
    expect(postReply).not.toHaveBeenCalled()
  })

  it('does not hold a reply that was queued after the reader left the post, or signed out, but still says it is on its way', async () => {
    for (const leave of [() => seed(OTHER), () => s.reset()]) {
      seed()
      const slow = deferred()
      postReply.mockReturnValue(slow.promise)
      const p = s.reply('tok', { source: 'x' })
      await tick()
      leave()
      slow.resolve(queued('k-late'))
      await expect(p).resolves.toMatchObject({ key: 'k-late', state: 'sending' })
      expect(s.outbox).toEqual([])
    }
  })

  it('takes nothing from an answer that is not what the route sends', async () => {
    seed()
    for (const answer of [null, {}, { pending: null }, { pending: { key: 7 } }, { pending: { key: '' } }]) {
      postReply.mockResolvedValue(answer)
      await expect(s.reply('tok', { source: 'x' }), JSON.stringify(answer)).rejects.toThrow("The server's answer was not one the site knows.")
    }
    expect(s.outbox).toEqual([])
  })
})

describe('librarius store: pictures', () => {
  /** Sends pictures to places, the server holding each under the id `7<place>`. */
  const at = async (...places) => {
    for (const n of places) {
      uploadPicture.mockResolvedValueOnce({ id: `7${n}` })
      await s.upload('tok', picture(), n)
    }
  }

  it('holds a picture at the place the composer gives it, and names it by its file', async () => {
    seed()
    uploadPicture.mockResolvedValueOnce({ id: '71' }).mockResolvedValueOnce({ id: '72' })
    await expect(s.upload('tok', picture('A sunset.png'), 1)).resolves.toEqual({ n: 1, name: 'A sunset' })
    await expect(s.upload('tok', picture('two.dots.jpeg'), 2)).resolves.toEqual({ n: 2, name: 'two.dots' })
    expect(uploadPicture).toHaveBeenCalledWith('tok', expect.any(File))
  })

  it('names a picture with no name of its own "picture"', async () => {
    seed()
    uploadPicture.mockResolvedValue({ id: '71' })
    for (const file of [new Blob(['x']), picture(''), picture('.png'), picture('   .gif'), picture('noext')]) {
      expect((await s.upload('tok', file, 1)).name).toBe(file.name === 'noext' ? 'noext' : 'picture')
    }
  })

  it('sends the pictures a reply shows by their place, upload:N being the Nth, up to the last one shown', async () => {
    seed()
    await at(1, 2, 3)
    postReply.mockResolvedValue(queued('k-1'))
    await s.reply('tok', { source: 'one ![a](upload:1) and two ![b](upload:2)' })
    expect(bodyOf(postReply).uploads).toEqual(['71', '72'])
  })

  it('sends every place up to the last one shown, so that the list is as long as the highest place', async () => {
    seed()
    await at(1, 2, 3)
    postReply.mockResolvedValue(queued('k-1'))
    await s.reply('tok', { source: '![c](upload:3)' })
    expect(bodyOf(postReply).uploads).toEqual(['71', '72', '73'])
  })

  it('puts a new picture in a place that was freed, in place of the one before', async () => {
    seed()
    await at(1, 2, 3)
    await at(2)
    postReply.mockResolvedValue(queued('k-1'))
    await s.reply('tok', { source: '![a](upload:1)![b](upload:2)![c](upload:3)' })
    expect(bodyOf(postReply).uploads).toEqual(['71', '72', '73'])
    uploadPicture.mockResolvedValueOnce({ id: '90' })
    await s.upload('tok', picture(), 1)
    uploadPicture.mockResolvedValueOnce({ id: '91' })
    await s.upload('tok', picture(), 1)
    await s.reply('tok', { source: '![a](upload:1)' })
    expect(bodyOf(postReply, 1).uploads).toEqual(['91'])
  })

  it('stops the list at a place it never held, and the server refuses the pictures past it', async () => {
    seed()
    await at(1, 3)
    postReply.mockResolvedValue(queued('k-1'))
    await s.reply('tok', { source: '![a](upload:1)![c](upload:3)' })
    expect(bodyOf(postReply).uploads).toEqual(['71'])
  })

  it('sends none for a reply that shows none, and keeps them for the reply that will', async () => {
    seed()
    await at(1)
    postReply.mockResolvedValue(queued('k-1'))
    await s.reply('tok', { source: 'no picture here, not even upload:1 or ![x](upload:11)' })
    expect(bodyOf(postReply, 0).uploads).toEqual([])
    await s.reply('tok', { source: '![a](upload:1)' })
    expect(bodyOf(postReply, 1).uploads).toEqual(['71'])
  })

  it('empties the places once a reply with pictures is queued, and not when it is refused', async () => {
    seed()
    await at(1)
    postReply.mockRejectedValueOnce(apiError(422, 'Blocked.')).mockResolvedValue(queued('k-1'))
    await expect(s.reply('tok', { source: '![a](upload:1)' })).rejects.toMatchObject({ status: 422 })
    await s.reply('tok', { source: '![a](upload:1)' })
    expect(bodyOf(postReply, 1).uploads).toEqual(['71'])
    await s.reply('tok', { source: '![a](upload:1)' })
    expect(bodyOf(postReply, 2).uploads).toEqual([])
  })

  it("keeps each post's pictures to it", async () => {
    seed(POST)
    await at(1)
    seed(OTHER)
    postReply.mockResolvedValue(queued('k-1'))
    await s.reply('tok', { source: '![a](upload:1)' })
    expect(bodyOf(postReply).uploads).toEqual([])
    seed(POST)
    await s.reply('tok', { source: '![a](upload:1)' })
    expect(bodyOf(postReply, 1).uploads).toEqual(['71'])
  })

  it('holds what the composer asks, whatever places it gives in whatever order, and sends the run from 1 that has no gap (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 10 }), { maxLength: 15 }), fc.integer({ min: 0, max: 10 }), async (places, shown) => {
        setActivePinia(createPinia())
        vi.resetAllMocks()
        s = useLibrarius()
        seed()
        const held = new Map()
        let serial = 0
        uploadPicture.mockImplementation(async () => ({ id: String(100 + ++serial) }))
        for (const n of places) {
          await expect(s.upload('tok', picture(), n)).resolves.toEqual({ n, name: 'invented' })
          held.set(n, String(100 + serial))
        }
        postReply.mockResolvedValue(queued('k-1'))
        await s.reply('tok', { source: shown === 0 ? 'none' : `![x](upload:${shown})` })
        const expected = []
        for (let i = 1; i <= shown && held.has(i); i++) expected.push(held.get(i))
        expect(bodyOf(postReply).uploads).toEqual(expected)
        s.reset()
      }),
      { numRuns: 100 },
    )
  })

  it.each([
    [413, 'That picture is too large (10 MB at most).'],
    [415, 'Send the picture as a form.'],
    [429, 'One picture at a time, please.'],
    [503, 'Too many pictures are being sent just now. Try again.'],
    [400, 'That picture took too long to arrive.'],
    [400, "That file isn't a picture we can take (PNG, JPEG, WebP or GIF)."],
    [401, 'Sign in with Discord.'],
  ])("answers a refusal (%i) with its status and the server's words, holds nothing at the place, and tries nothing again", async (status, error) => {
    seed()
    await at(1)
    uploadPicture.mockRejectedValueOnce(apiError(status, error))
    await expect(s.upload('tok', picture(), 1)).resolves.toEqual({ status, error })
    expect(uploadPicture).toHaveBeenCalledTimes(2)
    postReply.mockResolvedValue(queued('k-1'))
    await s.reply('tok', { source: '![a](upload:1)' })
    expect(bodyOf(postReply).uploads).toEqual(['71'])
  })

  it('answers a network failure, or an answer that is no picture id, with words of its own and status 0', async () => {
    seed()
    const failed = { status: 0, error: "Couldn't send the picture. Try again." }
    uploadPicture.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(s.upload('tok', picture(), 1)).resolves.toEqual(failed)
    for (const answer of [null, {}, { id: 71 }, { id: '' }, { id: '7a' }, { id: '../7' }, { id: '1'.repeat(20) }]) {
      uploadPicture.mockResolvedValueOnce(answer)
      await expect(s.upload('tok', picture(), 1), JSON.stringify(answer)).resolves.toEqual(failed)
    }
    postReply.mockResolvedValue(queued('k-1'))
    await s.reply('tok', { source: '![a](upload:1)' })
    expect(bodyOf(postReply).uploads).toEqual([])
  })

  it('refuses what is no file, or no place, before anything is sent', async () => {
    seed()
    for (const bad of [undefined, null, 'picture.png', { name: 'x.png', size: 3 }, new Uint8Array(4)]) {
      await expect(s.upload('tok', bad, 1)).rejects.toThrow(new TypeError('upload takes a picture: a File or a Blob.'))
    }
    for (const n of [undefined, null, '1', 1.5, NaN, Infinity]) {
      await expect(s.upload('tok', picture(), n), String(n)).rejects.toThrow(new TypeError('upload takes the place of the picture, a whole number.'))
    }
    for (const n of [0, -1, 11, 2 ** 53]) {
      await expect(s.upload('tok', picture(), n), String(n)).rejects.toThrow(new RangeError('A picture goes in place 1 to 10.'))
    }
    expect(uploadPicture).not.toHaveBeenCalled()
  })

  it('says there is no post open, and sends nothing, with none open', async () => {
    await expect(s.upload('tok', picture(), 1)).resolves.toEqual({ status: 0, error: 'There is no post open to write in.' })
    expect(uploadPicture).not.toHaveBeenCalled()
  })

  it('keeps the places through a new load(), as the drafts that use them are kept', async () => {
    seed()
    await at(1)
    getMe.mockReturnValue(new Promise(() => {}))
    s.load('tok')
    await at(2)
    postReply.mockResolvedValue(queued('k-1'))
    await s.reply('tok', { source: '![a](upload:1)![b](upload:2)' })
    expect(bodyOf(postReply).uploads).toEqual(['71', '72'])
  })

  it('holds nothing for a picture that arrives after a sign-out', async () => {
    seed()
    const slow = deferred()
    uploadPicture.mockReturnValueOnce(slow.promise)
    const p = s.upload('tok', picture(), 1)
    await tick()
    s.reset()
    slow.resolve({ id: '71' })
    await expect(p).resolves.toEqual({ status: 0, error: "Couldn't send the picture. Try again." })
    seed()
    postReply.mockResolvedValue(queued('k-1'))
    await s.reply('tok', { source: '![a](upload:1)' })
    expect(bodyOf(postReply).uploads).toEqual([])
  })
})

// A post can have a draft for each message replied to, and the composer gives each picture a place that its own draft does not use: the
// places are each draft's, so that a picture added to one draft never goes with another.
describe('librarius store: the pictures of each draft', () => {
  const OTHER_MSG = mid(451)
  const hold = async (n, id, replyTo) => {
    uploadPicture.mockResolvedValueOnce({ id })
    return s.upload('tok', picture(), n, replyTo)
  }

  it('holds the pictures of a reply to a message apart from those of a reply to the post, and of a reply to another message', async () => {
    seed()
    await hold(1, '7001', MSG)
    await hold(1, '7002', null)
    await hold(1, '7003', OTHER_MSG)
    expect([s.holdsPicture(1, MSG), s.holdsPicture(1), s.holdsPicture(1, OTHER_MSG), s.holdsPicture(2, MSG)]).toEqual([true, true, true, false])
    postReply.mockResolvedValue(queued('k-1'))
    await s.reply('tok', { source: 'To the post ![a](upload:1)' })
    expect(bodyOf(postReply, 0).uploads).toEqual(['7002'])
    // A reply takes its own draft's pictures, and leaves the others'.
    expect([s.holdsPicture(1, MSG), s.holdsPicture(1), s.holdsPicture(1, OTHER_MSG)]).toEqual([true, false, true])
    await s.reply('tok', { source: 'To the message ![b](upload:1)', replyTo: MSG })
    expect(bodyOf(postReply, 1).uploads).toEqual(['7001'])
    expect([s.holdsPicture(1, MSG), s.holdsPicture(1, OTHER_MSG)]).toEqual([false, true])
  })

  it('moves the pictures of a draft with it to the message it now replies to, in place of any held there', async () => {
    seed()
    await hold(1, '7001', MSG)
    await hold(2, '7002', MSG)
    await hold(1, '7009', OTHER_MSG)
    s.movePictures(MSG, OTHER_MSG)
    expect([s.holdsPicture(2, OTHER_MSG), s.holdsPicture(1, MSG)]).toEqual([true, false])
    s.movePictures(OTHER_MSG, null)
    postReply.mockResolvedValue(queued('k-1'))
    await s.reply('tok', { source: '![a](upload:1) ![b](upload:2)' })
    expect(bodyOf(postReply).uploads).toEqual(['7001', '7002'])
    // Moving what holds none leaves what is there, and nothing moves with no post open.
    await hold(1, '7010', MSG)
    s.movePictures(OTHER_MSG, MSG)
    expect(s.holdsPicture(1, MSG)).toBe(true)
    s.reset()
    expect(() => s.movePictures(MSG, null)).not.toThrow()
  })

  it('refuses a message replied to that is no message id', async () => {
    seed()
    for (const bad of ['', '12', 5, {}, `${MSG} `]) {
      await expect(s.upload('tok', picture(), 1, bad), String(bad)).rejects.toThrow(new TypeError('replyTo is the id of a message, or null.'))
      expect(() => s.holdsPicture(1, bad), String(bad)).toThrow(new TypeError('replyTo is the id of a message, or null.'))
      expect(() => s.movePictures(bad, null), String(bad)).toThrow(new TypeError('replyTo is the id of a message, or null.'))
      expect(() => s.movePictures(null, bad), String(bad)).toThrow(new TypeError('replyTo is the id of a message, or null.'))
    }
    expect(uploadPicture).not.toHaveBeenCalled()
  })
})

describe('librarius store: whether a picture a draft shows will go with it', () => {
  const at = async (...places) => {
    for (const n of places) {
      uploadPicture.mockResolvedValueOnce({ id: `7${n}` })
      await s.upload('tok', picture(), n)
    }
  }

  it('holds none with no post open, and none in a post before a picture is sent', () => {
    expect(s.holdsPicture(1)).toBe(false)
    seed()
    for (let n = 1; n <= 10; n++) expect(s.holdsPicture(n)).toBe(false)
  })

  it('holds the places sent, and only those', async () => {
    seed()
    await at(1, 2)
    expect([1, 2, 3, 10].map((n) => s.holdsPicture(n))).toEqual([true, true, false, false])
  })

  it('does not hold a place past one never held, which a reply would not carry', async () => {
    seed()
    await at(1, 3)
    expect([1, 2, 3].map((n) => s.holdsPicture(n))).toEqual([true, false, false])
    await at(2)
    expect([1, 2, 3].map((n) => s.holdsPicture(n))).toEqual([true, true, true])
  })

  it('does not hold a place whose picture was refused', async () => {
    seed()
    uploadPicture.mockRejectedValueOnce(apiError(413, 'Too large.'))
    await s.upload('tok', picture(), 1)
    expect(s.holdsPicture(1)).toBe(false)
  })

  it('holds none once a reply took them, and keeps them when the reply was refused', async () => {
    seed()
    await at(1)
    postReply.mockRejectedValueOnce(apiError(422, 'Blocked.')).mockResolvedValue(queued('k-1'))
    await expect(s.reply('tok', { source: '![a](upload:1)' })).rejects.toMatchObject({ status: 422 })
    expect(s.holdsPicture(1)).toBe(true)
    await s.reply('tok', { source: '![a](upload:1)' })
    expect(s.holdsPicture(1)).toBe(false)
  })

  it("holds each post's pictures for it alone", async () => {
    seed(POST)
    await at(1)
    seed(OTHER)
    expect(s.holdsPicture(1)).toBe(false)
    seed(POST)
    expect(s.holdsPicture(1)).toBe(true)
    // A post that is gone (deleted in Discord) is no post open: no picture of it is sent.
    s.$patch((state) => {
      state.post = null
    })
    expect(s.holdsPicture(1)).toBe(false)
  })

  it('holds them through a new load(), and none after a reset()', async () => {
    seed()
    await at(1)
    getMe.mockReturnValue(new Promise(() => {}))
    s.load('tok')
    expect(s.holdsPicture(1)).toBe(true)
    s.reset()
    seed()
    expect(s.holdsPicture(1)).toBe(false)
  })

  it('refuses what is no place', () => {
    seed()
    for (const n of [undefined, null, '1', 1.5, NaN]) expect(() => s.holdsPicture(n), String(n)).toThrow(TypeError)
    for (const n of [0, -1, 11]) expect(() => s.holdsPicture(n), String(n)).toThrow(RangeError)
  })

  it('holds a place exactly when a reply that shows it would carry it (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 10 }), { maxLength: 12 }), fc.integer({ min: 1, max: 10 }), async (places, shown) => {
        setActivePinia(createPinia())
        vi.resetAllMocks()
        s = useLibrarius()
        seed()
        uploadPicture.mockImplementation(async () => ({ id: '71' }))
        for (const n of places) await s.upload('tok', picture(), n)
        const held = s.holdsPicture(shown)
        postReply.mockResolvedValue(queued('k-1'))
        await s.reply('tok', { source: `![x](upload:${shown})` })
        expect(held).toBe(bodyOf(postReply).uploads.length === shown)
        s.reset()
      }),
      { numRuns: 100 },
    )
  })
})

describe('librarius store: editing and deleting', () => {
  it('queues an edit of a message with the people it mentions, and holds it as sending', async () => {
    seed()
    editMessage.mockResolvedValue(queued(MSG))
    const source = `Changed, <@${FRIEND}>`
    const answer = await s.edit('tok', MSG, { source })
    expect(editMessage).toHaveBeenCalledWith('tok', MSG, { source, mentions: [FRIEND] })
    expect(answer).toEqual({ key: MSG, kind: 'edit', state: 'sending', error: null, source, createdAt: null })
    expect(states()).toEqual([['edit', MSG, 'sending']])
  })

  it('forwards the people the composer picked for an edit', async () => {
    seed()
    editMessage.mockResolvedValue(queued(MSG))
    await s.edit('tok', MSG, { source: `Changed, <@${FRIEND}>`, mentions: [] })
    expect(editMessage).toHaveBeenCalledWith('tok', MSG, { source: `Changed, <@${FRIEND}>`, mentions: [] })
  })

  it('queues a delete of a message, and holds it as sending', async () => {
    seed()
    deleteMessage.mockResolvedValue(queued(MSG))
    await expect(s.remove('tok', MSG)).resolves.toEqual({ key: MSG, kind: 'delete', state: 'sending', error: null, source: null, createdAt: null })
    expect(deleteMessage).toHaveBeenCalledWith('tok', MSG)
    expect(states()).toEqual([['delete', MSG, 'sending']])
  })

  it.each([
    ['edit', () => s.edit('tok', MSG, { source: 'x' }), editMessage],
    ['remove', () => s.remove('tok', MSG), deleteMessage],
  ])("%s: rejects a refusal with the server's words, rule and match, and holds nothing", async (_name, call, mock) => {
    seed()
    for (const refusal of [
      apiError(422, 'Blocked by the server\'s AutoMod rule "Invented rule".', { rule: 'Invented rule', match: { start: 0, end: 1 } }),
      apiError(429, 'Slow down a little: try again in 3 seconds.'),
      apiError(403, 'Only the author can edit this reply.'),
      apiError(409, 'This message is already being changed. Try again in a moment.'),
    ]) {
      mock.mockRejectedValueOnce(refusal)
      await expect(call()).rejects.toBe(refusal)
    }
    expect(s.outbox).toEqual([])
  })

  it('refuses what is no edit before anything is sent', async () => {
    seed()
    for (const bad of [undefined, null, {}, { source: 3 }]) await expect(s.edit('tok', MSG, bad)).rejects.toBeInstanceOf(TypeError)
    for (const id of [undefined, 'abc', Number(MSG), `${MSG}/..`]) {
      await expect(s.edit('tok', id, { source: 'x' })).rejects.toBeInstanceOf(TypeError)
      await expect(s.remove('tok', id)).rejects.toBeInstanceOf(TypeError)
    }
    expect(editMessage).not.toHaveBeenCalled()
    expect(deleteMessage).not.toHaveBeenCalled()
  })

  it('refuses to edit or delete with no post open', async () => {
    await expect(s.edit('tok', MSG, { source: 'x' })).rejects.toBeInstanceOf(TypeError)
    await expect(s.remove('tok', MSG)).rejects.toBeInstanceOf(TypeError)
    expect(editMessage).not.toHaveBeenCalled()
    expect(deleteMessage).not.toHaveBeenCalled()
  })

  it('a new edit of a message takes the place of its last one, and a delete puts its edit away', async () => {
    seed()
    vi.useFakeTimers()
    getPending.mockResolvedValue(listed(entry(MSG, { kind: 'edit', state: 'blocked', error: 'Blocked by the server\'s rules.', source: null })))
    await s.pending('tok')
    expect(states()).toEqual([['edit', MSG, 'blocked']])
    editMessage.mockResolvedValue(queued(MSG))
    await s.edit('tok', MSG, { source: 'again' })
    expect(states()).toEqual([['edit', MSG, 'sending']])
    deleteMessage.mockResolvedValue(queued(MSG))
    await s.remove('tok', MSG)
    expect(states()).toEqual([['delete', MSG, 'sending']])
  })
})

describe('librarius store: the pending poll', () => {
  beforeEach(() => vi.useFakeTimers())

  const replied = async (key = 'k-1') => {
    postReply.mockResolvedValueOnce(queued(key))
    await s.reply('tok', { source: 'Invented reply' })
  }

  it('asks every 3 seconds while a reply is sending, and never sooner', async () => {
    expect(PENDING_MS).toBe(3_000)
    seed()
    getPending.mockResolvedValue(listed(entry('k-1')))
    await replied()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(getPending).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(getPending).toHaveBeenCalledTimes(1)
    expect(getPending).toHaveBeenCalledWith('tok', POST)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(getPending).toHaveBeenCalledTimes(2)
  })

  it('marks a reply sent once the server no longer lists it, and then stops asking', async () => {
    seed()
    getPending.mockResolvedValueOnce(listed(entry('k-1'))).mockResolvedValue(listed())
    await replied()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(states()).toEqual([['send', 'k-1', 'sending']])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(states()).toEqual([['send', 'k-1', 'sent']])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getPending).toHaveBeenCalledTimes(2)
  })

  it("shows a blocked or failed one with the server's words, and stops asking when nothing is sending", async () => {
    seed()
    getPending.mockResolvedValue(
      listed(
        entry('k-1', { state: 'blocked', error: "Blocked by the server's rules." }),
        entry('k-2', { state: 'failed', error: "Couldn't send. Try again." }),
      ),
    )
    await replied('k-1')
    await replied('k-2')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(s.outbox).toEqual([
      { key: 'k-1', kind: 'send', state: 'blocked', error: "Blocked by the server's rules.", source: 'Invented reply', createdAt: '2026-11-18T10:00:00.000Z' },
      { key: 'k-2', kind: 'send', state: 'failed', error: "Couldn't send. Try again.", source: 'Invented reply', createdAt: '2026-11-18T10:00:00.000Z' },
    ])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getPending).toHaveBeenCalledTimes(1)
  })

  it('pending() asks at once, learns what was on its way from before (a page loaded again), and follows it', async () => {
    seed()
    getPending.mockResolvedValueOnce(listed(entry('k-old', { source: 'From before' }), entry(MSG, { kind: 'delete', source: null }))).mockResolvedValue(listed())
    await s.pending('tok')
    expect(getPending).toHaveBeenCalledTimes(1)
    expect(states()).toEqual([
      ['send', 'k-old', 'sending'],
      ['delete', MSG, 'sending'],
    ])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(states()).toEqual([
      ['send', 'k-old', 'sent'],
      ['delete', MSG, 'sent'],
    ])
  })

  it('pending() with nothing on its way asks once, and no more', async () => {
    seed()
    getPending.mockResolvedValue(listed())
    await s.pending('tok')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getPending).toHaveBeenCalledTimes(1)
  })

  it('pending() with no post open asks nothing', async () => {
    await expect(s.pending('tok')).resolves.toBeUndefined()
    expect(getPending).not.toHaveBeenCalled()
  })

  it('never asks twice at once: a pending() while one is on its way is that one', async () => {
    seed()
    const slow = deferred()
    getPending.mockReturnValue(slow.promise)
    const a = s.pending('tok')
    const b = s.pending('tok')
    await replied()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getPending).toHaveBeenCalledTimes(1)
    slow.resolve(listed(entry('k-1')))
    await Promise.all([a, b])
    await vi.advanceTimersByTimeAsync(2_999)
    expect(getPending).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(getPending).toHaveBeenCalledTimes(2)
  })

  it('does not call a reply sent from an answer that was asked for before the reply was queued', async () => {
    seed()
    const slow = deferred()
    getPending.mockReturnValueOnce(slow.promise).mockResolvedValue(listed(entry('k-1')))
    const p = s.pending('tok')
    await replied()
    slow.resolve(listed())
    await p
    expect(states()).toEqual([['send', 'k-1', 'sending']])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(getPending).toHaveBeenCalledTimes(2)
    expect(states()).toEqual([['send', 'k-1', 'sending']])
  })

  it('keeps asking through a failure while something is sending, and a pending() that fails says why', async () => {
    seed()
    await replied()
    getPending.mockRejectedValueOnce(apiError(503, 'down')).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(listed())
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(states()).toEqual([['send', 'k-1', 'sending']])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(states()).toEqual([['send', 'k-1', 'sent']])
    getPending.mockRejectedValueOnce(apiError(500, 'broken'))
    await expect(s.pending('tok')).rejects.toMatchObject({ status: 500 })
    expect(s.status).toBe('allowed')
  })

  it('stops asking for a post that is gone (404), and leaves telling the page so to the poll', async () => {
    seed()
    await replied()
    getPending.mockRejectedValue(apiError(404, 'No such post.'))
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getPending).toHaveBeenCalledTimes(1)
    expect(s.post.id).toBe(POST)
    expect(states()).toEqual([['send', 'k-1', 'sending']])
  })

  it('stops when the reader opens another post, and lands nothing from the one before in it', async () => {
    seed()
    await replied()
    const slow = deferred()
    getPending.mockReturnValueOnce(slow.promise)
    await vi.advanceTimersByTimeAsync(3_000)
    getPost.mockResolvedValue(found({ post: info({ id: OTHER }) }))
    listMessages.mockResolvedValue(pageOf([420]))
    await s.openPost('tok', OTHER)
    slow.resolve(listed(entry('k-1', { state: 'failed', error: 'x' })))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(s.outbox).toEqual([])
    expect(getPending).toHaveBeenCalledTimes(1)
  })

  it('keeps what is on its way when the same post is opened again', async () => {
    seed()
    await replied()
    getPost.mockResolvedValue(found())
    listMessages.mockResolvedValue(pageOf([410, 411]))
    await s.openPost('tok', POST)
    expect(states()).toEqual([['send', 'k-1', 'sending']])
    getPending.mockResolvedValue(listed(entry('k-1')))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(getPending).toHaveBeenCalledTimes(1)
  })

  it('stops on a new load(), and follows again once the post is opened again', async () => {
    seed()
    await replied()
    getMe.mockReturnValue(new Promise(() => {}))
    s.load('tok-2')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getPending).not.toHaveBeenCalled()
    expect(states()).toEqual([['send', 'k-1', 'sending']])
    getPost.mockResolvedValue(found())
    listMessages.mockResolvedValue(pageOf([410, 411]))
    getPending.mockResolvedValue(listed())
    await s.openPost('tok-2', POST)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(getPending).toHaveBeenCalledWith('tok-2', POST)
    expect(states()).toEqual([['send', 'k-1', 'sent']])
  })

  it('stops on a sign-out, and lands nothing', async () => {
    seed()
    await replied()
    const slow = deferred()
    getPending.mockReturnValueOnce(slow.promise)
    await vi.advanceTimersByTimeAsync(3_000)
    s.reset()
    slow.resolve(listed(entry('k-1', { state: 'failed', error: 'x' })))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(s.outbox).toEqual([])
    expect(getPending).toHaveBeenCalledTimes(1)
  })

  it('judges nothing from an answer that is not what the route sends, and keeps asking', async () => {
    seed()
    await replied()
    for (const answer of [null, {}, { pending: 'x' }, { pending: {} }]) getPending.mockResolvedValueOnce(answer)
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(3_000)
    expect(states()).toEqual([['send', 'k-1', 'sending']])
    expect(getPending).toHaveBeenCalledTimes(4)
  })

  it('leaves out entries that are not what the route sends, and keeps the rest', async () => {
    seed()
    const good = entry('k-good', { state: 'failed', error: 'x' })
    getPending.mockResolvedValue(
      listed(
        null,
        7,
        entry(''),
        entry(5),
        entry('k-a', { kind: 'post' }),
        entry('k-b', { state: 'sent' }),
        entry('k-c', { state: 'pending' }),
        entry('k-d', { error: 5 }),
        entry('k-e', { source: 5 }),
        entry('k-f', { createdAt: 'yesterday' }),
        entry('k-g', { createdAt: null }),
        entry('k-h', { source: null }),
        entry(MSG, { kind: 'edit', source: 7 }),
        good,
      ),
    )
    await s.pending('tok')
    expect(s.outbox).toEqual([good])
  })

  it('takes an edit or a delete with its text or without', async () => {
    seed()
    const edit = entry(MSG, { kind: 'edit', source: 'New text' })
    const del = entry(MSG, { kind: 'delete', source: null })
    getPending.mockResolvedValue(listed(edit, del))
    await s.pending('tok')
    expect(s.outbox).toEqual([edit, del])
  })

  it('drops a blocked or failed one the server no longer lists (it is over a day old)', async () => {
    seed()
    getPending.mockResolvedValueOnce(listed(entry('k-1', { state: 'failed', error: 'x' }))).mockResolvedValueOnce(listed())
    await s.pending('tok')
    expect(states()).toEqual([['send', 'k-1', 'failed']])
    await s.pending('tok')
    expect(s.outbox).toEqual([])
  })

  it('shows the newest of a message\'s edits, and never one older once the newest is done', async () => {
    seed()
    const older = entry(MSG, { kind: 'edit', state: 'failed', error: 'x', source: null, createdAt: '2026-11-18T09:00:00.000Z' })
    const newer = entry(MSG, { kind: 'edit', state: 'sending', source: null, createdAt: '2026-11-18T09:30:00.000Z' })
    getPending.mockResolvedValueOnce(listed(older, newer)).mockResolvedValue(listed(older))
    await s.pending('tok')
    expect(s.outbox).toEqual([newer])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(states()).toEqual([['edit', MSG, 'sent']])
    await s.pending('tok')
    expect(states()).toEqual([['edit', MSG, 'sent']])
  })

  it('takes the newest of a message\'s edits whatever order the server lists them in', async () => {
    seed()
    const older = entry(MSG, { kind: 'edit', state: 'failed', error: 'x', source: null, createdAt: '2026-11-18T09:00:00.000Z' })
    const newer = entry(MSG, { kind: 'edit', state: 'blocked', error: 'y', source: null, createdAt: '2026-11-18T09:30:00.000Z' })
    getPending.mockResolvedValue(listed(newer, older))
    await s.pending('tok')
    expect(s.outbox).toEqual([newer])
  })

  it('lets a sent one go once a poll for changes that began after it was sent lands, with the message in it', async () => {
    seed()
    await replied()
    getPending.mockResolvedValue(listed())
    const early = deferred()
    getChanges.mockReturnValueOnce(early.promise)
    const before = s.poll('tok') // began before the reply was seen sent
    await vi.advanceTimersByTimeAsync(3_000)
    expect(states()).toEqual([['send', 'k-1', 'sent']])
    early.resolve(changesOf({ rev: '50' }))
    await before
    expect(states()).toEqual([['send', 'k-1', 'sent']])
    getChanges.mockResolvedValue(changesOf({ rev: '61', messages: [msg(412)] }))
    await s.poll('tok')
    expect(s.outbox).toEqual([])
  })

  it('lets a sent one go when the post is opened again after it was sent, and keeps those still on their way', async () => {
    seed()
    await replied('k-1')
    getPending.mockResolvedValueOnce(listed())
    await vi.advanceTimersByTimeAsync(3_000)
    await replied('k-2')
    getPost.mockResolvedValue(found())
    listMessages.mockResolvedValue(pageOf([410, 411, 412]))
    await s.openPost('tok', POST)
    expect(states()).toEqual([['send', 'k-2', 'sending']])
  })

  it('never has two asks on their way, and stops once nothing is sending, whatever happens in between (property)', async () => {
    const step = fc.oneof(
      fc.constant({ do: 'reply' }),
      fc.constant({ do: 'pending' }),
      fc.integer({ min: 1, max: 7_000 }).map((ms) => ({ do: 'wait', ms })),
      fc.constant({ do: 'answer', done: true }),
      fc.constant({ do: 'answer', done: false }),
      fc.constant({ do: 'fail' }),
    )
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 25 }), async (steps) => {
        setActivePinia(createPinia())
        vi.resetAllMocks()
        s = useLibrarius()
        seed()
        let open = 0
        let most = 0
        const waiting = []
        getPending.mockImplementation(() => {
          open++
          most = Math.max(most, open)
          const d = deferred()
          waiting.push(d)
          return d.promise.finally(() => open--)
        })
        let keys = 0
        postReply.mockImplementation(async () => queued(`k-${++keys}`))
        for (const st of steps) {
          if (st.do === 'reply') await s.reply('tok', { source: 'x' })
          else if (st.do === 'pending') s.pending('tok').catch(() => {})
          else if (st.do === 'wait') await vi.advanceTimersByTimeAsync(st.ms)
          else if (waiting.length > 0) {
            const d = waiting.shift()
            if (st.do === 'fail') d.reject(apiError(503, 'down'))
            else d.resolve(listed(...(st.done ? [] : s.outbox.filter((e) => e.state === 'sending').map((e) => entry(e.key)))))
            await vi.advanceTimersByTimeAsync(0)
          }
        }
        expect(most).toBeLessThanOrEqual(1)
        // Answer whatever is still asked, with everything done: then nothing is sending, and the asking stops.
        getPending.mockImplementation(async () => listed())
        for (const d of waiting.splice(0)) d.resolve(listed())
        await vi.advanceTimersByTimeAsync(3_000)
        await vi.advanceTimersByTimeAsync(3_000)
        expect(s.outbox.some((e) => e.state === 'sending')).toBe(false)
        const asked = getPending.mock.calls.length
        await vi.advanceTimersByTimeAsync(60_000)
        expect(getPending.mock.calls.length).toBe(asked)
        s.reset()
      }),
      { numRuns: 60 },
    )
  })
})

describe('librarius store: trying again, and putting away', () => {
  beforeEach(() => vi.useFakeTimers())

  const failedReply = async () => {
    postReply.mockResolvedValueOnce(queued('k-1'))
    await s.reply('tok', { source: `Retry <@${FRIEND}>`, replyTo: MSG, pingReply: true })
    getPending.mockResolvedValueOnce(listed(entry('k-1', { state: 'failed', error: "Couldn't send. Try again.", source: `Retry <@${FRIEND}>` })))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(states()).toEqual([['send', 'k-1', 'failed']])
  }

  it('sends a failed reply again as it was sent, and the failed one goes for good', async () => {
    seed()
    await failedReply()
    postReply.mockResolvedValueOnce(queued('k-2'))
    await expect(s.retry('tok', { kind: 'send', key: 'k-1' })).resolves.toMatchObject({ key: 'k-2', state: 'sending' })
    expect(bodyOf(postReply, 1)).toEqual(bodyOf(postReply, 0))
    expect(states()).toEqual([['send', 'k-2', 'sending']])
    // The server keeps listing the failed one for a day: it stays put away.
    getPending.mockResolvedValue(listed(entry('k-1', { state: 'failed', error: 'x' }), entry('k-2')))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(states()).toEqual([['send', 'k-2', 'sending']])
  })

  it('sends a failed reply it learned of from the server with its text, and the people it mentions', async () => {
    seed()
    getPending.mockResolvedValue(listed(entry('k-old', { state: 'failed', error: 'x', source: `Old <@${FRIEND}>` })))
    await s.pending('tok')
    postReply.mockResolvedValue(queued('k-new'))
    await s.retry('tok', { kind: 'send', key: 'k-old' })
    expect(bodyOf(postReply)).toEqual({ source: `Old <@${FRIEND}>`, replyTo: null, pingReply: false, mentions: [FRIEND], uploads: [] })
  })

  it('keeps a failed one as it is when trying again is refused, and says why', async () => {
    seed()
    await failedReply()
    const refusal = apiError(429, 'Slow down a little: try again in 9 seconds.')
    postReply.mockRejectedValueOnce(refusal)
    await expect(s.retry('tok', { kind: 'send', key: 'k-1' })).rejects.toBe(refusal)
    expect(states()).toEqual([['send', 'k-1', 'failed']])
  })

  it('sends a failed edit again as it was sent, and a failed delete', async () => {
    seed()
    editMessage.mockResolvedValue(queued(MSG))
    await s.edit('tok', MSG, { source: `Edit <@${FRIEND}>` })
    const other = mid(451)
    deleteMessage.mockResolvedValue(queued(other))
    await s.remove('tok', other)
    getPending.mockResolvedValueOnce(
      listed(
        entry(MSG, { kind: 'edit', state: 'failed', error: 'x', source: null }),
        entry(other, { kind: 'delete', state: 'failed', error: 'x', source: null }),
      ),
    )
    await vi.advanceTimersByTimeAsync(3_000)
    await s.retry('tok', { kind: 'edit', key: MSG })
    await s.retry('tok', { kind: 'delete', key: other })
    expect(editMessage).toHaveBeenLastCalledWith('tok', MSG, { source: `Edit <@${FRIEND}>`, mentions: [FRIEND] })
    expect(deleteMessage).toHaveBeenLastCalledWith('tok', other)
    expect(states()).toEqual([
      ['edit', MSG, 'sending'],
      ['delete', other, 'sending'],
    ])
    getPending.mockResolvedValue(listed(entry(MSG, { kind: 'edit', state: 'failed', error: 'x', source: null })))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(states()).toEqual([
      ['edit', MSG, 'sent'],
      ['delete', other, 'sent'],
    ])
  })

  it('keeps the words of an edit it sent when the server lists the edit without them, blocked or failed, so that Edit opens them again', async () => {
    seed()
    editMessage.mockResolvedValue(queued(MSG))
    await s.edit('tok', MSG, { source: 'The blocked words' })
    getPending.mockResolvedValueOnce(listed(entry(MSG, { kind: 'edit', state: 'blocked', error: 'x', source: null })))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(s.outbox).toEqual([{ key: MSG, kind: 'edit', state: 'blocked', error: 'x', source: 'The blocked words', createdAt: '2026-11-18T10:00:00.000Z' }])
    // Words the server does list are its own, and one it never saw the words of has none.
    getPending.mockResolvedValueOnce(listed(entry(MSG, { kind: 'edit', state: 'blocked', error: 'x', source: 'Listed words' })))
    await s.pending('tok')
    expect(s.outbox[0].source).toBe('Listed words')
    s.reset()
    seed()
    getPending.mockResolvedValueOnce(listed(entry(MSG, { kind: 'edit', state: 'blocked', error: 'x', source: null })))
    await s.pending('tok')
    expect(s.outbox[0].source).toBeNull()
  })

  it('cannot send again an edit it never saw the text of, and says so', async () => {
    seed()
    getPending.mockResolvedValue(listed(entry(MSG, { kind: 'edit', state: 'failed', error: 'x', source: null })))
    await s.pending('tok')
    await expect(s.retry('tok', { kind: 'edit', key: MSG })).rejects.toThrow(new RangeError("This edit can't be sent again from here: edit the message again."))
    expect(editMessage).not.toHaveBeenCalled()
  })

  it('tries again only what failed', async () => {
    seed()
    getPending.mockResolvedValue(listed(entry('k-s'), entry('k-b', { state: 'blocked', error: 'x' })))
    await s.pending('tok')
    for (const which of [{ kind: 'send', key: 'k-s' }, { kind: 'send', key: 'k-b' }, { kind: 'send', key: 'k-none' }, { kind: 'edit', key: 'k-s' }, null, undefined]) {
      await expect(s.retry('tok', which), JSON.stringify(which)).rejects.toThrow(new RangeError('Only a message that failed to send can be tried again.'))
    }
    expect(postReply).not.toHaveBeenCalled()
  })

  it('puts away a blocked or failed one for good, and nothing that is still on its way', async () => {
    seed()
    const blocked = entry('k-b', { state: 'blocked', error: 'x' })
    const failed = entry('k-f', { state: 'failed', error: 'y' })
    getPending.mockResolvedValue(listed(entry('k-s'), blocked, failed))
    await s.pending('tok')
    s.dismiss({ kind: 'send', key: 'k-b' })
    s.dismiss({ kind: 'send', key: 'k-f' })
    s.dismiss({ kind: 'send', key: 'k-gone' })
    s.dismiss(null)
    expect(states()).toEqual([['send', 'k-s', 'sending']])
    expect(() => s.dismiss({ kind: 'send', key: 'k-s' })).toThrow(new RangeError('Only a message that ended without being sent can be put away.'))
    await s.pending('tok')
    expect(states()).toEqual([['send', 'k-s', 'sending']])
  })
})

// A double press of Retry, and a reload, a load() or another post after a Retry or a Dismiss, must not show the entry again with a
// Retry that sends it once more: the server lists a failed or blocked entry for a day, whatever came after it.
describe('librarius store: what was tried again or put away stays so', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-11-18T12:00:00.000Z'))
  })
  const AT = '2026-11-18T10:00:00.000Z'
  const asMember = (id = SELF) => useAuth().$patch({ member: { id, username: 'invented', isMember: true, librarius: true } })
  /** The page is loaded again: a new store, with nothing in memory, over the same browser. */
  const reload = () => {
    s.reset()
    setActivePinia(createPinia())
    s = useLibrarius()
    asMember()
    seed()
  }
  const failed = (key, extra = {}) => entry(key, { state: 'failed', error: 'Discord did not take this reply. Try again in a little while.', createdAt: AT, ...extra })
  const learnFailed = async (...entries) => {
    getPending.mockResolvedValue(listed(...entries))
    await s.pending('tok')
  }

  it('sends a failed reply once when Retry is pressed twice before the first answer, and both presses get its entry', async () => {
    asMember()
    seed()
    await learnFailed(failed('k-1'))
    const answer = deferred()
    postReply.mockReturnValueOnce(answer.promise)
    const first = s.retry('tok', { kind: 'send', key: 'k-1' })
    const second = s.retry('tok', { kind: 'send', key: 'k-1' })
    expect(postReply).toHaveBeenCalledTimes(1)
    answer.resolve(queued('k-2'))
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ key: 'k-2', state: 'sending' })
    expect(postReply).toHaveBeenCalledTimes(1)
    expect(states()).toEqual([['send', 'k-2', 'sending']])
  })

  it('lets a Retry that was refused be pressed again, and sends that one', async () => {
    asMember()
    seed()
    await learnFailed(failed('k-1'))
    postReply.mockRejectedValueOnce(apiError(429, 'Slow down.'))
    await expect(s.retry('tok', { kind: 'send', key: 'k-1' })).rejects.toMatchObject({ status: 429 })
    postReply.mockResolvedValueOnce(queued('k-2'))
    await expect(s.retry('tok', { kind: 'send', key: 'k-1' })).resolves.toMatchObject({ key: 'k-2' })
    expect(postReply).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a reload', () => reload()],
    ['a new load()', async () => {
      getMe.mockResolvedValue({ access: true, ready: true, tags: [], roles: [], guildId: mid(399), forumId: mid(398), can: {} })
      await s.load('tok')
      seed()
    }],
    ['another post and back', async () => {
      getPost.mockResolvedValue(found({ post: info({ id: OTHER }) }))
      listMessages.mockResolvedValue(pageOf([]))
      await s.openPost('tok', OTHER)
      seed()
    }],
  ])('shows neither a failed reply that was tried again nor one that was dismissed after %s', async (_, leave) => {
    asMember()
    seed()
    await learnFailed(failed('k-1'), failed('k-3', { kind: 'edit', key: MSG, source: null }), entry('k-4', { state: 'blocked', error: 'x', createdAt: AT }))
    postReply.mockResolvedValueOnce(queued('k-2'))
    await s.retry('tok', { kind: 'send', key: 'k-1' })
    s.dismiss({ kind: 'edit', key: MSG })
    s.dismiss({ kind: 'send', key: 'k-4' })
    await leave()
    // The server still lists the three that ended, and the retry has gone out (it is sent: no longer listed).
    await learnFailed(failed('k-1'), failed(MSG, { kind: 'edit', source: null }), entry('k-4', { state: 'blocked', error: 'x', createdAt: AT }))
    const ended = () => states().filter(([, , state]) => state !== 'sent')
    expect(ended()).toEqual([])
    // A newer failure of the same edit is news, and shows.
    await learnFailed(failed(MSG, { kind: 'edit', source: null, createdAt: '2026-11-18T11:00:00.000Z' }))
    expect(ended()).toEqual([['edit', MSG, 'failed']])
  })

  it('keeps a Retry put away when the post was left before the server answered it', async () => {
    asMember()
    seed()
    await learnFailed(failed('k-1'))
    const answer = deferred()
    postReply.mockReturnValueOnce(answer.promise)
    const retried = s.retry('tok', { kind: 'send', key: 'k-1' })
    getPost.mockResolvedValue(found({ post: info({ id: OTHER }) }))
    listMessages.mockResolvedValue(pageOf([]))
    await s.openPost('tok', OTHER)
    answer.resolve(queued('k-2'))
    await retried
    reload()
    await learnFailed(failed('k-1'))
    expect(states()).toEqual([])
  })

  it('keeps what one member put away for that member only, and nothing for a reader not signed in', async () => {
    asMember(SELF)
    seed()
    await learnFailed(failed('k-1'))
    s.dismiss({ kind: 'send', key: 'k-1' })
    reload()
    asMember(FRIEND)
    await learnFailed(failed('k-1'))
    expect(states()).toEqual([['send', 'k-1', 'failed']])
    useAuth().$patch({ member: null })
    s.dismiss({ kind: 'send', key: 'k-1' })
    expect(states()).toEqual([])
    expect(Object.keys(localStorage).filter((k) => k.startsWith('lb-done:'))).toEqual([`lb-done:${SELF}:${POST}`])
  })

  it('keeps going in memory when the browser keeps nothing, or keeps something that is not a list of times', async () => {
    asMember()
    seed()
    localStorage.setItem(`lb-done:${SELF}:${POST}`, '{not json')
    await learnFailed(failed('k-1'), failed('k-2'))
    expect(states()).toEqual([['send', 'k-1', 'failed'], ['send', 'k-2', 'failed']])
    localStorage.setItem(`lb-done:${SELF}:${POST}`, JSON.stringify({ 'send:k-1': 'soon', 'send:k-2': Date.parse(AT) }))
    await learnFailed(failed('k-1'), failed('k-2'))
    expect(states()).toEqual([['send', 'k-1', 'failed']])
    localStorage.setItem(`lb-done:${SELF}:${POST}`, '[1, 2]')
    await learnFailed(failed('k-1'))
    expect(states()).toEqual([['send', 'k-1', 'failed']])
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    s.dismiss({ kind: 'send', key: 'k-1' })
    expect(states()).toEqual([])
    await learnFailed(failed('k-1'))
    expect(states()).toEqual([])
    setItem.mockRestore()
  })

  it('forgets what it put away once it is two days old, which the server no longer lists', async () => {
    asMember()
    seed()
    await learnFailed(failed('k-old', { createdAt: '2026-11-16T11:00:00.000Z' }), failed('k-1'))
    s.dismiss({ kind: 'send', key: 'k-old' })
    s.dismiss({ kind: 'send', key: 'k-1' })
    expect(JSON.parse(localStorage.getItem(`lb-done:${SELF}:${POST}`))).toEqual({ 'send:k-1': Date.parse(AT) })
  })
})

describe('librarius store: a 401 in the middle of reading asks to sign in again', () => {
  const signIn = () => {
    localStorage.setItem(SIGNED_IN, JSON.stringify({ id: SELF, username: 'invented', accessToken: 'tok', expiresAt: Date.now() + 60_000 }))
    return useAuth()
  }
  const expired = () => apiError(401, 'Sign in with Discord.')

  it.each([
    ['a poll', () => getChanges.mockRejectedValue(expired()), () => s.poll('tok')],
    ['loading older messages', () => listMessages.mockRejectedValue(expired()), () => s.loadOlder('tok')],
    ['opening a post', () => getPost.mockRejectedValue(expired()), () => s.openPost('tok', POST)],
    ['the topic list', () => listPosts.mockRejectedValue(expired()), () => s.loadPosts('tok')],
    ['a read mark', () => markRead.mockRejectedValue(expired()), () => s.markRead('tok', mid(411))],
    ['the pending poll', () => getPending.mockRejectedValue(expired()), () => s.pending('tok')],
  ])('%s: signs the reader out as the server sees them, so that the page asks them to sign in, keeping their drafts and places', async (_name, arrange, act) => {
    const auth = signIn()
    expect(auth.signedIn).toBe(true)
    seed()
    s.$patch((state) => {
      state.post.hasOlder = true
    })
    arrange()
    localStorage.setItem(`lb-draft:${POST}:new`, 'A reply half written')
    sessionStorage.setItem(`lb-anchor:${POST}`, mid(410))
    await act().catch(() => {})
    expect(s.status).toBe('signin')
    expect(s.post).toBeNull()
    expect(auth.signedIn).toBe(false)
    expect(auth.token).toBeNull()
    expect(localStorage.getItem(SIGNED_IN)).toBeNull()
    expect(localStorage.getItem(`lb-draft:${POST}:new`)).toBe('A reply half written')
    expect(sessionStorage.getItem(`lb-anchor:${POST}`)).toBe(mid(410))
  })

  it('a 403 in the middle of reading takes the page away and leaves the sign-in alone', async () => {
    const auth = signIn()
    seed()
    getChanges.mockRejectedValue(apiError(403, 'Restricted.'))
    await s.poll('tok').catch(() => {})
    expect(s.status).toBe('denied')
    expect(auth.signedIn).toBe(true)
  })
})

describe('librarius store: the poll reads the post itself again every 6th time', () => {
  const T0 = Date.UTC(2026, 10, 18, 12, 0, 0)

  it('asks for the post on the 6th poll and the 12th, and takes its title, lock and count of replies', async () => {
    seed()
    getChanges.mockResolvedValue(changesOf())
    getPost.mockResolvedValue(found({ post: info({ title: 'Renamed', locked: true, replies: 9 }) }))
    for (let i = 1; i <= 5; i++) await s.poll('tok')
    expect(getPost).not.toHaveBeenCalled()
    expect(s.post.info.title).toBe('Invented post')
    await s.poll('tok')
    expect(getPost).toHaveBeenCalledTimes(1)
    expect(getPost).toHaveBeenCalledWith('tok', POST)
    expect(s.post.info).toEqual(info({ title: 'Renamed', locked: true, replies: 9 }))
    for (let i = 7; i <= 11; i++) await s.poll('tok')
    expect(getPost).toHaveBeenCalledTimes(1)
    await s.poll('tok')
    expect(getPost).toHaveBeenCalledTimes(2)
  })

  it('keeps the rev and the reader\'s mark the poll has, whatever the post\'s answer says', async () => {
    seed()
    getChanges.mockResolvedValue(changesOf({ rev: '70' }))
    getPost.mockResolvedValue(found({ rev: '1', lastRead: mid(999) }))
    for (let i = 1; i <= 6; i++) await s.poll('tok')
    expect(s.post.rev).toBe('70')
    expect(s.post.lastRead).toBeNull()
  })

  it('counts the polls of the post that is open: another post starts the count again', async () => {
    seed()
    getChanges.mockResolvedValue(changesOf())
    for (let i = 1; i <= 3; i++) await s.poll('tok')
    seed(OTHER)
    for (let i = 1; i <= 5; i++) await s.poll('tok')
    expect(getPost).not.toHaveBeenCalled()
    getPost.mockResolvedValue(found({ post: info({ id: OTHER }) }))
    await s.poll('tok')
    expect(getPost).toHaveBeenCalledWith('tok', OTHER)
  })

  it('does not count a poll that waited out a start-over and asked nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    seed()
    getChanges.mockResolvedValue({ reset: true })
    getPost.mockResolvedValue(found({ rev: '900' }))
    listMessages.mockResolvedValue(pageOf([410, 411], { rev: '900' }))
    await s.poll('tok') // opened again: the count starts over
    await s.poll('tok') // asked, and ignored: the wait is 20 s
    getPost.mockClear()
    getChanges.mockResolvedValue(changesOf({ rev: '901' }))
    for (let i = 0; i < 10; i++) await s.poll('tok') // all in the wait
    vi.setSystemTime(T0 + 20_000)
    for (let i = 1; i <= 4; i++) await s.poll('tok')
    expect(getPost).not.toHaveBeenCalled()
    await s.poll('tok')
    expect(getPost).toHaveBeenCalledTimes(1)
  })

  it('lets go of the post when the post is gone (404), as a poll does', async () => {
    seed()
    getChanges.mockResolvedValue(changesOf())
    getPost.mockRejectedValue(apiError(404, 'No such post.'))
    for (let i = 1; i <= 5; i++) await s.poll('tok')
    await expect(s.poll('tok')).resolves.toBe(true)
    expect(s.post).toBeNull()
  })

  it('keeps the post as it was when the read fails for another reason, and says so', async () => {
    seed()
    getChanges.mockResolvedValue(changesOf({ rev: '70' }))
    getPost.mockRejectedValue(apiError(503, 'down'))
    for (let i = 1; i <= 5; i++) await s.poll('tok')
    await expect(s.poll('tok')).rejects.toMatchObject({ status: 503 })
    expect(s.post.rev).toBe('70')
    expect(s.post.info).toEqual(info())
    expect(s.error).toBe('down')
  })

  it('keeps the facts it has when the answer has none', async () => {
    seed()
    getChanges.mockResolvedValue(changesOf())
    for (const answer of [null, {}, { post: null }, { post: 'x' }, { post: [] }]) {
      getPost.mockResolvedValueOnce(answer)
      for (let i = 1; i <= 6; i++) await s.poll('tok')
      expect(s.post.info, JSON.stringify(answer)).toEqual(info())
    }
  })

  it('lands nothing when the store moved on while the post was read', async () => {
    seed()
    getChanges.mockResolvedValue(changesOf())
    for (let i = 1; i <= 5; i++) await s.poll('tok')
    const slow = deferred()
    getPost.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(found({ post: info({ id: OTHER }) }))
    listMessages.mockResolvedValue(pageOf([420]))
    const p = s.poll('tok')
    await tick()
    await s.openPost('tok', OTHER)
    slow.resolve(found({ post: info({ title: 'Wrong' }) }))
    await p
    expect(s.post.id).toBe(OTHER)
    expect(s.post.info).toEqual(info({ id: OTHER }))
  })
})

describe('librarius store: a start-over that keeps coming opens the post again at the five-minute cap', () => {
  const T0 = Date.UTC(2026, 10, 18, 12, 0, 0)
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })

  it('opens the post once each time the wait has reached five minutes, and never in between', async () => {
    expect(POLL_MS).toBe(10_000)
    seed()
    getChanges.mockResolvedValue({ reset: true })
    getPost.mockResolvedValue(found({ rev: '900' }))
    listMessages.mockResolvedValue(pageOf([410, 411], { rev: '900' }))
    await s.poll('tok') // the first start-over: opened again
    getPost.mockClear()
    let now = 0
    const opened = []
    for (const wait of [20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]) {
      vi.setSystemTime(T0 + now)
      getPost.mockClear()
      await s.poll('tok')
      opened.push(getPost.mock.calls.length)
      vi.setSystemTime(T0 + now + wait - 1)
      getChanges.mockClear()
      await s.poll('tok')
      expect(getChanges, `in the wait after ${now}`).not.toHaveBeenCalled()
      now += wait
    }
    // Ignored while the wait doubles; at the cap, each start-over opens the post again, once.
    expect(opened).toEqual([0, 0, 0, 0, 0, 1, 1])
  })

  it('shows what changed when it opens the post again at the cap', async () => {
    seed()
    getChanges.mockResolvedValue({ reset: true })
    getPost.mockResolvedValue(found({ rev: '900' }))
    listMessages.mockResolvedValue(pageOf([410, 411], { rev: '900' }))
    await s.poll('tok')
    let now = 0
    for (const wait of [20_000, 40_000, 80_000, 160_000, 300_000]) {
      vi.setSystemTime(T0 + now)
      await s.poll('tok')
      now += wait
    }
    listMessages.mockResolvedValue(pageOf([410, 411, 412], { rev: '900' }))
    vi.setSystemTime(T0 + now)
    await s.poll('tok')
    expect(s.post.messages.map((m) => m.id)).toEqual([mid(410), mid(411), mid(412)])
  })

  it('waits the five minutes again after a reopen at the cap that fails, rather than ask at every poll', async () => {
    seed()
    getChanges.mockResolvedValue({ reset: true })
    getPost.mockResolvedValue(found({ rev: '900' }))
    listMessages.mockResolvedValue(pageOf([410, 411], { rev: '900' }))
    await s.poll('tok')
    let now = 0
    for (const wait of [20_000, 40_000, 80_000, 160_000, 300_000]) {
      vi.setSystemTime(T0 + now)
      await s.poll('tok')
      now += wait
    }
    vi.setSystemTime(T0 + now)
    getPost.mockRejectedValue(apiError(503, 'down'))
    await expect(s.poll('tok')).rejects.toMatchObject({ status: 503 })
    getChanges.mockClear()
    vi.setSystemTime(T0 + now + 299_999)
    await s.poll('tok')
    expect(getChanges).not.toHaveBeenCalled()
  })

  it('begins afresh when the reopen at the cap lands at another rev: the wait for that rev starts again from the poll\'s', async () => {
    seed()
    getChanges.mockResolvedValue({ reset: true })
    getPost.mockResolvedValue(found({ rev: '900' }))
    listMessages.mockResolvedValue(pageOf([410, 411], { rev: '900' }))
    await s.poll('tok')
    let now = 0
    for (const wait of [20_000, 40_000, 80_000, 160_000, 300_000]) {
      vi.setSystemTime(T0 + now)
      await s.poll('tok')
      now += wait
    }
    getPost.mockResolvedValue(found({ rev: '950' }))
    listMessages.mockResolvedValue(pageOf([410, 411], { rev: '950' }))
    vi.setSystemTime(T0 + now)
    await s.poll('tok')
    expect(s.post.rev).toBe('950')
    getChanges.mockClear()
    getPost.mockClear()
    await s.poll('tok') // asks from 950 at once, and the start-over for it is ignored: the wait is 20 s, not 5 minutes
    expect(getChanges).toHaveBeenCalledWith('tok', POST, '950')
    expect(getPost).not.toHaveBeenCalled()
    vi.setSystemTime(T0 + now + 20_000)
    await s.poll('tok')
    expect(getChanges).toHaveBeenCalledTimes(2)
  })
})
