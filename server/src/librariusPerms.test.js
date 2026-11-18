import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { ALL, P, canRead, permissionsIn, toBits } from './librariusPerms.js'

// Invented ids. The guild id doubles as the @everyone role id, as it does on Discord.
const GUILD = '200000000000000400'
const READER = '200000000000000401'
const OTHER = '200000000000000402'
const THIRD = '200000000000000403'
const A = '200000000000000410'
const B = '200000000000000411'
const OWNER = '200000000000000412'

const bits = (...list) => list.reduce((acc, b) => acc | b, 0n)
const role = (id, ...list) => ({ id, permissions: String(bits(...list)) })
const ow = (id, type, { allow = 0n, deny = 0n } = {}) => ({ id, type, allow: String(allow), deny: String(deny) })

const VIEW = P.VIEW_CHANNEL
const HISTORY = P.READ_MESSAGE_HISTORY
const SEND = P.SEND_MESSAGES
const REACT = P.ADD_REACTIONS
const THREADS = P.SEND_MESSAGES_IN_THREADS

// The live shape: @everyone may do the ordinary things, a forum overwrite takes View Channel from @everyone, and a
// reader role is given it back.
const live = () => ({
  guildId: GUILD,
  ownerId: OWNER,
  roles: [role(GUILD, VIEW, SEND, HISTORY, THREADS, REACT), role(READER), role(OTHER)],
  overwrites: [ow(GUILD, 0, { deny: VIEW }), ow(READER, 0, { allow: VIEW })],
})

// A small, plain world: @everyone holds View and History, nothing else is set. Tests change one thing at a time.
const plain = (over = {}) => ({
  guildId: GUILD,
  ownerId: OWNER,
  roles: [role(GUILD, VIEW, HISTORY), role(READER), role(OTHER), role(THIRD)],
  overwrites: [],
  memberId: A,
  memberRoleIds: [],
  ...over,
})

describe('the permission bits', () => {
  it('carry the values Discord documents', () => {
    expect(P).toStrictEqual({
      ADMINISTRATOR: 1n << 3n,
      MANAGE_CHANNELS: 1n << 4n,
      ADD_REACTIONS: 1n << 6n,
      VIEW_CHANNEL: 1n << 10n,
      SEND_MESSAGES: 1n << 11n,
      MANAGE_MESSAGES: 1n << 13n,
      ATTACH_FILES: 1n << 15n,
      READ_MESSAGE_HISTORY: 1n << 16n,
      MANAGE_THREADS: 1n << 34n,
      SEND_MESSAGES_IN_THREADS: 1n << 38n,
    })
    expect(P.ADMINISTRATOR).toBe(8n)
    expect(P.VIEW_CHANNEL).toBe(1024n)
    expect(P.READ_MESSAGE_HISTORY).toBe(65536n)
  })

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(P)).toBe(true)
  })

  it('make ALL every one of the 64 bits', () => {
    expect(ALL).toBe(18446744073709551615n)
    expect(ALL.toString(2)).toBe('1'.repeat(64))
  })
})

describe('toBits: a permission value as bits, or nothing', () => {
  it('reads a string of digits as the number it spells', () => {
    expect(toBits('0')).toBe(0n)
    expect(toBits('8')).toBe(8n)
    expect(toBits('1024')).toBe(1024n)
    expect(toBits('0008')).toBe(8n)
    expect(toBits('18446744073709551615')).toBe(ALL)
  })

  it('takes a string of up to 40 digits and not a 41st', () => {
    expect(toBits('9'.repeat(40))).toBe(BigInt('9'.repeat(40)))
    expect(toBits('1' + '0'.repeat(39))).toBe(10n ** 39n)
    expect(toBits('9'.repeat(41))).toBe(0n)
    expect(toBits('1' + '0'.repeat(40))).toBe(0n)
  })

  it('passes a bigint of zero or more straight through', () => {
    expect(toBits(0n)).toBe(0n)
    expect(toBits(1n)).toBe(1n)
    expect(toBits(ALL)).toBe(ALL)
    expect(toBits(1n << 70n)).toBe(1n << 70n)
  })

  it('answers nothing for a negative bigint', () => {
    expect(toBits(-1n)).toBe(0n)
    expect(toBits(-(1n << 70n))).toBe(0n)
  })

  it('answers nothing for anything that is not plain digits', () => {
    const hostile = [
      '', ' ', '12a', 'a12', ' 12', '12 ', '1 2', '-1', '+1', '1e3', '1.5', '.5', '0x10', '1_000', '१२', '１２', '12\n', '\n12',
      '12\n\n', 'NaN', 'Infinity', 'null', 'undefined', '[8]',
    ]
    for (const value of hostile) expect(toBits(value), JSON.stringify(value)).toBe(0n)
  })

  it('answers nothing for a number, even a whole one: Discord sends these as strings', () => {
    for (const value of [8, 1024, 0, 1e3, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER]) expect(toBits(value)).toBe(0n)
  })

  it('answers nothing for any other type', () => {
    const hostile = [undefined, null, true, false, {}, [], ['8'], [8n], { toString: () => '8' }, { valueOf: () => 8n }, Symbol('8'), () => '8', new String('8')]
    for (const value of hostile) expect(toBits(value)).toBe(0n)
  })

  it('property: a string of 1 to 40 digits is read exactly', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{1,40}$/), (s) => {
        expect(toBits(s)).toBe(BigInt(s))
      }),
    )
  })

  it('property: a bigint of zero or more is kept and a negative one is dropped', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(1n << 80n), max: 1n << 80n }), (n) => {
        expect(toBits(n)).toBe(n >= 0n ? n : 0n)
      }),
    )
  })

  it('property: it is never negative and never throws, whatever it is given', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        const out = toBits(v)
        expect(typeof out).toBe('bigint')
        expect(out >= 0n).toBe(true)
      }),
    )
  })

  it('property: a string that is not 1 to 40 digits is nothing', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^[0-9]{1,40}$/.test(s)),
        (s) => {
          expect(toBits(s)).toBe(0n)
        },
      ),
    )
  })
})

