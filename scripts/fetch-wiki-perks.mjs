/**
 * Bake class perk data from the Space Marine 2 wiki into src/data/perk-details.json.
 *
 * The original planner fetched this live on every visit, so prestige perks and
 * full perk descriptions only appeared after a successful sync. Baking it means
 * the site ships with the text already in hand: no spinner, no CORS risk, works
 * offline. Re-run after a game patch:
 *
 *   bun run wiki:perks
 */
import { writeFile } from 'node:fs/promises'
import { fetchPage, tableAfter, rowsOf } from './lib/wiki.mjs'
import classes from '../src/data/classes.json' with { type: 'json' }

const OUT = new URL('../src/data/perk-details.json', import.meta.url)

/**
 * Both the "Perk List" and "Prestige Perk" tables use a rowspan on the level
 * cell, so only the first perk of each level carries its number. A 3-cell row
 * opens a new level; 2-cell rows inherit the level above.
 */
function levelledPerks(table) {
  const out = []
  let level = null
  for (const cells of rowsOf(table)) {
    let name, description
    if (cells.length >= 3) {
      const n = parseInt(cells[0], 10)
      if (Number.isFinite(n)) level = n
      ;[, name, description] = cells
    } else {
      ;[name, description] = cells
    }
    if (!name || !description || name === description) continue
    out.push({ level, name, description })
  }
  return out
}

async function run() {
  const names = Object.keys(classes)
  const data = {}
  let warnings = 0

  for (const name of names) {
    const doc = await fetchPage(name)

    const perkList = levelledPerks(tableAfter(doc, 'Perk List'))
    const prestige = levelledPerks(tableAfter(doc, 'Prestige Perk'))

    // Key descriptions by perk name so the planner can look them up directly
    // from the grid it already has in classes.json.
    const perks = {}
    for (const p of perkList) perks[p.name] = { level: p.level, description: p.description }

    // Every name in the class grid should have found a description.
    const grid = classes[name].rows.flat()
    const missing = grid.filter((p) => !perks[p])
    if (missing.length) {
      warnings++
      console.warn(`  ! ${name}: no wiki description for ${missing.length}: ${missing.join(', ')}`)
    }

    data[name] = { perks, prestige }
    console.log(
      `  ${name}: ${perkList.length} perks, ${prestige.length} prestige, ${grid.length - missing.length}/${grid.length} matched`,
    )
  }

  await writeFile(OUT, JSON.stringify({ fetched: new Date().toISOString(), classes: data }, null, 2))
  console.log(`\nWrote ${OUT.pathname}${warnings ? ` (${warnings} class(es) with gaps)` : ''}`)
}

run().catch((err) => {
  console.error(`\nBake failed: ${err.message}`)
  process.exit(1)
})
