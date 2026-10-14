<script setup>
import RosterMember from './RosterMember.vue'
import RosterRank from './RosterRank.vue'

// A branch's ranks, top to bottom, on the heat spine. Each step carries its
// sequence and heat colours as CSS variables (built once by rosterView.js); the
// spine and nodes light up from the branch's [data-open] state, in CSS only.
defineProps({
  items: { type: Array, required: true },
  // { kind, number } of the branch (null for Unassigned)
  branch: { type: Object, default: null },
  imageReady: { type: Boolean, default: true },
  spine: { type: Boolean, default: true },
  withTier: { type: Boolean, default: true },
})

const styleOf = (item) => ({ '--s': item.s, '--h': item.heat.h, '--hp': item.heat.hp, '--hn': item.heat.hn })
</script>

<template>
  <div class="rs-ladder" :class="{ 'rs-no-spine': !spine }">
    <div
      v-for="item in items"
      :key="item.s"
      class="rs-step"
      :class="{ 'rs-lateral': item.type === 'lateral', 'rs-last': item.last }"
      :style="styleOf(item)"
    >
      <i v-if="spine" class="rs-node" />
      <div v-if="item.type === 'aside'" class="rs-aside">
        <span class="rs-aside-label">Honoured Dreadnoughts</span>
        <ul class="rs-aside-chips">
          <RosterMember v-for="m in item.members" :key="m.id" :member="m" :branch="branch" :image-ready="imageReady" />
        </ul>
      </div>
      <RosterRank v-else-if="item.type === 'lateral'" :row="item.row" :branch="branch" :with-tier="withTier" :image-ready="imageReady" />
      <div v-else-if="item.rows.length > 1" class="rs-peers">
        <RosterRank v-for="r in item.rows" :key="r.rank.key" :row="r" :branch="branch" :with-tier="withTier" :image-ready="imageReady" />
      </div>
      <RosterRank v-else :row="item.rows[0]" :branch="branch" :with-tier="withTier" :image-ready="imageReady" />
    </div>
  </div>
</template>

<style scoped>
.rs-ladder {
  --pour: 110ms; /* delay between ranks lighting up */
  position: relative;
  padding: 0.5rem 1.3rem 1.3rem;
  border-top: 1px solid rgba(58, 82, 70, 0.5);
}
.rs-step {
  --node-y: 0.95rem;
  position: relative;
  padding: 0.42rem 0 0.42rem 2.1rem;
}

/* The spine: one segment per step, from its node down to the next, graded between
   this step's heat and the next one's. Hidden until the branch opens, then poured
   down in sequence. transform and opacity only. */
.rs-step::before {
  content: '';
  position: absolute;
  left: 0.6rem;
  top: 0;
  bottom: 0;
  width: 3px;
  margin-left: -1.5px;
  border-radius: 2px;
  background: linear-gradient(to bottom, var(--hp) 0, var(--h) var(--node-y), var(--hn) 100%);
  box-shadow: 0 0 10px -1px var(--hn);
  transform: scaleY(0);
  transform-origin: top;
  transition: transform 0.12s linear;
}
.rs-last::before {
  bottom: auto;
  height: var(--node-y);
}
:global([data-open]) .rs-step::before {
  transform: scaleY(1);
  transition-duration: 0.18s;
  transition-delay: calc(var(--s) * var(--pour) + 40ms);
}

/* The node: a diamond on the spine that lights as the heat reaches it. */
.rs-node {
  position: absolute;
  left: 0.6rem;
  top: var(--node-y);
  width: 11px;
  height: 11px;
  background: var(--h);
  transform: translate(-50%, -50%) rotate(45deg) scale(0);
  transition: transform 0.15s, box-shadow 0.2s;
}
:global([data-open]) .rs-node {
  transform: translate(-50%, -50%) rotate(45deg) scale(1);
  box-shadow: 0 0 12px 1px var(--h);
  transition: transform 0.32s cubic-bezier(0.3, 1.7, 0.5, 1), box-shadow 0.5s;
  transition-delay: calc(var(--s) * var(--pour) + 90ms);
}

/* A lateral rank (Terminator): a hollow node on a dashed stub off the spine. */
.rs-lateral {
  padding-left: 3.6rem;
  --rs-label-w: 8.4rem;
}
.rs-lateral .rs-node {
  left: 2.2rem;
  width: 8px;
  height: 8px;
  background: var(--color-obsidian);
  border: 1.5px solid var(--h);
  box-shadow: none;
}
:global([data-open]) .rs-lateral .rs-node {
  box-shadow: 0 0 8px -1px var(--h);
}
.rs-lateral::after {
  content: '';
  position: absolute;
  left: 0.6rem;
  width: 1.6rem;
  top: var(--node-y);
  border-top: 1.5px dashed var(--h);
  opacity: 0.8;
}
.rs-lateral :deep(.rs-rank-label) {
  color: var(--color-smoke);
}

/* Peers: same-tier ranks side by side on one node. */
.rs-peers {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 2.6rem;
}
.rs-peers > :first-child {
  --rs-label-w: 10rem;
}
.rs-peers > :not(:first-child) {
  --rs-label-w: auto;
}
.rs-peers :deep(.rs-rank-label) {
  white-space: nowrap;
}

/* Dreadnoughts honoured, with no formal post: a dashed side slot before the first rank. */
.rs-aside {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.9rem;
  margin: 0.2rem 0;
  padding: 0.55rem 0.8rem;
  border: 1px dashed rgba(223, 184, 91, 0.45);
  border-radius: 3px;
  background: rgba(223, 184, 91, 0.04);
}
.rs-aside-label {
  font-family: var(--font-mono);
  font-size: 0.64rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--color-gold);
}
.rs-aside-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.38rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Unassigned: plain rows, no spine. */
.rs-no-spine .rs-step {
  padding-left: 0;
}
.rs-no-spine .rs-step::before {
  display: none;
}

@media (max-width: 760px) {
  .rs-ladder {
    padding: 0.4rem 0.8rem 1rem;
  }
  .rs-step {
    padding-left: 1.7rem;
  }
  .rs-lateral {
    padding-left: 3rem;
  }
  .rs-lateral .rs-node {
    left: 1.8rem;
  }
  .rs-lateral::after {
    width: 1.2rem;
  }
  .rs-peers > :first-child {
    --rs-label-w: auto;
  }
  .rs-no-spine .rs-step {
    padding-left: 0;
  }
}
</style>
