<script setup>
// A star and a score out of 10, always with one decimal: 8.6.
// Usage: <RatingBadge :score="8.6" />
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  score: { type: Number, required: true },
  large: { type: Boolean, default: false },
})

const text = computed(() => props.score.toFixed(1))
</script>

<template>
  <span class="rating" :class="{ 'rating--large': large }" :aria-label="`Score ${text} out of 10`">
    <AppIcon name="star" :size="large ? 20 : 12" />
    <span aria-hidden="true">{{ text }}</span>
  </span>
</template>

<style scoped>
.rating { flex-shrink: 0; display: inline-flex; align-items: center; gap: var(--spacing-xs); color: var(--star-rating); font: var(--text-caption); }
.rating--large { font: var(--text-display-xl); }
</style>
