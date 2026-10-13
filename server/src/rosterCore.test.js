import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import * as L from './rosterLadder.js'
import { memberFacts } from './rosterMember.js'
import { buildInfirmary, buildRoster, commandTier, routeOf } from './rosterCore.js'

const GUILD = '1322056087792521269'
let seq = 0
const sf = () => String(200000000000000000n + BigInt(seq++))
/** A raw guild-member object as Discord returns it. */
const mem = (roles = [], { name = 'Brother Test', bot = false, id = sf() } = {}) => ({
  nick: name,
  roles,
  user: { id, username: `u${id}`, global_name: null, ...(bot ? { bot: true } : {}) },
})
const route = (roles, opts) => routeOf(memberFacts(mem(roles, opts), GUILD))

const co = (n) => L.COMPANIES[n - 1].roleId
const cmd = (n, i = 0) => L.COMPANIES[n - 1].commandRoleIds[i]
const cr = (key) => L.COMPANY_RANKS.find((r) => r.key === key).id

describe('routeOf', () => {
  const { LEGION_ROLE: LEG, INFIRMARY_ROLE: INF, SERVO_SKULLS_ROLE: SKULL, VOICE_OF_VULKAN_ROLE: VOICE } = L

  it('hides the Voice of Vulkan account above everything else', () => {
    expect(route([VOICE])).toBe('hidden')
    expect(route([VOICE, LEG, INF, SKULL, L.CAPTAIN.id], { bot: true })).toBe('hidden')
  })

  it('sends bots and Servo-Skulls holders to the servitors, Legion role or not, whatever else they hold', () => {
    expect(route([], { bot: true })).toBe('servitor')
    expect(route([LEG, co(1), cmd(1)], { bot: true })).toBe('servitor')
    expect(route([SKULL])).toBe('servitor')
    expect(route([SKULL, LEG, ...L.COMPANIES.map((c) => c.roleId)])).toBe('servitor')
    expect(route([SKULL, INF])).toBe('servitor')
    expect(route([INF], { bot: true })).toBe('servitor')
  })

  it('sends Infirmary holders to the Infirmary, Legion role or not, whatever else they hold', () => {
    expect(route([INF])).toBe('infirmary')
    expect(route([INF, LEG])).toBe('infirmary')
    expect(route([INF, LEG, L.HIGH_COMMAND[0].id, L.CAPTAIN.id])).toBe('infirmary')
    expect(route([INF], { name: 'Viewing Servitor' })).toBe('infirmary')
  })

  it('hides anyone without the Legion role', () => {
    expect(route([])).toBe('hidden')
    expect(route([L.CAPTAIN.id, co(3)])).toBe('hidden')
    expect(route([], { name: 'Viewing Servitor' })).toBe('hidden')
  })

  it('puts a Legion member on the roster', () => {
    expect(route([LEG])).toBe('roster')
    expect(route([LEG, cr('scout')])).toBe('roster')
  })

  it('sends a servitor-named Legion member with no placing role to the servitors', () => {
    expect(route([LEG], { name: 'Kestrel Viewing Servitor' })).toBe('servitor')
    expect(route([LEG], { name: 'Marrow’s Servo Skull' })).toBe('servitor')
    // roles that are not placing roles do not save them
    expect(route([LEG, cmd(1), L.LEGION_HIERARCHY_ROLE, '1'], { name: 'Smith-Servitor' })).toBe('servitor')
  })

  it('lets any placing role beat a servitor-looking name', () => {
    const placing = [
      L.HIGH_COMMAND[2].id, L.CAPTAIN.id, L.VENERABLE_DREADNOUGHT.id, L.DREADNOUGHTS[0].id,
      L.SPECIALTIES[0].head.id, L.SPECIALTIES[3].head.id, L.SPECIALTIES[1].ranks[1].id,
      cr('battle-brother'), L.COMPANY_RANKS[4].variants[0].id, L.SPECIALTIES[3].ranks[0].variants[0].id, co(5),
    ]
    for (const role of placing) expect(route([LEG, role], { name: 'Servitor Prime' }), role).toBe('roster')
  })

  it('does not treat lookalike names as servitors', () => {
    for (const name of ['Servitorial', 'Observo-Skulls', 'Servo Skullcap']) expect(route([LEG], { name }), name).toBe('roster')
  })

  it('follows one precedence over all 32 combinations of the five routing facts', () => {
    const expected = (v, b, s, i, l) => (v ? 'hidden' : b || s ? 'servitor' : i ? 'infirmary' : l ? 'roster' : 'hidden')
    for (let bits = 0; bits < 32; bits++) {
      const [v, b, s, i, l] = [0, 1, 2, 3, 4].map((k) => Boolean(bits & (1 << k)))
      const roles = [v && VOICE, s && SKULL, i && INF, l && LEG].filter(Boolean)
      expect(route(roles, { bot: b }), `voice=${v} bot=${b} skull=${s} inf=${i} legion=${l}`).toBe(expected(v, b, s, i, l))
    }
  })

  it('always returns one of the four routes', () => {
    const pool = [L.LEGION_ROLE, L.INFIRMARY_ROLE, L.SERVO_SKULLS_ROLE, L.VOICE_OF_VULKAN_ROLE, L.CAPTAIN.id, co(2), 'x']
    fc.assert(
      fc.property(fc.subarray(pool), fc.boolean(), fc.string(), (roles, bot, name) => {
        return ['hidden', 'servitor', 'infirmary', 'roster'].includes(route(roles, { bot, name }))
      }),
    )
  })
})

describe('commandTier', () => {
  it.each([...L.COMMAND_TIER_ROLES])('opens the Infirmary for role %s', (id) => {
    expect(commandTier([id])).toBe(true)
    expect(commandTier(['1', id, '2'])).toBe(true)
  })

  it('covers the alt Company Command roles', () => {
    expect(commandTier([cmd(5, 1)])).toBe(true)
    expect(commandTier([cmd(6, 1)])).toBe(true)
  })

  it('does not open it for everyone else', () => {
    expect(commandTier([])).toBe(false)
    for (const id of [L.LEGION_ROLE, L.INFIRMARY_ROLE, L.VENERABLE_DREADNOUGHT.id, L.SERVO_SKULLS_ROLE, co(1), cr('lieutenant'), '1']) {
      expect(commandTier([id]), id).toBe(false)
    }
  })
})

