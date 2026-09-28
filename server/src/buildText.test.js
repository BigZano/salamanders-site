import { describe, it, expect } from 'vitest'
import { validateBuildText } from './buildText'

const b = (over = {}) => ({ title: 'Melta Bulwark', role: 'Tank', notes: 'Solid pick', className: 'Devastator', ...over })

describe('validateBuildText', () => {
  it('strips zero-width characters from the title', () => {
    const out = validateBuildText(b({ title: 'Mel​ta Bulwark' }))
    expect(out.title).toBe('Melta Bulwark')
  })

  it('keeps single newlines in notes', () => {
    const out = validateBuildText(b({ notes: 'Line one\nLine two' }))
    expect(out.notes).toBe('Line one\nLine two')
  })

  it('rejects an over-limit title with its message', () => {
    expect(validateBuildText(b({ title: 'x'.repeat(201) }))).toBe('Title is too long (200 characters max).')
  })

  it('rejects an over-limit role with its message', () => {
    expect(validateBuildText(b({ role: 'x'.repeat(201) }))).toBe('Role is too long (200 characters max).')
  })

  it('rejects over-limit notes with its message', () => {
    expect(validateBuildText(b({ notes: 'x'.repeat(2001) }))).toBe('Notes are too long (2000 characters max).')
  })

  it('rejects an empty title after sanitizing', () => {
    expect(validateBuildText(b({ title: '   ' }))).toBe('Give the build a title.')
  })

  it('returns clean title, role and notes for valid input', () => {
    expect(validateBuildText(b())).toEqual({ title: 'Melta Bulwark', role: 'Tank', notes: 'Solid pick', justifications: {} })
  })

  it('strips zero-width characters inside a justification', () => {
    const out = validateBuildText(b({ justifications: { p1: 'Mel​ta' } }))
    expect(out.justifications).toEqual({ p1: 'Melta' })
  })

  it('drops a justification that is empty after sanitizing', () => {
    const out = validateBuildText(b({ justifications: { p1: '   ', p2: 'Kept' } }))
    expect(out.justifications).toEqual({ p2: 'Kept' })
  })

  it('rejects an over-limit justification with its message', () => {
    expect(validateBuildText(b({ justifications: { p1: 'x'.repeat(1001) } }))).toBe(
      'A perk justification is too long (1000 characters max).',
    )
  })

  it('treats a non-object justifications as empty', () => {
    expect(validateBuildText(b({ justifications: 'nope' })).justifications).toEqual({})
    expect(validateBuildText(b({ justifications: null })).justifications).toEqual({})
    expect(validateBuildText(b({ justifications: undefined })).justifications).toEqual({})
  })

  it('a __proto__ key from JSON.parse does not pollute Object.prototype', () => {
    const parsed = JSON.parse('{"__proto__":{"x":"y"}}')
    const out = validateBuildText(b({ justifications: parsed }))
    expect(out.justifications).toEqual({})
    expect(out.justifications.x).toBeUndefined()
    expect(({}).x).toBeUndefined()
    expect(Object.prototype.x).toBeUndefined()
  })
})
