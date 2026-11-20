import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import { createLibrariusStore } from './librariusStore.js'
import { applyReaction, attachmentUrl } from './librariusParse.js'

// The SQL itself is proven against real Postgres by the e2e stack. Here a recording pool pins what the store asks
// for, in what order, with which parameters, and what it does on failure, as galleryStore.test.js does.
// `script` maps a lowercase SQL fragment to the rows that statement answers with: an Error is thrown, and a function
// is called with the statement's parameters. The first fragment found in a statement wins.
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

// The statement a write takes its number of the sequence with, and a pool that hands the numbers out from 900, one per
// ask, after whatever `script` answers first.
const REV = "select nextval('librarius_rev') as rev"
function revPool(script = []) {
  let next = 900
  return fakePool([...script, ['select nextval', () => [{ rev: String(next++) }]]])
}

// Invented ids, all in the 400-499 range. None of them is a real post, member or message.
const POST = '200000000000000410'
const POST_2 = '200000000000000411'
const MEMBER = '200000000000000412'
const OWNER = '200000000000000413'
const AUTHOR = '200000000000000414'
const HOOK = '200000000000000415'
const TAG = '200000000000000420'
const MSG = '200000000000000430'
const MSG_2 = '200000000000000431'
const MSG_3 = '200000000000000432'
const ATT = '200000000000000440'
const ATT_2 = '200000000000000441'

const has = (fragment) => expect.stringContaining(fragment)
const store = (pool) => createLibrariusStore(pool)
const boom = () => new Error('connection lost')
// A title for a value of any type, bigint included (which %j cannot print).
const show = (v) => (typeof v === 'bigint' ? `${v}n` : (JSON.stringify(v) ?? String(v)))
const labelled = (list) => list.map((v) => [show(v), v])

const post = (over = {}) => ({
  id: POST,
  ownerId: OWNER,
  title: 'A test post',
  tagIds: [TAG],
  pinned: false,
  locked: true,
  archived: false,
  createdAt: '2026-11-01T10:00:00.123000+00:00',
  ...over,
})

const attachment = (over = {}) => ({
  id: ATT,
  filename: 'map.png',
  contentType: 'image/png',
  size: 2048,
  width: 640,
  height: 480,
  url: `https://cdn.discordapp.com/attachments/${POST}/${ATT}/map.png?ex=6540a0b3`,
  proxyUrl: `https://media.discordapp.net/attachments/${POST}/${ATT}/map.png?ex=6540a0b3`,
  expiresAt: '2023-10-31T06:37:39.000Z',
  position: 0,
  ...over,
})

const message = (over = {}) => ({
  id: MSG,
  postId: POST,
  authorId: AUTHOR,
  authorName: 'Test Author',
  authorAvatar: `https://cdn.discordapp.com/avatars/${AUTHOR}/0123456789abcdef0123456789abcdef.png?size=64`,
  webhookId: null,
  kind: 0,
  content: 'hello there',
  embeds: [{ type: 'link', url: 'https://example.test/', title: null }],
  stickers: [{ id: '200000000000000450', name: 'wave' }],
  reactions: [{ key: 'u:x', id: null, name: 'x', animated: false, count: 2 }],
  replyTo: null,
  createdAt: '2026-11-02T18:30:00.123000+00:00',
  editedAt: null,
  attachments: [attachment()],
  ...over,
})

// What Postgres answers for a message row, and what the store makes of it.
const dbMessage = (id, over = {}) => ({
  id,
  post_id: POST,
  author_id: AUTHOR,
  author_name: 'Test Author',
  author_avatar: null,
  webhook_id: null,
  kind: 0,
  content: `hello ${id}`,
  embeds: [],
  stickers: [],
  reactions: [],
  reply_to: null,
  created_at: new Date('2026-11-02T18:30:00.123Z'),
  edited_at: null,
  rev: '120',
  origin: 'discord',
  source: null,
  ...over,
})
const viewMessage = (id, attachments = [], over = {}) => ({
  id,
  postId: POST,
  authorId: AUTHOR,
  authorName: 'Test Author',
  authorAvatar: null,
  webhookId: null,
  kind: 0,
  content: `hello ${id}`,
  embeds: [],
  stickers: [],
  reactions: [],
  replyTo: null,
  createdAt: '2026-11-02T18:30:00.123Z',
  editedAt: null,
  rev: '120',
  origin: 'discord',
  source: null,
  attachments,
  ...over,
})
const dbAttachment = (id, messageId, over = {}) => ({
  id,
  message_id: messageId,
  position: 0,
  filename: 'map.png',
  content_type: 'image/png',
  size: 2048,
  width: 640,
  height: 480,
  url: 'https://cdn.discordapp.com/attachments/1/2/map.png?ex=6540a0b3',
  proxy_url: null,
  expires_at: new Date('2023-10-31T06:37:39.000Z'),
  ...over,
})

const COLUMNS =
  'id, post_id, author_id, author_name, author_avatar, webhook_id, kind, content, embeds, stickers, reactions, reply_to, created_at, edited_at, rev, origin, source'
const ATTACHMENT_COLUMNS = 'id, message_id, position, filename, content_type, size, width, height, url, proxy_url, expires_at'

// A post's messages as Postgres would answer the store's page statements, honouring the where, order and limit the
// store sent. `ids` is a list of ids in any order.
function modelPool(ids, extra = []) {
  const asc = [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  const lt = (a, b) => BigInt(a) < BigInt(b)
  const rows = (list, limit) => list.slice(0, limit).map((id) => dbMessage(id))
  return fakePool([
    ...extra,
    ['and id < $2 order by id desc', (p) => rows(asc.filter((id) => lt(id, p[1])).reverse(), p[2])],
    ['and id > $2 order by id asc', (p) => rows(asc.filter((id) => lt(p[1], id)), p[2])],
    ['and id <= $2 order by id desc', (p) => rows(asc.filter((id) => !lt(p[1], id)).reverse(), p[2])],
    ['and id >= $2) as found', (p) => [{ found: asc.some((id) => !lt(id, p[1])) }]],
    ['and id <= $2) as found', (p) => [{ found: asc.some((id) => !lt(p[1], id)) }]],
    ['where post_id = $1 order by id desc limit $2', (p) => rows([...asc].reverse(), p[1])],
  ])
}

const ids = (from, count) => Array.from({ length: count }, (_, i) => String(BigInt(from) + BigInt(i)))
const FIRST = '200000000000001000'

// Everything that is not a snowflake the store may take: the shape, the type or the size of a bigint.
const BAD_IDS = [
  '',
  ' ',
  'abc',
  '1234567890123456',
  '123456789012345678901',
  '9223372036854775808',
  '99999999999999999999',
  '18446744073709551615',
  '-200000000000000410',
  '200000000000000410.0',
  ' 200000000000000410',
  '200000000000000410 ',
  '200000000000000410\n',
  '2000000000000004\uFF11\uFF10',
  '0x2000000000000041',
  200000000000000410,
  200000000000000410n,
  null,
  undefined,
  {},
  ['200000000000000410'],
  true,
]

describe('createLibrariusStore: ids', () => {
  // [what is called, the call, the name the error gives the id, whether undefined means "no cursor given"]
  it.each([
    ['upsertPost id', (s, bad) => s.upsertPost(post({ id: bad })), 'id'],
    ['deletePost', (s, bad) => s.deletePost(bad), 'postId'],
    ['deletePostsNotIn', (s, bad) => s.deletePostsNotIn([POST, bad]), 'postId'],
    ['upsertMessages id', (s, bad) => s.upsertMessages([message({ id: bad })]), 'id'],
    ['upsertMessages postId', (s, bad) => s.upsertMessages([message({ postId: bad })]), 'postId'],
    ['upsertMessages authorId', (s, bad) => s.upsertMessages([message({ authorId: bad })]), 'authorId'],
    ['upsertMessages attachment id', (s, bad) => s.upsertMessages([message({ attachments: [attachment({ id: bad })] })]), 'attachment id'],
    ['deleteMessages', (s, bad) => s.deleteMessages([MSG, bad]), 'messageId'],
    ['adjustReaction', (s, bad) => s.adjustReaction(bad, { id: null, name: 'x' }, 1), 'messageId'],
    ['clearReactions', (s, bad) => s.clearReactions(bad, null), 'messageId'],
    ['listPosts', (s, bad) => s.listPosts(bad), 'memberId'],
    ['getPost id', (s, bad) => s.getPost(bad, MEMBER), 'postId'],
    ['getPost memberId', (s, bad) => s.getPost(POST, bad), 'memberId'],
    ['listMessages postId', (s, bad) => s.listMessages(bad, { limit: 5 }), 'postId'],
    ['listMessages before', (s, bad) => s.listMessages(POST, { before: bad, limit: 5 }), 'before', true],
    ['listMessages after', (s, bad) => s.listMessages(POST, { after: bad, limit: 5 }), 'after', true],
    ['listMessages around', (s, bad) => s.listMessages(POST, { around: bad, limit: 5 }), 'around', true],
    ['changes', (s, bad) => s.changes(bad, '0', 200), 'postId'],
    ['currentRev', (s, bad) => s.currentRev(bad), 'postId'],
    ['quotedMessages postId', (s, bad) => s.quotedMessages(bad, [MSG]), 'postId'],
    ['quotedMessages messageId', (s, bad) => s.quotedMessages(POST, [MSG, bad]), 'messageId'],
    ['setRead memberId', (s, bad) => s.setRead(bad, POST, MSG), 'memberId'],
    ['setRead postId', (s, bad) => s.setRead(MEMBER, bad, MSG), 'postId'],
    ['setRead messageId', (s, bad) => s.setRead(MEMBER, POST, bad), 'messageId'],
    ['markViewed', (s, bad) => s.markViewed(bad), 'postId'],
    ['importCursor', (s, bad) => s.importCursor(bad), 'postId'],
    ['setImportCursor postId', (s, bad) => s.setImportCursor(bad, MSG), 'postId'],
    ['setImportCursor messageId', (s, bad) => s.setImportCursor(POST, bad), 'messageId'],
    ['windowIds', (s, bad) => s.windowIds(bad, 10), 'postId'],
    ['updateAttachmentUrls', (s, bad) => s.updateAttachmentUrls([{ id: bad, url: 'https://cdn.discordapp.com/attachments/1/2/f.png?ex=6540a0b3', expiresAt: null }]), 'attachment id'],
  ])('%s: a non-snowflake throws TypeError before any query', async (_, call, what, undefinedMeansNone) => {
    // An undefined cursor means none was given, so it is no bad id for those.
    for (const bad of BAD_IDS.filter((v) => !(undefinedMeansNone && v === undefined))) {
      const { pool, log, release } = fakePool()
      const failed = call(store(pool), bad)
      await expect(failed).rejects.toThrow(TypeError)
      await expect(failed).rejects.toThrow(`${what} must be a snowflake`)
      expect(log).toEqual([])
      expect(release).not.toHaveBeenCalled()
    }
  })

  it('takes the ends of the snowflake range: 17 digits up to the largest bigint', async () => {
    for (const id of ['10000000000000000', '9223372036854775807']) {
      const { pool, log } = fakePool()
      await store(pool).markViewed(id)
      expect(log[0].params).toEqual([id])
    }
  })

  it('names what was wrong, so a caller can find it', async () => {
    const { pool } = fakePool()
    await expect(store(pool).markViewed('nope')).rejects.toThrow('postId must be a snowflake')
    await expect(store(pool).setRead(MEMBER, POST, 'nope')).rejects.toThrow('messageId must be a snowflake')
  })

  it('refuses any string that is not 17 to 20 digits within a bigint, whatever it holds (property)', async () => {
    const inRange = (s) => /^\d{17,20}$/.test(s) && BigInt(s) <= 9223372036854775807n
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 24 }), async (s) => {
        const { pool, log } = fakePool()
        const done = store(pool).markViewed(s)
        if (inRange(s)) {
          await done
          expect(log[0].params).toEqual([s])
        } else {
          await expect(done).rejects.toThrow(TypeError)
          expect(log).toEqual([])
        }
      }),
    )
  })

  it('takes every snowflake in range (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 10n ** 16n, max: 9223372036854775807n }), async (n) => {
        const { pool, log } = fakePool()
        await store(pool).markViewed(String(n))
        expect(log[0].params).toEqual([String(n)])
      }),
    )
  })
})

describe('knownPostIds', () => {
  it('answers the ids of every stored post, as a set of strings', async () => {
    const { pool, log } = fakePool([['from librarius_posts', [{ id: POST }, { id: POST_2 }, { id: POST }]]])
    const out = await store(pool).knownPostIds()
    expect(out).toEqual(new Set([POST, POST_2]))
    expect(out).toBeInstanceOf(Set)
    expect(log).toEqual([{ sql: 'select id from librarius_posts', params: undefined }])
  })

  it('is an empty set with no posts', async () => {
    const { pool } = fakePool()
    expect(await store(pool).knownPostIds()).toEqual(new Set())
  })
})

