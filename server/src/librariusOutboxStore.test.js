import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import { createLibrariusStore } from './librariusStore.js'
import { createOutboxStore } from './librariusOutboxStore.js'

// The SQL itself is proven against a real Postgres (a throwaway container, see the task report). Here a recording pool pins
// what the store asks for, in what order, with which parameters, and what it does on failure, as librariusStore.test.js does.
// `script` maps a lowercase SQL fragment to the rows that statement answers with: an Error is thrown, and a function is
// called with the statement's parameters. The first fragment found in a statement wins.
function fakePool(script = []) {
  const log = []
  const release = vi.fn()
  const query = async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    log.push({ sql: s, params })
    const hit = script.find(([fragment]) => s.includes(fragment))
    let out = hit ? hit[1] : []
    if (typeof out === 'function') out = out(params)
    if (out instanceof Error) throw out
    return { rows: out }
  }
  return { pool: { query, connect: async () => ({ query, release }) }, log, release, sqls: () => log.map((l) => l.sql) }
}

// A pool that hands the numbers of the sequence out from 900, one per ask, after whatever `script` answers first.
function revPool(script = []) {
  let next = 900
  return fakePool([...script, ['select nextval', () => [{ rev: String(next++) }]]])
}

// Invented ids, all in the 400-499 range. None of them is a real post, member or message.
const POST = '200000000000000410'
const AUTHOR = '200000000000000414'
const HOOK = '200000000000000415'
const MSG = '200000000000000430'
const MSG_2 = '200000000000000431'
const MSG_3 = '200000000000000432'
const MSG_4 = '200000000000000433'
const ATT = '200000000000000440'
const OUT_OF_RANGE = '99999999999999999999'

const has = (fragment) => expect.stringContaining(fragment)
// What a refusal says, word for word, by the name it was given.
const ID_MSG = (what) => `${what} must be a snowflake: 17 to 20 digits that fit a bigint`
const SERIAL_MSG = (what) => `${what} must be 1 to 19 digits that fit a bigint`
const LIST_MSG = (what) => `${what} must be a list`
const OBJECT_MSG = (what) => `${what} must be an object`
const TIME_MSG = (what) => `${what} must be a Date, an ISO time or epoch milliseconds`
const PARTS_MSG = 'partIds must hold 1 to 3 ids'
const FIRST_MSG = 'the first part is the message'
// Calls `run` and checks it is refused with a TypeError of exactly this message, before any query reached the pool.
async function refused(rig, run, message) {
  const err = await run().then(
    () => null,
    (e) => e,
  )
  expect(err).toBeInstanceOf(TypeError)
  expect(err.message).toBe(message)
  expect(rig.log).toEqual([])
}
const store = (pool) => createOutboxStore(pool)
const boom = () => new Error('connection lost')
const show = (v) => (typeof v === 'bigint' ? `${v}n` : (JSON.stringify(v) ?? String(v)))
const labelled = (list) => list.map((v) => [show(v), v])
// The ids a snowflake check refuses: a number, text of the wrong length or with other characters, a bigint's overflow.
const BAD_IDS = [undefined, null, 7, 200000000000000430, 12345678901234567n, '', '1234567890123456', '123456789012345678901', '20000000000000043x', ' 200000000000000430', '-200000000000000430', OUT_OF_RANGE, {}, [MSG]]
const BAD_SERIALS = [undefined, null, 7, '', '-1', '1.5', '1e3', ' 1', '12345678901234567890', '9223372036854775808', {}, ['1']]

const SEND_PAYLOAD = { postId: POST, source: 'hello', mentions: [] }
const EVENT = { action: 'send', postId: POST, messageId: MSG, note: '1 part' }

describe('createLibrariusStore hands the outbox methods out with the rest', () => {
  it('has every one, bound to the same pool', async () => {
    const { pool, sqls } = fakePool()
    const s = createLibrariusStore(pool)
    for (const name of Object.keys(createOutboxStore(pool))) expect(typeof s[name]).toBe('function')
    await s.outboxNextAt().catch(() => {})
    expect(sqls()).toEqual([has('librarius_outbox')])
    expect(typeof s.upsertMessages).toBe('function')
  })
})

