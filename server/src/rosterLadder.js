/**
 * The roster's role table: which Discord roles place a member, and in what
 * order. Rules: docs/superpowers/specs/2026-10-13-roster-design.md. Role ids
 * are the live guild's as of 2026-10-13 (ids are not secret; privileges.js and
 * index.js already carry them). Order within every list is the hierarchy,
 * highest first. `tier` numbers a rank within its own list; ranks sharing a
 * tier are peers. A `variant` is a role that is the same rank as its owner,
 * within a company (Firedrake is 1st Company, Scout is 7th).
 */
const rank = (id, key, label, tier, extra = {}) => ({ id, key, label, tier, ...extra })

export const LEGION_ROLE = '1377787723976409211'
export const INFIRMARY_ROLE = '1362059023481831517'
export const VOICE_OF_VULKAN_ROLE = '1456339345102602425'
export const SERVO_SKULLS_ROLE = '1322056087880597521'
export const LEGION_HIERARCHY_ROLE = '1322056087880597522' // ping group; places no one

export const HIGH_COMMAND = [
  rank('1322056087888859199', 'lord-of-drakes', 'Lord of Drakes', 1),
  rank('1322056087880597524', 'lord-protector', 'Lord Protector of the 7 Realms', 2),
  rank('1322056087880597523', 'pyre-guard', 'Pyre Guard', 3),
  rank('1322056087867883563', 'chapter-master', 'Chapter Master', 4),
  rank('1322056087867883567', 'lord-chaplain', 'Lord Chaplain', 5), // the Master of Sanctity role
]

export const CAPTAIN = rank('1322056087867883561', 'captain', 'Captain', 1)
export const VENERABLE_DREADNOUGHT = rank('1354921403849244672', 'venerable-dreadnought', 'Venerable Dreadnought', 1)
export const DREADNOUGHTS = [
  rank('1322056087859499046', 'dreadnought', 'Dreadnought', 1),
  rank('1403430421622034547', 'reclusiam-dreadnought', 'Reclusiam Dreadnought', 2),
  rank('1498341187038482603', 'chiron-saturnine-dreadnought', 'Chiron Pattern Saturnine Dreadnought', 3),
]

export const SPECIALTIES = [
  {
    key: 'forge',
    label: 'Forge',
    headFirst: true,
    head: rank('1322056087867883565', 'master-of-the-forge', 'Master of the Forge', 1),
    ranks: [
      rank('1362522277677240521', 'mechadendrite-expert', 'Mechadendrite Expert', 1),
      rank('1322056087859499042', 'techmarine', 'Techmarine', 2),
      rank('1322056087838523410', 'tech-adept', 'Tech Adept', 3),
    ],
  },
  {
    key: 'librarius',
    label: 'Librarius',
    headFirst: true,
    head: rank('1322056087867883568', 'chief-librarian', 'Chief Librarian', 1),
    ranks: [
      rank('1362511749382668581', 'epistolary', 'Epistolary', 1),
      rank('1322056087859499049', 'codicier', 'Codicier', 2),
      rank('1322056087838523408', 'lexicanium', 'Lexicanium', 3),
    ],
  },
  {
    key: 'apothecarion',
    label: 'Apothecarion',
    headFirst: true,
    head: rank('1322056087867883564', 'chief-apothecary', 'Chief Apothecary', 1),
    ranks: [
      rank('1362509331483857157', 'apothecary-biologis', 'Apothecary Biologis', 1),
      rank('1322056087859499043', 'apothecary', 'Apothecary', 2),
      rank('1322056087838523409', 'helix-adept', 'Helix Adept', 3),
    ],
  },
  {
    key: 'reclusiam',
    label: 'Reclusiam',
    headFirst: false, // Reclusiarch is placed after Captain and the Dreadnoughts
    head: rank('1323334632904855592', 'reclusiarch-chaplain', 'Reclusiarch Chaplain', 1),
    ranks: [
      rank('1322056087859499048', 'company-chaplain', 'Company Chaplain', 1, {
        variants: [{ id: '1391154164595294349', company: 1 }], // Firedrake Chaplain
      }),
      rank('1341223740897366091', 'igniax-chaplain', 'Igniax Chaplain', 2),
    ],
  },
]

