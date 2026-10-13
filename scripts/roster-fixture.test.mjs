import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildFixture } from './roster-fixture.mjs'

const committed = JSON.parse(readFileSync(new URL('../src/data/roster.fixture.json', import.meta.url), 'utf8'))
const fx = buildFixture()
const branch = (key) => fx.roster.branches.find((b) => b.key === key)

describe('the synthetic roster fixture', () => {
  it('is exactly what the generator produces (run `node scripts/roster-fixture.mjs` to refresh it)', () => {
    expect(committed).toEqual(fx)
  })

  it('is marked synthetic, and all its ids are in the synthetic 9-prefixed range', () => {
    expect(fx._fixture).toBe(true)
    const ids = JSON.stringify(fx).match(/"id": ?"(\d+)"/g) ?? []
    expect(ids.length).toBeGreaterThan(50)
    for (const m of ids) expect(m).toMatch(/"9\d{17}"/)
  })

  it('covers the cases the page has to design for', () => {
    expect(fx.roster.branches).toHaveLength(12)
    expect(fx.roster.viewer).toEqual({ infirmary: true })
    expect(fx.roster.highCommand.length).toBeGreaterThanOrEqual(4)
    expect(branch('company-6').head).toMatchObject({ vacant: true, members: [] })
    expect(branch('company-2').head.members.every((m) => m.acting)).toBe(true)
    expect(branch('company-2').head.members.length).toBeGreaterThan(0)
    expect(branch('venerable-dreadnoughts').head.members.length).toBeGreaterThanOrEqual(2)
    expect(branch('company-4').aside.length).toBeGreaterThan(0)
    expect(branch('reclusiam').head.members.length).toBeGreaterThan(0)
    expect(branch('company-7').rows.find((r) => r.rank.key === 'scout').members.length).toBeGreaterThanOrEqual(20)
    expect(branch('company-1').rows.some((r) => r.rank.lateral)).toBe(true)
    expect(fx.roster.unassigned.rows.length).toBeGreaterThan(0)
    expect(fx.roster.servitors.length).toBeGreaterThanOrEqual(3)
    expect(fx.roster.servitors.some((s) => s.bot)).toBe(true)
    const everyone = [...fx.roster.highCommand.flatMap((r) => r.members), ...fx.roster.branches.flatMap((b) => [...b.head.members, ...b.aside, ...b.rows.flatMap((r) => r.members)])]
    expect(everyone.some((m) => m.nameMismatch)).toBe(true)
    expect(everyone.some((m) => m.alsoCompanies)).toBe(true)
  })

  it('has an Infirmary list with and without the Legion role, and a stripped rank', () => {
    const { members, count } = fx.infirmary
    expect(count).toBe(members.length)
    expect(members.some((m) => m.legion)).toBe(true)
    expect(members.some((m) => !m.legion)).toBe(true)
    expect(members.some((m) => m.rank === null)).toBe(true)
  })

  it('keeps Infirmary holders, the Voice of Vulkan stand-in and non-Legion accounts off the roster', () => {
    const text = JSON.stringify(fx.roster)
    for (const name of ['Voice of Vulkan', 'Fixture Outsider']) expect(text).not.toContain(name)
    const rosterIds = new Set(JSON.stringify(fx.roster).match(/"id":"\d+"/g))
    expect(rosterIds.size).toBeGreaterThan(50)
    for (const m of fx.infirmary.members) expect(rosterIds.has(`"id":"${m.id}"`)).toBe(false)
  })
})