describe('canRead: View Channel and Read Message History together', () => {
  it('needs both bits', () => {
    expect(canRead(VIEW | HISTORY)).toBe(true)
    expect(canRead(VIEW)).toBe(false)
    expect(canRead(HISTORY)).toBe(false)
    expect(canRead(0n)).toBe(false)
    expect(canRead(SEND | REACT | THREADS)).toBe(false)
  })

  it('does not mind what else is set', () => {
    expect(canRead(VIEW | HISTORY | SEND | P.ADMINISTRATOR)).toBe(true)
    expect(canRead(ALL)).toBe(true)
    expect(canRead(ALL & ~VIEW)).toBe(false)
    expect(canRead(ALL & ~HISTORY)).toBe(false)
  })

  it('reads a digit string the way toBits does, and refuses what toBits refuses', () => {
    expect(canRead(String(VIEW | HISTORY))).toBe(true)
    expect(canRead(String(VIEW))).toBe(false)
    for (const value of [undefined, null, 66560, NaN, '', '12a', {}, [], -1n, true]) expect(canRead(value)).toBe(false)
  })

  it('property: true exactly when both bits are in', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: ALL }), (n) => {
        expect(canRead(n)).toBe((n & VIEW) !== 0n && (n & HISTORY) !== 0n)
      }),
    )
  })
})

describe('permissionsIn: the live shape', () => {
  it('the reader role sees the forum, and a member without it does not', () => {
    expect(canRead(permissionsIn({ ...live(), memberId: A, memberRoleIds: [READER] }))).toBe(true)
    expect(permissionsIn({ ...live(), memberId: B, memberRoleIds: [OTHER] })).toBe(0n)
  })

  it('gives the reader exactly what @everyone has, with View Channel back', () => {
    expect(permissionsIn({ ...live(), memberId: A, memberRoleIds: [READER] })).toBe(bits(VIEW, SEND, HISTORY, THREADS, REACT))
  })

  it('gives a member with no roles at all nothing', () => {
    expect(permissionsIn({ ...live(), memberId: A, memberRoleIds: [] })).toBe(0n)
  })
})

