/**
 * What the Librarius needs to know about the guild and its forum to judge who may read the forum, and to show it: the
 * guild's owner and roles, the forum's permission overwrites and tags, and the guild's custom emoji. Each is read from
 * Discord (librariusDiscord.js) and kept for a while, so that a request costs no call to Discord.
 *
 * facts() → { ownerId, roles: [{ id, permissions, name, color }], overwrites: [{ id, type, allow, deny }],
 *   tags: [{ id, name }] }. `ownerId` is null when Discord names none that is an id; `permissions`, `allow` and `deny`
 *   are strings of digits, and `color` is `#rrggbb`, or null for a role with none. What a caller gets is its own copy.
 * emoji() → [{ id, name, animated }], the guild's custom emoji (librariusParse.js parseEmoji).
 * automodRules() → the guild's AutoMod rules as Discord gives them (a list of objects), which a reply from the site is checked
 *   against (librariusSend.js automodMatcher). Held as a slot of its own, and not with the facts: reading them needs a right
 *   the facts do not (the bot's Manage Server), and a read that fails must fail the writes that need the rules, never the reads
 *   that only need the facts. Something that is not a list of objects is Upstream, as anything else that is not usable.
 * invalidate(kind) forgets what is held of 'guild', 'forum', 'emoji' or 'rules', so that the next call reads it again. Any other
 *   kind is a TypeError, and forgets nothing. An AutoMod event forgets only the 'rules'.
 * setEmoji(rawList) replaces the emoji with Discord's own list of them, as a live event carries it. Something that is
 *   not a list says nothing about the emoji, so it only forgets them, as invalidate('emoji') does.
 *
 * The guild, the forum and the rules are three reads, each kept for `ttlMs` from when it was made, and the emoji a fourth, for
 * `emojiTtlMs`. Callers who come while a read is in flight share it. A failed read is Upstream, whether Discord could
 * not be reached or answered with something the Librarius cannot use, and nothing is kept: a copy that has gone stale
 * is never served in its place, since a role taken away must not still open the forum. A forum id that is not an id is
 * the same failure for the forum, with no request.
 *
 * An invalidation that comes while a read is in flight means what that read is about to answer may already be out of
 * date: its callers still get it, but it is not kept, and a caller who comes later reads again rather than joining it.
 * The same goes for setEmoji, which answers the emoji read in flight with something newer.
 *
 * A guild with no list of roles and a forum with no list of overwrites are Upstream rather than empty, because a forum
 * read as having no overwrites would be read as one nobody is shut out of. For the same reason one overwrite that is not
 * the shape Discord documents (an id, a type of 0 or 1, an allow and a deny of digits) makes the whole forum Upstream,
 * not just that overwrite left out: it could be the deny that shuts @everyone out. A role or a tag that is not the shape
 * is left out, since a role lost can only take permissions away, and a role's permission that is not digits counts as
 * none.
 */
import { Upstream } from './discordRoles.js'
import { parseEmoji } from './librariusParse.js'
import { toBits } from './librariusPerms.js'

const SNOWFLAKE = /^\d{17,20}$/
// A permission value as Discord sends it, and as librariusPerms.js toBits reads it.
const PERMISSION = /^\d{1,40}$/
const MAX_COLOR = 0xffffff
// Overwrite types, as Discord numbers them: a role's or a member's.
const KINDS = [0, 1]

const isId = (v) => typeof v === 'string' && SNOWFLAKE.test(v)
const isPermission = (v) => typeof v === 'string' && PERMISSION.test(v)
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const unusable = (what) => new Upstream(`Discord answered 200 for ${what}, but not with what the Librarius expected.`)

// A permission value as the digits of its number: what a role or an overwrite grants, or '0' when it is no number.
const digits = (v) => String(toBits(v))

function colorOf(v) {
  return Number.isInteger(v) && v > 0 && v <= MAX_COLOR ? `#${v.toString(16).padStart(6, '0')}` : null
}

function roleOf(r) {
  if (!isObject(r) || !isId(r.id)) return null
  return { id: r.id, permissions: digits(r.permissions), name: typeof r.name === 'string' ? r.name : '', color: colorOf(r.color) }
}