describe('enqueueOutbox', () => {
  it('stores a reply as pending and answers its id, in one transaction, and touches no message', async () => {
    const { pool, log, release } = fakePool([['insert into librarius_outbox', [{ id: '17' }]]])
    expect(await store(pool).enqueueOutbox({ kind: 'send', messageKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', authorId: AUTHOR, payload: SEND_PAYLOAD })).toEqual({ id: '17' })
    expect(log.map((l) => l.sql)).toEqual(['begin', has('insert into librarius_outbox (kind, message_key, author_id, payload) values ($1, $2, $3, $4::jsonb) returning id'), 'commit'])
    expect(log[1].params).toEqual(['send', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', AUTHOR, JSON.stringify(SEND_PAYLOAD)])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it.each(['edit', 'delete'])('stores an %s, and puts the message it names in the state sending with a new rev', async (kind) => {
    const { pool, log } = fakePool([['insert into librarius_outbox', [{ id: '18' }]]])
    expect(await store(pool).enqueueOutbox({ kind, messageKey: MSG, authorId: AUTHOR, payload: { postId: POST, source: 'x' } })).toEqual({ id: '18' })
    expect(log.map((l) => l.sql)).toEqual([
      'begin',
      has('insert into librarius_outbox'),
      "update librarius_messages set state = 'sending', rev = nextval('librarius_rev') where id = $1",
      'commit',
    ])
    expect(log[1].params).toEqual([kind, MSG, AUTHOR, JSON.stringify({ postId: POST, source: 'x' })])
    expect(log[2].params).toEqual([MSG])
  })

  it('rolls back, releases the client and throws the same error when a statement fails', async () => {
    const err = boom()
    const { pool, sqls, release } = fakePool([['insert into librarius_outbox', err]])
    await expect(store(pool).enqueueOutbox({ kind: 'send', messageKey: 'k', authorId: AUTHOR, payload: SEND_PAYLOAD })).rejects.toBe(err)
    expect(sqls()).toEqual(['begin', has('insert into'), 'rollback'])
    expect(release).toHaveBeenCalledTimes(1)
  })

  const good = { kind: 'edit', messageKey: MSG, authorId: AUTHOR, payload: SEND_PAYLOAD }
  const KIND_MSG = 'kind must be one of send, edit, delete'
  const KEY_MSG = 'messageKey must be a text of 1 to 64 characters'
  it.each([
    ...labelled(['reply', 'SEND', '', undefined, null, 7, {}]).map(([name, kind]) => [`kind ${name}`, { ...good, kind }, KIND_MSG]),
    ...labelled([undefined, null, 7, '', 'x'.repeat(65), {}]).map(([name, messageKey]) => [`messageKey ${name}`, { ...good, kind: 'send', messageKey }, KEY_MSG]),
    ...labelled(['not-an-id', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', OUT_OF_RANGE, '1234567890123456']).map(([name, messageKey]) => [`the messageKey ${name} of an edit`, { ...good, messageKey }, ID_MSG('messageKey')]),
    ...labelled(BAD_IDS).map(([name, authorId]) => [`authorId ${name}`, { ...good, authorId }, ID_MSG('authorId')]),
    ...labelled([undefined, null, 'text', 7, []]).map(([name, payload]) => [`payload ${name}`, { ...good, payload }, OBJECT_MSG('payload')]),
    ...labelled([...BAD_IDS, undefined]).map(([name, postId]) => [`payload.postId ${name}`, { ...good, payload: { source: 'x', postId } }, ID_MSG('payload.postId')]),
  ])('refuses %s before any query', async (_, args, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).enqueueOutbox(args), message)
  })

  it('takes a reply with any key of up to 64 characters, since the key of a reply is the route\'s', async () => {
    const { pool } = fakePool([['insert into librarius_outbox', [{ id: '1' }]]])
    await expect(store(pool).enqueueOutbox({ kind: 'send', messageKey: 'k'.repeat(64), authorId: AUTHOR, payload: SEND_PAYLOAD })).resolves.toEqual({ id: '1' })
  })
})

describe('outboxInterrupted', () => {
  it('lists the entries the worker had begun, oldest first, as entries', async () => {
    const row = (id, kind) => ({ id, kind, message_key: MSG, author_id: AUTHOR, payload: { postId: POST, progress: { parts: [] } }, attempts: 2, last_error: 'x' })
    const { pool, log } = fakePool([['from librarius_outbox', [row('3', 'send'), row('5', 'edit')]]])
    expect(await store(pool).outboxInterrupted()).toEqual([
      { id: '3', kind: 'send', messageKey: MSG, authorId: AUTHOR, payload: { postId: POST, progress: { parts: [] } }, attempts: 2 },
      { id: '5', kind: 'edit', messageKey: MSG, authorId: AUTHOR, payload: { postId: POST, progress: { parts: [] } }, attempts: 2 },
    ])
    expect(log).toHaveLength(1)
    expect(log[0].sql).toBe("select id, kind, message_key, author_id, payload, attempts from librarius_outbox where state = 'sending' order by id")
    expect(log[0].params).toBeUndefined()
  })

  it('is an empty list when none is', async () => {
    expect(await store(fakePool().pool).outboxInterrupted()).toEqual([])
  })
})

describe('claimOutbox', () => {
  const row = { id: '9', kind: 'send', message_key: 'k', author_id: AUTHOR, payload: SEND_PAYLOAD, attempts: 0 }

  it('takes the oldest entry that is due, in one statement, and answers it as an entry', async () => {
    const { pool, log } = fakePool([['update librarius_outbox', [row]]])
    expect(await store(pool).claimOutbox('2026-11-18T10:00:00.000Z')).toEqual({ id: '9', kind: 'send', messageKey: 'k', authorId: AUTHOR, payload: SEND_PAYLOAD, attempts: 0 })
    expect(log).toHaveLength(1)
    expect(log[0].params).toEqual(['2026-11-18T10:00:00.000Z'])
    expect(log[0].sql).toBe(
      "update librarius_outbox set state = 'sending' where id = (select id from librarius_outbox where state = 'pending' and next_at <= $1::timestamptz order by next_at, id limit 1 for update skip locked) returning id, kind, message_key, author_id, payload, attempts",
    )
  })

  it('answers null when nothing is due', async () => {
    expect(await store(fakePool().pool).claimOutbox(0)).toBeNull()
  })

  it('takes the time as a Date, ISO text or epoch milliseconds, and asks with the instant as ISO text', async () => {
    const at = '2026-11-18T10:00:00.000Z'
    for (const now of [new Date(at), at, Date.parse(at)]) {
      const { pool, log } = fakePool()
      await store(pool).claimOutbox(now)
      expect(log[0].params).toEqual([at])
    }
  })

  it.each(labelled([undefined, null, {}, 'yesterday', Number.NaN, new Date('x'), true]))('refuses the time %s before any query', async (_, now) => {
    const { pool, log } = fakePool()
    await expect(store(pool).claimOutbox(now)).rejects.toThrow(new TypeError('now must be a Date, an ISO time or epoch milliseconds'))
    expect(log).toEqual([])
  })
})

describe('outboxNextAt', () => {
  it('asks for the earliest due time of the pending entries, as ISO text', async () => {
    const { pool, log } = fakePool([['min(next_at)', [{ at: new Date('2026-11-18T10:00:05.250Z') }]]])
    expect(await store(pool).outboxNextAt()).toBe('2026-11-18T10:00:05.250Z')
    expect(log[0].sql).toBe("select min(next_at) as at from librarius_outbox where state = 'pending'")
  })

  it('answers null when none is pending', async () => {
    expect(await store(fakePool([['min(next_at)', [{ at: null }]]]).pool).outboxNextAt()).toBeNull()
  })
})

describe('outboxProgress', () => {
  it('writes the progress into the payload of an entry that is sending, and only then', async () => {
    const { pool, log } = fakePool()
    await store(pool).outboxProgress('12', { parts: [{ id: MSG }], inflight: null })
    expect(log).toHaveLength(1)
    expect(log[0].sql).toBe("update librarius_outbox set payload = jsonb_set(payload, '{progress}', $2::jsonb, true) where id = $1 and state = 'sending'")
    expect(log[0].params).toEqual(['12', JSON.stringify({ parts: [{ id: MSG }], inflight: null })])
  })

  it.each([
    ...labelled(BAD_SERIALS).map(([name, id]) => [`id ${name}`, id, {}, SERIAL_MSG('id')]),
    ...labelled([undefined, null, 'x', 7, []]).map(([name, progress]) => [`progress ${name}`, '1', progress, OBJECT_MSG('progress')]),
  ])('refuses %s before any query', async (_, id, progress, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).outboxProgress(id, progress), message)
  })

  it('takes the highest id a bigint holds, and refuses the next', async () => {
    const { pool, log } = fakePool()
    await store(pool).outboxProgress('9223372036854775807', {})
    expect(log).toHaveLength(1)
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).outboxProgress('9223372036854775808', {}), SERIAL_MSG('id'))
  })
})

describe('outboxSet', () => {
  const entry = (kind) => [['update librarius_outbox', [{ kind, message_key: MSG, author_id: AUTHOR }]]]

  it('moves an entry to a state, setting what it is given and leaving the rest, in one transaction', async () => {
    const { pool, log } = fakePool(entry('send'))
    await store(pool).outboxSet('12', { state: 'pending', attempts: 2, nextAt: '2026-11-18T10:00:30.000Z', error: 'Discord answered 502 to the webhook send.' })
    expect(log.map((l) => l.sql)).toEqual([
      'begin',
      'update librarius_outbox set state = $2, attempts = coalesce($3::int, attempts), next_at = coalesce($4::timestamptz, next_at), last_error = $5 where id = $1 returning kind, message_key, author_id',
      'commit',
    ])
    expect(log[1].params).toEqual(['12', 'pending', 2, '2026-11-18T10:00:30.000Z', 'Discord answered 502 to the webhook send.'])
  })

  it('leaves attempts and the due time to the row when it is not given them, and clears the error', async () => {
    const { pool, log } = fakePool(entry('send'))
    await store(pool).outboxSet('12', { state: 'sent' })
    expect(log[1].params).toEqual(['12', 'sent', null, null, null])
  })

  it('takes attempts of 0 as 0, and the due time as a Date or milliseconds as ISO text', async () => {
    const at = '2026-11-18T10:00:30.000Z'
    for (const nextAt of [new Date(at), Date.parse(at)]) {
      const { pool, log } = fakePool(entry('send'))
      await store(pool).outboxSet('12', { state: 'pending', attempts: 0, nextAt })
      expect(log[1].params).toEqual(['12', 'pending', 0, at, null])
    }
  })

  it('cuts an error to 500 characters', async () => {
    const { pool, log } = fakePool(entry('send'))
    await store(pool).outboxSet('12', { state: 'failed', error: 'e'.repeat(700) })
    expect(log[1].params[4]).toBe('e'.repeat(500))
  })

  it.each(['edit', 'delete'])('sets the state of the message an %s names when it is given one, with a new rev', async (kind) => {
    const { pool, log } = fakePool(entry(kind))
    await store(pool).outboxSet('12', { state: 'blocked', messageState: 'blocked' })
    expect(log.map((l) => l.sql)).toEqual(['begin', has('update librarius_outbox'), "update librarius_messages set state = $2, rev = nextval('librarius_rev') where id = $1", 'commit'])
    expect(log[2].params).toEqual([MSG, 'blocked'])
  })

  it('clears the state of the message with null, and leaves it alone when no state is given', async () => {
    const cleared = fakePool(entry('edit'))
    await store(cleared.pool).outboxSet('12', { state: 'sent', messageState: null })
    expect(cleared.log[2].params).toEqual([MSG, null])
    const left = fakePool(entry('edit'))
    await store(left.pool).outboxSet('12', { state: 'sent' })
    expect(left.sqls()).toEqual(['begin', has('update librarius_outbox'), 'commit'])
  })

  it('does not touch a message for a reply, which has none yet', async () => {
    const { pool, sqls } = fakePool(entry('send'))
    await store(pool).outboxSet('12', { state: 'failed', messageState: 'blocked' })
    expect(sqls()).toEqual(['begin', has('update librarius_outbox'), 'commit'])
  })

  it('notes an event by the author of the entry', async () => {
    const { pool, log } = fakePool(entry('send'))
    await store(pool).outboxSet('12', { state: 'blocked', event: { action: 'blocked', postId: POST, note: 'AutoMod' } })
    expect(log.map((l) => l.sql)).toEqual(['begin', has('update librarius_outbox'), 'insert into librarius_events (actor_id, action, post_id, message_id, note) values ($1, $2, $3, $4, $5)', 'commit'])
    expect(log[2].params).toEqual([AUTHOR, 'blocked', POST, null, 'AutoMod'])
  })

  it('does nothing more for an entry that is not there', async () => {
    const { pool, sqls } = fakePool()
    await store(pool).outboxSet('12', { state: 'blocked', messageState: 'blocked', event: { action: 'blocked' } })
    expect(sqls()).toEqual(['begin', has('update librarius_outbox'), 'commit'])
  })

  it('rolls back and throws what failed', async () => {
    const err = boom()
    const { pool, sqls } = fakePool([['update librarius_outbox', err]])
    await expect(store(pool).outboxSet('12', { state: 'sent' })).rejects.toBe(err)
    expect(sqls()).toEqual(['begin', has('update'), 'rollback'])
  })

  const EVENT_MSG = 'event must be an object'
  const ACTION_MSG = 'action must be a text of 1 to 40 characters'
  it.each([
    ...labelled(BAD_SERIALS).map(([name, id]) => [`id ${name}`, id, { state: 'sent' }, SERIAL_MSG('id')]),
    ...labelled(['sending', 'done', '', undefined, null, 7, 'SENT']).map(([name, state]) => [`state ${name}`, '1', { state }, 'state must be one of pending, sent, blocked, failed']),
    ...labelled([-1, 1.5, Number.NaN, '1', null, Infinity, 2 ** 53]).map(([name, attempts]) => [`attempts ${name}`, '1', { state: 'pending', attempts }, 'attempts must be a whole number of at least 0']),
    ...labelled(['soon', {}, null, Number.NaN, new Date('x'), true]).map(([name, nextAt]) => [`nextAt ${name}`, '1', { state: 'pending', nextAt }, TIME_MSG('nextAt')]),
    ...labelled([7, {}, [], true]).map(([name, error]) => [`error ${name}`, '1', { state: 'failed', error }, 'error must be text or null']),
    ...labelled(['sent', 'pending', 7, {}, '']).map(([name, messageState]) => [`messageState ${name}`, '1', { state: 'sent', messageState }, "messageState must be null, 'sending' or 'blocked'"]),
    ['an event that is no object', '1', { state: 'sent', event: 'send' }, EVENT_MSG],
    ['an event with no action', '1', { state: 'sent', event: {} }, ACTION_MSG],
    ['an event with an empty action', '1', { state: 'sent', event: { action: '' } }, ACTION_MSG],
    ['an event with a long action', '1', { state: 'sent', event: { action: 'a'.repeat(41) } }, ACTION_MSG],
    ['an event with a post that is no id', '1', { state: 'sent', event: { action: 'send', postId: '1' } }, ID_MSG('event postId')],
    ['an event with a message that is no id', '1', { state: 'sent', event: { action: 'send', messageId: 7 } }, ID_MSG('event messageId')],
    ['an event with a long note', '1', { state: 'sent', event: { action: 'send', note: 'n'.repeat(201) } }, 'note must be text of at most 200 characters, or null'],
    ['an event with a note that is no text', '1', { state: 'sent', event: { action: 'send', note: 7 } }, 'note must be text of at most 200 characters, or null'],
  ])('refuses %s before any query', async (_, id, patch, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).outboxSet(id, patch), message)
  })

  it('refuses no patch at all, which has no state', async () => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).outboxSet('1'), 'state must be one of pending, sent, blocked, failed')
  })

  it('takes an action of 40 characters and a note of 200', async () => {
    const { pool } = fakePool(entry('send'))
    await expect(store(pool).outboxSet('1', { state: 'sent', event: { action: 'a'.repeat(40), note: 'n'.repeat(200) } })).resolves.toBeUndefined()
  })
})

