<script setup>
// Step 1: create a session. Title, a day from the calendar and a time window.
// The times sit to the right of the calendar from tablet up (start on top, end below), and under it on phones.
// Next stays disabled until the title, the date and the start time are set. A new session's times start filled in: the next
// round hour and three hours after it (defaultTimes in lib/session.js), so only the title and the day are left to choose. After
// 23:00 that start is after midnight, so the day starts as tomorrow (defaultDate); and a window that has already ended today is
// refused under the end time (endHasPassed), never a default for a day that is over, and a start that has gone is refused under the
// start time (startHasPassed). All of it on Singapore's clock. An edit that changes only the title is never held back by the clock.
// The same form edits a session (/sessions/:id/edit), reached from the invite step's back arrow or the steps bar's
// Create: the heading says "Edit session", the form starts with the session's title, day and times, and Next saves them
// and goes on to the invite step. The back arrow goes Home, as from the first step of any session. Only the host can
// edit, and only while the session is still inviting; after that the screen says the day and times are locked. Create and
// Invite are one stop in the browser's history (each replaces the other), so Back in the browser never returns to an
// empty create form.
// "We already have a place" is not asked here: it is on the Locate step, where the spots are (SpotList).
// A new session opens with a dropdown, "How are you starting?" (walkthrough, 30 October 2026): "From scratch" is the form above;
// "Already out" is Home's "Already out? Find something nearby" (RoamFromHome) brought into creating a session. It hides the day and
// times (it is today, from now), asks "Where are you?" (LocationSheet: an area, the home area or the current location), and its button,
// "Find places nearby", starts a light meetup there (events.startRoam) and opens its itinerary, the list of places nearby. The title is
// optional ("Out in <area>"). It is the quick form of the Start choice's "We already know where" (StartView), for when the person is
// there already and has nobody to wait for. Like Home's row it is for the demo and local accounts only: a shared session cannot be a
// light meetup yet, so a real account sees no dropdown. `?start=out` opens the form on "Already out".
//   <CreateEventView />                  /sessions/new
//   <CreateEventView id="s1" />          /sessions/s1/edit
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { addDays, format, parseISO } from 'date-fns'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import ClashDialog from '@/components/group/ClashDialog.vue'
import CalendarPicker from '@/components/ui/CalendarPicker.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import IconButton from '@/components/ui/IconButton.vue'
import SelectField from '@/components/ui/SelectField.vue'
import LocationSheet from '@/components/group/LocationSheet.vue'
import SessionSteps, { backFor } from '@/components/event/SessionSteps.vue'
import RadialTimePicker from '@/components/ui/RadialTimePicker.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import TextField from '@/components/ui/TextField.vue'
import NotFoundView from './NotFoundView.vue'
import { toMinutes } from '@/lib/planner/format.js'
import { exitFor, goBackIfBehind } from '@/lib/stepNav.js'
import { useReturnFocus } from '@/lib/useReturnFocus.js'
import { defaultDate, defaultSessionEnd, defaultTimes, endHasPassed, singaporeDate, startHasPassed } from '@/lib/session.js'
import { START_MODES, areaName, startModesFor } from '@/lib/startChoice.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'

const TITLE_IDEAS = ['Saturday hangout', 'Dinner catch-up', 'Weekend makan trip']
const DEFAULT_LENGTH = 6 * 60

const props = defineProps({ id: { type: String, default: '' } })
const router = useRouter()
const route = useRoute()
const events = useEventsStore()
const auth = useAuthStore()

const title = ref('')
// How the session starts: 'scratch' (pick a day and times) or 'out' (already somewhere, today). Only a new one asks.
const modes = computed(() => (props.id ? [] : startModesFor(auth.sampleWorld)))
const mode = ref(route.query.start === 'out' ? 'out' : 'scratch')
const out = computed(() => mode.value === 'out' && modes.value.some((m) => m.value === 'out'))
// Already out: the area picked in "Where are you?", and whether that sheet is open.
const place = ref(null)
const placeOpen = ref(false)
const homeArea = computed(() => (auth.user?.homeAreaId ? { id: auth.user.homeAreaId, name: auth.user.homeAreaName } : null))
// A new session starts with real times (and, late at night, with tomorrow as the day: the default start is after midnight); an
// edited one takes the session's own (fill, below).
const date = ref(props.id ? '' : defaultDate()) // yyyy-MM-dd
const startTimes = props.id ? { start: '', end: '' } : defaultTimes()
const start = ref(startTimes.start)
const end = ref(startTimes.end)
const busy = ref(false)
const error = ref('')
// The meetup in the way when the day and times overlap another the person is in (the popup).
const clash = ref(null)
const showClash = ref(false)
// Next is disabled while the save runs, so it hands focus back when the popup closes.
const { remember } = useReturnFocus(showClash)
// Someone else in the meetup is busy at the new time (a host's edit the database refused): said under the end time, and gone as soon
// as the day or a time changes.
const taken = ref('')

