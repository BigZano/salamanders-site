<script>
const NONE = Object.freeze([])
</script>

<script setup>
// One Discord message as the Librarius shows it: the avatar, name and time (a message that sits under the one before it
// has none), a line for the message it replies to, the text through the Legion Archive's markdown renderer, then its
// attachments, embeds, stickers and reactions. Everything arrives as data and goes on the page as text or as an element
// made here, never as markup. An address is used only once render.js has passed it: attachments from Discord's CDN,
// embed pictures from its media proxy, links as https. Videos and other files are links, not players. A picture whose
// file is named SPOILER_ is blurred until it is clicked, or Enter or Space is pressed on it.
//
// A reply written on the site (`origin: 'site'`) has the "site" tag, and its text is read in the site's own markdown (the
// extended dialect), from its whole source where the message has it (the outbox stores the same text as its content), so
// that it reads as the composer previewed it. Its pictures (`upload:N` in the text, the files the site named picture-N.<type>)
// are shown where the text puts them, not again under it. The reply line of a message that quotes one reads it the same way.
//
// At the end of the message are what the page offers on it (`actions`) and how what the reader has on its way for it stands
// (`entry`, an edit or a delete: LibActions.vue), and the message is greyed while that is going; what is pressed is passed on
// (`act`). Styles are in librarius.css.
import { computed, h, reactive } from 'vue'
import ArchiveMarkdown from '../archive/ArchiveMarkdown'
import LibActions from './LibActions.vue'
import { parse, walk } from '../../lib/archive/markdown'
import { isImage, isSpoilerFile, messageExcerpt, sizeText } from '../../lib/librarius/layout'
import { attachmentUrl, httpsUrl, proxyImageUrl } from '../../lib/librarius/render'
import { initials, safeAvatar } from '../../lib/rosterAvatar'
import './librarius.css'

const props = defineProps({
  message: { type: Object, required: true },
  // True for a message that sits under the one before it from the same person: no avatar, name or time.
  grouped: { type: Boolean, default: false },
  // True for the wide layout of a long message, or one with a heading or pictures.
  article: { type: Boolean, default: false },
  // { member id: { name, avatar } }: who people are now. The message's own author fields are the fallback.
  people: { type: Object, default: () => ({}) },
  // What ArchiveMarkdown renders with: { link, emoji, mention } (see createRenderCtx).
  ctx: { type: Object, required: true },
  // The actions the page offers on the message, in order (see LibActions.vue). The page gives the same list for the same actions, so
  // that a message whose actions have not changed is not drawn again.
  actions: { type: Array, default: () => NONE },
  // The edit or the delete of the message the reader has on its way, as the store holds it, or null.
  entry: { type: Object, default: null },
  // Whether a blocked edit can be put back to be changed.
  revisable: { type: Boolean, default: false },
  // Why the last thing done to the message did not go, or ''.
  actionError: { type: String, default: '' },
})
const emit = defineEmits(['act'])

// While its edit or its delete is going, the message is greyed.
const pending = computed(() => props.entry?.state === 'sending' || props.entry?.state === 'sent')

// The name the site gives the file of a reply's picture at place N (librariusOutbox.js): picture-N.<type>, N from 1 to 10.
const SITE_PICTURE = /^picture-(10|[1-9])\.[a-z]+$/

// A functional component that puts a VNode the context made on the page.
const Show = (p) => p.vnode
Show.props = ['vnode']

const known = (id) => (Object.hasOwn(props.people, id) ? props.people[id] : null)

const author = computed(() => {
  const person = known(props.message.authorId)
  return {
    name: person?.name || props.message.authorName,
    avatar: safeAvatar(person ? person.avatar : props.message.authorAvatar),
  }
})

