/**
 * The 3D-rendered plates under the hero, as plain functions: which plate a page asks for, how it is cover-fitted to the
 * window, and how its sidecar of mountain data follows it onto the screen.
 *
 * Pure. No DOM, no fetch, no Vue: the loader (plateLoader.js) and MountDeathfire.vue call these, and the offline
 * pipeline reads the same constants, so a plate is rendered at exactly the sizes the page goes looking for.
 *
 * A plate is two images (`sky`, opaque, and `rock`, with alpha) and a JSON sidecar, all in the one image's own pixels:
 * the reference size for its bucket plus BLEED of extra picture on every side for cover-fit crops. The sidecar's mountain
 * is in those pixels too (bleed offset already applied), which is what `mapMountain` expects.
 */

/** The reference render size of each aspect bucket, in px, before the bleed. */
export const BUCKETS = {
  portrait: { w: 900, h: 1600 },
  squarish: { w: 1600, h: 1200 },
  wide: { w: 2000, h: 1125 },
}

/** Extra picture on every side, as a fraction of the reference size, so a cover-fit crop has something to take. */
export const BLEED = 0.1

// A window whose w/h is at most this is portrait, at most the next is squarish, wider is wide. The comparisons are `<=`
// on the quotient (division is correctly rounded, so 1120x1400 and 800x1000 both give the very double 0.8), which puts
// exactly 0.8 in portrait and exactly 1.4 in squarish, at every size that reaches them, on every resize.
const PORTRAIT_MAX = 0.8
const SQUARISH_MAX = 1.4

/** @returns {'portrait' | 'squarish' | 'wide'} the bucket for a window of w by h */
export function bucketFor(w, h) {
  const aspect = w / h
  if (aspect <= PORTRAIT_MAX) return 'portrait'
  if (aspect <= SQUARISH_MAX) return 'squarish'
  return 'wide'
}

/**
 * Every route profile key (the keys of routeProfiles in fireTuning.js) and the folder its plates are named for on disk.
 * `/` is `home`, `/deathwatch/*` is `deathwatch`, `*` is `default`, the others drop the leading slash.
 */
const PROFILE_SLUGS = {
  '/': 'home',
  '/planner': 'planner',
  '/armoury': 'armoury',
  '/builds': 'builds',
  '/companies': 'companies',
  '/roster': 'roster',
  '/deathwatch/*': 'deathwatch',
  '*': 'default',
}

/**
 * The slugs that have plates on disk. Extending the set is this one line (and rendering the plates): every other profile
 * falls through to `default`, which must stay in the list.
 */
export const PLATE_SLUGS = ['home', 'default']

/** @returns {string} the disk name for a route profile key; a key that is not one of the profiles is `default` */
export function profileSlug(key) {
  return Object.hasOwn(PROFILE_SLUGS, key) ? PROFILE_SLUGS[key] : 'default'
}

/** @returns {string} the slug of the plate set a route profile key is served from: its own if it has one, else `default` */
export function plateSlug(key) {
  const slug = profileSlug(key)
  return PLATE_SLUGS.includes(slug) ? slug : 'default'
}

/**
 * Where a profile key's plate for a bucket lives. A key with no plate of its own gets the default plate's urls.
 *
 * @returns {{ sky: { avif: string, webp: string }, rock: { avif: string, webp: string }, json: string }}
 */
export function plateUrls(key, bucket, base = '/plates/') {
  const stem = `${base}${plateSlug(key)}/${bucket}`
  return {
    sky: { avif: `${stem}.sky.avif`, webp: `${stem}.sky.webp` },
    rock: { avif: `${stem}.rock.avif`, webp: `${stem}.rock.webp` },
    json: `${stem}.json`,
  }
}

// The peak stays inside this band of the window's width.
const PEAK_BAND = [0.08, 0.92]
// The pool arc's top is held this far above the window's bottom edge, as a fraction of its height.
const POOL_EDGE = 0.06

// The most an image can be moved without exposing its edge is the slack `lo` (<= 0) up to 0.
const clamp = (v, lo) => Math.min(0, Math.max(lo, v))

/**
 * Cover-fit a plate to a w by h window and place it: `scale` and the `dx`, `dy` that go with it, so an image point (px, py)
 * lands at (px * scale + dx, py * scale + dy). Both shifts are <= 0 and never expose the image's edge.
 *
 * Centred to begin with. Then along x by the least amount that brings the peak inside the middle 84 percent of the window.
 * Then along y, preferring the pool over centring: the image is moved so the pool arc's top sits at 94 percent of the
 * window's height (the arc stays at the bottom edge), and the peak is kept from crossing the top edge. "When the crop
 * allows": every shift is clamped to the slack, so a window with no slack on an axis does not move on it.
 *
 * `anchor` is `{ peak?: {x, y}, poolTop?: {x, y} }` in image pixels (see anchorFor). Without a part the axis is centred.
 *
 * @returns {{ scale: number, dx: number, dy: number }}
 */
