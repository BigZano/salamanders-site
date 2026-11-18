import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createLibrariusStore } from './librariusStore.js'
import { parseMessage } from './librariusParse.js'

// The SQL of the outbox store (librariusOutboxStore.js), run for real: a throwaway Postgres 16 in a container of its own (a unique name,
// a random local port, removed when the tests end), schema.sql applied twice and app-role.sql after the first, and the store driven as the
// data-only role the API connects as. The unit tests of the store pin the text of each statement against a recording pool; this proves that
// the statements do what they say: the repair, the constraints, the lock, the claim.
//
// It is skipped when there is no docker, or no `pg` to reach it with, or no image of Postgres 16 (a pull is tried once). It is also skipped
// in a mutation run: the mutants of the SQL text are killed by the unit tests, and a container for every one of them would be a cost for nothing.
// Every id here is invented.

const IMAGE = 'postgres:16.15-alpine'
const run = (args, options = {}) => spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, ...options })
const dockerUp = run(['info'], { timeout: 15_000 }).status === 0
const imageHere = () => run(['image', 'inspect', IMAGE]).status === 0
const pg = await import('pg').then(
  (m) => m.default,
  () => null,
)
const runnable = dockerUp && pg !== null && !process.env.STRYKER_MUTATOR_WORKER && (imageHere() || (run(['pull', IMAGE]).status === 0 && imageHere()))

const POST = '200000000000000410'
const MEMBER = '200000000000000414'
const OTHER = '200000000000000417'
const HOOK = '200000000000000415'
const OLD_HOOK = '200000000000000416'
const REPLIED = '200000000000000418'
const EPOCH = 1420070400000n
/** → a Discord snowflake made at `ms`, as text. */
const snow = (ms, n = 0) => String(((BigInt(ms) - EPOCH) << 22n) | BigInt(n))
const T0 = Date.parse('2026-11-18T10:00:00.000Z')
const AVATAR = 'https://cdn.example/invented/avatar.png'
const SOURCE = 'The *invented* source of a reply.'
const keyOf = () => randomBytes(16).toString('hex')

