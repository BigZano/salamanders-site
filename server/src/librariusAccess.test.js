import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import { createLibrariusAccess } from './librariusAccess.js'
import { createLibrariusGuild } from './librariusGuild.js'
import { Upstream } from './discordRoles.js'
import { ALL, P } from './librariusPerms.js'

// Invented ids, all in the 400-499 range. None of them is a real guild, role, user or channel.
const GUILD = '200000000000000400'
const READER = '200000000000000401' // the role the forum lets in
const LEGION = '200000000000000402' // a role that opens nothing at the forum
const ADMIN = '200000000000000403' // a role that carries Administrator
const OWNER = '200000000000000412'
const FORUM = '200000000000000420'

const USERS = {
  reader: { id: '300000000000000101', username: 'reader', roles: [READER] },
  legion: { id: '300000000000000102', username: 'legion', roles: [LEGION] }, // Legion only: no reader role
  plain: { id: '300000000000000103', username: 'plain', roles: [] },
  admin: { id: '300000000000000104', username: 'admin', roles: [ADMIN] },
  both: { id: '300000000000000105', username: 'both', roles: [LEGION, READER] },
  owner: { id: OWNER, username: 'owner', roles: [] }, // holds no role at all
  stranger: { id: '300000000000000107', username: 'stranger', roles: null }, // not in the guild
}

const BASE = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.SEND_MESSAGES_IN_THREADS | P.ADD_REACTIONS

// The live shape: @everyone may do the ordinary things, the forum takes View Channel from @everyone, and the reader
// role is given it back.
const live = () => ({
  ownerId: OWNER,
  roles: [
    { id: GUILD, permissions: String(BASE), name: '@everyone', color: null },
    { id: READER, permissions: '0', name: 'invented reader', color: '#aa3366' },
    { id: LEGION, permissions: '0', name: 'invented legion', color: null },
    { id: ADMIN, permissions: String(P.ADMINISTRATOR), name: 'invented admin', color: null },
  ],
  overwrites: [
    { id: GUILD, type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) },
    { id: READER, type: 0, allow: String(P.VIEW_CHANNEL), deny: '0' },
  ],
  tags: [],
})

const req = (token) => new Request('https://api.test/librarius/me', { headers: token ? { Authorization: `Bearer ${token}` } : {} })

/**
 * An access on a clock the test owns, over fakes of Discord's member lookups and of the cached guild facts. A token
 * names a user; `world.users` is who each user is right now, and `world.facts` what the guild says. `fail` makes a
 * call throw Upstream.
 */
function setup(options = {}) {
  const clock = { t: 1_000 }
  const fail = { identify: false, memberOf: false, facts: false }
  const world = { users: { ...USERS }, facts: live() }
  const tokens = { ...Object.fromEntries(Object.keys(USERS).map((k) => [k, k])), 'tok-a': 'reader', 'tok-b': 'reader' }
  const roles = {
    identify: vi.fn(async (request) => {
      if (fail.identify) throw new Upstream()
      const token = (request.headers.get('Authorization') || '').slice(7)
      const user = world.users[tokens[token] ?? token]
      return user ? { id: user.id, username: user.username } : null
    }),
    memberOf: vi.fn(async (id) => {
      if (fail.memberOf) throw new Upstream()
      const user = Object.values(world.users).find((u) => u?.id === id)
      return user.roles === null ? null : { roles: user.roles, joinedAt: '2024-01-01T00:00:00.000000+00:00' }
    }),
  }
  const guild = {
    facts: vi.fn(async () => {
      if (fail.facts) throw new Upstream()
      return structuredClone(world.facts)
    }),
  }
  const access = createLibrariusAccess({ roles, guild, guildId: GUILD, now: () => clock.t, ...options })
  return { access, roles, guild, clock, fail, world }
}

const asked = (who) => ({ id: USERS[who].id, username: USERS[who].username })

