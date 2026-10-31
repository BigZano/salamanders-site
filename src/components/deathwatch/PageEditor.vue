<script setup>
// "Edit page", as on the old site: a button at the foot of the screen opens the texts of the page the Watch Commander
// is on, each under the old site's label, in a modal <dialog>. Save writes them to the area's page texts (cfg/tx),
// where the page reads them from; a text equal to its default is not stored (lib/deathwatch/pageTexts.js). The
// area shows it to the Watch Commander only; the server refuses anyone else's save anyway.
import { nextTick, ref, useTemplateRef } from 'vue'
import { defaultText, editedTexts, textOf } from '../../lib/deathwatch/pageTexts'
import { useAuth } from '../../stores/auth'
import { useDeathwatchData } from '../../stores/deathwatchData'

const props = defineProps({ fields: { type: Array, required: true } })
const auth = useAuth()
const data = useDeathwatchData()
const dialog = useTemplateRef('dialog')
const values = ref({})
const saving = ref(false)
const msg = ref('')
// Rows enough for the text, as the old site sized them, up to 16.
const rows = (t) => Math.min(16, Math.ceil(t.length / 90) + t.split('\n').length)

async function open() {
  values.value = Object.fromEntries(props.fields.map(([k]) => [k, textOf(data.cfg.tx, k)]))
  msg.value = ''
  dialog.value.showModal()
  await nextTick()
  dialog.value.querySelector('textarea').focus()
}

async function save() {
  if (saving.value) return
  saving.value = true
  msg.value = ''
  try {
    await data.write(auth.token, 'cfg', 'tx', editedTexts(data.cfg.tx, values.value))
    dialog.value.close()
  } catch (err) {
    msg.value = err?.message ? `Not saved: ${err.message}` : 'Not saved.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <template v-if="data.status === 'ready'">
    <button type="button" class="pe-open" @click="open">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13 7l4 4" /></svg>
      Edit page
    </button>
    <dialog ref="dialog" class="pe" aria-labelledby="pe-title">
      <form @submit.prevent="save">
        <h2 id="pe-title" class="pe-title">Edit page</h2>
        <p class="pe-hint">
          Blank line = new paragraph · **bold** · *italic* · [link text](https://…). An empty field hides that part; “Default” brings back the
          standard text.
        </p>
        <div v-for="[k, label] in fields" :key="k" class="pe-f">
          <span :id="`pe-l-${k}`">{{ label }}</span>
          <textarea v-model="values[k]" :name="k" :rows="rows(values[k] ?? '')" :aria-labelledby="`pe-l-${k}`" spellcheck="true" />
          <button
            v-if="defaultText(k) && values[k] !== defaultText(k)"
            type="button"
            class="pe-reset"
            :aria-label="`Restore the default: ${label.replace(/\s*\(.*$/, '')}`"
            @click="values[k] = defaultText(k)"
          >
            Default
          </button>
        </div>
        <p v-if="msg" class="pe-msg" role="alert">{{ msg }}</p>
        <div class="pe-actions">
          <button type="submit" class="dw-btn pe-save" :disabled="saving">{{ saving ? 'Saving…' : 'Save' }}</button>
          <button type="button" class="dw-btn pe-cancel" @click="dialog.close()">Cancel</button>
        </div>
      </form>
    </dialog>
  </template>
</template>

<style scoped>
/* Bottom right, clear of the iPhone's home bar; above the page, below an open sheet or dialog. */
.pe-open {
  position: fixed;
  z-index: 35;
  right: max(16px, env(safe-area-inset-right, 0px));
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 16px;
  font: 600 0.82rem / 1 var(--dw-font-cond);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--dw-accent);
  border: 1px solid var(--dw-accent);
  border-radius: 999px;
  background: color-mix(in oklab, var(--dw-surface) 88%, transparent);
  box-shadow: 0 10px 30px -8px rgb(0 0 0 / 0.7);
  cursor: pointer;
}
.pe-open svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
@media (hover: hover) and (pointer: fine) {
  .pe-open:hover {
    background: color-mix(in oklab, var(--dw-accent) 18%, var(--dw-surface));
  }
}
.pe-open:focus-visible {
  outline: 2px solid var(--dw-accent);
  outline-offset: 2px;
}
.pe {
  width: min(820px, calc(100% - 2rem));
  max-height: calc(100dvh - 2rem);
  padding: 0.5rem 1.25rem 1.25rem;
  color: var(--dw-ink);
  border: 1px solid var(--dw-line-2);
  border-radius: 14px;
  background: var(--dw-surface);
  overflow: auto;
  overscroll-behavior: contain;
}
/* Literal colour: ::backdrop does not inherit custom properties in older browsers. */
.pe::backdrop {
  background: rgba(0, 0, 0, 0.6);
}
.pe-title {
  margin: 0.75rem 0 0.25rem;
  font: 700 1.6rem / 1.1 var(--dw-font-title);
}
.pe-hint {
  margin: 0 0 1rem;
  font-size: 0.85rem;
  color: var(--dw-muted);
}
.pe-f {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.35rem 0.75rem;
  margin-bottom: 1rem;
}
.pe-f > span {
  font-size: 0.9rem;
  font-weight: 600;
}
.pe-f textarea {
  grid-column: 1 / -1;
  width: 100%;
  box-sizing: border-box;
  padding: 10px;
  font: 0.8rem / 1.45 ui-monospace, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  color: var(--dw-ink);
  border: 1px solid var(--dw-line-2);
  border-radius: 8px;
  background: var(--dw-bg);
  resize: vertical;
}
.pe-f textarea:focus-visible {
  outline: 2px solid var(--dw-accent);
  outline-offset: 1px;
}
/* Beside the label, at its end. */
.pe-reset {
  grid-row: 1;
  grid-column: 2;
  align-self: end;
  min-height: 32px;
  padding: 0 0.75rem;
  font: 600 0.75rem / 1 var(--dw-font-cond);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--dw-muted);
  border: 1px solid var(--dw-line-2);
  border-radius: 999px;
  background: none;
  cursor: pointer;
}
.pe-reset:focus-visible {
  outline: 2px solid var(--dw-accent);
  outline-offset: 2px;
}
.pe-msg {
  margin: 0 0 0.75rem;
  color: var(--dw-down);
}
.pe-actions {
  position: sticky;
  bottom: -1.25rem;
  display: flex;
  gap: 0.75rem;
  margin: 0 -1.25rem -1.25rem;
  padding: 0.75rem 1.25rem 1.25rem;
  background: var(--dw-surface);
  border-top: 1px solid var(--dw-line);
}
</style>
