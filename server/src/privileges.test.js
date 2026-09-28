import { describe, it, expect } from 'vitest'
import { ROLE_IDS as R, privilegesFrom, mayRevoke, createPrivileges } from './privileges'

const p = (roles, admin = false, revoked = false) => privilegesFrom({ roles, admin, revoked })

describe('privilegesFrom', () => {
  it.each([
    ['techmarine', [R.techmarine], { editor: true, historyViewer: true, moderator: true, revoker: null }],
    ['mechadendrite', [R.mechadendrite], { editor: true, historyViewer: true, moderator: true, revoker: null }],
    ['forge', [R.forge], { editor: true, historyViewer: true, moderator: true, revoker: 'forge' }],
    ['hierarchy', [R.hierarchy], { editor: true, historyViewer: true, moderator: false, revoker: null }],
    ['plain member', ['1377787723976409211'], { editor: false, historyViewer: false, moderator: false, revoker: null }],
  ])('%s', (_, roles, want) => {
    expect(p(roles)).toMatchObject(want)
  })

  it('admin by permission alone gets everything', () => {
    expect(p([], true)).toMatchObject({ admin: true, editor: true, historyViewer: true, moderator: true, revoker: 'admin' })
  })

  it('a revocation drops every elevated power', () => {
    expect(p([R.forge, R.techmarine], false, true)).toEqual({
      admin: false, editor: false, historyViewer: false, moderator: false, revoked: true, revoker: null,
    })
  })

  it('an admin cannot be revoked, even with a stray revocation row', () => {
    expect(p([], true, true)).toMatchObject({ editor: true, revoked: false, revoker: 'admin' })
  })
})

describe('mayRevoke', () => {
  const actor = (roles, admin = false, id = '1') => ({ id, ...p(roles, admin) })
  const target = (roles, admin = false, id = '2') => ({ id, roles, admin })

  it('admin may revoke anyone but an admin', () => {
    const a = actor([], true)
    expect(mayRevoke(a, target([R.forge]))).toBe(true)
    expect(mayRevoke(a, target([R.hierarchy]))).toBe(true)
    expect(mayRevoke(a, target([], true))).toBe(false)
  })

  it('forge may revoke techmarines and mechadendrites only', () => {
    const f = actor([R.forge])
    expect(mayRevoke(f, target([R.techmarine]))).toBe(true)
    expect(mayRevoke(f, target([R.mechadendrite]))).toBe(true)
    expect(mayRevoke(f, target([R.hierarchy]))).toBe(false)
    expect(mayRevoke(f, target([R.forge]))).toBe(false)
    expect(mayRevoke(f, target([R.techmarine, R.hierarchy]))).toBe(false)
    expect(mayRevoke(f, target([], true))).toBe(false)
  })

  it('hierarchy, techmarine and mechadendrite revoke no one', () => {
    for (const r of [R.hierarchy, R.techmarine, R.mechadendrite]) expect(mayRevoke(actor([r]), target([R.techmarine]))).toBe(false)
  })

  it('nobody revokes themselves; missing target is refused', () => {
    expect(mayRevoke(actor([], true, '5'), target([R.forge], false, '5'))).toBe(false)
    expect(mayRevoke(actor([], true), null)).toBe(false)
  })
})

describe('createPrivileges', () => {
  const roles = {
    rolesOf: async (id) => ({ '1': [R.techmarine], '2': [] }[id] ?? null),
    isAdmin: async (id) => id === '2',
  }
  const store = { openRevocation: async (id) => (id === '1' ? { id: 7 } : null) }
  const priv = createPrivileges({ roles, store })

  it('looks up roles, admin and revocation live', async () => {
    expect(await priv.forUser({ id: '1' })).toMatchObject({ id: '1', editor: false, revoked: true })
    expect(await priv.forUser({ id: '2' })).toMatchObject({ id: '2', admin: true, editor: true })
    expect(await priv.forUser({ id: '3' })).toMatchObject({ id: '3', editor: false, revoked: false })
  })

  it('target() returns null for someone not in the guild', async () => {
    expect(await priv.target('3')).toBeNull()
    expect(await priv.target('1')).toEqual({ id: '1', roles: [R.techmarine], admin: false })
  })
})
