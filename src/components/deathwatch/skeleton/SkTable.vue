<script setup>
// A table whose real column labels are shown over placeholder rows: the shape of a view's table before its
// data exists. It scrolls sideways inside its own wrapper, so a table with many columns never widens the page.
defineProps({
  columns: { type: Array, required: true },
  rows: { type: Number, default: 5 },
})
</script>

<template>
  <div class="sk-scroll">
    <table class="sk-table">
      <thead>
        <tr>
          <th v-for="(label, i) in columns" :key="i" scope="col">{{ label }}</th>
        </tr>
      </thead>
      <tbody aria-hidden="true">
        <tr v-for="r in rows" :key="r">
          <td v-for="(label, i) in columns" :key="i"><span class="dw-sk-bar" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.sk-scroll {
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.sk-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--dw-font-cond);
}
th {
  padding: 0.5rem 0.75rem;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-align: left;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--dw-muted);
  border-bottom: 1px solid var(--dw-line-2);
}
td {
  min-width: 3.5rem;
  padding: 0.7rem 0.75rem;
  border-bottom: 1px solid var(--dw-line);
}
</style>
