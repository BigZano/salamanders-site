<script setup>
import RosterRank from './RosterRank.vue'

// The public body of a Ranks bar: how many hold each rank, never who. Head
// holders beyond the two the bar shows are named (they are leaders), as chips
// with no avatars: the public data carries none, and nothing here asks for one.
// Props in, one event out; the page decides what signing in does.
defineProps({
  // a branch's `shape` from rosterPublicView.js: [{ s, key, label, count, lateral?, aside?, heat }]
  items: { type: Array, required: true },
  // { rank, members } for head holders past the first two, or null
  extraHeads: { type: Object, default: null },
  // { kind, number } of the branch, for the chips' company tag (null is fine)
  branch: { type: Object, default: null },
})
defineEmits(['sign-in'])

const styleOf = (item) => ({ '--h': item.heat.h, '--hp': item.heat.hp, '--hn': item.heat.hn })
</script>

<template>
  <div class="rs-shape">
    <RosterRank v-if="extraHeads" class="rs-shape-heads" :row="extraHeads" :branch="branch" :image-ready="false" />
    <ul v-if="items.length" class="rs-shape-rows">
      <li
        v-for="item in items"
        :key="item.s"
        class="rs-shape-row"
        :data-rank="item.key"
        :data-lateral="item.lateral ? '' : undefined"
        :style="styleOf(item)"
      >
        <i class="rs-shape-node" aria-hidden="true" />
        <span class="rs-shape-label">{{ item.label }}</span>
        <span class="rs-count">{{ item.count }}</span>
      </li>
    </ul>
    <p class="rs-shape-signin">
      <span>Legion member? Sign in to see everyone in this company.</span>
      <button type="button" class="btn-drake" @click="$emit('sign-in')">Sign in with Discord</button>
    </p>
  </div>
</template>

<style scoped>
.rs-shape {
  padding: 0.7rem 1.3rem 1.3rem;
  border-top: 1px solid rgba(58, 82, 70, 0.5);
}
.rs-shape-heads {
  margin-bottom: 0.7rem;
}
.rs-shape-rows {
  display: grid;
  gap: 0.2rem 2.4rem;
  grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
  margin: 0;
  padding: 0;
  list-style: none;
}
.rs-shape-row {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  padding: 0.3rem 0;
}
/* a lit diamond in the rank's place on the heat ramp, the ladder's colour without its spine */
.rs-shape-node {
  flex: none;
  width: 7px;
  height: 7px;
  align-self: center;
  transform: rotate(45deg);
  background: var(--h);
  box-shadow: 0 0 8px -1px var(--hn);
}
.rs-shape-row[data-lateral] .rs-shape-node {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--h);
}
.rs-shape-label {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 0.82rem;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #b9c7bd;
}
.rs-count {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--color-smoke);
}
.rs-shape-signin {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem 1rem;
  margin: 1rem 0 0;
  padding-top: 0.9rem;
  border-top: 1px dashed rgba(58, 82, 70, 0.6);
  font-family: var(--font-mono);
  font-size: 0.76rem;
  color: var(--color-smoke);
}
.rs-shape-signin button {
  min-height: 44px;
  padding: 0.55rem 0.95rem;
  cursor: pointer;
}
</style>
