// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import DeathwatchNavSheet from './DeathwatchNavSheet.vue'

// jsdom has no modal <dialog>, pointer events, pointer capture or matchMedia: the pieces of the browser the sheet
// leans on are stood in for here, and the sheet's own behaviour is what is tested.
let reduced
let clock
beforeEach(() => {
  reduced = false
  clock = 0
  HTMLDialogElement.prototype.showModal = vi.fn(function () {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function () {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  })
  window.matchMedia = vi.fn(() => ({ matches: reduced }))
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) // only the sheet's safety timer; the clock below is ours
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function mountSheet({ open = true, attrs = {} } = {}) {
  const updates = []
  const w = mount(DeathwatchNavSheet, {
    props: {
      modelValue: open,
      'onUpdate:modelValue': (v) => {
        updates.push(v)
        w.setProps({ modelValue: v })
      },
    },
    attrs,
    slots: { default: '<button class="inner" type="button">inner</button>' },
    attachTo: document.body,
  })
  const dialog = w.find('dialog').element
  dialog.getBoundingClientRect = () => ({ height: 400, width: 390, top: 0, left: 0, right: 390, bottom: 400 })
  return { w, updates, dialog }
}
const pointer = (el, type, { id = 1, y = 0 } = {}) => {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(e, { pointerId: { value: id }, clientY: { value: y } })
  el.dispatchEvent(e)
  return e
}
const slideEnd = (dialog, propertyName = 'transform') => {
  const e = new Event('transitionend', { bubbles: true })
  Object.defineProperty(e, 'propertyName', { value: propertyName })
  dialog.dispatchEvent(e)
}

describe('DeathwatchNavSheet: opening', () => {
  it('holds its content in a dialog, closed until it is opened', () => {
    const { w, dialog } = mountSheet({ open: false })
    expect(dialog.classList.contains('dw-sheet')).toBe(true)
    expect(w.find('dialog .inner').exists()).toBe(true)
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled()
    expect(dialog.hasAttribute('open')).toBe(false)
  })

  it('opens as a modal dialog, both when mounted open and when opened later', async () => {
    const mounted = mountSheet({ open: true })
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1)
    expect(mounted.dialog.hasAttribute('open')).toBe(true)

    const later = mountSheet({ open: false })
    await later.w.setProps({ modelValue: true })
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(2)
    expect(later.dialog.hasAttribute('open')).toBe(true)
  })

  it('passes attributes such as aria-label to the dialog', () => {
    const { dialog } = mountSheet({ attrs: { 'aria-label': 'Event Tracker views' } })
    expect(dialog.getAttribute('aria-label')).toBe('Event Tracker views')
  })
})

describe('DeathwatchNavSheet: asking to close', () => {
  it('turns Escape into a request to close, so it slides out like any other close', () => {
    const { dialog, updates } = mountSheet()
    const e = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true) // the browser's own instant close is not used
    expect(updates).toEqual([false])
  })

  it('closes on a click on the backdrop, and not on a click inside', () => {
    const inside = mountSheet()
    inside.w.find('.inner').element.click()
    expect(inside.updates).toEqual([])

    const outside = mountSheet()
    outside.dialog.click()
    expect(outside.updates).toEqual([false])
  })
})

describe('DeathwatchNavSheet: closing', () => {
  it('waits for the slide-out to finish before closing the dialog', async () => {
    const { w, dialog, updates } = mountSheet()
    await w.setProps({ modelValue: false })
    expect(dialog.hasAttribute('data-closing')).toBe(true)
    expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled()
    expect(dialog.hasAttribute('open')).toBe(true)

    slideEnd(dialog)
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1)
    expect(dialog.hasAttribute('open')).toBe(false)
    expect(dialog.hasAttribute('data-closing')).toBe(false)
    expect(updates).toEqual([]) // closing came from the parent, so there is nothing to report back
  })

  it('is not fooled by another element or another property finishing', async () => {
    const { w, dialog } = mountSheet()
    await w.setProps({ modelValue: false })
    w.find('.inner').element.dispatchEvent(Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'transform' }))
    slideEnd(dialog, 'opacity')
    expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled()
  })

  it('does not wait for an animation that never ends', async () => {
    const { w } = mountSheet()
    await w.setProps({ modelValue: false })
    vi.advanceTimersByTime(299)
    expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1)
  })

  it('closes at once when the visitor prefers reduced motion', async () => {
    reduced = true
    const { w, dialog } = mountSheet()
    await w.setProps({ modelValue: false })
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1)
    expect(dialog.hasAttribute('data-closing')).toBe(false)
  })

  it('stays open if it is asked to open again while it slides out', async () => {
    const { w, dialog } = mountSheet()
    await w.setProps({ modelValue: false })
    await w.setProps({ modelValue: true })
    expect(dialog.hasAttribute('data-closing')).toBe(false)
    slideEnd(dialog)
    vi.advanceTimersByTime(1000)
    expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled()
    expect(dialog.hasAttribute('open')).toBe(true)
  })

  it('closes the dialog when it is unmounted while open, so the page is not left locked', () => {
    const { w, dialog } = mountSheet()
    expect(dialog.hasAttribute('open')).toBe(true)
    w.unmount()
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1)
    expect(dialog.hasAttribute('open')).toBe(false)
  })

  it('does not close an already closed dialog when it is unmounted', () => {
    const { w } = mountSheet({ open: false })
    w.unmount()
    expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled()
  })
})

