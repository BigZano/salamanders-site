// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import companies from '../data/companies.json'
import { TEXT, contrast, over } from '../test-utils/contrast'
import Companies from './Companies.vue'
import source from './Companies.vue?raw'

const render = () => mount(Companies)

describe('Companies', () => {
  it('uses the shared page header', () => {
    const w = render()
    const header = w.find('header.page-head')
    expect(header.classes()).toContain('c-head')
    expect(header.find('.eyebrow').text()).toBe('The Chapter')
    expect(header.find('h1').text()).toBe('Companies & Sections')
    expect(header.find('.page-lede').text()).toContain('forged from many hearths')
  })

  it('keeps the search box in the header, and it still filters', async () => {
    const w = render()
    const all = w.findAll('article.company').length
    expect(all).toBe(companies.length)
    expect(w.find('header .c-search').exists()).toBe(true)
    await w.find('.c-search').setValue('firedrakes')
    const left = w.findAll('article.company')
    expect(left.length).toBeGreaterThan(0)
    expect(left.length).toBeLessThan(all)
    expect(left[0].find('.company-title').text()).toContain('Firedrakes')
    await w.find('.c-search').setValue('zzzzzz')
    expect(w.findAll('article.company')).toHaveLength(0)
    expect(w.find('.c-empty').text()).toBe('No companies match “zzzzzz”.')
  })

  it('puts each text block on the readable surface', () => {
    const blocks = render().findAll('.block')
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every((b) => b.classes().includes('surface'))).toBe(true)
  })

  it('on wide screens, a left scrim keeps text readable wherever the text runs', () => {
    // The text column is at most 62ch (about 60% of the page); the scrim must hold 4.5:1 against
    // the brightest lava all the way across it, then fade out over the empty right half.
    const rule = source.match(/\.block\.surface\s*\{([^}]*)\}/)
    expect(rule, 'a .block.surface rule for wide screens').not.toBeNull()
    const stops = [...rule[1].matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)\s*(\d+)%/g)].map((m) => ({ rgb: [m[1], m[2], m[3]], alpha: Number(m[4]), at: Number(m[5]) }))
    expect(stops.length).toBeGreaterThanOrEqual(2)
    const covering = stops.filter((s) => s.at <= 62)
    expect(covering.length).toBeGreaterThanOrEqual(2)
    for (const s of covering) expect(contrast(over(s.rgb, s.alpha), TEXT), `${s.at}%`).toBeGreaterThanOrEqual(4.5)
    expect(Math.max(...stops.map((s) => s.at))).toBeGreaterThanOrEqual(62)
  })
})