describe('permissionsIn: the owner and Administrator', () => {
  it('gives the owner everything, whatever the overwrites say', () => {
    const world = {
      ...plain(),
      memberId: OWNER,
      roles: [role(GUILD)],
      overwrites: [ow(GUILD, 0, { deny: ALL }), ow(OWNER, 1, { deny: ALL })],
    }
    expect(permissionsIn(world)).toBe(ALL)
    expect(permissionsIn({ ...world, memberRoleIds: [READER] })).toBe(ALL)
  })

  it('gives everything only to the owner: the same world for anyone else is empty', () => {
    const world = { ...plain(), roles: [role(GUILD)], overwrites: [ow(GUILD, 0, { deny: ALL })] }
    expect(permissionsIn({ ...world, memberId: OWNER, ownerId: OWNER })).toBe(ALL)
    expect(permissionsIn({ ...world, memberId: A, ownerId: OWNER })).toBe(0n)
  })

  it('gives Administrator on any held role everything, overwrites ignored', () => {
    const world = plain({
      roles: [role(GUILD, VIEW, HISTORY), role(READER, P.ADMINISTRATOR), role(OTHER)],
      overwrites: [ow(GUILD, 0, { deny: ALL }), ow(READER, 0, { deny: ALL }), ow(A, 1, { deny: ALL })],
    })
    expect(permissionsIn({ ...world, memberRoleIds: [READER] })).toBe(ALL)
    expect(permissionsIn({ ...world, memberRoleIds: [OTHER, READER] })).toBe(ALL)
  })

  it('finds Administrator among other bits on a role', () => {
    const world = plain({ roles: [role(GUILD), role(READER, SEND, P.ADMINISTRATOR, P.MANAGE_THREADS)], overwrites: [ow(GUILD, 0, { deny: ALL })] })
    expect(permissionsIn({ ...world, memberRoleIds: [READER] })).toBe(ALL)
  })

  it('gives Administrator on @everyone everything, to a member who holds no role', () => {
    const world = plain({ roles: [role(GUILD, P.ADMINISTRATOR)], overwrites: [ow(GUILD, 0, { deny: ALL })] })
    expect(permissionsIn({ ...world, memberRoleIds: [] })).toBe(ALL)
  })

  it('gives nothing for Administrator on a role the member does not hold', () => {
    const world = plain({ roles: [role(GUILD, VIEW, HISTORY), role(READER, P.ADMINISTRATOR)] })
    expect(permissionsIn({ ...world, memberRoleIds: [OTHER] })).toBe(VIEW | HISTORY)
    expect(permissionsIn({ ...world, memberRoleIds: [] })).toBe(VIEW | HISTORY)
  })

  it('does not take Administrator from an overwrite: an overwrite grants channel permissions, nothing more', () => {
    // Allowing the Administrator bit in an overwrite is not Administrator; the short-circuit looks at the base only.
    const world = plain({ overwrites: [ow(GUILD, 0, { allow: P.ADMINISTRATOR })] })
    expect(permissionsIn(world)).toBe(bits(VIEW, HISTORY, P.ADMINISTRATOR))
    expect(permissionsIn(world)).not.toBe(ALL)
  })
})

