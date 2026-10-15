import { describe, it, expect } from 'vitest'
import { syntheticGuild } from '../../scripts/roster-fixture.mjs'
import { buildRoster } from './rosterCore.js'
import { publicRoster } from './rosterPublic.js'

const GUILD = '1322056087792521269'
const HEAD_RANK_KEYS = ['key', 'label', 'tier']
const ROW_RANK_KEYS = ['key', 'label', 'tier', 'lateral']
const realRoster = () => buildRoster(syntheticGuild(), { guildId: GUILD })
const extraKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k))

const rank = (key, tier = 1) => ({ key, label: key.toUpperCase(), tier })
const person = (name, extra = {}) => ({
  id: '200000000000000099',
  name,
  avatar: 'https://cdn.discordapp.com/avatars/200000000000000099/abc.png?size=64',
  company: 3,
  alsoCompanies: [5],
  nameMismatch: true,
  ...extra,
})

const ROSTER = {
  highCommand: [{ rank: rank('chapter-master'), members: [person('Hero One')] }],
  branches: [
    {
      key: 'company-3',
      kind: 'company',
      label: '3rd Battle Company',
      number: 3,
      head: { rank: rank('captain'), members: [person('Cap A'), person('Cap B'), person('Cap C')], vacant: false },
      aside: [person('Old Dread')],
      rows: [
        { rank: rank('sergeant', 3), members: [person('Serg 1'), person('Serg 2')] },
        { rank: { ...rank('terminator', 4), lateral: true }, members: [person('Term')] },
      ],
    },
    { key: 'company-6', kind: 'company', label: '6th Battle Company', number: 6, head: { rank: rank('captain'), members: [], vacant: true }, aside: [], rows: [] },
    { key: 'company-2', kind: 'company', label: '2nd Battle Company', number: 2, head: { rank: rank('captain'), members: [person('Acting One', { acting: true })], vacant: false }, aside: [], rows: [] },
    { key: 'forge', kind: 'specialty', label: 'Forge', head: { rank: rank('forgemaster'), members: [person('Smith')], vacant: false }, aside: [], rows: [] },
  ],
  unassigned: { rows: [{ rank: rank('no-rank'), members: [person('Hidden Unassigned')] }] },
  servitors: [person('Hidden Servitor', { bot: true })],
}

