<script>
// Each composer's own ids (its tabs, panels and meter), unique on the page whichever app it is mounted in.
let instances = 0
// The site's address as the server gives it to the "Open On Site" button (librariusHandler.js).
const SITE_URL = 'https://sm2salamanders.site'
</script>

<script setup>
// Where a member writes a reply to a Librarius post (layout A of the design): never a new post, so there is no title or tag.
// The markdown source is on the left, and beside it two tabs: the Preview, drawn by the post page's own renderer
// (ArchiveMarkdown, with the page's context) from the site's extended markdown, and the Discord view, the messages Discord
// will get as librariusForm.js makes them, in the form in use. The toolbar and Ctrl or Cmd with B, I and U change the text
// through apply() (lib/librarius/composer.js), so nobody has to remember the markdown. Ctrl or Cmd with Enter sends, and the focus
// goes back to the text once it is sent.
//
// @ opens the member search (MentionPopover), through the page's `searchMembers`, paced so that typing never runs into the
// server's searches a minute (lib/librarius/requests.js). The member picked goes in as <@id>, and the Preview names them. A
// reply sends as `mentions` the people picked whose mention is still in the text, so one typed in by hand is not (the server
// refuses it); the mentions of a draft count as picked, since they were when it was written. 😀 opens the emoji picker, with
// the standard emoji and the server's own (`customEmoji`, from /librarius/emoji).
//
// Pictures come by 🖼 (the file chooser), or pasted or dropped in. Each is given a place from 1 to 10 that neither the text nor
// another picture on its way holds (one taken out of the text frees its place), and the page's `upload(file, n)` (one try →
// { n, name } or { status, error }) holds it there: 2 at a time at most, tried again a moment later on a 429 or 503, with the
// server's copy shown while it waits, and never again on anything else (a 413 too large, a 400 for one that is no picture
// or took too long to arrive, or a 408), whose copy is shown.
// A picture held goes in as ![name](upload:N) at the selection. A reply holds 10 at most, and cannot be sent while one is on
// its way.
//
// The budget meter is budget() of the same module the server cuts a reply with, given what the server gives it (the form, the
// author, the post's link on the site, the message replied to and a file for each picture), so a reply the meter takes never
// fails in Discord for its length. Reply is disabled while the reply needs more than 3 messages, or is longer than the server
// reads, or cannot be measured at all; and while a picture is inside a spoiler, which the server refuses in the same words.
//
// Drafts are kept in the member's own browser, a second after the last change, under the post and the message replied to
// (draftKey). A draft is kept when the composer closes or the page goes, too, but never for someone who has signed out since.
// Given another message to reply to, the composer opens that one's draft and keeps its own text under the one it was written
// for; when the other has none, the text goes with it, and `moved` ({ from, to }, the messages replied to, null for the post) tells
// the page, whose pictures are held for each draft, to move the text's along. Given another post, it keeps the text with the post it
// was for.
//
// Sending is the page's: the composer calls its `send` listener with { source, replyTo, pingReply, mentions } and waits on what it
// returns. A promise that resolves means the reply is on its way: the text and its draft go, and `sent` passes on what it
// resolved with. One that rejects keeps both, and shows why from the error's `status` and `message` (the server's words) and,
// for an AutoMod refusal (422), its `rule` and `match` ({ start, end } in the source), whose words are selected in the editor.
// A 403 says "You can't reply here right now.", with the server's reason after it.
//
// Editing one of the member's own replies (`editing`, { id, source, replyTo }): the composer opens with the reply's source, says it
// is editing, and sends { source, mentions, edit: id } in its place; the reply that was being written is kept as its draft, and is
// back once the edit ends (sent, or left by Cancel or Escape: `update:editing` null). An edit keeps no draft of its own, and adds
// no pictures: a reply's pictures are fixed once it is sent (the server refuses an edit that moves or changes one). It is measured
// with the line of the message the reply answers, which is the reply's own, as the server measures it.
//
// A draft can show a picture that nothing holds any more (`held(n)` says no: the page was loaded again since it was written, and
// pictures are held in its memory only). The composer says so, keeps the text, and sends nothing until those pictures are taken
// out, so that a reply never names one that is gone. When the server ends the sign-in, or the member signs out, what was typed in
// the last second is kept at once, before the sign-in goes (signing out then takes every draft away). `insert(block)` puts a block
// the page gives (a quote of a message, say) on lines of its own after the selection. Styles are in librarius.css.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import ArchiveMarkdown from '../archive/ArchiveMarkdown'
import EmojiPicker from './EmojiPicker.vue'
import MentionPopover from './MentionPopover.vue'
import { parse, walk } from '../../lib/archive/markdown'
import { apply, clearDraft, draftStorage, insertBlock, loadDraft, saveDraft } from '../../lib/librarius/composer'
import { createUploadQueue, paced } from '../../lib/librarius/requests'
import { DEFAULT_FORM, MAX_PARTS, PICTURE_IN_SPOILER, budget, pictureInSpoiler, toDiscord } from '../../../server/src/librariusForm.js'
import { useAuth } from '../../stores/auth'
import './librarius.css'