const build = (...members) => buildRoster(members, { guildId: GUILD })
const branch = (r, key) => r.branches.find((b) => b.key === key)
const names = (ms) => ms.map((m) => m.name)
const rowOf = (b, key) => b.rows.find((r) => r.rank.key === key)?.members ?? []
const LEG = L.LEGION_ROLE
const spec = (key) => L.SPECIALTIES.find((s) => s.key === key)
/**
 * Everyone placed anywhere in the main roster, flattened, each member once: acting
 * duplicates are dropped, and so is a High Command Captain's second appearance as
 * their company's head (the banner entry counts).
 */
const placed = (r) => {
  const banner = r.highCommand.flatMap((x) => x.members)
  const inBanner = new Set(banner.map((m) => m.id))
  return [
    ...banner,
    ...r.branches.flatMap((b) => [...b.head.members.filter((m) => !m.acting && !inBanner.has(m.id)), ...b.aside, ...b.rows.flatMap((x) => x.members)]),
    ...r.unassigned.rows.flatMap((x) => x.members),
  ]
}

describe('buildRoster: shape', () => {
  it('returns all twelve branches, vacant, for an empty or hostile input', () => {
    for (const input of [[], null, undefined, 'x', {}, [null, 5, 'x', {}, { user: null }]]) {
      const r = buildRoster(input, { guildId: GUILD })
      expect(r.highCommand).toEqual([])
      expect(r.unassigned).toEqual({ rows: [] })
      expect(r.servitors).toEqual([])
      expect(r.branches.map((b) => b.key)).toEqual(L.BRANCHES.map((b) => b.key))
      for (const b of r.branches) expect(b).toMatchObject({ aside: [], rows: [], head: { members: [], vacant: true } })
    }
  })

  it('describes each branch and its head rank', () => {
    const r = build()
    expect(branch(r, 'company-3')).toEqual({
      key: 'company-3', kind: 'company', label: '3rd Battle Company', number: 3,
      head: { rank: { key: 'captain', label: 'Captain', tier: 1 }, members: [], vacant: true }, aside: [], rows: [],
    })
    expect(branch(r, 'venerable-dreadnoughts')).toMatchObject({ kind: 'dreadnoughts', label: 'Venerable Dreadnoughts', head: { rank: { key: 'venerable-dreadnought' } } })
    expect(branch(r, 'venerable-dreadnoughts')).not.toHaveProperty('number')
    expect(branch(r, 'forge')).toMatchObject({ kind: 'specialty', label: 'Forge', head: { rank: { key: 'master-of-the-forge' } } })
  })

  it('gives a member their avatar, name and company from roles', () => {
    const raw = mem([LEG, cr('scout'), co(4)], { name: 'Brother Four' })
    raw.avatar = 'c'.repeat(32)
    const m = rowOf(branch(build(raw), 'company-4'), 'scout')[0]
    expect(m).toEqual({
      id: raw.user.id, name: 'Brother Four', company: 4,
      avatar: `https://cdn.discordapp.com/guilds/${GUILD}/users/${raw.user.id}/avatars/${'c'.repeat(32)}.png?size=64`,
    })
  })
})

describe('buildRoster: High Command', () => {
  it('lists High Command in rank order, Master of Sanctity as Lord Chaplain, vacant ranks omitted', () => {
    const r = build(
      mem([LEG, L.HIGH_COMMAND[4].id], { name: 'Chaplain' }),
      mem([LEG, L.HIGH_COMMAND[0].id], { name: 'Lord' }),
      mem([LEG, L.HIGH_COMMAND[2].id], { name: 'pyre b' }),
      mem([LEG, L.HIGH_COMMAND[2].id], { name: 'Pyre A' }),
    )
    expect(r.highCommand.map((x) => x.rank.label)).toEqual(['Lord of Drakes', 'Pyre Guard', 'Lord Chaplain'])
    expect(r.highCommand.map((x) => x.rank.tier)).toEqual([1, 3, 5])
    expect(names(r.highCommand[1].members)).toEqual(['Pyre A', 'pyre b'])
  })

  it('places High Command over every other role', () => {
    const r = build(mem([LEG, L.HIGH_COMMAND[3].id, L.CAPTAIN.id, L.SPECIALTIES[0].head.id, co(1), cr('sergeant')]))
    expect(r.highCommand).toHaveLength(1)
    expect(placed(r)).toHaveLength(1)
  })

  it('places someone holding two High Command roles at the higher rank only, whatever order the roles came in', () => {
    for (const roles of [[L.HIGH_COMMAND[1].id, L.HIGH_COMMAND[3].id], [L.HIGH_COMMAND[3].id, L.HIGH_COMMAND[1].id]]) {
      const r = build(mem([LEG, ...roles], { name: 'Two Hats' }))
      expect(r.highCommand.map((x) => [x.rank.key, names(x.members)])).toEqual([[L.HIGH_COMMAND[1].key, ['Two Hats']]])
    }
  })

  it('sorts same-name members by id so output is deterministic', () => {
    const a = mem([LEG, L.HIGH_COMMAND[2].id], { name: 'Same', id: '200000000000000900' })
    const b = mem([LEG, L.HIGH_COMMAND[2].id], { name: 'Same', id: '200000000000000100' })
    expect(build(a, b).highCommand[0].members.map((m) => m.id)).toEqual(['200000000000000100', '200000000000000900'])
    expect(build(b, a)).toEqual(build(a, b))
  })
})

