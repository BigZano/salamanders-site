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
      "update librarius_outbox set state = $2, attempts = coalesce($3::int, attempts), next_at = coalesce($4::timestamptz, next_at), last_error = $5 where id = $1 and state = 'sending' returning kind, message_key, author_id",
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

  it('does nothing more for an entry that is not there, or is not sending any more: what was written once is not written again', async () => {
    const { pool, sqls } = fakePool()
    await store(pool).outboxSet('12', {
      state: 'blocked',
      messageState: 'blocked',
      event: { action: 'blocked' },
      queue: [{ kind: 'delete', messageKey: MSG, payload: { postId: POST } }],
    })
    expect(sqls()).toEqual(['begin', has("and state = 'sending'"), 'commit'])
  })

  describe('queue', () => {
    const insert = 'insert into librarius_outbox (kind, message_key, author_id, payload) values ($1, $2, $3, $4::jsonb) returning id'
    const messageState = "update librarius_messages set state = 'sending', rev = nextval('librarius_rev') where id = $1"
    const withQueue = (kind) => fakePool([...entry(kind), ['insert into librarius_outbox', [{ id: '31' }]]])

    it('queues each entry for the author of the entry, after the event, in the same transaction, in order', async () => {
      const { pool, log } = withQueue('edit')
      const restore = { kind: 'edit', messageKey: MSG, payload: { postId: POST, source: 'old', mentions: [], restore: true } }
      const remove = { kind: 'delete', messageKey: MSG_2, payload: { postId: POST, partIds: [MSG_2] } }
      await store(pool).outboxSet('12', { state: 'failed', error: 'x', messageState: null, event: { action: 'failed', postId: POST }, queue: [restore, remove] })
      expect(log.map((l) => l.sql)).toEqual([
        'begin',
        has("and state = 'sending'"),
        has('update librarius_messages set state = $2'),
        has('insert into librarius_events'),
        insert,
        messageState,
        insert,
        messageState,
        'commit',
      ])
      expect(log[4].params).toEqual(['edit', MSG, AUTHOR, JSON.stringify(restore.payload)])
      expect(log[5].params).toEqual([MSG])
      expect(log[6].params).toEqual(['delete', MSG_2, AUTHOR, JSON.stringify(remove.payload)])
      expect(log[7].params).toEqual([MSG_2])
    })

    it('queues nothing when it is given nothing, and takes up to two', async () => {
      const none = withQueue('send')
      await store(none.pool).outboxSet('12', { state: 'failed' })
      expect(none.sqls()).toEqual(['begin', has('update librarius_outbox'), 'commit'])
      const two = withQueue('send')
      const item = { kind: 'delete', messageKey: MSG, payload: { postId: POST } }
      await store(two.pool).outboxSet('12', { state: 'failed', queue: [item, item] })
      expect(two.sqls().filter((q) => q === insert)).toHaveLength(2)
    })

    it('rolls back everything when an entry cannot be queued', async () => {
      const err = boom()
      const { pool, sqls } = fakePool([...entry('send'), ['insert into librarius_outbox', err]])
      await expect(store(pool).outboxSet('12', { state: 'failed', queue: [{ kind: 'delete', messageKey: MSG, payload: { postId: POST } }] })).rejects.toBe(err)
      expect(sqls().at(-1)).toBe('rollback')
    })

    const good = { kind: 'delete', messageKey: MSG, payload: { postId: POST } }
    it.each([
      ...labelled([null, 'x', {}, 7]).map(([name, queue]) => [`queue ${name}`, queue, LIST_MSG('queue')]),
      ['three entries', [good, good, good], 'queue must hold at most 2 entries'],
      ...labelled([undefined, null, 'x', []]).map(([name, item]) => [`an entry ${name}`, [item], OBJECT_MSG('a queued entry')]),
      ...labelled(['send', 'SEND', '', undefined, 7]).map(([name, kind]) => [`a kind ${name}`, [{ ...good, kind }], 'the kind of a queued entry must be one of edit, delete']),
      ...labelled(BAD_IDS).map(([name, messageKey]) => [`a messageKey ${name}`, [{ ...good, messageKey }], ID_MSG('the messageKey of a queued entry')]),
      ...labelled([undefined, null, 'x', []]).map(([name, payload]) => [`a payload ${name}`, [{ ...good, payload }], OBJECT_MSG('the payload of a queued entry')]),
      ...labelled([...BAD_IDS, undefined]).map(([name, postId]) => [`a payload.postId ${name}`, [{ ...good, payload: { postId } }], ID_MSG('the payload.postId of a queued entry')]),
    ])('refuses %s before any query', async (_, queue, message) => {
      const rig = fakePool()
      await refused(rig, () => store(rig.pool).outboxSet('12', { state: 'failed', queue }), message)
    })
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
  const GONE_SQL = "select coalesce(payload->'gone', '[]'::jsonb) as gone, author_id from librarius_outbox where id = $1 and state = 'sending' for update"
  const run = (script, over = {}, args = {}) => {
    const rig = revPool([...script, ["payload->'gone'", [{ gone: [], author_id: AUTHOR }]], ['select 1 from librarius_posts', [{ '?column?': 1 }]]])
    const done = store(rig.pool).finishSend('12', { message: message(over), partIds: [MSG], uploadIds: [], event: EVENT, ...args })
    return { ...rig, done }
  }

  it('stores a one-part reply, its parts, the event and the state of the entry, in one transaction, in order, and says it is stored', async () => {
    const r = run([])
    expect(await r.done).toEqual({ stored: true, gone: [] })
    expect(r.sqls()).toEqual([
      'begin',
      GONE_SQL,
      'select 1 from librarius_posts where id = $1',
      "select nextval('librarius_rev') as rev",
      has('insert into librarius_messages'),
      'delete from librarius_attachments where message_id = $1',
      'delete from librarius_parts where message_id = $1',
      'insert into librarius_parts (message_id, part_index, discord_id, webhook_id) select $1::bigint, (t.n - 1)::smallint, t.id, (select webhook_id from librarius_messages where id = $1::bigint) from unnest($2::bigint[]) with ordinality as t (id, n)',
      'insert into librarius_events (actor_id, action, post_id, message_id, note) values ($1, $2, $3, $4, $5)',
      "update librarius_outbox set state = 'sent', last_error = null where id = $1",
      'commit',
    ])
    expect(r.log[1].params).toEqual(['12'])
    expect(r.log[2].params).toEqual([POST])
    expect(r.log[4].params).toEqual([MSG, POST, AUTHOR, 'Invented Name', null, HOOK, 'hello', null, '2026-11-18T10:00:00.000Z', '900', 'hello', JSON.stringify({ form: 'v2', authorId: AUTHOR })])
    expect(r.log[5].params).toEqual([MSG])
    expect(r.log[6].params).toEqual([MSG])
    expect(r.log[7].params).toEqual([MSG, [MSG]])
    expect(r.log[8].params).toEqual([AUTHOR, 'send', POST, MSG, '1 part'])
    expect(r.log[9].params).toEqual(['12'])
  })

  it('writes the author of the entry into the layout, read from the entry in the same transaction, so that the repair knows the author with no entry or event left', async () => {
    const QUEUED_BY = '200000000000000419'
    const r = run([["payload->'gone'", [{ gone: [], author_id: QUEUED_BY }]]], { layout: { form: 'plain', username: 'Invented Name', authorId: '200000000000000499' } })
    await r.done
    expect(r.log[1].sql).toBe(GONE_SQL)
    expect(JSON.parse(r.log[4].params[11])).toStrictEqual({ form: 'plain', username: 'Invented Name', authorId: QUEUED_BY })
  })

  it('writes the message as a message of the site, with no embeds, stickers or reactions, kind 0 and no state, and keeps the reactions a conflict finds', async () => {
    const r = run([])
    await r.done
    const sql = r.log[4].sql
    expect(sql).toContain("0, $7::text, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $8::bigint, $9::timestamptz, null, $10::bigint, 'site', $11::text, null, $12::jsonb")
    expect(sql).toContain('on conflict (id) do update set')
    expect(sql).not.toContain('reactions = excluded')
    for (const column of ['post_id', 'author_id', 'author_name', 'author_avatar', 'webhook_id', 'kind', 'content', 'reply_to', 'created_at', 'edited_at', 'rev', 'origin', 'source', 'state', 'layout']) {
      expect(sql).toContain(`${column} = excluded.${column}`)
    }
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
    expect(r.sqls().slice(0, 7)).toEqual([
      'begin',
      GONE_SQL,
      'select 1 from librarius_posts where id = $1',
      "select nextval('librarius_rev') as rev",
      'insert into librarius_tombstones (message_id, post_id, rev) select id, post_id, $2::bigint from librarius_messages where id = any($1::bigint[])',
      'delete from librarius_messages where id = any($1::bigint[])',
      has('insert into librarius_messages'),
    ])
    expect(r.log[4].params).toEqual([[MSG_2, MSG_3], '900'])
    expect(r.log[5].params).toEqual([[MSG_2, MSG_3]])
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

  it('writes nothing, and says so, for an entry that is not sending any more: a write that was made is not made again', async () => {
    const r = run([["payload->'gone'", []]])
    expect(await r.done).toEqual({ stored: true, gone: [] })
    expect(r.sqls()).toEqual(['begin', GONE_SQL, 'commit'])
  })

  it('writes nothing, and names the parts, when Discord deleted some of the parts of the reply while it was on its way', async () => {
    const r = run([["payload->'gone'", [{ gone: [MSG_3, MSG_2] }]]], {}, { partIds: [MSG, MSG_2] })
    expect(await r.done).toEqual({ stored: false, gone: [MSG_2] })
    expect(r.sqls()).toEqual(['begin', GONE_SQL, 'commit'])
  })

  it('does not count a part that is not one of this reply', async () => {
    const r = run([["payload->'gone'", [{ gone: [MSG_4] }]]], {}, { partIds: [MSG, MSG_2] })
    expect(await r.done).toEqual({ stored: true, gone: [] })
    expect(r.sqls()).toContain("update librarius_outbox set state = 'sent', last_error = null where id = $1")
  })

  it('writes nothing, and gives no list of lost parts, for a reply whose post is not stored: the caller has to deal with what is in Discord', async () => {
    const r = run([['select 1 from librarius_posts', []]], {}, { uploadIds: ['3'] })
    expect(await r.done).toEqual({ stored: false, gone: null })
    expect(r.sqls()).toEqual(['begin', GONE_SQL, 'select 1 from librarius_posts where id = $1', 'commit'])
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
      expect(r.log[4].params[8]).toBe(at)
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
    expect(r.log[4].params[4]).toBe('https://cdn.discordapp.com/avatars/1/2.png')
  })

  it('takes a reply to a message', async () => {
    const r = run([], { replyTo: MSG_4 })
    await r.done
    expect(r.log[4].params[7]).toBe(MSG_4)
  })

  it('takes ten uploads', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => String(i + 1))
    const r = run([], {}, { uploadIds: ids })
    await expect(r.done).resolves.toEqual({ stored: true, gone: [] })
  })
})

