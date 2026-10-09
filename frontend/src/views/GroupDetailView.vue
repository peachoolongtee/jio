<script setup>
// The session: people, locations and the meeting area (steps 2 to 5).
//   Inviting  the people list and "Start session" (2 people or more, including Ian)
//   Locating  Ian's start and end, the meeting area with a map, and one list of everyone with
//             their area, travel time (coloured by length, with a key) and status. While the planner works
//             out the area, the card and the map say so.
//   Later     the same, read-only once the plan is confirmed
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import IconButton from '@/components/ui/IconButton.vue'
import ProgressDonut from '@/components/ui/ProgressDonut.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import SplitView from '@/components/ui/SplitView.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import SessionNotices from '@/components/event/SessionNotices.vue'
import LocationSheet from '@/components/group/LocationSheet.vue'
import MemberList from '@/components/group/MemberList.vue'
import PlannerMap from '@/components/map/PlannerMap.vue'
import NotFoundView from './NotFoundView.vue'
import { voters as votersOf } from '@/lib/planner/confirm.js'
import { TRAVEL_TONES } from '@/lib/planner/travel.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'

const props = defineProps({ id: { type: String, required: true } })

const router = useRouter()
const auth = useAuthStore()
const events = useEventsStore()
const groups = useGroupsStore()

const missing = ref(false)
const busy = ref(false)
const error = ref('')
const sheet = ref({ open: false, which: 'start' })
const view = ref('list')

async function load() {
  missing.value = false
  try {
    await Promise.all([events.loadSession(props.id), groups.loadPeople()])
  } catch {
    missing.value = true
  }
}
onMounted(load)
watch(() => props.id, load)

const session = computed(() => events.byId[props.id])
const status = computed(() => session.value?.status)
const nameOf = (id) => (id === 'ian' ? auth.user.name : groups.nameOf(id))
const active = computed(() => session.value?.activeIds || [])
const voterIds = computed(() => (session.value ? votersOf(session.value.votes, active.value) : []))
const locked = computed(() => ['confirmed', 'completed', 'cancelled'].includes(status.value))
const myLoc = computed(() => session.value?.locations?.ian || { start: null, end: null })
const homeArea = computed(() => (auth.user?.homeAreaId ? { id: auth.user.homeAreaId, name: auth.user.homeAreaName } : null))

// The donut follows the step: locations while locating, votes after that.
const progress = computed(() => {
  if (!session.value) return null
  const people = active.value.map((id) => ({ name: nameOf(id), id }))
  if (['voting', 'confirmed', 'completed'].includes(status.value)) {
    return { title: 'Votes', label: 'Voted', people: people.map((p) => ({ name: p.name, done: voterIds.value.includes(p.id) })) }
  }
  return { title: 'Locations', label: 'Located', people: people.map((p) => ({ name: p.name, done: !!session.value.locations?.[p.id]?.start })) }
})

// Map pins: each person's start AREA, with their travel time to the meeting area.
const mapPeople = computed(() =>
  active.value
    .filter((id) => session.value.locations?.[id]?.start)
    .map((id) => {
      const start = session.value.locations[id].start
      return { id, name: nameOf(id), lat: start.lat, lng: start.lng, areaName: start.name, minutes: session.value.meeting?.times?.[id] ?? null }
    }),
)

// The planner is working out the meeting area right now.
const finding = computed(() => !!session.value?.findingMeeting)
function openSheet(which) {
  sheet.value = { open: true, which }
}

async function saveLocation(place) {
  error.value = ''
  try {
    await events.setMyLocation(props.id, sheet.value.which, place)
  } catch (e) {
    error.value = e.message
  }
}

async function run(fn, after) {
  busy.value = true
  error.value = ''
  try {
    await fn()
    if (after) after()
  } catch (e) {
    error.value = e.message
  }
  busy.value = false
}

