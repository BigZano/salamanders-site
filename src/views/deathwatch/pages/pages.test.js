// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'

// The 20 views are skeletons: the original's real headings and labels over shimmer where the content will be.
// This is the contract each one keeps until its port replaces it. A page lists exactly what it may say, so a
// real name can never slip in: whatever text is left after the allowed labels are removed must be nothing.
const MODULES = import.meta.glob('./*/*.vue', { eager: true })

const NOTE = 'This view is being rebuilt.'
const PLAYER_COLS = ['Player', 'Obj', 'Kills', 'Special', 'Melee', 'Ranged', 'Items', 'Dmg taken', 'Incaps', 'Revives', 'MVP']
const MISSION_COLS = ['Mission', 'Kills', 'Special', 'Melee', 'Ranged', 'Incaps', 'Revives', 'Seed', 'Armoury', 'Relic', 'Ext', 'Points', 'MVP']
const ARMOUR = ['Helm', 'Pauldrons', 'Wargear', 'Breastplate', 'Gauntlets', 'Greaves', 'Armour Set']
const armour = (label) => ({ h2: [label], labels: ARMOUR, figure: true })

// h2/h3: every heading, in order; tables: every table's column labels; labels: every tile and field label.
const PAGES = {
  'eventtracker/standings': {
    h2: ['Standings', 'Points progression', 'Watch Companies'],
    tables: [['#', 'Kill Team', 'W1', 'W2', 'W3', 'W4', 'Total', 'Gap', 'Ø/mission'], ['Company', 'Kill Teams', 'Points']],
    podium: true,
    chart: true,
  },
  'eventtracker/kill-teams': {
    h2: ['Kill Team profile', 'Players', 'Points per week', 'Missions'],
    labels: ['Kill Team', 'Rank', 'Event points', 'Move', 'Gap to #1', 'Missions played', 'KIA'],
    tables: [PLAYER_COLS, ['Week', 'Points', 'Total'], MISSION_COLS],
  },
  'eventtracker/players': {
    h2: ['Players'],
    tables: [['#', 'Player', 'MVP', 'Kills', 'Special', 'Revives', 'Incaps', 'Seeds', 'Class']],
  },
  'eventtracker/honour-roll': {
    h2: ['Honour Roll', 'Kill Team awards'],
    labels: [
      'Event Champion',
      'MVP',
      'Executioner · most kills',
      'Terminator · most special kills',
      'Blade Master · melee damage',
      'Marksman · ranged damage',
      'Scavenger · most items',
      'Guardian Angel · most revives',
      'Gene-Seed Hunter · seeds found',
      'Best Average',
    ],
  },
  'eventtracker/game-stats': {
    h2: ['Game Stats'],
    labels: [
      'Missions played',
      'Kills',
      'Special Kills',
      'Melee Damage',
      'Ranged Damage',
      'Items Found',
      'Damage Taken',
      'Incapacitations',
      'Revives',
      'In-Game Score',
      'Gene-Seed',
    ],
    tables: [
      ['Class', 'Played', 'Share', 'Ø kills', 'Seeds'],
      ['Kill Team', 'Tactical', 'Assault', 'Vanguard', 'Bulwark', 'Sniper', 'Heavy', 'Techmarine', 'Apothecary'],
    ],
  },
  'eventtracker/scoring': {
    h2: ['Event points per mission', 'Best possible mission', 'MVP score per objective'],
    labels: ['Played mission', 'Gene-Seed', '2 Guardian Relics', '3 Armoury Data', 'Extermination Rank', 'Total'],
  },
  'eventtracker/archive': { h2: ['Archive'] },
  'chronicles/hall-of-champions': {
    h2: ['Hall of Champions', 'Past Champions', 'How to earn this honor?'],
    labels: ['Requirements', 'Award', 'Accolade Duration', 'Legacy'],
  },
  'chronicles/chamber-of-honor': {
    h2: ['Chamber of Honor', 'Battle-Brother Honours'],
    labels: ['MVP', 'Executioner', 'Terminator', 'Blade Master', 'Marksman', 'Scavenger', 'Guardian Angel', 'Gene-Seed Hunter'],
  },
  'chronicles/player-profiles': {
    h2: ['Player Profiles'],
    tables: [['#', 'Player', 'Tours', 'Missions', 'MVP', 'Kills', 'Special', 'Melee', 'Ranged', 'Items', 'Dmg taken', 'Incaps', 'Revives', 'Seed']],
  },
  'chronicles/in-memoriam': { h2: ['In Memoriam'] },
  'chronicles/operational-records': { h2: ['Operational Records', 'Current Kill-Team Standings'], tables: [['#', 'Kill Team', 'Points']] },
  'armouringhall/standard': armour('Standard'),
  'armouringhall/specialist': armour('Specialist'),
  'armouringhall/watch-command': armour('Watch Command'),
  'manage/enter-mission': {
    h2: ['Enter mission', 'Reset all missions'],
    labels: ['Kill Team', 'Week', 'Objective', 'Played', 'In-Game Score', 'Gene-Seed'],
  },
  'manage/manage': {
    h2: ['Scoring', 'Rename or merge player', 'Kill Teams', 'Restore from backup', 'Event archive', 'Reset Kill Teams'],
    labels: ['Base points', 'Incap penalty', 'Revive bonus', 'Gene-Seed bonus', 'Armoury Data bonus', 'Guardian Relic bonus'],
  },
  'manage/checks': { h2: ['Data checks'], tables: [['']] },
  'manage/records': { h2: ['New operational record', 'Records created here'], h3: ['Kill Teams', 'Top Operatives'] },
  'manage/page-texts': { h2: ['Page Texts'] },
}

