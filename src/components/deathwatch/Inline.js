import { h } from 'vue'

// A page text's segments (lib/deathwatch/notables.js inline()) as elements, never as HTML: bold, italic, a link
// (https only, opening in a new tab), and a spoiler, as on the old site: hidden until hovered or focused, and opened
// or closed by a tap, since a phone has no hover. A screen reader hears that it is a spoiler before it. The elements
// carry no scope id, so a page styles them through its own root with :deep(); .open is a revealed spoiler.
const TAG = { b: 'b', i: 'i' }
const spoiler = (s) =>
  h('span', { class: 'nm-spl', tabindex: 0, onClick: (e) => e.currentTarget.classList.toggle('open') }, [
    h('span', { class: 'dw-sr-only' }, 'Spoiler: '),
    s.t,
  ])
const render = (segs) =>
  segs.map((s) =>
    s.k === 'a'
      ? h('a', { href: s.href, target: '_blank', rel: 'noopener noreferrer' }, render(s.segs))
      : s.k === 's'
        ? spoiler(s)
        : s.k
          ? h(TAG[s.k], s.t)
          : s.t,
  )
const Inline = (props) => render(props.segs)
Inline.props = ['segs']
export default Inline
