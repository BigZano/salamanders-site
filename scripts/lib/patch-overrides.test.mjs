import { describe, it, expect } from 'vitest'
import { deriveRows, applyOverrides, holdClasses } from './patch-overrides.mjs'

const grid = (n = 24) => Array.from({ length: n }, (_, i) => ({ level: i + 2, name: `P${i + 2}`, description: `d${i + 2}` }))
const SRC = ['Patch Notes 15.0']

describe('deriveRows', () => {
  it('lays levels 2 to 25 out as 3 rows of 8', () => {
    const rows = deriveRows(grid())
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r).toHaveLength(8)
    expect(rows[0][4]).toBe('P6')
    expect(rows[2][7]).toBe('P25')
    expect(rows[0][0]).toBe('P2')
    expect(rows[1][0]).toBe('P10')
  })

  it('does not depend on the order of the list', () => {
    expect(deriveRows([...grid()].reverse())).toEqual(deriveRows(grid()))
  })

  it.each([[1], [26], [0]])('throws for level %i', (level) => {
    expect(() => deriveRows([...grid(23), { level, name: 'X', description: 'x' }])).toThrow(`level out of range: ${level}`)
  })

  it('throws for a perk with no level', () => {
    expect(() => deriveRows([...grid(23), { level: null, name: 'X', description: 'x' }])).toThrow('level out of range: null')
  })

  it('throws for a repeated level', () => {
    expect(() => deriveRows([...grid(), { level: 6, name: 'Dup', description: 'x' }])).toThrow(/duplicate level: 6/)
  })

  it('throws when a level is missing rather than writing a hole into the grid', () => {
    expect(() => deriveRows(grid().filter((p) => p.level !== 9))).toThrow(/missing level: 9/)
  })
})

