import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fc from 'fast-check'
import { COPY, createOutbox } from './librariusOutbox.js'
import { WebhookError, createWebhookClient } from './librariusWebhook.js'
import { Upstream } from './discordRoles.js'

// Every id, name, link and token here is invented. The worker runs on fake timers and a fake clock, against a small model of
// everything it touches: a store with the contract of the real one (librariusOutboxStore.js, whose SQL is proven against a
// real Postgres), the REAL webhook client over a fake `fetch` that behaves as Discord does (it stores what it is sent, keeps
// the files of a message across an edit, answers what a script says it answers), and a bot client. A test reads what is left
// in that world, not what was called: the messages in the thread, the rows of the store, and when each webhook call was made.
const API = 'https://discord.com/api'
const HOOK = '200000000000000450'
const TOKEN = 'invented-webhook-token_0123456789abcdef'
const GUILD = '200000000000000403'
const THREAD = '200000000000000404'
const THREAD_2 = '200000000000000405'
const MEMBER = '200000000000000401'
const MEMBER_2 = '200000000000000402'
const REPLIED = '200000000000000406'
const MENTIONED = '200000000000000407'
const OLD_HOOK = '200000000000000451' // a webhook that was replaced
const SITE = 'https://site.example/librarius/200000000000000404'
const AVATAR = 'https://cdn.discordapp.com/avatars/200000000000000401/0a1b2c3d.png'
const T0 = Date.parse('2026-11-18T10:00:00.000Z')
const SPACING = 1500
const x = (n) => 'x'.repeat(n)
const png = (...bytes) => Uint8Array.from([137, 80, 78, 71, ...bytes])

/** A WebhookError as the client makes it, for a script to answer with. */
const answer = (status, body = {}, headers = {}) => ({ status, body, headers })
/** What the bot client throws for a refusal of Discord's: an Upstream with the status and Discord's code. */
const botRefusal = (status, code) => Object.assign(new Upstream(`Discord answered ${status} for a message delete.`), { status, code })
const archivedRefusal = () => botRefusal(400, 50083)

function makeWorld() {
  let counter = 0
  const nextId = () => String(200000000000100000n + BigInt(counter++))
  const w = {
    thread: [], // the messages of the thread, oldest first, as Discord's REST shows them (ours and others')
    calls: [], // every webhook call: { kind, at, thread, messageId, body, files }
    bot: [], // every call of the bot: { kind, ... }
    script: [], // what the next webhook requests answer: null (as Discord would), a response, or { throws, lands }
    lookFails: [],
    // What may leave a part in Discord that the store has no id for, in the order it happened (`seq`): `made`, the seq of each message a
    // send made, by its id; `doubts`, each look at the thread that threw (Discord's read, or the store's knownPartIds) and each note of
    // progress the store did not take, with the parts the look would have seen or the note told of (`covers(message, entry)`). A note
    // the store did not take is a doubt only when the worker that held it was gone before the store had it (`takes`, the seq of each
    // time the lock was taken afresh: a stop and a start, or a lock that was lost). An entry that ends for good has the seq of its end
    // (`endSeq`), and an entry it queued to put Discord right names it (`origin`). What undoes a doubt: `madeFor`, the entry and the part
    // each message a send made was sent for (the entry and part of the last note that said a part was on its way, which is written just
    // before the send); `found`, each look that answered whole (the thread, then knownPartIds), with the entries and parts it was a look
    // for (`for`: the entries on their way whose note of the part on its way says the send began 5 s after the look's start).
    made: new Map(),
    madeFor: new Map(),
    doubts: [],
    found: [],
    takes: [],
    seq: 0,
    inflight: null,
    looking: null,
    // What the worker holds in the store (ISO text or null), whether the lock is free for it, whether it holds it, and what it did with
    // the lock. A test takes the lock away with `lockHeld = false` (and gives it to another worker with `lockFree = false`).
    holds: { pausedUntil: null, globalUntil: null },
    lockFree: true,
    lockHeld: false,
    lockCalls: [],
    looks: [],
    archived: false,
    locked: false,
    life: 0,
    entries: new Map(),
    messages: new Map(),
    parts: new Map(),
    uploads: new Map(),
    events: [],
    tombstones: [],
    storeFails: {},
    storeFailsAfter: {},
    postMissing: false,
    nextEntry: 1,
    nextUpload: 1,
    nextId,
  }

  const asMs = (t) => (t instanceof Date ? t.getTime() : typeof t === 'string' ? Date.parse(t) : t)
  const clone = (v) => JSON.parse(JSON.stringify(v))
  const view = (e) => ({ id: e.id, kind: e.kind, messageKey: e.messageKey, authorId: e.authorId, payload: clone(e.payload), attempts: e.attempts })
  const maybeFail = (name) => {
    const err = w.storeFails[name]?.shift()
    if (err) throw err
  }
  const partOwner = (id) => [...w.parts.entries()].find(([, ids]) => ids.includes(id))?.[0] ?? null

  /** What the store does with a hold: a time never moves back. */
  w.hold = (hold) => {
    for (const key of ['pausedUntil', 'globalUntil']) {
      if (hold[key] === undefined) continue
      const was = w.holds[key] === null ? -Infinity : Date.parse(w.holds[key])
      if (asMs(hold[key]) > was) w.holds[key] = new Date(asMs(hold[key])).toISOString()
    }
  }

  w.enqueue = ({ kind = 'send', key, authorId = MEMBER, payload, nextAt = Date.now(), state = 'pending', attempts = 0, origin = null }) => {
    const id = String(w.nextEntry++)
    w.entries.set(id, { id, kind, messageKey: key ?? `${id}`.padStart(32, 'a'), authorId, payload: clone(payload), state, attempts, nextAt: asMs(nextAt), lastError: null, origin })
    if (kind !== 'send') {
      const m = w.messages.get(key)
      if (m !== undefined) m.state = 'sending'
    }
    return id
  }

  w.store = {
    async takeWorkerLock() {
      maybeFail('takeWorkerLock')
      w.lockCalls.push('take')
      // As the real store: a lock that is held is held, and one that is free is taken.
      if (!w.lockHeld && w.lockFree) {
        w.lockHeld = true
        w.takes.push(w.seq++)
      }
      return w.lockHeld
    },
    async releaseWorkerLock() {
      maybeFail('releaseWorkerLock')
      w.lockCalls.push('release')
      w.lockHeld = false
    },
    holdsWorkerLock() {
      return w.lockHeld
    },
    async outboxHold() {
      maybeFail('outboxHold')
      return { ...w.holds }
    },
    async noteBlock(id, { event, hold }) {
      maybeFail('noteBlock')
      const e = w.entries.get(id)
      if (e === undefined || e.state !== 'sending') return
      w.events.push({ at: Date.now(), actor: e.authorId, ...event })
      if (hold !== undefined) w.hold(hold)
    },
    async sendTimesSince(since) {
      maybeFail('sendTimesSince')
      return [...w.entries.values()]
        .filter((e) => ['send', 'edit'].includes(e.kind))
        .flatMap((e) => e.payload.progress?.parts ?? [])
        .map((part) => asMs(part.at))
        .filter((t) => t >= asMs(since))
        .sort((a, b) => a - b)
        .map((t) => new Date(t).toISOString())
    },
    async outboxInterrupted() {
      maybeFail('outboxInterrupted')
      return [...w.entries.values()].filter((e) => e.state === 'sending').map(view)
    },
    async claimOutbox(now) {
      maybeFail('claimOutbox')
      const due = [...w.entries.values()].filter((e) => e.state === 'pending' && e.nextAt <= asMs(now)).sort((a, b) => a.nextAt - b.nextAt || Number(a.id) - Number(b.id))[0]
      if (due === undefined) return null
      due.state = 'sending'
      return view(due)
    },
    async outboxNextAt() {
      maybeFail('outboxNextAt')
      const pending = [...w.entries.values()].filter((e) => e.state === 'pending')
      return pending.length === 0 ? null : new Date(Math.min(...pending.map((e) => e.nextAt))).toISOString()
    },
    async outboxProgress(id, progress) {
      const parts = (progress.parts ?? []).map((part) => part.id)
      try {
        maybeFail('outboxProgress')
      } catch (err) {
        // The worker keeps the note: the parts it told of are unknown to the store only if that worker is gone (the lock was taken afresh)
        // before a later note of the entry told the store of them.
        const doubt = { seq: w.seq++, entryId: id, parts, taken: false }
        doubt.covers = (m, entry) => entry.id === id && parts.includes(m.id) && !doubt.taken && w.takes.some((t) => t > doubt.seq && t < entry.endSeq)
        w.doubts.push(doubt)
        throw err
      }
      const e = w.entries.get(id)
      if (e !== undefined && e.state === 'sending') e.payload.progress = clone(progress)
      if ((progress.inflight ?? null) !== null) w.inflight = { entryId: id, index: progress.inflight }
      for (const d of w.doubts) if (d.entryId === id && !d.taken && !w.takes.some((t) => t > d.seq) && d.parts.every((part) => parts.includes(part))) d.taken = true
    },
    async outboxSet(id, { state, attempts, nextAt, error = null, messageState, event, queue = [], hold }) {
      maybeFail('outboxSet')
      const e = w.entries.get(id)
      // As the real store: an entry that is not sending is left as it is, and nothing is written for it.
      if (e === undefined || e.state !== 'sending') return
      if (hold !== undefined) w.hold(hold)
      if (state === 'failed' || state === 'blocked') e.endSeq = w.seq++
      e.state = state
      if (attempts !== undefined) e.attempts = attempts
      if (nextAt !== undefined) e.nextAt = asMs(nextAt)
      e.lastError = error === null ? null : error.slice(0, 500)
      if (messageState !== undefined && e.kind !== 'send' && w.messages.has(e.messageKey)) w.messages.get(e.messageKey).state = messageState
      if (event !== undefined) w.events.push({ at: Date.now(), actor: e.authorId, ...event })
      for (const item of queue) w.enqueue({ kind: item.kind, key: item.messageKey, authorId: e.authorId, payload: item.payload, origin: id })
    },
    async finishSend(id, { message, partIds, uploadIds, event }) {
      maybeFail('finishSend')
      const e = w.entries.get(id)
      if (e.state !== 'sending') return { stored: true, gone: [] }
      const gone = (e.gone ?? []).filter((g) => partIds.includes(g))
      if (gone.length > 0) return { stored: false, gone }
      if (w.postMissing) return { stored: false, gone: null }
      for (const part of partIds) {
        const owner = partOwner(part)
        if (owner !== null && owner !== message.id) throw new Error('duplicate key value violates unique constraint (discord_id)')
      }
      for (const part of partIds.slice(1)) w.messages.delete(part)
      w.messages.set(message.id, { ...clone(message), origin: 'site', state: null })
      w.parts.set(message.id, [...partIds])
      for (const upload of uploadIds) w.uploads.delete(upload)
      e.state = 'sent'
      e.lastError = null
      w.events.push({ at: Date.now(), actor: message.authorId, ...event })
      return { stored: true, gone: [] }
    },
    async finishEdit(id, { messageId, source, content, partIds, event, queue = [] }) {
      maybeFail('finishEdit')
      const e = w.entries.get(id)
      if (e.state !== 'sending') return { stored: true, gone: [] }
      const gone = (e.gone ?? []).filter((g) => partIds.includes(g))
      if (gone.length > 0) return { stored: false, gone }
      const m = w.messages.get(messageId)
      if (m === undefined) return { stored: false, gone: [] }
      Object.assign(m, { source, content, state: null, editedAt: Date.now() })
      w.parts.set(messageId, [...partIds])
      e.state = 'sent'
      w.events.push({ at: Date.now(), actor: e.authorId, ...event })
      // As outboxSet does: what puts Discord right is queued in the same transaction (the parts an edit no longer needs).
      for (const item of queue) w.enqueue({ kind: item.kind, key: item.messageKey, authorId: e.authorId, payload: item.payload, origin: id })
      return { stored: true, gone: [] }
    },
    async finishDelete(id, { messageId, partIds, event }) {
      maybeFail('finishDelete')
      const e = w.entries.get(id)
      if (e.state !== 'sending') return
      if (w.messages.has(messageId)) w.tombstones.push(messageId)
      w.messages.delete(messageId)
      w.parts.delete(messageId)
      for (const part of partIds) {
        const owner = partOwner(part)
        if (owner !== null) w.parts.delete(owner)
      }
      e.state = 'sent'
      w.events.push({ at: Date.now(), actor: e.authorId, ...event })
    },
    async outboxMessage(messageId) {
      maybeFail('outboxMessage')
      const m = w.messages.get(messageId)
      return m === undefined ? null : { ...clone(m), parts: [...(w.parts.get(messageId) ?? [])] }
    },
    async uploadsFor(authorId, ids) {
      maybeFail('uploadsFor')
      return ids.filter((id) => w.uploads.get(id)?.authorId === authorId).map((id) => w.uploads.get(id))
    },
    async knownPartIds(ids) {
      const look = w.looking
      w.looking = null
      try {
        maybeFail('knownPartIds')
      } catch (err) {
        w.doubts.push({ seq: w.seq++, covers: (m) => ids.includes(m.id) })
        throw err
      }
      if (look !== null) w.found.push({ seq: w.seq++, for: look })
      return new Set(ids.filter((id) => partOwner(id) !== null))
    },
    async blockedSince(since) {
      maybeFail('blockedSince')
      return w.events.filter((e) => e.action === 'blocked' && e.at >= asMs(since)).map((e) => new Date(e.at).toISOString())
    },
  }

  // A write that was made, and whose answer was lost: the store applied it, and the worker is told it failed.
  for (const name of ['outboxSet', 'finishSend', 'finishEdit', 'finishDelete', 'claimOutbox']) {
    const inner = w.store[name]
    w.store[name] = async (...args) => {
      const out = await inner(...args)
      const err = w.storeFailsAfter[name]?.shift()
      if (err) throw err
      return out
    }
  }

  w.addUpload = (over = {}) => {
    const id = String(w.nextUpload++)
    w.uploads.set(id, { id, authorId: MEMBER, name: 'whatever.png', contentType: 'image/png', bytes: png(id.charCodeAt(0)), ...over })
    return id
  }

  /**
   * What the store does when the gateway tells it that a message was deleted (siteDeleted, whose SQL is proven apart): a part
   * that no stored reply owns, but that an entry on its way has sent, is noted in that entry.
   */
  w.partDeleted = (id) => {
    const at = w.thread.findIndex((m) => m.id === id)
    if (at !== -1) w.thread.splice(at, 1)
    for (const e of w.entries.values()) {
      if (['pending', 'sending'].includes(e.state) && ['send', 'edit'].includes(e.kind) && (e.payload.progress?.parts ?? []).some((part) => part.id === id)) (e.gone ??= []).push(id)
    }
  }

  /** What Discord does with a request to the webhook, before any script has its say. */
  function discord(method, url, init) {
    const u = new URL(url)
    const thread = u.searchParams.get('thread_id')
    const messageId = /\/messages\/(\d+)$/.exec(u.pathname)?.[1]
    const kind = { POST: 'send', PATCH: 'edit', DELETE: 'remove' }[method]
    let body = null
    let files = []
    if (typeof init.body === 'string') body = JSON.parse(init.body)
    else if (init.body instanceof FormData) {
      body = JSON.parse(init.body.get('payload_json'))
      files = [...init.body.entries()].filter(([k]) => k.startsWith('files[')).map(([, f]) => ({ name: f.name, type: f.type, size: f.size }))
    }
    w.calls.push({ kind, at: Date.now(), thread, messageId, body, files, life: w.life, held: w.lockHeld })
    return { kind, thread, messageId, body, files }
  }

  function effect({ kind, thread, messageId, body, files }) {
    if (w.archived) return answer(400, { code: 50083, message: 'Thread is archived' })
    if (w.threadGone) return answer(404, { code: 10003, message: 'Unknown Channel' })
    if (kind === 'send') {
      const id = w.nextId()
      const message = {
        id,
        channel_id: thread,
        type: 0,
        webhook_id: HOOK,
        author: { id: HOOK, username: body.username, bot: true },
        flags: body.flags,
        content: body.content ?? '',
        components: body.components,
        attachments: files.map((f, i) => ({ id: w.nextId(), filename: f.name, content_type: f.type, size: f.size, width: 1, height: 1, url: `https://cdn.discordapp.com/attachments/${thread}/${id}/${f.name}?ex=6540a0b3&is=1&hm=2` })),
        timestamp: new Date(Date.now()).toISOString(),
      }
      w.thread.push(message)
      w.made.set(id, w.seq++)
      w.madeFor.set(id, w.inflight)
      return answer(200, message)
    }
    const at = w.thread.findIndex((m) => m.id === messageId)
    if (at === -1) return answer(404, { code: 10008, message: 'Unknown Message' })
    if (kind === 'edit') {
      // Only the text is changed: the files of the message are kept, whatever the body says of them.
      if (body.content !== undefined) w.thread[at].content = body.content
      if (body.components !== undefined) w.thread[at].components = body.components
      w.thread[at].edited_timestamp = new Date(Date.now()).toISOString()
      return answer(200, w.thread[at])
    }
    w.thread.splice(at, 1)
    return { status: 204 }
  }

  const respond = (r) => new Response(r.status === 204 ? null : JSON.stringify(r.body ?? null), { status: r.status, headers: r.headers })

  w.fetchImpl = async (url, init = {}) => {
    const req = discord(init.method, url, init)
    const next = w.script.shift()
    if (next === undefined || next === null) return respond(effect(req))
    if (next.throws) {
      if (next.lands) effect(req)
      throw new Error('socket hang up')
    }
    // A response of the script's own; `lands` has Discord do the work and still answer so, and `removes` has the message it names gone.
    // (A 2xx answer to a delete or an edit means Discord did it: only a send can be answered 2xx with no message.)
    if (next.lands || (req.kind !== 'send' && next.status >= 200 && next.status < 300)) effect(req)
    if (next.removes) {
      const at = w.thread.findIndex((m) => m.id === req.messageId)
      if (at !== -1) w.thread.splice(at, 1)
    }
    return respond(next)
  }

  w.discord = {
    async newest(threadId, limit = 100) {
      return [...w.thread].reverse().slice(0, limit)
    },
    async messagesAfter(threadId, afterId, limit = 100) {
      w.looks.push({ threadId, afterId, limit, at: Date.now() })
      // The snowflake holds a time: what is after it is what came later, and a message with no time is taken as recent.
      const since = Number(BigInt(afterId) >> 22n) + 1420070400000
      const fail = w.lookFails.shift()
      if (fail !== undefined) {
        w.doubts.push({ seq: w.seq++, covers: (m) => Date.parse(m.timestamp) > since })
        throw fail
      }
      // The entries and parts this is a look for: a look reads from 5 s before the send of the part began, which the part's note says.
      const on = [...w.entries.values()].filter((e) => e.state === 'sending' && (e.payload.progress?.inflight ?? null) !== null && e.payload.progress.inflightAt - 5000 === since)
      w.looking = on.map((e) => ({ entryId: e.id, index: e.payload.progress.inflight }))
      return w.thread.filter((m) => m.timestamp === undefined || Date.parse(m.timestamp) > since).slice(0, limit)
    },
    async setArchived(threadId, archived) {
      w.bot.push({ kind: 'archive', threadId, archived, at: Date.now() })
      if (!archived && w.locked) return false
      w.archived = archived
      return true
    },
    async deleteMessage(threadId, messageId) {
      w.bot.push({ kind: 'delete', threadId, messageId, at: Date.now(), held: w.lockHeld })
      // As Discord answers a delete in a thread that is archived, and the bot client carries its status and code.
      if (w.archived) throw archivedRefusal()
      const at = w.thread.findIndex((m) => m.id === messageId)
      if (at !== -1) w.thread.splice(at, 1)
    },
  }
  w.webhook = createWebhookClient({ fetchImpl: w.fetchImpl, url: `${API}/webhooks/${HOOK}/${TOKEN}`, apiBase: API, newest: w.discord.newest })

  /** The messages of the thread that are ours, oldest first. */
  w.ours = () => w.thread.filter((m) => m.webhook_id === HOOK)
  /** The text of a message as a reader of Discord sees it. */
  w.textOf = (m) => (m.content !== '' ? m.content : walk(m.components).join('\n'))
  w.sends = () => w.calls.filter((c) => c.kind === 'send')
  w.entry = (id) => w.entries.get(id)
  return w
}

function walk(components, out = []) {
  for (const c of components ?? []) {
    if (typeof c.content === 'string') out.push(c.content)
    walk(c.components, out)
  }
  return out
}

const sendPayload = (over = {}) => ({
  postId: THREAD,
  source: 'Hello there.',
  replyTo: null,
  mentions: [],
  uploads: [],
  username: 'Invented Name',
  avatarUrl: AVATAR,
  siteUrl: SITE,
  ...over,
})

// Three paragraphs of 3000 characters cannot share a part, so a source of them is three parts.
const THREE = (a = 'one', b = 'two', c = 'three') => `${a}${x(3000)}\n\n${b}${x(3000)}\n\n${c}${x(3000)}`
const TWO = (a = 'one', b = 'two') => `${a}${x(3000)}\n\n${b}${x(3000)}`

let w
let outbox
beforeEach(() => {
  vi.useFakeTimers()
  // A worker that starts waits the spacing before its first call (a call may have gone out just before the crash that is being recovered
  // from), so the clock begins one spacing before T0 and the first call of a test is at T0.
  vi.setSystemTime(T0 - SPACING)
  w = makeWorld()
})
afterEach(async () => {
  await outbox?.stop()
  outbox = null
  vi.useRealTimers()
})

const make = (over = {}) => createOutbox({ store: w.store, webhook: w.webhook, discord: w.discord, guildId: GUILD, log: () => {}, ...over })
/** Starts a worker, and lets it work for `ms` of fake time. */
async function run(ms = 60_000, over = {}) {
  const fresh = outbox == null
  outbox ??= make(over)
  outbox.start()
  // A worker that is going already is told of what was queued since.
  if (!fresh) outbox.kick()
  // A worker that starts waits the spacing before its first call, so `ms` is counted from that first call.
  await vi.advanceTimersByTimeAsync(fresh ? SPACING + ms : ms)
}
const later = (ms) => vi.advanceTimersByTimeAsync(ms)
/** Sends a reply through the worker and answers the id of the message it made. */
async function sentReply(source, over = {}, ms = 60_000) {
  const id = w.enqueue({ payload: sendPayload({ source, ...over }) })
  await run(ms)
  expect(w.entry(id).state).toBe('sent')
  return [...w.messages.keys()].at(-1)
}
/** The gaps between the webhook calls, in ms. */
const gaps = () => w.calls.slice(1).map((c, i) => c.at - w.calls[i].at)

describe('the first reply', () => {
  it('sends a short reply as one message under the member\'s name, stores it as theirs, and finishes the entry', async () => {
    const id = w.enqueue({ payload: sendPayload({ mentions: [MENTIONED] }) })
    await run()
    expect(w.ours()).toHaveLength(1)
    const [sent] = w.ours()
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]).toMatchObject({ kind: 'send', thread: THREAD })
    expect(w.calls[0].body.username).toBe('Invented Name')
    expect(w.calls[0].body.avatar_url).toBe(AVATAR)
    expect(w.calls[0].body.allowed_mentions).toEqual({ parse: [], users: [MENTIONED] })
    expect(w.calls[0].body.flags).toBe(32768)
    expect(w.textOf(sent)).toBe(`Hello there.\n-# <@${MEMBER}>`)
    expect(w.entry(id).state).toBe('sent')
    const row = w.messages.get(sent.id)
    expect(row).toMatchObject({ id: sent.id, postId: THREAD, authorId: MEMBER, authorName: 'Invented Name', authorAvatar: AVATAR, webhookId: HOOK, origin: 'site', state: null, source: 'Hello there.', content: 'Hello there.', replyTo: null })
    expect(row.layout).toEqual({ form: 'v2', replyTo: null, siteUrl: SITE, username: 'Invented Name', avatarUrl: AVATAR, images: [] })
    expect(row.createdAt).toBe(sent.timestamp)
    expect(w.parts.get(sent.id)).toEqual([sent.id])
    expect(w.events).toEqual([{ at: T0, actor: MEMBER, action: 'send', postId: THREAD, messageId: sent.id, note: '1 part' }])
  })
})

describe('createOutbox: the options', () => {
  const ok = () => ({ store: w.store, webhook: w.webhook, discord: w.discord, guildId: GUILD })
  it('starts nothing and sends nothing until start()', async () => {
    outbox = createOutbox(ok())
    w.enqueue({ payload: sendPayload() })
    await later(10_000)
    expect(w.calls).toEqual([])
    expect(outbox.sendingPausedUntil()).toBeNull()
    expect(outbox.webhookRefused()).toBeNull()
  })

  it.each([
    ['a store without a method', () => ({ ...ok(), store: { ...w.store, finishSend: undefined } }), 'store.finishSend must be a function.'],
    ['no store', () => ({ ...ok(), store: undefined }), 'store.takeWorkerLock must be a function.'],
    ...['takeWorkerLock', 'releaseWorkerLock', 'holdsWorkerLock', 'outboxHold', 'noteBlock', 'sendTimesSince', 'outboxInterrupted', 'claimOutbox', 'outboxNextAt', 'outboxProgress', 'outboxSet', 'finishSend', 'finishEdit', 'finishDelete', 'outboxMessage', 'uploadsFor', 'knownPartIds', 'blockedSince'].map((name) => [
      `a store with no ${name}`,
      () => ({ ...ok(), store: { ...w.store, [name]: 'x' } }),
      `store.${name} must be a function.`,
    ]),
    ...['send', 'edit', 'remove'].map((name) => [`a webhook with no ${name}`, () => ({ ...ok(), webhook: { ...w.webhook, [name]: null } }), `webhook.${name} must be a function.`]),
    ['no webhook', () => ({ ...ok(), webhook: undefined }), 'webhook.send must be a function.'],
    ['a webhook with no id', () => ({ ...ok(), webhook: { send() {}, edit() {}, remove() {}, id: undefined } }), 'webhook.id must be a Discord id.'],
    ['a webhook with a bad id', () => ({ ...ok(), webhook: { send() {}, edit() {}, remove() {}, id: '12' } }), 'webhook.id must be a Discord id.'],
    ...['setArchived', 'deleteMessage', 'messagesAfter'].map((name) => [`a bot with no ${name}`, () => ({ ...ok(), discord: { ...w.discord, [name]: 1 } }), `discord.${name} must be a function.`]),
    ['no bot', () => ({ ...ok(), discord: undefined }), 'discord.setArchived must be a function.'],
    ['a form that is no form', () => ({ ...ok(), form: 'html' }), 'form must be "v2" or "plain".'],
    ['no guild id', () => ({ ...ok(), guildId: undefined }), 'guildId must be a Discord id.'],
    ['a guild id that is no id', () => ({ ...ok(), guildId: '12' }), 'guildId must be a Discord id.'],
    ['a clock that is no function', () => ({ ...ok(), now: 5 }), 'now must be a function.'],
    ['a log that is no function', () => ({ ...ok(), log: 'x' }), 'log must be a function.'],
    ['timers without setTimeout', () => ({ ...ok(), timers: { clearTimeout() {} } }), 'timers.setTimeout must be a function.'],
    ['timers without clearTimeout', () => ({ ...ok(), timers: { setTimeout() {} } }), 'timers.clearTimeout must be a function.'],
  ])('refuses %s', (_, options, message) => {
    expect(() => createOutbox(options())).toThrow(new TypeError(message))
  })

  it('takes the plain form, and its own clock and timers', async () => {
    const timers = { setTimeout: vi.fn((fn, ms) => globalThis.setTimeout(fn, ms)), clearTimeout: vi.fn((t) => globalThis.clearTimeout(t)) }
    outbox = createOutbox({ ...ok(), form: 'plain', timers, now: () => Date.now() })
    w.enqueue({ payload: sendPayload() })
    outbox.start()
    await later(5000)
    expect(w.ours()[0].content).toBe(`Hello there.\n-# <@${MEMBER}> · [Open On Site](<${SITE}>)`)
    expect(w.calls[0].body.flags).toBe(4)
  })
})

describe('a reply, in order', () => {
  it('sends the entries oldest first: by their due time, and by id for the same time', async () => {
    const a = w.enqueue({ payload: sendPayload({ source: 'Third.' }), nextAt: T0 + 2000 })
    const b = w.enqueue({ payload: sendPayload({ source: 'First.' }), nextAt: T0 - 5000 })
    const c = w.enqueue({ payload: sendPayload({ source: 'Second A.' }), nextAt: T0 })
    const d = w.enqueue({ payload: sendPayload({ source: 'Second B.' }), nextAt: T0 })
    await run(10_000)
    expect(w.ours().map((m) => w.textOf(m).split('\n')[0])).toEqual(['First.', 'Second A.', 'Second B.', 'Third.'])
    for (const id of [a, b, c, d]) expect(w.entry(id).state).toBe('sent')
  })

  it('does not send an entry before it is due, and sends it when it is, without being kicked', async () => {
    w.enqueue({ payload: sendPayload(), nextAt: T0 + 40_000 })
    await run(39_999)
    expect(w.calls).toEqual([])
    await later(1)
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0].at).toBe(T0 + 40_000)
  })

  it('sends a reply queued later when it is kicked', async () => {
    await run(1000)
    expect(w.calls).toEqual([])
    w.enqueue({ payload: sendPayload() })
    outbox.kick()
    await later(0)
    expect(w.calls).toHaveLength(1)
  })

  it('does not wait for a kick when the next entry is due in a month: it looks again within the hour', async () => {
    w.enqueue({ payload: sendPayload(), nextAt: T0 + 30 * 86_400_000 })
    await run(1000)
    const claims = vi.spyOn(w.store, 'claimOutbox')
    await later(3_600_000 * 24)
    // One look an hour, not a look at once and again at once, which is what a timer longer than 24 days does.
    expect(claims.mock.calls.length).toBeLessThanOrEqual(25)
    expect(claims.mock.calls.length).toBeGreaterThanOrEqual(23)
    await later(7 * 86_400_000 * 3)
    expect(w.calls).toEqual([])
    await later(10 * 86_400_000)
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0].at).toBe(T0 + 30 * 86_400_000)
  })
})

