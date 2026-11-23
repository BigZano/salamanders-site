<script setup>
// What the post page offers on one message, and what it says of what the reader has on its way for it: the actions the reader
// may take (Reply, Quote, Edit, Delete), each named for a screen reader by whose message it is; and, for a reply, an edit or a
// delete on its way, that it is still going ("sending…", or "deleting…"), that the server's rules blocked it (Edit puts it back to
// be changed, where the reader may still reply, and Discard lets it go: it is not the message's own Delete), or that it failed
// (Retry sends it again, Dismiss lets it go), with the server's reason for a failure. It decides nothing: it says what was pressed (`act`), and the page does it. Quote
// keeps the reader's selection when it is pressed, since the words selected are what it quotes. Styles are in librarius.css.
import { computed } from 'vue'

const props = defineProps({
  // The actions offered, in order: any of 'reply', 'quote', 'edit' and 'delete'.
  actions: { type: Array, default: () => [] },
  // Whose message it is, as the page names them.
  name: { type: String, default: '' },
  // What the reader has on its way for it, as the store holds it ({ kind, state, error }), or null.
  entry: { type: Object, default: null },
  // Whether what was blocked can be put back to be changed: the reader may still reply.
  revisable: { type: Boolean, default: false },
  // Why the last thing done to it did not go, or ''.
  error: { type: String, default: '' },
})
const emit = defineEmits(['act'])

const COPY = {
  sending: 'sending…',
  deleting: 'deleting…',
  blocked: "Blocked by the server's rules. Edit it or discard it.",
  failed: "Couldn't send. Try again.",
  failedDelete: "Couldn't delete. Try again.",
}
// What each kind of entry is called in the names of its buttons.
const NOUN = { send: 'reply', edit: 'edit', delete: 'delete' }

const who = computed(() => props.name || 'this member')
const TOOLS = {
  reply: { face: 'Reply', label: () => `Reply to ${who.value}` },
  quote: { face: 'Quote', label: () => `Quote ${who.value}` },
  edit: { face: 'Edit', label: () => 'Edit your reply' },
  delete: { face: 'Delete', label: () => `Delete ${who.value}'s message` },
}
const tools = computed(() => props.actions.map((action) => ({ action, face: TOOLS[action].face, label: TOOLS[action].label() })))

const isWords = (value) => typeof value === 'string' && /\S/.test(value)
const noun = computed(() => NOUN[props.entry?.kind] ?? 'reply')
// How the entry stands: going, blocked or failed, with what the reader is told, or null with none.
const state = computed(() => {
  const e = props.entry
  if (e === null) return null
  if (e.state === 'sending' || e.state === 'sent') return { kind: 'going', text: e.kind === 'delete' ? COPY.deleting : COPY.sending }
  if (e.state === 'blocked') return { kind: 'blocked', text: COPY.blocked }
  const failed = e.kind === 'delete' ? COPY.failedDelete : COPY.failed
  return { kind: 'failed', text: isWords(e.error) ? `${failed} ${e.error}` : failed }
})
</script>

<template>
  <p v-if="state" class="lb-state" :class="`lb-state-${state.kind}`" :role="state.kind === 'going' ? 'status' : 'alert'">{{ state.text }}</p>
  <div v-if="state && state.kind === 'blocked'" class="lb-state-tools">
    <button v-if="revisable" type="button" class="lb-act" :aria-label="`Edit the blocked ${noun}`" @click="emit('act', 'revise')">Edit</button>
    <button type="button" class="lb-act" :aria-label="`Discard the blocked ${noun}`" @click="emit('act', 'discard')">Discard</button>
  </div>
  <div v-else-if="state && state.kind === 'failed'" class="lb-state-tools">
    <button type="button" class="lb-act" :aria-label="`Try the ${noun} again`" @click="emit('act', 'retry')">Retry</button>
    <button type="button" class="lb-act" :aria-label="`Dismiss the failed ${noun}`" @click="emit('act', 'dismiss')">Dismiss</button>
  </div>
  <p v-if="error" class="lb-action-error" role="alert">{{ error }}</p>
  <div v-if="tools.length" class="lb-actions" role="group" aria-label="Message actions">
    <button
      v-for="t in tools"
      :key="t.action"
      type="button"
      class="lb-act"
      :aria-label="t.label"
      @mousedown="t.action === 'quote' && $event.preventDefault()"
      @click="emit('act', t.action)"
    >
      {{ t.face }}
    </button>
  </div>
</template>