describe('upsertPost', () => {
  it('writes the post in one statement: insert, or update every column Discord owns', async () => {
    const { pool, log, release } = fakePool()
    expect(await store(pool).upsertPost(post())).toBeUndefined()
    expect(log).toEqual([
      {
        sql:
          'insert into librarius_posts (id, owner_id, title, tag_ids, pinned, locked, archived, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8) ' +
          'on conflict (id) do update set owner_id = excluded.owner_id, title = excluded.title, tag_ids = excluded.tag_ids, ' +
          'pinned = excluded.pinned, locked = excluded.locked, archived = excluded.archived, created_at = excluded.created_at, updated_at = now()',
        params: [POST, OWNER, 'A test post', [TAG], false, true, false, '2026-11-01T10:00:00.123000+00:00'],
      },
    ])
    expect(release).not.toHaveBeenCalled()
  })

  it("leaves the import's cursor and the view time alone, since only the store's own jobs set them", async () => {
    const { pool, log } = fakePool()
    await store(pool).upsertPost(post())
    expect(log[0].sql).not.toContain('import_cursor')
    expect(log[0].sql).not.toContain('viewed_at')
  })

  it('takes a post with no owner and no tags', async () => {
    const { pool, log } = fakePool()
    await store(pool).upsertPost(post({ ownerId: null, tagIds: [] }))
    expect(log[0].params.slice(0, 4)).toEqual([POST, null, 'A test post', []])
  })

  it.each(labelled(BAD_IDS.filter((v) => v !== null)))('refuses an owner of %s before any query', async (_, bad) => {
    const { pool, log } = fakePool()
    await expect(store(pool).upsertPost(post({ ownerId: bad }))).rejects.toThrow('ownerId must be a snowflake')
    expect(log).toEqual([])
  })

  it.each([undefined, null, 'a,b', { 0: TAG }, 5])('refuses tagIds of %j before any query', async (tagIds) => {
    const { pool, log } = fakePool()
    await expect(store(pool).upsertPost(post({ tagIds }))).rejects.toThrow('tagIds must be a list')
    expect(log).toEqual([])
  })

  it('refuses a missing post', async () => {
    const { pool, log } = fakePool()
    await expect(store(pool).upsertPost(undefined)).rejects.toThrow(TypeError)
    await expect(store(pool).upsertPost(null)).rejects.toThrow(TypeError)
    expect(log).toEqual([])
  })

  it('sends the same statement whatever the text of the post, and the text only as a parameter (property)', async () => {
    const base = fakePool()
    await store(base.pool).upsertPost(post())
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (title, tag) => {
        const { pool, log } = fakePool()
        await store(pool).upsertPost(post({ title, tagIds: [tag] }))
        expect(log[0].sql).toBe(base.log[0].sql)
        expect(log[0].params[2]).toBe(title)
        expect(log[0].params[3]).toEqual([tag])
      }),
    )
  })

  it('lets a failing query reach the caller', async () => {
    const { pool } = fakePool([['insert into librarius_posts', boom()]])
    await expect(store(pool).upsertPost(post())).rejects.toThrow('connection lost')
  })
})

describe('deletePost', () => {
  it('deletes the post by id, and its messages, attachments and read marks go with it by cascade', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).deletePost(POST)).toBeUndefined()
    expect(log).toEqual([{ sql: 'delete from librarius_posts where id = $1', params: [POST] }])
  })
})

describe('deletePostsNotIn', () => {
  it('deletes every post outside the list and answers the ids it deleted', async () => {
    const { pool, log } = fakePool([['delete from librarius_posts', [{ id: POST_2 }]]])
    expect(await store(pool).deletePostsNotIn([POST, MSG])).toEqual([POST_2])
    expect(log).toEqual([{ sql: 'delete from librarius_posts where id <> all($1::bigint[]) returning id', params: [[POST, MSG]] }])
  })

  it('answers an empty list when nothing was outside it', async () => {
    const { pool } = fakePool()
    expect(await store(pool).deletePostsNotIn([POST])).toEqual([])
  })

  it('deletes nothing for an empty list, since that is far likelier a listing that failed to read than a forum emptied', async () => {
    const { pool, log } = fakePool([['delete from librarius_posts', [{ id: POST }]]])
    expect(await store(pool).deletePostsNotIn([])).toEqual([])
    expect(log).toEqual([])
  })

  it.each([undefined, null, POST, new Set([POST]), { length: 1, 0: POST }])('refuses %j, which is not a list', async (bad) => {
    const { pool, log } = fakePool()
    await expect(store(pool).deletePostsNotIn(bad)).rejects.toThrow('ids must be a list')
    expect(log).toEqual([])
  })
})

describe('upsertMessages', () => {
  const INSERT =
    `insert into librarius_messages (id, post_id, author_id, author_name, author_avatar, webhook_id, kind, content, embeds, stickers, reactions, reply_to, created_at, edited_at, rev) ` +
    `select $1::bigint, $2::bigint, $3::bigint, $4::text, $5::text, $6::bigint, $7::smallint, $8::text, $9::jsonb, $10::jsonb, $11::jsonb, $12::bigint, $13::timestamptz, $14::timestamptz, $15::bigint ` +
    `where exists (select 1 from librarius_posts where id = $2) ` +
    `on conflict (id) do update set author_id = excluded.author_id, author_name = excluded.author_name, author_avatar = excluded.author_avatar, ` +
    `webhook_id = excluded.webhook_id, kind = excluded.kind, content = excluded.content, embeds = excluded.embeds, stickers = excluded.stickers, ` +
    `reactions = excluded.reactions, reply_to = excluded.reply_to, edited_at = excluded.edited_at, rev = excluded.rev ` +
    `where librarius_messages.origin = 'discord' returning id`
  const DELETE_ATTACHMENTS = 'delete from librarius_attachments where message_id = $1'
  const INSERT_ATTACHMENT =
    'insert into librarius_attachments (id, message_id, position, filename, content_type, size, width, height, url, proxy_url, expires_at) ' +
    'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (id) do nothing'

  it('writes a message and replaces its attachments, in one transaction', async () => {
    const { pool, log, release } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
    const m = message()
    expect(await store(pool).upsertMessages([m])).toBeUndefined()
    expect(log.map((l) => l.sql)).toEqual(['begin', REV, INSERT, DELETE_ATTACHMENTS, INSERT_ATTACHMENT, 'commit'])
    expect(log[2].params).toEqual([
      MSG,
      POST,
      AUTHOR,
      'Test Author',
      m.authorAvatar,
      null,
      0,
      'hello there',
      JSON.stringify(m.embeds),
      JSON.stringify(m.stickers),
      JSON.stringify(m.reactions),
      null,
      '2026-11-02T18:30:00.123000+00:00',
      null,
      '900',
    ])
    expect(log[3].params).toEqual([MSG])
    expect(log[4].params).toEqual([
      ATT,
      MSG,
      0,
      'map.png',
      'image/png',
      2048,
      640,
      480,
      m.attachments[0].url,
      m.attachments[0].proxyUrl,
      '2023-10-31T06:37:39.000Z',
    ])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('takes one number of the sequence for the whole transaction, as its first statement, and stamps it on an insert and on an update alike', async () => {
    const { pool, log } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
    await store(pool).upsertMessages([message()])
    expect(log.map((l) => l.sql).slice(0, 3)).toEqual(['begin', REV, INSERT])
    expect(log[1].params).toBeUndefined()
    expect(log[2].params[14]).toBe('900')
    // The insert carries the number, and so does what a conflict updates; the statement asks the sequence for nothing.
    expect(log[2].sql).toContain('edited_at, rev) select')
    expect(log[2].sql).toContain("rev = excluded.rev where librarius_messages.origin = 'discord' returning id")
    expect(log[2].sql).not.toContain('nextval')
  })

  it('stamps every message of a batch with the same number, from one ask of the sequence', async () => {
    const { pool, log, sqls } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
    await store(pool).upsertMessages([message({ id: MSG }), message({ id: MSG_2 }), message({ id: MSG_3 })])
    expect(sqls().filter((q) => q === REV)).toHaveLength(1)
    const inserts = log.filter((l) => l.sql === INSERT)
    expect(inserts.map((l) => l.params[0])).toEqual([MSG, MSG_2, MSG_3])
    expect(inserts.map((l) => l.params[14])).toEqual(['900', '900', '900'])
  })

  it('takes a new number for each batch, and the batch is stamped with the number it was handed (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 1n, max: 9223372036854775000n }), fc.integer({ min: 1, max: 6 }), async (rev, count) => {
        const { pool, log } = fakePool([
          ['insert into librarius_messages', [{ id: MSG }]],
          ['select nextval', [{ rev: String(rev) }]],
        ])
        await store(pool).upsertMessages(ids(FIRST, count).map((id) => message({ id })))
        const inserts = log.filter((l) => l.sql === INSERT)
        expect(inserts).toHaveLength(count)
        expect(new Set(inserts.map((l) => l.params[14]))).toEqual(new Set([String(rev)]))
        expect(log.filter((l) => l.sql === REV)).toHaveLength(1)
      }),
    )
    const { pool, log } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
    await store(pool).upsertMessages([message()])
    await store(pool).upsertMessages([message()])
    expect(log.filter((l) => l.sql === INSERT).map((l) => l.params[14])).toEqual(['900', '901'])
  })

  it('takes no number when there is nothing to write', async () => {
    const { pool, sqls } = revPool()
    await store(pool).upsertMessages([])
    expect(sqls()).toEqual([])
  })

  it('rolls back, and writes nothing, when the sequence cannot be asked', async () => {
    const err = boom()
    const { pool, sqls } = fakePool([['select nextval', err]])
    await expect(store(pool).upsertMessages([message()])).rejects.toBe(err)
    expect(sqls()).toEqual(['begin', REV, 'rollback'])
  })

  it('never moves a message to another post or rewrites when it was written', async () => {
    const { pool, log } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
    await store(pool).upsertMessages([message()])
    const update = log[2].sql.slice(log[2].sql.indexOf('do update set'))
    expect(update).not.toContain('post_id')
    expect(update).not.toContain('created_at')
  })

  it('sends the lists as json text, never as a Postgres array', async () => {
    const { pool, log } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
    await store(pool).upsertMessages([message({ embeds: [], stickers: [], reactions: [] })])
    expect(log[2].params.slice(8, 11)).toEqual(['[]', '[]', '[]'])
  })

  it('skips a message whose post is not stored: the insert answers nothing, so its attachments are left alone', async () => {
    const { pool, sqls } = revPool([['insert into librarius_messages', []]])
    await store(pool).upsertMessages([message()])
    expect(sqls()).toEqual(['begin', REV, INSERT, 'commit'])
  })

  it('never writes over a message of the site, nor its attachments: a conflict updates only a row of origin discord', async () => {
    // A row of the site is the outbox's (origin 'site'): the update of a conflict is limited to rows of Discord, so for one of the site
    // the statement answers nothing, as for a message whose post is not stored, and its attachments are left as they are.
    const { pool, log, sqls } = revPool([['insert into librarius_messages', []]])
    await store(pool).upsertMessages([message({ attachments: [attachment(), attachment({ id: ATT_2, position: 1 })] })])
    expect(sqls()).toEqual(['begin', REV, INSERT, 'commit'])
    const update = log[2].sql.slice(log[2].sql.indexOf('do update set'))
    expect(update.endsWith("rev = excluded.rev where librarius_messages.origin = 'discord' returning id")).toBe(true)
  })

  it('limits the update of a conflict to rows of Discord with keepReactions too', async () => {
    const { pool, log, sqls } = revPool([['insert into librarius_messages', []]])
    await store(pool).upsertMessages([message()], { keepReactions: true })
    expect(sqls()).toEqual(['begin', REV, INSERT.replace('reactions = excluded.reactions, ', ''), 'commit'])
    expect(log[2].sql).toContain("where librarius_messages.origin = 'discord' returning id")
  })

  it('goes on with the next message after a skipped one, in the order given', async () => {
    const { pool, log } = revPool([['insert into librarius_messages', (p) => (p[0] === MSG ? [] : [{ id: p[0] }])]])
    await store(pool).upsertMessages([message({ id: MSG }), message({ id: MSG_2, attachments: [attachment({ id: ATT_2 })] }), message({ id: MSG_3, attachments: [] })])
    expect(log.map((l) => [l.sql === INSERT ? 'message' : l.sql, l.params?.[0]])).toEqual([
      ['begin', undefined],
      [REV, undefined],
      ['message', MSG],
      ['message', MSG_2],
      [DELETE_ATTACHMENTS, MSG_2],
      [INSERT_ATTACHMENT, ATT_2],
      ['message', MSG_3],
      [DELETE_ATTACHMENTS, MSG_3],
      ['commit', undefined],
    ])
  })

  it('drops the attachments of a message that has none now', async () => {
    const { pool, sqls } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
    await store(pool).upsertMessages([message({ attachments: [] })])
    expect(sqls()).toEqual(['begin', REV, INSERT, DELETE_ATTACHMENTS, 'commit'])
  })

  it('writes an attachment at each position it was given, one statement each, after the delete', async () => {
    const { pool, log } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
    const second = attachment({ id: ATT_2, position: 1, contentType: null, width: null, height: null, proxyUrl: null, expiresAt: null })
    await store(pool).upsertMessages([message({ attachments: [attachment(), second] })])
    expect(log.map((l) => l.sql)).toEqual(['begin', REV, INSERT, DELETE_ATTACHMENTS, INSERT_ATTACHMENT, INSERT_ATTACHMENT, 'commit'])
    expect(log[5].params).toEqual([ATT_2, MSG, 1, 'map.png', null, 2048, null, null, second.url, null, null])
  })

  it('takes a reply and a webhook message', async () => {
    const { pool, log } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
    await store(pool).upsertMessages([message({ webhookId: HOOK, replyTo: MSG_2, kind: 19, editedAt: '2026-11-02T19:00:00.000000+00:00' })])
    expect(log[2].params[5]).toBe(HOOK)
    expect(log[2].params[6]).toBe(19)
    expect(log[2].params[11]).toBe(MSG_2)
    expect(log[2].params[13]).toBe('2026-11-02T19:00:00.000000+00:00')
  })

  it('sends nothing for an empty list: no transaction is opened', async () => {
    const { pool, log, release } = fakePool()
    expect(await store(pool).upsertMessages([])).toBeUndefined()
    expect(log).toEqual([])
    expect(release).not.toHaveBeenCalled()
  })

  describe('with keepReactions', () => {
    // The same statement with the reactions left out of what a conflict updates. The insert still carries them ($11), so a
    // message that is new is stored with the reactions it came with.
    const KEEPING = INSERT.replace('reactions = excluded.reactions, ', '')

    it('leaves the stored reactions alone when the message exists, and still inserts them when it does not', async () => {
      const { pool, log } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
      const m = message()
      expect(await store(pool).upsertMessages([m], { keepReactions: true })).toBeUndefined()
      expect(KEEPING).not.toBe(INSERT)
      expect(log.map((l) => l.sql)).toEqual(['begin', REV, KEEPING, DELETE_ATTACHMENTS, INSERT_ATTACHMENT, 'commit'])
      expect(log[2].sql.slice(log[2].sql.indexOf('do update set'))).not.toContain('reactions')
      expect(log[2].sql.slice(0, log[2].sql.indexOf('do update set'))).toContain('$11::jsonb')
      expect(log[2].params[10]).toBe(JSON.stringify(m.reactions))
    })

    it('changes nothing else about the write: the same parameters and the same stamp of a new number', async () => {
      const keep = revPool([['insert into librarius_messages', [{ id: MSG }]]])
      const full = revPool([['insert into librarius_messages', [{ id: MSG }]]])
      await store(keep.pool).upsertMessages([message()], { keepReactions: true })
      await store(full.pool).upsertMessages([message()])
      expect(keep.log.map((l) => l.params)).toEqual(full.log.map((l) => l.params))
      expect(keep.log[2].sql).toContain('rev = excluded.rev')
      expect(keep.log[2].sql).toContain('edited_at = excluded.edited_at')
    })

    it('applies to every message of a batch', async () => {
      const { pool, log } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
      await store(pool).upsertMessages([message({ id: MSG }), message({ id: MSG_2 })], { keepReactions: true })
      expect(log.filter((l) => l.sql.startsWith('insert into librarius_messages')).map((l) => l.sql)).toEqual([KEEPING, KEEPING])
    })

    it.each([[undefined], [{}], [{ keepReactions: undefined }], [{ keepReactions: false }]])(
      'writes the reactions as before when the options are %j',
      async (options) => {
        const { pool, log } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
        await store(pool).upsertMessages([message()], options)
        expect(log[2].sql).toBe(INSERT)
      },
    )

    it.each([[1], [0], ['true'], [null], [{}], [[]]])('refuses %j, which is not true or false, before any query', async (bad) => {
      const { pool, log } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
      await expect(store(pool).upsertMessages([message()], { keepReactions: bad })).rejects.toThrow('keepReactions must be true or false')
      expect(log).toEqual([])
    })

    it('refuses a bad option even when there is nothing to write', async () => {
      const { pool, log } = fakePool()
      await expect(store(pool).upsertMessages([], { keepReactions: 'yes' })).rejects.toThrow(TypeError)
      expect(log).toEqual([])
    })

    it('rolls back and gives the error to the caller when the write fails', async () => {
      const err = boom()
      const { pool, sqls } = revPool([['insert into librarius_messages', err]])
      await expect(store(pool).upsertMessages([message()], { keepReactions: true })).rejects.toBe(err)
      expect(sqls()).toEqual(['begin', REV, KEEPING, 'rollback'])
    })
  })

  it.each([undefined, null, message(), 'x', new Set([message()])])('refuses %j, which is not a list', async (bad) => {
    const { pool, log } = fakePool()
    await expect(store(pool).upsertMessages(bad)).rejects.toThrow('rows must be a list')
    expect(log).toEqual([])
  })

  it.each(labelled(BAD_IDS.filter((v) => v !== null)))('refuses a webhookId or replyTo of %s before any query', async (_, bad) => {
    for (const field of ['webhookId', 'replyTo']) {
      const { pool, log } = fakePool()
      await expect(store(pool).upsertMessages([message({ [field]: bad })])).rejects.toThrow(`${field} must be a snowflake`)
      expect(log).toEqual([])
    }
  })

  it.each(['embeds', 'stickers', 'reactions', 'attachments'])('refuses %s that is not a list, before any query', async (field) => {
    for (const bad of [undefined, null, 'x', {}, 5]) {
      const { pool, log } = fakePool()
      await expect(store(pool).upsertMessages([message({ [field]: bad })])).rejects.toThrow(`${field} must be a list`)
      expect(log).toEqual([])
    }
  })

  it('checks every message before it writes any: one bad message in a batch writes none', async () => {
    const { pool, log } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
    await expect(store(pool).upsertMessages([message(), message({ id: MSG_2, authorId: 'x' })])).rejects.toThrow(TypeError)
    expect(log).toEqual([])
  })

  it('refuses an attachment that is not an object, before any query', async () => {
    for (const bad of [null, undefined, 'x', 5]) {
      const { pool, log } = fakePool()
      await expect(store(pool).upsertMessages([message({ attachments: [bad] })])).rejects.toThrow(TypeError)
      expect(log).toEqual([])
    }
  })

  it('refuses a missing message, before any query', async () => {
    for (const bad of [null, undefined]) {
      const { pool, log } = fakePool()
      await expect(store(pool).upsertMessages([bad])).rejects.toThrow(TypeError)
      expect(log).toEqual([])
    }
  })

  it.each([
    ['the message insert', 'insert into librarius_messages', ['begin', REV, INSERT, 'rollback']],
    ['the attachment delete', 'delete from librarius_attachments', ['begin', REV, INSERT, DELETE_ATTACHMENTS, 'rollback']],
    ['an attachment insert', 'insert into librarius_attachments', ['begin', REV, INSERT, DELETE_ATTACHMENTS, INSERT_ATTACHMENT, 'rollback']],
  ])('rolls everything back when %s fails, and gives the error to the caller', async (_, fragment, expected) => {
    const err = boom()
    const { pool, sqls, release } = revPool([
      [fragment, err],
      ['insert into librarius_messages', [{ id: MSG }]],
    ])
    await expect(store(pool).upsertMessages([message()])).rejects.toBe(err)
    expect(sqls()).toEqual(expected)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('sends the same statements whatever the text in the messages, and the text only as parameters (property)', async () => {
    const base = revPool([['insert into librarius_messages', [{ id: MSG }]]])
    await store(base.pool).upsertMessages([message()])
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), fc.string(), async (name, content, file) => {
        const { pool, log } = revPool([['insert into librarius_messages', [{ id: MSG }]]])
        await store(pool).upsertMessages([message({ authorName: name, content, attachments: [attachment({ filename: file })] })])
        expect(log.map((l) => l.sql)).toEqual(base.log.map((l) => l.sql))
        expect(log[2].params[3]).toBe(name)
        expect(log[2].params[7]).toBe(content)
        expect(log[4].params[3]).toBe(file)
      }),
    )
  })
})

