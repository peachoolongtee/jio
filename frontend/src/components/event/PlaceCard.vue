<script setup>
// A place near Ian on Home: a photo of the kind of place with its category, the name, where it is,
// the price tier and the rating.
//   <PlaceCard :place="venue" />
import CategoryIcon from '../ui/CategoryIcon.vue'
import PriceTier from '../ui/PriceTier.vue'
import RatingBadge from '../ui/RatingBadge.vue'
import { placeImage } from '@/lib/placeImages.js'

defineProps({
  place: { type: Object, required: true },
})
</script>

<template>
  <article class="place" :aria-label="place.name">
    <div class="place__plate">
      <img class="place__photo" :src="placeImage(place)" alt="" loading="lazy" width="84" height="84" />
      <CategoryIcon class="place__cat" :category="place.category" :size="28" />
    </div>
    <div class="place__text">
      <div class="place__top">
        <h3 class="title-md clamp-2">{{ place.name }}</h3>
        <RatingBadge v-if="place.rating != null" :score="place.rating" />
      </div>
      <p class="caption-sm text-muted">{{ place.area }} · {{ place.distanceKm }} km</p>
      <PriceTier class="place__price" :price="place.price" />
    </div>
  </article>
</template>

<style scoped>
/* A property-card-like row: a photo plate (14px corners) with its category badge, and the meta beside it. Flat, hairline. */
.place { display: flex; gap: var(--spacing-md); padding: var(--spacing-sm); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); transition: box-shadow var(--motion-fast) var(--ease-out); }
.place__plate { position: relative; flex-shrink: 0; display: flex; align-items: center; justify-content: center; width: 84px; height: 84px; border-radius: var(--rounded-sm); background: var(--surface-strong); }
.place__photo { width: 100%; height: 100%; object-fit: cover; border-radius: var(--rounded-sm); }
.place__cat { position: absolute; right: -6px; bottom: -6px; box-shadow: 0 0 0 2px var(--canvas); }
.place__plate :deep(.cat) { background: var(--canvas); }
.place__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-xs); padding: var(--spacing-xs) var(--spacing-xs) var(--spacing-xs) 0; }
.place__top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing-sm); }
.place__price { margin-top: auto; }
@media (hover: hover) { .place:hover { box-shadow: var(--shadow-float); } }
</style>
