/**
 * Bake every weapon's perk tree from the wiki into src/data/weapon-trees.json.
 *
 * The Armoury and the Perk Builder's loadout used to fetch each tree live on
 * first open. Baking makes them instant and keeps the site working when Fandom
 * is slow or unreachable; the live fetch stays as a fallback for weapons that
 * aren't in the bake yet.
 *
 *   bun run wiki:weapons
 */
import { writeFile } from 'node:fs/promises'
import {
  fetchPage,
  tableAfter,
  tableRecords,
  rowsOf,
  clean,
  normalizeQuality,
  sleep,
} from './lib/wiki.mjs'
import weapons from '../src/data/weapons.json' with { type: 'json' }

const OUT = new URL('../src/data/weapon-trees.json', import.meta.url)

/** The "Perk List" table: quality is rowspanned across its perks. */
function parsePerks(doc) {
  const rows = rowsOf(tableAfter(doc, 'Perk List'))
  const out = []
  let quality = ''
  for (const cells of rows) {
    const rowQuality = normalizeQuality(cells[0])
    if (rowQuality) quality = rowQuality

    let name, description
    if (rowQuality && cells.length >= 3) {
      ;[, name, description] = cells
    } else {
      name = cells[cells.length - 2]
      description = cells[cells.length - 1]
    }
    if (!name || !description || name === description || name.length > 100) continue
    out.push({ name, quality: quality || 'Unknown', description })
  }
  return out
}

/** Perk-point budget is the number of upgrade rows in the stats table. */
function parseBudget(doc) {
  const table = tableAfter(doc, 'In-game shown stats') || tableAfter(doc, 'Versions')
  if (!table) return 10
  const rows = table
    .querySelectorAll('tr')
    .filter((tr) => tr.querySelectorAll('td').length >= 2).length
  return Math.max(1, Math.min(30, rows || 10))
}

// Ranged pages rate Firepower/Accuracy/…; melee pages rate Strength/Speed/
// Cleaving Potential/Defence. Rather than hardcode either list, treat every
// column that isn't an identity or an absolute figure as a 0-10 gauge.
const IDENTITY = ['Quality', 'Version', 'Version Name']
const FIGURES = ['Magazine Capacity', 'Ammo Reserve']

/** "4+" reads as a half-step above 4 on the in-game bars. */
function ratingValue(raw) {
  const m = clean(raw).match(/^(\d+(?:\.\d+)?)\s*(\+)?/)
  if (!m) return null
  return Number(m[1]) + (m[2] ? 0.5 : 0)
}

/** Per-version stat lines from the "In-game shown stats" table. */
function parseVersions(doc) {
  const recs = tableRecords(tableAfter(doc, 'In-game shown stats'))
  return recs
    .map((r) => {
      const name = r['Version Name'] || r.Version || ''
      if (!name) return null

      const gauges = {}
      const figures = {}
      for (const [key, raw] of Object.entries(r)) {
        if (!key || !raw || IDENTITY.includes(key)) continue
        if (FIGURES.includes(key)) {
          figures[key] = raw
          continue
        }
        const value = ratingValue(raw)
        if (value !== null) gauges[key] = { value, raw }
      }

      return { quality: normalizeQuality(r.Quality) || r.Quality || '', name, gauges, figures }
    })
    .filter(Boolean)
}

/** Slot / category / damage type / usable classes, from the infobox. */
function parseMeta(doc) {
  const out = {}
  for (const d of doc.querySelectorAll('.portable-infobox .pi-data, aside .pi-data')) {
    const label = clean(d.querySelector('.pi-data-label')?.text)
    const value = clean(d.querySelector('.pi-data-value')?.text)
    if (!label || !value) continue
    if (/^slot$/i.test(label)) out.slot = value
    else if (/^category$/i.test(label)) out.category = value
    // The infobox concatenates damage types with no separator, e.g.
    // "Bullet(Bolter)Explosive(Grenade)" — split them back apart.
    else if (/damage type/i.test(label)) {
      out.damageType = value
        .replace(/\)(?=[A-Z])/g, ') · ')
        .replace(/([a-z])(?=[A-Z])/g, '$1 · ')
    }
  }
  return out
}

/** Lead paragraphs, which on these pages sit above the first section heading. */
function parseIntro(doc) {
  const out = []
  for (const p of doc.querySelectorAll('p')) {
    // Pages label the lead "Description: …"; the label isn't worth shipping.
    const t = clean(p.text).replace(/^Description:\s*/i, '')
    if (t) out.push(t)
    if (out.length >= 2) break
  }
  return out
}

async function run() {
  const names = [...new Set(Object.values(weapons.fallbackWeapons).flat())]
  const trees = {}
  const failed = []

  for (const name of names) {
    try {
      const doc = await fetchPage(name)
      const perks = parsePerks(doc)
      if (!perks.length) throw new Error('no readable perk table')
      const versions = parseVersions(doc)
      trees[name] = {
        perks,
        budget: parseBudget(doc),
        intro: parseIntro(doc),
        meta: parseMeta(doc),
        versions,
      }
      console.log(
        `  ${name}: ${perks.length} perks, budget ${trees[name].budget}, ${versions.length} versions`,
      )
    } catch (err) {
      failed.push(`${name} (${err.message})`)
      console.warn(`  ! ${name}: ${err.message}`)
    }
    await sleep(250) // be polite to Fandom
  }

  await writeFile(
    OUT,
    JSON.stringify({ fetched: new Date().toISOString(), weapons: trees }, null, 2),
  )
  console.log(
    `\nWrote ${Object.keys(trees).length}/${names.length} weapon trees to ${OUT.pathname}`,
  )
  if (failed.length) console.log(`Not baked (live fetch will cover these): ${failed.join(', ')}`)
}

run().catch((err) => {
  console.error(`\nBake failed: ${err.message}`)
  process.exit(1)
})
