import { reactive } from 'vue'

/**
 * Live tuning values for the fire effects.
 *
 * The panel at ?tune=1 writes here and the components read it, so the look can
 * be dialled in the browser instead of guessed in CSS. Once the numbers are
 * settled, paste them back in as these defaults and the panel stops mattering.
 */

/**
 * The baked hero.
 *
 * These are the numbers Bret settled on at the tuning panel, and they describe
 * the landing page exactly: a tall narrow cone hard over on the left, so the
 * centred wordmark sits clear of it, lit hot and running two dozen lava
 * channels. Every other page is expressed as a departure from this (see
 * ROUTE_PROFILE_DEFAULTS), so treat it as the anchor rather than one preset
 * among several — changing it moves the whole site.
 */
export const DEFAULTS = {
  text: {
    pixel: 1,
    speed: 1.45,
    maxHeight: 0.8,
    variation: 0.95,
    intensity: 1.3,
    // How bright the un-burnt base of each glyph sits. Too high and the additive
    // fire clips to a single flat colour.
    base: 0.35,
  },
  // Mount Deathfire, the great volcano of Nocturne, behind every page.
  // Not Doom fire — at background scale the pixel grid read as noise.
  bed: {
    // Height of the peak above the bottom of the viewport.
    height: 690,
    // Base width as a fraction of the viewport.
    width: 0.6,
    // Centre of the range the peak sits in, 0 = left edge, 1 = right.
    offsetX: 0.18,
    // How far a page's seed may wander from that centre. This is the *random*
    // component only; a page's deliberate position is its profile bearing.
    faceSpread: 0.16,
    // Lava channels running down the flanks.
    flows: 24,
    flowHeat: 1.1,
    // Light in the crater mouth.
    caldera: 1.3,
    // Lower cones behind the peak, for depth.
    ridges: 8,
    // Painted heat haze in the sky behind it.
    glow: 0.64,
    // Eruption pulses: how often, and how many sparks each throws.
    eruptRate: 1,
    sparks: 1.6,
    // Volcanic ash falling against the rising sparks.
    ash: 160,
    // Continuous plume off the summit.
    count: 200,
    speed: 2.35,
    scale: 2.7,
    // 0 = all soft embers, 1 = all fast sparks, between = both at once.
    sparkMix: 0,
  },
}

/**
 * Which values a route's seed is allowed to vary.
 *
 * Deathfire is one mountain, but the cone's own profile is now in play too —
 * turning `asymmetry` on was part of the look that got baked, so each page
 * reshapes the flanks rather than only moving the camera. Per-route amount is
 * governed by the profile `variance` below, which is what keeps that from
 * reading as five different mountains.
 */
export const RANDOMIZE_DEFAULTS = {
  offsetX: true, // walk around the mountain
  flows: true, // different channels face you from each side
  ridges: true, // the far peaks shift with parallax
  asymmetry: true, // the cone's own profile reshapes per face
  height: false,
  width: false,
}

/**
 * How each page departs from the baked hero.
 *
 *   bearing  — where you stand, added to bed.offsetX in viewport fractions.
 *              Negative walks left, positive right. Deliberately absolute
 *              rather than a multiple of faceSpread: a page's position is a
 *              design decision and shouldn't collapse to zero if the random
 *              spread is later dialled down.
 *   scale    — how tall the peak stands, multiplying bed.height. This is how
 *              far away you are. Sideways is not enough on its own: the perk
 *              tree spans the full width, so a full-height cone shoved to the
 *              edge just drops the summit and its converging lava on top of
 *              the grid. Pulling it down to a horizon is the answer.
 *   variance — how far the seeded detail (cone profile, lava layout, ridge
 *              parallax) is allowed to stray from the neutral cone. 1 is as
 *              loose as the hero, 0 is a clean symmetric mountain with evenly
 *              spaced channels.
 *   density  — how loud the mountain is: plume, ash, sky glow, and the heat of
 *              the lava and caldera. Lava is the brightest thing on screen, so
 *              a page that's mostly reading needs this well under 1.
 *
 * The hero is 0 / 1 / 1 / 1 by definition. Those values are algebraically
 * neutral everywhere they're applied, so `/` renders from exactly the same
 * sequence of random numbers it did before profiles existed. Don't "tidy" them.
 */
export const ROUTE_PROFILE_DEFAULTS = {
  // The landing page, exactly as tuned. The anchor for everything below.
  '/': { bearing: 0, scale: 1, variance: 1, density: 1 },

  // Perk Builder: an eight-column hex tree spanning the full width, the densest
  // screen on the site. Nowhere to hide a mountain sideways, so it drops to a
  // low horizon and the lava comes right down.
  '/planner': { bearing: -0.02, scale: 0.34, variance: 0.45, density: 0.35 },

  // Armoury: weapon list and detail panel together span most of the width, so
  // this is a horizon too, just a nearer one than the planner's.
  '/armoury': { bearing: 0.3, scale: 0.45, variance: 0.6, density: 0.45 },

  // Builds: empty until you save one, so it can carry a bolder horizon — but
  // the page is short, which puts the footer over the peak, and the footer
  // background is only 60% opaque. Density is what keeps the fine print legible.
  '/builds': { bearing: 0.34, scale: 0.5, variance: 0.9, density: 0.45 },

  // Companies: a left-aligned reading column with the whole right half empty.
  // The mountain belongs in that empty half, not under the text.
  '/companies': { bearing: 0.52, scale: 0.6, variance: 0.75, density: 0.55 },

  // Anything unrouted — the 404. Somewhere you haven't been before.
  '*': { bearing: 0.3, scale: 0.85, variance: 1, density: 0.8 },
}

const clone = (o) => JSON.parse(JSON.stringify(o))

export const fireTuning = reactive(clone(DEFAULTS))
export const randomize = reactive({ ...RANDOMIZE_DEFAULTS })
export const routeProfiles = reactive(clone(ROUTE_PROFILE_DEFAULTS))

/** The hero's profile, and the fallback for a route with nothing declared. */
export const NEUTRAL_PROFILE = { bearing: 0, scale: 1, variance: 1, density: 1 }

export function profileFor(path) {
  return routeProfiles[path] || routeProfiles['*'] || NEUTRAL_PROFILE
}

export function resetTuning() {
  Object.assign(fireTuning.text, DEFAULTS.text)
  Object.assign(fireTuning.bed, DEFAULTS.bed)
  Object.assign(randomize, RANDOMIZE_DEFAULTS)
  for (const [path, p] of Object.entries(ROUTE_PROFILE_DEFAULTS)) {
    Object.assign(routeProfiles[path], p)
  }
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
