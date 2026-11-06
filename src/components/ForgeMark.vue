<script setup>
// The forge's mark: a flame, an anvil and a hammer on one line, joined by ash hairlines. Only the flame is
// warm. It is geometry, three 24 by 24 cells centred at x = 12, 60 and 108, and it is still: the glow is a
// fixed drop-shadow, never moving.
defineProps({
  muted: { type: Boolean, default: false },
  size: { type: String, default: 'md', validator: (v) => ['md', 'sm'].includes(v) },
})
</script>

<template>
  <svg
    class="forge-mark"
    :class="{ 'is-muted': muted, 'is-sm': size === 'sm' }"
    viewBox="0 0 120 24"
    aria-hidden="true"
    focusable="false"
  >
    <line class="mark-rule" x1="30" y1="12" x2="44" y2="12" />
    <line class="mark-rule" x1="76" y1="12" x2="90" y2="12" />

    <g class="mark-flame">
      <path
        class="flame-body"
        d="M13 2C15 6 20 10 20 15C20 19 16.5 22 12 22C7.5 22 4 19 4 15C4 12 4 9 6.5 6C7 8 8.5 9 10 9C10 6 12 5 13 2Z"
      />
      <path
        class="flame-lick"
        d="M12 21C9.5 21 8 19.5 8 17.5C8 15.5 10 14 11 12C12 14 16 15.5 16 17.5C16 19.5 14.5 21 12 21Z"
      />
    </g>

    <g class="mark-anvil">
      <path d="M50 7C52 5.5 54 4 56 4H69V9H65V14L68 17V20H55V17L58 14V10C55 9.5 53 9 50 7Z" />
    </g>

    <g class="mark-hammer" transform="rotate(35 107 12)">
      <rect class="hammer-haft" x="105.5" y="10" width="3" height="12" rx="0.5" />
      <rect class="hammer-head" x="101" y="4" width="12" height="7" rx="1" />
    </g>
  </svg>
</template>

<style scoped>
.forge-mark {
  display: block;
  flex: none;
  width: 120px;
  height: auto;
  /* The flame's glow reaches past the viewBox; let it. */
  overflow: visible;
}
.forge-mark.is-sm {
  width: 84px;
}
.forge-mark.is-muted {
  opacity: 0.55;
}

.mark-rule {
  stroke: var(--color-ash-2);
  stroke-width: 1;
  /* A hairline stays one pixel at every size, and sits on the pixel grid. */
  vector-effect: non-scaling-stroke;
  shape-rendering: crispEdges;
}

.flame-body {
  fill: var(--color-ember);
}
.flame-lick {
  fill: var(--color-ember-light);
}
/* The one warm thing, and the only filter. Muted, it goes out. */
.mark-flame {
  filter: drop-shadow(0 0 6px color-mix(in srgb, var(--color-ember) 60%, transparent));
}
.forge-mark.is-muted .mark-flame {
  filter: none;
}

.mark-anvil,
.mark-hammer {
  fill: var(--color-basalt-3);
  stroke: var(--color-ash-2);
  stroke-width: 1.5;
}
</style>
