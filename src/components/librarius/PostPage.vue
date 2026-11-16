<script setup>
// One Librarius post, the page a row of the topic list opens (layout C of the design): a breadcrumb, the title with its tags,
// reply count and start day, and a link to the post in Discord; then the messages, the opening one laid out as an article and
// the replies compact, consecutive messages of one person grouped as Discord groups them; and a rail of months to jump
// through the history. It asks the store to open the post, and again every 10 seconds (while the tab is visible) for what
// changed. What Discord sends goes on the page as text, never as markup. Styles are in librarius.css.
//
// Where the reader is:
//   - The store keeps the reader's mark (`lastRead`) moving as messages are read, so the page takes a copy of it when the post
//     opens and puts the "since your last visit" divider by that copy: the divider stays where it was while the reader reads on.
//   - The page opens at that divider, else at the message the address names (#m-<id>), else at the newest message. It scrolls
//     once for each opening, never for what a poll or an older page brings. Loading older messages keeps the reader's place.
//   - A message is reported read (the newest in view, two seconds after what is in view last changed) through the store, which
//     never lowers the mark. A failed report, poll or page is dropped quietly or noted: none of them takes the page away.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '../../stores/auth'
import { useLibrarius } from '../../stores/librarius'
import { parse } from '../../lib/archive/markdown'
import { firstUnread, groupMessages, isArticle, railMonths } from '../../lib/librarius/layout'
import { createRenderCtx } from '../../lib/librarius/render'
import { snowflakeAt } from '../../lib/librarius/snowflake'
import LibMessage from './LibMessage.vue'
import './librarius.css'

const POLL_MS = 10_000
const READ_AFTER_MS = 2_000
const SNOWFLAKE = /^\d{17,20}$/
const MESSAGE_ELEMENT = /^m-(\d{17,20})$/
const MESSAGE_ANCHOR = /^#m-(\d{17,20})$/
// The guild of a reader whose answer from /me names none the page can use: no address names this one, so no link is ours.
const NO_GUILD = '0'.repeat(17)
const COULD_NOT_REACH = 'The Librarius couldn\'t be reached.'
// Scrolls are instant: the site smooths them, and a jump to the reader's place should not be a ride.
const TO_TOP = { block: 'start', behavior: 'instant' }
const TO_END = { block: 'end', behavior: 'instant' }

const props = defineProps({
  // The id of the post: its channel, which is also the id of its opening message.
  postId: { type: String, required: true },
})

const store = useLibrarius()
const auth = useAuth()
const route = useRoute()

const root = ref(null)
// loading, ready, missing (no such post) or failed.
const phase = ref('loading')
// `lastRead` as it was when the post opened: where the divider goes, however far the reader has read since.
const snapshot = ref(null)
const notice = ref('')
const busy = reactive({ older: false, newer: false, jump: false })

const post = computed(() => (store.post?.id === props.postId ? store.post : null))
const info = computed(() => post.value?.info ?? null)
const messages = computed(() => post.value?.messages ?? [])

// The opening message first, as an article whatever its length; the replies after it, grouped, each with its own layout.
const entries = computed(() => {
  const opening = messages.value.find((message) => message.id === props.postId)
  const replies = messages.value.filter((message) => message.id !== props.postId)
  const rows = groupMessages(replies).map(({ message, grouped }) => ({ message, grouped, article: isArticle(message, parse(message.content)) }))
  return opening === undefined ? rows : [{ message: opening, grouped: false, article: true }, ...rows]
})

// The divider: before the first message newer than the reader's mark. A run that begins after the mark and has older messages
// beyond it does not say where the unread ones begin, so it gets none. The count is a lower bound when newer messages lie beyond.
const divider = computed(() => {
  const id = firstUnread(messages.value, snapshot.value)
  if (id === null) return null
  const index = messages.value.findIndex((message) => message.id === id)
  if (index === 0 && post.value.hasOlder) return null
  const count = `${messages.value.length - index}${post.value.hasNewer ? '+' : ''}`
  return { id, text: `SINCE YOUR LAST VISIT · ${count} NEW` }
})

const tagNames = computed(() => {
  const listed = Array.isArray(store.me?.tags) ? store.me.tags : []
  const names = new Map(listed.map((tag) => [tag.id, tag.name]))
  const ids = Array.isArray(info.value?.tagIds) ? info.value.tagIds : []
  return ids.map((id) => names.get(id)).filter(Boolean)
})
const timeOf = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN)
const started = computed(() => {
  const at = timeOf(info.value?.createdAt)
  return Number.isNaN(at) ? null : new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
})
const replies = computed(() => {
  const n = info.value?.replies
  return Number.isSafeInteger(n) && n >= 0 ? `${n.toLocaleString('en')} ${n === 1 ? 'reply' : 'replies'}` : ''
})
const discord = computed(() => {
  const guildId = store.me?.guildId
  return typeof guildId === 'string' && SNOWFLAKE.test(guildId) && SNOWFLAKE.test(props.postId) ? `https://discord.com/channels/${guildId}/${props.postId}` : null
})

