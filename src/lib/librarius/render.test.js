import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { createRenderCtx, httpsUrl, attachmentUrl, proxyImageUrl } from './render'
import { GUILD_ID } from '../archive/registry'

// Invented ids only (the 200000000000000400 range), and invented names.
const GUILD = '200000000000000400'
const POST = '200000000000000401'
const POST_TWO = '200000000000000402'
const OTHER_CHANNEL = '200000000000000403'
const MESSAGE = '200000000000000450'
const TOR = '200000000000000410'
const WARDENS = '200000000000000420'
const PLAIN = '200000000000000421'
const ROUTE = '/reliquarium/librarius/'
const EMOJI_ID = '200000000000000430'

const make = (over = {}) =>
  createRenderCtx({
    guildId: GUILD,
    postTitles: new Map([
      [POST, 'The Long Road'],
      [POST_TWO, 'Supply Lines'],
    ]),
    people: { [TOR]: { name: 'Tor Mardan', avatar: null } },
    roles: [
      { id: WARDENS, name: 'Wardens', color: '#aa3322' },
      { id: PLAIN, name: 'Plain', color: null },
    ],
    ...over,
  })

describe('createRenderCtx', () => {
  it('has the three functions ArchiveMarkdown takes, and nothing else', () => {
    const ctx = make()
    expect(Object.keys(ctx).sort()).toEqual(['emoji', 'link', 'mention'])
    for (const fn of Object.values(ctx)) expect(typeof fn).toBe('function')
  })

  it('refuses arguments of the wrong kind', () => {
    expect(() => createRenderCtx()).toThrow(TypeError)
    expect(() => createRenderCtx(null)).toThrow(TypeError)
    expect(() => createRenderCtx({})).toThrow(/guildId/)
    for (const guildId of [undefined, null, '', 'abc', '1234567890123456', '123456789012345678901', 400, 12345678901234567, { toString: () => GUILD }, [GUILD], `${GUILD} `]) {
      expect(() => make({ guildId }), String(guildId)).toThrow(/guildId/)
    }
    for (const postTitles of [undefined, null, {}, [], [[POST, 'x']], 'abc']) expect(() => make({ postTitles })).toThrow(/postTitles/)
    for (const people of [undefined, null, [], 'abc', 5]) expect(() => make({ people })).toThrow(/people/)
    for (const roles of [undefined, null, {}, 'abc', 5]) expect(() => make({ roles })).toThrow(/roles/)
  })

  it('reads its tables when it is asked, so one made early sees what is added later', () => {
    const postTitles = new Map()
    const people = {}
    const roles = []
    const ctx = createRenderCtx({ guildId: GUILD, postTitles, people, roles })
    expect(ctx.link(`<#${POST}>`)).toEqual({ kind: 'text' })
    expect(ctx.mention({ kind: 'channel', id: POST }).label).toBe('#channel')
    expect(ctx.mention({ kind: 'user', id: TOR }).label).toBe('@unknown-member')
    expect(ctx.mention({ kind: 'role', id: WARDENS }).label).toBe('@unknown-role')
    postTitles.set(POST, 'The Long Road')
    people[TOR] = { name: 'Tor Mardan', avatar: null }
    roles.push({ id: WARDENS, name: 'Wardens', color: null })
    expect(ctx.link(`<#${POST}>`)).toEqual({ kind: 'route', to: `${ROUTE}${POST}` })
    expect(ctx.mention({ kind: 'channel', id: POST }).label).toBe('The Long Road')
    expect(ctx.mention({ kind: 'user', id: TOR }).label).toBe('@Tor Mardan')
    expect(ctx.mention({ kind: 'role', id: WARDENS }).label).toBe('@Wardens')
  })
})

