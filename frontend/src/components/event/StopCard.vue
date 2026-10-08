<script setup>
// One stop on the itinerary timeline: a numbered ink dot on the rail, the time and duration on one line
// ("15:00 · 45 min"), the name, the category as an icon only, where it is and the price tier.
//   <StopCard :number="1" time="15:00" :duration="45" name="Tiong Bahru Bakery" category="drink" :price="14" area="Tiong Bahru" />
// Put several in a list with the .timeline class (EventView) so the rail joins them.
// Slots: `handle` (a drag handle, on the right), `actions` (buttons such as "Delete stop").
// `warning` shows a short error-red line, for example "Closed at 15:00" after the stops were rearranged.
import AppIcon from '../ui/AppIcon.vue'
import CategoryIcon from '../ui/CategoryIcon.vue'
import PriceTier from '../ui/PriceTier.vue'
import { timeAndDuration } from '@/lib/planner/format.js'

defineProps({
  time: { type: [String, Number], required: true },
  duration: { type: Number, required: true },
  name: { type: String, required: true },
  category: { type: String, required: true },
  price: { type: Number, required: true },
  area: { type: String, default: '' },
  number: { type: Number, default: 0 },
  warning: { type: String, default: '' },
  // Highlights the stop: its pin is selected on the map, or it is being dragged.
  lifted: { type: Boolean, default: false },
})
</script>

<template>
  <article class="stop" :class="{ 'is-lifted': lifted }" :aria-label="name">
    <span class="stop__dot" aria-hidden="true">{{ number || '' }}</span>
    <div class="stop__body">
      <span class="caption tnum">{{ timeAndDuration(time, duration) }}</span>
      <h3 class="title-md clamp-2">{{ name }}</h3>
      <p class="stop__meta">
        <CategoryIcon :category="category" :size="22" />
        <span v-if="area" class="caption-sm text-muted truncate">{{ area }}</span>
        <PriceTier :price="price" />
      </p>
      <p v-if="warning" class="stop__warning caption-sm"><AppIcon name="warning" :size="12" /> {{ warning }}</p>
    </div>
    <div v-if="$slots.actions || $slots.handle" class="stop__actions">
      <slot name="actions" />
      <slot name="handle" />
    </div>
  </article>
</template>

<style scoped>
.stop { position: relative; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: start; gap: var(--spacing-md); padding: var(--spacing-xs) 0; border-radius: var(--rounded-sm); background: var(--canvas); }
.stop__dot { position: relative; z-index: 1; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; margin-top: 2px; border-radius: var(--rounded-full); background: var(--ink); box-shadow: 0 0 0 4px var(--canvas); color: var(--on-dark); font: var(--text-caption); }
.stop__body { display: flex; flex-direction: column; gap: var(--spacing-xxs); min-width: 0; }
.stop__meta { display: flex; align-items: center; gap: var(--spacing-sm); min-width: 0; margin-top: var(--spacing-xxs); }
.stop__warning { display: inline-flex; align-items: center; gap: var(--spacing-xs); margin-top: var(--spacing-xxs); color: var(--primary-error-text); }
.stop__actions { display: flex; align-items: center; gap: var(--spacing-xs); }
.stop.is-lifted .stop__dot { background: var(--primary); }
</style>