describe('finishSend', () => {
  const attachment = (over = {}) => ({
    id: ATT,
    position: 0,
    filename: 'picture-1.png',
    contentType: 'image/png',
    size: 2048,
    width: 64,
    height: 32,
    url: `https://cdn.discordapp.com/attachments/${POST}/${ATT}/picture-1.png?ex=6540a0b3`,
    proxyUrl: null,
    expiresAt: '2026-11-19T10:00:00.000Z',
    ...over,
  })
  const message = (over = {}) => ({
    id: MSG,
    postId: POST,
    authorId: AUTHOR,
    authorName: 'Invented Name',
    authorAvatar: null,
    webhookId: HOOK,
    content: 'hello',
    replyTo: null,
    createdAt: '2026-11-18T10:00:00.000Z',
    source: 'hello',
    layout: { form: 'v2' },
    attachments: [],
    ...over,
  })
  const run = (script, over = {}, args = {}) => {
    const rig = revPool([...script, ['insert into librarius_messages', [{ id: MSG }]]])
    const done = store(rig.pool).finishSend('12', { message: message(over), partIds: [MSG], uploadIds: [], event: EVENT, ...args })
    return { ...rig, done }
  }

  it('stores a one-part reply, its parts, the event and the state of the entry, in one transaction, in order', async () => {
    const r = run([])
    await r.done
    expect(r.sqls()).toEqual([
      'begin',
      "select nextval('librarius_rev') as rev",
      has('insert into librarius_messages'),
      'delete from librarius_attachments where message_id = $1',
      'delete from librarius_parts where message_id = $1',
      'insert into librarius_parts (message_id, part_index, discord_id) select $1::bigint, (t.n - 1)::smallint, t.id from unnest($2::bigint[]) with ordinality as t (id, n)',
      'insert into librarius_events (actor_id, action, post_id, message_id, note) values ($1, $2, $3, $4, $5)',
      "update librarius_outbox set state = 'sent', last_error = null where id = $1",
      'commit',
    ])
    expect(r.log[2].params).toEqual([MSG, POST, AUTHOR, 'Invented Name', null, HOOK, 'hello', null, '2026-11-18T10:00:00.000Z', '900', 'hello', JSON.stringify({ form: 'v2' })])
    expect(r.log[3].params).toEqual([MSG])
    expect(r.log[4].params).toEqual([MSG])
    expect(r.log[5].params).toEqual([MSG, [MSG]])
    expect(r.log[6].params).toEqual([AUTHOR, 'send', POST, MSG, '1 part'])
    expect(r.log[7].params).toEqual(['12'])
  })

  it('writes the message as a message of the site, with no embeds, stickers or reactions, kind 0 and no state, and keeps the reactions a conflict finds', async () => {
    const r = run([])
    await r.done
    const sql = r.log[2].sql
    expect(sql).toContain("0, $7::text, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $8::bigint, $9::timestamptz, null, $10::bigint, 'site', $11::text, null, $12::jsonb")
    expect(sql).toContain('where exists (select 1 from librarius_posts where id = $2)')
    expect(sql).toContain('on conflict (id) do update set')
    expect(sql).not.toContain('reactions = excluded')
    for (const column of ['post_id', 'author_id', 'author_name', 'author_avatar', 'webhook_id', 'kind', 'content', 'reply_to', 'created_at', 'edited_at', 'rev', 'origin', 'source', 'state', 'layout']) {
      expect(sql).toContain(`${column} = excluded.${column}`)
    }
    expect(sql).toContain('returning id')
  })

  it('stores the attachments of the message, in order, once the message is written', async () => {
    const r = run([], { attachments: [attachment(), attachment({ id: MSG_4, position: 1, filename: 'picture-2.png', width: null, height: null, proxyUrl: 'https://media.discordapp.net/x', contentType: null })] })
    await r.done
    const inserts = r.log.filter((l) => l.sql.startsWith('insert into librarius_attachments'))
    expect(inserts).toHaveLength(2)
    expect(inserts[0].sql).toContain('on conflict (id) do nothing')
    expect(inserts[0].params).toEqual([ATT, MSG, 0, 'picture-1.png', 'image/png', 2048, 64, 32, attachment().url, null, '2026-11-19T10:00:00.000Z'])
    expect(inserts[1].params).toEqual([MSG_4, MSG, 1, 'picture-2.png', null, 2048, null, null, attachment().url, 'https://media.discordapp.net/x', '2026-11-19T10:00:00.000Z'])
    const order = r.sqls()
    expect(order.indexOf('delete from librarius_attachments where message_id = $1')).toBeLessThan(order.indexOf(inserts[0].sql))
  })

  it('first deletes what an import stored as messages of the later parts, noting them for the readers, with the rev of the write', async () => {
    const r = run([], {}, { partIds: [MSG, MSG_2, MSG_3] })
    await r.done
    expect(r.sqls().slice(0, 5)).toEqual([
      'begin',
      "select nextval('librarius_rev') as rev",
      'insert into librarius_tombstones (message_id, post_id, rev) select id, post_id, $2::bigint from librarius_messages where id = any($1::bigint[])',
      'delete from librarius_messages where id = any($1::bigint[])',
      has('insert into librarius_messages'),
    ])
    expect(r.log[2].params).toEqual([[MSG_2, MSG_3], '900'])
    expect(r.log[3].params).toEqual([[MSG_2, MSG_3]])
    expect(r.log.find((l) => l.sql.startsWith('insert into librarius_parts')).params).toEqual([MSG, [MSG, MSG_2, MSG_3]])
  })

  it('deletes the uploads of the author that it was sent with, and only when there are some', async () => {
    const r = run([], {}, { uploadIds: ['3', '4'] })
    await r.done
    const gone = r.log.find((l) => l.sql.startsWith('delete from librarius_uploads'))
    expect(gone.sql).toBe('delete from librarius_uploads where id = any($1::bigint[]) and author_id = $2')
    expect(gone.params).toEqual([['3', '4'], AUTHOR])
    const none = run([])
    await none.done
    expect(none.sqls().some((s) => s.includes('librarius_uploads'))).toBe(false)
  })

  it('stores no attachments or parts for a reply whose post is not stored, but still ends the entry and notes the event', async () => {
    const r = run([['insert into librarius_messages', []]], {}, { uploadIds: ['3'] })
    await r.done
    expect(r.sqls()).toEqual([
      'begin',
      "select nextval('librarius_rev') as rev",
      has('insert into librarius_messages'),
      has('delete from librarius_uploads'),
      has('insert into librarius_events'),
      has("update librarius_outbox set state = 'sent'"),
      'commit',
    ])
  })

  it('rolls back, with no state of the entry written, when any statement fails, and throws that error', async () => {
    const err = boom()
    const r = run([['insert into librarius_parts', err]])
    await expect(r.done).rejects.toBe(err)
    expect(r.sqls().at(-1)).toBe('rollback')
    expect(r.sqls().some((s) => s.includes("set state = 'sent'"))).toBe(false)
    expect(r.release).toHaveBeenCalledTimes(1)
  })

  it('takes the creation time as a Date or milliseconds, written as ISO text', async () => {
    const at = '2026-11-18T10:00:00.000Z'
    for (const createdAt of [new Date(at), Date.parse(at)]) {
      const r = run([], { createdAt })
      await r.done
      expect(r.log[2].params[8]).toBe(at)
    }
  })

  const good = () => ({ message: message(), partIds: [MSG], uploadIds: [], event: EVENT })
  const TEXT_MSG = (field) => `${field} must be text`
  it.each([
    ...labelled(BAD_SERIALS).map(([name, id]) => [`id ${name}`, id, good(), SERIAL_MSG('id')]),
    ...labelled([undefined, null, 'x', []]).map(([name, m]) => [`message ${name}`, '1', { ...good(), message: m }, OBJECT_MSG('message')]),
    ...['id', 'postId', 'authorId', 'webhookId'].flatMap((field) => labelled([undefined, null, '1', 7, OUT_OF_RANGE]).map(([name, v]) => [`message.${field} ${name}`, '1', { ...good(), message: message({ [field]: v }) }, ID_MSG(field)])),
    ...labelled(['1', 7, undefined, OUT_OF_RANGE]).map(([name, v]) => [`message.replyTo ${name}`, '1', { ...good(), message: message({ replyTo: v }) }, ID_MSG('replyTo')]),
    ...['authorName', 'content', 'source'].flatMap((field) => labelled([undefined, null, 7, {}]).map(([name, v]) => [`message.${field} ${name}`, '1', { ...good(), message: message({ [field]: v }) }, TEXT_MSG(field)])),
    ...labelled([undefined, 7, {}]).map(([name, v]) => [`message.authorAvatar ${name}`, '1', { ...good(), message: message({ authorAvatar: v }) }, 'authorAvatar must be text or null']),
    ...labelled(['soon', undefined, null, {}]).map(([name, v]) => [`message.createdAt ${name}`, '1', { ...good(), message: message({ createdAt: v }) }, TIME_MSG('createdAt')]),
    ...labelled([undefined, null, [], 'x']).map(([name, v]) => [`message.layout ${name}`, '1', { ...good(), message: message({ layout: v }) }, OBJECT_MSG('layout')]),
    ...labelled([undefined, null, {}, 'x']).map(([name, v]) => [`message.attachments ${name}`, '1', { ...good(), message: message({ attachments: v }) }, LIST_MSG('attachments')]),
    ['an attachment with a bad id', '1', { ...good(), message: message({ attachments: [attachment({ id: '1' })] }) }, ID_MSG('attachment id')],
    ...labelled([undefined, null, {}, 'x']).map(([name, v]) => [`partIds ${name}`, '1', { ...good(), partIds: v }, LIST_MSG('partIds')]),
    ...labelled([[], [MSG, MSG_2, MSG_3, MSG_4]]).map(([name, v]) => [`partIds ${name}`, '1', { ...good(), partIds: v }, PARTS_MSG]),
    ['a part that is no id', '1', { ...good(), partIds: [MSG, '1'] }, ID_MSG('a part id')],
    ['parts that repeat', '1', { ...good(), partIds: [MSG, MSG] }, 'partIds must be different ids'],
    ['a first part that is not the message', '1', { ...good(), partIds: [MSG_2] }, FIRST_MSG],
    ...labelled([undefined, null, {}, 'x']).map(([name, v]) => [`uploadIds ${name}`, '1', { ...good(), uploadIds: v }, LIST_MSG('uploadIds')]),
    ['eleven uploads', '1', { ...good(), uploadIds: Array.from({ length: 11 }, (_, i) => String(i + 1)) }, 'at most 10 uploads'],
    ...labelled(BAD_SERIALS).map(([name, v]) => [`an upload id ${name}`, '1', { ...good(), uploadIds: ['1', v] }, SERIAL_MSG('an upload id')]),
    ['no event', '1', { ...good(), event: undefined }, OBJECT_MSG('event')],
    ['a bad event', '1', { ...good(), event: { action: '' } }, 'action must be a text of 1 to 40 characters'],
  ])('refuses %s before any query', async (_, id, args, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).finishSend(id, args), message)
  })

  it('takes a message with an avatar', async () => {
    const r = run([], { authorAvatar: 'https://cdn.discordapp.com/avatars/1/2.png' })
    await r.done
    expect(r.log[2].params[4]).toBe('https://cdn.discordapp.com/avatars/1/2.png')
  })

  it('takes a reply to a message', async () => {
    const r = run([], { replyTo: MSG_4 })
    await r.done
    expect(r.log[2].params[7]).toBe(MSG_4)
  })

  it('takes ten uploads', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => String(i + 1))
    const r = run([], {}, { uploadIds: ids })
    await expect(r.done).resolves.toBeUndefined()
  })
})