describe('a reply of several parts', () => {
  it('sends the parts in order, each at least 1500 ms after the one before, then adds the links forward to the first', async () => {
    const id = w.enqueue({ payload: sendPayload({ source: THREE() }) })
    await run()
    const [p1, p2, p3] = w.ours()
    expect(w.ours()).toHaveLength(3)
    expect(w.calls.map((c) => c.kind)).toEqual(['send', 'send', 'send', 'edit'])
    expect(w.calls.map((c) => c.at - T0)).toEqual([0, 1500, 3000, 4500])
    const base = `https://discord.com/channels/${GUILD}/${THREAD}`
    // Part 1 was sent with nothing to say about the others, and now continues to both.
    expect(w.textOf(p1)).toContain('**1/3** one')
    expect(w.textOf(p1)).toContain(`-# continues: [2/3](<${base}/${p2.id}>) · [3/3](<${base}/${p3.id}>)`)
    expect(w.textOf(p2)).toContain(`-# [↑ from 1/3](<${base}/${p1.id}>)`)
    expect(w.textOf(p2)).toContain('**2/3** two')
    expect(w.textOf(p3)).toContain(`-# [↑ from 1/3](<${base}/${p1.id}>)`)
    expect(w.textOf(p3)).toContain(`-# <@${MEMBER}>`)
    expect(w.textOf(p1)).not.toContain(`-# <@${MEMBER}>`)
    expect(w.entry(id).state).toBe('sent')
    expect(w.parts.get(p1.id)).toEqual([p1.id, p2.id, p3.id])
    expect([...w.messages.keys()]).toEqual([p1.id])
    expect(w.events[0].note).toBe('3 parts')
    // The first part's own edit leaves its files and its name alone.
    expect(w.calls[3].messageId).toBe(p1.id)
    expect(w.calls[3].body.username).toBeUndefined()
  })

  it('stores the message under the id of its first part, made at the time Discord made that part', async () => {
    const id = await sentReply(TWO())
    const [p1] = w.ours()
    expect(id).toBe(p1.id)
    expect(w.messages.get(id).createdAt).toBe(p1.timestamp)
    expect(w.messages.get(id).source).toBe(TWO())
  })

  it('keeps the content to 4000 characters of the source, never cutting a pair', async () => {
    const source = `${x(3999)}😀${x(3000)}`
    const id = await sentReply(source)
    expect(Array.from(w.messages.get(id).content)).toHaveLength(4000)
    expect(w.messages.get(id).content.endsWith('😀')).toBe(true)
  })

  it('stores the time from the id when Discord gave none', async () => {
    const real = w.fetchImpl
    w.fetchImpl = undefined
    const bare = createWebhookClient({
      fetchImpl: async (url, init) => {
        const r = await real(url, init)
        if (init.method !== 'POST') return r
        const body = await r.json()
        delete body.timestamp
        return new Response(JSON.stringify(body), { status: 200 })
      },
      url: `${API}/webhooks/${HOOK}/${TOKEN}`,
      apiBase: API,
      newest: w.discord.newest,
    })
    outbox = make({ webhook: bare })
    w.enqueue({ payload: sendPayload() })
    outbox.start()
    await later(5000)
    const [m] = w.messages.values()
    // (200000000000100000 >> 22) + the epoch of Discord, as a time
    expect(m.createdAt).toBe(new Date(Number(200000000000100000n >> 22n) + 1420070400000).toISOString())
  })
})

describe('spacing: every webhook call is at least 1500 ms after the one before it', () => {
  it('holds between entries, not only between the parts of one', async () => {
    for (let i = 0; i < 4; i++) w.enqueue({ payload: sendPayload({ source: `Reply ${i}.` }) })
    await run()
    expect(w.calls.map((c) => c.at - T0)).toEqual([0, 1500, 3000, 4500])
  })

  it('holds for edits and deletes as for sends', async () => {
    const a = await sentReply('First.')
    const b = await sentReply('Second.')
    w.calls.length = 0
    w.enqueue({ kind: 'edit', key: a, payload: { postId: THREAD, source: 'First, edited.', mentions: [] } })
    w.enqueue({ kind: 'delete', key: b, payload: { postId: THREAD } })
    w.enqueue({ payload: sendPayload({ source: 'Third.' }) })
    w.enqueue({ kind: 'edit', key: a, payload: { postId: THREAD, source: 'First, edited again.', mentions: [] } })
    outbox.kick()
    await later(30_000)
    expect(w.calls.map((c) => c.kind)).toEqual(['edit', 'remove', 'send', 'edit'])
    expect(gaps()).toEqual([1500, 1500, 1500])
  })

  it('counts from the end of a call, not its start', async () => {
    const slow = w.fetchImpl
    w.fetchImpl = async (url, init) => {
      const r = await slow(url, init)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return r
    }
    w.webhook = createWebhookClient({ fetchImpl: w.fetchImpl, url: `${API}/webhooks/${HOOK}/${TOKEN}`, apiBase: API, newest: w.discord.newest })
    w.enqueue({ payload: sendPayload({ source: 'A.' }) })
    w.enqueue({ payload: sendPayload({ source: 'B.' }) })
    await run(20_000, { webhook: w.webhook })
    expect(gaps()).toEqual([2500])
  })

  it('waits more than 1500 ms when the entry is not due until later: it is no shorter than the time to the due entry', async () => {
    w.enqueue({ payload: sendPayload({ source: 'A.' }) })
    w.enqueue({ payload: sendPayload({ source: 'B.' }), nextAt: T0 + 10_000 })
    await run(20_000)
    expect(w.calls.map((c) => c.at - T0)).toEqual([0, 10_000])
  })
})

describe('the ceiling: 20 sends in 60 seconds', () => {
  it('lets a 21st send wait until the first has left the window, and no sliding minute ever holds more than 20', async () => {
    for (let i = 0; i < 24; i++) w.enqueue({ payload: sendPayload({ source: `Reply ${i}.` }) })
    await run(300_000)
    const at = w.sends().map((c) => c.at)
    expect(at).toHaveLength(24)
    expect(at.slice(0, 20).map((t) => t - T0)).toEqual(Array.from({ length: 20 }, (_, i) => i * 1500))
    // The 21st goes out the moment the first is a minute old, and the others keep to the spacing from there.
    expect(at[20] - at[0]).toBe(60_000)
    expect(at[21] - at[1]).toBe(60_000)
    for (let i = 0; i + 20 < at.length; i++) expect(at[i + 20] - at[i]).toBeGreaterThanOrEqual(60_000)
    expect(w.ours()).toHaveLength(24)
  })

  it('counts the last 20 sends, not the first: a send that is late moves the window of the sends after it', async () => {
    w.enqueue({ payload: sendPayload({ source: 'First.' }), nextAt: T0 })
    for (let i = 1; i < 22; i++) w.enqueue({ payload: sendPayload({ source: `Reply ${i}.` }), nextAt: T0 + 40_000 })
    await run(300_000)
    const at = w.sends().map((c) => c.at - T0)
    // The first at 0, the next 20 from 40 s, 1.5 s apart. The 21st is ready at 68.5 s and goes: the first left the window at 60 s. The
    // 22nd must wait for the second, which was sent at 40 s: it goes at 100 s, and not at 70 s as it would if the window began at the first.
    expect(at[0]).toBe(0)
    expect(at[1]).toBe(40_000)
    expect(at[20]).toBe(68_500)
    expect(at[21]).toBe(100_000)
  })

  it('counts sends only: edits and deletes neither fill the window nor wait for it', async () => {
    const first = await sentReply('First.')
    w.calls.length = 0
    for (let i = 0; i < 25; i++) w.enqueue({ kind: 'edit', key: first, payload: { postId: THREAD, source: `Edit ${i}.`, mentions: [] } })
    w.enqueue({ payload: sendPayload({ source: 'Last.' }) })
    outbox.kick()
    await later(200_000)
    expect(w.calls.map((c) => c.kind)).toEqual([...Array(25).fill('edit'), 'send'])
    expect(gaps().every((g) => g === 1500)).toBe(true)
  })

  it('does not count a send that Discord refused: it made no message, so it fills no window', async () => {
    // (A 403 ends an entry at once: a refusal that is tried again would send more than once.)
    for (let i = 0; i < 25; i++) w.script.push(answer(403, { code: 50013 }))
    for (let i = 0; i < 26; i++) w.enqueue({ payload: sendPayload({ source: `Reply ${i}.` }) })
    await run(200_000)
    expect(w.sends()).toHaveLength(26)
    expect(gaps().every((g) => g === 1500)).toBe(true)
    expect(w.ours()).toHaveLength(1)
  })

  describe('from what landed, as the store knows it, and from when it landed', () => {
    const S = T0 - SPACING // the clock as the worker starts
    /** `n` parts that landed `ago` ms before the worker starts, `step` ms apart, from the oldest. Entries done, with their parts in progress, as the store keeps them. */
    const landedBefore = (n, ago, step = 1000) => {
      for (let i = 0; i < n; i++) {
        const at = new Date(S - ago + i * step).toISOString()
        w.enqueue({ state: 'sent', payload: sendPayload({ progress: { form: 'v2', parts: [{ id: w.nextId(), at, attachments: [] }], inflight: null } }) })
      }
    }

    it('rebuilds the window at start: with 20 sends in the last minute, the next waits until the oldest has left it', async () => {
      landedBefore(20, 50_000)
      w.enqueue({ payload: sendPayload({ source: 'Next.' }) })
      await run(60_000)
      // The oldest landed 50 s before the start: it leaves the window 10 s after it.
      expect(w.sends().map((c) => c.at - S)).toEqual([10_000])
    })

    it('has no wait for 19 sends in the last minute, and counts the 20th: the next waits', async () => {
      landedBefore(19, 50_000)
      w.enqueue({ payload: sendPayload({ source: 'Twentieth.' }) })
      w.enqueue({ payload: sendPayload({ source: 'Twenty-first.' }) })
      await run(60_000)
      expect(w.sends().map((c) => c.at - S)).toEqual([SPACING, 10_000])
    })

    it('keeps the last 20 of more than 20, and reads only the last minute', async () => {
      landedBefore(25, 50_000)
      landedBefore(5, 130_000)
      w.enqueue({ payload: sendPayload({ source: 'Next.' }) })
      await run(60_000)
      // The 20th latest of the 25 landed at 50 s before the start minus 5 s... : 6th of the 25 (at index 5) + 60 s.
      expect(w.sends().map((c) => c.at - S)).toEqual([-50_000 + 5_000 + 60_000])
    })

    it('asks the store for the last minute only', async () => {
      const asked = []
      const real = w.store.sendTimesSince
      w.store.sendTimesSince = async (since) => (asked.push(since), real(since))
      await run(1)
      expect(asked).toEqual([S - 60_000])
    })

    it('counts a send whose answer was lost: it may have made a message', async () => {
      landedBefore(19, 50_000)
      w.script.push({ throws: true, lands: true })
      w.enqueue({ payload: sendPayload({ source: 'Lost answer.' }) })
      w.enqueue({ payload: sendPayload({ source: 'Next.' }) })
      await run(60_000)
      // The first is adopted after the look, at 5 s; the 20 sends in the window then make the next wait until the oldest has left it.
      expect(w.sends().map((c) => c.at - S)).toEqual([SPACING, 10_000])
    })

    /** A webhook that is the real one but for what `over` says. */
    const stub = (over) => ({ id: HOOK, send: (...a) => w.webhook.send(...a), edit: (...a) => w.webhook.edit(...a), remove: (...a) => w.webhook.remove(...a), ...over })

    it('counts only a send: an edit that may have been made fills no place of the window', async () => {
      landedBefore(19, 50_000)
      const id = w.nextId()
      w.messages.set(id, { id, origin: 'site', postId: THREAD, authorId: MEMBER, webhookId: HOOK, source: 'Before.', state: null, layout: { form: 'v2', replyTo: null, siteUrl: SITE, username: 'Invented Name', avatarUrl: AVATAR, images: [] } })
      w.parts.set(id, [id])
      w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: 'After.', mentions: [] } })
      w.enqueue({ payload: sendPayload({ source: 'Next.' }) })
      const webhook = stub({
        edit: async () => {
          throw new WebhookError('Discord did not answer.', { unknown: true })
        },
      })
      await run(60_000, { webhook })
      // The edit is a call at the start, and the send follows it by the spacing: it waits for no window.
      expect(w.sends().map((c) => c.at - S)).toEqual([2 * SPACING])
    })

    it('counts only what the webhook client says may have landed: another error of a send, with the same word, is no landing', async () => {
      landedBefore(19, 50_000)
      let sent = 0
      const webhook = stub({
        send: async (...args) => {
          if (sent++ === 0) throw Object.assign(new Error('odd'), { unknown: true })
          return w.webhook.send(...args)
        },
      })
      w.enqueue({ payload: sendPayload({ source: 'Odd.' }) })
      w.enqueue({ payload: sendPayload({ source: 'Next.' }) })
      await run(60_000, { webhook })
      // The odd error ended the first attempt of 'Odd.' at the start, and 'Next.' went after it, by the spacing, with no wait for the window.
      expect(w.sends()[0].at - S).toBe(2 * SPACING)
    })

    it('counts a send when it lands, not when it begins: a slow one leaves the window a call later', async () => {
      const slow = w.fetchImpl
      w.fetchImpl = async (url, init) => {
        const r = await slow(url, init)
        await new Promise((resolve) => setTimeout(resolve, 1500))
        return r
      }
      w.webhook = createWebhookClient({ fetchImpl: w.fetchImpl, url: `${API}/webhooks/${HOOK}/${TOKEN}`, apiBase: API, newest: w.discord.newest })
      for (let i = 0; i < 21; i++) w.enqueue({ payload: sendPayload({ source: `Reply ${i}.` }) })
      await run(120_000, { webhook: w.webhook })
      const at = w.sends().map((c) => c.at - S)
      // Each call takes 1500 ms and the next begins 1500 ms after its end. The first lands at S + 3000, so the 21st waits until S + 63000
      // (it is ready at S + 61500, and a window counted from the first call's start would let it go then).
      expect(at.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => 1500 + 3000 * i))
      expect(at[20]).toBe(63_000)
    })
  })
})

describe('pictures', () => {
  const SRC = (n) => `Look: ![a picture](upload:${n})`

  it('sends the files with the part that carries them, under names of their own, and keeps what Discord stored of them', async () => {
    const u1 = w.addUpload({ name: 'holiday.PNG', contentType: 'image/png' })
    const u2 = w.addUpload({ name: 'plan.jpeg', contentType: 'image/jpeg' })
    const id = w.enqueue({ payload: sendPayload({ source: `${SRC(2)} and ${SRC(1)}`, uploads: [u1, u2] }) })
    await run()
    expect(w.calls[0].files.map((f) => [f.name, f.type])).toEqual([
      ['picture-2.jpg', 'image/jpeg'],
      ['picture-1.png', 'image/png'],
    ])
    expect(w.entry(id).state).toBe('sent')
    const [m] = w.ours()
    expect(m.attachments.map((a) => a.filename)).toEqual(['picture-2.jpg', 'picture-1.png'])
    const row = w.messages.get(m.id)
    expect(row.attachments.map((a) => [a.filename, a.position, a.contentType])).toEqual([
      ['picture-2.jpg', 0, 'image/jpeg'],
      ['picture-1.png', 1, 'image/png'],
    ])
    expect(row.layout.images).toEqual([
      { ref: 1, name: 'picture-1.png' },
      { ref: 2, name: 'picture-2.jpg' },
    ])
    expect([...w.uploads.keys()]).toEqual([])
  })

  it('names the file by its type, for each of the four', async () => {
    const ups = [
      ['image/png', 'png'],
      ['image/jpeg', 'jpg'],
      ['image/webp', 'webp'],
      ['image/gif', 'gif'],
    ].map(([contentType]) => w.addUpload({ contentType }))
    w.enqueue({ payload: sendPayload({ source: [1, 2, 3, 4].map(SRC).join('\n\n'), uploads: ups }) })
    await run()
    expect(w.calls[0].files.map((f) => f.name)).toEqual(['picture-1.png', 'picture-2.jpg', 'picture-3.webp', 'picture-4.gif'])
  })

  it('sends the bytes it was given', async () => {
    const seen = []
    const inner = w.fetchImpl
    w.fetchImpl = async (url, init) => {
      if (init.body instanceof FormData) for (const [k, f] of init.body.entries()) if (k.startsWith('files[')) seen.push([...new Uint8Array(await f.arrayBuffer())])
      return inner(url, init)
    }
    w.webhook = createWebhookClient({ fetchImpl: w.fetchImpl, url: `${API}/webhooks/${HOOK}/${TOKEN}`, apiBase: API, newest: w.discord.newest })
    const u = w.addUpload({ bytes: png(9, 8, 7) })
    w.enqueue({ payload: sendPayload({ source: SRC(1), uploads: [u] }) })
    await run(5000, { webhook: w.webhook })
    expect(seen).toEqual([[137, 80, 78, 71, 9, 8, 7]])
  })

  it('attaches each picture to the part it falls in, and to no other', async () => {
    const [u1, u2, u3] = [1, 2, 3].map(() => w.addUpload())
    const source = `${x(3000)}\n\n${SRC(1)}\n\n${x(3000)}\n\n${SRC(2)}\n\n${x(3000)}\n\n${SRC(3)}`
    w.enqueue({ payload: sendPayload({ source, uploads: [u1, u2, u3] }) })
    await run()
    expect(w.sends().map((c) => c.files.map((f) => f.name))).toEqual([['picture-1.png'], ['picture-2.png'], ['picture-3.png']])
    expect(w.calls.at(-1).kind).toBe('edit')
    expect(w.calls.at(-1).files).toEqual([])
    expect(w.messages.values().next().value.attachments.map((a) => a.filename)).toEqual(['picture-1.png', 'picture-2.png', 'picture-3.png'])
  })

  it('fails the entry, sending nothing, when a picture is no longer held, and leaves the others', async () => {
    const u1 = w.addUpload()
    const id = w.enqueue({ payload: sendPayload({ source: SRC(1), uploads: [u1, '99'] }) })
    await run()
    expect(w.calls).toEqual([])
    expect(w.entry(id).state).toBe('failed')
    expect(w.entry(id).lastError).toBe('A picture of this reply is no longer held. Post it again.')
    expect(w.uploads.has(u1)).toBe(true)
  })

  it('does not take another member\'s upload', async () => {
    const u = w.addUpload({ authorId: MEMBER_2 })
    const id = w.enqueue({ payload: sendPayload({ source: SRC(1), uploads: [u] }) })
    await run()
    expect(w.entry(id).state).toBe('failed')
    expect(w.calls).toEqual([])
  })
})

describe('what a reply may be', () => {
  it('shows the message it answers, and keeps its id for the site', async () => {
    const replyTo = { messageId: '200000000000000430', authorId: REPLIED, url: 'https://discord.com/channels/200000000000000403/200000000000000404/200000000000000430' }
    const id = await sentReply('Agreed.', { replyTo })
    expect(w.textOf(w.ours()[0])).toContain(`-# ↪ <@${REPLIED}> [jump](<${replyTo.url}>)`)
    expect(w.messages.get(id).replyTo).toBe('200000000000000430')
    expect(w.messages.get(id).layout.replyTo).toEqual(replyTo)
  })

  it('fails a reply that needs more than three messages, and sends nothing of it', async () => {
    const id = w.enqueue({ payload: sendPayload({ source: `${x(3000)}\n\n${x(3000)}\n\n${x(3000)}\n\n${x(3000)}` }) })
    await run()
    expect(w.calls).toEqual([])
    expect(w.entry(id)).toMatchObject({ state: 'failed', lastError: "That's longer than Discord can carry in 3 messages." })
  })

  it('sends at most ten mentions and none that were not picked', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `2000000000000005${String(10 + i)}`)
    await sentReply('Hello.', { mentions: ids })
    expect(w.calls[0].body.allowed_mentions.parse).toEqual([])
    expect(w.calls[0].body.allowed_mentions.users).toEqual(ids.slice(0, 10))
  })

  it('sends under the name and picture it was given, and none when it was given none', async () => {
    await sentReply('Hello.', { avatarUrl: null, username: 'Other Name' })
    expect(w.calls[0].body.username).toBe('Other Name')
    expect(w.calls[0].body.avatar_url).toBeUndefined()
    expect([...w.messages.values()][0].authorAvatar).toBeNull()
  })
})

describe('the form a reply was checked in', () => {
  // The route checks a reply in the form the site sends in at the time, and says which in the entry (payload.form). The worker sends it in
  // that form, whatever form it sends new replies in by the time it takes the entry.
  it.each([
    ['v2', 'plain', 32768],
    ['plain', 'v2', 4],
  ])('sends a reply checked in %s in that form, though the worker sends new replies in %s now', async (checked, current, flags) => {
    outbox = make({ form: current })
    const id = w.enqueue({ payload: sendPayload({ form: checked }) })
    await run()
    expect(w.entry(id).state).toBe('sent')
    expect(w.calls[0].body.flags).toBe(flags)
    expect(w.messages.get(w.ours()[0].id).layout.form).toBe(checked)
  })

  it.each([
    ['no form, as an entry queued before the route said', undefined],
    ['null', null],
    ['a form in capitals', 'V2'],
    ['a form that is no form', 'html'],
    ['an empty text', ''],
    ['a number', 2],
    ['a list with a form in it', ['plain']],
    ['an object with a form in it', { form: 'plain' }],
  ])('sends a reply whose entry says %s in the form the worker sends new replies in', async (_, form) => {
    outbox = make({ form: 'plain' })
    const id = w.enqueue({ payload: sendPayload({ form }) })
    await run()
    expect(w.entry(id).state).toBe('sent')
    expect(w.calls[0].body.flags).toBe(4)
    expect(w.messages.get(w.ours()[0].id).layout.form).toBe('plain')
  })

  it('keeps the form a reply began in when it is taken up again, whatever its entry and the worker say', async () => {
    const id = w.enqueue({ state: 'sending', payload: sendPayload({ form: 'v2', progress: { form: 'plain', parts: [], inflight: null } }) })
    await run()
    expect(w.entry(id).state).toBe('sent')
    expect(w.calls[0].body.flags).toBe(4)
    expect(w.messages.get(w.ours()[0].id).layout.form).toBe('plain')
  })
})

describe('no blind resend: a send that may have landed is looked for before it is sent again', () => {
  const lost = { throws: true }
  const landed = { throws: true, lands: true }

  it('adopts the message when it did land, and sends no second', async () => {
    w.script.push(landed)
    const id = w.enqueue({ payload: sendPayload() })
    await run()
    expect(w.sends()).toHaveLength(1)
    expect(w.ours()).toHaveLength(1)
    expect(w.entry(id).state).toBe('sent')
    expect([...w.messages.keys()]).toEqual([w.ours()[0].id])
  })

  it('sends it again, once, when it did not land, 5 s after the first: the look waits for Discord to show what it made', async () => {
    w.script.push(lost)
    const id = w.enqueue({ payload: sendPayload() })
    await run()
    expect(w.sends().map((c) => c.at - T0)).toEqual([0, 5000])
    expect(w.ours()).toHaveLength(1)
    expect(w.entry(id).state).toBe('sent')
  })

  it.each([
    ['a timeout or a reset', lost],
    ['a 502', { ...answer(502), lands: false }],
    ['a 500', answer(500)],
    ['an answer that is no message', answer(200, { nothing: 1 })],
  ])('treats %s as a send that may have landed', async (_, first) => {
    w.script.push(first, answer(200, { ...{ id: w.nextId() }, ...{} }))
    w.enqueue({ payload: sendPayload() })
    await run()
    // One look at the thread, which was empty, and then one more send: the second answer was the script's own, a message of nobody's.
    expect(w.sends().length).toBeGreaterThanOrEqual(2)
  })

  it('adopts it when the second send is the one that did land, at the look after it, in the same attempt', async () => {
    w.script.push(lost, landed)
    const id = w.enqueue({ payload: sendPayload() })
    await run()
    expect(w.sends().map((c) => c.at - T0)).toEqual([0, 5000])
    expect(w.looks.map((l) => l.at - T0)).toEqual([5000, 10_000])
    expect(w.ours()).toHaveLength(1)
    expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 0 })
  })

  it('goes to the ladder after two unknowns and a look after each, and looks first at the next attempt, which sends once', async () => {
    w.script.push(lost, lost)
    const id = w.enqueue({ payload: sendPayload() })
    await run(10_000)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 1 })
    expect(w.entry(id).nextAt).toBe(T0 + 10_000 + 5000)
    await later(5000)
    expect(w.sends().map((c) => c.at - T0)).toEqual([0, 5000, 15_000])
    expect(w.looks.map((l) => l.at - T0)).toEqual([5000, 10_000, 15_000])
    expect(w.ours()).toHaveLength(1)
    expect(w.entry(id).state).toBe('sent')
  })

  describe('at the end of the ladder, where no attempt comes after to look', () => {
    // Every attempt sends twice, and each send is a 502, until the very last of the last attempt, which lands.
    const ladder = () => [...Array.from({ length: 9 }, () => answer(502)), { ...answer(502), lands: true }]
    const forbidden = () => answer(403, { code: 50013, message: 'Missing Permissions' })

    it('looks after the second unknown too, and takes the part the last send made: the reply is there once, and stored', async () => {
      w.script.push(...ladder())
      const id = w.enqueue({ payload: sendPayload() })
      await run(2_000_000)
      expect(w.sends()).toHaveLength(10)
      expect(w.ours()).toHaveLength(1)
      expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 4 })
      expect([...w.messages.keys()]).toEqual([w.ours()[0].id])
      expect(w.parts.get(w.ours()[0].id)).toEqual([w.ours()[0].id])
    })

    it('removes that part with the rest of the reply when the reply then ends for good', async () => {
      w.script.push(...ladder(), forbidden())
      const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
      await run(2_000_000)
      expect(w.entry(id)).toMatchObject({ state: 'failed', lastError: COPY.locked })
      expect(w.sends()).toHaveLength(11)
      expect(w.ours()).toEqual([])
      expect(w.messages.size).toBe(0)
      // The part the last send made is the one the cleanup named and removed.
      const landed = w.entry(id).payload.progress.parts.map((part) => part.id)
      expect(landed).toHaveLength(1)
      const deletes = [...w.entries.values()].filter((e) => e.kind === 'delete')
      expect(deletes.map((e) => [e.state, e.payload.partIds])).toEqual([['sent', landed]])
      expect(w.calls.filter((c) => c.kind === 'remove').map((c) => c.messageId)).toEqual(landed)
    })

    it('removes a part an edit added with the last send of the ladder, when the edit then ends for good, and puts the reply back', async () => {
      const id = await sentReply('Short.')
      w.calls.length = 0
      w.script.push(null, ...ladder(), forbidden())
      const e = w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: TWO('a', 'b'), mentions: [] } })
      outbox.kick()
      await later(2_000_000)
      expect(w.entry(e)).toMatchObject({ state: 'failed', lastError: COPY.locked })
      expect(w.sends()).toHaveLength(10)
      expect(w.ours().map((m) => m.id)).toEqual([id])
      expect(w.textOf(w.ours()[0])).toBe(`Short.\n-# <@${MEMBER}>`)
      expect(w.messages.get(id)).toMatchObject({ source: 'Short.', state: null })
      expect(w.parts.get(id)).toEqual([id])
    })

    it('ends the attempt with the second send\'s own error when the look after it finds nothing, and sends no third', async () => {
      w.script.push(answer(502), answer(500))
      const id = w.enqueue({ payload: sendPayload() })
      await run(10_000)
      // Two sends, a look after each, and then the ladder: the next attempt is 5 s after the second look.
      expect(w.sends().map((c) => c.at - T0)).toEqual([0, 5000])
      expect(w.looks.map((l) => l.at - T0)).toEqual([5000, 10_000])
      expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 1, lastError: 'WebhookError: Discord answered 500 to the webhook send.' })
      expect(w.entry(id).nextAt).toBe(T0 + 15_000)
    })
  })

  it('finds, at the next attempt, a message that landed when the look after it could not be made', async () => {
    w.script.push(lost, landed)
    w.script.push(lost) // never reached: the part is found, and not sent a third time
    // The look after the first send is made; the one after the second fails.
    w.lookFails.push(undefined, new Upstream('Discord is unreachable.'))
    const id = w.enqueue({ payload: sendPayload() })
    await run()
    expect(w.sends()).toHaveLength(2)
    expect(w.looks.map((l) => l.at - T0)).toEqual([5000, 10_000, 15_000])
    expect(w.ours()).toHaveLength(1)
    expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 1 })
  })

  it('does not take for its own a message that is a part of another reply, though the words are the same', async () => {
    const a = await sentReply('Same words.')
    w.script.push(lost)
    const id = w.enqueue({ payload: sendPayload({ source: 'Same words.' }) })
    outbox.kick()
    await later(10_000)
    expect(w.ours()).toHaveLength(2)
    expect(w.entry(id).state).toBe('sent')
    const [first, second] = w.ours()
    expect(first.id).toBe(a)
    expect([...w.messages.keys()]).toEqual([first.id, second.id])
  })

  it('does not take a part of a reply that is stored, though it is recent and has the same words', async () => {
    const a = await sentReply('Same words.', {}, 2000)
    w.script.push(lost)
    const asked = []
    const inner = w.store.knownPartIds
    w.store.knownPartIds = async (ids) => (asked.push([...ids]), inner(ids))
    const id = w.enqueue({ payload: sendPayload({ source: 'Same words.' }) })
    outbox.kick()
    await later(10_000)
    expect(w.entry(id).state).toBe('sent')
    expect(w.ours()).toHaveLength(2)
    expect(w.ours()[0].id).toBe(a)
    expect([...w.messages.keys()]).toEqual([a, w.ours()[1].id])
    // The store is asked about the messages of our webhook that the look found, and about no other.
    expect(asked).toEqual([[a]])
  })

  it('is not made to fail by what Discord puts in the page that is no message', async () => {
    w.script.push(lost)
    const real = w.discord.messagesAfter
    w.discord.messagesAfter = async (...args) => [null, 7, 'x', undefined, ...(await real(...args))]
    w.enqueue({ payload: sendPayload() })
    await run(10_000)
    expect(w.sends()).toHaveLength(2)
    expect(w.ours()).toHaveLength(1)
  })

  it('does not take a message of someone else with the same words', async () => {
    w.thread.push({ id: w.nextId(), webhook_id: '200000000000000999', content: `Hello there.\n-# <@${MEMBER}>`, attachments: [] })
    w.thread.push({ id: w.nextId(), webhook_id: null, content: `Hello there.\n-# <@${MEMBER}>`, attachments: [] })
    w.script.push(lost)
    w.enqueue({ payload: sendPayload() })
    await run()
    expect(w.ours()).toHaveLength(1)
    expect(w.sends()).toHaveLength(2)
  })

  it('takes the newest of two that match', async () => {
    const old = w.nextId()
    w.thread.push({ id: old, webhook_id: HOOK, content: '', components: [{ type: 17, components: [{ type: 10, content: `Hello there.\n-# <@${MEMBER}>` }] }], attachments: [] })
    w.script.push(landed)
    const id = w.enqueue({ payload: sendPayload() })
    await run()
    // The old one has the same words, but the one that landed is newer, and is the one taken.
    expect([...w.messages.keys()]).toEqual([w.ours().at(-1).id])
    expect(w.entry(id).state).toBe('sent')
    expect(w.sends()).toHaveLength(1)
  })

  it('reads the words of a message of the form it was sent in, plain as V2, and ignores the space round them', async () => {
    outbox = make({ form: 'plain' })
    w.script.push(landed)
    w.enqueue({ payload: sendPayload() })
    outbox.start()
    await later(5000)
    expect(w.sends()).toHaveLength(1)
    const message = w.ours()[0]
    expect(message.content).toBe(`Hello there.\n-# <@${MEMBER}> · [Open On Site](<${SITE}>)`)
  })

  it('does not send again when it cannot look: the attempt fails, and the next one looks', async () => {
    w.script.push(lost)
    w.lookFails.push(new Upstream('Discord is unreachable.'))
    const id = w.enqueue({ payload: sendPayload() })
    await run(5000)
    expect(w.sends()).toHaveLength(1)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 1, lastError: 'Error: Discord is unreachable.' })
    await later(10_000)
    expect(w.sends().map((c) => c.at - T0)).toEqual([0, 10_000])
    expect(w.ours()).toHaveLength(1)
  })

  it('does not look at a thread for a send that was plainly refused, and sends again at the next attempt after looking', async () => {
    w.script.push(answer(400, { code: 50035 }))
    w.enqueue({ payload: sendPayload() })
    await run(1000)
    expect(w.looks).toEqual([])
  })
})

