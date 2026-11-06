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

  describe('the flame', () => {
    // Every point of an absolute path (M L C H V Z only), as [x, y] pairs; H and V keep the other axis.
    const pointsOf = (d) => {
      const pts = []
      let x = 0
      let y = 0
      for (const [, cmd, args] of d.matchAll(/([MLCHVZ])([^MLCHVZ]*)/g)) {
        const n = (args.match(/-?\d*\.?\d+/g) ?? []).map(Number)
        if (cmd === 'H') x = n[0]
        else if (cmd === 'V') y = n[0]
        if (cmd === 'H' || cmd === 'V') pts.push([x, y])
        else if (cmd !== 'Z') {
          for (let i = 0; i < n.length; i += 2) pts.push([n[i], n[i + 1]])
          ;[x, y] = pts[pts.length - 1]
        }
      }
      return pts
    }
    const paths = () => mount(ForgeMark).findAll('.mark-flame path')
    const body = () => mount(ForgeMark).get('.mark-flame .flame-body').attributes('d')

    it('is at most three paths: the body, the lick and the dark core', () => {
      const w = mount(ForgeMark)
      expect(paths().length).toBeLessThanOrEqual(3)
      for (const part of ['flame-body', 'flame-lick', 'flame-core']) {
        expect(w.findAll(`.mark-flame path.${part}`), part).toHaveLength(1)
      }
    })

    it('stays inside its 24 by 24 cell, on whole or half pixels, with its base on y = 22', () => {
      for (const p of paths()) {
        for (const [x, y] of pointsOf(p.attributes('d'))) {
          expect(x, p.classes().join(' ')).toBeGreaterThanOrEqual(0)
          expect(x).toBeLessThanOrEqual(24)
          expect(y).toBeGreaterThanOrEqual(0)
          expect(y).toBeLessThanOrEqual(24)
          expect(x * 2 % 1).toBe(0)
          expect(y * 2 % 1).toBe(0)
        }
      }
      expect(Math.max(...pointsOf(body()).map(([, y]) => y))).toBe(22)
    })

    it('is asymmetric: the taller tongue leans well right of centre, a shorter one stands left of it', () => {
      const pts = pointsOf(body())
      const top = pts.reduce((a, b) => (b[1] < a[1] ? b : a))
      expect(top[0]).toBeGreaterThanOrEqual(15)
      // a second tip, at least 4 lower and left of centre (so two tongues, not one teardrop)
      expect(pts.some(([x, y]) => x < 10 && y >= top[1] + 4 && y < 10)).toBe(true)
    })

    it('has a dark core in obsidian, the ember body, and the ember-light lick', () => {
      const source = readFileSync(fileURLToPath(import.meta.url).replace(/\.test\.js$/, '.vue'), 'utf8')
      expect(source).toMatch(/\.flame-core\s*\{[^}]*fill:\s*var\(--color-obsidian\)/)
      expect(source).toMatch(/\.flame-body\s*\{[^}]*fill:\s*var\(--color-ember\)/)
      expect(source).toMatch(/\.flame-lick\s*\{[^}]*fill:\s*var\(--color-ember-light\)/)
    })
  })

  describe('the cold marks', () => {
    const source = () => readFileSync(fileURLToPath(import.meta.url).replace(/\.test\.js$/, '.vue'), 'utf8')

    it('anvil and hammer are drawn in a smoke stroke over a basalt-3 fill, so they show on obsidian', () => {
      expect(source()).toMatch(
        /\.mark-anvil,\s*\.mark-hammer\s*\{[^}]*fill:\s*var\(--color-basalt-3\)[^}]*stroke:\s*var\(--color-smoke\)/,
      )
    })

    it('the hairlines stay ash-2 and faint', () => {
      expect(source()).toMatch(/\.mark-rule\s*\{[^}]*stroke:\s*var\(--color-ash-2\)/)
    })
  })

  it('has no animation of any kind in its source', () => {
    const source = readFileSync(fileURLToPath(import.meta.url).replace(/\.test\.js$/, '.vue'), 'utf8')
    expect(source).not.toContain('@keyframes')
    expect(source).not.toContain('animation:')
    expect(source).not.toContain('transition')
  })
})
