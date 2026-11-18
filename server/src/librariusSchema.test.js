import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Postgres enforces these on the e2e stack (a fresh database built from schema.sql); here the text is pinned, as the
// Reliquarium's tables are in galleryStore.test.js: idempotent statements, and the columns the store relies on.
const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

/** The text between `create table if not exists <name> (` and its closing `);`, or '' when the table is not there. */
const tableBody = (name) => new RegExp(`create table if not exists ${name} \\(([\\s\\S]*?)\\r?\\n\\);`).exec(sql)?.[1] ?? ''

/** → { column: 'its definition, as written' } for the column lines of a table body; table-level lines are left out. */
function columnsOf(body) {
  const out = {}
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/,$/, '')
    if (line === '' || line.startsWith('--')) continue
    const [name, ...rest] = line.split(/\s+/)
    if (['primary', 'foreign', 'check', 'unique', 'constraint'].includes(name)) continue
    out[name] = rest.join(' ')
  }
  return out
}

/** The statement `create [unique] index if not exists <name> ... ;`, whitespace collapsed, or '' when it is not there. */
function indexStatement(name) {
  const found = new RegExp(`create index if not exists ${name}\\b([^;]*);`).exec(sql)
  return found === null ? '' : found[0].replace(/\s+/g, ' ')
}

const TABLES = [
  'librarius_posts',
  'librarius_messages',
  'librarius_attachments',
  'librarius_tombstones',
  'librarius_reads',
  'librarius_sync',
  'librarius_outbox',
  'librarius_parts',
  'librarius_uploads',
  'librarius_events',
]

