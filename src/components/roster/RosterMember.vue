<script setup>
import { inject } from 'vue'
import { initials, safeAvatar } from '../../lib/rosterAvatar'
import { ROSTER_VIEWER } from '../../lib/rosterContext'
import { showCompanyTag } from '../../lib/rosterView'

// One chip. Plain functions in the template, no per-chip computed: a roster has
// hundreds of these and they only re-render when their props change.
defineProps({
  member: { type: Object, required: true },
  // { kind, number } of the branch this chip sits in; decides whether the company tag adds anything
  branch: { type: Object, default: null },
  // false holds the avatar image back (a closed branch body); initials show either way
  imageReady: { type: Boolean, default: true },
  hero: { type: Boolean, default: false },
})
const viewer = inject(ROSTER_VIEWER, null)
const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th']
</script>

<template>
  <li class="rs-member" :class="{ 'rs-me': viewer != null && viewer === member.id, 'rs-hero': hero }" :data-id="member.id">
    <span class="rs-avatar" :class="{ 'rs-initials': !(imageReady && safeAvatar(member.avatar)) }" aria-hidden="true">
      {{ initials(member.name) }}
      <img
        v-if="imageReady && safeAvatar(member.avatar)"
        class="rs-avatar-img"
        :src="member.avatar"
        width="64"
        height="64"
        decoding="async"
        alt=""
      />
    </span>
    <span class="rs-name">{{ member.name }}</span>
    <span v-if="showCompanyTag(member, branch)" class="rs-tag">{{ ORDINALS[member.company] }}</span>
    <span v-if="member.acting" class="rs-badge rs-acting">Acting</span>
    <span v-if="member.nameMismatch" class="rs-badge rs-warn" title="The display name names a different company than the roles do">Check name</span>
    <span v-if="member.bot" class="rs-badge rs-bot">Bot</span>
    <span v-if="viewer != null && viewer === member.id" class="rs-you">You</span>
    <slot />
  </li>
</template>

<style scoped>
.rs-member {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  box-sizing: border-box;
  max-width: 100%;
  min-height: calc(1.6rem + 0.4rem + 2px);
  padding: 0.2rem 0.65rem 0.2rem 0.2rem;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(58, 82, 70, 0.55);
  border-radius: 999px;
  font-size: 0.86rem;
  line-height: 1.2;
  list-style: none;
  transition: border-color 0.15s, background 0.15s;
}
.rs-member:hover {
  border-color: rgba(89, 214, 108, 0.55);
  background: rgba(89, 214, 108, 0.06);
}
.rs-avatar {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 50%;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: max(0.62rem, var(--text-floor));
  letter-spacing: 0.02em;
  color: #cfe0d4;
  background: linear-gradient(180deg, #2c4137, #1a2a22);
  border: 1px solid rgba(58, 82, 70, 0.9);
}
/* sits over the initials, which are the placeholder while it loads */
.rs-avatar-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.rs-name {
  font-weight: 600;
  color: #e1ebe3;
  overflow-wrap: anywhere;
}
.rs-tag {
  font-family: var(--font-mono);
  font-size: max(0.62rem, var(--text-floor));
  color: var(--color-smoke);
  border: 1px solid var(--color-ash);
  border-radius: 3px;
  padding: 0 0.3rem;
}
.rs-badge,
.rs-you {
  font-family: var(--font-mono);
  font-size: max(0.6rem, var(--text-floor));
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.06rem 0.38rem;
  border-radius: 3px;
  white-space: nowrap;
}
.rs-acting {
  color: #1a1204;
  background: var(--color-averland);
  font-weight: 700;
}
.rs-warn {
  color: #ffd2a8;
  border: 1px solid rgba(255, 106, 43, 0.6);
  background: rgba(255, 106, 43, 0.12);
}
.rs-bot {
  color: var(--color-smoke);
  border: 1px solid var(--color-ash-2);
}
.rs-me {
  border-color: var(--color-drake);
  box-shadow: 0 0 0 1px rgba(89, 214, 108, 0.3), 0 0 18px -4px rgba(89, 214, 108, 0.55);
}
.rs-you {
  color: #06150a;
  background: var(--color-drake);
  font-weight: 700;
}
/* added by the page when Find me lands on this chip */
.rs-ping {
  animation: rs-ping 1.4s ease-out 2;
}
@keyframes rs-ping {
  0% { box-shadow: 0 0 0 0 rgba(89, 214, 108, 0.7); }
  100% { box-shadow: 0 0 0 14px rgba(89, 214, 108, 0); }
}

/* High Command's first rank: a large avatar and name, no pill */
.rs-hero {
  gap: 1rem;
  padding: 0;
  background: none;
  border-color: transparent;
}
.rs-hero:hover {
  background: none;
  border-color: transparent;
}
.rs-hero .rs-avatar {
  width: 4.2rem;
  height: 4.2rem;
  font-size: 1.3rem;
  border-color: rgba(223, 184, 91, 0.55);
}
.rs-hero .rs-name {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: clamp(1.7rem, 3.6vw, 2.3rem);
  line-height: 1.05;
}
</style>
