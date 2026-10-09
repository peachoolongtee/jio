<script setup>
// A place opened from its card on Home: the photo, name, rating and price, the exact address apart from the
// distance, "Navigate" (Google Maps directions in a new tab), and sample reviews: your friends' first, then other
// people on Jio. A friend's review is tagged Friend; anyone else's has Add friend, so you can add them from here.
// A "Sample data for the demo" note under the name says the place details and reviews are demo content.
//   <PlaceDetail :place="place" :reviews="reviews" @close="close" />
// `place` is the card's own data, so the view draws at once; `reviews` follow from api.getPlace (null while loading).
// The panel, photo, name, rating and price carry the same view-transition names as a PlaceCard with `morph`,
// so the card grows into this view and shrinks back into the grid. LandingView runs that transition.
// `error` is the message to show when the place could not be loaded; the view stays open with a Close button.
// Full screen on phones, a large centred panel on wider screens. Escape, the backdrop and Back close it. Focus stays
// inside while it is open and returns to the card that opened it.
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { format } from 'date-fns'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import CategoryIcon from '../ui/CategoryIcon.vue'
import IconButton from '../ui/IconButton.vue'
import PriceTier from '../ui/PriceTier.vue'
import RatingBadge from '../ui/RatingBadge.vue'
import SampleNote from '../ui/SampleNote.vue'
import SkeletonRow from '../ui/SkeletonRow.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import { directionsUrl } from '@/lib/maps.js'
import { useGroupsStore } from '@/stores/groups.js'
import { placeImage, placeKind } from '@/lib/placeImages.js'
import { useFocusTrap } from '@/lib/useFocusTrap.js'

const KIND_LABELS = {
  hawker: 'Hawker centre', restaurant: 'Restaurant', cafe: 'Café', dessert: 'Dessert', bar: 'Bar', mall: 'Mall', market: 'Market',
  park: 'Park', museum: 'Museum', cinema: 'Cinema', library: 'Library', sports: 'Sports', attraction: 'Attraction',
}

const props = defineProps({
  place: { type: Object, required: true },
  reviews: { type: Array, default: null },
  // Where the distance is measured from: "home", or the meetup's area ("Serangoon").
  from: { type: String, default: 'home' },
  error: { type: String, default: '' },
})
const emit = defineEmits(['close'])

const titleId = `place-${useId()}`
const panel = ref(null)
const open = ref(true)
const kind = computed(() => KIND_LABELS[placeKind(props.place)])
const mapsUrl = computed(() => directionsUrl(props.place))
const reviewDate = (date) => format(new Date(date), 'd MMM yyyy')

// Focus moves into the view, Tab stays inside it, and focus goes back to the opener when it closes.
const { onKeydown } = useFocusTrap(open, panel, { restoreOnUnmount: true })

// Who is a friend, from the people list (loaded here if Home has not yet).
const groups = useGroupsStore()
if (!groups.people.length) groups.loadPeople()
const isFriend = (id) => !!groups.people.find((p) => p.id === id)?.isFriend
const adding = ref('')
const sorted = computed(() => (props.reviews ? [...props.reviews].sort((a, b) => isFriend(b.personId) - isFriend(a.personId)) : null))
const friendCount = computed(() => (props.reviews || []).filter((r) => isFriend(r.personId)).length)
async function addFriend(id) {
  adding.value = id
  await groups.setFriend(id, true)
  adding.value = ''
}

// Keep the page behind still (and its scroll position), and keep its scrollbar's space so nothing shifts.
onMounted(() => {
  const root = document.documentElement
  root.style.scrollbarGutter = 'stable'
  root.style.overflow = 'hidden'
})
onBeforeUnmount(() => {
  document.documentElement.style.overflow = ''
  document.documentElement.style.scrollbarGutter = ''
})
</script>

