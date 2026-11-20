// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { setActivePinia, createPinia, storeToRefs } from 'pinia'

vi.mock('../lib/librarius/api')
import { getPost, listMessages, getChanges, getPending, postReply, editMessage, deleteMessage, uploadPicture } from '../lib/librarius/api'
import { useLibrarius } from './librarius'
import { devtoolsPinia, trackedStore } from '../test-utils/devtoolsPinia'

// The store in a dev build (`bun run dev`, and so the e2e run): Pinia's devtools plugin calls every action with a new Proxy of the store
// as `this`. What the store keeps beside its state (the following of the queue, the count of polls, the wait after a start-over, the
// pictures held for a reply) must be the same store's however its actions are called. The tests of librarius.test.js and
// librarius.writes.test.js run without the plugin, as a production build does.

const apiError = (status, message = 'nope') => Object.assign(new Error(message), { status })

// Every id here is invented: 18 digits, from the range the Librarius fixtures use.
const mid = (n) => String(200000000000000000n + BigInt(n))
const POST = mid(400)
const OTHER = mid(401)
const SELF = mid(402)
const FRIEND = mid(403)
const MSG = mid(450)
const msg = (n) => ({ id: mid(n), authorId: SELF, authorName: 'Invented Author', content: `Message ${n}` })
const info = (extra = {}) => ({ id: POST, ownerId: SELF, title: 'Invented post', tagIds: [], pinned: false, locked: false, archived: false, createdAt: '2026-11-01T00:00:00.000Z', replies: 3, ...extra })
const found = (extra = {}) => ({ post: info(), lastRead: null, rev: '40', ...extra })
const pageOf = (ns, extra = {}) => ({ messages: ns.map((n) => msg(n)), hasOlder: false, hasNewer: false, people: {}, rev: '40', ...extra })
const changesOf = (extra = {}) => ({ messages: [], deleted: [], rev: '60', people: {}, ...extra })
const queued = (key) => ({ pending: { key, state: 'sending' } })
const entry = (key, extra = {}) => ({ key, kind: 'send', state: 'sending', error: null, source: 'Invented reply', createdAt: '2026-11-18T10:00:00.000Z', ...extra })
const listed = (...entries) => ({ pending: entries })
const picture = (name = 'invented.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })
const bodyOf = (mock, n = 0) => mock.mock.calls[n].at(-1)
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0)

let s
beforeEach(() => {
  devtoolsPinia()
  vi.resetAllMocks()
  s = useLibrarius()
})
afterEach(() => {
  s.reset()
  vi.useRealTimers()
})

const seed = (id = POST) => {
  s.$patch((state) => {
    state.status = 'allowed'
    state.post = { id, info: info({ id }), opening: null, earliest: null, messages: [msg(410), msg(411)], hasOlder: false, hasNewer: false, rev: '40', lastRead: null }
  })
}
const states = () => s.outbox.map((e) => [e.kind, e.key, e.state])

