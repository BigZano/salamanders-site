<script setup>
// Tiles cut from a uniform's sprite: one strip of `count` equal tiles, each shown by its index.
defineProps({
  sprite: { type: String, required: true },
  tiles: { type: Array, required: true },
  count: { type: Number, required: true },
})
</script>

<template>
  <div class="ah-tiles" aria-hidden="true">
    <i
      v-for="i in tiles"
      :key="i"
      class="ah-tile"
      :style="{
        backgroundImage: `url(${sprite})`,
        backgroundPosition: `${(i / (count - 1)) * 100}% 0`,
        backgroundSize: `${count * 100}% 100%`,
      }"
    />
  </div>
</template>

<style scoped>
.ah-tiles {
  display: flex;
  gap: 8px;
}
.ah-tile {
  display: block;
  width: min(112px, calc(50% - 4px));
  aspect-ratio: 160 / 234;
  background-repeat: no-repeat;
  border: 1px solid var(--dw-line-2);
  clip-path: polygon(5px 0, calc(100% - 5px) 0, 100% 5px, 100% calc(100% - 5px), calc(100% - 5px) 100%, 5px 100%, 0 calc(100% - 5px), 0 5px);
}
</style>