// What the markdown renders its links, mentions and emoji with. The titles are those of the topic list the store holds, and of
// this post, so that a channel mention or a link to a post names it. A change in the list makes a new context.
const ctx = computed(() => {
  const me = store.me ?? {}
  const titles = new Map(store.posts.map((p) => [p.id, p.title]))
  if (info.value) titles.set(info.value.id, info.value.title)
  return createRenderCtx({
    guildId: typeof me.guildId === 'string' && SNOWFLAKE.test(me.guildId) ? me.guildId : NO_GUILD,
    postTitles: titles,
    people: store.people,
    roles: Array.isArray(me.roles) ? me.roles : [],
  })
})

// The months from the start of the post to now, or to its newest message held if that is later (the reader's clock may run
// behind the server's). A post that has lived in one month has no use for a rail, and a start that is no date, or is before
// Discord began, has none.
const months = computed(() => {
  try {
    const newest = messages.value.reduce((latest, message) => Math.max(latest, timeOf(message.createdAt) || 0), Date.now())
    const all = railMonths(info.value.createdAt, new Date(newest))
    return all.length > 1 ? all : []
  } catch {
    return []
  }
})

const messageElement = (id) => root.value.querySelector(`#m-${id}`)
const scrollTo = (target, options) => {
  if (target) target.scrollIntoView(options)
}
const anchorId = () => MESSAGE_ANCHOR.exec(route.hash)?.[1] ?? null

// The reader's place on opening: the divider, else the message the address names, else the newest message.
function scrollToStart() {
  const unread = root.value.querySelector('.lb-divider')
  if (unread) return scrollTo(unread, TO_TOP)
  const id = anchorId()
  const named = id === null ? null : messageElement(id)
  if (named) return scrollTo(named, TO_TOP)
  const all = root.value.querySelectorAll('.lb-msg')
  scrollTo(all[all.length - 1], TO_END)
}

// A link in this post to one of its messages changes the address while the page is open.
watch(
  () => route.hash,
  () => {
    const id = anchorId()
    if (id !== null) scrollTo(messageElement(id), TO_TOP)
  },
)

// Marking read. The messages in view are what the browser last said was in view; two seconds after that last changed, the
// newest of them is reported. One observer for each opening of a post.
let observer = null
const watched = new WeakSet()
let readTimer = null
const inView = new Set()

function sendRead() {
  let newest = null
  for (const id of inView) {
    if (newest === null || BigInt(id) > BigInt(newest)) newest = id
  }
  if (newest !== null) store.markRead(auth.token, newest).catch(() => {})
}

function seen(entries) {
  for (const { target, isIntersecting } of entries) {
    const id = MESSAGE_ELEMENT.exec(target.id)?.[1]
    if (id === undefined) continue
    if (isIntersecting) inView.add(id)
    else inView.delete(id)
  }
  clearTimeout(readTimer)
  readTimer = setTimeout(sendRead, READ_AFTER_MS)
}

// Watches the messages on the page that are not watched yet. A browser with no IntersectionObserver marks nothing.
function watchMessages() {
  if (observer === null) {
    if (typeof IntersectionObserver !== 'function') return
    observer = new IntersectionObserver(seen)
  }
  for (const node of root.value.querySelectorAll('.lb-msg')) {
    if (!watched.has(node)) {
      watched.add(node)
      observer.observe(node)
    }
  }
}

function stopReading() {
  clearTimeout(readTimer)
  inView.clear()
  observer?.disconnect()
  observer = null
}

// Messages that arrive (from a poll, an older or newer page, or a jump) are watched once they are on the page.
watch(() => post.value?.messages, watchMessages, { flush: 'post' })

// Polling: one chain of timeouts, not an interval, so that a slow answer is never asked again on top of itself. `session`
// counts the openings of a post; a chain that belongs to an earlier one ends.
let session = 0
let pollTimer = null

function poll(mine) {
  pollTimer = setTimeout(async () => {
    if (document.visibilityState === 'visible') await store.poll(auth.token).catch(() => {})
    if (mine === session) poll(mine)
  }, POLL_MS)
}

// Opens the post: asks the store, takes the reader's mark for the divider, then puts the reader at their place and starts
// watching and polling. Whatever an earlier opening was doing is let go.
async function enter() {
  const mine = ++session
  clearTimeout(pollTimer)
  stopReading()
  phase.value = 'loading'
  notice.value = ''
  // So that a channel mention or a link names a post: a deep link arrives with no topic list. The page does not wait for it.
  if (store.posts.length === 0) store.loadPosts(auth.token).catch(() => {})
  try {
    await store.openPost(auth.token, props.postId)
  } catch (err) {
    phase.value = err?.status === 404 ? 'missing' : 'failed'
    return
  }
  if (mine !== session) return
  if (store.post?.id !== props.postId) {
    phase.value = 'failed'
    return
  }
  snapshot.value = store.post.lastRead
  phase.value = 'ready'
  await nextTick()
  if (mine !== session) return
  watchMessages()
  scrollToStart()
  poll(mine)
}

