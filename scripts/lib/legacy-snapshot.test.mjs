import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { buildSnapshot, checkStartingPoint, colorHex } from './legacy-snapshot.mjs'

const R1 = '810000000000000001'
const R2 = '810000000000000002'
const R3 = '810000000000000003'
const U = (n) => `82000000000000000${n}`
const NOW = new Date('2026-10-16T12:00:00.000Z')
const LATER = new Date('2026-11-01T08:00:00.000Z')

const role = (id, name, color = 0) => ({ id, name, color })
const member = (n, roles, { nick = null, global_name = null, username = `user${n}` } = {}) => ({ nick, roles, user: { id: U(n), username, global_name } })
const deepFreeze = (o) => {
  Object.values(o).forEach((v) => typeof v === 'object' && v !== null && deepFreeze(v))
  return Object.freeze(o)
}

const members = () => [
  member(1, [R1], { nick: 'Alpha', global_name: 'ignored' }),
  member(2, [R1, R2], { global_name: 'Beta' }),
  member(3, [R2]),
  member(4, [R3]),
]
const input = (over = {}) => ({
  existing: null,
  roles: [role(R1, 'Laurel', 0xd4a017), role(R2, 'Ember'), role(R3, 'Third', 0x112233)],
  members: members(),
  roleIds: [R1, R2],
  now: NOW,
  ...over,
})
const stored = (roleId, over = {}) => ({ roleId, name: `old ${roleId.slice(-1)}`, color: null, blurb: `blurb ${roleId.slice(-1)}`, holders: [], ...over })

describe('colorHex', () => {
  it.each([[0xd4a017, '#d4a017'], [1, '#000001'], [0xffffff, '#ffffff']])('writes %i as %s', (n, hex) => {
    expect(colorHex(n)).toBe(hex)
  })
  it.each([0, -1, 0x1000000, 1.5, '5', NaN, null, undefined])('has no colour for %j', (v) => {
    expect(colorHex(v)).toBeNull()
  })
})

describe('buildSnapshot, first run', () => {
  it('lists the requested roles oldest first, with each one’s current holders by id and the names the guild shows', () => {
    const { legacy, report } = buildSnapshot(input({ roleIds: [R2, R1] }))
    expect(legacy).toEqual({
      snapshot: '2026-10-16T12:00:00.000Z',
      accolades: [
        { roleId: R1, name: 'Laurel', color: '#d4a017', blurb: '', holders: [{ id: U(1), name: 'Alpha' }, { id: U(2), name: 'Beta' }] },
        { roleId: R2, name: 'Ember', color: null, blurb: '', holders: [{ id: U(2), name: 'Beta' }, { id: U(3), name: 'user3' }] },
      ],
    })
    expect(report).toEqual({ missingRoles: [], unknownRoles: [], keptAbsent: { [R1]: 0, [R2]: 0 }, nameless: [] })
  })

  it('leaves out everyone who holds only other roles, and members the guild sent without roles', () => {
    const { legacy } = buildSnapshot(input({ roleIds: [R1], members: [...members(), { user: { id: U(9), username: 'x' } }] }))
    expect(legacy.accolades[0].holders.map((h) => h.id)).toEqual([U(1), U(2)])
  })

  it('asks for each role once however often it is listed', () => {
    expect(buildSnapshot(input({ roleIds: [R1, R1] })).legacy.accolades).toHaveLength(1)
  })

  it('names a member the guild shows no name for by their id, keeps them, and reports only the id', () => {
    const ghost = member(5, [R1], { nick: '\u200b', username: '\u200b' })
    const { legacy, report } = buildSnapshot(input({ roleIds: [R1], members: [ghost, member(6, [R1, R2], { nick: '\u200b', username: '\u200b' })] }))
    expect(legacy.accolades[0].holders).toEqual([{ id: U(5), name: U(5) }, { id: U(6), name: U(6) }])
    expect(report.nameless).toEqual([U(5), U(6)])
    const both = buildSnapshot(input({ roleIds: [R1, R2], members: [member(6, [R1, R2], { nick: '\u200b', username: '\u200b' })] }))
    expect(both.report.nameless).toEqual([U(6)])
  })

  it.each(
    // the number and the array only read as a snowflake once coerced to a string
    [undefined, null, 5, ['x'], {}, '123', '8'.repeat(21), 'x810000000000000001', 810000000000000001, [R1]].map((v) => [v]),
  )('refuses role id %j', (bad) => {
    const run = () => buildSnapshot(input({ roleIds: [R1, bad] }))
    expect(run).toThrow(TypeError)
    expect(run).toThrow('roleIds must be an array of snowflake strings')
  })
  it.each([undefined, null, R1, {}].map((v) => [v]))('refuses a role id list that is %j, not a list', (roleIds) => {
    expect(() => buildSnapshot(input({ roleIds }))).toThrow(TypeError)
  })

  it('never mutates what it is given', () => {
    const i = input({ existing: { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R1, { holders: [{ id: U(9), name: 'Gone' }] })] } })
    expect(() => buildSnapshot(deepFreeze(i))).not.toThrow()
  })
})

