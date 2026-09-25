import { describe, it, expect } from 'vitest'
import { createArchive, orderMessages, emojiFile, attachmentFile, threadTags, mentionLabel, classifyHref } from './model'
import { makeIndex, IDS } from './testIndex'

describe('createArchive', () => {
  it('builds both collections with ordered, filtered messages', () => {
    const a = createArchive(makeIndex())
    expect([...a.collections.keys()]).toEqual(['accolades', 'ranks'])
    const t = a.collections.get('accolades').threads.get(IDS.A_TOC)
    expect(t.messages.map((m) => m.id)).toEqual([IDS.A_TOC, IDS.A_TOC_M2])
  })
  it.each([
    ['wrong format', (i) => ({ ...i, format: 2 })],
    ['missing collection', (i) => ({ ...i, collections: { accolades: i.collections.accolades } })],
    ['unparseable thread file', (i) => { i.collections.ranks.files[`threads/${IDS.R_TOC}.json`] = '{'; return i }],
    ['toc thread not present', (i) => { i.collections.ranks.tocThreadId = '999999999999999999'; return i }],
  ])('rejects %s', (_, mutate) => {
    expect(() => createArchive(mutate(makeIndex()))).toThrow()
  })
})

describe('orderMessages', () => {
  it('keeps type 0 and 19 only; orders by position then snowflake (as BigInt, not string)', () => {
    const msgs = [
      { id: '100000000000000009', type: 0, position: 1 },
      { id: '99999999999999999', type: 0, position: 1 },
      { id: '100000000000000001', type: 4, position: 0 },
      { id: '100000000000000002', type: 19, position: 2 },
      { id: '100000000000000003', type: 0, position: 0 },
    ]
    expect(orderMessages(msgs).map((m) => m.id)).toEqual(['100000000000000003', '99999999999999999', '100000000000000009', '100000000000000002'])
  })
})

describe('asset lookups', () => {
  const a = createArchive(makeIndex())
  const col = a.collections.get('accolades')
  it('emoji via resolve.json first', () => expect(emojiFile(col, IDS.EMOJI, false)).toBe('emoji-fixture.png'))
  it('emoji fallback via assets.json CDN key (tag emoji missing from resolve)', () =>
    expect(emojiFile(col, IDS.TAG_EMOJI, false)).toBe('emoji-tag.png'))
  it('animated fallback prefers .gif', () => expect(emojiFile(col, IDS.GIF_EMOJI, true)).toBe('emoji-anim.gif'))
  it('unknown emoji → null', () => expect(emojiFile(col, '111111111111111111', false)).toBeNull())
  it('attachment by exact URL (query string included)', () => expect(attachmentFile(col, IDS.ATT_URL)).toBe('att-fixture.png'))
  it('attachment URL without its query string does not match', () => expect(attachmentFile(col, IDS.ATT_URL.split('?')[0])).toBeNull())
  it('threadTags maps applied tag ids to forum tags, skipping unknown ids', () => {
    expect(threadTags(col, { applied_tags: [IDS.TAG, '1'] }).map((t) => t.id)).toEqual([IDS.TAG])
    expect(threadTags(col, {})).toEqual([])
  })
})

describe('mentionLabel', () => {
  const a = createArchive(makeIndex())
  const col = a.collections.get('accolades')
  it('role → name + color', () => expect(mentionLabel(col, a, { kind: 'role', id: IDS.ROLE })).toEqual({ label: '@Fixture Role', color: '#991115' }))
  it('user → @display_name', () => expect(mentionLabel(col, a, { kind: 'user', id: IDS.USER })).toEqual({ label: '@Fixture User', color: null }))
  it('channel in archive → #thread name', () => expect(mentionLabel(col, a, { kind: 'channel', id: IDS.R_TOC }).label).toBe('#Fixture Ranks'))
  it('channel outside archive → #name from resolve.channels', () =>
    expect(mentionLabel(col, a, { kind: 'channel', id: IDS.EXT_CHANNEL }).label).toBe('#fixture-reports'))
  it('unknown ids degrade to a neutral label, never the raw id', () => {
    expect(mentionLabel(col, a, { kind: 'role', id: '1' }).label).toBe('@unknown-role')
    expect(mentionLabel(col, a, { kind: 'user', id: '1' }).label).toBe('@unknown-user')
    expect(mentionLabel(col, a, { kind: 'channel', id: '1' }).label).toBe('#unknown-channel')
  })
})

describe('classifyHref', () => {
  const a = createArchive(makeIndex())
  it('in-site Discord link → route', () => expect(classifyHref(IDS.LINK_TO_RANKS, a).kind).toBe('route'))
  it('fixed external channel → text', () => expect(classifyHref(`<#${IDS.EXT_CHANNEL}>`, a)).toEqual({ kind: 'text' }))
  it('discord.gg invite → unaccounted (never a Discord href)', () =>
    expect(classifyHref('https://discord.gg/abc', a).kind).toBe('unaccounted'))
  it('non-Discord https → external', () =>
    expect(classifyHref('https://example.com/w', a)).toEqual({ kind: 'external', href: 'https://example.com/w' }))
  it.each(['javascript:alert(1)', 'data:text/html,x', '//evil.io', 'ftp://x'])('%s → text', (h) =>
    expect(classifyHref(h, a)).toEqual({ kind: 'text' }))
})