describe('a stop and a restart never lose a part and never send one twice', () => {
  it('stops between two parts, and the next worker goes on with the next part', async () => {
    const id = w.enqueue({ payload: sendPayload({ source: THREE() }) })
    await run(1000)
    expect(w.ours()).toHaveLength(1)
    await outbox.stop()
    expect(w.entry(id).state).toBe('sending')
    expect(w.entry(id).payload.progress.parts).toHaveLength(1)
    // The second part was about to be sent, and is marked so: a look for it first costs nothing.
    expect(w.entry(id).payload.progress.inflight).toBe(1)
    outbox = make()
    outbox.start()
    await later(20_000)
    expect(w.ours()).toHaveLength(3)
    expect(w.sends()).toHaveLength(3)
    expect(w.entry(id).state).toBe('sent')
    expect(w.parts.get(w.ours()[0].id)).toEqual(w.ours().map((m) => m.id))
  })

  it('waits its 1500 ms after the start before it makes a call that the one before it may have made just before', async () => {
    // An entry left between two parts: the first is in Discord, and nothing says a second is on its way.
    const first = w.nextId()
    w.enqueue({ state: 'sending', payload: sendPayload({ source: THREE(), progress: { form: 'v2', parts: [{ id: first, at: new Date().toISOString(), attachments: [] }], inflight: null } }) })
    outbox = make()
    const startedAt = Date.now()
    outbox.start()
    await later(1499)
    expect(w.calls).toEqual([])
    await later(1)
    expect(w.calls[0].at).toBe(startedAt + 1500)
  })

  it('waits 5 s after the part was noted before it looks for a part that may be in Discord, and sends it when it is not there', async () => {
    w.enqueue({ payload: sendPayload({ source: THREE() }) })
    await run(1000)
    await outbox.stop()
    const noted = w.entries.get('1').payload.progress.inflightAt
    outbox = make()
    outbox.start()
    await later(20_000)
    // The part was noted as about to be sent at T0, when the first part landed: the look waits until noted + 5 s, and finds nothing.
    expect(w.looks[0].at).toBe(noted + 5000)
    expect(w.calls[1].at).toBe(noted + 5000)
  })

  it('waits its first call by the spacing even when it resumes nothing: a call may have gone out before the crash, and which is not known', async () => {
    await run(1000)
    await outbox.stop()
    outbox = make()
    w.enqueue({ payload: sendPayload() })
    const startedAt = Date.now()
    outbox.start()
    await later(1499)
    expect(w.calls).toHaveLength(0)
    await later(1)
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0].at).toBe(startedAt + 1500)
  })

  it('writes down where it is going to send before it does, so a part in flight is known', async () => {
    const id = w.enqueue({ payload: sendPayload() })
    const seen = []
    const inner = w.store.outboxProgress
    w.store.outboxProgress = async (entryId, progress) => {
      seen.push({ sent: w.sends().length, progress: JSON.parse(JSON.stringify(progress)) })
      return inner(entryId, progress)
    }
    await run()
    expect(seen.map((s) => [s.sent, s.progress.inflight, s.progress.parts.length, s.progress.form])).toEqual([
      [0, 0, 0, 'v2'],
      [1, null, 1, 'v2'],
    ])
    expect(w.entry(id).state).toBe('sent')
  })

  it('stops while a send is on its way: the message that comes back is written down, and nothing is lost', async () => {
    const inner = w.fetchImpl
    w.fetchImpl = async (url, init) => {
      const r = await inner(url, init)
      if (init.method === 'POST') await new Promise((resolve) => setTimeout(resolve, 2000))
      return r
    }
    w.webhook = createWebhookClient({ fetchImpl: w.fetchImpl, url: `${API}/webhooks/${HOOK}/${TOKEN}`, apiBase: API, newest: w.discord.newest })
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    outbox = make({ webhook: w.webhook })
    outbox.start()
    await later(2000)
    const stopped = outbox.stop()
    await later(2000)
    await stopped
    expect(w.ours()).toHaveLength(1)
    expect(w.entry(id).payload.progress.parts.map((p) => p.id)).toEqual([w.ours()[0].id])
    expect(w.entry(id).payload.progress.inflight).toBe(1)
    expect(w.entry(id).state).toBe('sending')
    outbox = make({ webhook: w.webhook })
    outbox.start()
    await later(20_000)
    expect(w.ours()).toHaveLength(2)
    expect(w.entry(id).state).toBe('sent')
  })

  it('writes down a part whose note the store did not take before the step of the ladder, and the next try goes on from it, with no look', async () => {
    w.storeFails.outboxProgress = [false, new Error('connection lost')]
    const id = w.enqueue({ payload: sendPayload() })
    await run(4000)
    expect(w.ours()).toHaveLength(1)
    // The note of the part did not reach the store when the part landed: it is written before the entry goes back on the ladder.
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 1 })
    expect(w.entry(id).payload.progress).toMatchObject({ inflight: null, parts: [{ id: w.ours()[0].id }] })
    await later(2000)
    expect(w.sends()).toHaveLength(1)
    expect(w.looks).toEqual([])
    expect(w.entry(id).state).toBe('sent')
    expect(w.ours()).toHaveLength(1)
  })

  it('removes a part whose note the store did not take when the reply then ends for good, though no look at the thread can be made', async () => {
    w.storeFails.outboxProgress = [false, new Error('connection lost')]
    w.lookFails.push(...Array.from({ length: 10 }, () => new Upstream('Discord is unreachable.')))
    w.script.push(null, answer(403, { code: 50001 }))
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    await run(86_400_000)
    expect(w.entry(id)).toMatchObject({ state: 'failed', lastError: 'This post is locked in Discord.' })
    expect(w.ours()).toEqual([])
    expect(w.messages.size).toBe(0)
  })

  it('writes that note once, and not again when the write of the step itself is made again', async () => {
    w.storeFails.outboxProgress = [false, new Error('connection lost')]
    w.storeFails.outboxSet = [new Error('connection lost')]
    const writes = vi.spyOn(w.store, 'outboxProgress')
    const id = w.enqueue({ payload: sendPayload() })
    await run(4000)
    // Before the send, after it (lost), and before the step (whose own write is lost).
    expect(writes).toHaveBeenCalledTimes(3)
    expect(w.entry(id).state).toBe('sending')
    expect(w.entry(id).payload.progress.parts).toHaveLength(1)
    await later(10_000)
    expect(writes).toHaveBeenCalledTimes(3)
    expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 1 })
    expect(w.sends()).toHaveLength(1)
  })

  it('writes no note with the step of the ladder when the store took every note already', async () => {
    w.script.push(answer(400, { code: 50035 }))
    const writes = vi.spyOn(w.store, 'outboxProgress')
    const id = w.enqueue({ payload: sendPayload() })
    await run(4000)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 1 })
    expect(writes).toHaveBeenCalledTimes(1)
  })

  it('looks again for a part that landed, at an attempt after a note that never reached the store', async () => {
    // The first note ("sending part 1") is lost, the send is lost, the resend lands but its answer is refused as a 502: the
    // next attempt, which reads the store afresh, must still know that a part may be in Discord.
    w.script.push({ throws: true }, { ...answer(502), lands: true })
    w.storeFails.outboxProgress = [new Error('connection lost')]
    const id = w.enqueue({ payload: sendPayload() })
    await run(60_000)
    expect(w.ours()).toHaveLength(1)
    expect(w.sends()).toHaveLength(2)
    expect(w.entry(id).state).toBe('sent')
  })

  it('finds a part that landed when the worker died before it could write it down', async () => {
    // The note fails when the part lands, and again when the entry is settled: the worker is stopped before the store takes it.
    w.storeFails.outboxProgress = [false, new Error('connection lost'), new Error('connection lost')]
    const id = w.enqueue({ payload: sendPayload() })
    await run(1000)
    await outbox.stop()
    // What the database holds now is what a crash leaves: the part is in Discord, and the notes say it was being sent.
    expect(w.entry(id).payload.progress).toMatchObject({ inflight: 0, parts: [] })
    outbox = make()
    outbox.start()
    await later(10_000)
    expect(w.sends()).toHaveLength(1)
    expect(w.ours()).toHaveLength(1)
    expect(w.entry(id).state).toBe('sent')
    expect([...w.messages.keys()]).toEqual([w.ours()[0].id])
  })

  it('sends a part that was being sent, and is not in Discord, once', async () => {
    const id = w.enqueue({ state: 'sending', payload: { ...sendPayload(), progress: { form: 'v2', parts: [], inflight: 0 } } })
    await run()
    expect(w.sends()).toHaveLength(1)
    expect(w.ours()).toHaveLength(1)
    expect(w.entry(id).state).toBe('sent')
  })

  it('finds the second part that landed before a crash, and goes on to the third', async () => {
    const first = await (async () => {
      w.enqueue({ payload: sendPayload({ source: THREE() }) })
      await run(1000)
      await outbox.stop()
      return w.ours()[0]
    })()
    // The second part is sent, as the first worker would have, and the crash comes before the notes do.
    const entry = [...w.entries.values()][0]
    entry.payload.progress.inflight = 1
    const fresh = createWebhookClient({ fetchImpl: w.fetchImpl, url: `${API}/webhooks/${HOOK}/${TOKEN}`, apiBase: API, newest: w.discord.newest })
    const second = make()
    void fresh
    void second
    // Let a worker run the part, then cut its notes back to what they were.
    outbox = make()
    outbox.start()
    await later(4600)
    expect(w.ours()).toHaveLength(2)
    entry.state = 'sending'
    entry.payload.progress = { form: 'v2', parts: [{ id: first.id, at: first.timestamp, attachments: [] }], inflight: 1 }
    await outbox.stop()
    outbox = make()
    outbox.start()
    await later(20_000)
    expect(w.sends()).toHaveLength(3)
    expect(w.ours()).toHaveLength(3)
    expect(entry.state).toBe('sent')
  })

  it('takes an entry that was left sending before it takes new ones', async () => {
    const left = w.enqueue({ state: 'sending', payload: sendPayload({ source: 'Left over.' }), nextAt: T0 + 5000 })
    w.enqueue({ payload: sendPayload({ source: 'New.' }), nextAt: T0 })
    await run(10_000)
    expect(w.ours().map((m) => w.textOf(m).split('\n')[0])).toEqual(['Left over.', 'New.'])
    expect(w.entry(left).state).toBe('sent')
  })

  it('ends its waits at a stop, and a stopped worker does nothing more, not even when kicked', async () => {
    w.enqueue({ payload: sendPayload({ source: THREE() }) })
    await run(1000)
    const stopped = outbox.stop()
    await stopped
    const before = w.calls.length
    outbox.kick()
    await later(60_000)
    expect(w.calls).toHaveLength(before)
  })

  it('can be stopped and started again, and stopping twice is as good as once', async () => {
    await run(1000)
    await outbox.stop()
    await outbox.stop()
    outbox.start()
    outbox.start()
    w.enqueue({ payload: sendPayload() })
    outbox.kick()
    await later(5000)
    expect(w.ours()).toHaveLength(1)
  })

  it('stops at once when it is waiting for nothing, and when it was never started', async () => {
    outbox = make()
    await outbox.stop()
    outbox.start()
    await later(0)
    await outbox.stop()
    expect(w.calls).toEqual([])
  })
})

describe('failures that may pass: 5 s, 30 s, 2 min, 10 min, and then failed', () => {
  const refuse = () => answer(400, { code: 50035, message: 'Invalid Form Body' })

  it('tries again at each step of the ladder, and fails the entry when the steps are used up', async () => {
    for (let i = 0; i < 5; i++) w.script.push(refuse())
    const id = w.enqueue({ payload: sendPayload() })
    await run(1)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 1, lastError: 'WebhookError: Discord answered 400 to the webhook send.' })
    expect(w.entry(id).nextAt).toBe(T0 + 5000)
    await later(5000)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 2 })
    expect(w.entry(id).nextAt).toBe(T0 + 5000 + 30_000)
    await later(30_000)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 3 })
    expect(w.entry(id).nextAt).toBe(T0 + 35_000 + 120_000)
    await later(120_000)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 4 })
    expect(w.entry(id).nextAt).toBe(T0 + 155_000 + 600_000)
    await later(600_000)
    expect(w.sends().map((c) => c.at - T0)).toEqual([0, 5000, 35_000, 155_000, 755_000])
    expect(w.entry(id)).toMatchObject({ state: 'failed', lastError: 'Discord did not take this reply. Try again in a little while.' })
    expect(w.ours()).toEqual([])
    await later(86_400_000)
    expect(w.sends()).toHaveLength(5)
    expect(w.events).toEqual([{ at: T0 + 755_000, actor: MEMBER, action: 'failed', postId: THREAD, messageId: null, note: 'Discord did not take this reply. Try again in a little while.' }])
  })

  it('sends it when a later try is taken, and ends with the reply there once', async () => {
    w.script.push(refuse(), refuse(), refuse())
    const id = w.enqueue({ payload: sendPayload() })
    await run(200_000)
    expect(w.sends().map((c) => c.at - T0)).toEqual([0, 5000, 35_000, 155_000])
    expect(w.ours()).toHaveLength(1)
    expect(w.entry(id)).toMatchObject({ state: 'sent', lastError: null })
  })

  it('goes on to the next entry at once, and does not wait out the ladder of the first', async () => {
    w.script.push(refuse())
    w.enqueue({ payload: sendPayload({ source: 'Fails once.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Goes through.' }) })
    await run(1600)
    expect(w.ours().map((m) => w.textOf(m).split('\n')[0])).toEqual(['Goes through.'])
  })

  it('applies to an edit, whose message shows it is on its way until the edit is done or failed', async () => {
    const id = await sentReply('Before.')
    w.calls.length = 0
    for (let i = 0; i < 5; i++) w.script.push(refuse())
    const e = w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: 'After.', mentions: [] } })
    outbox.kick()
    await later(1)
    expect(w.messages.get(id).state).toBe('sending')
    await later(100_000)
    expect(w.entry(e)).toMatchObject({ state: 'pending', attempts: 3 })
    expect(w.messages.get(id).state).toBe('sending')
    await later(700_000)
    expect(w.entry(e)).toMatchObject({ state: 'failed', lastError: 'Discord did not take this edit. Try again in a little while.' })
    expect(w.messages.get(id).state).toBeNull()
    expect(w.messages.get(id).source).toBe('Before.')
  })

  it('applies to a delete, with its own words', async () => {
    const id = await sentReply('Before.')
    for (let i = 0; i < 5; i++) w.script.push(refuse())
    const d = w.enqueue({ kind: 'delete', key: id, payload: { postId: THREAD } })
    outbox.kick()
    await later(900_000)
    expect(w.entry(d)).toMatchObject({ state: 'failed', lastError: 'Discord did not take this delete. Try again in a little while.' })
    expect(w.messages.has(id)).toBe(true)
    expect(w.messages.get(id).state).toBeNull()
  })

  it('applies to the bot too: a failed unarchive is a failed attempt', async () => {
    w.archived = true
    w.discord.setArchived = async () => {
      throw new Upstream('Discord is unreachable.')
    }
    const id = w.enqueue({ payload: sendPayload() })
    await run(100)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 1 })
  })

  it('fails at once an entry that can never be sent, and says so in the words of the site', async () => {
    const bad = w.enqueue({ payload: sendPayload({ source: 5 }) })
    const worse = w.enqueue({ payload: sendPayload({ siteUrl: 'not a link' }) })
    await run(5000)
    for (const id of [bad, worse]) expect(w.entry(id)).toMatchObject({ state: 'failed', attempts: 0, lastError: 'This reply could not be sent.' })
    expect(w.calls).toEqual([])
  })
})

describe('429: not accepted, not an attempt', () => {
  it('sets the entry\'s next try to what Discord asked, without counting it', async () => {
    w.script.push(answer(429, { retry_after: 7.5, global: false }))
    const id = w.enqueue({ payload: sendPayload() })
    await run(1)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 0, lastError: null })
    expect(w.entry(id).nextAt).toBe(T0 + 7500)
    await later(7500)
    expect(w.sends().map((c) => c.at - T0)).toEqual([0, 7500])
    expect(w.entry(id).state).toBe('sent')
  })

  it('never uses up the ladder, however often Discord says wait', async () => {
    for (let i = 0; i < 12; i++) w.script.push(answer(429, { retry_after: 1 }))
    const id = w.enqueue({ payload: sendPayload() })
    await run(60_000)
    expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 0 })
    expect(w.sends()).toHaveLength(13)
    expect(w.ours()).toHaveLength(1)
  })

  it('does not hold the other entries up when it is not global: they go at their own pace', async () => {
    w.script.push(answer(429, { retry_after: 10, global: false }))
    w.enqueue({ payload: sendPayload({ source: 'Limited.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Free.' }) })
    await run(20_000)
    expect(w.sends().map((c) => c.at - T0)).toEqual([0, 1500, 10_000])
    expect(w.ours().map((m) => w.textOf(m).split('\n')[0])).toEqual(['Free.', 'Limited.'])
  })

  it('pauses every webhook call when it is global, for any entry and any kind of call', async () => {
    const edited = await sentReply('Before.')
    w.calls.length = 0
    w.script.push(answer(429, { retry_after: 10, global: true }))
    w.enqueue({ payload: sendPayload({ source: 'Limited.' }) })
    w.enqueue({ kind: 'edit', key: edited, payload: { postId: THREAD, source: 'After.', mentions: [] } })
    w.enqueue({ payload: sendPayload({ source: 'Free.' }) })
    outbox.kick()
    await later(30_000)
    // The first was refused at the start; nothing else goes out before the pause is over, and then the spacing holds.
    expect(w.calls.map((c) => [c.kind, (c.at - T0) % 100_000_000 >= 0 ? c.at - w.calls[0].at : 0])).toEqual([
      ['send', 0],
      ['edit', 10_000],
      ['send', 11_500],
      ['send', 13_000],
    ])
  })

  it('takes the header of the answer too, and a global pause only as long as it was asked', async () => {
    w.script.push({ status: 429, body: {}, headers: { 'Retry-After': '3', 'X-RateLimit-Global': 'true' } })
    w.enqueue({ payload: sendPayload({ source: 'A.' }) })
    w.enqueue({ payload: sendPayload({ source: 'B.' }) })
    await run(20_000)
    expect(w.sends().map((c) => c.at - T0)).toEqual([0, 3000, 4500])
  })

  it('applies to an edit and a delete, which are tried again at that time and still count for nothing', async () => {
    const id = await sentReply('Before.')
    w.calls.length = 0
    w.script.push(answer(429, { retry_after: 5 }), answer(429, { retry_after: 5 }))
    const e = w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: 'After.', mentions: [] } })
    outbox.kick()
    await later(20_000)
    expect(w.entry(e)).toMatchObject({ state: 'sent', attempts: 0 })
    expect(w.calls.map((c) => c.at - w.calls[0].at)).toEqual([0, 5000, 10_000])
  })
})

describe('blocked: never tried again, and two in an hour stop everything for an hour', () => {
  const block = (code = 200000) => answer(400, { code, message: 'blocked' })

  it.each([200000, 200001, 240000])('ends the entry as blocked on code %i, and never sends it again', async (code) => {
    w.script.push(block(code))
    const id = w.enqueue({ payload: sendPayload() })
    await run(86_400_000)
    expect(w.sends()).toHaveLength(1)
    expect(w.entry(id)).toMatchObject({ state: 'blocked', lastError: 'Discord blocked this reply.' })
    expect(w.ours()).toEqual([])
    expect(w.events).toEqual([{ at: T0, actor: MEMBER, action: 'blocked', postId: THREAD, messageId: null, note: 'send' }])
  })

  it('blocks an edit with its own words, and puts the message back as it was', async () => {
    const id = await sentReply('Before.')
    w.script.push(block())
    const e = w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: 'After.', mentions: [] } })
    outbox.kick()
    await later(10_000)
    expect(w.entry(e)).toMatchObject({ state: 'blocked', lastError: 'Discord blocked this edit.' })
    expect(w.messages.get(id).source).toBe('Before.')
    expect(w.events.find((ev) => ev.action === 'blocked')).toMatchObject({ messageId: id, note: 'edit' })
    // The edit that restores it has been through, so nothing is on its way.
    expect(w.messages.get(id).state).toBeNull()
    expect(w.textOf(w.ours()[0])).toBe(`Before.\n-# <@${MEMBER}>`)
  })

  it('blocks a delete with its own words', async () => {
    const id = await sentReply('Before.')
    w.script.push(block())
    const d = w.enqueue({ kind: 'delete', key: id, payload: { postId: THREAD } })
    outbox.kick()
    await later(10_000)
    expect(w.entry(d)).toMatchObject({ state: 'blocked', lastError: 'Discord blocked this delete.' })
    expect(w.messages.get(id).state).toBe('blocked')
  })

  it('does not pause for one block, and goes on to the next entry', async () => {
    w.script.push(block())
    w.enqueue({ payload: sendPayload({ source: 'Blocked.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Fine.' }) })
    await run(5000)
    expect(outbox.sendingPausedUntil()).toBeNull()
    expect(w.ours().map((m) => w.textOf(m).split('\n')[0])).toEqual(['Fine.'])
  })

  it('pauses everything for an hour at the second block within an hour, and then goes on', async () => {
    w.script.push(block(), block())
    w.enqueue({ payload: sendPayload({ source: 'Blocked A.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Blocked B.' }) })
    const c = w.enqueue({ payload: sendPayload({ source: 'After.' }) })
    await run(10_000)
    expect(w.sends()).toHaveLength(2)
    const until = T0 + 1500 + 3_600_000
    expect(outbox.sendingPausedUntil()).toBe(until)
    await later(3_591_499)
    expect(Date.now()).toBe(until - 1)
    expect(w.sends()).toHaveLength(2)
    expect(outbox.sendingPausedUntil()).toBe(until)
    await later(1)
    expect(w.sends().map((s) => s.at)).toEqual([T0, T0 + 1500, until])
    expect(w.entry(c).state).toBe('sent')
    expect(outbox.sendingPausedUntil()).toBeNull()
  })

  it.each([
    [240000, 240000],
    [200000, 240000],
    [240000, 200001],
  ])('counts a block for harmful links (240000) towards the breaker like any other: codes %i and %i pause everything for an hour', async (first, second) => {
    w.script.push(block(first), block(second))
    w.enqueue({ payload: sendPayload({ source: 'Blocked A.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Blocked B.' }) })
    const c = w.enqueue({ payload: sendPayload({ source: 'After.' }) })
    await run(10_000)
    expect(w.sends()).toHaveLength(2)
    const until = T0 + 1500 + 3_600_000
    expect(outbox.sendingPausedUntil()).toBe(until)
    await later(3_590_000)
    expect(w.entry(c).state).toBe('pending')
    await later(2000)
    expect(w.entry(c).state).toBe('sent')
  })

  it('pauses edits and deletes as well, and a kick does not start anything in the pause', async () => {
    const id = await sentReply('Before.')
    w.calls.length = 0
    w.script.push(block(), block())
    w.enqueue({ payload: sendPayload({ source: 'Blocked A.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Blocked B.' }) })
    outbox.kick()
    await later(5000)
    w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: 'After.', mentions: [] } })
    outbox.kick()
    await later(3_000_000)
    outbox.kick()
    await later(500_000)
    expect(w.calls.map((c) => c.kind)).toEqual(['send', 'send'])
    await later(200_000)
    expect(w.calls.map((c) => c.kind)).toEqual(['send', 'send', 'edit'])
  })

  it('does not pause for two blocks more than an hour apart, but does for two just inside the hour', async () => {
    w.script.push(block(), block())
    w.enqueue({ payload: sendPayload({ source: 'Blocked A.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Blocked B.' }), nextAt: T0 + 3_600_000 })
    w.enqueue({ payload: sendPayload({ source: 'After.' }), nextAt: T0 + 3_600_000 })
    await run(3_700_000)
    expect(w.ours().map((m) => w.textOf(m).split('\n')[0])).toEqual(['After.'])
    expect(w.sends().map((s) => s.at - T0)).toEqual([0, 3_600_000, 3_601_500])
    expect(outbox.sendingPausedUntil()).toBeNull()
  })

  it('counts the block of the second at 3,599,999 ms after the first, which is inside the hour', async () => {
    w.script.push(block(), block())
    w.enqueue({ payload: sendPayload({ source: 'Blocked A.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Blocked B.' }), nextAt: T0 + 3_599_999 })
    await run(3_600_000)
    expect(outbox.sendingPausedUntil()).toBe(T0 + 3_599_999 + 3_600_000)
  })

  it('needs two new blocks to pause again, not one, once a pause is over', async () => {
    w.script.push(block(), block(), block())
    w.enqueue({ payload: sendPayload({ source: 'Blocked A.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Blocked B.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Blocked C.' }), nextAt: T0 + 4_000_000 })
    w.enqueue({ payload: sendPayload({ source: 'Fine.' }), nextAt: T0 + 4_000_000 })
    await run(4_100_000)
    expect(outbox.sendingPausedUntil()).toBeNull()
    expect(w.ours().map((m) => w.textOf(m).split('\n')[0])).toEqual(['Fine.'])
  })

  it('builds the pause again after a restart, from the blocks that were noted', async () => {
    w.script.push(block(), block())
    w.enqueue({ payload: sendPayload({ source: 'Blocked A.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Blocked B.' }) })
    await run(5000)
    const until = outbox.sendingPausedUntil()
    expect(until).toBe(T0 + 1500 + 3_600_000)
    await outbox.stop()
    outbox = make()
    w.enqueue({ payload: sendPayload({ source: 'After.' }) })
    outbox.start()
    await later(1_000_000)
    expect(outbox.sendingPausedUntil()).toBe(until)
    expect(w.sends()).toHaveLength(2)
    await later(2_700_000)
    expect(w.sends()).toHaveLength(3)
  })

  it('reads back only the blocks of the last hour, and in order', async () => {
    w.events.push({ at: T0 - 3 * 3_600_000, action: 'blocked' }, { at: T0 - 3_000_000, action: 'blocked' }, { at: T0 - 100, action: 'send' })
    outbox = make()
    outbox.start()
    await later(10)
    // One block in the hour is no pause, the old one does not count with it, and a send is no block.
    expect(outbox.sendingPausedUntil()).toBeNull()
    await outbox.stop()
    w.events.push({ at: T0 - 600_000, action: 'blocked' })
    outbox = make()
    outbox.start()
    await later(10)
    expect(outbox.sendingPausedUntil()).toBe(T0 - 600_000 + 3_600_000)
  })

  it('does not count a block twice when it has to read the store again', async () => {
    w.events.push({ at: T0 - 600_000, action: 'blocked' })
    w.storeFails.outboxInterrupted = [new Error('connection lost')]
    outbox = make()
    outbox.start()
    await later(6000)
    expect(outbox.sendingPausedUntil()).toBeNull()
  })
})

