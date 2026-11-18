import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { librariusConfig, repliesConfig } from './librariusConfig.js'

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

// The replies' settings. Every id and token is invented; a distinctive text stands in for a value, to prove none is ever printed.
const API = 'https://discord.com/api'
const MOCK = 'http://discord-mock:4400'
const HOOK = '200000000000000450'
const TOKEN = 'invented-webhook-token_0123456789abcdef'
const ADDRESS = `${API}/webhooks/${HOOK}/${TOKEN}`
const OFF_UNSET = 'Replying from the site is off, so its write routes answer 503: LIBRARIUS_WEBHOOK_URL is not set.'
const OFF_BAD = 'Replying from the site is off, so its write routes answer 503: LIBRARIUS_WEBHOOK_URL is not a Discord webhook address.'
const BAD_FORM = 'LIBRARIUS_FORM is neither "v2" nor "plain", so replies go out as "v2".'

describe('repliesConfig', () => {
  it('is on, in the v2 form and with nothing to report, for a webhook address alone', () => {
    expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: ADDRESS }, API)).toEqual({ webhookUrl: ADDRESS, form: 'v2', reports: [] })
  })

  it.each(['v2', 'plain'])('takes the %s form', (form) => {
    expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: ADDRESS, LIBRARIUS_FORM: form }, API)).toEqual({ webhookUrl: ADDRESS, form, reports: [] })
  })

  it.each([
    ['not set', {}],
    ['undefined', { LIBRARIUS_FORM: undefined }],
    ['null', { LIBRARIUS_FORM: null }],
    ['empty', { LIBRARIUS_FORM: '' }],
  ])('is the v2 form, without a report, when LIBRARIUS_FORM is %s', (_, extra) => {
    expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: ADDRESS, ...extra }, API)).toEqual({ webhookUrl: ADDRESS, form: 'v2', reports: [] })
  })

  it.each([
    ['not set', {}],
    ['undefined', { LIBRARIUS_WEBHOOK_URL: undefined }],
    ['null', { LIBRARIUS_WEBHOOK_URL: null }],
    ['empty', { LIBRARIUS_WEBHOOK_URL: '' }],
  ])('is off, saying it is not set, when LIBRARIUS_WEBHOOK_URL is %s', (_, env) => {
    expect(repliesConfig(env, API)).toEqual({ webhookUrl: null, form: 'v2', reports: [OFF_UNSET] })
  })

  it.each([
    ['a word', 'webhook'],
    ['a space', ' '],
    ['a leading space', ` ${ADDRESS}`],
    ['a trailing space', `${ADDRESS} `],
    ['a trailing newline', `${ADDRESS}\n`],
    ['quotes round it', `"${ADDRESS}"`],
    ['a trailing slash', `${ADDRESS}/`],
    ['a query', `${ADDRESS}?wait=true`],
    ['a fragment', `${ADDRESS}#x`],
    ['the API version in the path', `https://discord.com/api/v10/webhooks/${HOOK}/${TOKEN}`],
    ['a look-alike host', `https://discord.com.example.test/api/webhooks/${HOOK}/${TOKEN}`],
    ['another host', `https://example.test/api/webhooks/${HOOK}/${TOKEN}`],
    ['http for the real host', `http://discord.com/api/webhooks/${HOOK}/${TOKEN}`],
    ['user info', `https://user@discord.com/api/webhooks/${HOOK}/${TOKEN}`],
    ['a short id', `${API}/webhooks/123/${TOKEN}`],
    ['no token', `${API}/webhooks/${HOOK}/`],
    ['a short token', `${API}/webhooks/${HOOK}/abc`],
    ['a token with a space', `${API}/webhooks/${HOOK}/${TOKEN} x`],
    ['the mock address while the base is the real one', `${MOCK}/api/webhooks/${HOOK}/${TOKEN}`],
    ['a channel link', `https://discord.com/channels/${HOOK}/${HOOK}`],
  ])('is off, saying it is not an address, for %s', (_, value) => {
    expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: value }, API)).toEqual({ webhookUrl: null, form: 'v2', reports: [OFF_BAD] })
  })

  it.each([
    ['a number', 200000000000000450],
    ['an array holding the address', [ADDRESS]],
    ['an object that prints as the address', { toString: () => ADDRESS }],
    ['true', true],
    ['zero', 0],
  ])('does not take %s for an address, even when it prints as one', (_, value) => {
    expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: value }, API)).toEqual({ webhookUrl: null, form: 'v2', reports: [OFF_BAD] })
  })

  it('takes the mock stack\'s address only while the API base is an http one', () => {
    const mock = `${MOCK}/api/webhooks/${HOOK}/${TOKEN}`
    expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: mock }, MOCK)).toEqual({ webhookUrl: mock, form: 'v2', reports: [] })
    expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: mock }, `${MOCK}/api`).webhookUrl).toBe(mock)
    expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: ADDRESS }, MOCK).webhookUrl).toBe(ADDRESS)
    expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: mock }, API).webhookUrl).toBeNull()
  })

  it('uses the real API base when none is given', () => {
    expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: ADDRESS }).webhookUrl).toBe(ADDRESS)
    expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: `${MOCK}/api/webhooks/${HOOK}/${TOKEN}` }).webhookUrl).toBeNull()
  })

  it.each([
    ['not an address', 'discord'],
    ['an empty text', ''],
    ['a number', 7],
    ['null', null],
  ])('is off rather than throwing when the API base is %s', (_, base) => {
    const got = repliesConfig({ LIBRARIUS_WEBHOOK_URL: ADDRESS }, base)
    expect(got.webhookUrl).toBeNull()
    expect(got.reports).toEqual([OFF_BAD])
  })

  it.each([
    ['another word', 'embed'],
    ['capitals', 'V2'],
    ['capitals on plain', 'Plain'],
    ['a space before', ' v2'],
    ['a space after', 'plain '],
    ['a newline after', 'v2\n'],
    ['quotes', '"v2"'],
    ['a number', 2],
    ['an array holding it', ['plain']],
    ['an object that prints as it', { toString: () => 'plain' }],
    ['true', true],
    ['one space', ' '],
  ])('falls back to v2, and says so, when LIBRARIUS_FORM is %s', (_, value) => {
    expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: ADDRESS, LIBRARIUS_FORM: value }, API)).toEqual({ webhookUrl: ADDRESS, form: 'v2', reports: [BAD_FORM] })
  })

  it('reports a bad form first, and each fault once, when both settings are bad', () => {
    expect(repliesConfig({ LIBRARIUS_FORM: 'embed', LIBRARIUS_WEBHOOK_URL: 'x' }, API)).toEqual({ webhookUrl: null, form: 'v2', reports: [BAD_FORM, OFF_BAD] })
    expect(repliesConfig({ LIBRARIUS_FORM: 'embed' }, API)).toEqual({ webhookUrl: null, form: 'v2', reports: [BAD_FORM, OFF_UNSET] })
  })

  it('reads nothing but its two variables', () => {
    const env = { LIBRARIUS_WEBHOOK: ADDRESS, LIBRARIUS_REPLIES_URL: ADDRESS, REPORTS_WEBHOOK_URL: ADDRESS, LIBRARIUS_FORMS: 'plain', LIBRARIUS_CHANNEL_ID: FORUM }
    expect(repliesConfig(env, API)).toEqual({ webhookUrl: null, form: 'v2', reports: [OFF_UNSET] })
  })

  it('never prints a value, of either variable', () => {
    for (const reports of [
      repliesConfig({ LIBRARIUS_WEBHOOK_URL: 'hook-sentinel-0', LIBRARIUS_FORM: 'form-sentinel-1' }, API).reports,
      repliesConfig({ LIBRARIUS_WEBHOOK_URL: `${API}/webhooks/${HOOK}/${TOKEN}x y`, LIBRARIUS_FORM: 'form-sentinel-1' }, API).reports,
    ]) {
      expect(reports).toHaveLength(2)
      expect(reports.join('\n')).not.toMatch(/sentinel|invented-webhook|discord\.com|200000000000000450/)
    }
  })

  it('never says the webhook address or its token in a report, whatever the setting', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (hook, form) => {
        const got = repliesConfig({ LIBRARIUS_WEBHOOK_URL: hook, LIBRARIUS_FORM: form }, API)
        for (const line of got.reports) {
          expect([OFF_UNSET, OFF_BAD, BAD_FORM]).toContain(line)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('answers the same for any address the API would accept, and only those', () => {
    const digits = fc.stringMatching(/^[1-9][0-9]{16,19}$/)
    const token = fc.stringMatching(/^[A-Za-z0-9_-]{8,200}$/)
    fc.assert(
      fc.property(digits, token, (id, t) => {
        const url = `${API}/webhooks/${id}/${t}`
        expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: url }, API)).toEqual({ webhookUrl: url, form: 'v2', reports: [] })
      }),
      { numRuns: 200 },
    )
    const odd = fc.string({ minLength: 1 }).filter((s) => !/^https:\/\/discord\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{8,200}$/.test(s))
    fc.assert(
      fc.property(odd, (value) => {
        expect(repliesConfig({ LIBRARIUS_WEBHOOK_URL: value }, API)).toEqual({ webhookUrl: null, form: 'v2', reports: [OFF_BAD] })
      }),
      { numRuns: 300 },
    )
  })

  it('refuses an env that is no object', () => {
    for (const env of [undefined, null, 'LIBRARIUS_WEBHOOK_URL', 7, true]) {
      expect(() => repliesConfig(env, API)).toThrow(new TypeError('env must be an object.'))
    }
  })
})
