// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mount } from '@vue/test-utils'
import ArchivePlaque from './ArchivePlaque.vue'
import { deathfireHeat } from '../../lib/deathfireHeat'

// The plaque wraps a whole thread, so a custom property written on it restyles every
// descendant, every frame (measured: ~67% of the main thread at idle on a throttled phone).
// The heat has to reach only the small layers that glow.
const GLOWS = ['.plaque-halo', '.plaque-glow', '.inlay-glow', '.skull']

let frames
beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  deathfireHeat.breathe = 0.6
  deathfireHeat.flare = 0
})
const runFrame = (now = 0) => frames.shift()(now)
const heatOf = (el) => el.style.getPropertyValue('--heat')

describe('ArchivePlaque heat', () => {
  it('never writes --heat on the wrapper around the thread', () => {
    const w = mount(ArchivePlaque, { slots: { default: '<p>thread</p>' } })
    deathfireHeat.breathe = 1
    deathfireHeat.flare = 1
    runFrame()
    expect(heatOf(w.find('.plaque-wrap').element)).toBe('')
    expect(heatOf(w.find('.plaque-inlay').element)).toBe('')
  })

  it('writes the same heat on each glow layer, and only those', () => {
    const w = mount(ArchivePlaque, { slots: { default: '<p>thread</p>' } })
    deathfireHeat.breathe = 0.6
    deathfireHeat.flare = 0.5 // 0.55 + 0.6 * 0.3 + 0.5 * 0.7
    runFrame()
    for (const sel of GLOWS) expect(heatOf(w.find(sel).element), sel).toBe('1.080')
    const written = [...w.element.querySelectorAll('*')].filter((el) => heatOf(el) !== '')
    expect(written).toHaveLength(GLOWS.length)
  })

  it('does not rewrite a heat that has not moved', () => {
    const w = mount(ArchivePlaque, { slots: { default: '<p>thread</p>' } })
    runFrame()
    const halo = w.find('.plaque-halo').element
    halo.style.setProperty('--heat', 'sentinel')
    runFrame()
    expect(heatOf(halo)).toBe('sentinel')
    deathfireHeat.flare = 1
    runFrame()
    expect(heatOf(halo)).toBe('1.430') // 0.55 + 0.6 * 0.3 + 0.7
  })

  it('moves the skull at most ten times a second, and the other glows on every change', () => {
    const w = mount(ArchivePlaque, { slots: { default: '<p>thread</p>' } })
    const halo = w.find('.plaque-halo').element
    const skull = w.find('.skull').element
    runFrame(0) // 0.55 + 0.6 * 0.3
    expect([heatOf(halo), heatOf(skull)]).toEqual(['0.730', '0.730'])
    deathfireHeat.flare = 1
    runFrame(50)
    expect([heatOf(halo), heatOf(skull)]).toEqual(['1.430', '0.730'])
    deathfireHeat.flare = 0.5
    runFrame(120)
    expect([heatOf(halo), heatOf(skull)]).toEqual(['1.080', '1.080'])
  })

  it('keeps the heat-driven look off paint-triggering properties of the big layers', () => {
    // jsdom's global URL rejects file: URLs, so derive the path from the test's own as a string.
    const src = readFileSync(fileURLToPath(import.meta.url).replace(/\.test\.js$/, '.vue'), 'utf8')
    const css = src.slice(src.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '')
    const driven = [...css.matchAll(/([a-z-]+)\s*:[^:;{}]*var\(--heat\)/g)].map((m) => m[1])
    expect(driven.length).toBeGreaterThan(0)
    // box-shadow on a thread-high box repaints a blur the size of the whole thread each frame.
    expect(driven).not.toContain('box-shadow')
    // The wrapper only declares geometry; each glow layer declares its own default heat.
    expect(css).not.toMatch(/\.plaque-wrap\s*\{[^}]*--heat/)
  })

  it('clips the halo across, so on a narrow page it cannot widen the page', () => {
    const src = readFileSync(fileURLToPath(import.meta.url).replace(/\.test\.js$/, '.vue'), 'utf8')
    // The halo overhangs the plaque by ~12px a side; a phone would shrink the page to fit and let it pan.
    expect(src).toMatch(/@media \(max-width: 64rem\) \{\s*\.plaque-wrap \{ overflow-x: clip; \}/)
  })
})