describe('fatal: the webhook itself is refused', () => {
  const REFUSED = 'The Librarius webhook was refused (status 401): run librariusWebhookSetupRun to check it.'

  it('stops everything, keeps the entry as it was, and says so', async () => {
    w.script.push(answer(401, { code: 0, message: '401: Unauthorized' }))
    const a = w.enqueue({ payload: sendPayload({ source: 'A.' }) })
    const b = w.enqueue({ payload: sendPayload({ source: 'B.' }) })
    await run(86_400_000)
    expect(w.calls).toHaveLength(1)
    expect(outbox.webhookRefused()).toEqual({ status: 401, text: REFUSED })
    expect(w.entry(a)).toMatchObject({ state: 'pending', attempts: 0, lastError: null })
    expect(w.entry(b).state).toBe('pending')
    outbox.kick()
    await later(86_400_000)
    expect(w.calls).toHaveLength(1)
  })

  it('refuses on a 404 that is not a thread or a message, with that status', async () => {
    w.script.push(answer(404, { code: 10015, message: 'Unknown Webhook' }))
    w.enqueue({ payload: sendPayload() })
    await run(5000)
    expect(outbox.webhookRefused()).toEqual({ status: 404, text: 'The Librarius webhook was refused (status 404): run librariusWebhookSetupRun to check it.' })
  })

  it('also stops for a refusal of an edit or a delete', async () => {
    const id = await sentReply('Before.')
    w.script.push(answer(401, {}))
    w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: 'After.', mentions: [] } })
    outbox.kick()
    await later(5000)
    expect(outbox.webhookRefused()).toMatchObject({ status: 401 })
    expect(w.messages.get(id).state).toBe('sending')
  })

  it('goes on with the entries when the site is restarted with a webhook that works', async () => {
    w.script.push(answer(401, {}))
    const a = w.enqueue({ payload: sendPayload({ source: 'A.' }) })
    const b = w.enqueue({ payload: sendPayload({ source: 'B.' }) })
    await run(5000)
    await outbox.stop()
    outbox = make()
    expect(outbox.webhookRefused()).toBeNull()
    outbox.start()
    await later(10_000)
    expect(w.ours().map((m) => w.textOf(m).split('\n')[0])).toEqual(['A.', 'B.'])
    for (const id of [a, b]) expect(w.entry(id).state).toBe('sent')
  })

  it('sends nothing more even for a part that was half way', async () => {
    const id = w.enqueue({ payload: sendPayload({ source: THREE() }) })
    w.script.push(null, answer(401, {}))
    await run(86_400_000)
    expect(w.ours()).toHaveLength(1)
    expect(w.entry(id)).toMatchObject({ state: 'pending' })
    expect(w.entry(id).payload.progress.parts).toHaveLength(1)
    await outbox.stop()
    outbox = make()
    outbox.start()
    await later(30_000)
    expect(w.ours()).toHaveLength(3)
    expect(w.sends()).toHaveLength(4)
  })
})

describe('a thread that is gone', () => {
  const gone = () => answer(404, { code: 10003, message: 'Unknown Channel' })

  it('fails a reply, which is not tried again', async () => {
    w.script.push(gone())
    const id = w.enqueue({ payload: sendPayload() })
    await run(86_400_000)
    expect(w.entry(id)).toMatchObject({ state: 'failed', lastError: 'This post is gone from Discord.' })
    expect(w.sends()).toHaveLength(1)
    expect(outbox.webhookRefused()).toBeNull()
  })

  it('ends an edit by removing the message from the store, calling nothing else', async () => {
    const id = await sentReply(TWO())
    w.calls.length = 0
    w.script.push(gone())
    const e = w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: TWO('new', 'new'), mentions: [] } })
    outbox.kick()
    await later(20_000)
    expect(w.entry(e).state).toBe('sent')
    expect(w.messages.has(id)).toBe(false)
    expect(w.parts.size).toBe(0)
    expect(w.calls).toHaveLength(1)
    expect(w.tombstones).toEqual([id])
    expect(w.events.at(-1)).toMatchObject({ action: 'delete', postId: THREAD, messageId: id, note: 'This post is gone from Discord.' })
  })

  it('ends a delete by removing the message from the store, the parts it has included', async () => {
    const id = await sentReply(TWO())
    w.calls.length = 0
    w.script.push(gone())
    const d = w.enqueue({ kind: 'delete', key: id, payload: { postId: THREAD } })
    outbox.kick()
    await later(20_000)
    expect(w.entry(d).state).toBe('sent')
    expect(w.messages.has(id)).toBe(false)
    expect(w.calls).toHaveLength(1)
  })

  it('ends a delete of a message that is no longer stored, which the gateway had left parts of to remove', async () => {
    const p = w.nextId()
    const d = w.enqueue({ kind: 'delete', key: p, payload: { postId: THREAD, partIds: [p] } })
    w.script.push(gone())
    await run(5000)
    expect(w.entry(d).state).toBe('sent')
    expect(w.entry(d).payload.progress.partIds).toEqual([p])
  })
})

describe('the links forward, which come last', () => {
  const refuse = () => answer(400, { code: 50035 })

  it('are tried again like any call when they fail, with no part sent twice', async () => {
    w.script.push(null, null, null, refuse())
    const id = w.enqueue({ payload: sendPayload({ source: THREE() }) })
    await run(20_000)
    expect(w.sends()).toHaveLength(3)
    expect(w.calls.map((c) => c.kind)).toEqual(['send', 'send', 'send', 'edit', 'edit'])
    expect(w.calls[4].at - w.calls[3].at).toBe(5000)
    expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 1 })
    expect(w.ours()).toHaveLength(3)
    expect(w.events[0].note).toBe('3 parts')
  })

  it('are given up when the steps of the ladder are used up, and the reply is stored without them', async () => {
    w.script.push(null, null, null, refuse(), refuse(), refuse(), refuse(), refuse())
    const id = w.enqueue({ payload: sendPayload({ source: THREE() }) })
    await run(1_000_000)
    expect(w.calls.map((c) => c.kind)).toEqual(['send', 'send', 'send', 'edit', 'edit', 'edit', 'edit', 'edit'])
    expect(w.entry(id).state).toBe('sent')
    expect(w.parts.get(w.ours()[0].id)).toHaveLength(3)
    expect(w.events[0].note).toBe('3 parts, no links')
    expect(w.textOf(w.ours()[0])).not.toContain('continues')
  })

  it('are given up at once when Discord blocks them, and the block counts for the breaker', async () => {
    w.script.push(null, null, answer(400, { code: 200000 }))
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    w.enqueue({ payload: sendPayload({ source: `${x(3000)}b\n\n${x(3000)}b` }), nextAt: T0 + 10_000 })
    w.script.push(null, null, answer(400, { code: 200001 }))
    await run(30_000)
    expect(w.entry(id)).toMatchObject({ state: 'sent', lastError: null })
    expect(w.events.find((e) => e.action === 'send').note).toBe('2 parts, no links')
    expect(outbox.sendingPausedUntil()).toBe(T0 + 13_000 + 3_600_000)
  })

  it('end the reply with the first part gone: the parts that were sent are removed, and nothing is stored', async () => {
    w.script.push(null, null)
    const id = w.enqueue({ payload: sendPayload({ source: THREE() }) })
    // The third part is sent; before the links, a moderator deletes the first.
    const real = w.fetchImpl
    w.fetchImpl = async (url, init) => {
      if (init.method === 'PATCH') w.thread.splice(0, 1)
      return real(url, init)
    }
    w.webhook = createWebhookClient({ fetchImpl: w.fetchImpl, url: `${API}/webhooks/${HOOK}/${TOKEN}`, apiBase: API, newest: w.discord.newest })
    await run(30_000, { webhook: w.webhook })
    expect(w.ours()).toEqual([])
    expect(w.messages.size).toBe(0)
    expect(w.entry(id).state).toBe('sent')
    expect(w.calls.filter((c) => c.kind === 'remove')).toHaveLength(3)
  })

  it('stop the worker when the webhook is refused, as every call does, and the reply is finished after a restart', async () => {
    w.script.push(null, null, answer(401, {}))
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    // (the first of two parts, the second, and then the links, which are refused)
    w.script.length = 0
    w.script.push(null, answer(401, {}))
    await run(10_000)
    expect(outbox.webhookRefused()).toMatchObject({ status: 401 })
    await outbox.stop()
    outbox = make()
    outbox.start()
    await later(20_000)
    expect(w.entry(id).state).toBe('sent')
    expect(w.ours()).toHaveLength(2)
  })

  it('fail the reply when the thread is gone, which nothing is stored for', async () => {
    w.script.push(null, null)
    const real = w.fetchImpl
    w.fetchImpl = async (url, init) => (init.method === 'PATCH' ? new Response(JSON.stringify({ code: 10003 }), { status: 404 }) : real(url, init))
    w.webhook = createWebhookClient({ fetchImpl: w.fetchImpl, url: `${API}/webhooks/${HOOK}/${TOKEN}`, apiBase: API, newest: w.discord.newest })
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    await run(10_000, { webhook: w.webhook })
    expect(w.entry(id)).toMatchObject({ state: 'failed', lastError: 'This post is gone from Discord.' })
  })
})

describe('a thread that is archived', () => {
  it('is unarchived through the bot, the send made again, and the thread archived again once the entry is done', async () => {
    w.archived = true
    const id = w.enqueue({ payload: sendPayload() })
    await run()
    expect(w.bot.map((b) => [b.kind, b.threadId, b.archived])).toEqual([
      ['archive', THREAD, false],
      ['archive', THREAD, true],
    ])
    expect(w.sends().map((c) => c.at - T0)).toEqual([0, 1500])
    expect(w.ours()).toHaveLength(1)
    expect(w.archived).toBe(true)
    expect(w.entry(id).state).toBe('sent')
  })

  it('unarchives once for all the parts of a reply and archives once at the end', async () => {
    w.archived = true
    w.enqueue({ payload: sendPayload({ source: THREE() }) })
    await run()
    expect(w.bot.map((b) => b.archived)).toEqual([false, true])
    expect(w.ours()).toHaveLength(3)
    expect(w.archived).toBe(true)
  })

  it('does not touch a thread that is not archived', async () => {
    await sentReply('Hello.')
    expect(w.bot).toEqual([])
  })

  it('does the same for an edit and for a delete', async () => {
    const id = await sentReply('Before.')
    w.archived = true
    w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: 'After.', mentions: [] } })
    outbox.kick()
    await later(10_000)
    expect(w.textOf(w.ours()[0])).toContain('After.')
    expect(w.bot.map((b) => b.archived)).toEqual([false, true])
    w.bot.length = 0
    w.enqueue({ kind: 'delete', key: id, payload: { postId: THREAD } })
    outbox.kick()
    await later(10_000)
    expect(w.ours()).toEqual([])
    expect(w.bot.map((b) => b.archived)).toEqual([false, true])
  })

  it('fails the entry for good when the bot may not unarchive it, whatever else it tries', async () => {
    w.archived = true
    w.locked = true
    const id = w.enqueue({ payload: sendPayload() })
    await run(86_400_000)
    expect(w.entry(id)).toMatchObject({ state: 'failed', attempts: 0, lastError: 'This post is locked in Discord.' })
    expect(w.bot.map((b) => b.archived)).toEqual([false])
    expect(w.sends()).toHaveLength(1)
  })

  it('treats a thread that is archived again at once as a failed attempt, and archives it again after it', async () => {
    w.script.push(answer(400, { code: 50083 }), answer(400, { code: 50083 }))
    const id = w.enqueue({ payload: sendPayload() })
    await run(2000)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 1 })
    expect(w.bot.map((b) => b.archived)).toEqual([false, true])
    await later(10_000)
    expect(w.entry(id).state).toBe('sent')
  })

  it('does not let an archive that fails undo the entry', async () => {
    w.archived = true
    const real = w.discord.setArchived
    w.discord.setArchived = async (t, a) => {
      if (a) throw new Upstream('Discord is unreachable.')
      return real(t, a)
    }
    const id = w.enqueue({ payload: sendPayload() })
    await run()
    expect(w.entry(id).state).toBe('sent')
  })

  it('unarchives for an entry that fails afterwards, and leaves the thread as it found it', async () => {
    w.archived = true
    w.script.push(answer(400, { code: 50083 }), answer(400, { code: 50035 }))
    const id = w.enqueue({ payload: sendPayload() })
    await run(2000)
    expect(w.entry(id).attempts).toBe(1)
    expect(w.bot.map((b) => b.archived)).toEqual([false, true])
  })

  describe('for a message the bot deletes there', () => {
    // The bot's deletes are unarchived for as the webhook's calls are: a message a person wrote, the parts of a reply of an older webhook, and
    // what an old webhook sent of a reply that is begun again.
    const remove = (key) => w.enqueue({ kind: 'delete', key, payload: { postId: THREAD } })
    const person = () => {
      const human = w.nextId()
      w.thread.push({ id: human, webhook_id: null, content: 'A person wrote this.', attachments: [] })
      w.messages.set(human, { id: human, origin: 'discord', postId: THREAD, authorId: MEMBER_2, source: null, layout: null, state: null })
      return human
    }
    async function olderReply() {
      const id = await sentReply(TWO())
      w.messages.get(id).webhookId = OLD_HOOK
      for (const m of w.thread) if (w.parts.get(id).includes(m.id)) m.webhook_id = OLD_HOOK
      w.calls.length = 0
      w.bot.length = 0
      return id
    }
    /** A reply that an old webhook began: its first part is in the thread. */
    const begunElsewhere = () => {
      const first = { id: w.nextId(), webhook_id: OLD_HOOK, content: '', components: [{ type: 17, components: [{ type: 10, content: 'old words' }] }], timestamp: new Date(T0).toISOString(), attachments: [] }
      w.thread.push(first)
      const id = w.enqueue({ state: 'sending', payload: sendPayload({ progress: { form: 'v2', webhookId: OLD_HOOK, parts: [{ id: first.id, at: first.timestamp, attachments: [] }], inflight: null } }) })
      return { id, first }
    }
    const botLog = () => w.bot.map((b) => (b.kind === 'archive' ? ['archive', b.archived] : ['delete', b.messageId]))

    it('unarchives the post to delete a message a person wrote, deletes it, and archives the post again', async () => {
      const human = person()
      w.archived = true
      const d = remove(human)
      await run(5000)
      expect(botLog()).toEqual([
        ['delete', human],
        ['archive', false],
        ['delete', human],
        ['archive', true],
      ])
      expect(w.thread).toEqual([])
      expect(w.messages.has(human)).toBe(false)
      expect(w.entry(d)).toMatchObject({ state: 'sent', attempts: 0 })
      expect(w.archived).toBe(true)
      expect(w.calls).toEqual([])
    })

    it('unarchives once for every part of a reply of an older webhook, and archives once at the end', async () => {
      const id = await olderReply()
      const parts = [...w.parts.get(id)]
      w.archived = true
      const d = remove(id)
      outbox.kick()
      await later(30_000)
      expect(botLog()).toEqual([
        ['delete', parts[0]],
        ['archive', false],
        ['delete', parts[0]],
        ['delete', parts[1]],
        ['archive', true],
      ])
      expect(w.thread.filter((m) => parts.includes(m.id))).toEqual([])
      expect(w.messages.has(id)).toBe(false)
      expect(w.entry(d)).toMatchObject({ state: 'sent', attempts: 0 })
      expect(w.archived).toBe(true)
      expect(w.calls).toEqual([])
    })

    it('unarchives to remove what an old webhook sent of a reply that is begun again, sends the reply, and archives once at the end', async () => {
      const { id, first } = begunElsewhere()
      w.archived = true
      await run(30_000)
      expect(botLog()).toEqual([
        ['delete', first.id],
        ['archive', false],
        ['delete', first.id],
        ['archive', true],
      ])
      expect(w.thread.some((m) => m.id === first.id)).toBe(false)
      expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 0 })
      expect(w.ours()).toHaveLength(1)
      expect(w.archived).toBe(true)
    })

    it.each([
      ['a message a person wrote', async () => ({ d: remove(person()) })],
      ['the parts of a reply of an older webhook', async () => ({ d: remove(await olderReply()) })],
      ['what an old webhook sent of a reply that is begun again', async () => ({ d: begunElsewhere().id })],
    ])('fails for good, with the words of a locked post, when the bot may not unarchive the post: %s', async (_, queue) => {
      const { d } = await queue()
      const before = [...w.thread]
      w.archived = true
      w.locked = true
      await run(86_400_000)
      expect(w.entry(d)).toMatchObject({ state: 'failed', attempts: 0, lastError: 'This post is locked in Discord.' })
      // Asked to unarchive, refused, and so never archived again. (The cleanup of a reply begun again asks once more, and fails the same way.)
      expect(botLog().slice(0, 2)).toEqual([
        ['delete', expect.any(String)],
        ['archive', false],
      ])
      expect(w.bot.filter((b) => b.kind === 'archive' && b.archived)).toEqual([])
      expect(w.thread).toEqual(before)
      expect(w.calls).toEqual([])
    })

    it('treats a post that is archived again at once as a failed attempt, and archives it again after it', async () => {
      const human = person()
      const real = w.discord.deleteMessage
      let refusals = 2
      w.discord.deleteMessage = async (...args) => {
        if (refusals-- > 0) throw archivedRefusal()
        return real(...args)
      }
      const d = remove(human)
      await run(2000)
      expect(w.entry(d)).toMatchObject({ state: 'pending', attempts: 1 })
      expect(botLog()).toEqual([
        ['archive', false],
        ['archive', true],
      ])
      await later(10_000)
      expect(w.entry(d).state).toBe('sent')
      expect(w.thread).toEqual([])
      expect(w.archived).toBe(true)
    })

    it.each([
      ['another refusal of a 400', () => botRefusal(400, 50035)],
      ['the code of an archived post with another status', () => botRefusal(403, 50083)],
      ['a refusal with no code', () => new Upstream('Discord answered 400 for a message delete.')],
      ['an error that is no Upstream, with that status and code', () => Object.assign(new Error('Discord answered 400 for a message delete.'), { status: 400, code: 50083 })],
    ])('does not take %s for an archived post: nothing is unarchived, and the attempt fails', async (_, refusal) => {
      const human = person()
      const real = w.discord.deleteMessage
      let refusals = 1
      w.discord.deleteMessage = async (...args) => {
        if (refusals-- > 0) throw refusal()
        return real(...args)
      }
      const d = remove(human)
      await run(2000)
      expect(w.bot).toEqual([])
      expect(w.entry(d)).toMatchObject({ state: 'pending', attempts: 1 })
      await later(10_000)
      expect(w.entry(d).state).toBe('sent')
      expect(w.thread).toEqual([])
    })
  })
})

describe('the store failing under the worker', () => {
  it('looks again in five seconds when it cannot claim an entry', async () => {
    w.storeFails.claimOutbox = [new Error('connection lost')]
    const id = w.enqueue({ payload: sendPayload() })
    outbox = make()
    outbox.start()
    await later(4999)
    expect(w.calls).toEqual([])
    await later(1)
    expect(w.entry(id).state).toBe('sent')
    // The clock began 1500 ms before T0, and the spacing from the start had passed by the time it looked again.
    expect(w.calls[0].at).toBe(T0 - 1500 + 5000)
  })

  it('looks again in five seconds when it cannot read what is due next', async () => {
    w.storeFails.outboxNextAt = [new Error('connection lost')]
    outbox = make()
    outbox.start()
    await later(100)
    w.enqueue({ payload: sendPayload(), nextAt: T0 + 2000 })
    await later(4899)
    expect(w.calls).toEqual([])
    await later(1)
    expect(w.calls).toHaveLength(1)
  })

  it('keeps an entry it could not settle, and settles it when it can, without sending again', async () => {
    w.storeFails.finishSend = [new Error('connection lost')]
    w.storeFails.outboxSet = [new Error('connection lost')]
    const id = w.enqueue({ payload: sendPayload() })
    await run(4999)
    // The store failed under the entry, and then under the write that puts it on the ladder: it stays as it is.
    expect(w.entry(id).state).toBe('sending')
    expect(w.ours()).toHaveLength(1)
    await later(1)
    // The ladder step was decided when the store failed, so the entry was due when it could be written, and is sent (stored) now.
    expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 1 })
    expect(w.sends()).toHaveLength(1)
  })

  it('does not lose a block when the store fails while it notes it', async () => {
    w.script.push(answer(400, { code: 200000 }))
    w.storeFails.outboxSet = [new Error('connection lost')]
    const id = w.enqueue({ payload: sendPayload() })
    await run(6000)
    expect(w.entry(id).state).toBe('blocked')
    expect(w.sends()).toHaveLength(1)
  })

  it('takes up a reply whose claim was made when the answer to it was lost, at its next look, with no restart', async () => {
    w.storeFailsAfter.claimOutbox = [new Error('connection lost')]
    const id = w.enqueue({ payload: sendPayload() })
    outbox = make()
    outbox.start()
    await later(4999)
    expect(w.entry(id).state).toBe('sending')
    expect(w.calls).toEqual([])
    await later(1)
    expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 0 })
    expect(w.ours()).toHaveLength(1)
    expect(w.calls[0].at).toBe(T0 - 1500 + 5000)
  })

  it('does the same for an edit, whose message shows that it is on its way until it is done', async () => {
    const key = await sentReply('Before.')
    w.storeFailsAfter.claimOutbox = [new Error('connection lost')]
    const id = w.enqueue({ kind: 'edit', key, payload: { postId: THREAD, source: 'After.', mentions: [] } })
    outbox.kick()
    await later(4999)
    expect(w.messages.get(key).state).toBe('sending')
    await later(1)
    expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 0 })
    expect(w.messages.get(key)).toMatchObject({ state: null, source: 'After.' })
    expect(w.textOf(w.ours()[0])).toContain('After.')
  })

  it('reads the entries left sending again after a failure of the store, once, and not when it has just read them', async () => {
    const reads = vi.spyOn(w.store, 'outboxInterrupted')
    w.storeFails.outboxHold = [new Error('connection lost')]
    outbox = make()
    outbox.start()
    await later(5100)
    // The start failed before it read them, and read them when it was made again: once.
    expect(reads).toHaveBeenCalledTimes(1)
    w.storeFails.claimOutbox = [new Error('connection lost')]
    outbox.kick()
    await later(5100)
    expect(reads).toHaveBeenCalledTimes(2)
    outbox.kick()
    await later(5100)
    expect(reads).toHaveBeenCalledTimes(2)
  })

  it('starts again once the store can be read, and takes up what was left sending', async () => {
    w.storeFails.blockedSince = [new Error('connection lost')]
    const id = w.enqueue({ state: 'sending', payload: sendPayload() })
    outbox = make()
    outbox.start()
    await later(4000)
    expect(w.calls).toEqual([])
    await later(3000)
    expect(w.entry(id).state).toBe('sent')
    // A call may just have gone out before the stop that left the entry: the first waits its 1500 ms, from when it began again (the clock began 1500 ms before T0).
    expect(w.calls[0].at).toBe(T0 - 1500 + 5000 + 1500)
  })
})

