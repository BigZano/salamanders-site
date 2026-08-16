// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlanner, MAX_PRESTIGE } from './planner'

const CLASS = 'Tactical'

function setUpBuild(planner) {
  planner.setClass(CLASS)
  planner.level = 25
  const col0 = planner.columns[0]
  const perk = col0.perks[0]
  planner.togglePerk(perk)
  planner.setJustification(perk.col, '  Solid pick for sustain.  ')
  planner.togglePrestigePerk(planner.prestigePool[0].name)
  planner.setWeapon('primary', 'Bolt Rifle')
  planner.toggleWeaponPerk('Bolt Rifle', 'p1')
  return { perk, prestigeName: planner.prestigePool[0].name }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('buildSnapshot', () => {
  it('captures the full current build under the given title/role/notes', () => {
    const planner = usePlanner()
    const { perk, prestigeName } = setUpBuild(planner)

    const snap = planner.buildSnapshot({ title: 'My Build', role: 'Frontline', notes: 'Solid' })

    expect(snap.title).toBe('My Build')
    expect(snap.role).toBe('Frontline')
    expect(snap.notes).toBe('Solid')
    expect(snap.className).toBe(CLASS)
    expect(snap.level).toBe(25)
    expect(snap.perkIds[perk.col]).toBe(perk.name)
    expect(snap.justifications[perk.col]).toBe('Solid pick for sustain.')
    expect(snap.weapons.primary).toBe('Bolt Rifle')
    expect(snap.weaponPerks['Bolt Rifle']).toEqual({ p1: true })
    expect(snap.prestigePicks).toHaveLength(MAX_PRESTIGE)
    expect(snap.prestigePicks[0]).toBe(prestigeName)
    // perks is the parallel 8-slot name array, not a copy of perkIds.
    expect(snap.perks[perk.col]).toBe(perk.name)
    expect(snap.perks).toHaveLength(8)
    expect(snap.perks.filter(Boolean)).toEqual([perk.name])
  })

  it('defaults the title to "<class> Build" when none is given or it is blank', () => {
    const planner = usePlanner()
    planner.setClass(CLASS)
    expect(planner.buildSnapshot().title).toBe(`${CLASS} Build`)
    expect(planner.buildSnapshot({ title: '   ' }).title).toBe(`${CLASS} Build`)
  })

  it('defaults role and notes to an empty string, not a placeholder, when omitted', () => {
    const planner = usePlanner()
    planner.setClass(CLASS)
    const snap = planner.buildSnapshot()
    expect(snap.role).toBe('')
    expect(snap.notes).toBe('')
  })

  it('trims title/role/notes', () => {
    const planner = usePlanner()
    planner.setClass(CLASS)
    const snap = planner.buildSnapshot({ title: '  Rush  ', role: '  DPS  ', notes: '  go  ' })
    expect(snap).toMatchObject({ title: 'Rush', role: 'DPS', notes: 'go' })
  })

  it('only snapshots weapon perks for weapons actually equipped in the current build', () => {
    const planner = usePlanner()
    planner.setClass(CLASS)
    planner.toggleWeaponPerk('Unequipped Gun', 'x')
    planner.setWeapon('primary', 'Bolt Rifle')
    planner.toggleWeaponPerk('Bolt Rifle', 'p1')

    const snap = planner.buildSnapshot()
    expect(snap.weaponPerks).toEqual({ 'Bolt Rifle': { p1: true } })
    expect(snap.weaponPerks).not.toHaveProperty('Unequipped Gun')
  })

  it('omits an equipped weapon from weaponPerks entirely when it has no perks picked', () => {
    const planner = usePlanner()
    planner.setClass(CLASS)
    planner.setWeapon('primary', 'Bolt Rifle')
    planner.setWeapon('secondary', 'Bolt Pistol') // equipped, never given any perks

    const snap = planner.buildSnapshot()
    expect(snap.weaponPerks).not.toHaveProperty('Bolt Pistol')
  })

  it('ignores a cleared (empty-string) weapon slot rather than treating "" as an equipped weapon', () => {
    const planner = usePlanner()
    planner.setClass(CLASS)
    // Perks parked under the empty-string key from some earlier state — an
    // empty slot must never pick these up just because it's falsy, not absent.
    planner.toggleWeaponPerk('', 'ghost')
    planner.setWeapon('primary', '')
    planner.setWeapon('secondary', 'Bolt Pistol')

    const snap = planner.buildSnapshot()
    expect(Object.keys(snap.weaponPerks)).not.toContain('')
  })

  it('never includes savedBuilds/id fields — it is a payload for the API, not a local record', () => {
    const planner = usePlanner()
    planner.setClass(CLASS)
    const snap = planner.buildSnapshot({ title: 'x' })
    expect(snap).not.toHaveProperty('id')
    expect(snap).not.toHaveProperty('savedBuilds')
  })
})

describe('applyBuildData', () => {
  it('round-trips through a snapshot: apply(snapshot(x)) restores the same picks', () => {
    const source = usePlanner()
    setUpBuild(source)
    const snap = source.buildSnapshot({ title: 'RT' })
    // Simulate what the API actually returns: the snapshot plus server-only fields.
    const fromApi = { ...snap, id: 9, author: { id: '1', username: 'x' }, createdAt: 'now' }

    setActivePinia(createPinia())
    const target = usePlanner()
    target.setClass('Assault') // start from a different class to prove it switches
    target.applyBuildData(fromApi)

    expect(target.activeClass).toBe(CLASS)
    expect(target.level).toBe(25)
    expect(target.selected).toEqual(source.selected)
    expect(target.justified).toEqual(source.justified)
    expect(target.activeWeapons).toEqual(source.activeWeapons)
    expect(target.weaponPerks['Bolt Rifle']).toEqual({ p1: true })
    expect(target.prestigeRaw).toEqual(source.prestigeRaw)
  })

  it('is a no-op for a missing or unknown class name', () => {
    const planner = usePlanner()
    planner.setClass(CLASS)

    planner.applyBuildData(null)
    expect(planner.activeClass).toBe(CLASS)

    planner.applyBuildData({})
    expect(planner.activeClass).toBe(CLASS)

    planner.applyBuildData({ className: 'Not A Real Class' })
    expect(planner.activeClass).toBe(CLASS)
  })

  it('tolerates missing optional fields without throwing, defaulting them to empty', () => {
    const planner = usePlanner()
    expect(() => planner.applyBuildData({ className: 'Assault' })).not.toThrow()
    expect(planner.activeClass).toBe('Assault')
    expect(planner.selected).toEqual({})
    expect(planner.justified).toEqual({})
    expect(planner.activeWeapons).toEqual({})
    expect(planner.prestigeRaw).toEqual(Array(MAX_PRESTIGE).fill(null))
  })

  it('persists the applied build so a reload does not lose it', () => {
    const planner = usePlanner()
    planner.applyBuildData({ className: 'Assault', level: 12, perkIds: { 0: 'Onslaught' } })

    const stored = JSON.parse(localStorage.getItem('salamanders-planner-v1'))
    expect(stored.activeClass).toBe('Assault')
    expect(stored.selectedPerks.Assault).toEqual({ 0: 'Onslaught' })
  })

  it('falls back to the current level when the incoming level is falsy (0 or missing)', () => {
    const planner = usePlanner()
    planner.level = 30
    planner.applyBuildData({ className: 'Assault', level: 0 })
    expect(planner.level).toBe(30)

    planner.applyBuildData({ className: 'Bulwark' })
    expect(planner.level).toBe(30)
  })
})
