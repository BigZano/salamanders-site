import { plateSlug, plateUrls } from './plate'

/**
 * Getting a plate (a sky, a rock and the sidecar of mountain data that goes with them, see plate.js) from the server into
 * pictures the canvas can draw, and the little clock that fades one in. No DOM drawing and no Vue; the network and the
 * decoder come in as parameters, so a test hands over a fake of each.
 *
 * The rule the page lives by: a plate that cannot be had is `null`, and the page keeps its painted rock. "Cannot be had"
 * is everything that can go wrong (a 404, a network that is down, a server that answers with a page, a sidecar that is not a
 * sidecar, a picture that does not decode, a sky and a rock that are not the same size), it is never an error the page
 * hears about, and it is remembered: the same plate is not asked for again in this page view.
 */

/** How long a plate takes to fade in over the painted rock, in ms. Zero under reduced motion (see plateState). */
export const FADE_MS = 400

// The smallest AVIF there is a free picture of (a 2x2 pixel image, 311 bytes; the one most AVIF feature tests use). A browser
// that can decode it can decode the plates. Base64 so it needs no file and no extra request.
const AVIF_PROBE =
  'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAMAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A='

/**
 * Whether `decode` (createImageBitmap, or a stand-in) can read AVIF: it is handed the probe picture and answers yes if it
 * gives a picture back and no if it throws or is not there.
 *
 * @returns {Promise<boolean>}
 */
export async function detectAvif(decode) {
  try {
    const bytes = Uint8Array.from(atob(AVIF_PROBE), (c) => c.charCodeAt(0))
    return Boolean(await decode(new Blob([bytes], { type: 'image/avif' })))
  } catch {
    return false
  }
}

const num = (v) => typeof v === 'number' && Number.isFinite(v)
const point = (p) => Boolean(p) && num(p.x) && num(p.y)
const points = (list, min) => Array.isArray(list) && list.length >= min && list.every(point)

// What the page reads from a sidecar, and the fewest points a list can have for the page's own indexing to hold (the flanks
// and the valley are walked by index, with a neighbour).
const SCALARS = ['peakX', 'peakY', 'craterHalf', 'valleyDepth']
const POINT_FIELDS = ['rimL', 'rimR', 'mouthL', 'mouthR', 'vent']
const LIST_FIELDS = { left: 2, right: 2, valley: 2, crown: 1, litL: 1, litR: 1 }
const POOL_FIELDS = ['cx', 'cy', 'arcTop', 'rx', 'ry']

// A pool is optional. One that is there has only finite numbers in the fields the fit and the mapping read, and an arcTop
// comes with the cx the fit pairs it with.
const poolOk = (pool) =>
  pool == null ||
  (typeof pool === 'object' && POOL_FIELDS.every((k) => pool[k] === undefined || num(pool[k])) && (pool.arcTop === undefined || num(pool.cx)))

/**
 * Whether a parsed sidecar has what MountDeathfire.vue reads from it, every number a finite one: the shape of what
 * buildMountain returns (in image pixels), and a pool and a lip anchor when it has them. A sidecar that fails is treated as a
 * 404 would be. It does not say the numbers make a mountain; the page guards the mapping as well.
 */
export function sidecarOk(s) {
  if (!s || typeof s !== 'object') return false
  return (
    SCALARS.every((k) => num(s[k])) &&
    POINT_FIELDS.every((k) => point(s[k])) &&
    Object.entries(LIST_FIELDS).every(([k, min]) => points(s[k], min)) &&
    poolOk(s.pool) &&
    (s.lip === undefined || point(s.lip))
  )
}

// A decoded picture is let go if the plate it belonged to did not come together. Older browsers' bitmaps may not have close().
const release = (bitmaps) => {
  for (const b of bitmaps) b.close?.()
}