describe('an edit', () => {
  const edit = (key, source, over = {}) => w.enqueue({ kind: 'edit', key, payload: { postId: THREAD, source, mentions: [], ...over } })
  const text = (m) => w.textOf(m)

  it('edits the part that is there, in place, without its name or picture, and updates the message', async () => {
    const id = await sentReply('Before.')
    w.calls.length = 0
    const e = edit(id, 'After, with <@200000000000000407>.', { mentions: [MENTIONED] })
    outbox.kick()
    await later(5000)
    expect(w.calls.map((c) => [c.kind, c.messageId])).toEqual([['edit', id]])
    expect(w.calls[0].body.username).toBeUndefined()
    expect(w.calls[0].body.avatar_url).toBeUndefined()
    expect(w.calls[0].body.attachments).toBeUndefined()
    expect(w.calls[0].body.allowed_mentions).toEqual({ parse: [], users: [MENTIONED] })
    expect(text(w.ours()[0])).toBe(`After, with <@200000000000000407>.\n-# <@${MEMBER}>`)
    expect(w.messages.get(id)).toMatchObject({ source: 'After, with <@200000000000000407>.', content: 'After, with <@200000000000000407>.', state: null })
    expect(w.messages.get(id).editedAt).toBe(w.calls[0].at)
    expect(w.parts.get(id)).toEqual([id])
    expect(w.entry(e).state).toBe('sent')
    expect(w.events.at(-1)).toEqual({ at: w.calls[0].at, actor: MEMBER, action: 'edit', postId: THREAD, messageId: id, note: '1 part' })
  })

  it('keeps who wrote it, how it was laid out and where it answers, from the message and not the edit', async () => {
    const replyTo = { messageId: '200000000000000430', authorId: REPLIED, url: 'https://discord.com/channels/200000000000000403/200000000000000404/200000000000000430' }
    const id = await sentReply('Before.', { replyTo, username: 'Other Name' })
    edit(id, 'After.')
    outbox.kick()
    await later(5000)
    expect(text(w.ours()[0])).toBe(`-# ↪ <@${REPLIED}> [jump](<${replyTo.url}>)\nAfter.\n-# <@${MEMBER}>`)
    expect(w.messages.get(id).replyTo).toBe('200000000000000430')
    expect(w.messages.get(id).authorName).toBe('Other Name')
    expect(w.calls.at(-1).body.username).toBeUndefined()
  })

  it('edits every part of a reply in place when it stays as many, and none is added or removed', async () => {
    const id = await sentReply(THREE('a', 'b', 'c'))
    const ids = w.ours().map((m) => m.id)
    w.calls.length = 0
    edit(id, THREE('A', 'B', 'C'))
    outbox.kick()
    await later(20_000)
    expect(w.calls.map((c) => [c.kind, c.messageId])).toEqual(ids.map((m) => ['edit', m]))
    expect(gaps()).toEqual([1500, 1500])
    expect(w.ours().map((m) => m.id)).toEqual(ids)
    expect(w.ours().map((m) => text(m).match(/\*\*\d\/3\*\* (\w)/)[1])).toEqual(['A', 'B', 'C'])
    // The links forward are in the first from the start: every id is known.
    expect(text(w.ours()[0])).toContain(`[2/3](<https://discord.com/channels/${GUILD}/${THREAD}/${ids[1]}>)`)
    expect(w.parts.get(id)).toEqual(ids)
  })

  describe('the links forward of an edit, both ways', () => {
    // The first part is edited in place, and once more to carry the links when the reply grew: an edit that keeps the number of parts, or
    // shortens the reply, makes no second edit of it, and writes no 'links' note. Example by example, so that each side is taken every run.
    it.each([
      ['one part to one', 'Short.', 'Shorter.', 1, false],
      ['two parts to two', TWO('a', 'b'), TWO('c', 'd'), 1, false],
      ['three parts to two', THREE('a', 'b', 'c'), TWO('a', 'b'), 1, false],
      ['two parts to one', TWO('a', 'b'), 'Short.', 1, false],
      ['one part to two', 'Short.', TWO('a', 'b'), 2, true],
      ['two parts to three', TWO('a', 'b'), THREE('a', 'b', 'c'), 2, true],
    ])('from %s: the first part is edited %i time(s), and the links are written down: %s', async (_, before, after, editsOfFirst, linked) => {
      const id = await sentReply(before)
      w.calls.length = 0
      const e = edit(id, after)
      outbox.kick()
      await later(30_000)
      expect(w.entry(e).state).toBe('sent')
      expect(w.calls.filter((c) => c.kind === 'edit' && c.messageId === id)).toHaveLength(editsOfFirst)
      expect(w.entry(e).payload.progress.done.includes('links')).toBe(linked)
    })
  })

  describe('that makes the reply longer', () => {
    it.each([
      ['one part to two', 'Short.', TWO('new', 'more'), ['edit', 'send', 'edit'], 2],
      ['one part to three', 'Short.', THREE('a', 'b', 'c'), ['edit', 'send', 'send', 'edit'], 3],
      ['two parts to three', TWO('a', 'b'), THREE('a', 'b', 'c'), ['edit', 'edit', 'send', 'edit'], 3],
    ])('from %s: edits the old, adds the new, and edits the first to link them', async (_, before, after, kinds, total) => {
      const id = await sentReply(before)
      const old = w.ours().map((m) => m.id)
      w.calls.length = 0
      const e = edit(id, after)
      outbox.kick()
      await later(30_000)
      expect(w.calls.map((c) => c.kind)).toEqual(kinds)
      expect(gaps().every((g) => g === 1500)).toBe(true)
      expect(w.ours()).toHaveLength(total)
      expect(w.ours().slice(0, old.length).map((m) => m.id)).toEqual(old)
      const ids = w.ours().map((m) => m.id)
      const base = `https://discord.com/channels/${GUILD}/${THREAD}`
      for (const later of ids.slice(1)) expect(text(w.ours()[0])).toContain(`<${base}/${later}>`)
      for (const m of w.ours().slice(1)) expect(text(m)).toContain(`-# [↑ from 1/${total}](<${base}/${id}>)`)
      expect(w.parts.get(id)).toEqual(ids)
      expect([...w.messages.keys()]).toEqual([id])
      expect(w.messages.get(id).source).toBe(after)
      expect(w.entry(e).state).toBe('sent')
      expect(w.events.at(-1).note).toBe(`${total} parts`)
      // The edit of the first part that carries the links is written down with the others, once it is made.
      expect(w.entry(e).payload.progress.done).toContain('links')
      // A new part is sent as the same author, and carries no file.
      for (const c of w.sends()) expect(c.body.username).toBe('Invented Name')
      for (const c of w.sends()) expect(c.files).toEqual([])
    })
  })

  describe('that makes the reply shorter', () => {
    it.each([
      ['three parts to one', THREE('a', 'b', 'c'), 'Short.', ['edit', 'remove', 'remove'], 1],
      ['three parts to two', THREE('a', 'b', 'c'), TWO('a', 'b'), ['edit', 'edit', 'remove'], 2],
      ['two parts to one', TWO('a', 'b'), 'Short.', ['edit', 'remove'], 1],
    ])('from %s: edits what stays, and deletes the surplus', async (_, before, after, kinds, left) => {
      const id = await sentReply(before)
      const old = w.ours().map((m) => m.id)
      w.calls.length = 0
      const e = edit(id, after)
      outbox.kick()
      await later(30_000)
      expect(w.calls.map((c) => c.kind)).toEqual(kinds)
      expect(w.calls.filter((c) => c.kind === 'remove').map((c) => c.messageId)).toEqual(old.slice(left))
      expect(gaps().every((g) => g === 1500)).toBe(true)
      expect(w.ours().map((m) => m.id)).toEqual(old.slice(0, left))
      expect(w.parts.get(id)).toEqual(old.slice(0, left))
      expect(w.messages.get(id).source).toBe(after)
      expect(w.entry(e).state).toBe('sent')
      // The first part links to what is left, and to nothing when it is one part.
      if (left === 1) expect(text(w.ours()[0])).not.toContain('continues')
      if (left === 2) expect(text(w.ours()[0])).toContain(`[2/2](<https://discord.com/channels/${GUILD}/${THREAD}/${old[1]}>)`)
    })
  })

  it('goes on with the same number of parts after a stop, and does not add a part twice', async () => {
    const id = await sentReply('Short.')
    w.calls.length = 0
    edit(id, THREE('a', 'b', 'c'))
    outbox.kick()
    await later(2000)
    // The edit of the first at 0, the second part at 1500; the third is next.
    expect(w.ours()).toHaveLength(2)
    await outbox.stop()
    outbox = make()
    outbox.start()
    await later(30_000)
    expect(w.ours()).toHaveLength(3)
    expect(w.sends()).toHaveLength(2)
    expect(w.parts.get(id)).toEqual(w.ours().map((m) => m.id))
    expect(w.messages.get(id).state).toBeNull()
  })

  it('finds the part it was adding when it was stopped, rather than adding it again', async () => {
    const id = await sentReply('Short.')
    w.script.push(null, { throws: true, lands: true })
    edit(id, TWO('a', 'b'))
    outbox.kick()
    await later(30_000)
    expect(w.ours()).toHaveLength(2)
    expect(w.sends()).toHaveLength(2)
    expect(w.messages.get(id).source).toBe(TWO('a', 'b'))
  })

  it('keeps a reply\'s form, whatever the worker sends new replies in now', async () => {
    outbox = make({ form: 'plain' })
    const id = await sentReply('Before.')
    await outbox.stop()
    outbox = make()
    w.calls.length = 0
    edit(id, 'After.')
    outbox.start()
    await later(5000)
    expect(w.calls[0].body.flags).toBe(4)
    expect(w.calls[0].body.content).toBe(`After.\n-# <@${MEMBER}> · [Open On Site](<${SITE}>)`)
    expect(w.calls[0].body.components).toBeUndefined()
  })

  it('refuses an edit that makes a reply too long for three messages, sending nothing', async () => {
    const id = await sentReply('Before.')
    w.calls.length = 0
    const e = edit(id, `${x(3000)}\n\n${x(3000)}\n\n${x(3000)}\n\n${x(3000)}`)
    outbox.kick()
    await later(5000)
    expect(w.calls).toEqual([])
    expect(w.entry(e)).toMatchObject({ state: 'failed', lastError: "That's longer than Discord can carry in 3 messages." })
    expect(w.messages.get(id)).toMatchObject({ state: null, source: 'Before.' })
  })

  it('fails when the message is not there any more, or is not the site\'s to edit', async () => {
    const gone = edit('200000000000000999', 'After.')
    w.messages.set('200000000000000998', { id: '200000000000000998', origin: 'discord', postId: THREAD, authorId: MEMBER, webhookId: null, source: null, layout: null, state: null })
    const theirs = edit('200000000000000998', 'After.')
    w.messages.set('200000000000000997', { id: '200000000000000997', origin: 'site', postId: THREAD, authorId: MEMBER, webhookId: HOOK, source: 'x', layout: null, state: null })
    const unknown = edit('200000000000000997', 'After.')
    await run(5000)
    expect(w.entry(gone)).toMatchObject({ state: 'failed', lastError: 'This reply is no longer there.' })
    expect(w.entry(theirs)).toMatchObject({ state: 'failed', lastError: 'Only replies written on the site can be edited here.' })
    // A message of the site with no layout is not one the site made: it cannot be cut as it was, which is a fault, not an edit.
    expect(w.entry(unknown)).toMatchObject({ state: 'failed', lastError: 'This reply could not be sent.' })
    expect(w.calls).toEqual([])
  })

  it('fails what cannot be cut, and leaves the message as it was', async () => {
    const id = await sentReply('Before.')
    w.messages.get(id).source = null
    const e = edit(id, 'After.')
    outbox.kick()
    await later(5000)
    expect(w.entry(e)).toMatchObject({ state: 'failed', lastError: 'This reply could not be sent.' })
    expect(w.messages.get(id).state).toBeNull()
  })

  describe('that deletes a part in Discord first', () => {
    it.each([
      ['the first part', 0],
      ['the second part', 1],
      ['the last part', 2],
    ])('takes the whole reply with %s, the other parts through the webhook', async (_, which) => {
      const id = await sentReply(THREE('a', 'b', 'c'))
      const ids = w.ours().map((m) => m.id)
      w.thread.splice(w.thread.findIndex((m) => m.id === ids[which]), 1)
      w.calls.length = 0
      const e = edit(id, THREE('A', 'B', 'C'))
      outbox.kick()
      await later(30_000)
      expect(w.ours()).toEqual([])
      expect(w.messages.has(id)).toBe(false)
      expect(w.parts.size).toBe(0)
      expect(w.tombstones).toEqual([id])
      expect(w.entry(e).state).toBe('sent')
      expect(w.calls.filter((c) => c.kind === 'remove').map((c) => c.messageId)).toEqual(ids)
      expect(w.events.at(-1)).toMatchObject({ action: 'delete', messageId: id, note: 'A part was deleted in Discord.' })
    })

    it('takes the parts it had added too', async () => {
      const id = await sentReply('Short.')
      w.script.push(null, null, answer(404, { code: 10008 }))
      w.calls.length = 0
      edit(id, TWO('a', 'b'))
      outbox.kick()
      await later(30_000)
      // The edit of the first, the new part, and the last edit of the first, which found it gone.
      expect(w.ours()).toEqual([])
      expect(w.messages.has(id)).toBe(false)
    })
  })

  describe('and the pictures, which cannot change', () => {
    const SRC = (n) => `![alt](upload:${n})`
    const pictured = async (source, uploads = 1) => {
      const ups = Array.from({ length: uploads }, () => w.addUpload())
      return sentReply(source, { uploads: ups })
    }

    it('leaves the files of a part where they are when only the words change', async () => {
      const id = await pictured(`Look ${SRC(1)} here.`)
      const before = JSON.stringify(w.ours()[0].attachments)
      w.calls.length = 0
      const e = edit(id, `Look at this ${SRC(1)} here, again.`)
      outbox.kick()
      await later(5000)
      expect(w.entry(e).state).toBe('sent')
      expect(w.calls[0].kind).toBe('edit')
      expect(w.calls[0].files).toEqual([])
      expect(JSON.stringify(w.ours()[0].attachments)).toBe(before)
      expect(text(w.ours()[0])).toContain('Look at this')
      expect(w.messages.get(id).source).toBe(`Look at this ${SRC(1)} here, again.`)
    })

    it('refuses an edit that takes the picture out', async () => {
      const id = await pictured(`Look ${SRC(1)} here.`)
      w.calls.length = 0
      const e = edit(id, 'No picture now.')
      outbox.kick()
      await later(5000)
      expect(w.calls).toEqual([])
      expect(w.entry(e)).toMatchObject({ state: 'failed', lastError: COPY.pictures })
      expect(COPY.pictures).toBe("That edit would move or change a picture. Pictures can't be changed after sending: delete the reply and post it again.")
      expect(w.messages.get(id)).toMatchObject({ state: null, source: `Look ${SRC(1)} here.` })
      expect(w.events.at(-1)).toMatchObject({ action: 'failed', messageId: id, note: COPY.pictures })
    })

    it('refuses an edit that brings in a picture the reply was sent with and did not show', async () => {
      const id = await pictured(`Look ${SRC(1)} here.`, 2)
      w.calls.length = 0
      const e = edit(id, `Look ${SRC(1)} and ${SRC(2)}.`)
      outbox.kick()
      await later(5000)
      expect(w.calls).toEqual([])
      expect(w.entry(e)).toMatchObject({ state: 'failed', lastError: COPY.pictures })
    })

    it('refuses an edit that swaps two pictures, which would put each file under the other\'s place', async () => {
      const id = await pictured(`${SRC(1)} ${SRC(2)}`, 2)
      w.calls.length = 0
      const e = edit(id, `${SRC(2)} ${SRC(1)}`)
      outbox.kick()
      await later(5000)
      expect(w.entry(e)).toMatchObject({ state: 'failed', lastError: COPY.pictures })
    })

    it('refuses an edit that moves a picture into another part', async () => {
      const source = `${x(3000)}\n\n${SRC(1)}\n\n${x(3000)}`
      const id = await pictured(source)
      expect(w.ours()).toHaveLength(2)
      w.calls.length = 0
      const e = edit(id, `${x(3000)}\n\n${x(3000)}\n\n${SRC(1)}`)
      outbox.kick()
      await later(5000)
      expect(w.calls).toEqual([])
      expect(w.entry(e)).toMatchObject({ state: 'failed', lastError: COPY.pictures })
    })

    it('lets the reply grow when its pictures stay in the parts they are in, the new part having none', async () => {
      const id = await pictured(`${SRC(1)} Short.`)
      const before = JSON.stringify(w.ours()[0].attachments)
      w.calls.length = 0
      const e = edit(id, `${SRC(1)} ${x(3000)}\n\n${x(3000)}`)
      outbox.kick()
      await later(30_000)
      expect(w.entry(e).state).toBe('sent')
      expect(w.ours()).toHaveLength(2)
      expect(JSON.stringify(w.ours()[0].attachments)).toBe(before)
      expect(w.ours()[1].attachments).toEqual([])
    })
  })
})

describe('a delete', () => {
  const remove = (key, payload = { postId: THREAD }) => w.enqueue({ kind: 'delete', key, payload })

  it('removes every part of a reply of the site through the webhook, one after another, and then the message', async () => {
    const id = await sentReply(THREE())
    const ids = w.ours().map((m) => m.id)
    w.calls.length = 0
    const d = remove(id)
    outbox.kick()
    await later(1)
    expect(w.messages.get(id).state).toBe('sending')
    await later(10_000)
    expect(w.calls.map((c) => [c.kind, c.messageId])).toEqual(ids.map((m) => ['remove', m]))
    expect(gaps()).toEqual([1500, 1500])
    expect(w.ours()).toEqual([])
    expect(w.messages.has(id)).toBe(false)
    expect(w.parts.size).toBe(0)
    expect(w.tombstones).toEqual([id])
    expect(w.entry(d).state).toBe('sent')
    expect(w.events.at(-1)).toEqual({ at: w.calls.at(-1).at, actor: MEMBER, action: 'delete', postId: THREAD, messageId: id, note: null })
    expect(w.bot).toEqual([])
  })

  it('deletes a message that a person wrote in Discord through the bot, and never through the webhook', async () => {
    const human = w.nextId()
    w.thread.push({ id: human, webhook_id: null, content: 'A person wrote this.', attachments: [] })
    w.messages.set(human, { id: human, origin: 'discord', postId: THREAD, authorId: MEMBER_2, source: null, layout: null, state: null })
    const d = remove(human)
    await run(5000)
    expect(w.bot.map((b) => [b.kind, b.threadId, b.messageId])).toEqual([['delete', THREAD, human]])
    expect(w.calls).toEqual([])
    expect(w.thread).toEqual([])
    expect(w.messages.has(human)).toBe(false)
    expect(w.entry(d).state).toBe('sent')
    // The bot's call is written down once it is made, so that a run after a failure of the store does not make it again.
    expect(w.entry(d).payload.progress.done).toEqual(['bot'])
  })

  it('takes the parts it was told of when the message is no longer stored, as when Discord deleted one part', async () => {
    const id = await sentReply(THREE())
    const ids = w.ours().map((m) => m.id)
    // The gateway took the message and its part rows out first, and queued the removal of the parts that were left.
    w.messages.delete(id)
    w.parts.delete(id)
    w.thread.splice(w.thread.findIndex((m) => m.id === ids[1]), 1)
    w.calls.length = 0
    const d = remove(id, { postId: THREAD, partIds: [ids[0], ids[2]] })
    outbox.kick()
    await later(10_000)
    expect(w.calls.map((c) => [c.kind, c.messageId])).toEqual([
      ['remove', ids[0]],
      ['remove', ids[2]],
    ])
    expect(w.ours()).toEqual([])
    expect(w.entry(d).state).toBe('sent')
  })

  it('does nothing to Discord, and ends, when there is nothing it knows of to remove', async () => {
    const d = remove('200000000000000996')
    await run(5000)
    expect(w.calls).toEqual([])
    expect(w.bot).toEqual([])
    expect(w.entry(d).state).toBe('sent')
  })

  it('writes down what it is to remove first, and finishes after a stop even when the store has lost the parts', async () => {
    const id = await sentReply(THREE())
    const ids = w.ours().map((m) => m.id)
    w.calls.length = 0
    const d = remove(id)
    outbox.kick()
    await later(1600)
    expect(w.calls).toHaveLength(2)
    await outbox.stop()
    expect(w.entry(d).payload.progress.partIds).toEqual(ids)
    // The gateway saw a part go, and forgot the message and its parts.
    w.messages.delete(id)
    w.parts.delete(id)
    outbox = make()
    outbox.start()
    await later(10_000)
    expect(w.ours()).toEqual([])
    expect(w.entry(d).state).toBe('sent')
  })

  it('does not fail for a part that is already gone', async () => {
    const id = await sentReply(TWO())
    const ids = w.ours().map((m) => m.id)
    w.thread.splice(w.thread.findIndex((m) => m.id === ids[0]), 1)
    const d = remove(id)
    outbox.kick()
    await later(10_000)
    expect(w.entry(d).state).toBe('sent')
    expect(w.ours()).toEqual([])
  })

  it('writes the delete as an event of the member who asked, with the post', async () => {
    const id = await sentReply('Hello.')
    remove(id)
    outbox.kick()
    await later(5000)
    expect(w.events.at(-1)).toMatchObject({ action: 'delete', actor: MEMBER, postId: THREAD, messageId: id })
  })
})

describe('the worker as a whole', () => {
  it('goes on to a reply queued while it was busy, after the one it was on, and not before it', async () => {
    w.enqueue({ payload: sendPayload({ source: THREE() }) })
    await run(1000)
    w.enqueue({ payload: sendPayload({ source: 'Second.' }) })
    outbox.kick()
    outbox.kick()
    await later(20_000)
    expect(w.calls.map((c) => c.kind)).toEqual(['send', 'send', 'send', 'edit', 'send'])
    expect(w.ours()).toHaveLength(4)
  })

  it('answers who has been blocked and who has been refused to the routes, null when none', async () => {
    outbox = make()
    expect(outbox.sendingPausedUntil()).toBeNull()
    expect(outbox.webhookRefused()).toBeNull()
  })
})


describe('what a message of the thread says, read as text', () => {
  const lost = { throws: true }

  it('is found whether Discord names its content or not, whatever the form of the message', async () => {
    const [, ...others] = []
    void others
    w.script.push(lost)
    w.enqueue({ payload: sendPayload() })
    // The message that did land, as Discord may give it: no content field at all, the words in the components.
    const real = w.discord.messagesAfter
    w.discord.messagesAfter = async (...args) => {
      const page = await real(...args)
      return [{ id: w.nextId(), webhook_id: HOOK, attachments: [], components: [{ type: 17, components: [{ type: 10, content: `Hello there.\n-# <@${MEMBER}>` }] }] }, ...page]
    }
    await run(10_000)
    expect(w.sends()).toHaveLength(1)
    expect(w.entry('1').state).toBe('sent')
  })

  it('is found with the space round it taken off, as Discord takes it off a message', async () => {
    w.script.push(lost)
    w.enqueue({ payload: sendPayload() })
    w.thread.push({ id: w.nextId(), webhook_id: HOOK, content: `  \nHello there.\n-# <@${MEMBER}> \n\n`, flags: 4, attachments: [] })
    w.thread.at(-1).components = undefined
    // A plain message of that content: the worker is V2, but the words are what is looked for.
    outbox = make()
    outbox.start()
    await later(10_000)
    expect(w.sends()).toHaveLength(1)
  })

  it('joins the text displays of a message with a line end, and not with nothing, and not with a blank line for what is not text', async () => {
    const u = w.addUpload()
    w.script.push({ throws: true, lands: true })
    const id = w.enqueue({ payload: sendPayload({ source: 'Before the picture.\n\n![alt](upload:1)\n\nAfter the picture.', uploads: [u] }) })
    await run(10_000)
    // The picture is a component between the two texts, and the message that landed is found by its words all the same.
    expect(w.sends()).toHaveLength(1)
    expect(w.entry(id).state).toBe('sent')
  })

  it('is not made to fail by a message with odd components, which are no match', async () => {
    w.script.push(lost)
    for (const components of [[null], [7, 'x', []], [{ type: 17, components: null }], [{ type: 10, content: 5 }], 'x', {}, [{ components: [{ components: [null, { content: 'x' }] }] }]]) {
      w.thread.push({ id: w.nextId(), webhook_id: HOOK, content: '', components, attachments: [] })
    }
    w.thread.push({ id: w.nextId(), webhook_id: HOOK, content: 5, attachments: [] })
    w.enqueue({ payload: sendPayload() })
    await run(10_000)
    expect(w.sends()).toHaveLength(2)
    expect(w.entry('1').state).toBe('sent')
  })
})

describe('what is left running', () => {
  it('has no timer left after a stop, and none for a worker that has nothing to wait for', async () => {
    await run(100)
    expect(vi.getTimerCount()).toBe(0)
    w.enqueue({ payload: sendPayload(), nextAt: T0 + 50_000 })
    outbox.kick()
    await later(100)
    expect(vi.getTimerCount()).toBe(1)
    await outbox.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('has one timer for what is due next, however often it is told to look again', async () => {
    w.enqueue({ payload: sendPayload(), nextAt: T0 + 50_000 })
    await run(100)
    for (let i = 0; i < 5; i++) {
      outbox.kick()
      await later(10)
    }
    expect(vi.getTimerCount()).toBe(1)
  })

  it('leaves no timer behind when a store failure is waited out, nor after a stop in the middle of the wait', async () => {
    w.storeFails.claimOutbox = [new Error('connection lost')]
    await run(100)
    expect(vi.getTimerCount()).toBe(1)
    await outbox.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends a wait for the breaker at a stop, with no timer left', async () => {
    w.script.push(answer(400, { code: 200000 }), answer(400, { code: 200000 }))
    w.enqueue({ payload: sendPayload() })
    w.enqueue({ payload: sendPayload() })
    await run(10_000)
    expect(outbox.sendingPausedUntil()).not.toBeNull()
    expect(vi.getTimerCount()).toBe(1)
    await outbox.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes up an entry queued while it was looking for what is due next, and is not left waiting for a kick that came too early', async () => {
    const real = w.store.outboxNextAt
    w.store.outboxNextAt = async () => {
      const at = await real()
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return at
    }
    await run(10)
    // The worker is in its look at what is due next, which has said none: an entry is queued, and it is told.
    w.enqueue({ payload: sendPayload() })
    outbox.kick()
    await later(3000)
    expect(w.sends()).toHaveLength(1)
  })

  it('does nothing when told to look before it was started, or while it is being stopped', async () => {
    outbox = make()
    w.enqueue({ payload: sendPayload() })
    outbox.kick()
    await later(5000)
    expect(w.calls).toEqual([])
    outbox.start()
    await later(5000)
    expect(w.calls).toHaveLength(1)
    // A send is on its way when the stop is asked; the kick that comes in the middle of it starts nothing.
    const inner = w.fetchImpl
    w.fetchImpl = async (url, init) => {
      const r = await inner(url, init)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return r
    }
    w.webhook = createWebhookClient({ fetchImpl: w.fetchImpl, url: `${API}/webhooks/${HOOK}/${TOKEN}`, apiBase: API, newest: w.discord.newest })
    await outbox.stop()
    outbox = make({ webhook: w.webhook })
    w.enqueue({ payload: sendPayload({ source: 'Second.' }) })
    outbox.start()
    // (The first call of a worker is 1500 ms after its start, and takes 1000 ms here: the stop comes in the middle of it.)
    await later(2000)
    const stopped = outbox.stop()
    w.enqueue({ payload: sendPayload({ source: 'Third.' }) })
    outbox.kick()
    await later(5000)
    await stopped
    await later(20_000)
    expect(w.ours().map((m) => w.textOf(m).split('\n')[0])).toEqual(['Hello there.', 'Second.'])
  })

  it('reads what the store keeps once for a worker that is started twice', async () => {
    const reads = vi.spyOn(w.store, 'outboxInterrupted')
    outbox = make()
    outbox.start()
    outbox.start()
    await later(100)
    outbox.start()
    await later(100)
    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('does not begin the next entry while it is on one, however it is told to look again', async () => {
    w.enqueue({ payload: sendPayload({ source: THREE() }) })
    const b = w.enqueue({ payload: sendPayload({ source: 'Second.' }), nextAt: T0 + 500 })
    await run(1000)
    outbox.kick()
    outbox.kick()
    await later(1000)
    // The first reply is between its parts; the second has not been taken yet.
    expect(w.entry(b).state).toBe('pending')
    await later(20_000)
    expect(w.entry(b).state).toBe('sent')
    expect(w.calls.map((c) => c.kind)).toEqual(['send', 'send', 'send', 'edit', 'send'])
  })

  it('leaves no timer when a stop ends a wait in the middle of a reply', async () => {
    w.enqueue({ payload: sendPayload({ source: THREE() }) })
    await run(1000)
    await outbox.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not change the pause when a stop comes in the middle of a wait that has its own timer', async () => {
    w.enqueue({ payload: sendPayload({ source: 'A.' }) })
    w.enqueue({ payload: sendPayload({ source: 'B.' }), nextAt: T0 + 1500 })
    await run(100)
    const stopped = outbox.stop()
    await stopped
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the ceiling and the last try, at their edges', () => {
  it('lets edits and deletes go at once when twenty sends are in the window', async () => {
    const id = await sentReply('First.', {}, 5000)
    for (let i = 0; i < 19; i++) w.enqueue({ payload: sendPayload({ source: `Reply ${i}.` }) })
    outbox.kick()
    await later(30_000)
    expect(w.sends()).toHaveLength(20)
    w.calls.length = 0
    const queued = Date.now()
    w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: 'Edited.', mentions: [] } })
    w.enqueue({ kind: 'delete', key: id, payload: { postId: THREAD } })
    outbox.kick()
    await later(5000)
    expect(w.calls.map((c) => c.kind)).toEqual(['edit', 'remove'])
    // Twenty sends are in the last minute, and the edit and the delete are not held up for them.
    expect(w.calls[0].at - queued).toBeLessThanOrEqual(1500)
    expect(w.calls[1].at - w.calls[0].at).toBe(1500)
  })

  it('does not wait for the ceiling at nineteen sends, and does at twenty', async () => {
    for (let i = 0; i < 20; i++) w.enqueue({ payload: sendPayload({ source: `Reply ${i}.` }) })
    await run(29_999)
    // 20 sends at 0, 1500 ... 28500 are in; the twenty-first waits.
    expect(w.sends()).toHaveLength(20)
    w.enqueue({ payload: sendPayload({ source: 'Reply 20.' }) })
    outbox.kick()
    await later(30_000)
    expect(w.sends()).toHaveLength(20)
    await later(1)
    expect(w.sends()).toHaveLength(21)
    expect(w.sends().at(-1).at - w.sends()[0].at).toBe(60_000)
  })

  it('does not give up the links when a stop comes on the last try', async () => {
    w.script.push(null, null, null, answer(400, { code: 50035 }), answer(400, { code: 50035 }), answer(400, { code: 50035 }), answer(400, { code: 50035 }))
    const id = w.enqueue({ payload: sendPayload({ source: THREE() }) })
    // The four tries of the ladder have failed on the links; the fifth is the last, and is stopped before it is made.
    await run(160_000)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 4 })
    await later(10_000)
    expect(w.entry(id).state).toBe('pending')
    await later(500_000)
    const stopped = outbox.stop()
    await stopped
    expect(w.entry(id).state).toBe('pending')
    expect(w.ours()).toHaveLength(3)
  })

  it('stops, even on the last try, without giving up the links: the stop is no failure', async () => {
    w.script.push(null, null, null, answer(400, { code: 50035 }), answer(400, { code: 50035 }), answer(400, { code: 50035 }), answer(400, { code: 50035 }))
    const id = w.enqueue({ payload: sendPayload({ source: THREE() }) })
    await run(755_000 - 1)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 4 })
    // The last try is due at 755,000, and starts with the links edit waiting for its 1500 ms after the stop that left it.
    await outbox.stop()
    outbox = make()
    outbox.start()
    await later(1)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 4 })
    const stopped = outbox.stop()
    await stopped
    expect(w.entry(id).state).not.toBe('sent')
    outbox = make()
    outbox.start()
    await later(10_000)
    expect(w.entry(id).state).toBe('sent')
    expect(w.textOf(w.ours()[0])).toContain('continues')
  })
})

describe('a message with a layout that is not one', () => {
  it('fails the edit, as a fault, whatever the layout is', async () => {
    const id = await sentReply('Before.')
    for (const layout of ['text', 5, [], true]) {
      w.messages.get(id).layout = layout
      const e = w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: 'After.', mentions: [] } })
      outbox.kick()
      await later(5000)
      expect(w.entry(e)).toMatchObject({ state: 'failed', lastError: 'This reply could not be sent.' })
    }
  })
})


