import { describe, it, expect, beforeEach } from 'vitest'
import fc from 'fast-check'
import { parseDiscordRef, isDiscordHost, buildLinkIndex, resolveRef, validateFixes } from './links'
import { GUILD_ID } from './registry'

const G = GUILD_ID
const T1 = '100000000000000001' // accolades thread
const M1 = '100000000000000011' // message in T1
const T2 = '200000000000000001' // ranks thread
const EXT = '500000000000000001' // channel outside both collections
const DEAD = '100000000000000099' // message id not in T1

// Built per test (not at import) so mutation testing sees buildLinkIndex run.
let index
beforeEach(() => {
  index = buildLinkIndex([
    { prefix: '/accolades', threads: new Map([[T1, { messages: [{ id: T1 }, { id: M1 }] }]]) },
    { prefix: '/ranks', threads: new Map([[T2, { messages: [{ id: T2 }] }]]) },
  ])
})
const snowflake = fc.bigInt({ min: 10n ** 16n, max: 10n ** 19n - 1n }).map(String)

describe('parseDiscordRef', () => {
  it.each([
    [`https://discord.com/channels/${G}/${T1}`, { guildId: G, channelId: T1, messageId: null }],
    [`https://discord.com/channels/${G}/${T1}/${M1}`, { guildId: G, channelId: T1, messageId: M1 }],
    [`https://discordapp.com/channels/${G}/${T1}/${M1}`, { guildId: G, channelId: T1, messageId: M1 }],
    [`https://ptb.discord.com/channels/${G}/${T1}`, { guildId: G, channelId: T1, messageId: null }],
    [`https://canary.discord.com/channels/${G}/${T1}/`, { guildId: G, channelId: T1, messageId: null }],
    [`http://discord.com/channels/${G}/${T1}`, { guildId: G, channelId: T1, messageId: null }],
    [`<https://discord.com/channels/${G}/${T1}>`, { guildId: G, channelId: T1, messageId: null }],
    [`  https://discord.com/channels/${G}/${T1}  `, { guildId: G, channelId: T1, messageId: null }],
    [`<#${EXT}>`, { guildId: G, channelId: EXT, messageId: null }],
  ])('parses %s', (s, want) => expect(parseDiscordRef(s)).toEqual(want))

  it.each([
    'https://example.com/channels/1/2',
    `https://discord.com.evil.io/channels/${G}/${T1}`,
    `https://evildiscord.com/channels/${G}/${T1}`,
    `https://discord.com/channels/${G}`,
    `https://discord.com/channels/${G}/${T1}/${M1}/extra`,
    `https://discord.com/channels/${G}/12/`,
    `https://discord.com/invite/abc`,
    `<#12>`,
    `<#${EXT}`,
    '',
    null,
    42,
    'javascript:alert(1)',
  ])('rejects %j', (s) => expect(parseDiscordRef(s)).toBeNull())

  it('round-trips any snowflake triple over every host/scheme variant', () => {
    fc.assert(
      fc.property(
        snowflake, snowflake, fc.option(snowflake, { nil: null }),
        fc.constantFrom('discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'),
        fc.constantFrom('https', 'http'), fc.boolean(), fc.boolean(),
        (g, c, m, host, scheme, slash, angle) => {
          let url = `${scheme}://${host}/channels/${g}/${c}${m ? `/${m}` : ''}${slash ? '/' : ''}`
          if (angle) url = `<${url}>`
          expect(parseDiscordRef(url)).toEqual({ guildId: g, channelId: c, messageId: m })
        },
      ),
    )
  })

  it('treats @me (DM) links as foreign, not as our guild', () => {
    expect(parseDiscordRef(`https://discord.com/channels/@me/${T1}`)).toEqual({ guildId: '@me', channelId: T1, messageId: null })
  })
})

describe('isDiscordHost', () => {
  it.each([
    ['https://discord.com/x', true], ['https://discordapp.com/x', true], ['https://ptb.discord.com/x', true],
    ['https://discord.gg/abc', true], ['https://cdn.discordapp.com/emojis/1.png', true],
    // Parser hands over bare hrefs; an angle-wrapped string is not a URL and
    // is never treated as one (classifyHref then renders it as text).
    ['<https://discord.com/x>', false],
    [' https://discord.com/x ', true],
    ['https://x.>discord.com/', false],
    ['https://disc<ord.com/x', false],
    [42, false],
    ['https://warhammer40k.fandom.com/wiki/X', false], ['https://notdiscord.com/x', false],
    ['https://discord.com.evil.io/x', false], ['not a url', false], ['', false], [null, false],
  ])('%j → %s', (h, want) => expect(isDiscordHost(h)).toBe(want))
})

