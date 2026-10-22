import { describe, it, expect } from 'vitest'
import { etagOf, ifNoneMatches } from './deathwatchEtag'

describe('etagOf', () => {
  it('is a quoted 32-character lowercase hex string', () => {
    expect(etagOf('{"teams":{}}')).toMatch(/^"[0-9a-f]{32}"$/)
    expect(etagOf('')).toMatch(/^"[0-9a-f]{32}"$/)
  })

  it('is stable for equal text and different for different text', () => {
    expect(etagOf('a')).toBe(etagOf('a'))
    expect(etagOf('a')).not.toBe(etagOf('b'))
  })
})

describe('ifNoneMatches', () => {
  const tag = etagOf('current')
  const other = etagOf('stale')

  it('is true for the exact tag', () => {
    expect(ifNoneMatches(tag, tag)).toBe(true)
  })

  it('is true for the weak form of the tag', () => {
    expect(ifNoneMatches(`W/${tag}`, tag)).toBe(true)
  })

  it('is true when the tag is one of a comma list', () => {
    expect(ifNoneMatches(`${other}, ${tag}`, tag)).toBe(true)
    expect(ifNoneMatches(`${other},W/${tag} , "x"`, tag)).toBe(true)
  })

  it('is true for *', () => {
    expect(ifNoneMatches('*', tag)).toBe(true)
  })

  it('is false for no header, an empty header or another tag', () => {
    expect(ifNoneMatches(null, tag)).toBe(false)
    expect(ifNoneMatches('', tag)).toBe(false)
    expect(ifNoneMatches(other, tag)).toBe(false)
    expect(ifNoneMatches(`W/${other}`, tag)).toBe(false)
  })

  it('is false for the tag without its quotes or with extra characters inside them', () => {
    expect(ifNoneMatches(tag.slice(1, -1), tag)).toBe(false)
    expect(ifNoneMatches(`"z${tag.slice(1)}`, tag)).toBe(false)
  })
})
