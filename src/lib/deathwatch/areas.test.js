import { describe, it, expect } from 'vitest'
import { AREAS, resolveArea } from './areas'

const tabsOf = (area) => AREAS[area].tabs.map((t) => t.slug)

describe('AREAS', () => {
  it('lists the four areas in hub order', () => {
    expect(Object.keys(AREAS)).toEqual(['eventtracker', 'armouringhall', 'chronicles', 'manage'])
  })

  it('lists the seven Event Tracker views in order', () => {
    expect(tabsOf('eventtracker')).toEqual([
      'standings',
      'kill-teams',
      'players',
      'honour-roll',
      'game-stats',
      'scoring',
      'archive',
    ])
  })

  it("lists the other areas' tabs in order", () => {
    expect(tabsOf('armouringhall')).toEqual(['standard', 'specialist', 'watch-command', 'restricted-wargear'])
    expect(tabsOf('chronicles')).toEqual([
      'hall-of-champions',
      'chamber-of-honor',
      'player-profiles',
      'in-memoriam',
      'operational-records',
    ])
    expect(tabsOf('manage')).toEqual(['enter-mission', 'manage', 'checks', 'records', 'page-texts'])
  })

  it("carries the archive's labels and blurbs verbatim", () => {
    expect(AREAS).toEqual({
      eventtracker: {
        label: 'Event Tracker',
        blurb: 'Standings, Kill Teams, players and honours',
        tabs: [
          { slug: 'standings', label: 'Standings' },
          { slug: 'kill-teams', label: 'Kill Teams' },
          { slug: 'players', label: 'Players' },
          { slug: 'honour-roll', label: 'Honour Roll' },
          { slug: 'game-stats', label: 'Game Stats' },
          { slug: 'scoring', label: 'Scoring' },
          { slug: 'archive', label: 'Archive' },
        ],
      },
      armouringhall: {
        label: 'Armouring Hall',
        blurb: 'Specialist armour, standard uniform and heraldry',
        tabs: [
          { slug: 'standard', label: 'Standard' },
          { slug: 'specialist', label: 'Specialist' },
          { slug: 'watch-command', label: 'Watch Command', commander: true },
          { slug: 'restricted-wargear', label: 'Restricted Wargear' },
        ],
      },
      chronicles: {
        label: 'Chronicles of Valor',
        blurb: 'Deeds and honours of the Watch Fortress',
        tabs: [
          { slug: 'hall-of-champions', label: 'Hall of Champions' },
          { slug: 'chamber-of-honor', label: 'Chamber of Honor' },
          { slug: 'player-profiles', label: 'Player Profiles' },
          { slug: 'in-memoriam', label: 'In Memoriam' },
          { slug: 'operational-records', label: 'Operational Records' },
        ],
      },
      manage: {
        label: 'Manage',
        blurb: "The Watch Commander's dashboard",
        tabs: [
          { slug: 'enter-mission', label: 'Enter mission' },
          { slug: 'manage', label: 'Manage' },
          { slug: 'checks', label: 'Checks' },
          { slug: 'records', label: 'Records' },
          { slug: 'page-texts', label: 'Page Texts' },
        ],
      },
    })
  })
})

describe('resolveArea', () => {
  it.each([
    ['eventtracker', 'standings'],
    ['armouringhall', 'standard'],
    ['chronicles', 'hall-of-champions'],
    ['manage', 'enter-mission'],
  ])('defaults %s to its first tab, %s', (area, first) => {
    expect(resolveArea({ area })).toEqual({ area, tab: first, sub: '', canonical: `/deathwatch/${area}/${first}` })
  })

  it('keeps a tab that exists, not only the first', () => {
    expect(resolveArea({ area: 'eventtracker', tab: 'players' })).toEqual({
      area: 'eventtracker',
      tab: 'players',
      sub: '',
      canonical: '/deathwatch/eventtracker/players',
    })
    expect(resolveArea({ area: 'chronicles', tab: 'in-memoriam' }).canonical).toBe('/deathwatch/chronicles/in-memoriam')
  })

  it('falls back to the first tab for an unknown or non-string tab', () => {
    for (const tab of ['nonsense', '', 'Players', 123, null, ['players'], {}]) {
      expect(resolveArea({ area: 'eventtracker', tab }).tab, String(tab)).toBe('standings')
    }
  })

  it('rejects an unknown area', () => {
    for (const area of ['nope', '', 'EventTracker', undefined]) {
      expect(resolveArea({ area }), String(area)).toBeNull()
    }
  })

  it('rejects missing params and a non-string area', () => {
    expect(resolveArea()).toBeNull()
    expect(resolveArea(null)).toBeNull()
    expect(resolveArea({})).toBeNull()
    // An array coerces to its text, which would otherwise find the area.
    for (const area of [123, ['eventtracker'], {}, null]) {
      expect(resolveArea({ area }), String(area)).toBeNull()
    }
  })

  it('survives prototype keys', () => {
    for (const area of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(resolveArea({ area }), area).toBeNull()
    }
    for (const tab of ['__proto__', 'constructor', 'toString']) {
      expect(resolveArea({ area: 'eventtracker', tab }).tab, tab).toBe('standings')
    }
    expect(resolveArea({ area: 'armouringhall', tab: 'standard', sub: '__proto__' }).sub).toBe('')
  })

  it('keeps a sub-slug only for the Armouring Hall', () => {
    expect(resolveArea({ area: 'armouringhall', tab: 'standard', sub: 'battlebrother' })).toEqual({
      area: 'armouringhall',
      tab: 'standard',
      sub: 'battlebrother',
      canonical: '/deathwatch/armouringhall/standard/battlebrother',
    })
    for (const area of ['eventtracker', 'chronicles', 'manage']) {
      const r = resolveArea({ area, sub: 'battlebrother' })
      expect(r.sub, area).toBe('')
      expect(r.canonical, area).not.toContain('battlebrother')
    }
  })

  it('accepts a sub-slug of one to forty lowercase letters and digits', () => {
    for (const sub of ['a', '0', '0123456789', 'a'.repeat(40)]) {
      expect(resolveArea({ area: 'armouringhall', sub }).sub, sub).toBe(sub)
    }
  })

  it('drops a hostile sub-slug', () => {
    const hostile = ['../x', 'A B', '', 'a'.repeat(41), 123, ['ab'], null, undefined, 'abc!', '!abc', 'ABC', 'abc\n', 'a-b', 'a/b']
    for (const sub of hostile) {
      const r = resolveArea({ area: 'armouringhall', tab: 'standard', sub })
      expect(r.sub, String(sub)).toBe('')
      expect(r.canonical, String(sub)).toBe('/deathwatch/armouringhall/standard')
    }
  })
})
