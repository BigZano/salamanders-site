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
//   - The post's opening message is pinned on top, above "Load older", whichever run of messages is held.
//   - The page opens at the message the address names (#m-<id>: a link to a message is where the reader means to be, and the
//     post is opened around it when it is not among the messages held), else at the divider, else at the newest message. Coming
//     Back to a post it opens around the message that was topmost when the reader left (kept in sessionStorage), and scrolls
//     to that, in place of the rest. It scrolls once for each opening, never for what a poll or an older page brings. Loading
//     older messages keeps the reader's place.
//   - A message counts as read when at least 60% of it is in view, or its bottom edge is, below the site's fixed header (see
//     isRead). The newest that counts is reported, two seconds after what is in view last changed, through the store, which
//     never lowers the mark. A failed report, poll or page is dropped quietly or noted: none of them takes the page away. A
//     poll that finds the post gone (deleted in Discord: the server answers 404) does: the page says so, with a way back to the
//     topic list, and asks no more.
//   - A poll draws only what changed: the layout of a message is worked out once for each message object, and people are replaced
//     only when they are named differently. Messages that leave the page (a jump, a deletion) are no longer watched. The rail of
//     months comes before the messages in the page, so a keyboard meets it first, and the focus moves to the first message
//     that came when the button that loaded it goes.
//
// Writing (batch 2). The server's /me says what the reader may do (`can`), and the form replies are checked in (`form`, v2 when
// it says none). The page does nothing the server would refuse, and the server judges every write again:
//   - The composer is docked under the thread, apart from the messages (no .lb-msg in it, so the page never reads it as one), for
//     a member who may reply; a locked post says "This post is locked." in its place, but to a member who manages threads, whom
//     Discord lets reply. It is given the store's writes: a reply, an edit, a picture (held by place; only for a member who may
//     attach, else its 🖼 is unavailable), whether a picture a draft shows is still held, the member search, and the server's own emoji.
//   - Each message offers Reply (the composer replies to it), Quote (the words selected in it, else all of it, go in as a quote,
//     with each mention written as the page names it, and the composer replies to it), Edit (the reader's own replies written on the site: the composer opens with the source)
//     and Delete (the reader's own messages, or any but the post's opening message for a member who manages messages; it asks
//     first). None is offered in a locked post but to a member who manages threads, as the server refuses them there.
//   - What the reader has on its way is the store's `outbox`, asked for when the post opens (what was sent before the page was
//     loaded again shows too): a reply on its way stands under the thread, greyed, with "sending…", until it is in the post; an
//     edit or a delete greys its message. One that the server's rules blocked can be edited or let go, and one that failed tried
//     again or let go. A refusal of any of it is said by the message or the reply it is about.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '../../stores/auth'
import { POLL_MS, useLibrarius } from '../../stores/librarius'
import { listEmoji, searchMembers } from '../../lib/librarius/api'
import { parse } from '../../lib/archive/markdown'
import { asQuote, namedMentions } from '../../lib/librarius/composer'
import { articleMemo, firstUnread, groupMessages, isRead, railMonths, samePeople } from '../../lib/librarius/layout'
import { createRenderCtx } from '../../lib/librarius/render'
import { placeKey } from '../../lib/librarius/places'
import { snowflakeAt } from '../../lib/librarius/snowflake'
import { initials } from '../../lib/rosterAvatar'
import { DEFAULT_FORM, FORMS } from '../../../server/src/librariusForm.js'
import ArchiveMarkdown from '../archive/ArchiveMarkdown'
import Composer from './Composer.vue'
import LibActions from './LibActions.vue'
import LibMessage from './LibMessage.vue'
import './librarius.css'

