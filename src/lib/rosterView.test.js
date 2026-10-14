import { describe, it, expect } from 'vitest'
import fixture from '../data/roster.fixture.json'
import companies from '../data/companies.json'
import { sceneOf } from './rosterScenes'
import { HEAT_STOPS, SIGILS, UNASSIGNED_SIGIL, buildRosterView, heatAt, showCompanyTag } from './rosterView'

const roster = fixture.roster
const view = buildRosterView(roster)
const branchView = (key) => view.branches.find((b) => b.key === key)

// hand-built rosters for the cases the fixture does not hold
const rank = (key, tier, extra = {}) => ({ key, label: key, tier, ...extra })
const person = (id, extra = {}) => ({ id, name: `Name ${id}`, avatar: null, company: null, ...extra })
const branchOf = (over = {}) => ({
  key: 'company-1', kind: 'company', label: '1st', number: 1,
  head: { rank: rank('captain', 1), members: [person('1')], vacant: false },
  aside: [], rows: [], ...over,
})
const rosterOf = (branches, extra = {}) => ({
  fetchedAt: 'x', stale: false, viewer: { infirmary: false },
  highCommand: [], branches, unassigned: { rows: [] }, servitors: [], ...extra,
})
const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o) }
const membersOf = (b) => [...(b.head.vacant ? [] : b.head.members), ...b.aside, ...b.rows.flatMap((r) => r.members)]

describe('heatAt', () => {
  it('hits the stops at its endpoints and clamps outside them', () => {
    expect(heatAt(0)).toBe('rgb(242,210,122)')
    expect(heatAt(0.4)).toBe('rgb(255,106,43)')
    expect(heatAt(1)).toBe('rgb(58,82,70)')
    expect(heatAt(-1)).toBe(heatAt(0))
    expect(heatAt(2)).toBe(heatAt(1))
    expect(heatAt(NaN)).toBe(heatAt(0))
    expect(HEAT_STOPS[0]).toEqual([0, [242, 210, 122]])
  })

  it('only cools as rank falls', () => {
    const sum = (t) => heatAt(t).match(/\d+/g).reduce((a, n) => a + Number(n), 0)
    for (let t = 0; t < 1; t += 0.05) expect(sum(t + 0.05)).toBeLessThanOrEqual(sum(t))
  })
})

describe('SIGILS', () => {
  it('covers every roster branch, and the Forge is M', () => {
    for (const b of roster.branches) expect(SIGILS[b.key], b.key).toBeTruthy()
    expect(SIGILS.forge).toBe('M')
    expect(SIGILS['company-7']).toBe('VII')
    expect(SIGILS['venerable-dreadnoughts']).toBe('VD')
    expect(UNASSIGNED_SIGIL).toBe('?')
  })

  it('agrees with the sigils on the Companies page', () => {
    const same = {
      'company-1': 'first', 'company-2': 'second', 'company-3': 'third', 'company-4': 'fourth',
      'company-5': 'fifth', 'company-6': 'sixth', 'company-7': 'seventh',
      apothecarion: 'apothecarion', librarius: 'librarius', reclusiam: 'reclusiam', forge: 'armoury',
    }
    for (const [key, id] of Object.entries(same)) expect(SIGILS[key], key).toBe(companies.find((c) => c.id === id).sigil)
  })
})

describe('showCompanyTag', () => {
  const co1 = { kind: 'company', number: 1 }
  it('hides the tag inside the member\'s own company', () => {
    expect(showCompanyTag({ company: 1 }, co1)).toBe(false)
  })
  it('shows it for another company, a specialty branch, or no branch', () => {
    expect(showCompanyTag({ company: 3 }, co1)).toBe(true)
    expect(showCompanyTag({ company: 1 }, { kind: 'specialty' })).toBe(true)
    expect(showCompanyTag({ company: 2 }, null)).toBe(true)
  })
  it('shows nothing without a company', () => {
    expect(showCompanyTag({ company: null }, null)).toBe(false)
    expect(showCompanyTag({}, { kind: 'specialty' })).toBe(false)
  })
})

