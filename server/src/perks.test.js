import { describe, it, expect, vi } from 'vitest'
import { createPerksHandler, validateCorrection } from './perks'
import { createPrivileges, ROLE_IDS as R } from './privileges'
import { Upstream } from './discordRoles'

const USERS = {
  member: { id: '100000000000000001', username: 'member', roles: ['1377787723976409211'] },
  tm: { id: '100000000000000002', username: 'tm', roles: [R.techmarine] },
  tm2: { id: '100000000000000006', username: 'tm2', roles: [R.techmarine] },
  forge: { id: '100000000000000003', username: 'forge', roles: [R.forge] },
  lh: { id: '100000000000000004', username: 'lh', roles: [R.hierarchy] },
  admin: { id: '100000000000000005', username: 'admin', roles: [], admin: true },
}
const byId = (id) => Object.values(USERS).find((u) => u.id === id)

function fakeRoles({ fail } = {}) {
  return {
    identify: async (req) => {
      if (fail) throw new Upstream()
      const u = USERS[(req.headers.get('Authorization') || '').slice(7)]
      return u ? { id: u.id, username: u.username } : null
    },
    rolesOf: async (id) => byId(id)?.roles ?? null,
    isAdmin: async (id) => !!byId(id)?.admin,
  }
}

// In-memory stand-in with historyStore.js's contract.
function memStore() {
  const corrections = []
  const events = []
  const revocations = []
  const ev = (e) => events.push({ id: events.length + 1, createdAt: 't', ...e })
  return {
    corrections, events, revocations,
    listActive: async () => corrections.filter((c) => c.active),
    insertCorrection: async (c, actor, before = null) => {
      const row = { ...c, id: corrections.length + 1, active: true, author: actor, createdAt: `t${corrections.length + 1}` }
      corrections.push(row)
      ev({ subject: 'perk_correction', subjectId: String(row.id), action: 'created', actor, snapshot: { ...row, before }, note: c.note })
      return row
    },
    revertCorrection: async (id, actor, note) => {
      const c = corrections.find((x) => x.id === id)
      if (!c) return 'missing'
      if (!c.active) return 'conflict'
      c.active = false
      ev({ subject: 'perk_correction', subjectId: String(id), action: 'reverted', actor, snapshot: c, note })
      return c
    },
    history: async ({ subject }) => ({ events: events.filter((e) => !subject || e.subject === subject).reverse(), next: null }),
    openRevocation: async (id) => revocations.find((r) => r.discordId === id && !r.liftedAt) || null,
    listOpenRevocations: async () => revocations.filter((r) => !r.liftedAt),
    revoke: async (target, actor, reason) => {
      if (revocations.some((r) => r.discordId === target.id && !r.liftedAt)) return 'conflict'
      const r = { id: revocations.length + 1, discordId: target.id, username: target.username, revokedBy: actor, reason, liftedAt: null }
      revocations.push(r)
      ev({ subject: 'privilege', subjectId: target.id, action: 'revoked', actor, snapshot: r, note: reason })
      return r
    },
    reinstate: async (id, actor) => {
      const r = revocations.find((x) => x.discordId === id && !x.liftedAt)
      if (!r) return 'conflict'
      r.liftedAt = 't'
      r.liftedBy = actor
      return r
    },
  }
}

const BAKE = {
  weapons: {
    'Las Fusil': {
      perks: [
        { name: 'Perpetual Velocity', quality: 'Relic', description: 'pv' },
        { name: 'Increased Capacity', quality: 'Standard', description: 'ic' },
      ],
    },
  },
  classes: { Tactical: { perks: { 'Adrenaline Rush': { level: 2, description: 'ar' } } } },
}

