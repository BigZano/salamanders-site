// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SkTable from './SkTable.vue'
import SkPodium from './SkPodium.vue'
import SkChart from './SkChart.vue'
import SkTiles from './SkTiles.vue'
import SkForm from './SkForm.vue'
import SkNote from './SkNote.vue'
import SkFigure from './SkFigure.vue'

// The primitives a view skeleton is built from: real labels, shimmer where the content will be. The shimmer
// itself (an opacity pulse, off under reduced motion) is in deathwatch.css and tested in deathwatch.css.test.js.
describe('SkTable', () => {
  const columns = ['#', 'Kill Team', 'W1', 'Ø/mission']

  it('shows each column label once, as a header cell', () => {
    const w = mount(SkTable, { props: { columns } })
    expect(w.findAll('thead th').map((th) => th.text())).toEqual(columns)
  })

  it('shows five placeholder rows by default and as many as asked', () => {
    expect(mount(SkTable, { props: { columns } }).findAll('tbody tr')).toHaveLength(5)
    const three = mount(SkTable, { props: { columns, rows: 3 } })
    expect(three.findAll('tbody tr')).toHaveLength(3)
    for (const tr of three.findAll('tbody tr')) expect(tr.findAll('td')).toHaveLength(columns.length)
  })

  it('keeps repeated labels, and hides the placeholder rows from assistive technology', () => {
    const w = mount(SkTable, { props: { columns: ['Obj', 'Obj'], rows: 1 } })
    expect(w.findAll('thead th')).toHaveLength(2)
    expect(w.get('tbody').attributes('aria-hidden')).toBe('true')
  })

  it('scrolls sideways inside its own wrapper, so a wide table never widens the page', () => {
    expect(mount(SkTable, { props: { columns } }).get('.sk-scroll').exists()).toBe(true)
  })
})

describe('SkTiles', () => {
  it('shows one tile per label, with the label as text and a shimmer bar for the value', () => {
    const labels = ['Rank', 'Event points', 'Gap to #1']
    const w = mount(SkTiles, { props: { labels } })
    const tiles = w.findAll('.sk-tile')
    expect(tiles.map((t) => t.get('.sk-label').text())).toEqual(labels)
    for (const t of tiles) expect(t.get('.dw-sk-bar').attributes('aria-hidden')).toBe('true')
  })

  it('draws nothing for no labels and no count', () => {
    expect(mount(SkTiles, { props: { labels: [] } }).findAll('.sk-tile')).toHaveLength(0)
    expect(mount(SkTiles).findAll('.sk-tile')).toHaveLength(0)
  })

  it('draws unlabelled tiles when only a count is given, with no label element', () => {
    const w = mount(SkTiles, { props: { count: 3 } })
    expect(w.findAll('.sk-tile')).toHaveLength(3)
    expect(w.findAll('.sk-label')).toHaveLength(0)
    expect(w.findAll('.dw-sk-bar')).toHaveLength(3)
  })

  it('prefers the labels over the count', () => {
    expect(mount(SkTiles, { props: { labels: ['A'], count: 5 } }).findAll('.sk-tile')).toHaveLength(1)
  })
})

describe('SkForm', () => {
  it('shows a label and a placeholder field for each field', () => {
    const fields = ['Kill Team', 'Week', 'In-Game Score']
    const w = mount(SkForm, { props: { fields } })
    const rows = w.findAll('.sk-field')
    expect(rows.map((r) => r.get('.sk-label').text())).toEqual(fields)
    for (const r of rows) expect(r.get('.sk-input').attributes('aria-hidden')).toBe('true')
  })

  it('draws unlabelled field boxes when only a count is given', () => {
    const w = mount(SkForm, { props: { count: 2 } })
    expect(w.findAll('.sk-field')).toHaveLength(2)
    expect(w.findAll('.sk-label')).toHaveLength(0)
    expect(mount(SkForm).findAll('.sk-field')).toHaveLength(0)
  })

  it('offers nothing to type into: a skeleton is not a form', () => {
    const w = mount(SkForm, { props: { fields: ['A', 'B'] } })
    expect(w.findAll('input, select, textarea, button')).toHaveLength(0)
  })
})

describe('SkPodium', () => {
  it('is three cards with the middle one raised, all hidden from assistive technology', () => {
    const w = mount(SkPodium)
    expect(w.attributes('aria-hidden')).toBe('true')
    const cards = w.findAll('.sk-card')
    expect(cards).toHaveLength(3)
    expect(cards.map((c) => c.classes('is-first'))).toEqual([false, true, false])
  })
})

describe('SkNote', () => {
  it('says the view is being rebuilt, as a status', () => {
    const w = mount(SkNote)
    expect(w.text()).toBe('This view is being rebuilt.')
    expect(w.attributes('role')).toBe('status')
  })
})

describe('SkFigure', () => {
  it('is a tall framed placeholder hidden from assistive technology', () => {
    const w = mount(SkFigure)
    expect(w.attributes('aria-hidden')).toBe('true')
    expect(w.classes()).toContain('sk-figure')
  })
})

describe('the skeleton barrel', () => {
  it('exports every primitive', async () => {
    const barrel = await import('./index.js')
    expect(Object.keys(barrel).sort()).toEqual(['SkChart', 'SkFigure', 'SkForm', 'SkNote', 'SkPodium', 'SkTable', 'SkTiles'])
  })
})

describe('SkChart', () => {
  it('is a framed plot with axes, hidden from assistive technology', () => {
    const w = mount(SkChart)
    expect(w.attributes('aria-hidden')).toBe('true')
    expect(w.get('.sk-chart').exists()).toBe(true)
    expect(w.findAll('.sk-axis').length).toBeGreaterThanOrEqual(2)
  })
})
