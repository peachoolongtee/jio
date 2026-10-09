<script setup>
// The confirmed plan, on one screen. On the day itself it is titled "Today's plan".
//   - A timeline of stops: time and duration on one line, name, category icon, price tier, a photo, and the stop
//     number in its category colour (the same as its pin; the map has a key).
//   - Between stops: a visible Walk / MRT / Car switch, each with its own time. It moves every later stop.
//     Two stops in the same building just say so.
//   - On desktop the timeline is as tall as the map beside it, with the stops spread out.
//   - Each stop has a delete button once the plan is confirmed (two stops or more), with a confirm dialog.
//   - The end point, and each person's trip home (folded away; anyone over 60 minutes is flagged above).
//   - Drag a stop by its handle (or focus the handle and use the arrow keys) to rearrange the day. Times follow;
//     a stop that would be closed at its new time, or an end far from the MRT, is flagged.
//   - Map, Ask AI (an empty sheet for now) and Edit: re-plan. "End plan" on the day.
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import { RouterLink } from 'vue-router'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import SortableList from '@/components/ui/SortableList.vue'
import SplitView from '@/components/ui/SplitView.vue'
import ToastMessage from '@/components/ui/ToastMessage.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import SessionNotices from '@/components/event/SessionNotices.vue'
import StopCard from '@/components/event/StopCard.vue'
import CategoryKey from '@/components/map/CategoryKey.vue'
import { placeImage } from '@/lib/placeImages.js'
import TravelConnector from '@/components/event/TravelConnector.vue'
import PlannerMap from '@/components/map/PlannerMap.vue'
import NotFoundView from './NotFoundView.vue'
import { fromMinutes } from '@/lib/planner/format.js'
import { POINTS_PER_MEETUP } from '@/lib/mock/people.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ id: { type: String, required: true } })

const router = useRouter()
const events = useEventsStore()

const missing = ref(false)
const editing = ref(false)
const aiOpen = ref(false)
const endOpen = ref(false)
const replanOpen = ref(false)
const removing = ref(null)
const busy = ref(false)
const error = ref('')
const view = ref('list')
const selected = ref('')
const toast = ref(false)
// Arrived straight from "Confirm plan": say so, big and clear, until dismissed.
const justConfirmed = ref(!!window.history.state?.justConfirmed)
const confirmedLine = computed(() => {
  const stops = itinerary.value?.stops || []
  const summary = stops.length ? ` ${stops.length} ${stops.length === 1 ? 'stop' : 'stops'}, starting ${fromMinutes(stops[0].start)}.` : ''
  return `Everyone in the group can see the itinerary now.${summary}`
})
function dismissConfirmed() {
  justConfirmed.value = false
  window.history.replaceState({ ...window.history.state, justConfirmed: false }, '')
}

async function load() {
  missing.value = false
  try {
    await events.loadSession(props.id)
    await events.loadItinerary(props.id)
  } catch {
    missing.value = true
  }
}
onMounted(load)
watch(() => props.id, load)

const session = computed(() => events.byId[props.id])
const itinerary = computed(() => events.itineraries[props.id])
const status = computed(() => session.value?.status)
const confirmed = computed(() => status.value === 'confirmed')
const today = computed(() => confirmed.value && session.value?.isToday)
const longTrips = computed(() => (itinerary.value?.trips || []).filter((t) => t.long))
const lastStop = computed(() => itinerary.value?.stops[itinerary.value.stops.length - 1])
// A confirmed plan with two or more stops can be rearranged by dragging a stop's handle.
const canMove = computed(() => confirmed.value && (itinerary.value?.stops.length || 0) > 1)

const mapPlaces = computed(() =>
  (itinerary.value?.stops || []).map((s, i) => ({ id: s.venue.id, name: s.venue.name, lat: s.venue.lat, lng: s.venue.lng, label: String(i + 1), category: s.category })),
)
const mapPeople = computed(() => (itinerary.value?.starts || []).map((p) => ({ id: p.id, name: p.name, lat: p.area.lat, lng: p.area.lng, areaName: p.area.name })))

async function act(fn) {
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = e.message
  }
}
const setMode = (index, mode) => act(() => events.setTravelMode(props.id, index, mode))
const moveStop = (from, to) => act(() => events.reorderStops(props.id, from, to))

async function removeStop() {
  const index = removing.value
  removing.value = null
  await act(() => events.deleteStop(props.id, index))
}