describe('DeathwatchNavSheet: dragging the handle', () => {
  const handle = (w) => w.find('.dw-sheet-handle').element

  it('follows the finger down, with the transition off so it tracks it', () => {
    const { w, dialog } = mountSheet()
    pointer(handle(w), 'pointerdown', { y: 100 })
    expect(dialog.style.transition).toBe('none')
    pointer(handle(w), 'pointermove', { y: 160 })
    expect(dialog.style.transform).toBe('translateY(60px)')
  })

  it('gives with friction when dragged up past the open position', () => {
    const { w, dialog } = mountSheet()
    pointer(handle(w), 'pointerdown', { y: 100 })
    pointer(handle(w), 'pointermove', { y: 0 })
    expect(dialog.style.transform).toBe('translateY(-10px)')
  })

  it('takes hold of the pointer, where the browser can', () => {
    const { w } = mountSheet()
    handle(w).setPointerCapture = vi.fn()
    pointer(handle(w), 'pointerdown', { id: 7, y: 100 })
    expect(handle(w).setPointerCapture).toHaveBeenCalledWith(7)
  })

  it('springs back after a short, slow drag', () => {
    const { w, dialog, updates } = mountSheet()
    pointer(handle(w), 'pointerdown', { y: 100 })
    pointer(handle(w), 'pointermove', { y: 140 })
    clock = 2000
    pointer(handle(w), 'pointerup', { y: 140 })
    expect(updates).toEqual([])
    expect(dialog.style.transform).toBe('')
    expect(dialog.style.transition).toBe('')
  })

  it('closes after a drag of 40% of its height', () => {
    const { w, updates } = mountSheet()
    pointer(handle(w), 'pointerdown', { y: 100 })
    clock = 5000
    pointer(handle(w), 'pointerup', { y: 260 }) // 160px of 400
    expect(updates).toEqual([false])
  })

  it('closes on a quick flick', () => {
    const { w, updates } = mountSheet()
    pointer(handle(w), 'pointerdown', { y: 100 })
    clock = 100
    pointer(handle(w), 'pointerup', { y: 140 }) // 0.4 px/ms
    expect(updates).toEqual([false])
  })

  it('ignores a second finger while one is down', () => {
    const { w, dialog, updates } = mountSheet()
    pointer(handle(w), 'pointerdown', { id: 1, y: 100 })
    pointer(handle(w), 'pointerdown', { id: 2, y: 400 })
    pointer(handle(w), 'pointermove', { id: 2, y: 900 })
    expect(dialog.style.transform).toBe('')
    pointer(handle(w), 'pointermove', { id: 1, y: 130 })
    expect(dialog.style.transform).toBe('translateY(30px)')
    clock = 5000
    pointer(handle(w), 'pointerup', { id: 2, y: 900 }) // not the finger that started it
    expect(updates).toEqual([])
    expect(dialog.style.transform).toBe('translateY(30px)')
    pointer(handle(w), 'pointerup', { id: 1, y: 130 })
    expect(updates).toEqual([])
    expect(dialog.style.transform).toBe('')
  })

  it('springs back when the browser cancels the touch', () => {
    const { w, dialog, updates } = mountSheet()
    pointer(handle(w), 'pointerdown', { y: 100 })
    pointer(handle(w), 'pointermove', { y: 300 })
    pointer(handle(w), 'pointercancel', { y: 300 })
    expect(updates).toEqual([])
    expect(dialog.style.transform).toBe('')
    expect(dialog.style.transition).toBe('')
  })

  it('ignores moves and releases that no touch began', () => {
    const { w, dialog, updates } = mountSheet()
    pointer(handle(w), 'pointermove', { y: 300 })
    pointer(handle(w), 'pointerup', { y: 300 })
    pointer(handle(w), 'pointercancel', { y: 300 })
    expect(dialog.style.transform).toBe('')
    expect(updates).toEqual([])
  })

  it('takes a new drag once the last has ended', () => {
    const { w, dialog } = mountSheet()
    pointer(handle(w), 'pointerdown', { y: 100 })
    clock = 5000
    pointer(handle(w), 'pointerup', { y: 110 })
    pointer(handle(w), 'pointerdown', { y: 200 })
    pointer(handle(w), 'pointermove', { y: 230 })
    expect(dialog.style.transform).toBe('translateY(30px)')
  })
})
