// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import Armoury from './Armoury.vue'
import trees from '../data/weapon-trees.json'

const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)', component: { render: () => null } }] })

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

async function open(tab, weaponText) {
  const wrapper = mount(Armoury, { global: { plugins: [router], stubs: { WeaponTree: true } } })
  await router.isReady()
  if (tab) await wrapper.findAll('.cat-tab').find((b) => b.text().startsWith(tab)).trigger('click')
  if (weaponText) {
    await wrapper.findAll('.w-item').find((b) => b.text().includes(weaponText)).trigger('click')
    await flushPromises()
  }
  return wrapper
}

const versionIndex = (weapon, name) => trees.weapons[weapon].versions.findIndex((v) => v.name === name)

describe('Armoury melee list', () => {
  it('lists both Thunder Hammers by their in-game names', async () => {
    const w = await open('Melee')
    const names = w.findAll('.w-item').map((b) => b.text())
    expect(names.some((t) => t.includes('Two-Handed Thunder Hammer'))).toBe(true)
    expect(names.some((t) => t.includes('One-Handed Thunder Hammer'))).toBe(true)
  })

  it('finds a weapon by either its key or its label', async () => {
    const w = await open('Melee')
    await w.find('.w-search').setValue('two-handed')
    expect(w.findAll('.w-item')).toHaveLength(1)
    await w.find('.w-search').setValue('thunder hammer')
    expect(w.findAll('.w-item')).toHaveLength(2)
  })
})

describe('Armoury defence badge', () => {
  it('shows the defence type of the selected version and follows the version picker', async () => {
    const w = await open('Melee', 'Two-Handed Thunder Hammer')
    expect(w.find('.defence').text()).toBe('Balanced')
    expect(w.find('.defence').attributes('data-defence')).toBe('Balanced')
    await w.find('.stats-version select').setValue(versionIndex('Thunder Hammer', 'Master-Crafted - Gamma'))
    expect(w.find('.defence').text()).toBe('Block')
    await w.find('.stats-version select').setValue(versionIndex('Thunder Hammer', 'Master-Crafted - Beta'))
    expect(w.find('.defence').text()).toBe('Fencing')
  })

  it('writes the defence type into each version option', async () => {
    const w = await open('Melee', 'Two-Handed Thunder Hammer')
    const options = w.findAll('.stats-version option').map((o) => o.text())
    expect(options).toContain('Master-Crafted - Beta — Master-Crafted · Fencing')
  })

  it('shows no defence badge for a ranged weapon', async () => {
    const w = await open('Primary', 'Bolt Rifle')
    expect(w.find('.stats').exists()).toBe(true)
    expect(w.find('.defence').exists()).toBe(false)
  })

  it('shows no badge or stray dot for a version with no defence type', async () => {
    const original = trees.weapons.Chainsword.versions[0].defence
    expect(original).toBeTruthy()
    delete trees.weapons.Chainsword.versions[0].defence
    try {
      const w = await open('Melee', 'Chainsword')
      expect(w.find('.defence').exists()).toBe(false)
      expect(w.findAll('.stats-version option')[0].text()).not.toContain('·')
    } finally {
      trees.weapons.Chainsword.versions[0].defence = original
    }
  })
})

// The One-Handed Thunder Hammer is borrowed as the weapon whose perks the wiki has not published.
async function withPendingHammer(fn) {
  const t = trees.weapons['One-Handed Thunder Hammer']
  const saved = { perks: t.perks, perksPending: t.perksPending }
  t.perks = []
  t.perksPending = true
  try {
    return await fn()
  } finally {
    t.perks = saved.perks
    if (saved.perksPending === undefined) delete t.perksPending
    else t.perksPending = saved.perksPending
  }
}

describe('Armoury weapon with no perk tree', () => {
  it('shows stats and a pending message instead of an empty tree', async () => {
    await withPendingHammer(async () => {
      const w = await open('Melee', 'One-Handed Thunder Hammer')
      expect(w.find('.stats').exists()).toBe(true)
      expect(w.find('.w-pending').text()).toContain('not published yet')
      expect(w.findComponent({ name: 'WeaponTree' }).exists()).toBe(false)
      expect(w.find('.defence').text()).toBe('Balanced')
    })
  })

  it('shows the One-Handed Thunder Hammer tree now that its perks are baked', async () => {
    const w = await open('Melee', 'One-Handed Thunder Hammer')
    expect(w.find('.w-pending').exists()).toBe(false)
    expect(w.findComponent({ name: 'WeaponTree' }).exists()).toBe(true)
  })

  it('still shows the tree for a weapon that has one', async () => {
    const w = await open('Melee', 'Chainsword')
    expect(w.find('.w-pending').exists()).toBe(false)
    expect(w.findComponent({ name: 'WeaponTree' }).exists()).toBe(true)
  })
})

describe('Armoury on a phone', () => {
  // jsdom replaces the global URL class, which fs rejects, so go through a plain path string.
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Armoury.vue'), 'utf8')
  // Unit tests do not process component CSS, so these read the stylesheet directly.
  const body = (selector) => new RegExp(`\\n${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(source)?.[1] ?? ''

  it('lets the detail column shrink below its widest child', () => {
    // Grid items default to min-width: auto and 1fr means minmax(auto, 1fr), so the perk tree's
    // max-content grid held the column at about 1000px and the whole page scrolled sideways.
    expect(body('.a-layout')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(body('.w-detail')).toMatch(/min-width:\s*0\b/)
    expect(source).toMatch(/grid-template-columns:\s*15rem minmax\(0,\s*1fr\)/)
  })

  it('lets the version picker shrink to the stat block instead of poking out of it', () => {
    // Its longest option ("Master-Crafted with Grenade Launcher — Master-Crafted") pinned the
    // select at 16rem, 49px wider than the stat block on a 390px screen.
    expect(body('.stats-version')).toMatch(/min-width:\s*0\b/)
    expect(body('.stats-version select')).toMatch(/min-width:\s*0\b/)
  })

  describe('revealing the detail', () => {
    let scrolled
    function viewport({ wide = false, calm = false } = {}) {
      vi.stubGlobal('matchMedia', (query) => ({
        matches: query.includes('min-width') ? wide : calm,
      }))
    }
    beforeEach(() => {
      scrolled = []
      Element.prototype.scrollIntoView = function (options) {
        scrolled.push({ el: this, options })
      }
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      delete Element.prototype.scrollIntoView
    })

    it('scrolls the detail into view when a weapon is picked in the stacked layout', async () => {
      viewport()
      await open('Melee', 'Chainsword')
      expect(scrolled).toHaveLength(1)
      expect(scrolled[0].el.classList.contains('w-detail')).toBe(true)
      expect(scrolled[0].options).toEqual({ behavior: 'smooth', block: 'start' })
    })

    it('does not animate the scroll for people who asked for less motion', async () => {
      viewport({ calm: true })
      await open('Melee', 'Chainsword')
      expect(scrolled[0].options.behavior).toBe('auto')
    })

    it('leaves the page where it is when the list and detail sit side by side', async () => {
      viewport({ wide: true })
      await open('Melee', 'Chainsword')
      expect(scrolled).toHaveLength(0)
    })
  })
})