describe('finishEdit', () => {
  const GONE_SQL = "select coalesce(payload->'gone', '[]'::jsonb) as gone, author_id from librarius_outbox where id = $1 and state = 'sending' for update"
  const run = (script, args = {}) => {
    const rig = fakePool([...script, ["payload->'gone'", [{ gone: [] }]], ['update librarius_messages', [{ author_id: AUTHOR }]], ['update librarius_outbox', [{ author_id: AUTHOR }]]])
    const done = store(rig.pool).finishEdit('12', { messageId: MSG, source: 'new source', content: 'new content', partIds: [MSG, MSG_2], event: { action: 'edit', postId: POST, messageId: MSG }, ...args })
    return { ...rig, done }
  }

  it('gives the message its new text, edit time and no state, replaces its parts, ends the entry and notes the event, in one transaction, and says it is stored', async () => {
    const r = run([])
    expect(await r.done).toEqual({ stored: true, gone: [] })
    expect(r.sqls()).toEqual([
      'begin',
      GONE_SQL,
      "update librarius_messages set source = $2, content = $3, edited_at = now(), state = null, rev = nextval('librarius_rev') where id = $1 and origin = 'site' returning author_id",
      'delete from librarius_parts where message_id = $1',
      has('insert into librarius_parts'),
      "update librarius_outbox set state = 'sent', last_error = null where id = $1 returning author_id",
      has('insert into librarius_events'),
      'commit',
    ])
    expect(r.log[1].params).toEqual(['12'])
    expect(r.log[2].params).toEqual([MSG, 'new source', 'new content'])
    expect(r.log[3].params).toEqual([MSG])
    expect(r.log[4].params).toEqual([MSG, [MSG, MSG_2]])
    expect(r.log[5].params).toEqual(['12'])
    expect(r.log[6].params).toEqual([AUTHOR, 'edit', POST, MSG, null])
  })

  it('does not bring back a message that is gone, nor give it parts, nor end the entry: the caller has the parts to deal with', async () => {
    const r = run([['update librarius_messages', []]])
    expect(await r.done).toEqual({ stored: false, gone: [] })
    expect(r.sqls()).toEqual(['begin', GONE_SQL, has('update librarius_messages'), 'commit'])
  })

  it('writes nothing for an entry that is not sending any more: a write that was made is not made again', async () => {
    const r = run([["payload->'gone'", []]])
    expect(await r.done).toEqual({ stored: true, gone: [] })
    expect(r.sqls()).toEqual(['begin', GONE_SQL, 'commit'])
  })

  it('writes nothing, and names the parts, when Discord deleted some of the parts the edit made', async () => {
    const r = run([["payload->'gone'", [{ gone: [MSG_3, MSG_2] }]]])
    expect(await r.done).toEqual({ stored: false, gone: [MSG_2] })
    expect(r.sqls()).toEqual(['begin', GONE_SQL, 'commit'])
  })

  it('does not count a part that is not one of the reply', async () => {
    const r = run([["payload->'gone'", [{ gone: [MSG_4] }]]])
    expect(await r.done).toEqual({ stored: true, gone: [] })
  })

  // The parts an edit no longer needs are removed before it is done, and Discord tells of each removal: siteDeleted notes those in the entry.
  it('does not count the parts the edit removed itself: a reply of three parts made one is stored, with its one part', async () => {
    const r = run([["payload->'gone'", [{ gone: [MSG_2, MSG_3], author_id: AUTHOR }]]], { partIds: [MSG] })
    expect(await r.done).toEqual({ stored: true, gone: [] })
    expect(r.log.find((l) => l.sql.startsWith('insert into librarius_parts')).params).toEqual([MSG, [MSG]])
    expect(r.sqls().slice(-3)).toEqual(["update librarius_outbox set state = 'sent', last_error = null where id = $1 returning author_id", has('insert into librarius_events'), 'commit'])
  })

  it('still counts a part it keeps that was deleted in Discord, beside the ones it removed: nothing is written, and the caller purges the reply', async () => {
    const r = run([["payload->'gone'", [{ gone: [MSG_3, MSG] }]]], { partIds: [MSG, MSG_2] })
    expect(await r.done).toEqual({ stored: false, gone: [MSG] })
    expect(r.sqls()).toEqual(['begin', GONE_SQL, 'commit'])
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
  const END_SQL = "update librarius_outbox set state = 'sent', last_error = null where id = $1 and state = 'sending' returning author_id"
  const run = (script, args = {}) => {
    const rig = revPool([...script, ['update librarius_outbox', [{ author_id: AUTHOR }]]])
    const done = store(rig.pool).finishDelete('12', { messageId: MSG, partIds: [MSG, MSG_2], event: { action: 'delete', postId: POST, messageId: MSG }, ...args })
    return { ...rig, done }
  }

  it('ends the entry, deletes the message, noting it for the readers, forgets its parts and notes the event, in one transaction', async () => {
    const r = run([])
    await r.done
    expect(r.sqls()).toEqual([
      'begin',
      END_SQL,
      "select nextval('librarius_rev') as rev",
      'insert into librarius_tombstones (message_id, post_id, rev) select id, post_id, $2::bigint from librarius_messages where id = any($1::bigint[])',
      'delete from librarius_messages where id = any($1::bigint[])',
      'delete from librarius_parts where message_id = $1 or discord_id = any($2::bigint[])',
      has('insert into librarius_events'),
      'commit',
    ])
    expect(r.log[1].params).toEqual(['12'])
    expect(r.log[3].params).toEqual([[MSG], '900'])
    expect(r.log[4].params).toEqual([[MSG]])
    expect(r.log[5].params).toEqual([MSG, [MSG, MSG_2]])
    expect(r.log[6].params).toEqual([AUTHOR, 'delete', POST, MSG, null])
  })

  it('takes an empty list of parts', async () => {
    const r = run([], { partIds: [] })
    await r.done
    expect(r.log[5].params).toEqual([MSG, []])
  })

  it('writes nothing for an entry that is not sending any more: a write that was made is not made again', async () => {
    const r = run([['update librarius_outbox', []]])
    await r.done
    expect(r.sqls()).toEqual(['begin', END_SQL, 'commit'])
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
  const row = { id: MSG, post_id: POST, author_id: AUTHOR, author_name: 'Invented Name', author_avatar: 'https://cdn.example/a.png', webhook_id: HOOK, origin: 'site', source: 'hello', layout: { form: 'v2' }, state: 'sending' }

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
      webhookId: HOOK,
      origin: 'site',
      source: 'hello',
      layout: { form: 'v2' },
      state: 'sending',
      parts: [MSG, MSG_2],
    })
    expect(log.map((l) => l.sql)).toEqual([
      'select id, post_id, author_id, author_name, author_avatar, webhook_id, origin, source, layout, state from librarius_messages where id = $1',
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

// The one statement in which siteDeleted locks every entry it reads or writes, in the order of their ids, before any message: the replies and
// edits on their way that sent one of the ids no stored reply owns ($1), and the edits and deletes on their way of the replies it hits ($2).
const ENTRIES_SQL =
  "select id, kind, message_key, payload from librarius_outbox where state in ('pending', 'sending') and ((kind in ('send', 'edit') and exists (select 1 from jsonb_array_elements(coalesce(payload->'progress'->'parts', '[]'::jsonb)) as part where part->>'id' = any($1::text[]))) or (kind in ('edit', 'delete') and message_key = any($2::text[]))) order by id for update"
const NOTE_UPDATE = "update librarius_outbox set payload = jsonb_set(payload, '{gone}', $2::jsonb, true) where id = $1"
const PARTS_SQL = 'select discord_id, message_id from librarius_parts where discord_id = any($1::bigint[]) order by message_id'
const REPLY_PARTS_SQL = 'select discord_id, webhook_id from librarius_parts where message_id = $1 order by part_index'

describe('siteDeleted', () => {
  // A reply of three parts MSG, MSG_2, MSG_3; MSG's message is stored.
  const partsOf = (rows) => ['select discord_id, message_id', rows]
  const three = [
    partsOf([{ discord_id: MSG_2, message_id: MSG }]),
    ['select discord_id, webhook_id from librarius_parts where message_id', [{ discord_id: MSG, webhook_id: HOOK }, { discord_id: MSG_2, webhook_id: HOOK }, { discord_id: MSG_3, webhook_id: HOOK }]],
    ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
  ]
  const deleteOf = (id, payload, messageKey = MSG) => ({ id, kind: 'delete', message_key: messageKey, payload })
  const editOf = (id, payload, messageKey = MSG) => ({ id, kind: 'edit', message_key: messageKey, payload: { postId: POST, source: 'shorter', mentions: [], ...payload } })

  it('answers every id as plain when none is a part, after one question of the parts and one of the entries', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).siteDeleted([MSG, MSG_2], POST)).toEqual({ plain: [MSG, MSG_2] })
    expect(log.map((l) => l.sql)).toEqual(['begin', PARTS_SQL, ENTRIES_SQL, 'commit'])
    expect(log[1].params).toEqual([[MSG, MSG_2]])
    expect(log[2].params).toEqual([[MSG, MSG_2], []])
  })

  it('asks nothing for no ids', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).siteDeleted([], POST)).toEqual({ plain: [] })
    expect(log).toEqual([])
  })

  it('takes the whole reply when one of its parts is deleted: the message goes, noted for the readers, and the parts left are queued for deletion', async () => {
    const r = revPool([...three, [ENTRIES_SQL, []]])
    expect(await store(r.pool).siteDeleted([MSG_2, MSG_4], POST)).toEqual({ plain: [MSG_4] })
    expect(r.sqls()).toEqual([
      'begin',
      PARTS_SQL,
      ENTRIES_SQL,
      "select nextval('librarius_rev') as rev",
      REPLY_PARTS_SQL,
      'select post_id, author_id from librarius_messages where id = $1',
      'insert into librarius_tombstones (message_id, post_id, rev) select id, post_id, $2::bigint from librarius_messages where id = any($1::bigint[])',
      'delete from librarius_messages where id = any($1::bigint[])',
      'delete from librarius_parts where message_id = $1',
      "insert into librarius_outbox (kind, message_key, author_id, payload) values ('delete', $1, $2, $3::jsonb)",
      'insert into librarius_events (actor_id, action, post_id, message_id, note) values ($1, $2, $3, $4, $5)',
      'commit',
    ])
    const at = (sql) => r.log.find((l) => l.sql === sql).params
    expect(at(REPLY_PARTS_SQL)).toEqual([MSG])
    expect(at('select post_id, author_id from librarius_messages where id = $1')).toEqual([MSG])
    expect(at('delete from librarius_parts where message_id = $1')).toEqual([MSG])
    expect(at(ENTRIES_SQL)).toEqual([[MSG_4], [MSG]])
    expect(at('delete from librarius_messages where id = any($1::bigint[])')).toEqual([[MSG]])
    expect(r.log[6].params).toEqual([[MSG], '900'])
    expect(at("insert into librarius_outbox (kind, message_key, author_id, payload) values ('delete', $1, $2, $3::jsonb)")).toEqual([MSG, AUTHOR, JSON.stringify({ postId: POST, partIds: [MSG, MSG_3], webhookId: HOOK })])
    expect(at('insert into librarius_events (actor_id, action, post_id, message_id, note) values ($1, $2, $3, $4, $5)')).toEqual([AUTHOR, 'deleted-in-discord', POST, MSG, null])
  })

  it('locks the entries of the reply that are on their way before it reads or deletes its message: an entry before its message, the order finishDelete, finishEdit and outboxSet lock in', async () => {
    const r = revPool([...three, [ENTRIES_SQL, []]])
    await store(r.pool).siteDeleted([MSG_2], POST)
    const order = r.sqls()
    const locked = order.indexOf(ENTRIES_SQL)
    expect(locked).toBeGreaterThan(0)
    for (const later of [REPLY_PARTS_SQL, 'select post_id, author_id from librarius_messages where id = $1', 'delete from librarius_messages where id = any($1::bigint[])', 'delete from librarius_parts where message_id = $1']) {
      expect(order.indexOf(later), later).toBeGreaterThan(locked)
    }
  })

  it('locks them for a reply of one part too, though it queues nothing for it', async () => {
    const r = revPool([
      partsOf([{ discord_id: MSG, message_id: MSG }]),
      ['select discord_id, webhook_id from librarius_parts where message_id', [{ discord_id: MSG, webhook_id: HOOK }]],
      ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
    ])
    await store(r.pool).siteDeleted([MSG], POST)
    expect(r.sqls().indexOf(ENTRIES_SQL)).toBeLessThan(r.sqls().indexOf('delete from librarius_messages where id = any($1::bigint[])'))
    expect(r.log.find((l) => l.sql === ENTRIES_SQL).params).toEqual([[], [MSG]])
  })

  it('locks the entries of every reply it hits in one statement, before any message, and then takes the replies in the order of their ids', async () => {
    const r = revPool([
      partsOf([
        { discord_id: MSG_2, message_id: MSG },
        { discord_id: MSG_4, message_id: MSG_3 },
      ]),
      ['select discord_id, webhook_id from librarius_parts where message_id', (p) => (p[0] === MSG ? [{ discord_id: MSG, webhook_id: HOOK }, { discord_id: MSG_2, webhook_id: HOOK }] : [{ discord_id: MSG_3, webhook_id: HOOK }, { discord_id: MSG_4, webhook_id: HOOK }])],
      ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
      [ENTRIES_SQL, []],
    ])
    await store(r.pool).siteDeleted([MSG_4, MSG_2], POST)
    const steps = r.log.filter((l) => l.sql === ENTRIES_SQL || l.sql.startsWith('delete from librarius_messages')).map((l) => (l.sql === ENTRIES_SQL ? ['lock', l.params[1]] : ['delete', l.params[0]]))
    expect(steps).toEqual([
      ['lock', [MSG, MSG_3]],
      ['delete', [MSG]],
      ['delete', [MSG_3]],
    ])
  })

  it('leaves a reply alone that a delete took while this waited for its lock: nothing deleted, queued or noted for it', async () => {
    const r = revPool([
      partsOf([
        { discord_id: MSG_2, message_id: MSG },
        { discord_id: MSG_4, message_id: MSG_3 },
      ]),
      // The delete of MSG's reply committed while this waited: its parts went with its message.
      ['select discord_id, webhook_id from librarius_parts where message_id', (p) => (p[0] === MSG ? [] : [{ discord_id: MSG_3, webhook_id: HOOK }, { discord_id: MSG_4, webhook_id: HOOK }])],
      ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
      [ENTRIES_SQL, []],
    ])
    expect(await store(r.pool).siteDeleted([MSG_2, MSG_4], POST)).toEqual({ plain: [] })
    const touched = (sql) => r.log.filter((l) => l.sql === sql).map((l) => l.params[0])
    expect(touched('select post_id, author_id from librarius_messages where id = $1')).toEqual([MSG_3])
    expect(touched('delete from librarius_messages where id = any($1::bigint[])')).toEqual([[MSG_3]])
    expect(touched('delete from librarius_parts where message_id = $1')).toEqual([MSG_3])
    expect(r.log.filter((l) => l.sql.startsWith('insert into librarius_outbox')).map((l) => l.params[0])).toEqual([MSG_3])
    expect(r.log.filter((l) => l.sql.startsWith('insert into librarius_events')).map((l) => l.params[3])).toEqual([MSG_3])
  })

  it('leaves a reply alone whose deleted parts an edit removed and was done with while this waited for its entry: the reply keeps the parts it has now', async () => {
    const r = revPool([
      partsOf([
        { discord_id: MSG_2, message_id: MSG },
        { discord_id: MSG_3, message_id: MSG },
      ]),
      // The edit made the reply one part, and committed: its entry is 'sent' now, so the lock found none of it.
      ['select discord_id, webhook_id from librarius_parts where message_id', [{ discord_id: MSG, webhook_id: HOOK }]],
      ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
      [ENTRIES_SQL, []],
    ])
    expect(await store(r.pool).siteDeleted([MSG_2, MSG_3], POST)).toEqual({ plain: [] })
    expect(r.sqls()).toEqual(['begin', PARTS_SQL, ENTRIES_SQL, "select nextval('librarius_rev') as rev", REPLY_PARTS_SQL, 'commit'])
  })

  // A delete of the reply that is on its way, as the row of the outbox says.
  it.each([
    ['one that was queued with the parts to remove', { postId: POST, partIds: [MSG, MSG_3] }],
    ['one at work, that has written down the parts it removes', { postId: POST, progress: { form: null, parts: [], inflight: null, partIds: [MSG, MSG_2, MSG_3] } }],
  ])('queues nothing when %s is on its way already', async (_, payload) => {
    const r = revPool([...three, [ENTRIES_SQL, [deleteOf('9', payload)]]])
    await store(r.pool).siteDeleted([MSG_2], POST)
    expect(r.sqls().some((s) => s.startsWith('insert into librarius_outbox'))).toBe(false)
    expect(r.sqls()).toContain('delete from librarius_messages where id = any($1::bigint[])')
  })

  it.each([
    ['a delete from the route, which will read its parts from the message, that is gone', [deleteOf('9', { postId: POST })]],
    ['a delete that has begun but not written its parts down', [deleteOf('9', { postId: POST, progress: { form: null, parts: [], inflight: null } })]],
    ['two that do not know them', [deleteOf('9', { postId: POST }), deleteOf('10', { postId: POST, progress: {} })]],
  ])('queues a delete of its own beside %s, since removing a part twice is harmless', async (_, rows) => {
    const r = revPool([...three, [ENTRIES_SQL, rows]])
    await store(r.pool).siteDeleted([MSG_2], POST)
    const queued = r.log.filter((l) => l.sql.startsWith('insert into librarius_outbox'))
    expect(queued).toHaveLength(1)
    expect(queued[0].params).toEqual([MSG, AUTHOR, JSON.stringify({ postId: POST, partIds: [MSG, MSG_3], webhookId: HOOK })])
  })

  it('queues nothing when any one of the deletes on its way knows its parts, though the others do not', async () => {
    const r = revPool([...three, [ENTRIES_SQL, [deleteOf('9', { postId: POST }), deleteOf('10', { postId: POST, partIds: [MSG_3] })]]])
    await store(r.pool).siteDeleted([MSG_2], POST)
    expect(r.sqls().some((s) => s.startsWith('insert into librarius_outbox'))).toBe(false)
  })

  it('counts only the deletes of that reply: a delete of another reply that knows its parts does not stand in for this one', async () => {
    const r = revPool([...three, [ENTRIES_SQL, [deleteOf('9', { postId: POST, partIds: [MSG_4] }, MSG_4)]]])
    await store(r.pool).siteDeleted([MSG_2], POST)
    expect(r.log.filter((l) => l.sql.startsWith('insert into librarius_outbox')).map((l) => l.params[0])).toEqual([MSG])
  })

  describe('a reply that an edit is on its way for', () => {
    // The edit may be removing these parts itself (the parts it no longer needs go before finishEdit writes the new list), so it decides.
    it('leaves the reply to the edit: notes the parts deleted in the edit, and deletes, queues and notes nothing of the reply', async () => {
      const r = revPool([
        partsOf([
          { discord_id: MSG_2, message_id: MSG },
          { discord_id: MSG_3, message_id: MSG },
        ]),
        ...three.slice(1),
        [ENTRIES_SQL, [editOf('8', { progress: { form: 'v2', parts: [], inflight: null, done: [`edit:${MSG}`, `remove:${MSG_2}`, `remove:${MSG_3}`] } })]],
      ])
      expect(await store(r.pool).siteDeleted([MSG_3, MSG_2], POST)).toEqual({ plain: [] })
      expect(r.sqls()).toEqual(['begin', PARTS_SQL, ENTRIES_SQL, "select nextval('librarius_rev') as rev", REPLY_PARTS_SQL, NOTE_UPDATE, 'commit'])
      expect(r.log[2].params).toEqual([[], [MSG]])
      expect(r.log[4].params).toEqual([MSG])
      // In the order of the reply's parts.
      expect(r.log[5].params).toEqual(['8', JSON.stringify([MSG_2, MSG_3])])
    })

    it.each([
      ['one that has not begun (pending, no progress)', editOf('8', {})],
      ['one at work (sending)', editOf('8', { progress: { form: 'v2', parts: [], inflight: null } })],
      ['a restore, which the worker queued', editOf('8', { mentions: [], restore: true })],
    ])('leaves it to %s', async (_, edit) => {
      const r = revPool([...three, [ENTRIES_SQL, [edit]]])
      expect(await store(r.pool).siteDeleted([MSG_2], POST)).toEqual({ plain: [] })
      expect(r.log.filter((l) => l.sql === NOTE_UPDATE).map((l) => l.params)).toEqual([['8', JSON.stringify([MSG_2])]])
      expect(r.sqls().filter((s) => s.startsWith('delete') || s.startsWith('insert'))).toEqual([])
    })

    it('adds the parts to what the edit had been told, once each', async () => {
      const r = revPool([...three, [ENTRIES_SQL, [editOf('8', { gone: [MSG_4, MSG_2] })]]])
      await store(r.pool).siteDeleted([MSG_2], POST)
      expect(r.log.find((l) => l.sql === NOTE_UPDATE).params).toEqual(['8', JSON.stringify([MSG_4, MSG_2])])
    })

    it('notes only the deleted parts that are still parts of the reply', async () => {
      const r = revPool([
        partsOf([
          { discord_id: MSG_2, message_id: MSG },
          { discord_id: MSG_3, message_id: MSG },
        ]),
        // MSG_3 stopped being a part while this waited (an earlier edit made the reply two parts).
        ['select discord_id, webhook_id from librarius_parts where message_id', [{ discord_id: MSG, webhook_id: HOOK }, { discord_id: MSG_2, webhook_id: HOOK }]],
        [ENTRIES_SQL, [editOf('8', {})]],
      ])
      await store(r.pool).siteDeleted([MSG_2, MSG_3], POST)
      expect(r.log.find((l) => l.sql === NOTE_UPDATE).params).toEqual(['8', JSON.stringify([MSG_2])])
    })

    it('leaves the reply to the edit though a delete is on its way too: the delete removes what is left, and the edit does what it does', async () => {
      const r = revPool([...three, [ENTRIES_SQL, [deleteOf('7', { postId: POST }), editOf('8', {})]]])
      expect(await store(r.pool).siteDeleted([MSG_2], POST)).toEqual({ plain: [] })
      expect(r.log.filter((l) => l.sql === NOTE_UPDATE).map((l) => l.params[0])).toEqual(['8'])
      expect(r.sqls().filter((s) => s.startsWith('delete') || s.startsWith('insert'))).toEqual([])
    })

    it('tells every edit on its way for the reply, and no delete', async () => {
      const r = revPool([...three, [ENTRIES_SQL, [editOf('6', {}), deleteOf('7', { postId: POST }), editOf('8', { gone: [MSG_3] })]]])
      await store(r.pool).siteDeleted([MSG_2], POST)
      expect(r.log.filter((l) => l.sql === NOTE_UPDATE).map((l) => l.params)).toEqual([
        ['6', JSON.stringify([MSG_2])],
        ['8', JSON.stringify([MSG_3, MSG_2])],
      ])
    })

    it('still takes another reply in the same call, which no edit is on its way for', async () => {
      const r = revPool([
        partsOf([
          { discord_id: MSG_2, message_id: MSG },
          { discord_id: MSG_4, message_id: MSG_3 },
        ]),
        ['select discord_id, webhook_id from librarius_parts where message_id', (p) => (p[0] === MSG ? [{ discord_id: MSG, webhook_id: HOOK }, { discord_id: MSG_2, webhook_id: HOOK }] : [{ discord_id: MSG_3, webhook_id: HOOK }, { discord_id: MSG_4, webhook_id: HOOK }])],
        ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
        [ENTRIES_SQL, [editOf('8', {})]],
      ])
      expect(await store(r.pool).siteDeleted([MSG_2, MSG_4], POST)).toEqual({ plain: [] })
      expect(r.log.filter((l) => l.sql === NOTE_UPDATE).map((l) => l.params)).toEqual([['8', JSON.stringify([MSG_2])]])
      expect(r.log.filter((l) => l.sql.startsWith('delete from librarius_messages')).map((l) => l.params[0])).toEqual([[MSG_3]])
      expect(r.log.filter((l) => l.sql.startsWith('insert into librarius_outbox')).map((l) => l.params[0])).toEqual([MSG_3])
      expect(r.log.filter((l) => l.sql.startsWith('insert into librarius_events')).map((l) => l.params[3])).toEqual([MSG_3])
    })

    it('does not leave a reply to an edit of another reply', async () => {
      const r = revPool([...three, [ENTRIES_SQL, [editOf('8', { progress: { parts: [{ id: MSG_4 }] } }, MSG_3)]]])
      expect(await store(r.pool).siteDeleted([MSG_2, MSG_4], POST)).toEqual({ plain: [MSG_4] })
      expect(r.log.filter((l) => l.sql === NOTE_UPDATE).map((l) => l.params)).toEqual([['8', JSON.stringify([MSG_4])]])
      expect(r.log.filter((l) => l.sql.startsWith('delete from librarius_messages')).map((l) => l.params[0])).toEqual([[MSG]])
    })

    it('tells an edit both what it sent that is gone and what of its reply is gone, the second note holding the first', async () => {
      const r = revPool([...three, [ENTRIES_SQL, [editOf('8', { progress: { parts: [{ id: MSG_4 }] } })]]])
      expect(await store(r.pool).siteDeleted([MSG_4, MSG_2], POST)).toEqual({ plain: [MSG_4] })
      expect(r.log.filter((l) => l.sql === NOTE_UPDATE).map((l) => l.params)).toEqual([
        ['8', JSON.stringify([MSG_4])],
        ['8', JSON.stringify([MSG_4, MSG_2])],
      ])
      expect(r.sqls().filter((s) => s.startsWith('delete') || s.startsWith('insert'))).toEqual([])
    })
  })

  describe('a part that no stored reply owns, which a reply or an edit on its way has sent', () => {
    const rows = (...list) => revPool([[ENTRIES_SQL, list]])

    it('notes it in that entry, beside what the entry had been told, once', async () => {
      const r = rows(
        { id: '5', kind: 'send', message_key: 'k5', payload: { postId: POST, progress: { parts: [{ id: MSG }, { id: MSG_2 }] }, gone: [MSG_4] } },
        { id: '6', kind: 'edit', message_key: MSG_3, payload: { postId: POST, progress: { parts: [{ id: MSG_2 }, { id: MSG_3 }] } } },
        { id: '7', kind: 'send', message_key: 'k7', payload: { postId: POST, progress: { parts: [{ id: MSG_2 }] }, gone: [MSG_2] } },
      )
      expect(await store(r.pool).siteDeleted([MSG_2, MSG_4], POST)).toEqual({ plain: [MSG_2, MSG_4] })
      expect(r.sqls()).toEqual(['begin', PARTS_SQL, ENTRIES_SQL, NOTE_UPDATE, NOTE_UPDATE, NOTE_UPDATE, 'commit'])
      expect(r.log[2].params).toEqual([[MSG_2, MSG_4], []])
      const writes = r.log.filter((l) => l.sql === NOTE_UPDATE).map((l) => l.params)
      expect(writes).toEqual([
        ['5', JSON.stringify([MSG_4, MSG_2])],
        ['6', JSON.stringify([MSG_2])],
        ['7', JSON.stringify([MSG_2])],
      ])
    })

    it('writes nothing for an entry the lock found that sent none of them', async () => {
      const r = rows({ id: '5', kind: 'send', message_key: 'k5', payload: { postId: POST, progress: { parts: [{ id: MSG_3 }] } } }, { id: '6', kind: 'delete', message_key: MSG_3, payload: { postId: POST } })
      expect(await store(r.pool).siteDeleted([MSG_2], POST)).toEqual({ plain: [MSG_2] })
      expect(r.sqls()).not.toContain(NOTE_UPDATE)
    })

    it('notes it before it takes a reply of the site, for the parts of that reply and of another', async () => {
      const r = revPool([...three, [ENTRIES_SQL, [{ id: '5', kind: 'send', message_key: 'k5', payload: { postId: POST, progress: { parts: [{ id: MSG_4 }] } } }]]])
      await store(r.pool).siteDeleted([MSG_2, MSG_4], POST)
      expect(r.sqls().slice(0, 5)).toEqual(['begin', PARTS_SQL, ENTRIES_SQL, NOTE_UPDATE, "select nextval('librarius_rev') as rev"])
    })

    it('writes no note when every id is a part of a stored reply that no edit is on its way for', async () => {
      const r = revPool([...three, [ENTRIES_SQL, []]])
      await store(r.pool).siteDeleted([MSG_2], POST)
      expect(r.log.find((l) => l.sql === ENTRIES_SQL).params[0]).toEqual([])
      expect(r.sqls()).not.toContain(NOTE_UPDATE)
    })
  })

  it('queues nothing when no part is left, as for a reply of one part', async () => {
    const r = revPool([
      partsOf([{ discord_id: MSG, message_id: MSG }]),
      ['select discord_id, webhook_id from librarius_parts where message_id', [{ discord_id: MSG, webhook_id: HOOK }]],
      ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
    ])
    expect(await store(r.pool).siteDeleted([MSG], POST)).toEqual({ plain: [] })
    expect(r.sqls().some((s) => s.startsWith('insert into librarius_outbox'))).toBe(false)
    expect(r.sqls()).toContain('delete from librarius_parts where message_id = $1')
  })

  it('names the webhook of the first part that has one, when the first has none', async () => {
    const r = revPool([
      partsOf([{ discord_id: MSG_2, message_id: MSG }]),
      ['select discord_id, webhook_id from librarius_parts where message_id', [{ discord_id: MSG, webhook_id: null }, { discord_id: MSG_2, webhook_id: HOOK }, { discord_id: MSG_3, webhook_id: '200000000000000416' }]],
      ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
      [ENTRIES_SQL, []],
    ])
    await store(r.pool).siteDeleted([MSG_2], POST)
    expect(r.log.find((l) => l.sql.startsWith('insert into librarius_outbox')).params[2]).toBe(JSON.stringify({ postId: POST, partIds: [MSG, MSG_3], webhookId: HOOK }))
  })

  it('names no webhook when no part has one', async () => {
    const r = revPool([
      partsOf([{ discord_id: MSG_2, message_id: MSG }]),
      ['select discord_id, webhook_id from librarius_parts where message_id', [{ discord_id: MSG, webhook_id: null }, { discord_id: MSG_2, webhook_id: null }]],
      ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
      [ENTRIES_SQL, []],
    ])
    await store(r.pool).siteDeleted([MSG_2], POST)
    expect(r.log.find((l) => l.sql.startsWith('insert into librarius_outbox')).params[2]).toBe(JSON.stringify({ postId: POST, partIds: [MSG], webhookId: null }))
  })

  it('takes each reply once when several of its parts, or several replies, are deleted together, with one rev', async () => {
    const r = revPool([
      partsOf([
        { discord_id: MSG, message_id: MSG },
        { discord_id: MSG_2, message_id: MSG },
        { discord_id: MSG_4, message_id: MSG_3 },
      ]),
      ['select discord_id, webhook_id from librarius_parts where message_id', (p) => (p[0] === MSG ? [{ discord_id: MSG, webhook_id: null }, { discord_id: MSG_2, webhook_id: null }] : [{ discord_id: MSG_3, webhook_id: HOOK }, { discord_id: MSG_4, webhook_id: HOOK }])],
      ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
      [ENTRIES_SQL, []],
    ])
    expect(await store(r.pool).siteDeleted([MSG, MSG_2, MSG_4], POST)).toEqual({ plain: [] })
    expect(r.log.find((l) => l.sql === ENTRIES_SQL).params).toEqual([[], [MSG, MSG_3]])
    expect(r.sqls().filter((s) => s.startsWith("select nextval"))).toHaveLength(1)
    expect(r.sqls().filter((s) => s.startsWith('delete from librarius_messages'))).toHaveLength(2)
    const queued = r.log.filter((l) => l.sql.startsWith('insert into librarius_outbox'))
    expect(queued).toHaveLength(1)
    expect(queued[0].params).toEqual([MSG_3, AUTHOR, JSON.stringify({ postId: POST, partIds: [MSG_3], webhookId: HOOK })])
    expect(r.log.filter((l) => l.sql.startsWith('insert into librarius_events')).map((l) => l.params[3])).toEqual([MSG, MSG_3])
  })

  it('still deletes the remaining parts of a reply whose message is no longer stored, with no author to name', async () => {
    const r = revPool([
      partsOf([{ discord_id: MSG_2, message_id: MSG }]),
      ['select discord_id, webhook_id from librarius_parts where message_id', [{ discord_id: MSG, webhook_id: HOOK }, { discord_id: MSG_2, webhook_id: HOOK }]],
      ['select post_id, author_id from librarius_messages', []],
      [ENTRIES_SQL, []],
    ])
    await store(r.pool).siteDeleted([MSG_2], POST)
    expect(r.log.find((l) => l.sql.startsWith('insert into librarius_outbox')).params).toEqual([MSG, '0', JSON.stringify({ postId: POST, partIds: [MSG], webhookId: HOOK })])
    expect(r.log.find((l) => l.sql.startsWith('insert into librarius_events')).params).toEqual(['0', 'deleted-in-discord', POST, MSG, null])
  })

  it('rolls back and throws what failed', async () => {
    const err = boom()
    const r = revPool([...three, ['insert into librarius_outbox', err], [ENTRIES_SQL, []]])
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

  // A world of up to three replies of the site, each of one to three parts, two ids no reply owns, and the entries on their way: for each reply
  // maybe an edit and maybe deletes, and maybe a reply being sent. The pool answers each statement as Postgres would from that world, and the
  // property checks what siteDeleted did against the rules: a reply an edit is on its way for is left to it, with the parts noted; any other
  // reply that was hit goes, with a delete of what is left queued unless a delete on its way knows its parts; and an entry that sent an id no
  // reply owns is told of it.
  it('does what the rules say for any world and any deletion (property)', async () => {
    const idOf = (reply, part) => `2000000000000004${5 + reply}${part}`
    const LOOSE = ['200000000000000480', '200000000000000481']
    const world = fc.record({
      sizes: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 3 }),
      edits: fc.array(fc.option(fc.record({ sent: fc.subarray(LOOSE), gone: fc.subarray([...LOOSE, idOf(0, 1)]) }), { nil: null }), { minLength: 3, maxLength: 3 }),
      deletes: fc.array(fc.array(fc.boolean(), { maxLength: 2 }), { minLength: 3, maxLength: 3 }),
      send: fc.subarray(LOOSE),
      pick: fc.array(fc.boolean(), { minLength: 11, maxLength: 11 }),
    })
    await fc.assert(
      fc.asyncProperty(world, async ({ sizes, edits, deletes, send, pick }) => {
        const replies = sizes.map((size, r) => Array.from({ length: size }, (_, k) => idOf(r, k)))
        const owner = new Map(replies.flatMap((parts) => parts.map((part) => [part, parts[0]])))
        const every = [...replies.flat(), ...LOOSE]
        const ids = every.filter((_, i) => pick[i])
        if (ids.length === 0) ids.push(every[0])
        let serial = 0
        const entries = []
        if (send.length > 0) entries.push({ id: String(++serial), kind: 'send', message_key: 'k', payload: { postId: POST, progress: { parts: send.map((id) => ({ id })) } } })
        replies.forEach((parts, r) => {
          for (const knows of deletes[r]) entries.push({ id: String(++serial), kind: 'delete', message_key: parts[0], payload: knows ? { postId: POST, partIds: parts } : { postId: POST } })
          const edit = edits[r]
          if (edit !== null) entries.push({ id: String(++serial), kind: 'edit', message_key: parts[0], payload: { postId: POST, gone: edit.gone, progress: { parts: edit.sent.map((id) => ({ id })) } } })
        })
        const sentOne = (e, plain) => (e.payload.progress?.parts ?? []).some((part) => plain.includes(part.id))
        const r = revPool([
          ['select discord_id, message_id', (p) => p[0].filter((id) => owner.has(id)).map((id) => ({ discord_id: id, message_id: owner.get(id) })).sort((a, b) => a.message_id.localeCompare(b.message_id))],
          [ENTRIES_SQL, (p) => entries.filter((e) => (e.kind !== 'delete' && sentOne(e, p[0])) || (e.kind !== 'send' && p[1].includes(e.message_key)))],
          ['select discord_id, webhook_id from librarius_parts where message_id', (p) => replies.find((parts) => parts[0] === p[0]).map((id) => ({ discord_id: id, webhook_id: HOOK }))],
          ['select post_id, author_id from librarius_messages', [{ post_id: POST, author_id: AUTHOR }]],
        ])

        const out = await store(r.pool).siteDeleted(ids, POST)

        // The model.
        const plain = ids.filter((id) => !owner.has(id))
        const gone = new Map(entries.map((e) => [e.id, [...e.payload.gone ?? []]]))
        const tell = (e, list) => gone.set(e.id, [...new Set([...gone.get(e.id), ...list])])
        for (const e of entries) if (e.kind !== 'delete') tell(e, (e.payload.progress?.parts ?? []).map((part) => part.id).filter((id) => plain.includes(id)))
        const taken = []
        const queued = []
        for (const parts of replies) {
          const hit = parts.filter((id) => ids.includes(id))
          if (hit.length === 0) continue
          const mine = entries.filter((e) => e.message_key === parts[0])
          const editing = mine.filter((e) => e.kind === 'edit')
          if (editing.length > 0) {
            for (const e of editing) tell(e, hit)
            continue
          }
          taken.push(parts[0])
          const left = parts.filter((id) => !ids.includes(id))
          if (left.length > 0 && !mine.some((e) => e.payload.partIds !== undefined)) queued.push([parts[0], left])
        }

        expect(out).toEqual({ plain })
        const written = new Map(entries.map((e) => [e.id, [...e.payload.gone ?? []]]))
        for (const { params } of r.log.filter((l) => l.sql === NOTE_UPDATE)) written.set(params[0], JSON.parse(params[1]))
        expect(written).toEqual(gone)
        expect(r.log.filter((l) => l.sql.startsWith('delete from librarius_messages')).map((l) => l.params[0][0])).toEqual(taken)
        expect(r.log.filter((l) => l.sql.startsWith('insert into librarius_outbox')).map((l) => [l.params[0], JSON.parse(l.params[2]).partIds])).toEqual(queued)
        expect(r.log.filter((l) => l.sql.startsWith('insert into librarius_events')).map((l) => l.params[3])).toEqual(taken)
        // Every entry is locked in the one statement, before any message is read or written.
        const sqls = r.sqls()
        expect(sqls.filter((s) => s === ENTRIES_SQL)).toHaveLength(1)
        const firstMessage = sqls.findIndex((s) => s.includes('librarius_messages'))
        if (firstMessage !== -1) expect(sqls.indexOf(ENTRIES_SQL)).toBeLessThan(firstMessage)
      }),
      { numRuns: 300 },
    )
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
  const CAP = 104_857_600
  const GOOD = { authorId: AUTHOR, name: 'picture.png', contentType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]), maxHeldBytes: CAP }
  // One member's pictures one at a time (the two numbers are a family of locks of its own and the member's id as a number Postgres hashes),
  // so that pictures sent together cannot each find room that another is taking: a statement sees the rows committed when it began.
  const LOCK_SQL = 'select pg_advisory_xact_lock(19000003, hashtext($1::text))'
  const HOLD_SQL =
    'insert into librarius_uploads (author_id, name, content_type, bytes) select $1::bigint, $2::text, $3::text, $4::bytea where coalesce((select sum(octet_length(bytes)) from librarius_uploads where author_id = $1::bigint), 0) + octet_length($4::bytea) <= $5::bigint returning id'

  it('holds the picture for its author, only if the author would then hold at most the cap, and answers the id the table gave it, in one transaction that takes the author\'s lock first', async () => {
    const { pool, log, release } = fakePool([['insert into librarius_uploads', [{ id: '41' }]]])
    expect(await store(pool).addUpload(GOOD)).toEqual({ id: '41' })
    expect(log.map((l) => l.sql)).toEqual(['begin', LOCK_SQL, HOLD_SQL, 'commit'])
    expect(log[1].params).toEqual([AUTHOR])
    expect(log[2].params).toHaveLength(5)
    expect(log[2].params.slice(0, 3)).toEqual([AUTHOR, 'picture.png', 'image/png'])
    // pg takes bytea as a Buffer: the same bytes, in one.
    expect(Buffer.isBuffer(log[2].params[3])).toBe(true)
    expect([...log[2].params[3]]).toEqual([137, 80, 78, 71])
    expect(log[2].params[4]).toBe(CAP)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('answers null, and holds nothing, when the table gave no row: the author would hold more than the cap', async () => {
    const { pool } = fakePool([['insert into librarius_uploads', []]])
    expect(await store(pool).addUpload(GOOD)).toBeNull()
  })

  it('sends the cap it was given, whole', async () => {
    for (const maxHeldBytes of [1, 4, 10_485_760, 9_007_199_254_740_991]) {
      const { pool, log } = fakePool([['insert into librarius_uploads', [{ id: '1' }]]])
      await store(pool).addUpload({ ...GOOD, maxHeldBytes })
      expect(log[2].params[4]).toBe(maxHeldBytes)
    }
  })

  it('sends the bytes of a view of a bigger buffer, and only those', async () => {
    const { pool, log } = fakePool([['insert into librarius_uploads', [{ id: '41' }]]])
    const whole = new Uint8Array([9, 9, 1, 2, 3, 9])
    await store(pool).addUpload({ ...GOOD, bytes: whole.subarray(2, 5) })
    expect([...log[2].params[3]]).toEqual([1, 2, 3])
  })

  it('takes a name of exactly 1 character and of exactly 100, and no other length', async () => {
    for (const name of ['p', 'p'.repeat(100)]) {
      const { pool, log } = fakePool([['insert into librarius_uploads', [{ id: '1' }]]])
      await store(pool).addUpload({ ...GOOD, name })
      expect(log[2].params[1]).toBe(name)
    }
  })

  it('takes each of the four types of picture', async () => {
    for (const contentType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      const { pool, log } = fakePool([['insert into librarius_uploads', [{ id: '1' }]]])
      await store(pool).addUpload({ ...GOOD, contentType })
      expect(log[2].params[2]).toBe(contentType)
    }
  })

  it.each([
    ...labelled(BAD_IDS).map(([name, v]) => [`authorId ${name}`, { ...GOOD, authorId: v }, ID_MSG('authorId')]),
    ...labelled([undefined, null, '', 7, {}, ['picture.png'], 'x'.repeat(101)]).map(([name, v]) => [`name ${name}`, { ...GOOD, name: v }, 'name must be a text of 1 to 100 characters']),
    ...labelled(['image/svg+xml', 'IMAGE/PNG', 'image/png ', 'text/html', '', undefined, null, 7, {}]).map(([name, v]) => [`contentType ${name}`, { ...GOOD, contentType: v }, 'contentType must be image/png, image/jpeg, image/webp or image/gif']),
    ...labelled([undefined, null, '', 'bytes', [1, 2, 3], new ArrayBuffer(4), new Uint8Array(0), Buffer.alloc(0), {}, 7]).map(([name, v]) => [`bytes ${name}`, { ...GOOD, bytes: v }, 'bytes must be a Uint8Array of at least one byte']),
    ...labelled([undefined, null, '', '100', 0, -1, 1.5, Number.NaN, Infinity, 2 ** 53, {}, [1], true]).map(([name, v]) => [`maxHeldBytes ${name}`, { ...GOOD, maxHeldBytes: v }, 'maxHeldBytes must be a whole number of bytes, at least 1']),
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
    expect([...log[2].params[3]]).toEqual([1, 2])
  })

  it('lets a failure of the table through, naming nothing it was given, after a rollback that releases the client', async () => {
    const { pool, sqls, release } = fakePool([['insert into librarius_uploads', new Error('the table is gone')]])
    await expect(store(pool).addUpload(GOOD)).rejects.toThrow('the table is gone')
    expect(sqls()).toEqual(['begin', LOCK_SQL, HOLD_SQL, 'rollback'])
    expect(release).toHaveBeenCalledTimes(1)
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

describe('outboxSet: what the worker holds', () => {
  const entry = [['update librarius_outbox', [{ kind: 'send', message_key: MSG, author_id: AUTHOR }]]]
  const HOLD_SQL =
    "insert into librarius_outbox_state (id, paused_until, global_until) values (1, $1::timestamptz, $2::timestamptz) on conflict (id) do update set paused_until = greatest(librarius_outbox_state.paused_until, excluded.paused_until), global_until = greatest(librarius_outbox_state.global_until, excluded.global_until)"
  const UNTIL = '2026-11-18T11:00:00.000Z'
  const LATER = '2026-11-18T10:00:30.000Z'

  it('writes the pause and the global hold in the transaction of the transition, after the event and the queue', async () => {
    const { pool, log } = fakePool([...entry, ['insert into librarius_outbox', [{ id: '31' }]]])
    await store(pool).outboxSet('12', {
      state: 'blocked',
      event: { action: 'blocked' },
      queue: [{ kind: 'delete', messageKey: MSG, payload: { postId: POST } }],
      hold: { pausedUntil: UNTIL, globalUntil: LATER },
    })
    expect(log.map((l) => l.sql)).toEqual(['begin', has('update librarius_outbox'), has('insert into librarius_events'), has('insert into librarius_outbox'), has("update librarius_messages set state = 'sending'"), HOLD_SQL, 'commit'])
    expect(log[5].params).toEqual([UNTIL, LATER])
  })

  it('writes one of the two, and leaves the other null so that greatest() keeps what is held', async () => {
    const paused = fakePool(entry)
    await store(paused.pool).outboxSet('12', { state: 'blocked', hold: { pausedUntil: UNTIL } })
    expect(paused.log[2].params).toEqual([UNTIL, null])
    const global = fakePool(entry)
    await store(global.pool).outboxSet('12', { state: 'pending', hold: { globalUntil: new Date(LATER) } })
    expect(global.log[2].params).toEqual([null, LATER])
    const ms = fakePool(entry)
    await store(ms.pool).outboxSet('12', { state: 'pending', hold: { globalUntil: Date.parse(LATER) } })
    expect(ms.log[2].params).toEqual([null, LATER])
  })

  it('writes no hold when it is given none, and none for an entry that is not sending any more', async () => {
    const none = fakePool(entry)
    await store(none.pool).outboxSet('12', { state: 'sent' })
    expect(none.sqls()).toEqual(['begin', has('update librarius_outbox'), 'commit'])
    const gone = fakePool()
    await store(gone.pool).outboxSet('12', { state: 'blocked', hold: { pausedUntil: UNTIL } })
    expect(gone.sqls()).toEqual(['begin', has('update librarius_outbox'), 'commit'])
  })

  it('rolls back the transition when the hold cannot be written', async () => {
    const err = boom()
    const { pool, sqls } = fakePool([...entry, ['insert into librarius_outbox_state', err]])
    await expect(store(pool).outboxSet('12', { state: 'blocked', hold: { pausedUntil: UNTIL } })).rejects.toBe(err)
    expect(sqls().at(-1)).toBe('rollback')
  })

  it.each([
    ...labelled([null, 'x', 7, [], true]).map(([name, hold]) => [`a hold that is ${name}`, hold, OBJECT_MSG('hold')]),
    ['a hold that says nothing', {}, 'hold must say pausedUntil or globalUntil'],
    ['a hold that says undefined', { pausedUntil: undefined, globalUntil: undefined }, 'hold must say pausedUntil or globalUntil'],
    ['a hold with another key', { pausedUntil: UNTIL, until: UNTIL }, 'hold has no until'],
    ...labelled(['soon', {}, null, Number.NaN, new Date('x'), true]).map(([name, v]) => [`a pausedUntil ${name}`, { pausedUntil: v }, TIME_MSG('pausedUntil')]),
    ...labelled(['soon', {}, null, Number.NaN, new Date('x'), true]).map(([name, v]) => [`a globalUntil ${name}`, { pausedUntil: UNTIL, globalUntil: v }, TIME_MSG('globalUntil')]),
  ])('refuses %s before any query', async (_, hold, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).outboxSet('12', { state: 'blocked', hold }), message)
  })
})

describe('outboxHold', () => {
  it('answers the two times as ISO text', async () => {
    const { pool, log } = fakePool([['from librarius_outbox_state', [{ paused_until: new Date('2026-11-18T11:00:00.000Z'), global_until: '2026-11-18T10:00:30.000Z' }]]])
    expect(await store(pool).outboxHold()).toEqual({ pausedUntil: '2026-11-18T11:00:00.000Z', globalUntil: '2026-11-18T10:00:30.000Z' })
    expect(log).toHaveLength(1)
    expect(log[0].sql).toBe('select paused_until, global_until from librarius_outbox_state where id = 1')
  })

  it('answers null for a time that was never set, and for both when there is no row', async () => {
    const one = fakePool([['from librarius_outbox_state', [{ paused_until: null, global_until: new Date('2026-11-18T10:00:30.000Z') }]]])
    expect(await store(one.pool).outboxHold()).toEqual({ pausedUntil: null, globalUntil: '2026-11-18T10:00:30.000Z' })
    const other = fakePool([['from librarius_outbox_state', [{ paused_until: new Date('2026-11-18T11:00:00.000Z'), global_until: null }]]])
    expect(await store(other.pool).outboxHold()).toEqual({ pausedUntil: '2026-11-18T11:00:00.000Z', globalUntil: null })
    expect(await store(fakePool().pool).outboxHold()).toEqual({ pausedUntil: null, globalUntil: null })
  })
})

describe('noteBlock', () => {
  const EVENT_SQL = 'insert into librarius_events (actor_id, action, post_id, message_id, note) values ($1, $2, $3, $4, $5)'
  const entry = [["from librarius_outbox where id = $1 and state = 'sending'", [{ author_id: AUTHOR }]]]
  const HOLD = { pausedUntil: '2026-11-18T11:00:00.000Z' }

  it('notes the block by the author of the entry that is at work, and the pause it caused, in one transaction', async () => {
    const { pool, log } = fakePool(entry)
    await store(pool).noteBlock('12', { event: { action: 'blocked', postId: POST, messageId: MSG, note: 'links' }, hold: HOLD })
    expect(log.map((l) => l.sql)).toEqual(['begin', "select author_id from librarius_outbox where id = $1 and state = 'sending'", EVENT_SQL, has('insert into librarius_outbox_state'), 'commit'])
    expect(log[1].params).toEqual(['12'])
    expect(log[2].params).toEqual([AUTHOR, 'blocked', POST, MSG, 'links'])
    expect(log[3].params).toEqual(['2026-11-18T11:00:00.000Z', null])
  })

  it('writes no pause when it caused none', async () => {
    const { pool, sqls } = fakePool(entry)
    await store(pool).noteBlock('12', { event: { action: 'blocked' } })
    expect(sqls()).toEqual(['begin', has('select author_id'), EVENT_SQL, 'commit'])
  })

  it('writes nothing for an entry that is not at work any more', async () => {
    const { pool, sqls } = fakePool()
    await store(pool).noteBlock('12', { event: { action: 'blocked' }, hold: HOLD })
    expect(sqls()).toEqual(['begin', has('select author_id'), 'commit'])
  })

  it('rolls back and throws what failed', async () => {
    const err = boom()
    const { pool, sqls } = fakePool([...entry, ['insert into librarius_events', err]])
    await expect(store(pool).noteBlock('12', { event: { action: 'blocked' } })).rejects.toBe(err)
    expect(sqls().at(-1)).toBe('rollback')
  })

  it.each([
    ...labelled(BAD_SERIALS).map(([name, id]) => [`id ${name}`, id, { event: { action: 'blocked' } }, SERIAL_MSG('id')]),
    ['no options', '1', undefined, 'event must be an object'],
    ['no event', '1', {}, 'event must be an object'],
    ['an event with no action', '1', { event: {} }, 'action must be a text of 1 to 40 characters'],
    ['a hold that says nothing', '1', { event: { action: 'blocked' }, hold: {} }, 'hold must say pausedUntil or globalUntil'],
    ['a hold that is null', '1', { event: { action: 'blocked' }, hold: null }, OBJECT_MSG('hold')],
  ])('refuses %s before any query', async (_, id, options, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).noteBlock(id, options), message)
  })
})

describe('sendTimesSince', () => {
  it('answers the times at which parts landed since then, oldest first, as ISO text, from the progress of the entries', async () => {
    const { pool, log } = fakePool([['from librarius_outbox o', [{ at: new Date('2026-11-18T10:00:00.000Z') }, { at: '2026-11-18T10:00:30.500Z' }]]])
    expect(await store(pool).sendTimesSince(new Date('2026-11-18T09:59:00.000Z'))).toEqual(['2026-11-18T10:00:00.000Z', '2026-11-18T10:00:30.500Z'])
    expect(log).toHaveLength(1)
    expect(log[0].sql).toBe(
      "select at from ( select case when part->>'id' ~ '^[0-9]{17,19}$' then to_timestamp((((part->>'id')::bigint >> 22) + 1420070400000) / 1000.0) end as at from librarius_outbox o, jsonb_array_elements(coalesce(o.payload->'progress'->'parts', '[]'::jsonb)) as part where o.kind in ('send', 'edit') ) landed where at >= $1::timestamptz order by at",
    )
    expect(log[0].params).toEqual(['2026-11-18T09:59:00.000Z'])
  })

  it('answers an empty list when nothing landed, and takes the time as epoch milliseconds', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).sendTimesSince(Date.parse('2026-11-18T09:59:00.000Z'))).toEqual([])
    expect(log[0].params).toEqual(['2026-11-18T09:59:00.000Z'])
  })

  it.each(labelled([undefined, null, 'soon', {}, Number.NaN]))('refuses the time %s before any query', async (_, since) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).sendTimesSince(since), TIME_MSG('since'))
  })
})