describe('link: a Discord link to a post', () => {

  it('goes to the post, as a route', () => {
    const { link } = make()
    expect(link(`https://discord.com/channels/${GUILD}/${POST}`)).toStrictEqual({ kind: 'route', to: `${ROUTE}${POST}` })
    expect(link(`https://discord.com/channels/${GUILD}/${POST_TWO}`)).toStrictEqual({ kind: 'route', to: `${ROUTE}${POST_TWO}` })
  })

  it('goes to the message, as a hash, when it names one', () => {
    const { link } = make()
    expect(link(`https://discord.com/channels/${GUILD}/${POST}/${MESSAGE}`)).toStrictEqual({
      kind: 'route',
      to: `${ROUTE}${POST}#m-${MESSAGE}`,
    })
  })

  it('takes the other hosts and shapes Discord links come in', () => {
    const { link } = make()
    for (const host of ['discord.com', 'ptb.discord.com', 'canary.discord.com', 'discordapp.com', 'ptb.discordapp.com']) {
      expect(link(`https://${host}/channels/${GUILD}/${POST}`), host).toStrictEqual({ kind: 'route', to: `${ROUTE}${POST}` })
    }
    expect(link(`https://discord.com/channels/${GUILD}/${POST}/`)).toStrictEqual({ kind: 'route', to: `${ROUTE}${POST}` })
    expect(link(`<https://discord.com/channels/${GUILD}/${POST}/${MESSAGE}>`)).toStrictEqual({
      kind: 'route',
      to: `${ROUTE}${POST}#m-${MESSAGE}`,
    })
    expect(link(`  https://discord.com/channels/${GUILD}/${POST}  `)).toStrictEqual({ kind: 'route', to: `${ROUTE}${POST}` })
    expect(link(`http://discord.com/channels/${GUILD}/${POST}`)).toStrictEqual({ kind: 'route', to: `${ROUTE}${POST}` })
  })

  it('goes to the post for a channel mention, whatever the guild the mention is read in', () => {
    const { link } = make()
    // The mention names no guild: the ctx's own guild is not the one the archive's code assumes for a bare mention.
    expect(GUILD).not.toBe(GUILD_ID)
    expect(link(`<#${POST}>`)).toStrictEqual({ kind: 'route', to: `${ROUTE}${POST}` })
    expect(link(` <#${POST_TWO}> `)).toStrictEqual({ kind: 'route', to: `${ROUTE}${POST_TWO}` })
  })

  it('is an external link when the guild is not ours, even for a channel that is a post', () => {
    const { link } = make()
    for (const other of [GUILD_ID, '200000000000000499', '@me']) {
      const href = `https://discord.com/channels/${other}/${POST}`
      expect(link(href), other).toStrictEqual({ kind: 'external', href })
    }
  })

  it('is an external link for a channel that is no post, and text for a mention of one', () => {
    const { link } = make()
    const href = `https://discord.com/channels/${GUILD}/${OTHER_CHANNEL}/${MESSAGE}`
    expect(link(href)).toStrictEqual({ kind: 'external', href })
    expect(link(`<#${OTHER_CHANNEL}>`)).toStrictEqual({ kind: 'text' })
  })

  it('is an external link for any other Discord address', () => {
    const { link } = make()
    for (const href of [
      'https://discord.com/',
      'https://discord.gg/abcdef',
      `https://discord.com/channels/${GUILD}/${POST}?x=1`,
      `https://discord.com/channels/${GUILD}`,
      'https://discord.com/channels/@me',
      `https://discord.com/channels/${GUILD}/${POST}/abc`,
      `https://cdn.discordapp.com/attachments/${POST}/${MESSAGE}/a.png`,
      'https://support.discord.com/hc/en-us',
    ]) {
      expect(link(href), href).toStrictEqual({ kind: 'external', href })
    }
  })
})

