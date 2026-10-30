// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { getData } from '../../lib/deathwatch/api'
import { useDeathwatchData } from '../../stores/deathwatchData'
import NotableMembers from './NotableMembers.vue'

vi.mock('../../lib/deathwatch/api', () => ({ getData: vi.fn(async () => null), writeDoc: vi.fn() }))

function mountWith(state) {
  const pinia = createPinia()
  setActivePinia(pinia)
  if (state) useDeathwatchData().$patch(state)
  return mount(NotableMembers, { global: { plugins: [pinia] } })
}

beforeEach(() => vi.clearAllMocks())

describe('NotableMembers', () => {
  // Invented names only: the real ones live in the server's data.
  it('shows the Watch Commander, the Chronicles, the veterans and the cries, a sealed veteran without the record', async () => {
    const w = mountWith({
      status: 'ready',
      cfg: {
        tx: {
          nm_i: '*Their names are remembered.*',
          nm_ck: '', // blank: the default line above the name
          nm_c: 'Brother Varn\nHolds the **Long Vigil**.',
          nm_h: '## Watch Commanders\n- **Brother Varn:** ||*lost*|| — *present*',
          nm_v: 'Sergeant Ilo — The Steady Hand\nLed from the front.\n\nBrother Quell [sealed]\nNot for the page.',
          nm_e: '**SUFFER NOT THE ALIEN TO LIVE!**',
        },
      },
    })
    const nm = w.get('section.nm')
    expect(nm.get('h2').text()).toBe('Notable Members of Ebonhold')
    expect(nm.get('.nm-intro').text()).toBe('Their names are remembered.')
    expect(nm.findAll('h3').map((h) => h.text())).toEqual(['Brother Varn', 'Chronicles of Command', 'Honored Veterans of the Long Vigil'])
    expect(nm.get('.nm-cmd .nm-k').text()).toBe('Watch Commander')
    expect(nm.get('.nm-cmd img').attributes('src')).toContain('crest-gold')
    expect(nm.get('.nm-body b').text()).toBe('Long Vigil')
    expect(nm.get('.nm-lh').text()).toBe('Watch Commanders')
    // A spoiler: a focusable toggle button, said to be one to a screen reader, opened or closed by a tap, Enter or
    // Space (a phone has no hover), and saying whether it is open.
    const spoiler = nm.get('.nm-l .nm-spl')
    expect(spoiler.text()).toBe('Spoiler: lost')
    expect(spoiler.get('.dw-sr-only').text()).toBe('Spoiler:')
    expect(spoiler.attributes()).toMatchObject({ tabindex: '0', role: 'button', 'aria-expanded': 'false' })
    await spoiler.trigger('click')
    expect(spoiler.classes()).toContain('open')
    expect(spoiler.attributes('aria-expanded')).toBe('true')
    await spoiler.trigger('click')
    expect(spoiler.classes()).not.toContain('open')
    await spoiler.trigger('keydown', { key: 'Enter' })
    expect(spoiler.attributes('aria-expanded')).toBe('true')
    await spoiler.trigger('keydown', { key: ' ' })
    expect(spoiler.attributes('aria-expanded')).toBe('false')
    await spoiler.trigger('keydown', { key: 'a' })
    expect(spoiler.attributes('aria-expanded')).toBe('false')
    expect(nm.findAll('.nm-v h4').map((h) => h.text())).toEqual(['Sergeant Ilo', 'Brother Quell'])
    expect(nm.findAll('.nm-b').map((b) => b.text())).toEqual(['Honored Veteran', 'Honored Veteran'])
    expect(nm.get('.nm-v:not(.sealed) .nm-vt').text()).toBe('Led from the front.')
    expect(nm.get('.sealed .nm-stamp').text()).toBe('Records sealed')
    expect(nm.text()).not.toContain('Not for the page.')
    expect(nm.get('.nm-cry').text()).toBe('SUFFER NOT THE ALIEN TO LIVE!')
    // Marks become elements, never markup: nothing in the page is raw text marks from the texts.
    expect(nm.text()).not.toMatch(/\*|\|\|/)
  })

  // Members' names never ship in the site's code: with no texts on the server, there is nobody to show.
  it('shows nobody unless the data names somebody', () => {
    for (const tx of [undefined, { cur_n: 'Tour' }, { nm_c: '', nm_h: '', nm_v: '' }]) {
      const w = mountWith({ status: 'ready', cfg: { tx } })
      expect(w.find('section.nm').exists(), JSON.stringify(tx)).toBe(false)
      expect(w.text()).toBe('No notable members are recorded yet.')
    }
  })

  it('shows loading until the data is there, and an error if it could not be loaded', () => {
    expect(mountWith({ status: 'loading' }).get('[role="status"]').text()).toBe('Loading…')
    expect(mountWith({ status: 'error' }).get('[role="alert"]').text()).toMatch(/^The records could not be loaded\.\s*Try again$/)
  })

  it('loads the records again from the button after an error', async () => {
    getData.mockRejectedValueOnce(new Error('down'))
    const w = mountWith({ status: 'error' })
    await flushPromises()
    vi.clearAllMocks()
    await w.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(getData).toHaveBeenCalledTimes(1)
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it('loads the data once when it is not there yet, and not again when it is', async () => {
    mountWith()
    await flushPromises()
    expect(getData).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()
    mountWith({ status: 'ready' })
    await flushPromises()
    expect(getData).not.toHaveBeenCalled()
  })
})