describe('the worker lock', () => {
  /** A pool whose connections are kept, to see which one holds the lock and whether it went back. */
  function lockPool(answers) {
    const clients = []
    const pool = {
      query: async () => ({ rows: [] }),
      async connect() {
        const handlers = {}
        const client = {
          queries: [],
          released: 0,
          // What each release was given: nothing gives the connection back, an error drops it from the pool.
          releases: [],
          handlers,
          async query(sql, params) {
            client.queries.push({ sql, params })
            const next = answers.shift()
            if (next instanceof Error) throw next
            return { rows: [next ?? {}] }
          },
          release(...args) {
            client.released++
            client.releases.push(args)
          },
          on(event, fn) {
            handlers[event] = fn
          },
        }
        clients.push(client)
        return client
      },
    }
    return { pool, clients }
  }

  it('takes the advisory lock on a connection of its own, and keeps that connection out of the pool', async () => {
    const { pool, clients } = lockPool([{ got: true }])
    expect(await store(pool).takeWorkerLock()).toBe(true)
    expect(clients).toHaveLength(1)
    expect(clients[0].queries).toEqual([{ sql: 'select pg_try_advisory_lock($1::bigint) as got', params: [19_000_001] }])
    expect(clients[0].released).toBe(0)
  })

  it('answers true again for the lock it holds, without a new connection or a new ask', async () => {
    const { pool, clients } = lockPool([{ got: true }])
    const s = store(pool)
    await s.takeWorkerLock()
    expect(await s.takeWorkerLock()).toBe(true)
    expect(clients).toHaveLength(1)
    expect(clients[0].queries).toHaveLength(1)
  })

  it('answers false when another worker holds it, and gives the connection back, and asks again the next time', async () => {
    const { pool, clients } = lockPool([{ got: false }, { got: false }])
    const s = store(pool)
    expect(await s.takeWorkerLock()).toBe(false)
    expect(clients[0].released).toBe(1)
    expect(await s.takeWorkerLock()).toBe(false)
    expect(clients).toHaveLength(2)
    expect(clients[1].released).toBe(1)
  })

  it.each([undefined, 't', 1, null])('does not take %s for the lock', async (got) => {
    const { pool, clients } = lockPool([{ got }])
    expect(await store(pool).takeWorkerLock()).toBe(false)
    expect(clients[0].released).toBe(1)
  })

  it('gives the connection back and throws what failed when the ask fails, and tries again from scratch next time', async () => {
    const err = boom()
    const { pool, clients } = lockPool([err, { got: true }])
    const s = store(pool)
    await expect(s.takeWorkerLock()).rejects.toBe(err)
    expect(clients[0].released).toBe(1)
    expect(await s.takeWorkerLock()).toBe(true)
    expect(clients).toHaveLength(2)
  })

  it('lets the lock go: asks to unlock on the same connection and gives it back, and takes it again after', async () => {
    const { pool, clients } = lockPool([{ got: true }, {}, { got: true }])
    const s = store(pool)
    await s.takeWorkerLock()
    await s.releaseWorkerLock()
    expect(clients[0].queries[1]).toEqual({ sql: 'select pg_advisory_unlock($1::bigint)', params: [19_000_001] })
    expect(clients[0].released).toBe(1)
    expect(await s.takeWorkerLock()).toBe(true)
    expect(clients).toHaveLength(2)
  })

  it('drops the connection from the pool when the unlock fails, since it may hold the lock still, and holds no lock after', async () => {
    const err = boom()
    const { pool, clients } = lockPool([{ got: true }, err, { got: true }])
    const s = store(pool)
    await s.takeWorkerLock()
    await expect(s.releaseWorkerLock()).rejects.toBe(err)
    expect(clients[0].releases).toEqual([[err]])
    expect(s.holdsWorkerLock()).toBe(false)
    expect(await s.takeWorkerLock()).toBe(true)
    expect(clients).toHaveLength(2)
  })

  it('gives the connection back to the pool, with no error, when the unlock works', async () => {
    const { pool, clients } = lockPool([{ got: true }, {}])
    const s = store(pool)
    await s.takeWorkerLock()
    await s.releaseWorkerLock()
    expect(clients[0].releases).toEqual([[undefined]])
  })

  it('does nothing to release a lock it does not hold', async () => {
    const { pool, clients } = lockPool([])
    await store(pool).releaseWorkerLock()
    expect(clients).toHaveLength(0)
  })

  it('takes a lost connection for a lost lock, without throwing, so that the next take asks again', async () => {
    const { pool, clients } = lockPool([{ got: true }, { got: true }])
    const s = store(pool)
    await s.takeWorkerLock()
    expect(() => clients[0].handlers.error(new Error('Connection terminated unexpectedly'))).not.toThrow()
    expect(await s.takeWorkerLock()).toBe(true)
    expect(clients).toHaveLength(2)
  })

  it('lets a lock that is not the held connection go on: an error of an old connection does not drop the new one', async () => {
    const { pool, clients } = lockPool([{ got: true }, {}, { got: true }])
    const s = store(pool)
    await s.takeWorkerLock()
    await s.releaseWorkerLock()
    await s.takeWorkerLock()
    clients[0].handlers.error(new Error('late'))
    clients[0].handlers.end()
    expect(s.holdsWorkerLock()).toBe(true)
    expect(clients[0].releases).toEqual([[undefined]])
    expect(clients[1].released).toBe(0)
    expect(await s.takeWorkerLock()).toBe(true)
    expect(clients).toHaveLength(2)
  })

  it('works with a connection that has no event emitter, as a fake pool gives', async () => {
    const { pool } = fakePool([['pg_try_advisory_lock', [{ got: true }]]])
    const s = store(pool)
    expect(await s.takeWorkerLock()).toBe(true)
    expect(s.holdsWorkerLock()).toBe(true)
  })

  describe('holdsWorkerLock', () => {
    it('says no before the lock is taken, yes once it is, and no once it is let go, at once and with no question to the database', async () => {
      const { pool, clients } = lockPool([{ got: true }, {}])
      const s = store(pool)
      expect(s.holdsWorkerLock()).toBe(false)
      await s.takeWorkerLock()
      expect(s.holdsWorkerLock()).toBe(true)
      expect(clients[0].queries).toHaveLength(1)
      await s.releaseWorkerLock()
      expect(s.holdsWorkerLock()).toBe(false)
    })

    it('says no while another worker holds it', async () => {
      const { pool } = lockPool([{ got: false }])
      const s = store(pool)
      await s.takeWorkerLock()
      expect(s.holdsWorkerLock()).toBe(false)
    })

    it('says no when the ask failed', async () => {
      const { pool } = lockPool([boom()])
      const s = store(pool)
      await s.takeWorkerLock().catch(() => {})
      expect(s.holdsWorkerLock()).toBe(false)
    })

    it('says no once the connection that holds the lock fails, and drops that connection from the pool with the error, once, however often it fails or ends after', async () => {
      const { pool, clients } = lockPool([{ got: true }, { got: true }])
      const s = store(pool)
      await s.takeWorkerLock()
      const err = new Error('terminating connection due to administrator command')
      clients[0].handlers.error(err)
      expect(s.holdsWorkerLock()).toBe(false)
      clients[0].handlers.error(new Error('Connection terminated unexpectedly'))
      clients[0].handlers.end()
      expect(clients[0].releases).toEqual([[err]])
      expect(await s.takeWorkerLock()).toBe(true)
      expect(s.holdsWorkerLock()).toBe(true)
      expect(clients).toHaveLength(2)
    })

    it('says no once the connection ends with no error first, and drops it from the pool as broken', async () => {
      const { pool, clients } = lockPool([{ got: true }])
      const s = store(pool)
      await s.takeWorkerLock()
      clients[0].handlers.end()
      expect(s.holdsWorkerLock()).toBe(false)
      expect(clients[0].releases).toHaveLength(1)
      const [[given]] = clients[0].releases
      expect(given).toBeInstanceOf(Error)
      expect(given.message).toBe('the connection that held the outbox lock ended')
      clients[0].handlers.error(new Error('late'))
      expect(clients[0].releases).toHaveLength(1)
    })

    it('needs no unlock after a lost connection: letting go then asks nothing and releases nothing', async () => {
      const { pool, clients } = lockPool([{ got: true }])
      const s = store(pool)
      await s.takeWorkerLock()
      clients[0].handlers.error(boom())
      await s.releaseWorkerLock()
      expect(clients[0].queries).toHaveLength(1)
      expect(clients[0].released).toBe(1)
    })

    it('releases a connection that fails while it is being let go once, with the error of the unlock', async () => {
      const err = boom()
      const { pool, clients } = lockPool([{ got: true }, err])
      const s = store(pool)
      await s.takeWorkerLock()
      const letting = s.releaseWorkerLock()
      // The connection fails while the unlock is asked: the unlock's own error decides, and the connection is released once.
      clients[0].handlers.error(err)
      await expect(letting).rejects.toBe(err)
      expect(clients[0].releases).toEqual([[err]])
    })
  })

  it('has a key that no other advisory lock of the server takes, in the same space as the Deathwatch lock', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const dir = new URL('./', import.meta.url)
    const keys = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.js') || file.endsWith('.test.js')) continue
      const text = readFileSync(new URL(file, dir), 'utf8')
      if (!/pg_(try_)?advisory/.test(text)) continue
      for (const m of text.matchAll(/const [A-Z_]*LOCK = ([\d_]+)/g)) keys.push([file, Number(m[1].replaceAll('_', ''))])
    }
    expect(keys.sort(([a, x], [b, y]) => a.localeCompare(b) || x - y)).toEqual([
      ['deathwatchStore.js', 18_000_002],
      ['librariusOutboxStore.js', 19_000_001],
      ['librariusOutboxStore.js', 19_000_003],
    ])
    expect(new Set(keys.map(([, key]) => key)).size).toBe(keys.length)
  })

  it('finds every key of the server among those constants: no advisory lock takes a number written into its statement', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const dir = new URL('./', import.meta.url)
    const literal = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.js') || file.endsWith('.test.js')) continue
      const text = readFileSync(new URL(file, dir), 'utf8')
      for (const m of text.matchAll(/pg_\w*advisory\w*\(\s*\d/g)) literal.push([file, m[0]])
    }
    expect(literal).toEqual([])
  })
})