const DRAFT_MS = 1_000
// The longest source the server reads (librariusSend.js MAX_SOURCE): a longer one is refused before it is looked at.
const MAX_SOURCE = 16_000
// The kinds of Discord component that a part of the V2 form is made of (librariusForm.js); the action row of the button is the rest.
const TEXT_DISPLAY = 10
const MEDIA_GALLERY = 12
const SEPARATOR = 14
const SHORTCUTS = new Map([['b', 'bold'], ['i', 'italic'], ['u', 'underline']])
// The pictures a reply may hold (librariusSend.js MAX_UPLOADS), and the kinds of file the server takes.
const MAX_PICTURES = 10
const PICTURE_TYPES = 'image/png,image/jpeg,image/webp,image/gif'

const COPY = {
  forbidden: "You can't reply here right now.",
  slow: "You're replying too fast. Wait a moment and try again.",
  failed: "Couldn't send. Try again.",
  blocked: (rule) => `Blocked by the server's AutoMod rule "${rule}".`,
  over: "That's longer than Discord can carry in 3 messages.",
  tooManyPictures: 'A reply can hold 10 pictures at most.',
  pictureFailed: "Couldn't add that picture. Try again.",
  retrying: 'Trying again in a moment.',
  adding: (n) => `Adding ${n} ${n === 1 ? 'picture' : 'pictures'}…`,
  deadPictures: 'Pictures from before the reload need adding again.',
}

// The toolbar, in groups, in the order of the design: what each button shows, its accessible name, and the action it applies.
// The three with `opens` open the file chooser, the member search or the emoji picker, and insert what comes from them.
const TOOLS = [
  [
    { action: 'h1', face: 'H1', name: 'Heading 1' },
    { action: 'h2', face: 'H2', name: 'Heading 2' },
    { action: 'h3', face: 'H3', name: 'Heading 3' },
  ],
  [
    { action: 'bold', face: 'B', name: 'Bold', keys: 'Control+B' },
    { action: 'italic', face: 'I', name: 'Italic', keys: 'Control+I' },
    { action: 'underline', face: 'U', name: 'Underline', keys: 'Control+U' },
    { action: 'strike', face: 'S', name: 'Strikethrough' },
    { action: 'spoiler', face: 'spoiler', name: 'Spoiler' },
  ],
  [
    { action: 'quote', face: '❝', name: 'Quote' },
    { action: 'code', face: '{}', name: 'Code' },
    { action: 'bullet', face: '•', name: 'Bulleted list' },
    { action: 'numbered', face: '1.', name: 'Numbered list' },
  ],
  [
    { action: 'link', face: '🔗', name: 'Link' },
    { action: 'image', face: '🖼', name: 'Add a picture', opens: 'picture' },
    { action: 'table', face: '▦', name: 'Table' },
    { action: 'rule', face: '―', name: 'Divider' },
    { action: 'mention', face: '@', name: 'Mention someone', opens: 'mention' },
    { action: 'emoji', face: '😀', name: 'Emoji', opens: 'emoji' },
  ],
  [{ action: 'subtext', face: '-#', name: 'Small text' }],
].map((group, g, all) => group.map((tool, i) => ({ ...tool, at: all.slice(0, g).reduce((n, before) => n + before.length, 0) + i })))
const TOOL_COUNT = TOOLS.flat().length

const TABS = [
  { name: 'preview', label: 'Preview' },
  { name: 'discord', label: 'Discord view' },
]

