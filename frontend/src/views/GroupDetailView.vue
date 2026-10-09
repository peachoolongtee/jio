<script setup>
// The session: people, locations and the meeting area (steps 2 to 5).
//   Inviting  the people list with an Invite button. Below 2 people the main button is "Invite friends";
//             from 2 people (including Ian) it is "Start session"
//   Locating  Ian's start and end, the meeting area with a map, and one list of everyone with
//             their area, travel time (coloured by length, with a key) and status. While the planner works
//             out the area, the card and the map say so.
//   Later     the same, read-only once the plan is confirmed
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import IconButton from '@/components/ui/IconButton.vue'
import ProgressDonut from '@/components/ui/ProgressDonut.vue'
import SegmentedProgress from '@/components/ui/SegmentedProgress.vue'
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
  return { title: 'Locations', label: 'Submitted', people: people.map((p) => ({ name: p.name, done: !!session.value.locations?.[p.id]?.start })) }
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

// Three facts under the meeting point, from everyone's travel time to it: the average, the quickest and the longest.
const tripFacts = computed(() => {
  const times = active.value.map((id) => session.value?.meeting?.times?.[id]).filter((m) => typeof m === 'number')
  if (!times.length) return []
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
  return [
    { label: 'Average trip', minutes: avg },
    { label: 'Quickest', minutes: Math.min(...times) },
    { label: 'Longest', minutes: Math.max(...times) },
  ]
})

// The planner is working out the meeting area right now.
const finding = computed(() => !!session.value?.findingMeeting)

// The loading bar before the meeting point is revealed. While the planner works, it creeps towards 90%; when the
// answer arrives it runs to 100%, holds a moment, then the place appears. `loading` covers both parts.
const loadPct = ref(0)
const finishing = ref(false)
const loading = computed(() => finding.value || finishing.value)
const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
let frame = 0
let holdTimer = 0
function stopLoader() {
  cancelAnimationFrame(frame)
  clearTimeout(holdTimer)
}
function tween(from, to, ms, done) {
  const t0 = performance.now()
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms)
    loadPct.value = from + (to - from) * (1 - (1 - k) ** 3)
    if (k < 1) frame = requestAnimationFrame(step)
    else done?.()
  }
  frame = requestAnimationFrame(step)
}
watch(finding, (now, was) => {
  stopLoader()
  if (now) {
    finishing.value = false
    loadPct.value = 0
    // Ease towards 90% and wait there for the answer.
    const t0 = performance.now()
    const creep = (time) => {
      loadPct.value = 90 * (1 - Math.exp(-(time - t0) / 450))
      frame = requestAnimationFrame(creep)
    }
    frame = requestAnimationFrame(creep)
  } else if (was) {
    if (reduceMotion) return
    finishing.value = true
    tween(loadPct.value, 100, 320, () => {
      holdTimer = setTimeout(() => { finishing.value = false }, 380)
    })
  }
})
onBeforeUnmount(stopLoader)
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
          <AppButton variant="secondary" small :to="`/sessions/${id}/invite`"><AppIcon name="user-plus" :size="16" />Invite</AppButton>
        </div>
        <MemberList :session="session" :names="nameOf" compact />
        <p v-if="active.length < 2" class="body-sm text-muted invite-hint">Invite at least one friend to start. Everyone you invite joins straight away; then each of you shares where you're starting from.</p>
      </section>

      <template v-else>
        <!-- Ian's own start and end, as a little route: where he starts, a dotted line, where he heads after.
             Only he sees the exact place. -->
        <dl class="route" aria-label="Your locations">
          <div class="route__stop">
            <span class="route__dot route__dot--from" aria-hidden="true"><AppIcon name="home" :size="16" /></span>
            <div class="route__text">
              <dt class="caption text-muted">Starting from</dt>
              <dd class="title-sm truncate" :class="{ 'text-muted': !myLoc.start }">{{ myLoc.start?.label || 'Not set yet' }}</dd>
            </div>
            <AppButton v-if="!locked && !myLoc.start" variant="pill" @click="openSheet('start')">Set</AppButton>
            <AppButton v-else-if="!locked" variant="tertiary" underline aria-label="Change start location" @click="openSheet('start')">Change</AppButton>
          </div>
          <span class="route__line" aria-hidden="true" />
          <div class="route__stop">
            <span class="route__dot route__dot--to" aria-hidden="true"><AppIcon name="flag" :size="16" /></span>
            <div class="route__text">
              <dt class="caption text-muted">Heading to after</dt>
              <dd class="title-sm truncate">{{ myLoc.end ? myLoc.end.label : 'Back to where you started' }}</dd>
            </div>
            <AppButton v-if="!locked" variant="tertiary" underline aria-label="Change end location" @click="openSheet('end')">Change</AppButton>
          </div>
        </dl>

        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>

        <SplitView v-model:view="view" label="Meeting area">
          <template #list>
            <!-- Step 5: the meeting point. While the planner works it out a segmented bar fills up; at 100% the place
                 appears. -->
            <section v-if="loading || session.meeting" class="area" :class="{ 'is-finding': loading }" aria-labelledby="area-head" :role="loading ? 'status' : undefined">
              <template v-if="loading">
                <h2 id="area-head" class="title-md">Finding the meeting point</h2>
                <SegmentedProgress :value="loadPct" label="Checking everyone's travel time" />
              </template>
              <div v-else class="area__main area__main--reveal">
                <div class="area__place">
                  <span class="area__pin"><AppIcon name="pin" :size="20" /></span>
                  <div class="area__name">
                    <span class="caption area__eyebrow">Meet at</span>
                    <h2 id="area-head" class="display-lg">{{ session.area.name }}</h2>
                  </div>
                </div>
                <dl v-if="tripFacts.length" class="area__facts">
                  <div v-for="f in tripFacts" :key="f.label" class="area__fact">
                    <dd class="title-md tnum">{{ f.minutes }} min</dd>
                    <dt class="caption-sm text-muted">{{ f.label }}</dt>
                  </div>
                </dl>
              </div>
            </section>
            <p v-if="session.areaNote" class="caption-sm text-muted">{{ session.areaNote }}</p>

            <section class="section people" aria-label="People">
              <ProgressDonut v-if="progress" compact :title="progress.title" :people="progress.people" :done-label="progress.label" />
              <MemberList :session="session" :names="nameOf" :voters="voterIds" />
              <p v-if="session.meeting && !loading" class="travel-key" aria-label="Travel time colours">
                <span v-for="t in TRAVEL_TONES" :key="t.id" class="travel-key__item"><span class="travel-key__dot" :class="`is-${t.id}`" />{{ t.label }}</span>
              </p>
            </section>
          </template>
          <template #map>
            <PlannerMap :people="mapPeople" :area="loading ? null : session.area" :finding="loading" spokes label="Meeting area map" />
            <div v-if="loading" class="map-wait map-wait--finding title-sm" role="status">Finding the meeting point… {{ Math.round(loadPct) }}%</div>
          </template>
        </SplitView>
      </template>
    </div>

    <footer v-if="status !== 'cancelled'" class="screen__footer">
      <AppButton v-if="status === 'inviting' && active.length < 2" block :to="`/sessions/${id}/invite`">Invite friends</AppButton>
      <AppButton v-else-if="status === 'inviting'" block :disabled="busy" @click="startSession">Start session</AppButton>
      <AppButton v-else-if="status === 'locating'" block :disabled="!session.meeting || busy || loading" @click="useArea">
        {{ loading ? 'Finding the meeting point…' : session.meeting ? 'Confirm location' : 'Waiting for everyone' }}
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
.invite-hint { margin: 0; }
/* Your route: a quiet grey strip, no border or shadow. Start (a small Rausch home) and end (an ink flag) joined
   by a dotted line, each with a Change link: stacked on phones, side by side from tablet up. */