describe('buildRosterView: branches', () => {
  it('keeps the twelve branches in the server\'s order', () => {
    expect(view.branches.map((b) => b.key)).toEqual(roster.branches.map((b) => b.key))
    expect(view.branches).toHaveLength(12)
    expect(branchView('company-3')).toMatchObject({ kind: 'company', number: 3, sigil: 'III' })
    expect(branchView('forge').number).toBeNull()
  })

  it('counts head, aside and every rank', () => {
    const b = roster.branches[0]
    expect(branchView('company-1').count).toBe(membersOf(b).length)
    expect(branchView('company-6').count).toBe(membersOf(roster.branches[5]).length)
  })

  it('1st Company: aside first, then groups, with the Terminator as a lateral between Sergeant and Company Veteran', () => {
    const l = branchView('company-1').ladder
    expect(l.map((i) => i.type)).toEqual(['aside', 'group', 'group', 'group', 'group', 'lateral', 'group', 'group', 'group'])
    expect(l[0].members).toEqual(roster.branches[0].aside)
    expect(l[4].rows[0].rank.key).toBe('sergeant')
    expect(l[5].row.rank).toMatchObject({ key: 'terminator', lateral: true })
    expect(l[6].rows[0].rank.key).toBe('company-veteran')
    expect(branchView('company-1').openable).toBe(true)
  })

  it('puts same-tier ranks in one group as peers', () => {
    const b = branchOf({ rows: [
      { rank: rank('lieutenant', 1), members: [person('2')] },
      { rank: rank('ancient', 2), members: [person('3')] },
      { rank: rank('champion', 2), members: [person('4')] },
      { rank: rank('sergeant', 3), members: [person('5')] },
    ] })
    const l = buildRosterView(rosterOf([b])).branches[0].ladder
    expect(l).toHaveLength(3)
    expect(l[1].rows.map((r) => r.rank.key)).toEqual(['ancient', 'champion'])
  })

  it('numbers items, grades the heat, and flags only the final group as last', () => {
    const l = branchView('company-1').ladder
    expect(l.map((i) => i.s)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    const n = 7 // groups in 1st Company
    expect(l[0].heat).toEqual({ h: heatAt(0.5 / n), hp: heatAt(0), hn: heatAt(1 / n) })
    expect(l[1].heat).toEqual({ h: heatAt(1 / n), hp: heatAt(0), hn: heatAt(2 / n) })
    expect(l[5].heat).toEqual({ h: heatAt(4.5 / n), hp: heatAt(4 / n), hn: heatAt(5 / n) })
    expect(l[8].heat.hn).toBe(heatAt(1))
    expect(l.filter((i) => i.last).map((i) => i.s)).toEqual([8])
    expect(l.filter((i) => i.type !== 'group').every((i) => i.last === undefined)).toBe(true)
  })

  it('Venerable Dreadnoughts has nothing to open', () => {
    const b = branchView('venerable-dreadnoughts')
    expect(b.openable).toBe(false)
    expect(b.ladder).toEqual([])
    expect(b.head.shown).toHaveLength(2)
    expect(b.count).toBe(2)
  })

  it('shows two head members and counts the rest', () => {
    const three = branchOf({ head: { rank: rank('captain', 1), members: [person('1'), person('2'), person('3')], vacant: false } })
    const h = buildRosterView(rosterOf([three])).branches[0].head
    expect(h.shown.map((m) => m.id)).toEqual(['1', '2'])
    expect(h.more).toBe(1)
  })

  it('a vacant head shows nobody and is marked vacant', () => {
    const h = branchView('company-6').head
    expect(h).toMatchObject({ vacant: true, shown: [], more: 0 })
    expect(h.rank.key).toBe('captain')
  })
})

describe('buildRosterView: banner, unassigned, servitors', () => {
  it('the hero is the first High Command member', () => {
    expect(view.banner.hero.member).toEqual(roster.highCommand[0].members[0])
    expect(view.banner.hero.rank).toEqual(roster.highCommand[0].rank)
    expect(view.banner.court.map((r) => r.rank.key)).toEqual(roster.highCommand.slice(1).map((r) => r.rank.key))
  })

  it('the rest of the first rank leads the court', () => {
    const r = rosterOf([], { highCommand: [{ rank: rank('lord', 1), members: [person('1'), person('2')] }, { rank: rank('guard', 2), members: [person('3')] }] })
    const b = buildRosterView(r).banner
    expect(b.hero.member.id).toBe('1')
    expect(b.court.map((x) => [x.rank.key, x.members.map((m) => m.id)])).toEqual([['lord', ['2']], ['guard', ['3']]])
  })

  it('Unassigned has the branch shape the bar reads, and is null when empty', () => {
    const u = view.unassigned
    expect(u).toMatchObject({ key: 'unassigned', label: 'Unassigned', sigil: '?', openable: true })
    expect(u.count).toBe(roster.unassigned.rows.reduce((n, r) => n + r.members.length, 0))
    expect(u.ladder.every((i) => i.type === 'group')).toBe(true)
    expect(buildRosterView(rosterOf([branchOf()])).unassigned).toBeNull()
  })

  it('passes servitors through', () => {
    expect(view.servitors).toEqual(roster.servitors)
  })
})

describe('buildRosterView: summary, index, openable keys', () => {
  it('summarises the gaps by branch key', () => {
    expect(view.summary.vacant).toEqual(['company-6'])
    expect(view.summary.acting).toEqual(['company-2'])
    expect(view.summary.mismatch).toEqual(['company-3'])
  })

  it('counts each person once, servitors excluded', () => {
    const ids = new Set()
    roster.highCommand.forEach((r) => r.members.forEach((m) => ids.add(m.id)))
    roster.branches.forEach((b) => membersOf(b).forEach((m) => ids.add(m.id)))
    roster.unassigned.rows.forEach((r) => r.members.forEach((m) => ids.add(m.id)))
    expect(view.summary.total).toBe(ids.size)
    expect(roster.servitors.some((s) => ids.has(s.id))).toBe(false)
  })

  it('indexes each person to their branch, falling back to the banner', () => {
    const inBranch = new Set(roster.branches.flatMap((b) => membersOf(b).map((m) => m.id)))
    const head4 = roster.branches.find((b) => b.key === 'company-4').head.members[0].id
    expect(roster.highCommand.some((r) => r.members.some((m) => m.id === head4))).toBe(true)
    expect(view.index.get(head4)).toBe('company-4')
    const bannerOnly = roster.highCommand.flatMap((r) => r.members).find((m) => !inBranch.has(m.id))
    expect(view.index.get(bannerOnly.id)).toBe('high-command')
    expect(view.index.get(roster.unassigned.rows[0].members[0].id)).toBe('unassigned')
    expect(view.index.get('nobody')).toBeUndefined()
  })

  it('lists openable branches, then Unassigned', () => {
    const expected = roster.branches.filter((b) => b.rows.length || b.aside.length).map((b) => b.key)
    expect(view.openableKeys).toEqual([...expected, 'unassigned'])
    expect(view.openableKeys).not.toContain('venerable-dreadnoughts')
  })
})

describe('buildRosterView: edges', () => {
  it('copes with an empty roster', () => {
    const v = buildRosterView(sceneOf(fixture, 'empty').roster)
    expect(v.banner).toEqual({ hero: null, court: [] })
    expect(v.branches).toHaveLength(12)
    expect(v.branches.every((b) => !b.openable && b.ladder.length === 0 && b.head.vacant)).toBe(true)
    expect(v.unassigned).toBeNull()
    expect(v.summary).toMatchObject({ total: 0 })
    expect(v.summary.vacant).toHaveLength(12)
    expect(v.openableKeys).toEqual([])
    expect(v.servitors).toEqual([])
  })

  it('does not mutate its input and is deterministic', () => {
    const frozen = deepFreeze(structuredClone(roster))
    const a = buildRosterView(frozen)
    expect(buildRosterView(frozen)).toEqual(a)
  })
})

describe('buildRosterView: a head with more than two members', () => {
  const heads = (n, rows = []) =>
    branchOf({
      key: 'venerable-dreadnoughts', kind: 'dreadnoughts', label: 'Venerable Dreadnoughts', number: undefined,
      head: { rank: rank('venerable-dreadnought', 1), members: Array.from({ length: n }, (_, i) => person(String(i + 1))), vacant: false },
      rows,
    })
  const viewOf = (b) => buildRosterView(rosterOf([b]))

  it('puts the members beyond the second first in the opened ladder, so nobody is hidden', () => {
    const v = viewOf(heads(4))
    const b = v.branches[0]
    expect(b.openable).toBe(true)
    expect(b.ladder).toHaveLength(1)
    expect(b.ladder[0]).toMatchObject({ type: 'group', s: 0 })
    expect(b.ladder[0].rows[0].rank.key).toBe('venerable-dreadnought')
    expect(b.ladder[0].rows[0].members.map((m) => m.id)).toEqual(['3', '4'])
    expect(b.head.shown.map((m) => m.id)).toEqual(['1', '2'])
    expect(b.head.more).toBe(2)
    expect(b.count).toBe(4)
  })

  it('does not merge that row into a same-tier rank beneath it', () => {
    const b = viewOf(heads(3, [{ rank: rank('lieutenant', 1), members: [person('9')] }])).branches[0]
    expect(b.ladder.map((i) => i.rows.map((r) => r.rank.key))).toEqual([['venerable-dreadnought'], ['lieutenant']])
  })

  it('adds nothing for a head of two or fewer', () => {
    expect(viewOf(heads(2)).branches[0].ladder).toEqual([])
    expect(viewOf(heads(2)).branches[0].openable).toBe(false)
    expect(viewOf(heads(1)).branches[0].openable).toBe(false)
  })

  it('finds every head member for Find me, shown or not', () => {
    const v = viewOf(heads(4))
    for (const id of ['1', '2', '3', '4']) expect(v.index.get(id), id).toBe('venerable-dreadnoughts')
  })
})
