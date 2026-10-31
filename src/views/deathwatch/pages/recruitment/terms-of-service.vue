<script setup>
// The Deathwatch Terms of Service, as the old site set them: six sections, each clause numbered by its section,
// sub-section and place. The texts are the old site's (lib/deathwatch/recruitment.js), each replaced by what the
// area's data holds for it.
import { computed, onMounted } from 'vue'
import Inline from '../../../../components/deathwatch/Inline'
import LoadRetry from '../../../../components/deathwatch/LoadRetry.vue'
import { termsOfService } from '../../../../lib/deathwatch/recruitment'
import { useAuth } from '../../../../stores/auth'
import { useDeathwatchData } from '../../../../stores/deathwatchData'
import '../../../../components/deathwatch/recruitment/recruitment.css'

const auth = useAuth()
const data = useDeathwatchData()
// Once: the defaults show at once, and what the data holds replaces them when it arrives.
onMounted(() => {
  if (data.status !== 'ready') data.load(auth.token)
})
const tos = computed(() => termsOfService(data.cfg.tx))
</script>

<template>
  <div class="dw-page rc">
    <LoadRetry v-if="data.status === 'error'">The latest texts could not be loaded.</LoadRetry>
    <header class="rc-head">
      <p class="rc-cls">Watch Fortress Ebonhold</p>
      <h2 class="rc-title">Terms of Service</h2>
      <span class="rc-orn" aria-hidden="true" />
      <p v-for="(line, i) in tos.head" :key="i" class="rc-sub"><Inline :segs="line" /></p>
    </header>
    <div v-if="tos.intro.length" class="rc-intro">
      <p v-for="(p, i) in tos.intro" :key="i" :class="{ 'rc-q': p.quote }"><Inline :segs="p.segs" /></p>
    </div>
    <section v-for="s in tos.sections" :key="s.n" class="rc-s">
      <h3>Section {{ s.n }}<template v-if="s.title.length"> — <Inline :segs="s.title" /></template></h3>
      <template v-for="(sub, j) in s.subs" :key="j">
        <h4 v-if="sub.title.length">{{ s.n }}.{{ j + 1 }} — <Inline :segs="sub.title" /></h4>
        <ol v-if="sub.clauses.length">
          <li v-for="(c, k) in sub.clauses" :key="k"><b class="rc-n">{{ s.n }}.{{ j + 1 }}.{{ k + 1 }}</b> <Inline :segs="c" /></li>
        </ol>
      </template>
    </section>
    <div v-if="tos.end.length" class="rc-intro rc-end">
      <p v-for="(p, i) in tos.end" :key="i" :class="{ 'rc-q': p.quote }"><Inline :segs="p.segs" /></p>
    </div>
  </div>
</template>
