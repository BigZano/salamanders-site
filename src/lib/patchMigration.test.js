import { describe, it, expect } from 'vitest'
import { migrateSelection, isStaleBuild } from './patchMigration'
import migrations from '../data/perk-migrations.json'
import classes from '../data/classes.json'

const deepFreeze = (o) => {
  Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v))
  return Object.freeze(o)
}

const run = (over) =>
  migrateSelection({ className: 'Tactical', selectedPerks: {}, justifications: {}, prestigePicks: [null, null, null, null], ...over })

describe('migrateSelection', () => {
  it('drops a replaced pick and its rationale, and says what now sits there', () => {
    const r = run({ selectedPerks: { 7: 'Signal Jammer' }, justifications: { 7: 'jam' } })
    expect(r.selectedPerks).not.toHaveProperty('7')
    expect(r.justifications).not.toHaveProperty('7')
    expect(r.notices).toEqual([
      expect.objectContaining({ kind: 'replaced', level: 9, was: 'Signal Jammer', now: 'Tactical Reserve' }),
    ])
  })

  it('keeps unrelated picks and rationale', () => {
    const r = run({ selectedPerks: { 0: 'Balanced Distribution', 7: 'Signal Jammer' }, justifications: { 0: 'keep me', 7: 'jam' } })
    expect(r.selectedPerks).toEqual({ 0: 'Balanced Distribution' })
    expect(r.justifications).toEqual({ 0: 'keep me' })
  })

  it('matches on column and name, so a name that moved is only dropped from its old slot', () => {
    // Vital Data was level 6 (column 4), is now level 8 (column 6).
    expect(run({ selectedPerks: { 4: 'Vital Data' } }).selectedPerks).toEqual({})
    expect(run({ selectedPerks: { 6: 'Vital Data' } })).toMatchObject({ selectedPerks: { 6: 'Vital Data' }, notices: [] })
    // Improved Efficiency was level 15 (column 5), is now level 6 (column 4).
    expect(run({ selectedPerks: { 5: 'Improved Efficiency' } }).selectedPerks).toEqual({})
    expect(run({ selectedPerks: { 4: 'Improved Efficiency' } })).toMatchObject({ selectedPerks: { 4: 'Improved Efficiency' }, notices: [] })
  })

  it('migrates every replaced slot in the table', () => {
    const slots = migrations.classes.Tactical.slots.filter((s) => s.action === 'replaced')
    expect(slots).toHaveLength(11)
    for (const s of slots) {
      const col = (s.level - 2) % 8
      const r = run({ selectedPerks: { [col]: s.was } })
      expect(r.selectedPerks, `level ${s.level}`).toEqual({})
      expect(r.notices[0], `level ${s.level}`).toMatchObject({ kind: 'replaced', level: s.level, was: s.was, now: s.now })
    }
  })

  it('names the class on every notice', () => {
    const r = run({ selectedPerks: { 7: 'Signal Jammer' }, prestigePicks: ['Exigency Charge', null, null, null] })
    expect(r.notices).toHaveLength(2)
    expect(r.notices.every((n) => n.className === 'Tactical')).toBe(true)
  })

  it('carries the table note onto the notice', () => {
    expect(run({ selectedPerks: { 4: 'Vital Data' } }).notices[0].note).toBe('Vital Data moved to level 8')
  })

  it('keeps and flags a reworked pick on a build made before the patch', () => {
    const r = run({ selectedPerks: { 7: 'Marked for Death' }, justifications: { 7: 'why' }, createdAt: '2026-09-20T00:00:00Z' })
    expect(r.selectedPerks).toEqual({ 7: 'Marked for Death' })
    expect(r.justifications).toEqual({ 7: 'why' })
    expect(r.notices).toEqual([expect.objectContaining({ kind: 'reworked', level: 25, was: 'Marked for Death', now: 'Marked for Death' })])
  })

  it.each([['2026-10-05T00:00:00Z'], [undefined], ['not a date'], [null]])('does not flag a reworked pick when createdAt is %j', (createdAt) => {
    expect(run({ selectedPerks: { 7: 'Marked for Death' }, createdAt }).notices).toEqual([])
  })

  it('drops a replaced prestige pick by name and reports it with a null level', () => {
    const r = run({ prestigePicks: ['Acuity', 'Exigency Charge', null, null] })
    expect(r.prestigePicks).toEqual(['Acuity', null, null, null])
    expect(r.notices).toEqual([expect.objectContaining({ kind: 'replaced', level: null, was: 'Exigency Charge', now: 'Passive Chambering' })])
  })

  it('leaves another class untouched', () => {
    const input = { className: 'Vanguard', selectedPerks: { 7: 'Signal Jammer' }, justifications: { 7: 'x' }, prestigePicks: ['Exigency Charge'] }
    const { className, ...rest } = input
    expect(migrateSelection(input)).toEqual({ ...rest, notices: [] })
  })

  it('does not mutate its input', () => {
    const input = deepFreeze({
      className: 'Tactical',
      selectedPerks: { 7: 'Signal Jammer', 4: 'Vital Data' },
      justifications: { 7: 'jam' },
      prestigePicks: ['Exigency Charge', null],
      createdAt: '2026-09-20T00:00:00Z',
    })
    expect(() => migrateSelection(input)).not.toThrow()
  })

  it.each([['constructor'], ['toString'], ['__proto__'], ['hasOwnProperty']])('treats the class name %s as an unknown class', (className) => {
    const r = migrateSelection({ className, selectedPerks: { 1: 'x' }, justifications: { 1: 'y' }, prestigePicks: ['z'] })
    expect(r).toMatchObject({ selectedPerks: { 1: 'x' }, justifications: { 1: 'y' }, prestigePicks: ['z'], notices: [] })
    expect(isStaleBuild({ className, perks: ['x'] })).toBe(false)
  })

  it('tolerates missing pieces', () => {
    expect(migrateSelection({ className: 'Tactical' })).toMatchObject({ notices: [] })
    expect(migrateSelection({ className: 'Tactical', selectedPerks: null, justifications: null, prestigePicks: null })).toMatchObject({ notices: [] })
    expect(migrateSelection({ className: 'Nope', selectedPerks: { 1: 'x' } }).selectedPerks).toEqual({ 1: 'x' })
  })

  it('only drops names that the new grid no longer has in that slot', () => {
    // Guard against a table entry that points at what is actually still there.
    const rows = classes.Tactical.rows
    for (const s of migrations.classes.Tactical.slots.filter((x) => x.action === 'replaced')) {
      const slot = rows[Math.floor((s.level - 2) / 8)][(s.level - 2) % 8]
      expect(slot, `level ${s.level}`).toBe(s.now)
      expect(slot, `level ${s.level}`).not.toBe(s.was)
    }
  })
})

