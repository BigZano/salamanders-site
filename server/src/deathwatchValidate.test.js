import { describe, it, expect } from 'vitest'
import {
  COLLECTIONS,
  MAX_DOC_BYTES,
  MAX_BODY_BYTES,
  MAX_ACTIVE_GRANTS,
  isDiscordId,
  parseDocWrite,
  parseGrantBody,
} from './deathwatchValidate'

const write = (over = {}) => ({ col: 'teams', id: 'alpha', op: 'set', doc: { n: 1 }, ...over })
const isError = (r) => typeof r === 'string' && r.length > 0

describe('limits', () => {
  it('pins the numbers the spec states', () => {
    expect(COLLECTIONS).toEqual(['teams', 'cfg', 'archive'])
    expect(MAX_DOC_BYTES).toBe(1_048_576)
    expect(MAX_BODY_BYTES).toBe(2_097_152)
    expect(MAX_ACTIVE_GRANTS).toBe(200)
  })
})

describe('parseDocWrite', () => {
  it('accepts a set for each collection', () => {
    for (const col of COLLECTIONS) {
      expect(parseDocWrite(write({ col }))).toEqual({ col, id: 'alpha', op: 'set', doc: { n: 1 } })
    }
  })

  it('accepts a delete without a doc, and ignores one that is supplied', () => {
    expect(parseDocWrite({ col: 'cfg', id: 'x', op: 'delete' })).toEqual({ col: 'cfg', id: 'x', op: 'delete', doc: null })
    expect(parseDocWrite({ col: 'cfg', id: 'x', op: 'delete', doc: { a: 1 } }).doc).toBeNull()
  })

  it('rejects a body that is not an object', () => {
    for (const b of [null, undefined, [], 'x', 7]) expect(isError(parseDocWrite(b))).toBe(true)
  })

  it('rejects an unknown collection', () => {
    for (const col of ['users', '__proto__', 'constructor', 7, undefined]) {
      expect(isError(parseDocWrite(write({ col })))).toBe(true)
    }
  })

  it('rejects a bad id and accepts the edge ids', () => {
    for (const id of ['', 'x'.repeat(65), 'a b', '../x', 'a.b', 7, undefined]) {
      expect(isError(parseDocWrite(write({ id })))).toBe(true)
    }
    for (const id of ['x'.repeat(64), '__proto__', 'a-b_C9']) {
      expect(parseDocWrite(write({ id })).id).toBe(id)
    }
  })

  it('rejects an unknown op', () => {
    for (const op of ['update', 'SET', '', undefined]) expect(isError(parseDocWrite(write({ op })))).toBe(true)
  })

  it('rejects a set whose doc is not a JSON object', () => {
    for (const doc of [undefined, null, [], 'x', 7, true]) expect(isError(parseDocWrite(write({ doc })))).toBe(true)
  })

  it('enforces the document size in bytes, not characters', () => {
    // {"a":"…"} is 8 bytes of JSON around the string.
    const atLimit = { a: 'x'.repeat(MAX_DOC_BYTES - 8) }
    expect(isError(parseDocWrite(write({ doc: atLimit })))).toBe(false)
    expect(isError(parseDocWrite(write({ doc: { a: 'x'.repeat(MAX_DOC_BYTES - 7) } })))).toBe(true)
    // Under the limit in characters, over it in UTF-8 bytes.
    const euros = '€'.repeat(Math.floor(MAX_DOC_BYTES / 3) + 1)
    expect(euros.length).toBeLessThan(MAX_DOC_BYTES)
    expect(isError(parseDocWrite(write({ doc: { a: euros } })))).toBe(true)
  })

  it('rejects text that Postgres jsonb cannot store', () => {
    const bad = ['a\u0000b', '\ud800', '\udc00', 'ok\ud83d']
    for (const s of bad) {
      expect(isError(parseDocWrite(write({ doc: { v: s } })))).toBe(true)
      expect(isError(parseDocWrite(write({ doc: { [s]: 1 } })))).toBe(true)
      expect(isError(parseDocWrite(write({ doc: { a: [{ b: [s] }] } })))).toBe(true)
    }
  })

  it('accepts a valid surrogate pair and ordinary punctuation', () => {
    const doc = { '😀': 'ok 😀', 'q"uote': 'back\\slash\ttab' }
    expect(parseDocWrite(write({ doc })).doc).toEqual(doc)
  })
})

describe('parseGrantBody', () => {
  it('accepts 17 to 20 digits and returns only the id', () => {
    for (const discordId of ['1'.repeat(17), '2'.repeat(18), '3'.repeat(20)]) {
      expect(parseGrantBody({ discordId, extra: 'ignored' })).toEqual({ discordId })
    }
  })

  it('rejects anything else', () => {
    const bad = ['1'.repeat(16), '1'.repeat(21), 'abc', ' ' + '1'.repeat(18), '1'.repeat(18) + '\n', 123456789012345678, undefined]
    for (const discordId of bad) expect(isError(parseGrantBody({ discordId }))).toBe(true)
    for (const b of [null, undefined, [], 'x', {}]) expect(isError(parseGrantBody(b))).toBe(true)
  })
})

describe('isDiscordId', () => {
  it('agrees with the grant rule', () => {
    expect(isDiscordId('1'.repeat(17))).toBe(true)
    expect(isDiscordId('1'.repeat(20))).toBe(true)
    expect(isDiscordId('1'.repeat(16))).toBe(false)
    expect(isDiscordId('1'.repeat(21))).toBe(false)
    expect(isDiscordId(' ' + '1'.repeat(18))).toBe(false)
    expect(isDiscordId(123456789012345678)).toBe(false)
    expect(isDiscordId(undefined)).toBe(false)
  })
})
