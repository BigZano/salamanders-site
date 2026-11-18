import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import { createLibrariusGuild } from './librariusGuild.js'
import { Upstream } from './discordRoles.js'

// Invented ids, all in the 400-499 range. None of them is a real guild, role, channel or emoji.
const GUILD = '200000000000000400'
const OWNER = '200000000000000412'
const NEW_OWNER = '200000000000000413'
const FORUM = '200000000000000420'
const READER = '200000000000000401'
const OTHER = '200000000000000402'
const TAG_A = '200000000000000450'
const TAG_B = '200000000000000451'
const EMOJI_A = '200000000000000460'
const EMOJI_B = '200000000000000461'

const SNOWFLAKE = /^\d{17,20}$/
const DIGITS = /^\d{1,40}$/

// Everything near an id that is not one: the wrong length, the wrong characters, the wrong type.
const BAD_IDS = [
  undefined, null, '', 'role', 200000000000000401, 2e17, true, [READER], {},
  READER.slice(2), // 16 digits
  `${READER}111`, // 21 digits
  `${READER.slice(1)}a`,
  ` ${READER}`,
  `${READER} `,
  `${READER}\n`,
  `0x${READER}`,
  `-${READER}`,
  '\u0661'.repeat(18), // Arabic-Indic digits, which \d does not match
]

const rawGuild = () => ({
  id: GUILD,
  name: 'invented guild',
  owner_id: OWNER,
  roles: [
    { id: GUILD, name: '@everyone', color: 0, permissions: '1071698660929', position: 0 },
    { id: READER, name: 'invented reader', color: 0xaa3366, permissions: '0', position: 2 },
    { id: OTHER, name: 'invented other', color: 255, permissions: '8', position: 1 },
  ],
})

const rawForum = () => ({
  id: FORUM,
  type: 15,
  name: 'invented forum',
  permission_overwrites: [
    { id: GUILD, type: 0, allow: '0', deny: '1024' },
    { id: READER, type: 0, allow: '1024', deny: '0' },
  ],
  available_tags: [
    { id: TAG_A, name: 'invented tag', moderated: false, emoji_id: null, emoji_name: null },
    { id: TAG_B, name: 'another tag', moderated: true, emoji_id: EMOJI_A, emoji_name: null },
  ],
})

const rawEmojis = () => [
  { id: EMOJI_A, name: 'invented_a', animated: false, roles: [], managed: false },
  { id: EMOJI_B, name: 'invented_b', animated: true },
]

const FACTS = {
  ownerId: OWNER,
  roles: [
    { id: GUILD, permissions: '1071698660929', name: '@everyone', color: null },
    { id: READER, permissions: '0', name: 'invented reader', color: '#aa3366' },
    { id: OTHER, permissions: '8', name: 'invented other', color: '#0000ff' },
  ],
  overwrites: [
    { id: GUILD, type: 0, allow: '0', deny: '1024' },
    { id: READER, type: 0, allow: '1024', deny: '0' },
  ],
  tags: [
    { id: TAG_A, name: 'invented tag' },
    { id: TAG_B, name: 'another tag' },
  ],
}

const EMOJI = [
  { id: EMOJI_A, name: 'invented_a', animated: false },
  { id: EMOJI_B, name: 'invented_b', animated: true },
]

// The guild's AutoMod rules as Discord gives them (invented), which the guild keeps whole: the matcher reads what it needs.
const RULE_A = '200000000000000470'
const RULE_B = '200000000000000471'
const rawRules = () => [
  { id: RULE_A, name: 'invented keywords', enabled: true, event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: ['zorp'], allow_list: [] }, actions: [{ type: 1 }], exempt_roles: [OTHER], exempt_channels: [] },
  { id: RULE_B, name: 'invented mentions', enabled: false, event_type: 1, trigger_type: 5, trigger_metadata: { mention_total_limit: 40 }, actions: [{ type: 1 }], exempt_roles: [], exempt_channels: [] },
]

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// What a promise throws, or null when it does not.
const failure = (promise) => promise.then(() => null, (e) => e)

const NO_GUILD = 'Discord answered 200 for the guild, but not with what the Librarius expected.'
// A TypeError with this message: a bare TypeError is also what a lookup of nothing would throw.
const NOT_A_KIND = "kind must be 'guild', 'forum', 'emoji' or 'rules'."
function expectNotAKind(guild, kind, label = String(kind)) {
  let error = null
  try {
    guild.invalidate(kind)
  } catch (e) {
    error = e
  }
  expect(error, label).toBeInstanceOf(TypeError)
  expect(error.message, label).toBe(NOT_A_KIND)
}
const NO_FORUM = 'Discord answered 200 for the forum, but not with what the Librarius expected.'

// Lets every promise that can settle settle, so a read the guild has started has been asked for.
const flush = () => new Promise((resolve) => setImmediate(resolve))

/**
 * A guild on a clock the test owns, over a fake Discord that answers from `world`: what Discord holds right now. Each
 * read answers a copy, as a real one would. `clock.t` is the guild's idea of now.
 */
function setup(options = {}) {
  const clock = { t: 1_000 }
  const world = { guild: rawGuild(), forum: rawForum(), emojis: rawEmojis(), rules: rawRules() }
  const discord = {
    guild: vi.fn(async () => structuredClone(world.guild)),
    channel: vi.fn(async () => structuredClone(world.forum)),
    emojis: vi.fn(async () => structuredClone(world.emojis)),
    autoModRules: vi.fn(async () => structuredClone(world.rules)),
  }
  const guild = createLibrariusGuild({ discord, forumId: FORUM, now: () => clock.t, ...options })
  return { guild, discord, clock, world }
}

/** The facts of a world whose guild and forum are as given: the shapes under test go in `guild` and `forum`. */
async function factsOf({ guild: g, forum: f }) {
  const { guild, world } = setup()
  world.guild = g
  world.forum = f
  return guild.facts()
}