describe('pruneOutbox', () => {
  const SENT_SQL = "with gone as (delete from librarius_outbox where state = 'sent' and created_at < $1::timestamptz returning 1) select count(*)::int as n from gone"
  const A = '2026-11-17T10:00:00.000Z'

  it('deletes the entries that are done and older than the time, in one statement, and says how many', async () => {
    const { pool, log } = fakePool([['from librarius_outbox', [{ n: 3 }]]])
    expect(await store(pool).pruneOutbox({ sentBefore: new Date(A) })).toEqual({ entries: 3 })
    expect(log.map((l) => l.sql)).toEqual([SENT_SQL])
    expect(log[0].params).toEqual([A])
  })

  it('takes the time as ISO text or epoch milliseconds too', async () => {
    for (const sentBefore of [A, Date.parse(A)]) {
      const { pool, log } = fakePool([['from librarius_outbox', [{ n: 0 }]]])
      await store(pool).pruneOutbox({ sentBefore })
      expect(log[0].params).toEqual([A])
    }
  })

  it('deletes only entries that are sent: an entry that failed, was blocked or is still on its way stays', async () => {
    const { pool, log } = fakePool([['from librarius_outbox', [{ n: 0 }]]])
    await store(pool).pruneOutbox({ sentBefore: A })
    expect(log[0].sql).toContain("state = 'sent'")
    expect(log[0].sql).not.toMatch(/failed|blocked|pending|sending/)
  })

  it('never deletes an event: the events are the Librarians\' record, kept with no end', async () => {
    const { pool, sqls } = fakePool([['from librarius_outbox', [{ n: 0 }]]])
    await store(pool).pruneOutbox({ sentBefore: A })
    expect(sqls().some((q) => q.includes('librarius_events'))).toBe(false)
  })

  it.each([
    ...labelled([undefined, null, 'x', 7, []]).map(([name, o]) => [`options ${name}`, o, OBJECT_MSG('options')]),
    ...labelled([undefined, null, 'soon', {}, Number.NaN]).map(([name, v]) => [`sentBefore ${name}`, { sentBefore: v }, TIME_MSG('sentBefore')]),
    // A caller that still asks for the events to be pruned is told, rather than left to think they were.
    ['a time for the events', { sentBefore: A, eventsBefore: A }, 'options takes sentBefore only (the events are never pruned), not eventsBefore'],
    ['anything else', { sentBefore: A, before: A }, 'options takes sentBefore only (the events are never pruned), not before'],
  ])('refuses %s before any query', async (_, options, message) => {
    const rig = fakePool()
    await refused(rig, () => store(rig.pool).pruneOutbox(options), message)
  })

  it('throws what failed', async () => {
    const err = boom()
    const { pool, log } = fakePool([['from librarius_outbox', err]])
    await expect(store(pool).pruneOutbox({ sentBefore: A })).rejects.toBe(err)
    expect(log).toHaveLength(1)
  })
})