describe('the verdict', () => {
  it('lets in a member who holds the role the forum is opened to', async () => {
    const { access } = setup()
    expect(await access.resolve(req('reader'))).toStrictEqual({ user: asked('reader'), read: true, perms: BASE })
  })

  it('refuses a member of the Legion who does not hold it', async () => {
    const { access } = setup()
    expect(await access.resolve(req('legion'))).toStrictEqual({ user: asked('legion'), read: false, perms: 0n })
  })

  it('refuses a member with no role', async () => {
    const { access } = setup()
    expect(await access.resolve(req('plain'))).toStrictEqual({ user: asked('plain'), read: false, perms: 0n })
  })

  it('lets in the guild owner, who holds nothing and whom the forum shuts out like everyone', async () => {
    const { access } = setup()
    expect(await access.resolve(req('owner'))).toStrictEqual({ user: asked('owner'), read: true, perms: ALL })
  })

  it('lets in an Administrator, whatever the forum says', async () => {
    const { access } = setup()
    expect(await access.resolve(req('admin'))).toStrictEqual({ user: asked('admin'), read: true, perms: ALL })
  })

  it('lets in a member who holds both', async () => {
    const { access } = setup()
    expect((await access.resolve(req('both'))).read).toBe(true)
  })

  it('refuses someone who is not in the guild, with no permissions, and does not need the guild facts for it', async () => {
    const { access, fail } = setup()
    fail.facts = true
    expect(await access.resolve(req('stranger'))).toStrictEqual({ user: asked('stranger'), read: false, perms: 0n })
  })

  it('is null for a request with no identity, and does not look the member up', async () => {
    const { access, roles } = setup()
    expect(await access.resolve(req(null))).toBeNull()
    expect(await access.resolve(req('nobody'))).toBeNull()
    expect(roles.memberOf).not.toHaveBeenCalled()
  })

  it("lets one role's allow beat another role's deny, as Discord does", async () => {
    const { access, world } = setup()
    world.facts.overwrites.push({ id: LEGION, type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) })
    expect((await access.resolve(req('both'))).read).toBe(true)
    expect((await access.resolve(req('legion'))).read).toBe(false)
  })

  it('follows a member overwrite of its own', async () => {
    const { access, world } = setup()
    world.facts.overwrites.push({ id: USERS.plain.id, type: 1, allow: String(P.VIEW_CHANNEL), deny: '0' })
    expect((await access.resolve(req('plain'))).read).toBe(true)
    expect((await access.resolve(req('legion'))).read).toBe(false)
  })

  it('needs both View Channel and Read Message History', async () => {
    const { access, world } = setup()
    world.facts.roles[0].permissions = String(P.VIEW_CHANNEL)
    world.facts.overwrites = []
    expect(await access.resolve(req('plain'))).toStrictEqual({ user: asked('plain'), read: false, perms: P.VIEW_CHANNEL })
  })

  it('refuses everyone, the owner and an Administrator too, when the guild id is not an id', async () => {
    const ids = [undefined, null, '', 'guild', 200000000000000400, GUILD.slice(2), `${GUILD}111`, ` ${GUILD}`, [GUILD]]
    for (const guildId of ids) {
      const { access } = setup({ guildId })
      for (const who of ['reader', 'owner', 'admin']) {
        expect(await access.resolve(req(who)), `${String(guildId)} ${who}`).toStrictEqual({ user: asked(who), read: false, perms: 0n })
      }
    }
  })

  it('refuses a user whose id is not an id, even when it is the id the guild names as owner', async () => {
    for (const id of ['owner', '', '12345', `${OWNER}111`, ` ${OWNER}`]) {
      const { access, world } = setup()
      world.users.odd = { id, username: 'odd', roles: [READER] }
      world.facts.ownerId = id
      const verdict = await access.resolve(req('odd'))
      expect(verdict, id).toStrictEqual({ user: { id, username: 'odd' }, read: false, perms: 0n })
    }
  })

  it('counts roles that are not ids as no roles, and a member without a list of them as holding none', async () => {
    for (const roles of [[null, 7, {}, [READER], 'role', READER.slice(2), `${READER}111`], undefined, 'roles', {}, 8]) {
      const { access, world } = setup()
      world.users.odd = { id: '300000000000000150', username: 'odd', roles }
      const verdict = await access.resolve(req('odd'))
      expect(verdict.read, String(roles)).toBe(false)
      expect(verdict.perms).toBe(0n)
    }
  })

  it('refuses a user when the guild facts hold nothing of use', async () => {
    for (const facts of [{}, { ownerId: null, roles: null, overwrites: null }, { ownerId: 'x', roles: 'roles', overwrites: {} }]) {
      const { access, world } = setup()
      world.facts = facts
      expect((await access.resolve(req('reader'))).read, JSON.stringify(facts)).toBe(false)
    }
  })

  it('does not change the facts it is given', async () => {
    const { access, guild } = setup()
    const frozen = structuredClone(live())
    const freeze = (v) => (typeof v === 'object' && v !== null ? Object.values(Object.freeze(v)).forEach(freeze) : v)
    freeze(frozen)
    guild.facts.mockImplementation(async () => frozen)
    for (const who of ['reader', 'legion', 'owner', 'admin']) await access.resolve(req(who))
    expect(frozen).toStrictEqual(live())
  })
})

