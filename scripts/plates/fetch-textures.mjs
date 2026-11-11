// The plate scene's rock: four Poly Haven sets at 1K, into scripts/plates/scene/textures/ (gitignored). Run once per
// machine before rendering plates. The repo carries the plates, never these files.
//
// Sets (Poly Haven, CC0 1.0, https://polyhaven.com/license): dark_rock, dark_rock_02, rock_face_03, cliff_side.
// Maps per set: diffuse (sRGB), nor_gl (OpenGL normal), rough, ao. The scene samples dark_rock, dark_rock_02 and
// rock_face_03's normals today; cliff_side is kept for the mock's look.
//
// usage: node scripts/plates/fetch-textures.mjs [--force]
// Sends nothing but a generic User-Agent.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SETS = ['dark_rock', 'dark_rock_02', 'rock_face_03', 'cliff_side']
export const MAPS = ['diffuse', 'nor_gl', 'rough', 'ao']
export const RES = '1k'
const API = 'https://api.polyhaven.com/files/'
const HEADERS = { 'User-Agent': 'plate-textures/1.0' }

// The API's key for each map, matched without regard to case: { Diffuse, nor_gl, Rough, AO } today.
const KEYS = { diffuse: ['diffuse', 'diff'], nor_gl: ['nor_gl'], rough: ['rough'], ao: ['ao'] }

/** @returns {string | null} the 1K jpg url of one map in a Poly Haven `files` listing, or null when it has none */
export function pickUrl(files, map, res = RES) {
  const wanted = KEYS[map] ?? [map]
  const key = Object.keys(files ?? {}).find((k) => wanted.includes(k.toLowerCase()))
  return key ? (files[key]?.[res]?.jpg?.url ?? null) : null
}

/** @returns {string} where a map lands on disk */
export const texturePath = (root, set, map) => join(root, set, `${map}.jpg`)

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), 'scene', 'textures')
  const force = process.argv.includes('--force')
  let failed = 0
  for (const set of SETS) {
    const res = await fetch(API + set, { headers: HEADERS })
    if (!res.ok) throw new Error(`${set}: the file list answered ${res.status}`)
    const files = await res.json()
    for (const map of MAPS) {
      const out = texturePath(root, set, map)
      if (!force && existsSync(out)) {
        console.log(`${set}/${map}.jpg  kept (${statSync(out).size} bytes)`)
        continue
      }
      const url = pickUrl(files, map)
      if (!url) {
        console.error(`${set}/${map}: no ${RES} jpg in the listing`)
        failed++
        continue
      }
      const img = await fetch(url, { headers: HEADERS })
      if (!img.ok) {
        console.error(`${set}/${map}: ${img.status} from ${url}`)
        failed++
        continue
      }
      const buf = Buffer.from(await img.arrayBuffer())
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, buf)
      console.log(`${set}/${map}.jpg  ${buf.length} bytes`)
    }
  }
  return failed ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.message ?? e)
      process.exit(1)
    },
  )
}
