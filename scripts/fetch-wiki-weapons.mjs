/**
 * Bake every weapon's perk tree from the wiki into src/data/weapon-trees.json.
 *
 * The Armoury and the Perk Builder's loadout used to fetch each tree live on
 * first open. Baking makes them instant and keeps the site working when Fandom
 * is slow or unreachable; the live fetch stays as a fallback for weapons that
 * aren't in the bake yet.
 *
 *   bun run wiki:weapons
 *   bun run wiki:weapons -- --keep-perks
 *
 * --keep-perks keeps the perk lists and budgets already in the bake for weapons
 * that are in it, and takes only the fresh versions (stats, defence type),
 * meta and intro. The wiki has drifted from the patch notes in places; this
 * lets a re-bake pick up new weapons and stats without adopting every
 * uncorroborated perk edit. What it held back is printed as a drift report.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fetchPage, sleep } from './lib/wiki.mjs'
import { buildTree, mergeTrees } from './lib/weapon-parse.mjs'
import { listDrift } from './lib/drift.mjs'
import weapons from '../src/data/weapons.json' with { type: 'json' }

const OUT = new URL('../src/data/weapon-trees.json', import.meta.url)
const KEEP_PERKS = process.argv.includes('--keep-perks')

async function readPrevious() {
  try {
    return JSON.parse(await readFile(OUT, 'utf8')).weapons || {}
  } catch {
    return {}
  }
}

const perkItems = (tree) => tree.perks.map((p) => ({ key: `${p.quality}|${p.name}`, text: p.description }))

const statsOf = (v) => JSON.stringify({ g: Object.fromEntries(Object.entries(v.gauges).map(([k, x]) => [k, x.raw])), f: v.figures })

/** What --keep-perks held back: perk edits per weapon, then version stat edits. */
function reportHeld(previous, fresh) {
  const total = { wording: 0, numeric: 0, added: 0, removed: 0, stats: 0 }
  for (const [name, f] of Object.entries(fresh)) {
    const p = previous[name]
    if (!p?.perks?.length) continue
    const d = listDrift(perkItems(p), perkItems(f))
    const n = {
      wording: d.changed.filter((c) => c.kind === 'wording').length,
      numeric: d.changed.filter((c) => c.kind === 'numeric').length,
      added: d.added.length,
      removed: d.removed.length,
    }
    for (const k of Object.keys(n)) total[k] += n[k]
    if (Object.values(n).some(Boolean)) {
      console.log(`  held ${name}: ${n.wording} wording, ${n.numeric} numeric, ${n.added} added, ${n.removed} removed`)
      for (const c of d.changed.filter((c) => c.kind === 'numeric')) console.log(`      ${c.key}: "${c.old}" -> "${c.new}"`)
    }
  }
  console.log(`\nHeld in total: ${total.wording} wording, ${total.numeric} numeric, ${total.added} added, ${total.removed} removed`)

  for (const [name, f] of Object.entries(fresh)) {
    const before = new Map((previous[name]?.versions || []).map((v) => [v.name, v]))
    const listed = new Map()
    for (const v of f.versions) listed.set(v.name, (listed.get(v.name) || 0) + 1)
    for (const [version, n] of listed) {
      if (n > 1) console.log(`  held duplicate ${name} / ${version}: the wiki lists it ${n} times, the baked version is kept`)
    }
    for (const v of f.versions) {
      const was = before.get(v.name)
      if (listed.get(v.name) === 1 && was && statsOf(was) !== statsOf(v)) {
        total.stats++
        console.log(`  held stats ${name} / ${v.name}: ${statsOf(was)} -> ${statsOf(v)}`)
      }
    }
    const now = new Set(f.versions.map((v) => v.name))
    for (const v of before.values()) if (!now.has(v.name)) console.log(`  held version ${name} / ${v.name}: dropped on the wiki, kept`)
  }
  console.log(`Held version stat edits: ${total.stats}`)
}

async function run() {
  const names = [...new Set(Object.values(weapons.fallbackWeapons).flat())]
  const trees = {}
  const failed = []

  for (const name of names) {
    try {
      const doc = await fetchPage(name)
      trees[name] = buildTree(doc)
      const t = trees[name]
      console.log(
        `  ${name}: ${t.perks.length} perks${t.perksPending ? ' (pending)' : ''}, budget ${t.budget}, ${t.versions.length} versions`,
      )
    } catch (err) {
      failed.push(`${name} (${err.message})`)
      console.warn(`  ! ${name}: ${err.message}`)
    }
    await sleep(250) // be polite to Fandom
  }

  const previous = await readPrevious()
  if (KEEP_PERKS) reportHeld(previous, trees)
  const merged = mergeTrees(previous, trees, { keepPerks: KEEP_PERKS })

  await writeFile(
    OUT,
    JSON.stringify({ fetched: new Date().toISOString(), weapons: merged }, null, 2),
  )
  console.log(
    `\nWrote ${Object.keys(merged).length} weapon trees (${Object.keys(trees).length}/${names.length} fetched) to ${OUT.pathname}`,
  )
  if (failed.length) console.log(`Not baked (live fetch will cover these): ${failed.join(', ')}`)
}

run().catch((err) => {
  console.error(`\nBake failed: ${err.message}`)
  process.exit(1)
})
