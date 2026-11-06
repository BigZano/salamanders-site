// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mount } from '@vue/test-utils'
import ForgeMark from './ForgeMark.vue'

describe('ForgeMark', () => {
  it('renders one decorative svg', () => {
    const w = mount(ForgeMark)
    expect(w.findAll('svg.forge-mark')).toHaveLength(1)
    const svg = w.get('svg.forge-mark')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('focusable')).toBe('false')
    expect(svg.attributes('viewBox')).toBe('0 0 120 24')
  })

  it('draws a flame, an anvil, a hammer and two hairlines', () => {
    const w = mount(ForgeMark)
    expect(w.find('.mark-flame').exists()).toBe(true)
    expect(w.find('.mark-anvil').exists()).toBe(true)
    expect(w.find('.mark-hammer').exists()).toBe(true)
    expect(w.findAll('.mark-rule')).toHaveLength(2)
  })

  it('puts the hairlines between the three cells', () => {
    const rules = mount(ForgeMark).findAll('line.mark-rule')
    expect(rules.map((r) => [r.attributes('x1'), r.attributes('x2'), r.attributes('y1'), r.attributes('y2')])).toEqual([
      ['30', '44', '12', '12'],
      ['76', '90', '12', '12'],
    ])
  })

  it('is full strength and medium by default', () => {
    const svg = mount(ForgeMark).get('svg')
    expect(svg.classes()).not.toContain('is-muted')
    expect(svg.classes()).not.toContain('is-sm')
  })

  it('muted adds is-muted', () => {
    expect(mount(ForgeMark, { props: { muted: true } }).get('svg').classes()).toContain('is-muted')
  })

  it('size="sm" adds is-sm', () => {
    expect(mount(ForgeMark, { props: { size: 'sm' } }).get('svg').classes()).toContain('is-sm')
  })

  it('has no animation of any kind in its source', () => {
    const source = readFileSync(fileURLToPath(import.meta.url).replace(/\.test\.js$/, '.vue'), 'utf8')
    expect(source).not.toContain('@keyframes')
    expect(source).not.toContain('animation:')
    expect(source).not.toContain('transition')
  })
})