onMounted(enter)
watch(() => props.postId, enter)
onBeforeUnmount(() => {
  session++
  clearTimeout(pollTimer)
  stopReading()
})

// Loads the page beyond one end of what is held. Older messages go above what the reader is looking at, so the first message
// held is kept where it is on the screen (a browser may have done so already, and then there is nothing to move).
async function more(side) {
  busy[side] = true
  notice.value = ''
  const anchor = root.value.querySelector('.lb-msg')
  const from = anchor?.getBoundingClientRect().top
  try {
    await (side === 'older' ? store.loadOlder(auth.token) : store.loadNewer(auth.token))
  } catch {
    notice.value = COULD_NOT_REACH
    return
  } finally {
    busy[side] = false
  }
  if (!anchor?.isConnected) return
  await nextTick()
  const shift = anchor.getBoundingClientRect().top - from
  if (shift !== 0) window.scrollBy({ top: shift, behavior: 'instant' })
}

// Opens the post around the first instant of a month, never before the post began nor after now: the server answers 400 to
// a date it cannot use. The reader's mark and the divider stay as they were.
async function jump(month) {
  busy.jump = true
  notice.value = ''
  try {
    const began = Date.parse(info.value.createdAt)
    const around = snowflakeAt(new Date(Math.min(Math.max(month.at.getTime(), began), Date.now())))
    await store.openPost(auth.token, props.postId, { around })
    await nextTick()
    const held = messages.value
    const target = held.find((message) => BigInt(message.id) >= BigInt(around)) ?? held[held.length - 1]
    if (target) scrollTo(messageElement(target.id), TO_TOP)
  } catch {
    notice.value = COULD_NOT_REACH
  } finally {
    busy.jump = false
  }
}
</script>

<template>
  <section ref="root" class="lb-post" aria-label="Librarius post">
    <p v-if="phase === 'loading'" class="lb-note" role="status" aria-busy="true">Loading…</p>

    <div v-else-if="phase === 'missing'" class="lb-empty panel-forge">
      <p role="alert">That post couldn't be found.</p>
      <RouterLink class="btn-ghost btn-sm" to="/reliquarium/librarius">Back to the Librarius</RouterLink>
    </div>

    <div v-else-if="phase === 'failed'" class="lb-empty panel-forge">
      <p role="alert">The Librarius couldn't be reached.</p>
      <button type="button" class="btn-ember btn-sm" @click="enter">Retry</button>
    </div>

    <template v-else-if="post">
      <nav class="lb-crumbs" aria-label="Breadcrumb">
        <RouterLink to="/reliquarium">Reliquarium</RouterLink>
        <span aria-hidden="true"> › </span>
        <RouterLink to="/reliquarium/librarius">Librarius</RouterLink>
        <span aria-hidden="true"> › </span>
        <span class="lb-crumb-here" aria-current="page">{{ info.title }}</span>
      </nav>

      <header class="lb-post-head">
        <div class="lb-post-top">
          <h2 class="lb-post-title">{{ info.title }}</h2>
          <a v-if="discord" class="btn-drake btn-sm lb-discord" :href="discord" target="_blank" rel="noopener noreferrer">Open in Discord ↗</a>
        </div>
        <p class="lb-post-meta">
          <span v-for="name in tagNames" :key="name" class="lb-tag">{{ name }}</span>
          {{ replies }}
          <template v-if="started">· started <time :datetime="info.createdAt">{{ started }}</time></template>
        </p>
      </header>

      <div class="lb-post-body">
        <div class="lb-thread">
          <button v-if="post.hasOlder" type="button" class="btn-ghost btn-sm lb-more" :disabled="busy.older" @click="more('older')">Load older</button>

          <template v-for="e in entries" :key="e.message.id">
            <div v-if="divider && divider.id === e.message.id" class="lb-divider"><span class="lb-divider-text">{{ divider.text }}</span></div>
            <LibMessage :message="e.message" :grouped="e.grouped" :article="e.article" :people="store.people" :ctx="ctx" />
          </template>

          <button v-if="post.hasNewer" type="button" class="btn-ghost btn-sm lb-more" :disabled="busy.newer" @click="more('newer')">Load newer</button>
          <p v-if="notice" class="lb-notice" role="alert">{{ notice }}</p>
        </div>

        <nav v-if="months.length" class="lb-rail" aria-label="Jump to a month">
          <button v-for="month in months" :key="month.label" type="button" class="lb-month" :disabled="busy.jump" @click="jump(month)">{{ month.label }}</button>
        </nav>
      </div>
    </template>
  </section>
</template>