/**
 * The plate fetcher.
 *
 * `load(key, bucket, token)` resolves to `{ sky, rock, sidecar, token }` (the two pictures decoded, the sidecar parsed, and
 * the `token` handed in, so a caller that has moved on can see the answer is not for it: `result.token !== latest`), or to
 * `null` if the plate cannot be had. It never rejects.
 *
 * Plates are kept (and failures too) by `plateSlug(key) + '/' + bucket`, not by the route's own key: every route that has no
 * plate of its own is served the default one, so `/planner` and `/roster` share one fetch, and one 404 when there is none.
 * Nothing is asked for twice in a page view, whether the first ask was a success, a failure or is still on its way. The
 * decoded pictures are held for the page view: at most a handful of plates, the one for the window and the ones it may be
 * resized to.
 *
 * It asks for the sidecar first and for the pictures only if that is good, so a plate that is not there is one request. The
 * pictures are AVIF when `supportsAvif` (a boolean or a promise of one; left out, it asks `detectAvif(decode)` once) says the
 * browser reads it, WebP otherwise. A 404 on the chosen format is a 404; the other format is not tried.
 *
 * `fail(key, bucket)` is for a caller that finds out later that a plate is no good (the sidecar's numbers made nothing
 * drawable): the plate is `null` from then on.
 */
export function createPlateLoader({
  fetchImpl = (...args) => globalThis.fetch(...args),
  decode = (...args) => globalThis.createImageBitmap(...args),
  supportsAvif,
  base,
} = {}) {
  const plates = new Map() // `${slug}/${bucket}` -> a promise of { sky, rock, sidecar }, or of null
  const idOf = (key, bucket) => `${plateSlug(key)}/${bucket}`

  let avif
  const wantsAvif = () => (avif ??= Promise.resolve(supportsAvif === undefined ? detectAvif(decode) : supportsAvif).catch(() => false))

  async function picture(url) {
    const res = await fetchImpl(url)
    if (!res.ok) throw new Error(`${url} answered ${res.status}`)
    return decode(await res.blob())
  }

  async function fetchPlate(key, bucket) {
    const urls = plateUrls(key, bucket, base)
    const res = await fetchImpl(urls.json)
    if (!res.ok) return null
    const sidecar = await res.json()
    if (!sidecarOk(sidecar)) return null
    const format = (await wantsAvif()) ? 'avif' : 'webp'
    const settled = await Promise.allSettled([picture(urls.sky[format]), picture(urls.rock[format])])
    const got = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
    if (got.length < 2 || got[0].width !== got[1].width || got[0].height !== got[1].height) {
      release(got)
      return null
    }
    return { sky: got[0], rock: got[1], sidecar }
  }

  return {
    load(key, bucket, token) {
      const id = idOf(key, bucket)
      if (!plates.has(id)) plates.set(id, fetchPlate(key, bucket).catch(() => null))
      return plates.get(id).then((plate) => (plate ? { ...plate, token } : null))
    },
    fail(key, bucket) {
      plates.set(idOf(key, bucket), Promise.resolve(null))
    },
  }
}

/**
 * The fade, as a clock the draw loop reads. A plate is `set` with the time it arrived and `tick`ed with the time now; the
 * answer is how much of it to draw over what is under it, 0 to 1, rising in a line over FADE_MS (at once under reduced motion).
 *
 * `incoming` is the plate that is fading in, `current` the one that has finished (or the last one, while a new one fades in
 * over it: a caller that has one draws it whole and the incoming one at the alpha). A tick that finishes the fade moves
 * incoming to current. `set(null)` clears both, and the answer is 0.
 */
export function plateState() {
  const s = {
    current: null,
    incoming: null,
    fadeStart: 0,
    set(plate, now) {
      if (!plate) {
        s.current = null
        s.incoming = null
        return
      }
      s.incoming = plate
      s.fadeStart = now
    },
    tick(now, reducedMotion) {
      if (s.incoming) {
        const p = reducedMotion ? 1 : Math.max(0, Math.min(1, (now - s.fadeStart) / FADE_MS))
        if (p < 1) return p
        s.current = s.incoming
        s.incoming = null
      }
      return s.current ? 1 : 0
    },
  }
  return s
}
