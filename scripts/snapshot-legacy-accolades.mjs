/**
 * Snapshot the retired accolade roles and their holders into archive-export/legacy-accolades.json,
 * the gitignored input of the Legacy Accolades page (see
 * docs/superpowers/specs/2026-10-16-legacy-accolades-design.md). Read-only against Discord.
 *
 *   DISCORD_BOT_TOKEN=... node scripts/snapshot-legacy-accolades.mjs --roles <id>,<id>,... [--prune] [--fresh] [--out <file>]
 *
 * Merges into the file if it exists: blurbs and order are kept, holders only accumulate (--prune
 * drops anyone the new pull does not show), and a role already deleted in Discord keeps its stored
 * entry. A new role gets an empty blurb, which the seal audit rejects until it is written.
 * Once archive.lock.json says the legacy accolades were published, a run with no snapshot file to add to is refused
 * (restore it with `seal-archive unseal`), unless --fresh says starting over is meant.
 * Needs the bot's GUILD_MEMBERS intent, like scripts/fetch-discord-members.mjs.
 * Prints ids and counts only; the file itself holds names and must never be committed.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { GUILD_ID } from '../src/lib/archive/registry.js'
import { auditLegacy, canonicalLegacy } from '../src/lib/archive/legacy.js'
import { createDiscord } from './lib/discord.mjs'
import { buildSnapshot, checkStartingPoint } from './lib/legacy-snapshot.mjs'

const { values } = parseArgs({
  options: {
    roles: { type: 'string' },
    out: { type: 'string', default: 'archive-export/legacy-accolades.json' },
    prune: { type: 'boolean', default: false },
    fresh: { type: 'boolean', default: false },
    lock: { type: 'string', default: 'archive.lock.json' },
  },
})
const token = process.env.DISCORD_BOT_TOKEN
if (!token) {
  console.error('DISCORD_BOT_TOKEN not set.')
  process.exit(1)
}
if (!values.roles) {
  console.error('usage: snapshot-legacy-accolades --roles <id>,<id>,... [--prune] [--fresh] [--out <file>]')
  process.exit(2)
}

async function run() {
  const existing = await readFile(values.out, 'utf8').then(JSON.parse, (e) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  const lock = await readFile(values.lock, 'utf8').then(JSON.parse, (e) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  checkStartingPoint({ existing, lock, fresh: values.fresh })
  const discord = createDiscord({ token, log: console.log })
  const roles = await discord.fetchRoles(GUILD_ID)
  const members = await discord.fetchAllMembers(GUILD_ID)
  const { legacy, report } = buildSnapshot({
    existing, roles, members, roleIds: values.roles.split(',').map((s) => s.trim()), now: new Date(), prune: values.prune,
  })

  // 0o600: the file holds member names. The mode only applies when the file is created.
  await writeFile(values.out, canonicalLegacy(legacy), { mode: 0o600 })

  console.log(`\npulled ${roles.length} roles and ${members.length} members; wrote ${legacy.accolades.length} accolades to ${values.out}`)
  for (const a of legacy.accolades) console.log(`  ${a.roleId}: ${a.holders.length} holders${a.blurb ? '' : ', blurb missing'}`)
  for (const [id, n] of Object.entries(report.keptAbsent)) if (n) console.log(`  ${id}: ${n} recorded holders are no longer shown (kept; --prune drops them)`)
  if (report.missingRoles.length) console.log(`  roles no longer in the guild (stored entry kept): ${report.missingRoles.join(', ')}`)
  if (report.nameless.length) console.log(`  members with no usable display name, named by id: ${report.nameless.join(', ')}`)
  const problems = auditLegacy(legacy)
  if (problems.length) console.log(`\nnot ready to seal yet (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`)
  if (report.unknownRoles.length) {
    console.error(`\nrequested roles that are not in the guild and were never recorded: ${report.unknownRoles.join(', ')}`)
    process.exitCode = 1
  }
}

run().catch((err) => {
  console.error(`\nSnapshot failed: ${err.message}`)
  process.exit(1)
})
