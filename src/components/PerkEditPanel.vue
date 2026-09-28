<script setup>
import { ref, computed, watch, useId } from 'vue'
import { usePerkCorrections } from '../stores/perkCorrections'
import { useAuth } from '../stores/auth'

// Edit / remove an existing perk, or (perk = null) add one to a tier. The
// store applies the change at once; a refusal rolls it back and lands here.
const props = defineProps({
  kind: { type: String, required: true },
  target: { type: String, required: true },
  quality: { type: String, default: null },
  perk: { type: Object, default: null },
  suggestions: { type: Array, default: () => [] },
})
const emit = defineEmits(['done'])
const corrections = usePerkCorrections()
const auth = useAuth()
// Several panels can be on one page (edit + add, several weapon slots), so
// label/field ids must be per-instance.
const uid = useId()

const mode = ref(props.perk ? 'idle' : 'add') // idle | edit | remove | add
const name = ref('')
const text = ref(props.perk?.description || '')
const note = ref('')
const error = ref('')
const busy = ref(false)

// Hosts pass a fresh `{ name, description }` literal on every render, so
// watch the perk's value, not its identity, or any re-render (a hover, a
// node toggle) would wipe the draft.
watch(
  () => (props.perk ? props.perk.name + '\u0000' + (props.perk.description ?? '') : null),
  () => {
    const p = props.perk
    mode.value = p ? 'idle' : 'add'
    text.value = p?.description || ''
    note.value = ''
    error.value = ''
  },
)
const canSave = computed(() => {
  const t = text.value.trim()
  if (!t) return false
  return mode.value !== 'edit' || t !== (props.perk?.description || '').trim()
})
watch(name, (n) => {
  const hit = props.suggestions.find((s) => s.name === n.trim())
  if (hit) text.value = hit.description
})

async function save(op) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await corrections.submit(
      {
        kind: props.kind,
        target: props.target,
        quality: props.kind === 'weapon' ? props.quality : null,
        op,
        perkName: op === 'add' ? name.value.trim() : props.perk.name,
        description: op === 'remove' ? null : text.value.trim(),
        note: note.value.trim() || null,
      },
      auth.token,
    )
    emit('done')
  } catch (err) {
    error.value = err.message || 'That did not save.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="pe">
    <div v-if="mode === 'idle'" class="pe-actions">
      <button type="button" class="pe-edit" @click="mode = 'edit'">Edit text</button>
      <button v-if="kind === 'weapon'" type="button" class="pe-remove" @click="mode = 'remove'">Remove from this tier</button>
    </div>

    <div v-else-if="mode === 'remove'" class="pe-actions">
      <span>Remove {{ perk.name }} from {{ quality }}?</span>
      <input v-model="note" class="pe-note" maxlength="200" placeholder="Note (optional), e.g. checked in game, patch 14.1" aria-label="Note" />
      <button type="button" class="pe-confirm" :disabled="busy" @click="save('remove')">Remove</button>
      <button type="button" @click="mode = 'idle'">Cancel</button>
    </div>

    <form v-else class="pe-form" @submit.prevent="save(mode === 'add' ? 'add' : 'edit')">
      <template v-if="mode === 'add'">
        <label class="pe-label" :for="`${uid}-name`">Perk name</label>
        <input :id="`${uid}-name`" v-model="name" class="pe-name" maxlength="80" :list="`${uid}-suggest`" required />
        <datalist :id="`${uid}-suggest`">
          <option v-for="s in suggestions" :key="s.name" :value="s.name" />
        </datalist>
      </template>
      <label class="pe-label" :for="`${uid}-text`">Perk text</label>
      <textarea :id="`${uid}-text`" v-model="text" rows="3" maxlength="500" required />
      <input v-model="note" class="pe-note" maxlength="200" placeholder="Note (optional), e.g. checked in game, patch 14.1" aria-label="Note" />
      <div class="pe-actions">
        <button type="submit" :disabled="busy || !canSave">Save</button>
        <button type="button" @click="perk ? (mode = 'idle') : emit('done')">Cancel</button>
      </div>
    </form>

    <p v-if="error" class="pe-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.pe {
  margin-top: 0.7rem;
  padding-top: 0.7rem;
  border-top: 1px dashed var(--color-ash);
}
.pe-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: #c3d0c6;
}
.pe-form {
  display: grid;
  gap: 0.4rem;
}
.pe-label {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.58rem;
  color: var(--color-smoke);
}
.pe input,
.pe textarea {
  background: rgba(5, 10, 8, 0.7);
  border: 1px solid var(--color-ash);
  color: var(--color-bone);
  border-radius: 2px;
  padding: 0.4rem 0.5rem;
  font: inherit;
  font-size: 0.85rem;
}
.pe button {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.68rem;
  color: var(--color-bone);
  background: transparent;
  border: 1px solid var(--color-ash-2);
  border-radius: 2px;
  padding: 0.35rem 0.6rem;
  cursor: pointer;
}
.pe .pe-confirm,
.pe .pe-remove:hover {
  border-color: var(--color-ember);
  color: var(--color-ember);
}
.pe-error {
  margin-top: 0.4rem;
  color: var(--color-ember);
  font-size: 0.8rem;
}
</style>
