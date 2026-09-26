import { describe, it, expect, vi } from 'vitest'
import { createReportsHandler, validate } from './reports'
import { Upstream } from './discordRoles'

const MEMBER = '1377787723976409211'
const RECLUSIARCH = '1323334632904855592'
const USERS = {
  member: { id: '100000000000000001', username: 'member', roles: [MEMBER] },
  recl: { id: '100000000000000002', username: 'recl', roles: [MEMBER, RECLUSIARCH] },
  admin: { id: '100000000000000003', username: 'admin', roles: [MEMBER], admin: true },
  outsider: { id: '100000000000000004', username: 'outsider', roles: [] },
  stranger: { id: '100000000000000005', username: 'stranger', roles: null },
}

// Discord stand-in: the bearer token is the USERS key.
function fakeRoles({ fail } = {}) {
  const who = (request) => USERS[(request.headers.get('Authorization') || '').slice(7)] || null
  return {
    identify: async (request) => {
      if (fail) throw new Upstream()
      const u = who(request)
      return u && { id: u.id, username: u.username }
    },
    rolesOf: async (id) => Object.values(USERS).find((u) => u.id === id).roles,
    isAdmin: async (id) => !!Object.values(USERS).find((u) => u.id === id).admin,
  }
}

// In-memory store with the same transition contract as reportsStore.js.
function memStore() {
  const rows = []
  return {
    rows,
    insert: async (f, actor) => {
      rows.push({ id: rows.length + 1, ...f, reporter: actor, status: 'received', createdAt: 't0', updatedAt: 't0', handler: null, resolutionNote: null, events: [{ action: 'filed', actor }] })
      return rows.length
    },
    listByReporter: async (id) => rows.filter((r) => r.reporter.id === id),
    listAll: async () => [...rows],
    get: async (id) => rows.find((r) => r.id === id) || null,
    transition: async (id, { from, to, claim, note, actor, action }) => {
      const r = rows.find((x) => x.id === id)
      if (!r) return 'missing'
      if (!from.includes(r.status)) return 'conflict'
      r.status = to
      if (claim) r.handler = actor
      if (to === 'resolved' || to === 'escalated') r.resolutionNote = note
      r.events.push({ action, actor, note })
      return r
    },
  }
}

const GOOD = { reportedMember: 'Brother X', description: 'Said things.', medium: 'voice', witnesses: 'Y', incidentDate: '2026-09-20' }