describe('facts', () => {
  it('reads the owner, the roles, the forum overwrites and the tags, in Discord order', async () => {
    const { guild } = setup()
    expect(await guild.facts()).toStrictEqual(FACTS)
  })

  it('asks Discord for the forum it was made for', async () => {
    const { guild, discord } = setup()
    await guild.facts()
    expect(discord.channel).toHaveBeenCalledWith(FORUM)
  })

  it('writes a role colour as #rrggbb, with every digit, and no colour for 0', async () => {
    const { guild, world } = setup()
    world.guild.roles = [0, 1, 255, 0x00ff00, 0xabcdef, 0xffffff].map((color, i) => ({ id: `20000000000000050${i}`, name: 'r', color, permissions: '0' }))
    expect((await guild.facts()).roles.map((r) => r.color)).toStrictEqual([null, '#000001', '#0000ff', '#00ff00', '#abcdef', '#ffffff'])
  })

  it('gives no colour for one that is not a colour: negative, past #ffffff, fractional, text, NaN, or missing', async () => {
    const { guild, world } = setup()
    const colours = [-1, 0x1000000, 2 ** 53, 1.5, '255', '#ffffff', NaN, Infinity, null, undefined, true, [], {}, [255]]
    world.guild.roles = colours.map((color, i) => ({ id: `2000000000000005${String(i).padStart(2, '0')}`, name: 'r', color, permissions: '0' }))
    expect((await guild.facts()).roles.map((r) => r.color)).toStrictEqual(colours.map(() => null))
  })

  it('keeps a permission string as its number, with no leading zeros, and counts anything else as none', async () => {
    const { guild, world } = setup()
    const permissions = ['8', '0', '0000', '0008', '1'.repeat(40), '1'.repeat(41), '', '-1', '1.5', '1e3', ' 8', '8 ', '8\n', '0x8', 8, null, undefined, [], {}]
    world.guild.roles = permissions.map((p, i) => ({ id: `2000000000000005${String(i).padStart(2, '0')}`, name: 'r', color: 0, permissions: p }))
    expect((await guild.facts()).roles.map((r) => r.permissions)).toStrictEqual(['8', '0', '0', '8', '1'.repeat(40), ...Array(14).fill('0')])
  })

  it('leaves out a role without a snowflake id, and anything in the list that is not a role', async () => {
    const { guild, world } = setup()
    const ok = { id: READER, name: 'ok', color: 0, permissions: '8' }
    world.guild.roles = [
      null, undefined, 'role', 8, true, [], [ok],
      { name: 'no id', permissions: '8' },
      ...BAD_IDS.map((id) => ({ ...ok, id })),
      ok,
    ]
    expect((await guild.facts()).roles).toStrictEqual([{ id: READER, permissions: '8', name: 'ok', color: null }])
  })

  it('takes ids of 17 and of 20 digits, and no others', async () => {
    const { guild, world } = setup()
    const lengths = [15, 16, 17, 18, 19, 20, 21]
    world.guild.roles = lengths.map((n) => ({ id: '3'.repeat(n), name: 'r', color: 0, permissions: '0' }))
    world.forum.available_tags = lengths.map((n) => ({ id: '3'.repeat(n), name: 't' }))
    const kept = [17, 18, 19, 20].map((n) => '3'.repeat(n))
    // A role or a tag with another length is left out; an overwrite with one is Upstream, as the next describe shows.
    world.forum.permission_overwrites = kept.map((id) => ({ id, type: 0, allow: '0', deny: '0' }))
    const facts = await guild.facts()
    expect(facts.roles.map((r) => r.id)).toStrictEqual(kept)
    expect(facts.overwrites.map((o) => o.id)).toStrictEqual(kept)
    expect(facts.tags.map((t) => t.id)).toStrictEqual(kept)
    for (const n of [15, 16, 21]) {
      world.forum.permission_overwrites = [{ id: '3'.repeat(n), type: 0, allow: '0', deny: '0' }]
      guild.invalidate('forum')
      expect(await failure(guild.facts()), String(n)).toBeInstanceOf(Upstream)
    }
  })

  it('gives a role with no name an empty one, and does not take a name that is no text', async () => {
    const { guild, world } = setup()
    world.guild.roles = [undefined, null, 7, ['x'], {}, 'name'].map((name, i) => ({ id: `2000000000000005${String(i).padStart(2, '0')}`, name, color: 0, permissions: '0' }))
    expect((await guild.facts()).roles.map((r) => r.name)).toStrictEqual(['', '', '', '', '', 'name'])
  })

  it('has no owner when Discord names none that is an id', async () => {
    for (const owner of BAD_IDS) {
      const { guild, world } = setup()
      world.guild.owner_id = owner
      expect((await guild.facts()).ownerId, String(owner)).toBeNull()
    }
  })

  it('answers Upstream, whatever else was read, for a guild without a list of roles', async () => {
    for (const roles of [undefined, null, 'roles', 8, {}, { 0: { id: READER } }]) {
      const { guild, world } = setup()
      world.guild.roles = roles
      const error = await failure(guild.facts())
      expect(error, String(roles)).toBeInstanceOf(Upstream)
      expect(error.message).toBe(NO_GUILD)
    }
  })

  it('answers Upstream for a forum without a list of overwrites, which would read as a forum nobody is shut out of', async () => {
    for (const overwrites of [undefined, null, 'none', 8, {}, { 0: { id: GUILD } }]) {
      const { guild, world } = setup()
      world.forum.permission_overwrites = overwrites
      const error = await failure(guild.facts())
      expect(error, String(overwrites)).toBeInstanceOf(Upstream)
      expect(error.message).toBe(NO_FORUM)
    }
  })

  it('names no token, link or Discord text in what it throws for an answer it cannot use', async () => {
    const { guild, world } = setup()
    world.guild.roles = 'https://cdn.test/secret?token=abc'
    const error = await failure(guild.facts())
    expect(error).toBeInstanceOf(Upstream)
    expect(error.message).toBe(NO_GUILD)
  })

  it('has no tags for a forum without a list of them', async () => {
    for (const tags of [undefined, null, 'tags', 8, {}, { 0: { id: TAG_A, name: 'a' } }]) {
      const { guild, world } = setup()
      world.forum.available_tags = tags
      expect((await guild.facts()).tags, String(tags)).toStrictEqual([])
    }
  })

  it('leaves out a tag without a snowflake id or without a name that is text', async () => {
    const { guild, world } = setup()
    const ok = { id: TAG_A, name: 'ok' }
    world.forum.available_tags = [
      null, undefined, 'tag', 8, true, [], [ok],
      { name: 'no id' },
      ...BAD_IDS.map((id) => ({ ...ok, id })),
      { id: TAG_A },
      { id: TAG_A, name: null },
      { id: TAG_A, name: 7 },
      { id: TAG_A, name: ['x'] },
      ok,
    ]
    expect((await guild.facts()).tags).toStrictEqual([ok])
  })

  it('keeps an overwrite of a role (0) and of a member (1) with its allow and deny as digits', async () => {
    const { guild, world } = setup()
    world.forum.permission_overwrites = [
      { id: READER, type: 0, allow: '1024', deny: '2048', extra: 'dropped' },
      { id: OWNER, type: 1, allow: '0008', deny: '0' },
    ]
    expect((await guild.facts()).overwrites).toStrictEqual([
      { id: READER, type: 0, allow: '1024', deny: '2048' },
      { id: OWNER, type: 1, allow: '8', deny: '0' },
    ])
  })

  it('hands back copies: what a caller changes in them is not what the next caller gets', async () => {
    const { guild } = setup()
    const first = await guild.facts()
    first.roles[0].permissions = '8'
    first.roles.pop()
    first.overwrites.length = 0
    first.tags[0].name = 'changed'
    first.ownerId = null
    expect(await guild.facts()).toStrictEqual(FACTS)
  })
})