describe('permissionsIn: the order Discord applies things in', () => {
  it('starts from @everyone and every held role together', () => {
    const world = plain({ roles: [role(GUILD, VIEW, HISTORY), role(READER, SEND), role(OTHER, REACT), role(THIRD, P.MANAGE_THREADS)] })
    expect(permissionsIn({ ...world, memberRoleIds: [READER, OTHER] })).toBe(bits(VIEW, HISTORY, SEND, REACT))
    expect(permissionsIn({ ...world, memberRoleIds: [THIRD] })).toBe(bits(VIEW, HISTORY, P.MANAGE_THREADS))
    expect(permissionsIn({ ...world, memberRoleIds: [] })).toBe(bits(VIEW, HISTORY))
  })

  it('applies the @everyone overwrite to the base: deny, then allow', () => {
    const world = plain({ overwrites: [ow(GUILD, 0, { deny: bits(SEND, REACT), allow: bits(P.MANAGE_THREADS, REACT) })] })
    // REACT is both denied and allowed: the allow is applied last, so it stays.
    expect(permissionsIn(world)).toBe(bits(VIEW, HISTORY, REACT, P.MANAGE_THREADS))
  })

  it('lets the @everyone overwrite take a base bit away', () => {
    const world = plain({ roles: [role(GUILD, VIEW, HISTORY, SEND)], overwrites: [ow(GUILD, 0, { deny: SEND })] })
    expect(permissionsIn(world)).toBe(VIEW | HISTORY)
  })

  it('lets a role allow beat the @everyone deny', () => {
    const world = plain({ overwrites: [ow(GUILD, 0, { deny: bits(VIEW, HISTORY) }), ow(READER, 0, { allow: bits(VIEW, HISTORY) })] })
    expect(permissionsIn({ ...world, memberRoleIds: [READER] })).toBe(VIEW | HISTORY)
    expect(permissionsIn({ ...world, memberRoleIds: [] })).toBe(0n)
  })

  it('lets a role deny beat the @everyone allow: roles come after @everyone', () => {
    const world = plain({ overwrites: [ow(GUILD, 0, { allow: SEND }), ow(READER, 0, { deny: SEND })] })
    expect(permissionsIn({ ...world, memberRoleIds: [READER] })).toBe(VIEW | HISTORY)
    expect(permissionsIn({ ...world, memberRoleIds: [] })).toBe(bits(VIEW, HISTORY, SEND))
  })

  it('lets a role take away a bit that a role gave in the base', () => {
    const world = plain({ roles: [role(GUILD, VIEW, HISTORY), role(READER, SEND)], overwrites: [ow(READER, 0, { deny: SEND })] })
    expect(permissionsIn({ ...world, memberRoleIds: [READER] })).toBe(VIEW | HISTORY)
  })

  it('lets one held role allow beat another held role deny, in either order', () => {
    const denier = ow(READER, 0, { deny: SEND })
    const allower = ow(OTHER, 0, { allow: SEND })
    for (const overwrites of [[denier, allower], [allower, denier]]) {
      for (const memberRoleIds of [[READER, OTHER], [OTHER, READER]]) {
        expect(permissionsIn(plain({ overwrites, memberRoleIds }))).toBe(bits(VIEW, HISTORY, SEND))
      }
    }
  })

  it('denies before it allows inside one role overwrite, and across all the held roles', () => {
    const both = ow(READER, 0, { deny: SEND, allow: SEND })
    expect(permissionsIn(plain({ overwrites: [both], memberRoleIds: [READER] }))).toBe(bits(VIEW, HISTORY, SEND))
    // A deny on one role and an allow on another, for the same bit, in the same stage: the allow stands.
    const world = plain({ overwrites: [ow(READER, 0, { deny: VIEW }), ow(OTHER, 0, { allow: VIEW })], memberRoleIds: [READER, OTHER] })
    expect(permissionsIn(world)).toBe(VIEW | HISTORY)
  })

  it('takes a role deny in full even when it is the only role overwrite', () => {
    const world = plain({ overwrites: [ow(READER, 0, { deny: VIEW })], memberRoleIds: [READER] })
    expect(permissionsIn(world)).toBe(0n)
  })

  it('lets the member deny beat a role allow', () => {
    const world = plain({
      overwrites: [ow(READER, 0, { allow: SEND }), ow(A, 1, { deny: SEND })],
      memberRoleIds: [READER],
    })
    expect(permissionsIn(world)).toBe(VIEW | HISTORY)
  })

  it('lets the member allow beat a role deny', () => {
    const world = plain({
      overwrites: [ow(READER, 0, { deny: VIEW }), ow(A, 1, { allow: VIEW })],
      memberRoleIds: [READER],
    })
    expect(permissionsIn(world)).toBe(VIEW | HISTORY)
  })

  it('lets the member allow beat the @everyone deny', () => {
    const world = plain({ overwrites: [ow(GUILD, 0, { deny: VIEW }), ow(A, 1, { allow: VIEW })] })
    expect(permissionsIn(world)).toBe(VIEW | HISTORY)
  })

  it('denies before it allows inside the member overwrite', () => {
    const world = plain({ overwrites: [ow(A, 1, { deny: bits(SEND, REACT), allow: bits(REACT, THREADS) })] })
    expect(permissionsIn(world)).toBe(bits(VIEW, HISTORY, REACT, THREADS))
  })

  it('applies the member overwrite last of all', () => {
    const world = plain({
      overwrites: [ow(A, 1, { deny: SEND }), ow(READER, 0, { allow: SEND }), ow(GUILD, 0, { allow: SEND })],
      memberRoleIds: [READER],
    })
    expect(permissionsIn(world)).toBe(VIEW | HISTORY)
  })

  it('does not let @everyone count twice when the member is also listed as holding it', () => {
    // @everyone allows Send; a held role denies it. The deny comes later, so Send is gone. Counting the @everyone
    // overwrite again among the held roles would hand Send back.
    const world = plain({ overwrites: [ow(GUILD, 0, { allow: SEND }), ow(READER, 0, { deny: SEND })] })
    expect(permissionsIn({ ...world, memberRoleIds: [READER] })).toBe(VIEW | HISTORY)
    expect(permissionsIn({ ...world, memberRoleIds: [GUILD, READER] })).toBe(VIEW | HISTORY)
    expect(permissionsIn({ ...world, memberRoleIds: [READER, GUILD] })).toBe(VIEW | HISTORY)
  })

  it('counts a held role once however often it is listed', () => {
    const world = plain({ roles: [role(GUILD, VIEW, HISTORY), role(READER, SEND), role(READER, SEND)], overwrites: [ow(READER, 0, { deny: SEND })] })
    expect(permissionsIn({ ...world, memberRoleIds: [READER, READER, READER] })).toBe(VIEW | HISTORY)
  })

  it('answers 0n when View Channel is gone after the overwrites, even with other bits allowed', () => {
    const world = plain({
      roles: [role(GUILD, VIEW, HISTORY, SEND, REACT)],
      overwrites: [ow(A, 1, { deny: VIEW, allow: bits(SEND, REACT, THREADS, HISTORY) })],
    })
    expect(permissionsIn(world)).toBe(0n)
  })

  it('answers 0n when View Channel was never there', () => {
    const world = plain({ roles: [role(GUILD, HISTORY, SEND)], overwrites: [ow(GUILD, 0, { allow: REACT })] })
    expect(permissionsIn(world)).toBe(0n)
  })

  it('keeps the bits when View Channel stays, History or not: only canRead asks for both', () => {
    const world = plain({ roles: [role(GUILD, VIEW, SEND)] })
    expect(permissionsIn(world)).toBe(VIEW | SEND)
    expect(canRead(permissionsIn(world))).toBe(false)
  })

  it('gives the bits back exactly: nothing is added that was not asked for', () => {
    const world = plain({ roles: [role(GUILD, VIEW, P.MANAGE_MESSAGES, P.ATTACH_FILES, P.MANAGE_CHANNELS, HISTORY)] })
    expect(permissionsIn(world)).toBe(bits(VIEW, P.MANAGE_MESSAGES, P.ATTACH_FILES, P.MANAGE_CHANNELS, HISTORY))
  })

  it('reads the high bits too', () => {
    const world = plain({ roles: [role(GUILD, VIEW, HISTORY, P.MANAGE_THREADS, THREADS)], overwrites: [ow(A, 1, { deny: P.MANAGE_THREADS })] })
    expect(permissionsIn(world)).toBe(bits(VIEW, HISTORY, THREADS))
  })
})