describe('librarius store in a dev build: what the reader sent', () => {
  beforeEach(() => vi.useFakeTimers())

  it.each([
    ['a reply', 'send', 'k-1', () => s.reply('tok', { source: 'Invented reply' }), postReply],
    ['an edit', 'edit', MSG, () => s.edit('tok', MSG, { source: 'Changed' }), editMessage],
    ['a delete', 'delete', MSG, () => s.remove('tok', MSG), deleteMessage],
  ])('%s leaves the queue once a poll has brought the change, and the asking stops', async (_, kind, key, send, mock) => {
    seed()
    mock.mockResolvedValue(queued(key))
    getPending.mockResolvedValue(listed())
    await send()
    expect(states()).toEqual([[kind, key, 'sending']])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(states()).toEqual([[kind, key, 'sent']])
    getChanges.mockResolvedValue(changesOf({ rev: '61', messages: [msg(412)] }))
    await s.poll('tok')
    expect(s.outbox).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getPending).toHaveBeenCalledTimes(1)
  })

  it('stops following the queue on a sign-out, and asks nothing more', async () => {
    seed()
    postReply.mockResolvedValue(queued('k-1'))
    getPending.mockResolvedValue(listed(entry('k-1')))
    await s.reply('tok', { source: 'Invented reply' })
    s.reset()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getPending).not.toHaveBeenCalled()
    expect(s.outbox).toEqual([])
  })

  it('stops following the queue of a post the reader has left, and asks nothing about the post it opened', async () => {
    seed()
    postReply.mockResolvedValue(queued('k-1'))
    getPending.mockResolvedValue(listed(entry('k-1')))
    await s.reply('tok', { source: 'Invented reply' })
    getPost.mockResolvedValue(found({ post: info({ id: OTHER }) }))
    listMessages.mockResolvedValue(pageOf([420]))
    await s.openPost('tok', OTHER)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getPending).not.toHaveBeenCalled()
    expect(s.outbox).toEqual([])
  })

  it('sends a failed reply again as it was sent, and a failed edit', async () => {
    seed()
    postReply.mockResolvedValue(queued('k-1'))
    editMessage.mockResolvedValue(queued(MSG))
    await s.reply('tok', { source: `Retry <@${FRIEND}>`, replyTo: MSG, pingReply: true })
    await s.edit('tok', MSG, { source: `Edit <@${FRIEND}>`, mentions: [] })
    getPending.mockResolvedValueOnce(
      listed(entry('k-1', { state: 'failed', error: 'x', source: `Retry <@${FRIEND}>` }), entry(MSG, { kind: 'edit', state: 'failed', error: 'x', source: null })),
    )
    await vi.advanceTimersByTimeAsync(3_000)
    postReply.mockResolvedValue(queued('k-2'))
    await s.retry('tok', { kind: 'send', key: 'k-1' })
    await expect(s.retry('tok', { kind: 'edit', key: MSG })).resolves.toMatchObject({ key: MSG, state: 'sending' })
    expect(bodyOf(postReply, 1)).toEqual({ source: `Retry <@${FRIEND}>`, replyTo: MSG, pingReply: true, mentions: [FRIEND], uploads: [] })
    expect(bodyOf(editMessage, 1)).toEqual({ source: `Edit <@${FRIEND}>`, mentions: [] })
  })

  it('keeps a failed one put away though the server lists it for a day', async () => {
    seed()
    getPending.mockResolvedValue(listed(entry('k-1', { state: 'failed', error: 'x' })))
    await s.pending('tok')
    s.dismiss({ kind: 'send', key: 'k-1' })
    expect(s.outbox).toEqual([])
    await s.pending('tok')
    expect(s.outbox).toEqual([])
  })
})

describe('librarius store in a dev build: the polls', () => {
  it('reads the post itself again on the 6th poll', async () => {
    seed()
    getChanges.mockResolvedValue(changesOf())
    getPost.mockResolvedValue(found({ post: info({ locked: true }) }))
    for (let i = 1; i <= 5; i++) await s.poll('tok')
    expect(getPost).not.toHaveBeenCalled()
    await s.poll('tok')
    expect(getPost).toHaveBeenCalledTimes(1)
    expect(s.post.info.locked).toBe(true)
  })

  it('waits out a start-over that comes again for the rev it opened the post at', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    seed()
    getChanges.mockResolvedValue({ reset: true })
    getPost.mockResolvedValue(found({ rev: '900' }))
    listMessages.mockResolvedValue(pageOf([410, 411], { rev: '900' }))
    await s.poll('tok')
    expect(getPost).toHaveBeenCalledTimes(1)
    // The same start-over again: not opened again, and the next poll waits 20 seconds.
    await s.poll('tok')
    expect(getPost).toHaveBeenCalledTimes(1)
    vi.setSystemTime(T0 + 19_999)
    getChanges.mockClear()
    await s.poll('tok')
    expect(getChanges).not.toHaveBeenCalled()
  })
})

describe('librarius store in a dev build: pictures', () => {
  it('sends the picture held for a reply with it, and knows the draft holds it until then', async () => {
    seed()
    uploadPicture.mockResolvedValue({ id: '9001' })
    postReply.mockResolvedValue(queued('k-1'))
    await expect(s.upload('tok', picture(), 1)).resolves.toEqual({ n: 1, name: 'invented' })
    expect(s.holdsPicture(1)).toBe(true)
    await s.reply('tok', { source: 'A map ![the map](upload:1)' })
    expect(bodyOf(postReply).uploads).toEqual(['9001'])
    expect(s.holdsPicture(1)).toBe(false)
  })

  it('lets go of the pictures on a sign-out', async () => {
    seed()
    uploadPicture.mockResolvedValue({ id: '9001' })
    await s.upload('tok', picture(), 1)
    expect(s.holdsPicture(1)).toBe(true)
    s.reset()
    seed()
    expect(s.holdsPicture(1)).toBe(false)
  })
})

