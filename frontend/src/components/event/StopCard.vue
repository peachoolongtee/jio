<script setup>
// One stop on the itinerary timeline: a numbered dot on the rail in the category colour (matching the stop's pin
// on the map), the time and duration on one line ("15:00 · 45 min"), the name, the category as an icon,
// where it is, the price tier, and a photo of the kind of place when `image` is set.
//   <StopCard :number="1" time="15:00" :duration="45" name="Tiong Bahru Bakery" category="drink" :price="14" area="Tiong Bahru" :image="src" />
// Put several in a list with the .timeline class (EventView) so the rail joins them.
// Slots: `handle` (a drag handle, on the right), `actions` (buttons such as "Delete stop"). On a phone (480px and
// narrower) the photo and the controls drop under the text, so the name, time, area and price keep the full width.
// The name can take focus from code (tabindex -1), for example to land on the next stop after one is deleted.
// `warning` shows a short error-red line, for example "Closed at 15:00" after the stops were rearranged.
// `banner` shows the photo as a wide strip above the details instead of a thumbnail beside them.
// `mark` is the weather mark under the place's line ("Dry", "Outdoor, showers", "Indoor", "Weather is checked from the day before"), from stopMark in
// lib/weatherText.js; without it the card shows no weather.
import AppIcon from '../ui/AppIcon.vue'
import CategoryIcon from '../ui/CategoryIcon.vue'
import PriceTier from '../ui/PriceTier.vue'
import WeatherMark from '../weather/WeatherMark.vue'
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
  image: { type: String, default: '' },
  banner: { type: Boolean, default: false },
  mark: { type: Object, default: null },
})
</script>

<template>
  <article class="stop" :class="{ 'is-lifted': lifted }" :aria-label="name">
    <span class="stop__dot" :class="`stop__dot--${category}`" aria-hidden="true">{{ number || '' }}</span>
    <div class="stop__body">
      <img v-if="image && banner" class="stop__banner" :src="image" alt="" loading="lazy" />
      <span class="caption tnum">{{ timeAndDuration(time, duration) }}</span>
      <h3 class="stop__name title-md clamp-2" tabindex="-1">{{ name }}</h3>
      <p class="stop__meta">
        <CategoryIcon :category="category" :size="22" />
        <span v-if="area" class="caption-sm text-muted truncate">{{ area }}</span>
        <PriceTier :price="price" />
      </p>
      <p v-if="mark" class="stop__weather"><WeatherMark :mark="mark" /></p>
      <p v-if="warning" class="stop__warning caption-sm"><AppIcon name="warning" :size="12" /> {{ warning }}</p>
    </div>
    <img v-if="image && !banner" class="stop__photo" :src="image" alt="" loading="lazy" width="64" height="64" />
    <div v-if="$slots.actions || $slots.handle" class="stop__actions">
      <slot name="actions" />
      <slot name="handle" />
    </div>
  </article>
</template>

<style scoped>
/* Dot | text | photo | actions, on one row. Phones stack them: see the media query at the end. */
.stop { position: relative; display: grid; grid-auto-flow: column; grid-template-columns: 28px minmax(0, 1fr); grid-auto-columns: auto; align-items: start; gap: var(--spacing-md); padding: var(--spacing-xs) 0; border-radius: var(--rounded-sm); background: var(--canvas); }
.stop__dot { position: relative; z-index: 1; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; margin-top: 2px; border-radius: var(--rounded-full); background: var(--ink); box-shadow: 0 0 0 4px var(--canvas); color: var(--on-dark); font: var(--text-caption); }
.stop__dot--eat { background: var(--cat-eat-fg); }
.stop__dot--drink { background: var(--cat-drink-fg); }
.stop__dot--shop { background: var(--cat-shop-fg); }
.stop__dot--activity { background: var(--cat-activity-fg); }
.stop__body { display: flex; flex-direction: column; gap: var(--spacing-xxs); min-width: 0; }
.stop__meta { display: flex; align-items: center; gap: var(--spacing-sm); min-width: 0; margin-top: var(--spacing-xxs); }
.stop__weather { display: flex; margin-top: var(--spacing-xxs); }
.stop__warning { display: inline-flex; align-items: center; gap: var(--spacing-xs); margin-top: var(--spacing-xxs); color: var(--primary-error-text); }
.stop__banner { display: block; width: 100%; height: 120px; margin-bottom: var(--spacing-sm); object-fit: cover; border-radius: var(--rounded-sm); background: var(--surface-strong); }
.stop__photo { width: 64px; height: 64px; object-fit: cover; border-radius: var(--rounded-sm); background: var(--surface-strong); }
.stop__actions { display: flex; align-items: center; gap: var(--spacing-xs); }
.stop__name:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: var(--rounded-xs); }
.stop.is-lifted .stop__dot { background: var(--primary); }

/* 480px and narrower: dot | text on the first row; the photo and then the controls get a row of their own under the
   text, so nothing squeezes the name. The controls sit at the end of their row. */
@media (max-width: 480px) {
  .stop { grid-auto-flow: row; grid-auto-columns: auto; row-gap: var(--spacing-xs); }
  .stop__dot { grid-column: 1; grid-row: 1; }
  .stop__body { grid-column: 2; grid-row: 1; }
  .stop__photo { grid-column: 2; grid-row: auto; }
  .stop__actions { grid-column: 2; grid-row: auto; justify-content: flex-end; }
}
</style>