describe('publicRoster', () => {
  it('keeps only allowlisted keys at every level', () => {
    const out = publicRoster(realRoster())
    expect(extraKeys(out, ['highCommand', 'branches'])).toEqual([])
    for (const row of out.highCommand) {
      expect(extraKeys(row, ['rank', 'members'])).toEqual([])
      expect(extraKeys(row.rank, HEAD_RANK_KEYS)).toEqual([])
      for (const m of row.members) expect(extraKeys(m, ['name'])).toEqual([])
    }
    expect(out.branches.length).toBeGreaterThan(0)
    for (const b of out.branches) {
      expect(extraKeys(b, ['key', 'kind', 'label', 'number', 'head', 'aside', 'rows'])).toEqual([])
      expect(extraKeys(b.head, ['rank', 'vacant', 'members'])).toEqual([])
      expect(extraKeys(b.head.rank, HEAD_RANK_KEYS)).toEqual([])
      for (const m of b.head.members) expect(extraKeys(m, ['name', 'acting'])).toEqual([])
      expect(typeof b.aside).toBe('number')
      for (const r of b.rows) {
        expect(extraKeys(r, ['rank', 'count'])).toEqual([])
        expect(extraKeys(r.rank, ROW_RANK_KEYS)).toEqual([])
      }
    }
  })

  it('carries no snowflake, avatar url or flag anywhere in a real-shaped roster', () => {
    const json = JSON.stringify(publicRoster(realRoster()))
    expect(json).not.toMatch(/\d{17,20}/)
    for (const word of ['cdn.discordapp.com', 'avatar', 'nameMismatch', 'alsoCompanies', '"company":', '"bot":', '"roles":', '"id":']) {
      expect(json).not.toContain(word)
    }
  })

  it('drops a field added anywhere in the roster later, not just on members', () => {
    const LEAK = 'LEAK'
    const tainted = {
      highCommand: [{ rank: { ...rank('chapter-master'), leak: LEAK }, members: [person('Hero One')], leak: LEAK }],
      branches: [
        {
          key: 'company-3',
          kind: 'company',
          label: '3rd Battle Company',
          number: 3,
          leak: LEAK,
          head: { rank: { ...rank('captain'), leak: LEAK }, members: [person('Cap A')], vacant: false, leak: LEAK },
          aside: [],
          rows: [{ rank: { ...rank('sergeant', 3), leak: LEAK }, members: [person('Serg 1')], leak: LEAK }],
        },
      ],
      leak: LEAK,
    }
    expect(JSON.stringify(publicRoster(tainted))).not.toContain(LEAK)
  })

  it('keeps lateral on rank rows only, never on a head or High Command rank', () => {
    const lateral = (key, tier) => ({ ...rank(key, tier), lateral: true })
    const out = publicRoster({
      highCommand: [{ rank: lateral('chapter-master', 1), members: [person('Hero One')] }],
      branches: [
        {
          key: 'company-3',
          kind: 'company',
          label: '3rd Battle Company',
          number: 3,
          head: { rank: lateral('captain', 2), members: [person('Cap A')], vacant: false },
          aside: [],
          rows: [{ rank: lateral('terminator', 4), members: [person('Term')] }],
        },
      ],
    })
    expect(out.highCommand[0].rank).toEqual(rank('chapter-master', 1))
    expect(out.branches[0].head.rank).toEqual(rank('captain', 2))
    expect(out.branches[0].rows[0].rank).toEqual(lateral('terminator', 4))
  })

  it('projects an empty roster to empty lists', () => {
    expect(publicRoster({ highCommand: [], branches: [], unassigned: { rows: [] }, servitors: [] })).toEqual({ highCommand: [], branches: [] })
  })

  it('names every holder of a head rank, including more than two', () => {
    const out = publicRoster(ROSTER)
    expect(out.branches[0].head.members.map((m) => m.name)).toEqual(['Cap A', 'Cap B', 'Cap C'])
    expect(out.highCommand).toEqual([{ rank: rank('chapter-master'), members: [{ name: 'Hero One' }] }])
  })

  it('leaves out everyone below the head, the Unassigned list and the Servitors', () => {
    const json = JSON.stringify(publicRoster(ROSTER))
    for (const hidden of ['Serg 1', 'Serg 2', 'Term', 'Old Dread', 'Hidden Unassigned', 'Hidden Servitor']) {
      expect(json).not.toContain(hidden)
    }
  })

  it('marks acting heads and vacant posts', () => {
    const [, vacant, acting] = publicRoster(ROSTER).branches
    expect(vacant.head).toEqual({ rank: rank('captain'), vacant: true, members: [] })
    expect(acting.head.vacant).toBe(false)
    expect(acting.head.members).toEqual([{ name: 'Acting One', acting: true }])
    expect(publicRoster(ROSTER).branches[0].head.members[0]).toEqual({ name: 'Cap A' })
  })

  it('counts aside Dreadnoughts and rank rows without names', () => {
    const company = publicRoster(ROSTER).branches[0]
    expect(company.aside).toBe(1)
    expect(company.rows).toEqual([
      { rank: rank('sergeant', 3), count: 2 },
      { rank: { ...rank('terminator', 4), lateral: true }, count: 1 },
    ])
  })

  it('keeps number on companies only, and lateral on lateral ranks only', () => {
    const out = publicRoster(ROSTER)
    expect(out.branches[0].number).toBe(3)
    expect('number' in out.branches[3]).toBe(false)
    expect('lateral' in out.branches[0].rows[0].rank).toBe(false)
    expect(out.branches[0].rows[1].rank.lateral).toBe(true)
    expect(out.branches[0]).toMatchObject({ key: 'company-3', kind: 'company', label: '3rd Battle Company' })
  })

  it('passes a name through as text, untouched', () => {
    const roster = { ...ROSTER, highCommand: [{ rank: rank('chapter-master'), members: [person('<b>x</b>')] }] }
    expect(publicRoster(roster).highCommand[0].members[0].name).toBe('<b>x</b>')
  })

  it('does not mutate its input', () => {
    const before = structuredClone(ROSTER)
    publicRoster(ROSTER)
    expect(ROSTER).toEqual(before)
  })
})
