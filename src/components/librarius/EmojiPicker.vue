<script>
// The kinds of emoji, as Unicode groups them in the standard list, and the server's own last.
const KINDS = [
  { id: 'Smileys & Emotion', face: '😀', label: 'Smileys' },
  { id: 'People & Body', face: '👋', label: 'People' },
  { id: 'Animals & Nature', face: '🐱', label: 'Animals' },
  { id: 'Food & Drink', face: '🍎', label: 'Food' },
  { id: 'Activities', face: '⚽', label: 'Activities' },
  { id: 'Travel & Places', face: '🚗', label: 'Travel' },
  { id: 'Objects', face: '💡', label: 'Objects' },
  { id: 'Symbols', face: '❤', label: 'Symbols' },
  { id: 'Flags', face: '🏳', label: 'Flags' },
  { id: 'custom', face: '⭐', label: 'This server' },
]
// What a custom emoji must be to be written as <:name:id>: Discord's ids, and the names render.js shows.
const SNOWFLAKE = /^\d{17,20}$/
const NAME = /^\w{1,32}$/
// No more buttons than this in the grid at once (a server may have hundreds of emoji).
const SHOWN = 200
</script>

<script setup>
// The emoji picker of the Librarius composer, ported from the Req_bot dashboard's, without its stores: the page gives the
// server's own emoji (`custom`, from /librarius/emoji, as [{ id, name, animated }]) and the standard list is Unicode's
// (src/data/emojis.json). It shows one kind at a time, and the search looks through the names of the kind shown. Pressing an
// emoji, or Enter in the search box for the first one shown, gives its text by `pick`: the emoji itself, or <:name:id> for
// the server's (<a:name:id> for one that moves). A custom emoji whose id or name could not be written so is left out.
// Escape gives `close`, and goes no further, so a full-screen composer stays so. Styles are in librarius.css.
import { computed, onMounted, ref } from 'vue'
import standardEmoji from '../../data/emojis.json'

const props = defineProps({
  // The server's own emoji, [{ id, name, animated }].
  custom: { type: Array, default: () => [] },
  // The standard emoji, [{ emoji, name, group }].
  standard: { type: Array, default: () => standardEmoji },
})
const emit = defineEmits(['pick', 'close'])

const kind = ref(KINDS[0].id)
const query = ref('')
const box = ref(null)

const isCustom = (e) => typeof e === 'object' && e !== null && typeof e.id === 'string' && SNOWFLAKE.test(e.id) && typeof e.name === 'string' && NAME.test(e.name)
const customEmoji = computed(() =>
  props.custom.filter(isCustom).map((e) => {
    const moves = e.animated === true
    return {
      key: e.id,
      label: `:${e.name}:`,
      name: e.name,
      text: `<${moves ? 'a' : ''}:${e.name}:${e.id}>`,
      src: `https://cdn.discordapp.com/emojis/${e.id}.${moves ? 'gif' : 'webp'}?size=48`,
    }
  }),
)

const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list =
    kind.value === 'custom'
      ? customEmoji.value
      : props.standard.filter((e) => e.group === kind.value).map((e) => ({ key: e.emoji, label: e.name, name: e.name, text: e.emoji, src: null }))
  return list.filter((e) => e.name.toLowerCase().includes(q)).slice(0, SHOWN)
})
const empty = computed(() => (kind.value === 'custom' && customEmoji.value.length === 0 && query.value.trim() === '' ? 'This server has no emoji of its own.' : 'No emoji match that.'))

function onSearchKey(event) {
  if (event.key !== 'Enter' || shown.value.length === 0) return
  event.preventDefault()
  emit('pick', shown.value[0].text)
}

onMounted(() => box.value.focus())
</script>

<template>
  <div class="lb-picker" role="dialog" aria-label="Emoji" @keydown.esc.stop="emit('close')">
    <div class="lb-picker-kinds" role="group" aria-label="Kinds of emoji">
      <button
        v-for="k in KINDS"
        :key="k.id"
        type="button"
        class="lb-picker-kind"
        :aria-label="k.label"
        :aria-pressed="String(kind === k.id)"
        :title="k.label"
        @click="kind = k.id"
      >
        <span aria-hidden="true">{{ k.face }}</span>
      </button>
    </div>
    <input ref="box" v-model="query" type="search" class="lb-picker-search" aria-label="Search emoji" placeholder="Search emoji…" @keydown="onSearchKey" />
    <div class="lb-picker-grid" role="group" :aria-label="KINDS.find((k) => k.id === kind).label">
      <p v-if="shown.length === 0" class="lb-picker-empty">{{ empty }}</p>
      <button v-for="e in shown" :key="e.key" type="button" class="lb-picker-emoji" :aria-label="e.label" :title="e.label" @click="emit('pick', e.text)">
        <img v-if="e.src" :src="e.src" alt="" width="22" height="22" loading="lazy" />
        <span v-else aria-hidden="true">{{ e.text }}</span>
      </button>
    </div>
  </div>
</template>