describe('facts: what is well-formed whatever Discord sends', () => {
  const snowflake = fc.stringMatching(/^[1-9]\d{16,19}$/)
  const maybe = (good) => fc.oneof({ weight: 3, arbitrary: good }, { weight: 1, arbitrary: fc.jsonValue() })
  const role = fc.record(
    { id: maybe(snowflake), name: maybe(fc.string()), color: maybe(fc.integer({ min: 0, max: 0xffffff })), permissions: maybe(fc.stringMatching(/^\d{1,45}$/)) },
    { requiredKeys: [] },
  )
  const overwrite = fc.record(
    { id: maybe(snowflake), type: maybe(fc.constantFrom(0, 1)), allow: maybe(fc.stringMatching(/^\d{1,45}$/)), deny: maybe(fc.stringMatching(/^\d{1,45}$/)) },
    { requiredKeys: [] },
  )
  const goodOverwrite = fc.record({ id: snowflake, type: fc.constantFrom(0, 1), allow: fc.stringMatching(/^\d{1,40}$/), deny: fc.stringMatching(/^\d{1,40}$/) })
  const tag = fc.record({ id: maybe(snowflake), name: maybe(fc.string()) }, { requiredKeys: [] })
  const world = fc.record({
    ownerId: maybe(snowflake),
    roles: fc.oneof({ weight: 8, arbitrary: fc.array(maybe(role)) }, { weight: 1, arbitrary: fc.jsonValue() }),
    // A malformed overwrite is Upstream, so most runs must hold only good ones for the roles and tags to be read at all.
    overwrites: fc.oneof(
      { weight: 8, arbitrary: fc.array(goodOverwrite) },
      { weight: 2, arbitrary: fc.array(maybe(overwrite)) },
      { weight: 1, arbitrary: fc.jsonValue() },
    ),
    tags: fc.oneof({ weight: 8, arbitrary: fc.array(maybe(tag)) }, { weight: 1, arbitrary: fc.jsonValue() }),
  })

  it('is Upstream, or only ids, digits and #rrggbb: nothing of the shapes it was given', async () => {
    await fc.assert(
      fc.asyncProperty(world, async (w) => {
        const { guild, world: held } = setup()
        held.guild = { owner_id: w.ownerId, roles: w.roles }
        held.forum = { permission_overwrites: w.overwrites, available_tags: w.tags }
        let facts
        try {
          facts = await guild.facts()
        } catch (e) {
          expect(e).toBeInstanceOf(Upstream)
          return
        }
        expect(facts.ownerId === null || SNOWFLAKE.test(facts.ownerId)).toBe(true)
        for (const r of facts.roles) {
          expect(r.id).toMatch(SNOWFLAKE)
          expect(r.permissions).toMatch(DIGITS)
          expect(typeof r.name).toBe('string')
          expect(r.color === null || /^#[0-9a-f]{6}$/.test(r.color)).toBe(true)
          expect(Object.keys(r).sort()).toStrictEqual(['color', 'id', 'name', 'permissions'])
        }
        for (const o of facts.overwrites) {
          expect(o.id).toMatch(SNOWFLAKE)
          expect([0, 1]).toContain(o.type)
          expect(o.allow).toMatch(DIGITS)
          expect(o.deny).toMatch(DIGITS)
          expect(Object.keys(o).sort()).toStrictEqual(['allow', 'deny', 'id', 'type'])
        }
        for (const t of facts.tags) {
          expect(t.id).toMatch(SNOWFLAKE)
          expect(typeof t.name).toBe('string')
          expect(Object.keys(t).sort()).toStrictEqual(['id', 'name'])
        }
        expect(Object.keys(facts).sort()).toStrictEqual(['overwrites', 'ownerId', 'roles', 'tags'])
      }),
    )
  })

  it('keeps every good role, overwrite and tag, in order, however many there are', async () => {
    const goodRole = fc.record({
      id: snowflake,
      name: fc.string(),
      color: fc.integer({ min: 0, max: 0xffffff }),
      permissions: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map(String),
    })
    const goodOverwrite = fc.record({ id: snowflake, type: fc.constantFrom(0, 1), allow: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map(String), deny: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map(String) })
    const goodTag = fc.record({ id: snowflake, name: fc.string() })
    await fc.assert(
      fc.asyncProperty(fc.array(goodRole), fc.array(goodOverwrite), fc.array(goodTag), async (roles, overwrites, tags) => {
        const { roles: got, overwrites: gotOverwrites, tags: gotTags } = await factsOf({
          guild: { owner_id: OWNER, roles },
          forum: { permission_overwrites: overwrites, available_tags: tags },
        })
        expect(got).toStrictEqual(roles.map((r) => ({ id: r.id, permissions: r.permissions, name: r.name, color: r.color === 0 ? null : `#${r.color.toString(16).padStart(6, '0')}` })))
        expect(gotOverwrites).toStrictEqual(overwrites.map((o) => ({ ...o })))
        expect(gotTags).toStrictEqual(tags.map((t) => ({ id: t.id, name: t.name })))
      }),
    )
  })
})

describe('a malformed forum overwrite', () => {
  const good = () => ({ id: READER, type: 0, allow: '1024', deny: '0' })

  // Every way one overwrite can be wrong, each with the rest of it as it should be.
  const malformed = () => [
    null, undefined, 'overwrite', 8, true, [], [good()],
    ...BAD_IDS.map((id) => ({ ...good(), id })),
    { id: undefined },
    ...[2, -1, '0', '1', 0.5, null, undefined, NaN, true, [0], {}].map((type) => ({ ...good(), type })),
    { id: READER, allow: '1024', deny: '0' }, // no type
    ...[1024, -5, 8.5, '', 'deny', '-1', '1.5', '1e3', ' 8', '8 ', '8\n', '0x8', '1'.repeat(41), '\u0661', null, undefined, true, [], ['8'], {}].flatMap((value) => [
      { ...good(), allow: value },
      { ...good(), deny: value },
    ]),
    { id: READER, type: 0, deny: '0' }, // no allow
    { id: READER, type: 0, allow: '0' }, // no deny
  ]

  it('is Upstream, wherever it stands among good ones', async () => {
    for (const bad of malformed()) {
      for (const list of [[bad], [bad, good()], [good(), bad], [good(), bad, good()]]) {
        const { guild, world } = setup()
        world.forum.permission_overwrites = list
        const error = await failure(guild.facts())
        expect(error, JSON.stringify(bad)).toBeInstanceOf(Upstream)
        expect(error.message).toBe(NO_FORUM)
      }
    }
  })

  it('is Upstream when it is the deny of View Channel to @everyone, which skipped would open the forum to all', async () => {
    const { guild, world } = setup()
    world.forum.permission_overwrites = [
      { id: GUILD, type: 0, allow: '0', deny: 1024 },
      { id: READER, type: 0, allow: '1024', deny: '0' },
    ]
    expect(await failure(guild.facts())).toBeInstanceOf(Upstream)
    world.forum.permission_overwrites = [
      { id: 'everyone', type: 0, allow: '0', deny: '1024' },
      { id: READER, type: 0, allow: '1024', deny: '0' },
    ]
    expect(await failure(guild.facts())).toBeInstanceOf(Upstream)
  })

  it('caches nothing: the next call reads the forum again, and not the guild, which was read fine', async () => {
    const { guild, discord, world } = setup()
    world.forum.permission_overwrites = [good(), { ...good(), type: 2 }]
    expect(await failure(guild.facts())).toBeInstanceOf(Upstream)
    expect(await failure(guild.facts())).toBeInstanceOf(Upstream)
    expect(discord.channel).toHaveBeenCalledTimes(2)
    world.forum.permission_overwrites = [good()]
    expect((await guild.facts()).overwrites).toStrictEqual([{ id: READER, type: 0, allow: '1024', deny: '0' }])
    expect(discord.channel).toHaveBeenCalledTimes(3)
    expect(discord.guild).toHaveBeenCalledTimes(1)
  })

  it('is not served from an older good read once that has expired', async () => {
    const { guild, clock, world } = setup()
    await guild.facts()
    clock.t = 1_000 + 300_000
    world.forum.permission_overwrites = [{ ...good(), allow: 'x' }]
    expect(await failure(guild.facts())).toBeInstanceOf(Upstream)
  })

  it('fails every caller waiting on the read', async () => {
    const { guild, world } = setup()
    world.forum.permission_overwrites = [{ ...good(), id: 'x' }]
    const results = await Promise.all([failure(guild.facts()), failure(guild.facts())])
    for (const error of results) expect(error).toBeInstanceOf(Upstream)
  })

  it('does not fail a forum with no overwrites at all, only one whose list is missing or bad', async () => {
    const { guild, world } = setup()
    world.forum.permission_overwrites = []
    expect((await guild.facts()).overwrites).toStrictEqual([])
  })

  it('takes an allow and a deny of 1 and of 40 digits, and a type of 0 and of 1', async () => {
    const { guild, world } = setup()
    world.forum.permission_overwrites = [
      { id: READER, type: 0, allow: '7', deny: '9'.repeat(40) },
      { id: OWNER, type: 1, allow: '1'.repeat(40), deny: '0' },
    ]
    expect((await guild.facts()).overwrites).toStrictEqual([
      { id: READER, type: 0, allow: '7', deny: '9'.repeat(40) },
      { id: OWNER, type: 1, allow: '1'.repeat(40), deny: '0' },
    ])
  })
})

describe('the cache', () => {
  it('serves the guild and the forum from memory within 5 minutes, and reads both again at 5 minutes', async () => {
    const { guild, discord, clock, world } = setup()
    expect((await guild.facts()).ownerId).toBe(OWNER)
    world.guild.owner_id = NEW_OWNER
    world.forum.available_tags = []
    clock.t = 1_000 + 299_999
    const cached = await guild.facts()
    expect(cached.ownerId).toBe(OWNER)
    expect(cached.tags).toHaveLength(2)
    expect(discord.guild).toHaveBeenCalledTimes(1)
    expect(discord.channel).toHaveBeenCalledTimes(1)
    clock.t = 1_000 + 300_000
    const fresh = await guild.facts()
    expect(fresh.ownerId).toBe(NEW_OWNER)
    expect(fresh.tags).toStrictEqual([])
  })

  it('serves them for the ttlMs it was given, and not a tick longer', async () => {
    const { guild, clock, world } = setup({ ttlMs: 50 })
    await guild.facts()
    world.guild.owner_id = NEW_OWNER
    clock.t = 1_049
    expect((await guild.facts()).ownerId).toBe(OWNER)
    clock.t = 1_050
    expect((await guild.facts()).ownerId).toBe(NEW_OWNER)
  })

  it('keeps a read for a full ttl from when it was made, not from when the first was', async () => {
    const { guild, clock, world } = setup({ ttlMs: 100 })
    await guild.facts()
    clock.t = 1_100
    world.guild.owner_id = NEW_OWNER
    await guild.facts()
    world.guild.owner_id = OWNER
    clock.t = 1_199
    expect((await guild.facts()).ownerId).toBe(NEW_OWNER)
    clock.t = 1_200
    expect((await guild.facts()).ownerId).toBe(OWNER)
  })

  it('times the guild and the forum apart: each expires ttlMs after its own read', async () => {
    const { guild, discord, clock, world } = setup({ ttlMs: 100 })
    await guild.facts()
    clock.t = 1_060
    guild.invalidate('forum')
    world.forum.available_tags = []
    await guild.facts() // the forum is read again, now; the guild is not
    expect(discord.guild).toHaveBeenCalledTimes(1)
    expect(discord.channel).toHaveBeenCalledTimes(2)
    world.guild.owner_id = NEW_OWNER
    world.forum.available_tags = [{ id: TAG_A, name: 'back' }]
    clock.t = 1_100 // the guild's read is 100 old, the forum's 40
    const facts = await guild.facts()
    expect(facts.ownerId).toBe(NEW_OWNER)
    expect(facts.tags).toStrictEqual([])
    expect(discord.guild).toHaveBeenCalledTimes(2)
    expect(discord.channel).toHaveBeenCalledTimes(2)
    clock.t = 1_160
    expect((await guild.facts()).tags).toStrictEqual([{ id: TAG_A, name: 'back' }])
    expect(discord.channel).toHaveBeenCalledTimes(3)
  })

  it('serves the emoji for 10 minutes, and reads them again at 10 minutes', async () => {
    const { guild, discord, clock, world } = setup()
    expect(await guild.emoji()).toStrictEqual(EMOJI)
    world.emojis = []
    clock.t = 1_000 + 599_999
    expect(await guild.emoji()).toStrictEqual(EMOJI)
    expect(discord.emojis).toHaveBeenCalledTimes(1)
    clock.t = 1_000 + 600_000
    expect(await guild.emoji()).toStrictEqual([])
    expect(discord.emojis).toHaveBeenCalledTimes(2)
  })

  it('serves the emoji for the emojiTtlMs it was given, and the facts for their own ttlMs', async () => {
    const { guild, clock, world } = setup({ ttlMs: 10, emojiTtlMs: 70 })
    await guild.emoji()
    await guild.facts()
    world.emojis = []
    world.guild.owner_id = NEW_OWNER
    clock.t = 1_010
    expect((await guild.facts()).ownerId).toBe(NEW_OWNER)
    expect(await guild.emoji()).toStrictEqual(EMOJI)
    clock.t = 1_069
    expect(await guild.emoji()).toStrictEqual(EMOJI)
    clock.t = 1_070
    expect(await guild.emoji()).toStrictEqual([])
  })

  it('reads the emoji and the facts apart: one does not warm the other', async () => {
    const { guild, discord } = setup()
    await guild.emoji()
    expect(discord.guild).not.toHaveBeenCalled()
    expect(discord.channel).not.toHaveBeenCalled()
    await guild.facts()
    expect(discord.emojis).toHaveBeenCalledTimes(1)
  })

  it('has two callers at once share one read of each', async () => {
    const { guild, discord } = setup()
    const [a, b, c, d] = await Promise.all([guild.facts(), guild.facts(), guild.emoji(), guild.emoji()])
    expect(a).toStrictEqual(FACTS)
    expect(b).toStrictEqual(FACTS)
    expect(c).toStrictEqual(EMOJI)
    expect(d).toStrictEqual(EMOJI)
    expect(discord.guild).toHaveBeenCalledTimes(1)
    expect(discord.channel).toHaveBeenCalledTimes(1)
    expect(discord.emojis).toHaveBeenCalledTimes(1)
  })

  it('has a caller who comes while a read is in flight wait for that read', async () => {
    const { guild, discord } = setup()
    const gate = deferred()
    discord.guild.mockImplementationOnce(() => gate.promise)
    const first = guild.facts()
    await flush()
    const second = guild.facts()
    await flush()
    gate.resolve({ ...rawGuild(), owner_id: NEW_OWNER })
    expect((await first).ownerId).toBe(NEW_OWNER)
    expect((await second).ownerId).toBe(NEW_OWNER)
    expect(discord.guild).toHaveBeenCalledTimes(1)
  })

  it('does not hand one caller what another changed in its copy', async () => {
    const { guild } = setup()
    const [a, b] = await Promise.all([guild.facts(), guild.facts()])
    a.roles.length = 0
    expect(b.roles).toHaveLength(3)
    const [e, f] = await Promise.all([guild.emoji(), guild.emoji()])
    e.length = 0
    expect(f).toHaveLength(2)
    expect(await guild.emoji()).toHaveLength(2)
  })

  it('reads again after a read has settled and its ttl has run out, not hands back that read once more', async () => {
    const { guild, discord, clock } = setup({ ttlMs: 10 })
    await guild.facts()
    clock.t += 10
    await guild.facts()
    clock.t += 10
    await guild.facts()
    expect(discord.guild).toHaveBeenCalledTimes(3)
  })
})

describe('a failed read', () => {
  it('answers Upstream, and the next call reads again instead of remembering the failure', async () => {
    const { guild, discord } = setup()
    discord.guild.mockRejectedValueOnce(new Upstream('Discord is unreachable.'))
    await expect(guild.facts()).rejects.toBeInstanceOf(Upstream)
    expect(await guild.facts()).toStrictEqual(FACTS)
    expect(discord.guild).toHaveBeenCalledTimes(2)
  })

  it('fails the forum alone the same way, and keeps the guild it did read', async () => {
    const { guild, discord } = setup()
    discord.channel.mockRejectedValueOnce(new Upstream('Discord is unreachable.'))
    await expect(guild.facts()).rejects.toBeInstanceOf(Upstream)
    expect(await guild.facts()).toStrictEqual(FACTS)
    expect(discord.channel).toHaveBeenCalledTimes(2)
    expect(discord.guild).toHaveBeenCalledTimes(1)
  })

  it('fails the emoji the same way', async () => {
    const { guild, discord } = setup()
    discord.emojis.mockRejectedValueOnce(new Upstream('Discord is unreachable.'))
    await expect(guild.emoji()).rejects.toBeInstanceOf(Upstream)
    expect(await guild.emoji()).toStrictEqual(EMOJI)
    expect(discord.emojis).toHaveBeenCalledTimes(2)
  })

  it('fails every caller that was waiting on the read, and then lets the next one read', async () => {
    const { guild, discord } = setup()
    const gate = deferred()
    discord.guild.mockImplementationOnce(() => gate.promise)
    const callers = [guild.facts(), guild.facts(), guild.facts()].map((p) => p.catch((e) => e))
    await flush()
    gate.reject(new Upstream('Discord is unreachable.'))
    for (const result of await Promise.all(callers)) expect(result).toBeInstanceOf(Upstream)
    expect(discord.guild).toHaveBeenCalledTimes(1)
    expect(await guild.facts()).toStrictEqual(FACTS)
  })

  it('serves no copy that has gone stale: once the ttl has run out, a failure is a failure', async () => {
    const reads = [
      ['guild', 300_000, (guild) => guild.facts()],
      ['channel', 300_000, (guild) => guild.facts()],
      ['emojis', 600_000, (guild) => guild.emoji()],
    ]
    for (const [name, ttl, read] of reads) {
      const { guild, discord, clock } = setup()
      await read(guild)
      clock.t = 1_000 + ttl
      discord[name].mockRejectedValueOnce(new Upstream('Discord is unreachable.'))
      await expect(read(guild), name).rejects.toBeInstanceOf(Upstream)
    }
  })

  it('is Upstream, without asking Discord for a channel, when the forum is not configured', async () => {
    for (const forumId of BAD_IDS) {
      const { guild, discord } = setup({ forumId })
      const error = await failure(guild.facts())
      expect(error, String(forumId)).toBeInstanceOf(Upstream)
      expect(error.message).toBe('The Librarius forum is not configured.')
      expect(discord.channel).not.toHaveBeenCalled()
      expect(await guild.emoji()).toStrictEqual(EMOJI)
    }
  })

  it('takes a forum id of 17 and of 20 digits', async () => {
    for (const forumId of ['3'.repeat(17), '3'.repeat(20)]) {
      const { guild, discord } = setup({ forumId })
      await guild.facts()
      expect(discord.channel).toHaveBeenCalledWith(forumId)
    }
  })
})

describe('invalidate', () => {
  it("'guild' reads the guild again and leaves the forum and the emoji", async () => {
    const { guild, discord, world } = setup()
    await guild.facts()
    await guild.emoji()
    world.guild.owner_id = NEW_OWNER
    world.forum.available_tags = []
    world.emojis = []
    guild.invalidate('guild')
    const facts = await guild.facts()
    expect(facts.ownerId).toBe(NEW_OWNER)
    expect(facts.tags).toHaveLength(2)
    expect(await guild.emoji()).toStrictEqual(EMOJI)
    expect(discord.guild).toHaveBeenCalledTimes(2)
    expect(discord.channel).toHaveBeenCalledTimes(1)
    expect(discord.emojis).toHaveBeenCalledTimes(1)
  })

  it("'forum' reads the forum again and leaves the guild and the emoji", async () => {
    const { guild, discord, world } = setup()
    await guild.facts()
    await guild.emoji()
    world.guild.owner_id = NEW_OWNER
    world.forum.available_tags = []
    world.emojis = []
    guild.invalidate('forum')
    const facts = await guild.facts()
    expect(facts.ownerId).toBe(OWNER)
    expect(facts.tags).toStrictEqual([])
    expect(await guild.emoji()).toStrictEqual(EMOJI)
    expect(discord.guild).toHaveBeenCalledTimes(1)
    expect(discord.channel).toHaveBeenCalledTimes(2)
    expect(discord.emojis).toHaveBeenCalledTimes(1)
  })

  it("'emoji' reads the emoji again and leaves the guild and the forum", async () => {
    const { guild, discord, world } = setup()
    await guild.facts()
    await guild.emoji()
    world.guild.owner_id = NEW_OWNER
    world.emojis = []
    guild.invalidate('emoji')
    expect(await guild.emoji()).toStrictEqual([])
    expect((await guild.facts()).ownerId).toBe(OWNER)
    expect(discord.guild).toHaveBeenCalledTimes(1)
    expect(discord.channel).toHaveBeenCalledTimes(1)
    expect(discord.emojis).toHaveBeenCalledTimes(2)
  })

  it('answers nothing, and can be called before anything was read or twice in a row', async () => {
    const { guild, discord } = setup()
    expect(guild.invalidate('guild')).toBeUndefined()
    expect(guild.invalidate('forum')).toBeUndefined()
    expect(guild.invalidate('emoji')).toBeUndefined()
    guild.invalidate('guild')
    expect(await guild.facts()).toStrictEqual(FACTS)
    expect(discord.guild).toHaveBeenCalledTimes(1)
  })

  it('throws TypeError for any other kind, and invalidates nothing', async () => {
    const { guild, discord, world } = setup()
    await guild.facts()
    await guild.emoji()
    world.guild.owner_id = NEW_OWNER
    world.emojis = []
    const hostile = [
      'Guild', 'GUILD', 'guilds', ' guild', 'guild ', 'guild\n', 'roles', 'rule', 'Rules', 'rules ', 'automod', 'forum,emoji', 'all', '',
      'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype',
      undefined, null, 0, 1, true, NaN, ['guild'], ['forum'], { toString: () => 'guild' }, { kind: 'guild' }, Symbol('guild'), () => 'guild',
    ]
    for (const kind of hostile) expectNotAKind(guild, kind, typeof kind === 'symbol' ? 'symbol' : String(kind))
    expect(() => guild.invalidate()).toThrow(TypeError)
    expect((await guild.facts()).ownerId).toBe(OWNER)
    expect(await guild.emoji()).toStrictEqual(EMOJI)
    expect(discord.guild).toHaveBeenCalledTimes(1)
    expect(discord.emojis).toHaveBeenCalledTimes(1)
  })

  it('throws TypeError for any text that is not one of the four kinds', () => {
    const { guild } = setup()
    fc.assert(
      fc.property(fc.string(), (kind) => {
        fc.pre(!['guild', 'forum', 'emoji', 'rules'].includes(kind))
        expectNotAKind(guild, kind)
      }),
    )
  })

  describe('during a read', () => {
    it("is not stored: the caller has what it asked for, and the next call reads again", async () => {
      const { guild, discord, world } = setup()
      const gate = deferred()
      discord.guild.mockImplementationOnce(() => gate.promise)
      const first = guild.facts()
      await flush()
      guild.invalidate('guild')
      world.guild.owner_id = NEW_OWNER
      gate.resolve({ ...rawGuild(), owner_id: OTHER })
      expect((await first).ownerId).toBe(OTHER)
      expect((await guild.facts()).ownerId).toBe(NEW_OWNER)
      expect(discord.guild).toHaveBeenCalledTimes(2)
    })

    it("is not stored for the forum either, nor for the emoji", async () => {
      const { guild, discord } = setup()
      const forum = deferred()
      const emoji = deferred()
      discord.channel.mockImplementationOnce(() => forum.promise)
      discord.emojis.mockImplementationOnce(() => emoji.promise)
      const facts = guild.facts()
      const list = guild.emoji()
      await flush()
      guild.invalidate('forum')
      guild.invalidate('emoji')
      forum.resolve({ ...rawForum(), available_tags: [] })
      emoji.resolve([])
      expect((await facts).tags).toStrictEqual([])
      expect(await list).toStrictEqual([])
      expect((await guild.facts()).tags).toHaveLength(2)
      expect(await guild.emoji()).toStrictEqual(EMOJI)
    })

    it('does not stop a read of another kind from being stored', async () => {
      const { guild, discord } = setup()
      const gate = deferred()
      discord.guild.mockImplementationOnce(() => gate.promise)
      const first = guild.facts()
      await flush()
      guild.invalidate('forum')
      guild.invalidate('emoji')
      gate.resolve(rawGuild())
      await first
      await guild.facts()
      expect(discord.guild).toHaveBeenCalledTimes(1) // the guild read was stored
      expect(discord.channel).toHaveBeenCalledTimes(2) // the forum was dropped by its own invalidation
    })

    it('starts a new read for a caller who comes after it, not the one in flight', async () => {
      const { guild, discord, world } = setup()
      const gate = deferred()
      discord.guild.mockImplementationOnce(() => gate.promise)
      const stale = guild.facts()
      await flush()
      guild.invalidate('guild')
      world.guild.owner_id = NEW_OWNER
      expect((await guild.facts()).ownerId).toBe(NEW_OWNER)
      gate.resolve(rawGuild())
      await stale
      expect(discord.guild).toHaveBeenCalledTimes(2)
    })

    it('does not let the old read, finishing last, take the place of the newer one', async () => {
      const { guild, discord, world } = setup()
      const gate = deferred()
      discord.guild.mockImplementationOnce(() => gate.promise)
      const stale = guild.facts()
      await flush()
      guild.invalidate('guild')
      world.guild.owner_id = NEW_OWNER
      await guild.facts() // the newer read, stored
      gate.resolve({ ...rawGuild(), owner_id: OTHER })
      expect((await stale).ownerId).toBe(OTHER)
      expect((await guild.facts()).ownerId).toBe(NEW_OWNER)
      expect(discord.guild).toHaveBeenCalledTimes(2)
    })

    it('does not let the old read, finishing first, end the newer one that is still in flight', async () => {
      const { guild, discord } = setup()
      const older = deferred()
      const newer = deferred()
      discord.guild.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise)
      const first = guild.facts()
      await flush()
      guild.invalidate('guild')
      const second = guild.facts()
      await flush()
      older.resolve(rawGuild())
      await first
      const third = guild.facts() // joins the newer read; there is no third
      await flush()
      newer.resolve({ ...rawGuild(), owner_id: NEW_OWNER })
      expect((await second).ownerId).toBe(NEW_OWNER)
      expect((await third).ownerId).toBe(NEW_OWNER)
      expect(discord.guild).toHaveBeenCalledTimes(2)
    })
  })
})