describe('link: every other address', () => {

  it('is an external link, as written, for an https address', () => {
    const { link } = make()
    for (const href of [
      'https://example.org',
      'https://example.org/',
      'https://example.org/a/b?c=d#e',
      'https://sub.example.org:8443/x',
      'HTTPS://EXAMPLE.ORG/A',
      'https://exa-mple.org/%20x',
      'https://user:pass@example.org/',
    ]) {
      expect(link(href), href).toStrictEqual({ kind: 'external', href })
    }
  })

  it('is text for a scheme that is not https', () => {
    const { link } = make()
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\nscript:alert(1)',
      'javascript://example.org/%0aalert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'blob:https://example.org/abc',
      'http://example.org',
      'HTTP://EXAMPLE.ORG',
      'http://discord.com/',
      'ftp://example.org',
      'file:///etc/passwd',
      'mailto:a@example.org',
      'tel:123',
      'ws://example.org',
      '//example.org',
      'example.org',
      '/reliquarium/librarius/1',
      '#m-1',
    ]) {
      expect(link(href), href).toStrictEqual({ kind: 'text' })
    }
  })

  it('is text for an https address with no host', () => {
    const { link } = make()
    for (const href of ['https:', 'https:/', 'https://', 'https:///x', 'https://?x', 'https://#x', 'https://\\x', 'https:example.org', 'https:\\\\example.org']) {
      expect(link(href), href).toStrictEqual({ kind: 'text' })
    }
  })

  it('is text for an address with white space, a control character or an invisible one in it', () => {
    const { link } = make()
    for (const href of [
      ' https://example.org',
      'https://example.org ',
      'https://example.org/a b',
      'https://exa mple.org',
      'https:// example.org',
      'https://example.org/\n',
      'https://example.org/\tx',
      'https://example.org/\u0000',
      'https://example.org/\u007f',
      'https://example.org/\u0085',
      'https://example.org/​',
      'https://example.org/‍',
      'https://example.org/‎',
      'https://example.org/‮',
      'https://example.org/⁦',
      'https://example.org/﻿',
      'https://​example.org',
      'https://‮example.org',
      'https://example.org/ x',
      'https://example.org/ x',
    ]) {
      expect(link(href), JSON.stringify(href)).toStrictEqual({ kind: 'text' })
    }
  })

  it('keeps ordinary letters from other scripts in an address', () => {
    const { link } = make()
    for (const href of ['https://пример.рф/путь', 'https://example.org/日本語', 'https://example.org/😀']) {
      expect(link(href), href).toStrictEqual({ kind: 'external', href })
    }
  })

  it('is text for what is no address', () => {
    const { link } = make()
    for (const href of ['', ' ', 'hello', '<#123>', `<@${TOR}>`, `<#${POST}`, `#${POST}`, POST, `<#${POST}>x`, '<>', '[x](y)']) {
      expect(link(href), href).toStrictEqual({ kind: 'text' })
    }
  })

  it('is text for what is no string', () => {
    const { link } = make()
    for (const href of [undefined, null, 5, true, {}, [], ['https://example.org'], { toString: () => 'https://example.org' }]) {
      expect(link(href), String(href)).toStrictEqual({ kind: 'text' })
    }
  })

  it('answers one of three kinds, and an external link keeps the very text it was given, for any text', () => {
    const { link } = make()
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (href) => {
        const r = link(href)
        expect(['route', 'external', 'text']).toContain(r.kind)
        if (r.kind === 'external') {
          expect(r.href).toBe(href)
          expect(href).toMatch(/^https:\/\//i)
        }
        if (r.kind === 'route') expect(r.to.startsWith(ROUTE)).toBe(true)
      }),
    )
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ['https'] }), (href) => {
        expect(link(href)).toStrictEqual({ kind: 'external', href })
      }),
    )
  })
})

