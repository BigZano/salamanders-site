<script setup>
// An Armouring Hall tab: the uniform its address names (/armouringhall/<tab>/<item>), or the tab's first.
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { UNIFORMS, uniformFor } from '../../../lib/deathwatch/armour'
import ArmourView from './ArmourView.vue'
import HeraldryView from './HeraldryView.vue'

const props = defineProps({ tab: { type: String, required: true }, label: { type: String, required: true } })
const route = useRoute()
const current = computed(() => uniformFor(props.tab, route.params.sub))
</script>

<template>
  <div class="dw-page">
    <h2 class="dw-sr-only">{{ label }}</h2>
    <component :is="current.heraldry ? HeraldryView : ArmourView" :label="label" :tab="tab" :list="UNIFORMS[tab]" :current="current" />
  </div>
</template>
