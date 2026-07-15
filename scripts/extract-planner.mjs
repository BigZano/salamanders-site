// One-off extractor: pulls classMeta / fallbackWeapons / categories out of the
// original 51MB planner HTML into clean JSON for the planner + armoury pages.
// Run: bun run scripts/extract-planner.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SOURCE = resolve(__dirname, '../../xviiith_legion_operations_planner_departments_pauldrons.html')
const DATA = resolve(__dirname, '../src/data')

const html = readFileSync(SOURCE, 'utf8')

// Slice a top-level literal between one `const X=` and the next declaration.
function grab(startDecl, endDecl) {
  const s = html.indexOf(startDecl)
  if (s === -1) throw new Error(`not found: ${startDecl}`)
  const eq = html.indexOf('=', s)
  const end = html.indexOf(endDecl, eq)
  let body = html.slice(eq + 1, end).trim().replace(/;$/, '')
  return new Function(`return (${body})`)()
}

const categories = grab('const categories=', 'const fallbackWeapons=')
const fallbackWeapons = grab('const fallbackWeapons=', 'const classMeta=')
const classMeta = grab('const classMeta=', 'const classOrder=')

mkdirSync(DATA, { recursive: true })
writeFileSync(resolve(DATA, 'classes.json'), JSON.stringify(classMeta, null, 2) + '\n')
writeFileSync(
  resolve(DATA, 'weapons.json'),
  JSON.stringify({ categories, fallbackWeapons }, null, 2) + '\n',
)

const nClasses = Object.keys(classMeta).length
const nWeapons = Object.values(fallbackWeapons).reduce((n, a) => n + a.length, 0)
console.log(`Wrote ${nClasses} classes, ${nWeapons} weapons`)
