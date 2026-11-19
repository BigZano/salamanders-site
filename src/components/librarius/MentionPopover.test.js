// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import MentionPopover from './MentionPopover.vue'

// Invented ids only (the 200000000000000400 range), and invented names.
const IXEN = '200000000000000411'
const SEFA = '200000000000000412'
const ORRIN = '200000000000000413'
const FOUND = [
  { id: IXEN, name: 'Ixen Calloway', avatar: null },
  { id: SEFA, name: 'Sefa Orrin', avatar: null },
  { id: ORRIN, name: 'Orrin Vale', avatar: null },
]

let mounted = []
afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
}
function mountPopover(search) {
  const w = mount(MentionPopover, { props: { search }, attachTo: document.body })
  mounted.push(w)
  return w
}
const box = (w) => w.get('input')
const options = (w) => w.findAll('[role="option"]')
const status = (w) => w.get('[role="status"]').text()
// Types into the box one letter at a time, `gap` ms apart.
async function typeSlowly(w, text, gap) {
  for (let i = 1; i <= text.length; i++) {
    await box(w).setValue(text.slice(0, i))
    await vi.advanceTimersByTimeAsync(gap)
  }
}

describe('MentionPopover', () => {
  it('is a dialog with a combobox in focus, of 32 characters at most, as the server reads a search', () => {
    const w = mountPopover(async () => [])
    expect(w.get('[role="dialog"]').attributes('aria-label')).toBe('Mention someone')
    const input = box(w)
    expect(input.attributes('role')).toBe('combobox')
    expect(input.attributes('aria-label')).toBe('Find a member to mention')
    expect(input.attributes('aria-autocomplete')).toBe('list')
    expect(input.attributes('maxlength')).toBe('32')
    expect(document.activeElement).toBe(input.element)
    expect(status(w)).toBe('Type two or more letters of their name.')
  })

  it('searches 250 ms after the last letter, once, with the query trimmed, and not for one letter', async () => {
    vi.useFakeTimers()
    const asked = []
    const w = mountPopover(async (q) => {
      asked.push(q)
      return FOUND
    })
    await typeSlowly(w, 'I', 1000)
    expect(asked).toEqual([])
    await typeSlowly(w, ' Ixen ', 100)
    expect(asked).toEqual([])
    expect(status(w)).toBe('Searching…')
    await vi.advanceTimersByTimeAsync(149)
    expect(asked).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(asked).toEqual(['Ixen'])
    await settle()
    expect(options(w).map((o) => o.text())).toEqual(['Ixen Calloway', 'Sefa Orrin', 'Orrin Vale'])
  })

  it('moves along the members with the arrows, round from end to end, and picks the one selected on Enter', async () => {
    vi.useFakeTimers()
    const w = mountPopover(async () => FOUND)
    await box(w).setValue('Or')
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    const selected = () => options(w).map((o) => o.attributes('aria-selected'))
    const active = () => box(w).attributes('aria-activedescendant')
    expect(status(w)).toBe('3 found.')
    expect(box(w).attributes('aria-expanded')).toBe('true')
    expect(box(w).attributes('aria-controls')).toBe(w.get('[role="listbox"]').attributes('id'))
    expect(selected()).toEqual(['true', 'false', 'false'])
    expect(active()).toBe(options(w)[0].attributes('id'))
    await box(w).trigger('keydown', { key: 'ArrowDown' })
    expect(selected()).toEqual(['false', 'true', 'false'])
    expect(active()).toBe(options(w)[1].attributes('id'))
    await box(w).trigger('keydown', { key: 'ArrowDown' })
    await box(w).trigger('keydown', { key: 'ArrowDown' })
    expect(selected()).toEqual(['true', 'false', 'false'])
    await box(w).trigger('keydown', { key: 'ArrowUp' })
    expect(selected()).toEqual(['false', 'false', 'true'])
    await box(w).trigger('keydown', { key: 'ArrowUp' })
    expect(selected()).toEqual(['false', 'true', 'false'])
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    box(w).element.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    expect(w.emitted('pick')).toEqual([[{ id: SEFA, name: 'Sefa Orrin' }]])
    expect(new Set(options(w).map((o) => o.attributes('id'))).size).toBe(3)
  })

  it('picks a member by a click too, and Enter with nobody found does nothing', async () => {
    vi.useFakeTimers()
    let found = FOUND
    const w = mountPopover(async () => found)
    await box(w).setValue('Or')
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    await options(w)[2].trigger('click')
    expect(w.emitted('pick')).toEqual([[{ id: ORRIN, name: 'Orrin Vale' }]])
    found = []
    await box(w).setValue('Zz')
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    expect(status(w)).toBe('Nobody found by that name.')
    expect(box(w).attributes('aria-expanded')).toBe('false')
    expect(box(w).attributes('aria-activedescendant')).toBeUndefined()
    await box(w).trigger('keydown', { key: 'Enter' })
    await box(w).trigger('keydown', { key: 'ArrowDown' })
    expect(w.emitted('pick')).toHaveLength(1)
  })

  it('goes back to the first member when the list changes', async () => {
    vi.useFakeTimers()
    const w = mountPopover(async (q) => (q === 'Or' ? FOUND : FOUND.slice(1)))
    await box(w).setValue('Or')
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    await box(w).trigger('keydown', { key: 'ArrowUp' })
    expect(options(w)[2].attributes('aria-selected')).toBe('true')
    await box(w).setValue('Orr')
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    expect(options(w).map((o) => o.attributes('aria-selected'))).toEqual(['true', 'false'])
  })

  it('leaves out anyone the server gave who could not be mentioned: no id, or no name', async () => {
    vi.useFakeTimers()
    const w = mountPopover(async () => [
      null, 'Ixen', 7, {}, { id: IXEN }, { name: 'Ixen' }, { id: Number(IXEN), name: 'Ixen' }, { id: '123', name: 'Short' }, { id: `${IXEN}9999`, name: 'Long' },
      { id: IXEN, name: '' }, { id: IXEN, name: '   ' }, { id: IXEN, name: ['Ixen'] }, { id: ` ${IXEN}`, name: 'Spaced' },
      { id: SEFA, name: '<b>Sefa</b>', avatar: 'javascript:alert(1)' },
    ])
    await box(w).setValue('Se')
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    expect(options(w).map((o) => o.text())).toEqual(['<b>Sefa</b>'])
    expect(w.find('[role="listbox"] b').exists()).toBe(false)
    expect(w.find('[role="listbox"] img').exists()).toBe(false)
  })

  it('says why a search did not work, and the server\'s 503 as "still loading"', async () => {
    vi.useFakeTimers()
    let refusal = Object.assign(new Error('The member list is not ready yet. Try again.'), { status: 503 })
    const w = mountPopover(async () => {
      throw refusal
    })
    await box(w).setValue('Ix')
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    expect(status(w)).toBe('The member list is still loading. Try again in a minute.')
    refusal = Object.assign(new Error("You're searching too fast."), { status: 429 })
    await box(w).setValue('Ixe')
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    expect(status(w)).toBe("You're searching too fast.")
    expect(options(w)).toEqual([])
  })

  it('closes on Escape, and keeps the key to itself', async () => {
    let outside = 0
    const w = mountPopover(async () => [])
    const count = () => outside++
    document.body.addEventListener('keydown', count)
    await box(w).trigger('keydown', { key: 'Escape' })
    document.body.removeEventListener('keydown', count)
    expect(w.emitted('close')).toHaveLength(1)
    expect(outside).toBe(0)
  })
})
