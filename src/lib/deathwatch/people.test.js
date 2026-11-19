import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { addAccess, listAccess, removeAccess, searchMembers } from './people'

// Invented values only.
const ID = '300000000000000201'
const ROW = { id: ID, kind: 'desk', name: 'Brother Valen', avatar: null, grantedBy: 'Watch Commander Tor', grantedAt: '2026-06-01T00:00:00.000Z' }

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * A stand-in for the API behind fetch, with the browser's HTTP cache in front of it: a GET not sent as no-store
 * may come back as the first answer to that address. `members` is the guild the search looks through (by name,
 * ignoring case), `rows` the access list; only the token 'tok' is let in.
 */
function fakeServer() {
  const members = []
  const rows = []
  const httpCache = new Map()
  function answer(url, { method, headers, body }) {
    if (headers.Authorization !== 'Bearer tok') return json(401, { error: 'Sign in.' })
    const path = url.pathname
    if (method === 'GET' && path === '/deathwatch/members') {
      const q = url.searchParams.get('q').toLowerCase()
      return json(200, { members: members.filter((m) => m.name.toLowerCase().includes(q)) })
    }
    if (method === 'GET' && path === '/deathwatch/access') return json(200, { people: rows })
    if (method === 'POST' && path === '/deathwatch/access') {
      const b = JSON.parse(body)
      if (b.discordId !== ID) return json(404, { error: 'Not in the server.' })
      rows.push({ ...ROW, kind: b.kind })
      return json(201, b)
    }
    const del = method === 'DELETE' && /^\/deathwatch\/access\/([^/]+)\/([^/]+)$/.exec(path)
    if (del) {
      const i = rows.findIndex((r) => r.id === decodeURIComponent(del[1]) && r.kind === decodeURIComponent(del[2]))
      if (i < 0) return json(404, { error: 'No such access.' })
      rows.splice(i, 1)
      return json(200, {})
    }
    return json(404, { error: 'No route.' })
  }
  vi.stubGlobal('fetch', async (input, init) => {
    const url = new URL(input)
    const key = url.href
    if (init.method === 'GET' && init.cache !== 'no-store' && httpCache.has(key)) return httpCache.get(key).clone()
    const res = answer(url, init)
    if (init.method === 'GET') httpCache.set(key, res.clone())
    return res
  })
  return { members, rows }
}
const VAL = { id: ID, name: 'Val & Co?', avatar: null }
const SORN = { id: '300000000000000202', name: 'Val Sorn', avatar: null }

beforeEach(() => vi.stubEnv('VITE_DEATHWATCH_FIXTURE', '')) // as in production, whatever .env.local says
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('against the server', () => {
  it('searches with the query arriving whole, however it is spelled', async () => {
    fakeServer().members.push(VAL, SORN)
    // Unencoded, the '&' would cut it to 'val ', which finds Val Sorn too.
    expect(await searchMembers('tok', 'val & co?')).toEqual([VAL])
  })

  it('searches afresh each time, never from the HTTP cache', async () => {
    const server = fakeServer()
    expect(await searchMembers('tok', 'val')).toEqual([])
    server.members.push(SORN)
    expect(await searchMembers('tok', 'val')).toEqual([SORN])
  })

  it('lists who was given what, never from the HTTP cache', async () => {
    const server = fakeServer()
    expect(await listAccess('tok')).toEqual([])
    server.rows.push(ROW)
    expect(await listAccess('tok')).toEqual([ROW])
  })

  it('adds one kind for one person, signed in', async () => {
    const server = fakeServer()
    await addAccess('tok', ID, 'watchcommand')
    expect(server.rows.map((r) => [r.id, r.kind])).toEqual([[ID, 'watchcommand']])
    await expect(addAccess('other', ID, 'desk')).rejects.toMatchObject({ status: 401 })
  })

  it('removes one kind for one person, both encoded into the address', async () => {
    const server = fakeServer()
    server.rows.push(ROW, { ...ROW, kind: 'watchcommand' }, { ...ROW, id: '../x', kind: 'a/b' })
    await removeAccess('tok', ID, 'desk')
    expect(server.rows.map((r) => [r.id, r.kind])).toEqual([[ID, 'watchcommand'], ['../x', 'a/b']])
    await removeAccess('tok', '../x', 'a/b')
    expect(server.rows.map((r) => [r.id, r.kind])).toEqual([[ID, 'watchcommand']])
  })

  it('passes a refusal on', async () => {
    fakeServer()
    await expect(addAccess('tok', '300000000000000299', 'desk')).rejects.toMatchObject({ status: 404, message: 'Not in the server.' })
    await expect(removeAccess('tok', ID, 'desk')).rejects.toMatchObject({ status: 404, message: 'No such access.' })
  })
})