describe('emoji', () => {
  it('is the guild custom emoji as id, name and whether it is animated, and nothing else of them', async () => {
    const { guild } = setup()
    expect(await guild.emoji()).toStrictEqual(EMOJI)
  })

  it('leaves out an emoji without a snowflake id or a name of word characters', async () => {
    const { guild, world } = setup()
    world.emojis = [
      null, 'emoji', 8, [], { name: 'no_id' },
      { id: 200000000000000460, name: 'number_id' },
      { id: EMOJI_A },
      { id: EMOJI_A, name: null },
      { id: EMOJI_A, name: 'has space' },
      { id: EMOJI_A, name: '' },
      { id: EMOJI_A, name: 'x'.repeat(33) },
      { id: EMOJI_B, name: 'ok', animated: 'yes' },
    ]
    expect(await guild.emoji()).toStrictEqual([{ id: EMOJI_B, name: 'ok', animated: false }])
  })
})

describe('setEmoji', () => {
  it('replaces the list, in the shape emoji() gives, without a read', async () => {
    const { guild, discord } = setup()
    await guild.emoji()
    guild.setEmoji([{ id: EMOJI_B, name: 'renamed', animated: false, user: { id: OWNER } }, { id: OTHER, name: 'extra', animated: true }])
    expect(await guild.emoji()).toStrictEqual([
      { id: EMOJI_B, name: 'renamed', animated: false },
      { id: OTHER, name: 'extra', animated: true },
    ])
    expect(discord.emojis).toHaveBeenCalledTimes(1)
  })

  it('works before anything was read, and with the empty list', async () => {
    const { guild, discord } = setup()
    guild.setEmoji([])
    expect(await guild.emoji()).toStrictEqual([])
    guild.setEmoji(rawEmojis())
    expect(await guild.emoji()).toStrictEqual(EMOJI)
    expect(discord.emojis).not.toHaveBeenCalled()
  })

  it('answers nothing', () => {
    const { guild } = setup()
    expect(guild.setEmoji([])).toBeUndefined()
  })

  it('filters what it is given like a read does', async () => {
    const { guild } = setup()
    guild.setEmoji([null, { id: 'x', name: 'bad' }, { id: EMOJI_A, name: 'good' }, 7, { id: EMOJI_B, name: 'bad name' }])
    expect(await guild.emoji()).toStrictEqual([{ id: EMOJI_A, name: 'good', animated: false }])
  })

  it('keeps the list for the emojiTtlMs from when it was set, and no longer', async () => {
    const { guild, discord, clock, world } = setup({ emojiTtlMs: 100 })
    await guild.emoji()
    clock.t = 1_080
    guild.setEmoji([{ id: OTHER, name: 'set' }])
    world.emojis = []
    clock.t = 1_179 // 99 after it was set, 179 after the read
    expect(await guild.emoji()).toStrictEqual([{ id: OTHER, name: 'set', animated: false }])
    expect(discord.emojis).toHaveBeenCalledTimes(1)
    clock.t = 1_180
    expect(await guild.emoji()).toStrictEqual([])
    expect(discord.emojis).toHaveBeenCalledTimes(2)
  })

  it('keeps the list for 10 minutes unless told otherwise', async () => {
    const { guild, clock, world } = setup()
    guild.setEmoji([{ id: OTHER, name: 'set' }])
    world.emojis = []
    clock.t = 1_000 + 599_999
    expect(await guild.emoji()).toHaveLength(1)
    clock.t = 1_000 + 600_000
    expect(await guild.emoji()).toStrictEqual([])
  })

  it('takes a list that is not a list as a sign that what is held is out of date: it is read again', async () => {
    for (const raw of [undefined, null, 'emoji', 8, {}, { 0: { id: EMOJI_A, name: 'a' } }]) {
      const { guild, discord, world } = setup()
      await guild.emoji()
      world.emojis = []
      guild.setEmoji(raw)
      expect(await guild.emoji(), String(raw)).toStrictEqual([])
      expect(discord.emojis).toHaveBeenCalledTimes(2)
    }
  })

  it('does not touch the guild or the forum', async () => {
    const { guild, discord } = setup()
    await guild.facts()
    guild.setEmoji([])
    await guild.facts()
    expect(discord.guild).toHaveBeenCalledTimes(1)
    expect(discord.channel).toHaveBeenCalledTimes(1)
  })

  it('wins over a read that was already in flight: that read is the older news and is not stored', async () => {
    const { guild, discord } = setup()
    const gate = deferred()
    discord.emojis.mockImplementationOnce(() => gate.promise)
    const reading = guild.emoji()
    await flush()
    guild.setEmoji([{ id: OTHER, name: 'newer' }])
    gate.resolve(rawEmojis())
    expect(await reading).toStrictEqual(EMOJI)
    expect(await guild.emoji()).toStrictEqual([{ id: OTHER, name: 'newer', animated: false }])
    expect(discord.emojis).toHaveBeenCalledTimes(1)
  })

  it('hands back copies: a caller who changes its list does not change the next', async () => {
    const { guild } = setup()
    guild.setEmoji(rawEmojis())
    const first = await guild.emoji()
    first.length = 0
    expect(await guild.emoji()).toStrictEqual(EMOJI)
  })

  it('is not changed by what the caller does to the list it gave', async () => {
    const { guild } = setup()
    const raw = rawEmojis()
    guild.setEmoji(raw)
    raw[0].name = 'changed'
    raw.length = 0
    expect(await guild.emoji()).toStrictEqual(EMOJI)
  })
})

