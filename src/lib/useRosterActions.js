import { computed, nextTick, shallowRef } from 'vue'
import { branchKeyOfArticle } from './companyKeys'
import { scrollBehavior } from './motion'
import { openNow, withReaderPinned } from './pinReader'

/**
 * What the Companies page does with the roster: Find me, Expand all, the
 * Infirmary toggle, jumping to a company or a bar, and landing on a deep link.
 * Moved here from the old Roster page; the page owns the refs and the elements,
 * this owns the behaviour.
 *
 *   root          the page's root element ref (everything is looked up inside it)
 *   view          the current view model (full or public), or null
 *   open          useOpenBranches()
 *   infirmaryOpen the page's ref: true while the Infirmary list replaces the order
 *   viewerId      the signed-in member's Discord id, or null
 *   loadInfirmary called when the Infirmary opens
 */
export function useRosterActions({ root, view, open, infirmaryOpen, viewerId, loadInfirmary }) {
  const findMessage = shallowRef('')
  const openableKeys = computed(() => view.value?.openableKeys ?? [])
  const allOpen = computed(() => open.allOpen(openableKeys.value))

  const branchEls = () => (root.value ? [...root.value.querySelectorAll('.rs-branch, .rs-unassigned')] : [])
  const targetOf = (key) => [...(root.value?.querySelectorAll('[data-jump]') ?? [])].find((el) => el.dataset.jump === key)

  function toggleInfirmary() {
    infirmaryOpen.value = !infirmaryOpen.value
    if (infirmaryOpen.value) loadInfirmary()
  }

  // Bulk open and close: snap, and hold the bar under the reader's eye in place.
  function toggleAll() {
    return withReaderPinned(branchEls(), () => open.setAll(openableKeys.value, !allOpen.value))
  }

  function flash(el, cls) {
    el.classList.remove(cls)
    void el.offsetWidth // restart the animation if it is already running
    el.classList.add(cls)
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true })
  }

  // The order of battle is hidden while the Infirmary shows; bring it back before jumping.
  async function showOrder() {
    if (!infirmaryOpen.value) return
    infirmaryOpen.value = false
    await nextTick()
  }

  // Open a bar with no height animation, so the scroll that follows is exact.
  async function jumpToBranch(key) {
    await showOrder()
    if (openableKeys.value.includes(key)) await openNow(() => open.openKey(key))
    const el = targetOf(key)
    if (!el) return
    el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
    flash(el, 'rs-flash')
  }

  async function findMe() {
    findMessage.value = ''
    const id = viewerId.value
    const key = id ? view.value?.index?.get(id) : undefined
    if (!key) {
      findMessage.value = 'You are not on the roll. Check your Legion and rank roles in Discord.'
      return
    }
    await showOrder()
    if (key === 'high-command') {
      targetOf(key)?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
      return
    }
    await openNow(() => open.openKey(key))
    const chip = [...(targetOf(key)?.querySelectorAll('[data-id]') ?? [])].find((el) => el.dataset.id === id)
    if (!chip) return
    chip.scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
    flash(chip, 'rs-ping')
  }

  const scrollNow = (id, options) => document.getElementById(id)?.scrollIntoView(options)

  // High Command, the Muster and the bars are loaded in chunks of their own, after the story, so the
  // target may not exist yet when the roster arrives: wait for it (two seconds at most), then scroll.
  // Timers, not animation frames: a tab opened in the background never gets frames, and this is only
  // waiting for an element to exist.
  async function scrollWhenPresent(id) {
    for (let tries = 0; tries < 40 && !document.getElementById(id); tries++) await new Promise((r) => setTimeout(r, 50))
    scrollNow(id, { behavior: 'instant' })
  }

  // A chip: scroll to the company (or High Command, or Muster). Synchronous unless the Infirmary is open.
  function scrollToArticle(id) {
    if (infirmaryOpen.value) return showOrder().then(() => scrollNow(id))
    scrollNow(id)
  }

  /**
   * /companies#third lands on that company. The story is already on the page, so scroll at once; the
   * bar opens when the roster first arrives, and the scroll is repeated then, because High Command and
   * the bars have by then changed the layout above. The sign-in callback also uses the fragment
   * (`#access_token=…`); useOpenBranches ignores that, and anything that is not one of our ids.
   */
  let scrolled = false
  let opened = false
  async function applyHash() {
    const id = open.hashKey()
    const key = id ? branchKeyOfArticle(id) : null
    if (!key) return
    if (!scrolled) {
      scrolled = true
      scrollNow(id, { behavior: 'instant' })
    }
    if (opened || !view.value) return
    opened = true
    if (openableKeys.value.includes(key)) {
      await nextTick()
      await openNow(() => open.openKey(key))
    }
    await scrollWhenPresent(id)
  }

  return { findMessage, openableKeys, allOpen, toggleAll, toggleInfirmary, jumpToBranch, findMe, scrollToArticle, applyHash }
}