const props = defineProps({
  // The post replied in, by its id, and its title.
  postId: { type: String, required: true },
  postTitle: { type: String, default: '' },
  // The member writing, by their id, and the name the reply goes under.
  authorId: { type: String, required: true },
  authorName: { type: String, default: '' },
  // The guild the Librarius is in: the link of the message replied to is in it.
  guildId: { type: String, required: true },
  // What ArchiveMarkdown renders with (render.js createRenderCtx): the post page's own.
  ctx: { type: Object, required: true },
  // The message replied to, { id, authorId, authorName }, or null for a reply to the post.
  replyTo: { type: Object, default: null },
  // The Discord form in use ('v2' or 'plain'), and the site's address, as the server has them.
  form: { type: String, default: DEFAULT_FORM },
  siteUrl: { type: String, default: SITE_URL },
  // The page's `send` listener: (reply) → a promise, resolved once the reply is queued, rejected with why it was not.
  onSend: { type: Function, required: true },
  // The member search for a mention: (q) → a promise of [{ id, name, avatar }] (/librarius/members). None, no mentions.
  searchMembers: { type: Function, default: null },
  // The server's own emoji, [{ id, name, animated }] (/librarius/emoji).
  customEmoji: { type: Array, default: () => [] },
  // One try at holding a picture at place n: (file, n) → a promise of { n, name } or { status, error }. None, no pictures.
  upload: { type: Function, default: null },
  // Whether place n holds a picture that a reply would carry: (n) → boolean. None, no question is asked.
  held: { type: Function, default: null },
  // The member's own reply being edited, { id, source, replyTo: { id, authorId } | null }, or null for a new reply.
  editing: { type: Object, default: null },
})
const emit = defineEmits(['update:replyTo', 'update:editing', 'sent', 'moved'])

const auth = useAuth()
const uid = `lb-composer-${++instances}`
const area = ref(null)
const toolbar = ref(null)
const files = ref(null)
const popoverBox = ref(null)
const replyId = computed(() => props.replyTo?.id ?? null)
const replyName = computed(() => props.replyTo?.authorName || 'unknown member')
// The people picked for a mention, by id → the name the search gave them (null for one a draft held).
const picked = reactive(new Map())
// The reply being written, kept aside while an edit is open, else null.
let aside = null
const draft = loadDraft(draftStorage(), props.postId, replyId.value) ?? ''
const text = ref(draft)
if (props.editing !== null) {
  aside = draft
  text.value = props.editing.source
}
remember(text.value)
const tab = ref('preview')
const full = ref(false)
const ping = ref(true)
const sending = ref(false)
// { text, match }: why the last try was refused, and the words AutoMod matched, or null.
const failure = ref(null)
const saved = ref(false)
// The toolbar button that holds the toolbar's one tab stop.
const toolStop = ref(0)

const blank = computed(() => !/\S/.test(text.value))
const nodes = computed(() => parse(text.value, { dialect: 'extended' }))

// The pictures the source holds, each with the file name the server measures it with (librariusSend.js), by its number.
const images = computed(() => {
  const refs = new Set()
  walk(nodes.value, (node) => {
    if (node.type === 'image') refs.add(node.ref)
  })
  return [...refs].map((ref) => ({ ref, name: `image-${ref}.png` }))
})
// The people the text mentions, by id, each once, in the order they come.
const mentioned = computed(() => {
  const ids = []
  walk(nodes.value, (node) => {
    if (node.type === 'mention' && node.kind === 'user' && !ids.includes(node.id)) ids.push(node.id)
  })
  return ids
})
// The page's context, naming each member picked for a mention as the search did.
const previewCtx = computed(() => ({
  ...props.ctx,
  mention(node) {
    const name = node.kind === 'user' ? picked.get(node.id) : undefined
    return typeof name === 'string' ? { label: `@${name}`, color: null } : props.ctx.mention(node)
  },
}))
const pictureOf = (name) => `Picture ${images.value.find((image) => image.name === name).ref}`

// What the server gives the form for this reply (librariusWrites.js): the same author, links and pictures, so the same cuts. An
// edit answers the message its reply answered.
const answering = computed(() => (props.editing === null ? props.replyTo : props.editing.replyTo))
const formOptions = computed(() => ({
  form: props.form,
  authorId: props.authorId,
  siteUrl: `${props.siteUrl}/reliquarium/librarius/${props.postId}`,
  replyTo: answering.value === null ? null : { authorId: answering.value.authorId, url: `https://discord.com/channels/${props.guildId}/${props.postId}/${answering.value.id}` },
  images: images.value,
}))