describe('deleteMessages', () => {
  it('notes each message that is stored, then deletes them, in one transaction', async () => {
    const { pool, log, release } = revPool()
    expect(await store(pool).deleteMessages([MSG, MSG_2])).toBeUndefined()
    expect(log).toEqual([
      { sql: 'begin', params: undefined },
      { sql: REV, params: undefined },
      {
        sql: 'insert into librarius_tombstones (message_id, post_id, rev) select id, post_id, $2::bigint from librarius_messages where id = any($1::bigint[])',
        params: [[MSG, MSG_2], '900'],
      },
      { sql: 'delete from librarius_messages where id = any($1::bigint[])', params: [[MSG, MSG_2]] },
      { sql: 'commit', params: undefined },
    ])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('stamps every note of the batch with the one number it took, whatever the batch (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 1n, max: 9223372036854775000n }), fc.integer({ min: 1, max: 20 }), async (rev, count) => {
        const { pool, log } = fakePool([['select nextval', [{ rev: String(rev) }]]])
        await store(pool).deleteMessages(ids(FIRST, count))
        expect(log.filter((l) => l.sql === REV)).toHaveLength(1)
        const notes = log.filter((l) => l.sql.startsWith('insert into librarius_tombstones'))
        expect(notes).toHaveLength(1)
        expect(notes[0].params).toEqual([ids(FIRST, count), String(rev)])
      }),
    )
  })

  it('takes a new number for each batch', async () => {
    const { pool, log } = revPool()
    await store(pool).deleteMessages([MSG])
    await store(pool).deleteMessages([MSG_2])
    expect(log.filter((l) => l.sql.startsWith('insert into librarius_tombstones')).map((l) => l.params[1])).toEqual(['900', '901'])
  })

  it('sends nothing for an empty list: no transaction is opened', async () => {
    const { pool, log, release } = fakePool()
    expect(await store(pool).deleteMessages([])).toBeUndefined()
    expect(log).toEqual([])
    expect(release).not.toHaveBeenCalled()
  })

  it.each([undefined, null, MSG, new Set([MSG])])('refuses %j, which is not a list', async (bad) => {
    const { pool, log } = fakePool()
    await expect(store(pool).deleteMessages(bad)).rejects.toThrow('ids must be a list')
    expect(log).toEqual([])
  })

  it.each([
    ['the sequence', 'select nextval', ['begin', REV, 'rollback']],
    ['the note', 'insert into librarius_tombstones', ['begin', REV, has('insert into librarius_tombstones'), 'rollback']],
    ['the delete', 'delete from librarius_messages', ['begin', REV, has('insert into librarius_tombstones'), has('delete from librarius_messages'), 'rollback']],
  ])('rolls back when %s fails, so no message is noted without being deleted', async (_, fragment, expected) => {
    const err = boom()
    const { pool, sqls, release } = revPool([[fragment, err]])
    await expect(store(pool).deleteMessages([MSG])).rejects.toBe(err)
    expect(sqls()).toEqual(expected)
    expect(release).toHaveBeenCalledTimes(1)
  })
})

describe('adjustReaction and clearReactions', () => {
  const FIRE = { id: null, name: '\u{1F525}', animated: false }
  const fire = (count) => ({ key: 'u:\u{1F525}', id: null, name: '\u{1F525}', animated: false, count })
  const star = (count) => ({ key: 'c:200000000000000460', id: '200000000000000460', name: 'star', animated: false, count })
  const SELECT = 'select reactions from librarius_messages where id = $1 for update'
  const UPDATE = "update librarius_messages set reactions = $2::jsonb, rev = nextval('librarius_rev') where id = $1"

  describe('adjustReaction', () => {
    it('adds to an emoji already counted: lock the row, apply, write with a new number, in one transaction', async () => {
      const { pool, log, release } = fakePool([[SELECT, [{ reactions: [fire(2), star(1)] }]]])
      expect(await store(pool).adjustReaction(MSG, FIRE, 1)).toBeUndefined()
      expect(log).toEqual([
        { sql: 'begin', params: undefined },
        { sql: SELECT, params: [MSG] },
        { sql: UPDATE, params: [MSG, JSON.stringify([fire(3), star(1)])] },
        { sql: 'commit', params: undefined },
      ])
      expect(release).toHaveBeenCalledTimes(1)
    })

    it('adds a new emoji at the end, and drops one that falls to zero', async () => {
      const added = fakePool([[SELECT, [{ reactions: [star(1)] }]]])
      await store(added.pool).adjustReaction(MSG, FIRE, 1)
      expect(added.log[2].params[1]).toBe(JSON.stringify([star(1), fire(1)]))

      const dropped = fakePool([[SELECT, [{ reactions: [fire(1), star(1)] }]]])
      await store(dropped.pool).adjustReaction(MSG, FIRE, -1)
      expect(dropped.log[2].params[1]).toBe(JSON.stringify([star(1)]))
    })

    it('writes what applyReaction answers, for any reactions, emoji and change (property)', async () => {
      const emoji = fc.oneof(
        fc.constantFrom(FIRE, { id: '200000000000000460', name: 'star' }, { id: null, name: 'x' }),
        fc.constant(null),
        fc.constant({}),
      )
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.record({ key: fc.constantFrom('u:\u{1F525}', 'c:200000000000000460', 'u:x'), id: fc.constant(null), name: fc.constant('n'), animated: fc.boolean(), count: fc.integer({ min: 1, max: 50 }) }), { maxLength: 4 }),
          emoji,
          fc.integer({ min: -60, max: 60 }),
          async (reactions, e, delta) => {
            const { pool, log } = fakePool([[SELECT, [{ reactions }]]])
            await store(pool).adjustReaction(MSG, e, delta)
            expect(JSON.parse(log[2].params[1])).toEqual(applyReaction(reactions, e, delta))
          },
        ),
      )
    })

    it('writes the list unchanged for an emoji that cannot be keyed, rather than throw', async () => {
      const { pool, log } = fakePool([[SELECT, [{ reactions: [fire(2)] }]]])
      await store(pool).adjustReaction(MSG, { id: 'not-an-id', name: 'x' }, 1)
      expect(log[2].params[1]).toBe(JSON.stringify([fire(2)]))
    })

    it('does nothing for a message that is not stored: it commits without a write', async () => {
      const { pool, sqls } = fakePool([[SELECT, []]])
      await store(pool).adjustReaction(MSG, FIRE, 1)
      expect(sqls()).toEqual(['begin', SELECT, 'commit'])
    })

    it.each([1.5, NaN, Infinity, -Infinity, '1', null, undefined, 2 ** 53, true, [], {}])('refuses a change of %j before any query', async (delta) => {
      const { pool, log } = fakePool([[SELECT, [{ reactions: [] }]]])
      await expect(store(pool).adjustReaction(MSG, FIRE, delta)).rejects.toThrow('delta must be a whole number')
      expect(log).toEqual([])
    })

    it('takes a change of zero, and the largest whole numbers', async () => {
      for (const delta of [0, 1, -1, Number.MAX_SAFE_INTEGER]) {
        const { pool, log } = fakePool([[SELECT, [{ reactions: [] }]]])
        await store(pool).adjustReaction(MSG, FIRE, delta)
        expect(log[2].params[0]).toBe(MSG)
      }
    })

    it.each([
      ['the lock', SELECT, ['begin', SELECT, 'rollback']],
      ['the write', UPDATE, ['begin', SELECT, UPDATE, 'rollback']],
    ])('rolls back when %s fails', async (_, fragment, expected) => {
      const err = boom()
      const { pool, sqls, release } = fakePool([
        [fragment, err],
        [SELECT, [{ reactions: [] }]],
      ])
      await expect(store(pool).adjustReaction(MSG, FIRE, 1)).rejects.toBe(err)
      expect(sqls()).toEqual(expected)
      expect(release).toHaveBeenCalledTimes(1)
    })
  })

  describe('clearReactions', () => {
    it('with no key, takes every reaction off the message', async () => {
      const { pool, log } = fakePool([[SELECT, [{ reactions: [fire(2), star(1)] }]]])
      expect(await store(pool).clearReactions(MSG, null)).toBeUndefined()
      expect(log).toEqual([
        { sql: 'begin', params: undefined },
        { sql: SELECT, params: [MSG] },
        { sql: UPDATE, params: [MSG, '[]'] },
        { sql: 'commit', params: undefined },
      ])
    })

    it('with a key, takes that emoji off and keeps the rest, in order', async () => {
      const { pool, log } = fakePool([[SELECT, [{ reactions: [fire(2), star(1), fire(9)] }]]])
      await store(pool).clearReactions(MSG, 'u:\u{1F525}')
      expect(log[2].params).toEqual([MSG, JSON.stringify([star(1)])])
    })

    it('with a key no reaction has, writes the list as it was', async () => {
      const { pool, log } = fakePool([[SELECT, [{ reactions: [fire(2)] }]]])
      await store(pool).clearReactions(MSG, 'c:200000000000000999')
      expect(log[2].params[1]).toBe(JSON.stringify([fire(2)]))
    })

    it('does nothing for a message that is not stored', async () => {
      const { pool, sqls } = fakePool([[SELECT, []]])
      await store(pool).clearReactions(MSG, null)
      expect(sqls()).toEqual(['begin', SELECT, 'commit'])
    })

    it.each([undefined, '', 5, {}, [], true, false])('refuses a key of %j before any query, so a missing one can never clear them all', async (key) => {
      const { pool, log } = fakePool([[SELECT, [{ reactions: [fire(1)] }]]])
      await expect(store(pool).clearReactions(MSG, key)).rejects.toThrow('key must be an emoji key or null')
      expect(log).toEqual([])
    })

    it.each([
      ['the lock', SELECT, ['begin', SELECT, 'rollback']],
      ['the write', UPDATE, ['begin', SELECT, UPDATE, 'rollback']],
    ])('rolls back when %s fails', async (_, fragment, expected) => {
      const err = boom()
      const { pool, sqls, release } = fakePool([
        [fragment, err],
        [SELECT, [{ reactions: [] }]],
      ])
      await expect(store(pool).clearReactions(MSG, null)).rejects.toBe(err)
      expect(sqls()).toEqual(expected)
      expect(release).toHaveBeenCalledTimes(1)
    })
  })
})

