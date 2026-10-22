import { describe, it, expect, vi } from 'vitest'
import { createDeathwatchAccess } from './deathwatchAccess'
import { Upstream } from './discordRoles'

// Invented ids only: the real role and user ids never enter the repo.
const DW = '200000000000000101'
const WC = '200000000000000102'
const LEGION = '200000000000000199'

const USERS = {
  commander: { id: '300000000000000001', username: 'commander', roles: [WC] },
  watcher: { id: '300000000000000002', username: 'watcher', roles: [DW] },
  both: { id: '300000000000000003', username: 'both', roles: [DW, WC] },
  plain: { id: '300000000000000004', username: 'plain', roles: [] },
  legion: { id: '300000000000000005', username: 'legion', roles: [LEGION] },
  stranger: { id: '300000000000000006', username: 'stranger', roles: null }, // not in the guild
}
// A bearer token names a user; two tokens may name the same one.
const TOKENS = { ...USERS, 'tok-a': USERS.watcher, 'tok-b': USERS.watcher }

const req = (token) =>
  new Request('https://api.test/deathwatch/me', { headers: token ? { Authorization: `Bearer ${token}` } : {} })

function setup({ granted = [], ...opts } = {}) {
  const clock = { t: 1_000 }
  const fail = { identify: false, roles: false }
  const roles = {
    identify: vi.fn(async (request) => {
      if (fail.identify) throw new Upstream()
      const u = TOKENS[(request.headers.get('Authorization') || '').slice(7)]
      return u ? { id: u.id, username: u.username } : null
    }),
    rolesOf: vi.fn(async (id) => {
      if (fail.roles) throw new Upstream()
      return Object.values(USERS).find((u) => u.id === id).roles
    }),
  }
  const grants = new Set(granted)
  const store = { isGranted: vi.fn(async (id) => grants.has(id)) }
  const access = createDeathwatchAccess({
    roles,
    store,
    deathwatchRoleId: DW,
    commanderRoleId: WC,
    now: () => clock.t,
    ...opts,
  })
  return { access, roles, store, clock, fail, grants }
}

describe('configured', () => {
  const make = (deathwatchRoleId, commanderRoleId) =>
    createDeathwatchAccess({ roles: {}, store: {}, deathwatchRoleId, commanderRoleId }).configured

  it('is true only when both role ids are snowflakes', () => {
    expect(make(DW, WC)).toBe(true)
    expect(make('1'.repeat(17), '1'.repeat(20))).toBe(true)
  })

  it('is false when either id is missing or malformed', () => {
    // 12345678901234567 is a number whose text is 17 digits: only the string check refuses it.
    for (const bad of [undefined, '', 'abc', '1'.repeat(16), '1'.repeat(21), ` ${DW}`, 7, 12345678901234567]) {
      expect(make(bad, WC)).toBe(false)
      expect(make(DW, bad)).toBe(false)
    }
    expect(make(undefined, undefined)).toBe(false)
  })
})

describe('the verdict', () => {
  it('gives the Commander role access and Commander status', async () => {
    const { access } = setup()
    expect(await access.resolve(req('commander'))).toEqual({
      user: { id: USERS.commander.id, username: 'commander' },
      access: true,
      watchCommander: true,
    })
  })

  it('gives the Deathwatch role access without Commander status', async () => {
    const { access } = setup()
    const v = await access.resolve(req('watcher'))
    expect([v.access, v.watchCommander]).toEqual([true, false])
  })

  it('gives both roles together both', async () => {
    const { access } = setup()
    const v = await access.resolve(req('both'))
    expect([v.access, v.watchCommander]).toEqual([true, true])
  })

  it('gives a grant access, but never Commander status', async () => {
    const { access } = setup({ granted: [USERS.plain.id] })
    const v = await access.resolve(req('plain'))
    expect([v.access, v.watchCommander]).toEqual([true, false])
  })

  it('denies the Legion role alone and a user with no roles', async () => {
    const { access } = setup()
    for (const who of ['legion', 'plain']) {
      const v = await access.resolve(req(who))
      expect([v.access, v.watchCommander]).toEqual([false, false])
    }
  })

  it('lets a granted user who is not in the guild in', async () => {
    const { access } = setup({ granted: [USERS.stranger.id] })
    const v = await access.resolve(req('stranger'))
    expect([v.access, v.watchCommander]).toEqual([true, false])
  })

  it('denies, without an error, a user who is not in the guild and has no grant', async () => {
    const { access } = setup()
    const v = await access.resolve(req('stranger'))
    expect([v.access, v.watchCommander]).toEqual([false, false])
  })

  it('does not touch the grants table for someone a role already admits', async () => {
    const { access, store } = setup()
    await access.resolve(req('watcher'))
    await access.resolve(req('commander'))
    expect(store.isGranted).not.toHaveBeenCalled()
  })

  it('asks the grants table about the user it identified', async () => {
    const { access, store } = setup()
    await access.resolve(req('plain'))
    expect(store.isGranted).toHaveBeenCalledWith(USERS.plain.id)
  })
})

