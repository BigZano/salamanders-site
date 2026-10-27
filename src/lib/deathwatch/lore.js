// The Fortress Lore, read as the old site read it from its page texts (cfg.tx), each key falling back to the old
// site's text (loreTexts.js).
//   lo_s  subtitle      lo_e  epigraph
//   lo1…lo6  a chapter: first line its title, then one paragraph a line. Lines in *…* in a row are one speech,
//            lines in **…** in a row are battle cries, and a lone **…** line a proclamation.
import { inline } from './notables'
import { LORE_TEXTS } from './loreTexts'

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI']
const text = (v) => (typeof v === 'string' ? v : '')
const lines = (t) =>
  text(t)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
const kind = (l) => (/^\*\*.+\*\*$/.test(l) ? 'x' : /^\*[^*].*\*$/.test(l) ? 'q' : 'p')

/** A chapter's lines as blocks: { kind: 'p' | 'q' | 'x' | 'cry', lines: segs[] }, the marks around q and x gone. */
function blocks(ls) {
  const out = []
  for (const l of ls) {
    const k = kind(l)
    const last = out.at(-1)
    const segs = inline(k === 'x' ? l.slice(2, -2) : k === 'q' ? l.slice(1, -1) : l)
    if (last && last.kind !== 'p' && (last.kind === k || (last.kind === 'cry' && k === 'x'))) {
      last.lines.push(segs)
      if (k === 'x') last.kind = 'cry'
    } else out.push({ kind: k, lines: [segs] })
  }
  return out
}

export function lore(tx) {
  const t = { ...LORE_TEXTS, ...(tx && typeof tx === 'object' ? tx : {}) }
  const chapters = NUMERALS.map((n, i) => {
    const [title = '', ...rest] = lines(t[`lo${i + 1}`])
    return { n, title: inline(title), blocks: blocks(rest) }
  }).filter((c) => c.title.length)
  return {
    sub: inline(text(t.lo_s).trim()),
    epigraph: inline(text(t.lo_e).trim()),
    chapters,
  }
}