describe('listPosts', () => {
  const dbPost = (over = {}) => ({
    id: POST,
    title: 'A test post',
    tag_ids: [TAG],
    pinned: true,
    locked: false,
    archived: false,
    created_at: new Date('2026-11-01T10:00:00.123Z'),
    last_activity_at: new Date('2026-11-05T12:00:00.000Z'),
    replies: 12,
    unread: 3,
    latest_id: MSG,
    latest_author_id: AUTHOR,
    latest_author_name: 'Test Author',
    latest_author_avatar: 'https://cdn.discordapp.com/avatars/x.png',
    latest_content: 'the newest words',
    image_id: ATT,
    image_url: 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=6540a0b3',
    image_expires_at: new Date('2023-10-31T06:37:39.000Z'),
    poster_ids: [AUTHOR, OWNER],
    ...over,
  })

  it('asks in one statement, with the member as the only parameter', async () => {
    const { pool, log, release } = fakePool()
    expect(await store(pool).listPosts(MEMBER)).toEqual([])
    expect(log).toHaveLength(1)
    expect(log[0].params).toEqual([MEMBER])
    expect(release).not.toHaveBeenCalled()
  })

  it('counts replies without the opening message, and unread only from the member own read mark', async () => {
    const { pool, log } = fakePool()
    await store(pool).listPosts(MEMBER)
    const sql = log[0].sql
    expect(sql).toContain('from librarius_posts p')
    expect(sql).toContain('left join librarius_reads r on r.post_id = p.id and r.member_id = $1')
    expect(sql).toContain('(select count(*)::int from librarius_messages m where m.post_id = p.id and m.id <> p.id) as replies')
    expect(sql).toContain(
      'case when r.last_read is null then 0 else (select count(*)::int from librarius_messages m where m.post_id = p.id and m.id > r.last_read) end as unread',
    )
  })

  it('takes the newest message by id as the latest, with its first 400 characters', async () => {
    const { pool, log } = fakePool()
    await store(pool).listPosts(MEMBER)
    const sql = log[0].sql
    expect(sql).toContain('left join lateral (select m.* from librarius_messages m where m.post_id = p.id order by m.id desc limit 1) lm on true')
    expect(sql).toContain('left(lm.content, 400) as latest_content')
    expect(sql).toContain('coalesce(lm.created_at, p.created_at) as last_activity_at')
  })

  it('takes the first image of the latest message as its thumbnail', async () => {
    const { pool, log } = fakePool()
    await store(pool).listPosts(MEMBER)
    expect(log[0].sql).toContain(
      "left join lateral (select att.id, att.url, att.expires_at from librarius_attachments att where att.message_id = lm.id and att.content_type like 'image/%' order by att.position limit 1) im on true",
    )
  })

  it('takes the last three distinct authors, newest first, as text ids', async () => {
    const { pool, log } = fakePool()
    await store(pool).listPosts(MEMBER)
    expect(log[0].sql).toContain(
      "(select coalesce(array_agg(ps.author_id::text order by ps.newest desc), '{}') from (select m.author_id, max(m.id) as newest from librarius_messages m where m.post_id = p.id group by m.author_id order by max(m.id) desc limit 3) ps) as poster_ids",
    )
  })

  it('puts pinned posts first, then the latest activity, then the newest post, so the order is never left to chance', async () => {
    const { pool, log } = fakePool()
    await store(pool).listPosts(MEMBER)
    expect(log[0].sql).toMatch(/order by p\.pinned desc, coalesce\(lm\.created_at, p\.created_at\) desc, p\.id desc$/)
  })

  it('answers one entry per row: times as ISO text, ids as strings, the latest message and its image', async () => {
    const { pool } = fakePool([['from librarius_posts p', [dbPost(), dbPost({ id: POST_2, pinned: false, latest_id: null, latest_author_id: null, latest_author_name: null, latest_author_avatar: null, latest_content: null, image_id: null, image_url: null, image_expires_at: null, poster_ids: [], replies: 0, unread: 0, last_activity_at: new Date('2026-11-01T10:00:00.123Z') })]]])
    expect(await store(pool).listPosts(MEMBER)).toEqual([
      {
        id: POST,
        title: 'A test post',
        tagIds: [TAG],
        pinned: true,
        locked: false,
        archived: false,
        createdAt: '2026-11-01T10:00:00.123Z',
        lastActivityAt: '2026-11-05T12:00:00.000Z',
        replies: 12,
        unread: 3,
        latest: {
          id: MSG,
          authorId: AUTHOR,
          authorName: 'Test Author',
          authorAvatar: 'https://cdn.discordapp.com/avatars/x.png',
          content: 'the newest words',
          image: { id: ATT, url: 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=6540a0b3', expiresAt: '2023-10-31T06:37:39.000Z' },
        },
        posterIds: [AUTHOR, OWNER],
      },
      {
        id: POST_2,
        title: 'A test post',
        tagIds: [TAG],
        pinned: false,
        locked: false,
        archived: false,
        createdAt: '2026-11-01T10:00:00.123Z',
        lastActivityAt: '2026-11-01T10:00:00.123Z',
        replies: 0,
        unread: 0,
        latest: null,
        posterIds: [],
      },
    ])
  })

  it('answers an image with no expiry as null, and a latest message with no image as image: null', async () => {
    const { pool } = fakePool([['from librarius_posts p', [dbPost({ image_expires_at: null }), dbPost({ image_id: null, image_url: null, image_expires_at: null })]]])
    const out = await store(pool).listPosts(MEMBER)
    expect(out[0].latest.image).toEqual({ id: ATT, url: expect.any(String), expiresAt: null })
    expect(out[1].latest.image).toBeNull()
  })
})

describe('getPost', () => {
  const dbRow = (over = {}) => ({
    id: POST,
    owner_id: OWNER,
    title: 'A test post',
    tag_ids: [TAG],
    pinned: false,
    locked: true,
    archived: true,
    created_at: new Date('2026-11-01T10:00:00.123Z'),
    replies: 41,
    last_read: MSG,
    ...over,
  })

  it('asks for the post and the member read mark in one statement', async () => {
    const { pool, log, release } = fakePool()
    await store(pool).getPost(POST, MEMBER)
    expect(log).toHaveLength(1)
    expect(log[0].params).toEqual([POST, MEMBER])
    expect(log[0].sql).toContain('from librarius_posts p left join librarius_reads r on r.post_id = p.id and r.member_id = $2 where p.id = $1')
    expect(log[0].sql).toContain('(select count(*)::int from librarius_messages m where m.post_id = p.id and m.id <> p.id) as replies')
    expect(release).not.toHaveBeenCalled()
  })

  it('is null for a post that is not stored', async () => {
    const { pool } = fakePool()
    expect(await store(pool).getPost(POST, MEMBER)).toBeNull()
  })

  it('answers the post and the last message the member read', async () => {
    const { pool } = fakePool([['from librarius_posts p', [dbRow()]]])
    expect(await store(pool).getPost(POST, MEMBER)).toEqual({
      post: {
        id: POST,
        ownerId: OWNER,
        title: 'A test post',
        tagIds: [TAG],
        pinned: false,
        locked: true,
        archived: true,
        createdAt: '2026-11-01T10:00:00.123Z',
        replies: 41,
      },
      lastRead: MSG,
    })
  })

  it('answers lastRead as null when the member has no read mark, and ownerId as null for a post with no owner', async () => {
    const { pool } = fakePool([['from librarius_posts p', [dbRow({ last_read: null, owner_id: null })]]])
    const out = await store(pool).getPost(POST, MEMBER)
    expect(out.lastRead).toBeNull()
    expect(out.post.ownerId).toBeNull()
  })
})

describe('listMessages', () => {
  const ATTACHMENTS = 'from librarius_attachments where message_id = any($1::bigint[]) order by message_id, position'

  it.each([0, 101, '5', NaN, 5.5, -1, null, Infinity, true, [], {}, 2 ** 31])('refuses a limit of %j with a RangeError before any query', async (limit) => {
    const { pool, log } = fakePool()
    const failed = store(pool).listMessages(POST, { limit })
    await expect(failed).rejects.toThrow(RangeError)
    await expect(failed).rejects.toThrow('limit must be a whole number from 1 to 100')
    expect(log).toEqual([])
  })

  it.each([1, 2, 50, 99, 100])('takes a limit of %j', async (limit) => {
    const { pool, log } = fakePool()
    await store(pool).listMessages(POST, { limit })
    expect(log[0].params).toEqual([POST, limit + 1])
  })

  it('takes 50 when no limit is given, and the newest page when no cursor is', async () => {
    const { pool, log } = fakePool()
    await store(pool).listMessages(POST, {})
    expect(log[0].params).toEqual([POST, 51])
    await store(pool).listMessages(POST)
    expect(log[1].params).toEqual([POST, 51])
  })

  it('refuses more than one of before, after and around, and says so', async () => {
    for (const opts of [{ before: MSG, after: MSG_2 }, { before: MSG, around: MSG_2 }, { after: MSG, around: MSG_2 }, { before: MSG, after: MSG, around: MSG }]) {
      const { pool, log } = fakePool()
      await expect(store(pool).listMessages(POST, { ...opts, limit: 5 })).rejects.toThrow('at most one of before, after and around')
      expect(log).toEqual([])
    }
  })

  it('treats an undefined cursor as none given', async () => {
    const { pool, log } = fakePool()
    await store(pool).listMessages(POST, { before: undefined, after: undefined, around: undefined, limit: 5 })
    expect(log[0].sql).toBe(`select ${COLUMNS} from librarius_messages where post_id = $1 order by id desc limit $2`)
  })

  it('refuses a cursor that is null, since that is no cursor a caller meant to send', async () => {
    for (const key of ['before', 'after', 'around']) {
      const { pool, log } = fakePool()
      await expect(store(pool).listMessages(POST, { [key]: null, limit: 5 })).rejects.toThrow(TypeError)
      expect(log).toEqual([])
    }
  })

  describe('with no cursor: the newest page', () => {
    it('asks for one row more than the limit, newest first, and answers oldest first', async () => {
      const { pool, log } = modelPool(ids(FIRST, 8))
      const out = await store(pool).listMessages(POST, { limit: 5 })
      expect(log[0]).toEqual({ sql: `select ${COLUMNS} from librarius_messages where post_id = $1 order by id desc limit $2`, params: [POST, 6] })
      expect(out.rows.map((r) => r.id)).toEqual(ids(FIRST, 8).slice(3))
      expect(out.hasOlder).toBe(true)
      expect(out.hasNewer).toBe(false)
    })

    it('has no older page when everything fit', async () => {
      const { pool } = modelPool(ids(FIRST, 5))
      const out = await store(pool).listMessages(POST, { limit: 5 })
      expect(out.rows.map((r) => r.id)).toEqual(ids(FIRST, 5))
      expect(out.hasOlder).toBe(false)
      expect(out.hasNewer).toBe(false)
    })

    it('answers an empty post as no rows and no more, with no attachment query', async () => {
      const { pool, log } = modelPool([])
      expect(await store(pool).listMessages(POST, { limit: 5 })).toEqual({ rows: [], hasOlder: false, hasNewer: false })
      expect(log).toHaveLength(1)
    })
  })

  describe('before', () => {
    it('takes the rows older than the cursor, newest first from the database, answered oldest first', async () => {
      const all = ids(FIRST, 10)
      const { pool, log } = modelPool(all)
      const out = await store(pool).listMessages(POST, { before: all[7], limit: 3 })
      expect(log[0]).toEqual({ sql: `select ${COLUMNS} from librarius_messages where post_id = $1 and id < $2 order by id desc limit $3`, params: [POST, all[7], 4] })
      expect(out.rows.map((r) => r.id)).toEqual(all.slice(4, 7))
      expect(out.hasOlder).toBe(true)
    })

    it('knows whether anything lies at or after the cursor, since the cursor may be a message that was deleted', async () => {
      const all = ids(FIRST, 4)
      const { pool, log } = modelPool(all)
      const out = await store(pool).listMessages(POST, { before: all[2], limit: 5 })
      expect(log[1]).toEqual({
        sql: 'select exists (select 1 from librarius_messages where post_id = $1 and id >= $2) as found',
        params: [POST, all[2]],
      })
      expect(out.hasNewer).toBe(true)
      expect(out.hasOlder).toBe(false)

      const none = modelPool(all)
      const past = await store(none.pool).listMessages(POST, { before: String(BigInt(all[3]) + 1n), limit: 5 })
      expect(past.hasNewer).toBe(false)
      expect(past.rows.map((r) => r.id)).toEqual(all)
    })
  })

  describe('after', () => {
    it('takes the rows newer than the cursor, oldest first', async () => {
      const all = ids(FIRST, 10)
      const { pool, log } = modelPool(all)
      const out = await store(pool).listMessages(POST, { after: all[2], limit: 3 })
      expect(log[0]).toEqual({ sql: `select ${COLUMNS} from librarius_messages where post_id = $1 and id > $2 order by id asc limit $3`, params: [POST, all[2], 4] })
      expect(out.rows.map((r) => r.id)).toEqual(all.slice(3, 6))
      expect(out.hasNewer).toBe(true)
    })

    it('knows whether anything lies at or before the cursor', async () => {
      const all = ids(FIRST, 4)
      const { pool, log } = modelPool(all)
      const out = await store(pool).listMessages(POST, { after: all[1], limit: 5 })
      expect(log[1]).toEqual({
        sql: 'select exists (select 1 from librarius_messages where post_id = $1 and id <= $2) as found',
        params: [POST, all[1]],
      })
      expect(out.hasOlder).toBe(true)
      expect(out.hasNewer).toBe(false)

      const none = modelPool(all)
      const before = await store(none.pool).listMessages(POST, { after: String(BigInt(all[0]) - 1n), limit: 9 })
      expect(before.hasOlder).toBe(false)
      expect(before.rows.map((r) => r.id)).toEqual(all)
    })
  })

  describe('around', () => {
    it('splits 50 as 25 at or before the cursor and 25 after it, each fetched with one row more', async () => {
      const all = ids(FIRST, 200)
      const { pool, log } = modelPool(all)
      const out = await store(pool).listMessages(POST, { around: all[100], limit: 50 })
      expect(log[0]).toEqual({ sql: `select ${COLUMNS} from librarius_messages where post_id = $1 and id <= $2 order by id desc limit $3`, params: [POST, all[100], 26] })
      expect(log[1]).toEqual({ sql: `select ${COLUMNS} from librarius_messages where post_id = $1 and id > $2 order by id asc limit $3`, params: [POST, all[100], 26] })
      expect(out.rows.map((r) => r.id)).toEqual(all.slice(76, 126))
      expect(out.hasOlder).toBe(true)
      expect(out.hasNewer).toBe(true)
    })

    it('puts the cursor message last of the older half, and the extra rows are not shown', async () => {
      const all = ids(FIRST, 20)
      const { pool } = modelPool(all)
      const out = await store(pool).listMessages(POST, { around: all[10], limit: 6 })
      expect(out.rows.map((r) => r.id)).toEqual(all.slice(8, 14))
      expect(out.rows[2].id).toBe(all[10])
    })

    it('gives the odd row of an odd limit to the newer half', async () => {
      const all = ids(FIRST, 100)
      const { pool, log } = modelPool(all)
      const out = await store(pool).listMessages(POST, { around: all[50], limit: 51 })
      expect(log[0].params[2]).toBe(26)
      expect(log[1].params[2]).toBe(27)
      expect(out.rows).toHaveLength(51)
      expect(out.rows[24].id).toBe(all[50])
    })

    it('reports no older and no newer when the page reaches both ends', async () => {
      const all = ids(FIRST, 10)
      const { pool } = modelPool(all)
      const out = await store(pool).listMessages(POST, { around: all[5], limit: 100 })
      expect(out.rows.map((r) => r.id)).toEqual(all)
      expect(out.hasOlder).toBe(false)
      expect(out.hasNewer).toBe(false)
    })

    it('reports each end on its own', async () => {
      const all = ids(FIRST, 10)
      const atStart = await store(modelPool(all).pool).listMessages(POST, { around: all[1], limit: 4 })
      expect(atStart.rows.map((r) => r.id)).toEqual(all.slice(0, 4))
      expect(atStart.hasOlder).toBe(false)
      expect(atStart.hasNewer).toBe(true)

      const atEnd = await store(modelPool(all).pool).listMessages(POST, { around: all[8], limit: 4 })
      expect(atEnd.rows.map((r) => r.id)).toEqual(all.slice(7, 10))
      expect(atEnd.hasOlder).toBe(true)
      expect(atEnd.hasNewer).toBe(false)
    })

    it('with a limit of 1, shows the next message after the cursor and still knows an older one exists', async () => {
      const all = ids(FIRST, 5)
      const { pool, log } = modelPool(all)
      const out = await store(pool).listMessages(POST, { around: all[2], limit: 1 })
      expect(log[0].params[2]).toBe(1)
      expect(log[1].params[2]).toBe(2)
      expect(out.rows.map((r) => r.id)).toEqual([all[3]])
      expect(out.hasOlder).toBe(true)
      expect(out.hasNewer).toBe(true)
    })

    it('splits any limit from 1 to 100 as floor(limit / 2) at or before and the rest after (property)', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 100 }), async (limit) => {
          const { pool, log } = modelPool(ids(FIRST, 10))
          await store(pool).listMessages(POST, { around: FIRST, limit })
          const before = Math.floor(limit / 2)
          expect(log[0].params).toEqual([POST, FIRST, before + 1])
          expect(log[1].params).toEqual([POST, FIRST, limit - before + 1])
        }),
      )
    })
  })

  describe('the page, whichever way it was asked for (property)', () => {
    it('is the right slice of the post, in order, with each flag true exactly when more lies that way', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 40 }),
          fc.integer({ min: 1, max: 12 }),
          fc.integer({ min: -5, max: 45 }),
          fc.constantFrom('newest', 'before', 'after', 'around'),
          async (count, limit, at, mode) => {
            const all = ids(FIRST, count)
            const cursor = String(BigInt(FIRST) + BigInt(at))
            const c = BigInt(cursor)
            const lt = all.filter((id) => BigInt(id) < c)
            const le = all.filter((id) => BigInt(id) <= c)
            const gt = all.filter((id) => BigInt(id) > c)
            const ge = all.filter((id) => BigInt(id) >= c)
            const half = Math.floor(limit / 2)

            const { pool } = modelPool(all)
            const opts = mode === 'newest' ? { limit } : { [mode]: cursor, limit }
            const out = await store(pool).listMessages(POST, opts)

            const want = {
              newest: { rows: all.slice(-limit), hasOlder: all.length > limit, hasNewer: false },
              before: { rows: lt.slice(-limit), hasOlder: lt.length > limit, hasNewer: ge.length > 0 },
              after: { rows: gt.slice(0, limit), hasOlder: le.length > 0, hasNewer: gt.length > limit },
              around: {
                rows: [...(half === 0 ? [] : le.slice(-half)), ...gt.slice(0, limit - half)],
                hasOlder: le.length > half,
                hasNewer: gt.length > limit - half,
              },
            }[mode]
            expect(out.rows.map((r) => r.id)).toEqual(want.rows)
            expect(out.hasOlder).toBe(want.hasOlder)
            expect(out.hasNewer).toBe(want.hasNewer)
          },
        ),
      )
    })
  })

  describe('attachments', () => {
    it('are asked for once, for the ids of the rows shown, and sit on their message in position order', async () => {
      const all = ids(FIRST, 3)
      const { pool, log } = modelPool(all, [
        [
          ATTACHMENTS,
          [
            dbAttachment(ATT, all[0], { position: 0, filename: 'a.png' }),
            dbAttachment(ATT_2, all[0], { position: 1, filename: 'b.png', content_type: null, width: null, height: null, proxy_url: 'https://media.discordapp.net/attachments/1/2/b.png', expires_at: null }),
            dbAttachment('200000000000000442', all[2], { filename: 'c.png' }),
          ],
        ],
      ])
      const out = await store(pool).listMessages(POST, { limit: 5 })
      const attachmentQuery = log.filter((l) => l.sql.includes('from librarius_attachments'))
      expect(attachmentQuery).toEqual([{ sql: `select ${ATTACHMENT_COLUMNS} from librarius_attachments where message_id = any($1::bigint[]) order by message_id, position`, params: [all] }])
      expect(out.rows.map((r) => r.attachments.map((a) => a.filename))).toEqual([['a.png', 'b.png'], [], ['c.png']])
      expect(out.rows[0].attachments[0]).toEqual({
        id: ATT,
        filename: 'a.png',
        contentType: 'image/png',
        size: 2048,
        width: 640,
        height: 480,
        url: 'https://cdn.discordapp.com/attachments/1/2/map.png?ex=6540a0b3',
        proxyUrl: null,
        expiresAt: '2023-10-31T06:37:39.000Z',
        position: 0,
      })
      expect(out.rows[0].attachments[1]).toMatchObject({ contentType: null, width: null, height: null, proxyUrl: 'https://media.discordapp.net/attachments/1/2/b.png', expiresAt: null, position: 1 })
    })

    it('leave out an attachment that belongs to a message not in the page', async () => {
      const { pool } = modelPool(ids(FIRST, 2), [[ATTACHMENTS, [dbAttachment(ATT, '200000000000009999'), dbAttachment(ATT_2, FIRST, { filename: 'kept.png' })]]])
      const out = await store(pool).listMessages(POST, { limit: 5 })
      expect(out.rows.map((r) => r.attachments.map((a) => a.filename))).toEqual([['kept.png'], []])
    })

    it('answer the message rows in the shape the parser makes, plus rev', async () => {
      const { pool } = fakePool([
        ['where post_id = $1 order by id desc limit $2', [dbMessage(MSG, { webhook_id: HOOK, reply_to: MSG_2, kind: 19, edited_at: new Date('2026-11-02T19:00:00.000Z'), author_avatar: 'https://cdn.discordapp.com/avatars/x.png', embeds: [{ type: 'link' }], stickers: [{ id: '1', name: 's' }], reactions: [{ key: 'u:x', count: 1 }], rev: '77' })]],
      ])
      const out = await store(pool).listMessages(POST, { limit: 5 })
      expect(out.rows).toEqual([
        viewMessage(MSG, [], {
          webhookId: HOOK,
          replyTo: MSG_2,
          kind: 19,
          editedAt: '2026-11-02T19:00:00.000Z',
          authorAvatar: 'https://cdn.discordapp.com/avatars/x.png',
          embeds: [{ type: 'link' }],
          stickers: [{ id: '1', name: 's' }],
          reactions: [{ key: 'u:x', count: 1 }],
          rev: '77',
          content: `hello ${MSG}`,
        }),
      ])
    })
  })

  it('does not open a transaction: a read is plain statements', async () => {
    const { pool, release } = modelPool(ids(FIRST, 3))
    await store(pool).listMessages(POST, { around: FIRST, limit: 4 })
    expect(release).not.toHaveBeenCalled()
  })
})

