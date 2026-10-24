<script setup>
// A destructive reset at the foot of a Manage page: a backup button, and the reset itself, which only runs after
// the Watch Commander types RESET. `run` does the work and may throw; its message is shown.
import { ref } from 'vue'

const props = defineProps({
  title: { type: String, required: true },
  text: { type: String, required: true },
  ask: { type: String, required: true },
  run: { type: Function, required: true },
})
defineEmits(['backup'])

const open = ref(false)
const typed = ref('')
const msg = ref('')
async function go() {
  open.value = false
  typed.value = ''
  msg.value = 'Deleting…'
  try {
    await props.run()
    msg.value = 'Done ✓'
  } catch (err) {
    msg.value = `Not completed: ${err.message}`
  }
}
</script>

<template>
  <section class="dw-danger">
    <h2 class="dw-plaque">{{ title }}</h2>
    <p class="dw-sub">{{ text }} This cannot be undone.</p>
    <div class="dw-actions">
      <button type="button" class="dw-btn" @click="$emit('backup')">Download backup</button>
      <button type="button" class="dw-btn danger" @click="open = !open">{{ title }}</button>
      <span class="dw-msg" role="status">{{ msg }}</span>
    </div>
    <template v-if="open">
      <p class="dw-msg"><b>{{ ask }}</b> Download a backup first if you still need the results.</p>
      <label class="dw-field confirm">Type RESET to confirm<input v-model="typed" autocomplete="off" autocapitalize="characters" /></label>
      <div class="dw-actions">
        <button type="button" class="dw-btn" @click="open = false">Cancel</button>
        <button type="button" class="dw-btn danger" :disabled="typed.trim().toUpperCase() !== 'RESET'" @click="go">Delete permanently</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.confirm {
  max-width: 18rem;
}
</style>
