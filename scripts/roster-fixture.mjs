/**
 * Builds src/data/roster.fixture.json: a SYNTHETIC roster (invented names, the
 * real role structure) for designing the page without the live server. It runs
 * the real buildRoster/buildInfirmary over made-up guild members, so the
 * fixture can never drift from the API contract. Real member data never goes
 * here (the repo is public).
 *
 *   node scripts/roster-fixture.mjs
 */
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { buildInfirmary, buildRoster } from '../server/src/rosterCore.js'
import * as L from '../server/src/rosterLadder.js'

const GUILD = '1322056087792521269'
const OUT = new URL('../src/data/roster.fixture.json', import.meta.url)
const FETCHED_AT = '2026-01-01T12:00:00.000Z'

const FIRST = ['Aurelian', 'Cassivel', 'Drusus', 'Evander', 'Fabrian', 'Galen', 'Hadrian', 'Ignatius', 'Justin', 'Kaelen', 'Lucan', 'Marcian', 'Nerius', 'Octavian', 'Perrin', 'Quintus']
const LAST = ['Ashgrave', 'Brandt', 'Cinder', 'Dross', 'Emberly', 'Flint', 'Garrow', 'Holt', 'Ironside', 'Jorrik', 'Kestrel', 'Lowe', 'Marrow', 'Nightshade', 'Oakheart']

const co = (n) => L.COMPANIES[n - 1].roleId
const cmd = (n) => L.COMPANIES[n - 1].commandRoleIds[0]
const cr = (key) => L.COMPANY_RANKS.find((r) => r.key === key)
const spec = (key) => L.SPECIALTIES.find((s) => s.key === key)

export function syntheticGuild() {
  let n = 0
  const members = []
  /** One made-up member. Ids are 18-digit and start with 9: synthetic and unmistakable in the fixture. A real account could in theory share the range, but no real data attaches to these. */
  const person = (roles, { name, bot = false } = {}) => {
    const i = n++
    const id = String(900000000000000000n + BigInt(i))
    const label = name ?? `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`
    members.push({ nick: label, roles: [...roles], user: { id, username: `fx${i}`, global_name: null, ...(bot ? { bot: true } : {}) } })
  }
  const add = (roles, opts) => person([L.LEGION_ROLE, ...roles], opts)

  // High Command, with a Pyre Guard standing in as 2nd Company's acting head,
  // and the Chapter Master also the 4th Company's Captain (banner and head row).
  add([L.HIGH_COMMAND[0].id])
  add([L.HIGH_COMMAND[2].id, co(2), cmd(2)])
  add([L.HIGH_COMMAND[2].id])
  add([L.HIGH_COMMAND[3].id, L.CAPTAIN.id, co(4), cmd(4)])
  add([L.HIGH_COMMAND[4].id])

  // Companies. 2nd is run by the acting head; 4th by the High Command Captain above; 6th has nobody, so it is vacant.
  for (const c of L.COMPANIES) {
    const k = c.number
    if (k !== 2 && k !== 4 && k !== 6) add([L.CAPTAIN.id, c.roleId, c.commandRoleIds[0]])
    for (let i = 0; i < 2; i++) add([cr('lieutenant').id, c.roleId])
    add([(k % 2 ? cr('company-ancient') : cr('company-champion')).id, c.roleId])
    add([cr('veteran-sergeant').id, c.roleId])
    for (let i = 0; i < 3; i++) add([cr('sergeant').id, c.roleId])
    add([cr('terminator').id, c.roleId])
    for (let i = 0; i < 3; i++) add([cr('company-veteran').id, c.roleId])
    for (let i = 0; i < 6; i++) add([cr('battle-brother').id, c.roleId])
    for (let i = 0; i < (k === 7 ? 24 : 3); i++) add([cr('scout').id, c.roleId])
  }
  add([cr('sergeant').variants[0].id, co(1)]) // a Firedrake Sergeant
  add([cr('sergeant').variants[1].id, co(7)]) // a Scout Sergeant
  add([cr('company-veteran').variants[0].id]) // a Firedrake Veteran with no company role: implies 1st
  add([cr('battle-brother').id, co(3), co(5)]) // two companies: 3rd decides, 5th is "also"
  add([cr('battle-brother').id, co(3)], { name: 'Marcian Flint 5th Co.' }) // name claims a different company

  // Dreadnoughts: Venerable ones are their own branch; the rest sit aside in their company.
  add([L.VENERABLE_DREADNOUGHT.id, co(5)])
  add([L.VENERABLE_DREADNOUGHT.id, co(1)])
  add([L.DREADNOUGHTS[0].id, co(4)])
  add([L.DREADNOUGHTS[1].id, co(1)])

  // Specialties, some with company tags.
  for (const s of L.SPECIALTIES) {
    for (let i = 0; i < (s.key === 'forge' ? 2 : 1); i++) add([s.head.id, ...(i === 0 ? [] : [co(1)])])
    s.ranks.forEach((r, ri) => {
      for (let i = 0; i < 2; i++) add([r.id, ...(i === 0 ? [co(((ri + i) % 7) + 1)] : [])])
    })
  }
  add([spec('reclusiam').ranks[0].variants[0].id]) // a Firedrake Chaplain with no company role

  // Legion members with no company or specialty role, and one with no rank at all.
  for (let i = 0; i < 4; i++) add([cr('battle-brother').id])
  add([])

  // Servitors: a bot, a Servo-Skulls holder, and a viewing account known by name.
  add([co(1)], { name: 'Smith-Servitor', bot: true })
  add([L.SERVO_SKULLS_ROLE], { name: 'Eye Servo Skull' })
  add([], { name: 'Rune Viewing Servitor' })

  // Never listed: the shared admin account, and someone without the Legion role.
  add([L.VOICE_OF_VULKAN_ROLE], { name: 'Voice of Vulkan' })
  person([cr('battle-brother').id], { name: 'Fixture Outsider' })

  // The Infirmary: still carrying the Legion role, rank-stripped, and never Legion.
  add([L.INFIRMARY_ROLE, cr('battle-brother').id, co(3)])
  add([L.INFIRMARY_ROLE, spec('forge').ranks[1].id, co(2)])
  add([L.INFIRMARY_ROLE, cr('scout').id, co(7)])
  add([L.INFIRMARY_ROLE])
  person([L.INFIRMARY_ROLE, cr('battle-brother').id, co(4)])
  person([L.INFIRMARY_ROLE])

  return members
}

export function buildFixture() {
  const guild = syntheticGuild()
  const roster = { fetchedAt: FETCHED_AT, stale: false, viewer: { infirmary: true }, ...buildRoster(guild, { guildId: GUILD }) }
  const members = buildInfirmary(guild, { guildId: GUILD })
  return { _fixture: true, roster, infirmary: { fetchedAt: FETCHED_AT, stale: false, count: members.length, members } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile(OUT, JSON.stringify(buildFixture(), null, 2) + '\n')
  console.log(`Wrote ${OUT.pathname}`)
}
