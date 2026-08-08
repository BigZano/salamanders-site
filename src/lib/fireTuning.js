import { reactive } from 'vue'

/**
 * Live tuning values for the fire effects.
 *
 * The panel at ?tune=1 writes here and the components read it, so the look can
 * be dialled in the browser instead of guessed in CSS. Once the numbers are
 * settled, paste them back in as these defaults and the panel stops mattering.
 */
export const DEFAULTS = {
  // Dialled in on the tuning panel; these are the values Bret settled on.
  text: {
    pixel: 1,
    speed: 0.85,
    maxHeight: 0.75,
    variation: 1.25,
    intensity: 1.1,
    // How bright the un-burnt base of each glyph sits. Too high and the additive
    // fire clips to a single flat colour.
    base: 0.35,
  },
  // Mount Deathfire, the great volcano of Nocturne, behind every page.
  // Not Doom fire — at background scale the pixel grid read as noise.
  bed: {
    // Height of the peak above the bottom of the viewport.
    height: 800,
    // Base width as a fraction of the viewport.
    width: 0.88,
    // Centre of the range the peak sits in, 0 = left edge, 1 = right.
    offsetX: 0.5,
    // How far each page may wander from that centre. 0 puts every page on the
    // same face; higher gives each route its own side of the mountain.
    faceSpread: 0.28,
    // Lava channels running down the flanks.
    flows: 7,
    flowHeat: 0.9,
    // Light in the crater mouth.
    caldera: 0.7,
    // Lower cones behind the peak, for depth.
    ridges: 3,
    // Painted heat haze in the sky behind it.
    glow: 0.16,
    // Eruption pulses: how often, and how many sparks each throws.
    eruptRate: 1,
    sparks: 1,
    // Volcanic ash falling against the rising sparks.
    ash: 40,
    // Continuous plume off the summit.
    count: 112,
    speed: 2.1,
    scale: 2,
    // 0 = all soft embers, 1 = all fast sparks, between = both at once.
    sparkMix: 1,
  },
}

/**
 * Which values a route's seed is allowed to vary.
 *
 * Deathfire is one mountain. Walking to another page should move you around it,
 * not swap it for a different peak — so the cone's own dimensions stay static by
 * default and only what you'd actually see change from another vantage varies:
 * where the summit sits, which lava channels face you, how the far ridges line up.
 */
export const RANDOMIZE_DEFAULTS = {
  offsetX: true, // walk around the mountain
  flows: true, // different channels face you from each side
  ridges: true, // the far peaks shift with parallax
  asymmetry: false, // the cone's own profile — off, or it's a new mountain
  height: false,
  width: false,
}

const clone = (o) => JSON.parse(JSON.stringify(o))

export const fireTuning = reactive(clone(DEFAULTS))
export const randomize = reactive({ ...RANDOMIZE_DEFAULTS })

export function resetTuning() {
  Object.assign(fireTuning.text, DEFAULTS.text)
  Object.assign(fireTuning.bed, DEFAULTS.bed)
  Object.assign(randomize, RANDOMIZE_DEFAULTS)
}

/**
 * Is the tuning panel switched on?
 *
 * Sticky for the session once enabled: the flag lives in location.search, and
 * any navigation that rewrites the URL would otherwise drop the panel mid-tune.
 */
export function tuningEnabled() {
  if (typeof window === 'undefined') return false
  const inUrl =
    /[?&]tune=1\b/.test(window.location.search) || /[?&]tune=1\b/.test(window.location.hash)
  try {
    if (inUrl) sessionStorage.setItem('sal-tune', '1')
    if (/[?&]tune=0\b/.test(window.location.search)) {
      sessionStorage.removeItem('sal-tune')
      return false
    }
    return inUrl || sessionStorage.getItem('sal-tune') === '1'
  } catch {
    return inUrl
  }
}
