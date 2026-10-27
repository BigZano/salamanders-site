// The fortress's Notable Members, read 1:1 from the page texts the old site kept them in (cfg.tx, edited under
// Manage → Page Texts). Real names live only in the server's data, never here.
//   nm_i   introduction                       nm_hi  Chronicles of Command: introduction
//   nm_ck  line above the Watch Commander     nm_h   Chronicles: "## " a group heading, "- " one commander a line
//   nm_c   the Watch Commander: name, then paragraphs (blank line between)
//   nm_vi  Honored Veterans: introduction     nm_vk  the badge on every veteran's card
//   nm_v   one block per veteran: "Name — Epithet" ("[sealed]" at its end seals the card), then the write-up
//   nm_e   closing: a paragraph in **…** is a battle cry, one in *…* a quote

/**
 * A text's inline marks as segments the page renders without HTML: { k: 'b' | 'i' | 's' | '', t }, s a spoiler
 * (hidden until hovered or focused). A link keeps only its text: the area links nowhere from page texts. Each mark
 * stays on its line and is bounded, so a long run of "[" or "*" in a text costs no more than its length.
 */
export function inline(s) {
  const out = []
  let at = 0
  for (const m of s.matchAll(/\*\*(.{1,400}?)\*\*|\|\|(.{1,400}?)\|\||\[([^\]\n]{1,200})\]\(https:\/\/[^)\s]{1,500}\)|\*(.{1,400}?)\*/g)) {
    if (m.index > at) out.push({ k: '', t: s.slice(at, m.index) })
    const [, b, sp, link, i] = m
    out.push(b != null ? { k: 'b', t: plain(b) } : sp != null ? { k: 's', t: plain(sp) } : link != null ? { k: '', t: link } : { k: 'i', t: plain(i) })
    at = m.index + m[0].length
  }
  if (at < s.length) out.push({ k: '', t: s.slice(at) })
  return out
}
const plain = (s) => inline(s).map((x) => x.t).join('')

/** Whether a text is one mark from end to end: **…** for 'b', *…* for 'i'. "**A** and **B**" is not: it is two. */
export const whole = (s, k) => {
  const segs = inline(s)
  return segs.length === 1 && segs[0].k === k
}

const text = (v) => (typeof v === 'string' ? v : '')
const paras = (t) =>
  text(t)
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
// The introductions are one quote each, *…* around the whole: the marks go, the page sets them as quotes.
const quote = (t) => paras(t).map((p) => inline(whole(p, 'i') ? p.slice(1, -1) : p))
const SEALED = /\s*\[sealed\]\s*$/i

export function notables(tx) {
  const t = tx && typeof tx === 'object' ? tx : {}

  const [first = '', ...rest] = text(t.nm_c).split('\n')
  const name = plain(first.trim())
  const commander = name ? { kicker: plain(text(t.nm_ck).trim()) || 'Watch Commander', name, lines: paras(rest.join('\n')).map(inline) } : null

  const groups = []
  for (const line of text(t.nm_h).split('\n').map((l) => l.trim())) {
    if (!line) continue
    if (line.startsWith('#')) groups.push({ h: plain(line.replace(/^#+\s*/, '')), items: [] })
    else (groups.at(-1) ?? groups[groups.push({ h: '', items: [] }) - 1]).items.push(inline(line.replace(/^-\s*/, '')))
  }

  const veterans = paras(t.nm_v)
    .map((b) => {
      const [head, ...body] = b.split('\n')
      const sealed = SEALED.test(head)
      const [vname, epithet = ''] = head.replace(SEALED, '').split(/\s+—\s+/)
      // A sealed card shows who, never what: its record stays out of the page.
      return { name: plain(vname.trim()), epithet: plain(epithet.trim()), text: sealed ? [] : inline(body.join(' ').replace(/^-\s*/, '').trim()), sealed }
    })
    .filter((v) => v.name)

  const closing = paras(t.nm_e).map((p) =>
    whole(p, 'b') ? { kind: 'cry', t: plain(p) } : whole(p, 'i') ? { kind: 'quote', t: plain(p) } : { kind: 'p', segs: inline(p) },
  )

  return {
    intro: quote(t.nm_i),
    commander,
    chronicles: { intro: quote(t.nm_hi), groups: groups.filter((g) => g.items.length) },
    veterans: { intro: quote(t.nm_vi), badge: plain(text(t.nm_vk).trim()) || 'Honored Veteran', list: veterans },
    closing,
  }
}

/** Whether the texts name anybody at all: with nobody, the section is not shown. */
export const anyone = (n) => !!(n.commander || n.veterans.list.length || n.chronicles.groups.length)
