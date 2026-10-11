<script setup>
// The session: people, locations and the meeting spot (the Locate step).
//   Inviting  the people list with an Invite button. Below 2 people the main button is "Invite friends";
//             from 2 people (including Ian) it is "Start session"
//   Locating  Ian's start and end, then "Where to meet": the meeting spots (the app's three and each member's own
//             suggestion) with everyone's travel time, "Works for me" on each, and a map with a pin for every spot.
//             From two starts on the list opens; the host confirms a spot at any time ("Confirm <area>", the one
//             main action; others see who they are waiting for) or sets a known place ("We already have a place").
//             While the planner works the spots out, the list and the map say so.
//             While some people have not set a start, a card lists them. The host can carry on without each one
//             (after a confirmation); others only see who it is waiting for.
//   Voting+   the same page, settled: one card with the confirmed meeting spot, everyone's travel time to it in the
//             people list (coloured, with a key; no votes ring and no status icons, which belong to the Vote step),
//             and the map with the meeting pin and a line from each person's start. The other spots are gone. The
//             footer's button is named for where it goes: "Choose places", then "Today's plan" or "See the plan".
//             Confirming a spot, or naming a known place, leaves the person here; it does not jump to Vote.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import ProgressDonut from '@/components/ui/ProgressDonut.vue'
import SegmentedProgress from '@/components/ui/SegmentedProgress.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import SplitView from '@/components/ui/SplitView.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import SessionNotices from '@/components/event/SessionNotices.vue'
import InviteDialog from '@/components/group/InviteDialog.vue'
import LocationSheet from '@/components/group/LocationSheet.vue'
import MemberList from '@/components/group/MemberList.vue'
import PlannerMap from '@/components/map/PlannerMap.vue'
import SpotConfirm from '@/components/spots/SpotConfirm.vue'
import SpotList from '@/components/spots/SpotList.vue'
import SpotPins from '@/components/spots/SpotPins.vue'
import { confirmedAreaId, settledView, shownFor, spotsToShow } from '@/components/spots/spotText.js'
import NotFoundView from './NotFoundView.vue'
import { voters as votersOf } from '@/lib/planner/confirm.js'
import { locateNext } from '@/lib/session.js'
import { TRAVEL_TONES } from '@/lib/planner/travel.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore, waitingFor } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'

const props = defineProps({ id: { type: String, required: true } })

const auth = useAuthStore()
const events = useEventsStore()
const groups = useGroupsStore()

const missing = ref(false)
const busy = ref(false)
const error = ref('')
const sheet = ref({ open: false, which: 'start' })
const view = ref('list')
const mapRef = ref(null)
const pinsRef = ref(null)
// The spot the person picked in the list or on the map; empty until they pick one (see shown).
const picked = ref('')

async function load() {
  missing.value = false
  try {
    await Promise.all([events.loadSession(props.id), groups.loadPeople()])
  } catch {
    missing.value = true
  }
}
onMounted(load)
watch(() => props.id, () => { picked.value = ''; load() })

const session = computed(() => events.byId[props.id])
const status = computed(() => session.value?.status)
const nameOf = (id) => (id === 'ian' ? auth.user?.name ?? '' : groups.nameOf(id))
const active = computed(() => session.value?.activeIds || [])
const voterIds = computed(() => (session.value ? votersOf(session.value.votes, active.value) : []))
const locked = computed(() => ['confirmed', 'completed', 'cancelled'].includes(status.value))
// While inviting: everyone joined or invited, the host first, with @username and home area (as on the invite page).
// The ring counts who has joined out of everyone invited.
const lobby = computed(() =>
  (session.value?.members || [])
    .filter((m) => ['joined', 'invited'].includes(m.state))
    .map((m) => {
      const p = m.id === 'ian' ? { username: auth.user?.username, homeArea: auth.user?.homeAreaName } : groups.people.find((x) => x.id === m.id) || {}
      return { id: m.id, name: nameOf(m.id), host: m.role === 'host', joined: m.state === 'joined', username: p.username || '', homeArea: p.homeArea || '' }
    }),
)
const lobbyRing = computed(() => lobby.value.map((p) => ({ name: p.name, done: p.joined })))
const inviteOpen = ref(false)

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

