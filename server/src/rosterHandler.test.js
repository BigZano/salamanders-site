import { describe, it, expect } from 'vitest'
import * as L from './rosterLadder.js'
import { Upstream } from './discordRoles.js'
import { createRosterHandler } from './rosterHandler.js'

const USER = { id: '200000000000000001', username: 'tester' }
const SNAP = {
  roster: { highCommand: [], branches: [], unassigned: { rows: [] }, servitors: [] },
  infirmary: [{ id: '1', name: 'Infirm' }, { id: '2', name: 'Other' }],
  fetchedAt: '2026-10-13T12:00:00.000Z',
  stale: false,
}

function setup({ user = USER, held = [L.LEGION_ROLE], snap = SNAP, identify, rolesOf, current } = {}) {
  const calls = { current: 0, rolesOf: 0 }
  const roles = {
    identify: identify ?? (async () => user),
    rolesOf: rolesOf ?? (async () => { calls.rolesOf++; return held }),
  }
  const roster = { current: current ?? (async () => { calls.current++; return snap }) }
  const handle = createRosterHandler({ roles, roster })
  const ask = (path, method = 'GET') => handle(new Request(`https://api.test${path}`, { method, headers: { Authorization: 'Bearer abc.def' } }), new URL(`https://api.test${path}`))
  return { ask, calls }
}
const body = (res) => res.json()

describe('routing', () => {
  it.each([['/builds'], ['/health'], ['/rosters'], ['/roster/other'], ['/roster/infirmary/x'], ['/']])('does not own %s', async (path) => {
    expect(await setup().ask(path)).toBe(null)
  })

  it.each(['POST', 'PUT', 'DELETE'])('does not own %s /roster', async (method) => {
    expect(await setup().ask('/roster', method)).toBe(null)
    expect(await setup().ask('/roster/infirmary', method)).toBe(null)
  })
})

describe('GET /roster', () => {
  it('returns the roster with fetchedAt, stale and the viewer flag, no-store', async () => {
    const res = await setup().ask('/roster')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(await body(res)).toEqual({ fetchedAt: SNAP.fetchedAt, stale: false, viewer: { infirmary: false }, ...SNAP.roster })
  })

  it('tells command callers they may open the Infirmary', async () => {
    for (const role of [L.CAPTAIN.id, L.HIGH_COMMAND[0].id, L.COMPANIES[4].commandRoleIds[1], L.LEGION_HIERARCHY_ROLE]) {
      const res = await setup({ held: [L.LEGION_ROLE, role] }).ask('/roster')
      expect((await body(res)).viewer).toEqual({ infirmary: true })
    }
  })

  it('passes stale through', async () => {
    const res = await setup({ snap: { ...SNAP, stale: true } }).ask('/roster')
    expect((await body(res)).stale).toBe(true)
  })

  it('is 401 without a valid identity, and then touches nothing else', async () => {
    const s = setup({ identify: async () => null })
    const res = await s.ask('/roster')
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual({ error: 'Sign in with Discord.' })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(s.calls).toEqual({ current: 0, rolesOf: 0 })
  })

  it('is 403 for anyone without the Legion role, or not in the guild, and never touches the roster', async () => {
    for (const held of [[], [L.CAPTAIN.id, L.INFIRMARY_ROLE], null]) {
      const s = setup({ held, rolesOf: async () => held })
      const res = await s.ask('/roster')
      expect(res.status).toBe(403)
      expect(await body(res)).toEqual({ error: 'The roster is open to the XVIIIth Legion.' })
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      expect(s.calls.current).toBe(0)
    }
  })

  it('is 503 when Discord is unreachable at either lookup, or when no roster has loaded', async () => {
    for (const s of [
      setup({ identify: async () => { throw new Upstream() } }),
      setup({ rolesOf: async () => { throw new Upstream() } }),
      setup({ snap: null }),
    ]) {
      const res = await s.ask('/roster')
      expect(res.status).toBe(503)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    }
    expect(await body(await setup({ snap: null }).ask('/roster'))).toEqual({ error: 'The roster is not available yet. Try again.' })
    expect(await body(await setup({ identify: async () => { throw new Upstream() } }).ask('/roster'))).toEqual({ error: 'Discord could not be reached. Try again.' })
  })

  it('lets an unexpected error escape for the server to log as a 500', async () => {
    await expect(setup({ identify: async () => { throw new TypeError('bug') } }).ask('/roster')).rejects.toThrow('bug')
  })
})

describe('GET /roster/infirmary', () => {
  it('returns the list with a count to command callers, no-store', async () => {
    const res = await setup({ held: [L.LEGION_ROLE, L.COMPANIES[2].commandRoleIds[0]] }).ask('/roster/infirmary')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await body(res)).toEqual({ fetchedAt: SNAP.fetchedAt, stale: false, count: 2, members: SNAP.infirmary })
  })

  it('is 403 for Legion members below command, and never touches the roster', async () => {
    for (const held of [[L.LEGION_ROLE], [L.LEGION_ROLE, L.VENERABLE_DREADNOUGHT.id, L.COMPANIES[0].roleId]]) {
      const s = setup({ held })
      const res = await s.ask('/roster/infirmary')
      expect(res.status).toBe(403)
      expect(await body(res)).toEqual({ error: 'The Infirmary list is open to company command and above.' })
      expect(s.calls.current).toBe(0)
    }
  })

  it('refuses a command role without the Legion role as a non-member, and never touches the roster', async () => {
    const s = setup({ held: [L.CAPTAIN.id] })
    const res = await s.ask('/roster/infirmary')
    expect(res.status).toBe(403)
    expect(await body(res)).toEqual({ error: 'The roster is open to the XVIIIth Legion.' })
    expect(s.calls.current).toBe(0)
  })

  it('is 401, 403 and 503 like /roster', async () => {
    expect((await setup({ identify: async () => null }).ask('/roster/infirmary')).status).toBe(401)
    expect((await setup({ held: [L.CAPTAIN.id] }).ask('/roster/infirmary')).status).toBe(403) // command but no Legion role
    expect((await setup({ held: [L.LEGION_ROLE, L.CAPTAIN.id], snap: null }).ask('/roster/infirmary')).status).toBe(503)
    expect((await setup({ held: [L.LEGION_ROLE, L.CAPTAIN.id], rolesOf: async () => { throw new Upstream() } }).ask('/roster/infirmary')).status).toBe(503)
  })
})