// The meter, or null when the reply cannot be measured (options the form refuses): then nothing can be sent.
const measured = computed(() => {
  try {
    return budget(text.value, formOptions.value)
  } catch {
    return null
  }
})
const over = computed(() => measured.value !== null && (measured.value.parts > MAX_PARTS || text.value.length > MAX_SOURCE))
const budgetText = computed(() => {
  const { used, limit, parts } = measured.value
  const words = [`${used.toLocaleString('en')} / ${limit.toLocaleString('en')}`, `${parts} Discord ${parts === 1 ? 'message' : 'messages'}`]
  const pictures = images.value.length
  if (pictures > 0) words.push(`${pictures} ${pictures === 1 ? 'picture' : 'pictures'}`)
  return words.join(' · ')
})
// Whether the text shows a picture that nothing holds now (the page was loaded again since it was written). An edit's are its own.
const dead = computed(() => props.editing === null && props.held !== null && images.value.some(({ ref }) => !props.held(ref)))
// Whether a picture is inside a spoiler: the site hides it and Discord would not, so the server refuses the reply (and an edit).
const spoiled = computed(() => pictureInSpoiler(nodes.value))
const canSend = computed(() => !sending.value && !blank.value && measured.value !== null && !over.value && uploading.value === 0 && !dead.value && !spoiled.value)

// The Discord view: each message as its blocks, worked out only while the tab is shown.
const discord = computed(() => {
  if (tab.value !== 'discord') return null
  try {
    const { parts } = toDiscord(text.value, formOptions.value)
    return parts.map((part) => ({
      blocks: part.components === null ? [{ kind: 'text', nodes: parse(part.text) }] : part.components[0].components.flatMap(blocksOf),
      files: part.components === null ? part.files.map(pictureOf) : [],
    }))
  } catch {
    return null
  }
})
function blocksOf(component) {
  if (component.type === TEXT_DISPLAY) return [{ kind: 'text', nodes: parse(component.content) }]
  if (component.type === MEDIA_GALLERY) return component.items.map((item) => ({ kind: 'picture', label: pictureOf(item.media.url.slice('attachment://'.length)) }))
  if (component.type === SEPARATOR) return [{ kind: 'separator' }]
  return [{ kind: 'button', label: component.components[0].label }]
}

// --- editing ---

// Applies a toolbar action, or one the page gives ({ type: 'mention', id } and the like), at the selection, and selects what
// apply() says a person would type over next. One at a time: two pictures held at once must each see the other's text.
let acting = Promise.resolve()
function inTurn(change) {
  const run = acting.then(() => changeAt(change))
  acting = run.catch(() => {})
  return run
}
const act = (action) => inTurn((value, selection) => apply(value, selection, action))
// A block the page gives (insertBlock): on lines of its own after the selection.
const insert = (md) => inTurn((value, selection) => insertBlock(value, selection, md))
async function changeAt(change) {
  if (sending.value) return
  const el = area.value
  const result = change(el.value, { start: el.selectionStart, end: el.selectionEnd })
  text.value = result.text
  await nextTick()
  el.focus()
  el.setSelectionRange(result.selection.start, result.selection.end)
}

// Whether a button that opens something can: the page gave what it needs, and an edit takes no pictures.
const unavailable = (tool) => (tool.opens === 'mention' && props.searchMembers === null) || (tool.opens === 'picture' && !canTakePictures())

function press(tool) {
  if (unavailable(tool)) return
  if (tool.opens === 'picture') files.value.click()
  else if (tool.opens) popover.value = popover.value === tool.opens ? null : tool.opens
  else act(tool.action)
}

// --- mentions and emoji ---

// The popover open under the toolbar: 'mention', 'emoji' or null.
const popover = ref(null)
const search = paced((q) => props.searchMembers(q))