describe('automodRules', () => {
  it("is the guild's AutoMod rules as Discord gave them, whole", async () => {
    const { guild } = setup()
    expect(await guild.automodRules()).toStrictEqual(rawRules())
  })

  it('is a copy: changing what a caller got changes nothing the next one gets', async () => {
    const { guild } = setup()
    const first = await guild.automodRules()
    first[0].trigger_metadata.keyword_filter.push('changed')
    first.pop()
    expect(await guild.automodRules()).toStrictEqual(rawRules())
  })

  it('serves the rules for ttlMs from when it read them, and reads again at that millisecond', async () => {
    const { guild, discord, clock, world } = setup({ ttlMs: 70 })
    await guild.automodRules()
    world.rules = [rawRules()[1]]
    clock.t = 1_069
    expect(await guild.automodRules()).toStrictEqual(rawRules())
    expect(discord.autoModRules).toHaveBeenCalledTimes(1)
    clock.t = 1_070
    expect(await guild.automodRules()).toStrictEqual([rawRules()[1]])
    expect(discord.autoModRules).toHaveBeenCalledTimes(2)
  })

  it('keeps them five minutes unless told otherwise', async () => {
    const { guild, discord, clock } = setup()
    await guild.automodRules()
    clock.t = 1_000 + 299_999
    await guild.automodRules()
    expect(discord.autoModRules).toHaveBeenCalledTimes(1)
    clock.t = 1_000 + 300_000
    await guild.automodRules()
    expect(discord.autoModRules).toHaveBeenCalledTimes(2)
  })

  it('reads the rules apart from the facts and the emoji: none of them warms another', async () => {
    const { guild, discord } = setup()
    await guild.automodRules()
    expect(discord.guild).not.toHaveBeenCalled()
    expect(discord.channel).not.toHaveBeenCalled()
    expect(discord.emojis).not.toHaveBeenCalled()
    await guild.facts()
    await guild.emoji()
    expect(discord.autoModRules).toHaveBeenCalledTimes(1)
  })

  it('does not fail the facts when the rules cannot be read, which the bot may be unable to', async () => {
    const { guild, discord } = setup()
    discord.autoModRules.mockRejectedValue(new Upstream('Discord answered 403 for the AutoMod rules.'))
    expect(await guild.facts()).toStrictEqual(FACTS)
    expect(await failure(guild.automodRules())).toBeInstanceOf(Upstream)
  })

  it('has callers who come while it is read share the one read', async () => {
    const { guild, discord } = setup()
    const [a, b] = await Promise.all([guild.automodRules(), guild.automodRules()])
    expect(a).toStrictEqual(rawRules())
    expect(b).toStrictEqual(rawRules())
    expect(discord.autoModRules).toHaveBeenCalledTimes(1)
  })

  it('fails with Upstream, and keeps nothing, when Discord cannot be asked or answers something else', async () => {
    const { guild, discord } = setup()
    discord.autoModRules.mockRejectedValueOnce(new Upstream('Discord is unreachable.'))
    expect(await failure(guild.automodRules())).toBeInstanceOf(Upstream)
    expect(await guild.automodRules()).toStrictEqual(rawRules())
    expect(discord.autoModRules).toHaveBeenCalledTimes(2)
  })

  it('never serves rules that have gone stale in place of a failed read', async () => {
    const { guild, discord, clock } = setup({ ttlMs: 10 })
    await guild.automodRules()
    clock.t = 1_010
    discord.autoModRules.mockRejectedValueOnce(new Upstream('Discord is unreachable.'))
    expect(await failure(guild.automodRules())).toBeInstanceOf(Upstream)
  })

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an object', {}],
    ['text', 'rules'],
    ['a list with something that is no rule', [{ id: RULE_A }, 7]],
    ['a list with a list in it', [[]]],
    ['a list with null in it', [null]],
  ])('is Upstream, naming nothing of what it read, for %s', async (_, answer) => {
    const { guild, discord } = setup()
    discord.autoModRules.mockResolvedValue(answer)
    const error = await failure(guild.automodRules())
    expect(error).toBeInstanceOf(Upstream)
    expect(error.message).toBe('Discord answered 200 for the AutoMod rules, but not with what the Librarius expected.')
  })

  it('reads an empty list as no rules: a guild may have none', async () => {
    const { guild, world } = setup()
    world.rules = []
    expect(await guild.automodRules()).toStrictEqual([])
  })

  describe('invalidate', () => {
    it("'rules' reads the rules again and leaves the guild, the forum and the emoji", async () => {
      const { guild, discord, world } = setup()
      await guild.facts()
      await guild.emoji()
      await guild.automodRules()
      world.rules = []
      world.guild.owner_id = NEW_OWNER
      world.emojis = []
      guild.invalidate('rules')
      expect(await guild.automodRules()).toStrictEqual([])
      expect((await guild.facts()).ownerId).toBe(OWNER)
      expect(await guild.emoji()).toStrictEqual(EMOJI)
      expect(discord.autoModRules).toHaveBeenCalledTimes(2)
      expect(discord.guild).toHaveBeenCalledTimes(1)
      expect(discord.channel).toHaveBeenCalledTimes(1)
      expect(discord.emojis).toHaveBeenCalledTimes(1)
    })

    it('leaves the rules alone when the guild, the forum or the emoji are forgotten', async () => {
      const { guild, discord, world } = setup()
      await guild.automodRules()
      world.rules = []
      for (const kind of ['guild', 'forum', 'emoji']) guild.invalidate(kind)
      expect(await guild.automodRules()).toStrictEqual(rawRules())
      expect(discord.autoModRules).toHaveBeenCalledTimes(1)
    })

    it('is not stored when it comes during a read: the caller has what it asked for, the next call reads again', async () => {
      const { guild, discord, world } = setup()
      const gate = deferred()
      discord.autoModRules.mockImplementationOnce(() => gate.promise)
      const first = guild.automodRules()
      await flush()
      guild.invalidate('rules')
      world.rules = [rawRules()[1]]
      gate.resolve([])
      expect(await first).toStrictEqual([])
      expect(await guild.automodRules()).toStrictEqual([rawRules()[1]])
      expect(discord.autoModRules).toHaveBeenCalledTimes(2)
    })

    it('does not stop a read of the rules from being stored when another kind is forgotten', async () => {
      const { guild, discord } = setup()
      const gate = deferred()
      discord.autoModRules.mockImplementationOnce(() => gate.promise)
      const first = guild.automodRules()
      await flush()
      guild.invalidate('guild')
      guild.invalidate('forum')
      guild.invalidate('emoji')
      gate.resolve(rawRules())
      await first
      await guild.automodRules()
      expect(discord.autoModRules).toHaveBeenCalledTimes(1)
    })
  })
})