// An overwrite is never skipped, since the one left out could be a deny: a forum read without it could be open to all.
function overwriteOf(o) {
  if (!isObject(o) || !isId(o.id) || !KINDS.includes(o.type) || !isPermission(o.allow) || !isPermission(o.deny)) throw unusable('the forum')
  return { id: o.id, type: o.type, allow: digits(o.allow), deny: digits(o.deny) }
}

function parseRules(raw) {
  if (!Array.isArray(raw) || !raw.every(isObject)) throw unusable('the AutoMod rules')
  return raw
}

function tagOf(t) {
  return isObject(t) && isId(t.id) && typeof t.name === 'string' ? { id: t.id, name: t.name } : null
}

// The entries of a list that read as something, in order. Anything that is not a list has none.
const parsed = (list, parse) => (Array.isArray(list) ? list.map(parse).filter((e) => e !== null) : [])

function parseGuild(raw) {
  if (!Array.isArray(raw.roles)) throw unusable('the guild')
  return { ownerId: isId(raw.owner_id) ? raw.owner_id : null, roles: parsed(raw.roles, roleOf) }
}

function parseForum(raw) {
  if (!Array.isArray(raw.permission_overwrites)) throw unusable('the forum')
  return { overwrites: raw.permission_overwrites.map(overwriteOf), tags: parsed(raw.available_tags, tagOf) }
}

/**
 * One thing read from Discord and kept for `ttlMs`. `epoch` is replaced whenever what is held, or about to be, stops
 * being the truth (verdictCache.js does the same): a read that began under another epoch is returned but not kept.
 * `flight` is the read in progress, which a caller joins.
 */
function createSlot({ read, ttlMs, now }) {
  let held = null // { value, until }
  let epoch = {}
  let flight = null // the promise of the read in progress

  async function readOnce(began) {
    const value = await read()
    if (began === epoch) held = { value, until: now() + ttlMs }
    return value
  }

  function get() {
    if (held !== null && now() < held.until) return Promise.resolve(held.value)
    if (flight !== null) return flight
    const promise = readOnce(epoch)
    flight = promise
    // Whether it answered or failed, the read is over: the next call that finds nothing held reads again.
    const over = () => {
      if (flight === promise) flight = null
    }
    promise.then(over, over)
    return promise
  }

  function forget() {
    held = null
    flight = null
    epoch = {}
  }

  function set(value) {
    forget()
    held = { value, until: now() + ttlMs }
  }

  return { get, forget, set }
}

export function createLibrariusGuild({ discord, forumId, ttlMs = 300_000, emojiTtlMs = 600_000, now = Date.now }) {
  const configured = isId(forumId)
  const slots = new Map([
    ['guild', createSlot({ read: async () => parseGuild(await discord.guild()), ttlMs, now })],
    [
      'forum',
      createSlot({
        read: async () => {
          if (!configured) throw new Upstream('The Librarius forum is not configured.')
          return parseForum(await discord.channel(forumId))
        },
        ttlMs,
        now,
      }),
    ],
    ['emoji', createSlot({ read: async () => parseEmoji(await discord.emojis()), ttlMs: emojiTtlMs, now })],
    ['rules', createSlot({ read: async () => parseRules(await discord.autoModRules()), ttlMs, now })],
  ])

  function invalidate(kind) {
    const slot = slots.get(kind)
    if (slot === undefined) throw new TypeError("kind must be 'guild', 'forum', 'emoji' or 'rules'.")
    slot.forget()
  }

  return {
    async facts() {
      const [guild, forum] = await Promise.all([slots.get('guild').get(), slots.get('forum').get()])
      return structuredClone({ ownerId: guild.ownerId, roles: guild.roles, overwrites: forum.overwrites, tags: forum.tags })
    },

    async emoji() {
      return structuredClone(await slots.get('emoji').get())
    },

    async automodRules() {
      return structuredClone(await slots.get('rules').get())
    },

    invalidate,

    setEmoji(rawList) {
      if (!Array.isArray(rawList)) return invalidate('emoji')
      slots.get('emoji').set(parseEmoji(rawList))
    },
  }
}