const myId = computed(() => auth.user?.id || 'ian')
// The group is choosing where to meet: the spots are listed, and the meeting area is what the host confirms.
const choosing = computed(() => status.value === 'locating')
// The spots as the list shows them: while choosing, as the data layer keeps them; after a spot is confirmed, the same
// spots with the confirmed one first.
const spotList = computed(() => (session.value ? spotsToShow(session.value) : []))
const confirmedId = computed(() => (session.value ? confirmedAreaId(session.value) : ''))
// The spot shown as chosen: the one picked, otherwise the confirmed one, otherwise the one most people said works for them.
const shown = computed(() => (session.value ? shownFor(session.value, picked.value) : null))
const shownSpot = computed(() => spotList.value.find((s) => s.areaId === shown.value) || null)
// The map keeps every spot in view.
const keepPoints = computed(() => spotList.value.map((s) => ({ lat: s.area.lat, lng: s.area.lng })))
// Where a point is on the map, for the pins laid over it.
// How to call: projectPoint(1.35, 103.82) -> { x, y }
const projectPoint = (lat, lng) => mapRef.value?.project(lat, lng) ?? null
const refreshPins = () => pinsRef.value?.refresh()

// Once a spot is confirmed: the meeting area and everyone's trip to it. Null while the group is choosing.
const settled = computed(() => (session.value ? settledView(session.value, nameOf) : null))

// The footer's button once settled, named for where it goes.
const next = computed(() => (session.value ? locateNext(session.value) : null))

// Map pins: each person's start AREA, with their travel time to the spot shown (the confirmed one once settled).
const mapPeople = computed(() =>
  settled.value ? settled.value.people : active.value
    .filter((id) => session.value.locations?.[id]?.start)
    .map((id) => {
      const start = session.value.locations[id].start
      const times = shownSpot.value?.times
      return { id, name: nameOf(id), lat: start.lat, lng: start.lng, areaName: start.name, minutes: times?.[id] ?? null }
    }),
)

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

// Who the meeting area is waiting for. Only the host can carry on without someone, and never without themself.
const waiting = computed(() => (session.value ? waitingFor(session.value) : []).map((id) => ({ id, name: nameOf(id), me: id === auth.user?.id })))
const isHost = computed(() => !!session.value && session.value.hostId === auth.user?.id)
const skipOpen = ref(false)
const skipTarget = ref(null)
function askSkip(person) {
  error.value = ''
  skipTarget.value = person
  skipOpen.value = true
}
const continueWithout = () => run(() => events.optOut(props.id, skipTarget.value.id), () => { skipOpen.value = false })

const hostName = computed(() => nameOf(session.value?.hostId) || 'the host')
// The meeting spots changed what the people card shows: while choosing, their trips are to each spot, not to a meeting
// area, so the card does not claim one.
const peopleSession = computed(() => (choosing.value ? { ...session.value, meeting: null } : session.value))
const hasMeetingTrips = computed(() => Object.keys(session.value?.meeting?.times || {}).length > 0)
// Approvals that went with a spot that left the list: the data layer leaves a banner that says so.
const approvalsBanner = computed(() => (choosing.value && session.value?.banner?.approvalsRemoved ? session.value.banner : null))
async function dismissBanner() {
  try {
    await events.dismissBanner(props.id)
  } catch {
    // The banner stays; dismissing it again is the retry.
  }
}

// Confirming a spot (or naming a known place) moves the session on to Voting, and the person stays on this page: the list
// stays, the confirmed spot is marked, and the footer's button becomes "Next". Say so to a screen reader, and put focus on
// "Next" when it was on the button or dialog that has just gone (otherwise it would fall to the top of the page).
const announcement = ref('')
const nextButton = ref(null)
watch(() => [props.id, status.value], async ([id, now], [beforeId, before]) => {
  if (id !== beforeId || before !== 'locating' || now !== 'voting') return
  const name = session.value?.area?.name
  announcement.value = `${name || 'The spot'} is confirmed. Press ${next.value?.label || 'Choose places'} to carry on.`
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const at = document.activeElement
  if (!at || at === document.body || at.closest?.('[role="dialog"], .screen__footer')) nextButton.value?.$el?.focus?.({ preventScroll: true })
})