describe('the verdict: whatever the roles held and the forum says', () => {
  const OTHERS = Array.from({ length: 6 }, (_, i) => `20000000000000051${i}`)
  const noAdmin = fc.bigInt({ min: 0n, max: (1n << 48n) - 1n }).map((n) => n & ~P.ADMINISTRATOR)

  it('is a bigint, and read exactly when it holds View Channel and Read Message History', async () => {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 0n, max: ALL }), fc.bigInt({ min: 0n, max: ALL }), fc.bigInt({ min: 0n, max: ALL }), async (everyone, allow, deny) => {
        const { access, world } = setup()
        world.facts.roles[0].permissions = String(everyone)
        world.facts.overwrites = [{ id: GUILD, type: 0, allow: String(allow), deny: String(deny) }]
        const verdict = await access.resolve(req('plain'))
        const need = P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY
        expect(typeof verdict.perms).toBe('bigint')
        expect(verdict.perms >= 0n).toBe(true)
        expect(verdict.read).toBe((verdict.perms & need) === need)
      }),
    )
  })

  it('reads for a member exactly when they hold the reader role, however the other roles are set', async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray(OTHERS), fc.boolean(), fc.array(noAdmin, { minLength: 6, maxLength: 6 }), async (others, holdsReader, permissions) => {
        const { access, world } = setup()
        world.facts.roles.push(...OTHERS.map((id, i) => ({ id, permissions: String(permissions[i]), name: 'r', color: null })))
        world.users.someone = { id: '300000000000000160', username: 'someone', roles: holdsReader ? [...others, READER] : others }
        expect((await access.resolve(req('someone'))).read).toBe(holdsReader)
      }),
    )
  })

  it('is never given to someone who is not in the guild, and always to the owner', async () => {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 0n, max: ALL }), fc.bigInt({ min: 0n, max: ALL }), async (allow, deny) => {
        const { access, world } = setup()
        world.facts.overwrites = [
          { id: GUILD, type: 0, allow: String(allow), deny: String(deny) },
          { id: OWNER, type: 1, allow: '0', deny: String(ALL) },
          { id: USERS.stranger.id, type: 1, allow: String(ALL), deny: '0' },
        ]
        expect((await access.resolve(req('stranger'))).read).toBe(false)
        expect(await access.resolve(req('owner'))).toStrictEqual({ user: asked('owner'), read: true, perms: ALL })
      }),
    )
  })
})

describe('the cache', () => {
  it('reuses a verdict for 30 seconds, and asks again at 30 seconds', async () => {
    const { access, roles, clock, world } = setup()
    const first = await access.resolve(req('reader'))
    world.users.reader = { ...USERS.reader, roles: [] }
    clock.t = 1_000 + 29_999
    expect(await access.resolve(req('reader'))).toBe(first)
    expect(roles.memberOf).toHaveBeenCalledTimes(1)
    clock.t = 1_000 + 30_000
    expect(await access.resolve(req('reader'))).toStrictEqual({ user: asked('reader'), read: false, perms: 0n })
    expect(roles.memberOf).toHaveBeenCalledTimes(2)
  })

  it('reuses a verdict for the ttlMs it was given, and not a tick longer', async () => {
    const { access, clock, world } = setup({ ttlMs: 100 })
    await access.resolve(req('reader'))
    world.users.reader = { ...USERS.reader, roles: [] }
    clock.t = 1_099
    expect((await access.resolve(req('reader'))).read).toBe(true)
    clock.t = 1_100
    expect((await access.resolve(req('reader'))).read).toBe(false)
  })

  it('keeps no more verdicts than maxEntries, and drops the one it stored first', async () => {
    const { access, roles } = setup({ maxEntries: 1 })
    await access.resolve(req('reader'))
    await access.resolve(req('legion')) // takes the one place there is
    await access.resolve(req('reader'))
    expect(roles.memberOf).toHaveBeenCalledTimes(3)
  })

  it('keeps a verdict for each header, and one verdict for a header that comes again', async () => {
    const { access, roles } = setup()
    await access.resolve(req('tok-a'))
    await access.resolve(req('tok-b'))
    await access.resolve(req('tok-a'))
    await access.resolve(req('tok-b'))
    expect(roles.memberOf).toHaveBeenCalledTimes(2)
  })

  it('forgets every verdict on forget()', async () => {
    const { access, world } = setup()
    await access.resolve(req('reader'))
    await access.resolve(req('legion'))
    world.users.reader = { ...USERS.reader, roles: [] }
    world.users.legion = { ...USERS.legion, roles: [READER] }
    expect((await access.resolve(req('reader'))).read).toBe(true)
    access.forget()
    expect((await access.resolve(req('reader'))).read).toBe(false)
    expect((await access.resolve(req('legion'))).read).toBe(true)
  })

  it('does not store a verdict a forget() came in the middle of', async () => {
    const { access, roles, world } = setup()
    let release
    roles.memberOf.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    const pending = access.resolve(req('reader'))
    await new Promise((resolve) => setImmediate(resolve))
    access.forget()
    world.users.reader = { ...USERS.reader, roles: [] }
    release({ roles: [READER], joinedAt: null })
    expect((await pending).read).toBe(true)
    expect((await access.resolve(req('reader'))).read).toBe(false)
  })

  it('skips the cache, reading and writing, for a fresh verdict', async () => {
    const { access, world } = setup()
    expect((await access.resolve(req('reader'))).read).toBe(true)
    world.users.reader = { ...USERS.reader, roles: [] }
    expect((await access.resolve(req('reader'), { fresh: true })).read).toBe(false)
    expect((await access.resolve(req('reader'))).read).toBe(true) // the stored one, which the fresh one did not replace
  })

  it('does not store a verdict for a request with no Authorization header', async () => {
    const { access, roles } = setup()
    const anonymous = new Request('https://api.test/librarius/me')
    roles.identify.mockImplementation(async () => ({ id: USERS.reader.id, username: 'reader' }))
    await access.resolve(anonymous)
    await access.resolve(anonymous)
    expect(roles.memberOf).toHaveBeenCalledTimes(2)
  })

  it('does not store a missing identity', async () => {
    const { access, roles, world } = setup()
    world.users.late = undefined
    expect(await access.resolve(req('late'))).toBeNull()
    world.users.late = { id: '300000000000000160', username: 'late', roles: [READER] }
    expect((await access.resolve(req('late'))).read).toBe(true)
    expect(roles.identify).toHaveBeenCalledTimes(2)
  })
})

