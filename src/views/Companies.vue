<script setup>
import { ref, computed } from 'vue'
import companies from '../data/companies.json'

const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return companies
  return companies.filter((c) =>
    (c.title + ' ' + c.subtitle + ' ' + (c.keywords || '')).toLowerCase().includes(q),
  )
})

// Initials from first + last word of a name, for the member badge.
function initials(name) {
  const words = name.replace(/[",]/g, '').trim().split(/\s+/)
  const a = words[0]?.[0] || ''
  const b = words.length > 1 ? words[words.length - 1][0] : ''
  return (a + b).toUpperCase()
}
</script>

<template>
  <section class="companies">
    <header class="c-head">
      <p class="eyebrow">The Chapter</p>
      <h1 class="c-title">Companies &amp; Sections</h1>
      <p class="c-intro">
        The XVIII Legion is forged from many hearths. These are our companies and
        institutions — and the brothers who hold the line.
      </p>
      <input
        v-model="query"
        class="c-search"
        type="search"
        placeholder="Search companies, sections, brothers…"
        aria-label="Search companies"
      />
    </header>

    <!-- Company index -->
    <nav class="c-index" aria-label="Jump to company">
      <a v-for="c in filtered" :key="c.id" :href="`#${c.id}`" class="c-chip">
        <span class="c-chip-sigil">{{ c.sigil }}</span>
        <span>{{ c.title.replace(/ — .*/, '') }}</span>
      </a>
    </nav>

    <p v-if="!filtered.length" class="c-empty">No companies match “{{ query }}”.</p>

    <!-- Companies -->
    <article v-for="c in filtered" :id="c.id" :key="c.id" class="company">
      <div class="company-head">
        <span class="sigil">{{ c.sigil }}</span>
        <div>
          <h2 class="company-title">{{ c.title }}</h2>
          <p class="company-sub">{{ c.subtitle }}</p>
        </div>
      </div>

      <div class="company-body">
        <section v-for="(s, i) in c.sections" :key="i" class="block">
          <h3 class="block-h">{{ s.h }}</h3>

          <template v-if="s.p">
            <p v-for="(para, j) in s.p" :key="j" class="block-p">{{ para }}</p>
          </template>

          <ul v-if="s.list" class="block-list">
            <li v-for="(item, j) in s.list" :key="j">{{ item }}</li>
          </ul>

          <div v-if="s.notables" class="notables">
            <div v-for="(m, j) in s.notables" :key="j" class="member panel-forge">
              <span class="avatar">{{ initials(m[0]) }}</span>
              <div class="member-text">
                <p class="member-name">{{ m[0] }}</p>
                <p class="member-blurb">{{ m[1] }}</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </article>
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
.c-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(2.2rem, 7vw, 3.6rem);
  letter-spacing: 0.01em;
  margin: 0.4rem 0 0.6rem;
  color: var(--color-bone);
}
.c-intro {
  color: var(--color-smoke);
  max-width: 52ch;
  line-height: 1.6;
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
.c-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.7rem 0.35rem 0.4rem;
  border: 1px solid var(--color-ash);
  border-radius: 999px;
  font-size: 0.8rem;
  color: var(--color-smoke);
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

.company {
  scroll-margin-top: 5rem;
  margin-bottom: 3.5rem;
}
.company-head {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.4rem;
}
.sigil {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 3.2rem;
  height: 3.2rem;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.3rem;
  color: var(--color-gold);
  background: linear-gradient(180deg, rgba(223, 184, 91, 0.14), rgba(223, 184, 91, 0.03));
  border: 1px solid rgba(223, 184, 91, 0.35);
  clip-path: polygon(15% 0, 85% 0, 100% 50%, 85% 100%, 15% 100%, 0 50%);
}
.company-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(1.4rem, 4vw, 2rem);
  letter-spacing: 0.01em;
  color: var(--color-bone);
  line-height: 1.05;
}
.company-sub {
  color: var(--color-drake);
  font-size: 0.92rem;
  margin-top: 0.3rem;
}

.block {
  margin: 0 0 1.6rem;
}
.block-h {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.74rem;
  color: var(--color-gold);
  margin-bottom: 0.6rem;
  padding-left: 0.9rem;
  border-left: 2px solid var(--color-ember);
}
.block-p {
  color: #c3d0c6;
  line-height: 1.65;
  margin-bottom: 0.7rem;
  max-width: 62ch;
}
.block-list {
  list-style: none;
  padding: 0;
  margin: 0;
  max-width: 62ch;
}
.block-list li {
  position: relative;
  padding-left: 1.3rem;
  margin-bottom: 0.5rem;
  color: #c3d0c6;
  line-height: 1.55;
}
.block-list li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0.55em;
  width: 7px;
  height: 7px;
  transform: rotate(45deg);
  background: var(--color-ember);
}

.notables {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
  gap: 0.8rem;
  margin-top: 0.4rem;
}
.member {
  display: flex;
  gap: 0.8rem;
  padding: 1rem;
  border-radius: 4px;
}
.avatar {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.6rem;
  height: 2.6rem;
  border-radius: 50%;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 0.9rem;
  color: #1a0d06;
  background: linear-gradient(180deg, #ffb066, #ff6a2b);
}
.member-name {
  font-weight: 600;
  color: var(--color-bone);
  font-size: 0.92rem;
  margin-bottom: 0.25rem;
}
.member-blurb {
  color: var(--color-smoke);
  font-size: 0.85rem;
  line-height: 1.5;
}
.c-empty {
  color: var(--color-smoke);
  padding: 2rem 0;
}

@media (max-width: 600px) {
  .companies {
    padding-top: 3rem;
  }
  .sigil {
    width: 2.6rem;
    height: 2.6rem;
    font-size: 1.1rem;
  }
}
</style>
