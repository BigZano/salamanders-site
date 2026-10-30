import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { rowToBuild, publicBuild } from './buildRow'

const row = {
  id: 7, title: 'Melta Bulwark', role: 'Frontline', notes: 'n', class_name: 'Bulwark', level: 25, prestige: 2,
  prestige_picks: [], perks: {}, perk_ids: {}, justifications: {}, weapons: {}, weapon_perks: {},
  author_discord_id: '300000000000000001', author_discord_username: 'secret-handle', created_at: 't',
}

describe('publicBuild', () => {
  it('names the author by display name and never carries the username', () => {
    const seen = []
    const out = publicBuild(rowToBuild(row), (id) => (seen.push(id), 'Vulkan'))
    expect(seen).toEqual(['300000000000000001'])
    expect(out.author).toEqual({ id: '300000000000000001', displayName: 'Vulkan' })
    expect(JSON.stringify(out)).not.toContain('secret-handle')
    expect(JSON.stringify(out)).not.toContain('username')
  })

  it('keeps every other build field as rowToBuild shaped it', () => {
    const { author: _a, ...rest } = rowToBuild(row)
    const { author: _b, ...pub } = publicBuild(rowToBuild(row), () => 'x')
    expect(pub).toEqual(rest)
  })

  it('does not modify the build it was given', () => {
    const b = rowToBuild(row)
    publicBuild(b, () => 'x')
    expect(b.author).toEqual({ id: '300000000000000001', username: 'secret-handle' })
  })

  describe('the member flag', () => {
    const ID = '300000000000000001'
    const holds = (id) => id === ID

    it('author has no member key when isMember is null', () => {
      const out = publicBuild(rowToBuild(row), () => 'Vulkan', null)
      expect('member' in out.author).toBe(false)
      expect(out.author).toStrictEqual({ id: ID, displayName: 'Vulkan' })
    })

    it('author has no member key when isMember is left out', () => {
      const out = publicBuild(rowToBuild(row), () => 'Vulkan')
      expect('member' in out.author).toBe(false)
      expect('member' in out).toBe(false)
    })

    it('author.member is a real boolean when isMember is given', () => {
      const yes = publicBuild(rowToBuild(row), () => 'Vulkan', holds)
      expect(yes.author).toStrictEqual({ id: ID, displayName: 'Vulkan', member: true })

      const no = publicBuild({ ...rowToBuild(row), author: { id: '300000000000000002', username: 'x' } }, () => 'Vulkan', holds)
      expect(no.author).toStrictEqual({ id: '300000000000000002', displayName: 'Vulkan', member: false })
    })

    it('asks about the build\'s own author, and the flag lives only on the author', () => {
      const out = publicBuild(rowToBuild(row), () => 'Vulkan', holds)
      expect('member' in out).toBe(false)
      const { author: _a, ...rest } = rowToBuild(row)
      const { author: _b, ...pub } = out
      expect(pub).toEqual(rest)
    })

    it('a flag that returns something other than a boolean fails closed to false', () => {
      for (const truthy of [1, 'yes', 'true', {}, [], [true], Symbol('s'), () => true]) {
        const out = publicBuild(rowToBuild(row), () => 'Vulkan', () => truthy)
        expect(out.author.member, String(typeof truthy)).toBe(false)
      }
      for (const falsy of [0, '', null, undefined, NaN, false]) {
        const out = publicBuild(rowToBuild(row), () => 'Vulkan', () => falsy)
        expect(out.author.member).toBe(false)
      }
    })

    it('property: member is true exactly when the flag says the boolean true', () => {
      fc.assert(
        fc.property(fc.anything(), (answer) => {
          const out = publicBuild(rowToBuild(row), () => 'Vulkan', () => answer)
          expect(out.author.member).toBe(answer === true)
        }),
      )
    })

    it('property: anything that is not a function is no flag at all', () => {
      fc.assert(
        fc.property(
          fc.anything().filter((v) => typeof v !== 'function'),
          (notAFlag) => {
            const out = publicBuild(rowToBuild(row), () => 'Vulkan', notAFlag)
            expect('member' in out.author).toBe(false)
          },
        ),
      )
    })

    it('does not modify the build it was given', () => {
      const b = rowToBuild(row)
      publicBuild(b, () => 'x', holds)
      expect(b.author).toEqual({ id: ID, username: 'secret-handle' })
    })
  })
})