// Editing: the session in the store (from the invite step it is already there), whether it could not be found, and
// whether the form has taken its values yet (only once, so a live update never overwrites what is being typed).
const editing = computed(() => !!props.id)
const session = computed(() => (editing.value ? events.byId[props.id] : null))
const missing = ref(false)
let filled = false
const isHost = computed(() => session.value?.hostId === auth.myId)
const started = computed(() => !!session.value && session.value.status !== 'inviting')
// Why the form is not offered, or '' when it is.
const closed = computed(() => (!session.value ? '' : !isHost.value ? 'Only the host can change the date and times.' : started.value ? 'The date and times are locked once a session has started.' : ''))
// Create is the first step, so the arrow goes Home whether the session is new or being edited.
const back = computed(() => (editing.value && session.value ? backFor(session.value, route.path, isHost.value, exitFor()) : exitFor()))

async function load() {
  missing.value = false
  try {
    await events.loadSession(props.id)
  } catch {
    missing.value = !events.byId[props.id]
  }
}
// How to call: fill(events.byId.s1)
function fill(found) {
  if (!found || filled || closed.value) return
  filled = true
  title.value = found.title
  date.value = found.date
  start.value = found.start
  end.value = found.end
}
if (editing.value) onMounted(load)
watch(session, fill, { immediate: true })
// The same screen opened for another session: take that one's values.
watch(() => props.id, (id) => { if (!id) return; filled = false; fill(session.value); load() })

// Sessions can be planned up to three months ahead of today in Singapore.
const lastDay = format(addDays(parseISO(singaporeDate()), 90), 'yyyy-MM-dd')
// Without an end time the window runs six hours, up to midnight.
const endValue = computed(() => defaultSessionEnd(start.value, end.value, DEFAULT_LENGTH))
// Editing a session and leaving its day and times as they are: only the title changes, so a start or end that has passed since the
// session was made is not held against the edit (lib/api.js updateSession allows it too).
const timingKept = computed(() => !!session.value && date.value === session.value.date && start.value === session.value.start && endValue.value === session.value.end)
// Today, with a start that has gone in Singapore: shown under the start time.
const startError = computed(() => (!timingKept.value && startHasPassed(date.value, start.value) ? 'That start time has already passed today.' : ''))
const endError = computed(() => {
  if (start.value && toMinutes(endValue.value) <= toMinutes(start.value)) return 'End time must be after the start time.'
  // Today, with an end that has gone: the outing would be over before it began.
  return !timingKept.value && endHasPassed(date.value, endValue.value) ? 'That time has already passed today.' : ''
})
const ready = computed(() => title.value.trim().length > 0 && date.value !== '' && start.value !== '' && !startError.value && !endError.value)

const endShown = computed(() => endError.value || taken.value)
watch([date, start, end], () => { taken.value = '' })

// Already out: starts the light meetup where the person is and opens its itinerary (the places nearby) in place of this screen.
// How to call: await goOut()
async function goOut() {
  if (!place.value?.areaId || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const session = await events.startRoam({ areaId: place.value.areaId, title: title.value })
    await router.replace(`/sessions/${session.id}/itinerary`)
  } catch (e) {
    error.value = e?.message || 'Could not start. Try again.'
    busy.value = false
  }
}

// The area picked in "Where are you?": only the area is kept, with its name for the screen.
// How to call: pickPlace({ areaId: 'bugis', label: 'Bugis Junction' })
function pickPlace(picked) {
  if (!picked?.areaId) return
  place.value = { areaId: picked.areaId, areaName: areaName(picked.areaId) || picked.label || '' }
}