describe('mention', () => {

  it('is a member by name from the people the page knows', () => {
    const { mention } = make()
    expect(mention({ kind: 'user', id: TOR })).toStrictEqual({ label: '@Tor Mardan', color: null })
  })

  it('is an unknown member for one it does not know, or one with no name', () => {
    const { mention } = make()
    expect(mention({ kind: 'user', id: '200000000000000499' })).toStrictEqual({ label: '@unknown-member', color: null })
    for (const name of ['', null, undefined, 5, {}]) {
      const { mention: m } = make({ people: { [TOR]: { name, avatar: null } } })
      expect(m({ kind: 'user', id: TOR }), String(name)).toStrictEqual({ label: '@unknown-member', color: null })
    }
    const { mention: m } = make({ people: { [TOR]: null } })
    expect(m({ kind: 'user', id: TOR })).toStrictEqual({ label: '@unknown-member', color: null })
  })

  it('does not take a name off the prototype of the table', () => {
    const { mention } = make()
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(mention({ kind: 'user', id }), id).toStrictEqual({ label: '@unknown-member', color: null })
    }
    const { mention: m } = make({ people: JSON.parse(`{"__proto__": {"name": "Sneaky"}}`) })
    expect(m({ kind: 'user', id: '__proto__' })).toStrictEqual({ label: '@Sneaky', color: null })
    expect(m({ kind: 'user', id: 'constructor' })).toStrictEqual({ label: '@unknown-member', color: null })
  })

  it('shows a name as it is, markup and all, for the page to show as text', () => {
    const { mention: m } = make({ people: { [TOR]: { name: '<img src=x onerror=alert(1)>', avatar: null } } })
    expect(m({ kind: 'user', id: TOR }).label).toBe('@<img src=x onerror=alert(1)>')
  })

  it('is a role by name with its colour', () => {
    const { mention } = make()
    expect(mention({ kind: 'role', id: WARDENS })).toStrictEqual({ label: '@Wardens', color: '#aa3322' })
  })

  it('has no colour for a role with none', () => {
    const { mention } = make()
    expect(mention({ kind: 'role', id: PLAIN })).toStrictEqual({ label: '@Plain', color: null })
    const { mention: m } = make({ roles: [{ id: WARDENS, name: 'Wardens' }] })
    expect(m({ kind: 'role', id: WARDENS })).toStrictEqual({ label: '@Wardens', color: null })
  })

  it('takes only a colour that is a hex code of six digits', () => {
    for (const color of ['#AABBCC', '#aabbcc', '#000000', '#ffFFff']) {
      const { mention: m } = make({ roles: [{ id: WARDENS, name: 'Wardens', color }] })
      expect(m({ kind: 'role', id: WARDENS }).color, color).toBe(color)
    }
    for (const color of ['red', '#abc', '#aabbc', '#aabbccd', 'aabbcc', '#gggggg', 'red; background: url(x)', '#aabbcc;x', ' #aabbcc', '#aabbcc\n', 'url(javascript:1)', 7, {}, '', { toString: () => '#aabbcc' }, ['#aabbcc']]) {
      const { mention: m } = make({ roles: [{ id: WARDENS, name: 'Wardens', color }] })
      expect(m({ kind: 'role', id: WARDENS }), String(color)).toStrictEqual({ label: '@Wardens', color: null })
    }
  })

  it('passes over what is no role among the roles', () => {
    const { mention: m } = make({ roles: [null, undefined, 5, 'x', { id: WARDENS, name: 'Wardens', color: null }] })
    expect(m({ kind: 'role', id: WARDENS })).toStrictEqual({ label: '@Wardens', color: null })
    expect(m({ kind: 'role', id: PLAIN })).toStrictEqual({ label: '@unknown-role', color: null })
  })

  it('is an unknown role for one it does not know, or one with no name', () => {
    const { mention } = make()
    expect(mention({ kind: 'role', id: '200000000000000499' })).toStrictEqual({ label: '@unknown-role', color: null })
    for (const name of ['', null, undefined, 5]) {
      const { mention: m } = make({ roles: [{ id: WARDENS, name, color: '#aa3322' }] })
      expect(m({ kind: 'role', id: WARDENS }), String(name)).toStrictEqual({ label: '@unknown-role', color: null })
    }
  })

  it('looks a role up among the roles, not among the people', () => {
    const { mention } = make()
    expect(mention({ kind: 'role', id: TOR }).label).toBe('@unknown-role')
    expect(mention({ kind: 'user', id: WARDENS }).label).toBe('@unknown-member')
  })

  it('is the title of a post for a channel that is one', () => {
    const { mention } = make()
    expect(mention({ kind: 'channel', id: POST })).toStrictEqual({ label: 'The Long Road', color: null })
    expect(mention({ kind: 'channel', id: POST_TWO })).toStrictEqual({ label: 'Supply Lines', color: null })
  })

  it('is #channel for a channel that is no post, or a post with no title', () => {
    const { mention } = make()
    expect(mention({ kind: 'channel', id: OTHER_CHANNEL })).toStrictEqual({ label: '#channel', color: null })
    for (const title of ['', null, undefined, 5]) {
      const { mention: m } = make({ postTitles: new Map([[POST, title]]) })
      expect(m({ kind: 'channel', id: POST }), String(title)).toStrictEqual({ label: '#channel', color: null })
    }
  })

  it('is #channel for a kind it does not know', () => {
    const { mention } = make()
    expect(mention({ kind: 'everyone', id: POST })).toStrictEqual({ label: '#channel', color: null })
    expect(mention({ kind: undefined, id: POST })).toStrictEqual({ label: '#channel', color: null })
  })

  it('never answers a label that is empty', () => {
    const { mention } = make()
    const kinds = ['user', 'role', 'channel', 'other']
    fc.assert(
      fc.property(fc.constantFrom(...kinds), fc.string({ maxLength: 30 }), (kind, id) => {
        const { label, color } = mention({ kind, id })
        expect(label.length).toBeGreaterThan(1)
        expect(color === null || /^#[0-9a-f]{6}$/i.test(color)).toBe(true)
      }),
    )
  })
})

