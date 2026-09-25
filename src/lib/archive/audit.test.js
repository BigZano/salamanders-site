import { describe, it, expect } from 'vitest'
import { createArchive } from './model'
import { auditArchive } from './audit'
import { makeIndex, IDS } from './testIndex'

const kinds = (a) => auditArchive(createArchive(a)).problems.map((p) => p.kind)

describe('auditArchive', () => {
  it('the synthetic archive is clean', () => {
    const r = auditArchive(createArchive(makeIndex()))
    expect(r.problems).toEqual([])
    expect(r.stats).toMatchObject({ links: 6, route: 4, text: 1, external: 1 })
  })
  it('removing a fix makes its dead link unaccounted, naming where it lives', () => {
    const idx = makeIndex()
    delete idx.fixes[`${IDS.A_T2}/${IDS.DEAD_MSG}`]
    const [p] = auditArchive(createArchive(idx)).problems
    expect(p).toMatchObject({ kind: 'unaccounted-link', collectionKey: 'accolades', threadId: IDS.A_T2, messageId: IDS.A_T2 })
    expect(p.detail).toMatch(/no longer exists/)
  })
  it('a discord.gg invite in content is a problem', () => {
    const idx = makeIndex()
    const f = `threads/${IDS.R_TOC}.json`
    const t = JSON.parse(idx.collections.ranks.files[f])
    t.messages[0].content = 'join https://discord.gg/abc'
    idx.collections.ranks.files[f] = JSON.stringify(t)
    expect(kinds(idx)).toEqual(['unaccounted-link'])
  })
  it.each([
    ['unknown-emoji', `<:nope:111111111111111111>`],
    ['unknown-role', `<@&111111111111111111>`],
    ['unknown-user', `<@111111111111111111>`],
  ])('%s is reported', (kind, content) => {
    const idx = makeIndex()
    const f = `threads/${IDS.R_TOC}.json`
    const t = JSON.parse(idx.collections.ranks.files[f])
    t.messages[0].content = content
    idx.collections.ranks.files[f] = JSON.stringify(t)
    expect(kinds(idx)).toEqual([kind])
  })
  it('an attachment with no asset is reported', () => {
    const idx = makeIndex()
    const f = `threads/${IDS.R_TOC}.json`
    const t = JSON.parse(idx.collections.ranks.files[f])
    t.messages[0].attachments = [{ url: 'https://cdn.discordapp.com/attachments/1/2/x.png' }]
    idx.collections.ranks.files[f] = JSON.stringify(t)
    expect(kinds(idx)).toEqual(['missing-attachment'])
  })
  it('an invalid fix entry is reported', () => {
    const idx = makeIndex()
    idx.fixes['bad'] = { text: true, why: 'x' }
    expect(kinds(idx)).toContain('bad-fix')
  })
  it('channel mentions of unknown external channels are unaccounted without a fix', () => {
    const idx = makeIndex()
    delete idx.fixes[IDS.EXT_CHANNEL]
    expect(kinds(idx)).toEqual(['unaccounted-link'])
  })
  it('messages without content or attachments fields are fine', () => {
    const idx = makeIndex()
    const f = `threads/${IDS.R_TOC}.json`
    const th = JSON.parse(idx.collections.ranks.files[f])
    delete th.messages[0].content
    delete th.messages[0].attachments
    idx.collections.ranks.files[f] = JSON.stringify(th)
    expect(auditArchive(createArchive(idx)).problems).toEqual([])
  })
  it('a collection whose resolve.json lacks roles/users maps reports mentions instead of crashing', () => {
    const idx = makeIndex()
    const r = JSON.parse(idx.collections.ranks.files['resolve.json'])
    delete r.roles
    delete r.users
    idx.collections.ranks.files['resolve.json'] = JSON.stringify(r)
    const f = `threads/${IDS.R_TOC}.json`
    const th = JSON.parse(idx.collections.ranks.files[f])
    th.messages[0].content = `<@&${IDS.ROLE}> <@${IDS.USER}>`
    idx.collections.ranks.files[f] = JSON.stringify(th)
    expect(kinds(idx)).toEqual(['unknown-role', 'unknown-user'])
  })
})
