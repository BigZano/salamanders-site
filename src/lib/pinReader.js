import { nextTick } from 'vue'

/**
 * Two small helpers for changing many branches (or jumping to one) without
 * throwing the reader off their place. Opening every branch at once grows the
 * page by thousands of pixels in a third of a second, and whatever you were
 * reading flies off screen. So bulk changes snap (no height animation) and the
 * branch under the reader's eye is held where it was; jumps open instantly so
 * the scroll target, measured afterwards, is exact. Vue patches the DOM on the
 * next tick, so both wait one before measuring.
 */

/** Added to <html> while a change is applied; the branch CSS drops its height transition under it. */
export const INSTANT_CLASS = 'rs-instant'

const READING_LINE = 0.35 // the reader's eye: this far down the viewport
const KEEP_MIN = 90 // keep the pinned bar clear of the sticky nav
const KEEP_MAX = 0.6 // and out of the bottom of the viewport

// The class stays on for two frames so the snapped layout is what gets painted.
const settle = (root) => requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove(INSTANT_CLASS)))

/** The element under the line, else the one whose edge is nearest it (ties go to the earlier one). */
function atLine(items, line) {
  let best = null
  let bestDistance = Infinity
  for (const el of items) {
    const r = el.getBoundingClientRect()
    const distance = r.top <= line && r.bottom > line ? 0 : Math.min(Math.abs(r.top - line), Math.abs(r.bottom - line))
    if (distance < bestDistance) {
      best = el
      bestDistance = distance
    }
  }
  return best
}

/**
 * Run `mutate` (a bulk open or close) and keep the branch under the reading line
 * where it was. `items` are the branch elements. The correction is `instant`
 * because style.css sets `html { scroll-behavior: smooth }`, which would turn a
 * plain scrollBy into a slide.
 */
export async function withReaderPinned(items, mutate, root = document.documentElement) {
  const height = window.innerHeight
  const ref = items.length ? atLine(items, height * READING_LINE) : null
  const want = ref ? Math.min(Math.max(ref.getBoundingClientRect().top, KEEP_MIN), height * KEEP_MAX) : 0
  root.classList.add(INSTANT_CLASS)
  try {
    mutate()
    await nextTick()
    if (ref) {
      const delta = ref.getBoundingClientRect().top - want
      if (Math.abs(delta) >= 0.5) window.scrollBy({ top: delta, behavior: 'instant' })
    }
  } finally {
    settle(root)
  }
}

/** Run `open` with no height animation and wait for the layout, so a scroll measured after it is exact. */
export async function openNow(open, root = document.documentElement) {
  root.classList.add(INSTANT_CLASS)
  try {
    open()
    await nextTick()
    void root.offsetHeight // force the layout before the caller measures
  } finally {
    settle(root)
  }
}