/** Takes the people a text mentions as picked, for a draft that is opened: they were picked when it was written. */
function remember(source) {
  walk(parse(source, { dialect: 'extended' }), (node) => {
    if (node.type === 'mention' && node.kind === 'user' && !picked.has(node.id)) picked.set(node.id, null)
  })
}
function mentionPicked({ id, name }) {
  picked.set(id, name)
  popover.value = null
  act({ type: 'mention', id })
}
function emojiPicked(emojiText) {
  popover.value = null
  act({ type: 'emoji', text: emojiText })
}
function closePopover() {
  popover.value = null
  area.value.focus()
}
// A press anywhere but the popover and the toolbar (whose buttons open and close it themselves) closes it.
function onPressOutside(event) {
  if (popover.value === null || popoverBox.value?.contains(event.target) || toolbar.value.contains(event.target)) return
  popover.value = null
}

// --- pictures ---

const reserved = reactive(new Set())
const uploading = ref(0)
// The server's copy while a picture waits to be tried again, and why the last one could not be added.
const retryCopy = ref(null)
const pictureAlert = ref(null)
const queue = createUploadQueue({ upload: (file, n) => props.upload(file, n), onRetry: ({ error }) => (retryCopy.value = error) })
const uploadingText = computed(() => (retryCopy.value === null ? COPY.adding(uploading.value) : `${retryCopy.value} ${COPY.retrying}`))
const canTakePictures = () => !sending.value && props.upload !== null && props.editing === null

/** → the first place from 1 to 10 that neither the text nor a picture on its way holds, or null. */
function freePlace() {
  const taken = new Set([...images.value.map((image) => image.ref), ...reserved])
  for (let n = 1; n <= MAX_PICTURES; n++) if (!taken.has(n)) return n
  return null
}

/** Sends the files to be held, each at a free place, as far as there are places. → whether it took them. */
function addPictures(list) {
  if (!canTakePictures() || list.length === 0) return false
  pictureAlert.value = null
  for (const file of list) {
    const n = freePlace()
    if (n === null) {
      pictureAlert.value = COPY.tooManyPictures
      break
    }
    reserved.add(n)
    uploading.value++
    queue.add(file, n).then((outcome) => placed(n, outcome))
  }
  return true
}
function placed(n, outcome) {
  reserved.delete(n)
  uploading.value--
  retryCopy.value = null
  if (outcome.stopped) return
  if (outcome.ok) act({ type: 'image', name: outcome.name, n: outcome.n })
  else pictureAlert.value = outcome.error ?? COPY.pictureFailed
}

function onChoose(event) {
  addPictures([...event.target.files])
  event.target.value = ''
}
function onPaste(event) {
  if (addPictures([...(event.clipboardData?.files ?? [])])) event.preventDefault()
}
function onDragOver(event) {
  if (canTakePictures() && [...(event.dataTransfer?.types ?? [])].includes('Files')) event.preventDefault()
}
function onDrop(event) {
  if (addPictures([...(event.dataTransfer?.files ?? [])])) event.preventDefault()
}

function onKey(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
  // Ctrl or Cmd with Enter sends, as the Reply button does (and does nothing when it could not).
  if (event.key === 'Enter') {
    event.preventDefault()
    send()
    return
  }
  const action = SHORTCUTS.get(event.key.toLowerCase())
  if (action === undefined) return
  event.preventDefault()
  act(action)
}

// The toolbar is one tab stop: the arrow keys, Home and End move along it, round from one end to the other.
function moveInToolbar(event) {
  const buttons = [...event.currentTarget.querySelectorAll('button')]
  const at = buttons.indexOf(event.target)
  let next
  switch (event.key) {
    case 'ArrowRight': next = (at + 1) % TOOL_COUNT; break
    case 'ArrowLeft': next = (at - 1 + TOOL_COUNT) % TOOL_COUNT; break
    case 'Home': next = 0; break
    case 'End': next = TOOL_COUNT - 1; break
    default: return
  }
  event.preventDefault()
  toolStop.value = next
  buttons[next].focus()
}

// The tabs, as tabs are: the arrow keys, Home and End select one and move to it.
function moveInTabs(event, at) {
  let next
  switch (event.key) {
    case 'ArrowRight': next = (at + 1) % TABS.length; break
    case 'ArrowLeft': next = (at - 1 + TABS.length) % TABS.length; break
    case 'Home': next = 0; break
    case 'End': next = TABS.length - 1; break
    default: return
  }
  event.preventDefault()
  tab.value = TABS[next].name
  event.currentTarget.parentElement.children[next].focus()
}
const tabId = (name) => `${uid}-tab-${name}`
const panelId = (name) => `${uid}-panel-${name}`

