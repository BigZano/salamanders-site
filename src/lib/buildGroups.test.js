import { describe, it, expect } from 'vitest'
import { isMemberAuthor, splitByMembership, paginate, PAGE_SIZE } from './buildGroups'

const build = (authorId) => ({ author: { id: authorId } })
const ids = ['a', 'b', 'c']

describe('isMemberAuthor', () => {
  it('is true when the author id is in the member list', () => {
    expect(isMemberAuthor(build('b'), ids)).toBe(true)
  })

  it('is false when the author id is not in the member list', () => {
    expect(isMemberAuthor(build('z'), ids)).toBe(false)
  })

  it('is false for a build with no author, no author.id, null, or undefined', () => {
    expect(isMemberAuthor({}, ids)).toBe(false)
    expect(isMemberAuthor({ author: {} }, ids)).toBe(false)
    expect(isMemberAuthor(null, ids)).toBe(false)
    expect(isMemberAuthor(undefined, ids)).toBe(false)
  })

  it('does not coerce types — a numeric id never matches a string member list', () => {
    expect(isMemberAuthor(build(1), ['1'])).toBe(false)
  })
})

describe('splitByMembership', () => {
  it('partitions builds into member and other, preserving relative order in each', () => {
    const builds = [build('a'), build('z'), build('b'), build('y')]
    const { member, other } = splitByMembership(builds, ids)
    expect(member).toEqual([build('a'), build('b')])
    expect(other).toEqual([build('z'), build('y')])
  })

  it('returns two empty arrays for an empty input', () => {
    expect(splitByMembership([], ids)).toEqual({ member: [], other: [] })
  })

  it('puts everything in "other" when the member list is empty', () => {
    const builds = [build('a'), build('b')]
    expect(splitByMembership(builds, [])).toEqual({ member: [], other: builds })
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
