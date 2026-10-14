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

describe('toggleWeaponPerk validIds', () => {
  it('ignores picks outside validIds when checking the budget, without deleting them', () => {
    const planner = usePlanner()
    planner.toggleWeaponPerk('Gun', 'gone', 2)
    planner.toggleWeaponPerk('Gun', 'a', 2)
    // Without validIds the budget is full.
    planner.toggleWeaponPerk('Gun', 'b', 2)
    expect(planner.weaponPerks.Gun).not.toHaveProperty('b')
    // With validIds, 'gone' no longer counts.
    planner.toggleWeaponPerk('Gun', 'b', 2, new Set(['a', 'b', 'c']))
    expect(planner.weaponPerks.Gun).toEqual({ gone: true, a: true, b: true })
    planner.toggleWeaponPerk('Gun', 'c', 2, ['a', 'b', 'c'])
    expect(planner.weaponPerks.Gun).not.toHaveProperty('c')
  })
})

describe('Patch 15.0 migration', () => {
  const KEY = 'salamanders-planner-v1'
  const encode = (payload) =>
    btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const stale = {
    className: 'Tactical',
    perkIds: { 7: 'Signal Jammer' },
    justifications: { 7: 'jam' },
    prestigePicks: ['Exigency Charge', null, null, null],
    createdAt: '2026-09-20T00:00:00Z',
  }

  it('drops a replaced perk, its rationale and a replaced prestige pick when a build is applied', () => {
    const planner = usePlanner()
    planner.applyBuildData(stale)
    expect(planner.selected).not.toHaveProperty('7')
    expect(planner.justified).not.toHaveProperty('7')
    expect(planner.prestigePicks.Tactical).toEqual([null, null, null, null])
    expect(planner.staleNotices).toHaveLength(2)
  })

  it('keeps a reworked perk and flags it', () => {
    const planner = usePlanner()
    planner.applyBuildData({ ...stale, perkIds: { 7: 'Marked for Death' }, justifications: {}, prestigePicks: [] })
    expect(planner.selected[7]).toBe('Marked for Death')
    expect(planner.staleNotices[0].kind).toBe('reworked')
  })

  it('migrates a share link, without a date so a reworked perk is not flagged', () => {
    const planner = usePlanner()
    planner.applyEncoded(encode({ c: 'Tactical', p: { 7: 'Signal Jammer' }, j: { 7: 'jam' } }))
    expect(planner.selected).not.toHaveProperty('7')
    expect(planner.staleNotices).toHaveLength(1)
    planner.applyEncoded(encode({ c: 'Tactical', p: { 7: 'Marked for Death' } }))
    expect(planner.selected[7]).toBe('Marked for Death')
    expect(planner.staleNotices).toEqual([])
  })

  it('migrates saved state on hydrate', () => {
    localStorage.setItem(KEY, JSON.stringify({
      activeClass: 'Tactical',
      selectedPerks: { Tactical: { 7: 'Signal Jammer', 0: 'Balanced Distribution' } },
      justifications: { Tactical: { 7: 'jam', 0: 'keep' } },
      prestigePicks: { Tactical: ['Exigency Charge', null, null, null] },
    }))
    const planner = usePlanner()
    planner.hydrate()
    expect(planner.selectedPerks.Tactical).toEqual({ 0: 'Balanced Distribution' })
    expect(planner.justifications.Tactical).toEqual({ 0: 'keep' })
    expect(planner.prestigePicks.Tactical).toEqual([null, null, null, null])
    expect(planner.staleNotices).toHaveLength(2)
  })

  it('does not throw on malformed saved state', () => {
    localStorage.setItem(KEY, '{not json')
    const planner = usePlanner()
    expect(() => planner.hydrate()).not.toThrow()
    expect(planner.staleNotices).toEqual([])
  })

  it('ignores a staleNotices value in saved state that is not a list', () => {
    localStorage.setItem(KEY, JSON.stringify({ activeClass: 'Vanguard', staleNotices: 'oops' }))
    const planner = usePlanner()
    planner.hydrate()
    expect(planner.staleNotices).toEqual([])
  })

  it('does not flag a current Tactical build or another class', () => {
    const planner = usePlanner()
    planner.applyBuildData({ ...stale, perkIds: { 7: 'Tactical Reserve' }, justifications: {}, prestigePicks: ['Passive Chambering'] })
    expect(planner.staleNotices).toEqual([])
    planner.applyBuildData({ className: 'Vanguard', perkIds: { 7: 'Signal Jammer' }, justifications: {} })
    expect(planner.staleNotices).toEqual([])
    expect(planner.selected[7]).toBe('Signal Jammer')
  })

  it('replaces that class notices when its build is loaded again', () => {
    const planner = usePlanner()
    planner.applyBuildData(stale)
    expect(planner.staleNotices).toHaveLength(2)
    planner.applyBuildData({ ...stale, perkIds: {}, justifications: {}, prestigePicks: [] })
    expect(planner.staleNotices).toEqual([])
  })

  it('names the class on each notice and shows only the active class its own', () => {
    const planner = usePlanner()
    planner.applyBuildData(stale)
    expect(planner.staleNotices.every((n) => n.className === 'Tactical')).toBe(true)
    expect(planner.activeStaleNotices).toHaveLength(2)
    planner.setClass('Vanguard')
    expect(planner.activeStaleNotices).toEqual([])
    planner.setClass('Tactical')
    expect(planner.activeStaleNotices).toHaveLength(2)
  })

  it('keeps the notice for a class the user is not viewing until they open it', () => {
    localStorage.setItem(KEY, JSON.stringify({
      activeClass: 'Vanguard',
      selectedPerks: { Tactical: { 7: 'Signal Jammer' } },
      justifications: { Tactical: { 7: 'jam' } },
    }))
    const planner = usePlanner()
    planner.hydrate()
    expect(planner.activeStaleNotices).toEqual([])
    planner.setClass('Tactical')
    expect(planner.activeStaleNotices).toHaveLength(1)
    expect(planner.activeStaleNotices[0]).toMatchObject({ className: 'Tactical', was: 'Signal Jammer', now: 'Tactical Reserve' })
  })

  it('keeps the notices found on load when a share link for another class is applied', () => {
    localStorage.setItem(KEY, JSON.stringify({
      activeClass: 'Vanguard',
      selectedPerks: { Tactical: { 7: 'Signal Jammer' } },
    }))
    const planner = usePlanner()
    planner.hydrate()
    planner.applyEncoded(encode({ c: 'Vanguard', p: {} }))
    expect(planner.staleNotices).toHaveLength(1)
    expect(planner.staleNotices[0].className).toBe('Tactical')
  })

  it('dismisses only the active class notices', () => {
    const planner = usePlanner()
    const note = (className) => ({ kind: 'replaced', level: 9, was: 'a', now: 'b', className })
    planner.staleNotices = [note('Assault'), note('Tactical')]
    planner.setClass('Tactical')
    planner.dismissStaleNotices()
    expect(planner.staleNotices.map((n) => n.className)).toEqual(['Assault'])
  })

  it('drops saved notices that do not name a class', () => {
    localStorage.setItem(KEY, JSON.stringify({
      activeClass: 'Tactical',
      staleNotices: [{ kind: 'replaced', level: 9, was: 'a', now: 'b' }, { kind: 'replaced', level: 9, was: 'a', now: 'b', className: 'Tactical' }],
    }))
    const planner = usePlanner()
    planner.hydrate()
    expect(planner.staleNotices).toHaveLength(1)
  })

  it('keeps the notices across a reload until they are dismissed', () => {
    const first = usePlanner()
    first.applyBuildData(stale)
    setActivePinia(createPinia())
    const reloaded = usePlanner()
    reloaded.hydrate()
    expect(reloaded.staleNotices).toHaveLength(2)
    reloaded.dismissStaleNotices()
    expect(reloaded.staleNotices).toEqual([])
    setActivePinia(createPinia())
    const again = usePlanner()
    again.hydrate()
    expect(again.staleNotices).toEqual([])
  })
})
