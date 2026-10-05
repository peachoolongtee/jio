<script setup>
// The session: people, locations and the meeting area (steps 2 to 5).
//   Inviting  the people list and "Start session" (2 people or more, including Ian)
//   Locating  Ian's start and end location, who has submitted (donut), the meeting area on a map
//             and "Use this area", which moves the session to Voting
//   Later     the same, read-only once the plan is confirmed
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
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

const donut = computed(() => {
  if (!session.value) return null
  const people = active.value.map((id) => ({ name: nameOf(id), id }))
  if (['voting', 'confirmed', 'completed'].includes(status.value)) {
    return { title: 'Votes', doneLabel: 'Voted', todoLabel: 'Not yet', people: people.map((p) => ({ name: p.name, done: voterIds.value.includes(p.id) })) }
  }
  return {
    title: 'Locations',
    doneLabel: 'Submitted',
    todoLabel: 'Waiting',
    people: people.map((p) => ({ name: p.name, done: !!session.value.locations?.[p.id]?.start })),
  }
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

const travelRows = computed(() => {
  if (!session.value) return []
  const max = session.value.meeting?.maxMinutes || 1
  return active.value.map((id) => {
    const start = session.value.locations?.[id]?.start
    const minutes = session.value.meeting?.times?.[id]
    return { id, name: nameOf(id), area: start?.name || '', minutes: start ? minutes : null, width: start && minutes != null ? `${Math.max(4, (minutes / max) * 100)}%` : '0%', longest: minutes === max && !!start }
  })
})
const locationCount = computed(() => mapPeople.value.length)

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
      <template v-if="status === 'inviting'">
        <section class="section" aria-labelledby="people-head">
          <div class="section__head">
            <h2 id="people-head" class="display-sm">People <span class="text-muted">{{ active.length }}</span></h2>
            <AppButton variant="secondary" small :to="`/sessions/${id}/invite`">
              <AppIcon name="user-plus" />
              Invite friends
            </AppButton>
          </div>
          <MemberList :session="session" :names="nameOf" compact />
          <EmptyState v-if="active.length < 2" title="Only you so far" text="A session needs at least 2 people, including you." />
        </section>
      </template>

      <template v-else>
        <div class="overview">
          <!-- Ian's own start and end. Only he sees the exact place. -->
          <section class="card" aria-labelledby="mine-head">
            <div class="row between">
              <h2 id="mine-head" class="title-md">Your locations</h2>
              <span v-if="locked" class="caption-sm text-muted row gap-xs"><AppIcon name="lock" :size="12" /> Read-only</span>
            </div>
            <dl class="mine">
              <div class="mine__row">
                <dt class="caption text-muted">Start</dt>
                <dd>
                  <span class="title-sm">{{ myLoc.start?.label || 'No location yet' }}</span>
                  <span v-if="myLoc.start && myLoc.start.label !== myLoc.start.name" class="caption-sm text-muted">{{ myLoc.start.name }}</span>
                </dd>
                <AppButton v-if="!locked" :variant="myLoc.start ? 'secondary' : 'primary'" small @click="openSheet('start')">{{ myLoc.start ? 'Change' : 'Set start' }}</AppButton>
              </div>
              <div class="mine__row">
                <dt class="caption text-muted">End</dt>
                <dd>
                  <span class="title-sm">{{ myLoc.end ? myLoc.end.label : 'Same as start' }}</span>
                  <span v-if="myLoc.end && myLoc.end.label !== myLoc.end.name" class="caption-sm text-muted">{{ myLoc.end.name }}</span>
                </dd>
                <AppButton v-if="!locked" variant="secondary" small @click="openSheet('end')">Change</AppButton>
              </div>
            </dl>
          </section>

          <section v-if="donut" class="card">
            <ProgressDonut :title="donut.title" :people="donut.people" :done-label="donut.doneLabel" :todo-label="donut.todoLabel" />
          </section>
        </div>

        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>

        <!-- Step 5: the meeting area. List and map side by side on desktop. -->
        <section class="section" aria-labelledby="area-head">
          <h2 id="area-head" class="display-sm">Meeting area</h2>
          <SplitView v-model:view="view" label="Meeting area">
            <template #list>
              <div v-if="session.meeting" class="area-card">
                <div class="row gap-sm">
                  <span class="area-card__pin"><AppIcon name="pin" :size="20" /></span>
                  <div class="stack">
                    <span class="caption text-muted">{{ status === 'locating' ? 'Fairest so far' : 'Meeting area' }}</span>
                    <span class="display-sm">{{ session.area.name }}</span>
                  </div>
                </div>
                <p class="body-md">{{ session.resultLine }}</p>
              </div>
              <EmptyState v-else title="Waiting for at least 2 locations" :text="`${locationCount} of ${active.length} people have a start location.`" />

              <ul class="travel" aria-label="Travel time to the meeting area">
                <li v-for="row in travelRows" :key="row.id" class="travel__row">
                  <span class="travel__who">
                    <span class="title-sm">{{ row.name }}</span>
                    <span class="caption-sm text-muted">{{ row.area || 'No location yet' }}</span>
                  </span>
                  <span v-if="row.minutes != null" class="travel__bar" aria-hidden="true"><span :class="{ 'is-longest': row.longest }" :style="{ width: row.width }" /></span>
                  <span class="caption travel__min">{{ row.minutes != null ? `${row.minutes} min` : '' }}</span>
                </li>
              </ul>
            </template>
            <template #map>
              <PlannerMap :people="mapPeople" :area="session.area" spokes label="Meeting area map" />
              <div v-if="!session.meeting" class="map-wait">
                <span class="title-sm">Waiting for at least 2 locations</span>
              </div>
            </template>
          </SplitView>
        </section>

        <section class="section" aria-labelledby="people-head-2">
          <div class="section__head">
            <h2 id="people-head-2" class="display-sm">People <span class="text-muted">{{ active.length }}</span></h2>
          </div>
          <MemberList :session="session" :names="nameOf" :voters="voterIds" />
        </section>
      </template>
    </div>

    <footer v-if="status !== 'cancelled'" class="screen__footer">
      <AppButton v-if="status === 'inviting'" block :disabled="active.length < 2 || busy" @click="startSession">
        {{ active.length < 2 ? 'Start session · needs 2 people' : 'Start session' }}
      </AppButton>
      <AppButton v-else-if="status === 'locating'" block :disabled="!session.meeting || busy" @click="useArea">
        {{ session.meeting ? `Use ${session.area.name}` : 'Use this area' }}
      </AppButton>
      <AppButton v-else-if="status === 'voting'" block :to="`/sessions/${id}/plan`">Choose activities</AppButton>
      <AppButton v-else block :to="`/sessions/${id}/itinerary`">{{ session.isToday && status === 'confirmed' ? "Today's plan" : 'View itinerary' }}</AppButton>
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
.overview { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--spacing-base); }
@media (min-width: 1128px) { .overview { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.mine { display: flex; flex-direction: column; gap: var(--spacing-sm); margin: 0; }
.mine__row { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-md); min-height: 48px; }
.mine__row dd { display: flex; flex-direction: column; min-width: 0; margin: 0; }
.area-card { display: flex; flex-direction: column; gap: var(--spacing-md); padding: var(--spacing-base); border-radius: var(--rounded-md); background: var(--primary-tint); }
.area-card__pin { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); }
.travel { display: flex; flex-direction: column; }
.travel__row { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 56px; align-items: center; gap: var(--spacing-md); min-height: 52px; border-bottom: 1px solid var(--hairline-soft); }
.travel__who { display: flex; flex-direction: column; min-width: 0; }
.travel__bar { height: 8px; border-radius: var(--rounded-full); background: var(--primary-tint); overflow: hidden; }
.travel__bar > span { display: block; height: 100%; border-radius: var(--rounded-full); background: var(--primary); transition: width var(--motion-fast) ease; }
.travel__bar > span.is-longest { background: var(--primary-active); }
.travel__min { text-align: right; }
.map-wait { position: absolute; left: 50%; top: 50%; z-index: 500; transform: translate(-50%, -50%); padding: var(--spacing-md) var(--spacing-base); border-radius: var(--rounded-md); background: var(--canvas); box-shadow: var(--shadow-float); text-align: center; }
</style>