// Start the session. It opens on this page, now the Locate step.
// How to call: startSession()
const startSession = () => run(() => events.start(props.id))
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else-if="session" class="screen" data-testid="group-detail-view">
    <SessionHeader :session="session" />

    <div class="screen__body">
      <p class="sr-only" role="status">{{ announcement }}</p>
      <SessionNotices :session="session" />
      <BannerNote v-if="approvalsBanner" icon="info" dismissible @dismiss="dismissBanner">{{ approvalsBanner.text }}</BannerNote>

      <!-- Inviting: who is in, whether the session can start, and Start session below. -->
      <section v-if="status === 'inviting'" class="card lobby" aria-labelledby="lobby-head">
        <header class="lobby__head">
          <h2 id="lobby-head" class="sr-only">Who is in</h2>
          <ProgressDonut compact title="Joined" :people="lobbyRing" done-label="Joined" />
          <AppButton variant="secondary" small @click="inviteOpen = true"><AppIcon name="user-plus" :size="16" />Invite</AppButton>
        </header>

        <div class="lobby__group">
          <h3 class="caption text-muted">In this session <span class="tnum">· {{ lobby.length }}</span></h3>
          <ul class="lobby__list">
            <li v-for="(person, i) in lobby" :key="person.id" class="lobby__row rise" :class="{ 'is-pending': !person.joined }" :style="{ '--i': i }">
              <UserAvatar :name="person.name" :person="person.id" :size="44" />
              <RouterLink :to="person.host ? '/profile' : `/people/${person.id}`" class="lobby__who">
                <span class="title-sm truncate">{{ person.name }}<template v-if="person.host"> (you)</template></span>
                <span class="caption-sm text-muted truncate"><template v-if="person.username">@{{ person.username }}</template><template v-if="person.username && person.homeArea"> · </template>{{ person.homeArea }}</span>
              </RouterLink>
              <span v-if="person.host" class="lobby__tag lobby__tag--host"><AppIcon name="crown" :size="14" />Host</span>
              <span v-else-if="person.joined" class="lobby__tag"><AppIcon name="check" :size="14" />Joined</span>
              <span v-else class="lobby__tag lobby__tag--pending"><AppIcon name="clock" :size="14" />Invited</span>
            </li>
          </ul>
        </div>
      </section>

      <template v-else>
        <!-- Ian's own start and end, like a ride's pickup and drop-off: two rows joined by a dotted line. Each whole
             row is the button for its own place, so it is clear which one you are changing. Only he sees the exact place. -->
        <div class="route" role="group" aria-label="Your locations">
          <component
            :is="locked ? 'div' : 'button'"
            :type="locked ? undefined : 'button'"
            class="route__row"
            :class="{ 'is-empty': !myLoc.start }"
            @click="!locked && openSheet('start')"
          >
            <span class="route__mark route__mark--from" aria-hidden="true" />
            <span class="route__text">
              <span class="caption-sm text-muted">Starting from</span>
              <span class="route__value truncate">{{ myLoc.start?.label || 'Add where you are starting' }}</span>
            </span>
            <AppIcon v-if="!locked" class="route__go" :name="myLoc.start ? 'chevron-right' : 'plus'" :size="18" />
          </component>
          <component
            :is="locked ? 'div' : 'button'"
            :type="locked ? undefined : 'button'"
            class="route__row"
            @click="!locked && openSheet('end')"
          >
            <span class="route__mark route__mark--to" aria-hidden="true" />
            <span class="route__text">
              <span class="caption-sm text-muted">Heading to after</span>
              <span class="route__value truncate">{{ myLoc.end ? myLoc.end.label : 'Back to where you started' }}</span>
            </span>
            <AppIcon v-if="!locked" class="route__go" name="chevron-right" :size="18" />
          </component>
        </div>

        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>

        <SplitView v-model:view="view" label="Meeting area">
          <template #list>
            <!-- While the planner works out the meeting point a segmented bar fills up. -->
            <section v-if="loading" class="area is-finding" aria-labelledby="area-head" role="status">
              <h2 id="area-head" class="title-md">Finding the meeting point</h2>
              <SegmentedProgress :value="loadPct" label="Checking everyone's travel time" />
            </section>
            <p v-if="session.areaNote" class="caption-sm text-muted">{{ session.areaNote }}</p>

            <!-- Settled: the confirmed meeting spot on its own, like a reservation card. Everyone's trip to it is in
                 the people list below and drawn on the map. -->
            <section v-if="settled && !loading" class="area" aria-labelledby="area-head">
              <div class="area__main area__main--reveal">
                <span class="area__pin" aria-hidden="true"><AppIcon name="pin" :size="20" /></span>
                <div class="area__text">
                  <span class="caption-sm text-muted">Meeting spot</span>
                  <h2 id="area-head" class="display-lg truncate">{{ settled.area.name }}</h2>
                </div>
              </div>
            </section>

            <!-- The meeting spots, while locating: members say which work for them and the host confirms one at any time. -->
            <SpotList
              v-else-if="!settled"
              :session="session"
              :my-id="myId"
              :names="nameOf"
              :selected-id="shown || ''"
              :is-host="isHost"
              :host-name="hostName"
              @select="picked = $event"
              @error="error = $event"
            />

            <!-- Locating, and the meeting area is waiting for people who have not set a start. -->
            <section v-if="waiting.length && !loading" class="section card" aria-labelledby="waiting-head">
              <h2 id="waiting-head" class="title-md">Waiting for {{ waiting.length }} {{ waiting.length === 1 ? 'person' : 'people' }}</h2>
              <p class="body-sm text-muted">Their trips are counted once they share where they start.<template v-if="isHost"> If someone is not going to, you can carry on without them.</template></p>
              <ul class="waiting" aria-label="People who have not set a start">
                <li v-for="person in waiting" :key="person.id" class="waiting__row">
                  <UserAvatar :name="person.name" :person="person.id" :size="36" />
                  <span class="title-sm truncate waiting__name">{{ person.me ? 'You' : person.name }}</span>
                  <span v-if="person.me" class="caption-sm text-muted">Add where you are starting, above</span>
                  <AppButton v-else-if="isHost" small variant="secondary" :disabled="busy" @click="askSkip(person)">Continue without {{ person.name }}</AppButton>
                </li>
              </ul>
            </section>

            <section class="section card" aria-label="People">
              <!-- Once the spot is confirmed this card is about the trips: no votes ring, no status icons. -->
              <ProgressDonut v-if="progress && !settled" compact :title="progress.title" :people="progress.people" :done-label="progress.label" />
              <MemberList :session="peopleSession" :names="nameOf" :voters="voterIds" :statuses="!settled" />
              <p v-if="!choosing && hasMeetingTrips && !loading" class="travel-key" aria-label="Travel time colours">
                <span v-for="t in TRAVEL_TONES" :key="t.id" class="travel-key__item"><span class="travel-key__dot" :class="`is-${t.id}`" />{{ t.label }}</span>
              </p>
            </section>
          </template>
          <template #map>
            <PlannerMap ref="mapRef" :people="mapPeople" :area="settled && !loading ? settled.area : null" :finding="loading" spokes :keep="settled ? [] : keepPoints" label="Meeting area map" @view="refreshPins" />
            <SpotPins v-if="!settled && spotList.length" ref="pinsRef" :spots="spotList" :selected-id="shown || ''" :confirmed-id="confirmedId" :project="projectPoint" :names="nameOf" :my-id="myId" @select="picked = $event" />
            <div v-if="loading" class="map-wait map-wait--finding title-sm" role="status">Finding the meeting point… {{ Math.round(loadPct) }}%</div>
          </template>
        </SplitView>
      </template>
    </div>

    <footer v-if="status !== 'cancelled'" class="screen__footer">
      <AppButton v-if="status === 'inviting' && active.length < 2" block @click="inviteOpen = true">Invite friends</AppButton>
      <AppButton v-else-if="status === 'inviting'" next block :disabled="busy" @click="startSession">Start session</AppButton>
      <SpotConfirm
        v-else-if="status === 'locating'"
        :session="session"
        :is-host="isHost"
        :host-name="hostName"
        :selected-id="shown || ''"
        :disabled="loading || busy"
        @error="error = $event"
      />
      <AppButton v-else ref="nextButton" next block :to="next.to">{{ next.label }}</AppButton>
    </footer>

    <InviteDialog v-model:open="inviteOpen" :session="session" />
    <ModalDialog v-model:open="skipOpen" :title="`Continue without ${skipTarget?.name || 'them'}?`" text="They leave this session, and the meeting point is worked out from the people who have shared where they start. This cannot be undone.">
      <template #content><p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p></template>
      <AppButton block variant="secondary" @click="skipOpen = false">Keep waiting</AppButton>
      <AppButton block variant="danger" :disabled="busy" @click="continueWithout">Continue without {{ skipTarget?.name }}</AppButton>
    </ModalDialog>
    <LocationSheet v-model:open="sheet.open" :which="sheet.which" :home="homeArea" @select="saveLocation" />
  </main>
  <main v-else class="screen" data-testid="group-detail-view">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <SkeletonRow v-for="n in 4" :key="n" avatar />
    </div>
  </main>
