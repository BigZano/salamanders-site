// One-off extractor: pulls the `chapterEntries` data out of the original
// 51MB planner HTML and writes it as clean JSON for the Companies page.
// Run: bun run scripts/extract-companies.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
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

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8')

const sections = data.reduce((n, e) => n + (e.sections?.length || 0), 0)
console.log(`Wrote ${data.length} companies / ${sections} sections -> ${OUT}`)
