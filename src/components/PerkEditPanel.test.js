// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PerkEditPanel from './PerkEditPanel.vue'
import { usePerkCorrections } from '../stores/perkCorrections'

// The real auth store reads a Discord token from storage; the panel only needs one.
vi.mock('../stores/auth', () => ({ useAuth: () => ({ token: 'tok' }) }))

beforeEach(() => setActivePinia(createPinia()))

describe('PerkEditPanel', () => {
  it('edit text submits an edit with the note', async () => {
    const s = usePerkCorrections()
    s.submit = vi.fn().mockResolvedValue()
    const w = mount(PerkEditPanel, { props: { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', perk: { name: 'Head Hunter', description: 'old' } } })
    await w.get('button.pe-edit').trigger('click')
    await w.get('textarea').setValue('Headshots deal 10% more Damage')
    await w.get('input.pe-note').setValue('patch 14.1')
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(s.submit).toHaveBeenCalledWith(
      { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'edit', perkName: 'Head Hunter', description: 'Headshots deal 10% more Damage', note: 'patch 14.1' },
      'tok',
    )
    expect(w.emitted('done')).toHaveLength(1)
  })

  it('remove needs a confirm click, then submits a remove', async () => {
    const s = usePerkCorrections()
    s.submit = vi.fn().mockResolvedValue()
    const w = mount(PerkEditPanel, { props: { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', perk: { name: 'Head Hunter', description: 'x' } } })
    await w.get('button.pe-remove').trigger('click')
    expect(s.submit).not.toHaveBeenCalled()
    await w.get('button.pe-confirm').trigger('click')
    await flushPromises()
    expect(s.submit.mock.calls[0][0]).toMatchObject({ op: 'remove', perkName: 'Head Hunter' })
  })

  it('add mode prefills the text of a known perk name', async () => {
    const w = mount(PerkEditPanel, {
      props: { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', perk: null, suggestions: [{ name: 'Divine Might', description: 'Damage increases by 10%' }] },
    })
    await w.get('input.pe-name').setValue('Divine Might')
    expect(w.get('textarea').element.value).toBe('Damage increases by 10%')
  })

  it('class perks offer edit only', () => {
    const w = mount(PerkEditPanel, { props: { kind: 'class', target: 'Tactical', quality: null, perk: { name: 'Stim', description: 's' } } })
    expect(w.find('button.pe-remove').exists()).toBe(false)
    expect(w.find('button.pe-edit').exists()).toBe(true)
  })

  it('shows the server error and stays open when a save is refused', async () => {
    const s = usePerkCorrections()
    s.submit = vi.fn().mockRejectedValue(new Error('Your site privileges have been revoked.'))
    const w = mount(PerkEditPanel, { props: { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', perk: { name: 'Head Hunter', description: 'x' } } })
    await w.get('button.pe-edit').trigger('click')
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(w.get('.pe-error').text()).toContain('revoked')
    expect(w.emitted('done')).toBeUndefined()
  })

  const weaponProps = (perk) => ({ kind: 'weapon', target: 'Las Fusil', quality: 'Relic', perk })

  it('keeps the draft when the host re-passes an equal perk object', async () => {
    const w = mount(PerkEditPanel, { props: weaponProps({ name: 'Head Hunter', description: 'old' }) })
    await w.get('button.pe-edit').trigger('click')
    await w.get('textarea').setValue('typed draft')
    await w.get('input.pe-note').setValue('my note')
    await w.setProps({ perk: { name: 'Head Hunter', description: 'old' } })
    expect(w.find('form').exists()).toBe(true)
    expect(w.get('textarea').element.value).toBe('typed draft')
    expect(w.get('input.pe-note').element.value).toBe('my note')
  })

  it('resets when a genuinely different perk arrives', async () => {
    const w = mount(PerkEditPanel, { props: weaponProps({ name: 'Head Hunter', description: 'old' }) })
    await w.get('button.pe-edit').trigger('click')
    await w.get('textarea').setValue('typed draft')
    await w.setProps({ perk: { name: 'Divine Might', description: 'dm' } })
    expect(w.find('form').exists()).toBe(false)
    expect(w.find('button.pe-edit').exists()).toBe(true)
    await w.get('button.pe-edit').trigger('click')
    expect(w.get('textarea').element.value).toBe('dm')
  })

  it('gives each panel its own label/field ids', async () => {
    const Host = {
      components: { PerkEditPanel },
      template: `<div>
        <PerkEditPanel kind="weapon" target="Las Fusil" quality="Relic" :perk="null" />
        <PerkEditPanel kind="weapon" target="Las Fusil" quality="Heroic" :perk="null" />
      </div>`,
    }
    const w = mount(Host)
    const panels = w.findAll('.pe')
    const ids = panels.map((p) => {
      const labels = p.findAll('label')
      const nameInput = p.get('input.pe-name')
      const textarea = p.get('textarea')
      expect(labels[0].attributes('for')).toBe(nameInput.attributes('id'))
      expect(labels[1].attributes('for')).toBe(textarea.attributes('id'))
      expect(nameInput.attributes('list')).toBe(p.get('datalist').attributes('id'))
      return [nameInput.attributes('id'), textarea.attributes('id'), p.get('datalist').attributes('id')]
    })
    const all = ids.flat()
    expect(new Set(all).size).toBe(all.length)
  })

  it('disables Save when the text is empty', async () => {
    const w = mount(PerkEditPanel, { props: weaponProps(null) })
    await w.get('input.pe-name').setValue('New Perk')
    await w.get('textarea').setValue('   ')
    expect(w.get('button[type=submit]').element.disabled).toBe(true)
    await w.get('textarea').setValue('does a thing')
    expect(w.get('button[type=submit]').element.disabled).toBe(false)
  })

  it('disables Save in edit mode until the text changes', async () => {
    const w = mount(PerkEditPanel, { props: weaponProps({ name: 'Head Hunter', description: 'old' }) })
    await w.get('button.pe-edit').trigger('click')
    expect(w.get('button[type=submit]').element.disabled).toBe(true)
    await w.get('textarea').setValue('  old  ')
    expect(w.get('button[type=submit]').element.disabled).toBe(true)
    await w.get('textarea').setValue('new text')
    expect(w.get('button[type=submit]').element.disabled).toBe(false)
  })

  it('Cancel after a failed save clears the error and emits idle state', async () => {
    const s = usePerkCorrections()
    s.submit = vi.fn().mockRejectedValue(new Error('Your site privileges have been revoked.'))
    const w = mount(PerkEditPanel, { props: weaponProps({ name: 'Head Hunter', description: 'x' }) })
    await w.get('button.pe-edit').trigger('click')
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(w.get('.pe-error').text()).toContain('revoked')
    expect(w.emitted('state')).toContainEqual(['active'])
    await w.findAll('button')[w.findAll('button').length - 1].trigger('click') // last Cancel button
    expect(w.find('.pe-error').exists()).toBe(false)
    expect(w.emitted('state')).toContainEqual(['idle'])
  })
})