describe('a failure', () => {
  const calls = [
    ['identify', 'the identity'],
    ['memberOf', 'the member lookup'],
    ['facts', 'the guild facts'],
  ]

  for (const [which, what] of calls) {
    it(`propagates Upstream from ${what}, and the next call asks again instead of remembering it`, async () => {
      const { access, fail } = setup()
      fail[which] = true
      await expect(access.resolve(req('reader'))).rejects.toBeInstanceOf(Upstream)
      fail[which] = false
      expect(await access.resolve(req('reader'))).toStrictEqual({ user: asked('reader'), read: true, perms: BASE })
    })

    it(`propagates Upstream from ${what} for a fresh verdict too`, async () => {
      const { access, fail } = setup()
      fail[which] = true
      await expect(access.resolve(req('reader'), { fresh: true })).rejects.toBeInstanceOf(Upstream)
    })
  }

  it('does not fall back to an earlier verdict once its ttl has run out', async () => {
    const { access, fail, clock } = setup()
    await access.resolve(req('reader'))
    clock.t = 1_000 + 30_000
    fail.memberOf = true
    await expect(access.resolve(req('reader'))).rejects.toBeInstanceOf(Upstream)
  })

  it('does not hide a failure that is not Upstream', async () => {
    const { access, guild } = setup()
    guild.facts.mockRejectedValueOnce(new TypeError('a bug'))
    await expect(access.resolve(req('reader'))).rejects.toBeInstanceOf(TypeError)
  })
})

describe('with the cached guild facts', () => {
  const rawGuild = () => ({
    id: GUILD,
    owner_id: OWNER,
    roles: [
      { id: GUILD, name: '@everyone', color: 0, permissions: String(BASE) },
      { id: READER, name: 'invented reader', color: 0xaa3366, permissions: '0' },
      { id: LEGION, name: 'invented legion', color: 0, permissions: '0' },
    ],
  })
  const rawForum = () => ({
    id: FORUM,
    permission_overwrites: [
      { id: GUILD, type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) },
      { id: READER, type: 0, allow: String(P.VIEW_CHANNEL), deny: '0' },
    ],
    available_tags: [],
  })

  function together() {
    const clock = { t: 1_000 }
    const held = { forum: rawForum() }
    const discord = {
      guild: async () => rawGuild(),
      channel: async () => structuredClone(held.forum),
      emojis: async () => [],
    }
    const guild = createLibrariusGuild({ discord, forumId: FORUM, now: () => clock.t })
    const { access, world } = setup({ guild, now: () => clock.t })
    return { access, guild, held, world, clock }
  }

  it('lets the reader in and keeps the Legion member out, as the forum is set', async () => {
    const { access } = together()
    expect((await access.resolve(req('reader'))).read).toBe(true)
    expect((await access.resolve(req('legion'))).read).toBe(false)
    expect((await access.resolve(req('owner'))).read).toBe(true)
  })

  it("follows a change of the forum's overwrites once the guild and the verdicts are told", async () => {
    const { access, guild, held } = together()
    expect((await access.resolve(req('legion'))).read).toBe(false)
    held.forum.permission_overwrites.push({ id: LEGION, type: 0, allow: String(P.VIEW_CHANNEL), deny: '0' })
    guild.invalidate('forum')
    access.forget()
    expect((await access.resolve(req('legion'))).read).toBe(true)
  })
})