<template>
  <Teleport to="body">
    <div class="pd" @keydown.esc="emit('close')" @keydown="onKeydown">
      <button class="pd__scrim" type="button" tabindex="-1" aria-label="Close" @click="emit('close')" />
      <article ref="panel" class="pd__panel" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1" style="view-transition-name: place-card">
        <div class="pd__hero">
          <img class="pd__photo" style="view-transition-name: place-photo" :src="placeImage(place)" alt="" />
          <span class="pd__credit caption-sm">Illustrative photo</span>
          <IconButton class="pd__back" label="Back" @click="emit('close')"><AppIcon name="back" /></IconButton>
        </div>

        <div class="pd__body">
          <header class="pd__head">
            <p class="pd__kind caption text-muted"><CategoryIcon :category="place.category" :size="24" /> {{ kind }}</p>
            <h2 :id="titleId" class="display-md pd__name" style="view-transition-name: place-name">{{ place.name }}</h2>
            <SampleNote />
            <div class="pd__facts">
              <RatingBadge v-if="place.rating != null" large style="view-transition-name: place-rating" :score="place.rating" />
              <PriceTier class="pd__price" style="view-transition-name: place-price" :price="place.price" />
            </div>
          </header>

          <!-- Where it is: the exact address, then how far it is, set apart so the two never blur together. -->
          <section class="pd__where" aria-label="Location">
            <div class="pd__address">
              <span class="pd__pin"><AppIcon name="pin" :size="18" /></span>
              <span class="pd__address-text">
                <span class="caption text-muted">Address</span>
                <span class="title-sm">{{ place.address || `${place.area}, Singapore` }}</span>
              </span>
            </div>
            <div class="pd__distance">
              <span class="pd__chip"><AppIcon name="route" :size="14" /><span class="tnum">{{ place.distanceKm }} km</span> from {{ from }}</span>
              <span v-if="place.mrt" class="caption-sm text-muted">about {{ place.mrtWalk }} min walk from {{ place.mrt }} MRT</span>
            </div>
          </section>

          <div class="pd__navigate">
            <AppButton block :href="mapsUrl" target="_blank" :aria-describedby="`${titleId}-navigate`">
              <AppIcon name="route" />
              Navigate
            </AppButton>
            <p :id="`${titleId}-navigate`" class="caption-sm text-muted">Opens Google Maps in a new tab.</p>
          </div>

          <section class="pd__reviews" :aria-labelledby="`${titleId}-reviews`">
            <div class="pd__reviews-head">
              <h3 :id="`${titleId}-reviews`" class="title-md">Sample reviews</h3>
              <span v-if="reviews" class="caption text-muted">{{ reviews.length }} {{ reviews.length === 1 ? 'review' : 'reviews' }} · {{ friendCount }} from friends</span>
            </div>
            <div v-if="error" class="pd__error" role="alert">
              <p class="body-sm text-error">{{ error }}</p>
              <AppButton variant="secondary" @click="emit('close')">Close</AppButton>
            </div>
            <div v-else-if="!reviews" class="stack gap-md" aria-busy="true">
              <SkeletonRow v-for="n in 3" :key="n" avatar :lines="2" />
            </div>
            <ul v-else class="pd__list">
              <li v-for="review in sorted" :key="review.id" class="review">
                <div class="review__top">
                  <UserAvatar :name="review.name" :person="review.personId" :size="32" />
                  <span class="review__who">
                    <span class="review__name">
                      <RouterLink :to="`/people/${review.personId}`" class="title-sm review__link">{{ review.name }}</RouterLink>
                      <span v-if="isFriend(review.personId)" class="review__friend caption-sm"><AppIcon name="check" :size="12" />Friend</span>
                      <button v-else type="button" class="review__add caption" :disabled="adding === review.personId" @click="addFriend(review.personId)">
                        <AppIcon name="user-plus" :size="14" />Add friend
                      </button>
                    </span>
                    <span class="caption-sm text-muted">{{ reviewDate(review.date) }}</span>
                  </span>
                  <RatingBadge :score="review.rating" />
                </div>
                <p class="body-sm review__text">{{ review.text }}</p>
              </li>
            </ul>
            <p v-if="reviews && !reviews.length" class="body-sm text-muted">No sample reviews for this place.</p>
          </section>
        </div>
      </article>
    </div>
  </Teleport>