describe('buildRoster: heads and branches', () => {
  it('heads Forge, Librarius and Apothecarion with their masters, who keep a company tag', () => {
    const r = build(
      mem([LEG, spec('forge').head.id, co(1)], { name: 'Forge M' }),
      mem([LEG, spec('librarius').head.id], { name: 'Lib M' }),
      mem([LEG, spec('apothecarion').head.id, co(3)], { name: 'Apo M' }),
    )
    expect(branch(r, 'forge').head).toMatchObject({ vacant: false, members: [{ name: 'Forge M', company: 1 }] })
    expect(branch(r, 'librarius').head.members[0]).toMatchObject({ name: 'Lib M', company: null })
    expect(branch(r, 'apothecarion').head.members[0].company).toBe(3)
    expect(branch(r, 'company-1').head.vacant).toBe(true)
  })

  it('puts a Master of the Forge above a Captain and a Venerable Dreadnought', () => {
    const r = build(mem([LEG, spec('forge').head.id, L.CAPTAIN.id, L.VENERABLE_DREADNOUGHT.id, co(2)]))
    expect(branch(r, 'forge').head.members).toHaveLength(1)
    expect(placed(r)).toHaveLength(1)
  })

  it('puts a Venerable Dreadnought in their own branch, with or without a company', () => {
    const r = build(
      mem([LEG, L.VENERABLE_DREADNOUGHT.id, co(5)], { name: 'VD five' }),
      mem([LEG, L.VENERABLE_DREADNOUGHT.id, co(1)], { name: 'VD one' }),
      mem([LEG, L.VENERABLE_DREADNOUGHT.id], { name: 'VD none' }),
    )
    const vd = branch(r, 'venerable-dreadnoughts')
    expect(vd.head.vacant).toBe(false)
    expect(vd.head.members.map((m) => [m.name, m.company])).toEqual([['VD five', 5], ['VD none', null], ['VD one', 1]])
    expect(vd.rows).toEqual([])
    expect(branch(r, 'company-1').head.vacant).toBe(true)
  })

  it('puts a Venerable Dreadnought in their own branch ahead of a Dreadnought role, even with a company', () => {
    const r = build(mem([LEG, L.VENERABLE_DREADNOUGHT.id, L.DREADNOUGHTS[0].id, co(4)], { name: 'VD Dread' }))
    expect(names(branch(r, 'venerable-dreadnoughts').head.members)).toEqual(['VD Dread'])
    expect(branch(r, 'company-4').aside).toEqual([])
    expect(placed(r)).toHaveLength(1)
  })

  it('puts a Venerable Dreadnought in their own branch ahead of a Reclusiarch', () => {
    const r = build(mem([LEG, L.VENERABLE_DREADNOUGHT.id, spec('reclusiam').head.id], { name: 'VD Recl' }))
    expect(names(branch(r, 'venerable-dreadnoughts').head.members)).toEqual(['VD Recl'])
    expect(branch(r, 'reclusiam').head.vacant).toBe(true)
    expect(placed(r)).toHaveLength(1)
  })

  it('heads the company with a Captain who also holds a Dreadnought role, not drawing them aside', () => {
    const r = build(mem([LEG, L.CAPTAIN.id, L.DREADNOUGHTS[1].id, co(6)], { name: 'Cap Dread' }))
    expect(names(branch(r, 'company-6').head.members)).toEqual(['Cap Dread'])
    expect(branch(r, 'company-6').aside).toEqual([])
    expect(placed(r)).toHaveLength(1)
  })

  it('draws a Dreadnought with a company aside ahead of a Reclusiarch', () => {
    const r = build(mem([LEG, L.DREADNOUGHTS[0].id, spec('reclusiam').head.id, co(2)], { name: 'Dread Recl' }))
    expect(names(branch(r, 'company-2').aside)).toEqual(['Dread Recl'])
    expect(branch(r, 'reclusiam').head.vacant).toBe(true)
    expect(placed(r)).toHaveLength(1)
  })

  it('shows a Captain who is also a Venerable Dreadnought with their company, as its Captain', () => {
    const r = build(mem([LEG, L.VENERABLE_DREADNOUGHT.id, L.CAPTAIN.id, co(5), cmd(5)], { name: 'Cap VD' }))
    expect(branch(r, 'company-5').head).toMatchObject({ vacant: false, members: [{ name: 'Cap VD', company: 5 }] })
    expect(branch(r, 'company-5').head.members[0]).not.toHaveProperty('acting')
    expect(branch(r, 'venerable-dreadnoughts').head.vacant).toBe(true)
    expect(placed(r)).toHaveLength(1)
  })

  it('puts a Captain who is also a Venerable Dreadnought, with no company, in the Venerable Dreadnoughts branch', () => {
    const r = build(mem([LEG, L.VENERABLE_DREADNOUGHT.id, L.CAPTAIN.id], { name: 'Cap VD homeless' }))
    expect(names(branch(r, 'venerable-dreadnoughts').head.members)).toEqual(['Cap VD homeless'])
  })

  it('makes a Captain head of the company they hold', () => {
    const r = build(mem([LEG, L.CAPTAIN.id, co(3), cmd(3)], { name: 'Cap Three' }))
    expect(branch(r, 'company-3').head).toMatchObject({ vacant: false, members: [{ name: 'Cap Three', company: 3 }] })
  })

  it('lets a Captain without a company role fall through to the next rule instead of vanishing', () => {
    const r = build(
      mem([LEG, L.CAPTAIN.id], { name: 'Homeless' }),
      mem([LEG, L.CAPTAIN.id, L.SPECIALTIES[0].ranks[1].id], { name: 'Smith Cap' }),
    )
    expect(names(rowOf({ rows: r.unassigned.rows }, 'no-rank'))).toEqual(['Homeless'])
    expect(names(rowOf(branch(r, 'forge'), 'techmarine'))).toEqual(['Smith Cap'])
  })

  it('draws every Dreadnought role in the company aside, ahead of specialty roles', () => {
    const r = build(
      mem([LEG, L.DREADNOUGHTS[0].id, co(4)], { name: 'Dread' }),
      mem([LEG, L.DREADNOUGHTS[1].id, co(1), L.SPECIALTIES[1].ranks[1].id], { name: 'Recl Dread' }),
      mem([LEG, L.DREADNOUGHTS[2].id, co(1)], { name: 'Chiron' }),
    )
    expect(names(branch(r, 'company-4').aside)).toEqual(['Dread'])
    expect(names(branch(r, 'company-1').aside)).toEqual(['Chiron', 'Recl Dread'])
    expect(branch(r, 'librarius').rows).toEqual([])
    expect(branch(r, 'company-4').rows).toEqual([])
  })

  it('lets a Dreadnought without a company continue to the next rule', () => {
    const r = build(mem([LEG, L.DREADNOUGHTS[0].id, L.SPECIALTIES[0].ranks[0].id], { name: 'Dread Forge' }), mem([LEG, L.DREADNOUGHTS[0].id], { name: 'Dread Lone' }))
    expect(names(rowOf(branch(r, 'forge'), 'mechadendrite-expert'))).toEqual(['Dread Forge'])
    expect(names(rowOf({ rows: r.unassigned.rows }, 'no-rank'))).toEqual(['Dread Lone'])
  })
})