// Creates the session, or saves the changes to it, and goes on to the invite step in place of this screen.
// How to call: next()
async function next() {
  if (out.value) return goOut()
  if (!ready.value || busy.value) return
  busy.value = true
  error.value = ''
  taken.value = ''
  const values = { title: title.value, date: date.value, start: start.value, end: endValue.value }
  try {
    const saved = editing.value ? await events.update(props.id, values) : await events.create(values)
    router.replace(`/sessions/${saved.id}/invite`)
  } catch (e) {
    if (e?.code === 'schedule_clash') {
      clash.value = e.clash || null
      showClash.value = true
    } else if (e?.code === 'member_clash') {
      taken.value = e.message
    } else {
      error.value = e.message
    }
    busy.value = false
  }
}
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else class="screen screen--wide-form" data-testid="create-event-view">
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton :label="back.label" :to="back.to" @click.capture="goBackIfBehind($event, router, back.to)"><AppIcon name="back" /></IconButton>
      </div>
      <!-- Before the title, as on every session screen, so the bar does not move between them. -->
      <SessionSteps :session="session" />
      <div class="screen__titles">
        <h1 class="display-xl">{{ editing ? 'Edit session' : 'Create session' }}</h1>
      </div>
    </header>

    <div v-if="editing && !session" class="screen__body">
      <SkeletonRow v-for="n in 3" :key="n" />
    </div>

    <div v-else-if="closed" class="screen__body">
      <BannerNote icon="info">
        {{ closed }}
        <template #actions><AppButton variant="secondary" small :to="`/sessions/${id}`">Back to session</AppButton></template>
      </BannerNote>
    </div>

    <template v-else>
      <form class="screen__body" novalidate @submit.prevent="next">
        <SelectField v-if="modes.length > 1" v-model="mode" label="How are you starting?" :options="modes" data-testid="start-mode" />
        <p v-if="out" class="body-sm text-muted">{{ START_MODES.out.note }}</p>
        <div class="stack gap-xs">
          <TextField v-model="title" :label="out ? 'Title (optional)' : 'Title'" :placeholder="out ? `Out in ${place?.areaName || 'your area'}` : 'Name your session'" maxlength="60" />
          <div v-if="!out" class="scroll-x" role="group" aria-label="Title ideas">
            <ChipButton v-for="idea in TITLE_IDEAS" :key="idea" :selected="title === idea" @click="title = idea">{{ idea }}</ChipButton>
          </div>
        </div>

        <!-- Already out: where the person is, in place of the day and times. -->
        <div v-if="out" class="where">
          <span class="caption text-muted" aria-hidden="true">Where are you?</span>
          <button type="button" class="where__row" :class="{ 'is-empty': !place }" :aria-label="`Where are you? ${place ? place.areaName : 'Pick where you are'}`" data-testid="where-row" @click="placeOpen = true">
            <span class="where__icon" aria-hidden="true"><AppIcon name="locate" :size="20" /></span>
            <span class="where__value truncate">{{ place ? place.areaName : 'Pick where you are' }}</span>
            <AppIcon class="where__go" :name="place ? 'chevron-right' : 'plus'" :size="18" />
          </button>
        </div>

        <section v-else class="when" aria-labelledby="when-label">
          <span id="when-label" class="sr-only">Date and time</span>
          <CalendarPicker v-model="date" class="when__calendar" label="Date" :max="lastDay" />
          <div class="when__times">
            <RadialTimePicker v-model="start" label="Start time" fallback="09:00" :error="startError" />
            <RadialTimePicker v-model="end" label="End time" :fallback="endValue || '18:00'" :error="endShown" :hint="!end && start ? `Ends ${endValue} unless you change it` : ''" />
          </div>
        </section>
        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
      </form>

      <footer class="screen__footer">
        <AppButton v-if="out" next block :disabled="!place || busy" @click="goOut">{{ busy ? 'Starting' : 'Find places nearby' }}</AppButton>
        <AppButton v-else next block :disabled="!ready || busy" @click="remember($event); next()">Next</AppButton>
      </footer>
      <LocationSheet v-model:open="placeOpen" which="spot" title="Where are you?" :home="homeArea" @select="pickPlace" />
    </template>
    <ClashDialog v-model:open="showClash" :clash="clash" />
  </main>
</template>

<style scoped>

/* Already out: one row like Locate's "Starting from", opening the location sheet. */
.where { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.where__row { display: flex; align-items: center; gap: var(--spacing-md); width: 100%; min-height: 64px; padding: var(--spacing-md) var(--spacing-base); border: 1px solid var(--border-control); border-radius: var(--rounded-md); background: var(--canvas); color: var(--ink); font: var(--text-title-sm); text-align: left; cursor: pointer; }
.where__row.is-empty { color: var(--muted); }
@media (hover: hover) { .where__row:hover { border-color: var(--ink); background: var(--surface-soft); } }
.where__row:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.where__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); }
.where__value { flex: 1; min-width: 0; }
.where__go { flex-shrink: 0; color: var(--muted); }

/* Date and time: the calendar, then the times. Phones stack them; from tablet up the times sit to the right,
   start at the top and end at the bottom, each centred so its buttons have room to fly out. */
/* An open time ring reaches 141px above and below the middle of its time. This room keeps it 12px or more clear of
   the other time and of Next: the gap between the two times, and the space under the end time. */
.when { --ring-room: calc(var(--spacing-xxl) + var(--spacing-lg)); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--spacing-md) var(--spacing-xl); }
.when__times { display: flex; flex-direction: column; align-items: center; gap: var(--ring-room); padding: var(--spacing-base) 0 var(--ring-room); }
@media (min-width: 744px) {
  .when { grid-template-columns: minmax(0, 1fr) 240px; grid-template-areas: "calendar times"; }
  .when__calendar { grid-area: calendar; }
  .when__times { grid-area: times; justify-content: space-between; padding: var(--spacing-lg) 0 var(--ring-room); }
}
/* Tablet and up: the action follows the form, right-aligned at a normal width, instead of a full-width bar
   pinned to the bottom of the window. Phones keep the pinned bar, where the thumb is. */
@media (min-width: 744px) {
  .screen__body { flex: 0 0 auto; }
  .screen__footer { position: static; flex-direction: row; justify-content: flex-end; padding-top: 0; border-top: 0; }
}
</style>