describe('emoji', () => {

  it('is the image on Discord\'s CDN, webp for a still emoji', () => {
    const { emoji } = make()
    const v = emoji({ type: 'emoji', name: 'wolf', id: EMOJI_ID, animated: false, raw: `<:wolf:${EMOJI_ID}>` })
    expect(v.type).toBe('img')
    expect(v.props).toStrictEqual({
      src: `https://cdn.discordapp.com/emojis/${EMOJI_ID}.webp?size=48`,
      alt: ':wolf:',
      class: 'lb-emoji',
      loading: 'lazy',
    })
  })

  it('is a gif for an animated one', () => {
    const { emoji } = make()
    const v = emoji({ name: 'wolf', id: EMOJI_ID, animated: true })
    expect(v.props.src).toBe(`https://cdn.discordapp.com/emojis/${EMOJI_ID}.gif?size=48`)
  })

  it('is still for anything that is not true', () => {
    const { emoji } = make()
    for (const animated of [false, undefined, null, 0, 1, 'true', 'a']) {
      expect(emoji({ name: 'wolf', id: EMOJI_ID, animated }).props.src, String(animated)).toBe(`https://cdn.discordapp.com/emojis/${EMOJI_ID}.webp?size=48`)
    }
  })

  it('takes the ids of 17 to 20 digits', () => {
    const { emoji } = make()
    for (const id of ['12345678901234567', '123456789012345678', '12345678901234567890']) {
      expect(emoji({ name: 'x', id, animated: false }).props.src, id).toBe(`https://cdn.discordapp.com/emojis/${id}.webp?size=48`)
    }
  })

  it('is its name as text when the id is no id, so no address is made of it', () => {
    const { emoji } = make()
    for (const id of ['', 'abc', '1234567890123456', '123456789012345678901', '12345678901234567x', `${EMOJI_ID}/../x`, `${EMOJI_ID}.png?x`, `x${EMOJI_ID}`, `${EMOJI_ID}\n`, null, undefined, 5, 12345678901234567, {}, { toString: () => EMOJI_ID }, [EMOJI_ID]]) {
      expect(emoji({ name: 'wolf', id, animated: false }), String(id)).toBe(':wolf:')
    }
  })

  it('names an emoji that has no name, or one that is no word, as "emoji"', () => {
    const { emoji } = make()
    for (const name of [null, undefined, '', 5, 'a b', '<script>', 'a'.repeat(33), 'x"onerror="y']) {
      expect(emoji({ name, id: EMOJI_ID, animated: false }).props.alt, String(name)).toBe(':emoji:')
      expect(emoji({ name, id: 'bad', animated: false }), String(name)).toBe(':emoji:')
    }
    expect(emoji({ name: 'a'.repeat(32), id: EMOJI_ID }).props.alt).toBe(`:${'a'.repeat(32)}:`)
    expect(emoji({ name: 'under_score_9', id: EMOJI_ID }).props.alt).toBe(':under_score_9:')
  })
})

describe('httpsUrl', () => {
  it('is the address itself for an https address, else null', () => {
    expect(httpsUrl('https://example.org/a')).toBe('https://example.org/a')
    expect(httpsUrl('http://example.org/a')).toBeNull()
    expect(httpsUrl('javascript:alert(1)')).toBeNull()
    expect(httpsUrl(null)).toBeNull()
    expect(httpsUrl(undefined)).toBeNull()
    expect(httpsUrl(7)).toBeNull()
  })
})

