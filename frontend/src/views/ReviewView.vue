<script setup>
// "How was it?": where "Finish outing" goes, and where a finished outing's "How was it?" row leads (/sessions/:id/review).
//   - Arrived straight from finishing: one line says the outing is finished and what it paid (JioCoins, or why none). The flag in
//     the history entry is cleared once read, so a reload or Back does not say it again. When it was the 1st, 5th, 10th (then every
//     10th) outing together with a friend, a second line says so (OutingMilestone), also only on that arrival.
//   - Stars for the outing (StarRating, required), then, folded under it, stars for each stop (optional), and a short note.
//   - "Add your photos": the photos so far as thumbnails, Add photos (the same camera as the Photos page, up to PHOTOS_MAX), and
//     a link to all of them, where they can be shared.
//   - The footer: "Save review" (off until the outing has stars; "Saving…" while it saves, and a failure is said just above it), which
//     saves and goes Home; "Not now" goes Home without saving, and reads "Skip for now" once there are stars or a note that would be
//     lost. Saving again replaces the person's review, and the page opens with their last one filled in. Going to another outing's
//     review (the same page with another address) starts the form again.
//   - Only for the people who went, once the outing has finished. Before that, for an outing that closed without a plan, and for a
//     shared outing (reviews and photos are not on the server yet), the page says so with the way back to the itinerary.
// It belongs to the Itinerary step: its back arrow goes there.
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import CategoryIcon from '@/components/ui/CategoryIcon.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import StarRating from '@/components/ui/StarRating.vue'
import TextField from '@/components/ui/TextField.vue'
import OutingMilestone from '@/components/event/OutingMilestone.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import NotFoundView from './NotFoundView.vue'
import { PHOTOS_MAX, REVIEW_NOTE_MAX } from '@/lib/api.js'
import { coins } from '@/lib/currency.js'
import { compressImage } from '@/lib/image.js'
import { POINTS_PER_MEETUP } from '@/lib/mock/people.js'
import { NO_COINS } from '@/lib/session.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ id: { type: String, required: true } })

const router = useRouter()
const auth = useAuthStore()
const events = useEventsStore()

const missing = ref(false)
const loadError = ref('')
const error = ref('')
const photoError = ref('')
const saving = ref(false)
const uploading = ref(0)
const input = ref(null)
const stars = ref(0)
const stopStars = ref({})
const note = ref('')
// Arrived straight from "Finish outing" (the history entry's flag, cleared once read).
const justFinished = ref(!!window.history.state?.justFinished)
if (justFinished.value) window.history.replaceState({ ...window.history.state, justFinished: false }, '')

const session = computed(() => events.byId[props.id])
const itinerary = computed(() => events.itineraries[props.id])
const photos = computed(() => [...(events.photos[props.id] || [])].reverse())
const mine = computed(() => session.value?.reviews?.[auth.myId] || null)
const went = computed(() => (session.value?.activeIds || []).includes(auth.myId))
// Why this person cannot review this outing, or '' when they can.
const closedWhy = computed(() => {
  const s = session.value
  if (!s) return ''
  if (s.remote) return 'Reviews of shared outings come in a later update.'
  if (s.status !== 'completed') return 'You can review the outing once it has finished.'
  if (s.endedBy === 'closed') return 'This outing closed without a plan, so there is nothing to review.'
  if (!went.value) return 'Only the people who went can review this outing.'
  return ''
})
const paidLine = computed(() => (session.value?.paid === false ? NO_COINS.toast : `+${coins(POINTS_PER_MEETUP)} each to spend on sample café vouchers.`))
const full = computed(() => photos.value.length >= PHOTOS_MAX)

