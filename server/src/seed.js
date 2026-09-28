/**
 * One-off: seed perk corrections from a document (the shape of
 * GET /perk-corrections, e.g. src/data/perk-corrections.json) read on stdin.
 * Idempotent: does nothing if the system author already has rows.
 *
 *   docker compose exec -T api bun run src/seed.js < ../src/data/perk-corrections.json
 */
import { Pool } from 'pg'
import { createHistoryStore } from './historyStore.js'
import { flattenDocument } from './perkCorrectionsCore.js'

const SYSTEM = { id: '0', username: 'system (error report 2026-09-27)' }

const doc = JSON.parse(await Bun.stdin.text())
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const n = await createHistoryStore(pool).seedCorrections(flattenDocument(doc), SYSTEM)
console.log(n ? `Seeded ${n} perk corrections.` : 'Already seeded — nothing to do.')
await pool.end()
