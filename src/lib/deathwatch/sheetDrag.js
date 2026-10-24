// The arithmetic behind the Deathwatch bottom sheet's drag-to-dismiss, kept apart from the component so it
// can be tested exactly. Nothing here touches the DOM.

/** A drag of this fraction of the sheet's height dismisses it however slowly it was made. */
export const DISMISS_RATIO = 0.4
/** A flick faster than this (px per ms) dismisses it from a short distance. */
export const DISMISS_VELOCITY = 0.11
/** The shortest drag (px) that can count as a flick, so a twitch of a finger does not close the sheet. */
export const MIN_FLICK = 20

/**
 * Where the sheet sits for a drag of `delta` px (down is positive). Downwards it follows the finger one
 * to one. Upwards, past its open position, it gives with increasing friction instead of stopping dead.
 * Anything that is not a finite number leaves the sheet where it is.
 */
export function dragOffset(delta) {
  if (!Number.isFinite(delta)) return 0
  // Stryker disable next-line EqualityOperator: at 0 both branches give +0 (-Math.sqrt(-0) is +0), so `>` and `>=` are the same function
  return delta >= 0 ? delta : -Math.sqrt(-delta)
}

/**
 * Whether releasing the sheet after dragging it `distance` px down, over `elapsedMs`, on a sheet `height` px
 * tall, should close it: a long enough drag, or a quick enough flick. An unusable distance or height never
 * closes it. An unusable elapsed time only switches off the flick rule, so a long drag still closes.
 */
export function shouldDismiss({ distance, elapsedMs, height }) {
  if (!Number.isFinite(distance) || !Number.isFinite(height) || height <= 0) return false
  if (distance >= height * DISMISS_RATIO) return true
  return elapsedMs > 0 && distance >= MIN_FLICK && distance / elapsedMs > DISMISS_VELOCITY
}