// --- drafts ---

let saveTimer = null

/** Keeps the text as the draft of a post and message (by default, the ones it is for now), for a member who is signed in. → whether it was kept. */
function keep(postId = props.postId, reply = replyId.value) {
  clearTimeout(saveTimer)
  saveTimer = null
  return auth.signedIn && saveDraft(draftStorage(), postId, reply, text.value)
}
const flush = () => {
  if (saveTimer !== null) keep()
}

watch(text, () => {
  saved.value = false
  failure.value = null
  clearTimeout(saveTimer)
  saveTimer = null
  // An edit keeps no draft: the draft of the post and message is the reply that was being written.
  if (props.editing === null) saveTimer = setTimeout(() => (saved.value = keep()), DRAFT_MS)
})

// An edit opens with its reply's source; the reply that was being written is kept (its last second too) and comes back after.
watch(
  () => props.editing,
  (now, before) => {
    if (before === null) {
      keep()
      aside = text.value
    }
    text.value = now === null ? aside : now.source
    if (now === null) aside = null
    remember(text.value)
  },
)
const leaveEdit = () => {
  if (!sending.value) emit('update:editing', null)
}
// Going full screen, or back, moves the composer (see the template), and a moved element loses the focus: it goes to the text.
async function setFull(on) {
  full.value = on
  await nextTick()
  area.value?.focus()
}
// Escape leaves full screen first, then an edit.
function onEscape() {
  if (full.value) setFull(false)
  else if (props.editing !== null) leaveEdit()
}

// What was typed in the last second is kept before the sign-in goes, whoever ends it.
const stopWatchingAuth = auth.$onAction(({ name }) => {
  if (name === 'expire' || name === 'signOut') flush()
})

watch([() => props.postId, replyId], ([post, reply], [oldPost, oldReply]) => {
  ping.value = true
  const storage = draftStorage()
  const there = loadDraft(storage, post, reply)
  if (there !== null || post !== oldPost) {
    // The text stays the draft of what it was written for, and the other's draft, or nothing, is opened.
    keep(oldPost, oldReply)
    text.value = there ?? ''
    remember(text.value)
  } else {
    // The text goes with the composer to the message it now replies to, and so do the pictures held for it (`moved`).
    if (auth.signedIn) {
      clearTimeout(saveTimer)
      saveTimer = null
      clearDraft(storage, oldPost, oldReply)
      saveDraft(storage, post, reply, text.value)
    }
    emit('moved', { from: oldReply, to: reply })
  }
})

onMounted(() => {
  window.addEventListener('pagehide', flush)
  document.addEventListener('mousedown', onPressOutside)
})
onBeforeUnmount(() => {
  stopWatchingAuth()
  window.removeEventListener('pagehide', flush)
  document.removeEventListener('mousedown', onPressOutside)
  queue.stop()
  flush()
})

// --- sending ---

const isWords = (value) => typeof value === 'string' && /\S/.test(value)

/** → the AutoMod match when it is a range of the source with something in it, else null. */
function matchOf(match, source) {
  if (typeof match !== 'object' || match === null) return null
  const { start, end } = match
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= source.length ? { start, end } : null
}

/** → { text, match } for a refused try: the server's words when it answered with some, else the composer's own. */
function failureOf(err, source) {
  const status = err?.status
  const said = Number.isInteger(status) && isWords(err.message) ? err.message : null
  if (status === 403) return { text: said === null ? COPY.forbidden : `${COPY.forbidden} ${said}`, match: null }
  if (status === 422 && isWords(err.rule)) return { text: said ?? COPY.blocked(err.rule), match: matchOf(err.match, source) }
  if (status === 429) return { text: said ?? COPY.slow, match: null }
  return { text: said ?? COPY.failed, match: null }
}