describe('buildSnapshot, runs after the first', () => {
  const first = () => buildSnapshot(input()).legacy

  it('is idempotent', () => {
    expect(buildSnapshot(input({ existing: first() })).legacy).toEqual(first())
  })

  it('a later identical pull changes only the date', () => {
    const again = buildSnapshot(input({ existing: first(), now: LATER })).legacy
    expect(again).toEqual({ ...first(), snapshot: '2026-11-01T08:00:00.000Z' })
  })

  it('keeps blurbs and the stored order, refreshes name and colour, and appends new roles oldest first', () => {
    const existing = { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R2), stored(R1)] }
    const { legacy } = buildSnapshot(input({ existing, roleIds: [R3, R1, R2] }))
    expect(legacy.accolades.map((a) => [a.roleId, a.name, a.color, a.blurb])).toEqual([
      [R2, 'Ember', null, 'blurb 2'],
      [R1, 'Laurel', '#d4a017', 'blurb 1'],
      [R3, 'Third', '#112233', ''],
    ])
  })

  it('keeps stored accolades it was not asked about', () => {
    const existing = { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R3, { holders: [{ id: U(7), name: 'Kept' }] })] }
    const { legacy } = buildSnapshot(input({ existing, roleIds: [R1] }))
    expect(legacy.accolades.map((a) => a.roleId)).toEqual([R3, R1])
    expect(legacy.accolades[0]).toEqual(existing.accolades[0])
  })

  it('keeps a holder the new pull no longer shows, and reports how many', () => {
    const existing = { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R1, { holders: [{ id: U(9), name: 'Gone' }, { id: U(1), name: 'Old Alpha' }] })] }
    const { legacy, report } = buildSnapshot(input({ existing, roleIds: [R1] }))
    expect(legacy.accolades[0].holders).toEqual([{ id: U(1), name: 'Alpha' }, { id: U(2), name: 'Beta' }, { id: U(9), name: 'Gone' }])
    expect(report.keptAbsent).toEqual({ [R1]: 1 })
  })

  it('--prune drops them', () => {
    const existing = { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R1, { holders: [{ id: U(9), name: 'Gone' }] })] }
    const { legacy, report } = buildSnapshot(input({ existing, roleIds: [R1], prune: true }))
    expect(legacy.accolades[0].holders.map((h) => h.id)).toEqual([U(1), U(2)])
    expect(report.keptAbsent).toEqual({ [R1]: 0 })
  })

  it.each([false, true])('a role already gone from the guild keeps its stored entry and date (prune=%s)', (prune) => {
    const existing = { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R1, { holders: [{ id: U(9), name: 'Gone' }] })] }
    const { legacy, report } = buildSnapshot(input({ existing, roles: [], roleIds: [R1], prune, now: LATER }))
    expect(legacy).toEqual(existing)
    expect(report).toEqual({ missingRoles: [R1], unknownRoles: [], keptAbsent: {}, nameless: [] })
  })

  it('a requested role that is gone and was never stored is reported and not invented', () => {
    const { legacy, report } = buildSnapshot(input({ roles: [role(R1, 'Laurel')], roleIds: [R1, R3] }))
    expect(legacy.accolades.map((a) => a.roleId)).toEqual([R1])
    expect(report.missingRoles).toEqual([R3])
    expect(report.unknownRoles).toEqual([R3])
  })

  it('a first run that finds nothing is dated now, and has no accolades', () => {
    const { legacy } = buildSnapshot(input({ roles: [], roleIds: [R1] }))
    expect(legacy).toEqual({ snapshot: '2026-10-16T12:00:00.000Z', accolades: [] })
  })

  it('never loses a recorded holder, nor misses a current one (property)', () => {
    const pool = [1, 2, 3, 4, 5, 6, 7, 8]
    fc.assert(
      fc.property(fc.subarray(pool), fc.subarray(pool), (recorded, current) => {
        const existing = { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R1, { holders: recorded.map((n) => ({ id: U(n), name: `old${n}` })) })] }
        const ms = current.map((n) => member(n, [R1], { nick: `new${n}` }))
        const ids = (prune) => buildSnapshot(input({ existing, members: ms, roleIds: [R1], prune })).legacy.accolades[0].holders.map((h) => h.id)
        expect(ids(false)).toEqual([...new Set([...recorded, ...current])].sort().map(U))
        expect(ids(true)).toEqual([...current].sort().map(U))
      }),
    )
  })
})

describe('checkStartingPoint', () => {
  const published = { legacy: true }
  const something = { snapshot: '2026-10-16T12:00:00.000Z', accolades: [] }

  it('refuses to start from nothing once the legacy accolades have been published', () => {
    expect(() => checkStartingPoint({ existing: null, lock: published })).toThrow(/already published.*seal-archive unseal.*--fresh/s)
  })
  it('lets --fresh start over anyway', () => {
    expect(() => checkStartingPoint({ existing: null, lock: published, fresh: true })).not.toThrow()
  })
  it('has nothing to say when there is a snapshot file to add to', () => {
    expect(() => checkStartingPoint({ existing: something, lock: published })).not.toThrow()
  })
  it.each([null, undefined, {}, { legacy: false }].map((v) => [v]))('has nothing to say when the last lock was %j', (lock) => {
    expect(() => checkStartingPoint({ existing: null, lock })).not.toThrow()
  })
})
