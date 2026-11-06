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
        d="M17 2C18 7 22 11 21 16C21 19.5 18.5 22 15 22H9C5.5 22 3 19.5 3 16C3 12.5 4.5 10 7 7C7.5 9.5 9 11 11 13C11 9 15 7 17 2Z"
      />
      <path
        class="flame-lick"
        d="M15.5 8C16 11 19 13.5 18 17C18 19 16 20.5 14 20.5H10C8 20.5 6.5 19 6.5 17C6.5 15 7 13.5 9 12C9.5 13.5 10 14.5 11 15C11 13 14 11.5 15.5 8Z"
      />
      <path
        class="flame-core"
        d="M12.5 13C13 15 14.5 16.5 14.5 18V19.5H10V18C10 16 11.5 15 12.5 13Z"
      />
    </g>

    <g class="mark-anvil">
      <path d="M50 6.5C52 5 54 3 56 3H69V9H65V14L68 17V21H55V17L58 14V10C55 9.5 53 8.5 50 6.5Z" />
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
/* The hollow of the furnace mouth: the one dark thing inside the fire. */
.flame-core {
  fill: var(--color-obsidian);
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
  /* Smoke, not ash-2: the cold marks have to show on obsidian at 120px. The hairlines stay faint. */
  stroke: var(--color-smoke);
  stroke-width: 1.5;
}
</style>