describe('buildRoster: specialties', () => {
  it('heads Reclusiam with Reclusiarchs, ahead of specialty ranks but behind Captain', () => {
    const r = build(
      mem([LEG, spec('reclusiam').head.id, spec('forge').ranks[1].id], { name: 'Recl' }),
      mem([LEG, spec('reclusiam').head.id, L.CAPTAIN.id, co(2)], { name: 'Recl Cap' }),
    )
    expect(names(branch(r, 'reclusiam').head.members)).toEqual(['Recl'])
    expect(names(branch(r, 'company-2').head.members)).toEqual(['Recl Cap'])
    expect(branch(r, 'forge').rows).toEqual([])
  })

  it('builds each specialty waterfall in list order, with a company tag from roles', () => {
    const f = spec('forge').ranks
    const r = build(
      mem([LEG, f[2].id, co(2)], { name: 'Adept' }),
      mem([LEG, f[0].id], { name: 'Mech' }),
      mem([LEG, f[1].id, co(7)], { name: 'Tech' }),
      mem([LEG, f[1].id, f[2].id], { name: 'Tech Adept both' }),
    )
    const rows = branch(r, 'forge').rows
    expect(rows.map((x) => x.rank.key)).toEqual(['mechadendrite-expert', 'techmarine', 'tech-adept'])
    expect(rows.map((x) => x.rank.tier)).toEqual([1, 2, 3])
    expect(names(rows[1].members)).toEqual(['Tech', 'Tech Adept both'])
    expect(rows[1].members[0].company).toBe(7)
    expect(rows[2].members[0].company).toBe(2)
  })

  it('files Company, Firedrake and Igniax Chaplains in the Reclusiam waterfall; Firedrake implies 1st when no company role', () => {
    const [chap, igniax] = spec('reclusiam').ranks
    const r = build(
      mem([LEG, chap.id, co(3)], { name: 'Company C' }),
      mem([LEG, chap.variants[0].id], { name: 'Firedrake C' }),
      mem([LEG, igniax.id], { name: 'Igniax' }),
    )
    const rows = branch(r, 'reclusiam').rows
    expect(rows.map((x) => x.rank.key)).toEqual(['company-chaplain', 'igniax-chaplain'])
    expect(rows[0].members.map((m) => [m.name, m.company])).toEqual([['Company C', 3], ['Firedrake C', 1]])
  })

  it('takes the first specialty branch, in order, when someone holds ranks in two', () => {
    const r = build(mem([LEG, spec('apothecarion').ranks[0].id, spec('forge').ranks[2].id], { name: 'Both' }))
    expect(branch(r, 'forge').rows).toHaveLength(1)
    expect(branch(r, 'apothecarion').rows).toEqual([])
  })
})

describe('buildRoster: company waterfall', () => {
  it('orders the rows as the spec does, merging variants into their base rank', () => {
    const sgtVet = cr('veteran-sergeant')
    const sergeant = L.COMPANY_RANKS.find((r) => r.key === 'sergeant')
    const vet = L.COMPANY_RANKS.find((r) => r.key === 'company-veteran')
    const r = build(
      mem([LEG, co(1), cr('scout')], { name: 's' }),
      mem([LEG, co(1), cr('battle-brother')], { name: 'bb' }),
      mem([LEG, co(1), vet.variants[0].id], { name: 'Firedrake Vet' }),
      mem([LEG, co(1), vet.id], { name: 'Vet' }),
      mem([LEG, co(1), cr('terminator')], { name: 'Term' }),
      mem([LEG, co(1), sergeant.variants[0].id], { name: 'Firedrake Sgt' }),
      mem([LEG, co(7), sergeant.variants[1].id], { name: 'Scout Sgt' }),
      mem([LEG, co(1), sergeant.id], { name: 'Sgt' }),
      mem([LEG, co(1), sgtVet], { name: 'VSgt' }),
      mem([LEG, co(1), cr('company-champion')], { name: 'Champ' }),
      mem([LEG, co(1), cr('company-ancient')], { name: 'Ancient' }),
      mem([LEG, co(1), cr('lieutenant')], { name: 'Lt' }),
    )
    const rows = branch(r, 'company-1').rows
    expect(rows.map((x) => x.rank.key)).toEqual([
      'lieutenant', 'company-ancient', 'company-champion', 'veteran-sergeant', 'sergeant', 'terminator', 'company-veteran', 'battle-brother', 'scout',
    ])
    expect(names(rows[4].members)).toEqual(['Firedrake Sgt', 'Sgt'])
    expect(names(rows[6].members)).toEqual(['Firedrake Vet', 'Vet'])
    expect(names(rowOf(branch(r, 'company-7'), 'sergeant'))).toEqual(['Scout Sgt'])
  })

  it('shares one tier between Ancient and Champion, and marks Terminator lateral', () => {
    const rows = branch(build(mem([LEG, co(2), cr('company-ancient')]), mem([LEG, co(2), cr('company-champion')]), mem([LEG, co(2), cr('terminator')])), 'company-2').rows
    expect(rows.map((x) => x.rank.tier)).toEqual([2, 2, 5])
    expect(rows[2].rank).toEqual({ key: 'terminator', label: 'Terminator', tier: 5, lateral: true })
    expect(rows[0].rank).not.toHaveProperty('lateral')
  })

  it('shows the highest company rank when someone holds several', () => {
    const r = build(mem([LEG, co(3), cr('scout'), cr('sergeant'), cr('battle-brother')]))
    expect(rowOf(branch(r, 'company-3'), 'sergeant')).toHaveLength(1)
    expect(placed(r)).toHaveLength(1)
  })

  it('puts a company member with no rank role in a final "No rank role" row', () => {
    const r = build(mem([LEG, co(6)], { name: 'Rankless' }), mem([LEG, co(6), cr('scout')], { name: 'Scout' }))
    const rows = branch(r, 'company-6').rows
    expect(rows.map((x) => x.rank.key)).toEqual(['scout', 'no-rank'])
    expect(rows[1].rank).toEqual({ key: 'no-rank', label: 'No rank role', tier: 9 })
  })

  it('puts members with no company or specialty role in the unassigned waterfall', () => {
    const r = build(
      mem([LEG, cr('battle-brother')], { name: 'BB' }),
      mem([LEG, cr('lieutenant')], { name: 'Lt' }),
      mem([LEG], { name: 'Nobody' }),
      mem([LEG, L.LEGION_HIERARCHY_ROLE, cmd(1)], { name: 'Command only' }),
    )
    expect(r.unassigned.rows.map((x) => x.rank.key)).toEqual(['lieutenant', 'battle-brother', 'no-rank'])
    expect(names(r.unassigned.rows[2].members)).toEqual(['Command only', 'Nobody'])
  })

  it('uses the lowest-numbered company and lists the rest in order, whatever order the roles came in', () => {
    const r = build(mem([LEG, co(6), co(1), co(4), cr('scout')], { name: 'Multi' }))
    const m = rowOf(branch(r, 'company-1'), 'scout')[0]
    expect(m).toMatchObject({ company: 1, alsoCompanies: [4, 6] })
    expect(branch(r, 'company-4').rows).toEqual([])
    expect(rowOf(branch(r, 'company-1'), 'scout')[0].alsoCompanies).toEqual([4, 6])
    expect(placed(r)).toHaveLength(1)
  })

  it('has no alsoCompanies key for a single company', () => {
    expect(rowOf(branch(build(mem([LEG, co(2), cr('scout')])), 'company-2'), 'scout')[0]).not.toHaveProperty('alsoCompanies')
  })

  it('has no alsoCompanies key for a member with no company, or whose company a variant role implies', () => {
    const vet = L.COMPANY_RANKS.find((r) => r.key === 'company-veteran')
    const r = build(mem([LEG, cr('scout')], { name: 'Companyless' }), mem([LEG, vet.variants[0].id], { name: 'Variant' }))
    expect(rowOf({ rows: r.unassigned.rows }, 'scout')[0]).not.toHaveProperty('alsoCompanies')
    expect(rowOf(branch(r, 'company-1'), 'company-veteran')[0]).not.toHaveProperty('alsoCompanies')
  })
})

