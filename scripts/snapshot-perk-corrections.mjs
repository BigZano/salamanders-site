/**
 * Refresh src/data/perk-corrections.json from the live API before a build,
 * so the site's offline fallback is current. Never fails the build: on any
 * problem the committed snapshot stays.
 *
 *   VITE_BUILDS_API_URL=https://… bun run perks:snapshot
 */
import { writeFile } from 'node:fs/promises'

const OUT = new URL('../src/data/perk-corrections.json', import.meta.url)
const base = process.env.VITE_BUILDS_API_URL

if (!base) {
  console.log('VITE_BUILDS_API_URL unset — keeping the committed perk corrections snapshot.')
} else {
  try {
    const res = await fetch(`${base}/perk-corrections`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`API responded ${res.status}`)
    const doc = await res.json()
    if (!doc?.weapons || !doc?.classes) throw new Error('unexpected document shape')
    await writeFile(OUT, JSON.stringify(doc, null, 2) + '\n')
    const n = [...Object.values(doc.weapons), ...Object.values(doc.classes)].reduce((a, l) => a + l.length, 0)
    console.log(`Perk corrections snapshot: ${n} active corrections (${doc.version}).`)
  } catch (err) {
    console.warn(`Keeping the committed perk corrections snapshot: ${err.message}`)
  }
}