async function send() {
  if (!canSend.value) return
  const source = text.value
  // What it is sent to: the member may press Reply on another message, or ✕, while it is on its way.
  const post = props.postId
  const reply = replyId.value
  sending.value = true
  failure.value = null
  let answer
  const edit = props.editing?.id ?? null
  try {
    const mentions = mentioned.value.filter((id) => picked.has(id))
    answer = await props.onSend(edit === null ? { source, replyTo: replyId.value, pingReply: replyId.value !== null && ping.value, mentions } : { source, mentions, edit })
  } catch (err) {
    sending.value = false
    failure.value = failureOf(err, source)
    const match = failure.value.match
    if (match !== null) {
      await nextTick()
      area.value.focus()
      area.value.setSelectionRange(match.start, match.end)
    }
    return
  }
  sending.value = false
  if (edit !== null) {
    // The reply that was being written comes back once the page leaves the edit.
    emit('sent', answer)
    emit('update:editing', null)
  } else {
    // The draft of what it was sent to goes. The text goes only if it is what was sent: moved to another message meanwhile, the
    // composer shows that one's draft, which stays (the sent words went with it, as the draft of the first, and go now).
    const storage = draftStorage()
    clearDraft(storage, post, reply)
    if (text.value === source) {
      clearDraft(storage, props.postId, replyId.value)
      text.value = ''
    }
    emit('sent', answer)
  }
  // The button that sent it is disabled now, and would leave the focus to the page.
  await nextTick()
  area.value?.focus()
}

defineExpose({ act, insert, focus: () => area.value.focus() })
</script>

