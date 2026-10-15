// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
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
