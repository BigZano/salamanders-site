// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WeaponSlot from './WeaponSlot.vue'
import WeaponTree from './WeaponTree.vue'
import { usePlanner } from '../stores/planner'

let planner
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  planner = usePlanner()
})

const slot = () => mount(WeaponSlot, { props: { slot: 'melee', label: 'Melee' }, global: { stubs: { WeaponTree: true } } })

describe('WeaponSlot', () => {
  it('says the perk tree is not published yet for a weapon without one', async () => {
    planner.setClass('Tactical')
    planner.setWeapon('melee', 'One-Handed Thunder Hammer')
    const w = slot()
    await w.find('.slot-toggle').trigger('click')
    await flushPromises()
    expect(w.find('.slot-pending').text()).toContain('not published yet')
    expect(w.findComponent(WeaponTree).exists()).toBe(false)
  })

  it('still opens the tree for a weapon that has one', async () => {
    planner.setClass('Tactical')
    planner.setWeapon('melee', 'Chainsword')
    const w = slot()
    await w.find('.slot-toggle').trigger('click')
    await flushPromises()
    expect(w.find('.slot-pending').exists()).toBe(false)
    expect(w.findComponent(WeaponTree).exists()).toBe(true)
  })

  it('offers the Thunder Hammer under its two-handed name, keeping the key as the value', () => {
    planner.setClass('Assault')
    const option = slot().findAll('option').find((o) => o.element.value === 'Thunder Hammer')
    expect(option.text()).toBe('Two-Handed Thunder Hammer')
  })

  it('offers the One-Handed Thunder Hammer to Tactical, which has no two-handed one', () => {
    planner.setClass('Tactical')
    const values = slot().findAll('option').map((o) => o.element.value)
    expect(values).toContain('One-Handed Thunder Hammer')
    expect(values).not.toContain('Thunder Hammer')
  })
})