const startSession = () => run(() => events.start(props.id))
const useArea = () => run(() => events.useArea(props.id), () => router.push(`/sessions/${props.id}/plan`))
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else-if="session" class="screen" data-testid="group-detail-view">
    <SessionHeader :session="session" back="/" />

    <div class="screen__body">
      <SessionNotices :session="session" />

      <!-- Inviting: the people list and Start session. -->
      <section v-if="status === 'inviting'" class="section" aria-labelledby="people-head">
        <div class="section__head">
          <h2 id="people-head" class="title-md">People <span class="text-muted">{{ active.length }}</span></h2>
          <IconButton label="Invite friends" :to="`/sessions/${id}/invite`"><AppIcon name="user-plus" /></IconButton>
        </div>
        <MemberList :session="session" :names="nameOf" compact />
      </section>

      <template v-else>
        <!-- Ian's own start and end. Only he sees the exact place. -->
        <dl class="mine" aria-label="Your locations">
          <div class="mine__row">
            <dt class="caption text-muted">From</dt>
            <dd class="title-sm truncate">{{ myLoc.start?.label || 'Not set' }}</dd>
            <AppButton v-if="!locked && !myLoc.start" variant="pill" @click="openSheet('start')">Set</AppButton>
            <IconButton v-else-if="!locked" label="Change start location" @click="openSheet('start')"><AppIcon name="edit" /></IconButton>
          </div>
          <div class="mine__row">
            <dt class="caption text-muted">To</dt>
            <dd class="title-sm truncate">{{ myLoc.end ? myLoc.end.label : 'Same as start' }}</dd>
            <IconButton v-if="!locked" label="Change end location" @click="openSheet('end')"><AppIcon name="edit" /></IconButton>
          </div>
        </dl>

        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>

        <SplitView v-model:view="view" label="Meeting area">
          <template #list>
            <!-- Step 5: the meeting area. While the planner works it out, the card says so and a bar sweeps across. -->
            <section class="area" :class="{ 'is-finding': finding }" aria-labelledby="area-head" :role="finding ? 'status' : undefined">
              <template v-if="finding">
                <div class="area__main">
                  <span class="area__pin area__pin--finding"><AppIcon name="pin" :size="18" /></span>
                  <div class="stack">
                    <span class="caption area__label">Working it out</span>
                    <h2 id="area-head" class="title-md">Finding the fairest meeting point…</h2>
                  </div>
                </div>
                <span class="area__bar" aria-hidden="true"><span /></span>
              </template>
              <div v-else-if="session.meeting" class="area__main">
                <span class="area__pin"><AppIcon name="pin" :size="18" /></span>
                <div class="stack">
                  <span class="caption area__label">Fairest area</span>
                  <h2 id="area-head" class="display-lg">{{ session.area.name }}</h2>
                </div>
              </div>
              <h2 v-else id="area-head" class="title-md text-muted">Waiting for 2 locations</h2>
            </section>
            <p v-if="session.areaNote" class="caption-sm text-muted">{{ session.areaNote }}</p>

            <section class="section card" aria-label="People">
              <ProgressDonut v-if="progress" compact :title="progress.title" :people="progress.people" :done-label="progress.label" />
              <MemberList :session="session" :names="nameOf" :voters="voterIds" />
              <p v-if="session.meeting && !finding" class="travel-key" aria-label="Travel time colours">
                <span v-for="t in TRAVEL_TONES" :key="t.id" class="travel-key__item"><span class="travel-key__dot" :class="`is-${t.id}`" />{{ t.label }}</span>
              </p>
            </section>
          </template>
          <template #map>
            <PlannerMap :people="mapPeople" :area="session.area" :finding="finding" spokes label="Meeting area map" />
            <div v-if="finding" class="map-wait map-wait--finding title-sm" role="status">Finding the fairest meeting point…</div>
            <div v-else-if="!session.meeting" class="map-wait title-sm">Waiting for 2 locations</div>
          </template>
        </SplitView>
      </template>
    </div>

    <footer v-if="status !== 'cancelled'" class="screen__footer">
      <AppButton v-if="status === 'inviting'" block :disabled="active.length < 2 || busy" @click="startSession">
        {{ active.length < 2 ? 'Invite 1 more to start' : 'Start session' }}
      </AppButton>
      <AppButton v-else-if="status === 'locating'" block :disabled="!session.meeting || busy || finding" @click="useArea">
        {{ finding ? 'Finding the meeting point…' : session.meeting ? `Meet at ${session.area.name}` : 'Waiting for locations' }}
      </AppButton>
      <AppButton v-else-if="status === 'voting'" block :to="`/sessions/${id}/plan`">Activities</AppButton>
      <AppButton v-else block :to="`/sessions/${id}/itinerary`">{{ session.isToday && status === 'confirmed' ? "Today's plan" : 'Itinerary' }}</AppButton>
    </footer>

    <LocationSheet v-model:open="sheet.open" :which="sheet.which" :home="homeArea" @select="saveLocation" />
  </main>
  <main v-else class="screen" data-testid="group-detail-view">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <SkeletonRow v-for="n in 4" :key="n" avatar />
    </div>
  </main>
</template>

<style scoped>
.mine { display: flex; flex-direction: column; margin: 0; padding: var(--spacing-xs) var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.mine__row { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-md); min-height: 56px; }
.mine__row + .mine__row { border-top: 1px solid var(--hairline-soft); }
.mine__row dd { margin: 0; }
/* The meeting area: a reservation-card style block. The pin is the screen's Rausch moment besides the CTA. */
.area { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); padding: var(--spacing-lg); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); box-shadow: var(--shadow-float); }
.area__main { display: flex; align-items: center; gap: var(--spacing-md); min-width: 0; }
.area__label { color: var(--muted); }
.area__pin { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); }
/* Finding the meeting area: the pin breathes and a bar sweeps across. Still when motion is reduced. */
.area.is-finding { flex-direction: column; align-items: stretch; }
.area__pin--finding { animation: area-breathe 1.2s ease-in-out infinite alternate; }
.area__bar { position: relative; height: 4px; overflow: hidden; border-radius: var(--rounded-full); background: var(--surface-strong); }
.area__bar > span { position: absolute; top: 0; bottom: 0; width: 40%; border-radius: var(--rounded-full); background: var(--primary); animation: area-sweep 1.1s ease-in-out infinite; }
@keyframes area-breathe { to { transform: scale(1.12); } }
@keyframes area-sweep { from { left: -40%; } to { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .area__pin--finding, .area__bar > span { animation: none; } .area__bar > span { left: 30%; } }
/* The key for the travel-time colours in the people list. */
.travel-key { display: flex; flex-wrap: wrap; gap: var(--spacing-xs) var(--spacing-base); margin: 0; font: var(--text-caption-sm); color: var(--muted); }
.travel-key__item { display: inline-flex; align-items: center; gap: var(--spacing-xs); }
.travel-key__dot { width: 10px; height: 10px; border-radius: var(--rounded-full); }
.travel-key__dot.is-short { background: var(--travel-short); }
.travel-key__dot.is-medium { background: var(--travel-medium); }
.travel-key__dot.is-long { background: var(--travel-long); }
.map-wait { position: absolute; left: 50%; top: 50%; z-index: 500; transform: translate(-50%, -50%); padding: var(--spacing-md) var(--spacing-base); border-radius: var(--rounded-md); background: var(--canvas); box-shadow: var(--shadow-float); text-align: center; }
.map-wait--finding { top: var(--spacing-md); transform: translateX(-50%); }
</style>
