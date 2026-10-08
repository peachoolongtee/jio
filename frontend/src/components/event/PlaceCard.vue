<script setup>
// A place near Ian on Home: a category plate, the name, where it is, the price tier and the rating.
//   <PlaceCard :place="venue" />
import CategoryIcon from '../ui/CategoryIcon.vue'
import PriceTier from '../ui/PriceTier.vue'
import RatingBadge from '../ui/RatingBadge.vue'

defineProps({
  place: { type: Object, required: true },
})
</script>

<template>
  <article class="place" :aria-label="place.name">
    <div class="place__plate">
      <CategoryIcon :category="place.category" :size="48" />
    </div>
    <div class="place__text">
      <div class="place__top">
        <h3 class="title-md clamp-2">{{ place.name }}</h3>
        <RatingBadge :score="place.rating" />
      </div>
      <p class="caption-sm text-muted">{{ place.area }} · {{ place.distanceKm }} km</p>
      <PriceTier class="place__price" :price="place.price" />
    </div>
  </article>
</template>

<style scoped>
/* A property-card-like row: a photo plate (Surface Strong, 14px corners) and the meta beside it. Flat, hairline. */
.place { display: flex; gap: var(--spacing-md); padding: var(--spacing-sm); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); transition: box-shadow var(--motion-fast) var(--ease-out); }
.place__plate { flex-shrink: 0; display: flex; align-items: center; justify-content: center; width: 84px; height: 84px; border-radius: var(--rounded-sm); background: var(--surface-strong); }
.place__plate :deep(.cat) { background: var(--canvas); }
.place__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-xs); padding: var(--spacing-xs) var(--spacing-xs) var(--spacing-xs) 0; }
.place__top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing-sm); }
.place__price { margin-top: auto; }
@media (hover: hover) { .place:hover { box-shadow: var(--shadow-float); } }
</style>
