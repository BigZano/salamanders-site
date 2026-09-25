/**
 * Mount Deathfire's live heat, published every frame so page elements can
 * glow in step with the volcano without their own clock. A plain object,
 * not reactive: readers poll it from their own animation frame.
 *
 * breathe: the caldera's slow swell, 0..1. flare: an eruption pulse, 1 at
 * the moment of eruption decaying to 0.
 */
export const deathfireHeat = { breathe: 0.6, flare: 0 }
