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
    expect(validateBuildText(b())).toEqual({ title: 'Melta Bulwark', role: 'Tank', notes: 'Solid pick' })
  })
})
