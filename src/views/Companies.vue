<script setup>
import { ref, computed } from 'vue'
import companies from '../data/companies.json'
import PageHeader from '../components/PageHeader.vue'
import CompanyArticle from '../components/company/CompanyArticle.vue'

const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return companies
  return companies.filter((c) =>
    (c.title + ' ' + c.subtitle + ' ' + (c.keywords || '')).toLowerCase().includes(q),
  )
})

// Scroll to a company. Plain scrollIntoView, not href="#id": the chip is a button, and
// the scroll stays smooth (or not) the way the page's CSS says, reduced motion included.
function jumpTo(id) {
  document.getElementById(id)?.scrollIntoView()
}

// "↑ Index" on a company: back to the chip row, with focus there so the next Tab is a chip.
function backToIndex() {
  const index = document.getElementById('company-index')
  index?.scrollIntoView()
  index?.focus({ preventScroll: true })
}
</script>

<template>
  <section class="companies">
    <PageHeader
      class="c-head"
      eyebrow="The Chapter"
      title="Companies & Sections"
      lede="The XVIII Legion is forged from many hearths. These are our companies and institutions — and the brothers who hold the line."
    >
      <input
        v-model="query"
        class="c-search"
        type="search"
        placeholder="Search companies, sections, brothers…"
        aria-label="Search companies"
      />
    </PageHeader>

    <!-- Company index -->
    <nav id="company-index" class="c-index" aria-label="Jump to company" tabindex="-1">
      <button
        v-for="c in filtered"
        :key="c.id"
        type="button"
        class="c-chip"
        @click="jumpTo(c.id)"
      >
        <span class="c-chip-sigil">{{ c.sigil }}</span>
        <span>{{ c.title.replace(/ — .*/, '') }}</span>
      </button>
    </nav>

    <p v-if="!filtered.length" class="c-empty">No companies match “{{ query }}”.</p>

    <!-- Companies -->
    <CompanyArticle v-for="c in filtered" :key="c.id" :company="c" @index="backToIndex" />
  </section>
</template>

<style scoped>
.companies {
  max-width: 60rem;
  margin: 0 auto;
  padding: 4rem 1.5rem 2rem;
}
.c-head {
  margin-bottom: 2rem;
}
.c-search {
  margin-top: 1.4rem;
  width: 100%;
  max-width: 26rem;
  padding: 0.7rem 1rem;
  background: rgba(14, 28, 22, 0.6);
  border: 1px solid var(--color-ash);
  border-radius: 3px;
  color: var(--color-bone);
  font-size: 0.95rem;
}
.c-search::placeholder {
  color: #5f6f66;
}

.c-index {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 3rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--color-ash);
}
.c-index:focus {
  outline: none; /* focus lands here from "↑ Index"; the chips carry the visible focus */
}
.c-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.7rem 0.35rem 0.4rem;
  border: 1px solid var(--color-ash);
  border-radius: 999px;
  font-size: 0.8rem;
  color: var(--color-smoke);
  background: transparent;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.c-chip:hover {
  color: var(--color-bone);
  border-color: var(--color-drake);
}
.c-chip-sigil {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.4rem;
  height: 1.4rem;
  padding: 0 0.3rem;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 0.72rem;
  color: var(--color-gold);
  background: rgba(223, 184, 91, 0.1);
  border-radius: 999px;
}
.c-empty {
  color: var(--color-smoke);
  padding: 2rem 0;
}

@media (max-width: 600px) {
  .companies {
    padding-top: 3rem;
  }
}
</style>
