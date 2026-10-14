import { describe, it, expect } from 'vitest'
import { AVATAR_ORIGINS, initials, safeAvatar } from './rosterAvatar'

const OK = 'https://cdn.discordapp.com/avatars/900000000000000001/abc.png?size=64'

describe('safeAvatar', () => {
  it('allows the Discord CDN', () => {
    expect(AVATAR_ORIGINS).toEqual(['https://cdn.discordapp.com'])
    expect(safeAvatar(OK)).toBe(OK)
  })

  it.each([
    ['http, not https', 'http://cdn.discordapp.com/avatars/1/a.png'],
    ['another origin', 'https://example.com/a.png'],
    ['a look-alike host', 'https://cdn.discordapp.com.evil.test/a.png'],
    ['a userinfo trick', 'https://cdn.discordapp.com@evil.test/a.png'],
    ['another port', 'https://cdn.discordapp.com:444/a.png'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:image/png;base64,AAAA'],
    ['not a URL', 'not a url'],
  ])('rejects %s', (_, url) => {
    expect(safeAvatar(url)).toBeNull()
  })

  it.each([[null], [undefined], [''], [42], [{}]])('rejects %j', (value) => {
    expect(safeAvatar(value)).toBeNull()
  })
})

describe('initials', () => {
  it('takes the first letter of the first two words, uppercased', () => {
    expect(initials('Aurelian Ashgrave')).toBe('AA')
    expect(initials('cassivel lowe brandt')).toBe('CL')
  })
  it('works for one word, an emoji first, and nothing', () => {
    expect(initials('Cassivel')).toBe('C')
    expect(initials('🔥 Fire')).toBe('🔥F')
    expect(initials('')).toBe('')
    expect(initials('   ')).toBe('')
  })
})