describe('buildRoster: rank variants and company fallback', () => {
  const sergeant = L.COMPANY_RANKS.find((r) => r.key === 'sergeant')
  const vet = L.COMPANY_RANKS.find((r) => r.key === 'company-veteran')

  it('lets a variant imply its company only when no company role is held', () => {
    const r = build(
      mem([LEG, vet.variants[0].id], { name: 'No company' }),
      mem([LEG, vet.variants[0].id, co(4)], { name: 'Has 4th' }),
      mem([LEG, vet.variants[0].id, co(6), co(1)], { name: 'Has 6th and 1st' }),
      mem([LEG, sergeant.variants[1].id], { name: 'Scout Sgt alone' }),
    )
    expect(names(rowOf(branch(r, 'company-1'), 'company-veteran'))).toEqual(['Has 6th and 1st', 'No company'])
    expect(names(rowOf(branch(r, 'company-4'), 'company-veteran'))).toEqual(['Has 4th'])
    expect(names(rowOf(branch(r, 'company-7'), 'sergeant'))).toEqual(['Scout Sgt alone'])
    expect(branch(r, 'company-6').rows).toEqual([])
  })
})

describe('buildRoster: acting heads', () => {
  const lt = cr('lieutenant')

  it('heads a Captain-less company with High Command and other Captains holding its Command role, marked acting', () => {
    const pyre = mem([LEG, L.HIGH_COMMAND[2].id, co(2), cmd(2)], { name: 'Pyre A' })
    const capt5 = mem([LEG, L.CAPTAIN.id, co(5), cmd(5), cmd(2)], { name: 'Captain B' })
    const ltC = mem([LEG, lt, co(2), cmd(2)], { name: 'Lt C' })
    const r = build(pyre, capt5, ltC)
    expect(branch(r, 'company-2').head).toMatchObject({ vacant: false })
    expect(branch(r, 'company-2').head.members.map((m) => [m.name, m.acting])).toEqual([['Captain B', true], ['Pyre A', true]])
    // they stay where they already are, unlabelled
    expect(r.highCommand[0].members).toEqual([expect.objectContaining({ name: 'Pyre A' })])
    expect(r.highCommand[0].members[0]).not.toHaveProperty('acting')
    expect(names(branch(r, 'company-5').head.members)).toEqual(['Captain B'])
    expect(branch(r, 'company-5').head.members[0]).not.toHaveProperty('acting')
    // a Lieutenant holding the Command role does not head it
    expect(names(rowOf(branch(r, 'company-2'), 'lieutenant'))).toEqual(['Lt C'])
  })

  it('counts the alt Command roles', () => {
    const r = build(mem([LEG, L.HIGH_COMMAND[0].id, cmd(5, 1)], { name: 'Lord' }), mem([LEG, L.HIGH_COMMAND[0].id, cmd(6, 1)], { name: 'Lord6' }))
    expect(names(branch(r, 'company-5').head.members)).toEqual(['Lord'])
    expect(names(branch(r, 'company-6').head.members)).toEqual(['Lord6'])
  })

  it('stays vacant when nobody eligible holds the Command role', () => {
    const r = build(mem([LEG, L.HIGH_COMMAND[2].id, cmd(3)], { name: 'Other co' }), mem([LEG, lt, cmd(2)]))
    expect(branch(r, 'company-2').head).toEqual(expect.objectContaining({ members: [], vacant: true }))
  })

  it('hands over to a Captain with no change, and labels nothing when a Captain already heads the company', () => {
    const r = build(
      mem([LEG, L.CAPTAIN.id, co(2)], { name: 'New Captain' }),
      mem([LEG, L.HIGH_COMMAND[2].id, co(2), cmd(2)], { name: 'Pyre A' }),
      mem([LEG, L.CAPTAIN.id, co(5), cmd(2)], { name: 'Other Captain' }),
    )
    expect(branch(r, 'company-2').head.members.map((m) => [m.name, m.acting])).toEqual([['New Captain', undefined]])
  })

  it('never uses Infirmary members, servitors, Voice of Vulkan or non-Legion accounts as acting heads', () => {
    const base = [L.HIGH_COMMAND[2].id, cmd(2)]
    const r = build(
      mem([LEG, L.INFIRMARY_ROLE, ...base], { name: 'Infirm' }),
      mem([LEG, L.SERVO_SKULLS_ROLE, ...base], { name: 'Skull' }),
      mem([LEG, L.VOICE_OF_VULKAN_ROLE, ...base], { name: 'Voice' }),
      mem(base, { name: 'No legion' }),
      mem([LEG, ...base], { name: 'Bot', bot: true }),
    )
    expect(branch(r, 'company-2').head.vacant).toBe(true)
  })

  it('does not make a company-less Captain the head of anything unless they hold a Command role of a Captain-less company', () => {
    const r = build(mem([LEG, L.CAPTAIN.id, cmd(4)], { name: 'Floating' }))
    expect(names(branch(r, 'company-4').head.members)).toEqual(['Floating'])
    expect(branch(r, 'company-4').head.members[0].acting).toBe(true)
    expect(names(rowOf({ rows: r.unassigned.rows }, 'no-rank'))).toEqual(['Floating'])
  })
})

