import { h, ref } from 'vue'
import { RouterLink } from 'vue-router'

// A page text's segments (lib/deathwatch/notables.js inline()) as elements, never as HTML: bold, italic, a link (one
// to a page of the area opens in place, as a router link; any other, https only, in a new tab), and a spoiler. The
// elements carry no scope id, so a page styles them through its own root with :deep(); a spoiler is styled once,
// in deathwatch.css.
const TAG = { b: 'b', i: 'i' }

// A spoiler, as on the old site: hidden under a blur, shown while a mouse is over it, and opened or closed by a tap,
// a click, Enter or Space. It is a toggle button to assistive technology, which hears that it is a spoiler first.
const Spoiler = {
  props: ['t'],
  setup(props) {
    const open = ref(false)
    const toggle = () => (open.value = !open.value)
    const onKeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      toggle()
    }
    return () =>
      h(
        'span',
        { class: ['nm-spl', { open: open.value }], role: 'button', tabindex: 0, 'aria-expanded': String(open.value), onClick: toggle, onKeydown },
        [h('span', { class: 'dw-sr-only' }, 'Spoiler: '), props.t],
      )
  },
}

const link = (s) =>
  s.href.startsWith('/')
    ? h(RouterLink, { to: s.href }, () => render(s.segs))
    : h('a', { href: s.href, target: '_blank', rel: 'noopener noreferrer' }, render(s.segs))
const render = (segs) =>
  segs.map((s) =>
    s.k === 'a' ? link(s) : s.k === 's' ? h(Spoiler, { t: s.t }) : s.k ? h(TAG[s.k], s.segs ? render(s.segs) : s.t) : s.t,
  )
const Inline = (props) => render(props.segs)
Inline.props = ['segs']
export default Inline
