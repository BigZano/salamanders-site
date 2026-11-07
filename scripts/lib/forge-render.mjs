/**
 * Pure helpers for scripts/forge-render.mjs, the headless render and smoke harness for the volcano. Nothing here
 * touches Chrome, the network or the disk, so it can be tested without any of them.
 */

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

/** Where Chrome is looked for, in order, for the error message when none is found. */
export const chromeCandidates = (env = {}) => (env.CHROME ? [env.CHROME, ...CHROME_PATHS] : CHROME_PATHS)

/**
 * The Chrome to launch: `CHROME` if it names a real file, else the first known install that exists, else null.
 * `exists` is passed in so the lookup is testable without a disk.
 */
export function findChrome(env, exists) {
  return chromeCandidates(env).find((p) => exists(p)) ?? null
}

/**
 * The three viewports the grid renders at. Phone and tablet are mobile with a 2x screen, as a real one would be;
 * desktop is a plain 1x window.
 */
export const SIZES = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
  desktop: { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false },
}

// Every grid page opens frozen at the same second (?t=120) with the calm band off and the lava shader forced, so two
// renders differ only in what the grid varies: the moon's phase and the lava preset.
const FROZEN_AT = 120

/** `/` is `home`; any other path is itself with its slashes taken out (`/armoury` is `armoury`). */
const pathName = (path) => path.replace(/\//g, '') || 'home'

/**
 * Every combination of path, size, phase and preset, in that nesting order (the preset varies fastest), each with the
 * file name it renders to and the URL to open (relative to the dev server). A preset is `key=value` query params as
 * the volcano reads them in dev (`crust=0.3`, or `crust=0.3&heat=1.2`), or null for none.
 */
export function plan({ paths, sizes, phases, presets }) {
  const out = []
  for (const path of paths) {
    for (const size of sizes) {
      const dims = SIZES[size]
      if (!dims) throw new Error(`unknown size "${size}" (known: ${Object.keys(SIZES).join(', ')})`)
      for (const phase of phases) {
        for (const preset of presets) {
          const query = [`moon=${phase}`, `t=${FROZEN_AT}`, 'calm=0', 'lava=1']
          if (preset) query.push(preset)
          const label = [pathName(path), size, `p${phase}`]
          if (preset) label.push(preset.replace(/=/g, '').replace(/&/g, '-'))
          out.push({ name: label.join('-'), url: `${path}?${query.join('&')}`, ...dims })
        }
      }
    }
  }
  return out
}

/**
 * What an RGBA pixel buffer holds inside a rect (clipped to the buffer): the mean of each of r, g and b, the largest
 * single channel value, and whether any pixel is bright, which is to say hot lava (red above 200).
 */
export function probe(pixels, w, h, rect) {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(w, Math.floor(rect.x + rect.w))
  const y1 = Math.min(h, Math.floor(rect.y + rect.h))
  const sum = [0, 0, 0]
  let max = 0
  let bright = false
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        sum[c] += pixels[i + c]
        if (pixels[i + c] > max) max = pixels[i + c]
      }
      if (pixels[i] > 200) bright = true
      n++
    }
  }
  return { mean: n ? sum.map((s) => s / n) : [0, 0, 0], max, bright }
}

// The probe boxes, in CSS px. The head box sits just under the breach; the toe box is the end of the first arm; the
// levee box is small enough to fit in the rubble beside the narrowest sheet (about 6 px of it).
const HEAD_BOX = 24
const TOE_BOX = 24
const LEVEE_BOX = 4
// How far beside the sheet the levee box sits, in half widths. The rubble runs from 1 (the bank) to 2.2 (where it has
// faded out, the shader's LEVEE), so 1.6 is in the middle of it; at 2.2 the box would see bare rock and prove nothing.
const LEVEE_AT = 1.6

/**
 * The three rects the smoke probes read, in viewport CSS px, worked out from the volcano's `geometry()`:
 *   head     a box just below the breach, where the sheet is hottest
 *   toe      a box on the last point of the first arm (the first flow that is not the sheet)
 *   toeWide  the box around the lower 40 % of that arm, padded by its width, to look for any lava still moving
 *   levee    a small box beside the middle of the sheet, in the rubble
 * Returns null when the volcano has no sheet or no arm to probe (a phone with no flows, say).
 */