function setup(over = {}) {
  const roles = fakeRoles(over)
  const store = memStore()
  const notify = vi.fn()
  const handle = createPerksHandler({
    roles,
    privileges: createPrivileges({ roles, store }),
    store,
    loadBake: over.loadBake || (async () => BAKE),
    notify,
  })
  async function call(who, method, path, body) {
    const headers = who ? { Authorization: `Bearer ${who}` } : {}
    const req = new Request(`https://api.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const res = await handle(req, new URL(req.url))
    return res && { status: res.status, body: await res.json(), headers: res.headers }
  }
  return { store, notify, call }
}

const REMOVE_PV = { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'remove', perkName: 'Perpetual Velocity', note: 'checked in game' }
const ADD_HH = { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'add', perkName: 'Head Hunter', description: 'Headshots deal 10% more Damage' }

describe('routing and the public document', () => {
  it('ignores other paths', async () => {
    expect(await setup().call(null, 'GET', '/builds')).toBeNull()
  })

  it('serves the document to anyone, briefly cacheable', async () => {
    const { call } = setup()
    await call('tm', 'POST', '/perk-corrections', REMOVE_PV)
    const res = await call(null, 'GET', '/perk-corrections')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30')
    expect(res.body.weapons['Las Fusil'][0]).toMatchObject({ op: 'remove', perkName: 'Perpetual Velocity' })
    expect(JSON.stringify(res.body)).not.toContain('100000000000000002')
  })
})

describe('POST /perk-corrections', () => {
  it('401 without a token, 403 for a plain member', async () => {
    const { call } = setup()
    expect((await call(null, 'POST', '/perk-corrections', REMOVE_PV)).status).toBe(401)
    expect((await call('member', 'POST', '/perk-corrections', REMOVE_PV)).status).toBe(403)
  })

  it.each(['tm', 'forge', 'lh', 'admin'])('%s may correct; the webhook says what changed', async (who) => {
    const { call, notify } = setup()
    const res = await call(who, 'POST', '/perk-corrections', ADD_HH)
    expect(res.status).toBe(201)
    expect(res.body.weapons['Las Fusil'][0]).toMatchObject({ op: 'add', perkName: 'Head Hunter' })
    expect(notify).toHaveBeenCalledWith(`Perk correction by ${USERS[who].username}: Las Fusil / Relic — added Head Hunter`)
  })

  it('404 when removing or editing a perk that is not in that tier', async () => {
    const { call } = setup()
    expect((await call('tm', 'POST', '/perk-corrections', { ...REMOVE_PV, quality: 'Standard' })).status).toBe(404)
    expect((await call('tm', 'POST', '/perk-corrections', { ...REMOVE_PV, perkName: 'Nope' })).status).toBe(404)
    expect((await call('tm', 'POST', '/perk-corrections', { ...REMOVE_PV, target: 'Nope Rifle' })).status).toBe(404)
  })

  it('a perk added by an earlier correction can then be edited or removed', async () => {
    const { call } = setup()
    await call('tm', 'POST', '/perk-corrections', ADD_HH)
    expect((await call('tm', 'POST', '/perk-corrections', { ...ADD_HH, op: 'edit', description: 'x' })).status).toBe(201)
    expect((await call('tm', 'POST', '/perk-corrections', { ...ADD_HH, op: 'remove' })).status).toBe(201)
  })

  it('a perk already removed cannot be removed again', async () => {
    const { call } = setup()
    await call('tm', 'POST', '/perk-corrections', REMOVE_PV)
    expect((await call('tm', 'POST', '/perk-corrections', REMOVE_PV)).status).toBe(404)
  })

  it('class perks: edit only, and only existing perks', async () => {
    const { call } = setup()
    const base = { kind: 'class', target: 'Tactical', perkName: 'Adrenaline Rush', description: 'new' }
    expect((await call('tm', 'POST', '/perk-corrections', { ...base, op: 'edit' })).status).toBe(201)
    expect((await call('tm', 'POST', '/perk-corrections', { ...base, op: 'add' })).status).toBe(400)
    expect((await call('tm', 'POST', '/perk-corrections', { ...base, op: 'edit', perkName: 'Nope' })).status).toBe(404)
  })

  it('a revoked editor is refused', async () => {
    const { call } = setup()
    await call('forge', 'POST', '/privileges/100000000000000002/revoke', { reason: 'bad edits', username: 'tm' })
    const res = await call('tm', 'POST', '/perk-corrections', ADD_HH)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/revoked/)
  })

  it('503 when Discord or the bake is unreachable', async () => {
    expect((await setup({ fail: true }).call('tm', 'POST', '/perk-corrections', ADD_HH)).status).toBe(503)
    const noBake = setup({ loadBake: async () => { throw new Upstream() } })
    expect((await noBake.call('tm', 'POST', '/perk-corrections', REMOVE_PV)).status).toBe(503)
  })

  it('rejects prototype-key targets and class perk names, and never poisons the document', async () => {
    const { call } = setup()
    expect((await call('tm', 'POST', '/perk-corrections', { ...ADD_HH, target: 'constructor' })).status).toBe(404)
    expect((await call('tm', 'POST', '/perk-corrections', { ...ADD_HH, target: '__proto__' })).status).toBe(404)
    expect(
      (await call('tm', 'POST', '/perk-corrections', { kind: 'class', target: 'Tactical', op: 'edit', perkName: 'constructor', description: 'x' })).status,
    ).toBe(404)
    expect((await call(null, 'GET', '/perk-corrections')).status).toBe(200)
  })
})

describe('what a correction replaced', () => {
  const created = (store) => store.events.filter((e) => e.action === 'created').at(-1).snapshot

  it('an add records nothing before it', async () => {
    const { call, store } = setup()
    await call('tm', 'POST', '/perk-corrections', ADD_HH)
    expect(created(store).before).toBeNull()
  })

  it("an edit records the bake's description", async () => {
    const { call, store } = setup()
    await call('tm', 'POST', '/perk-corrections', { ...REMOVE_PV, op: 'edit', description: 'new pv' })
    expect(created(store).before).toEqual({ name: 'Perpetual Velocity', description: 'pv' })
    expect(created(store).description).toBe('new pv')
  })

  it('a remove records the removed perk', async () => {
    const { call, store } = setup()
    await call('tm', 'POST', '/perk-corrections', REMOVE_PV)
    expect(created(store).before).toEqual({ name: 'Perpetual Velocity', description: 'pv' })
  })

  it("editing an already-edited perk records the previous correction's text", async () => {
    const { call, store } = setup()
    await call('tm', 'POST', '/perk-corrections', { ...REMOVE_PV, op: 'edit', description: 'first' })
    await call('tm', 'POST', '/perk-corrections', { ...REMOVE_PV, op: 'edit', description: 'second' })
    expect(created(store).before).toEqual({ name: 'Perpetual Velocity', description: 'first' })
  })

  it('a class edit records the current class-perk text, after corrections', async () => {
    const { call, store } = setup()
    const base = { kind: 'class', target: 'Tactical', op: 'edit', perkName: 'Adrenaline Rush' }
    await call('tm', 'POST', '/perk-corrections', { ...base, description: 'one' })
    expect(created(store).before).toEqual({ name: 'Adrenaline Rush', description: 'ar' })
    await call('tm', 'POST', '/perk-corrections', { ...base, description: 'two' })
    expect(created(store).before).toEqual({ name: 'Adrenaline Rush', description: 'one' })
  })
})

describe('duplicate adds', () => {
  it('409 when the tier already has a perk by that name (bake or added)', async () => {
    const { call } = setup()
    const dupBake = await call('tm', 'POST', '/perk-corrections', { ...ADD_HH, perkName: 'Perpetual Velocity' })
    expect(dupBake.status).toBe(409)
    expect(dupBake.body.error).toBe('That tier already has a perk named Perpetual Velocity.')
    expect((await call('tm', 'POST', '/perk-corrections', ADD_HH)).status).toBe(201)
    expect((await call('tm', 'POST', '/perk-corrections', ADD_HH)).status).toBe(409)
    expect((await call('tm', 'POST', '/perk-corrections', { ...ADD_HH, quality: 'Heroic' })).status).toBe(201)
  })
})

describe('validateCorrection', () => {
  it.each([
    [null, /Malformed/],
    [{ ...ADD_HH, kind: 'armour' }, /weapon or class/],
    [{ ...ADD_HH, quality: 'Legendary' }, /tier/],
    [{ ...ADD_HH, op: 'swap' }, /add, remove or edit/],
    [{ ...ADD_HH, perkName: '' }, /Name the perk/],
    [{ ...ADD_HH, perkName: 'x'.repeat(81) }, /Name the perk/],
    [{ ...ADD_HH, perkName: '<script>' }, /letters, numbers and basic punctuation/],
    [{ ...ADD_HH, description: '' }, /Describe/],
    [{ ...ADD_HH, description: 'x'.repeat(501) }, /Describe/],
    [{ ...ADD_HH, note: 'x'.repeat(201) }, /Note/],
  ])('rejects %j', (body, msg) => {
    expect(validateCorrection(body)).toMatch(msg)
  })

  it('trims, and drops the description on a remove', () => {
    expect(validateCorrection({ ...REMOVE_PV, perkName: '  Perpetual Velocity ', description: 'ignored' })).toMatchObject({
      perkName: 'Perpetual Velocity',
      description: null,
    })
  })

  it('sanitizes before checking length: padding whitespace is free, but 501 real characters is not', () => {
    const padded = validateCorrection({ ...ADD_HH, description: `  ${'x'.repeat(500)}  ` })
    expect(typeof padded).toBe('object')
    expect(padded.description).toBe('x'.repeat(500))
    expect(validateCorrection({ ...ADD_HH, description: 'x'.repeat(501) })).toMatch(/Describe/)
  })

  it('cleans a zero-width space and doubled spaces out of the perk name', () => {
    const c = validateCorrection({ ...ADD_HH, perkName: 'Head\u200B  Hunter' })
    expect(c).toMatchObject({ perkName: 'Head Hunter' })
  })

  it('strips a bidi override out of the description', () => {
    const c = validateCorrection({ ...ADD_HH, description: 'Deals\u202E more damage' })
    expect(c.description).toBe('Deals more damage')
  })
})

describe('revert', () => {
  it('reverts once, 409 the second time, 404 for unknown ids', async () => {
    const { call, notify } = setup()
    await call('tm', 'POST', '/perk-corrections', REMOVE_PV)
    const res = await call('lh', 'POST', '/perk-corrections/1/revert', { note: 'wrong' })
    expect(res.status).toBe(200)
    expect(res.body.weapons).toEqual({})
    expect(notify).toHaveBeenLastCalledWith('lh reverted perk correction #1 (Las Fusil / Relic — removed Perpetual Velocity): wrong')
    expect((await call('lh', 'POST', '/perk-corrections/1/revert')).status).toBe(409)
    expect((await call('lh', 'POST', '/perk-corrections/99/revert')).status).toBe(404)
    expect((await call('member', 'POST', '/perk-corrections/1/revert')).status).toBe(403)
  })
})

describe('GET /history', () => {
  it('editors only; bad subject is 400', async () => {
    const { call } = setup()
    await call('tm', 'POST', '/perk-corrections', REMOVE_PV)
    expect((await call('member', 'GET', '/history')).status).toBe(403)
    expect((await call('lh', 'GET', '/history?subject=nope')).status).toBe(400)
    const res = await call('lh', 'GET', '/history?subject=perk_correction')
    expect(res.status).toBe(200)
    expect(res.body.events[0]).toMatchObject({ action: 'created', actor: { username: 'tm' } })
  })

  it('open revocations only for someone who can revoke', async () => {
    const { call } = setup()
    await call('forge', 'POST', '/privileges/100000000000000002/revoke', { reason: 'r', username: 'tm' })
    expect((await call('lh', 'GET', '/history')).body.revocations).toEqual([])
    expect((await call('forge', 'GET', '/history')).body.revocations).toHaveLength(1)
  })

  it('a search term over 80 characters is rejected', async () => {
    const { call } = setup()
    const res = await call('lh', 'GET', `/history?q=${'x'.repeat(81)}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/too long/)
  })
})

