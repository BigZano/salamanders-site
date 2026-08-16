<script setup>
defineProps({
  build: { type: Object, required: true },
  showBadge: { type: Boolean, default: false },
  canDelete: { type: Boolean, default: false },
  deleting: { type: Boolean, default: false },
})
defineEmits(['open', 'remove'])

const slots = [
  { key: 'primary', label: 'Primary' },
  { key: 'secondary', label: 'Secondary' },
  { key: 'melee', label: 'Melee' },
]
</script>

<template>
  <article class="b-card panel-forge">
    <div class="b-card-top">
      <h2 class="b-name">{{ build.title }}</h2>
      <span class="b-class">{{ build.className }}</span>
    </div>
    <p class="b-meta">
      Level {{ build.level }}<span v-if="build.prestige"> · Prestige {{ build.prestige }}</span
      ><span v-if="build.role"> · {{ build.role }}</span>
    </p>
    <p class="b-author">
      by {{ build.author.username }}
      <span v-if="showBadge" class="b-member-badge" title="Verified Chapter member">✓ Member</span>
    </p>
    <p v-if="build.notes" class="b-notes">{{ build.notes }}</p>

    <dl class="b-load">
      <div v-for="s in slots" :key="s.key">
        <dt>{{ s.label }}</dt>
        <dd>
          <RouterLink
            v-if="build.weapons[s.key]"
            class="b-weapon"
            :to="{ path: '/armoury', query: { w: build.weapons[s.key] } }"
          >
            {{ build.weapons[s.key] }}
          </RouterLink>
          <span v-else>—</span>
        </dd>
      </div>
    </dl>

    <div class="b-perks">
      <span v-for="(p, i) in build.perks.filter(Boolean)" :key="i" class="b-perk">{{ p }}</span>
      <span v-if="!build.perks.some(Boolean)" class="b-perk-none">No class perks selected</span>
    </div>

    <div class="b-actions">
      <button class="btn-drake btn-sm" @click="$emit('open', build)">Open in builder</button>
      <button
        v-if="canDelete"
        class="btn-ghost btn-sm"
        :disabled="deleting"
        @click="$emit('remove', build)"
      >
        {{ deleting ? 'Deleting…' : 'Delete' }}
      </button>
    </div>
  </article>
</template>

<style scoped>
.b-card {
  display: flex;
  flex-direction: column;
  border-radius: 6px;
  padding: 1.3rem;
}
.b-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}
.b-name {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: 1.2rem;
  color: var(--color-bone);
  line-height: 1.1;
}
.b-class {
  flex: none;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.6rem;
  color: var(--color-drake);
  border: 1px solid rgba(89, 214, 108, 0.35);
  border-radius: 2px;
  padding: 2px 6px;
}
.b-meta {
  color: var(--color-smoke);
  font-size: 0.8rem;
  margin: 0.35rem 0 0.6rem;
}
.b-author {
  color: #5f6f66;
  font-size: 0.72rem;
  font-style: italic;
  margin: -0.3rem 0 0.6rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.b-member-badge {
  font-family: var(--font-mono);
  font-style: normal;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.6rem;
  color: var(--color-drake);
  border: 1px solid rgba(89, 214, 108, 0.4);
  border-radius: 2px;
  padding: 1px 5px;
}
.b-notes {
  color: #c3d0c6;
  font-size: 0.85rem;
  line-height: 1.5;
  margin-bottom: 0.8rem;
}
.b-load {
  margin: 0 0 0.9rem;
  display: grid;
  gap: 0.35rem;
}
.b-load div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid rgba(38, 55, 47, 0.5);
  padding-bottom: 0.3rem;
}
.b-load dt {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.62rem;
  color: var(--color-smoke);
}
.b-load dd {
  margin: 0;
  font-size: 0.82rem;
  color: var(--color-bone);
  text-align: right;
}
.b-weapon {
  color: var(--color-drake);
  border-bottom: 1px solid rgba(89, 214, 108, 0.35);
}
.b-weapon:hover {
  color: var(--color-bone);
  border-bottom-color: var(--color-bone);
}
.b-perks {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  flex-grow: 1;
  align-content: flex-start;
}
.b-perk {
  font-size: 0.72rem;
  color: #c3d0c6;
  background: rgba(255, 106, 43, 0.07);
  border: 1px solid rgba(255, 106, 43, 0.22);
  border-radius: 2px;
  padding: 0.2rem 0.5rem;
}
.b-perk-none {
  font-size: 0.76rem;
  color: #5f6f66;
  font-style: italic;
}
.b-actions {
  display: flex;
  gap: 0.4rem;
  margin-top: 1rem;
}
.btn-sm {
  padding: 0.5rem 0.85rem;
  border-radius: 2px;
  font-size: 0.78rem;
  cursor: pointer;
}
.btn-sm:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.btn-ghost {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  color: var(--color-smoke);
  background: transparent;
  border: 1px solid var(--color-ash);
}
.btn-ghost:hover {
  color: var(--color-bone);
  border-color: var(--color-ash-2);
}
</style>
