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
    // a High Command Captain heads their company too, unlabelled
    const head4 = branch('company-4').head.members
    expect(head4).toHaveLength(1)
    expect(head4[0]).not.toHaveProperty('acting')
    expect(fx.roster.highCommand.flatMap((r) => r.members).some((m) => m.id === head4[0].id)).toBe(true)
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

describe('the scaled fixture (for performance checks)', () => {
  const big = buildFixture(5)
  const inRows = (f) => f.roster.branches.flatMap((b) => b.rows.flatMap((r) => r.members))
  const bigBranch = (key) => big.roster.branches.find((b) => b.key === key)

  it('scale 1 is the committed fixture', () => {
    expect(buildFixture(1)).toEqual(committed)
    expect(buildFixture()).toEqual(committed)
  })

  it('scale 5 has about five times the waterfall members', () => {
    expect(inRows(big).length).toBeGreaterThanOrEqual(inRows(fx).length * 4.5)
    expect(bigBranch('company-7').rows.find((r) => r.rank.key === 'scout').members.length).toBe(24 * 5)
  })

  it('scale 5 keeps the shape: twelve branches, the same High Command, the same gaps', () => {
    expect(big.roster.branches.map((b) => b.key)).toEqual(fx.roster.branches.map((b) => b.key))
    expect(big.roster.highCommand.map((r) => r.rank.key)).toEqual(fx.roster.highCommand.map((r) => r.rank.key))
    expect(bigBranch('company-6').head.vacant).toBe(true)
    expect(bigBranch('company-2').head.members.every((m) => m.acting)).toBe(true)
    expect(bigBranch('company-1').rows.some((r) => r.rank.lateral)).toBe(true)
    expect(bigBranch('company-1').aside.length).toBe(branch('company-1').aside.length)
  })

  it('scale 5 ids are unique and in the synthetic range', () => {
    const ids = [...inRows(big), ...big.roster.unassigned.rows.flatMap((r) => r.members), ...big.roster.servitors].map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^9\d{17}$/)
  })

  it('rejects a scale that is not a positive whole number', () => {
    for (const bad of [0, -1, 1.5, NaN, '3']) expect(() => buildFixture(bad), String(bad)).toThrow(/scale/)
  })
})