describe('attachmentUrl', () => {
  const good = 'https://cdn.discordapp.com/attachments/200000000000000401/200000000000000450/a.png'

  it('is the address for one on the attachments path of the CDN', () => {
    expect(attachmentUrl(good)).toBe(good)
    expect(attachmentUrl(`${good}?ex=65f0&is=65e0&hm=ab12`)).toBe(`${good}?ex=65f0&is=65e0&hm=ab12`)
    expect(attachmentUrl('https://cdn.discordapp.com/attachments/1')).toBe('https://cdn.discordapp.com/attachments/1')
  })

  it('is null for any other address', () => {
    for (const url of [
      'http://cdn.discordapp.com/attachments/1/2/a.png',
      'https://cdn.discordapp.com/attachments',
      'https://cdn.discordapp.com/avatars/1/a.png',
      'https://cdn.discordapp.com/emojis/1.png',
      'https://cdn.discordapp.com/',
      'https://cdn.discordapp.com.evil.example/attachments/1/2/a.png',
      'https://cdn.discordapp.com@evil.example/attachments/1/2/a.png',
      'https://evil.example/https://cdn.discordapp.com/attachments/1/2/a.png',
      'https://evil.example/?u=https://cdn.discordapp.com/attachments/1/2/a.png',
      'https://media.discordapp.net/attachments/1/2/a.png',
      'https://example.org/a.png',
      'HTTPS://CDN.DISCORDAPP.COM/attachments/1/2/a.png',
      ' https://cdn.discordapp.com/attachments/1/2/a.png',
      '//cdn.discordapp.com/attachments/1/2/a.png',
      '/attachments/1/2/a.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '',
    ]) {
      expect(attachmentUrl(url), url).toBeNull()
    }
  })

  it('is null for an address that climbs out of the attachments path', () => {
    for (const url of [
      'https://cdn.discordapp.com/attachments/../avatars/1/a.png',
      'https://cdn.discordapp.com/attachments/%2e%2e/avatars/1/a.png',
      'https://cdn.discordapp.com/attachments/%2E%2E/avatars/1/a.png',
      'https://cdn.discordapp.com/attachments/./../avatars/1/a.png',
      'https://cdn.discordapp.com/attachments/..\\avatars\\1\\a.png',
      'https://cdn.discordapp.com/attachments/1/../../avatars/1/a.png',
    ]) {
      expect(attachmentUrl(url), url).toBeNull()
    }
  })

  it('is null for what is no string', () => {
    for (const url of [undefined, null, 5, true, {}, [good], { toString: () => good }, { startsWith: () => true }]) {
      expect(attachmentUrl(url), String(url)).toBeNull()
    }
  })

  it('answers the address as the browser reads it', () => {
    expect(attachmentUrl('https://cdn.discordapp.com/attachments/1/2/a b.png')).toBe('https://cdn.discordapp.com/attachments/1/2/a%20b.png')
    expect(attachmentUrl('https://cdn.discordapp.com/attachments/1/2/a\n.png')).toBe('https://cdn.discordapp.com/attachments/1/2/a.png')
  })

  it('answers either null or an address on the attachments path, for any text after the path', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (rest) => {
        const out = attachmentUrl(`https://cdn.discordapp.com/attachments/${rest}`)
        if (out !== null) {
          expect(out.startsWith('https://cdn.discordapp.com/attachments/')).toBe(true)
          expect(new URL(out).origin).toBe('https://cdn.discordapp.com')
        }
      }),
    )
  })
})

describe('proxyImageUrl', () => {
  it('is the address for one on the media proxy', () => {
    for (const url of [
      'https://media.discordapp.net/attachments/1/2/a.png?width=400&height=300',
      'https://images-ext-1.discordapp.net/external/abc/https/example.org/a.png',
      'https://images-ext-12.discordapp.net/external/abc/a.png',
      'https://images-ext-123456.discordapp.net/x',
    ]) {
      expect(proxyImageUrl(url), url).toBe(url)
    }
  })

  it('answers the address as the browser reads it', () => {
    expect(proxyImageUrl('https://media.discordapp.net/a b.png')).toBe('https://media.discordapp.net/a%20b.png')
    expect(proxyImageUrl('https://media.discordapp.net/a\n.png')).toBe('https://media.discordapp.net/a.png')
    expect(proxyImageUrl('https://media.discordapp.net')).toBeNull()
  })

  it('is null for any other address', () => {
    for (const url of [
      'http://media.discordapp.net/a.png',
      'https://cdn.discordapp.com/attachments/1/2/a.png',
      'https://media.discordapp.net.evil.example/a.png',
      'https://media.discordapp.net@evil.example/a.png',
      'https://evil.example/media.discordapp.net/a.png',
      'https://evil.example/?https://media.discordapp.net/a.png',
      'https://images-ext-.discordapp.net/a.png',
      'https://images-ext-x.discordapp.net/a.png',
      'https://images-ext-1x.discordapp.net/a.png',
      'https://images-ext.discordapp.net/a.png',
      'https://xmedia.discordapp.net/a.png',
      'HTTPS://MEDIA.DISCORDAPP.NET/a.png',
      ' https://media.discordapp.net/a.png',
      'https://media.discordapp.com/a.png',
      'https://media-discordapp.net/a.png',
      'https://example.org/a.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '//media.discordapp.net/a.png',
      '',
      'not a url',
    ]) {
      expect(proxyImageUrl(url), url).toBeNull()
    }
  })

  it('is null for what is no string, and never throws', () => {
    for (const url of [undefined, null, 5, true, {}, [], { toString: () => 'https://media.discordapp.net/a.png' }]) {
      expect(proxyImageUrl(url), String(url)).toBeNull()
    }
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (text) => {
        const out = proxyImageUrl(text)
        expect(out === null || /^https:\/\/(?:media|images-ext-\d+)\.discordapp\.net\//.test(out)).toBe(true)
      }),
    )
  })
})