describe('finishEdit', () => {
  const run = (script, args = {}) => {
    const rig = fakePool([...script, ['update librarius_messages', [{ author_id: AUTHOR }]], ['update librarius_outbox', [{ author_id: AUTHOR }]]])
    const done = store(rig.pool).finishEdit('12', { messageId: MSG, source: 'new source', content: 'new content', partIds: [MSG, MSG_2], event: { action: 'edit', postId: POST, messageId: MSG }, ...args })
    return { ...rig, done }
  }

  it('gives the message its new text, edit time and no state, replaces its parts, ends the entry and notes the event, in one transaction', async () => {
    const r = run([])
    await r.done
    expect(r.sqls()).toEqual([
      'begin',
      "update librarius_messages set source = $2, content = $3, edited_at = now(), state = null, rev = nextval('librarius_rev') where id = $1 and origin = 'site' returning author_id",
      'delete from librarius_parts where message_id = $1',
      has('insert into librarius_parts'),
      "update librarius_outbox set state = 'sent', last_error = null where id = $1 returning author_id",
      has('insert into librarius_events'),
      'commit',
    ])
    expect(r.log[1].params).toEqual([MSG, 'new source', 'new content'])
    expect(r.log[2].params).toEqual([MSG])
    expect(r.log[3].params).toEqual([MSG, [MSG, MSG_2]])
    expect(r.log[4].params).toEqual(['12'])
    expect(r.log[5].params).toEqual([AUTHOR, 'edit', POST, MSG, null])
  })

  it('does not bring back a message that is gone, nor give it parts, but ends the entry', async () => {
    const r = run([['update librarius_messages', []]])
    await r.done
    expect(r.sqls()).toEqual(['begin', has('update librarius_messages'), has("update librarius_outbox set state = 'sent'"), has('insert into librarius_events'), 'commit'])
  })

  it('notes no event for an entry that is not there', async () => {
    const r = run([['update librarius_outbox', []]])
    await r.done
    expect(r.sqls().some((s) => s.includes('librarius_events'))).toBe(false)
  })

  it('rolls back and throws what failed', async () => {
    const err = boom()
    const r = run([['insert into librarius_parts', err]])
    await expect(r.done).rejects.toBe(err)
    expect(r.sqls().at(-1)).toBe('rollback')
  })

  const good = { messageId: MSG, source: 's', content: 'c', partIds: [MSG], event: { action: 'edit' } }
  it.each([
    ...labelled(BAD_SERIALS).map(([name, id]) => [`id ${name}`, id, good, SERIAL_MSG('id')]),
    ...labelled(BAD_IDS).map(([name, messageId]) => [`messageId ${name}`, '1', { ...good, messageId, partIds: [messageId] }, ID_MSG('messageId')]),
    ...labelled([undefined, null, 7, {}]).map(([name, v]) => [`source ${name}`, '1', { ...good, source: v }, 'source and content must be text']),
    ...labelled([undefined, null, 7, {}]).map(([name, v]) => [`content ${name}`, '1', { ...good, content: v }, 'source and content must be text']),
    ...labelled([undefined, 'x']).map(([name, v]) => [`partIds ${name}`, '1', { ...good, partIds: v }, LIST_MSG('partIds')]),
    ...labelled([[], [MSG, MSG_2, MSG_3, MSG_4]]).map(([name, v]) => [`partIds ${name}`, '1', { ...good, partIds: v }, PARTS_MSG]),
    ['a first part that is not the message', '1', { ...good, partIds: [MSG_2] }, FIRST_MSG],
    ['parts that repeat', '1', { ...good, partIds: [MSG, MSG] }, 'partIds must be different ids'],
    ['no event', '1', { ...good, event: undefined }, OBJECT_MSG('event')],
  ])('refuses %s before any query', async (_, id, args, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).finishEdit(id, args), message)
  })
})

