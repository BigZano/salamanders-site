// One-off extractor: pulls the `chapterEntries` data out of the original
// 51MB planner HTML and writes it as clean JSON for the Companies page.
// Run: bun run scripts/extract-companies.mjs [--notables-out <file>]
//
// The Notable Server Members are real members' names, so they never go into companies.json: each card list
// becomes the marker `notables: true` (where the page puts the cards it gets from the server). The entries are
// kept only if --notables-out names a file OUTSIDE the repo; it is in the shape server/src/seedNotables.js reads
// ({ companyId: [[name, ...lines], ...] }).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const { values } = parseArgs({ options: { 'notables-out': { type: 'string' } } })
const notablesOut = values['notables-out'] ? resolve(values['notables-out']) : null
if (notablesOut) {
  const inside = relative(REPO, notablesOut)
  if (!inside.startsWith('..') && !isAbsolute(inside)) throw new Error('--notables-out must be outside the repo: it holds real names.')
}
const SOURCE = resolve(__dirname, '../../xviiith_legion_operations_planner_departments_pauldrons.html')
const OUT = resolve(__dirname, '../src/data/companies.json')

const html = readFileSync(SOURCE, 'utf8')

const marker = 'const chapterEntries='
const start = html.indexOf(marker)
if (start === -1) throw new Error('chapterEntries not found')
const arrStart = html.indexOf('[', start)

// The array is followed by `];` then `let state=`. Slice up to that boundary.
const stateIdx = html.indexOf('let state=', arrStart)
let slice = html.slice(arrStart, stateIdx)
slice = slice.replace(/;\s*$/, '').trim()

// Data literals only (no refs/calls), so evaluating is safe here.
const data = new Function(`return (${slice})`)()

// Take the real names out before anything is written to the repo.
const notables = {}
for (const company of data) {
  for (const s of company.sections ?? []) {
    if (!Array.isArray(s.notables)) continue
    notables[company.id] = [...(notables[company.id] ?? []), ...s.notables]
    s.notables = true
  }
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8')

const sections = data.reduce((n, e) => n + (e.sections?.length || 0), 0)
console.log(`Wrote ${data.length} companies / ${sections} sections -> ${OUT}`)

const members = Object.values(notables).reduce((n, list) => n + list.length, 0)
if (notablesOut) {
  writeFileSync(notablesOut, JSON.stringify(notables, null, 2) + '\n', 'utf8')
  console.log(`Wrote ${members} notable members for ${Object.keys(notables).length} companies -> ${notablesOut} (real names: never commit it)`)
} else {
  console.log(`Left out ${members} notable members. Pass --notables-out <file> (outside the repo) to keep them for the seed script.`)
}
