// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, shallowRef } from 'vue'
import { useOpenBranches } from './useOpenBranches'
import { useRosterActions } from './useRosterActions'

// /companies#third: scroll to the story at once, then once more when the roster has arrived, because
// the pieces it brings (High Command, the bars, the toolbar) change the layout above the target. The
// page holds each of their places with a placeholder; the final scroll must wait for those to go, or a
// placeholder that is a few pixels off leaves the page drifted from where the link meant to land.
let scrolled
beforeEach(() => {
  scrolled = []
  Element.prototype.scrollIntoView = vi.fn(function (options) {
    scrolled.push({ id: this.id, options })
  })
  document.body.innerHTML = '<article id="third"></article>'
  window.history.replaceState(null, '', '/companies#third')
})
afterEach(() => vi.useRealTimers())

const actions = () =>
  useRosterActions({
    root: ref(document.body),
    view: shallowRef({ openableKeys: [] }), // the roster has arrived; nothing needs opening
    open: useOpenBranches(),
    infirmaryOpen: ref(false),
    viewerId: ref(null),
    loadInfirmary: vi.fn(),
  })
const hold = (cls) => document.body.insertAdjacentHTML('beforeend', `<div class="${cls}"></div>`)

describe('applyHash: the final scroll waits for the held places', () => {
  it.each(['rs-hc-loading', 'rs-ranks-loading', 'rs-tools-loading'])('does not take the final scroll while a %s place is held, and takes it when it goes', async (cls) => {
    hold(cls)
    const done = actions().applyHash()
    await new Promise((r) => setTimeout(r, 250))
    expect(scrolled).toHaveLength(1) // the first scroll, at once, because the story was already there
    document.querySelector(`.${cls}`).remove()
    await done
    expect(scrolled).toHaveLength(2)
    expect(scrolled.map((s) => s.id)).toEqual(['third', 'third'])
    expect(scrolled[1].options).toEqual({ behavior: 'instant' })
  })

  it('waits for all of them, not just the first to go', async () => {
    hold('rs-hc-loading')
    hold('rs-tools-loading')
    const done = actions().applyHash()
    document.querySelector('.rs-hc-loading').remove()
    await new Promise((r) => setTimeout(r, 250))
    expect(scrolled).toHaveLength(1)
    document.querySelector('.rs-tools-loading').remove()
    await done
    expect(scrolled).toHaveLength(2)
  })

  it('scrolls straight away when nothing is held', async () => {
    await actions().applyHash()
    expect(scrolled).toHaveLength(2)
  })

  it('does not wait for ever: after two seconds it scrolls anyway', async () => {
    vi.useFakeTimers()
    hold('rs-hc-loading') // never goes
    const done = actions().applyHash()
    await vi.advanceTimersByTimeAsync(1900)
    expect(scrolled).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(300)
    await done
    expect(scrolled).toHaveLength(2)
  })
})
