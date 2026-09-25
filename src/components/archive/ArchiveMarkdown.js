/**
 * AST → VNodes. Text goes through Vue's escaping; there is no v-html
 * anywhere in the archive. Links come only from classifyHref: route,
 * external https, or plain text.
 */
import { defineComponent, h, ref } from 'vue'
import { RouterLink } from 'vue-router'

const Spoiler = defineComponent({
  name: 'ArchiveSpoiler',
  setup(_, { slots }) {
    const shown = ref(false)
    const reveal = () => (shown.value = true)
    return () =>
      h('span', {
        class: ['md-spoiler', { 'is-shown': shown.value }],
        role: 'button',
        tabindex: shown.value ? -1 : 0,
        'aria-expanded': String(shown.value),
        'aria-label': shown.value ? undefined : 'Spoiler, activate to reveal',
        onClick: reveal,
        onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), reveal()),
      }, slots.default?.())
  },
})

export default defineComponent({
  name: 'ArchiveMarkdown',
  props: {
    nodes: { type: Array, required: true },
    // { link(href) → classifyHref result, emoji(node) → VNode, mention(node) → {label, color} }
    ctx: { type: Object, required: true },
  },
  setup(props) {
    const inl = (nodes) => nodes.map((n) => inline(n, props.ctx))
    function block(n) {
      switch (n.type) {
        case 'heading': return h(`h${n.level + 1}`, { class: `md-h md-h${n.level}` }, inl(n.children))
        case 'subtext': return h('p', { class: 'md-sub' }, inl(n.children))
        case 'quote': return h('blockquote', { class: 'md-quote' }, n.children.map(block))
        case 'list': return h(n.ordered ? 'ol' : 'ul', { class: 'md-list' }, n.items.map((it) => h('li', it.children.map(block))))
        case 'codeblock': return h('pre', { class: 'md-pre' }, h('code', n.text))
        case 'blank': return h('div', { class: 'md-blank', 'aria-hidden': 'true' })
        default: return h('p', { class: 'md-line' }, inl(n.children))
      }
    }
    function inline(n, ctx) {
      switch (n.type) {
        case 'text': return n.value
        case 'strong': return h('strong', inl(n.children))
        case 'em': return h('em', inl(n.children))
        case 'underline': return h('u', inl(n.children))
        case 'strike': return h('s', inl(n.children))
        case 'spoiler': return h(Spoiler, null, () => inl(n.children))
        case 'code': return h('code', { class: 'md-code' }, n.text)
        case 'emoji': return ctx.emoji(n)
        case 'mention': return mention(n, ctx)
        case 'link': return anchor(ctx.link(n.href), inl(n.children))
        case 'url': return anchor(ctx.link(n.href), [n.href])
        default: return ''
      }
    }
    function anchor(r, children) {
      if (r.kind === 'route') return h(RouterLink, { to: r.to, class: 'md-link' }, () => children)
      if (r.kind === 'external') return h('a', { href: r.href, class: 'md-link md-ext', target: '_blank', rel: 'noopener noreferrer' }, children)
      return h('span', { class: 'md-unlinked' }, children)
    }
    function mention(n, ctx) {
      const { label, color } = ctx.mention(n)
      if (n.kind === 'channel') {
        const r = ctx.link(n.raw)
        if (r.kind === 'route') return h(RouterLink, { to: r.to, class: 'md-mention' }, () => label)
      }
      return h('span', { class: `md-mention md-mention-${n.kind}`, style: color ? { '--role': color } : undefined }, label)
    }
    return () => h('div', { class: 'md' }, props.nodes.map(block))
  },
})
