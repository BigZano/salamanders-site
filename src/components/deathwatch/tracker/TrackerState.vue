<script setup>
// The frame of every Event Tracker and Manage view: "loading" until the data is in, the error if it could not be
// fetched, and the view itself once it is ready.
import './tracker.css'

defineProps({ status: { type: String, required: true }, error: { type: String, default: '' } })
defineEmits(['retry'])
</script>

<template>
  <div class="dw-page">
    <p v-if="status === 'error'" class="dw-empty" role="alert">
      {{ error || 'The data could not be loaded.' }}
      <button type="button" class="dw-btn rm-fade" @click="$emit('retry')">Try again</button>
    </p>
    <p v-else-if="status !== 'ready'" class="dw-sub" role="status">Loading…</p>
    <slot v-else />
  </div>
</template>
