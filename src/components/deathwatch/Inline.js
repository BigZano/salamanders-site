import { h } from 'vue'

// A page text's segments (lib/deathwatch/notables.js inline()) as elements, never as HTML: bold, italic, a spoiler
// that is hidden until hovered or focused, as on the old site, and a link (https only, opening in a new tab). Its
// elements carry no scope id, so a page styles them through its own root with :deep().
const TAG = { b: 'b', i: 'i', s: 'span' }
const ATTRS = { s: { class: 'nm-spl', tabindex: 0 } }
const render = (segs) =>
  segs.map((s) =>
    s.k === 'a'
      ? h('a', { href: s.href, target: '_blank', rel: 'noopener noreferrer' }, render(s.segs))
      : s.k
        ? h(TAG[s.k], ATTRS[s.k] ?? null, s.t)
        : s.t,
  )
const Inline = (props) => render(props.segs)
Inline.props = ['segs']
export default Inline