describe('an entry that ends for good leaves nothing of itself in Discord', () => {
  const block = () => answer(400, { code: 200000 })
  const deletes = () => [...w.entries.values()].filter((e) => e.kind === 'delete')
  const lateError = (Kind) => {
    let sends = 0
    return {
      id: w.webhook.id,
      send: async (...args) => {
        if (sends++ === 1) throw new Kind('a bug that shows late')
        return w.webhook.send(...args)
      },
      edit: w.webhook.edit,
      remove: w.webhook.remove,
      recent: w.webhook.recent,
    }
  }

  it('queues a delete of the part that landed with the block, and the delete removes it', async () => {
    w.script.push(null, block())
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    await run(1600)
    expect(w.entry(id)).toMatchObject({ state: 'blocked', lastError: 'Discord blocked this reply.' })
    const [first] = w.ours().map((m) => m.id)
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0]).toMatchObject({ messageKey: first, authorId: MEMBER, payload: { postId: THREAD, partIds: [first] } })
    await later(5000)
    expect(w.ours()).toEqual([])
    expect(deletes()[0].state).toBe('sent')
    expect([...w.messages.keys()]).toEqual([])
    expect(w.events.map((e) => e.action)).toEqual(['blocked', 'delete'])
  })

  it('does the same when the ladder is used up on a later part, with every part that landed', async () => {
    w.script.push(null, null, ...Array.from({ length: 5 }, () => answer(400, { code: 50035 })))
    const id = w.enqueue({ payload: sendPayload({ source: THREE() }) })
    await run(1_000_000)
    expect(w.entry(id)).toMatchObject({ state: 'failed', lastError: 'Discord did not take this reply. Try again in a little while.' })
    expect(deletes()[0].payload.partIds).toHaveLength(2)
    expect(deletes()[0].state).toBe('sent')
    expect(w.ours()).toEqual([])
  })

  it('does the same when the webhook may not write in the thread (a 403 is not tried again)', async () => {
    w.script.push(null, answer(403, { code: 50013, message: 'Missing Permissions' }))
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    await run(10_000)
    expect(w.entry(id)).toMatchObject({ state: 'failed', attempts: 0, lastError: COPY.locked })
    expect(w.sends()).toHaveLength(2)
    expect(w.ours()).toEqual([])
  })

  it('does the same when the thread is gone after the first part', async () => {
    w.script.push(null, answer(404, { code: 10003, message: 'Unknown Channel' }))
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    await run(10_000)
    expect(w.entry(id)).toMatchObject({ state: 'failed', lastError: COPY.threadGone })
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0].state).toBe('sent')
    expect(w.ours()).toEqual([])
  })

  it.each([TypeError, RangeError])('does the same when %s is thrown late, after a part landed', async (Kind) => {
    outbox = make({ webhook: lateError(Kind) })
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    await run(10_000)
    expect(w.entry(id)).toMatchObject({ state: 'failed', attempts: 0, lastError: COPY.unsendable })
    expect(w.ours()).toEqual([])
    expect(deletes()).toHaveLength(1)
  })

  it('queues nothing for an entry that sent nothing', async () => {
    w.script.push(block())
    w.enqueue({ payload: sendPayload() })
    await run(10_000)
    expect([...w.entries.values()].map((e) => e.kind)).toEqual(['send'])
  })

  it('writes the block and the delete together, before anything else is done: a write the store loses is made again, and queues one delete', async () => {
    w.script.push(null, block())
    w.storeFails.outboxSet = [new Error('connection lost')]
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    await run(4999)
    // Two calls so far and no third, the entry still the worker's, and nothing queued.
    expect(w.calls).toHaveLength(2)
    expect(w.entry(id).state).toBe('sending')
    expect(deletes()).toEqual([])
    await later(10_000)
    expect(w.entry(id).state).toBe('blocked')
    expect(deletes()).toHaveLength(1)
    expect(w.ours()).toEqual([])
  })

  it('does not queue a second delete, nor turn what ended into something else, when a write was made and its answer lost', async () => {
    w.script.push(null, block())
    w.storeFailsAfter.outboxSet = [new Error('connection lost')]
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    await run(30_000)
    expect(w.entry(id).state).toBe('blocked')
    expect(deletes()).toHaveLength(1)
    expect(w.events.filter((e) => e.action === 'blocked')).toHaveLength(1)
    expect(w.ours()).toEqual([])
  })

  it('fails before the first part when any part could not be built, and sends nothing', async () => {
    const a = w.enqueue({ payload: sendPayload({ source: THREE(), mentions: ['not an id'] }) })
    const b = w.enqueue({ payload: sendPayload({ source: THREE(), username: '' }) })
    await run(10_000)
    for (const id of [a, b]) expect(w.entry(id)).toMatchObject({ state: 'failed', attempts: 0, lastError: COPY.unsendable })
    expect(w.calls).toEqual([])
    expect([...w.entries.values()].map((e) => e.kind)).toEqual(['send', 'send'])
  })
})

describe('a delete of the site that is waiting does not swallow a part deleted in Discord', () => {
  it('removes the parts that were left when the gateway took the reply, the route\'s delete having found the message gone', async () => {
    const id = await sentReply(THREE('a', 'b', 'c'))
    const [p1, p2, p3] = w.ours().map((m) => m.id)
    // The member deletes on the site; the entry waits. Meanwhile part 2 is deleted in Discord, and the store (siteDeleted) drops the
    // message and its parts, and queues a delete of what is left.
    const route = w.enqueue({ kind: 'delete', key: id, payload: { postId: THREAD }, nextAt: T0 + 100_000 })
    w.thread.splice(w.thread.findIndex((m) => m.id === p2), 1)
    w.messages.delete(id)
    w.parts.delete(id)
    const own = w.enqueue({ kind: 'delete', key: id, payload: { postId: THREAD, partIds: [p1, p3] }, nextAt: T0 + 100_000 })
    w.calls.length = 0
    outbox.kick()
    await later(200_000)
    expect(w.ours().map((m) => m.id)).toEqual([])
    expect(w.entry(route).state).toBe('sent')
    expect(w.entry(own).state).toBe('sent')
    expect(w.calls.map((c) => [c.kind, c.messageId])).toEqual([['remove', p1], ['remove', p3]])
  })
})

describe('a webhook 403 ends the entry at once', () => {
  const forbidden = () => answer(403, { code: 50013, message: 'Missing Permissions' })

  it('fails a reply, an edit and a delete, with the words of a locked post, on no ladder', async () => {
    const id = await sentReply('Before.')
    const e = w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: 'After.', mentions: [] } })
    w.script.push(forbidden())
    outbox.kick()
    await later(10_000)
    expect(w.entry(e)).toMatchObject({ state: 'failed', attempts: 0, lastError: COPY.locked })
    const d = w.enqueue({ kind: 'delete', key: id, payload: { postId: THREAD } })
    w.script.push(forbidden())
    outbox.kick()
    await later(10_000)
    expect(w.entry(d)).toMatchObject({ state: 'failed', attempts: 0, lastError: COPY.locked })
    w.script.push(forbidden())
    const r = w.enqueue({ payload: sendPayload({ source: 'Another.' }) })
    outbox.kick()
    await later(10_000)
    expect(w.entry(r)).toMatchObject({ state: 'failed', attempts: 0, lastError: COPY.locked })
  })
})

describe('an edit that ends for good puts the message back as the store has it', () => {
  const edit = (key, source, over = {}) => w.enqueue({ kind: 'edit', key, payload: { postId: THREAD, source, mentions: [], ...over } })
  const block = () => answer(400, { code: 200000 })
  const forbidden = () => answer(403, { code: 50013, message: 'Missing Permissions' })
  const texts = () => w.ours().map((m) => w.textOf(m))
  const ofKind = (kind) => [...w.entries.values()].filter((e) => e.kind === kind)

  // Each case: the reply there is, the edit, what Discord answers to its calls (null: as it does), and the state the entry ends in.
  it.each([
    ['an in-place edit of the second part', THREE('a', 'b', 'c'), THREE('A', 'B', 'C'), [null, block()], 'blocked'],
    ['the first in-place edit', THREE('a', 'b', 'c'), THREE('A', 'B', 'C'), [block()], 'blocked'],
    ['the part that an append sends', 'Short.', TWO('a', 'b'), [null, block()], 'blocked'],
    ['the second part that an append sends, the first having landed', 'Short.', THREE('a', 'b', 'c'), [null, null, block()], 'blocked'],
    ['the links edit after an append', 'Short.', TWO('a', 'b'), [null, null, forbidden()], 'failed'],
    ['the edit of the first part of a reply made shorter', THREE('a', 'b', 'c'), 'Short.', [block()], 'blocked'],
    ['the edit of a part that stays, of a reply made shorter', THREE('a', 'b', 'c'), TWO('A', 'B'), [null, forbidden()], 'failed'],
  ])('leaves Discord and the store as they were when it fails at %s', async (_, before, after, script, end) => {
    const id = await sentReply(before)
    const ids = w.ours().map((m) => m.id)
    const was = texts()
    const { editedAt: _edited, ...row } = structuredClone(w.messages.get(id))
    w.script.push(...script)
    const e = edit(id, after)
    outbox.kick()
    await later(100_000)
    expect(w.entry(e).state).toBe(end)
    // The same messages, in the same order, saying the same, and no part of the edit left.
    expect(w.ours().map((m) => m.id)).toEqual(ids)
    expect(texts()).toEqual(was)
    const { editedAt: _again, ...now } = w.messages.get(id)
    expect(now).toEqual(row)
    expect(w.parts.get(id)).toEqual(ids)
    expect(ofKind('edit').map((x) => x.state)).toEqual([end, 'sent'])
  })

  it('removes the parts the edit added, and edits the first back, with no mention in it', async () => {
    const id = await sentReply('Short.')
    w.calls.length = 0
    w.script.push(null, null, block())
    edit(id, THREE('a', 'b', 'c'), { mentions: [MENTIONED] })
    outbox.kick()
    await later(100_000)
    expect(w.calls.map((c) => c.kind)).toEqual(['edit', 'send', 'send', 'edit', 'remove'])
    expect(w.calls[3].body.allowed_mentions).toEqual({ parse: [], users: [] })
    const [d] = ofKind('delete')
    expect(d).toMatchObject({ state: 'sent', payload: { postId: THREAD, partIds: [w.calls[4].messageId] } })
    expect(texts()).toEqual([`Short.\n-# <@${MEMBER}>`])
  })

  it('puts the message back whatever the end: a ladder that is used up, a thread locked meanwhile, a bug', async () => {
    const id = await sentReply(THREE('a', 'b', 'c'))
    const was = texts()
    w.script.push(null, ...Array.from({ length: 5 }, () => answer(502)))
    const e = edit(id, THREE('A', 'B', 'C'))
    outbox.kick()
    await later(2_000_000)
    expect(w.entry(e).state).toBe('failed')
    expect(texts()).toEqual(was)
    expect(w.messages.get(id).source).toBe(THREE('a', 'b', 'c'))
  })

  it('does not put back a reply it could not have changed: an edit that is refused before it begins', async () => {
    const id = await sentReply('Short.')
    w.calls.length = 0
    edit(id, `${x(5000)}\n\n${x(5000)}\n\n${x(5000)}\n\n${x(5000)}`)
    outbox.kick()
    await later(10_000)
    expect(w.calls).toEqual([])
    expect(ofKind('edit')).toHaveLength(1)
    expect(ofKind('edit')[0]).toMatchObject({ state: 'failed', lastError: COPY.tooLong })
    expect(w.messages.get(id).state).toBeNull()
  })

  it('puts the message back when it ends for good on a later try, whatever that try did: an earlier one may have changed Discord', async () => {
    const id = await sentReply('Before.')
    w.storeFails.outboxMessage = [new Error('connection lost')]
    const e = w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: 'After.', mentions: [] }, attempts: 4 })
    outbox.kick()
    await later(100_000)
    expect(w.entry(e).state).toBe('failed')
    expect(ofKind('edit').map((x) => x.state)).toEqual(['failed', 'sent'])
    expect(w.messages.get(id).state).toBeNull()
  })

  it('does not put a restore back in its turn: when it fails too, the entries end there', async () => {
    const id = await sentReply(TWO('a', 'b'))
    w.script.push(null, block(), block())
    edit(id, TWO('A', 'B'))
    outbox.kick()
    await later(100_000)
    expect(ofKind('edit').map((x) => x.state)).toEqual(['blocked', 'blocked'])
    expect(ofKind('edit')[1].payload).toMatchObject({ postId: THREAD, mentions: [], restore: true })
    expect(ofKind('edit')[1].payload.source).toBeUndefined()
  })

})

// An edit that makes a reply shorter removes the parts it no longer needs last, once the store has taken the edit: they are a delete queued
// with it, in the same transaction. So an edit that ends for good has removed nothing, and the restore finds every part where it was.
describe('an edit that makes the reply shorter removes the parts it no longer needs once the edit is stored', () => {
  const edit = (key, source) => w.enqueue({ kind: 'edit', key, payload: { postId: THREAD, source, mentions: [] } })
  const forbidden = () => answer(403, { code: 50013, message: 'Missing Permissions' })
  const texts = () => w.ours().map((m) => w.textOf(m))
  const ofKind = (kind) => [...w.entries.values()].filter((e) => e.kind === kind)

  it.each([
    ['three parts to one', THREE('a', 'b', 'c'), 'Short.', 1],
    ['three parts to two', THREE('a', 'b', 'c'), TWO('A', 'B'), 2],
    ['two parts to one', TWO('a', 'b'), 'Short.', 1],
  ])('from %s: the store has the edit before any part is removed, and the parts it drops go by a delete queued with it', async (_, before, after, left) => {
    const id = await sentReply(before)
    const ids = w.ours().map((m) => m.id)
    w.calls.length = 0
    // What Discord had been asked when the store took the edit.
    let askedWhenStored = null
    const finishEdit = w.store.finishEdit
    w.store.finishEdit = async (...args) => {
      askedWhenStored ??= w.calls.map((c) => [c.kind, c.messageId])
      return finishEdit(...args)
    }
    const e = edit(id, after)
    outbox.kick()
    await later(30_000)
    expect(askedWhenStored).toEqual(ids.slice(0, left).map((m) => ['edit', m]))
    expect(w.calls.map((c) => [c.kind, c.messageId])).toEqual([...ids.slice(0, left).map((m) => ['edit', m]), ...ids.slice(left).map((m) => ['remove', m])])
    expect(gaps().every((g) => g === 1500)).toBe(true)
    expect(w.entry(e).state).toBe('sent')
    expect(ofKind('delete')).toMatchObject([{ state: 'sent', messageKey: ids[left], authorId: MEMBER, origin: e, payload: { postId: THREAD, partIds: ids.slice(left), webhookId: HOOK } }])
    expect(w.ours().map((m) => m.id)).toEqual(ids.slice(0, left))
    expect(w.parts.get(id)).toEqual(ids.slice(0, left))
    expect(w.messages.get(id)).toMatchObject({ source: after, state: null })
  })

  it('queues no delete for an edit that keeps as many parts, or adds some', async () => {
    const same = await sentReply(TWO('a', 'b'))
    edit(same, TWO('c', 'd'))
    const grown = await sentReply('Short.')
    edit(grown, TWO('e', 'f'))
    outbox.kick()
    await later(60_000)
    expect(ofKind('edit').map((e) => e.state)).toEqual(['sent', 'sent'])
    expect(ofKind('delete')).toEqual([])
    expect(w.ours()).toHaveLength(4)
  })

  it('leaves every part, and the reply as it was, when the store never takes the edit: the restore finds each part where it was', async () => {
    const id = await sentReply(THREE('a', 'b', 'c'))
    const ids = w.ours().map((m) => m.id)
    const was = texts()
    const { editedAt: _edited, ...row } = structuredClone(w.messages.get(id))
    // The first run and the four of the ladder.
    w.storeFails.finishEdit = Array.from({ length: 5 }, () => new Error('connection lost'))
    w.calls.length = 0
    const e = edit(id, 'Short.')
    outbox.kick()
    await later(1_000_000)
    expect(w.entry(e)).toMatchObject({ state: 'failed', attempts: 4, lastError: COPY.unsendable })
    expect(w.calls.filter((c) => c.kind === 'remove')).toEqual([])
    expect(w.ours().map((m) => m.id)).toEqual(ids)
    expect(texts()).toEqual(was)
    const { editedAt: _again, ...now } = w.messages.get(id)
    expect(now).toEqual(row)
    expect(w.parts.get(id)).toEqual(ids)
    expect(ofKind('edit').map((x) => x.state)).toEqual(['failed', 'sent'])
    expect(ofKind('delete')).toEqual([])
  })

  it('removes the part when its removal fails after the edit is stored: the reply is stored at one part, and the delete tries again', async () => {
    const id = await sentReply(THREE('a', 'b', 'c'))
    const ids = w.ours().map((m) => m.id)
    w.script.push(null, answer(502))
    const e = edit(id, 'Short.')
    outbox.kick()
    // The edit at 0, the first removal at 1500, which fails: the delete is tried again at 6500.
    await later(6000)
    expect(w.entry(e)).toMatchObject({ state: 'sent', attempts: 0 })
    expect(w.parts.get(id)).toEqual([id])
    expect(w.messages.get(id)).toMatchObject({ source: 'Short.', state: null })
    const [d] = ofKind('delete')
    expect(d).toMatchObject({ state: 'pending', attempts: 1 })
    // Meanwhile a reader of Discord sees the reply as edited, and its old parts 2 and 3 after it.
    expect(w.ours().map((m) => m.id)).toEqual(ids)
    expect(w.textOf(w.ours()[0])).toBe(`Short.\n-# <@${MEMBER}>`)
    expect(w.textOf(w.ours()[1])).toContain('**2/3**')
    await later(30_000)
    expect(d.state).toBe('sent')
    expect(w.ours().map((m) => m.id)).toEqual([id])
    expect(texts()).toEqual([`Short.\n-# <@${MEMBER}>`])
    expect(ofKind('edit')).toHaveLength(1)
  })

  it('counts the edit as done when a part cannot be removed for good: the reply is stored as edited, and the part left is the delete\'s, which fails', async () => {
    const id = await sentReply(THREE('a', 'b', 'c'))
    const ids = w.ours().map((m) => m.id)
    // The edit of the first part, the removal of the second, and the removal of the third is refused.
    w.script.push(null, null, forbidden())
    const e = edit(id, 'Short.')
    outbox.kick()
    await later(100_000)
    expect(w.entry(e).state).toBe('sent')
    expect(w.messages.get(id)).toMatchObject({ source: 'Short.', state: null })
    expect(w.parts.get(id)).toEqual([id])
    expect(ofKind('delete')).toMatchObject([{ state: 'failed', lastError: COPY.locked, payload: { partIds: ids.slice(1) } }])
    // No restore: the edit is done. What a reader of Discord sees is the reply as edited, and the old third part, which a moderator removes.
    expect(ofKind('edit')).toHaveLength(1)
    expect(w.ours().map((m) => m.id)).toEqual([id, ids[2]])
    expect(texts()[0]).toBe(`Short.\n-# <@${MEMBER}>`)
    expect(texts()[1]).toContain('**3/3**')
  })

  it('stores the edit when Discord tells, while it is on its way, of a part it drops being deleted: the delete finds that part gone, and is done', async () => {
    const id = await sentReply(THREE('a', 'b', 'c'))
    const ids = w.ours().map((m) => m.id)
    const e = edit(id, 'Short.')
    // A moderator deletes part 3 before the edit is run, and the store notes it in the edit (siteDeleted).
    w.thread.splice(w.thread.findIndex((m) => m.id === ids[2]), 1)
    ;(w.entry(e).gone ??= []).push(ids[2])
    outbox.kick()
    await later(30_000)
    expect(w.entry(e).state).toBe('sent')
    expect(w.parts.get(id)).toEqual([id])
    expect(ofKind('delete')).toMatchObject([{ state: 'sent', payload: { partIds: ids.slice(1) } }])
    expect(w.ours().map((m) => m.id)).toEqual([id])
  })
})

describe('a store that fails under an entry is not asked for Discord\'s work over, and not for ever', () => {
  const boom = () => new Error('connection lost')
  const kinds = () => w.calls.map((c) => c.kind)

  it.each([
    ['a reply of two parts', () => w.enqueue({ payload: sendPayload({ source: TWO() }) }), 'finishSend', ['send', 'send', 'edit']],
    ['a reply of three parts', () => w.enqueue({ payload: sendPayload({ source: THREE() }) }), 'finishSend', ['send', 'send', 'send', 'edit']],
  ])('sends %s, adds its links and settles it once, whatever the store does to the write at the end', async (_, queue, name, expected) => {
    queue()
    w.storeFails[name] = [boom(), boom()]
    await run(1_000_000)
    expect(kinds()).toEqual(expected)
    expect([...w.entries.values()][0]).toMatchObject({ state: 'sent', attempts: 2 })
    expect(w.ours()).toHaveLength(expected.length - 1)
    expect(w.messages.size).toBe(1)
  })

  it('does not read the pictures of a reply again when only the write at the end is made again', async () => {
    const u = w.addUpload()
    let reads = 0
    const inner = w.store.uploadsFor
    w.store.uploadsFor = async (...args) => {
      reads++
      return inner(...args)
    }
    w.storeFails.finishSend = [boom(), boom()]
    const id = w.enqueue({ payload: sendPayload({ source: 'Look: ![a picture](upload:1)', uploads: [u] }) })
    await run(1_000_000)
    expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 2 })
    expect(reads).toBe(1)
    expect(w.sends()).toHaveLength(1)
    expect(w.messages.size).toBe(1)
  })

  it('sends the reply even when the pictures are swept after its last part is in Discord', async () => {
    const u = w.addUpload()
    w.storeFails.finishSend = [boom()]
    const id = w.enqueue({ payload: sendPayload({ source: 'Look: ![a picture](upload:1)', uploads: [u] }) })
    await run(4000)
    w.uploads.clear()
    await later(10_000)
    expect(w.entry(id).state).toBe('sent')
    expect(w.messages.size).toBe(1)
  })

  it.each([
    ['three parts to three', THREE('a', 'b', 'c'), THREE('A', 'B', 'C'), ['edit', 'edit', 'edit']],
    ['three parts to one', THREE('a', 'b', 'c'), 'Short.', ['edit', 'remove', 'remove']],
    ['one part to two', 'Short.', TWO('a', 'b'), ['edit', 'send', 'edit']],
  ])('edits %s once, however often the write at the end fails', async (_, before, after, expected) => {
    const id = await sentReply(before)
    w.calls.length = 0
    w.storeFails.finishEdit = [boom(), boom()]
    const e = w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: after, mentions: [] } })
    outbox.kick()
    await later(1_000_000)
    expect(w.entry(e)).toMatchObject({ state: 'sent', attempts: 2 })
    expect(kinds()).toEqual(expected)
    expect(w.messages.get(id).source).toBe(after)
  })

  it('removes the parts of a reply once, however often the write at the end fails', async () => {
    const id = await sentReply(THREE())
    w.calls.length = 0
    w.storeFails.finishDelete = [boom(), boom()]
    const d = w.enqueue({ kind: 'delete', key: id, payload: { postId: THREAD } })
    outbox.kick()
    await later(1_000_000)
    expect(w.entry(d)).toMatchObject({ state: 'sent', attempts: 2 })
    expect(kinds()).toEqual(['remove', 'remove', 'remove'])
    expect(w.ours()).toEqual([])
  })

  it('goes on from the calls of an entry that a restart found half-done, and does not make them again', async () => {
    const id = await sentReply(THREE('a', 'b', 'c'))
    w.calls.length = 0
    w.script.push(null, answer(502))
    const e = w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: 'Short.', mentions: [] } })
    outbox.kick()
    await later(2000)
    // The first edit is made; the removal after it fails, and the entry waits for its next try.
    expect(w.entry(e).payload.progress.done).toHaveLength(1)
    await outbox.stop()
    outbox = make()
    outbox.start()
    await later(100_000)
    expect(w.entry(e).state).toBe('sent')
    // The edit once, the removal that failed and then every removal, once.
    expect(kinds()).toEqual(['edit', 'remove', 'remove', 'remove'])
  })

  it('fails an entry the store keeps failing under, after the ladder, and removes what it sent', async () => {
    w.storeFails.finishSend = Array.from({ length: 6 }, boom)
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    let stored = 0
    const inner = w.store.finishSend
    w.store.finishSend = async (...args) => {
      stored++
      return inner(...args)
    }
    // Two parts at 0 and 1500, the links at 3000, and the store fails under the write at the end.
    await run(3001)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 1 })
    expect(w.entry(id).nextAt).toBe(T0 + 3000 + 5000)
    await later(5000)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 2 })
    expect(w.entry(id).nextAt).toBe(T0 + 8000 + 30_000)
    await later(30_000)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 3 })
    expect(w.entry(id).nextAt).toBe(T0 + 38_000 + 120_000)
    await later(120_000)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 4 })
    expect(w.entry(id).nextAt).toBe(T0 + 158_000 + 600_000)
    await later(600_000)
    expect(w.entry(id)).toMatchObject({ state: 'failed', lastError: COPY.unsendable })
    await later(86_400_000)
    expect(stored).toBe(5)
    expect(kinds()).toEqual(['send', 'send', 'edit', 'remove', 'remove'])
    expect(w.ours()).toEqual([])
    expect(w.messages.size).toBe(0)
  })

  it('does not hold the queue up: the next entry is sent while this one waits for its step', async () => {
    w.storeFails.finishSend = [boom()]
    w.enqueue({ payload: sendPayload({ source: 'Fails once.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Goes through.' }) })
    await run(3500)
    expect(w.messages.size).toBe(1)
    expect([...w.messages.values()][0].source).toBe('Goes through.')
  })

  it('does not count the ladder against an entry for a store that fails under the write that settles it', async () => {
    w.storeFails.finishSend = [boom()]
    w.storeFails.outboxSet = [boom(), boom(), boom()]
    const id = w.enqueue({ payload: sendPayload() })
    await run(60_000)
    expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 1 })
  })

  it('does not turn an entry that was written as done into a failure when the answer of the write is lost', async () => {
    const id = await sentReply('Before.')
    w.storeFailsAfter.finishEdit = [boom()]
    const e = w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: 'After.', mentions: [] } })
    outbox.kick()
    await later(60_000)
    expect(w.entry(e)).toMatchObject({ state: 'sent', attempts: 0 })
    expect(w.messages.get(id).source).toBe('After.')
    const first = w.enqueue({ payload: sendPayload({ source: 'Next.' }) })
    w.storeFailsAfter.finishSend = [boom()]
    outbox.kick()
    await later(60_000)
    expect(w.entry(first)).toMatchObject({ state: 'sent', attempts: 0 })
    expect(w.sends()).toHaveLength(2)
    const d = w.enqueue({ kind: 'delete', key: id, payload: { postId: THREAD } })
    w.storeFailsAfter.finishDelete = [boom()]
    outbox.kick()
    await later(60_000)
    expect(w.entry(d)).toMatchObject({ state: 'sent', attempts: 0 })
    expect(w.events.filter((ev) => ev.action === 'delete')).toHaveLength(1)
  })
})

describe('a part that Discord loses while a reply or an edit is on its way', () => {
  const PART_DELETED = 'A part was deleted in Discord.'

  it('takes the reply with it: the parts that are left are removed, and nothing is stored', async () => {
    const id = w.enqueue({ payload: sendPayload({ source: THREE() }) })
    await run(1501)
    expect(w.sends()).toHaveLength(2)
    w.partDeleted(w.ours()[1].id)
    const [p1] = w.ours().map((m) => m.id)
    await later(30_000)
    expect(w.entry(id).state).toBe('sent')
    expect(w.ours()).toEqual([])
    expect(w.messages.size).toBe(0)
    expect(w.parts.size).toBe(0)
    expect(w.calls.filter((c) => c.kind === 'remove').map((c) => c.messageId).sort()).toEqual([p1, w.calls.at(-1).messageId].sort())
    expect(w.events.at(-1)).toMatchObject({ action: 'delete', postId: THREAD, note: PART_DELETED })
    expect([...w.uploads.keys()]).toEqual([])
  })

  it('does the same for a part deleted just before the reply is stored', async () => {
    const inner = w.store.finishSend
    w.store.finishSend = async (id, args) => {
      w.partDeleted(args.partIds[1])
      return inner(id, args)
    }
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    await run(30_000)
    expect(w.entry(id).state).toBe('sent')
    expect(w.ours()).toEqual([])
    expect(w.messages.size).toBe(0)
    // Only the part that is still there is removed.
    expect(w.calls.filter((c) => c.kind === 'remove')).toHaveLength(1)
  })

  it('does the same for an edit that has added a part which is deleted meanwhile', async () => {
    const id = await sentReply('Short.')
    w.calls.length = 0
    const e = w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: TWO('a', 'b'), mentions: [] } })
    outbox.kick()
    await later(1501)
    expect(w.calls.map((c) => c.kind)).toEqual(['edit', 'send'])
    w.partDeleted(w.ours()[1].id)
    await later(30_000)
    expect(w.entry(e).state).toBe('sent')
    expect(w.ours()).toEqual([])
    expect(w.messages.has(id)).toBe(false)
    expect(w.events.at(-1)).toMatchObject({ action: 'delete', messageId: id, note: PART_DELETED })
    // Only the part that is still there is removed: the one Discord lost is not asked for again.
    expect(w.calls.filter((c) => c.kind === 'remove').map((c) => c.messageId)).toEqual([id])
  })

  it('removes every part, the added ones too, of an edit whose message is gone from the store by the time it ends', async () => {
    const id = await sentReply('Short.')
    w.calls.length = 0
    const inner = w.store.finishEdit
    w.store.finishEdit = async (...args) => {
      w.messages.delete(id)
      w.parts.delete(id)
      return inner(...args)
    }
    const e = w.enqueue({ kind: 'edit', key: id, payload: { postId: THREAD, source: THREE('a', 'b', 'c'), mentions: [] } })
    outbox.kick()
    await later(60_000)
    expect(w.entry(e).state).toBe('sent')
    expect(w.ours()).toEqual([])
    expect(w.calls.filter((c) => c.kind === 'remove')).toHaveLength(3)
  })

  it('fails a reply whose post is not stored, and removes what it sent', async () => {
    w.postMissing = true
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    await run(30_000)
    expect(w.entry(id)).toMatchObject({ state: 'failed', lastError: COPY.threadGone })
    expect(w.ours()).toEqual([])
    expect(w.messages.size).toBe(0)
  })
})