describe('changes', () => {
  // What is new after the number asked from, then the newest few at or below it that are sent again.
  const FRESH = `select ${COLUMNS} from librarius_messages where post_id = $1 and rev > $2 order by rev limit $3`
  const SLACK = `select ${COLUMNS} from librarius_messages where post_id = $1 and rev <= $2::bigint and rev > $2::bigint - $3::bigint order by rev desc limit $3`
  const FRESH_GONE = 'select message_id, rev from librarius_tombstones where post_id = $1 and rev > $2 order by rev limit $3'
  const SLACK_GONE =
    'select message_id, rev from librarius_tombstones where post_id = $1 and rev <= $2::bigint and rev > $2::bigint - $3::bigint order by rev desc limit $3'
  const ATTACHMENTS = has('from librarius_attachments where message_id = any($1::bigint[])')
  const LIMIT = 200
  const SLACK_ROWS = 100
  const ask = (s, since = '5', options = { limit: LIMIT, slack: SLACK_ROWS }) => s.changes(POST, since, options)

  it.each(labelled(['', '-1', '1.5', ' 1', '1 ', '1\n', 'x', '１', 12, 12n, null, undefined, {}, '9223372036854775808', '99999999999999999999']))(
    'refuses a since of %s with a TypeError before any query',
    async (_, since) => {
      const { pool, log } = fakePool()
      await expect(store(pool).changes(POST, since, { limit: LIMIT, slack: SLACK_ROWS })).rejects.toThrow('sinceRev must be the digits of a rev')
      expect(log).toEqual([])
    },
  )

  it.each(labelled([0, -1, 1.5, '5', NaN, null, undefined, Infinity, 2 ** 53, true, 10n]))('refuses a limit of %s with a RangeError before any query', async (_, limit) => {
    const { pool, log } = fakePool()
    const failed = ask(store(pool), '5', { limit, slack: SLACK_ROWS })
    await expect(failed).rejects.toThrow(RangeError)
    await expect(failed).rejects.toThrow('limit must be a whole number from 1 to')
    expect(log).toEqual([])
  })

  it.each(labelled([0, -1, 1.5, '5', NaN, null, undefined, Infinity, 2 ** 53, true, 10n]))('refuses a slack of %s with a RangeError before any query', async (_, slack) => {
    const { pool, log } = fakePool()
    const failed = ask(store(pool), '5', { limit: LIMIT, slack })
    await expect(failed).rejects.toThrow(RangeError)
    await expect(failed).rejects.toThrow('slack must be a whole number from 1 to')
    expect(log).toEqual([])
  })

  it.each(labelled([undefined, null, 200, '200', [], () => 200]))('refuses options of %s, which has no limit and no slack, with a RangeError before any query', async (_, options) => {
    const { pool, log } = fakePool()
    await expect(store(pool).changes(POST, '5', options)).rejects.toThrow(RangeError)
    expect(log).toEqual([])
  })

  it('checks the post, then the since, then the limit, then the slack', async () => {
    const { pool } = fakePool()
    await expect(store(pool).changes('nope', 'x', { limit: 0, slack: 0 })).rejects.toThrow('postId must be a snowflake')
    await expect(ask(store(pool), 'x', { limit: 0, slack: 0 })).rejects.toThrow('sinceRev must be the digits')
    await expect(ask(store(pool), '5', { limit: 0, slack: 0 })).rejects.toThrow('limit must be')
    await expect(ask(store(pool), '5', { limit: 5, slack: 0 })).rejects.toThrow('slack must be')
  })

  it('takes a since of 0, and the largest bigint', async () => {
    for (const since of ['0', '9223372036854775807']) {
      const { pool, log } = fakePool()
      await ask(store(pool), since)
      expect(log[0].params).toEqual([POST, since, LIMIT])
      expect(log[1].params).toEqual([POST, since, SLACK_ROWS])
    }
  })

  it('takes a limit and a slack of 1 and of the largest safe integer', async () => {
    for (const n of [1, Number.MAX_SAFE_INTEGER]) {
      const wide = fakePool()
      await ask(store(wide.pool), '5', { limit: n, slack: 7 })
      expect(wide.log.map((l) => l.params[2])).toEqual([n, 7, n, 7])
      const deep = fakePool()
      await ask(store(deep.pool), '5', { limit: 7, slack: n })
      expect(deep.log.map((l) => l.params[2])).toEqual([7, n, 7, n])
    }
  })

  it('asks for what is new, then what is sent again, then the attachments of the lot, then the same two of the deletes, as plain statements', async () => {
    const { pool, log, release } = fakePool([
      [FRESH, [dbMessage(MSG, { rev: '9' })]],
      [SLACK, [dbMessage(MSG_2, { rev: '5' })]],
      ['from librarius_attachments', [dbAttachment(ATT, MSG)]],
    ])
    await ask(store(pool))
    expect(log.map((l) => l.sql)).toEqual([FRESH, SLACK, ATTACHMENTS, FRESH_GONE, SLACK_GONE])
    expect(log.map((l) => l.params)).toEqual([[POST, '5', LIMIT], [POST, '5', SLACK_ROWS], [[MSG_2, MSG]], [POST, '5', LIMIT], [POST, '5', SLACK_ROWS]])
    expect(release).not.toHaveBeenCalled()
  })

  it('answers what was sent again first and what is new after it, each oldest first, with their attachments', async () => {
    const { pool } = fakePool([
      // The statements that look back answer newest first: the store turns them round.
      [SLACK, [dbMessage(MSG_2, { rev: '5' }), dbMessage(MSG, { rev: '3' })]],
      [FRESH, [dbMessage(MSG_3, { rev: '7' }), dbMessage('200000000000000433', { rev: '9' })]],
      ['from librarius_attachments', [dbAttachment(ATT, MSG_3, { filename: 'late.png' })]],
      [SLACK_GONE, [{ message_id: '200000000000000434', rev: '4' }, { message_id: '200000000000000435', rev: '2' }]],
      [FRESH_GONE, [{ message_id: '200000000000000436', rev: '8' }]],
    ])
    const out = await ask(store(pool))
    expect(out.rows.map((r) => [r.id, r.rev, r.attachments.length])).toEqual([
      [MSG, '3', 0],
      [MSG_2, '5', 0],
      [MSG_3, '7', 1],
      ['200000000000000433', '9', 0],
    ])
    expect(out.rows[2].attachments[0].filename).toBe('late.png')
    expect(out.deleted).toEqual(['200000000000000435', '200000000000000434', '200000000000000436'])
    expect(out.rev).toBe('9')
    expect(out.full).toBe(false)
  })

  it('answers the number to ask from next: the highest among what is new, or the one asked from', async () => {
    const delete12 = fakePool([[FRESH, [dbMessage(MSG, { rev: '7' })]], [FRESH_GONE, [{ message_id: MSG_3, rev: '12' }]]])
    expect((await ask(store(delete12.pool))).rev).toBe('12')
    const compared = fakePool([[FRESH, [dbMessage(MSG, { rev: '99' })]], [FRESH_GONE, [{ message_id: MSG_3, rev: '100' }]]])
    expect((await ask(store(compared.pool))).rev).toBe('100')
    const flipped = fakePool([[FRESH, [dbMessage(MSG, { rev: '100' })]], [FRESH_GONE, [{ message_id: MSG_3, rev: '99' }]]])
    expect((await ask(store(flipped.pool))).rev).toBe('100')
  })

  it('stays where it was asked from when nothing is new, whatever it sends again, and asks for no attachments when it has no rows', async () => {
    const quiet = fakePool()
    expect(await ask(store(quiet.pool), '41')).toEqual({ rows: [], deleted: [], rev: '41', full: false })
    expect(quiet.log.map((l) => l.sql)).toEqual([FRESH, SLACK, FRESH_GONE, SLACK_GONE])
    // What is sent again is at or below the number asked from, so it never moves it.
    const again = fakePool([[SLACK, [dbMessage(MSG, { rev: '41' }), dbMessage(MSG_2, { rev: '38' })]], [SLACK_GONE, [{ message_id: MSG_3, rev: '40' }]]])
    const out = await ask(store(again.pool), '41')
    expect(out.rev).toBe('41')
    expect(out.rows).toHaveLength(2)
    expect(out.deleted).toEqual([MSG_3])
  })

  it('writes the number it stays at without leading zeros', async () => {
    const { pool } = fakePool()
    expect((await ask(store(pool), '007')).rev).toBe('7')
  })

  describe('full', () => {
    const many = (count, from = FIRST) => ids(from, count).map((id, i) => dbMessage(id, { rev: String(500 + i) }))
    const gone = (count) => ids('200000000000002000', count).map((id, i) => ({ message_id: id, rev: String(500 + i) }))
    const run = (script, options) => ask(store(fakePool(script).pool), '400', options)

    it('is true when what is new fills the limit, in messages or in deletes, and false one short of it', async () => {
      expect((await run([[FRESH, many(5)]], { limit: 5, slack: 3 })).full).toBe(true)
      expect((await run([[FRESH_GONE, gone(5)]], { limit: 5, slack: 3 })).full).toBe(true)
      expect((await run([[FRESH, many(4)], [FRESH_GONE, gone(4)]], { limit: 5, slack: 3 })).full).toBe(false)
      expect((await run([[FRESH, many(6)]], { limit: 5, slack: 3 })).full).toBe(true)
      expect((await run([[FRESH_GONE, gone(6)]], { limit: 5, slack: 3 })).full).toBe(true)
    })

    it('is true when both are full, and false when neither is', async () => {
      expect((await run([[FRESH, many(5)], [FRESH_GONE, gone(5)]], { limit: 5, slack: 3 })).full).toBe(true)
      expect((await run([], { limit: 5, slack: 3 })).full).toBe(false)
    })

    it('never counts what it sends again: any number of them, even more than the limit, leave it false', async () => {
      const looking = (count) => ids('200000000000001500', count).map((id, i) => dbMessage(id, { rev: String(399 - i) }))
      const out = await run([[SLACK, looking(9)], [SLACK_GONE, gone(9).map((g, i) => ({ ...g, rev: String(399 - i) }))]], { limit: 5, slack: 9 })
      expect(out.full).toBe(false)
      expect(out.rows).toHaveLength(9)
      expect(out.deleted).toHaveLength(9)
    })

    it('counts only what is new, with what it sends again beside it (property)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 8 }),
          fc.integer({ min: 0, max: 12 }),
          fc.integer({ min: 0, max: 12 }),
          fc.integer({ min: 0, max: 12 }),
          fc.integer({ min: 0, max: 12 }),
          async (limit, fresh, freshGone, slack, slackGone) => {
            const out = await run(
              [
                [FRESH, many(fresh)],
                [FRESH_GONE, gone(freshGone)],
                [SLACK, ids('200000000000001500', slack).map((id, i) => dbMessage(id, { rev: String(399 - i) }))],
                [SLACK_GONE, ids('200000000000002500', slackGone).map((id, i) => ({ message_id: id, rev: String(399 - i) }))],
              ],
              { limit, slack: 12 },
            )
            expect(out.full).toBe(fresh >= limit || freshGone >= limit)
            expect(out.rows).toHaveLength(fresh + slack)
            expect(out.deleted).toHaveLength(freshGone + slackGone)
          },
        ),
      )
    })
  })

  it('never answers a number below the one asked from, whatever the rows say (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 12n }), { maxLength: 4 }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 12n }), { maxLength: 4 }),
        async (since, rowRevs, deleteRevs) => {
          const { pool } = fakePool([
            [FRESH, rowRevs.map((r, i) => dbMessage(ids(FIRST, 4)[i], { rev: String(r) }))],
            [FRESH_GONE, deleteRevs.map((r) => ({ message_id: MSG_3, rev: String(r) }))],
          ])
          const out = await ask(store(pool), String(since))
          const max = [since, ...rowRevs, ...deleteRevs].reduce((a, b) => (a > b ? a : b))
          expect(out.rev).toBe(String(max))
        },
      ),
    )
  })

  it('sends the caller values only as parameters', async () => {
    const { pool, log } = fakePool()
    await ask(store(pool), '12345', { limit: 77, slack: 33 })
    for (const { sql } of log) expect(sql).not.toMatch(/12345|77|33/)
  })
})