describe('ownWebhookIds', () => {
  it('answers the webhooks that sent a stored part, or are sending a reply, as a Set', async () => {
    const { pool, log } = fakePool([['from librarius_parts', [{ id: HOOK }, { id: '200000000000000416' }]]])
    expect(await store(pool).ownWebhookIds()).toEqual(new Set([HOOK, '200000000000000416']))
    expect(log).toHaveLength(1)
    expect(log[0].sql).toBe(
      "select webhook_id as id from librarius_parts where webhook_id is not null union select (payload->'progress'->>'webhookid')::bigint from librarius_outbox where payload->'progress'->>'webhookid' ~ '^[0-9]{17,19}$'",
    )
  })

  it('answers an empty Set when there is none', async () => {
    expect(await store(fakePool().pool).ownWebhookIds()).toEqual(new Set())
  })
})

describe('repairSiteMessages', () => {
  const PARTS_FIX = 'update librarius_parts p set webhook_id = m.webhook_id from librarius_messages m where m.id = p.message_id and p.webhook_id is null and m.webhook_id is not null'
  const PHANTOMS = 'select m.id from librarius_messages m join librarius_parts p on p.discord_id = m.id where p.part_index > 0 order by m.id'
  const rig = (phantoms = [], damaged = []) => revPool([[PHANTOMS, phantoms], ['select i.id from intended', damaged]])

  it('writes nothing, and takes no rev, when nothing is damaged: a second run changes nothing', async () => {
    const r = rig()
    expect(await store(r.pool).repairSiteMessages()).toEqual({ removed: 0, restored: 0 })
    expect(r.sqls()).toEqual(['begin', PARTS_FIX, PHANTOMS, has('select i.id from intended'), 'commit'])
  })

  it('deletes the messages that are a part after the first, noted for the readers, with one new rev', async () => {
    const r = rig([{ id: MSG_2 }, { id: MSG_3 }])
    expect(await store(r.pool).repairSiteMessages()).toEqual({ removed: 2, restored: 0 })
    expect(r.sqls()).toEqual([
      'begin',
      PARTS_FIX,
      PHANTOMS,
      has('select i.id from intended'),
      "select nextval('librarius_rev') as rev",
      'insert into librarius_tombstones (message_id, post_id, rev) select id, post_id, $2::bigint from librarius_messages where id = any($1::bigint[])',
      'delete from librarius_messages where id = any($1::bigint[])',
      'commit',
    ])
    expect(r.log[5].params).toEqual([[MSG_2, MSG_3], '900'])
    expect(r.log[6].params).toEqual([[MSG_2, MSG_3]])
  })

  it('writes the damaged site messages again, in one statement, with the rev', async () => {
    const r = rig([], [{ id: MSG }, { id: MSG_4 }])
    expect(await store(r.pool).repairSiteMessages()).toEqual({ removed: 0, restored: 2 })
    expect(r.sqls()).toEqual(['begin', PARTS_FIX, PHANTOMS, has('select i.id from intended'), "select nextval('librarius_rev') as rev", has('update librarius_messages m set author_id = i.author_id'), 'commit'])
    expect(r.log[5].params).toEqual(['900', [MSG, MSG_4]])
  })

  it('does both with ONE rev, the phantoms first', async () => {
    const r = rig([{ id: MSG_2 }], [{ id: MSG }])
    expect(await store(r.pool).repairSiteMessages()).toEqual({ removed: 1, restored: 1 })
    expect(r.sqls().filter((q) => q.startsWith('select nextval'))).toHaveLength(1)
    const order = r.sqls().map((q) => (q.startsWith('delete from librarius_messages') ? 'phantoms' : q.includes('update librarius_messages m set') ? 'restore' : null)).filter(Boolean)
    expect(order).toEqual(['phantoms', 'restore'])
    expect(r.log.find((l) => l.sql.includes('update librarius_messages m set')).params).toEqual(['900', [MSG]])
  })

  describe('what a site message is made again from', () => {
    const sql = async () => {
      const r = rig([], [{ id: MSG }])
      await store(r.pool).repairSiteMessages()
      return r.log.find((l) => l.sql.includes('update librarius_messages m set')).sql
    }
    const find = async () => {
      const r = rig()
      await store(r.pool).repairSiteMessages()
      return r.log.find((l) => l.sql.startsWith('with sent as')).sql
    }

    it('takes the author the layout names first, then the author of the entry that sent the message (its first part), then the one of the event noted when it was sent', async () => {
      for (const text of [await sql(), await find()]) {
        // (the rig lowercases the statement)
        expect(text).toContain("coalesce(case when m.layout->>'authorid' ~ '^[0-9]{17,19}$' then (m.layout->>'authorid')::bigint end, s.author_id, m.author_id) as author_id")
        expect(text).toContain("o.payload->'progress'->'parts'->0->>'id' ~ '^[0-9]{17,19}$'")
        expect(text).toContain("from librarius_outbox o where o.kind = 'send'")
        expect(text).toContain("from librarius_events e where e.action = 'send' and e.message_id is not null")
        expect(text).toContain('order by mid, rank, at desc')
      }
    })

    it('takes the name, the picture, the reply link and the text from the layout and the source, cut to 4000 characters', async () => {
      const text = await sql()
      expect(text).toContain("coalesce(m.layout->>'username', m.author_name) as author_name")
      // (the rig lowercases the statement)
      expect(text).toContain("case when m.layout->'avatarurl' is not null then m.layout->>'avatarurl' else m.author_avatar end as author_avatar")
      expect(text).toContain('left(m.source, 4000) as content')
      expect(text).toContain("case when m.layout->'replyto' is not null then (m.layout->'replyto'->>'messageid')::bigint else m.reply_to end as reply_to")
    })

    it('looks only at messages of the site that have their source and layout, and only at those that differ', async () => {
      const text = await find()
      expect(text).toContain("where m.origin = 'site' and m.source is not null and m.layout is not null")
      expect(text).toContain('(m.author_id, m.author_name, m.author_avatar, m.content, m.reply_to) is distinct from (i.author_id, i.author_name, i.author_avatar, i.content, i.reply_to)')
    })

    it('writes only the columns the import overwrote, for the messages found', async () => {
      const text = await sql()
      expect(text).toContain('update librarius_messages m set author_id = i.author_id, author_name = i.author_name, author_avatar = i.author_avatar, content = i.content, reply_to = i.reply_to, rev = $1::bigint from intended i where m.id = i.id and m.id = any($2::bigint[])')
    })
  })

  it.each([
    ['the webhook of the parts', 'update librarius_parts'],
    ['the phantoms', 'select m.id from librarius_messages m join'],
    ['the damaged', 'select i.id from intended'],
  ])('rolls back and throws what failed in %s', async (_, fragment) => {
    const err = boom()
    const { pool, sqls } = revPool([[fragment, err]])
    await expect(store(pool).repairSiteMessages()).rejects.toBe(err)
    expect(sqls().at(-1)).toBe('rollback')
  })

  it('rolls back the phantoms when the restore fails', async () => {
    const err = boom()
    const r = revPool([[PHANTOMS, [{ id: MSG_2 }]], ['select i.id from intended', [{ id: MSG }]], ['update librarius_messages m set', err]])
    await expect(store(r.pool).repairSiteMessages()).rejects.toBe(err)
    expect(r.sqls().at(-1)).toBe('rollback')
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
      (s, v) => s.noteBlock(v, v),
      (s, v) => s.pruneOutbox(v),
      (s, v) => s.outboxSet(v, { state: 'sent', hold: v }),
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