export function probeRects(geometry) {
  const { vent, flows } = geometry ?? {}
  const sheet = flows?.find((f) => f.head)
  const arm = flows?.find((f) => !f.head)
  if (!vent || !sheet || !arm || sheet.pts.length < 3 || arm.pts.length < 3) return null

  const head = { x: vent.x - HEAD_BOX / 2, y: vent.y, w: HEAD_BOX, h: HEAD_BOX }

  const end = arm.pts[arm.pts.length - 1]
  const toe = { x: end.x - TOE_BOX / 2, y: end.y - TOE_BOX / 2, w: TOE_BOX, h: TOE_BOX }

  const lower = arm.pts.slice(Math.floor(arm.pts.length * 0.6))
  const pad = (arm.widthAt0 ?? 0) + 4
  const xs = lower.map((p) => p.x)
  const ys = lower.map((p) => p.y)
  const x0 = Math.min(...xs) - pad
  const y0 = Math.min(...ys) - pad
  const toeWide = { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 }

  // beside the sheet's middle point: along the normal to its chord, the same convention the volcano draws with
  const mid = Math.floor((sheet.pts.length - 1) / 2)
  const a = sheet.pts[Math.max(0, mid - 1)]
  const b = sheet.pts[Math.min(sheet.pts.length - 1, mid + 1)]
  const len = Math.hypot(b.y - a.y, b.x - a.x) || 1
  const off = LEVEE_AT * ((sheet.widthMid ?? sheet.widthAt0 ?? 0) / 2)
  const cx = sheet.pts[mid].x - ((b.y - a.y) / len) * off
  const cy = sheet.pts[mid].y + ((b.x - a.x) / len) * off
  const levee = { x: cx - LEVEE_BOX / 2, y: cy - LEVEE_BOX / 2, w: LEVEE_BOX, h: LEVEE_BOX }

  return { head, toe, toeWide, levee }
}

/**
 * Whether the three probes pass, given the `probe()` result for each rect:
 *   head     something is bright: lava is pouring from the breach
 *   toe      mostly crust (mean red under 140) with some bright pixel along the lower arm: cooled at the end, alive behind it
 *   levee    roughly grey (red and green within 40 of each other, nothing above 160): rubble, not glowing lava
 */
export function judge({ head, toe, toeWide, levee }) {
  const result = {
    head: head.bright,
    toe: toe.mean[0] < 140 && toeWide.bright,
    levee: Math.abs(levee.mean[0] - levee.mean[1]) < 40 && levee.max < 160,
  }
  return { ...result, ok: result.head && result.toe && result.levee }
}

/**
 * The command line. Flags that take a list (`--paths`, `--sizes`, `--phases`, `--presets`) accept commas, spaces or
 * both (`--paths / /armoury` and `--sizes phone,desktop`); the rest take one value; `--smoke`, `--verbose` and `--gpu` take none.
 */
export function parseArgs(argv) {
  const lists = new Set(['paths', 'sizes', 'phases', 'presets'])
  const values = new Set(['base', 'out', 'throttle', 'chrome'])
  const flags = new Set(['smoke', 'verbose', 'gpu'])
  const raw = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`)
    const key = arg.slice(2)
    if (flags.has(key)) raw[key] = true
    else if (values.has(key)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`--${key} needs a value`)
      raw[key] = argv[++i]
    } else if (lists.has(key)) {
      const items = []
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) items.push(...argv[++i].split(',').filter(Boolean))
      if (!items.length) throw new Error(`--${key} needs a value`)
      raw[key] = items
    } else throw new Error(`unknown flag --${key}`)
  }

  const phases = (raw.phases ?? ['0.42']).map(Number)
  if (phases.some((p) => !Number.isFinite(p))) throw new Error(`--phases must be numbers, got ${raw.phases}`)
  const paths = raw.paths ?? ['/']
  const bad = paths.find((p) => !p.startsWith('/'))
  if (bad) throw new Error(`--paths must start with "/", got "${bad}" (Git Bash rewrites a bare / into a Windows path: run with MSYS_NO_PATHCONV=1)`)
  const throttle = raw.throttle === undefined ? null : Number(raw.throttle)
  if (throttle !== null && !(throttle >= 1)) throw new Error(`--throttle must be a number of 1 or more, got "${raw.throttle}"`)

  return {
    base: (raw.base ?? 'http://127.0.0.1:5191').replace(/\/+$/, ''),
    out: raw.out ?? '.forge/grid',
    paths,
    sizes: raw.sizes ?? ['phone', 'desktop'],
    phases,
    presets: raw.presets ?? [null],
    throttle,
    smoke: Boolean(raw.smoke),
    verbose: Boolean(raw.verbose),
    gpu: Boolean(raw.gpu),
    chrome: raw.chrome ?? null,
  }
}