.route { display: flex; flex-direction: column; margin: 0; padding: var(--spacing-md) var(--spacing-base); border-radius: var(--rounded-lg); background: var(--surface-soft); }
.route__stop { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-md); min-height: 52px; }
.route__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.route__text dd { margin: 0; }
.route__dot { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--rounded-full); }
.route__dot--from { background: var(--primary); color: var(--on-primary); }
.route__dot--to { border: 1.5px solid var(--ink); background: var(--canvas); color: var(--ink); }
.route__line { width: 0; height: 12px; margin-left: 15px; border-left: 2px dotted var(--border-strong); }
@media (min-width: 744px) {
  .route { flex-direction: row; align-items: center; gap: var(--spacing-lg); }
  .route__stop { flex: 0 1 auto; }
  /* The dotted line takes the space between the two ends, so each Set or Change stays next to its place. */
  .route__line { flex: 1 1 40px; min-width: 40px; max-width: 200px; height: 0; margin: 0; border-left: 0; border-top: 2px dotted var(--border-strong); }
}
/* The meeting point: the screen's Rausch moment. A pale Rausch wash (no border, no shadow) holding the pin, the
   place in large type, and three travel facts split by hairlines. */
.area { display: flex; flex-direction: column; gap: var(--spacing-base); padding: var(--spacing-lg); border-radius: var(--rounded-lg); background: color-mix(in srgb, var(--primary) 7%, var(--canvas)); }
.area__main { display: flex; flex-direction: column; gap: var(--spacing-lg); min-width: 0; }
.area__place { display: flex; align-items: center; gap: var(--spacing-md); min-width: 0; }
.area__name { display: flex; flex-direction: column; min-width: 0; }
.area__eyebrow { color: var(--primary-active); font-weight: 600; }
.area__pin { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); box-shadow: 0 0 0 6px color-mix(in srgb, var(--primary) 16%, transparent); }
.area__facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; padding-top: var(--spacing-base); border-top: 1px solid color-mix(in srgb, var(--primary) 18%, transparent); }
.area__fact { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.area__fact + .area__fact { padding-left: var(--spacing-base); border-left: 1px solid color-mix(in srgb, var(--primary) 18%, transparent); }
.area__fact dd { margin: 0; }
/* Finding the meeting point: a title over the segmented bar. When it is found, the place pops in. */
.area.is-finding { align-items: stretch; }
.area__main--reveal { animation: area-reveal 420ms var(--ease-spring) both; }
@keyframes area-reveal { from { opacity: 0; transform: translateY(6px) scale(0.97); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .area__main--reveal { animation: none; } }
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
