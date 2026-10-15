import { describe, it, expect } from 'vitest'
import { publicRoster } from './rosterPublic.js'
import { createRosterPublicHandler } from './rosterPublicHandler.js'

const rank = { key: 'captain', label: 'Captain', tier: 1 }
const SNAP = {
  roster: {
    highCommand: [{ rank: { key: 'chapter-master', label: 'Chapter Master', tier: 2 }, members: [{ id: '200000000000000001', name: 'Hero', avatar: 'https://cdn.discordapp.com/x.png' }] }],
    branches: [{ key: 'company-3', kind: 'company', label: '3rd Battle Company', number: 3, head: { rank, members: [{ id: '200000000000000002', name: 'Cap' }], vacant: false }, aside: [], rows: [] }],
    unassigned: { rows: [] },
    servitors: [],
  },
  infirmary: [{ id: '200000000000000003', name: 'Infirm' }],
  fetchedAt: '2026-10-13T12:00:00.000Z',
  stale: false,
}

function setup({ current, project } = {}) {
  const roster = { current: current ?? (async () => SNAP) }
  const handle = createRosterPublicHandler({ roster, ...(project ? { project } : {}) })
  const ask = (path, method = 'GET', headers = {}) =>
    handle(new Request(`https://api.test${path}`, { method, headers }), new URL(`https://api.test${path}`))
  return { ask }
}
const body = (res) => res.json()

describe('routing', () => {
  it.each([['/roster'], ['/roster/infirmary'], ['/roster/public/x'], ['/roster/publics'], ['/builds'], ['/health'], ['/']])('does not own %s', async (path) => {
    expect(await setup().ask(path)).toBe(null)
  })

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('does not own %s /roster/public', async (method) => {
    expect(await setup().ask('/roster/public', method)).toBe(null)
  })
})

describe('GET /roster/public', () => {
  it('returns the projection with fetchedAt and stale, publicly cacheable for a minute', async () => {
    const res = await setup().ask('/roster/public')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(await body(res)).toEqual({ fetchedAt: SNAP.fetchedAt, stale: false, ...publicRoster(SNAP.roster) })
  })

  it('names the heads and nobody else, and carries no id or avatar', async () => {
    const text = JSON.stringify(await body(await setup().ask('/roster/public')))
    expect(text).toContain('Hero')
    expect(text).toContain('Cap')
    expect(text).not.toContain('Infirm')
    expect(text).not.toMatch(/\d{17,20}/)
    expect(text).not.toContain('cdn.discordapp.com')
  })

  it('passes stale through', async () => {
    const res = await setup({ current: async () => ({ ...SNAP, stale: true }) }).ask('/roster/public')
    expect((await body(res)).stale).toBe(true)
  })

  it.each([[{}], [{ Authorization: 'Bearer abc.def' }], [{ Authorization: 'garbage' }]])('answers the same whatever Authorization says (%j)', async (headers) => {
    const res = await setup().ask('/roster/public', 'GET', headers)
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ fetchedAt: SNAP.fetchedAt, stale: false, ...publicRoster(SNAP.roster) })
  })

  it('is 503 and never cached when no roster has loaded', async () => {
    const res = await setup({ current: async () => null }).ask('/roster/public')
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await body(res)).toEqual({ error: 'The roster is not available yet. Try again.' })
  })

  it('projects once per snapshot, and again for a new one', async () => {
    let projected = 0
    const project = (r) => {
      projected++
      return publicRoster(r)
    }
    let snap = SNAP
    const s = setup({ current: async () => snap, project })
    const first = await body(await s.ask('/roster/public'))
    const second = await body(await s.ask('/roster/public'))
    expect(projected).toBe(1)
    expect(second).toEqual(first)
    snap = { ...SNAP, roster: { ...SNAP.roster } }
    await s.ask('/roster/public')
    expect(projected).toBe(2)
  })

  it('lets an unexpected error from the roster propagate', async () => {
    const s = setup({ current: async () => { throw new TypeError('bug') } })
    await expect(s.ask('/roster/public')).rejects.toThrow('bug')
  })
})
