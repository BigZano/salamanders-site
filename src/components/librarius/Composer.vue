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
// through apply() (lib/librarius/composer.js), so nobody has to remember the markdown. Picture, mention and emoji only tell the
// page they were pressed for now; what they insert comes back through act().
//
// The budget meter is budget() of the same module the server cuts a reply with, given what the server gives it (the form, the
// author, the post's link on the site, the message replied to and a file for each picture), so a reply the meter takes never
// fails in Discord for its length. Reply is disabled while the reply needs more than 3 messages, or is longer than the server
// reads, or cannot be measured at all.
//
// Drafts are kept in the member's own browser, a second after the last change, under the post and the message replied to
// (draftKey). A draft is kept when the composer closes or the page goes, too, but never for someone who has signed out since.
// Given another message to reply to, the composer opens that one's draft and keeps its own text under the one it was written
// for; when the other has none, the text goes with it. Given another post, it keeps the text with the post it was for.
//
// Sending is the page's: the composer calls its `send` listener with { source, replyTo, pingReply } and waits on what it
// returns. A promise that resolves means the reply is on its way: the text and its draft go, and `sent` passes on what it
// resolved with. One that rejects keeps both, and shows why from the error's `status` and `message` (the server's words) and,
// for an AutoMod refusal (422), its `rule` and `match` ({ start, end } in the source), whose words are selected in the editor.
// A 403 says "You can't reply here right now.", with the server's reason after it. Styles are in librarius.css.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ArchiveMarkdown from '../archive/ArchiveMarkdown'
import { parse, walk } from '../../lib/archive/markdown'
import { apply, clearDraft, draftStorage, loadDraft, saveDraft } from '../../lib/librarius/composer'
import { DEFAULT_FORM, MAX_PARTS, budget, toDiscord } from '../../../server/src/librariusForm.js'
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

const COPY = {
  forbidden: "You can't reply here right now.",
  slow: "You're replying too fast. Wait a moment and try again.",
  failed: "Couldn't send. Try again.",
  blocked: (rule) => `Blocked by the server's AutoMod rule "${rule}".`,
  over: "That's longer than Discord can carry in 3 messages.",
}

// The toolbar, in groups, in the order of the design: what each button shows, its accessible name, and the action it applies.
// The three with `stub` tell the page they were pressed, by that event.
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
    { action: 'image', face: '🖼', name: 'Add a picture', stub: 'picture' },
    { action: 'table', face: '▦', name: 'Table' },
    { action: 'rule', face: '―', name: 'Divider' },
    { action: 'mention', face: '@', name: 'Mention someone', stub: 'mention' },
    { action: 'emoji', face: '😀', name: 'Emoji', stub: 'emoji' },
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
})
const emit = defineEmits(['update:replyTo', 'sent', 'picture', 'mention', 'emoji'])

const auth = useAuth()
const uid = `lb-composer-${++instances}`
const area = ref(null)
const replyId = computed(() => props.replyTo?.id ?? null)
const replyName = computed(() => props.replyTo?.authorName || 'unknown member')
const text = ref(loadDraft(draftStorage(), props.postId, replyId.value) ?? '')
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
const pictureOf = (name) => `Picture ${images.value.find((image) => image.name === name).ref}`