describe('permissionsIn: overwrites that are not the member’s', () => {
  const sentinel = () => plain({ memberRoleIds: [READER] })
  const baseline = () => permissionsIn(sentinel())

  it('ignores an overwrite for a role the member does not hold', () => {
    const world = { ...sentinel(), overwrites: [ow(OTHER, 0, { deny: ALL }), ow(THIRD, 0, { allow: ALL })] }
    expect(permissionsIn(world)).toBe(baseline())
    expect(baseline()).toBe(VIEW | HISTORY)
  })

  it('ignores an overwrite for another member', () => {
    const world = { ...sentinel(), overwrites: [ow(B, 1, { deny: ALL }), ow(OWNER, 1, { allow: ALL })] }
    expect(permissionsIn(world)).toBe(baseline())
  })

  it('ignores an overwrite whose type is not role (0) or member (1)', () => {
    for (const type of [2, 3, -1, 0.5, 1.5, '0', '1', true, false, null, undefined, NaN, {}, [], [0], [1], 0n, 1n]) {
      for (const id of [GUILD, READER, A]) {
        const world = { ...sentinel(), overwrites: [{ id, type, allow: String(ALL), deny: String(ALL) }] }
        expect(permissionsIn(world), `${id} ${String(type)}`).toBe(baseline())
      }
    }
  })

  it('ignores a role overwrite that uses the member id, and a member overwrite that uses a role id', () => {
    const world = { ...sentinel(), overwrites: [ow(A, 0, { deny: ALL }), ow(READER, 1, { deny: ALL }), ow(GUILD, 1, { deny: ALL })] }
    expect(permissionsIn(world)).toBe(baseline())
  })

  it('ignores an overwrite with no id, or one that is not a string of digits', () => {
    const world = {
      ...sentinel(),
      overwrites: [
        { type: 0, allow: '0', deny: String(ALL) },
        { type: 1, allow: '0', deny: String(ALL) },
        { id: undefined, type: 0, deny: String(ALL) },
        { id: null, type: 1, deny: String(ALL) },
        { id: Number(A), type: 1, deny: String(ALL) },
        { id: BigInt(A), type: 1, deny: String(ALL) },
        { id: [A], type: 1, deny: String(ALL) },
        { id: `${A} `, type: 1, deny: String(ALL) },
        { id: `${READER}x`, type: 0, deny: String(ALL) },
      ],
    }
    expect(permissionsIn(world)).toBe(baseline())
  })
})

