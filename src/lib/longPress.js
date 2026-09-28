// Touch press-and-hold. iOS Safari sends no hover (mouseenter) for a held
// finger and doesn't focus a tapped <button>, so hover-only previews can't be
// reached there. A held touch calls onHold with the pressed element; the click
// that follows the release is swallowed, so holding a perk to read it doesn't
// also toggle it. Mouse and pen pointers already hover and are left alone.
export const HOLD_MS = 450

export function createLongPress(onHold, delay = HOLD_MS) {
  if (typeof onHold !== 'function') throw new TypeError('onHold must be a function')
  if (!Number.isFinite(delay) || delay <= 0) {
    throw new RangeError('delay must be a positive number of milliseconds')
  }
  let timer = null
  let held = false
  function cancel() {
    clearTimeout(timer)
    timer = null
  }
  return {
    down(evt) {
      if (evt.pointerType !== 'touch') return
      cancel()
      // Android ends a hold with contextmenu rather than click, so a stale
      // hold must not swallow the next real tap.
      held = false
      const target = evt.currentTarget
      timer = setTimeout(() => {
        timer = null
        held = true
        onHold(target)
      }, delay)
    },
    cancel,
    // True when this click ends a hold and should be ignored.
    consumeClick() {
      const was = held
      held = false
      return was
    },
  }
}