</template>

<style scoped>
/* Inviting: a card like the invite page's. A header with a ring of who has joined out of everyone invited, and
   Invite; then who is in, each with a Host, Joined or Invited tag. */
.lobby { gap: var(--spacing-lg); }
.lobby__head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-base); padding-bottom: var(--spacing-lg); border-bottom: 1px solid var(--hairline); }
.lobby__group { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.lobby__group h3 { margin: 0; }
.lobby__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.lobby__row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 68px; }
.lobby__row + .lobby__row { border-top: 1px solid var(--hairline-soft); }
.lobby__who { flex: 1 1 0; display: flex; flex-direction: column; min-width: 0; color: var(--ink); text-decoration: none; }
@media (hover: hover) { .lobby__who:hover .title-sm { text-decoration: underline; } }
.lobby__tag { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: 1px solid var(--hairline); border-radius: var(--rounded-full); color: var(--body); font: var(--text-caption); }
.lobby__tag--host { border-color: color-mix(in srgb, var(--primary) 35%, var(--canvas)); color: var(--primary-active); }
/* Invited, not joined yet: a dashed tag and a faded row, until they accept. */
.lobby__tag--pending { border-style: dashed; color: var(--muted); }
.lobby__row.is-pending .lobby__who, .lobby__row.is-pending :deep(.avatar) { opacity: 0.55; }
/* Your route: a plain white card with two rows, start over end, like a ride's pickup and drop-off. A filled Rausch
   dot marks the start, an ink ring the end, and a dotted line joins them down the left. */