const mountPage = (key) => mount(MODULES[`./${key}.vue`].default)

describe('the 20 view skeletons', () => {
  it('are exactly the pages listed here', () => {
    expect(Object.keys(MODULES).map((k) => k.slice(2, -4)).sort()).toEqual(Object.keys(PAGES).sort())
  })

  for (const [key, want] of Object.entries(PAGES)) {
    describe(key, () => {
      it('says it is being rebuilt, as a status', () => {
        const w = mountPage(key)
        expect(w.get('[role="status"]').text()).toBe(NOTE)
      })

      it('has the original headings, in order, as plaques', () => {
        const w = mountPage(key)
        expect(w.findAll('h2').map((h) => h.text())).toEqual(want.h2)
        expect(w.findAll('h3').map((h) => h.text())).toEqual(want.h3 ?? [])
      })

      it('has the original column labels and tile and field labels', () => {
        const w = mountPage(key)
        expect(w.findAll('table').map((t) => t.findAll('th').map((th) => th.text()))).toEqual(want.tables ?? [])
        expect(w.findAll('.sk-label').map((l) => l.text())).toEqual(want.labels ?? [])
      })

      it('has the podium, chart and figure placeholders it should, and no others', () => {
        const w = mountPage(key)
        expect(w.findAll('.sk-podium')).toHaveLength(want.podium ? 1 : 0)
        expect(w.findAll('.sk-chart')).toHaveLength(want.chart ? 1 : 0)
        expect(w.findAll('.sk-figure')).toHaveLength(want.figure ? 1 : 0)
      })

      it('says nothing but its labels (no names, no data)', () => {
        const allowed = [NOTE, ...want.h2, ...(want.h3 ?? []), ...(want.tables ?? []).flat(), ...(want.labels ?? [])]
        let rest = mountPage(key).text()
        for (const s of allowed.filter(Boolean).sort((a, b) => b.length - a.length)) rest = rest.replaceAll(s, '')
        expect(rest.trim()).toBe('')
      })

      it('offers nothing to press or type into', () => {
        expect(mountPage(key).findAll('input, select, textarea, button, a')).toHaveLength(0)
      })
    })
  }

  it('hides the heading of a page whose original had none, but keeps it for assistive technology', () => {
    for (const key of ['chronicles/hall-of-champions', 'chronicles/in-memoriam', 'chronicles/player-profiles', 'armouringhall/standard']) {
      const first = mountPage(key).get('h2')
      expect(first.classes(), key).toContain('dw-sr-only')
      expect(first.classes(), key).not.toContain('dw-plaque')
    }
    expect(mountPage('eventtracker/standings').get('h2').classes()).toContain('dw-plaque')
  })
})