export const COMPANY_RANKS = [
  rank('1322056087867883560', 'lieutenant', 'Lieutenant', 1),
  rank('1322056087859499047', 'company-ancient', 'Company Ancient', 2),
  rank('1322056087850979328', 'company-champion', 'Company Champion', 2),
  rank('1322056087859499045', 'veteran-sergeant', 'Veteran Sergeant', 3),
  rank('1322056087859499044', 'sergeant', 'Sergeant', 4, {
    variants: [
      { id: '1385818666871816304', company: 1 }, // Firedrake Sergeant
      { id: '1432090984233308240', company: 7 }, // Scout Sergeant
    ],
  }),
  rank('1531689040946921522', 'terminator', 'Terminator', 5, { lateral: true }),
  rank('1430744412505505845', 'company-veteran', 'Company Veteran', 6, {
    variants: [{ id: '1385817805219430523', company: 1 }], // Firedrake Veteran
  }),
  rank('1322056087838523406', 'battle-brother', 'Battle-Brother', 7),
  rank('1430743608822206504', 'scout', 'Scout', 8),
]
export const NO_RANK = { key: 'no-rank', label: 'No rank role', tier: Math.max(...COMPANY_RANKS.map((r) => r.tier)) + 1 }

const company = (number, roleId, label, ...commandRoleIds) => ({ number, roleId, label, commandRoleIds })
export const COMPANIES = [
  company(1, '1322056087859499041', '1st Battle Company', '1323055686187356291'),
  company(2, '1322056087859499040', '2nd Battle Company', '1323055929981407242'),
  company(3, '1322056087850979333', '3rd Battle Company', '1323056001779241034'),
  company(4, '1322056087850979337', '4th Battle Company', '1323056196755918981'),
  company(5, '1322056087850979331', '5th Company', '1323056312182902906', '1493412147294638180'),
  company(6, '1322056087850979329', '6th Company', '1323056408379265114', '1493412321521963118'),
  company(7, '1322056087850979334', '7th Scout Company', '1323056498133438555'),
]

/** Branches in API order. */
export const BRANCHES = [
  ...COMPANIES.map((c) => ({
    key: `company-${c.number}`,
    kind: 'company',
    label: c.label,
    number: c.number,
    head: CAPTAIN,
    ranks: [...COMPANY_RANKS, NO_RANK],
    commandRoleIds: c.commandRoleIds,
  })),
  { key: 'venerable-dreadnoughts', kind: 'dreadnoughts', label: 'Venerable Dreadnoughts', head: VENERABLE_DREADNOUGHT, ranks: [], commandRoleIds: [] },
  ...SPECIALTIES.map((s) => ({ key: s.key, kind: 'specialty', label: s.label, head: s.head, ranks: s.ranks, commandRoleIds: [] })),
]

/** Every rank, highest first, in the order the placement rules try them. */
export const ALL_RANKS = [
  ...HIGH_COMMAND,
  ...SPECIALTIES.filter((s) => s.headFirst).map((s) => s.head),
  CAPTAIN,
  VENERABLE_DREADNOUGHT,
  ...DREADNOUGHTS,
  ...SPECIALTIES.filter((s) => !s.headFirst).map((s) => s.head),
  ...SPECIALTIES.flatMap((s) => s.ranks),
  ...COMPANY_RANKS,
]

const withVariants = (r) => [r.id, ...(r.variants ?? []).map((v) => v.id)]
/** Roles that place a member (rules 2-9); a servitor-looking name yields to any of them. */
export const PLACING_ROLES = new Set([...ALL_RANKS.flatMap(withVariants), ...COMPANIES.map((c) => c.roleId)])

/** Roles that open the Infirmary area. */
export const COMMAND_TIER_ROLES = new Set([
  ...HIGH_COMMAND.map((r) => r.id),
  CAPTAIN.id,
  ...SPECIALTIES.map((s) => s.head.id),
  LEGION_HIERARCHY_ROLE,
  ...COMPANIES.flatMap((c) => c.commandRoleIds),
])