// Reads the outing and, when it can be reviewed, its stops and photos.
// How to call: await load()
async function load() {
  missing.value = false
  loadError.value = ''
  try {
    await events.loadSession(props.id)
  } catch (e) {
    if (e?.code === 'not_found') missing.value = true
    else loadError.value = e?.message || 'Could not load this outing.'
    return
  }
  if (closedWhy.value) return
  // The line about a milestone counts the finished outings, so the list is read when it is to be said.
  if (justFinished.value && !events.loaded) events.loadSessions().catch(() => null)
  try {
    await Promise.all([events.loadItinerary(props.id), events.loadPhotos(props.id)])
  } catch (e) {
    loadError.value = e?.message || 'Could not load this outing.'
  }
}
onMounted(load)

// Puts a saved review into the form, unless the person has already started one.
// How to call: fillFrom({ stars: 4, stops: { eat: 3 }, note: 'Great' })
function fillFrom(review) {
  if (!review || stars.value) return
  stars.value = review.stars
  stopStars.value = { ...review.stops }
  note.value = review.note || ''
}
// The page is not remounted when only the address changes (the router view has no key), so another outing starts a new form: nothing
// typed for the last one stays, and the new outing's own saved review, if it has one, fills it in.
watch(() => props.id, () => {
  stars.value = 0
  stopStars.value = {}
  note.value = ''
  error.value = ''
  photoError.value = ''
  justFinished.value = false
  fillFrom(mine.value)
  load()
})
// The person's last review fills the form in, once, when it is read.
watch(mine, fillFrom, { immediate: true })
// Is there something typed or rated that "Not now" would throw away?
const started = computed(() => stars.value > 0 || note.value.trim() !== '' || Object.values(stopStars.value).some(Boolean))

// Posts the pictures one by one, as the Photos page does: it stops at the first that fails and says why.
// How to call: await onFiles(event) (the file input's change handler)
async function onFiles(event) {
  const files = [...(event.target.files || [])]
  event.target.value = ''
  photoError.value = ''
  for (const file of files) {
    uploading.value += 1
    try {
      await events.addPhoto(props.id, await compressImage(file))
    } catch (e) {
      photoError.value = e.message
      break
    } finally {
      uploading.value -= 1
    }
  }
  try {
    await events.loadPhotos(props.id)
  } catch {
    // The photos were saved; the strip catches up the next time the page opens.
  }
}

