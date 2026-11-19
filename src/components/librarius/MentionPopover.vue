<script>
// Each popover's own ids (its list and options), unique on the page whichever app it is mounted in.
let instances = 0
// A member that can be mentioned: Discord's ids, and a name to show.
const SNOWFLAKE = /^\d{17,20}$/
// The longest query the server searches with (librariusWrites.js SEARCH_MAX).
const MAX_QUERY = 32
</script>

<script setup>
// The @ popover of the Librarius composer: the member search of Administratum → Access (useMemberSearch), asked 250 ms
// after the last letter, once there are two. `search(q)` is the page's (→ a promise of [{ id, name, avatar }]); the composer
// gives it paced (lib/librarius/requests.js), so typing never runs into the server's searches a minute. The box is a combobox
// over the list of who was found: the arrows move along it, round from one end to the other, and Enter or a click gives the
// member by `pick` as { id, name }. Anyone the server gave without an id or a name is left out. Escape gives `close`, and goes
// no further, so a full-screen composer stays so. Styles are in librarius.css.
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useMemberSearch } from '../../lib/deathwatch/memberSearch'

const props = defineProps({
  // (q) → a promise of the members found, [{ id, name, avatar }].
  search: { type: Function, required: true },
})
const emit = defineEmits(['pick', 'close'])

const uid = `lb-mention-${++instances}`
const finder = reactive(useMemberSearch((q) => props.search(q)))
const box = ref(null)
const at = ref(0)

const isMember = (m) => typeof m === 'object' && m !== null && typeof m.id === 'string' && SNOWFLAKE.test(m.id) && typeof m.name === 'string' && /\S/.test(m.name)
const members = computed(() => (Array.isArray(finder.results) ? finder.results.filter(isMember) : []))
watch(members, () => (at.value = 0))

const said = computed(() => {
  if (finder.state === 'loading') return 'Searching…'
  if (finder.state === 'error') return finder.message
  if (finder.state === 'idle') return 'Type two or more letters of their name.'
  return members.value.length === 0 ? 'Nobody found by that name.' : `${members.value.length} found.`
})
const optionId = (i) => `${uid}-option-${i}`

const pick = (m) => emit('pick', { id: m.id, name: m.name })

function onKey(event) {
  const count = members.value.length
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
    return
  }
  if (count === 0) return
  if (event.key === 'ArrowDown') at.value = (at.value + 1) % count
  else if (event.key === 'ArrowUp') at.value = (at.value - 1 + count) % count
  else if (event.key === 'Enter') pick(members.value[at.value])
  else return
  event.preventDefault()
}

onMounted(() => box.value.focus())
</script>

<template>
  <div class="lb-mention" role="dialog" aria-label="Mention someone">
    <input
      ref="box"
      v-model="finder.query"
      type="text"
      class="lb-mention-search"
      role="combobox"
      aria-label="Find a member to mention"
      aria-autocomplete="list"
      :aria-expanded="String(members.length > 0)"
      :aria-controls="`${uid}-list`"
      :aria-activedescendant="members.length > 0 ? optionId(at) : undefined"
      :maxlength="MAX_QUERY"
      placeholder="Name…"
      autocomplete="off"
      @keydown="onKey"
    />
    <p class="lb-mention-status" role="status">{{ said }}</p>
    <ul :id="`${uid}-list`" class="lb-mention-list" role="listbox" aria-label="Members found">
      <li
        v-for="(m, i) in members"
        :id="optionId(i)"
        :key="m.id"
        class="lb-mention-option"
        role="option"
        :aria-selected="String(i === at)"
        @mousedown.prevent
        @click="pick(m)"
      >
        {{ m.name }}
      </li>
    </ul>
  </div>
</template>