<template>
  <!-- Full screen, it is teleported to <body>: the route's root is its own stacking context (the route fade), so inside it the composer
       would open under the site's sticky header, which hides its top bar (Lightbox.vue does the same). It keeps its state. -->
  <div class="lb-composer-host">
  <Teleport to="body" :disabled="!full">
  <section class="lb-composer" :class="{ 'lb-composer-full': full }" aria-label="Reply composer" @keydown.esc="onEscape">
    <div class="lb-composer-head">
      <p class="lb-composer-where">Replying in: <b>{{ postTitle }}</b></p>
      <div v-if="editing" class="lb-editing">
        <span class="lb-editing-text">✎ Editing your reply</span>
        <button type="button" class="lb-unedit" :disabled="sending" @click="leaveEdit">Cancel</button>
      </div>
      <div v-else-if="replyTo" class="lb-replying-to">
        <span class="lb-replying-text">↪ replying to <b>{{ replyName }}</b></span>
        <button type="button" class="lb-ping" :aria-label="`Ping ${replyName}`" :aria-pressed="String(ping)" @click="ping = !ping">@ {{ ping ? 'on' : 'off' }}</button>
        <button type="button" class="lb-unreply" :aria-label="`Stop replying to ${replyName}`" @click="emit('update:replyTo', null)"><span aria-hidden="true">✕</span></button>
      </div>
      <button type="button" class="btn-ghost btn-sm lb-full" :aria-pressed="String(full)" @click="setFull(!full)">Full screen</button>
    </div>

    <div ref="toolbar" class="lb-toolbar" role="toolbar" aria-label="Formatting" @keydown="moveInToolbar">
      <div v-for="(group, g) in TOOLS" :key="g" class="lb-tools" role="group">
        <button
          v-for="tool in group"
          :key="tool.action"
          type="button"
          class="lb-tool"
          :aria-label="tool.name"
          :aria-keyshortcuts="tool.keys"
          :title="tool.keys ? `${tool.name} (${tool.keys.replace('Control', 'Ctrl')})` : tool.name"
          :tabindex="tool.at === toolStop ? 0 : -1"
          :disabled="sending"
          :aria-disabled="unavailable(tool) ? 'true' : undefined"
          :aria-haspopup="tool.opens === 'mention' || tool.opens === 'emoji' ? 'dialog' : undefined"
          :aria-expanded="tool.opens === 'mention' || tool.opens === 'emoji' ? String(popover === tool.opens) : undefined"
          @focus="toolStop = tool.at"
          @mousedown.prevent
          @click="press(tool)"
        >
          <span aria-hidden="true">{{ tool.face }}</span>
        </button>
      </div>
    </div>

    <div v-if="popover" ref="popoverBox" class="lb-popover">
      <MentionPopover v-if="popover === 'mention'" :search="search" @pick="mentionPicked" @close="closePopover" />
      <EmojiPicker v-else :custom="customEmoji" @pick="emojiPicked" @close="closePopover" />
    </div>
    <input ref="files" type="file" class="lb-file-input" :accept="PICTURE_TYPES" multiple hidden @change="onChoose" />

    <div class="lb-compose-body" @dragover="onDragOver" @drop="onDrop">
      <textarea
        ref="area"
        v-model="text"
        class="lb-source"
        aria-label="Your reply, in markdown"
        :aria-describedby="`${uid}-budget`"
        :placeholder="`Reply to ${postTitle}…`"
        :readonly="sending"
        rows="8"
        @keydown="onKey"
        @paste="onPaste"
      />

      <div class="lb-pane">
        <div class="lb-tabs" role="tablist" aria-label="Show the reply as">
          <button
            v-for="(t, i) in TABS"
            :id="tabId(t.name)"
            :key="t.name"
            type="button"
            class="lb-tab"
            role="tab"
            :aria-selected="String(tab === t.name)"
            :aria-controls="tab === t.name ? panelId(t.name) : undefined"
            :tabindex="tab === t.name ? 0 : -1"
            @click="tab = t.name"
            @keydown="moveInTabs($event, i)"
          >
            {{ t.label }}
          </button>
        </div>

        <div :id="panelId(tab)" class="lb-tabpanel" role="tabpanel" :aria-labelledby="tabId(tab)" tabindex="0">
          <p v-if="blank" class="lb-pane-note">Nothing to preview yet.</p>
          <div v-else-if="tab === 'preview'" class="lb-body lb-rendered"><ArchiveMarkdown :nodes="nodes" :ctx="previewCtx" /></div>
          <p v-else-if="discord === null" class="lb-pane-note">This reply can't be measured just now.</p>
          <template v-else>
            <p v-if="discord.length > MAX_PARTS" class="lb-dv-over">This needs {{ discord.length }} Discord messages, and a reply may have {{ MAX_PARTS }} at most.</p>
            <ol class="lb-dv-parts">
              <li v-for="(part, k) in discord" :key="k" class="lb-dv-part">
                <p class="lb-dv-head">Message {{ k + 1 }} of {{ discord.length }}</p>
                <template v-for="(block, b) in part.blocks" :key="b">
                  <div v-if="block.kind === 'text'" class="lb-dv-block lb-dv-text lb-body lb-rendered"><ArchiveMarkdown :nodes="block.nodes" :ctx="previewCtx" /></div>
                  <p v-else-if="block.kind === 'picture'" class="lb-dv-block lb-dv-picture">{{ block.label }}</p>
                  <hr v-else-if="block.kind === 'separator'" class="lb-dv-block lb-dv-separator" />
                  <p v-else class="lb-dv-block lb-dv-button"><span class="lb-dv-button-face">{{ block.label }}</span></p>
                </template>
                <p v-if="part.files.length" class="lb-dv-files">Attached: {{ part.files.join(', ') }}</p>
              </li>
            </ol>
          </template>
        </div>
      </div>
    </div>

    <p v-if="uploading > 0" class="lb-uploading" role="status">{{ uploadingText }}</p>
    <p v-if="dead" class="lb-dead-pictures" role="status">{{ COPY.deadPictures }}</p>
    <p v-if="spoiled" class="lb-spoiled-picture" role="status">{{ PICTURE_IN_SPOILER }}</p>
    <p v-if="pictureAlert" class="lb-composer-error" role="alert">{{ pictureAlert }}</p>
    <p v-if="failure" class="lb-composer-error" role="alert">{{ failure.text }}<template v-if="failure.match"> The words it matched are selected in your reply.</template></p>

    <div class="lb-composer-foot">
      <p class="lb-posting-as">Posting as {{ authorName || 'you' }} (your server name and picture)</p>
      <span v-if="saved && !blank" class="lb-draft-saved">Draft saved</span>
      <div :id="`${uid}-budget`" class="lb-budget" :class="{ 'lb-over': over }">
        <template v-if="measured">
          <meter class="lb-meter" min="0" :max.attr="measured.limit" :value.attr="measured.used" aria-label="Length of the reply" />
          <span class="lb-budget-text">{{ budgetText }}</span>
        </template>
        <span v-if="over" class="lb-budget-over">{{ COPY.over }}</span>
      </div>
      <p v-if="sending" class="lb-sending" role="status">Sending…</p>
      <button type="button" class="btn-ember btn-sm lb-send" :disabled="!canSend" @click="send">{{ editing ? 'Save edit' : 'Reply' }}</button>
    </div>
  </section>
  </Teleport>
  </div>
</template>
