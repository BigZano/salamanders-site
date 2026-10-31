import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { createMembership } from './membership'
import { Upstream } from './discordRoles'

// Invented ids only: real role and user ids never enter the repo.
const ROLE = '300000000000000012'
const OTHER = '300000000000000013'
const ME = '300000000000000001'
const SOMEONE = '300000000000000002'

const req = (token) =>
  new Request('https://api.test/membership', { headers: token ? { Authorization: `Bearer ${token}` } : {} })

// A fake Discord seam. Whatever is not scripted throws a distinctive plain
// Error, so a test fails if the code under test reaches a method it should not.
const UNEXPECTED = () => {
  throw new Error('unexpected call')
}
const fakeRoles = ({ identify = UNEXPECTED, rolesOf = UNEXPECTED } = {}) => ({
  identify: async (request) => identify(request),
  rolesOf: async (id) => rolesOf(id),
})
// Signed in as ME, whose guild roles are `held` (null = not in the guild).
const asMe = (held) =>
  fakeRoles({
    identify: () => ({ id: ME, username: 'invented-name' }),
    rolesOf: (id) => {
      if (id !== ME) throw new Error('asked about someone else')
      return held
    },
  })

describe('membership.check — who is calling, and are they a member', () => {
  it('a holder is a member', async () => {
    const m = createMembership({ roles: asMe([OTHER, ROLE]), roleId: ROLE })
    await expect(m.check(req('tok'))).resolves.toStrictEqual({ id: ME, member: true })
  })

  it('someone with only other roles is not', async () => {
    const m = createMembership({ roles: asMe([OTHER]), roleId: ROLE })
    await expect(m.check(req('tok'))).resolves.toStrictEqual({ id: ME, member: false })
  })

  it('someone with no roles at all is not', async () => {
    const m = createMembership({ roles: asMe([]), roleId: ROLE })
    await expect(m.check(req('tok'))).resolves.toStrictEqual({ id: ME, member: false })
  })

  it('someone not in the guild (rolesOf null) is not', async () => {
    const m = createMembership({ roles: asMe(null), roleId: ROLE })
    await expect(m.check(req('tok'))).resolves.toStrictEqual({ id: ME, member: false })
  })

  it('the result is exactly { id, member }: the username never leaks out', async () => {
    const m = createMembership({ roles: asMe([ROLE]), roleId: ROLE })
    const result = await m.check(req('tok'))
    expect(Object.keys(result).sort()).toEqual(['id', 'member'])
  })

  it('answers for the caller the token names, and looks up that caller\'s roles', async () => {
    const roles = fakeRoles({
      identify: (request) =>
        request.headers.get('Authorization') === 'Bearer tok-member'
          ? { id: SOMEONE, username: 'x' }
          : { id: ME, username: 'y' },
      rolesOf: (id) => (id === SOMEONE ? [ROLE] : []),
    })
    const m = createMembership({ roles, roleId: ROLE })
    await expect(m.check(req('tok-member'))).resolves.toStrictEqual({ id: SOMEONE, member: true })
    await expect(m.check(req('tok-other'))).resolves.toStrictEqual({ id: ME, member: false })
  })

  it('no or invalid token is null and asks Discord for nothing more', async () => {
    // rolesOf throws if it is reached, so resolving to null proves it was not.
    const roles = fakeRoles({ identify: () => null })
    const m = createMembership({ roles, roleId: ROLE })
    await expect(m.check(req())).resolves.toBeNull()
    await expect(m.check(req('stale'))).resolves.toBeNull()
  })

  it('is told apart from a non-member: null is not { member: false }', async () => {
    const stranger = createMembership({ roles: fakeRoles({ identify: () => null }), roleId: ROLE })
    const outsider = createMembership({ roles: asMe([]), roleId: ROLE })
    expect(await stranger.check(req('t'))).toBeNull()
    expect(await outsider.check(req('t'))).not.toBeNull()
  })

  describe('Discord cannot answer', () => {
    it('Upstream from identify propagates', async () => {
      const boom = new Upstream('identify is down')
      const m = createMembership({
        roles: fakeRoles({
          identify: () => {
            throw boom
          },
        }),
        roleId: ROLE,
      })
      await expect(m.check(req('tok'))).rejects.toBe(boom)
      await expect(m.check(req('tok'))).rejects.toBeInstanceOf(Upstream)
    })

    it('Upstream from rolesOf propagates', async () => {
      const boom = new Upstream('rolesOf is down')
      const m = createMembership({
        roles: fakeRoles({
          identify: () => ({ id: ME, username: 'x' }),
          rolesOf: () => {
            throw boom
          },
        }),
        roleId: ROLE,
      })
      await expect(m.check(req('tok'))).rejects.toBe(boom)
      await expect(m.check(req('tok'))).rejects.toBeInstanceOf(Upstream)
    })

    it('any other error from either call propagates unchanged, never as non-member', async () => {
      const fromIdentify = new TypeError('identify blew up')
      const fromRoles = new RangeError('rolesOf blew up')
      const a = createMembership({
        roles: fakeRoles({
          identify: () => {
            throw fromIdentify
          },
        }),
        roleId: ROLE,
      })
      const b = createMembership({
        roles: fakeRoles({
          identify: () => ({ id: ME, username: 'x' }),
          rolesOf: () => {
            throw fromRoles
          },
        }),
        roleId: ROLE,
      })
      await expect(a.check(req('tok'))).rejects.toBe(fromIdentify)
      await expect(b.check(req('tok'))).rejects.toBe(fromRoles)
    })
  })

  describe('an unconfigured roleId fails closed before asking Discord', () => {
    // identify throws a plain Error if reached, so rejecting with Upstream
    // proves the roleId was checked first.
    const NOT_A_ROLE = [undefined, '', null, 0, 300000000000000012, true, false, {}, [], [ROLE], () => ROLE]
    it.each(NOT_A_ROLE.map((v) => [typeof v === 'function' ? 'a function' : JSON.stringify(v) ?? 'undefined', v]))(
      'roleId %s rejects with Upstream',
      async (_label, roleId) => {
        const m = createMembership({ roles: fakeRoles(), roleId })
        await expect(m.check(req('tok'))).rejects.toBeInstanceOf(Upstream)
      },
    )

    it('says so plainly', async () => {
      const m = createMembership({ roles: fakeRoles(), roleId: '' })
      await expect(m.check(req('tok'))).rejects.toThrow('Membership is not configured.')
    })

    it('fails closed even when there is no token to look at', async () => {
      const m = createMembership({ roles: fakeRoles(), roleId: undefined })
      await expect(m.check(req())).rejects.toBeInstanceOf(Upstream)
    })

    it('is a rejection of check, not a throw from createMembership', async () => {
      let m
      expect(() => {
        m = createMembership({ roles: fakeRoles(), roleId: undefined })
      }).not.toThrow()
      const pending = m.check(req('tok'))
      expect(pending).toBeInstanceOf(Promise)
      await expect(pending).rejects.toBeInstanceOf(Upstream)
    })
  })

  describe('roles are compared as strings', () => {
    it('a number never matches, even one that reads the same', async () => {
      const m = createMembership({ roles: asMe([Number(ROLE)]), roleId: ROLE })
      await expect(m.check(req('tok'))).resolves.toStrictEqual({ id: ME, member: false })
    })

    it('a short numeric id is not matched by the number either', async () => {
      const m = createMembership({ roles: asMe([42]), roleId: '42' })
      await expect(m.check(req('tok'))).resolves.toStrictEqual({ id: ME, member: false })
    })

    it('a longer id that merely contains the role id is not a match', async () => {
      const m = createMembership({ roles: asMe([`${ROLE}9`, `9${ROLE}`]), roleId: ROLE })
      await expect(m.check(req('tok'))).resolves.toStrictEqual({ id: ME, member: false })
    })
  })

  describe('a rolesOf answer that is not a role list fails closed', () => {
    const ODD = [
      ['a string equal to the role id', ROLE],
      ['a string containing the role id', `a ${ROLE} b`],
      ['an object that answers includes() with true', { includes: () => true }],
      ['an object keyed by the role id', { [ROLE]: true }],
      ['a number', 7],
      ['true', true],
      ['an empty string', ''],
      ['undefined', undefined],
    ]
    it.each(ODD)('%s is member: false, never a throw and never true', async (_label, answer) => {
      const m = createMembership({ roles: asMe(answer), roleId: ROLE })
      await expect(m.check(req('tok'))).resolves.toStrictEqual({ id: ME, member: false })
    })
  })

  describe('properties', () => {
    const roleish = fc.oneof(fc.constant(ROLE), fc.constant(OTHER), fc.string(), fc.integer(), fc.constant(null))

    it('member is exactly "the role list holds the role id", and always a boolean', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(roleish, { maxLength: 12 }), async (held) => {
          const m = createMembership({ roles: asMe(held), roleId: ROLE })
          const result = await m.check(req('tok'))
          expect(result).toStrictEqual({ id: ME, member: held.some((r) => r === ROLE) })
        }),
      )
    })

    it('never a member without the role, whatever else is held or answered', async () => {
      const anything = fc.anything({ withNullPrototype: false })
      await fc.assert(
        fc.asyncProperty(anything, async (answer) => {
          fc.pre(!(Array.isArray(answer) && answer.includes(ROLE)))
          const m = createMembership({ roles: asMe(answer), roleId: ROLE })
          const result = await m.check(req('tok'))
          expect(result).toStrictEqual({ id: ME, member: false })
        }),
      )
    })

    it('an unconfigured roleId (anything but a non-empty string) always rejects Upstream', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.anything().filter((v) => typeof v !== 'string'),
          async (roleId) => {
            const m = createMembership({ roles: fakeRoles(), roleId })
            await expect(m.check(req('tok'))).rejects.toBeInstanceOf(Upstream)
          },
        ),
      )
    })
  })
})