describe('permissionsIn: hostile input is nothing', () => {
  const NOT_LISTS = [undefined, null, 'abc', '', 5, 0, true, {}, { length: 1, 0: { id: GUILD } }, new Set([GUILD]), () => []]

  it('treats roles, overwrites and memberRoleIds that are not arrays as empty', () => {
    for (const value of NOT_LISTS) {
      // No roles: the member has nothing, so nothing to see.
      expect(permissionsIn(plain({ roles: value })), 'roles').toBe(0n)
      // No overwrites: the base stands.
      expect(permissionsIn(plain({ overwrites: value })), 'overwrites').toBe(VIEW | HISTORY)
      // No held roles: only @everyone.
      expect(permissionsIn(plain({ roles: [role(GUILD, VIEW, HISTORY), role(READER, SEND)], memberRoleIds: value })), 'memberRoleIds').toBe(VIEW | HISTORY)
    }
  })

  it('treats a list that is not a list of objects as having nothing in it', () => {
    const junk = [null, undefined, 0, 5, 'x', true, [], [GUILD], () => 0]
    expect(permissionsIn(plain({ roles: [...junk, role(GUILD, VIEW, HISTORY)], overwrites: junk }))).toBe(VIEW | HISTORY)
    expect(permissionsIn(plain({ roles: [role(GUILD, VIEW, HISTORY), role(READER, SEND)], memberRoleIds: [...junk, READER] }))).toBe(
      bits(VIEW, HISTORY, SEND),
    )
  })

  it('answers 0n for a guildId that is not a snowflake: 16 and 21 digits, letters, a number, nothing', () => {
    // The role ids below match the bad guild id, so the answer is 0n only if the guild id is refused outright.
    for (const bad of ['1'.repeat(16), '1'.repeat(21), '12a', '', ' ', `${GUILD} `, `x${GUILD}`, '-1', '1e3', Number(GUILD), BigInt(GUILD), undefined, null, [GUILD], {}]) {
      const world = plain({ guildId: bad, ownerId: A, roles: [{ id: bad, permissions: String(ALL & ~P.ADMINISTRATOR) }], overwrites: [] })
      expect(permissionsIn(world), String(bad)).toBe(0n)
      expect(permissionsIn({ ...world, ownerId: OWNER }), String(bad)).toBe(0n)
    }
  })

  it('answers 0n for a memberId that is not a snowflake, even when it equals ownerId', () => {
    for (const bad of ['1'.repeat(16), '1'.repeat(21), '12a', '', ' ', `${A} `, '-1', '1e3', Number(A), BigInt(A), undefined, null, [A], {}]) {
      const world = plain({ memberId: bad, ownerId: bad, overwrites: [ow(GUILD, 0, { allow: ALL })] })
      expect(permissionsIn(world), String(bad)).toBe(0n)
    }
  })

  it('makes nobody the owner when ownerId is not the member', () => {
    for (const ownerId of [undefined, null, '', '12a', Number(A), BigInt(A), [A], { id: A }, `${A} `, B]) {
      const world = plain({ ownerId, roles: [role(GUILD)], overwrites: [ow(GUILD, 0, { deny: ALL })] })
      expect(permissionsIn(world), String(ownerId)).toBe(0n)
    }
  })

  it('takes a snowflake of 17 to 20 digits', () => {
    for (const n of [17, 18, 19, 20]) {
      const guildId = '3'.repeat(n)
      const memberId = '4'.repeat(n)
      const roleId = '5'.repeat(n)
      const world = {
        guildId,
        ownerId: '6'.repeat(n),
        roles: [role(guildId, VIEW), role(roleId, HISTORY)],
        overwrites: [ow(guildId, 0, { allow: SEND }), ow(roleId, 0, { allow: REACT }), ow(memberId, 1, { allow: THREADS })],
        memberId,
        memberRoleIds: [roleId],
      }
      expect(permissionsIn(world), `${n} digits`).toBe(bits(VIEW, HISTORY, SEND, REACT, THREADS))
      expect(permissionsIn({ ...world, ownerId: memberId }), `${n} digits, owner`).toBe(ALL)
    }
  })

  it('ignores a held role whose id is not a snowflake, even when a role of that id grants Administrator', () => {
    for (const bad of ['12a', '1'.repeat(16), '1'.repeat(21), '', '-1', '1e3']) {
      const world = plain({
        roles: [role(GUILD, VIEW, HISTORY), role(bad, P.ADMINISTRATOR, SEND)],
        overwrites: [ow(bad, 0, { allow: REACT })],
        memberRoleIds: [bad],
      })
      expect(permissionsIn(world), bad).toBe(VIEW | HISTORY)
    }
  })

  it('ignores a held id that is not a string, even when a role carries it', () => {
    const world = plain({ roles: [role(GUILD, VIEW, HISTORY), { id: Number(READER), permissions: String(P.ADMINISTRATOR) }, { id: BigInt(OTHER), permissions: String(P.ADMINISTRATOR) }] })
    for (const memberRoleIds of [[Number(READER)], [BigInt(OTHER)], [[READER]], [{ id: READER }], [null], [undefined]]) {
      expect(permissionsIn({ ...world, memberRoleIds })).toBe(VIEW | HISTORY)
    }
  })

  it('reads a permission that is not a string of digits as none', () => {
    for (const bad of ['-1', '12a', '1e3', '', ' 8', '8 ', '9'.repeat(41), 8, 1024, -1, NaN, Infinity, null, undefined, {}, [], ['8'], true]) {
      // Bad on @everyone: no View, so nothing. (An Administrator that is not readable must not become one.)
      const everyone = plain({ roles: [{ id: GUILD, permissions: bad }, role(READER, VIEW, HISTORY)], memberRoleIds: [READER] })
      expect(permissionsIn(everyone), String(bad)).toBe(VIEW | HISTORY)
      const noAdmin = plain({ roles: [role(GUILD, VIEW, HISTORY), { id: READER, permissions: bad }], memberRoleIds: [READER] })
      expect(permissionsIn(noAdmin), String(bad)).toBe(VIEW | HISTORY)
    }
  })

  it('does not let a malformed Administrator value through', () => {
    for (const bad of [8, '8.0', '0x8', '+8', ' 8', '8 ', '٨']) {
      const world = plain({ roles: [role(GUILD, VIEW, HISTORY), { id: READER, permissions: bad }], memberRoleIds: [READER] })
      expect(permissionsIn(world), String(bad)).toBe(VIEW | HISTORY)
    }
  })

  it('reads an overwrite allow or deny that is not a string of digits as none', () => {
    for (const bad of ['-1', '12a', '1e3', '', '9'.repeat(41), 1024, -1, NaN, null, undefined, {}, [], true]) {
      const deny = plain({ overwrites: [{ id: GUILD, type: 0, allow: '0', deny: bad }, { id: READER, type: 0, allow: '0', deny: bad }, { id: A, type: 1, allow: '0', deny: bad }], memberRoleIds: [READER] })
      expect(permissionsIn(deny), `deny ${String(bad)}`).toBe(VIEW | HISTORY)
      const allow = plain({ roles: [role(GUILD)], overwrites: [{ id: GUILD, type: 0, allow: bad, deny: '0' }, { id: READER, type: 0, allow: bad, deny: '0' }, { id: A, type: 1, allow: bad, deny: '0' }], memberRoleIds: [READER] })
      expect(permissionsIn(allow), `allow ${String(bad)}`).toBe(0n)
    }
  })

  it('reads an overwrite with no allow or no deny as having none', () => {
    const world = plain({ overwrites: [{ id: GUILD, type: 0, allow: String(SEND) }, { id: A, type: 1, deny: String(HISTORY) }] })
    expect(permissionsIn(world)).toBe(VIEW | SEND)
  })

  it('takes a bigint where a string belongs, as toBits does', () => {
    // Role permissions and overwrite bits are strings on the wire; a bigint behaves as the number it is.
    const world = plain({ roles: [{ id: GUILD, permissions: VIEW | HISTORY }] })
    expect(permissionsIn(world)).toBe(VIEW | HISTORY)
  })
})

