// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { stashAnchor, takeAnchor, clearAnchor } from './anchor'

const P = '/ranks/200000000000000001'
const H = '#m-200000000000000011'
beforeEach(() => sessionStorage.clear())

describe('archive anchor stash', () => {
  it('restores the anchor only on the page it was stashed from, then forgets it', () => {
    stashAnchor(P, H)
    expect(takeAnchor(P)).toBe(H)
    expect(takeAnchor(P)).toBeNull()
  })
  it('a stash from another page is never applied here, and is dropped', () => {
    stashAnchor(P, H)
    expect(takeAnchor('/accolades/100000000000000001')).toBeNull()
    expect(takeAnchor(P)).toBeNull()
  })
  it.each([
    ['/builds', H],
    ['/ranksx/200000000000000001', H],
    [P, '#<img onerror=1>'],
    [P, ''],
  ])('ignores non-archive path or invalid hash (%s, %s) and clears any old stash', (path, hash) => {
    stashAnchor(P, H)
    stashAnchor(path, hash)
    expect(takeAnchor(path)).toBeNull()
    expect(takeAnchor(P)).toBeNull()
  })
  it('landing pages count as archive paths', () => {
    stashAnchor('/accolades', '#m-100000000000000011')
    expect(takeAnchor('/accolades')).toBe('#m-100000000000000011')
  })
  it('clearAnchor drops a pending stash (failed / refused sign-in)', () => {
    stashAnchor(P, H)
    clearAnchor()
    expect(takeAnchor(P)).toBeNull()
  })
  it('tampered storage is ignored', () => {
    sessionStorage.setItem('salamanders-archive-anchor', '{not json')
    expect(takeAnchor(P)).toBeNull()
    sessionStorage.setItem('salamanders-archive-anchor', JSON.stringify({ path: P, hash: 'javascript:1' }))
    expect(takeAnchor(P)).toBeNull()
  })
})
