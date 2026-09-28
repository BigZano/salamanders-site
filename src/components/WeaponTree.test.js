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

  it('frees budget held by a pick whose perk a correction removed, and restores it on revert', async () => {
    const tight = { budget: 2, perks: [...data.perks, { name: 'C', quality: 'Standard', description: 'c' }] }
    const planner = usePlanner()
    const s = usePerkCorrections()
    const w = mount(WeaponTree, { props: { weapon: 'Test', data: tight } })
    await w.findAll('.wnode')[0].trigger('click') // A
    await w.findAll('.wnode')[1].trigger('click') // B
    expect(w.find('.wtree-pts').text()).toBe('2 / 2 points')

    const original = s.doc
    s.doc = { version: 'v2', classes: {}, weapons: { Test: [{ id: 1, op: 'remove', quality: 'Standard', perkName: 'A', description: null, createdAt: 't' }] } }
    await w.vm.$nextTick()
    expect(w.find('.wtree-pts').text()).toBe('1 / 2 points')
    // The orphaned pick stays in storage so a revert can restore it.
    expect(planner.weaponPerks.Test).toHaveProperty('standard-a-0')

    const c = w.findAll('.wnode').find((n) => n.text() === 'C')
    await c.trigger('click')
    expect(planner.weaponPerks.Test).toHaveProperty('standard-c-2')
    expect(w.find('.wtree-pts').text()).toBe('2 / 2 points')

    s.doc = original
    await w.vm.$nextTick()
    const a = w.findAll('.wnode').find((n) => n.text() === 'A')
    expect(a.classes()).toContain('on')
  })

  it('live-updates the open detail panel when corrections change', async () => {
    const s = usePerkCorrections()
    const w = mount(WeaponTree, { props: { weapon: 'Test', data } })
    await w.findAll('.wnode')[1].trigger('mouseenter')
    expect(w.find('.wdetail-desc').text()).toBe('b')
    s.doc = { version: 'v2', classes: {}, weapons: { Test: [{ id: 1, op: 'edit', quality: 'Standard', perkName: 'B', description: 'fixed', createdAt: '2026-09-27T12:00:00.000Z' }] } }
    await w.vm.$nextTick()
    expect(w.find('.wdetail-desc').text()).toBe('fixed')
  })

  it('closes the detail panel when the inspected perk is removed', async () => {
    const s = usePerkCorrections()
    const w = mount(WeaponTree, { props: { weapon: 'Test', data } })
    await w.findAll('.wnode')[0].trigger('mouseenter')
    expect(w.find('.wdetail').exists()).toBe(true)
    s.doc = { version: 'v2', classes: {}, weapons: { Test: [{ id: 1, op: 'remove', quality: 'Standard', perkName: 'A', description: null, createdAt: 't' }] } }
    await w.vm.$nextTick()
    expect(w.find('.wdetail').exists()).toBe(false)
  })

  it('closes an open add panel when edit rights vanish', async () => {
    const s = usePerkCorrections()
    s.live = true
    s.privileges = { editor: true }
    const w = mount(WeaponTree, { props: { weapon: 'Test', data } })
    await w.get('button.wtier-add').trigger('click')
    expect(w.find('input.pe-name').exists()).toBe(true)
    s.privileges = { editor: false }
    await w.vm.$nextTick()
    expect(w.find('input.pe-name').exists()).toBe(false)
  })
})
