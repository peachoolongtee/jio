<script setup>
// A price as a tier, never a number: $ under SGD 10, $$ SGD 10 to 25, $$$ above SGD 25, per person.
//   <PriceTier :price="12" />
import { computed } from 'vue'
import { priceTier, priceTierLabel } from '@/lib/planner/format.js'

const props = defineProps({
  // Null when the price is not known (a saved place Jio does not know): nothing is drawn.
  price: { type: Number, default: null },
})
const tier = computed(() => priceTier(props.price))
const label = computed(() => priceTierLabel(props.price))
</script>

<template>
  <span v-if="price != null" class="price" :aria-label="label" role="img">
    <span v-for="n in 3" :key="n" :class="{ 'is-off': n > tier.length }" aria-hidden="true">$</span>
  </span>
</template>

<style scoped>
.price { flex-shrink: 0; display: inline-flex; color: var(--ink); font: var(--text-caption); letter-spacing: 0.5px; }
.price .is-off { color: var(--border-strong); }
</style>
