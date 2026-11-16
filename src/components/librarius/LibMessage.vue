<script setup>
// One Discord message as the Librarius shows it: the avatar, name and time (a message that sits under the one before it
// has none), a line for the message it replies to, the text through the Legion Archive's markdown renderer, then its
// attachments, embeds, stickers and reactions. Everything arrives as data and goes on the page as text or as an element
// made here, never as markup. An address is used only once render.js has passed it: attachments from Discord's CDN,
// embed pictures from its media proxy, links as https. Videos and other files are links, not players. A picture whose
// file is named SPOILER_ is blurred until it is clicked, or Enter or Space is pressed on it. Styles are in
// librarius.css.
import { computed, reactive } from 'vue'
import ArchiveMarkdown from '../archive/ArchiveMarkdown'
import { parse } from '../../lib/archive/markdown'
import { excerpt, isImage, isSpoilerFile, sizeText } from '../../lib/librarius/layout'
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
})

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

const nodes = computed(() => parse(props.message.content))
const hasText = computed(() => nodes.value.some((node) => node.type !== 'blank'))

const reply = computed(() => {
  const to = props.message.replyTo
  if (!to) return null
  return { id: to.id, name: known(to.authorId)?.name || to.authorName, quote: excerpt(to.content ?? '') }
})

// An image or an avatar that failed to load, by its address: a renewed link is a new address, so it is tried again.
const failed = reactive(new Set())
// The spoiler pictures the reader has shown, by attachment: a renewed link does not hide one again.
const shown = reactive(new Set())

const attachments = computed(() =>
  props.message.attachments.map((a) => ({
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
  <article :id="`m-${message.id}`" class="lb-msg" :class="{ 'lb-article': article, 'lb-grouped': grouped }">
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
        <time class="lb-time" :datetime="message.createdAt" :title="stampLong">{{ stamp }}</time>
      </header>
      <div v-if="hasText" class="lb-body"><ArchiveMarkdown :nodes="nodes" :ctx="ctx" /></div>

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
    </div>
  </article>
</template>
