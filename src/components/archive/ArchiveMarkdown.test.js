// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import ArchiveMarkdown from './ArchiveMarkdown'
import { parse } from '../../lib/archive/markdown'

// What the renderer makes of the nodes only the site's extended markdown has, and of a spoiler that runs over lines in either
// dialect. Discord's own nodes are exercised through the Archive and the Librarius (archive.test.js, LibMessage).
const base = { link: () => ({ kind: 'text' }), emoji: (n) => `:${n.name}:`, mention: () => ({ label: '@x', color: null }) }
const EXT = { dialect: 'extended' }

function render(src, ctx = base, opts = EXT) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] })
  return mount(ArchiveMarkdown, { props: { nodes: parse(src, opts), ctx }, global: { plugins: [router] } })
}

describe('ArchiveMarkdown: extended nodes', () => {
  it.each([[1, 'h2'], [2, 'h3'], [3, 'h4'], [4, 'h5'], [5, 'h6'], [6, 'h6']])('a level %i heading is an %s with its own class', (level, tag) => {
    const w = render(`${'#'.repeat(level)} Title`)
    const heading = w.find(`.md-h${level}`)
    expect(heading.element.tagName.toLowerCase()).toBe(tag)
    expect(heading.classes()).toContain('md-h')
    expect(heading.text()).toBe('Title')
    expect(w.findAll('h1, h7')).toHaveLength(0)
  })

  it('a table is a scrollable region with a header row, header cells, and rows', () => {
    const w = render('| **Name** | Count |\n|:-|-:|\n| a | 1 |\n| b | |')
    const wrap = w.find('.md-table-wrap')
    expect(wrap.attributes('tabindex')).toBe('0')
    expect(wrap.attributes('role')).toBe('region')
    expect(wrap.attributes('aria-label')).toBe('Table')
    const table = wrap.find('table.md-table')
    expect(table.exists()).toBe(true)
    const heads = table.findAll('thead tr th')
    expect(heads.map((th) => th.text())).toEqual(['Name', 'Count'])
    expect(heads.every((th) => th.attributes('scope') === 'col')).toBe(true)
    expect(heads[0].find('strong').exists()).toBe(true)
    expect(table.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => td.text()))).toEqual([['a', '1'], ['b', '']])
  })

  it('a table with no rows has a header and an empty body', () => {
    const w = render('| a |\n|-|')
    expect(w.findAll('thead th')).toHaveLength(1)
    expect(w.findAll('tbody tr')).toHaveLength(0)
  })

  it('a cell is text: markup in it stays inert', () => {
    const w = render('| <img src=x onerror=alert(1)> |\n|-|\n| <script>alert(1)</script> |')
    expect(w.findAll('script, img, [onerror]')).toHaveLength(0)
    expect(w.find('th').text()).toBe('<img src=x onerror=alert(1)>')
  })

  it('a divider is a rule', () => {
    const w = render('a\n---\nb')
    expect(w.findAll('hr.md-hr')).toHaveLength(1)
    expect(w.findAll('p.md-line').map((p) => p.text())).toEqual(['a', 'b'])
  })

  it('a footnote reference is a marker, and the notes are a labelled section after the text', () => {
    const w = render('A claim[^src].\n[^src]: The **source**.\n[^zz]: Another.')
    const marker = w.find('p.md-line sup.md-fnref')
    expect(marker.text()).toBe('[src]')
    const section = w.find('section.md-footnotes')
    expect(section.attributes('aria-label')).toBe('Footnotes')
    const notes = section.findAll('.md-footnote')
    expect(notes.map((n) => n.find('sup.md-fnref').text())).toEqual(['[src]', '[zz]'])
    expect(notes[0].find('p.md-line').text()).toBe('The source.')
    expect(notes[0].find('strong').text()).toBe('source')
    expect(w.element.lastElementChild).toBe(section.element)
  })

  it('a picture is what the context makes of its number, given its alt text too', () => {
    const calls = []
    const ctx = { ...base, image: (ref, alt) => (calls.push([ref, alt]), h('img', { class: 'test-img', 'data-ref': String(ref), alt })) }
    const w = render('a ![the **fall**](upload:7) b ![](upload:2)', ctx)
    expect(w.findAll('img.test-img').map((img) => [img.attributes('data-ref'), img.attributes('alt')])).toEqual([['7', 'the **fall**'], ['2', '']])
    expect(w.find('p.md-line').text()).toBe('a  b')
    expect(calls).toEqual([[7, 'the **fall**'], [2, '']])
  })

  it('a picture the context has no answer for, or no context for, shows its alt text, inert', () => {
    const none = { ...base, image: () => null }
    for (const ctx of [none, base, { ...base, image: () => undefined }]) {
      const w = render('![<b>x</b> "q"](upload:3)', ctx)
      expect(w.find('span.md-image-missing').text()).toBe('<b>x</b> "q"')
      expect(w.findAll('b, img')).toHaveLength(0)
    }
  })

  it('a picture in a heading, a list, a quote, a table and a spoiler is rendered through the context', () => {
    const ctx = { ...base, image: (ref) => h('img', { class: 'test-img', 'data-ref': String(ref) }) }
    const w = render('# ![](upload:1)\n- ![](upload:2)\n> ![](upload:3)\n||![](upload:4)||\n| ![](upload:5) |\n|-|\n| ![](upload:6) |', ctx)
    expect(w.findAll('img.test-img').map((img) => img.attributes('data-ref'))).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('a spoiler over the lines of a paragraph (the extended dialect) is one spoiler with a line break in it', () => {
    const w = render('x ||a\nb|| y')
    expect(w.findAll('.md-spoiler')).toHaveLength(1)
    expect(w.find('.md-spoiler').html()).toContain('<br>')
    expect(w.find('.md-spoiler').text()).toBe('ab')
    expect(w.findAll('p.md-line')).toHaveLength(1)
  })
  it('a spoiler over lines in the Discord dialect is one block toggle, the words before and after it lines of their own', () => {
    const w = render('x ||a\nb|| y', base, {})
    expect(w.findAll('.md-spoiler')).toHaveLength(1)
    expect(w.find('.md-spoiler').element.tagName).toBe('DIV')
    expect(w.find('.md-spoiler').classes()).toContain('md-spoiler-block')
    expect(w.findAll('.md-spoiler p.md-line').map((p) => p.text())).toEqual(['a', 'b'])
    expect(w.findAll('p.md-line').filter((p) => !p.element.closest('.md-spoiler')).map((p) => p.text())).toEqual(['x', 'y'])
  })
})