describe('buildRoster: High Command Captains', () => {
  const hc = (i) => L.HIGH_COMMAND[i].id

  it('also heads their company, unlabelled, while staying in the banner; other Command-role holders are not heads', () => {
    const master = mem([LEG, hc(3), L.CAPTAIN.id, co(1), cmd(1)], { name: 'Master' })
    const pyre = mem([LEG, hc(2), cmd(1)], { name: 'Pyre A' })
    const lord = mem([LEG, hc(0), cmd(1, 1)], { name: 'Lord' })
    const r = build(master, pyre, lord)
    const head = branch(r, 'company-1').head
    expect(head.vacant).toBe(false)
    expect(names(head.members)).toEqual(['Master'])
    expect(head.members[0]).not.toHaveProperty('acting')
    expect(head.members[0]).toMatchObject({ id: master.user.id, company: 1 })
    expect(r.highCommand.flatMap((x) => names(x.members)).sort()).toEqual(['Lord', 'Master', 'Pyre A'])
    expect(placed(r)).toHaveLength(3)
  })

  it('stays in the banner only when they hold no company role', () => {
    const r = build(mem([LEG, hc(3), L.CAPTAIN.id], { name: 'Floating Master' }))
    expect(names(r.highCommand[0].members)).toEqual(['Floating Master'])
    expect(r.branches.every((b) => b.head.vacant && b.head.members.length === 0)).toBe(true)
  })

  it('does not stop a Captain-less company getting its acting heads', () => {
    const r = build(
      mem([LEG, hc(3), L.CAPTAIN.id, co(1)], { name: 'Master' }),
      mem([LEG, hc(2), co(2), cmd(2)], { name: 'Pyre A' }),
    )
    expect(branch(r, 'company-2').head.members.map((m) => [m.name, m.acting])).toEqual([['Pyre A', true]])
    expect(names(branch(r, 'company-1').head.members)).toEqual(['Master'])
  })

  it('heads alongside a non-High-Command Captain of the same company, neither acting', () => {
    const r = build(
      mem([LEG, hc(3), L.CAPTAIN.id, co(4)], { name: 'Master' }),
      mem([LEG, L.CAPTAIN.id, co(4)], { name: 'Plain Captain' }),
      mem([LEG, hc(2), cmd(4)], { name: 'Pyre A' }),
    )
    const head = branch(r, 'company-4').head
    expect(head.members.map((m) => [m.name, m.acting])).toEqual([['Master', undefined], ['Plain Captain', undefined]])
    expect(placed(r)).toHaveLength(3)
  })

  it('shows a Venerable Dreadnought Captain in the banner and as company head, not in the Venerable Dreadnoughts branch', () => {
    const r = build(mem([LEG, hc(3), L.CAPTAIN.id, L.VENERABLE_DREADNOUGHT.id, co(3)], { name: 'Old Master' }))
    expect(names(branch(r, 'company-3').head.members)).toEqual(['Old Master'])
    expect(r.highCommand).toHaveLength(1)
    const vd = branch(r, 'venerable-dreadnoughts')
    expect(vd.head).toEqual(expect.objectContaining({ members: [], vacant: true }))
    expect(vd.rows.flatMap((x) => x.members)).toEqual([])
  })

  it('heads the lowest-numbered of several held companies only, keeping alsoCompanies', () => {
    for (const roles of [[co(5), co(2)], [co(2), co(5)]]) {
      const r = build(mem([LEG, hc(3), L.CAPTAIN.id, ...roles], { name: 'Two Cos' }))
      expect(names(branch(r, 'company-2').head.members)).toEqual(['Two Cos'])
      expect(branch(r, 'company-2').head.members[0]).toMatchObject({ company: 2, alsoCompanies: [5] })
      expect(branch(r, 'company-5').head.members).toEqual([])
      expect(r.highCommand[0].members[0]).toMatchObject({ company: 2, alsoCompanies: [5] })
    }
  })

  it('a variant role implying a company counts as a company role', () => {
    const owner = L.COMPANY_RANKS.find((r) => r.variants?.length > 0)
    const v = owner.variants[0]
    const r = build(mem([LEG, hc(3), L.CAPTAIN.id, v.id], { name: 'Variant Master' }))
    expect(names(branch(r, `company-${v.company}`).head.members)).toEqual(['Variant Master'])
  })
})