export function fitPlate({ imageW, imageH, w, h, anchor }) {
  let scale = Math.max(w / imageW, h / imageH)
  // Rounding leaves imageW * scale (or imageH * scale) a hair under the window on about one size in twenty. One ulp up and
  // the image covers in floating point as well as on paper, so nothing downstream sees a sliver of the edge.
  while (imageW * scale < w || imageH * scale < h) scale *= 1 + Number.EPSILON
  const slackX = Math.min(0, w - imageW * scale)
  const slackY = Math.min(0, h - imageH * scale)
  let dx = slackX / 2
  let dy = slackY / 2

  const peak = anchor?.peak
  if (peak) {
    const at = peak.x * scale + dx
    const lo = PEAK_BAND[0] * w
    const hi = PEAK_BAND[1] * w
    if (at < lo) dx += lo - at
    else if (at > hi) dx -= at - hi
    dx = clamp(dx, slackX)
  }

  const pool = anchor?.poolTop
  if (pool) dy = clamp(h * (1 - POOL_EDGE) - pool.y * scale, slackY)
  if (peak) dy = clamp(Math.max(dy, -peak.y * scale), slackY)

  return { scale, dx, dy }
}

/** @returns {{ x: number, y: number }} a new point: the image point carried through the fit */
export function mapPoint(p, fit) {
  return { x: p.x * fit.scale + fit.dx, y: p.y * fit.scale + fit.dy }
}

const mapPoints = (pts, fit) => pts.map((p) => mapPoint(p, fit))

// The pool arc as the lava network describes it (its `makePool`, less the arcY function JSON cannot carry): centre,
// half widths, and the arc's top. Only the fields present are mapped, and only these, so nothing is carried across in the
// wrong pixels.
const POOL_X = ['cx']
const POOL_Y = ['cy', 'arcTop']
const POOL_SCALED = ['rx', 'ry']

function mapPool(pool, fit) {
  const out = {}
  for (const k of POOL_X) if (typeof pool[k] === 'number') out[k] = pool[k] * fit.scale + fit.dx
  for (const k of POOL_Y) if (typeof pool[k] === 'number') out[k] = pool[k] * fit.scale + fit.dy
  for (const k of POOL_SCALED) if (typeof pool[k] === 'number') out[k] = pool[k] * fit.scale
  return out
}

/**
 * The sidecar's mountain carried through a fit: every point and list of points by `x * scale + dx`, `y * scale + dy`,
 * `peakX` and `peakY` the same way, `craterHalf` and `valleyDepth` by `scale` alone.
 *
 * Returns a new mountain with the fields buildMountain returns, and `pool` and `lip` when the sidecar has them. The
 * input is never touched, and no point of it is shared with the result: the mountain buildMountain returns aliases
 * points (`mouthL` and `mouthR` are the valley's first and last, `litL[0]` and `litR[0]` are crown points), so moving
 * them in place would move those twice. Anything else in the sidecar (size, bleed, versions, light anchors) is left out;
 * map a point of those with mapPoint.
 */
export function mapMountain(sidecar, fit) {
  const s = sidecar
  const out = {
    peakX: s.peakX * fit.scale + fit.dx,
    peakY: s.peakY * fit.scale + fit.dy,
    craterHalf: s.craterHalf * fit.scale,
    left: mapPoints(s.left, fit),
    right: mapPoints(s.right, fit),
    rimL: mapPoint(s.rimL, fit),
    rimR: mapPoint(s.rimR, fit),
    crown: mapPoints(s.crown, fit),
    mouthL: mapPoint(s.mouthL, fit),
    mouthR: mapPoint(s.mouthR, fit),
    valley: mapPoints(s.valley, fit),
    vent: mapPoint(s.vent, fit),
    valleyDepth: s.valleyDepth * fit.scale,
    litL: mapPoints(s.litL, fit),
    litR: mapPoints(s.litR, fit),
  }
  if (s.pool) out.pool = mapPool(s.pool, fit)
  if (s.lip) out.lip = mapPoint(s.lip, fit)
  return out
}

/**
 * The anchors fitPlate wants, read from a sidecar: the peak, and the top of the pool arc when the sidecar has a pool with
 * an `arcTop`. All in the sidecar's own (image) pixels.
 *
 * @returns {{ peak: { x: number, y: number }, poolTop?: { x: number, y: number } }}
 */
export function anchorFor(sidecar) {
  const anchor = { peak: { x: sidecar.peakX, y: sidecar.peakY } }
  const pool = sidecar.pool
  if (pool && typeof pool.arcTop === 'number') anchor.poolTop = { x: pool.cx, y: pool.arcTop }
  return anchor
}