describe('privileges', () => {
  it('/privileges/me reports the caller', async () => {
    const { call } = setup()
    expect((await call('forge', 'GET', '/privileges/me')).body).toEqual({
      id: USERS.forge.id,
      editor: true,
      historyViewer: true,
      moderator: true,
      revoked: false,
      revoker: 'forge',
    })
    expect((await call('lh', 'GET', '/privileges/me')).body).toMatchObject({ editor: true, moderator: false, revoker: null })
  })

  it('forge revokes a techmarine; reason required; double revoke 409; reinstate', async () => {
    const { call, notify } = setup()
    const path = '/privileges/100000000000000002'
    expect((await call('forge', 'POST', `${path}/revoke`, { username: 'tm' })).status).toBe(400)
    expect((await call('forge', 'POST', `${path}/revoke`, { reason: 'vandalism', username: 'tm' })).status).toBe(201)
    expect(notify).toHaveBeenLastCalledWith('forge revoked site privileges for tm: vandalism')
    expect((await call('forge', 'POST', `${path}/revoke`, { reason: 'again', username: 'tm' })).status).toBe(409)
    expect((await call('tm', 'GET', '/privileges/me')).body).toMatchObject({ editor: false, revoked: true })
    expect((await call('forge', 'POST', `${path}/reinstate`)).status).toBe(200)
    expect((await call('forge', 'POST', `${path}/reinstate`)).status).toBe(409)
    expect((await call('tm', 'GET', '/privileges/me')).body).toMatchObject({ editor: true, revoked: false })
  })

  it('who may revoke whom', async () => {
    const { call } = setup()
    const r = (who, target) => call(who, 'POST', `/privileges/${USERS[target].id}/revoke`, { reason: 'x', username: target })
    expect((await r('forge', 'lh')).status).toBe(403)
    expect((await r('lh', 'forge')).status).toBe(403)
    expect((await r('lh', 'tm')).status).toBe(403)
    expect((await r('tm', 'tm2')).status).toBe(403)
    expect((await r('admin', 'forge')).status).toBe(201)
    expect((await r('admin', 'lh')).status).toBe(201)
    expect((await r('admin', 'admin')).status).toBe(403)
  })

  it('404 for someone not in the guild', async () => {
    expect((await setup().call('admin', 'POST', '/privileges/199999999999999999/revoke', { reason: 'x' })).status).toBe(404)
  })

  it('a username over 100 characters is rejected, not truncated', async () => {
    const { call } = setup()
    const res = await call('forge', 'POST', '/privileges/100000000000000002/revoke', { reason: 'x', username: 'x'.repeat(101) })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Username is too long/)
  })

  it('refuses a non-revoker before looking up the target (no guild-membership probing)', async () => {
    const { call } = setup()
    expect((await call('member', 'POST', '/privileges/199999999999999999/revoke', { reason: 'x' })).status).toBe(403)
    expect((await call('lh', 'POST', '/privileges/199999999999999999/revoke', { reason: 'x' })).status).toBe(403)
  })

  it('a revoked forge cannot revoke others', async () => {
    const { call } = setup()
    await call('admin', 'POST', `/privileges/${USERS.forge.id}/revoke`, { reason: 'x', username: 'forge' })
    const res = await call('forge', 'POST', `/privileges/${USERS.tm.id}/revoke`, { reason: 'y', username: 'tm' })
    expect(res.status).toBe(403)
  })
})