describe('no identity, no cache', () => {
  it('returns null for no Authorization header and for an unknown token, and caches neither', async () => {
    const { access, roles } = setup()
    expect(await access.resolve(req(null))).toBeNull()
    expect(await access.resolve(req('nobody'))).toBeNull()
    expect(await access.resolve(req('nobody'))).toBeNull()
    expect(roles.identify).toHaveBeenCalledTimes(3)
    expect(roles.rolesOf).not.toHaveBeenCalled()
  })
})

describe('Discord failures fail closed', () => {
  it('rejects with Upstream when identify fails, and does not cache the failure', async () => {
    const { access, fail } = setup()
    fail.identify = true
    await expect(access.resolve(req('watcher'))).rejects.toBeInstanceOf(Upstream)
    fail.identify = false
    expect((await access.resolve(req('watcher'))).access).toBe(true)
  })

  it('rejects with Upstream when the role lookup fails, even for a granted user', async () => {
    const { access, fail } = setup({ granted: [USERS.plain.id] })
    fail.roles = true
    await expect(access.resolve(req('plain'))).rejects.toBeInstanceOf(Upstream)
    fail.roles = false
    expect((await access.resolve(req('plain'))).access).toBe(true)
  })
})

describe('the verdict cache', () => {
  it('serves a verdict for ttlMs and looks again one millisecond later', async () => {
    const { access, roles, clock } = setup()
    await access.resolve(req('watcher'))
    clock.t = 1_000 + 29_999
    await access.resolve(req('watcher'))
    expect(roles.identify).toHaveBeenCalledTimes(1)
    expect(roles.rolesOf).toHaveBeenCalledTimes(1)
    clock.t = 1_000 + 30_000
    await access.resolve(req('watcher'))
    expect(roles.identify).toHaveBeenCalledTimes(2)
  })

  it('honours a different ttlMs', async () => {
    const { access, roles, clock } = setup({ ttlMs: 5 })
    await access.resolve(req('watcher'))
    clock.t = 1_004
    await access.resolve(req('watcher'))
    expect(roles.identify).toHaveBeenCalledTimes(1)
    clock.t = 1_005
    await access.resolve(req('watcher'))
    expect(roles.identify).toHaveBeenCalledTimes(2)
  })

  it('keeps a separate entry per token, even for tokens that differ in one character', async () => {
    const { access, roles } = setup()
    await access.resolve(req('tok-a'))
    await access.resolve(req('tok-b'))
    expect(roles.identify).toHaveBeenCalledTimes(2)
    await access.resolve(req('tok-a'))
    await access.resolve(req('tok-b'))
    expect(roles.identify).toHaveBeenCalledTimes(2)
  })

  it('lets fresh bypass the cache and leaves the cache as it was', async () => {
    const { access, roles } = setup()
    await access.resolve(req('watcher'))
    await access.resolve(req('watcher'), { fresh: true })
    expect(roles.identify).toHaveBeenCalledTimes(2)
    await access.resolve(req('watcher'))
    expect(roles.identify).toHaveBeenCalledTimes(2)
  })

  it('does not cache what a fresh call learned', async () => {
    const { access, roles } = setup()
    await access.resolve(req('watcher'), { fresh: true })
    await access.resolve(req('watcher'))
    expect(roles.identify).toHaveBeenCalledTimes(2)
  })

  it('drops every cached verdict on forget', async () => {
    const { access, roles, grants } = setup()
    expect((await access.resolve(req('plain'))).access).toBe(false)
    grants.add(USERS.plain.id)
    expect((await access.resolve(req('plain'))).access).toBe(false) // still the cached answer
    access.forget()
    expect((await access.resolve(req('plain'))).access).toBe(true)
    expect(roles.identify).toHaveBeenCalledTimes(2)
  })

  it('is bounded: a full cache evicts its oldest entry', async () => {
    const { access, roles } = setup({ maxEntries: 2 })
    await access.resolve(req('watcher'))
    await access.resolve(req('commander'))
    await access.resolve(req('plain')) // evicts watcher
    expect(roles.identify).toHaveBeenCalledTimes(3)
    await access.resolve(req('commander'))
    await access.resolve(req('plain'))
    expect(roles.identify).toHaveBeenCalledTimes(3)
    await access.resolve(req('watcher')) // gone, looked up again
    expect(roles.identify).toHaveBeenCalledTimes(4)
  })
})