describe('librarius store: one store, however its actions are called', () => {
  it('reads the same through storeToRefs as from the store', async () => {
    vi.useFakeTimers()
    seed()
    const { outbox } = storeToRefs(s)
    postReply.mockResolvedValue(queued('k-1'))
    getPending.mockResolvedValue(listed())
    await s.reply('tok', { source: 'Invented reply' })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(outbox.value.map((e) => e.state)).toEqual(['sent'])
    getChanges.mockResolvedValue(changesOf({ rev: '61' }))
    await s.poll('tok')
    expect(outbox.value).toEqual([])
  })

  it('does the same whether each call gets the store, a new proxy of it, or a proxy of a proxy (property)', async () => {
    vi.useFakeTimers()
    const step = fc.oneof(
      fc.constant({ do: 'reply' }),
      fc.constant({ do: 'reply with the picture' }),
      fc.constant({ do: 'upload' }),
      fc.constant({ do: 'edit' }),
      fc.constant({ do: 'remove' }),
      fc.constant({ do: 'fail' }),
      fc.constant({ do: 'retry' }),
      fc.constant({ do: 'dismiss' }),
      fc.constant({ do: 'poll' }),
      fc.constant({ do: 'reset' }),
      fc.integer({ min: 1, max: 7_000 }).map((ms) => ({ do: 'wait', ms })),
    )
    const as = (how) => (how === 0 ? s : how === 1 ? trackedStore(s) : trackedStore(trackedStore(s)))
    /** Runs the steps on a store of its own, with `ways[i]` saying what `this` each call is given, and → all it showed and sent. */
    async function play(steps, ways) {
      s?.reset()
      vi.clearAllTimers()
      vi.resetAllMocks()
      setActivePinia(createPinia())
      s = useLibrarius()
      seed()
      let keys = 0
      let rev = 60
      let failing = false
      postReply.mockImplementation(async () => queued(`k-${++keys}`))
      editMessage.mockImplementation(async (_t, id) => queued(id))
      deleteMessage.mockImplementation(async (_t, id) => queued(id))
      uploadPicture.mockImplementation(async () => ({ id: String(9000 + ++keys) }))
      getPending.mockImplementation(async () => (failing ? listed(...s.outbox.filter((e) => e.state === 'sending').map((e) => entry(e.key, { kind: e.kind, state: 'failed', error: 'x', source: e.source }))) : listed()))
      getChanges.mockImplementation(async () => changesOf({ rev: String(++rev) }))
      const seen = []
      for (const [i, st] of steps.entries()) {
        const me = as(ways[i % ways.length])
        const call = (name, ...args) => s[name].call(me, ...args)
        const ended = s.outbox.find((e) => e.state === 'failed')
        if (st.do === 'reply') await call('reply', 'tok', { source: 'Invented reply' })
        else if (st.do === 'reply with the picture') await call('reply', 'tok', { source: 'A map ![the map](upload:1)' })
        else if (st.do === 'upload') await call('upload', 'tok', picture(), 1)
        else if (st.do === 'edit') await call('edit', 'tok', MSG, { source: 'Changed' })
        else if (st.do === 'remove') await call('remove', 'tok', MSG)
        else if (st.do === 'fail') failing = !failing
        else if (st.do === 'retry' && ended !== undefined) await call('retry', 'tok', ended).catch((err) => seen.push(err.message))
        else if (st.do === 'dismiss' && ended !== undefined) call('dismiss', ended)
        else if (st.do === 'poll') await call('poll', 'tok')
        else if (st.do === 'reset') {
          call('reset')
          seed()
        } else if (st.do === 'wait') await vi.advanceTimersByTimeAsync(st.ms)
        seen.push([states(), s.holdsPicture(1)])
      }
      return { seen, replies: postReply.mock.calls.map((c) => c.at(-1)), edits: editMessage.mock.calls.length, asked: getPending.mock.calls.length }
    }
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 20 }), fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 6 }), async (steps, ways) => {
        const plain = await play(steps, [0])
        expect(await play(steps, ways)).toEqual(plain)
      }),
      { numRuns: 150 },
    )
  })
})

describe('librarius store in a dev build: a refusal while reading', () => {
  it('lets go of what it followed when a poll is refused, and asks nothing more', async () => {
    vi.useFakeTimers()
    seed()
    postReply.mockResolvedValue(queued('k-1'))
    getPending.mockResolvedValue(listed(entry('k-1')))
    await s.reply('tok', { source: 'Invented reply' })
    getChanges.mockRejectedValue(apiError(403))
    await s.poll('tok')
    expect(s.status).toBe('denied')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getPending).not.toHaveBeenCalled()
  })
})
