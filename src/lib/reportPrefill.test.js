import { describe, it, expect } from 'vitest'
import { prefillUrl, OFFICIAL_FORM } from './reportPrefill'

const params = (url) => new URL(url).searchParams
const R = {
  reportedMember: 'Brother X',
  witnesses: 'Y, Z',
  medium: 'voice',
  incidentDate: '2026-09-20',
  description: 'Said things.',
  reporter: { username: 'member' },
}

describe('prefillUrl', () => {
  it('targets the official form in pre-fill mode', () => {
    const url = prefillUrl(R, { filer: 'recl' })
    expect(url.startsWith(`${OFFICIAL_FORM}?`)).toBe(true)
    expect(params(url).get('usp')).toBe('pp_url')
  })

  it('maps every field to its entry id', () => {
    const p = params(prefillUrl(R, { filer: 'recl', followUp: 'Yes', note: 'Warned him.' }))
    expect(p.get('entry.1585179301')).toBe('recl')
    expect(p.get('entry.1660417014')).toBe('2026-09-20')
    expect(p.get('entry.1659452298')).toBe('Brother X')
    expect(p.get('entry.2116649071')).toBe('Y, Z')
    expect(p.get('entry.829462579')).toBe('Discord Voice Channel')
    expect(p.get('entry.1492368838')).toBe('Yes')
    expect(p.get('entry.1441063800')).toBe('Said things.\n\nReported by: member\n\nReclusiarch notes: Warned him.')
  })

  it("uses the form's Other option for other mediums", () => {
    const p = params(prefillUrl({ ...R, medium: 'other', mediumOther: 'In game' }, { filer: 'x' }))
    expect(p.get('entry.829462579')).toBe('__other_option__')
    expect(p.get('entry.829462579.other_option_response')).toBe('In game')
  })

  it('omits empty fields and does not credit the filer as their own reporter', () => {
    const p = params(prefillUrl({ ...R, witnesses: '', incidentDate: null, reporter: { username: 'me' } }, { filer: 'me' }))
    expect(p.has('entry.2116649071')).toBe(false)
    expect(p.has('entry.1660417014')).toBe(false)
    expect(p.has('entry.1492368838')).toBe(false)
    expect(p.get('entry.1441063800')).toBe('Said things.')
  })
})