const READ_AFTER_MS = 2_000
// The observer tells the page at each tenth of a message that comes into view or goes out of it (a message is read from 60%,
// and a long one by its bottom edge: see isRead), and measures from under the site's fixed header.
const READ_THRESHOLDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
const SITE_HEADER = 'header.nav'
const SNOWFLAKE = /^\d{17,20}$/
const MESSAGE_ELEMENT = /^m-(\d{17,20})$/
const MESSAGE_ANCHOR = /^#m-(\d{17,20})$/
// The guild of a reader whose answer from /me names none the page can use: no address names this one, so no link is ours.
const NO_GUILD = '0'.repeat(17)
const COULD_NOT_REACH = 'The Librarius couldn\'t be reached.'
const COPY = {
  locked: 'This post is locked.',
  confirmDelete: 'Delete this message? It goes from Discord too.',
  failed: "Couldn't send. Try again.",
}
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
// loading, ready, missing (no such post), removed (it was there, and Discord has deleted it since) or failed.
const phase = ref('loading')
// `lastRead` as it was when the post opened: where the divider goes, however far the reader has read since.
const snapshot = ref(null)
const notice = ref('')
const busy = reactive({ older: false, newer: false, jump: false })

const post = computed(() => (store.post?.id === props.postId ? store.post : null))
const info = computed(() => post.value?.info ?? null)
const messages = computed(() => post.value?.messages ?? [])
// The post's own first message, pinned on top as an article whatever its length. The store keeps it out of the run.
const opening = computed(() => post.value?.opening ?? null)

// The replies, grouped, each with its own layout. Whether a message is an article is worked out once for each message object, so
// a poll that brings a message reads that one, not all that are held.
const articleOf = articleMemo()
const entries = computed(() => groupMessages(messages.value, articleOf).map(({ message, grouped }) => ({ message, grouped, article: articleOf(message) })))

