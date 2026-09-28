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
})
