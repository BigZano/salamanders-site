// @vitest-environment jsdom
// "Edit page": the Watch Commander opens the texts of the page they are on, edits them and saves them to the area's
// data (cfg/tx), as on the old site. Invented texts only.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('../../lib/deathwatch/api', () => ({ getData: vi.fn(async () => null), writeDoc: vi.fn(async () => {}) }))
import { writeDoc } from '../../lib/deathwatch/api'
import { LORE_TEXTS } from '../../lib/deathwatch/loreTexts'
import { pageTexts } from '../../lib/deathwatch/pageTexts'
import { useAuth } from '../../stores/auth'
import { useDeathwatchData } from '../../stores/deathwatchData'
import PageEditor from './PageEditor.vue'

// jsdom has no modal <dialog>: stood in for, as in DeathwatchNavSheet.test.js.
beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
  HTMLDialogElement.prototype.showModal = vi.fn(function () {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function () {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  })
})

function mountEditor(fields, state = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useDeathwatchData().$patch({ status: 'ready', cfg: { tx: { lo_s: 'Our subtitle', nm_c: 'Brother Example' } }, ...state })
  return mount(PageEditor, { props: { fields }, global: { plugins: [pinia] }, attachTo: document.body })
}
const lore = pageTexts('hallofrelics', 'fortress-lore')
const area = (w, k) => w.get(`textarea[name="${k}"]`)

describe('PageEditor', () => {
  it('opens the texts of the page, each under its label, as the page shows them', async () => {
    const w = mountEditor(lore)
    expect(w.get('dialog').attributes('open')).toBeUndefined()
    await w.get('.pe-open').trigger('click')
    expect(w.get('dialog').attributes('open')).toBe('')
    expect(w.findAll('textarea').map((t) => t.attributes('name'))).toEqual(lore.map(([k]) => k))
    expect(w.findAll('.pe-f > span').map((s) => s.text())[0]).toBe('Subtitle')
    expect(area(w, 'lo_s').element.value).toBe('Our subtitle')
    expect(area(w, 'lo1').element.value).toBe(LORE_TEXTS.lo1)
    expect(document.activeElement).toBe(area(w, 'lo_s').element)
  })

  it('saves the edits to the area’s page texts and closes', async () => {
    const w = mountEditor(lore)
    await w.get('.pe-open').trigger('click')
    await area(w, 'lo_s').setValue('A new subtitle')
    await area(w, 'lo2').setValue('')
    await w.get('form').trigger('submit')
    await flushPromises()
    const doc = { lo_s: 'A new subtitle', lo2: '', nm_c: 'Brother Example' }
    expect(writeDoc).toHaveBeenCalledWith(useAuth().token, 'cfg', 'tx', doc)
    expect(useDeathwatchData().cfg.tx).toEqual(doc)
    expect(w.get('dialog').attributes('open')).toBeUndefined()
  })

  it('brings a text back to its default, and offers that only where it differs', async () => {
    const w = mountEditor(lore)
    await w.get('.pe-open').trigger('click')
    expect(w.findAll('.pe-reset').map((b) => b.attributes('aria-label'))).toEqual(['Restore the default: Subtitle'])
    await w.get('.pe-reset').trigger('click')
    expect(area(w, 'lo_s').element.value).toBe(LORE_TEXTS.lo_s)
    expect(w.findAll('.pe-reset')).toHaveLength(0)
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(useDeathwatchData().cfg.tx).toEqual({ nm_c: 'Brother Example' })
  })

  it('has no default to offer for a text without one', async () => {
    const w = mountEditor(pageTexts('hallofrelics', 'notable-members'))
    await w.get('.pe-open').trigger('click')
    expect(area(w, 'nm_c').element.value).toBe('Brother Example')
    expect(w.findAll('.pe-reset')).toHaveLength(0)
  })

  it('closes without saving on Cancel, and opens again on what is stored', async () => {
    const w = mountEditor(lore)
    await w.get('.pe-open').trigger('click')
    await area(w, 'lo_s').setValue('Not kept')
    await w.get('.pe-cancel').trigger('click')
    expect(w.get('dialog').attributes('open')).toBeUndefined()
    expect(writeDoc).not.toHaveBeenCalled()
    await w.get('.pe-open').trigger('click')
    expect(area(w, 'lo_s').element.value).toBe('Our subtitle')
  })

  it('stays open and says why when the server refuses, and saves once at a time', async () => {
    let fail
    writeDoc.mockImplementationOnce(() => new Promise((_, rej) => (fail = rej)))
    const w = mountEditor(lore)
    await w.get('.pe-open').trigger('click')
    await w.get('form').trigger('submit')
    expect(w.get('.pe-save').attributes('disabled')).toBeDefined()
    await w.get('form').trigger('submit')
    expect(writeDoc).toHaveBeenCalledTimes(1)
    fail(new Error('Only the Watch Commander can do that.'))
    await flushPromises()
    expect(w.get('[role="alert"]').text()).toBe('Not saved: Only the Watch Commander can do that.')
    expect(w.get('dialog').attributes('open')).toBe('')
    expect(w.get('.pe-save').attributes('disabled')).toBeUndefined()
    await w.get('.pe-cancel').trigger('click')
    await w.get('.pe-open').trigger('click')
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it('says only that it was not saved when the error has no message', async () => {
    writeDoc.mockRejectedValueOnce({})
    const w = mountEditor(lore)
    await w.get('.pe-open').trigger('click')
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(w.get('[role="alert"]').text()).toBe('Not saved.')
  })

  it('shows no button until the texts are loaded', () => {
    expect(mountEditor(lore, { status: 'loading' }).find('.pe-open').exists()).toBe(false)
  })
})