describe('finishDelete', () => {
  const run = (script, args = {}) => {
    const rig = revPool([...script, ['update librarius_outbox', [{ author_id: AUTHOR }]]])
    const done = store(rig.pool).finishDelete('12', { messageId: MSG, partIds: [MSG, MSG_2], event: { action: 'delete', postId: POST, messageId: MSG }, ...args })
    return { ...rig, done }
  }

  it('deletes the message, noting it for the readers, forgets its parts, ends the entry and notes the event, in one transaction', async () => {
    const r = run([])
    await r.done
    expect(r.sqls()).toEqual([
      'begin',
      "select nextval('librarius_rev') as rev",
      'insert into librarius_tombstones (message_id, post_id, rev) select id, post_id, $2::bigint from librarius_messages where id = any($1::bigint[])',
      'delete from librarius_messages where id = any($1::bigint[])',
      'delete from librarius_parts where message_id = $1 or discord_id = any($2::bigint[])',
      "update librarius_outbox set state = 'sent', last_error = null where id = $1 returning author_id",
      has('insert into librarius_events'),
      'commit',
    ])
    expect(r.log[2].params).toEqual([[MSG], '900'])
    expect(r.log[3].params).toEqual([[MSG]])
    expect(r.log[4].params).toEqual([MSG, [MSG, MSG_2]])
    expect(r.log[5].params).toEqual(['12'])
    expect(r.log[6].params).toEqual([AUTHOR, 'delete', POST, MSG, null])
  })

  it('takes an empty list of parts', async () => {
    const r = run([], { partIds: [] })
    await r.done
    expect(r.log[4].params).toEqual([MSG, []])
  })

  it('notes no event for an entry that is not there', async () => {
    const r = run([['update librarius_outbox', []]])
    await r.done
    expect(r.sqls().some((s) => s.includes('librarius_events'))).toBe(false)
  })

  it('rolls back and throws what failed', async () => {
    const err = boom()
    const r = run([['delete from librarius_parts', err]])
    await expect(r.done).rejects.toBe(err)
    expect(r.sqls().at(-1)).toBe('rollback')
  })

  const good = { messageId: MSG, partIds: [MSG], event: { action: 'delete' } }
  it.each([
    ...labelled(BAD_SERIALS).map(([name, id]) => [`id ${name}`, id, good, SERIAL_MSG('id')]),
    ...labelled(BAD_IDS).map(([name, messageId]) => [`messageId ${name}`, '1', { ...good, messageId }, ID_MSG('messageId')]),
    ...labelled([undefined, null, {}, 'x']).map(([name, v]) => [`partIds ${name}`, '1', { ...good, partIds: v }, LIST_MSG('partIds')]),
    ...labelled(['1', 7]).map(([name, v]) => [`a part ${name}`, '1', { ...good, partIds: [v] }, ID_MSG('a part id')]),
    ['no event', '1', { ...good, event: undefined }, OBJECT_MSG('event')],
  ])('refuses %s before any query', async (_, id, args, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).finishDelete(id, args), message)
  })
})

describe('outboxMessage', () => {
  const row = { id: MSG, post_id: POST, author_id: AUTHOR, author_name: 'Invented Name', author_avatar: 'https://cdn.example/a.png', origin: 'site', source: 'hello', layout: { form: 'v2' }, state: 'sending' }

  it('answers the message with its parts, in order, as the worker reads it', async () => {
    const { pool, log } = fakePool([
      ['from librarius_messages', [row]],
      ['from librarius_parts', [{ discord_id: MSG }, { discord_id: MSG_2 }]],
    ])
    expect(await store(pool).outboxMessage(MSG)).toEqual({
      id: MSG,
      postId: POST,
      authorId: AUTHOR,
      authorName: 'Invented Name',
      authorAvatar: 'https://cdn.example/a.png',
      origin: 'site',
      source: 'hello',
      layout: { form: 'v2' },
      state: 'sending',
      parts: [MSG, MSG_2],
    })
    expect(log.map((l) => l.sql)).toEqual([
      'select id, post_id, author_id, author_name, author_avatar, origin, source, layout, state from librarius_messages where id = $1',
      'select discord_id from librarius_parts where message_id = $1 order by part_index',
    ])
    expect(log.map((l) => l.params)).toEqual([[MSG], [MSG]])
  })

  it('answers null for a message that is not stored, without asking for its parts', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).outboxMessage(MSG)).toBeNull()
    expect(log).toHaveLength(1)
  })

  it('answers a message of Discord with no parts, its source and layout null', async () => {
    const { pool } = fakePool([['from librarius_messages', [{ ...row, origin: 'discord', source: null, layout: null, state: null }]]])
    expect(await store(pool).outboxMessage(MSG)).toMatchObject({ origin: 'discord', source: null, layout: null, state: null, parts: [] })
  })

  it.each(labelled(BAD_IDS))('refuses the id %s before any query', async (_, id) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).outboxMessage(id), ID_MSG('messageId'))
  })
  it.each(labelled(BAD_IDS))('refuses the id %s before any query', async (_, id) => {
    const { pool, log } = fakePool()
    await expect(store(pool).outboxMessage(id)).rejects.toThrow(TypeError)
    expect(log).toEqual([])
  })
})