async function replan() {
  busy.value = true
  await events.replan(props.id)
  busy.value = false
  replanOpen.value = false
  router.push(`/sessions/${props.id}/plan`)
}

async function endPlan() {
  busy.value = true
  await events.endPlan(props.id)
  busy.value = false
  endOpen.value = false
  editing.value = false
  toast.value = true
}
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else-if="session" class="screen" data-testid="event-view">
    <SessionHeader :session="session" :title="today ? 'Today\'s plan' : ''" back="/">
      <template v-if="session.plan" #actions>
        <IconButton label="Ask AI" class="ai-btn" @click="aiOpen = true"><AppIcon name="sparkle" /></IconButton>
        <IconButton v-if="confirmed" :label="editing ? 'Done editing' : 'Edit itinerary'" :tone="editing ? 'brand' : ''" :aria-pressed="String(editing)" @click="editing = !editing">
          <AppIcon :name="editing ? 'check' : 'edit'" />
        </IconButton>
      </template>
    </SessionHeader>

    <div class="screen__body">
      <SessionNotices :session="session" />

      <EmptyState v-if="!session.plan" title="No itinerary yet">
        <AppButton variant="secondary" :to="`/sessions/${id}/plan`">Activities</AppButton>
      </EmptyState>

      <template v-else>
        <Transition name="celebrate" appear>
          <section v-if="justConfirmed && confirmed" class="celebrate" role="status">
            <span class="celebrate__icon"><AppIcon name="check" :size="22" /></span>
            <div class="celebrate__text">
              <h2 class="display-sm">Plan confirmed</h2>
              <p class="body-sm">{{ confirmedLine }}</p>
            </div>
            <IconButton label="Dismiss" class="celebrate__close" @click="dismissConfirmed"><AppIcon name="close" :size="16" /></IconButton>
          </section>
        </Transition>
        <BannerNote v-if="status === 'completed'" icon="trophy">
          Completed · +{{ POINTS_PER_MEETUP }} points each to spend on café discounts
          <template #actions>
            <AppButton small variant="secondary" to="/rewards">Rewards</AppButton>
          </template>
        </BannerNote>
        <BannerNote v-for="trip in longTrips" :key="trip.id" tone="warning" icon="warning">
          Long trip home: {{ trip.name }}, {{ trip.minutes }} min
        </BannerNote>

        <RouterLink v-if="session.photos.length" :to="`/sessions/${id}/photos`" class="strip" :aria-label="`${session.photos.length} photos`" title="Photos">
          <img v-for="p in session.photos.slice(-4)" :key="p.id" :src="p.src" alt="" />
          <span v-if="session.photos.length > 4" class="strip__more caption-sm">+{{ session.photos.length - 4 }}</span>
        </RouterLink>
        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>

        <SplitView v-model:view="view" label="Itinerary" even>
          <template #list>
            <div v-if="!itinerary" class="stack gap-md">
              <SkeletonRow v-for="n in 3" :key="n" avatar />
            </div>
            <template v-else>
              <div class="timeline card">
                <SortableList
                  :items="itinerary.stops"
                  :item-key="(s) => s.slotId"
                  :item-label="(s) => s.venue.name"
                  :disabled="!canMove"
                  label="Stops"
                  @move="moveStop"
                >
                  <template #item="{ item: stop, index: i, dragging, lifted, handle }">
                    <!-- The legs belong to pairs of stops, so they step aside while a stop is dragged. -->
                    <div v-if="i > 0" v-show="!dragging" class="timeline__leg">
                      <TravelConnector
                        :options="itinerary.legs[i - 1].options"
                        :mode="itinerary.legs[i - 1].mode"
                        :readonly="!confirmed"
                        :label="`Travel from ${itinerary.stops[i - 1].venue.name} to ${stop.venue.name}`"
                        @change="setMode(i - 1, $event)"
                      />
                    </div>
                    <StopCard
                      :number="i + 1"
                      :time="stop.start"
                      :duration="stop.duration"
                      :name="stop.venue.name"
                      :category="stop.category"
                      :price="stop.venue.price"
                      :area="stop.venue.area"
                      :image="placeImage(stop.venue)"
                      banner
                      :warning="stop.open === false ? 'Closed at this time' : ''"
                      :lifted="lifted || selected === stop.venue.id"
                    >
                      <template v-if="canMove" #actions>
                        <IconButton outline :label="`Delete stop: ${stop.venue.name}`" @click="removing = i"><AppIcon name="trash" /></IconButton>
                      </template>
                      <template v-if="canMove" #handle>
                        <button v-bind="handle" class="drag-handle"><AppIcon name="grip" /></button>
                      </template>
                    </StopCard>
                  </template>
                </SortableList>
                <div v-if="itinerary.end" class="timeline__end">
                  <span class="timeline__flag" aria-hidden="true"><AppIcon name="flag" :size="14" /></span>
                  <div class="stack">
                    <span class="title-sm">Ends {{ fromMinutes(lastStop.end) }}</span>
                    <span class="caption-sm text-muted">{{ itinerary.end.mrtWalk }} min walk to {{ itinerary.end.mrt }} MRT</span>
                    <span v-if="itinerary.end.farFromMrt" class="timeline__warning caption-sm"><AppIcon name="warning" :size="12" /> Far from the MRT</span>
                  </div>
                </div>
              </div>

              <details v-if="itinerary.trips.length" class="home">
                <summary class="home__summary">
                  <span class="title-sm">Trips home</span>
                  <span class="caption-sm text-muted">Longest {{ Math.max(...itinerary.trips.map((t) => t.minutes)) }} min</span>
                  <AppIcon name="chevron-down" class="home__chevron" />
                </summary>
                <ul class="home__list">
                  <li v-for="trip in itinerary.trips" :key="trip.id" class="home__row" :class="{ 'is-long': trip.long }">
                    <span class="body-sm">{{ trip.name }}</span>
                    <span class="caption-sm text-muted truncate">{{ trip.place }}</span>
                    <span class="caption home__min">{{ trip.minutes }} min</span>
                  </li>
                </ul>
              </details>

              <AppButton v-if="editing" variant="tertiary" underline class="replan" @click="replanOpen = true">Re-plan</AppButton>
            </template>
          </template>

          <template #map>
            <PlannerMap :places="mapPlaces" :people="mapPeople" :area="itinerary?.area" route fit-to="places" label="Itinerary map" :selected="selected" @select="selected = $event" />
            <CategoryKey :categories="mapPlaces.map((p) => p.category)" />
            <AppButton variant="secondary" small class="map-open" :to="`/sessions/${id}/map`">
              <AppIcon name="expand" />
              View map
            </AppButton>
          </template>
        </SplitView>
      </template>
    </div>

    <footer v-if="today" class="screen__footer">
      <AppButton block :disabled="busy" @click="endOpen = true">End plan</AppButton>
    </footer>

    <BottomSheet v-model:open="aiOpen" title="Ask AI" />

    <ModalDialog v-model:open="endOpen" title="End plan?">
      <template #content>
        <p class="body-md">+{{ POINTS_PER_MEETUP }} points each for {{ session.activeIds.length }} people, to spend on café discounts</p>
      </template>
      <AppButton block :disabled="busy" @click="endPlan">End plan</AppButton>
      <AppButton block variant="secondary" @click="endOpen = false">Not yet</AppButton>
    </ModalDialog>

    <ModalDialog :open="removing !== null" :title="removing !== null && itinerary ? `Delete ${itinerary.stops[removing]?.venue.name}?` : 'Delete stop?'" @update:open="(v) => !v && (removing = null)">
      <AppButton block variant="secondary" @click="removing = null">Keep</AppButton>
      <AppButton block variant="danger" @click="removeStop">Delete</AppButton>
    </ModalDialog>

    <ModalDialog v-model:open="replanOpen" title="Re-plan?">
      <template #content>
        <p class="body-md">Back to voting. Votes are kept.</p>
      </template>
      <AppButton block variant="secondary" @click="replanOpen = false">Keep plan</AppButton>
      <AppButton block :disabled="busy" @click="replan">Re-plan</AppButton>
    </ModalDialog>

    <ToastMessage v-model:show="toast" :text="`Completed · +${POINTS_PER_MEETUP} points to spend on café discounts`" :offset="120" />
  </main>
  <main v-else class="screen" data-testid="event-view">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <SkeletonRow v-for="n in 4" :key="n" avatar />
    </div>
  </main>