describe.skipIf(!runnable)('the outbox store on a real Postgres 16, as the data-only role', () => {
  const name = `librarius-pg-test-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(12).toString('hex')
  let port
  let owner
  let pool
  let store
  const sql = (text, params) => owner.query(text, params)
  const rows = async (text, params) => (await sql(text, params)).rows

  async function connectOwner(database) {
    // The container takes a few seconds to be reachable (it restarts once while it initialises).
    for (let tries = 0; ; tries++) {
      const candidate = new pg.Pool({ host: '127.0.0.1', port, user: 'salamanders', password, database, max: 4 })
      try {
        await candidate.query('select 1')
        return candidate
      } catch (err) {
        await candidate.end().catch(() => {})
        if (tries >= 60) throw err
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }

  const applySchema = () => sql(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))

  beforeAll(async () => {
    const started = run(['run', '-d', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_USER=salamanders', '-e', 'POSTGRES_DB=salamanders_builds', '-p', '127.0.0.1::5432', IMAGE])
    if (started.status !== 0) throw new Error(`the container did not start: ${started.stderr}`)
    port = Number(/:(\d+)\s*$/m.exec(run(['port', name, '5432/tcp']).stdout)[1])
    owner = await connectOwner('salamanders_builds')
    await applySchema()
    const role = spawnSync('docker', ['exec', '-i', name, 'psql', '-U', 'salamanders', '-d', 'salamanders_builds', '-v', 'ON_ERROR_STOP=1', '-v', `app_password=${password}`], {
      encoding: 'utf8',
      input: readFileSync(new URL('../app-role.sql', import.meta.url), 'utf8'),
    })
    if (role.status !== 0) throw new Error(`app-role.sql failed: ${role.stderr}`)
    // A second apply, with the role in place: schema.sql is safe to run again.
    await applySchema()
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'salamanders_app', password, database: 'salamanders_builds', max: 6 })
    // The container goes at the end of the run: a connection it drops then is not an error of a test.
    pool.on('error', () => {})
    owner.on('error', () => {})
    store = createLibrariusStore(pool)
  }, 180_000)

  afterAll(async () => {
    await store?.releaseWorkerLock().catch(() => {})
    await pool?.end().catch(() => {})
    await owner?.end().catch(() => {})
    run(['rm', '-f', name])
  }, 60_000)

  beforeEach(async () => {
    await store.releaseWorkerLock()
    await sql('truncate librarius_posts, librarius_outbox, librarius_events, librarius_tombstones, librarius_uploads, librarius_outbox_state restart identity cascade')
    await store.upsertPost({ id: POST, ownerId: MEMBER, title: 'An invented post', tagIds: [], pinned: false, locked: false, archived: false, createdAt: new Date(T0).toISOString() })
  })

  // ---- fixtures

  /** The message a finished reply stores, as the worker makes it. */
  const messageOf = (id, over = {}) => ({
    id,
    postId: POST,
    authorId: MEMBER,
    authorName: 'Invented Name',
    authorAvatar: AVATAR,
    webhookId: HOOK,
    content: SOURCE,
    replyTo: REPLIED,
    createdAt: new Date(T0).toISOString(),
    source: SOURCE,
    layout: { form: 'v2', replyTo: { messageId: REPLIED, authorId: OTHER, url: 'https://site.example/x' }, siteUrl: 'https://site.example/post', username: 'Invented Name', avatarUrl: AVATAR, images: [] },
    attachments: [],
    ...over,
  })

  /** Queues a reply that has sent `ids`, takes it, and finishes it as the worker does. → { entry, ids } */
  async function sentReply(ids, { hook = HOOK, author = MEMBER, source = SOURCE, over = {} } = {}) {
    const { id: entry } = await store.enqueueOutbox({
      kind: 'send',
      messageKey: keyOf(),
      authorId: author,
      payload: { postId: POST, source, progress: { form: 'v2', webhookId: hook, parts: ids.map((id) => ({ id, at: null, attachments: [] })), inflight: null } },
    })
    const claimed = await store.claimOutbox(Date.now())
    expect(claimed.id).toBe(entry)
    const done = await store.finishSend(entry, {
      message: messageOf(ids[0], { authorId: author, webhookId: hook, source, content: source, ...over }),
      partIds: ids,
      uploadIds: [],
      event: { action: 'send', postId: POST, messageId: ids[0], note: `${ids.length} parts` },
    })
    expect(done).toEqual({ stored: true, gone: [] })
    return { entry, ids }
  }

  /** What the import does to a message of Discord's: the row parseMessage makes of it, upserted as the catch-up does. */
  async function importAs(id, { webhook = HOOK, content = '', embeds = [] } = {}) {
    const row = parseMessage({
      id,
      channel_id: POST,
      type: 0,
      content,
      embeds,
      webhook_id: webhook,
      author: { id: webhook, username: 'The Webhook', avatar: null },
      timestamp: new Date(T0).toISOString(),
      attachments: [],
    })
    await store.upsertMessages([row])
  }

  const message = async (id) => (await rows('select * from librarius_messages where id = $1', [id]))[0]
  const partsOf = async (id) => (await rows('select discord_id, part_index, webhook_id from librarius_parts where message_id = $1 order by part_index', [id])).map((r) => [r.discord_id, r.part_index, r.webhook_id])
  const rev = async () => (await rows('select last_value from librarius_rev'))[0].last_value

  const A = snow(T0 + 1000, 1)
  const B = snow(T0 + 3000, 1)
  const C = snow(T0 + 5000, 1)

  // ---- schema

  describe('schema.sql', () => {
    it('can be applied again, and leaves the same constraints, columns and indexes', async () => {
      const before = await rows("select conname from pg_constraint where conrelid = 'librarius_parts'::regclass order by conname")
      await applySchema()
      expect(await rows("select conname from pg_constraint where conrelid = 'librarius_parts'::regclass order by conname")).toEqual(before)
      expect(before.map((r) => r.conname)).toEqual(expect.arrayContaining(['librarius_parts_message_fk', 'librarius_parts_index_check']))
      const columns = await rows("select column_name from information_schema.columns where table_name = 'librarius_parts' order by ordinal_position")
      expect(columns.map((r) => r.column_name)).toEqual(['message_id', 'part_index', 'discord_id', 'webhook_id'])
      const indexes = await rows("select indexname from pg_indexes where indexname = 'librarius_outbox_sending_idx'")
      expect(indexes).toHaveLength(1)
    })

    it('has one row of state at most, and the data-only role can write and read it', async () => {
      await sql("insert into librarius_outbox_state (id, paused_until) values (1, now())")
      await expect(sql('insert into librarius_outbox_state (id) values (2)')).rejects.toThrow(/check/)
      await pool.query("update librarius_outbox_state set global_until = now() where id = 1")
      expect((await pool.query('select global_until from librarius_outbox_state')).rows).toHaveLength(1)
    })

    it('keeps a part under its message: a part with no message is refused, and a message that goes takes its parts', async () => {
      await expect(pool.query('insert into librarius_parts (message_id, part_index, discord_id) values ($1, 0, $2)', [A, A])).rejects.toThrow(/librarius_parts_message_fk/)
      await sentReply([A, B])
      expect(await partsOf(A)).toHaveLength(2)
      await pool.query('delete from librarius_messages where id = $1', [A])
      expect(await partsOf(A)).toEqual([])
    })

    it('has three places for a part at most: 0 to 2', async () => {
      await sentReply([A, B, C])
      for (const place of [3, -1]) {
        await expect(pool.query('insert into librarius_parts (message_id, part_index, discord_id) values ($1, $2, $3)', [A, place, snow(T0 + 9000, 7)])).rejects.toThrow(/librarius_parts_index_check/)
      }
    })

    it('deletes the parts that would break the constraints when it adds them, and keeps the others', async () => {
      await sentReply([A, B])
      // The database as it was before the constraints: no foreign key and no range, with an orphan and a part out of range in it.
      await sql('alter table librarius_parts drop constraint librarius_parts_message_fk')
      await sql('alter table librarius_parts drop constraint librarius_parts_index_check')
      const orphan = snow(T0 + 7000, 2)
      const high = snow(T0 + 8000, 3)
      await sql('insert into librarius_parts (message_id, part_index, discord_id) values ($1, 0, $1), ($2, 7, $3)', [orphan, A, high])
      await applySchema()
      expect(await partsOf(orphan)).toEqual([])
      expect(await partsOf(A)).toEqual([
        [A, 0, HOOK],
        [B, 1, HOOK],
      ])
      expect((await rows('select 1 from librarius_parts where discord_id = $1', [high])).length).toBe(0)
      const names = (await rows("select conname from pg_constraint where conrelid = 'librarius_parts'::regclass")).map((r) => r.conname)
      expect(names).toEqual(expect.arrayContaining(['librarius_parts_message_fk', 'librarius_parts_index_check']))
    })
  })

  // ---- the lifecycle of the entries

  describe('the entries', () => {
    it('claims each due entry once, oldest due first, and never one that is not due yet', async () => {
      const first = await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'a' } })
      const second = await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'b' } })
      const claims = await Promise.all([store.claimOutbox(Date.now() + 1000), store.claimOutbox(Date.now() + 1000), store.claimOutbox(Date.now() + 1000)])
      expect(claims.filter((c) => c !== null).map((c) => c.id).sort()).toEqual([first.id, second.id].sort())
      expect(claims.filter((c) => c === null)).toHaveLength(1)
      expect((await store.outboxInterrupted()).map((e) => e.id)).toEqual([first.id, second.id])
      await store.outboxSet(first.id, { state: 'pending', attempts: 1, nextAt: Date.now() + 3_600_000 })
      expect(await store.claimOutbox(Date.now())).toBeNull()
      expect(Date.parse(await store.outboxNextAt())).toBeGreaterThan(Date.now() + 3_000_000)
    })

    it('writes progress and transitions only while the entry is sending', async () => {
      const { id } = await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'a' } })
      await store.outboxProgress(id, { form: 'v2', parts: [], inflight: null })
      expect((await rows('select payload from librarius_outbox where id = $1', [id]))[0].payload.progress).toBeUndefined()
      await store.claimOutbox(Date.now())
      await store.outboxProgress(id, { form: 'v2', parts: [], inflight: 0 })
      expect((await rows('select payload from librarius_outbox where id = $1', [id]))[0].payload.progress.inflight).toBe(0)
      await store.outboxSet(id, { state: 'failed', error: 'x' })
      await store.outboxSet(id, { state: 'sent' })
      expect((await rows('select state, last_error from librarius_outbox where id = $1', [id]))[0]).toEqual({ state: 'failed', last_error: 'x' })
    })

    it('stores a reply with its parts, each with the webhook of the message, and says it is done once', async () => {
      const { entry } = await sentReply([A, B, C])
      expect(await partsOf(A)).toEqual([
        [A, 0, HOOK],
        [B, 1, HOOK],
        [C, 2, HOOK],
      ])
      expect(await store.knownPartIds([A, B, C, '200000000000000999'])).toEqual(new Set([A, B, C]))
      expect(await store.messageOfPart(C)).toBe(A)
      expect((await message(A)).origin).toBe('site')
      expect((await rows('select state from librarius_outbox where id = $1', [entry]))[0].state).toBe('sent')
      expect(await store.finishSend(entry, { message: messageOf(A), partIds: [A, B, C], uploadIds: [], event: { action: 'send' } })).toEqual({ stored: true, gone: [] })
      expect((await rows("select 1 from librarius_events where action = 'send'")).length).toBe(1)
    })

    it('replaces the phantom messages an import stored for later parts, with tombstones', async () => {
      await importAs(B)
      await sentReply([A, B])
      expect(await message(B)).toBeUndefined()
      expect((await rows('select message_id from librarius_tombstones')).map((r) => r.message_id)).toEqual([B])
    })

    it('refuses a part that another reply owns, and writes none of the reply', async () => {
      await sentReply([A, B])
      const { id } = await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'x' } })
      await store.claimOutbox(Date.now())
      await expect(store.finishSend(id, { message: messageOf(C), partIds: [C, B], uploadIds: [], event: { action: 'send' } })).rejects.toThrow()
      expect(await message(C)).toBeUndefined()
    })

    it('finishes an edit with the new parts, and a delete with the message gone and noted', async () => {
      await sentReply([A, B, C])
      const edit = await store.enqueueOutbox({ kind: 'edit', messageKey: A, authorId: MEMBER, payload: { postId: POST, source: 'new', mentions: [] } })
      expect((await message(A)).state).toBe('sending')
      await store.claimOutbox(Date.now())
      expect(await store.finishEdit(edit.id, { messageId: A, source: 'new', content: 'new', partIds: [A, B], event: { action: 'edit', postId: POST, messageId: A } })).toEqual({ stored: true, gone: [] })
      expect(await partsOf(A)).toEqual([
        [A, 0, HOOK],
        [B, 1, HOOK],
      ])
      expect((await message(A)).state).toBeNull()
      expect((await message(A)).content).toBe('new')
      const del = await store.enqueueOutbox({ kind: 'delete', messageKey: A, authorId: MEMBER, payload: { postId: POST } })
      await store.claimOutbox(Date.now())
      await store.finishDelete(del.id, { messageId: A, partIds: [A, B], event: { action: 'delete', postId: POST, messageId: A } })
      expect(await message(A)).toBeUndefined()
      expect(await partsOf(A)).toEqual([])
      expect((await rows('select message_id from librarius_tombstones')).map((r) => r.message_id)).toEqual([A])
    })

    it('answers the message the worker acts on, with its webhook and its parts', async () => {
      await sentReply([A, B], { hook: OLD_HOOK })
      expect(await store.outboxMessage(A)).toMatchObject({ id: A, postId: POST, authorId: MEMBER, webhookId: OLD_HOOK, origin: 'site', source: SOURCE, state: null, parts: [A, B] })
      expect(await store.outboxMessage('200000000000000999')).toBeNull()
    })

    it('takes the whole reply when a part is deleted in Discord, and queues the deletion of the parts that are left, with their webhook', async () => {
      await sentReply([A, B, C], { hook: OLD_HOOK })
      expect(await store.siteDeleted([B, '200000000000000999'], POST)).toEqual({ plain: ['200000000000000999'] })
      expect(await message(A)).toBeUndefined()
      expect(await partsOf(A)).toEqual([])
      const queued = await rows("select kind, message_key, payload from librarius_outbox where kind = 'delete'")
      expect(queued).toHaveLength(1)
      expect(queued[0]).toMatchObject({ message_key: A, payload: { postId: POST, partIds: [A, C], webhookId: OLD_HOOK } })
      expect((await rows("select 1 from librarius_events where action = 'deleted-in-discord'")).length).toBe(1)
    })

    it('notes a part lost while its reply is on its way in that entry, and finishSend then stores nothing', async () => {
      const { id } = await store.enqueueOutbox({
        kind: 'send',
        messageKey: keyOf(),
        authorId: MEMBER,
        payload: { postId: POST, source: SOURCE, progress: { form: 'v2', webhookId: HOOK, parts: [{ id: A, at: null, attachments: [] }, { id: B, at: null, attachments: [] }], inflight: null } },
      })
      await store.claimOutbox(Date.now())
      expect(await store.siteDeleted([B], POST)).toEqual({ plain: [B] })
      expect(await store.finishSend(id, { message: messageOf(A), partIds: [A, B], uploadIds: [], event: { action: 'send' } })).toEqual({ stored: false, gone: [B] })
      expect(await message(A)).toBeUndefined()
    })

    it('lists the author’s entries that are not done, sweeps old uploads and spares those a live reply names', async () => {
      const held = await store.addUpload({ authorId: MEMBER, name: 'picture.png', contentType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) })
      const used = await store.addUpload({ authorId: MEMBER, name: 'picture.png', contentType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) })
      await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'with a picture', uploads: [used.id] } })
      await sql("update librarius_uploads set created_at = now() - interval '2 hours'")
      expect(await store.sweepUploads({ olderThan: new Date(Date.now() - 3_600_000) })).toBe(1)
      expect((await store.uploadsFor(MEMBER, [held.id, used.id])).map((u) => u.id)).toEqual([used.id])
      const listed = await store.outboxFor(MEMBER, POST, new Date(Date.now() - 60_000))
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({ kind: 'send', state: 'pending', source: 'with a picture' })
    })
  })

  // ---- what a restart must not lose

  describe('what the worker holds', () => {
    it('keeps the pause and the global hold, and never moves one back', async () => {
      expect(await store.outboxHold()).toEqual({ pausedUntil: null, globalUntil: null })
      const { id } = await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'a' } })
      await store.claimOutbox(Date.now())
      await store.outboxSet(id, { state: 'blocked', error: 'x', hold: { pausedUntil: '2026-11-18T11:00:00.000Z' } })
      expect(await store.outboxHold()).toEqual({ pausedUntil: '2026-11-18T11:00:00.000Z', globalUntil: null })
      const second = await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'b' } })
      await store.claimOutbox(Date.now())
      await store.outboxSet(second.id, { state: 'pending', nextAt: Date.now(), hold: { globalUntil: '2026-11-18T10:05:00.000Z' } })
      expect(await store.outboxHold()).toEqual({ pausedUntil: '2026-11-18T11:00:00.000Z', globalUntil: '2026-11-18T10:05:00.000Z' })
      await store.claimOutbox(Date.now())
      await store.outboxSet(second.id, { state: 'pending', nextAt: Date.now(), hold: { pausedUntil: '2026-11-18T10:30:00.000Z', globalUntil: '2026-11-18T10:06:00.000Z' } })
      expect(await store.outboxHold()).toEqual({ pausedUntil: '2026-11-18T11:00:00.000Z', globalUntil: '2026-11-18T10:06:00.000Z' })
    })

    it('notes a block of the links edit with its pause, and nothing for an entry that is not at work', async () => {
      const { id } = await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'a' } })
      await store.noteBlock(id, { event: { action: 'blocked', postId: POST, note: 'links' }, hold: { pausedUntil: '2026-11-18T11:00:00.000Z' } })
      expect(await store.blockedSince(new Date(0))).toEqual([])
      await store.claimOutbox(Date.now())
      await store.noteBlock(id, { event: { action: 'blocked', postId: POST, note: 'links' }, hold: { pausedUntil: '2026-11-18T11:00:00.000Z' } })
      expect(await store.blockedSince(new Date(0))).toHaveLength(1)
      expect((await rows('select actor_id from librarius_events'))[0].actor_id).toBe(MEMBER)
      expect((await store.outboxHold()).pausedUntil).toBe('2026-11-18T11:00:00.000Z')
    })

    it('answers when the parts landed, from the progress of any entry, since a time', async () => {
      const long = snow(T0 - 3_600_000, 1)
      const first = snow(T0 + 10_000, 1)
      const second = snow(T0 + 20_000, 2)
      const third = snow(T0 + 30_000, 3)
      await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'a', progress: { parts: [{ id: long }, { id: first }, { id: second }] } } })
      await store.enqueueOutbox({ kind: 'edit', messageKey: A, authorId: MEMBER, payload: { postId: POST, source: 'b', progress: { parts: [{ id: third }] } } })
      await store.enqueueOutbox({ kind: 'delete', messageKey: A, authorId: MEMBER, payload: { postId: POST, progress: { parts: [{ id: snow(T0 + 40_000) }] } } })
      await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'no progress' } })
      await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'x', progress: { parts: [{ id: 'not an id' }] } } })
      expect(await store.sendTimesSince(new Date(T0))).toEqual([new Date(T0 + 10_000), new Date(T0 + 20_000), new Date(T0 + 30_000)].map((d) => d.toISOString()))
      expect(await store.sendTimesSince(new Date(T0 + 20_000))).toHaveLength(2)
    })

    it('knows the webhooks that sent a stored part, and one that is sending a reply that is not stored yet', async () => {
      expect(await store.ownWebhookIds()).toEqual(new Set())
      await sentReply([A, B], { hook: OLD_HOOK })
      await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'x', progress: { webhookId: HOOK, parts: [] } } })
      await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'x', progress: { webhookId: 'nonsense', parts: [] } } })
      expect(await store.ownWebhookIds()).toEqual(new Set([OLD_HOOK, HOOK]))
    })

    it('lets one connection hold the worker lock, and another take it when it is let go or lost', async () => {
      const otherPool = new pg.Pool({ host: '127.0.0.1', port, user: 'salamanders_app', password, database: 'salamanders_builds', max: 2 })
      const other = createLibrariusStore(otherPool)
      try {
        expect(await store.takeWorkerLock()).toBe(true)
        expect(await store.takeWorkerLock()).toBe(true)
        expect(await other.takeWorkerLock()).toBe(false)
        await store.releaseWorkerLock()
        expect(await other.takeWorkerLock()).toBe(true)
        expect(await store.takeWorkerLock()).toBe(false)
        await other.releaseWorkerLock()
        expect(await store.takeWorkerLock()).toBe(true)
        await store.releaseWorkerLock()
      } finally {
        await other.releaseWorkerLock()
        await otherPool.end()
      }
    })

    it('shares no key with the Deathwatch lock, which a transaction takes and lets go of', async () => {
      expect(await store.takeWorkerLock()).toBe(true)
      const client = await pool.connect()
      try {
        // The Deathwatch's access lock is 18000002: a different key, so it is free while the worker holds its own.
        expect((await client.query('select pg_try_advisory_xact_lock(18000002) as got')).rows[0].got).toBe(true)
        expect((await client.query('select pg_try_advisory_xact_lock(19000001) as got')).rows[0].got).toBe(false)
      } finally {
        client.release()
      }
      await store.releaseWorkerLock()
    })

    it('prunes the entries that are done and old, and the events that are old, and nothing else', async () => {
      const old = "now() - interval '3 days'"
      const mk = async (state) => {
        const { id } = await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: state } })
        await sql(`update librarius_outbox set state = $2, created_at = ${old} where id = $1`, [id, state])
        return id
      }
      const [sent, failed, blocked, sending, pending] = [await mk('sent'), await mk('failed'), await mk('blocked'), await mk('sending'), await mk('pending')]
      const fresh = await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'fresh' } })
      await sql("update librarius_outbox set state = 'sent' where id = $1", [fresh.id])
      await sql("insert into librarius_events (actor_id, action, at) values ($1, 'old', now() - interval '100 days'), ($1, 'new', now() - interval '10 days')", [MEMBER])
      const out = await store.pruneOutbox({ sentBefore: new Date(Date.now() - 86_400_000), eventsBefore: new Date(Date.now() - 90 * 86_400_000) })
      expect(out).toEqual({ entries: 1, events: 1 })
      expect((await rows('select id from librarius_outbox order by id')).map((r) => r.id).sort()).toEqual([failed, blocked, sending, pending, fresh.id].sort())
      expect(sent).toBeDefined()
      expect((await rows('select action from librarius_events')).map((r) => r.action)).toEqual(['new'])
    })

    it('has an index for the entries it left sending', async () => {
      const plan = await rows("explain select id from librarius_outbox where state = 'sending' order by id")
      expect(plan.length).toBeGreaterThan(0)
      expect((await rows("select indexdef from pg_indexes where indexname = 'librarius_outbox_sending_idx'"))[0].indexdef).toContain("WHERE (state = 'sending'::text)")
    })
  })

  // ---- the repair

  describe('repairSiteMessages', () => {
    /** The damage the reviewer described: parts 2 and 3 stored as messages of their own, and part 1's author rewritten to the webhook with no text. */
    async function damage(ids = [A, B, C], hook = HOOK) {
      await sentReply(ids, { hook })
      await importAs(ids[1], { webhook: hook, content: '' })
      if (ids[2] !== undefined) await importAs(ids[2], { webhook: hook, content: 'part three' })
      await importAs(ids[0], { webhook: hook, content: '' })
    }

    it('writes the site’s own author, text, name, picture and reply link back over part 1, and deletes the phantom parts', async () => {
      await damage()
      const hurt = await message(A)
      expect(hurt).toMatchObject({ author_id: HOOK, content: '', author_name: 'The Webhook', author_avatar: null, reply_to: null })
      expect((await message(B)) !== undefined && (await message(C)) !== undefined).toBe(true)
      const before = await rev()
      expect(await store.repairSiteMessages()).toEqual({ removed: 2, restored: 1 })
      expect(await message(B)).toBeUndefined()
      expect(await message(C)).toBeUndefined()
      expect((await rows('select message_id from librarius_tombstones order by message_id')).map((r) => r.message_id)).toEqual([B, C])
      const healed = await message(A)
      expect(healed).toMatchObject({ author_id: MEMBER, content: SOURCE, author_name: 'Invented Name', author_avatar: AVATAR, reply_to: REPLIED, origin: 'site', webhook_id: HOOK })
      expect(BigInt(healed.rev)).toBeGreaterThan(BigInt(before))
      expect(await partsOf(A)).toHaveLength(3)
    })

    it('stamps one rev on all of it, and a second run writes nothing and takes no rev', async () => {
      await damage()
      await store.repairSiteMessages()
      const healed = await message(A)
      const tombstones = await rows('select rev from librarius_tombstones')
      expect(new Set(tombstones.map((t) => t.rev))).toEqual(new Set([healed.rev]))
      const after = await rev()
      expect(await store.repairSiteMessages()).toEqual({ removed: 0, restored: 0 })
      expect(await rev()).toBe(after)
      expect((await message(A)).rev).toBe(healed.rev)
    })

    it('finds the author in the event when the entry is pruned, and leaves the author alone when both are gone', async () => {
      await damage()
      await sql('delete from librarius_outbox')
      expect(await store.repairSiteMessages()).toEqual({ removed: 2, restored: 1 })
      expect((await message(A)).author_id).toBe(MEMBER)
      await importAs(A, { content: '' })
      await sql('delete from librarius_events')
      await store.repairSiteMessages()
      const kept = await message(A)
      expect(kept.author_id).toBe(HOOK)
      expect(kept.content).toBe(SOURCE)
    })

    it('takes the author of the newest entry that sent the message, over an event', async () => {
      await damage()
      await sql("insert into librarius_events (actor_id, action, post_id, message_id) values ($1, 'send', $2, $3)", [OTHER, POST, A])
      await store.repairSiteMessages()
      expect((await message(A)).author_id).toBe(MEMBER)
    })

    it('cuts the text to 4000 characters as the worker does, by characters and not by bytes', async () => {
      const long = `${'é'.repeat(3999)}😀tail`
      await sentReply([A], { source: long, over: { content: Array.from(long).slice(0, 4000).join('') } })
      await importAs(A, { content: '' })
      await store.repairSiteMessages()
      expect((await message(A)).content).toBe(Array.from(long).slice(0, 4000).join(''))
    })

    it('leaves a message of a person, a reply of the site that is whole, and a site message with no layout as they are', async () => {
      await importAs(snow(T0 + 500, 9), { webhook: OTHER })
      await sql("update librarius_messages set author_id = $1, content = 'person' where id = $2", [OTHER, snow(T0 + 500, 9)])
      await sentReply([B, C])
      await sentReply([A], { over: {} })
      await sql('update librarius_messages set layout = null, content = $2 where id = $1', [A, 'edited by hand'])
      const before = await rev()
      expect(await store.repairSiteMessages()).toEqual({ removed: 0, restored: 0 })
      expect(await rev()).toBe(before)
      expect((await message(A)).content).toBe('edited by hand')
    })

    it('gives a part with no webhook its message’s, so that the webhook is known again', async () => {
      await sentReply([A, B])
      await sql('update librarius_parts set webhook_id = null')
      // (The entry that sent the reply names the webhook too, so it goes: this is a database the parts of which were written before the column.)
      await sql('delete from librarius_outbox')
      expect(await store.ownWebhookIds()).toEqual(new Set())
      await store.repairSiteMessages()
      expect(await store.ownWebhookIds()).toEqual(new Set([HOOK]))
      expect(await partsOf(A)).toEqual([
        [A, 0, HOOK],
        [B, 1, HOOK],
      ])
    })

    it('works for a reply of a webhook that was replaced, and for a reply with no reply link', async () => {
      await sentReply([A, B], { hook: OLD_HOOK, over: { replyTo: null, layout: { form: 'v2', replyTo: null, siteUrl: 'https://site.example/p', username: 'Name', avatarUrl: null, images: [] } } })
      await importAs(B, { webhook: OLD_HOOK })
      await importAs(A, { webhook: OLD_HOOK })
      await store.repairSiteMessages()
      expect(await message(B)).toBeUndefined()
      expect(await message(A)).toMatchObject({ author_id: MEMBER, reply_to: null, author_avatar: null, author_name: 'Name', webhook_id: OLD_HOOK })
    })
  })
})