describe('applyOverrides', () => {
  const state = () => ({
    perkList: grid(),
    prestige: [
      { level: null, name: 'Acuity', description: 'a1' },
      { level: null, name: 'Exigency Charge', description: 'old text 10' },
    ],
  })
  const ov = (cls) => ({ patch: '15.0', classes: { Tactical: cls } })

  it('replaces the name and description at a grid level', () => {
    const o = ov({ grid: [{ level: 6, name: 'Improved Efficiency', description: 'faster 25%', sources: SRC }] })
    const r = applyOverrides('Tactical', state(), o)
    expect(r.perkList.find((p) => p.level === 6)).toMatchObject({ name: 'Improved Efficiency', description: 'faster 25%' })
    expect(r.warnings).toEqual([])
  })

  it('warns about a stale override when the wiki already has that name at that level', () => {
    const s = state()
    s.perkList[4] = { level: 6, name: 'Improved Efficiency', description: 'wiki text' }
    const o = ov({ grid: [{ level: 6, name: 'Improved Efficiency', description: 'faster 25%', sources: SRC }] })
    expect(applyOverrides('Tactical', s, o).warnings.join(' ')).toContain('stale override')
  })

  it('adds a grid override whose level the wiki list lacks, with a warning', () => {
    const s = state()
    s.perkList = s.perkList.filter((p) => p.level !== 6)
    const o = ov({ grid: [{ level: 6, name: 'Improved Efficiency', description: 'x', sources: SRC }] })
    const r = applyOverrides('Tactical', s, o)
    expect(r.perkList.find((p) => p.level === 6).name).toBe('Improved Efficiency')
    expect(r.warnings.join(' ')).toContain('no wiki perk at level 6')
  })

  it('replaces a prestige perk in place', () => {
    const o = ov({ prestige: [{ replaces: 'Exigency Charge', name: 'Passive Chambering', description: 'after 10 seconds', sources: SRC }] })
    const r = applyOverrides('Tactical', state(), o)
    expect(r.prestige.map((p) => p.name)).toEqual(['Acuity', 'Passive Chambering'])
    expect(r.prestige[1].description).toBe('after 10 seconds')
    expect(r.warnings).toEqual([])
  })

  it('warns when a prestige override has no target', () => {
    const o = ov({ prestige: [{ replaces: 'Nope', name: 'Passive Chambering', description: 'x', sources: SRC }] })
    const r = applyOverrides('Tactical', state(), o)
    expect(r.prestige.map((p) => p.name)).toEqual(['Acuity', 'Exigency Charge'])
    expect(r.warnings.join(' ')).toContain('prestige override target not found: Nope')
  })

  it('warns that a prestige override is stale once the wiki has the new name', () => {
    const s = state()
    s.prestige[1] = { level: null, name: 'Passive Chambering', description: 'wiki' }
    const o = ov({ prestige: [{ replaces: 'Exigency Charge', name: 'Passive Chambering', description: 'x', sources: SRC }] })
    expect(applyOverrides('Tactical', s, o).warnings.join(' ')).toContain('stale override')
  })

  describe('pins', () => {
    const pin = { name: 'P3', description: 'pinned 10', wikiSaid: 'wiki 15', reason: 'r', sources: SRC }

    it('sets the pinned description', () => {
      const s = state()
      s.perkList[1].description = 'wiki 15'
      const r = applyOverrides('Tactical', s, ov({ pins: [pin] }))
      expect(r.perkList[1].description).toBe('pinned 10')
      expect(r.warnings).toEqual([])
    })

    it('says re-evaluate when the wiki text is neither what was pinned against nor the pin', () => {
      const s = state()
      s.perkList[1].description = 'something new 20'
      const r = applyOverrides('Tactical', s, ov({ pins: [pin] }))
      expect(r.perkList[1].description).toBe('pinned 10')
      expect(r.warnings.join(' ')).toContain('re-evaluate')
    })

    it('says redundant when the wiki text now equals the pin', () => {
      const s = state()
      s.perkList[1].description = 'pinned  10'
      expect(applyOverrides('Tactical', s, ov({ pins: [pin] })).warnings.join(' ')).toContain('redundant')
    })

    it('warns when the pinned perk is not on the wiki', () => {
      const r = applyOverrides('Tactical', state(), ov({ pins: [{ ...pin, name: 'Missing' }] }))
      expect(r.warnings.join(' ')).toContain('pin target not found: Missing')
    })
  })

  it('returns the starting text, or null', () => {
    expect(applyOverrides('Tactical', state(), ov({ starting: { text: 'new start', sources: SRC } })).starting).toBe('new start')
    expect(applyOverrides('Tactical', state(), ov({})).starting).toBeNull()
  })

  it('returns an unknown class unchanged with no warnings', () => {
    const s = state()
    const r = applyOverrides('Vanguard', s, ov({ grid: [{ level: 6, name: 'X', description: 'x', sources: SRC }] }))
    expect(r).toEqual({ perkList: s.perkList, prestige: s.prestige, starting: null, warnings: [] })
  })

  it('does not mutate its input', () => {
    const s = state()
    const copy = structuredClone(s)
    applyOverrides('Tactical', s, ov({ grid: [{ level: 6, name: 'Improved Efficiency', description: 'x', sources: SRC }], pins: [{ name: 'P3', description: 'pinned', wikiSaid: 'd3', reason: 'r', sources: SRC }] }))
    expect(s).toEqual(copy)
  })
})

describe('holdClasses', () => {
  const prev = { Tactical: { v: 'old-T' }, Vanguard: { v: 'old-V' } }
  const next = { Tactical: { v: 'new-T' }, Vanguard: { v: 'new-V' }, Assault: { v: 'new-A' } }

  it('takes fresh for adopted classes and the same previous objects for the rest', () => {
    const out = holdClasses(prev, next, ['Tactical'])
    expect(out.Tactical).toBe(next.Tactical)
    expect(out.Vanguard).toBe(prev.Vanguard)
  })

  it('takes fresh for a class missing from previous', () => {
    expect(holdClasses(prev, next, ['Tactical']).Assault).toBe(next.Assault)
  })

  it('keeps a previous-only class', () => {
    expect(holdClasses({ ...prev, Gone: { v: 'g' } }, next, []).Gone).toEqual({ v: 'g' })
  })
})