.route { position: relative; display: flex; flex-direction: column; max-width: 560px; padding: var(--spacing-xs); border: 1px solid var(--hairline); border-radius: var(--rounded-lg); background: var(--canvas); }
.route::before { content: ""; position: absolute; left: calc(var(--spacing-xs) + var(--spacing-base) + 5px); top: 50%; height: 30px; margin-top: -15px; border-left: 2px dotted var(--border-strong); }
.route__row { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-base); min-height: 60px; padding: var(--spacing-sm) var(--spacing-base); border: 0; border-radius: var(--rounded-md); background: transparent; color: var(--ink); font: inherit; text-align: left; }
button.route__row { cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background-color var(--motion-fast) var(--ease-out); }
@media (hover: hover) { button.route__row:hover { background: var(--surface-soft); } }
button.route__row:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
.route__mark { width: 12px; height: 12px; border-radius: var(--rounded-full); }
.route__mark--from { background: var(--primary); box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary) 18%, transparent); }
.route__mark--to { border: 2px solid var(--ink); background: var(--canvas); }
.route__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.route__value { font: var(--text-title-sm); }
.route__go { color: var(--muted); }
/* No start yet: the row asks for it, in Rausch. */
.route__row.is-empty .route__value, .route__row.is-empty .route__go { color: var(--primary); }
/* The meeting spot once it is confirmed: a reservation-card style block. The pin is the screen's Rausch moment besides
   the CTA. While the planner is finding it, the same card holds a title over the segmented bar. */
.area { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); padding: var(--spacing-lg); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); box-shadow: var(--shadow-float); }
.area.is-finding { flex-direction: column; align-items: stretch; gap: var(--spacing-base); }
.area__main { display: flex; align-items: center; gap: var(--spacing-md); min-width: 0; }
.area__pin { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); }
.area__text { display: flex; flex-direction: column; min-width: 0; }
.area__text h2 { margin: 0; }
.area__main--reveal { animation: area-reveal 420ms var(--ease-spring) both; }
@keyframes area-reveal { from { opacity: 0; transform: translateY(6px) scale(0.97); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .area__main--reveal { animation: none; } }
/* Who the meeting area is waiting for: name on the left, the host's action after it (it wraps under the name on a narrow screen). */
.waiting { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.waiting__row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm) var(--spacing-md); padding: var(--spacing-sm) 0; }
.waiting__row + .waiting__row { border-top: 1px solid var(--hairline-soft); }
.waiting__name { flex: 1 1 120px; min-width: 0; }
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