describe('uploadsFor', () => {
  const row = (id, over = {}) => ({ id, name: `n${id}.png`, content_type: 'image/png', bytes: Buffer.from([1, 2, 3]), ...over })

  it('answers the uploads the author holds, in the order asked for, leaving out those that are gone', async () => {
    const { pool, log } = fakePool([['from librarius_uploads', [row('4'), row('3'), row('9')]]])
    const got = await store(pool).uploadsFor(AUTHOR, ['3', '5', '4'])
    expect(got).toEqual([
      { id: '3', name: 'n3.png', contentType: 'image/png', bytes: Buffer.from([1, 2, 3]) },
      { id: '4', name: 'n4.png', contentType: 'image/png', bytes: Buffer.from([1, 2, 3]) },
    ])
    expect(log).toHaveLength(1)
    expect(log[0].sql).toBe('select id, name, content_type, bytes from librarius_uploads where author_id = $1 and id = any($2::bigint[])')
    expect(log[0].params).toEqual([AUTHOR, ['3', '5', '4']])
  })

  it('asks nothing for no uploads', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).uploadsFor(AUTHOR, [])).toEqual([])
    expect(log).toEqual([])
  })

  it.each([
    ...labelled(BAD_IDS).map(([name, v]) => [`authorId ${name}`, v, ['1'], ID_MSG('authorId')]),
    ...labelled([undefined, null, 'x', {}]).map(([name, v]) => [`ids ${name}`, AUTHOR, v, LIST_MSG('ids')]),
    ...labelled(BAD_SERIALS).map(([name, v]) => [`an id ${name}`, AUTHOR, ['1', v], SERIAL_MSG('an upload id')]),
  ])('refuses %s before any query', async (_, authorId, ids, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).uploadsFor(authorId, ids), message)
  })
})

describe('knownPartIds', () => {
  it('answers which of the ids are parts of a stored reply', async () => {
    const { pool, log } = fakePool([['from librarius_parts', [{ discord_id: MSG_2 }]]])
    expect(await store(pool).knownPartIds([MSG, MSG_2])).toEqual(new Set([MSG_2]))
    expect(log[0].sql).toBe('select discord_id from librarius_parts where discord_id = any($1::bigint[])')
    expect(log[0].params).toEqual([[MSG, MSG_2]])
  })

  it('asks nothing for no ids', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).knownPartIds([])).toEqual(new Set())
    expect(log).toEqual([])
  })

  it.each([
    ...labelled([undefined, null, 'x', {}]).map(([n, v]) => [`ids ${n}`, v, LIST_MSG('ids')]),
    ...labelled(BAD_IDS).map(([n, v]) => [`an id ${n}`, [MSG, v], ID_MSG('a part id')]),
  ])('refuses %s before any query', async (_, ids, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).knownPartIds(ids), message)
  })
})

describe('messageOfPart', () => {
  it('answers the reply a part belongs to', async () => {
    const { pool, log } = fakePool([['from librarius_parts', [{ message_id: MSG }]]])
    expect(await store(pool).messageOfPart(MSG_2)).toBe(MSG)
    expect(log[0].sql).toBe('select message_id from librarius_parts where discord_id = $1')
    expect(log[0].params).toEqual([MSG_2])
  })

  it('answers the id itself when it is no part of a reply', async () => {
    expect(await store(fakePool().pool).messageOfPart(MSG_2)).toBe(MSG_2)
  })

  it.each(labelled(BAD_IDS))('refuses the id %s before any query', async (_, id) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).messageOfPart(id), ID_MSG('id'))
  })
  it.each(labelled(BAD_IDS))('refuses the id %s before any query', async (_, id) => {
    const { pool, log } = fakePool()
    await expect(store(pool).messageOfPart(id)).rejects.toThrow(TypeError)
    expect(log).toEqual([])
  })
})

describe('siteDeleted', () => {
  // A reply of three parts MSG, MSG_2, MSG_3; MSG's message is stored.
  const partsOf = (rows) => ['select discord_id, message_id', rows]
  const three = [
    partsOf([{ discord_id: MSG_2, message_id: MSG }]),
    ['select discord_id from librarius_parts where message_id', [{ discord_id: MSG }, { discord_id: MSG_2 }, { discord_id: MSG_3 }]],
    ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
  ]

  it('answers every id as plain when none is a part, after one question', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).siteDeleted([MSG, MSG_2], POST)).toEqual({ plain: [MSG, MSG_2] })
    expect(log.map((l) => l.sql)).toEqual(['begin', 'select discord_id, message_id from librarius_parts where discord_id = any($1::bigint[])', 'commit'])
    expect(log[1].params).toEqual([[MSG, MSG_2]])
  })

  it('asks nothing for no ids', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).siteDeleted([], POST)).toEqual({ plain: [] })
    expect(log).toEqual([])
  })

  it('takes the whole reply when one of its parts is deleted: the message goes, noted for the readers, and the parts left are queued for deletion', async () => {
    const r = revPool([...three, ["select 1 from librarius_outbox", []]])
    expect(await store(r.pool).siteDeleted([MSG_2, MSG_4], POST)).toEqual({ plain: [MSG_4] })
    expect(r.sqls()).toEqual([
      'begin',
      'select discord_id, message_id from librarius_parts where discord_id = any($1::bigint[])',
      "select nextval('librarius_rev') as rev",
      'select discord_id from librarius_parts where message_id = $1 order by part_index',
      'select post_id, author_id from librarius_messages where id = $1',
      'insert into librarius_tombstones (message_id, post_id, rev) select id, post_id, $2::bigint from librarius_messages where id = any($1::bigint[])',
      'delete from librarius_messages where id = any($1::bigint[])',
      'delete from librarius_parts where message_id = $1',
      "select 1 from librarius_outbox where kind = 'delete' and message_key = $1 and state in ('pending', 'sending')",
      "insert into librarius_outbox (kind, message_key, author_id, payload) values ('delete', $1, $2, $3::jsonb)",
      'insert into librarius_events (actor_id, action, post_id, message_id, note) values ($1, $2, $3, $4, $5)',
      'commit',
    ])
    const at = (sql) => r.log.find((l) => l.sql === sql).params
    expect(at('select discord_id from librarius_parts where message_id = $1 order by part_index')).toEqual([MSG])
    expect(at('select post_id, author_id from librarius_messages where id = $1')).toEqual([MSG])
    expect(at('delete from librarius_parts where message_id = $1')).toEqual([MSG])
    expect(at("select 1 from librarius_outbox where kind = 'delete' and message_key = $1 and state in ('pending', 'sending')")).toEqual([MSG])
    expect(at('delete from librarius_messages where id = any($1::bigint[])')).toEqual([[MSG]])
    expect(r.log[5].params).toEqual([[MSG], '900'])
    expect(at("insert into librarius_outbox (kind, message_key, author_id, payload) values ('delete', $1, $2, $3::jsonb)")).toEqual([MSG, AUTHOR, JSON.stringify({ postId: POST, partIds: [MSG, MSG_3] })])
    expect(at('insert into librarius_events (actor_id, action, post_id, message_id, note) values ($1, $2, $3, $4, $5)')).toEqual([AUTHOR, 'deleted-in-discord', POST, MSG, null])
  })

  it('queues nothing when a delete of the reply is on its way already', async () => {
    const r = revPool([...three, ['select 1 from librarius_outbox', [{ '?column?': 1 }]]])
    await store(r.pool).siteDeleted([MSG_2], POST)
    expect(r.sqls().some((s) => s.startsWith('insert into librarius_outbox'))).toBe(false)
    expect(r.sqls()).toContain('delete from librarius_messages where id = any($1::bigint[])')
  })

  it('queues nothing when no part is left, as for a reply of one part', async () => {
    const r = revPool([
      partsOf([{ discord_id: MSG, message_id: MSG }]),
      ['select discord_id from librarius_parts where message_id', [{ discord_id: MSG }]],
      ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
    ])
    expect(await store(r.pool).siteDeleted([MSG], POST)).toEqual({ plain: [] })
    expect(r.sqls().some((s) => s.includes('from librarius_outbox'))).toBe(false)
    expect(r.sqls()).toContain('delete from librarius_parts where message_id = $1')
  })

  it('takes each reply once when several of its parts, or several replies, are deleted together, with one rev', async () => {
    const r = revPool([
      partsOf([
        { discord_id: MSG, message_id: MSG },
        { discord_id: MSG_2, message_id: MSG },
        { discord_id: MSG_4, message_id: MSG_3 },
      ]),
      ['select discord_id from librarius_parts where message_id', (p) => (p[0] === MSG ? [{ discord_id: MSG }, { discord_id: MSG_2 }] : [{ discord_id: MSG_3 }, { discord_id: MSG_4 }])],
      ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
      ['select 1 from librarius_outbox', []],
    ])
    expect(await store(r.pool).siteDeleted([MSG, MSG_2, MSG_4], POST)).toEqual({ plain: [] })
    expect(r.sqls().filter((s) => s.startsWith("select nextval"))).toHaveLength(1)
    expect(r.sqls().filter((s) => s.startsWith('delete from librarius_messages'))).toHaveLength(2)
    const queued = r.log.filter((l) => l.sql.startsWith('insert into librarius_outbox'))
    expect(queued).toHaveLength(1)
    expect(queued[0].params).toEqual([MSG_3, AUTHOR, JSON.stringify({ postId: POST, partIds: [MSG_3] })])
    expect(r.log.filter((l) => l.sql.startsWith('insert into librarius_events')).map((l) => l.params[3])).toEqual([MSG, MSG_3])
  })

  it('still deletes the remaining parts of a reply whose message is no longer stored, with no author to name', async () => {
    const r = revPool([
      partsOf([{ discord_id: MSG_2, message_id: MSG }]),
      ['select discord_id from librarius_parts where message_id', [{ discord_id: MSG }, { discord_id: MSG_2 }]],
      ['select post_id, author_id from librarius_messages', []],
      ['select 1 from librarius_outbox', []],
    ])
    await store(r.pool).siteDeleted([MSG_2], POST)
    expect(r.log.find((l) => l.sql.startsWith('insert into librarius_outbox')).params).toEqual([MSG, '0', JSON.stringify({ postId: POST, partIds: [MSG] })])
    expect(r.log.find((l) => l.sql.startsWith('insert into librarius_events')).params).toEqual(['0', 'deleted-in-discord', POST, MSG, null])
  })

  it('rolls back and throws what failed', async () => {
    const err = boom()
    const r = revPool([...three, ['insert into librarius_outbox', err], ['select 1 from librarius_outbox', []]])
    await expect(store(r.pool).siteDeleted([MSG_2], POST)).rejects.toBe(err)
    expect(r.sqls().at(-1)).toBe('rollback')
  })

  it.each([
    ...labelled([undefined, null, 'x', {}]).map(([n, v]) => [`ids ${n}`, v, POST, LIST_MSG('ids')]),
    ...labelled(BAD_IDS).map(([n, v]) => [`an id ${n}`, [MSG, v], POST, ID_MSG('a part id')]),
    ...labelled(BAD_IDS).map(([n, v]) => [`postId ${n}`, [MSG], v, ID_MSG('postId')]),
  ])('refuses %s before any query', async (_, ids, postId, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).siteDeleted(ids, postId), message)
  })
})

