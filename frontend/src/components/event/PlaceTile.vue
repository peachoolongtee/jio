<script setup>
// A place near the meeting point, as a tall card for Home's carousel (PlaceCarousel; walkthrough, 30 October 2026). The photo of the kind
// of place on top, then its category as a tag, the name, where it is and how far, and a footer with the price tier, the rating and a
// round arrow that says the card opens. PlaceCard is the same place as a row, for lists.
//   <PlaceTile :place="venue" />
// `morph` gives the card and its photo the view-transition names PlaceDetail uses, so the card grows into the detail view and back
// (LandingView runs it), as PlaceCard does. Hovering lifts the card, zooms the photo a little and turns the arrow; none of it under
// reduced motion.
import AppIcon from '../ui/AppIcon.vue'
import CategoryIcon from '../ui/CategoryIcon.vue'
import PriceTier from '../ui/PriceTier.vue'
import RatingBadge from '../ui/RatingBadge.vue'
import { placeImage } from '@/lib/placeImages.js'
import { CATEGORY_LABELS } from '@/lib/planner/slots.js'

const props = defineProps({
  place: { type: Object, required: true },
  morph: { type: Boolean, default: false },
})
const vt = (name) => (props.morph ? { viewTransitionName: name } : null)
</script>

<template>
  <article class="tile" :aria-label="place.name" :style="vt('place-card')">
    <div class="tile__plate">
      <img class="tile__photo" :style="vt('place-photo')" :src="placeImage(place)" alt="" loading="lazy" width="260" height="140" />
    </div>
    <div class="tile__body">
      <p class="tile__tag caption-sm text-muted"><CategoryIcon :category="place.category" :size="22" />{{ CATEGORY_LABELS[place.category] || 'Place' }}</p>
      <h3 class="title-md clamp-2">{{ place.name }}</h3>
      <p class="caption-sm text-muted truncate">{{ place.area }} · {{ place.distanceKm }} km</p>
      <div class="tile__foot">
        <span class="tile__facts">
          <PriceTier :price="place.price" />
          <RatingBadge v-if="place.rating != null" :score="place.rating" />
        </span>
        <span class="tile__go" aria-hidden="true"><AppIcon name="arrow-right" :size="16" /></span>
      </div>
    </div>
  </article>
</template>

<style scoped>
/* A flat white card with a hairline, the photo across its top. It lifts on hover, as a card that is a link does. */
.tile { display: flex; flex-direction: column; height: 100%; overflow: hidden; border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); transition: box-shadow var(--motion-fast) var(--ease-out), transform 260ms var(--ease-spring); }
.tile__plate { height: 140px; overflow: hidden; background: var(--surface-strong); }
.tile__photo { width: 100%; height: 100%; object-fit: cover; transition: transform 500ms var(--ease-out); }
.tile__body { display: flex; flex: 1; flex-direction: column; gap: var(--spacing-xs); padding: var(--spacing-md) var(--spacing-base) var(--spacing-base); }
.tile__body p, .tile__body h3 { margin: 0; }
.tile__tag { display: inline-flex; align-items: center; gap: var(--spacing-sm); }
/* The footer: price and rating on the left, the arrow on the right, under a hairline. */
.tile__foot { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); margin-top: auto; padding-top: var(--spacing-md); border-top: 1px solid var(--hairline-soft); }
.tile__facts { display: inline-flex; align-items: center; gap: var(--spacing-md); }
.tile__go { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); transition: transform var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
@media (hover: hover) {
  .tile:hover { box-shadow: var(--shadow-float); transform: translateY(-6px); }
  .tile:hover .tile__photo { transform: scale(1.06); }
  .tile:hover .tile__go { background: var(--ink); color: var(--on-dark); transform: rotate(-45deg); }
}
@media (prefers-reduced-motion: reduce) {
  .tile, .tile__photo, .tile__go { transition: none; }
  .tile:hover, .tile:hover .tile__photo, .tile:hover .tile__go { transform: none; }
}
</style>
