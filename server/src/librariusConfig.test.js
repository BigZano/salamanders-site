import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { librariusConfig } from './librariusConfig.js'

// Invented ids only. A distinctive string stands in for a value, so a test can prove no value is ever printed.
const FORUM = '200000000000000400'
const REPORT = 'Librarius is not configured, so every /librarius route answers 503 and the gateway stays off: LIBRARIUS_CHANNEL_ID (not a Discord channel id).'
const NOT_CONFIGURED = { configured: false, forumId: null }

describe('librariusConfig', () => {
  it('is configured, with the forum id and no report, for a channel id', () => {
    expect(librariusConfig({ LIBRARIUS_CHANNEL_ID: FORUM })).toEqual({ configured: true, forumId: FORUM, report: null })
  })

  it.each([
    ['seventeen digits', '2'.repeat(17)],
    ['eighteen digits', FORUM],
    ['twenty digits', '9'.repeat(20)],
    ['leading zeros', '00000000000000001'],
  ])('takes %s', (_, id) => {
    expect(librariusConfig({ LIBRARIUS_CHANNEL_ID: id })).toEqual({ configured: true, forumId: id, report: null })
  })

  it.each([
    ['not set', {}],
    ['empty', { LIBRARIUS_CHANNEL_ID: '' }],
    ['undefined', { LIBRARIUS_CHANNEL_ID: undefined }],
    ['null', { LIBRARIUS_CHANNEL_ID: null }],
  ])('is off without a report when the variable is %s (the image may ship before the Librarius)', (_, env) => {
    expect(librariusConfig(env)).toEqual({ ...NOT_CONFIGURED, report: null })
  })

  it('reads nothing but LIBRARIUS_CHANNEL_ID', () => {
    const env = { PATH: '/bin', GALLERY_CHANNEL_ID: FORUM, LIBRARIUS_FORUM_ID: FORUM, LIBRARIUS_CHANNEL: FORUM }
    expect(librariusConfig(env)).toEqual({ ...NOT_CONFIGURED, report: null })
  })

  it.each([
    ['a word', 'forum'],
    ['sixteen digits', '2'.repeat(16)],
    ['twenty-one digits', '2'.repeat(21)],
    ['a leading space', ` ${FORUM}`],
    ['a trailing space', `${FORUM} `],
    ['a trailing newline', `${FORUM}\n`],
    ['a leading newline', `\n${FORUM}`],
    ['digits with a letter', `${FORUM.slice(0, 17)}x`],
    ['a signed number', `-${FORUM}`],
    ['a plus sign', `+${FORUM}`],
    ['a decimal', `${FORUM}.5`],
    ['an exponent', '2e17000000000000000'],
    ['two ids', `${FORUM},${FORUM}`],
    ['hex', '0x2c68a1b2c3d4e5f60'],
    ['a url', `https://discord.com/channels/${FORUM}/${FORUM}`],
    ['fullwidth digits', '２００００００００００００００４００'],
    ['Arabic-Indic digits', '٢٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠٤٠٠'],
    ['one space', ' '],
  ])('answers 503 with the report for %s', (_, id) => {
    expect(librariusConfig({ LIBRARIUS_CHANNEL_ID: id })).toEqual({ ...NOT_CONFIGURED, report: REPORT })
  })

  it.each([
    ['a number', 200000000000000400],
    ['a bigint', 200000000000000400n],
    ['an array holding the id', [FORUM]],
    ['an object that prints as the id', { toString: () => FORUM }],
    ['true', true],
    ['zero', 0],
    ['NaN', NaN],
  ])('does not take %s for a channel id, even when it prints as one', (_, value) => {
    expect(librariusConfig({ LIBRARIUS_CHANNEL_ID: value })).toEqual({ ...NOT_CONFIGURED, report: REPORT })
  })

  it('never prints a value', () => {
    const report = librariusConfig({ LIBRARIUS_CHANNEL_ID: 'chan-sentinel-0' }).report
    expect(report).toBe(REPORT)
    expect(report).not.toMatch(/sentinel/)
  })

  it('refuses an env that is no object', () => {
    for (const env of [undefined, null, 'LIBRARIUS_CHANNEL_ID', 7, true]) {
      expect(() => librariusConfig(env)).toThrow(new TypeError('env must be an object.'))
    }
  })

  it('is configured for every run of 17 to 20 digits, and only for those', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{17,20}$/), (id) => {
        expect(librariusConfig({ LIBRARIUS_CHANNEL_ID: id })).toEqual({ configured: true, forumId: id, report: null })
      }),
      { numRuns: 300 },
    )
  })

  it('refuses everything else with the one report, and never prints it', () => {
    const odd = fc.string({ minLength: 1 }).filter((s) => !/^\d{17,20}$/.test(s))
    fc.assert(
      fc.property(odd, (value) => {
        const got = librariusConfig({ LIBRARIUS_CHANNEL_ID: value })
        expect(got).toEqual({ ...NOT_CONFIGURED, report: REPORT })
      }),
      { numRuns: 300 },
    )
    // A value is never in the report: wrap whatever fast-check makes in characters the report cannot hold.
    fc.assert(
      fc.property(fc.string(), (s) => {
        const value = `\u0001${s}\u0002`
        expect(librariusConfig({ LIBRARIUS_CHANNEL_ID: value }).report).not.toContain(value)
      }),
      { numRuns: 100 },
    )
  })
})