describe('isStaleBuild', () => {
  const perks = (at, name) => Object.assign(Array(8).fill(null), { [at]: name })

  it('is true for a Tactical build holding a dropped perk', () => {
    expect(isStaleBuild({ className: 'Tactical', perks: perks(7, 'Signal Jammer') })).toBe(true)
  })

  it('is false once the slot holds the new perk', () => {
    expect(isStaleBuild({ className: 'Tactical', perks: perks(7, 'Tactical Reserve') })).toBe(false)
  })

  it('is false for a build with nothing to check', () => {
    expect(isStaleBuild({ className: 'Tactical' })).toBe(false)
    expect(isStaleBuild({ className: 'Tactical', perks: [], prestigePicks: undefined, createdAt: undefined })).toBe(false)
    expect(isStaleBuild({ className: 'Tactical', perks: null, prestigePicks: null })).toBe(false)
  })

  it('is true for a reworked pick on an old build, false on a new one', () => {
    expect(isStaleBuild({ className: 'Tactical', perks: perks(7, 'Marked for Death'), createdAt: '2026-09-01T00:00:00Z' })).toBe(true)
    expect(isStaleBuild({ className: 'Tactical', perks: perks(7, 'Marked for Death'), createdAt: '2026-10-09T00:00:00Z' })).toBe(false)
  })

  it('is true for a stale prestige pick', () => {
    expect(isStaleBuild({ className: 'Tactical', prestigePicks: [null, 'Exigency Charge', null, null] })).toBe(true)
  })

  it('is false for another class', () => {
    expect(isStaleBuild({ className: 'Vanguard', perks: perks(7, 'Signal Jammer') })).toBe(false)
  })
})
