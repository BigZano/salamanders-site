import { describe, it, expect } from 'vitest'
import { unlistedThreads, insertEntries } from './toc'
import { createArchive } from '../../lib/archive/model'
import { parse, walk } from '../../lib/archive/markdown'
import { makeIndex, IDS } from '../../lib/archive/testIndex'

const G = IDS.GUILD
// Extra accolades threads the fixture ToC never links to. The 18-digit id sorts
// before the 19-digit one numerically, though not as a string.
const LATE = '1000000000000000003'
const EARLY = '900000000000000004'

function archiveWith(extra = {}, toc = {}) {
  const index = makeIndex()
  const files = index.collections.accolades.files
  for (const [id, name] of Object.entries(extra)) {
    files[`threads/${id}.json`] = JSON.stringify({ thread: { id, name }, messages: [{ id, type: 0, position: 0, content: 'x', attachments: [] }] })
  }
  for (const [key, overlay] of Object.entries(toc)) index.collections[key].toc = overlay
  return createArchive(index)
}
const tocNodes = (a, key) => {
  const col = a.collections.get(key)
  return col.threads.get(col.tocThreadId).messages.map((m) => parse(m.content ?? ''))
}
const unlisted = (a, key, nodes = tocNodes(a, key)) => unlistedThreads(a.collections.get(key), a, nodes)

describe('unlistedThreads', () => {
  it('is empty when the ToC links every thread in its collection', () => {
    const a = archiveWith()
    expect(unlisted(a, 'accolades')).toEqual([])
    expect(unlisted(a, 'ranks')).toEqual([])
  })

  it('lists threads the ToC never links, oldest first by snowflake, never the ToC itself', () => {
    const a = archiveWith({ [LATE]: 'Late', [EARLY]: 'Early' })
    expect(unlisted(a, 'accolades')).toEqual([
      { id: EARLY, name: 'Early' },
      { id: LATE, name: 'Late' },
    ])
  })

  it('counts a link to a message inside a thread as listing that thread', () => {
    const a = archiveWith({ [EARLY]: 'Early' })
    const nodes = [...tocNodes(a, 'accolades'), parse(`[e](https://discord.com/channels/${G}/${EARLY}/${EARLY})`)]
    expect(unlisted(a, 'accolades', nodes)).toEqual([])
  })

  it('only counts links as they are displayed: nodes it is not given do not list anything', () => {
    expect(unlisted(archiveWith(), 'accolades', [])).toEqual([{ id: IDS.A_T2, name: 'Fixture Two' }])
  })

  it('ignores links into the other collection and non-route links', () => {
    const a = archiveWith()
    const nodes = [parse(`[r](https://discord.com/channels/${G}/${IDS.R_TOC}) [x](https://example.com) <#${IDS.EXT_CHANNEL}>`)]
    expect(unlisted(a, 'accolades', nodes)).toEqual([{ id: IDS.A_T2, name: 'Fixture Two' }])
  })

  it('never lists a thread the overlay hides', () => {
    const a = archiveWith({ [EARLY]: 'Early', [LATE]: 'Late' }, { accolades: { hide: [EARLY] } })
    expect(unlisted(a, 'accolades')).toEqual([{ id: LATE, name: 'Late' }])
  })
})

describe('insertEntries', () => {
  const links = (nodes) => { const out = []; walk(nodes, (n) => n.type === 'link' && out.push(n.href)); return out }

  it('puts the entry right after the block that links its `after` thread, and it then counts as listed', () => {
    const a = archiveWith({ [EARLY]: 'Early' }, { accolades: { insert: [{ after: IDS.A_T2, thread: EARLY }] } })
    const before = tocNodes(a, 'accolades')
    const out = insertEntries(before, a.collections.get('accolades'), a)
    const msg = out[1]
    const at = msg.findIndex((n) => links([n]).some((h) => h.includes(IDS.A_T2)))
    expect(msg[at + 1]).toEqual({ type: 'line', children: [{ type: 'link', href: `<#${EARLY}>`, children: [{ type: 'text', value: 'Early' }] }] })
    expect(before[1]).toHaveLength(msg.length - 1) // input untouched
    expect(unlisted(a, 'accolades', out)).toEqual([])
  })

  it('takes the shape of a heading anchor', () => {
    const a = archiveWith({ [EARLY]: 'Early' }, { accolades: { insert: [{ after: IDS.A_T2, thread: EARLY }] } })
    const nodes = [[{ type: 'heading', level: 2, children: [{ type: 'link', href: `https://discord.com/channels/${G}/${IDS.A_T2}`, children: [] }] }]]
    expect(insertEntries(nodes, a.collections.get('accolades'), a)[0][1]).toMatchObject({ type: 'heading', level: 2 })
  })

  it('appends at the end when the anchor is not in the ToC', () => {
    const a = archiveWith({ [EARLY]: 'Early' }, { accolades: { insert: [{ after: IDS.A_TOC, thread: EARLY }] } }) // the ToC never links itself
    const out = insertEntries(tocNodes(a, 'accolades'), a.collections.get('accolades'), a)
    expect(links(out.at(-1).slice(-1))).toEqual([`<#${EARLY}>`])
  })
})
