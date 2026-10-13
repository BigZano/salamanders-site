<script setup>
import { computed } from 'vue'

const props = defineProps({ member: { type: Object, required: true } })
const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th']
const initials = computed(() =>
  props.member.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0])
    .join('')
    .toUpperCase(),
)
</script>

<template>
  <li class="rs-member" :data-id="member.id">
    <img v-if="member.avatar" class="rs-avatar" :src="member.avatar" alt="" loading="lazy" />
    <span v-else class="rs-avatar rs-initials" aria-hidden="true">{{ initials }}</span>
    <span class="rs-name">{{ member.name }}</span>
    <span v-if="member.company" class="rs-tag">{{ ORDINALS[member.company] }}</span>
    <span v-if="member.acting" class="rs-badge">Acting</span>
    <span v-if="member.nameMismatch" class="rs-badge rs-warn" title="The display name names a different company than the roles do">Check name</span>
    <span v-if="member.bot" class="rs-badge">Bot</span>
    <slot />
  </li>
</template>
