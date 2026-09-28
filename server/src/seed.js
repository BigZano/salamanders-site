/**
 * One-off: seed perk corrections from a document (the shape of
 * GET /perk-corrections, e.g. src/data/perk-corrections.json) read on stdin.
 * Idempotent: does nothing if the system author already has rows.
 *
 * Each edit/remove gets the same history `before` a live correction records,
 * computed against the bake (BAKE_BASE_URL, or the repo's main branch — the
 * API image doesn't ship src/data). If the bake can't be loaded it seeds
 * without `before` and says so, rather than failing.
 *
 *   docker compose exec -T api bun run src/seed.js < ../src/data/perk-corrections.json
 */
import { Pool } from 'pg'
import { createHistoryStore } from './historyStore.js'
import { flattenDocument, withBefore } from './perkCorrectionsCore.js'
import { createBakeLoader, DEFAULT_BAKE_BASE_URL } from './bake.js'

const SYSTEM = { id: '0', username: 'system (error report 2026-09-27)' }

const doc = JSON.parse(await Bun.stdin.text())
let list = flattenDocument(doc)
try {
  const bake = await createBakeLoader({ baseUrl: process.env.BAKE_BASE_URL || DEFAULT_BAKE_BASE_URL })()
  list = withBefore(list, bake)
} catch (err) {
  console.warn(`Warning: could not load the bake (${err.message}); seeding without before-state in history.`)
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const n = await createHistoryStore(pool).seedCorrections(list, SYSTEM)
console.log(n ? `Seeded ${n} perk corrections.` : 'Already seeded — nothing to do.')
await pool.end()
