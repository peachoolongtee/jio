<script setup>
// One stop of an itinerary: the time and duration on one line ("15:00 · 45 min"), the name,
// the category as an icon only, and the price tier.
//   <StopCard :number="1" time="15:00" :duration="45" name="Tiong Bahru Bakery" category="drink" :price="14" area="Tiong Bahru" />
// Slots: `actions` (buttons such as "Delete stop"), default (extra content).
import CategoryIcon from '../ui/CategoryIcon.vue'
import PriceTier from '../ui/PriceTier.vue'
import { timeAndDuration } from '@/lib/planner/format.js'

defineProps({
  time: { type: [String, Number], required: true },
  duration: { type: Number, required: true },
  name: { type: String, required: true },
  category: { type: String, required: true },
  price: { type: Number, required: true },
  // Where it is, for example "Bishan".
  area: { type: String, default: '' },
  // The stop's number, matching its pin on the map.
  number: { type: Number, default: 0 },
  // Lifts the card, for example while it is selected on the map.
  lifted: { type: Boolean, default: false },
})
</script>

<template>
  <article class="stop" :class="{ 'is-lifted': lifted }" :aria-label="name">
    <span v-if="number" class="stop__number" aria-hidden="true">{{ number }}</span>
    <div class="stop__text">
      <span class="caption text-brand">{{ timeAndDuration(time, duration) }}</span>
      <h3 class="title-md clamp-2">{{ name }}</h3>
      <p class="stop__meta">
        <CategoryIcon :category="category" :size="24" />
        <PriceTier :price="price" />
        <span v-if="area" class="caption-sm text-muted truncate">{{ area }}</span>
      </p>
    </div>
    <div v-if="$slots.actions" class="stop__actions"><slot name="actions" /></div>
    <slot />
  </article>
</template>

<style scoped>
.stop { position: relative; display: flex; align-items: flex-start; gap: var(--spacing-md); padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.stop.is-lifted { z-index: 2; border-color: var(--primary); box-shadow: var(--shadow-float); }
.stop__number { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); font: var(--text-caption); }
.stop__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-xs); }
.stop__meta { display: flex; align-items: center; gap: var(--spacing-sm); min-width: 0; }
.stop__actions { flex-shrink: 0; display: flex; align-items: center; gap: var(--spacing-xs); }
</style>
