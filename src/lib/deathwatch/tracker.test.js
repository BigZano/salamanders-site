import { describe, expect, it } from 'vitest'
import {
  WEIGHTS,
  archiveDoc,
  bestMission,
  calc,
  discordText,
  findMission,
  honours,
  nextOpenSlot,
  parseBackup,
  progression,
  renameInTeam,
  renamePlan,
  teamStats,
  withMission,
} from './tracker'

// Invented teams and players. A row: [name, class, seed, kills, special, melee, ranged, items, dmgTaken, incaps, revives].
const row = (name, o = {}) => [name, o.c ?? 'Tactical', o.g ?? 0, o.k ?? 50, o.s ?? 2, 1000, 2000, 1, 500, o.i ?? 0, o.v ?? 0]
const teams = () => ({
  1: {
    id: 1,
    n: 'Alpha',
    co: 'Primus',
    ro: ['a1', 'a2'],
    ki: ['a2'],
    kw: { a2: 2 },
    m: [
      [1, 1, 1, 900, 1, 0, 0, 'A', [row('a1', { i: 1, v: 2, g: 1 }), row('a2')]],
      [2, 1, 1, 800, 0, 0, 0, '', [row('a1'), row('b1', { c: 'Sniper' })]],
    ],
  },
  2: { id: 2, n: 'Beta', co: 'Secundus', ro: ['b1'], m: [[1, 1, 1, 700, 0, 2, 1, 'B', [row('b1', { k: 0 })]], [2, 1, 0, 0, 0, 0, 0, '', []]] },
})

describe('calc', () => {
  it('scores missions from the weights and ranks the teams', () => {
    const R = calc(teams())
    // Alpha W1: 500 + 200 gene-seed + 100 rank A + 2 revives × 25 − 1 incap × 75; W2: 500.
    expect(R.ts.map((t) => [t.n, t.wk, t.tot, t.r, t.pl])).toEqual([
      ['Alpha', [775, 500, 0, 0], 1275, 1, 2],
      ['Beta', [680, 0, 0, 0], 680, 2, 1],
    ])
    expect(R.ts[1].gap).toBe(595)
  })

  it('takes the event weights over the defaults', () => {
    expect(calc(teams(), { base: 0 }).ts[0].tot).toBe(275)
  })

  it('counts MVP on the home Kill Team only, and a guest still helps the team', () => {
    const R = calc(teams())
    const b1 = R.pl.find((p) => p.n === 'b1')
    expect(b1.o).toBe(1) // b1's objective for Alpha does not count for b1
    expect(R.ts[0].cc.Sniper).toBe(1)
    expect(R.home).toEqual({ a1: 1, a2: 1, b1: 2 })
  })

  it('finds the data checks and the fallen', () => {
    const R = calc(teams())
    expect(R.CK.nd).toEqual(['Beta W1 O1']) // played, no kills entered
    expect(R.CK.sg).toBe(0)
    expect(R.kia.get('a2')).toBe(2)
  })

  it('moves a team by its rank change since last week', () => {
    const t = teams()
    t[2].m.push([2, 2, 1, 0, 1, 3, 2, 'A', [row('b1')]])
    const R = calc(t)
    // Beta's 975 in week 2 takes it past Alpha, which led after week 1.
    expect(R.ts.map((x) => [x.n, x.mv])).toEqual([
      ['Beta', 1],
      ['Alpha', -1],
    ])
  })

  it('copes with no teams', () => {
    expect(calc(undefined).ts).toEqual([])
    expect(progression(calc({}), 'tot')).toBeNull()
  })
})

