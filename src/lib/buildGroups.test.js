import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { isMemberAuthor, splitByMembership, paginate, PAGE_SIZE } from './buildGroups'

// The server decides who is a member and says so per build, only to a signed-in viewer
// (server/src/buildsView.js). The page just reads that answer.
const flagged = (member, title = 't') => ({ title, author: { id: '300000000000000001', member } })

describe('isMemberAuthor', () => {
  it('is true when the server flagged the author as a member', () => {
    expect(isMemberAuthor(flagged(true))).toBe(true)
  })

  it('is false when the server flagged the author as not a member', () => {
    expect(isMemberAuthor(flagged(false))).toBe(false)
  })

  it('is false for every flag value that is not the boolean true', () => {
    for (const member of ['true', 'TRUE', 1, -1, 'yes', [true], { member: true }, NaN, 0, '', null, undefined]) {
      expect(isMemberAuthor(flagged(member))).toBe(false)
    }
  })

  it('is false when the flag is missing, which is what a signed-out response looks like', () => {
    expect(isMemberAuthor({ author: { id: '300000000000000001' } })).toBe(false)
    expect(isMemberAuthor({ author: {} })).toBe(false)
  })

  it('is false for a build with no author, a null author, null, or undefined', () => {
    expect(isMemberAuthor({})).toBe(false)
    expect(isMemberAuthor({ author: null })).toBe(false)
    expect(isMemberAuthor(null)).toBe(false)
    expect(isMemberAuthor(undefined)).toBe(false)
    expect(isMemberAuthor()).toBe(false)
  })

  it('reads the flag only, never the author id', () => {
    const a = { author: { id: '300000000000000001', member: true } }
    const b = { author: { id: '300000000000000001' } }
    expect(isMemberAuthor(a)).toBe(true)
    expect(isMemberAuthor(b)).toBe(false)
  })

  it('does not read a member flag that sits anywhere but on the author', () => {
    expect(isMemberAuthor({ member: true, author: { id: '300000000000000001' } })).toBe(false)
    expect(isMemberAuthor({ isMember: true, author: { id: '300000000000000001' } })).toBe(false)
  })
})

describe('splitByMembership', () => {
  it('partitions builds into member and other, preserving relative order in each', () => {
    const builds = [flagged(true, 'a'), flagged(false, 'z'), flagged(true, 'b'), flagged(undefined, 'y'), flagged(true, 'c')]
    const { member, other } = splitByMembership(builds)
    expect(member.map((b) => b.title)).toEqual(['a', 'b', 'c'])
    expect(other.map((b) => b.title)).toEqual(['z', 'y'])
  })

  it('returns the same build objects, not copies', () => {
    const m = flagged(true)
    const o = flagged(false)
    const { member, other } = splitByMembership([o, m])
    expect(member[0]).toBe(m)
    expect(other[0]).toBe(o)
  })

  it('returns two empty arrays for an empty input', () => {
    expect(splitByMembership([])).toEqual({ member: [], other: [] })
  })

  it('puts everything in "other" when nothing is flagged, as for a signed-out viewer', () => {
    const builds = [{ author: { id: '300000000000000001' } }, { author: { id: '300000000000000002' } }]
    expect(splitByMembership(builds)).toEqual({ member: [], other: builds })
  })

  it('puts everything in "member" when every author is flagged', () => {
    const builds = [flagged(true, 'a'), flagged(true, 'b')]
    expect(splitByMembership(builds)).toEqual({ member: builds, other: [] })
  })

  it('sorts two builds by the same author id differently when their flags differ', () => {
    const yes = { title: 'yes', author: { id: '300000000000000001', member: true } }
    const no = { title: 'no', author: { id: '300000000000000001', member: false } }
    const { member, other } = splitByMembership([no, yes])
    expect(member).toEqual([yes])
    expect(other).toEqual([no])
  })

  it('files hostile entries under "other" instead of throwing', () => {
    const odd = [null, undefined, {}, { author: null }, flagged('true'), flagged(1)]
    expect(splitByMembership(odd)).toEqual({ member: [], other: odd })
  })

  it('does not change the list it was given', () => {
    const builds = [flagged(true, 'a'), flagged(false, 'b')]
    const copy = [...builds]
    splitByMembership(builds)
    expect(builds).toEqual(copy)
  })

  it('property: every build lands in exactly one group, in order, and the group is decided by the flag alone', () => {
    const flag = fc.constantFrom(true, false, undefined, null, 'true', 1, 0)
    fc.assert(
      fc.property(fc.array(flag, { maxLength: 40 }), (flags) => {
        const builds = flags.map((member, i) => flagged(member, String(i)))
        const { member, other } = splitByMembership(builds)
        expect(member.length + other.length).toBe(builds.length)
        expect(member).toEqual(builds.filter((b) => b.author.member === true))
        expect(other).toEqual(builds.filter((b) => b.author.member !== true))
      }),
    )
  })
})

describe('paginate', () => {
  const items = Array.from({ length: 25 }, (_, i) => i)

  it('returns the first PAGE_SIZE items on page 1 with the right page count', () => {
    const r = paginate(items, 1)
    expect(r.items).toEqual(items.slice(0, PAGE_SIZE))
    expect(r.page).toBe(1)
    expect(r.pageCount).toBe(3) // 25 items / 10 per page, rounded up
  })

  it('returns the correct slice for a middle page', () => {
    const r = paginate(items, 2)
    expect(r.items).toEqual(items.slice(10, 20))
    expect(r.page).toBe(2)
  })

  it('returns a partial final page, not padded or truncated further', () => {
    const r = paginate(items, 3)
    expect(r.items).toEqual(items.slice(20, 25))
    expect(r.items).toHaveLength(5)
  })

  it('clamps a page past the end to the last real page, rather than returning empty', () => {
    const r = paginate(items, 999)
    expect(r.page).toBe(3)
    expect(r.items).toEqual(items.slice(20, 25))
  })

  it('clamps page 0 and negative pages up to page 1', () => {
    expect(paginate(items, 0).page).toBe(1)
    expect(paginate(items, -5).page).toBe(1)
  })

  it('truncates a fractional page down rather than rounding', () => {
    // page 1.9 must not become page 2 — 1.9 items into page 1 is still page 1.
    expect(paginate(items, 1.9).page).toBe(1)
  })

  it('treats NaN and Infinity as page 1 instead of propagating a broken slice', () => {
    expect(paginate(items, NaN).page).toBe(1)
    expect(paginate(items, Infinity).page).toBe(1)
  })

  it('an exact multiple of the page size does not spill an empty trailing page', () => {
    const exact = Array.from({ length: 20 }, (_, i) => i)
    expect(paginate(exact, 1).pageCount).toBe(2)
    expect(paginate(exact, 2).items).toHaveLength(10)
  })

  it('reports pageCount 1 (not 0) for an empty list, so "page 1 of 1" reads sanely', () => {
    const r = paginate([], 1)
    expect(r.pageCount).toBe(1)
    expect(r.items).toEqual([])
  })

  it('honors a custom page size', () => {
    const r = paginate(items, 1, 4)
    expect(r.items).toHaveLength(4)
    expect(r.pageCount).toBe(7) // ceil(25/4)
  })
})