describe('buildRoster: servitors, Infirmary, hidden', () => {
  const LEGB = [LEG]
  it('collects bots, Servo-Skulls holders and servitor-named accounts, sorted, with their flags', () => {
    const r = build(
      mem([LEG, co(1), cmd(1)], { name: 'Smith-Servitor', bot: true }),
      mem([L.SERVO_SKULLS_ROLE], { name: 'A Skull' }),
      mem(LEGB, { name: 'Eye Viewing Servitor' }),
      mem(LEGB, { name: 'Brother Real' }),
    )
    expect(r.servitors.map((s) => s.name)).toEqual(['A Skull', 'Eye Viewing Servitor', 'Smith-Servitor'])
    expect(r.servitors.map((s) => s.bot)).toEqual([undefined, undefined, true])
    for (const s of r.servitors) expect(s.company).toBe(null)
    expect(placed(r).map((m) => m.name)).toEqual(['Brother Real'])
  })

  it('keeps servitors out of every branch even when they hold ranks and companies', () => {
    const r = build(mem([L.SERVO_SKULLS_ROLE, ...L.COMPANIES.map((c) => c.roleId), L.CAPTAIN.id, L.HIGH_COMMAND[0].id], { name: 'Every Role' }))
    expect(r.servitors).toHaveLength(1)
    expect(placed(r)).toEqual([])
  })

  it('leaves Infirmary holders, the Voice of Vulkan account and non-Legion accounts off the roster', () => {
    const r = build(
      mem([LEG, L.INFIRMARY_ROLE, L.HIGH_COMMAND[0].id, co(1)], { name: 'On leave' }),
      mem([L.INFIRMARY_ROLE], { name: 'No legion on leave' }),
      mem([LEG, L.VOICE_OF_VULKAN_ROLE], { name: 'Voice' }),
      mem([L.CAPTAIN.id, co(1)], { name: 'No legion' }),
    )
    expect(placed(r)).toEqual([])
    expect(r.servitors).toEqual([])
    expect(r.highCommand).toEqual([])
  })
})

describe('buildRoster: name check', () => {
  const only = (name, roles) => placed(build(mem([LEG, cr('scout'), ...roles], { name })))[0]
  it('flags a name tag that differs from the roles, or that has no company role behind it', () => {
    expect(only('Brother X 5th Co.', [co(3)]).nameMismatch).toBe(true)
    expect(only('Brother X 3rd Co.', []).nameMismatch).toBe(true)
    expect(only('Brother X 3rd and 4th', [co(3)]).nameMismatch).toBe(true)
  })

  it('does not flag matching, absent or multi-company-consistent tags', () => {
    expect(only('Brother X 3rd Co.', [co(3)])).not.toHaveProperty('nameMismatch')
    expect(only('Brother X', [co(3)])).not.toHaveProperty('nameMismatch')
    expect(only('Brother X', [])).not.toHaveProperty('nameMismatch')
    expect(only('Brother X 4th Co.', [co(2), co(4)])).not.toHaveProperty('nameMismatch')
  })

  it('counts a variant-implied company as the member’s company', () => {
    const vet = L.COMPANY_RANKS.find((r) => r.key === 'company-veteran')
    const m = placed(build(mem([LEG, vet.variants[0].id], { name: 'Fire 1st Co.' })))[0]
    expect(m).not.toHaveProperty('nameMismatch')
  })

  it('never lets a forged company tag change where someone is placed', () => {
    const r = build(mem([LEG, co(3), cr('scout')], { name: 'Liar 1st Co.' }))
    expect(rowOf(branch(r, 'company-3'), 'scout')).toHaveLength(1)
    expect(branch(r, 'company-1').rows).toEqual([])
  })
})

describe('buildRoster: hostile input and properties', () => {
  it('skips malformed members and duplicate ids (the first wins), and survives 10,000 roles', () => {
    const good = mem([LEG, cr('scout'), co(1)], { name: 'Good', id: '200000000000009999' })
    const dup = mem([LEG, cr('lieutenant'), co(1)], { name: 'Dup', id: '200000000000009999' })
    const huge = mem([LEG, ...Array.from({ length: 10_000 }, (_, i) => `r${i}`)], { name: 'Huge' })
    const r = build(good, dup, huge, { user: { id: 'nope' }, roles: [LEG] }, { roles: [LEG] }, null, mem(undefined, { name: 'No roles' }))
    expect(names(placed(r)).sort()).toEqual(['Good', 'Huge'])
  })

  it('ignores unknown role ids: a Legion member holding only strangers lands in No rank role', () => {
    const r = build(mem([LEG, '999999999999999999', 'junk'], { name: 'Stranger' }))
    expect(names(r.unassigned.rows[0].members)).toEqual(['Stranger'])
  })

  it('tolerates names with emoji, bidi marks, nothing at all, and the 32-character limit', () => {
    const r = build(
      mem([LEG, co(1), cr('scout')], { name: '🦀 Brother Pastry 🦀' }),
      mem([LEG, co(1), cr('scout')], { name: '‮Brother Bidi' }),
      mem([LEG, co(1), cr('scout')], { name: '' }),
      mem([LEG, co(1), cr('scout')], { name: 'x'.repeat(33) }),
    )
    const scouts = rowOf(branch(r, 'company-1'), 'scout')
    expect(scouts).toHaveLength(4)
    expect(scouts.every((m) => typeof m.name === 'string' && m.name.length > 0 && m.name.length <= 32)).toBe(true)
  })

  const roleArb = fc.subarray([
    LEG, L.INFIRMARY_ROLE, L.SERVO_SKULLS_ROLE, L.VOICE_OF_VULKAN_ROLE, L.LEGION_HIERARCHY_ROLE,
    ...L.PLACING_ROLES, ...L.COMPANIES.flatMap((c) => c.commandRoleIds), 'stranger',
  ])
  const nameArb = fc.oneof(fc.string({ maxLength: 20 }), fc.constantFrom('Viewing Servitor', 'Servo Skull', 'Bro 3rd Co.', 'Bro 6th'))
  const guildArb = fc.array(fc.record({ roles: roleArb, name: nameArb, bot: fc.boolean() }), { maxLength: 40 }).map((specs) =>
    specs.map((s, i) => mem(s.roles, { name: s.name, bot: s.bot, id: String(300000000000000000n + BigInt(i)) })),
  )

  it('is identical under any ordering of the input', () => {
    fc.assert(
      fc.property(guildArb, fc.nat(), (members, seed) => {
        const k = members.length === 0 ? 0 : seed % members.length
        const shuffled = [...members.slice(k), ...members.slice(0, k)].reverse()
        expect(buildRoster(shuffled, { guildId: GUILD })).toEqual(buildRoster(members, { guildId: GUILD }))
      }),
    )
  })

  it('places every roster member exactly once, and nobody who is not on the roster', () => {
    fc.assert(
      fc.property(guildArb, (members) => {
        const r = buildRoster(members, { guildId: GUILD })
        const onRoster = members.filter((m) => routeOf(memberFacts(m, GUILD)) === 'roster').map((m) => m.user.id).sort()
        expect(placed(r).map((m) => m.id).sort()).toEqual(onRoster)
        const servitorIds = members.filter((m) => routeOf(memberFacts(m, GUILD)) === 'servitor').map((m) => m.user.id).sort()
        expect(r.servitors.map((s) => s.id).sort()).toEqual(servitorIds)
        const everyone = new Set([...placed(r), ...r.servitors].map((m) => m.id))
        for (const m of members) {
          const route = routeOf(memberFacts(m, GUILD))
          if (route === 'infirmary' || route === 'hidden') expect(everyone.has(m.user.id)).toBe(false)
        }
      }),
    )
  })
})

