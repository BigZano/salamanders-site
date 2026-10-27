import { describe, it, expect } from 'vitest'
import { requirements, termsOfService } from './recruitment'
import { RECRUITMENT_TEXTS } from './recruitmentTexts'
import { resolveArea } from './areas'

const plain = (segs) => segs.map((s) => s.t).join('')

describe('RECRUITMENT_TEXTS', () => {
  it('holds every Recruitment text the old site had, as text', () => {
    expect(Object.keys(RECRUITMENT_TEXTS)).toEqual(['ts_h', 'ts_i', 'ts1', 'ts2', 'ts3', 'ts4', 'ts5', 'ts6', 'ts_e', 'rq_q', 'rq1', 'rq2', 'rq3'])
    for (const [k, v] of Object.entries(RECRUITMENT_TEXTS)) expect(typeof v === 'string' && v.trim().length > 0, k).toBe(true)
  })

  // Links go to the community's Discord only (the area is gated), always wrapped as a hyperlink, never bare.
  it("links only to the community's Discord or to a page of the area, always as hyperlinks", () => {
    const all = Object.values(RECRUITMENT_TEXTS).join('\n')
    const links = [...all.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1])
    const pages = links.filter((url) => url.startsWith('/'))
    expect(links.length).toBeGreaterThan(pages.length)
    for (const url of links.filter((u) => !pages.includes(u))) expect(url).toMatch(/^https:\/\/discord\.com\/channels\/\d+\/\d+(\/\d+)?$/)
    expect(all.match(/https?:/g)).toHaveLength(links.length - pages.length)
    // A page link is its page's own address, so following it never makes the guard rewrite (and replace) history.
    expect(pages).toEqual(['/deathwatch/recruitment/requirements', '/deathwatch/armouringhall/standard/watchbrother'])
    for (const url of pages) {
      const [, , area, tab, sub] = url.split('/')
      expect(resolveArea({ area, tab, sub }).canonical, url).toBe(url)
    }
  })
})

describe('termsOfService', () => {
  it('reads the six sections, each with its sub-sections and clauses', () => {
    const tos = termsOfService()
    expect(tos.sections).toHaveLength(6)
    expect(tos.sections.map((s) => plain(s.title))).toEqual([
      'Deathwatch Service',
      'Eligibility & Applications',
      'Tour Expectations',
      'Failure Progression',
      'Heraldry & Recognition',
      'Standards of Service',
    ])
    expect(tos.sections[0].subs.map((s) => s.title)).toEqual(['Tour of Duty', 'Operational Authority'])
    expect(tos.sections[0].subs[0].clauses[0][0]).toEqual({ k: 'b', t: 'Service Duration:' })
    expect(tos.sections.every((s) => s.subs.length && s.subs.every((sub) => sub.clauses.length))).toBe(true)
    expect(tos.head.map(plain)).toEqual(['Official Deathwatch Terms of Service', 'Issued by the XVIIIth Legiones Astartes — The Salamanders'])
    // Discord-only markup (custom emoji, role mentions, subtext and quote marks) is not in the texts.
    expect(Object.values(RECRUITMENT_TEXTS).join('\n')).not.toMatch(/<[@:a]|^-#|^> |__/m)
  })

  it('takes what the data holds over the default, and starts an untitled sub-section for clauses before any', () => {
    const tos = termsOfService({ ts1: 'Only\nfirst clause\n## Sub\nsecond', ts_i: '*A quote.*\n\nPlain **words**.', ts_e: '' })
    expect(plain(tos.sections[0].title)).toBe('Only')
    expect(tos.sections[0].subs.map((s) => [s.title, s.clauses.map(plain)])).toEqual([
      ['', ['first clause']],
      ['Sub', ['second']],
    ])
    expect(tos.intro).toEqual([
      { quote: true, segs: [{ k: '', t: 'A quote.' }] },
      { quote: false, segs: [{ k: '', t: 'Plain ' }, { k: 'b', t: 'words' }, { k: '', t: '.' }] },
    ])
    expect(tos.end).toEqual([])
  })

  it('drops a section the data blanks, and survives texts that are not text', () => {
    expect(termsOfService({ ts6: '' }).sections).toHaveLength(5)
    expect(termsOfService({ ts1: 42, ts_h: null }).head).toEqual([])
    expect(termsOfService('nonsense').sections).toHaveLength(6)
  })
})

describe('requirements', () => {
  it("reads the old site's three blocks: title, lead, requirements with their notes, and notes below", () => {
    const rq = requirements()
    expect(rq.blocks.map((b) => plain(b.title))).toEqual(['Rank Requirements', 'Accolade Requirements', 'Skill & Conduct Requirements'])
    const rank = rq.blocks[0]
    expect(plain(rank.items[0].segs)).toBe('Command: Sergeant or higher.')
    expect(rank.items[0].segs[0]).toEqual({ k: 'b', t: 'Command:' })
    expect(rank.notes.length).toBeGreaterThan(0)
    expect(plain(rq.quote)).not.toMatch(/^\*|\*$/)
  })

  it('puts an indented line under the requirement above it', () => {
    const b = requirements({ rq1: 'T\nLead\n- one\n  - under one\n- two\nbelow' }).blocks[0]
    expect(b.items.map((i) => [plain(i.segs), i.note && plain(i.note)])).toEqual([
      ['one', 'under one'],
      ['two', null],
    ])
    expect(b.notes.map(plain)).toEqual(['below'])
    expect(requirements({ rq2: '' }).blocks).toHaveLength(2)
  })
})
