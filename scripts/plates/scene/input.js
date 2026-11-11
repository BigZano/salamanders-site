// The plate scene's input: one base64 JSON object in `?input=`, the mountain the page builds for this plate's profile and
// bucket (src/lib/mountain.js buildMountain, in the reference size's pixels), turned into the scene's canvas pixels.
//
// {
//   mountain: buildMountain's fields (peakX, peakY, craterHalf, left, right, rimL, rimR, crown, mouthL, mouthR, valley,
//             vent, valleyDepth, litL, litR) plus `pool` ({ cx, cy, rx, ry, arcTop }, the lava network's pool rule) and,
//             optionally, `lip` ({ x, y }),
//   channels?: [[{ x, y }, ...], ...]  where the lava will run (the network's streams); the baked glow follows them,
//   size: { w, h }                    the bucket's reference size, before the bleed,
//   bleed: 0.1                        extra picture on every side, as a fraction of the size,
//   bucket, profile: { key, slug },   carried for the record,
//   seed: number                      the only source of noise,
// }
//
// The canvas is the size plus the bleed on every side; every point moves by the bleed. Pure: no DOM, no three.

/** @returns {object} the JSON inside a base64 string: standard or url-safe, padded or not, "+" turned to " " or not */
export function decodeInput(b64) {
  const s = String(b64 ?? '')
    .trim()
    .replace(/ /g, '+')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  if (!s) throw new Error('plate input: empty')
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4)
  try {
    return JSON.parse(atob(padded))
  } catch (e) {
    throw new Error(`plate input: not base64 JSON (${e.message})`)
  }
}

const isPoint = (v) => v !== null && typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number'
const movePoint = (p, dx, dy) => ({ ...p, x: p.x + dx, y: p.y + dy })

function movePool(pool, dx, dy) {
  const out = { ...pool }
  if (typeof pool.cx === 'number') out.cx = pool.cx + dx
  if (typeof pool.cy === 'number') out.cy = pool.cy + dy
  if (typeof pool.arcTop === 'number') out.arcTop = pool.arcTop + dy
  return out
}

/**
 * The mountain moved by (dx, dy): every point and list of points, `peakX` and `peakY`, the pool's centre and arc top.
 * Scalars (`craterHalf`, `valleyDepth`, the pool's radii) stay. Returns new objects throughout and never touches its
 * input: buildMountain's output aliases points (`mouthL` is `valley[0]`), and each copy is moved exactly once.
 */
export function offsetMountain(m, dx, dy) {
  const out = {}
  for (const [k, v] of Object.entries(m)) {
    if (k === 'peakX') out[k] = v + dx
    else if (k === 'peakY') out[k] = v + dy
    else if (k === 'pool' && v && typeof v === 'object') out[k] = movePool(v, dx, dy)
    else if (isPoint(v)) out[k] = movePoint(v, dx, dy)
    else if (Array.isArray(v)) out[k] = v.map((p) => (isPoint(p) ? movePoint(p, dx, dy) : p))
    else out[k] = v
  }
  return out
}

/**
 * The scene's input from `?input=`: `{ canvas: { w, h }, offset: { x, y }, mountain, channels, seed, size, bleed, bucket,
 * profile }`, the mountain and the channels in canvas pixels. Throws a message naming what is missing.
 */
export function parseInput(b64) {
  const input = decodeInput(b64)
  const { mountain, size, bleed, seed } = input ?? {}
  if (!mountain || typeof mountain.peakX !== 'number' || typeof mountain.peakY !== 'number') throw new Error('plate input: no mountain')
  if (!size || !(size.w > 0) || !(size.h > 0)) throw new Error('plate input: no size')
  if (!(bleed >= 0)) throw new Error('plate input: no bleed')
  if (!Number.isFinite(seed)) throw new Error('plate input: no seed')
  const offset = { x: bleed * size.w, y: bleed * size.h }
  const canvas = { w: Math.round(size.w + 2 * offset.x), h: Math.round(size.h + 2 * offset.y) }
  const channels = (input.channels ?? []).map((line) => line.map((p) => movePoint(p, offset.x, offset.y)))
  return {
    canvas,
    offset,
    mountain: offsetMountain(mountain, offset.x, offset.y),
    channels,
    seed,
    size: { w: size.w, h: size.h },
    bleed,
    bucket: input.bucket ?? null,
    profile: input.profile ?? null,
  }
}
