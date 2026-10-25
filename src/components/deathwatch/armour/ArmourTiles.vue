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
/* Two tiles share the card's width (a part with one tile takes one column); --tiles changes the count. */
.ah-tiles {
  display: grid;
  grid-template-columns: repeat(var(--tiles, 2), minmax(0, 1fr));
  gap: 8px;
  max-width: var(--tiles-max, 15rem);
}
.ah-tile {
  display: block;
  aspect-ratio: 160 / 234;
  background-repeat: no-repeat;
  border: 1px solid var(--dw-line-2);
  background-color: var(--dw-bg);
  clip-path: polygon(5px 0, calc(100% - 5px) 0, 100% 5px, 100% calc(100% - 5px), calc(100% - 5px) 100%, 5px 100%, 0 calc(100% - 5px), 0 5px);
}
</style>
