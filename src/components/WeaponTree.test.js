// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import WeaponTree from './WeaponTree.vue'
import { usePerkCorrections } from '../stores/perkCorrections'
import { usePlanner } from '../stores/planner'

const data = {
  budget: 5,
  perks: [
    { name: 'A', quality: 'Standard', description: 'a' },
    { name: 'B', quality: 'Standard', description: 'b' },
  ],
}

beforeEach(() => setActivePinia(createPinia()))

describe('WeaponTree with corrections', () => {
  it('keeps bake ids stable when an earlier perk is removed', async () => {
    const s = usePerkCorrections()
    s.doc = { version: 'v', classes: {}, weapons: { Test: [{ id: 1, op: 'remove', quality: 'Standard', perkName: 'A', description: null, createdAt: 't' }] } }
    const w = mount(WeaponTree, { props: { weapon: 'Test', data } })
    const nodes = w.findAll('.wnode')
    expect(nodes.map((n) => n.text())).toEqual(['B'])
    await nodes[0].trigger('click')
    // B was index 1 in the bake: its id must still end in -1.
    expect(Object.keys(usePlanner().weaponPerks.Test)).toEqual(['standard-b-1'])
  })

  it('tags corrected perks in the detail panel', async () => {
    const s = usePerkCorrections()
    s.doc = { version: 'v', classes: {}, weapons: { Test: [{ id: 1, op: 'edit', quality: 'Standard', perkName: 'B', description: 'fixed', createdAt: '2026-09-27T12:00:00.000Z' }] } }
    const w = mount(WeaponTree, { props: { weapon: 'Test', data } })
    await w.findAll('.wnode')[1].trigger('mouseenter')
    expect(w.find('.wdetail-desc').text()).toBe('fixed')
    expect(w.find('.corrected-tag').text()).toContain('Corrected in game')
  })
})