describe('who made a message: its origin and its source', () => {
  // A reply written on the site and a message written in Discord, as Postgres answers them (finishSend stores the first).
  const SITE = MSG
  const DISCORD = MSG_2
  const SOURCE = 'A reply of the **site**, with ![a map](upload:1) and <@200000000000000416>.'
  const siteRow = (over = {}) => dbMessage(SITE, { origin: 'site', source: SOURCE, webhook_id: HOOK, ...over })
  const discordRow = (over = {}) => dbMessage(DISCORD, over)

  // Every read that feeds the post page: the newest page, the three cursors, and changes() with both of its reads.
  const READS = [
    ['the newest page', (s) => s.listMessages(POST, { limit: 5 })],
    ['a page before an id', (s) => s.listMessages(POST, { before: MSG_3, limit: 5 })],
    ['a page after an id', (s) => s.listMessages(POST, { after: '200000000000000429', limit: 5 })],
    ['a page around an id', (s) => s.listMessages(POST, { around: SITE, limit: 6 })],
    ['the changes', (s) => s.changes(POST, '5', { limit: 10, slack: 10 })],
  ]
  /** A pool whose every statement over a post's messages answers `rows` (its edges answer none past them). */
  const answering = (rows) => fakePool([[') as found', [{ found: false }]], ['from librarius_messages where post_id = $1', () => rows.map((r) => ({ ...r }))]])
  const shown = (out) => out.rows.map((m) => [m.id, m.origin, m.source])

  it.each(READS)('%s selects both columns and answers them on each message, as they are stored', async (_, read) => {
    const { pool, log } = answering([siteRow(), discordRow()])
    const out = await read(store(pool))
    const reads = log.filter((l) => l.sql.includes('from librarius_messages where post_id = $1') && !l.sql.includes(') as found'))
    expect(reads.length).toBeGreaterThan(0)
    for (const { sql } of reads) expect(sql.startsWith(`select ${COLUMNS} from librarius_messages`)).toBe(true)
    const pairs = shown(out)
    expect(pairs).toContainEqual([SITE, 'site', SOURCE])
    expect(pairs).toContainEqual([DISCORD, 'discord', null])
    expect(new Set(pairs.map(([id, origin, source]) => `${id} ${origin} ${source}`)).size).toBe(2)
  })

  it("answers a reply of the site's whole source, past what its content holds", async () => {
    // The content is cut to what one Discord message holds (the outbox's contentOf); the source is the reply's, up to three of them.
    const long = `${'word '.repeat(2000)}<@200000000000000416>`
    const { pool } = answering([siteRow({ content: long.slice(0, 4000), source: long })])
    const [message] = (await store(pool).listMessages(POST, { limit: 5 })).rows
    expect(message.source).toBe(long)
    expect(message.content).toBe(long.slice(0, 4000))
  })

  it.each(
    labelled(['', ' ', '\u0000', '\uD800', 'null', '__proto__', '<b>bold</b>', '![x](upload:10)', `${'\u{1F600}'.repeat(3000)}`, 'line\r\nline', null]),
  )('passes a source of %s through untouched: the store neither cuts it nor reads it', async (_, source) => {
    const { pool } = answering([siteRow({ source })])
    const [message] = (await store(pool).changes(POST, '5', { limit: 10, slack: 10 })).rows
    expect(message.source).toBe(source)
    expect(message.origin).toBe('site')
  })

  it('answers whatever pair a row holds, on a page and in the changes (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('site', 'discord'), fc.option(fc.string({ maxLength: 60 }), { nil: null }), fc.integer({ min: 0, max: READS.length - 1 }), async (origin, source, which) => {
        const { pool } = answering([dbMessage(SITE, { origin, source })])
        const out = await READS[which][1](store(pool))
        expect(out.rows.length).toBeGreaterThan(0)
        for (const m of out.rows) expect([m.origin, m.source]).toEqual([origin, source])
      }),
      { numRuns: 200 },
    )
  })
})