describe('buildInfirmary', () => {
  const inf = (...members) => buildInfirmary(members, { guildId: GUILD })
  const INF = L.INFIRMARY_ROLE

  it('lists every Infirmary holder, Legion role or not, with a legion flag', () => {
    const out = inf(mem([INF, LEG], { name: 'Has Legion' }), mem([INF], { name: 'No Legion' }), mem([LEG, cr('scout')], { name: 'Healthy' }))
    expect(out.map((m) => [m.name, m.legion])).toEqual([['Has Legion', true], ['No Legion', false]])
  })

  it('leaves out servitors, the Voice of Vulkan account, bots and non-holders', () => {
    const out = inf(
      mem([INF, L.SERVO_SKULLS_ROLE], { name: 'Skull' }),
      mem([INF, L.VOICE_OF_VULKAN_ROLE], { name: 'Voice' }),
      mem([INF], { name: 'Bot', bot: true }),
      mem([LEG], { name: 'Well' }),
      mem([INF], { name: 'Servitor by name' }),
    )
    expect(names(out)).toEqual(['Servitor by name'])
  })

  it('reports null rank for a stripped member and the highest ladder rank otherwise', () => {
    const f = spec('forge').ranks[1]
    const out = inf(
      mem([INF], { name: 'a stripped' }),
      mem([INF, cr('sergeant'), f.id], { name: 'b tech' }),
      mem([INF, L.HIGH_COMMAND[1].id, L.CAPTAIN.id], { name: 'c high' }),
      mem([INF, L.HIGH_COMMAND[4].id], { name: 'd chaplain' }),
      mem([INF, L.COMPANY_RANKS[4].variants[0].id], { name: 'e firedrake' }),
    )
    const byN = Object.fromEntries(out.map((m) => [m.name, m.rank]))
    expect(byN['a stripped']).toBe(null)
    expect(byN['b tech']).toEqual({ key: 'techmarine', label: 'Techmarine' })
    expect(byN['c high']).toEqual({ key: 'lord-protector', label: 'Lord Protector of the 7 Realms' })
    expect(byN['d chaplain']).toEqual({ key: 'lord-chaplain', label: 'Lord Chaplain' })
    expect(byN['e firedrake']).toEqual({ key: 'sergeant', label: 'Sergeant' })
  })

  it('carries company, alsoCompanies and nameMismatch like the roster does', () => {
    const [m] = inf(mem([INF, co(5), co(2), cr('scout')], { name: 'Bro 6th Co.' }))
    expect(m).toMatchObject({ company: 2, alsoCompanies: [5], nameMismatch: true, legion: false })
    const vet = L.COMPANY_RANKS.find((r) => r.key === 'company-veteran')
    expect(inf(mem([INF, vet.variants[0].id], { name: 'Rose' }))[0].company).toBe(1)
  })

  it('sorts by company (none last), then rank, then name, then id', () => {
    const out = inf(
      mem([INF], { name: 'z none stripped' }),
      mem([INF, cr('scout')], { name: 'y none scout' }),
      mem([INF, co(3), cr('scout')], { name: 'b three scout' }),
      mem([INF, co(3), cr('lieutenant')], { name: 'c three lt' }),
      mem([INF, co(3), cr('scout')], { name: 'A three scout' }),
      mem([INF, co(1), cr('scout')], { name: 'd one scout' }),
    )
    expect(names(out)).toEqual(['d one scout', 'c three lt', 'A three scout', 'b three scout', 'y none scout', 'z none stripped'])
    const same = [mem([INF], { name: 'Same', id: '200000000000000900' }), mem([INF], { name: 'Same', id: '200000000000000100' })]
    expect(inf(...same).map((m) => m.id)).toEqual(['200000000000000100', '200000000000000900'])
  })

  it('skips malformed and duplicate members, tolerates hostile input, and is order independent', () => {
    const a = mem([INF, co(2)], { name: 'A', id: '200000000000008001' })
    const dup = mem([INF, co(1)], { name: 'Dup', id: '200000000000008001' })
    const b = mem([INF], { name: 'B', id: '200000000000008002' })
    expect(names(inf(a, dup, b, null, 5, {}, { user: { id: 'x' } }))).toEqual(['A', 'B'])
    expect(inf(b, a)).toEqual(inf(a, b))
    expect(buildInfirmary(null, { guildId: GUILD })).toEqual([])
    expect(buildInfirmary('x', { guildId: GUILD })).toEqual([])
  })

  it('never lists anyone buildRoster lists, and together they cover every non-hidden member', () => {
    const members = [
      mem([LEG, cr('scout'), co(1)]), mem([INF, LEG]), mem([INF]), mem([L.SERVO_SKULLS_ROLE]),
      mem([LEG, L.VOICE_OF_VULKAN_ROLE]), mem([co(2)]), mem([LEG], { name: 'Eye Servitor' }),
    ]
    const roster = buildRoster(members, { guildId: GUILD })
    const onRoster = new Set(placed(roster).map((m) => m.id))
    const infirmary = buildInfirmary(members, { guildId: GUILD })
    for (const m of infirmary) expect(onRoster.has(m.id)).toBe(false)
    expect(onRoster.size + infirmary.length + roster.servitors.length).toBe(1 + 2 + 2)
  })
})
