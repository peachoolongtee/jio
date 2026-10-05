<script setup>
// A place near Ian on Home: a category plate, the name, where it is, the price tier and the rating.
//   <PlaceCard :place="venue" />
import { computed } from 'vue'
import CategoryIcon from '../ui/CategoryIcon.vue'
import InfoTag from '../ui/InfoTag.vue'
import PriceTier from '../ui/PriceTier.vue'
import RatingBadge from '../ui/RatingBadge.vue'

const props = defineProps({
  place: { type: Object, required: true },
})
const tags = computed(() => {
  const t = props.place.tags || []
  const out = []
  if (t.includes('hidden')) out.push('Hidden gem')
  if (t.includes('touristy')) out.push('Touristy')
  if (t.includes('cdc')) out.push('CDC Vouchers')
  return out
})
</script>

<template>
  <article class="place" :aria-label="place.name">
    <div class="place__plate" :class="`place__plate--${place.category}`">
      <CategoryIcon :category="place.category" :size="48" />
    </div>
    <div class="place__text">
      <div class="place__top">
        <h3 class="title-md clamp-2">{{ place.name }}</h3>
        <RatingBadge :score="place.rating" />
      </div>
      <p class="caption-sm text-muted">{{ place.area }} · {{ place.distanceKm }} km</p>
      <div class="place__tags">
        <PriceTier :price="place.price" />
        <InfoTag v-for="tag in tags" :key="tag">{{ tag }}</InfoTag>
      </div>
    </div>
  </article>
</template>

<style scoped>
.place { display: flex; gap: var(--spacing-md); padding: var(--spacing-md); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.place__plate { flex-shrink: 0; display: flex; align-items: center; justify-content: center; width: 88px; height: 88px; border-radius: var(--rounded-sm); }
.place__plate--eat { background: var(--cat-eat-bg); }
.place__plate--drink { background: var(--cat-drink-bg); }
.place__plate--shop { background: var(--cat-shop-bg); }
.place__plate--activity { background: var(--cat-activity-bg); }
.place__plate :deep(.cat) { background: var(--canvas); }
.place__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-xs); }
.place__top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing-sm); }
.place__tags { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); margin-top: auto; }
</style>