describe('permissionsIn: properties', () => {
  // A world of valid ids drawn from a small pool, so the same id turns up in the roles, the held list and the
  // overwrites often enough to matter.
  const BIT_POOL = [VIEW, HISTORY, SEND, REACT, THREADS, P.MANAGE_THREADS, P.ATTACH_FILES, P.MANAGE_MESSAGES, P.MANAGE_CHANNELS]
  const bitsArb = fc.oneof(
    { weight: 20, arbitrary: fc.subarray(BIT_POOL).map((list) => bits(...list)) },
    { weight: 1, arbitrary: fc.constant(P.ADMINISTRATOR) },
    { weight: 1, arbitrary: fc.bigInt({ min: 0n, max: ALL }) },
  )
  const ROLE_IDS = [READER, OTHER, THIRD]
  const overwriteArb = fc.record({
    id: fc.constantFrom(GUILD, READER, OTHER, THIRD, A, B),
    type: fc.constantFrom(0, 1, 0, 1, 2),
    allow: bitsArb.map(String),
    deny: bitsArb.map(String),
  })
  const worldArb = fc.record({
    guildId: fc.constant(GUILD),
    ownerId: fc.constantFrom(OWNER, OWNER, OWNER, A),
    roles: fc.tuple(bitsArb, bitsArb, bitsArb, bitsArb).map(([g, r, o, t]) => [role(GUILD, g), role(READER, r), role(OTHER, o), role(THIRD, t)]),
    overwrites: fc.array(overwriteArb, { maxLength: 8 }),
    memberId: fc.constantFrom(A, B),
    memberRoleIds: fc.subarray(ROLE_IDS),
  })

  // A second, bit-by-bit reading of Discord's rules, written differently from the module so the two cannot share a mistake.
  const bitOf = (n, i) => ((n >> BigInt(i)) & 1n) === 1n
  function expected(w) {
    if (w.ownerId === w.memberId) return ALL
    const holds = (id) => id === w.guildId || w.memberRoleIds.includes(id)
    const heldRoles = w.roles.filter((r) => holds(r.id))
    if (heldRoles.some((r) => bitOf(BigInt(r.permissions), 3))) return ALL
    const everyone = w.overwrites.filter((o) => o.type === 0 && o.id === w.guildId)
    const roles = w.overwrites.filter((o) => o.type === 0 && o.id !== w.guildId && w.memberRoleIds.includes(o.id))
    const member = w.overwrites.filter((o) => o.type === 1 && o.id === w.memberId)
    let out = 0n
    for (let i = 0; i < 64; i++) {
      let on = heldRoles.some((r) => bitOf(BigInt(r.permissions), i))
      for (const stage of [everyone, roles, member]) {
        if (stage.some((o) => bitOf(BigInt(o.deny), i))) on = false
        if (stage.some((o) => bitOf(BigInt(o.allow), i))) on = true
      }
      if (on) out |= 1n << BigInt(i)
    }
    return bitOf(out, 10) ? out : 0n
  }

  it('property: it agrees with a bit-by-bit reading of the rules, over any world', () => {
    fc.assert(
      fc.property(worldArb, (w) => {
        expect(permissionsIn(w)).toBe(expected(w))
      }),
      { numRuns: 2000 },
    )
  })

  it('property: the answer is nothing, or has View Channel', () => {
    fc.assert(
      fc.property(worldArb, (w) => {
        const out = permissionsIn(w)
        expect(out === 0n || (out & VIEW) === VIEW).toBe(true)
      }),
    )
  })

  it('property: the owner has everything, whatever the world', () => {
    fc.assert(
      fc.property(worldArb, (w) => {
        expect(permissionsIn({ ...w, ownerId: w.memberId })).toBe(ALL)
      }),
    )
  })

  it('property: the order of the roles, the overwrites and the held list changes nothing', () => {
    fc.assert(
      fc.property(worldArb, fc.infiniteStream(fc.nat()), (w, seed) => {
        const shuffle = (list) => {
          const out = [...list]
          const it = seed[Symbol.iterator]()
          for (let i = out.length - 1; i > 0; i--) {
            const j = it.next().value % (i + 1)
            ;[out[i], out[j]] = [out[j], out[i]]
          }
          return out
        }
        const shuffled = { ...w, roles: shuffle(w.roles), overwrites: shuffle(w.overwrites), memberRoleIds: shuffle(w.memberRoleIds) }
        expect(permissionsIn(shuffled)).toBe(permissionsIn(w))
      }),
    )
  })

  it('property: an allow-only overwrite for a held role never removes a bit', () => {
    fc.assert(
      fc.property(worldArb, bitsArb, (w, extra) => {
        const held = w.memberRoleIds[0]
        fc.pre(held !== undefined)
        const without = permissionsIn(w)
        const withAllow = permissionsIn({ ...w, overwrites: [...w.overwrites, ow(held, 0, { allow: extra })] })
        expect(withAllow & without).toBe(without)
      }),
    )
  })

  it('property: a deny-only member overwrite never adds a bit', () => {
    fc.assert(
      fc.property(worldArb, bitsArb, (w, extra) => {
        const without = permissionsIn(w)
        const withDeny = permissionsIn({ ...w, overwrites: [...w.overwrites, ow(w.memberId, 1, { deny: extra })] })
        expect(withDeny & ~without).toBe(0n)
      }),
    )
  })

  it('property: an overwrite for a role not held, or another member, changes nothing', () => {
    fc.assert(
      fc.property(worldArb, bitsArb, bitsArb, (w, allow, deny) => {
        const stranger = ROLE_IDS.find((id) => !w.memberRoleIds.includes(id))
        fc.pre(stranger !== undefined)
        const other = w.memberId === A ? B : A
        const noise = [ow(stranger, 0, { allow, deny }), ow(other, 1, { allow, deny })]
        expect(permissionsIn({ ...w, overwrites: [...w.overwrites, ...noise] })).toBe(permissionsIn(w))
      }),
    )
  })

  it('property: listing @everyone among the held roles changes nothing', () => {
    fc.assert(
      fc.property(worldArb, (w) => {
        expect(permissionsIn({ ...w, memberRoleIds: [...w.memberRoleIds, GUILD] })).toBe(permissionsIn(w))
      }),
    )
  })

  it('property: it does not change what it is given', () => {
    fc.assert(
      fc.property(worldArb, (w) => {
        const before = JSON.stringify(w)
        permissionsIn(w)
        expect(JSON.stringify(w)).toBe(before)
      }),
    )
  })
})