describe('resolveRef', () => {
  const ref = (channelId, messageId = null, guildId = G) => ({ guildId, channelId, messageId })

  it('thread link → route with no hash', () => {
    expect(resolveRef(ref(T1), index, {})).toEqual({ kind: 'route', to: { path: `/accolades/${T1}`, hash: '' } })
  })
  it('message link → route with #m-<id>', () => {
    expect(resolveRef(ref(T1, M1), index, {})).toEqual({ kind: 'route', to: { path: `/accolades/${T1}`, hash: `#m-${M1}` } })
  })
  it('starter-message link (message id == thread id) → top of thread, no hash', () => {
    expect(resolveRef(ref(T1, T1), index, {})).toEqual({ kind: 'route', to: { path: `/accolades/${T1}`, hash: '' } })
  })
  it('cross-collection link resolves to the other prefix', () => {
    expect(resolveRef(ref(T2), index, {}).to.path).toBe(`/ranks/${T2}`)
  })
  it('deleted target message is unaccounted without a fix — never silently degraded', () => {
    expect(resolveRef(ref(T1, DEAD), index, {})).toEqual({ kind: 'unaccounted', reason: `message ${DEAD} no longer exists` })
  })
  it('a starter-message link still resolves when the starter post itself is gone', () => {
    const idx = buildLinkIndex([{ prefix: '/accolades', threads: new Map([[T1, { messages: [{ id: M1 }] }]]) }])
    expect(resolveRef(ref(T1, T1), idx, {})).toEqual({ kind: 'route', to: { path: `/accolades/${T1}`, hash: '' } })
  })
  it('exact fix redirects a dead message link', () => {
    const fixes = { [`${T1}/${DEAD}`]: { to: `${T1}/${M1}`, why: 'replacement post' } }
    expect(resolveRef(ref(T1, DEAD), index, fixes)).toEqual({ kind: 'route', to: { path: `/accolades/${T1}`, hash: `#m-${M1}` } })
  })
  it('channel-level fix covers message links into that external channel', () => {
    const fixes = { [EXT]: { text: true, why: 'outside archive' } }
    expect(resolveRef(ref(EXT), index, fixes)).toEqual({ kind: 'text' })
    expect(resolveRef(ref(EXT, M1), index, fixes)).toEqual({ kind: 'text' })
  })
  it('a channel-level fix never overrides a healthy direct link into an in-site thread', () => {
    const fixes = { [T1]: { text: true, why: 'x' } }
    expect(resolveRef(ref(T1, M1), index, fixes).kind).toBe('route')
  })
  it('exact fix beats direct resolution (explicit override)', () => {
    const fixes = { [`${T1}/${M1}`]: { to: T2, why: 'moved' } }
    expect(resolveRef(ref(T1, M1), index, fixes).to.path).toBe(`/ranks/${T2}`)
  })
  it('a fix pointing at a nonexistent target is unaccounted, not a broken route', () => {
    const fixes = { [EXT]: { to: '900000000000000009', why: 'x' } }
    expect(resolveRef(ref(EXT), index, fixes)).toEqual({ kind: 'unaccounted', reason: 'fix target 900000000000000009 does not exist' })
  })
  it('foreign guild and DM links are unaccounted even when the ids collide', () => {
    expect(resolveRef(ref(T1, null, '999999999999999999'), index, {})).toEqual({ kind: 'unaccounted', reason: 'foreign guild 999999999999999999' })
    expect(resolveRef(ref(T1, null, '@me'), index, {})).toMatchObject({ kind: 'unaccounted' })
  })
  it('null ref is unaccounted', () => {
    expect(resolveRef(null, index, {})).toEqual({ kind: 'unaccounted', reason: 'not a Discord reference' })
  })
  it('unknown external channel with no fix is unaccounted', () => {
    expect(resolveRef(ref(EXT), index, {})).toEqual({ kind: 'unaccounted', reason: `channel ${EXT} is outside the archive` })
  })
  it('ignores inherited properties on the fixes object', () => {
    const fixes = Object.create({ [EXT]: { text: true, why: 'proto' } })
    expect(resolveRef(ref(EXT), index, fixes)).toMatchObject({ kind: 'unaccounted' })
  })
})

describe('validateFixes', () => {
  it('accepts well-formed fixes', () => {
    expect(validateFixes({ [EXT]: { text: true, why: 'a' }, [`${T1}/${DEAD}`]: { to: `${T1}/${M1}`, why: 'b' } }, index)).toEqual([])
  })
  it.each([
    [{ 'not-an-id': { text: true, why: 'a' } }, /key/],
    [{ [EXT]: { text: true } }, /why/],
    [{ [EXT]: { text: true, why: '   ' } }, /why/],
    [{ [EXT]: { why: 'a' } }, /exactly one/],
    [{ [EXT]: { text: true, to: T1, why: 'a' } }, /exactly one/],
    [{ [EXT]: { text: false, why: 'a' } }, /exactly one/],
    [{ [EXT]: { to: 'garbage', why: 'a' } }, /"to" target must be <threadId>/],
    [{ [EXT]: { to: { toString: () => T1 }, why: 'a' } }, /"to" target must be <threadId>/],
    [{ [EXT]: { to: T1, text: false, why: 'a' } }, /exactly one/],
    [{ [EXT]: 'nope' }, /fix must be an object/],
    [{ [EXT]: { to: '900000000000000009', why: 'a' } }, /does not exist/],
    [{ [EXT]: { to: `${T1}/${DEAD}`, why: 'a' } }, /does not exist/],
    [{ [EXT]: null }, /object/],
    [{ [EXT]: { text: true, why: 'a', extra: 1 } }, /unknown field/],
  ])('rejects %j', (fixes, re) => {
    const errs = validateFixes(fixes, index)
    expect(errs.length).toBeGreaterThan(0)
    expect(errs.join('\n')).toMatch(re)
  })
  it('rejects a non-object fixes file', () => {
    expect(validateFixes(null, index)).toEqual(['link-fixes must be a JSON object'])
    expect(validateFixes([], index)).toEqual(['link-fixes must be a JSON object'])
    expect(validateFixes('str', index)).toEqual(['link-fixes must be a JSON object'])
  })
})

describe('buildLinkIndex', () => {
  it('throws on a thread id present in two collections', () => {
    const t = new Map([[T1, { messages: [] }]])
    expect(() => buildLinkIndex([{ prefix: '/a', threads: t }, { prefix: '/b', threads: t }])).toThrow(/duplicate thread/)
  })
})
