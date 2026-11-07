// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import FireTuner from '../components/FireTuner.vue'
import { DEFAULTS, fireTuning, profileFor, profileKeyFor, resetTuning, routeProfiles } from './fireTuning'

describe('the Deathwatch volcano profile', () => {
  const deathwatch = () => routeProfiles['/deathwatch/*']

  it('is one profile for the hub and every page under it', () => {
    expect(deathwatch()).toBeDefined()
    for (const path of ['/deathwatch', '/deathwatch/eventtracker/standings', '/deathwatch/manage/enter-mission']) {
      expect(profileFor(path), path).toBe(deathwatch())
    }
  })

  it('is a quieter mountain than the landing page, so a page of tables keeps its contrast', () => {
    expect(deathwatch().density).toBeLessThan(1)
    expect(deathwatch().scale).toBeLessThan(1)
  })

  it('covers the /deathwatch section only, not a path that merely starts with the same letters', () => {
    for (const path of ['/deathwatchful', '/deathwatch-x/y', '/x/deathwatch']) {
      expect(profileFor(path), path).toBe(routeProfiles['*'])
    }
  })

  it('leaves every other page as it was', () => {
    expect(routeProfiles['/']).toEqual({ bearing: 0, scale: 1, variance: 1, density: 1 }) // the landing page, exactly: do not tidy
    expect(profileFor('/')).toBe(routeProfiles['/'])
    expect(profileFor('/companies')).toBe(routeProfiles['/companies'])
    expect(profileFor('/roster')).toBe(routeProfiles['/roster'])
    expect(profileFor('/nowhere')).toBe(routeProfiles['*'])
  })

  it('answers something that is not a path with the catch-all', () => {
    for (const path of [undefined, null, '', 5, {}]) expect(profileFor(path), String(path)).toBe(routeProfiles['*'])
  })

  it('never takes a property of Object for a profile', () => {
    for (const path of ['__proto__', '/__proto__', 'constructor', '/constructor/x', '/toString']) {
      expect(profileFor(path), path).toBe(routeProfiles['*'])
    }
  })
})

describe('profileKeyFor', () => {
  it('names the entry that governs a path: its own, else its section, else the catch-all', () => {
    expect(profileKeyFor('/roster')).toBe('/roster')
    expect(profileKeyFor('/deathwatch')).toBe('/deathwatch/*')
    expect(profileKeyFor('/deathwatch/eventtracker/standings')).toBe('/deathwatch/*')
    expect(profileKeyFor('/nowhere')).toBe('*')
    expect(profileKeyFor(undefined)).toBe('*')
  })
})

describe('volcano route profiles', () => {
  it('/roster has its own profile instead of the unrouted fallback', () => {
    expect(routeProfiles['/roster']).toBeDefined()
    expect(profileFor('/roster')).not.toBe(routeProfiles['*'])
  })

  it('/roster is a calm, low horizon: a long reading page of panels must not sit under a glaring peak', () => {
    const { density, scale } = profileFor('/roster')
    expect(density).toBeLessThanOrEqual(0.6)
    expect(scale).toBeLessThanOrEqual(0.6)
  })
})

// FireTuner reads the current route for its "This page" section; none is needed here.
vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/' }) }))

describe('the lava tunables', () => {
  // each test edits the live values; reset in afterEach so a failed assertion cannot leak into the next test
  afterEach(() => resetTuning())

  it('carries the lava tunables and resets them', () => {
    expect(DEFAULTS.lava).toEqual({ crust: 0.75, heat: 1, viscosity: 0.7, cracks: 0.8, foldScale: 1, breakoutRate: 1 })
    fireTuning.lava.crust = 0.1
    resetTuning()
    expect(fireTuning.lava.crust).toBe(0.75)
  })

  it('keeps every key the shader reads, since a missing one packs as NaN', () => {
    for (const key of Object.keys(DEFAULTS.lava)) fireTuning.lava[key] = 0.5
    resetTuning()
    expect(fireTuning.lava).toEqual(DEFAULTS.lava)
  })

  it('does not share its defaults with the live values, so a drag cannot rewrite DEFAULTS', () => {
    fireTuning.lava.heat = 1.7
    expect(DEFAULTS.lava.heat).toBe(1)
  })

  it('shows in the tuner as a Lava section with a slider each, and in the Copy values text', () => {
    const tuner = mount(FireTuner)
    const lava = [...tuner.findAll('.tuner-group')].find((h) => h.text() === 'Lava')
    expect(lava).toBeDefined()
    expect(lava.element.parentElement.querySelectorAll('input[type=range]')).toHaveLength(Object.keys(DEFAULTS.lava).length)
    fireTuning.lava.crust = 0.3
    expect(tuner.vm.snippet).toContain('lava: {')
    expect(tuner.vm.snippet).toContain('"crust": 0.3')
    tuner.unmount()
  })
})