describe('blockedSince', () => {
  it('answers the times of the blocks since then, oldest first, as ISO text', async () => {
    const { pool, log } = fakePool([['from librarius_events', [{ at: new Date('2026-11-18T10:00:00.000Z') }, { at: '2026-11-18T10:30:00.000Z' }]]])
    expect(await store(pool).blockedSince(new Date('2026-11-18T09:00:00.000Z'))).toEqual(['2026-11-18T10:00:00.000Z', '2026-11-18T10:30:00.000Z'])
    expect(log[0].sql).toBe("select at from librarius_events where action = 'blocked' and at >= $1::timestamptz order by at")
    expect(log[0].params).toEqual(['2026-11-18T09:00:00.000Z'])
  })

  it.each(labelled([undefined, null, 'soon', {}, Number.NaN]))('refuses the time %s before any query', async (_, since) => {
    const { pool, log } = fakePool()
    await expect(store(pool).blockedSince(since)).rejects.toThrow(new TypeError('since must be a Date, an ISO time or epoch milliseconds'))
    expect(log).toEqual([])
  })
})

describe('addUpload', () => {
  const GOOD = { authorId: AUTHOR, name: 'picture.png', contentType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }

  it('holds the picture for its author and answers the id the table gave it', async () => {
    const { pool, log } = fakePool([['insert into librarius_uploads', [{ id: '41' }]]])
    expect(await store(pool).addUpload(GOOD)).toEqual({ id: '41' })
    expect(log).toHaveLength(1)
    expect(log[0].sql).toBe('insert into librarius_uploads (author_id, name, content_type, bytes) values ($1, $2, $3, $4) returning id')
    expect(log[0].params).toHaveLength(4)
    expect(log[0].params.slice(0, 3)).toEqual([AUTHOR, 'picture.png', 'image/png'])
    // pg takes bytea as a Buffer: the same bytes, in one.
    expect(Buffer.isBuffer(log[0].params[3])).toBe(true)
    expect([...log[0].params[3]]).toEqual([137, 80, 78, 71])
  })

  it('sends the bytes of a view of a bigger buffer, and only those', async () => {
    const { pool, log } = fakePool([['insert into librarius_uploads', [{ id: '41' }]]])
    const whole = new Uint8Array([9, 9, 1, 2, 3, 9])
    await store(pool).addUpload({ ...GOOD, bytes: whole.subarray(2, 5) })
    expect([...log[0].params[3]]).toEqual([1, 2, 3])
  })

  it('takes a name of exactly 1 character and of exactly 100, and no other length', async () => {
    for (const name of ['p', 'p'.repeat(100)]) {
      const { pool, log } = fakePool([['insert into librarius_uploads', [{ id: '1' }]]])
      await store(pool).addUpload({ ...GOOD, name })
      expect(log[0].params[1]).toBe(name)
    }
  })

  it('takes each of the four types of picture', async () => {
    for (const contentType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      const { pool, log } = fakePool([['insert into librarius_uploads', [{ id: '1' }]]])
      await store(pool).addUpload({ ...GOOD, contentType })
      expect(log[0].params[2]).toBe(contentType)
    }
  })

  it.each([
    ...labelled(BAD_IDS).map(([name, v]) => [`authorId ${name}`, { ...GOOD, authorId: v }, ID_MSG('authorId')]),
    ...labelled([undefined, null, '', 7, {}, ['picture.png'], 'x'.repeat(101)]).map(([name, v]) => [`name ${name}`, { ...GOOD, name: v }, 'name must be a text of 1 to 100 characters']),
    ...labelled(['image/svg+xml', 'IMAGE/PNG', 'image/png ', 'text/html', '', undefined, null, 7, {}]).map(([name, v]) => [`contentType ${name}`, { ...GOOD, contentType: v }, 'contentType must be image/png, image/jpeg, image/webp or image/gif']),
    ...labelled([undefined, null, '', 'bytes', [1, 2, 3], new ArrayBuffer(4), new Uint8Array(0), Buffer.alloc(0), {}, 7]).map(([name, v]) => [`bytes ${name}`, { ...GOOD, bytes: v }, 'bytes must be a Uint8Array of at least one byte']),
  ])('refuses %s before any query', async (_, upload, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).addUpload(upload), message)
  })

  it.each(labelled([undefined, null, 'x', 7]))('refuses an upload that is %s before any query', async (_, upload) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).addUpload(upload), OBJECT_MSG('upload'))
  })

  it('takes a Buffer for its bytes, which is a Uint8Array', async () => {
    const { pool, log } = fakePool([['insert into librarius_uploads', [{ id: '2' }]]])
    await store(pool).addUpload({ ...GOOD, bytes: Buffer.from([1, 2]) })
    expect([...log[0].params[3]]).toEqual([1, 2])
  })

  it('lets a failure of the table through, naming nothing it was given', async () => {
    const { pool } = fakePool([['insert into librarius_uploads', new Error('the table is gone')]])
    await expect(store(pool).addUpload(GOOD)).rejects.toThrow('the table is gone')
  })
})