const stamp = computed(() =>
  new Date(props.message.createdAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
)
const stampLong = computed(() => new Date(props.message.createdAt).toLocaleString())

const fromSite = computed(() => props.message.origin === 'site')
const nodes = computed(() => {
  if (!fromSite.value) return parse(props.message.content)
  const { source, content } = props.message
  return parse(typeof source === 'string' ? source : content, { dialect: 'extended' })
})
const hasText = computed(() => nodes.value.some((node) => node.type !== 'blank'))

// A site reply's pictures, by place: the attachments the site named for one, on the CDN.
const placed = computed(() => {
  const byPlace = new Map()
  if (!fromSite.value) return byPlace
  for (const a of props.message.attachments) {
    const place = SITE_PICTURE.exec(a.filename ?? '')?.[1]
    const href = attachmentUrl(a.url)
    if (place !== undefined && href !== null) byPlace.set(Number(place), { id: a.id, href, width: a.width, height: a.height })
  }
  return byPlace
})
// The places the text shows a picture at.
const shownPlaces = computed(() => {
  const places = new Set()
  walk(nodes.value, (node) => {
    if (node.type === 'image') places.add(node.ref)
  })
  return places
})
// The page's context, with the site reply's pictures drawn where its text puts them (else the stand-in).
const bodyCtx = computed(() => {
  if (placed.value.size === 0) return props.ctx
  return {
    ...props.ctx,
    image(ref, alt) {
      const pic = placed.value.get(ref)
      if (pic === undefined || failed.has(pic.href)) return null
      return h('img', { class: 'lb-image', src: pic.href, alt, width: pic.width, height: pic.height, loading: 'lazy', onError: () => failed.add(pic.href) })
    },
  }
})
const inText = (a) => [...placed.value.entries()].some(([place, pic]) => pic.id === a.id && shownPlaces.value.has(place))

const reply = computed(() => {
  const to = props.message.replyTo
  if (!to) return null
  // The message quoted is read as it is on the page: a reply of the site in its own dialect, from its source.
  return { id: to.id, name: known(to.authorId)?.name || to.authorName, quote: messageExcerpt(to) }
})

// An image or an avatar that failed to load, by its address: a renewed link is a new address, so it is tried again.
const failed = reactive(new Set())
// The spoiler pictures the reader has shown, by attachment: a renewed link does not hide one again.
const shown = reactive(new Set())

const attachments = computed(() =>
  props.message.attachments.filter((a) => !inText(a)).map((a) => ({
    id: a.id,
    image: isImage(a),
    spoiler: isSpoilerFile(a.filename) || isSpoilerFile(a.url),
    href: attachmentUrl(a.url),
    name: a.filename || 'Attachment',
    size: sizeText(a.size),
    width: a.width,
    height: a.height,
  })),
)

const embeds = computed(() =>
  props.message.embeds.map((e) => ({
    link: httpsUrl(e.url),
    title: e.title,
    // What a screen reader says of the embed's pictures: the embed's title, else this.
    alt: typeof e.title === 'string' && e.title !== '' ? e.title : 'Embedded picture',
    provider: e.provider,
    nodes: e.description ? parse(e.description) : [],
    thumb: e.thumbnail ? { src: proxyImageUrl(e.thumbnail.url), width: e.thumbnail.width, height: e.thumbnail.height } : null,
    image: e.image ? { src: proxyImageUrl(e.image.url), width: e.image.width, height: e.image.height } : null,
  })),
)
</script>

<template>
  <article :id="`m-${message.id}`" class="lb-msg" :class="{ 'lb-article': article, 'lb-grouped': grouped, 'lb-pending': pending }">
    <div class="lb-gutter">
      <template v-if="!grouped">
        <img v-if="author.avatar && !failed.has(author.avatar)" class="lb-avatar" :src="author.avatar" alt="" width="40" height="40" loading="lazy" @error="failed.add(author.avatar)" />
        <span v-else class="lb-avatar lb-initials" aria-hidden="true">{{ initials(author.name) }}</span>
      </template>
    </div>
    <div class="lb-main">
      <a v-if="reply" class="lb-reply" :href="`#m-${reply.id}`"><span class="lb-reply-text">↪ replying to <b class="lb-reply-name">{{ reply.name }}</b><template v-if="reply.quote">: <span class="lb-reply-quote">{{ reply.quote }}</span></template></span></a>
      <header v-if="!grouped" class="lb-head">
        <span class="lb-name">{{ author.name }}</span>
        <span v-if="fromSite" class="lb-site-tag">site</span>
        <time class="lb-time" :datetime="message.createdAt" :title="stampLong">{{ stamp }}</time>
      </header>
      <span v-else-if="fromSite" class="lb-site-tag">site</span>
      <div v-if="hasText" class="lb-body"><ArchiveMarkdown :nodes="nodes" :ctx="bodyCtx" /></div>

      <div v-for="a in attachments" :key="a.id" class="lb-attachment">
        <template v-if="a.image">
          <template v-if="a.href && !failed.has(a.href)">
            <div
              v-if="a.spoiler && !shown.has(a.id)"
              class="lb-spoiler-image"
              role="button"
              tabindex="0"
              aria-label="Spoiler image, activate to reveal"
              @click="shown.add(a.id)"
              @keydown.enter.prevent="shown.add(a.id)"
              @keydown.space.prevent="shown.add(a.id)"
            >
              <img class="lb-image lb-blurred" :src="a.href" alt="" :width="a.width" :height="a.height" loading="lazy" @error="failed.add(a.href)" />
              <span class="lb-spoiler-tag">Spoiler</span>
            </div>
            <img v-else class="lb-image" :src="a.href" :alt="a.name" :width="a.width" :height="a.height" loading="lazy" @error="failed.add(a.href)" />
          </template>
          <span v-else class="lb-missing">Image unavailable</span>
        </template>
        <a v-else-if="a.href" class="lb-file" :href="a.href" target="_blank" rel="noopener noreferrer">{{ a.name }}<template v-if="a.size"> ({{ a.size }})</template></a>
        <span v-else class="lb-file">{{ a.name }}<template v-if="a.size"> ({{ a.size }})</template></span>
      </div>

      <div v-for="(e, i) in embeds" :key="i" class="lb-embed">
        <p v-if="e.provider" class="lb-embed-provider">{{ e.provider }}</p>
        <p v-if="e.title" class="lb-embed-title">
          <a v-if="e.link" :href="e.link" target="_blank" rel="noopener noreferrer">{{ e.title }}</a>
          <template v-else>{{ e.title }}</template>
        </p>
        <div v-if="e.nodes.length" class="lb-embed-description"><ArchiveMarkdown :nodes="e.nodes" :ctx="ctx" /></div>
        <template v-for="(pic, kind) in { thumb: e.thumb, image: e.image }" :key="kind">
          <template v-if="pic && pic.src">
            <img v-if="!failed.has(pic.src)" :class="`lb-embed-${kind}`" :src="pic.src" :alt="e.alt" :width="pic.width" :height="pic.height" loading="lazy" @error="failed.add(pic.src)" />
            <span v-else class="lb-missing">Image unavailable</span>
          </template>
        </template>
      </div>

      <p v-for="s in message.stickers" :key="s.id" class="lb-sticker">[sticker: {{ s.name }}]</p>

      <ul v-if="message.reactions.length" class="lb-reactions" aria-label="Reactions">
        <li v-for="r in message.reactions" :key="r.key" class="lb-reaction"><Show v-if="r.id" :vnode="ctx.emoji(r)" /><span v-else>{{ r.name }}</span> <span class="lb-count">{{ r.count }}</span></li>
      </ul>
      <LibActions v-if="actions.length > 0 || entry !== null || actionError !== ''" :actions="actions" :name="author.name" :entry="entry" :revisable="revisable" :error="actionError" @act="(name) => emit('act', name)" />
    </div>
  </article>
</template>
