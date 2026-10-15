/**
 * Bake class perk data from the Space Marine 2 wiki into src/data/perk-details.json
 * and each class's perk grid (`rows`) into src/data/classes.json.
 *
 * The original planner fetched this live on every visit, so prestige perks and
 * full perk descriptions only appeared after a successful sync. Baking it means
 * the site ships with the text already in hand: no spinner, no CORS risk, works
 * offline. Re-run after a game patch:
 *
 *   bun run wiki:perks
 *   bun run wiki:perks -- --classes Tactical
 *
 * Every class is read from the wiki, then src/data/patch-overrides.json (the
 * places we know better than the wiki, each with its sources) is applied.
 *
 * --classes A,B adopts the wiki for the named classes only. Every other class is
 * held at its previous bake, and what the wiki says differently is printed as a
 * drift report instead. The wiki has drifted from the official patch notes in
 * places; this lets a re-bake adopt the classes we have checked without taking
 * every uncorroborated edit. With no flag, every class is adopted.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fetchPage, tableAfter, rowsOf } from './lib/wiki.mjs'
import { listDrift } from './lib/drift.mjs'
import { deriveRows, applyOverrides, holdClasses } from './lib/patch-overrides.mjs'
import classes from '../src/data/classes.json' with { type: 'json' }
import overrides from '../src/data/patch-overrides.json' with { type: 'json' }

const OUT = new URL('../src/data/perk-details.json', import.meta.url)
const CLASSES_OUT = new URL('../src/data/classes.json', import.meta.url)

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

/** The classes named by --classes, or every class when the flag is absent. */
function adoptedClasses(all) {
  const i = process.argv.findIndex((a) => a === '--classes' || a.startsWith('--classes='))
  if (i < 0) return all
  const raw = process.argv[i].includes('=') ? process.argv[i].split('=')[1] : process.argv[i + 1]
  const picked = (raw || '').split(',').map((s) => s.trim()).filter(Boolean)
  const unknown = picked.filter((c) => !all.includes(c))
  if (!picked.length || unknown.length) {
    throw new Error(`--classes needs known class names (${all.join(', ')}); got ${raw ?? 'nothing'}`)
  }
  return picked
}

/** One class as the wiki and our overrides say it is. */
async function readClass(name) {
  const doc = await fetchPage(name)
  const wiki = {
    perkList: levelledPerks(tableAfter(doc, 'Perk List')),
    prestige: levelledPerks(tableAfter(doc, 'Prestige Perk')),
  }
  const applied = applyOverrides(name, wiki, overrides)
  const warnings = [...applied.warnings]

  const names = applied.perkList.map((p) => p.name)
  const repeated = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
  if (repeated.length) warnings.push(`${name}: the grid names ${repeated.join(', ')} more than once`)

  // Key descriptions by perk name so the planner can look them up directly
  // from the grid it already has in classes.json.
  const perks = {}
  for (const p of applied.perkList) perks[p.name] = { level: p.level, description: p.description }

  let rows = null
  let rowsError = null
  try {
    rows = deriveRows(applied.perkList)
  } catch (err) {
    rowsError = err.message
  }
  return { perks, prestige: applied.prestige, rows, rowsError, starting: applied.starting, warnings }
}

const perkItems = (perks) => Object.entries(perks).map(([key, p]) => ({ key, text: p.description }))
const prestigeItems = (list) => list.map((p) => ({ key: `${p.level}|${p.name}`, text: p.description }))

/** Grid slots whose perk differs between two row sets, as "L<level>: was -> now". */
function gridChanges(before, after) {
  const out = []
  for (let level = 2; level <= 25; level++) {
    const r = Math.floor((level - 2) / 8)
    const c = (level - 2) % 8
    if (before[r]?.[c] !== after[r]?.[c]) out.push(`L${level}: ${before[r]?.[c]} -> ${after[r]?.[c]}`)
  }
  return out
}

/** Everything the wiki says differently from the previous bake, for one class. */
function driftOf(name, fresh, previous) {
  const grid = fresh.rows ? gridChanges(classes[name].rows, fresh.rows) : []
  const perks = listDrift(perkItems(previous?.perks || {}), perkItems(fresh.perks))
  const prestige = listDrift(prestigeItems(previous?.prestige || []), prestigeItems(fresh.prestige))
  const changed = [...perks.changed, ...prestige.changed]
  return {
    grid,
    numeric: changed.filter((c) => c.kind === 'numeric'),
    wording: changed.filter((c) => c.kind === 'wording'),
    prestigeNames: { added: prestige.added, removed: prestige.removed },
  }
}

function printDrift(d) {
  for (const g of d.grid) console.log(`      grid ${g}`)
  for (const c of d.numeric) console.log(`      numeric ${c.key}: "${c.old}" -> "${c.new}"`)
  for (const c of d.wording) console.log(`      wording ${c.key}: "${c.old}" -> "${c.new}"`)
  const { added, removed } = d.prestigeNames
  if (added.length || removed.length) console.log(`      prestige CHANGED: -${removed.join(', -') || 'none'} +${added.join(', +') || 'none'}`)
}

async function run() {
  const all = Object.keys(classes)
  const adopt = adoptedClasses(all)
  const previous = JSON.parse(await readFile(OUT, 'utf8')).classes || {}
  const fresh = {}
  const read = {}

  for (const name of all) {
    const c = await readClass(name)
    read[name] = c
    fresh[name] = { perks: c.perks, prestige: c.prestige }

    const drift = driftOf(name, c, previous[name])
    if (adopt.includes(name)) {
      if (c.rowsError) throw new Error(`${name}: cannot derive the perk grid (${c.rowsError})`)
      console.log(`  ${name}: adopted, ${Object.keys(c.perks).length} perks, ${c.prestige.length} prestige, ${drift.grid.length} grid slot(s) changed, ${c.warnings.length} warning(s)`)
      printDrift(drift)
    } else {
      const grid = c.rowsError ? `grid unreadable (${c.rowsError})` : `${drift.grid.length} grid`
      const prestigeChanged = drift.prestigeNames.added.length || drift.prestigeNames.removed.length
      console.log(`  held ${name}: ${grid}, ${drift.numeric.length} numeric, ${drift.wording.length} wording${prestigeChanged ? ', prestige CHANGED' : ''}`)
      printDrift(drift)
    }
    for (const w of c.warnings) console.warn(`  ! ${w}`)
  }

  // classes.json: only `rows` and the starting perk text, only for adopted classes.
  const nextClasses = structuredClone(classes)
  let missingTotal = 0
  for (const name of adopt) {
    nextClasses[name].rows = read[name].rows
    if (read[name].starting) nextClasses[name].starting = read[name].starting
    const missing = nextClasses[name].rows.flat().filter((p) => !read[name].perks[p])
    if (missing.length) {
      missingTotal++
      console.warn(`  ! ${name}: no wiki description for ${missing.length}: ${missing.join(', ')}`)
    }
  }

  const details = holdClasses(previous, fresh, adopt)
  await writeFile(OUT, JSON.stringify({ fetched: new Date().toISOString(), classes: details }, null, 2))
  await writeFile(CLASSES_OUT, JSON.stringify(nextClasses, null, 2) + '\n')
  console.log(`\nAdopted ${adopt.join(', ')}; held ${all.filter((c) => !adopt.includes(c)).join(', ') || 'none'}.`)
  console.log(`Wrote ${OUT.pathname} and ${CLASSES_OUT.pathname}${missingTotal ? ` (${missingTotal} class(es) with gaps)` : ''}`)
}

run().catch((err) => {
  console.error(`\nBake failed: ${err.message}`)
  process.exit(1)
})