function setup(over = {}) {
  const store = memStore()
  const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'))
  const handle = createReportsHandler({
    roles: fakeRoles(over),
    store,
    reporterRoleId: MEMBER,
    reviewerRoleId: RECLUSIARCH,
    webhookUrl: 'https://discord.test/hook',
    siteUrl: 'https://site.test',
    fetchImpl,
    ...over,
  })
  async function call(who, method, path, body) {
    const headers = who ? { Authorization: `Bearer ${who}` } : {}
    const req = new Request(`https://api.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const res = await handle(req, new URL(req.url))
    return res && { status: res.status, body: await res.json() }
  }
  return { store, fetchImpl, call }
}

describe('reports routing', () => {
  it('ignores non-report paths', async () => {
    const { call } = setup()
    expect(await call('member', 'GET', '/builds')).toBeNull()
    expect(await call('member', 'GET', '/reportsx')).toBeNull()
  })

  it('401 without a valid token, 503 when Discord is down', async () => {
    expect((await setup().call(null, 'GET', '/reports/mine')).status).toBe(401)
    expect((await setup().call('nobody', 'GET', '/reports/mine')).status).toBe(401)
    expect((await setup({ fail: true }).call('member', 'GET', '/reports/mine')).status).toBe(503)
  })

  it('reports each caller\'s access', async () => {
    const { call } = setup()
    expect((await call('member', 'GET', '/reports/access')).body).toEqual({ reporter: true, reviewer: false, admin: false })
    expect((await call('recl', 'GET', '/reports/access')).body).toEqual({ reporter: true, reviewer: true, admin: false })
    expect((await call('admin', 'GET', '/reports/access')).body).toEqual({ reporter: true, reviewer: false, admin: true })
    expect((await call('stranger', 'GET', '/reports/access')).body).toEqual({ reporter: false, reviewer: false, admin: false })
  })
})

describe('filing', () => {
  it('lets a member file, records them as reporter and pings the webhook with the id only', async () => {
    const { call, store, fetchImpl } = setup()
    const res = await call('member', 'POST', '/reports', { ...GOOD, reporter: { id: 'forged' } })
    expect(res).toEqual({ status: 201, body: { id: 1 } })
    expect(store.rows[0].reporter.id).toBe(USERS.member.id)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://discord.test/hook')
    const posted = JSON.parse(init.body)
    expect(posted.content).toBe('New member report #1 — review: https://site.test/reports/review')
    expect(init.body).not.toContain('Brother X')
  })

  it('refuses non-members and people outside the guild', async () => {
    const { call, store } = setup()
    expect((await call('outsider', 'POST', '/reports', GOOD)).status).toBe(403)
    expect((await call('stranger', 'POST', '/reports', GOOD)).status).toBe(403)
    expect(store.rows).toHaveLength(0)
  })

  it('rejects malformed bodies with 400', async () => {
    const { call } = setup()
    expect((await call('member', 'POST', '/reports', { ...GOOD, medium: 'carrier pigeon' })).status).toBe(400)
  })

  it('still files when the webhook fails', async () => {
    const log = vi.fn()
    const { call } = setup({ fetchImpl: vi.fn().mockRejectedValue(new Error('down')), log })
    expect((await call('member', 'POST', '/reports', GOOD)).status).toBe(201)
    await new Promise((r) => setTimeout(r))
    expect(log).toHaveBeenCalled()
  })

  it('shows a reporter only their own reports, status fields only', async () => {
    const { call } = setup()
    await call('member', 'POST', '/reports', GOOD)
    await call('recl', 'POST', '/reports', GOOD)
    const mine = (await call('member', 'GET', '/reports/mine')).body
    expect(mine).toHaveLength(1)
    expect(Object.keys(mine[0]).sort()).toEqual(['createdAt', 'id', 'reportedMember', 'status', 'updatedAt'])
  })
})

describe('review', () => {
  async function filed() {
    const s = setup()
    await s.call('member', 'POST', '/reports', GOOD)
    return s
  }

  it('lets Reclusiarchs and Admins read, nobody else', async () => {
    const { call } = await filed()
    expect((await call('recl', 'GET', '/reports')).body).toHaveLength(1)
    expect((await call('admin', 'GET', '/reports/1')).body.reportedMember).toBe('Brother X')
    expect((await call('member', 'GET', '/reports')).status).toBe(403)
    expect((await call('member', 'GET', '/reports/1')).status).toBe(403)
    expect((await call('recl', 'GET', '/reports/9')).status).toBe(404)
  })

  it('walks claim → resolve, recording handler and events', async () => {
    const { call } = await filed()
    const claimed = await call('recl', 'POST', '/reports/1/claim')
    expect(claimed.body).toMatchObject({ status: 'under_review', handler: { id: USERS.recl.id } })
    expect((await call('recl', 'POST', '/reports/1/resolve', {})).status).toBe(400)
    const done = await call('recl', 'POST', '/reports/1/resolve', { note: 'Talked to him.' })
    expect(done.body).toMatchObject({ status: 'resolved', resolutionNote: 'Talked to him.' })
    expect(done.body.events.map((e) => e.action)).toEqual(['filed', 'claimed', 'resolved'])
  })

  it('escalates without a note, and refuses out-of-order moves with 409', async () => {
    const { call } = await filed()
    expect((await call('recl', 'POST', '/reports/1/escalate')).status).toBe(409)
    await call('recl', 'POST', '/reports/1/claim')
    expect((await call('recl', 'POST', '/reports/1/claim')).status).toBe(409)
    expect((await call('recl', 'POST', '/reports/1/escalate')).body.status).toBe('escalated')
  })

  it('keeps Admins read-only except for reopen, which needs a reason', async () => {
    const { call } = await filed()
    expect((await call('admin', 'POST', '/reports/1/claim')).status).toBe(403)
    expect((await call('recl', 'POST', '/reports/1/reopen', { note: 'x' })).status).toBe(403)
    await call('recl', 'POST', '/reports/1/claim')
    await call('recl', 'POST', '/reports/1/resolve', { note: 'ok' })
    expect((await call('admin', 'POST', '/reports/1/reopen', {})).status).toBe(400)
    expect((await call('admin', 'POST', '/reports/1/reopen', { note: 'Should have escalated.' })).body.status).toBe('under_review')
  })

  it('404s an action on a missing report', async () => {
    const { call } = await filed()
    expect((await call('recl', 'POST', '/reports/9/claim')).status).toBe(404)
  })
})

describe('validate', () => {
  it('trims, drops mediumOther unless medium is other, nulls a blank date', () => {
    expect(validate({ ...GOOD, reportedMember: '  X ', mediumOther: 'junk', incidentDate: '' })).toMatchObject({
      reportedMember: 'X', mediumOther: '', incidentDate: null,
    })
  })

  it.each([
    [null],
    [{ ...GOOD, reportedMember: ' ' }],
    [{ ...GOOD, description: 'x'.repeat(4001) }],
    [{ ...GOOD, medium: 'other', mediumOther: '' }],
    [{ ...GOOD, incidentDate: '2026-13-45' }],
    [{ ...GOOD, incidentDate: 'yesterday' }],
  ])('rejects bad input #%#', (b) => {
    expect(typeof validate(b)).toBe('string')
  })
})
