<script setup>
// The confirmed plan, on one screen. On the day itself it is titled "Today's plan".
//   - Stops in order: time and duration on one line, name, category icon, price tier.
//   - Between stops: a visible Walk / MRT / Car switch, each with its own time. It moves every later stop.
//   - The end point and each person's travel time home, with a warning for anyone over 60 minutes.
//   - The AI button (an empty sheet for now) and "View map".
//   - Edit: delete a stop, change a travel mode, or re-plan. "End plan" completes the session on the day.
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
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
const title = computed(() => (today.value ? "Today's plan" : ''))
const longTrips = computed(() => (itinerary.value?.trips || []).filter((t) => t.long))

const mapPlaces = computed(() =>
  (itinerary.value?.stops || []).map((s, i) => ({ id: s.venue.id, name: s.venue.name, lat: s.venue.lat, lng: s.venue.lng, label: String(i + 1), category: s.category })),
)
const mapPeople = computed(() => (itinerary.value?.starts || []).map((p) => ({ id: p.id, name: p.name, lat: p.area.lat, lng: p.area.lng, areaName: p.area.name })))

async function setMode(index, mode) {
  error.value = ''
  try {
    await events.setTravelMode(props.id, index, mode)
  } catch (e) {
    error.value = e.message
  }
}

async function removeStop() {
  const index = removing.value
  removing.value = null
  error.value = ''
  try {
    await events.deleteStop(props.id, index)
  } catch (e) {
    error.value = e.message
  }
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
    <SessionHeader :session="session" :title="title" back="/" />

    <div class="screen__body">
      <SessionNotices :session="session" />

      <EmptyState v-if="!session.plan" title="No itinerary yet" text="The itinerary appears once the plan is confirmed.">
        <AppButton variant="secondary" :to="`/sessions/${id}/plan`">Activities</AppButton>
      </EmptyState>

      <template v-else>
        <BannerNote v-if="status === 'completed'" icon="trophy">
          Successful meetup · {{ POINTS_PER_MEETUP }} points for each person to spend on café discounts
          <template #actions>
            <AppButton small variant="secondary" to="/leaderboard#rewards">Café discounts</AppButton>
          </template>
        </BannerNote>

        <div class="tools">
          <AppButton variant="secondary" small class="mobile-only" :to="`/sessions/${id}/map`">
            <AppIcon name="map" />
            View map
          </AppButton>
          <AppButton variant="secondary" small class="desktop-only" :to="`/sessions/${id}/map`">
            <AppIcon name="expand" />
            Full-screen map
          </AppButton>
          <AppButton variant="pill" @click="aiOpen = true">
            <AppIcon name="sparkle" />
            Ask AI
          </AppButton>
          <AppButton v-if="confirmed" :variant="editing ? 'primary' : 'secondary'" small :aria-pressed="String(editing)" @click="editing = !editing">
            <AppIcon :name="editing ? 'check' : 'edit'" />
            {{ editing ? 'Done' : 'Edit' }}
          </AppButton>
        </div>

        <BannerNote v-for="trip in longTrips" :key="trip.id" tone="warning" icon="warning">
          Long trip home: {{ trip.name }}, {{ trip.minutes }} min to {{ trip.place }}
        </BannerNote>
        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>

        <SplitView v-model:view="view" label="Itinerary">
          <template #list>
            <div v-if="!itinerary" class="stack gap-md">
              <SkeletonRow v-for="n in 3" :key="n" avatar />
            </div>
            <ol v-else class="stops" aria-label="Stops">
              <li v-for="(stop, i) in itinerary.stops" :key="stop.slotId" class="stops__item">
                <TravelConnector
                  v-if="i > 0"
                  :options="itinerary.legs[i - 1].options"
                  :mode="itinerary.legs[i - 1].mode"
                  :readonly="!confirmed"
                  :label="`Travel from ${itinerary.stops[i - 1].venue.name} to ${stop.venue.name}`"
                  @change="setMode(i - 1, $event)"
                />
                <StopCard
                  :number="i + 1"
                  :time="stop.start"
                  :duration="stop.duration"
                  :name="stop.venue.name"
                  :category="stop.category"
                  :price="stop.venue.price"
                  :area="stop.venue.area"
                  :image="placeImage(stop.venue)"
                  :lifted="selected === stop.venue.id"
                >
                  <template v-if="editing && itinerary.stops.length > 1" #actions>
                    <IconButton outline :label="`Delete stop: ${stop.venue.name}`" @click="removing = i"><AppIcon name="trash" /></IconButton>
                  </template>
                </StopCard>
              </li>
            </ol>

            <section v-if="itinerary?.end" class="card end" aria-labelledby="end-head">
              <div class="row gap-sm">
                <span class="end__icon"><AppIcon name="flag" /></span>
                <div class="stack">
                  <h2 id="end-head" class="title-md">End point</h2>
                  <span class="caption-sm text-muted">
                    {{ itinerary.end.name }} · {{ fromMinutes(itinerary.stops[itinerary.stops.length - 1].end) }} · {{ itinerary.end.mrtWalk }} min walk to {{ itinerary.end.mrt }} MRT
                  </span>
                </div>
              </div>
              <h3 class="caption text-muted">Travel time home</h3>
              <ul class="trips">
                <li v-for="trip in itinerary.trips" :key="trip.id" class="trips__row" :class="{ 'is-long': trip.long }">
                  <span class="title-sm">{{ trip.name }}</span>
                  <span class="caption-sm text-muted truncate">{{ trip.place }}</span>
                  <span class="caption trips__min">
                    <AppIcon v-if="trip.long" name="warning" :size="12" label="Over 60 minutes" />
                    {{ trip.minutes }} min
                  </span>
                </li>
              </ul>
            </section>

            <AppButton v-if="editing" variant="secondary" class="replan" @click="replanOpen = true">
              <AppIcon name="swap" />
              Re-plan
            </AppButton>
          </template>

          <template #map>
            <PlannerMap :places="mapPlaces" :people="mapPeople" :area="itinerary?.area" route label="Itinerary map" :selected="selected" @select="selected = $event" />
            <CategoryKey :categories="mapPlaces.map((p) => p.category)" />
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
        <p class="body-md">Successful meetup · {{ POINTS_PER_MEETUP }} points each for {{ session.activeIds.length }} people, to spend on café discounts</p>
      </template>
      <AppButton block :disabled="busy" @click="endPlan">End plan</AppButton>
      <AppButton block variant="secondary" @click="endOpen = false">Not yet</AppButton>
    </ModalDialog>

    <ModalDialog :open="removing !== null" :title="removing !== null && itinerary ? `Delete ${itinerary.stops[removing]?.venue.name}?` : 'Delete stop?'" @update:open="(v) => !v && (removing = null)">
      <AppButton block variant="secondary" @click="removing = null">Keep stop</AppButton>
      <AppButton block variant="danger" @click="removeStop">Delete stop</AppButton>
    </ModalDialog>

    <ModalDialog v-model:open="replanOpen" title="Re-plan?">
      <template #content>
        <p class="body-md">Status returns to Voting · votes kept</p>
      </template>
      <AppButton block variant="secondary" @click="replanOpen = false">Keep plan</AppButton>
      <AppButton block :disabled="busy" @click="replan">Re-plan</AppButton>
    </ModalDialog>

    <ToastMessage v-model:show="toast" :text="`Session completed · +${POINTS_PER_MEETUP} points to spend on café discounts`" :offset="120" />
  </main>
  <main v-else class="screen" data-testid="event-view">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <SkeletonRow v-for="n in 4" :key="n" avatar />
    </div>
  </main>
</template>

<style scoped>
.tools { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
.stops { display: flex; flex-direction: column; }
.stops__item { display: flex; flex-direction: column; }
.end { gap: var(--spacing-md); }
.end__icon { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: var(--rounded-full); background: var(--primary-tint); color: var(--primary-active); }
.trips { display: flex; flex-direction: column; }
.trips__row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-md); min-height: 40px; border-bottom: 1px solid var(--hairline-soft); }
.trips__min { display: inline-flex; align-items: center; gap: var(--spacing-xs); }
.trips__row.is-long .trips__min { color: var(--warning-text); }
.replan { align-self: flex-start; }
</style>
