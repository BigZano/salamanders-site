import { describe, it, expect } from 'vitest'
import { canDeleteBuild } from './permissions'

const member = (id) => (id === undefined ? null : { id })
const build = (authorId) => (authorId === undefined ? {} : { author: { id: authorId } })

describe('canDeleteBuild', () => {
  it('allows the poster to delete their own build', () => {
    expect(canDeleteBuild(member('42'), build('42'))).toBe(true)
  })

  it('denies a different signed-in user', () => {
    expect(canDeleteBuild(member('42'), build('99'))).toBe(false)
  })

  it('denies when signed out', () => {
    expect(canDeleteBuild(null, build('42'))).toBe(false)
    expect(canDeleteBuild(undefined, build('42'))).toBe(false)
  })

  it('denies when the build has no author', () => {
    expect(canDeleteBuild(member('42'), {})).toBe(false)
    expect(canDeleteBuild(member('42'), null)).toBe(false)
    expect(canDeleteBuild(member('42'), undefined)).toBe(false)
  })

  it('denies an empty/falsy member id even if it matches a falsy author id', () => {
    expect(canDeleteBuild({ id: '' }, { author: { id: '' } })).toBe(false)
    expect(canDeleteBuild({ id: 0 }, { author: { id: 0 } })).toBe(false)
  })

  it('compares ids by string value, so numeric and string forms of the same id match', () => {
    expect(canDeleteBuild(member(42), build('42'))).toBe(true)
    expect(canDeleteBuild(member('42'), build(42))).toBe(true)
  })

  it('does not do loose/coercive matching across genuinely different ids', () => {
    expect(canDeleteBuild(member('42'), build('420'))).toBe(false)
    expect(canDeleteBuild(member('null'), build(null))).toBe(false)
  })

  it('rejects non-primitive ids instead of string-coercing them into a false match', () => {
    // Two distinct {} objects both stringify to "[object Object]" — without a
    // type guard this would wrongly read as a match.
    expect(canDeleteBuild({ id: {} }, build({}))).toBe(false)
    expect(canDeleteBuild({ id: [] }, build([]))).toBe(false)
  })
})