describe('the views', () => {
  it('sums a team for Game Stats', () => {
    const a = teamStats(teams()[1])
    expect(a.slice(0, 2)).toEqual([2, 200]) // missions played, kills
    expect(a[14]).toBe(1) // one rank A
  })

  it('names the champion and the award holders', () => {
    const H = honours(calc(teams()))
    expect(H.champion.n).toBe('Alpha')
    expect(H.players.find((a) => a.key === 'k').best).toMatchObject({ value: 100, who: [{ n: 'a1' }] })
    expect(H.teams.find((a) => a.label === 'Killstorm').best.who).toEqual(['Alpha W1 O1', 'Alpha W2 O1']) // a tie names both
  })

  it('draws the progression as totals, gaps and ranks', () => {
    const R = calc(teams())
    expect(progression(R, 'tot').ts.map((t) => t.v)).toEqual([[0, 775, 1275], [0, 680, 680]])
    expect(progression(R, 'gap').ts[1].v).toEqual([-95, -595])
    expect(progression(R, 'rk').ts[1].v).toEqual([2, 2])
  })

  it('splits the best mission between Gene-Seed and Relics by what scores more', () => {
    expect(bestMission(WEIGHTS).total).toBe(500 + 200 + 100 + 75 + 100)
    expect(bestMission({ ...WEIGHTS, gs: 0 }).parts[1]).toEqual(['3 Guardian Relics', 150])
  })

  it('writes the standings for Discord', () => {
    // Local noon: discordText prints the viewer's own date, and an ISO date string is midnight UTC (the day before, west of it).
    const text = discordText(calc(teams()), new Date(2026, 9, 24, 12))
    expect(text).toContain('(as of 24 Oct 2026)')
    expect(text).toContain('• Event Champion: Alpha (1.275)')
  })
})

describe('Manage', () => {
  it('renames a player everywhere in a team', () => {
    const d = renameInTeam(teams()[1], 'a2', 'x')
    expect(d.ro).toEqual(['a1', 'x'])
    expect(d.kw).toEqual({ x: 2 })
    expect(d.m[0][8][1][0]).toBe('x')
  })

  it('plans a rename across the live event and the archive', () => {
    const t = teams()
    const archive = { e1: { name: 'Old', teams: [t[2]] } }
    expect(renamePlan(t, archive, 'b1', 'z')).toMatchObject({ teams: [1, 2], archives: ['e1'], entries: 3 })
  })

  it('refuses a rename that would merge two players in one mission or across rosters', () => {
    const t = teams()
    expect(renamePlan(t, {}, 'a1', 'b1').error).toMatch(/both appear in Alpha W2 O1/)
    expect(renamePlan(t, {}, 'a2', 'b1').error).toMatch(/roster of Beta/)
    expect(renamePlan(t, {}, 'A1', 'q').error).toBe('No entries for “A1”. Did you mean “a1”?')
    expect(renamePlan(t, {}, 'a1', 'a1').error).toBe('The names are identical.')
  })

  it('reads a backup and refuses a damaged one', () => {
    const P = parseBackup({ exported: '2026-10-01T00:00:00Z', scoring: { base: '400' }, teams: Object.values(teams()) })
    expect(P.teams).toHaveLength(2)
    expect(P.scoring.base).toBe(400)
    expect(P.scoring.inc).toBe(75)
    expect(() => parseBackup({ teams: [] })).toThrow('No Kill Teams')
    expect(() => parseBackup({ teams: [{ id: 1, n: 'A', ro: [], m: [[1, 1]] }] })).toThrow('damaged mission')
    expect(() => parseBackup({ teams: [{ id: 1, n: 'A', ro: [], m: [] }, { id: 1, n: 'B', ro: [], m: [] }] })).toThrow('appears twice')
  })

  it('archives the event with its champion and counts', () => {
    const a = archiveDoc(teams(), WEIGHTS, 'Tour', new Date('2026-10-01T00:00:00Z'))
    expect(a.sum).toEqual({ champ: 'Alpha', pts: 1275, nt: 2, nm: 3 })
    expect(a.teams[1].ki).toEqual([])
  })

  it('puts a mission in its slot and finds the next open one', () => {
    const t = withMission(teams()[1], [1, 2, 1, 0, 0, 0, 0, '', []])
    expect(t.m.map((m) => `${m[0]}.${m[1]}`)).toEqual(['1.1', '1.2', '2.1'])
    expect(findMission(t, 1, 2)).toBeTruthy()
    expect(nextOpenSlot(t, 1, 1)).toEqual([1, 3])
    expect(nextOpenSlot(t, 4, 4)).toBeNull()
  })
})
