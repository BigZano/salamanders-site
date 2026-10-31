/**
 * One-off: store the Companies page's Notable Server Members in the database, from a document read on stdin (the
 * Companies data, src/data/companies.json, or an object of companyId → entries; see companyNotables.js).
 * Safe to re-run: each company in the document gets its entries replaced, the others are left alone.
 *
 * Prints counts only. The entries are real members' names, so nothing here echoes them, and a document that does
 * not parse is reported without the parser's message (which can quote the text around the fault).
 *
 *   docker compose exec -T api bun run src/seedNotables.js < ../src/data/companies.json
 */
import { Pool } from 'pg'
import { notablesFrom } from './companyNotables.js'
import { createCompanyNotablesStore } from './companyNotablesStore.js'

let doc
try {
  doc = JSON.parse(await Bun.stdin.text())
} catch {
  console.error('Not seeded: standard input is not valid JSON.')
  process.exit(1)
}

let pairs
try {
  pairs = notablesFrom(doc)
} catch (err) {
  console.error(`Not seeded: ${err.message}`)
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const stored = await createCompanyNotablesStore(pool).seed(pairs)
const members = pairs.reduce((n, [, entries]) => n + entries.length, 0)
console.log(`Stored ${members} notable members for ${stored} companies.`)
await pool.end()