</template>

<style scoped>
/* The latest photos from the day, as a stack of thumbnails linking to Photos. */
.strip { display: inline-flex; align-self: flex-start; align-items: center; min-height: var(--tap-min); text-decoration: none; }
.strip img { width: 40px; height: 40px; border-radius: 12px; object-fit: cover; box-shadow: 0 0 0 2px var(--canvas); transform: rotate(-3deg); }
.strip img:nth-child(even) { transform: rotate(3deg); }
.strip img + img { margin-left: -12px; }
.strip__more { margin-left: var(--spacing-sm); color: var(--muted); }
/* Opens the full-screen map screen. On desktop SplitView's own expand control does this job. */
.map-open { position: absolute; top: var(--spacing-md); right: var(--spacing-md); z-index: 500; box-shadow: var(--shadow-float); }
@media (min-width: 1128px) { a.map-open, button.map-open { display: none; } }

/* The timeline: one rail joins every stop, leg and the end point. */
.timeline { position: relative; display: flex; flex-direction: column; gap: 0; padding: var(--spacing-base); }
.timeline::before { content: ""; position: absolute; top: 34px; bottom: 34px; left: calc(var(--spacing-base) + 13px); width: 2px; border-radius: var(--rounded-full); background: var(--hairline); }
.timeline__leg { position: relative; }
.timeline__end { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: var(--spacing-md); padding-top: var(--spacing-sm); }
.timeline__warning { display: inline-flex; align-items: center; gap: var(--spacing-xs); color: var(--primary-error-text); }
.timeline__flag { position: relative; z-index: 1; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 2px solid var(--ink); border-radius: var(--rounded-full); background: var(--canvas); box-shadow: 0 0 0 4px var(--canvas); color: var(--ink); }