// Save the review and go Home.
// How to call: await save()
async function save() {
  if (!stars.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    await events.saveReview(props.id, { stars: stars.value, stops: stopStars.value, note: note.value })
    await router.push('/')
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else-if="session" class="screen" data-testid="review-view">
    <SessionHeader :session="session" title="How was it?" />

    <div class="screen__body review">
      <BannerNote v-if="justFinished" icon="trophy" data-testid="review-finished">Outing finished. {{ paidLine }}</BannerNote>
      <OutingMilestone v-if="justFinished && !closedWhy" :session="session" announce />

      <EmptyState v-if="closedWhy" :title="closedWhy" data-testid="review-closed">
        <AppButton variant="secondary" :to="`/sessions/${id}/itinerary`">Back to the itinerary</AppButton>
      </EmptyState>
      <EmptyState v-else-if="loadError" title="Could not load this outing" :text="loadError" role="alert">
        <AppButton variant="secondary" @click="load">Retry</AppButton>
      </EmptyState>

      <template v-else>
        <section class="review__card card" aria-labelledby="review-stars">
          <h2 id="review-stars" class="display-sm">Rate {{ session.title }}</h2>
          <StarRating v-model="stars" :label="session.title" />
          <p v-if="!stars" class="caption-sm text-muted">Tap a star to rate the outing.</p>
          <TextField v-model="note" label="Anything to remember? (optional)" multiline :maxlength="REVIEW_NOTE_MAX" :hint="`${note.length} of ${REVIEW_NOTE_MAX}`" />
        </section>

        <section v-if="itinerary?.stops?.length" class="review__card card" aria-labelledby="review-stops">
          <div class="stack">
            <h2 id="review-stops" class="title-md">Each stop</h2>
            <p class="caption-sm text-muted">Optional.</p>
          </div>
          <ul class="review__stops">
            <li v-for="stop in itinerary.stops" :key="stop.slotId" class="review__stop">
              <span class="review__stopname">
                <CategoryIcon :category="stop.category" :size="24" />
                <span class="title-sm clamp-2">{{ stop.venue.name }}</span>
              </span>
              <StarRating v-model="stopStars[stop.slotId]" :label="stop.venue.name" small />
            </li>
          </ul>
        </section>
        <section v-else-if="!itinerary" class="review__card card" aria-hidden="true">
          <SkeletonRow v-for="n in 2" :key="n" />
        </section>

        <section class="review__card card" aria-labelledby="review-photos">
          <div class="review__head">
            <h2 id="review-photos" class="title-md">Add your photos</h2>
            <AppButton variant="secondary" small :disabled="full" @click="input?.click()">
              <AppIcon name="camera" :size="16" />
              Add photos
            </AppButton>
          </div>
          <p v-if="photoError" class="body-sm text-error" role="alert">{{ photoError }}</p>
          <ul v-if="photos.length || uploading" class="review__thumbs">
            <li v-for="n in uploading" :key="`up-${n}`"><span class="review__thumb review__thumb--loading" aria-hidden="true" /></li>
            <li v-for="p in photos.slice(0, 8)" :key="p.id"><img class="review__thumb" :src="p.src" :alt="`Photo by ${p.name}`" loading="lazy" /></li>
          </ul>
          <p v-else class="caption-sm text-muted">Pictures from the day, for everyone who went.</p>
          <AppButton v-if="photos.length" variant="tertiary" underline small :to="`/sessions/${id}/photos`">See and share all {{ photos.length }} {{ photos.length === 1 ? 'photo' : 'photos' }}</AppButton>
          <input ref="input" class="sr-only" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true" @change="onFiles" />
        </section>

      </template>
    </div>

    <footer v-if="!closedWhy && !loadError" class="screen__footer review__footer">
      <p v-if="error" class="review__error body-sm text-error" role="alert" data-testid="review-error">{{ error }}</p>
      <AppButton variant="tertiary" to="/" data-testid="review-skip">{{ started ? 'Skip for now' : 'Not now' }}</AppButton>
      <AppButton block :disabled="!stars || saving" :aria-busy="saving ? 'true' : undefined" data-testid="review-save" @click="save">{{ saving ? 'Saving…' : 'Save review' }}</AppButton>
    </footer>
  </main>
  <main v-else class="screen" data-testid="review-view">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <EmptyState v-if="loadError" title="Could not load this outing" :text="loadError" role="alert">
        <AppButton variant="secondary" @click="load">Retry</AppButton>
      </EmptyState>
      <SkeletonRow v-for="n in 3" v-else :key="n" avatar />
    </div>
  </main>
</template>

<style scoped>
/* One column at a comfortable reading width, as the invite page. */
.review { max-width: 640px; }
.review__card { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-md); padding: var(--spacing-base); }
.review__card > :deep(.field), .review__card > .review__head { align-self: stretch; }
.review__head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--spacing-sm); }
.review__stops { display: flex; flex-direction: column; gap: var(--spacing-sm); align-self: stretch; margin: 0; padding: 0; list-style: none; }
.review__stop { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--spacing-xs) var(--spacing-md); }
.review__stopname { display: flex; align-items: center; gap: var(--spacing-sm); min-width: 0; flex: 1 1 12rem; }
.review__thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: var(--spacing-sm); align-self: stretch; margin: 0; padding: 0; list-style: none; }
.review__thumb { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: var(--rounded-sm); background: var(--surface-strong); }
.review__thumb--loading { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.5; } }
.review__footer { flex-wrap: wrap; gap: var(--spacing-sm); }
.review__error { flex: 1 1 100%; margin: 0; }
@media (prefers-reduced-motion: reduce) { .review__thumb--loading { animation: none; } }
</style>