// The fixture's list lives in the module, so these run in order and each starts where the last one left it.
describe('in dev with the fixture', () => {
  const MEMBERS = [
    ['300000000000000201', 'Brother Valen'],
    ['300000000000000202', 'Brother Varro'],
    ['300000000000000203', 'Brother Kael'],
    ['300000000000000204', 'Brother Ostar'],
    ['300000000000000205', 'Brother Ostar'],
    ['300000000000000206', 'Brother Avar'],
  ].map(([id, name]) => ({ id, name, avatar: null }))
  const [VALEN, , KAEL, , , AVAR] = MEMBERS
  const SEED = { id: VALEN.id, kind: 'desk', grantedBy: 'Watch Commander', grantedAt: '2026-10-02T18:00:00Z', name: 'Brother Valen', avatar: null }

  beforeEach(() => {
    vi.stubEnv('VITE_DEATHWATCH_FIXTURE', '1')
    vi.stubGlobal('fetch', async () => {
      throw new Error('The fixture never asks the server.')
    })
  })

  it('starts with one invented row, named from the invented members', async () => {
    expect(await listAccess('tok')).toEqual([SEED])
  })

  it('searches invented members by name, ignoring case and spaces around, or by id', async () => {
    expect(await searchMembers('tok', 'BROTHER')).toEqual(MEMBERS)
    expect(await searchMembers('tok', '  kael ')).toEqual([KAEL])
    expect(await searchMembers('tok', 'ka')).toEqual([KAEL])
    expect(await searchMembers('tok', AVAR.id)).toEqual([AVAR])
    expect(await searchMembers('tok', ' o ')).toEqual([])
  })

  it('adds each kind once per person, and removes only that person and kind', async () => {
    await addAccess('tok', KAEL.id, 'desk')
    await addAccess('tok', KAEL.id, 'watchcommand')
    await addAccess('tok', KAEL.id, 'watchcommand')
    const kael = (await listAccess('tok')).filter((r) => r.id === KAEL.id)
    expect(kael.map((r) => r.kind)).toEqual(['desk', 'watchcommand'])
    for (const r of kael) {
      expect(r).toMatchObject({ name: 'Brother Kael', avatar: null, grantedBy: 'Watch Commander' })
      expect(new Date(r.grantedAt).toISOString()).toBe(r.grantedAt)
    }
    await removeAccess('tok', KAEL.id, 'desk') // Valen's desk comes first in the list, and stays
    expect((await listAccess('tok')).map((r) => [r.id, r.kind])).toEqual([[VALEN.id, 'desk'], [KAEL.id, 'watchcommand']])
    await removeAccess('tok', KAEL.id, 'watchcommand')
    expect(await listAccess('tok')).toEqual([SEED])
  })

  it('lists someone outside the invented members unnamed, and removing what is not held changes nothing', async () => {
    const OUTSIDER = '300000000000000299'
    await addAccess('tok', OUTSIDER, 'desk')
    expect((await listAccess('tok')).find((r) => r.id === OUTSIDER)).toMatchObject({ id: OUTSIDER, kind: 'desk', name: null })
    await removeAccess('tok', OUTSIDER, 'watchcommand')
    expect((await listAccess('tok')).map((r) => [r.id, r.kind])).toEqual([[VALEN.id, 'desk'], [OUTSIDER, 'desk']])
    await removeAccess('tok', OUTSIDER, 'desk')
    expect(await listAccess('tok')).toEqual([SEED])
  })

  it('removes the first row too', async () => {
    await removeAccess('tok', VALEN.id, 'desk')
    expect(await listAccess('tok')).toEqual([])
  })
})