/* Trips home, folded away. */
.home { padding: 0 var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.home__summary { display: flex; align-items: center; gap: var(--spacing-md); min-height: 52px; list-style: none; cursor: pointer; }
.home__summary::-webkit-details-marker { display: none; }
.home__summary .caption-sm { margin-left: auto; }
.home__chevron { color: var(--muted); transition: transform var(--motion-fast) var(--ease-out); }
.home[open] .home__chevron { transform: rotate(180deg); }
.home__summary:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: var(--rounded-sm); }
.home__list { display: flex; flex-direction: column; padding-bottom: var(--spacing-sm); }
.home__row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-md); min-height: 36px; }
.home__row.is-long .home__min { color: var(--primary-error-text); }
.replan { align-self: flex-start; }

/* "Plan confirmed", right after confirming: a warm card that pops in under the confetti. */
.celebrate { position: relative; display: flex; align-items: center; gap: var(--spacing-base); padding: var(--spacing-base) var(--spacing-xl) var(--spacing-base) var(--spacing-base); border-radius: var(--rounded-md); background: linear-gradient(120deg, color-mix(in srgb, var(--primary) 14%, var(--canvas)), color-mix(in srgb, var(--cat-shop-fg) 12%, var(--canvas))); }
.celebrate__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); box-shadow: 0 0 0 6px color-mix(in srgb, var(--primary) 18%, transparent); }
.celebrate__text { display: flex; flex-direction: column; gap: var(--spacing-xxs); min-width: 0; }
.celebrate__close { position: absolute; top: var(--spacing-xs); right: var(--spacing-xs); }
.celebrate-enter-active { transition: opacity 400ms var(--ease-out), transform 600ms cubic-bezier(0.34, 1.56, 0.64, 1); }
.celebrate-enter-active .celebrate__icon { animation: celebrate-pop 700ms 150ms cubic-bezier(0.34, 1.56, 0.64, 1) both; }
.celebrate-leave-active { transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
.celebrate-enter-from { opacity: 0; transform: translateY(-12px) scale(0.96); }
.celebrate-leave-to { opacity: 0; transform: scale(0.98); }
@keyframes celebrate-pop { from { transform: scale(0) rotate(-45deg); } to { transform: scale(1) rotate(0); } }

/* Desktop: the timeline fills the height of the map beside it (less the Trips home row below), with the stops
   spread out, bigger photos and names, so the day reads at a glance. */
@media (min-width: 1128px) {
  .timeline { min-height: calc(min(820px, 100dvh - 120px) - 68px); padding: var(--spacing-lg); }
  .timeline::before { top: 42px; bottom: 42px; left: calc(var(--spacing-lg) + 13px); }
  .timeline :deep(.sortable) { flex: 1 1 auto; justify-content: space-around; gap: var(--spacing-sm); }
  .timeline :deep(.stop__banner) { height: 150px; border-radius: var(--rounded-md); }
  .timeline :deep(.stop .title-md) { font: var(--text-display-sm); }
  .timeline :deep(.stop) { padding: var(--spacing-sm) 0; }
}
</style>