// What the server gives the form for this reply (librariusWrites.js): the same author, links and pictures, so the same cuts.
const formOptions = computed(() => ({
  form: props.form,
  authorId: props.authorId,
  siteUrl: `${props.siteUrl}/reliquarium/librarius/${props.postId}`,
  replyTo: props.replyTo === null ? null : { authorId: props.replyTo.authorId, url: `https://discord.com/channels/${props.guildId}/${props.postId}/${props.replyTo.id}` },
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
const canSend = computed(() => !sending.value && !blank.value && measured.value !== null && !over.value)

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
// apply() says a person would type over next.
async function act(action) {
  if (sending.value) return
  const el = area.value
  const result = apply(el.value, { start: el.selectionStart, end: el.selectionEnd }, action)
  text.value = result.text
  await nextTick()
  el.focus()
  el.setSelectionRange(result.selection.start, result.selection.end)
}

function press(tool) {
  if (tool.stub) emit(tool.stub)
  else act(tool.action)
}

function onKey(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
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
  saveTimer = setTimeout(() => (saved.value = keep()), DRAFT_MS)
})

watch([() => props.postId, replyId], ([post, reply], [oldPost, oldReply]) => {
  ping.value = true
  const storage = draftStorage()
  const there = loadDraft(storage, post, reply)
  if (there !== null || post !== oldPost) {
    // The text stays the draft of what it was written for, and the other's draft, or nothing, is opened.
    keep(oldPost, oldReply)
    text.value = there ?? ''
  } else if (auth.signedIn) {
    // The text goes with the composer to the message it now replies to.
    clearTimeout(saveTimer)
    saveTimer = null
    clearDraft(storage, oldPost, oldReply)
    saveDraft(storage, post, reply, text.value)
  }
})

onMounted(() => window.addEventListener('pagehide', flush))
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', flush)
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
  sending.value = true
  failure.value = null
  let answer
  try {
    answer = await props.onSend({ source, replyTo: replyId.value, pingReply: replyId.value !== null && ping.value })
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
  clearDraft(draftStorage(), props.postId, replyId.value)
  text.value = ''
  emit('sent', answer)
}

defineExpose({ act, focus: () => area.value.focus() })
</script>

<template>
  <section class="lb-composer" :class="{ 'lb-composer-full': full }" aria-label="Reply composer" @keydown.esc="full = false">
    <div class="lb-composer-head">
      <p class="lb-composer-where">Replying in: <b>{{ postTitle }}</b></p>
      <div v-if="replyTo" class="lb-replying-to">
        <span class="lb-replying-text">↪ replying to <b>{{ replyName }}</b></span>
        <button type="button" class="lb-ping" :aria-label="`Ping ${replyName}`" :aria-pressed="String(ping)" @click="ping = !ping">@ {{ ping ? 'on' : 'off' }}</button>
        <button type="button" class="lb-unreply" :aria-label="`Stop replying to ${replyName}`" @click="emit('update:replyTo', null)"><span aria-hidden="true">✕</span></button>
      </div>
      <button type="button" class="btn-ghost btn-sm lb-full" :aria-pressed="String(full)" @click="full = !full">Full screen</button>
    </div>

    <div class="lb-toolbar" role="toolbar" aria-label="Formatting" @keydown="moveInToolbar">
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
          @focus="toolStop = tool.at"
          @mousedown.prevent
          @click="press(tool)"
        >
          <span aria-hidden="true">{{ tool.face }}</span>
        </button>
      </div>
    </div>

    <div class="lb-compose-body">
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
          <div v-else-if="tab === 'preview'" class="lb-body lb-rendered"><ArchiveMarkdown :nodes="nodes" :ctx="ctx" /></div>
          <p v-else-if="discord === null" class="lb-pane-note">This reply can't be measured just now.</p>
          <template v-else>
            <p v-if="discord.length > MAX_PARTS" class="lb-dv-over">This needs {{ discord.length }} Discord messages, and a reply may have {{ MAX_PARTS }} at most.</p>
            <ol class="lb-dv-parts">
              <li v-for="(part, k) in discord" :key="k" class="lb-dv-part">
                <p class="lb-dv-head">Message {{ k + 1 }} of {{ discord.length }}</p>
                <template v-for="(block, b) in part.blocks" :key="b">
                  <div v-if="block.kind === 'text'" class="lb-dv-block lb-dv-text lb-body lb-rendered"><ArchiveMarkdown :nodes="block.nodes" :ctx="ctx" /></div>
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
      <button type="button" class="btn-ember btn-sm lb-send" :disabled="!canSend" @click="send">Reply</button>
    </div>
  </section>
</template>
