<script setup>
// A bottom sheet for a phone: a native modal <dialog> that slides up from the foot of the screen, where a thumb
// reaches it (a left-hand drawer would fight the iOS edge swipe that means Back). The browser supplies the
// parts that are easy to get wrong: focus is held inside while it is open and handed back on close, the page
// behind is inert, and Escape asks to close. The sheet adds the rest: a scrim click and a drag of the handle
// ask to close too, and it slides out before it closes.
//
// v-model is whether it is open. Anything that wants it closed sets the model to false; this component then
// animates out and closes the dialog. The drag arithmetic lives in lib/deathwatch/sheetDrag.js.
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue'
import { dragOffset, shouldDismiss } from '../../lib/deathwatch/sheetDrag'

const open = defineModel({ type: Boolean, default: false })
const dialog = useTemplateRef('dialog')

// The slide-out lasts SLIDE_MS: the stylesheet's --dur-view (240ms), the close. The slide-in is the longer
// --dur-sheet (see the stylesheet). The timer is only for a transition that never ends, for instance in a
// hidden tab, so the dialog still closes.
const SLIDE_MS = 240
const SAFETY_MS = SLIDE_MS + 80

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

// Set while the sheet is sliding out: stops that (its listener, its timer, its marker).
let cancelSlide = null

function show() {
  const d = dialog.value
  if (!d) return
  cancelSlide?.() // opened again while sliding out: stay open
  if (!d.open) d.showModal()
}

function finish() {
  cancelSlide?.()
  dialog.value?.close()
}

function hide() {
  const d = dialog.value
  if (!d?.open || cancelSlide) return
  d.style.transform = '' // any drag offset goes: the slide-out starts from where it is
  if (reducedMotion()) return finish()
  d.setAttribute('data-closing', '')
  const onEnd = (e) => {
    if (e.target === d && e.propertyName === 'transform') finish()
  }
  d.addEventListener('transitionend', onEnd)
  const timer = setTimeout(finish, SAFETY_MS)
  cancelSlide = () => {
    d.removeEventListener('transitionend', onEnd)
    clearTimeout(timer)
    d.removeAttribute('data-closing')
    cancelSlide = null
  }
}

watch(open, (isOpen) => (isOpen ? show() : hide()), { flush: 'post' })
onMounted(() => {
  if (open.value) show()
})
// Leaving while open must not leave the page locked behind a dialog that no longer exists.
onBeforeUnmount(() => {
  cancelSlide?.()
  if (dialog.value?.open) dialog.value.close()
})

// The dialog's padding is nil, so a click that lands on the dialog itself is a click on the scrim around it.
function onDialogClick(event) {
  if (event.target === dialog.value) open.value = false
}

// Dragging the handle. One finger at a time: a second is ignored until the first lifts, or the sheet would
// jump to wherever the new finger is. While dragging, the stylesheet's transition is off so it tracks the finger.
let drag = null

function down(event) {
  if (drag) return
  drag = { id: event.pointerId, startY: event.clientY, startedAt: performance.now() }
  event.currentTarget.setPointerCapture?.(event.pointerId)
  dialog.value.style.transition = 'none'
}

function move(event) {
  if (!drag || event.pointerId !== drag.id) return
  dialog.value.style.transform = `translateY(${dragOffset(event.clientY - drag.startY)}px)`
}

// Let go: back to the stylesheet's own transition and position, which is the spring-back unless it closes.
function release(event, mayDismiss) {
  if (!drag || event.pointerId !== drag.id) return
  const d = dialog.value
  const { startY, startedAt } = drag
  drag = null
  d.style.transition = ''
  if (mayDismiss && shouldDismiss({ distance: event.clientY - startY, elapsedMs: performance.now() - startedAt, height: d.getBoundingClientRect().height })) {
    open.value = false // hide() slides it out from where the finger left it
  } else {
    d.style.transform = ''
  }
}
const up = (event) => release(event, true)
const cancel = (event) => release(event, false)
</script>

<template>
  <dialog ref="dialog" class="dw-sheet" @cancel.prevent="open = false" @close="open = false" @click="onDialogClick">
    <div class="dw-sheet-body">
      <div class="dw-sheet-handle" aria-hidden="true" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="cancel" />
      <slot />
    </div>
  </dialog>
</template>

<style scoped>
/* Anchored to the foot of the screen. Only transform and opacity ever animate. */
.dw-sheet {
  position: fixed;
  inset: auto 0 0 0;
  width: 100%;
  max-width: none;
  max-height: min(80dvh, 34rem);
  margin: 0;
  padding: 0;
  border: 0;
  border-top: 1px solid var(--dw-line-2);
  border-radius: 14px 14px 0 0;
  background: var(--dw-surface);
  color: var(--dw-ink);
  overflow: hidden;
  overscroll-behavior: contain;
  transform: translateY(0);
  /* A transition takes the duration of the state it enters, so this is the slide-out's: --dur-view (the
     JS constant SLIDE_MS mirrors it). The slide-in and a released drag's spring-back take --dur-sheet below. */
  transition: transform var(--dur-view) var(--ease-forge);
}
/* Sliding in, and what a released drag springs back to: the open state's own, longer, duration. */
.dw-sheet[open]:not([data-closing]) {
  transition-duration: var(--dur-sheet);
}
@starting-style {
  .dw-sheet[open] {
    transform: translateY(100%);
  }
}
/* Sliding out (DeathwatchNavSheet sets data-closing, then closes the dialog when this has finished). It takes
   the base rule's --dur-view. */
.dw-sheet[data-closing] {
  transform: translateY(100%);
}
/* Literal colours here, and the duration tokens below: ::backdrop does not inherit custom properties in older
   browsers, which keep the scrim (its colour is literal) and lose only its fade. */
.dw-sheet::backdrop {
  background: rgba(0, 0, 0, 0.6);
  opacity: 1;
  transition: opacity var(--dur-view) var(--ease-forge);
}
.dw-sheet[open]:not([data-closing])::backdrop {
  transition-duration: var(--dur-sheet);
}
@starting-style {
  .dw-sheet[open]::backdrop {
    opacity: 0;
  }
}
.dw-sheet[data-closing]::backdrop {
  opacity: 0;
}
.dw-sheet-body {
  max-height: min(80dvh, 34rem);
  padding: 0 1rem calc(1rem + env(safe-area-inset-bottom, 0px));
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* A 44px-tall grip, so it is easy to catch with a thumb; only this part owns the vertical gesture. */
.dw-sheet-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  margin: 0 -1rem;
  cursor: grab;
  touch-action: none;
}
.dw-sheet-handle::after {
  content: '';
  width: 2.6rem;
  height: 4px;
  border-radius: 2px;
  background: var(--dw-line-2);
}
@media (prefers-reduced-motion: reduce) {
  .dw-sheet,
  .dw-sheet::backdrop {
    transition: none;
  }
}
</style>