describe('heldUploadIds', () => {
  it('answers the ids of those uploads that the author still holds, as a Set', async () => {
    const { pool, log } = fakePool([['from librarius_uploads', [{ id: '4' }, { id: '3' }]]])
    const got = await store(pool).heldUploadIds(AUTHOR, ['3', '5', '4'])
    expect(got).toBeInstanceOf(Set)
    expect([...got].sort()).toEqual(['3', '4'])
    expect(log).toHaveLength(1)
    expect(log[0].sql).toBe('select id from librarius_uploads where author_id = $1 and id = any($2::bigint[])')
    expect(log[0].params).toEqual([AUTHOR, ['3', '5', '4']])
  })

  it('never reads the bytes of a picture to say that it is held', async () => {
    const { pool, log } = fakePool()
    await store(pool).heldUploadIds(AUTHOR, ['3'])
    expect(log[0].sql).not.toContain('bytes')
  })

  it('asks nothing for no uploads', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).heldUploadIds(AUTHOR, [])).toEqual(new Set())
    expect(log).toEqual([])
  })

  it('takes 50 ids and refuses 51, before any query', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => String(i + 1))
    const ok = fakePool()
    await store(ok.pool).heldUploadIds(AUTHOR, ids.slice(0, 50))
    expect(ok.log).toHaveLength(1)
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).heldUploadIds(AUTHOR, ids), 'ids must hold at most 50 ids')
  })

  it.each([
    ...labelled(BAD_IDS).map(([name, v]) => [`authorId ${name}`, v, ['1'], ID_MSG('authorId')]),
    ...labelled([undefined, null, 'x', {}]).map(([name, v]) => [`ids ${name}`, AUTHOR, v, LIST_MSG('ids')]),
    ...labelled(BAD_SERIALS).map(([name, v]) => [`an id ${name}`, AUTHOR, ['1', v], SERIAL_MSG('an upload id')]),
  ])('refuses %s before any query', async (_, authorId, ids, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).heldUploadIds(authorId, ids), message)
  })
})

describe('outboxFor', () => {
  const SINCE = '2026-11-17T10:00:00.000Z'
  const entry = (id, over = {}) => ({
    id,
    kind: 'send',
    message_key: `key-${id}`,
    state: 'pending',
    last_error: null,
    source: 'hello',
    created_at: new Date('2026-11-18T10:00:00.000Z'),
    ...over,
  })

  it("answers the author's entries for that post that are not done, oldest first, as the member sees them", async () => {
    const rows = [entry('9', { state: 'blocked', last_error: "Blocked by the server's AutoMod." }), entry('8', { kind: 'edit', message_key: MSG, state: 'sending', source: null, created_at: '2026-11-18T09:00:00.000Z' })]
    const { pool, log } = fakePool([['from librarius_outbox', rows]])
    expect(await store(pool).outboxFor(AUTHOR, POST, SINCE)).toEqual([
      { key: MSG, kind: 'edit', state: 'sending', error: null, source: null, createdAt: '2026-11-18T09:00:00.000Z' },
      { key: 'key-9', kind: 'send', state: 'blocked', error: "Blocked by the server's AutoMod.", source: 'hello', createdAt: '2026-11-18T10:00:00.000Z' },
    ])
    expect(log).toHaveLength(1)
    // The recording pool lowercases what it is given; the real statement reads the key as 'postId' (proven against Postgres).
    expect(log[0].sql).toBe(
      "select id, kind, message_key, state, last_error, case when kind = 'send' then payload->>'source' end as source, created_at from librarius_outbox where author_id = $1 and payload->>'postid' = $2 and state <> 'sent' and created_at >= $3::timestamptz order by id desc limit 20",
    )
    expect(log[0].params).toEqual([AUTHOR, POST, SINCE])
  })

  it('takes the time as a Date or epoch milliseconds too', async () => {
    for (const since of [new Date(SINCE), Date.parse(SINCE)]) {
      const { pool, log } = fakePool()
      expect(await store(pool).outboxFor(AUTHOR, POST, since)).toEqual([])
      expect(log[0].params[2]).toBe(SINCE)
    }
  })

  it.each([
    ...labelled(BAD_IDS).map(([name, v]) => [`authorId ${name}`, v, POST, SINCE, ID_MSG('authorId')]),
    ...labelled(BAD_IDS).map(([name, v]) => [`postId ${name}`, AUTHOR, v, SINCE, ID_MSG('postId')]),
    ...labelled([undefined, null, 'soon', {}, Number.NaN]).map(([name, v]) => [`since ${name}`, AUTHOR, POST, v, TIME_MSG('since')]),
  ])('refuses %s before any query', async (_, authorId, postId, since, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).outboxFor(authorId, postId, since), message)
  })
})

describe('sweepUploads', () => {
  const OLDER = '2026-11-18T09:00:00.000Z'

  it('deletes what is an hour old unless a reply on its way names it, and what a reply that ended for good named, and says how many', async () => {
    const { pool, log } = fakePool([['delete from librarius_uploads', [{ id: '3' }, { id: '5' }]]])
    expect(await store(pool).sweepUploads({ olderThan: new Date(OLDER) })).toBe(2)
    expect(log).toHaveLength(1)
    expect(log[0].sql).toBe(
      "delete from librarius_uploads u where not exists (select 1 from librarius_outbox o where o.kind = 'send' and o.state in ('pending', 'sending') and o.payload->'uploads' @> to_jsonb(u.id::text)) and (u.created_at < $1::timestamptz or exists (select 1 from librarius_outbox o where o.kind = 'send' and o.state in ('failed', 'blocked') and o.payload->'uploads' @> to_jsonb(u.id::text))) returning u.id",
    )
    expect(log[0].params).toEqual([OLDER])
  })

  it('answers 0 when there was nothing to delete', async () => {
    const { pool } = fakePool()
    expect(await store(pool).sweepUploads({ olderThan: OLDER })).toBe(0)
  })

  it('takes the time as epoch milliseconds too', async () => {
    const { pool, log } = fakePool()
    await store(pool).sweepUploads({ olderThan: Date.parse(OLDER) })
    expect(log[0].params).toEqual([OLDER])
  })

  it.each(labelled([undefined, null, 'soon', {}, Number.NaN]))('refuses the time %s before any query', async (_, olderThan) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).sweepUploads({ olderThan }), TIME_MSG('olderThan'))
  })

  it.each(labelled([undefined, null, 'x', 7]))('refuses options that are %s before any query', async (_, options) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).sweepUploads(options), OBJECT_MSG('options'))
  })
})

describe('hostile values (property)', () => {
  it('no method reaches the pool with a value that is not what it takes', async () => {
    const wrong = fc.oneof(fc.constant(undefined), fc.constant(null), fc.integer(), fc.string(), fc.boolean(), fc.object())
    const calls = [
      (s, v) => s.enqueueOutbox({ kind: v, messageKey: v, authorId: v, payload: v }),
      (s, v) => s.outboxProgress(v, v),
      (s, v) => s.outboxSet(v, v),
      (s, v) => s.finishSend(v, v),
      (s, v) => s.finishEdit(v, v),
      (s, v) => s.finishDelete(v, v),
      (s, v) => s.outboxMessage(v),
      (s, v) => s.uploadsFor(v, v),
      (s, v) => s.knownPartIds(v),
      (s, v) => s.messageOfPart(v),
      (s, v) => s.siteDeleted(v, v),
      (s, v) => s.addUpload(v),
      (s, v) => s.heldUploadIds(v, v),
      (s, v) => s.outboxFor(v, v, v),
      (s, v) => s.sweepUploads(v),
    ]
    await fc.assert(
      fc.asyncProperty(wrong, fc.nat(calls.length - 1), async (v, i) => {
        const { pool, log } = fakePool()
        await expect(calls[i](store(pool), v)).rejects.toThrow(TypeError)
        expect(log).toEqual([])
      }),
      { numRuns: 200 },
    )
  })
})
