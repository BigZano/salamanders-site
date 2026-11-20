import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createLibrariusStore } from './librariusStore.js'
import { createLibrariusHandler } from './librariusHandler.js'
import { createImport } from './librariusImport.js'
import { createOutbox } from './librariusOutbox.js'
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
const FORUM = '200000000000000419'
const GUILD = '200000000000000421'
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

  /**
   * What the rollback image (batch 1, which knows no reply of the site) does to a message of the webhook: its upsert, which writes over
   * any row. The upsert of this code leaves a row of the site alone, so the damage the repair puts right is made with batch 1's statement.
   */
  async function oldImageAs(id, { webhook = HOOK, content = '' } = {}) {
    await sql(
      `insert into librarius_messages (id, post_id, author_id, author_name, author_avatar, webhook_id, kind, content, embeds, stickers, reactions, reply_to, created_at, edited_at, rev)
       values ($1, $2, $3, 'The Webhook', null, $3, 0, $4, '[]', '[]', '[]', null, $5, null, nextval('librarius_rev'))
       on conflict (id) do update set author_id = excluded.author_id, author_name = excluded.author_name, author_avatar = excluded.author_avatar,
         webhook_id = excluded.webhook_id, kind = excluded.kind, content = excluded.content, embeds = excluded.embeds, stickers = excluded.stickers,
         reactions = excluded.reactions, reply_to = excluded.reply_to, edited_at = excluded.edited_at, rev = excluded.rev`,
      [id, POST, webhook, content, new Date(T0).toISOString()],
    )
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

    it('applies on top of a database that has only batch 1’s Librarius tables, with its messages kept as they are, and again after that', async () => {
      const text = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
      const batch1 = text.slice(0, text.indexOf('-- What the site sends to Discord (batch 2'))
      expect(batch1).toContain('create table if not exists librarius_sync')
      expect(batch1).not.toContain('librarius_outbox')
      await sql('create database live_like')
      const live = await connectOwner('live_like')
      live.on('error', () => {})
      try {
        await live.query(batch1)
        await live.query("insert into librarius_posts (id, title, created_at) values ($1, 'An invented post', now())", [POST])
        await live.query("insert into librarius_messages (id, post_id, author_id, author_name, kind, content, created_at) values ($1, $2, $3, 'A Person', 0, 'written in Discord', now())", [A, POST, MEMBER])
        await live.query(text)
        await live.query(text)
        const kept = (await live.query('select origin, content, source, state, layout from librarius_messages where id = $1', [A])).rows[0]
        expect(kept).toEqual({ origin: 'discord', content: 'written in Discord', source: null, state: null, layout: null })
        const names = (await live.query("select conname from pg_constraint where conrelid = 'librarius_parts'::regclass")).rows.map((r) => r.conname)
        expect(names).toEqual(expect.arrayContaining(['librarius_parts_message_fk', 'librarius_parts_index_check']))
        expect((await live.query('select count(*)::int as n from librarius_outbox_state')).rows[0].n).toBe(0)
      } finally {
        await live.end()
        await sql('drop database live_like')
      }
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

    it('writes the author of the entry into the layout of the reply it stores', async () => {
      await sentReply([A, B])
      await sentReply([C], { author: OTHER })
      expect((await message(A)).layout.authorId).toBe(MEMBER)
      expect((await message(C)).layout.authorId).toBe(OTHER)
      expect((await message(C)).layout.username).toBe('Invented Name')
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

    it('queues, with an edit that makes a reply shorter, the delete of the parts it drops: the reply stays as edited while that delete runs and after', async () => {
      await sentReply([A, B, C])
      const { id: edit } = await store.enqueueOutbox({ kind: 'edit', messageKey: A, authorId: OTHER, payload: { postId: POST, source: 'Shorter.', mentions: [] } })
      await store.claimOutbox(Date.now())
      const drop = { kind: 'delete', messageKey: B, payload: { postId: POST, partIds: [B, C], webhookId: HOOK, replyId: A } }
      expect(await store.finishEdit(edit, { messageId: A, source: 'Shorter.', content: 'Shorter.', partIds: [A], event: { action: 'edit', postId: POST, messageId: A, note: '1 part' }, queue: [drop] })).toEqual({ stored: true, gone: [] })
      expect(await partsOf(A)).toEqual([[A, 0, HOOK]])
      expect(await message(A)).toMatchObject({ source: 'Shorter.', state: null })
      // The delete is the edit's author's, keyed by the first part it removes: no message has that id, so none shows a delete on its way.
      const queued = await rows("select id, state, message_key, author_id, payload from librarius_outbox where kind = 'delete'")
      expect(queued).toMatchObject([{ state: 'pending', message_key: B, author_id: OTHER, payload: drop.payload }])
      // The worker takes it, and asks for its message: there is none, so it removes the parts it names (runDelete).
      const del = await store.claimOutbox(Date.now())
      expect(del).toMatchObject({ id: queued[0].id, kind: 'delete', messageKey: B })
      expect(await store.outboxMessage(B)).toBeNull()
      // Discord tells of each removal while the delete is at work: no reply has those parts any more, so they are messages the store does not have.
      expect(await store.siteDeleted([B], POST)).toEqual({ plain: [B] })
      await store.finishDelete(del.id, { messageId: B, partIds: [B, C], event: { action: 'delete', postId: POST, messageId: B, note: null } })
      expect(await store.siteDeleted([C], POST)).toEqual({ plain: [C] })
      expect(await message(A)).toMatchObject({ source: 'Shorter.', content: 'Shorter.', state: null, origin: 'site' })
      expect(await partsOf(A)).toEqual([[A, 0, HOOK]])
      expect(await rows('select message_id from librarius_tombstones')).toEqual([])
      expect((await rows('select state from librarius_outbox where id = $1', [del.id]))[0].state).toBe('sent')
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

    it('lets a delete of the reply finish while a deletion in Discord of one of its parts waits for it: an entry is locked before its message, so neither waits on the other in a ring', async () => {
      await sentReply([A, B])
      const del = await store.enqueueOutbox({ kind: 'delete', messageKey: A, authorId: MEMBER, payload: { postId: POST } })
      expect((await store.claimOutbox(Date.now())).id).toBe(del.id)
      // finishDelete's own statements, one at a time on a connection of their own, so that the echo can come in between: the entry first...
      const worker = await pool.connect()
      try {
        await worker.query('begin')
        await worker.query("update librarius_outbox set state = 'sent', last_error = null where id = $1 and state = 'sending' returning author_id", [del.id])
        // ...then the gateway's echo of the removal of part 2 comes in, and waits for the entry...
        const echo = store.siteDeleted([B], POST).then(
          (out) => ({ out }),
          (err) => ({ err }),
        )
        for (let tries = 0; (await rows("select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()"))[0].n === 0; tries++) {
          if (tries > 100) throw new Error('the echo never waited for a lock')
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        // ...and then the message, which the echo has not locked: with the other order this waits on the echo, the echo on this, and Postgres ends one of them.
        await worker.query('insert into librarius_tombstones (message_id, post_id, rev) select id, post_id, 1 from librarius_messages where id = $1', [A])
        await worker.query('delete from librarius_messages where id = $1', [A])
        await worker.query('commit')
        expect(await echo).toEqual({ out: { plain: [] } })
      } finally {
        await worker.query('rollback').catch(() => {})
        worker.release()
      }
      expect(await message(A)).toBeUndefined()
      expect(await partsOf(A)).toEqual([])
      // The delete took the reply: the echo found nothing of it left, so it queued no second delete and noted nothing.
      expect(await rows("select id from librarius_outbox where kind = 'delete' and state <> 'sent'")).toEqual([])
      expect(await rows("select 1 from librarius_events where action = 'deleted-in-discord'")).toEqual([])
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

    // A part is deleted in Discord while an edit of its reply is on its way: by a moderator, or by an edit of an earlier version of the worker,
    // which removed the parts it no longer needed before finishEdit wrote the new list (this one queues their delete with finishEdit, above).
    // Discord's gateway tells of each deletion with a MESSAGE_DELETE, which the live feed hands to siteDeleted.
    describe('a deletion in Discord while an edit of the reply is on its way', () => {
      /** Queues an edit of the reply A, and takes it as the worker does unless it is to stay pending. → the entry's id */
      async function editOfA({ take = true } = {}) {
        const { id } = await store.enqueueOutbox({ kind: 'edit', messageKey: A, authorId: MEMBER, payload: { postId: POST, source: 'Shorter.', mentions: [] } })
        if (take) expect((await store.claimOutbox(Date.now())).id).toBe(id)
        return id
      }
      const entryRow = async (id) => (await rows('select state, payload from librarius_outbox where id = $1', [id]))[0]
      const shorter = (id, partIds) => store.finishEdit(id, { messageId: A, source: 'Shorter.', content: 'Shorter.', partIds, event: { action: 'edit', postId: POST, messageId: A, note: `${partIds.length} parts` } })
      const nothingTaken = async () => {
        expect(await rows("select id from librarius_outbox where kind = 'delete'")).toEqual([])
        expect(await rows("select 1 from librarius_events where action = 'deleted-in-discord'")).toEqual([])
        expect(await rows('select message_id from librarius_tombstones')).toEqual([])
      }
      async function waitsForLock() {
        for (let tries = 0; (await rows("select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()"))[0].n === 0; tries++) {
          if (tries > 100) throw new Error('the echo never waited for a lock')
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }

      it.each([
        ['one at a time, each after its removal', [[B], [C]]],
        ['together', [[B, C]]],
      ])('keeps a reply of three parts edited down to one, when Discord tells of the removals of parts 2 and 3 %s before the edit is done', async (_, echoes) => {
        await sentReply([A, B, C])
        const edit = await editOfA()
        const done = [`edit:${A}`]
        for (const echo of echoes) {
          for (const id of echo) {
            done.push(`remove:${id}`)
            await store.outboxProgress(edit, { form: 'v2', parts: [], inflight: null, done: [...done] })
          }
          expect(await store.siteDeleted(echo, POST)).toEqual({ plain: [] })
        }
        // The reply is left to the edit, which is told: nothing of the reply is deleted, queued or noted, and the worker's progress is kept.
        expect((await message(A)).state).toBe('sending')
        expect(await partsOf(A)).toEqual([
          [A, 0, HOOK],
          [B, 1, HOOK],
          [C, 2, HOOK],
        ])
        expect(await entryRow(edit)).toMatchObject({ state: 'sending', payload: { gone: [B, C], progress: { done } } })
        await nothingTaken()
        // The edit is done: the parts it removed itself do not count.
        expect(await shorter(edit, [A])).toEqual({ stored: true, gone: [] })
        expect(await partsOf(A)).toEqual([[A, 0, HOOK]])
        expect(await message(A)).toMatchObject({ source: 'Shorter.', content: 'Shorter.', state: null, origin: 'site', author_id: MEMBER })
        expect((await entryRow(edit)).state).toBe('sent')
        await nothingTaken()
        // An echo that comes in after the edit is done finds no part of a reply: it is a message the store does not have.
        expect(await store.siteDeleted([C], POST)).toEqual({ plain: [C] })
        expect(await partsOf(A)).toEqual([[A, 0, HOOK]])
      })

      it.each([
        ['its second part', B],
        ['its first part, the message', A],
      ])('still takes the reply when a moderator deletes %s, which the edit keeps, while the edit is on its way', async (_, kept) => {
        await sentReply([A, B, C])
        const edit = await editOfA()
        await store.outboxProgress(edit, { form: 'v2', parts: [], inflight: null, done: [`edit:${A}`, `edit:${B}`, `remove:${C}`] })
        expect(await store.siteDeleted([C], POST)).toEqual({ plain: [] })
        expect(await store.siteDeleted([kept], POST)).toEqual({ plain: [] })
        expect(await shorter(edit, [A, B])).toEqual({ stored: false, gone: [kept] })
        // Nothing was written: the reply is as it was, and the entry is still the worker's.
        expect(await partsOf(A)).toHaveLength(3)
        expect((await message(A)).source).toBe(SOURCE)
        expect((await entryRow(edit)).state).toBe('sending')
        // The worker then purges the rest (runEdit): it removes the parts but the one that is gone, and finishes the entry as a delete.
        await store.finishDelete(edit, { messageId: A, partIds: [A, B, C].filter((id) => id !== kept), event: { action: 'delete', postId: POST, messageId: A, note: 'A part was deleted in Discord.' } })
        expect(await message(A)).toBeUndefined()
        expect(await partsOf(A)).toEqual([])
        expect((await rows('select message_id from librarius_tombstones')).map((r) => r.message_id)).toEqual([A])
        expect((await entryRow(edit)).state).toBe('sent')
        expect(await rows("select id from librarius_outbox where kind = 'delete'")).toEqual([])
      })

      it('leaves the reply to an edit that is queued and not begun, as to one at work', async () => {
        await sentReply([A, B, C])
        const edit = await editOfA({ take: false })
        expect(await store.siteDeleted([B], POST)).toEqual({ plain: [] })
        expect(await entryRow(edit)).toMatchObject({ state: 'pending', payload: { gone: [B] } })
        expect(await partsOf(A)).toHaveLength(3)
        await nothingTaken()
        // When it runs and keeps part 2, it is told, and the worker purges the reply.
        await store.claimOutbox(Date.now())
        expect(await shorter(edit, [A, B, C])).toEqual({ stored: false, gone: [B] })
      })

      it.each(['sent', 'failed', 'blocked'])('takes the whole reply as before when the edit of it is %s', async (state) => {
        await sentReply([A, B, C])
        const edit = await editOfA()
        if (state === 'sent') expect(await shorter(edit, [A, B, C])).toEqual({ stored: true, gone: [] })
        else await store.outboxSet(edit, { state, messageState: state === 'blocked' ? 'blocked' : null })
        expect(await store.siteDeleted([B], POST)).toEqual({ plain: [] })
        expect(await message(A)).toBeUndefined()
        expect(await rows("select message_key, payload from librarius_outbox where kind = 'delete'")).toEqual([{ message_key: A, payload: { postId: POST, partIds: [A, C], webhookId: HOOK } }])
        expect((await rows("select 1 from librarius_events where action = 'deleted-in-discord'")).length).toBe(1)
        expect((await entryRow(edit)).payload.gone).toBeUndefined()
      })

      it.each([
        ['a delete from the route, which reads its parts when it runs: one of its own is queued beside it', { postId: POST }, 2],
        ['a delete that knows its parts: nothing more is queued', { postId: POST, partIds: [A, B, C] }, 1],
      ])('takes the whole reply as before with %s', async (_, payload, deletes) => {
        await sentReply([A, B, C])
        await store.enqueueOutbox({ kind: 'delete', messageKey: A, authorId: MEMBER, payload })
        expect(await store.siteDeleted([B], POST)).toEqual({ plain: [] })
        expect(await message(A)).toBeUndefined()
        expect(await partsOf(A)).toEqual([])
        expect(await rows("select 1 from librarius_outbox where kind = 'delete' and state = 'pending'")).toHaveLength(deletes)
        expect((await rows("select 1 from librarius_events where action = 'deleted-in-discord'")).length).toBe(1)
      })

      it('keeps the reply when the edit is done while the echo of its removals waits for the entry: by then they are no parts of it', async () => {
        await sentReply([A, B, C])
        const edit = await editOfA()
        const worker = await pool.connect()
        try {
          // finishEdit's own statements, one at a time on a connection of their own: the entry is locked first, and the reply made one part...
          await worker.query('begin')
          await worker.query("select coalesce(payload->'gone', '[]'::jsonb) as gone, author_id from librarius_outbox where id = $1 and state = 'sending' for update", [edit])
          await worker.query("update librarius_messages set source = 'Shorter.', content = 'Shorter.', edited_at = now(), state = null, rev = nextval('librarius_rev') where id = $1 and origin = 'site'", [A])
          await worker.query('delete from librarius_parts where message_id = $1', [A])
          await worker.query('insert into librarius_parts (message_id, part_index, discord_id, webhook_id) values ($1, 0, $1, $2)', [A, HOOK])
          await worker.query("update librarius_outbox set state = 'sent', last_error = null where id = $1", [edit])
          // ...then the echo of the removals of parts 2 and 3 comes in: it still reads them as parts of the reply, and waits for the entry...
          const echo = store.siteDeleted([B, C], POST).then(
            (out) => ({ out }),
            (err) => ({ err }),
          )
          await waitsForLock()
          // ...and the edit is done.
          await worker.query('commit')
          expect(await echo).toEqual({ out: { plain: [] } })
        } finally {
          await worker.query('rollback').catch(() => {})
          worker.release()
        }
        expect(await partsOf(A)).toEqual([[A, 0, HOOK]])
        expect(await message(A)).toMatchObject({ source: 'Shorter.', state: null })
        await nothingTaken()
      })
    })

    it('lists the author’s entries that are not done, sweeps old uploads and spares those a live reply names', async () => {
      const held = await store.addUpload({ authorId: MEMBER, name: 'picture.png', contentType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]), maxHeldBytes: 1_000_000 })
      const used = await store.addUpload({ authorId: MEMBER, name: 'picture.png', contentType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]), maxHeldBytes: 1_000_000 })
      await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'with a picture', uploads: [used.id] } })
      await sql("update librarius_uploads set created_at = now() - interval '2 hours'")
      expect(await store.sweepUploads({ olderThan: new Date(Date.now() - 3_600_000) })).toBe(1)
      expect((await store.uploadsFor(MEMBER, [held.id, used.id])).map((u) => u.id)).toEqual([used.id])
      const listed = await store.outboxFor(MEMBER, POST, new Date(Date.now() - 60_000))
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({ kind: 'send', state: 'pending', source: 'with a picture' })
    })
  })

  it('holds a picture only while its author holds at most the cap of bytes, this one included, each author apart, and frees the room when one goes', async () => {
    const picture = (authorId, length) => ({ authorId, name: 'picture.png', contentType: 'image/png', bytes: new Uint8Array(length).fill(7) })
    const first = await store.addUpload({ ...picture(MEMBER, 600), maxHeldBytes: 1000 })
    expect(first).toEqual({ id: expect.any(String) })
    expect(await store.addUpload({ ...picture(MEMBER, 401), maxHeldBytes: 1000 })).toBeNull() // 1001 would be over
    const exact = await store.addUpload({ ...picture(MEMBER, 400), maxHeldBytes: 1000 }) // 1000 is not
    expect(exact).toEqual({ id: expect.any(String) })
    expect(await store.addUpload({ ...picture(MEMBER, 1), maxHeldBytes: 1000 })).toBeNull()
    expect(await store.addUpload({ ...picture(OTHER, 1000), maxHeldBytes: 1000 })).toEqual({ id: expect.any(String) })
    expect(await rows('select author_id::text as author, count(*)::int as n, sum(octet_length(bytes))::int as bytes from librarius_uploads group by 1 order by 1')).toEqual([
      { author: MEMBER, n: 2, bytes: 1000 },
      { author: OTHER, n: 1, bytes: 1000 },
    ])
    await sql('delete from librarius_uploads where id = $1', [first.id])
    expect(await store.addUpload({ ...picture(MEMBER, 600), maxHeldBytes: 1000 })).toEqual({ id: expect.any(String) })
  })

  it('holds no more than the cap when pictures are sent together', async () => {
    const picture = { authorId: MEMBER, name: 'picture.png', contentType: 'image/png', bytes: new Uint8Array(400).fill(7), maxHeldBytes: 1000 }
    const answers = await Promise.all(Array.from({ length: 6 }, () => store.addUpload(picture)))
    // Whatever the order, never more than two of 400 bytes in 1000, and at least one of them.
    const held = await rows('select count(*)::int as n from librarius_uploads')
    expect(held[0].n).toBeLessThanOrEqual(2)
    expect(held[0].n).toBeGreaterThanOrEqual(1)
    expect(answers.filter((a) => a !== null)).toHaveLength(held[0].n)
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

    it('notices when the server ends the connection that holds the lock: it holds no lock then, the dead connection leaves the pool, and a new take gets the lock', async () => {
      const options = { host: '127.0.0.1', port, user: 'salamanders_app', password, database: 'salamanders_builds', max: 1, connectionTimeoutMillis: 5_000 }
      // A pool of one: a dead connection that was never given back would leave no room for the new take.
      const lonePool = new pg.Pool(options)
      const otherPool = new pg.Pool(options)
      lonePool.on('error', () => {})
      otherPool.on('error', () => {})
      const lone = createLibrariusStore(lonePool)
      const other = createLibrariusStore(otherPool)
      try {
        expect(lone.holdsWorkerLock()).toBe(false)
        expect(await lone.takeWorkerLock()).toBe(true)
        expect(lone.holdsWorkerLock()).toBe(true)
        expect(await other.takeWorkerLock()).toBe(false)
        const held = await rows("select pid from pg_locks where locktype = 'advisory' and classid = 0 and objid = 19000001 and objsubid = 1 and granted")
        expect(held).toHaveLength(1)
        expect((await rows('select pg_terminate_backend($1) as done', [held[0].pid]))[0].done).toBe(true)
        // The connection hears it from the server: a few milliseconds, a few seconds at most.
        for (let tries = 0; lone.holdsWorkerLock() && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 50))
        expect(lone.holdsWorkerLock()).toBe(false)
        expect(lonePool.totalCount).toBe(0)
        // The server let the lock go with the session, and the slot of the pool is free.
        expect(await lone.takeWorkerLock()).toBe(true)
        expect(lone.holdsWorkerLock()).toBe(true)
        expect(await other.takeWorkerLock()).toBe(false)
        await lone.releaseWorkerLock()
        expect(lone.holdsWorkerLock()).toBe(false)
        expect(await other.takeWorkerLock()).toBe(true)
      } finally {
        await lone.releaseWorkerLock().catch(() => {})
        await other.releaseWorkerLock().catch(() => {})
        await lonePool.end()
        await otherPool.end()
      }
    })

    // The worker of librariusOutbox.js on this store, with a fake webhook: the two halves of the lock's contract, held together. The store answers
    // holdsWorkerLock() at once; the worker asks it before every call to Discord, and one whose connection the server ended sends nothing more until
    // it has taken the lock again.
    it('drives the outbox worker: it sends only while it holds the lock, and a lock the server takes away stops the sends until the worker has it again', async () => {
      const options = { host: '127.0.0.1', port, user: 'salamanders_app', password, database: 'salamanders_builds', max: 3, connectionTimeoutMillis: 5_000 }
      const workerPool = new pg.Pool(options)
      const otherPool = new pg.Pool(options)
      workerPool.on('error', () => {})
      otherPool.on('error', () => {})
      const real = createLibrariusStore(workerPool)
      const other = createLibrariusStore(otherPool)
      // Each send makes a message of one part, and notes who held the lock when it was made.
      const sent = []
      const webhook = {
        id: HOOK,
        async send(threadId) {
          const at = Date.now()
          const id = snow(at, sent.length + 1)
          sent.push({ id, threadId, mine: real.holdsWorkerLock(), others: other.holdsWorkerLock() })
          return { id, timestamp: new Date(at).toISOString(), attachments: [] }
        },
        edit: async () => {
          throw new Error('this test makes no edit')
        },
        remove: async () => {
          throw new Error('this test removes nothing')
        },
      }
      const discord = { setArchived: async () => true, deleteMessage: async () => undefined, messagesAfter: async () => [] }
      // Its waits are cut to 50 ms at most: the 1500 ms between two calls is waited for in steps, and a lock another holds is asked for every 50 ms.
      const timers = { setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 50)), clearTimeout: (timer) => clearTimeout(timer) }
      const outbox = createOutbox({ store: real, webhook, discord, guildId: GUILD, timers, log: () => {} })
      const reply = async (source) => {
        const payload = { postId: POST, source, replyTo: null, mentions: [], uploads: [], username: 'Invented Name', avatarUrl: AVATAR, siteUrl: 'https://site.example/post', form: 'v2' }
        return (await real.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload })).id
      }
      const stateOf = async (id) => (await rows('select state from librarius_outbox where id = $1', [id]))[0].state
      const until = async (what, done) => {
        for (let tries = 0; !(await done()); tries++) {
          if (tries > 200) throw new Error(`${what} never came`)
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      try {
        // The store's answer is a boolean, at once: no promise, and no question to the server.
        expect(real.holdsWorkerLock()).toBe(false)
        const first = await reply('The first invented reply.')
        outbox.start()
        await until('the first reply', async () => (await stateOf(first)) === 'sent')
        expect(real.holdsWorkerLock()).toBe(true)
        expect(await other.takeWorkerLock()).toBe(false)
        // The server ends the connection that holds the lock, and another worker takes it.
        const held = await rows("select pid from pg_locks where locktype = 'advisory' and classid = 0 and objid = 19000001 and objsubid = 1 and granted")
        expect(held).toHaveLength(1)
        await sql('select pg_terminate_backend($1)', [held[0].pid])
        await until('the end of the connection', async () => !real.holdsWorkerLock())
        expect(await other.takeWorkerLock()).toBe(true)
        // A reply queued now is not sent: the worker finds it holds no lock, and asks for it again and again.
        const second = await reply('The second invented reply.')
        outbox.kick()
        await new Promise((resolve) => setTimeout(resolve, 2500))
        expect(sent).toHaveLength(1)
        expect(await stateOf(second)).toBe('pending')
        // The other lets it go: this one takes it again, and sends.
        await other.releaseWorkerLock()
        await until('the second reply', async () => (await stateOf(second)) === 'sent')
        expect(real.holdsWorkerLock()).toBe(true)
        expect(sent.map(({ threadId, mine, others }) => ({ threadId, mine, others }))).toEqual([
          { threadId: POST, mine: true, others: false },
          { threadId: POST, mine: true, others: false },
        ])
        // Each is stored as the worker stores a reply: a message of the site, of one part.
        for (const { id } of sent) {
          expect(await message(id)).toMatchObject({ origin: 'site', author_id: MEMBER, webhook_id: HOOK })
          expect(await partsOf(id)).toEqual([[id, 0, HOOK]])
        }
      } finally {
        await outbox.stop()
        await other.releaseWorkerLock().catch(() => {})
        await workerPool.end()
        await otherPool.end()
      }
    }, 60_000)

    it('lets one connection hold the worker lock, and another take it when it is let go', async () => {
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

    it('prunes the entries that are done and old, and nothing else: an event stays, however old', async () => {
      const old = "now() - interval '3 days'"
      const mk = async (state) => {
        const { id } = await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: state } })
        await sql(`update librarius_outbox set state = $2, created_at = ${old} where id = $1`, [id, state])
        return id
      }
      const [sent, failed, blocked, sending, pending] = [await mk('sent'), await mk('failed'), await mk('blocked'), await mk('sending'), await mk('pending')]
      const fresh = await store.enqueueOutbox({ kind: 'send', messageKey: keyOf(), authorId: MEMBER, payload: { postId: POST, source: 'fresh' } })
      await sql("update librarius_outbox set state = 'sent' where id = $1", [fresh.id])
      await sql("insert into librarius_events (actor_id, action, at) values ($1, 'ancient', now() - interval '4000 days'), ($1, 'old', now() - interval '100 days'), ($1, 'new', now() - interval '10 days')", [MEMBER])
      const out = await store.pruneOutbox({ sentBefore: new Date(Date.now() - 86_400_000) })
      expect(out).toEqual({ entries: 1 })
      expect((await rows('select id from librarius_outbox order by id')).map((r) => r.id).sort()).toEqual([failed, blocked, sending, pending, fresh.id].sort())
      expect(sent).toBeDefined()
      expect((await rows('select action from librarius_events order by id')).map((r) => r.action)).toEqual(['ancient', 'old', 'new'])
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
      await oldImageAs(ids[1], { webhook: hook, content: '' })
      if (ids[2] !== undefined) await oldImageAs(ids[2], { webhook: hook, content: 'part three' })
      await oldImageAs(ids[0], { webhook: hook, content: '' })
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

    it('takes the author the layout names, with the entry and the event both gone', async () => {
      await damage()
      await sql('delete from librarius_outbox')
      await sql('delete from librarius_events')
      expect(await store.repairSiteMessages()).toEqual({ removed: 2, restored: 1 })
      expect(await message(A)).toMatchObject({ author_id: MEMBER, content: SOURCE, author_name: 'Invented Name', author_avatar: AVATAR, reply_to: REPLIED })
    })

    it('takes the author the layout names over the entry\'s and the event\'s', async () => {
      await damage()
      await sql('update librarius_outbox set author_id = $1', [OTHER])
      await sql("update librarius_events set actor_id = $1 where action = 'send'", [OTHER])
      await store.repairSiteMessages()
      expect((await message(A)).author_id).toBe(MEMBER)
    })

    /** A reply stored before its layout named its author. */
    const unnamed = () => sql("update librarius_messages set layout = layout - 'authorId' where origin = 'site'")

    it('for a reply whose layout names no author: finds the author in the event when the entry is pruned, and leaves the author alone when both are gone', async () => {
      await damage()
      await unnamed()
      await sql('delete from librarius_outbox')
      expect(await store.repairSiteMessages()).toEqual({ removed: 2, restored: 1 })
      expect((await message(A)).author_id).toBe(MEMBER)
      await oldImageAs(A, { content: '' })
      await sql('delete from librarius_events')
      await store.repairSiteMessages()
      const kept = await message(A)
      expect(kept.author_id).toBe(HOOK)
      expect(kept.content).toBe(SOURCE)
    })

    it('for a reply whose layout names no author: takes the author of the newest entry that sent the message, over an event', async () => {
      await damage()
      await unnamed()
      await sql("insert into librarius_events (actor_id, action, post_id, message_id) values ($1, 'send', $2, $3)", [OTHER, POST, A])
      await store.repairSiteMessages()
      expect((await message(A)).author_id).toBe(MEMBER)
    })

    it('leaves alone an author in the layout that is not an id, and takes the next source', async () => {
      await damage()
      await sql(`update librarius_messages set layout = jsonb_set(layout, '{authorId}', '"not an id"') where id = $1`, [A])
      await sql('update librarius_outbox set author_id = $1', [OTHER])
      expect(await store.repairSiteMessages()).toEqual({ removed: 2, restored: 1 })
      expect((await message(A)).author_id).toBe(OTHER)
    })

    it('cuts the text to 4000 characters as the worker does, by characters and not by bytes', async () => {
      const long = `${'é'.repeat(3999)}😀tail`
      await sentReply([A], { source: long, over: { content: Array.from(long).slice(0, 4000).join('') } })
      await oldImageAs(A, { content: '' })
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
      await oldImageAs(B, { webhook: OLD_HOOK })
      await oldImageAs(A, { webhook: OLD_HOOK })
      await store.repairSiteMessages()
      expect(await message(B)).toBeUndefined()
      expect(await message(A)).toMatchObject({ author_id: MEMBER, reply_to: null, author_avatar: null, author_name: 'Name', webhook_id: OLD_HOOK })
    })
  })

  // ---- a reply of the site against what Discord says of it (rB3 M7, M9)

  describe('a reply of the site and the import', () => {
    const PICTURE = { id: snow(T0 + 1000, 30), position: 0, filename: 'map.png', contentType: 'image/png', size: 2048, width: 640, height: 480, url: 'https://cdn.example/invented/map.png', proxyUrl: null, expiresAt: null }
    const attachmentsOf = async (id) => (await rows('select id, position, filename from librarius_attachments where message_id = $1 order by position', [id])).map((r) => [r.id, r.position, r.filename])

    /** The row the import makes of a message of the webhook with this id, with a picture of its own: what would write over a reply. */
    const webhookRow = (id, over = {}) => ({
      ...parseMessage({
        id,
        channel_id: POST,
        type: 0,
        content: 'what Discord shows',
        edited_timestamp: new Date(T0 + 60_000).toISOString(),
        embeds: [{ type: 'link', url: 'https://site.example/x', title: 'A preview' }],
        webhook_id: HOOK,
        author: { id: HOOK, username: 'The Webhook', avatar: null },
        timestamp: new Date(T0).toISOString(),
        attachments: [{ id: snow(T0 + 1000, 31), filename: 'other.png', size: 10, url: `https://cdn.discordapp.com/attachments/${POST}/${snow(T0 + 1000, 31)}/other.png`, content_type: 'image/png' }],
      }),
      ...over,
    })

    it('never writes over a reply of the site: an upsert of its first part leaves the row and its attachments as they are, with keepReactions or not', async () => {
      await sentReply([A, B], { over: { attachments: [PICTURE] } })
      const before = await message(A)
      expect(await attachmentsOf(A)).toEqual([[PICTURE.id, 0, 'map.png']])
      for (const options of [undefined, { keepReactions: true }]) {
        await store.upsertMessages([webhookRow(A)], options)
        const after = await message(A)
        expect(after).toEqual(before)
        expect(await attachmentsOf(A)).toEqual([[PICTURE.id, 0, 'map.png']])
      }
    })

    it('still writes a message of Discord in the same batch, and inserts a new one', async () => {
      const person = snow(T0 + 500, 9)
      await importAs(person, { webhook: OTHER, content: 'first' })
      await sentReply([A])
      const fresh = snow(T0 + 9000, 9)
      await store.upsertMessages([webhookRow(A), webhookRow(person, { webhookId: OTHER, content: 'second' }), webhookRow(fresh)])
      expect(await message(A)).toMatchObject({ origin: 'site', author_id: MEMBER, content: SOURCE })
      expect(await message(person)).toMatchObject({ origin: 'discord', content: 'second' })
      expect(await attachmentsOf(person)).toEqual([[snow(T0 + 1000, 31), 0, 'other.png']])
      expect(await message(fresh)).toMatchObject({ origin: 'discord', content: 'what Discord shows', author_id: HOOK })
    })

    it('reads the window with the later parts of each reply in order, none of a message of Discord, and none while an edit is at work', async () => {
      const person = snow(T0 + 7000, 9)
      await sentReply([A, B, C])
      await importAs(person, { webhook: OTHER })
      expect(await store.windowIds(POST, 10)).toEqual([
        { id: person, editedAt: null, parts: [] },
        { id: A, editedAt: null, parts: [B, C] },
      ])
      await store.enqueueOutbox({ kind: 'edit', messageKey: A, authorId: MEMBER, payload: { postId: POST, source: 'new', mentions: [] } })
      expect((await store.windowIds(POST, 10))[1]).toEqual({ id: A, editedAt: null, parts: [] })
      // The places of the parts, not their ids, give the order.
      await sql('delete from librarius_parts where message_id = $1 and part_index > 0', [A])
      await sql('insert into librarius_parts (message_id, part_index, discord_id, webhook_id) values ($1, 1, $2, $4), ($1, 2, $3, $4)', [A, C, B, HOOK])
      await sql("update librarius_messages set state = 'blocked' where id = $1", [A])
      expect((await store.windowIds(POST, 10))[1].parts).toEqual([C, B])
    })

    /** Discord as the catch-up reads it: the post, and the messages it holds now, all of them on the page. */
    function discordOf(messages) {
      const raw = (id) => ({ id, channel_id: POST, type: 0, content: '', webhook_id: HOOK, author: { id: HOOK, username: 'The Webhook' }, timestamp: new Date(T0).toISOString(), attachments: [] })
      const post = { id: POST, parent_id: FORUM, owner_id: MEMBER, name: 'An invented post', applied_tags: [], thread_metadata: { archived: false, locked: false, create_timestamp: new Date(T0).toISOString() } }
      const held = messages.map(raw)
      return {
        asked: [],
        activeThreads: async () => [post],
        archivedThreads: async () => ({ threads: [], hasMore: false }),
        messagesAfter: async (ch, after) => held.filter((m) => BigInt(m.id) > BigInt(after)),
        newest: async (ch, limit) => [...held].reverse().slice(0, limit),
        async message(ch, id) {
          this.asked.push(id)
          return held.find((m) => m.id === id) ?? null
        },
        thread: async () => null,
      }
    }

    it('takes a reply whose part 3 is gone from Discord in a catch-up, and queues the deletion of the parts that are left', async () => {
      await sentReply([A, B, C])
      const discord = discordOf([A, B])
      const imp = createImport({ discord, store, forumId: FORUM, webhookId: HOOK, log: () => {} })
      await imp.run()
      expect(await imp.status()).toMatchObject({ importDone: true, lastError: null })
      // Part 3 was the newest message of the post, so the page could not show what became of it: Discord was asked.
      expect(discord.asked).toEqual([C])
      expect(await message(A)).toBeUndefined()
      expect(await partsOf(A)).toEqual([])
      expect((await rows('select message_id from librarius_tombstones')).map((r) => r.message_id)).toEqual([A])
      const queued = await rows("select message_key, author_id, payload from librarius_outbox where kind = 'delete'")
      expect(queued).toEqual([{ message_key: A, author_id: MEMBER, payload: { postId: POST, partIds: [A, B], webhookId: HOOK } }])
      expect((await rows("select actor_id from librarius_events where action = 'deleted-in-discord'")).map((r) => r.actor_id)).toEqual([MEMBER])
    })

    it('keeps a reply that Discord holds whole, and stores none of its parts as messages of their own', async () => {
      await sentReply([A, B, C])
      const discord = discordOf([A, B, C])
      const imp = createImport({ discord, store, forumId: FORUM, webhookId: null, log: () => {} })
      await imp.run()
      expect(await imp.status()).toMatchObject({ importDone: true, lastError: null })
      expect(await message(A)).toMatchObject({ origin: 'site', author_id: MEMBER, content: SOURCE })
      expect(await message(B)).toBeUndefined()
      expect(await partsOf(A)).toHaveLength(3)
      expect(await rows("select 1 from librarius_outbox where kind = 'delete'")).toEqual([])
    })
  })

  // ---- what the post page is given of a reply of the site (P1: the store reads origin and source, the handler passes them on)

  describe('a reply of the site on the post page', () => {
    it("reads back as one message with its whole source, its pictures and its mentions, and a message of Discord as Discord's", async () => {
      const MENTIONED = '200000000000000423'
      const D = snow(T0 + 7000, 1)
      const PICTURE = snow(T0 + 1000, 40)
      // Three parts' worth: the content is cut to what one Discord message holds, and the mention is past the cut.
      const long = `![a map](upload:1)\n\n${'word '.repeat(1500)}<@${MENTIONED}>`
      const picture = { id: PICTURE, position: 0, filename: 'picture-1.png', contentType: 'image/png', size: 2048, width: 640, height: 480, url: `https://cdn.discordapp.com/attachments/${POST}/${PICTURE}/picture-1.png`, proxyUrl: null, expiresAt: null }
      await sentReply([A, B, C], { source: long, over: { content: long.slice(0, 4000), attachments: [picture] } })
      const discordRow = parseMessage({ id: D, channel_id: POST, type: 0, content: 'Written in Discord.', author: { id: OTHER, username: 'Invented Other', avatar: null }, timestamp: new Date(T0 + 7000).toISOString(), attachments: [] })
      await store.upsertMessages([{ ...discordRow, postId: POST }])
      // The source column of a message of Discord is null; one that held text anyway is never sent (the handler's rule).
      await sql('update librarius_messages set source = $2 where id = $1', [D, 'stray'])

      const pairs = (list) => list.map((m) => [m.id, m.origin, m.source])
      expect(pairs((await store.listMessages(POST)).rows)).toEqual([
        [A, 'site', long],
        [D, 'discord', 'stray'],
      ])
      expect(pairs((await store.changes(POST, '0', { limit: 10, slack: 10 })).rows)).toEqual([
        [A, 'site', long],
        [D, 'discord', 'stray'],
      ])

      const verdict = { user: { id: MEMBER }, read: true, reply: true, attach: true, manageMessages: false, manageThreads: false }
      const handle = createLibrariusHandler({
        access: { resolve: async () => verdict },
        store,
        guild: { facts: async () => ({ tags: [], roles: [] }), emoji: async () => [], automodRules: async () => [] },
        links: { refresh: async () => new Map() },
        importer: { status: async () => ({ importDone: true }) },
        roster: { members: async () => [{ id: MENTIONED, name: 'Invented Mentioned', avatar: null }] },
        guildId: GUILD,
        forumId: FORUM,
        configured: true,
      })
      for (const path of [`/librarius/posts/${POST}/messages`, `/librarius/posts/${POST}/changes?since=0`]) {
        const res = await handle(new Request(`http://api.test${path}`), new URL(`http://api.test${path}`))
        expect(res.status).toBe(200)
        const { messages, people } = await res.json()
        expect(messages.map((m) => m.id)).toEqual([A, D])
        const [site, discord] = messages
        expect(site).toMatchObject({ origin: 'site', source: long, content: long.slice(0, 4000), authorId: MEMBER })
        // The page draws upload:1 from the attachment named picture-1.<type> (LibMessage.vue).
        expect(site.attachments.map((a) => a.filename)).toEqual(['picture-1.png'])
        expect(discord.origin).toBe('discord')
        expect(Object.hasOwn(discord, 'source')).toBe(false)
        expect(people[MENTIONED]).toEqual({ name: 'Invented Mentioned', avatar: null })
      }
    })
  })
})