describe('quotedMessages', () => {
  const SQL =
    'select id, author_id, author_name, author_avatar, left(content, 200) as content from librarius_messages where post_id = $1 and id = any($2::bigint[])'

  it('asks for the named messages of the post in one plain statement, with the first 200 characters of each', async () => {
    const { pool, log, release } = fakePool([[SQL, []]])
    await store(pool).quotedMessages(POST, [MSG, MSG_2])
    expect(log).toEqual([{ sql: SQL, params: [POST, [MSG, MSG_2]] }])
    expect(release).not.toHaveBeenCalled()
  })

  it('answers each stored one as its id, author, name, avatar and start, and leaves out any that is not stored', async () => {
    const { pool } = fakePool([
      [
        SQL,
        [
          { id: MSG_2, author_id: AUTHOR, author_name: 'Test Author', author_avatar: 'https://cdn.discordapp.com/avatars/x.png', content: 'the start' },
          { id: MSG, author_id: OWNER, author_name: 'Other', author_avatar: null, content: '' },
        ],
      ],
    ])
    expect(await store(pool).quotedMessages(POST, [MSG, MSG_2, MSG_3])).toEqual([
      { id: MSG_2, authorId: AUTHOR, authorName: 'Test Author', authorAvatar: 'https://cdn.discordapp.com/avatars/x.png', content: 'the start' },
      { id: MSG, authorId: OWNER, authorName: 'Other', authorAvatar: null, content: '' },
    ])
  })

  it('sends nothing for an empty list', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).quotedMessages(POST, [])).toEqual([])
    expect(log).toEqual([])
  })

  it.each(labelled([undefined, null, MSG, 'abc', {}, 5, new Set([MSG])]))('refuses ids of %s, which is no list, with a TypeError before any query', async (_, list) => {
    const { pool, log } = fakePool()
    const failed = store(pool).quotedMessages(POST, list)
    await expect(failed).rejects.toThrow(TypeError)
    await expect(failed).rejects.toThrow('ids must be a list')
    expect(log).toEqual([])
  })

  it('fails with the pool, so a caller sees it', async () => {
    const { pool } = fakePool([[SQL, boom()]])
    await expect(store(pool).quotedMessages(POST, [MSG])).rejects.toThrow('connection lost')
  })
})

describe('currentRev', () => {
  const SQL =
    'select greatest(coalesce((select max(rev) from librarius_messages where post_id = $1), 0), coalesce((select max(rev) from librarius_tombstones where post_id = $1), 0)) as rev'

  it("answers the highest number any stored message or delete note of the post holds, so nothing in flight is skipped, and asks for that post's alone", async () => {
    const { pool, log, release } = fakePool([['select greatest', [{ rev: '4812' }]]])
    expect(await store(pool).currentRev(POST)).toBe('4812')
    expect(log).toEqual([{ sql: SQL, params: [POST] }])
    expect(release).not.toHaveBeenCalled()
  })

  it('asks for the post it was given, whichever it is (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 10n ** 16n, max: 9223372036854775807n }), async (id) => {
        const { pool, log } = fakePool([['select greatest', [{ rev: '1' }]]])
        await store(pool).currentRev(String(id))
        expect(log.map((l) => l.params)).toEqual([[String(id)]])
      }),
    )
  })

  it('answers 0 for a post with nothing in it, as text', async () => {
    const { pool } = fakePool([['greatest', [{ rev: '0' }]]])
    expect(await store(pool).currentRev(POST)).toBe('0')
  })
})

describe('setRead', () => {
  it('writes the read mark, never lowering it, and never for a post that is gone', async () => {
    const { pool, log, release } = fakePool()
    expect(await store(pool).setRead(MEMBER, POST, MSG)).toBeUndefined()
    expect(log).toEqual([
      {
        sql:
          'insert into librarius_reads (member_id, post_id, last_read) select $1::bigint, $2::bigint, $3::bigint ' +
          'where exists (select 1 from librarius_posts where id = $2) ' +
          'on conflict (member_id, post_id) do update set last_read = greatest(librarius_reads.last_read, excluded.last_read)',
        params: [MEMBER, POST, MSG],
      },
    ])
    expect(release).not.toHaveBeenCalled()
  })
})

describe('markViewed', () => {
  it('stamps the time of the view', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).markViewed(POST)).toBeUndefined()
    expect(log).toEqual([{ sql: 'update librarius_posts set viewed_at = now() where id = $1', params: [POST] }])
  })
})

describe('importCursor and setImportCursor', () => {
  it('reads the newest message the import has stored for a post, as text', async () => {
    const { pool, log } = fakePool([['select import_cursor', [{ import_cursor: MSG }]]])
    expect(await store(pool).importCursor(POST)).toBe(MSG)
    expect(log).toEqual([{ sql: 'select import_cursor from librarius_posts where id = $1', params: [POST] }])
  })

  it('is null before the import has begun, and for a post that is not stored', async () => {
    expect(await store(fakePool([['select import_cursor', [{ import_cursor: null }]]]).pool).importCursor(POST)).toBeNull()
    expect(await store(fakePool().pool).importCursor(POST)).toBeNull()
  })

  it('sets the cursor', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).setImportCursor(POST, MSG)).toBeUndefined()
    expect(log).toEqual([{ sql: 'update librarius_posts set import_cursor = $2 where id = $1', params: [POST, MSG] }])
  })
})

describe('windowIds', () => {
  const WINDOW =
    "select m.id, m.edited_at, case when m.state = 'sending' then '{}'::text[] " +
    'else array(select p.discord_id::text from librarius_parts p where p.message_id = m.id and p.part_index > 0 order by p.part_index) end as parts ' +
    'from librarius_messages m where m.post_id = $1 order by m.id desc limit $2'

  it('answers the newest ids with their edit times and their later parts, newest first', async () => {
    const { pool, log } = fakePool([
      [
        'from librarius_messages',
        [
          { id: MSG_3, edited_at: null, parts: [ATT, ATT_2] },
          { id: MSG_2, edited_at: new Date('2026-11-02T19:00:00.000Z'), parts: [] },
          { id: MSG, edited_at: null, parts: [ATT] },
        ],
      ],
    ])
    expect(await store(pool).windowIds(POST, 100)).toEqual([
      { id: MSG_3, editedAt: null, parts: [ATT, ATT_2] },
      { id: MSG_2, editedAt: '2026-11-02T19:00:00.000Z', parts: [] },
      { id: MSG, editedAt: null, parts: [ATT] },
    ])
    expect(log).toEqual([{ sql: WINDOW, params: [POST, 100] }])
  })

  it('is empty for a post with no messages', async () => {
    const { pool } = fakePool()
    expect(await store(pool).windowIds(POST, 5)).toEqual([])
  })

  it.each([0, -1, 1.5, '5', NaN, null, undefined, Infinity, 2 ** 53, true])('refuses a limit of %j with a RangeError before any query', async (limit) => {
    const { pool, log } = fakePool()
    const failed = store(pool).windowIds(POST, limit)
    await expect(failed).rejects.toThrow(RangeError)
    await expect(failed).rejects.toThrow('limit must be a whole number from 1 to')
    expect(log).toEqual([])
  })

  it('takes a limit of 1 and of 1000', async () => {
    for (const limit of [1, 1000]) {
      const { pool, log } = fakePool()
      await store(pool).windowIds(POST, limit)
      expect(log[0].params[1]).toBe(limit)
    }
  })
})

describe('syncStatus and setSync', () => {
  it('reads the single row, with its times as ISO text', async () => {
    const { pool, log } = fakePool([
      [
        'from librarius_sync',
        [{ import_done: true, last_run_at: new Date('2026-11-15T10:00:00.000Z'), last_ok_at: new Date('2026-11-15T09:00:00.000Z'), last_error: 'Discord could not be reached' }],
      ],
    ])
    expect(await store(pool).syncStatus()).toEqual({
      importDone: true,
      lastRunAt: '2026-11-15T10:00:00.000Z',
      lastOkAt: '2026-11-15T09:00:00.000Z',
      lastError: 'Discord could not be reached',
    })
    expect(log).toEqual([{ sql: 'select import_done, last_run_at, last_ok_at, last_error from librarius_sync where id = 1', params: undefined }])
  })

  it('answers the empty state before any run has written the row', async () => {
    const { pool } = fakePool()
    expect(await store(pool).syncStatus()).toEqual({ importDone: false, lastRunAt: null, lastOkAt: null, lastError: null })
  })

  it('answers nulls for a row whose times are not set', async () => {
    const { pool } = fakePool([['from librarius_sync', [{ import_done: false, last_run_at: null, last_ok_at: null, last_error: null }]]])
    expect(await store(pool).syncStatus()).toEqual({ importDone: false, lastRunAt: null, lastOkAt: null, lastError: null })
  })

  describe('setSync', () => {
    it('writes only the columns given, in the order given, as parameters', async () => {
      const { pool, log, release } = fakePool()
      const at = new Date('2026-11-15T10:00:00.000Z')
      expect(await store(pool).setSync({ import_done: true, last_ok_at: at, last_error: null })).toBeUndefined()
      expect(log).toEqual([
        {
          sql:
            'insert into librarius_sync (id, import_done, last_ok_at, last_error) values (1, $1, $2, $3) ' +
            'on conflict (id) do update set import_done = excluded.import_done, last_ok_at = excluded.last_ok_at, last_error = excluded.last_error',
          params: [true, at, null],
        },
      ])
      expect(release).not.toHaveBeenCalled()
    })

    it.each(['import_done', 'last_run_at', 'last_ok_at', 'last_error'])('takes %s on its own', async (column) => {
      const { pool, log } = fakePool()
      await store(pool).setSync({ [column]: null })
      expect(log[0].sql).toBe(
        `insert into librarius_sync (id, ${column}) values (1, $1) on conflict (id) do update set ${column} = excluded.${column}`,
      )
    })

    it.each([
      'id',
      'importDone',
      'IMPORT_DONE',
      'last_error; drop table librarius_posts',
      'last_error) values (1); --',
      '',
      ' last_error',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'length',
    ])('refuses a column of %j with a TypeError before any query, whatever sits beside a good one', async (column) => {
      const { pool, log } = fakePool()
      const patch = Object.defineProperty({ last_error: null }, column, { value: 1, enumerable: true })
      await expect(store(pool).setSync(patch)).rejects.toThrow(TypeError)
      await expect(store(pool).setSync(patch)).rejects.toThrow(`setSync: not a librarius_sync column: ${column}`)
      expect(log).toEqual([])
    })

    it('refuses a patch that is not an object, and an empty one, and says which', async () => {
      for (const bad of [null, undefined, 'last_error', 5, true, [], [true]]) {
        const { pool, log } = fakePool()
        await expect(store(pool).setSync(bad)).rejects.toThrow('setSync: patch must be an object')
        expect(log).toEqual([])
      }
      const { pool, log } = fakePool()
      await expect(store(pool).setSync({})).rejects.toThrow('setSync: nothing to set')
      expect(log).toEqual([])
    })

    it('refuses an undefined value, which pg would send as null and clear the column', async () => {
      const { pool, log } = fakePool()
      await expect(store(pool).setSync({ import_done: true, last_error: undefined })).rejects.toThrow('setSync: last_error is undefined (use null to clear it)')
      expect(log).toEqual([])
    })

    it('sends only allowed column names in the statement, whatever the keys (property)', async () => {
      await fc.assert(
        fc.asyncProperty(fc.dictionary(fc.oneof(fc.constantFrom('import_done', 'last_run_at', 'last_ok_at', 'last_error'), fc.string()), fc.constantFrom(null, true, 'x')), async (patch) => {
          const { pool, log } = fakePool()
          const keys = Object.keys(patch)
          const allowed = ['import_done', 'last_run_at', 'last_ok_at', 'last_error']
          if (keys.length > 0 && keys.every((k) => allowed.includes(k))) {
            await store(pool).setSync(patch)
            expect(log[0].sql).toBe(
              `insert into librarius_sync (id, ${keys.join(', ')}) values (1, ${keys.map((_, i) => `$${i + 1}`).join(', ')}) on conflict (id) do update set ${keys.map((k) => `${k} = excluded.${k}`).join(', ')}`,
            )
            expect(log[0].params).toEqual(keys.map((k) => patch[k]))
          } else {
            await expect(store(pool).setSync(patch)).rejects.toThrow(TypeError)
            expect(log).toEqual([])
          }
        }),
      )
    })
  })
})