describe('the links forward, when what goes wrong is more than a nicety', () => {
  // A reply of two parts on the last try of its ladder, whose links edit is answered with `last`.
  async function lastTry(last, attempts = 4) {
    w.script.push(null, null, last)
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }), attempts })
    await run(10_000)
    return id
  }

  it('is not given up when the webhook is refused on the last try: the entry waits, and nothing is stored without links', async () => {
    const id = await lastTry(answer(401, {}))
    expect(outbox.webhookRefused()).toMatchObject({ status: 401 })
    expect(w.entry(id).state).toBe('pending')
    expect(w.messages.size).toBe(0)
  })

  it('is not given up when a limit is global, on the last try: the entry waits for the time Discord says', async () => {
    const id = await lastTry(answer(429, { retry_after: 40, global: true }))
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 4 })
    expect(w.entry(id).nextAt).toBe(T0 + 3000 + 40_000)
    expect(w.messages.size).toBe(0)
  })

  it('is not given up for a limit that is not global either', async () => {
    const id = await lastTry(answer(429, { retry_after: 40, global: false }))
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 4 })
    expect(w.messages.size).toBe(0)
  })

  it('is not given up when the thread is gone, on the last try: the reply fails, and what landed is removed', async () => {
    const id = await lastTry(answer(404, { code: 10003 }))
    expect(w.entry(id)).toMatchObject({ state: 'failed', lastError: COPY.threadGone })
    expect(w.messages.size).toBe(0)
    await later(10_000)
    expect(w.ours()).toEqual([])
  })

  it.each([0, 4])('is given up for a 403 (the thread locked), on try %i, and the reply is stored without them', async (attempts) => {
    const id = await lastTry(answer(403, { code: 50013 }), attempts)
    expect(w.entry(id).state).toBe('sent')
    expect(w.events[0].note).toBe('2 parts, no links')
    expect(w.messages.size).toBe(1)
    expect(w.ours()).toHaveLength(2)
  })
})

describe('what is taken for a refusal of Discord\'s', () => {
  it('is only a WebhookError: an error of the store that carries the same words goes up the ladder', async () => {
    w.storeFails.finishSend = [Object.assign(new Error('connection lost'), { fatal: true, blocked: true, status: 403, threadGone: true })]
    const id = w.enqueue({ payload: sendPayload() })
    await run(10_000)
    expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 1 })
    expect(outbox.webhookRefused()).toBeNull()
    expect(outbox.sendingPausedUntil()).toBeNull()
  })

  it('is only a WebhookError for the links forward too: a failure of the bot that carries the same words is a failure like any', async () => {
    w.script.push(null, null, answer(400, { code: 50083 }))
    w.discord.setArchived = async () => {
      throw Object.assign(new Upstream('The bot is down.'), { blocked: true, status: 403, fatal: true, threadGone: true })
    }
    const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
    // The links go out at 3000, and the entry waits until 8000 for its next try.
    await run(4000)
    expect(w.entry(id)).toMatchObject({ state: 'pending', attempts: 1 })
    expect(outbox.webhookRefused()).toBeNull()
    expect(outbox.sendingPausedUntil()).toBeNull()
    expect(w.messages.size).toBe(0)
  })
})

describe('a try of the ladder goes on from what the one before it did', () => {
  it('reads no picture again when the parts it has left carry none', async () => {
    let reads = 0
    const inner = w.store.uploadsFor
    w.store.uploadsFor = async (...args) => {
      reads++
      return inner(...args)
    }
    w.script.push(null, answer(400, { code: 50035 }))
    const id = w.enqueue({ payload: sendPayload({ source: THREE() }) })
    await run(30_000)
    expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 1 })
    expect(reads).toBe(1)
  })
})

/**
 * Whether what an entry queued to put Discord right when it ended for good is all done, and what that queued in its turn: only then is
 * the entry held to have left nothing. A cleanup that failed for good excuses its own entry, and no other. Every one of them is over by
 * then, one way or another (everyEntryOver): one still on its way is a fault, not an excuse.
 */
function cleanedUp(entry) {
  return [...w.entries.values()].filter((e) => e.origin === entry.id).every((e) => e.state === 'sent' && cleanedUp(e))
}

/** Never lost, and never stuck: every entry of the world is over at the end, the ones queued to put Discord right too. */
function everyEntryOver() {
  expect([...w.entries.values()].filter((e) => !['sent', 'failed', 'blocked'].includes(e.state)).map((e) => [e.id, e.kind, e.state])).toEqual([])
}

/** What an action of a property does to the world, other than a wait or a restart. */
function disturb(a) {
  if (a.type === 'storefail') (w.storeFails[a.name] ??= []).push(new Error('connection lost'))
  // The claim is made, and its answer lost: the entry is 'sending' with no one at it.
  else if (a.type === 'claimlost') (w.storeFailsAfter.claimOutbox ??= []).push(new Error('connection lost'))
  // The connection that held the lock is gone: the worker must notice, and take it again.
  else if (a.type === 'loselock') w.lockHeld = false
  else w.lookFails.push(new Upstream('Discord is unreachable.'))
}

/** Nothing was done to Discord, by the webhook or the bot, while the worker did not hold the lock. */
function onlyWithTheLock() {
  expect(w.calls.filter((c) => !c.held)).toEqual([])
  expect(w.bot.filter((b) => b.kind === 'delete' && !b.held)).toEqual([])
}

/**
 * Whether a message that an entry which ended for good left in Discord is a part the outbox cannot know of: one whose id the store never
 * got (it is not among the entry's parts), and which, between the send that made it and the entry's end, a look at the thread that threw
 * would have seen, or a note of progress that the store did not take would have told of, with no look for that part of that entry that
 * answered after it, and before the end: such a look finds it (the fake shows a message at once). The look is the only way to learn of
 * such a part, so one that no look could find is left. Any other part left behind is a fault: a part with no doubt on it is always found.
 */
function unknowable(entry, message) {
  const made = w.made.get(message.id)
  if (made === undefined || (entry.payload.progress?.parts ?? []).some((part) => part.id === message.id)) return false
  const sentFor = w.madeFor.get(message.id)
  const foundAfter = (seq) => w.found.some((l) => l.seq > seq && l.seq < entry.endSeq && l.for.some((f) => f.entryId === sentFor?.entryId && f.index === sentFor.index))
  return w.doubts.some((d) => d.seq > made && d.seq < entry.endSeq && d.covers(message, entry) && !foundAfter(d.seq))
}

describe('never twice, never lost (property)', () => {
  const OUTCOMES = {
    ok: () => null,
    refuse: () => answer(400, { code: 50035 }),
    blocked: () => answer(400, { code: 200000 }),
    lost: () => ({ throws: true }),
    landed: () => ({ throws: true, lands: true }),
    bad: () => answer(502),
    badLanded: () => ({ ...answer(502), lands: true }),
    slow: () => answer(429, { retry_after: 2 }),
    nothing: () => answer(200, { nothing: 1 }),
    nothingLanded: () => ({ ...answer(200, { nothing: 1 }), lands: true }),
  }
  const outcome = fc.constantFrom('ok', 'ok', 'ok', 'ok', ...Object.keys(OUTCOMES))
  const action = fc.oneof(
    fc.record({ type: fc.constant('wait'), ms: fc.integer({ min: 0, max: 40_000 }) }),
    fc.record({ type: fc.constant('wait'), ms: fc.integer({ min: 0, max: 3000 }) }),
    fc.record({ type: fc.constant('restart') }),
    fc.record({ type: fc.constant('storefail'), name: fc.constantFrom('outboxProgress', 'finishSend', 'claimOutbox', 'outboxSet', 'knownPartIds') }),
    fc.record({ type: fc.constant('looksfail') }),
    fc.record({ type: fc.constant('claimlost') }),
    fc.record({ type: fc.constant('loselock') }),
  )
  const scenario = fc.record({
    parts: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 4 }),
    script: fc.array(outcome, { maxLength: 16 }),
    actions: fc.array(action, { maxLength: 10 }),
  })

  const tokenOf = (i, k) => `E${i}P${k}`
  const sourceOf = (i, n) => Array.from({ length: n }, (_, k) => `${tokenOf(i, k + 1)}${n === 1 ? ' short' : x(3000)}`).join('\n\n')
  const holders = (i, k) => w.ours().filter((m) => w.textOf(m).includes(tokenOf(i, k)))

  it('every part of every reply is in Discord at most once, and a reply that is sent is whole, however it fails and restarts', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ parts, script, actions }) => {
        vi.useFakeTimers()
        vi.setSystemTime(T0)
        w = makeWorld()
        outbox = null
        try {
          for (const o of script) w.script.push(OUTCOMES[o]())
          const ids = parts.map((n, i) => w.enqueue({ payload: sendPayload({ source: sourceOf(i, n) }), nextAt: T0 + i * 700 }))
          outbox = make()
          outbox.start()
          for (const a of actions) {
            if (a.type === 'wait') await vi.advanceTimersByTimeAsync(a.ms)
            else if (a.type === 'restart') {
              await outbox.stop()
              w.life++
              outbox = make()
              outbox.start()
            } else disturb(a)
          }
          for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(1_200_000)

          parts.forEach((n, i) => {
            const entry = w.entry(ids[i])
            // Never twice: no part of any reply is in the thread more than once.
            for (let k = 1; k <= n; k++) expect(holders(i, k).length).toBeLessThanOrEqual(1)
            // Never lost: after all this, the entry is over, one way or another.
            expect(['sent', 'failed', 'blocked']).toContain(entry.state)
            if (entry.state === 'sent') {
              const there = Array.from({ length: n }, (_, k) => holders(i, k + 1))
              expect(there.every((h) => h.length === 1)).toBe(true)
              const stored = [...w.messages.values()].filter((m) => m.source === sourceOf(i, n))
              expect(stored).toHaveLength(1)
              expect(w.parts.get(stored[0].id)).toEqual(there.map(([m]) => m.id))
              expect(stored[0].id).toBe(there[0][0].id)
            } else {
              // A reply that did not go leaves no message of the site behind...
              expect([...w.messages.values()].filter((m) => m.source === sourceOf(i, n))).toHaveLength(0)
              // ...and, once what it queued has run, no part of it in Discord, but for one the worker cannot know of (unknowable).
              if (cleanedUp(entry)) for (let k = 1; k <= n; k++) for (const m of holders(i, k)) expect(unknowable(entry, m)).toBe(true)
            }
          })
          everyEntryOver()
          onlyWithTheLock()
          // The limits hold within one run of the worker.
          const byLife = Map.groupBy(w.calls, (c) => c.life)
          for (const calls of byLife.values()) {
            for (let j = 1; j < calls.length; j++) expect(calls[j].at - calls[j - 1].at).toBeGreaterThanOrEqual(SPACING)
            const sends = calls.filter((c) => c.kind === 'send')
            for (let j = 20; j < sends.length; j++) expect(sends[j].at - sends[j - 20].at).toBeGreaterThanOrEqual(60_000)
          }
        } finally {
          await outbox?.stop()
          outbox = null
          vi.useRealTimers()
        }
      }),
      { numRuns: Number(process.env.P6_RUNS ?? 120) },
    )
  }, 600_000)
})

describe('edits and deletes never leave a part twice, nor a reply that is gone half there (property)', () => {
  const OUTCOMES = {
    ok: () => null,
    refuse: () => answer(400, { code: 50035 }),
    blocked: () => answer(400, { code: 200000 }),
    lost: () => ({ throws: true }),
    landed: () => ({ throws: true, lands: true }),
    bad: () => answer(502),
    badLanded: () => ({ ...answer(502), lands: true }),
    slow: () => answer(429, { retry_after: 2 }),
    gone: () => ({ ...answer(404, { code: 10008 }), removes: true }),
  }
  const outcome = fc.constantFrom('ok', 'ok', 'ok', 'ok', 'ok', ...Object.keys(OUTCOMES))
  const action = fc.oneof(
    fc.record({ type: fc.constant('wait'), ms: fc.integer({ min: 0, max: 30_000 }) }),
    fc.record({ type: fc.constant('wait'), ms: fc.integer({ min: 0, max: 3000 }) }),
    fc.record({ type: fc.constant('restart') }),
    fc.record({ type: fc.constant('storefail'), name: fc.constantFrom('outboxProgress', 'finishEdit', 'finishDelete', 'outboxMessage', 'claimOutbox', 'knownPartIds') }),
    fc.record({ type: fc.constant('looksfail') }),
    fc.record({ type: fc.constant('claimlost') }),
    fc.record({ type: fc.constant('loselock') }),
  )
  const op = fc.record({ kind: fc.constantFrom('edit', 'edit', 'delete', 'none'), n2: fc.integer({ min: 1, max: 3 }) })
  const scenario = fc.record({
    parts: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 3 }),
    ops: fc.array(op, { minLength: 3, maxLength: 3 }),
    script: fc.array(outcome, { maxLength: 14 }),
    actions: fc.array(action, { maxLength: 8 }),
  })

  const tokenOf = (i, k) => `E${i}P${k}`
  const sourceOf = (i, n, version) => Array.from({ length: n }, (_, k) => `${tokenOf(i, k + 1)}${n === 1 ? ` short ${version}` : x(version === 1 ? 3000 : 2999)}`).join('\n\n')
  const holders = (i, k) => w.ours().filter((m) => w.textOf(m).includes(tokenOf(i, k)))
  it('holds for any mix of failures, restarts and lost answers', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ parts, ops, script, actions }) => {
        vi.useFakeTimers()
        vi.setSystemTime(T0)
        w = makeWorld()
        outbox = null
        try {
          const sent = parts.map((n, i) => w.enqueue({ payload: sendPayload({ source: sourceOf(i, n, 1) }) }))
          outbox = make()
          outbox.start()
          await vi.advanceTimersByTimeAsync(600_000)
          const keys = parts.map((_, i) => [...w.messages.values()].find((m) => m.source === sourceOf(i, parts[i], 1)).id)
          for (const id of sent) expect(w.entry(id).state).toBe('sent')
          for (const o of script) w.script.push(OUTCOMES[o]())
          const queued = parts.map((n, i) => {
            const { kind, n2 } = ops[i]
            if (kind === 'edit') return w.enqueue({ kind, key: keys[i], payload: { postId: THREAD, source: sourceOf(i, n2, 2), mentions: [] } })
            if (kind === 'delete') return w.enqueue({ kind, key: keys[i], payload: { postId: THREAD } })
            return null
          })
          outbox.kick()
          for (const a of actions) {
            if (a.type === 'wait') await vi.advanceTimersByTimeAsync(a.ms)
            else if (a.type === 'restart') {
              await outbox.stop()
              w.life++
              outbox = make()
              outbox.start()
            } else disturb(a)
          }
          for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(1_200_000)

          // A reply that Discord lost (a `gone` answer removes a part by itself) and whose entry then ended for good, for the whole
          // ladder, before the store could be told: it is still stored, and the member's own retry finishes it (every removal is
          // harmless the second time).
          const ghost = (key) => script.includes('gone') && [...w.entries.values()].some((e) => e.messageKey === key && (e.state === 'failed' || e.state === 'blocked'))
          parts.forEach((n, i) => {
            const { kind, n2 } = ops[i]
            const entry = queued[i] === null ? null : w.entry(queued[i])
            for (let k = 1; k <= 3; k++) expect(holders(i, k).length).toBeLessThanOrEqual(1)
            if (entry !== null) expect(['sent', 'failed', 'blocked']).toContain(entry.state)
            const row = w.messages.get(keys[i])
            if (kind === 'delete' && entry.state === 'sent') {
              // Gone from Discord, every part, and from the store, the parts' rows with it.
              for (let k = 1; k <= 3; k++) expect(holders(i, k)).toHaveLength(0)
              expect(row).toBeUndefined()
              expect(w.parts.has(keys[i])).toBe(false)
            } else if (kind === 'edit' && entry.state === 'sent' && row !== undefined) {
              expect(row.source).toBe(sourceOf(i, n2, 2))
              expect(row.state).toBeNull()
              for (let k = 1; k <= n2; k++) expect(holders(i, k)).toHaveLength(1)
              // The parts it no longer needs are gone once the delete it queued for them is done. A delete that ended for good leaves them, as
              // any cleanup that fails for good does (it ended: no entry of the world is left on its way, below).
              if (cleanedUp(entry)) for (let k = n2 + 1; k <= 3; k++) expect(holders(i, k)).toHaveLength(0)
              expect(w.parts.get(keys[i])).toEqual(Array.from({ length: n2 }, (_, k) => holders(i, k + 1)[0].id))
            } else if (row !== undefined && !ghost(keys[i])) {
              // Whatever became of the edit or delete, a message that is stored has its parts, in order, in Discord, or says it is on its way.
              const stored = w.parts.get(keys[i])
              expect(stored).toBeDefined()
              expect(stored[0]).toBe(keys[i])
              // An edit that ended for good, and whose restore and cleanup went through, left the message as it was: its source, and every part, in Discord.
              if (kind === 'edit' && entry.state !== 'sent' && cleanedUp(entry) && row.state === null) {
                expect(row.source).toBe(sourceOf(i, n, 1))
                for (let k = 1; k <= n; k++) expect(holders(i, k)).toHaveLength(1)
                for (let k = 1; k <= n; k++) expect(w.textOf(holders(i, k)[0])).toContain(n === 1 ? 'short 1' : x(3000))
                // No part the edit added is left, but for one the worker cannot know of (unknowable), as in the property above.
                for (let k = n + 1; k <= 3; k++) for (const m of holders(i, k)) expect(unknowable(entry, m)).toBe(true)
              }
            }
            if (row !== undefined && (kind === 'none' || entry.state === 'sent' || entry.state === 'failed' || entry.state === 'blocked')) expect(w.messages.get(keys[i]).state === 'sending').toBe(false)
          })
          everyEntryOver()
          onlyWithTheLock()
          const byLife = Map.groupBy(w.calls, (c) => c.life)
          for (const calls of byLife.values()) for (let j = 1; j < calls.length; j++) expect(calls[j].at - calls[j - 1].at).toBeGreaterThanOrEqual(SPACING)
        } finally {
          await outbox?.stop()
          outbox = null
          vi.useRealTimers()
        }
      }),
      { numRuns: Number(process.env.P6_RUNS ?? 100) },
    )
  }, 600_000)
})

describe('one worker sends at a time: the lock', () => {
  const START = T0 - SPACING

  it('takes the lock before it reads or sends anything', async () => {
    const order = []
    for (const name of ['takeWorkerLock', 'outboxHold', 'sendTimesSince', 'blockedSince', 'outboxInterrupted', 'claimOutbox']) {
      const inner = w.store[name]
      w.store[name] = async (...args) => (order.push(name), inner(...args))
    }
    w.enqueue({ payload: sendPayload() })
    await run()
    expect(order.slice(0, 5)).toEqual(['takeWorkerLock', 'outboxHold', 'sendTimesSince', 'blockedSince', 'outboxInterrupted'])
    expect(order[5]).toBe('claimOutbox')
    expect(w.ours()).toHaveLength(1)
  })

  it('does not send, nor read, when another worker holds it, and says so once', async () => {
    w.lockFree = false
    const told = []
    const id = w.enqueue({ payload: sendPayload() })
    const reads = vi.spyOn(w.store, 'outboxInterrupted')
    outbox = make({ log: (line) => told.push(line) })
    outbox.start()
    await later(200_000)
    expect(w.calls).toEqual([])
    expect(reads).not.toHaveBeenCalled()
    expect(w.entry(id).state).toBe('pending')
    expect(told).toHaveLength(1)
    expect(told[0]).toBe('Librarius outbox: another worker holds the outbox, so this one does not send.')
  })

  it('asks again every 30 s, and goes to work when the lock is let go', async () => {
    w.lockFree = false
    const id = w.enqueue({ payload: sendPayload() })
    outbox = make()
    outbox.start()
    await later(29_999)
    expect(w.lockCalls).toEqual(['take'])
    await later(1)
    expect(w.lockCalls).toEqual(['take', 'take'])
    await later(30_000)
    expect(w.lockCalls).toEqual(['take', 'take', 'take'])
    expect(w.calls).toEqual([])
    w.lockFree = true
    await later(30_000)
    expect(w.lockCalls).toHaveLength(4)
    await later(5000)
    expect(w.entry(id).state).toBe('sent')
    expect(w.calls[0].at).toBe(START + 90_000 + 1500)
  })

  it('does not say again that another worker holds it when it loses the lock after it had it, and asks again', async () => {
    const told = []
    outbox = make({ log: (line) => told.push(line) })
    outbox.start()
    await later(100)
    await outbox.stop()
    w.lockFree = false
    outbox.start()
    await later(100)
    expect(told).toHaveLength(1)
  })

  it('lets the lock go at a stop, after the work is done, and asks for it again at the next start', async () => {
    w.enqueue({ payload: sendPayload() })
    await run(10_000)
    expect(w.lockCalls).toEqual(['take'])
    await outbox.stop()
    expect(w.lockCalls).toEqual(['take', 'release'])
    outbox.start()
    await later(100)
    expect(w.lockCalls).toEqual(['take', 'release', 'take'])
  })

  it('lets the lock go for a worker that was never started, and a failure to let it go is no failure of the stop', async () => {
    const told = []
    outbox = make({ log: (line) => told.push(line) })
    await outbox.stop()
    expect(w.lockCalls).toEqual(['release'])
    w.storeFails.releaseWorkerLock = [new Error('connection lost')]
    outbox.start()
    await later(100)
    await expect(outbox.stop()).resolves.toBeUndefined()
    expect(told.some((line) => line.includes('connection lost'))).toBe(true)
  })

  it('asks for the lock again when the store fails after it, since it holds it already', async () => {
    w.storeFails.outboxHold = [new Error('connection lost')]
    const id = w.enqueue({ payload: sendPayload() })
    outbox = make()
    outbox.start()
    await later(20_000)
    expect(w.lockCalls).toEqual(['take', 'take'])
    expect(w.entry(id).state).toBe('sent')
  })

  // A stop and a start of the same worker hold on to what it had decided and could not write, as a lost lock does (below).
  it('writes a block it had decided at the next start, when it was stopped while the store could not take it, and does not send the part again', async () => {
    w.script.push(answer(400, { code: 200000 }))
    w.storeFails.outboxSet = [new Error('connection lost')]
    const id = w.enqueue({ payload: sendPayload() })
    outbox = make()
    outbox.start()
    await later(SPACING + 100)
    expect(w.sends()).toHaveLength(1)
    expect(w.entry(id).state).toBe('sending')
    await outbox.stop()
    outbox.start()
    await later(30_000)
    expect(w.lockCalls).toEqual(['take', 'release', 'take'])
    expect(w.sends()).toHaveLength(1)
    expect(w.looks).toEqual([])
    expect(w.entry(id)).toMatchObject({ state: 'blocked', lastError: 'Discord blocked this reply.' })
    expect(w.events.filter((e) => e.action === 'blocked')).toHaveLength(1)
  })

  describe('lost while it works', () => {
    // The connection that held the lock may fail: another worker may take the lock then, and only that one may send.
    it('sends nothing more when it loses the lock in the middle of the queue, leaves the entry for whoever holds it, and goes on once it has it again', async () => {
      const a = w.enqueue({ payload: sendPayload({ source: THREE() }) })
      const b = w.enqueue({ payload: sendPayload({ source: 'Second.' }) })
      outbox = make()
      outbox.start()
      await later(SPACING + 100)
      expect(w.sends()).toHaveLength(1)
      w.lockHeld = false
      w.lockFree = false
      await later(120_000)
      expect(w.calls).toHaveLength(1)
      expect(w.entry(a)).toMatchObject({ state: 'sending', attempts: 0 })
      expect(w.entry(b).state).toBe('pending')
      w.lockFree = true
      await later(60_000)
      // Asked for again when it was lost (at the next call, 1500 ms after the first), then every 30 s until it was free.
      expect(w.lockCalls).toEqual(['take', 'take', 'take', 'take', 'take', 'take'])
      expect(w.calls.map((c) => c.at - T0)).toEqual([0, 123_000, 124_500, 126_000, 127_500])
      expect(w.calls.every((c) => c.held)).toBe(true)
      expect(w.entry(a)).toMatchObject({ state: 'sent', attempts: 0 })
      expect(w.entry(b)).toMatchObject({ state: 'sent', attempts: 0 })
      expect(w.ours()).toHaveLength(4)
      for (const words of ['onexxx', 'twoxxx', 'threexxx', 'Second.']) expect(w.ours().filter((m) => w.textOf(m).includes(words))).toHaveLength(1)
    })

    it('takes the lock again at once when it is free, reads what the store keeps again, and goes on from what the store knows', async () => {
      const reads = vi.spyOn(w.store, 'outboxInterrupted')
      const a = w.enqueue({ payload: sendPayload({ source: TWO() }) })
      outbox = make()
      outbox.start()
      await later(SPACING + 100)
      w.lockHeld = false
      await later(30_000)
      expect(w.lockCalls).toEqual(['take', 'take'])
      expect(reads).toHaveBeenCalledTimes(2)
      expect(w.entry(a)).toMatchObject({ state: 'sent', attempts: 0 })
      // The second part was noted as on its way when the lock went: it is looked for, 5 s after it was noted, and sent.
      expect(w.sends().map((c) => c.at - T0)).toEqual([0, 5000])
      expect(w.ours()).toHaveLength(2)
    })

    it('claims nothing while it does not hold the lock: an entry queued meanwhile waits for the worker that does', async () => {
      outbox = make()
      outbox.start()
      await later(100)
      w.lockHeld = false
      w.lockFree = false
      const id = w.enqueue({ payload: sendPayload() })
      outbox.kick()
      await later(10_000)
      expect(w.entry(id).state).toBe('pending')
      expect(w.calls).toEqual([])
      w.lockFree = true
      await later(30_000)
      expect(w.entry(id).state).toBe('sent')
      expect(w.calls.every((c) => c.held)).toBe(true)
    })

    // What it had decided for an entry, and could not write because the store failed, is written once it holds the lock again, as it was
    // decided, before it reads what the store keeps: it is not run again, which would send a part that Discord blocked.
    it('writes a block it had decided when the lock went while the store could not take it, and does not send the part again', async () => {
      w.script.push(answer(400, { code: 200000 }))
      w.storeFails.outboxSet = [new Error('connection lost')]
      const id = w.enqueue({ payload: sendPayload() })
      outbox = make()
      outbox.start()
      await later(SPACING + 100)
      // The block is decided, and its write failed: it is made again in 5 s. Meanwhile the connection that held the lock is gone.
      expect(w.sends()).toHaveLength(1)
      expect(w.entry(id).state).toBe('sending')
      w.lockHeld = false
      await later(30_000)
      expect(w.lockCalls).toEqual(['take', 'take'])
      expect(w.sends()).toHaveLength(1)
      expect(w.looks).toEqual([])
      expect(w.entry(id)).toMatchObject({ state: 'blocked', lastError: 'Discord blocked this reply.' })
      expect(w.events.filter((e) => e.action === 'blocked')).toHaveLength(1)
      expect(w.ours()).toEqual([])
      // The block counts towards the breaker: a second one within the hour stops everything.
      w.script.push(answer(400, { code: 200000 }))
      w.enqueue({ payload: sendPayload({ source: 'Another.' }) })
      outbox.kick()
      await later(5000)
      expect(outbox.sendingPausedUntil()).not.toBeNull()
    })

    it('writes the note of a part that landed, which the store did not take, when the lock went before the store came back: the part is not looked for', async () => {
      const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
      // The note of part 1, and the same note written again with the step of the ladder.
      w.storeFails.outboxProgress = [null, new Error('connection lost'), new Error('connection lost')]
      outbox = make()
      outbox.start()
      await later(SPACING + 100)
      expect(w.sends()).toHaveLength(1)
      expect(w.entry(id).payload.progress.parts).toEqual([])
      w.lockHeld = false
      await later(60_000)
      expect(w.lockCalls).toEqual(['take', 'take'])
      expect(w.looks).toEqual([])
      expect(w.entry(id)).toMatchObject({ state: 'sent', attempts: 1 })
      expect(w.sends()).toHaveLength(2)
      expect(w.ours()).toHaveLength(2)
      expect(w.parts.get(w.ours()[0].id)).toEqual(w.ours().map((m) => m.id))
    })

    it('makes no delete through the bot once it has lost the lock, and makes the rest, once each, when it holds it again', async () => {
      const id = await sentReply(TWO())
      w.messages.get(id).webhookId = OLD_HOOK
      const parts = [...w.parts.get(id)]
      for (const m of w.thread) if (parts.includes(m.id)) m.webhook_id = OLD_HOOK
      w.bot.length = 0
      const real = w.discord.deleteMessage
      w.discord.deleteMessage = async (...args) => {
        await real(...args)
        // The lock goes with the first delete, to another worker.
        w.lockHeld = false
        w.lockFree = false
        w.discord.deleteMessage = real
      }
      const d = w.enqueue({ kind: 'delete', key: id, payload: { postId: THREAD } })
      outbox.kick()
      await later(60_000)
      expect(w.bot.map((b) => b.messageId)).toEqual([parts[0]])
      expect(w.entry(d).state).toBe('sending')
      w.lockFree = true
      await later(30_000)
      expect(w.bot.map((b) => b.messageId)).toEqual(parts)
      expect(w.bot.every((b) => b.held)).toBe(true)
      expect(w.entry(d).state).toBe('sent')
      expect(w.messages.has(id)).toBe(false)
    })
  })

  it('says which webhook it sends through, for a route that refuses what it cannot edit', () => {
    outbox = make()
    expect(outbox.webhookId).toBe(HOOK)
  })
})

