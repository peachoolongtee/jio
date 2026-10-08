<script setup>
// The colour of each category on the map, for the categories it shows. Sits over a corner of a PlannerMap.
//   <CategoryKey :categories="['eat', 'activity']" />
import { computed } from 'vue'
import { CATEGORIES, CATEGORY_LABELS } from '@/lib/planner/slots.js'

const props = defineProps({
  categories: { type: Array, default: () => CATEGORIES },
})
// In the usual order, each once.
const shown = computed(() => CATEGORIES.filter((c) => props.categories.includes(c)))
</script>

<template>
  <p v-if="shown.length" class="cat-key" aria-label="Map colours by category">
    <span v-for="c in shown" :key="c" class="cat-key__item"><span class="cat-key__dot" :class="`cat-key__dot--${c}`" />{{ CATEGORY_LABELS[c] }}</span>
  </p>
</template>

<style scoped>
.cat-key { position: absolute; left: var(--spacing-sm); bottom: var(--spacing-xl); z-index: 500; display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); margin: 0; padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--rounded-full); background: var(--canvas); box-shadow: var(--shadow-float); font: var(--text-caption-sm); }
.cat-key__item { display: inline-flex; align-items: center; gap: var(--spacing-xs); }
.cat-key__dot { width: 10px; height: 10px; border-radius: var(--rounded-full); }
.cat-key__dot--eat { background: var(--cat-eat-fg); }
.cat-key__dot--drink { background: var(--cat-drink-fg); }
.cat-key__dot--shop { background: var(--cat-shop-fg); }
.cat-key__dot--activity { background: var(--cat-activity-fg); }
</style>
