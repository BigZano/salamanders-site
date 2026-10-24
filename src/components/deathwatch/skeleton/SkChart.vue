<script setup>
// The plot area of a chart before there is data: a frame with an axis along the left and the bottom.
</script>

<template>
  <div class="sk-chart" aria-hidden="true">
    <span class="sk-axis sk-axis-y" />
    <span class="sk-axis sk-axis-x" />
    <span class="dw-sk-bar sk-hint" />
  </div>
</template>

<style scoped>
.sk-chart {
  position: relative;
  min-height: 12rem;
  border: 1px solid var(--dw-line);
  background: color-mix(in oklab, var(--dw-surface) 70%, transparent);
}
.sk-axis {
  position: absolute;
  background: var(--dw-line-2);
}
.sk-axis-y {
  inset: 0.75rem auto 1.5rem 2rem;
  width: 1px;
}
.sk-axis-x {
  inset: auto 0.75rem 1.5rem 2rem;
  height: 1px;
}
.sk-hint {
  position: absolute;
  inset: 40% 25% auto 25%;
  height: 0.5rem;
}
</style>