describe('attachmentsToRefresh', () => {
  const SQL =
    'select a.id, a.url from librarius_attachments a join librarius_messages m on m.id = a.message_id join librarius_posts p on p.id = m.post_id ' +
    'where p.viewed_at >= $2 and a.expires_at < $1 order by a.expires_at limit $3'

  it('asks for the links of posts viewed since the given time that expire before the other, soonest first', async () => {
    const { pool, log, release } = fakePool([['from librarius_attachments a', [{ id: ATT, url: 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=1' }, { id: ATT_2, url: 'https://cdn.discordapp.com/attachments/1/2/b.png?ex=2' }]]])
    const out = await store(pool).attachmentsToRefresh({
      expiringBefore: new Date('2026-11-15T12:00:00.000Z'),
      viewedSince: '2026-11-14T12:00:00.000Z',
      limit: 200,
    })
    expect(out).toEqual([
      { id: ATT, url: 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=1' },
      { id: ATT_2, url: 'https://cdn.discordapp.com/attachments/1/2/b.png?ex=2' },
    ])
    expect(log).toEqual([{ sql: SQL, params: ['2026-11-15T12:00:00.000Z', '2026-11-14T12:00:00.000Z', 200] }])
    expect(release).not.toHaveBeenCalled()
  })

  it('takes a time as a Date, an ISO text or epoch milliseconds, and sends it as ISO text', async () => {
    const at = '2026-11-15T12:00:00.000Z'
    for (const v of [new Date(at), at, Date.parse(at)]) {
      const { pool, log } = fakePool()
      await store(pool).attachmentsToRefresh({ expiringBefore: v, viewedSince: v, limit: 1 })
      expect(log[0].params).toEqual([at, at, 1])
    }
  })

  it('is empty when nothing is due', async () => {
    const { pool } = fakePool()
    expect(await store(pool).attachmentsToRefresh({ expiringBefore: 0, viewedSince: 0, limit: 1 })).toEqual([])
  })

  it.each([null, undefined, 'tomorrow', '', NaN, Infinity, {}, [], true, new Date(NaN), 8.64e15 + 1])('refuses a time of %j with a TypeError before any query', async (bad) => {
    for (const field of ['expiringBefore', 'viewedSince']) {
      const { pool, log } = fakePool()
      const opts = { expiringBefore: 0, viewedSince: 0, limit: 1, [field]: bad }
      await expect(store(pool).attachmentsToRefresh(opts)).rejects.toThrow(`${field} must be a Date, an ISO time or epoch milliseconds`)
      expect(log).toEqual([])
    }
  })

  it.each([0, -1, 1.5, '5', NaN, null, undefined, Infinity, 2 ** 53])('refuses a limit of %j with a RangeError before any query', async (limit) => {
    const { pool, log } = fakePool()
    const failed = store(pool).attachmentsToRefresh({ expiringBefore: 0, viewedSince: 0, limit })
    await expect(failed).rejects.toThrow(RangeError)
    await expect(failed).rejects.toThrow('limit must be a whole number from 1 to')
    expect(log).toEqual([])
  })

  it('refuses no options at all', async () => {
    const { pool, log } = fakePool()
    await expect(store(pool).attachmentsToRefresh()).rejects.toThrow(TypeError)
    await expect(store(pool).attachmentsToRefresh(null)).rejects.toThrow(TypeError)
    expect(log).toEqual([])
  })
})

describe('updateAttachmentUrls', () => {
  const SQL =
    'update librarius_attachments a set url = u.url, expires_at = u.expires_at ' +
    'from unnest($1::bigint[], $2::text[], $3::timestamptz[]) as u (id, url, expires_at) where a.id = u.id'
  const url = (n) => `https://cdn.discordapp.com/attachments/1/2/f${n}.png?ex=6540a0b3&is=1&hm=2`

  it('replaces the link and expiry of every attachment in one statement', async () => {
    const { pool, log, release } = fakePool()
    expect(
      await store(pool).updateAttachmentUrls([
        { id: ATT, url: url(1), expiresAt: '2026-11-16T10:00:00.000Z' },
        { id: ATT_2, url: url(2), expiresAt: null },
      ]),
    ).toBeUndefined()
    expect(log).toEqual([{ sql: SQL, params: [[ATT, ATT_2], [url(1), url(2)], ['2026-11-16T10:00:00.000Z', null]] }])
    expect(release).not.toHaveBeenCalled()
  })

  it('takes the expiry as a Date and sends it as ISO text', async () => {
    const { pool, log } = fakePool()
    await store(pool).updateAttachmentUrls([{ id: ATT, url: url(1), expiresAt: new Date('2026-11-16T10:00:00.000Z') }])
    expect(log[0].params[2]).toEqual(['2026-11-16T10:00:00.000Z'])
  })

  it('sends nothing for an empty list', async () => {
    const { pool, log } = fakePool()
    expect(await store(pool).updateAttachmentUrls([])).toBeUndefined()
    expect(log).toEqual([])
  })

  it.each([undefined, null, ATT, new Set()])('refuses %j, which is not a list', async (bad) => {
    const { pool, log } = fakePool()
    await expect(store(pool).updateAttachmentUrls(bad)).rejects.toThrow('updates must be a list')
    expect(log).toEqual([])
  })

  const NOT_CDN = "url must be a link on Discord's CDN attachments path"

  it.each(
    labelled([
      undefined,
      null,
      '',
      5,
      {},
      [],
      ' ',
      'x',
      'https://x.test/',
      'https://cdn.discordapp.com/attachments',
      'https://cdn.discordapp.com/',
      'http://cdn.discordapp.com/attachments/1/2/f.png?ex=6540a0b3',
      'HTTPS://CDN.DISCORDAPP.COM/attachments/1/2/f.png?ex=6540a0b3',
      ' https://cdn.discordapp.com/attachments/1/2/f.png?ex=6540a0b3',
      'https://cdn.discordapp.com.evil.test/attachments/1/2/f.png?ex=6540a0b3',
      'https://cdn.discordapp.com@evil.test/attachments/1/2/f.png',
      'https://evil.test/https://cdn.discordapp.com/attachments/1/2/f.png',
      'https://cdn.discordapp.com:444/attachments/1/2/f.png',
      'https://cdn.discordapp.com/attachments/../avatars/1/f.png',
      'https://cdn.discordapp.com/attachments/%2e%2e/avatars/1/f.png',
      'https://cdn.discordapp.com/attachments/1/../../avatars/1/f.png',
      'https://cdn.discordapp.com/avatars/1/f.png',
      'https://media.discordapp.net/attachments/1/2/f.png?ex=6540a0b3',
      'ftp://cdn.discordapp.com/attachments/1/2/f.png',
      'javascript:alert(1)',
      'data:text/html,x',
      '//cdn.discordapp.com/attachments/1/2/f.png',
    ]),
  )('refuses a url of %s before any query: only a link on the CDN attachments path may be stored', async (_, bad) => {
    const { pool, log } = fakePool()
    const failed = store(pool).updateAttachmentUrls([{ id: ATT, url: url(1), expiresAt: null }, { id: ATT_2, url: bad, expiresAt: null }])
    await expect(failed).rejects.toThrow(TypeError)
    await expect(failed).rejects.toThrow(NOT_CDN)
    expect(log).toEqual([])
  })

  it('takes a link on the CDN attachments path, whatever follows it', async () => {
    for (const good of [url(1), 'https://cdn.discordapp.com/attachments/1/2/f.png', 'https://cdn.discordapp.com/attachments/1/2/f%20g.png?ex=6540a0b3&is=1&hm=2#top', 'https://cdn.discordapp.com/attachments/']) {
      const { pool, log } = fakePool()
      await store(pool).updateAttachmentUrls([{ id: ATT, url: good, expiresAt: null }])
      expect(log).toHaveLength(1)
      expect(log[0].params[1]).toEqual([good])
    }
  })

  it('stores the link as the check normalises it, so that what is kept is what was judged (and what parseMessage would keep)', async () => {
    const written = [
      'https://cdn.discordapp.com/attachments/1/2/a file.png?ex=6540a0b3',
      'https://cdn.discordapp.com/attachments/\\..\\x/f.png',
      'https://cdn.discordapp.com/attachments/1/./2/f.png',
    ]
    const { pool, log } = fakePool()
    await store(pool).updateAttachmentUrls(written.map((link, i) => ({ id: [ATT, ATT_2, MSG][i], url: link, expiresAt: null })))
    expect(log[0].params[1]).toEqual([
      'https://cdn.discordapp.com/attachments/1/2/a%20file.png?ex=6540a0b3',
      'https://cdn.discordapp.com/attachments/x/f.png',
      'https://cdn.discordapp.com/attachments/1/2/f.png',
    ])
    expect(log[0].params[1]).toEqual(written.map((link) => attachmentUrl(link)))
  })

  it('judges a link as parseMessage does, whatever it holds (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('https://cdn.discordapp.com/attachments/', 'https://cdn.discordapp.com/', 'https://x.test/'), fc.string({ maxLength: 40 }), async (head, tail) => {
        const link = head + tail
        const { pool, log } = fakePool()
        const done = store(pool).updateAttachmentUrls([{ id: ATT, url: link, expiresAt: null }])
        if (attachmentUrl(link) === null) {
          await expect(done).rejects.toThrow(NOT_CDN)
          expect(log).toEqual([])
        } else {
          await done
          expect(log).toHaveLength(1)
          expect(log[0].params[1]).toEqual([attachmentUrl(link)])
        }
      }),
    )
  })

  it('checks the id of an entry before its link', async () => {
    const { pool } = fakePool()
    await expect(store(pool).updateAttachmentUrls([{ id: 'x', url: 'https://x.test/', expiresAt: null }])).rejects.toThrow('attachment id must be a snowflake')
  })

  it.each([undefined, 'soon', NaN, {}, true])('refuses an expiry of %j (null is allowed, undefined is not) before any query', async (bad) => {
    const { pool, log } = fakePool()
    await expect(store(pool).updateAttachmentUrls([{ id: ATT, url: url(1), expiresAt: bad }])).rejects.toThrow(
      'expiresAt must be a Date, an ISO time or epoch milliseconds',
    )
    expect(log).toEqual([])
  })

  it('refuses an entry that is not an object', async () => {
    for (const bad of [null, undefined, 'x', 5]) {
      const { pool, log } = fakePool()
      await expect(store(pool).updateAttachmentUrls([bad])).rejects.toThrow(TypeError)
      expect(log).toEqual([])
    }
  })
})

describe('pruneTombstones', () => {
  it('deletes the notes older than the time, as one statement', async () => {
    const { pool, log, release } = fakePool()
    expect(await store(pool).pruneTombstones(new Date('2026-11-14T10:00:00.000Z'))).toBeUndefined()
    expect(log).toEqual([{ sql: 'delete from librarius_tombstones where deleted_at < $1', params: ['2026-11-14T10:00:00.000Z'] }])
    expect(release).not.toHaveBeenCalled()
  })

  it('takes an ISO text and epoch milliseconds too', async () => {
    for (const v of ['2026-11-14T10:00:00.000Z', Date.parse('2026-11-14T10:00:00.000Z')]) {
      const { pool, log } = fakePool()
      await store(pool).pruneTombstones(v)
      expect(log[0].params).toEqual(['2026-11-14T10:00:00.000Z'])
    }
  })

  it.each([null, undefined, 'yesterday', '', NaN, {}, true])('refuses a time of %j with a TypeError before any query, which would otherwise delete nothing or everything', async (bad) => {
    const { pool, log } = fakePool()
    await expect(store(pool).pruneTombstones(bad)).rejects.toThrow('before must be a Date, an ISO time or epoch milliseconds')
    expect(log).toEqual([])
  })
})

describe('every statement', () => {
  it('holds no caller text: a hostile value in any argument only ever travels as a parameter', async () => {
    const hostile = "x'); drop table librarius_posts; --"
    const calls = [
      (s) => s.upsertPost(post({ title: hostile, tagIds: [hostile] })),
      (s) => s.upsertMessages([message({ authorName: hostile, content: hostile, authorAvatar: hostile, attachments: [attachment({ filename: hostile, url: hostile })] })]),
      (s) => s.adjustReaction(MSG, { id: null, name: 'x' }, 1),
      (s) => s.updateAttachmentUrls([{ id: ATT, url: `https://cdn.discordapp.com/attachments/${hostile}`, expiresAt: null }]),
      (s) => s.setSync({ last_error: hostile }),
    ]
    for (const call of calls) {
      const { pool, log } = revPool([
        ['insert into librarius_messages', [{ id: MSG }]],
        ['select reactions', [{ reactions: [] }]],
      ])
      await call(store(pool))
      for (const { sql } of log) {
        expect(sql).not.toContain('drop table')
        expect(sql).not.toContain(hostile)
      }
    }
  })
})