</template>

<style scoped>
.pd { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; }
.pd__scrim { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; background: var(--scrim); opacity: 0.4; cursor: default; }
/* Phones: the card fills the screen. Wider screens: a large panel in the middle, the page dimmed behind. */
.pd__panel { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; overflow-y: auto; overscroll-behavior: contain; background: var(--canvas); outline: none; }
@media (min-width: 768px) {
  .pd__panel { width: min(640px, calc(100% - var(--spacing-xl) * 2)); height: auto; max-height: calc(100dvh - var(--spacing-xl) * 2); border-radius: var(--rounded-lg); box-shadow: var(--shadow-float); }
}
.pd__hero { position: relative; flex-shrink: 0; }
.pd__photo { display: block; width: 100%; height: clamp(220px, 34vh, 320px); object-fit: cover; background: var(--surface-strong); }
.pd__credit { position: absolute; right: var(--spacing-md); bottom: var(--spacing-md); padding: var(--spacing-xxs) var(--spacing-sm); border-radius: var(--rounded-full); background: color-mix(in srgb, var(--scrim) 60%, transparent); color: var(--on-dark); }
.pd__back { position: absolute; top: var(--spacing-md); left: var(--spacing-md); background: var(--canvas); box-shadow: var(--shadow-float); }
.pd__body { display: flex; flex-direction: column; gap: var(--spacing-lg); padding: var(--spacing-lg); }
.pd__head { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.pd__kind { display: inline-flex; align-items: center; gap: var(--spacing-sm); margin: 0; }
/* Long names wrap; they never push the rating off the screen. */
.pd__name { margin: 0; overflow-wrap: anywhere; }
.pd__facts { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-base); }
.pd__price { font: var(--text-title-md); }
.pd__where { display: flex; flex-direction: column; gap: var(--spacing-md); padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); }
.pd__address { display: flex; align-items: flex-start; gap: var(--spacing-md); }
.pd__pin { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); }
.pd__address-text { display: flex; flex-direction: column; gap: var(--spacing-xxs); min-width: 0; overflow-wrap: anywhere; }
.pd__distance { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); padding-top: var(--spacing-md); border-top: 1px solid var(--hairline-soft); }
.pd__chip { display: inline-flex; align-items: center; gap: var(--spacing-xs); padding: var(--spacing-xxs) var(--spacing-sm); border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); font: var(--text-caption); }
.pd__navigate { display: flex; flex-direction: column; align-items: center; gap: var(--spacing-xs); }
.pd__error { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-md); padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); }
.pd__reviews { display: flex; flex-direction: column; gap: var(--spacing-md); }
.pd__reviews-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--spacing-sm); }
.pd__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.review { display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-base) 0; }
.review + .review { border-top: 1px solid var(--hairline-soft); }
.review__top { display: flex; align-items: center; gap: var(--spacing-md); }
.review__who { flex: 1 1 0; display: flex; flex-direction: column; min-width: 0; }
.review__name { display: flex; flex-wrap: wrap; align-items: center; gap: 2px var(--spacing-sm); }
.review__link { color: var(--ink); text-decoration: none; }
@media (hover: hover) { .review__link:hover { text-decoration: underline; } }
/* A friend: a quiet tag. Anyone else: a small outlined Add friend button. */
.review__friend { display: inline-flex; align-items: center; gap: 3px; padding: 1px 8px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--body); }
.review__add { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); cursor: pointer; }
@media (hover: hover) { .review__add:not(:disabled):hover { border-color: var(--ink); } }
.review__add:disabled { opacity: 0.6; cursor: default; }
.review__text { margin: 0; color: var(--body); }
</style>
