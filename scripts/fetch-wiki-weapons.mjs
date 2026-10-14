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
import { fetchPage, sleep } from './lib/wiki.mjs'
import { buildTree } from './lib/weapon-parse.mjs'
import weapons from '../src/data/weapons.json' with { type: 'json' }

const OUT = new URL('../src/data/weapon-trees.json', import.meta.url)

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