describe('what a restart must not lose: the pause, the global hold, the blocks', () => {
  const block = (code = 200000) => answer(400, { code, message: 'blocked' })
  const START = T0 - SPACING

  it('holds all sending until the pause that was in force when it stopped, and no longer', async () => {
    w.holds.pausedUntil = new Date(START + 600_000).toISOString()
    const id = w.enqueue({ payload: sendPayload() })
    outbox = make()
    outbox.start()
    await later(10)
    expect(outbox.sendingPausedUntil()).toBe(START + 600_000)
    await later(599_000)
    expect(w.calls).toEqual([])
    await later(1000)
    expect(w.entry(id).state).toBe('sent')
    expect(w.calls[0].at).toBe(START + 600_000)
    expect(outbox.sendingPausedUntil()).toBeNull()
  })

  it('knows a pause that is over for what it is', async () => {
    w.holds.pausedUntil = new Date(START - 1).toISOString()
    outbox = make()
    outbox.start()
    await later(10)
    expect(outbox.sendingPausedUntil()).toBeNull()
  })

  it('holds every call until the global 429 that was in force, edits and deletes too', async () => {
    w.holds.globalUntil = new Date(START + 20_000).toISOString()
    w.enqueue({ payload: sendPayload() })
    await run(30_000)
    expect(w.calls[0].at).toBe(START + 20_000)
  })

  it('writes the pause with the second block within an hour, in the transaction that ends the entry, and not with the first', async () => {
    w.script.push(block(), block())
    w.enqueue({ payload: sendPayload({ source: 'Blocked A.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Blocked B.' }) })
    const sets = []
    const inner = w.store.outboxSet
    w.store.outboxSet = async (id, patch) => (sets.push([id, patch.state, patch.hold]), inner(id, patch))
    await run(10_000)
    expect(sets).toEqual([
      ['1', 'blocked', undefined],
      ['2', 'blocked', { pausedUntil: T0 + 1500 + 3_600_000 }],
    ])
    expect(w.holds.pausedUntil).toBe(new Date(T0 + 1500 + 3_600_000).toISOString())
    expect(w.holds.globalUntil).toBeNull()
  })

  it('is paused after a restart by the pause it wrote, whether or not the blocks are still read back', async () => {
    w.script.push(block(), block())
    w.enqueue({ payload: sendPayload({ source: 'Blocked A.' }) })
    w.enqueue({ payload: sendPayload({ source: 'Blocked B.' }) })
    await run(10_000)
    const until = outbox.sendingPausedUntil()
    await outbox.stop()
    w.events.length = 0
    outbox = make()
    outbox.start()
    await later(10)
    expect(outbox.sendingPausedUntil()).toBe(until)
  })

  it('does not shorten a pause that was written when the blocks it read back would make a shorter one', async () => {
    w.holds.pausedUntil = new Date(T0 + 3_000_000).toISOString()
    w.events.push({ at: T0 - 1_000_000, action: 'blocked' }, { at: T0 - 900_000, action: 'blocked' })
    outbox = make()
    outbox.start()
    await later(10)
    expect(outbox.sendingPausedUntil()).toBe(T0 + 3_000_000)
  })

  it('reads the blocks of the last hour only: two that are an hour and a minute old are no pause', async () => {
    w.events.push({ at: START - 3_660_000, action: 'blocked' }, { at: START - 3_650_000, action: 'blocked' })
    outbox = make()
    outbox.start()
    await later(10)
    expect(outbox.sendingPausedUntil()).toBeNull()
    await outbox.stop()
    w.events.push({ at: START - 3_000_000, action: 'blocked' })
    outbox = make()
    outbox.start()
    await later(10)
    expect(outbox.sendingPausedUntil()).toBeNull()
  })

  it('forgets the blocks it counted before a stop when it starts again, and counts what the store says', async () => {
    w.script.push(block())
    w.enqueue({ payload: sendPayload({ source: 'Blocked A.' }) })
    await run(5000)
    await outbox.stop()
    w.events.length = 0
    w.script.push(block())
    w.enqueue({ payload: sendPayload({ source: 'Blocked B.' }) })
    outbox.start()
    await later(10_000)
    // The first block is no longer counted, so the second is the only one: no pause.
    expect(outbox.sendingPausedUntil()).toBeNull()
  })

  it('writes the global hold with a 429 that is global, and nothing for one that is not', async () => {
    w.script.push(answer(429, { retry_after: 20, global: true }))
    const id = w.enqueue({ payload: sendPayload() })
    await run(100)
    expect(w.holds.globalUntil).toBe(new Date(T0 + 20_000).toISOString())
    expect(w.entry(id).state).toBe('pending')
    await outbox.stop()
    outbox = null
    w.holds.globalUntil = null
    w.script.push(answer(429, { retry_after: 20 }))
    const second = w.enqueue({ payload: sendPayload({ source: 'Second.' }), nextAt: Date.now() })
    await run(100)
    expect(w.holds.globalUntil).toBeNull()
    expect(w.entry(second).state).toBe('pending')
  })

  it('is held by the global 429 it wrote after a restart', async () => {
    w.script.push(answer(429, { retry_after: 30, global: true }))
    w.enqueue({ payload: sendPayload() })
    await run(100)
    await outbox.stop()
    outbox = make()
    w.enqueue({ payload: sendPayload({ source: 'Next.' }) })
    outbox.start()
    await later(10_000)
    expect(w.sends()).toHaveLength(1)
    await later(30_000)
    expect(w.sends()[1].at).toBe(T0 + 30_000)
    expect(w.ours()).toHaveLength(2)
  })

  describe('the block of the edit that adds the links forward', () => {
    const linksBlocked = (code = 200000) => {
      w.script.push(null, null, answer(400, { code }))
      return w.enqueue({ payload: sendPayload({ source: TWO() }) })
    }

    it('is noted by the author of the entry, with the first part, and the reply is stored without its links', async () => {
      const id = linksBlocked()
      await run(30_000)
      expect(w.entry(id).state).toBe('sent')
      const noted = w.events.filter((e) => e.action === 'blocked')
      expect(noted).toEqual([{ at: expect.any(Number), actor: MEMBER, action: 'blocked', postId: THREAD, messageId: w.ours()[0].id, note: 'links' }])
      expect(w.holds.pausedUntil).toBeNull()
    })

    it('is read back after a restart, with the blocks of any other entry', async () => {
      linksBlocked()
      await run(30_000)
      await outbox.stop()
      w.script.push(answer(400, { code: 200000 }))
      w.enqueue({ payload: sendPayload({ source: 'Blocked.' }) })
      outbox = make()
      outbox.start()
      await later(10_000)
      expect(outbox.sendingPausedUntil()).not.toBeNull()
      expect(w.holds.pausedUntil).not.toBeNull()
    })

    it('writes the pause it may cause with the note, when it is the second block in the hour', async () => {
      w.script.push(answer(400, { code: 200000 }))
      w.enqueue({ payload: sendPayload({ source: 'Blocked first.' }) })
      linksBlocked(200001)
      await run(30_000)
      expect(w.holds.pausedUntil).toBe(new Date(outbox.sendingPausedUntil()).toISOString())
      expect(outbox.sendingPausedUntil()).not.toBeNull()
    })

    it('is not noted for a locked thread, which is no block of Discord’s moderation', async () => {
      w.script.push(null, null, answer(403, { code: 50013 }))
      const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
      await run(30_000)
      expect(w.entry(id).state).toBe('sent')
      expect(w.events.filter((e) => e.action === 'blocked')).toEqual([])
    })

    it('is not counted for the breaker when it is a locked thread that refuses it: the next real block is the first', async () => {
      w.script.push(null, null, answer(403, { code: 50013 }), answer(400, { code: 200000 }))
      w.enqueue({ payload: sendPayload({ source: TWO() }) })
      const blocked = w.enqueue({ payload: sendPayload({ source: 'Blocked.' }) })
      await run(30_000)
      expect(w.entry(blocked).state).toBe('blocked')
      expect(outbox.sendingPausedUntil()).toBeNull()
      expect(w.holds.pausedUntil).toBeNull()
    })

    it('is not made again, nor noted twice, when the store fails under the note: the links are given up, and the reply goes on', async () => {
      const id = linksBlocked()
      w.storeFails.noteBlock = [new Error('connection lost')]
      await run(200_000)
      expect(w.entry(id).state).toBe('sent')
      expect(w.calls.filter((c) => c.kind === 'edit')).toHaveLength(1)
      expect(w.ours()).toHaveLength(2)
      expect(w.events.filter((e) => e.action === 'blocked')).toEqual([])
    })
  })
})

describe('the look for a part that may have landed: from when it began, after Discord has had time', () => {
  const lost = { throws: true }
  const snowflakeOf = (ms) => String(BigInt(ms - 1420070400000) << 22n)

  it('reads the thread after the snowflake of five seconds before the send began, a hundred at most', async () => {
    w.script.push(lost)
    w.enqueue({ payload: sendPayload() })
    await run(10_000)
    expect(w.looks).toHaveLength(1)
    // The note that the part is about to be sent is written as the worker begins (the spacing holds the call 1500 ms more), and the look reads from before it.
    expect(w.looks[0]).toMatchObject({ threadId: THREAD, afterId: snowflakeOf(T0 - SPACING - 5000), limit: 100 })
    expect(w.looks[0].at).toBe(T0 + 5000)
  })

  it('writes down when a part began and which webhook sends it, with the note that it is about to be sent', async () => {
    w.enqueue({ payload: sendPayload({ source: TWO() }) })
    const seen = []
    const inner = w.store.outboxProgress
    w.store.outboxProgress = async (entryId, progress) => (seen.push(JSON.parse(JSON.stringify(progress))), inner(entryId, progress))
    await run(100)
    // Written before the part is sent, with the time of the note and the webhook it will be sent through.
    expect(seen[0]).toMatchObject({ inflight: 0, inflightAt: T0 - SPACING, webhookId: HOOK, parts: [] })
    expect(seen[1]).toMatchObject({ inflight: null, webhookId: HOOK })
    expect(seen[1].parts).toHaveLength(1)
  })

  it('does not take a message from before the look begins, though its words are the part’s', async () => {
    w.script.push(lost)
    w.thread.push({ id: w.nextId(), webhook_id: HOOK, content: `Hello there.\n-# <@${MEMBER}>`, timestamp: new Date(T0 - 60_000).toISOString(), attachments: [] })
    const id = w.enqueue({ payload: sendPayload() })
    await run(10_000)
    expect(w.sends()).toHaveLength(2)
    expect(w.entry(id).state).toBe('sent')
  })

  it('takes a message from after it began, and one from a few seconds before: the clocks may differ', async () => {
    w.script.push({ throws: true, lands: true })
    const id = w.enqueue({ payload: sendPayload() })
    await run(10_000)
    expect(w.sends()).toHaveLength(1)
    expect(w.entry(id).state).toBe('sent')
  })

  it('takes the newest of the messages after it that match, and none of another webhook’s', async () => {
    w.script.push(lost)
    const other = { id: w.nextId(), webhook_id: OLD_HOOK, content: `Hello there.\n-# <@${MEMBER}>`, timestamp: new Date(T0 + 1000).toISOString(), attachments: [] }
    w.thread.push(other)
    const id = w.enqueue({ payload: sendPayload() })
    await run(10_000)
    expect(w.sends()).toHaveLength(2)
    expect(w.entry(id).state).toBe('sent')
    expect([...w.messages.keys()]).not.toContain(other.id)
  })

  it('waits 5 s after a send that may have landed before it looks, and counts from the end of the call', async () => {
    w.script.push(lost)
    const slow = w.fetchImpl
    w.fetchImpl = async (url, init) => {
      const r = await slow(url, init).catch((err) => {
        throw err
      })
      return r
    }
    w.enqueue({ payload: sendPayload() })
    await run(4999)
    expect(w.looks).toEqual([])
    await later(1)
    expect(w.looks).toHaveLength(1)
  })

  it('looks from an hour back when the note of when the part began is missing', async () => {
    const id = w.enqueue({ state: 'sending', payload: sendPayload({ progress: { form: 'v2', parts: [], inflight: 0 } }) })
    await run(2000)
    expect(w.looks).toHaveLength(1)
    expect(w.looks[0].afterId).toBe(snowflakeOf(T0 - SPACING - 3_600_000 - 5000))
    expect(w.entry(id).state).toBe('sent')
  })

  it('ends its wait at a stop: the part is looked for again at the next start', async () => {
    w.script.push(lost)
    const id = w.enqueue({ payload: sendPayload() })
    await run(3000)
    await outbox.stop()
    expect(w.looks).toEqual([])
    expect(w.entry(id).state).toBe('sending')
    expect(w.entry(id).payload.progress.inflight).toBe(0)
    outbox = make()
    outbox.start()
    await later(20_000)
    expect(w.entry(id).state).toBe('sent')
    // The first send did not land, and the second does.
    expect(w.sends()).toHaveLength(2)
    expect(w.ours()).toHaveLength(1)
  })
})

describe('another webhook: a reply sent through one that the address was made again for', () => {
  const edit = (key, source, over = {}) => w.enqueue({ kind: 'edit', key, payload: { postId: THREAD, source, mentions: [], ...over } })
  const remove = (key, over = {}) => w.enqueue({ kind: 'delete', key, payload: { postId: THREAD, ...over } })
  const botDeletes = () => w.bot.filter((b) => b.kind === 'delete').map((b) => b.messageId)
  /** A reply that the old webhook sent: its parts are in the thread as that webhook's, and its message says so. */
  async function oldReply(source = THREE(), hook = OLD_HOOK) {
    const id = await sentReply(source)
    w.messages.get(id).webhookId = hook
    for (const m of w.thread) if (w.parts.get(id).includes(m.id)) m.webhook_id = hook
    w.calls.length = 0
    w.bot.length = 0
    return id
  }
  const OLDER = "This reply was sent through an older webhook, so it can't be edited from the site. Delete it and post it again."

  describe('an edit', () => {
    it('is refused with what the member is told, before anything is sent, and the message is left as it was', async () => {
      const id = await oldReply('Before.')
      const e = edit(id, 'After.')
      outbox.kick()
      await later(5000)
      expect(COPY.olderWebhook).toBe(OLDER)
      expect(w.entry(e)).toMatchObject({ state: 'failed', lastError: OLDER })
      expect(w.calls).toEqual([])
      expect(botDeletes()).toEqual([])
      expect(w.messages.get(id)).toMatchObject({ source: 'Before.', state: null })
      // Nothing is queued to put it right: nothing was changed.
      expect([...w.entries.values()]).toHaveLength(2)
    })

    it.each([
      ['no webhook noted for it', null],
      ['a webhook it does not send through', OLD_HOOK],
    ])('is refused for a message with %s', async (_, hook) => {
      const id = await oldReply('Before.', hook)
      const e = edit(id, 'After.')
      outbox.kick()
      await later(5000)
      expect(w.entry(e)).toMatchObject({ state: 'failed', lastError: OLDER })
    })

    it('is not refused for a message of the webhook it sends through', async () => {
      const id = await sentReply('Before.')
      const e = edit(id, 'After.')
      outbox.kick()
      await later(5000)
      expect(w.entry(e).state).toBe('sent')
    })

    it('puts nothing back for an edit of such a message that was queued as a restore, and does not queue more', async () => {
      const id = await oldReply('Before.')
      const e = edit(id, 'ignored', { restore: true })
      outbox.kick()
      await later(5000)
      expect(w.entry(e)).toMatchObject({ state: 'failed', lastError: OLDER })
      expect([...w.entries.values()]).toHaveLength(2)
    })

    it('says what the route says, word for word, and in one place', () => {
      outbox = make()
      expect(COPY.olderWebhook).toBe(OLDER)
    })
  })

  describe('a delete', () => {
    it('removes every part through the bot, and none through the webhook, and the message goes from the store', async () => {
      const id = await oldReply(THREE())
      const parts = [...w.parts.get(id)]
      remove(id)
      outbox.kick()
      await later(30_000)
      expect(botDeletes()).toEqual(parts)
      expect(w.calls).toEqual([])
      expect(w.thread.filter((m) => parts.includes(m.id))).toEqual([])
      expect(w.messages.has(id)).toBe(false)
      expect(w.tombstones).toContain(id)
      expect(w.bot.filter((b) => b.kind === 'delete').every((b) => b.threadId === THREAD)).toBe(true)
    })

    it('removes the parts of a message of the webhook it sends through with the webhook, and none with the bot', async () => {
      const id = await sentReply(THREE())
      const parts = [...w.parts.get(id)]
      w.calls.length = 0
      w.bot.length = 0
      remove(id)
      outbox.kick()
      await later(30_000)
      expect(w.calls.map((c) => [c.kind, c.messageId])).toEqual(parts.map((p) => ['remove', p]))
      expect(botDeletes()).toEqual([])
    })

    it('removes the parts of a message with no webhook noted through the webhook, as it did before there was one to note', async () => {
      const id = await oldReply('One.', null)
      remove(id)
      outbox.kick()
      await later(10_000)
      expect(w.calls.map((c) => c.kind)).toEqual(['remove'])
      expect(botDeletes()).toEqual([])
    })

    it.each([
      ['an old webhook', OLD_HOOK, 'bot'],
      ['the webhook it sends through', HOOK, 'webhook'],
      ['no webhook it knows of', null, 'webhook'],
    ])('removes what a delete queued by the gateway names, sent by %s, through the %s, when the message is not stored', async (_, hook, through) => {
      const a = w.nextId()
      const b = w.nextId()
      for (const id of [a, b]) w.thread.push({ id, webhook_id: hook ?? HOOK, content: 'x', attachments: [] })
      const e = remove(a, { partIds: [a, b], webhookId: hook })
      await run(30_000)
      expect(w.entry(e).state).toBe('sent')
      expect(w.thread.filter((m) => [a, b].includes(m.id))).toEqual([])
      if (through === 'bot') {
        expect(botDeletes()).toEqual([a, b])
        expect(w.calls).toEqual([])
      } else {
        expect(w.calls.map((c) => c.kind)).toEqual(['remove', 'remove'])
        expect(botDeletes()).toEqual([])
      }
    })

    it('decides by what the delete says before what the message says: a delete that names its webhook knows best', async () => {
      const id = await oldReply('One.', OLD_HOOK)
      remove(id, { partIds: [id], webhookId: HOOK })
      outbox.kick()
      await later(10_000)
      expect(w.calls.map((c) => c.kind)).toEqual(['remove'])
      expect(botDeletes()).toEqual([])
    })

    it('does not remove through the webhook, whose answer would be "gone" for a message that is not its own, and so strand it', async () => {
      const id = await oldReply('One.')
      const [part] = w.parts.get(id)
      remove(id)
      outbox.kick()
      await later(10_000)
      expect(w.thread.some((m) => m.id === part)).toBe(false)
      expect(w.calls).toEqual([])
    })

    it('does the removals it has done once, when the store fails and the entry is tried again', async () => {
      const id = await oldReply(THREE())
      const parts = [...w.parts.get(id)]
      w.storeFails.finishDelete = [new Error('connection lost')]
      remove(id)
      outbox.kick()
      await later(60_000)
      expect(botDeletes()).toEqual(parts)
      expect(w.messages.has(id)).toBe(false)
    })
  })

  describe('an entry that ends for good after it sent a part', () => {
    it('queues the delete of what it sent with the webhook it sent it through', async () => {
      w.script.push(null, answer(400, { code: 200000 }))
      const id = w.enqueue({ payload: sendPayload({ source: TWO() }) })
      await run(10_000)
      expect(w.entry(id).state).toBe('blocked')
      const queued = [...w.entries.values()].find((e) => e.kind === 'delete')
      const landed = w.entry(id).payload.progress.parts.map((p) => p.id)
      expect(landed).toHaveLength(1)
      expect(queued.messageKey).toBe(landed[0])
      expect(queued.payload).toMatchObject({ postId: THREAD, partIds: landed, webhookId: HOOK })
    })
  })

  describe('a reply that was begun through an old webhook, and is taken up again', () => {
    const oldPart = (over = {}) => ({ id: w.nextId(), webhook_id: OLD_HOOK, content: '', components: [{ type: 17, components: [{ type: 10, content: 'old words' }] }], timestamp: new Date(T0).toISOString(), attachments: [], ...over })
    const left = (parts, over = {}) =>
      w.enqueue({
        state: 'sending',
        payload: sendPayload({ source: THREE(), progress: { form: 'v2', webhookId: OLD_HOOK, parts: parts.map((m) => ({ id: m.id, at: m.timestamp, attachments: [] })), inflight: null, ...over } }),
      })

    it('removes what the old webhook sent through the bot, and sends the whole reply again from its first part through this one', async () => {
      const first = oldPart()
      w.thread.push(first)
      const id = left([first])
      await run(30_000)
      expect(botDeletes()).toEqual([first.id])
      expect(w.thread.some((m) => m.id === first.id)).toBe(false)
      expect(w.entry(id).state).toBe('sent')
      expect(w.ours()).toHaveLength(3)
      expect(w.ours().every((m) => m.webhook_id === HOOK)).toBe(true)
      expect(w.calls.map((c) => c.kind)).toEqual(['send', 'send', 'send', 'edit'])
      expect(w.calls.some((c) => c.messageId === first.id)).toBe(false)
      const stored = [...w.messages.keys()]
      expect(stored).toEqual([w.ours()[0].id])
      expect(w.parts.get(stored[0])).toEqual(w.ours().map((m) => m.id))
      expect(w.messages.get(stored[0]).webhookId).toBe(HOOK)
      expect(w.entry(id).payload.progress.webhookId).toBe(HOOK)
    })

    it('removes every part it sent, and puts nothing of the old reply in the new one', async () => {
      const a = oldPart()
      const b = oldPart()
      w.thread.push(a, b)
      left([a, b], { inflight: null })
      await run(30_000)
      expect(botDeletes()).toEqual([a.id, b.id])
      expect(w.sends()).toHaveLength(3)
    })

    it('begins again with no note of the links forward, so the new reply gets its own', async () => {
      const first = oldPart()
      w.thread.push(first)
      left([first], { linked: true })
      await run(30_000)
      expect(w.calls.filter((c) => c.kind === 'edit')).toHaveLength(1)
      expect(w.calls.at(-1).kind).toBe('edit')
    })

    it('looks for the part that may have been in Discord when it stopped, among the old webhook’s messages, and removes it too', async () => {
      const lost = oldPart({ components: [{ type: 17, components: [{ type: 10, content: `Hello there.\n-# <@${MEMBER}>` }] }], timestamp: new Date(T0 - 1000).toISOString() })
      const another = oldPart({ components: [{ type: 17, components: [{ type: 10, content: 'something else' }] }] })
      const ours = oldPart({ webhook_id: HOOK, components: [{ type: 17, components: [{ type: 10, content: `Hello there.\n-# <@${MEMBER}>` }] }] })
      w.thread.push(lost, another, ours)
      const id = w.enqueue({ state: 'sending', payload: sendPayload({ progress: { form: 'v2', webhookId: OLD_HOOK, parts: [], inflight: 0, inflightAt: T0 - 1000 } }) })
      await run(30_000)
      expect(botDeletes()).toEqual([lost.id])
      expect(w.thread.some((m) => m.id === another.id)).toBe(true)
      expect(w.thread.some((m) => m.id === ours.id)).toBe(true)
      expect(w.entry(id).state).toBe('sent')
      expect(w.sends()).toHaveLength(1)
    })

    it('looks from when the part was noted, after Discord has had its 5 s, with the old webhook’s id', async () => {
      const id = w.enqueue({ state: 'sending', payload: sendPayload({ progress: { form: 'v2', webhookId: OLD_HOOK, parts: [], inflight: 0, inflightAt: T0 + 1000 } }) })
      await run(30_000)
      expect(w.looks[0].afterId).toBe(String(BigInt(T0 + 1000 - 5000 - 1420070400000) << 22n))
      expect(w.looks[0].at).toBe(T0 + 6000)
      expect(w.entry(id).state).toBe('sent')
    })

    it('looks from an hour back when it was not noted when the part began', async () => {
      w.enqueue({ state: 'sending', payload: sendPayload({ progress: { form: 'v2', webhookId: OLD_HOOK, parts: [], inflight: 0 } }) })
      await run(30_000)
      expect(w.looks[0].afterId).toBe(String(BigInt(T0 - SPACING - 3_600_000 - 5000 - 1420070400000) << 22n))
    })

    it('sends on, with no removal, when the part that may have been sent is not in Discord', async () => {
      const id = w.enqueue({ state: 'sending', payload: sendPayload({ progress: { form: 'v2', webhookId: OLD_HOOK, parts: [], inflight: 0, inflightAt: T0 - 1000 } }) })
      await run(30_000)
      expect(botDeletes()).toEqual([])
      expect(w.entry(id).state).toBe('sent')
      expect(w.ours()).toHaveLength(1)
    })

    it('does not remove a part twice when the store fails after one removal, nor send before they are all gone', async () => {
      const a = oldPart()
      const b = oldPart()
      w.thread.push(a, b)
      const inner = w.discord.deleteMessage
      const tried = []
      let failed = false
      w.discord.deleteMessage = async (threadId, id) => {
        tried.push(id)
        if (id === b.id && !failed) {
          failed = true
          throw new Upstream('Discord is unreachable.')
        }
        return inner(threadId, id)
      }
      const id = left([a, b])
      await run(60_000)
      expect(tried).toEqual([a.id, b.id, b.id])
      expect(w.entry(id).state).toBe('sent')
      expect(w.ours()).toHaveLength(3)
    })

    it('goes on as before when the webhook is the one that began it: nothing is removed, and no part is sent again', async () => {
      const first = oldPart({ webhook_id: HOOK })
      w.thread.push(first)
      w.enqueue({ state: 'sending', payload: sendPayload({ source: THREE(), progress: { form: 'v2', webhookId: HOOK, parts: [{ id: first.id, at: first.timestamp, attachments: [] }], inflight: null } }) })
      await run(30_000)
      expect(botDeletes()).toEqual([])
      expect(w.sends()).toHaveLength(2)
    })

    it('treats a reply with no webhook noted as one of this webhook (an entry from before it was noted)', async () => {
      const first = oldPart({ webhook_id: HOOK })
      w.thread.push(first)
      w.enqueue({ state: 'sending', payload: sendPayload({ source: THREE(), progress: { form: 'v2', parts: [{ id: first.id, at: first.timestamp, attachments: [] }], inflight: null } }) })
      await run(30_000)
      expect(botDeletes()).toEqual([])
      expect(w.sends()).toHaveLength(2)
    })

    it('stops being held to the old webhook once it has begun again: the note is this webhook’s, written with the removal', async () => {
      const first = oldPart()
      w.thread.push(first)
      const id = left([first])
      const seen = []
      const inner = w.store.outboxProgress
      w.store.outboxProgress = async (entryId, progress) => (seen.push(JSON.parse(JSON.stringify(progress))), inner(entryId, progress))
      await run(30_000)
      const begun = seen.find((p) => p.parts.length === 0 && p.webhookId === HOOK)
      expect(begun).toBeDefined()
      expect(begun.inflight).toBeNull()
      expect(begun.done).toContain(`bot:${first.id}`)
      expect('linked' in begun).toBe(false)
      expect(w.entry(id).state).toBe('sent')
    })
  })
})

describe('a kick that comes while the worker is finishing', () => {
  it('is not lost: an entry queued after the worker saw nothing due, and before it was done, is taken up', async () => {
    outbox = make()
    const inner = w.store.outboxNextAt
    let release
    let gated = false
    w.store.outboxNextAt = async () => {
      const out = await inner()
      if (!gated) {
        gated = true
        await new Promise((resolve) => (release = resolve))
      }
      return out
    }
    outbox.start()
    await later(10)
    // The worker has read that nothing is due, and has not yet finished.
    const id = w.enqueue({ payload: sendPayload() })
    outbox.kick()
    release()
    await later(10_000)
    expect(w.entry(id).state).toBe('sent')
  })
})