describe('schema.sql Librarius section', () => {
  it('numbers every change in one sequence, created only when missing', () => {
    expect(sql).toContain('create sequence if not exists librarius_rev;')
  })

  it.each(TABLES)('creates %s only when it is missing, exactly once', (name) => {
    expect(sql.match(new RegExp(`create table if not exists ${name} \\(`, 'g'))).toHaveLength(1)
    expect(tableBody(name)).not.toBe('')
  })

  it('creates no Librarius table or index without if not exists, and drops nothing', () => {
    expect(sql).not.toMatch(/create table (?!if not exists)\s*librarius_/)
    expect(sql).not.toMatch(/create (unique )?index (?!if not exists)\s*librarius_/)
    expect(sql).not.toMatch(/create sequence (?!if not exists)\s*librarius_/)
    const section = sql.slice(sql.indexOf('create sequence if not exists librarius_rev;'))
    expect(section).not.toMatch(/\bdrop\s+(table|column|index|sequence|constraint)\b/i)
    expect(section).not.toMatch(/\btruncate\b/i)
  })

  it('heads the section with what it is: a copy of what Discord holds, deleted when Discord deletes, snowflake ids', () => {
    const head = sql.slice(0, sql.indexOf('create sequence if not exists librarius_rev;')).split('\n').slice(-12).join('\n')
    expect(head).toMatch(/Librarius/)
    expect(head).toMatch(/copy of what Discord holds/i)
    expect(head).toMatch(/delete in Discord deletes here/i)
    expect(head).toMatch(/snowflake/i)
  })

  describe('librarius_posts', () => {
    const columns = () => columnsOf(tableBody('librarius_posts'))

    it('has exactly these columns, in this order', () => {
      expect(Object.keys(columns())).toEqual([
        'id',
        'owner_id',
        'title',
        'tag_ids',
        'pinned',
        'locked',
        'archived',
        'created_at',
        'import_cursor',
        'viewed_at',
        'updated_at',
      ])
    })

    it('keys on the thread id, a bigint', () => {
      expect(columns().id).toBe('bigint primary key')
    })

    it.each([
      ['owner_id', 'bigint'],
      ['import_cursor', 'bigint'],
      ['viewed_at', 'timestamptz'],
    ])('lets %s be empty: a thread may have lost its owner, an import may not have begun, a post may be unopened', (name, type) => {
      expect(columns()[name]).toBe(type)
    })

    it('needs a title and a creation time', () => {
      expect(columns().title).toBe('text not null')
      expect(columns().created_at).toBe('timestamptz not null')
    })

    it("holds its tags as text ids, none by default, so a post with no tags is '{}' and never null", () => {
      expect(columns().tag_ids).toBe("text[] not null default '{}'")
    })

    it.each(['pinned', 'locked', 'archived'])('%s is a flag, off by default, never null', (name) => {
      expect(columns()[name]).toBe('boolean not null default false')
    })

    it('stamps its last change itself', () => {
      expect(columns().updated_at).toBe('timestamptz not null default now()')
    })
  })

  describe('librarius_messages', () => {
    const body = () => tableBody('librarius_messages')
    const columns = () => columnsOf(body())

    it('has exactly these columns, in this order', () => {
      expect(Object.keys(columns())).toEqual([
        'id',
        'post_id',
        'author_id',
        'author_name',
        'author_avatar',
        'webhook_id',
        'kind',
        'content',
        'embeds',
        'stickers',
        'reactions',
        'reply_to',
        'created_at',
        'edited_at',
        'rev',
      ])
    })

    it('belongs to a post, and goes with it', () => {
      expect(columns().id).toBe('bigint primary key')
      expect(columns().post_id).toMatch(/^bigint not null references librarius_posts \(id\) on delete cascade$/)
    })

    it('stamps every write with the next number of the shared sequence, so a reader can ask for what changed after one', () => {
      expect(columns().rev).toBe("bigint not null default nextval('librarius_rev')")
    })

    it('needs an author, a kind, a text and a time', () => {
      expect(columns().author_id).toBe('bigint not null')
      expect(columns().author_name).toBe('text not null')
      expect(columns().kind).toBe('smallint not null')
      expect(columns().content).toBe('text not null')
      expect(columns().created_at).toBe('timestamptz not null')
    })

    it.each([
      ['author_avatar', 'text'],
      ['webhook_id', 'bigint'],
      ['reply_to', 'bigint'],
      ['edited_at', 'timestamptz'],
    ])('lets %s be empty', (name, type) => {
      expect(columns()[name]).toBe(type)
    })

    it.each(['embeds', 'stickers', 'reactions'])("holds %s as a json list, empty by default and never null", (name) => {
      expect(columns()[name]).toBe("jsonb not null default '[]'")
    })

    it('does not make a reply depend on the replied-to message being stored: reply_to has no foreign key', () => {
      expect(columns().reply_to).not.toMatch(/references/)
    })
  })

  describe('librarius_attachments', () => {
    const columns = () => columnsOf(tableBody('librarius_attachments'))

    it('has exactly these columns, in this order', () => {
      expect(Object.keys(columns())).toEqual([
        'id',
        'message_id',
        'position',
        'filename',
        'content_type',
        'size',
        'width',
        'height',
        'url',
        'proxy_url',
        'expires_at',
      ])
    })

    it('belongs to a message, and goes with it', () => {
      expect(columns().id).toBe('bigint primary key')
      expect(columns().message_id).toMatch(/^bigint not null references librarius_messages \(id\) on delete cascade$/)
    })

    it('keeps the order Discord listed them in', () => {
      expect(columns().position).toMatch(/^smallint not null\b/)
    })

    it('needs a name, a size and a link', () => {
      expect(columns().filename).toBe('text not null')
      expect(columns().size).toBe('integer not null')
      expect(columns().url).toBe('text not null')
    })

    it.each([
      ['content_type', 'text'],
      ['width', 'integer'],
      ['height', 'integer'],
      ['proxy_url', 'text'],
      ['expires_at', 'timestamptz'],
    ])('lets %s be empty', (name, type) => {
      expect(columns()[name]).toBe(type)
    })
  })

  describe('librarius_tombstones', () => {
    const columns = () => columnsOf(tableBody('librarius_tombstones'))

    it('has exactly these columns, in this order', () => {
      expect(Object.keys(columns())).toEqual(['message_id', 'post_id', 'rev', 'deleted_at'])
    })

    it('holds ids and no foreign key, since the message it names is gone', () => {
      expect(columns().message_id).toBe('bigint not null')
      expect(columns().post_id).toBe('bigint not null')
      expect(tableBody('librarius_tombstones')).not.toMatch(/references/)
    })

    it('is numbered by the same sequence as the messages', () => {
      expect(columns().rev).toBe("bigint not null default nextval('librarius_rev')")
    })

    it('notes when the delete happened', () => {
      expect(columns().deleted_at).toBe('timestamptz not null default now()')
    })
  })

  describe('librarius_reads', () => {
    const body = () => tableBody('librarius_reads')
    const columns = () => columnsOf(body())

    it('has exactly these columns, in this order', () => {
      expect(Object.keys(columns())).toEqual(['member_id', 'post_id', 'last_read'])
    })

    it('is one row per member and post', () => {
      expect(body()).toMatch(/primary key \(member_id, post_id\)/)
    })

    it('goes with its post', () => {
      expect(columns().member_id).toBe('bigint not null')
      expect(columns().post_id).toMatch(/^bigint not null references librarius_posts \(id\) on delete cascade$/)
    })

    it('always names a message', () => {
      expect(columns().last_read).toBe('bigint not null')
    })
  })

  describe('librarius_sync', () => {
    const columns = () => columnsOf(tableBody('librarius_sync'))

    it('has exactly these columns, in this order', () => {
      expect(Object.keys(columns())).toEqual(['id', 'import_done', 'last_run_at', 'last_ok_at', 'last_error'])
    })

    it('is a single row: the id is 1 and nothing else is allowed', () => {
      expect(columns().id).toBe('smallint primary key default 1 check (id = 1)')
    })

    it('starts with no import done, and no run recorded', () => {
      expect(columns().import_done).toBe('boolean not null default false')
      expect(columns().last_run_at).toBe('timestamptz')
      expect(columns().last_ok_at).toBe('timestamptz')
      expect(columns().last_error).toBe('text')
    })
  })

  describe('librarius_outbox', () => {
    const columns = () => columnsOf(tableBody('librarius_outbox'))

    it('has exactly these columns, in this order', () => {
      expect(Object.keys(columns())).toEqual(['id', 'kind', 'message_key', 'author_id', 'payload', 'state', 'attempts', 'next_at', 'last_error', 'created_at'])
    })

    it('numbers its rows, so the oldest is the first to go', () => {
      expect(columns().id).toBe('bigserial primary key')
    })

    it('is a reply, an edit or a delete, and nothing else', () => {
      expect(columns().kind).toBe("text not null check (kind in ('send', 'edit', 'delete'))")
    })

    it('begins pending and is in one of five states', () => {
      expect(columns().state).toBe("text not null default 'pending' check (state in ('pending', 'sending', 'sent', 'blocked', 'failed'))")
    })

    it('needs a key, an author and a payload', () => {
      expect(columns().message_key).toBe('text not null')
      expect(columns().author_id).toBe('bigint not null')
      expect(columns().payload).toBe('jsonb not null')
    })

    it('has tried nothing yet and is due at once', () => {
      expect(columns().attempts).toBe('int not null default 0')
      expect(columns().next_at).toBe('timestamptz not null default now()')
    })

    it('lets last_error be empty, and stamps its creation', () => {
      expect(columns().last_error).toBe('text')
      expect(columns().created_at).toBe('timestamptz not null default now()')
    })
  })

  describe('librarius_parts', () => {
    const body = () => tableBody('librarius_parts')
    const columns = () => columnsOf(body())

    it('has exactly these columns, in this order', () => {
      expect(Object.keys(columns())).toEqual(['message_id', 'part_index', 'discord_id'])
    })

    it('knows a Discord message as one part only', () => {
      expect(columns().discord_id).toBe('bigint primary key')
    })

    it('has one part at each place of a reply', () => {
      expect(body()).toMatch(/unique \(message_id, part_index\)/)
      expect(columns().message_id).toBe('bigint not null')
      expect(columns().part_index).toBe('smallint not null')
    })

    it('has no foreign key: its message is only stored when its last part has been sent', () => {
      expect(body()).not.toMatch(/references/)
    })
  })

  describe('librarius_uploads', () => {
    const columns = () => columnsOf(tableBody('librarius_uploads'))

    it('has exactly these columns, in this order', () => {
      expect(Object.keys(columns())).toEqual(['id', 'author_id', 'name', 'content_type', 'bytes', 'created_at'])
    })

    it('holds the picture itself, whose author, name and type are known', () => {
      expect(columns().id).toBe('bigserial primary key')
      expect(columns().author_id).toBe('bigint not null')
      expect(columns().name).toBe('text not null')
      expect(columns().content_type).toBe('text not null')
      expect(columns().bytes).toBe('bytea not null')
      expect(columns().created_at).toBe('timestamptz not null default now()')
    })
  })

  describe('librarius_events', () => {
    const columns = () => columnsOf(tableBody('librarius_events'))

    it('has exactly these columns, in this order', () => {
      expect(Object.keys(columns())).toEqual(['id', 'at', 'actor_id', 'action', 'post_id', 'message_id', 'note'])
    })

    it('names who did what, and when', () => {
      expect(columns().id).toBe('bigserial primary key')
      expect(columns().at).toBe('timestamptz not null default now()')
      expect(columns().actor_id).toBe('bigint not null')
      expect(columns().action).toBe('text not null')
    })

    it('lets the post, the message and the note be empty', () => {
      expect(columns().post_id).toBe('bigint')
      expect(columns().message_id).toBe('bigint')
      expect(columns().note).toBe('text')
    })
  })

  describe('what a site message adds to librarius_messages', () => {
    /** The statement `alter table librarius_messages add column if not exists <name> ...;`, whitespace collapsed, or ''. */
    const added = (name) => {
      const found = new RegExp(`alter table librarius_messages add column if not exists ${name}\\b([^;]*);`).exec(sql)
      return found === null ? '' : found[0].replace(/\s+/g, ' ')
    }

    it('adds each column only when it is missing, as its own statement, and leaves the batch 1 table as it was', () => {
      for (const name of ['origin', 'source', 'state', 'layout']) expect(added(name)).not.toBe('')
      expect(sql.match(/alter table librarius_messages\b/g)).toHaveLength(4)
      expect(Object.keys(columnsOf(tableBody('librarius_messages')))).not.toContain('origin')
    })

    it('says who made a message, a person in Discord unless the outbox did', () => {
      expect(added('origin')).toBe("alter table librarius_messages add column if not exists origin text not null default 'discord' check (origin in ('discord', 'site'));")
    })

    it('keeps the markdown and the layout of a site message, empty for the others', () => {
      expect(added('source')).toBe('alter table librarius_messages add column if not exists source text;')
      expect(added('layout')).toBe('alter table librarius_messages add column if not exists layout jsonb;')
    })

    it('has a state that is empty, sending or blocked', () => {
      expect(added('state')).toBe("alter table librarius_messages add column if not exists state text check (state in ('sending', 'blocked'));")
    })
  })

  describe('indexes', () => {
    it.each([
      ['librarius_messages_post_idx', 'on librarius_messages (post_id, id)'],
      ['librarius_messages_rev_idx', 'on librarius_messages (post_id, rev)'],
      ['librarius_tombstones_rev_idx', 'on librarius_tombstones (post_id, rev)'],
      ['librarius_attachments_message_idx', 'on librarius_attachments (message_id)'],
      ['librarius_attachments_expires_idx', 'on librarius_attachments (expires_at)'],
      ['librarius_outbox_due_idx', "on librarius_outbox (next_at) where state = 'pending'"],
      ['librarius_outbox_key_idx', 'on librarius_outbox (message_key)'],
      ['librarius_events_action_idx', 'on librarius_events (action, at)'],
    ])('%s is created only when missing, %s', (name, target) => {
      const statement = indexStatement(name)
      expect(statement).not.toBe('')
      expect(statement).toContain(` ${target};`)
    })

    it('has no other Librarius index than those eight, and none that is unique', () => {
      expect(sql.match(/create (unique )?index if not exists librarius_\w+/g)).toHaveLength(8)
      expect(sql).not.toMatch(/create unique index if not exists librarius_/)
    })
  })
})