// Who people are: the store's table, but replaced only when it names someone differently. The store replaces it with every
// answer, and a table that is new but says the same would otherwise draw every message again.
const people = shallowRef(store.people)
watch(
  () => store.people,
  (next) => {
    if (!samePeople(people.value, next)) people.value = next
  },
)
const isHeld = (id) => opening.value?.id === id || messages.value.some((message) => message.id === id)

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
// this post, so that a channel mention or a link to a post names it. A change in the list, or in who people are, makes a new context.
const ctx = computed(() => {
  const me = store.me ?? {}
  const titles = new Map(store.posts.map((p) => [p.id, p.title]))
  if (info.value) titles.set(info.value.id, info.value.title)
  return createRenderCtx({
    guildId: typeof me.guildId === 'string' && SNOWFLAKE.test(me.guildId) ? me.guildId : NO_GUILD,
    postTitles: titles,
    people: people.value,
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

// --- writing ---

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isWords = (value) => typeof value === 'string' && /\S/.test(value)
// What the reader may do, as /me says it: nothing, from a server that says nothing of it.
const can = computed(() => (isObject(store.me?.can) ? store.me.can : {}))
const myId = computed(() => {
  const id = auth.member?.id
  return typeof id === 'string' && SNOWFLAKE.test(id) ? id : null
})
const nameOf = (id) => (Object.hasOwn(people.value, id) ? people.value[id]?.name : undefined)
const myName = computed(() => nameOf(myId.value) || auth.member?.username || '')
// A locked post takes no reply, no edit and no delete but from a member who manages threads.
const lockedOut = computed(() => info.value?.locked === true && can.value.manageThreads !== true)
const writing = computed(() => myId.value !== null && can.value.reply === true && !lockedOut.value)
const form = computed(() => (FORMS.includes(store.me?.form) ? store.me.form : DEFAULT_FORM))
const guildId = computed(() => (typeof store.me?.guildId === 'string' ? store.me.guildId : ''))

const composer = ref(null)
// The message the composer replies to, { id, authorId, authorName }, or null; and the reply it edits, or null.
const replying = ref(null)
const editing = ref(null)
const customEmoji = ref([])
// Why the last thing done to a message (`m:<id>`) or to a reply on its way (`send:<key>`) did not go.
const failures = reactive(new Map())

// The composer's ways to the store and the server, made once, so that it is never drawn again for a new one.
const send = (p) => (p.edit === undefined ? store.reply(auth.token, p) : store.edit(auth.token, p.edit, { source: p.source, mentions: p.mentions }))
// The pictures are held for each draft: the post and the message the composer replies to, as its drafts are kept.
const draftTarget = () => replying.value?.id ?? null
const upload = (file, n) => store.upload(auth.token, file, n, draftTarget())
const holds = (n) => store.holdsPicture(n, draftTarget())
const movePictures = ({ from, to }) => store.movePictures(from, to)
const search = (q) => searchMembers(auth.token, q)
// A reply that is on its way leaves the message it replied to: the next one is to the post, as in Discord.
function onSent() {
  if (editing.value === null) replying.value = null
}

// The server's own emoji, asked for once, when the composer is first shown. Without them the standard ones are still there.
let emojiAsked = false
watch(
  writing,
  (yes) => {
    if (!yes || emojiAsked) return
    emojiAsked = true
    listEmoji(auth.token)
      .then((got) => (customEmoji.value = Array.isArray(got?.emoji) ? got.emoji : []))
      .catch(() => {})
  },
  { immediate: true },
)

const onItsWay = (e) => e?.state === 'sending' || e?.state === 'sent'
// What the reader has on its way for each message held (an edit or a delete, the delete first), and the replies on their way.
const changing = computed(() => {
  const byMessage = new Map()
  for (const e of store.outbox) {
    if (e.kind !== 'send' && (e.kind === 'delete' || !byMessage.has(e.key))) byMessage.set(e.key, e)
  }
  return byMessage
})
const outgoing = computed(() => store.outbox.filter((e) => e.kind === 'send'))
const entryOf = (message) => changing.value.get(message.id) ?? null

// The same list for the same actions, so that a message whose actions have not changed is not drawn again.
const lists = new Map()
function listOf(actions) {
  const key = actions.join(' ')
  if (!lists.has(key)) lists.set(key, Object.freeze(actions))
  return lists.get(key)
}
/** → the actions the reader may take on a message: none while its edit or delete is going. */
function actionsOf(message) {
  if (onItsWay(entryOf(message))) return listOf([])
  const own = myId.value !== null && message.authorId === myId.value
  const actions = []
  if (writing.value) actions.push('reply', 'quote')
  if (writing.value && own && message.origin === 'site' && typeof message.source === 'string') actions.push('edit')
  const deletes = (own && can.value.reply === true) || can.value.manageMessages === true
  if (message.id !== props.postId && !lockedOut.value && deletes) actions.push('delete')
  return listOf(actions)
}

/** → the words a refusal is said in: the server's, or the store's own when it refuses itself, else the page's. */
const copyOf = (err) => ((Number.isInteger(err?.status) && isWords(err.message)) || err instanceof RangeError ? err.message : COPY.failed)
/** Runs a write about `key`, saying why by it when it does not go. */
async function attemptFor(key, write) {
  failures.delete(key)
  try {
    await write()
  } catch (err) {
    failures.set(key, copyOf(err))
  }
}

/** The composer replies to the message, leaving an edit. */
async function answer(message) {
  editing.value = null
  replying.value = { id: message.id, authorId: message.authorId, authorName: nameOf(message.authorId) || message.authorName }
  await nextTick()
  composer.value?.focus()
}
/** → the words of the message the reader has selected, when the selection lies in its text, else null. */
function selectedIn(id) {
  const body = messageElement(id)?.querySelector('.lb-body')
  const selection = document.getSelection()
  if (!body || !selection || selection.isCollapsed || !body.contains(selection.anchorNode) || !body.contains(selection.focusNode)) return null
  return selection.toString()
}
const wordsOf = (message) => (message.origin === 'site' && typeof message.source === 'string' ? message.source : message.content)
// The mentions of the words are written as the page names them: a quote pings nobody, and is not refused for a mention nobody picked.
async function quote(message) {
  const words = selectedIn(message.id) ?? wordsOf(message)
  await answer(message)
  if (isWords(words)) await composer.value?.insert(asQuote(namedMentions(words, (node) => ctx.value.mention(node).label)))
}
/** The composer edits the reader's own reply, from `source`, measured with the message the reply answered. */
async function edit(message, source) {
  const to = message.replyTo
  editing.value = { id: message.id, source, replyTo: to ? { id: to.id, authorId: to.authorId } : null }
  await nextTick()
  composer.value?.focus()
}

// What is pressed on a message: its own actions, and those of its edit or delete that ended.
function onAct(name, message) {
  const key = `m:${message.id}`
  const entry = entryOf(message)
  if (name === 'reply') return answer(message)
  if (name === 'quote') return quote(message)
  if (name === 'edit') return edit(message, message.source)
  if (name === 'delete') return window.confirm(COPY.confirmDelete) ? attemptFor(key, () => store.remove(auth.token, message.id)) : undefined
  if (name === 'retry') return attemptFor(key, () => store.retry(auth.token, entry))
  store.dismiss(entry)
  // A blocked edit opens again with its own words, else the reply's source.
  if (name === 'revise') return edit(message, typeof entry.source === 'string' ? entry.source : message.source)
}
// What is pressed on a reply on its way.
async function onEntry(name, entry) {
  if (name === 'retry') return attemptFor(`send:${entry.key}`, () => store.retry(auth.token, entry))
  store.dismiss(entry)
  if (name !== 'revise') return
  // A blocked reply goes back into the composer, after what it holds, to be changed.
  editing.value = null
  await nextTick()
  if (isWords(entry.source)) await composer.value?.insert(entry.source)
}

// The element of a message on the page, or null (a page that has gone has none).
const messageElement = (id) => root.value?.querySelector(`#m-${id}`) ?? null
// The first message of the run on the page: the opening message is above it, and does not move when older ones are added.
const firstOfRun = () => [...root.value.querySelectorAll('.lb-msg')].find((node) => node.id !== `m-${props.postId}`)
const scrollTo = (target, options) => {
  if (target) target.scrollIntoView(options)
}
const anchorId = () => MESSAGE_ANCHOR.exec(route.hash)?.[1] ?? null

// The reader's place on opening: the message they mean to be at (where they were, coming Back, or the one the address names),
// else the divider, else the newest message. A message that is gone leaves the rest of the order to decide.
function scrollToStart(wanted) {
  const named = wanted === null ? null : messageElement(wanted)
  if (named) return scrollTo(named, TO_TOP)
  const unread = root.value.querySelector('.lb-divider')
  if (unread) return scrollTo(unread, TO_TOP)
  const all = root.value.querySelectorAll('.lb-msg')
  scrollTo(all[all.length - 1], TO_END)
}

// Opens the post again around a message the messages held do not reach. A failure is not the reader's trouble: the page goes
// on with what it has, and the message is simply not there.
async function reach(id) {
  try {
    await store.openPost(auth.token, props.postId, { around: id })
  } catch {
    // The run held stays.
  }
}

// Back keeps the reader's place: where they were is the topmost message in view when they leave, kept for this tab only.
const returning = () => Boolean(window.history.state?.forward)
function savedPlace(postId) {
  try {
    const id = sessionStorage.getItem(placeKey(postId))
    return id !== null && SNOWFLAKE.test(id) ? id : null
  } catch {
    return null
  }
}
function rememberPlace(postId) {
  // A page that is left because the reader signed out keeps nothing: signing out has forgotten every place, and this one is the
  // last reader's too.
  if (!auth.signedIn) return
  try {
    let top = null
    for (const id of inView) {
      if (top === null || BigInt(id) < BigInt(top)) top = id
    }
    if (top === null) sessionStorage.removeItem(placeKey(postId))
    else sessionStorage.setItem(placeKey(postId), top)
  } catch {
    // A browser that keeps nothing keeps nothing: the reader is put at the usual place.
  }
}

// Marking read. Two sets are kept of the messages on the page: those in view at all (the place to go Back to is the topmost of
// them) and those that count as read (see isRead). Two seconds after what the browser last said changed, the newest that count
// is reported. One observer for each opening of a post.
let observer = null
// The message elements the observer watches: those on the page, so that one that leaves is let go.
const watched = new Set()
let readTimer = null
const inView = new Set()
const counted = new Set()

function sendRead() {
  let newest = null
  for (const id of counted) {
    if (newest === null || BigInt(id) > BigInt(newest)) newest = id
  }
  if (newest !== null) store.markRead(auth.token, newest).catch(() => {})
}

const idOfNode = (node) => MESSAGE_ELEMENT.exec(node.id)?.[1]

function seen(entries) {
  for (const entry of entries) {
    const id = watched.has(entry.target) ? idOfNode(entry.target) : undefined
    if (id === undefined) continue
    if (entry.isIntersecting) inView.add(id)
    else inView.delete(id)
    if (isRead(entry)) counted.add(id)
    else counted.delete(id)
  }
  clearTimeout(readTimer)
  readTimer = setTimeout(sendRead, READ_AFTER_MS)
}

// The height of the site's fixed header, which hides the top of the page: nothing under it is in view.
function siteHeaderHeight() {
  const height = document.querySelector(SITE_HEADER)?.getBoundingClientRect().height
  return Number.isFinite(height) && height > 0 ? Math.ceil(height) : 0
}

// Watches the messages on the page that are not watched yet, and lets go of those that have left it (a jump, a deletion), so
// that none is kept in memory, or counted, after it is gone. A browser with no IntersectionObserver marks nothing.
function watchMessages() {
  if (observer === null) {
    if (typeof IntersectionObserver !== 'function') return
    observer = new IntersectionObserver(seen, { rootMargin: `${-siteHeaderHeight()}px 0px 0px 0px`, threshold: READ_THRESHOLDS })
  }
  const present = new Set(root.value.querySelectorAll('.lb-msg'))
  for (const node of watched) {
    if (present.has(node)) continue
    watched.delete(node)
    observer.unobserve(node)
    inView.delete(idOfNode(node))
    counted.delete(idOfNode(node))
  }
  for (const node of present) {
    if (!watched.has(node)) {
      watched.add(node)
      observer.observe(node)
    }
  }
}

function stopReading() {
  clearTimeout(readTimer)
  inView.clear()
  counted.clear()
  watched.clear()
  observer?.disconnect()
  observer = null
}

// Messages that arrive (from a poll, an older or newer page, or a jump) are watched once they are on the page.
watch(() => [post.value?.messages, post.value?.opening], watchMessages, { flush: 'post' })

// Polling: one chain of timeouts, not an interval, so that a slow answer is never asked again on top of itself. `session`
// counts the openings of a post; a chain that belongs to an earlier one ends.
let session = 0
let pollTimer = null

function poll(mine) {
  pollTimer = setTimeout(async () => {
    // The store answers true for a post that Discord has deleted: the page says so, and asks no more about it.
    const removed = document.visibilityState === 'visible' && (await store.poll(auth.token).catch(() => false)) === true
    if (mine !== session) return
    if (removed) {
      stopReading()
      phase.value = 'removed'
      return
    }
    poll(mine)
  }, POLL_MS)
}

// → whether the opening that is `mine` is still the current one and has put the post in the store. A post the store has let go
// (the reader may no longer read it) is a failure.
function landed(mine) {
  if (mine !== session) return false
  if (store.post?.id !== props.postId) {
    phase.value = 'failed'
    return false
  }
  return true
}

// Opens the post: asks the store (around the place the reader left, coming Back), takes the reader's mark for the divider, and
// reaches a message the address names when the run does not; then puts the reader at their place and starts watching and polling.
// Whatever an earlier opening was doing is let go.
async function enter() {
  const mine = ++session
  clearTimeout(pollTimer)
  stopReading()
  phase.value = 'loading'
  notice.value = ''
  // So that a channel mention or a link names a post: a deep link arrives with no topic list. The page does not wait for it.
  if (store.posts.length === 0) store.loadPosts(auth.token).catch(() => {})
  const back = returning() ? savedPlace(props.postId) : null
  try {
    await store.openPost(auth.token, props.postId, { around: back })
  } catch (err) {
    phase.value = err?.status === 404 ? 'missing' : 'failed'
    return
  }
  if (!landed(mine)) return
  // What the reader has on its way here, sent before the page was loaded again too, from a server that takes writes.
  if (isObject(store.me?.can)) store.pending(auth.token).catch(() => {})
  snapshot.value = store.post.lastRead
  const named = back === null ? anchorId() : null
  if (named !== null && !isHeld(named)) {
    await reach(named)
    if (!landed(mine)) return
  }
  phase.value = 'ready'
  await nextTick()
  if (mine !== session) return
  watchMessages()
  scrollToStart(back ?? named)
  poll(mine)
}

onMounted(enter)
watch(
  () => props.postId,
  (_now, before) => {
    if (phase.value === 'ready') rememberPlace(before)
    // The reply and the edit were for the post before.
    replying.value = null
    editing.value = null
    failures.clear()
    enter()
  },
)
onBeforeUnmount(() => {
  if (phase.value === 'ready') rememberPlace(props.postId)
  session++
  clearTimeout(pollTimer)
  stopReading()
})

// A link in this post to one of its messages changes the address while the page is open. A change of post comes with its own
// opening (which sets the phase), so it is left to that. Each step after a wait is for this opening only: a page that was left,
// or a post that was changed, since the link was followed is not scrolled.
watch(
  () => route.hash,
  async () => {
    const id = anchorId()
    if (id === null) return
    const mine = session
    await nextTick()
    if (mine !== session || phase.value !== 'ready') return
    if (!isHeld(id)) {
      await reach(id)
      await nextTick()
      if (mine !== session) return
    }
    scrollTo(messageElement(id), TO_TOP)
  },
)

// Loads the page beyond one end of what is held. Older messages go above what the reader is looking at, so the first message
// of the run is kept where it is on the screen (a browser may have done so already, and then there is nothing to move). When
// the button that was used goes, with the page that it brought, the focus it had would be lost: it moves to the first message
// that came, without moving the page.
async function more(side, event) {
  const mine = session
  const hadFocus = document.activeElement === event?.currentTarget
  const held = new Set(messages.value.map((message) => message.id))
  busy[side] = true
  notice.value = ''
  const anchor = firstOfRun()
  const from = anchor?.getBoundingClientRect().top
  try {
    await (side === 'older' ? store.loadOlder(auth.token) : store.loadNewer(auth.token))
  } catch {
    notice.value = COULD_NOT_REACH
    return
  } finally {
    busy[side] = false
  }
  await nextTick()
  if (mine !== session) return
  if (anchor?.isConnected) {
    const shift = anchor.getBoundingClientRect().top - from
    if (shift !== 0) window.scrollBy({ top: shift, behavior: 'instant' })
  }
  const gone = side === 'older' ? !post.value?.hasOlder : !post.value?.hasNewer
  const first = messages.value.find((message) => !held.has(message.id))
  const target = hadFocus && gone && first ? messageElement(first.id) : null
  if (target) {
    target.tabIndex = -1
    target.focus({ preventScroll: true })
  }
}

// Opens the post around the first instant of a month, never before the post began nor after now: the server answers 400 to
// a date it cannot use. The reader's mark and the divider stay as they were.
async function jump(month) {
  const mine = session
  busy.jump = true
  notice.value = ''
  try {
    const began = Date.parse(info.value.createdAt)
    const around = snowflakeAt(new Date(Math.min(Math.max(month.at.getTime(), began), Date.now())))
    await store.openPost(auth.token, props.postId, { around })
    await nextTick()
    if (mine !== session) return
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

    <div v-else-if="phase === 'removed'" class="lb-empty panel-forge">
      <p role="alert">This post was removed in Discord.</p>
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
        <nav v-if="months.length" class="lb-rail" aria-label="Jump to a month">
          <button v-for="month in months" :key="month.label" type="button" class="lb-month" :disabled="busy.jump" @click="jump(month)">{{ month.label }}</button>
        </nav>

        <div class="lb-thread">
          <LibMessage
            v-if="opening"
            :message="opening"
            :grouped="false"
            article
            :people="people"
            :ctx="ctx"
            :actions="actionsOf(opening)"
            :entry="entryOf(opening)"
            :revisable="writing"
            :action-error="failures.get(`m:${opening.id}`) ?? ''"
            @act="(name) => onAct(name, opening)"
          />
          <button v-if="post.hasOlder" type="button" class="btn-ghost btn-sm lb-more" :disabled="busy.older" @click="more('older', $event)">Load older</button>

          <template v-for="e in entries" :key="e.message.id">
            <div v-if="divider && divider.id === e.message.id" class="lb-divider"><span class="lb-divider-text">{{ divider.text }}</span></div>
            <LibMessage
              :message="e.message"
              :grouped="e.grouped"
              :article="e.article"
              :people="people"
              :ctx="ctx"
              :actions="actionsOf(e.message)"
              :entry="entryOf(e.message)"
              :revisable="writing"
              :action-error="failures.get(`m:${e.message.id}`) ?? ''"
              @act="(name) => onAct(name, e.message)"
            />
          </template>

          <button v-if="post.hasNewer" type="button" class="btn-ghost btn-sm lb-more" :disabled="busy.newer" @click="more('newer', $event)">Load newer</button>

          <article v-for="e in outgoing" :key="e.key" class="lb-outgoing" :class="{ 'lb-pending': onItsWay(e) }" aria-label="Your reply">
            <div class="lb-gutter"><span class="lb-avatar lb-initials" aria-hidden="true">{{ initials(myName) }}</span></div>
            <div class="lb-main">
              <header class="lb-head">
                <span class="lb-name">{{ myName }}</span>
                <span class="lb-site-tag">site</span>
              </header>
              <div v-if="isWords(e.source)" class="lb-body lb-rendered"><ArchiveMarkdown :nodes="parse(e.source, { dialect: 'extended' })" :ctx="ctx" /></div>
              <LibActions :entry="e" :revisable="writing" :error="failures.get(`send:${e.key}`) ?? ''" @act="(name) => onEntry(name, e)" />
            </div>
          </article>
          <p v-if="notice" class="lb-notice" role="alert">{{ notice }}</p>
        </div>
      </div>

      <div v-if="writing || lockedOut" class="lb-dock">
        <Composer
          v-if="writing"
          ref="composer"
          v-model:reply-to="replying"
          v-model:editing="editing"
          :post-id="postId"
          :post-title="info.title"
          :author-id="myId"
          :author-name="myName"
          :guild-id="guildId"
          :ctx="ctx"
          :form="form"
          :on-send="send"
          :search-members="search"
          :custom-emoji="customEmoji"
          :upload="can.attach === true ? upload : null"
          :held="holds"
          @sent="onSent"
          @moved="movePictures"
        />
        <p v-else class="lb-locked" role="status">{{ COPY.locked }}</p>
      </div>
    </template>
  </section>
</template>
