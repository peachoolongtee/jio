<script setup>
// The confirmed plan, on one screen. On the day itself it is titled "Today's plan".
//   - A timeline of stops: time and duration on one line, name, category icon, price tier, a photo, and the stop
//     number in its category colour (the same as its pin; the map has a key). The map shows the stops, the route and the
//     meeting area, and no one's start.
//   - Between stops: a visible Walk / MRT / Car switch, each with its own time. It moves every later stop.
//     Two stops in the same building just say so.
//   - On desktop the timeline is as tall as the map beside it, with the stops spread out.
//   - In edit mode (the pencil toggle in the header; confirmed plans only) each stop has a Replace button, a delete
//     button (two stops or more) and a drag handle, with a confirm dialog for delete. Focus lands on the next stop after
//     a delete. Replace is the host's, like the rain swap: it opens the plan page for that one stop (/sessions/:id/plan?replace=<slot>),
//     with the other places that fit it; choosing one puts it in and comes back here.
//     Outside edit mode the stops carry no controls.
//   - The end point, and each person's trip home (folded away; anyone over 60 minutes is flagged above).
//   - In edit mode, drag a stop by its handle (or focus the handle and use the arrow keys) to rearrange the day. Times follow;
//     a stop that would be closed at its new time, or an end far from the MRT, is flagged.
//   - Edit mode also shows "Re-plan".
//   - The footer's one button follows the session (itineraryAction in lib/session.js): before the day it is "Save plan",
//     which only goes Home (the plan was saved when it was confirmed); on the day it is "Finish outing", which asks
//     first, completes the outing and pays out the coins. A completed or cancelled session has neither.
//   - When the host confirmed a suggested order (see PlannerView), one line says where it came from (an AI suggestion,
//     or chosen by travel and waiting time) and why, above the stops until a stop is moved or deleted by hand.
//   - The photo strip shows the latest pictures (loaded with the events store) and links to Photos. (A session on the server has no photos
//     yet, so it has no strip.)
//   - A session on the server (session.remote): the plan is read from the database and every person sees the same one live. Only the host
//     edits it (the pencil, the travel modes, Replace, delete, drag, Re-plan) and finishes the outing; everyone else sees the plan, and the
//     footer says the host finishes it. Finishing pays no JioCoins there; a finished outing shows the person's own row of the travel ledger
//     ("Your travel"), with a Try again when it could not be read. A move, delete or change that the server refuses is one line of words
//     above the stops, and the page then shows the plan as it is stored. Changes made on another device (a move, a delete, a travel mode, a
//     place added or replaced, the end of the outing, a re-plan) arrive live, with no reload.
//   - While the plan is under way (roamOpen in lib/session.js: a confirmed plan on its day) a "What next?" button under the
//     stops opens the Roam page, and the places members proposed there appear under the stops as proposed stops
//     (ProposedStops). It is a secondary button: the footer's "Finish outing" stays the page's one main action.
//   - A plan with no stops (a light meetup started from Home, before anything is added) says "No stops yet" in place of
//     the timeline.
//   - Travel and trip-home times are estimates from distance, so they read "about" or "est.".
//   - Weather (a confirmed plan): a mark on each stop (Dry, Cloudy, Showers, Thundery showers, Not known; "Indoor" for an indoor
//     stop when rain is likely; "Outdoor, showers" for an exposed stop, in the warning tone) and one muted line under the stops
//     for the source and time. The marks are what the plan kept when it was confirmed. On the plan's day the screen asks the
//     planner for the stops' weather when it opens and every 30 minutes while it stays open (lib/weatherCheck.js; stopped when
//     the page is left, paused while hidden, one at a time, a failure keeps the last answer), and shows a rain banner for
//     everyone, with "Swap to <indoor place>?" for the host (RainBanners). A simulated forecast adds a banner at the top.
import { coins } from '@/lib/currency.js'
import { NO_COINS, earnsCoins, itineraryAction, roamOpen } from '@/lib/session.js'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import CoinBadge from '@/components/ui/CoinBadge.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import LedgerCard from '@/components/event/LedgerCard.vue'
import { RouterLink } from 'vue-router'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import RainBanners from '@/components/weather/RainBanners.vue'
import WeatherSource from '@/components/weather/WeatherSource.vue'
import SortableList from '@/components/ui/SortableList.vue'
import SplitView from '@/components/ui/SplitView.vue'
import ToastMessage from '@/components/ui/ToastMessage.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import SessionNotices from '@/components/event/SessionNotices.vue'
import ProposedStops from '@/components/event/ProposedStops.vue'
import StopCard from '@/components/event/StopCard.vue'
import CategoryKey from '@/components/map/CategoryKey.vue'
import { placeImage } from '@/lib/placeImages.js'
import TravelConnector from '@/components/event/TravelConnector.vue'
import PlannerMap from '@/components/map/PlannerMap.vue'
import NotFoundView from './NotFoundView.vue'
import { dayTime } from '@/lib/planner/format.js'
import { lateLine } from '@/lib/roam.js'
import { sourceIcon, sourceText } from '@/lib/confirmOrder.js'
import { POINTS_PER_MEETUP } from '@/lib/mock/people.js'
import { createWeatherCheck } from '@/lib/weatherCheck.js'
import { stopMark, venueSetting } from '@/lib/weatherText.js'
import { watchSessions } from '@/lib/api.js'
import { itineraryRain } from '@/lib/rainLook.js'
import { useNow } from '@/lib/useNow.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { usePlannerStore } from '@/stores/planner.js'

const props = defineProps({ id: { type: String, required: true } })

const router = useRouter()
const events = useEventsStore()
const auth = useAuthStore()
const planner = usePlannerStore()

// The session does not exist, or the person is not in it (the data layer's `not_found`), and why the page could not load it at
// all (no connection, the planner slow or down) with a Retry. The two are different pages: only the first is "not found".
const missing = ref(false)
const loadError = ref('')
const editing = ref(false)
const endOpen = ref(false)
const replanOpen = ref(false)
// The stop the Delete dialog is about: its key (the server's stop id, else the slot's) and its name, taken when the dialog opens. The key, not the
// stop's position: a stop moved or deleted on another device meanwhile must not make Delete take a different stop.
const removing = ref(null)
// How to call: askRemove(stop)
function askRemove(stop) {
  removing.value = { key: stop.stopId ?? stop.slotId, name: stop.venue.name }
}
const busy = ref(false)
const error = ref('')
const view = ref('list')
const selected = ref('')
const toast = ref(false)
// Arrived straight from "Confirm plan": say so, big and clear, until dismissed. The flag in the history entry is
// cleared as soon as it has been read, so a reload or Back to this page does not show the card again.
const justConfirmed = ref(!!window.history.state?.justConfirmed)
// A screen reader only reads a live region whose text changes after it is on the page, so the region is there from
// the start, empty, and the words are put in once the card has appeared.
const announcement = ref('')
let announceTimer = 0
function clearConfirmedFlag() {
  if (window.history.state?.justConfirmed) window.history.replaceState({ ...window.history.state, justConfirmed: false }, '')
}
const confirmedLine = computed(() => {
  const stops = itinerary.value?.stops || []
  const summary = stops.length ? ` ${stops.length} ${stops.length === 1 ? 'stop' : 'stops'}, starting ${dayTime(stops[0].start)}.` : ''
  return `Everyone in the group can see the itinerary now.${summary}`
})
function dismissConfirmed() {
  justConfirmed.value = false
  announcement.value = ''
  clearConfirmedFlag()
}

// Only the newest load speaks, so a slow answer for a page already left never changes what the person sees.
let loadTicket = 0
// How to call: load() (on mount, when the id changes, and from Retry)
async function load() {
  const ticket = ++loadTicket
  missing.value = false
  loadError.value = ''
  try {
    await events.loadSession(props.id)
    await events.loadItinerary(props.id)
  } catch (err) {
    if (ticket !== loadTicket) return
    if (err?.code === 'not_found') missing.value = true
    else loadError.value = err?.message || 'The plan could not be loaded.'
  }
}
// A shared session's plan changes arrive live while this page is open (a no-op for the demo and local accounts).
let stopWatching = () => {}
onMounted(() => {
  stopWatching = watchSessions()
  clearConfirmedFlag()
  load()
  // The demo's "Simulate rain" switch, which decides what the weather check asks for.
  planner.loadConditions().catch(() => {})
})
watch(() => props.id, load)

const session = computed(() => events.byId[props.id])
const itinerary = computed(() => events.itineraries[props.id])
const status = computed(() => session.value?.status)
const confirmed = computed(() => status.value === 'confirmed')
const today = computed(() => confirmed.value && session.value?.isToday)
// Does finishing pay? An outing of one person does not (lib/session.js earnsCoins), and the dialog and the toast say so.
const earns = computed(() => earnsCoins(session.value?.activeIds.length ?? 0))
// A session on the server: the plan is the database's, only the host changes it, and no JioCoins are paid (they are kept in each browser).
const remote = computed(() => !!session.value?.remote)
const isHost = computed(() => session.value?.hostId === auth.myId)
const mayEdit = computed(() => !remote.value || isHost.value)
// The toast after "Finish outing": what was paid, or why nothing was.
const toastText = computed(() => (remote.value ? 'Outing finished' : session.value?.paid === false ? `Completed · ${NO_COINS.toast}` : `Completed · +${coins(POINTS_PER_MEETUP)} to spend on sample café vouchers`))

// The person's own travel ledger row for a finished outing on the server, read when the outing is finished (here or on another device).
const ledgerState = computed(() => events.ledgers[props.id])
const ledgerLoading = ref(false)
// How to call: await loadLedger()
async function loadLedger() {
  ledgerLoading.value = true
  try {
    await events.loadLedger(props.id)
  } finally {
    ledgerLoading.value = false
  }
}
watch(
  () => remote.value && status.value === 'completed',
  (finished) => {
    if (finished) loadLedger()
  },
  { immediate: true },
)
// 'finish', 'save' or null: the footer's button.
const footer = computed(() => (session.value ? itineraryAction(session.value) : null))
// Under way: people can ask "What next?" and propose places.
const underway = computed(() => !!session.value && roamOpen(session.value))
const myId = computed(() => auth.myId)
const longTrips = computed(() => (itinerary.value?.trips || []).filter((t) => t.long))
const lastStop = computed(() => itinerary.value?.stops[itinerary.value.stops.length - 1])
// "Ends after the session's end, 21:30" when the plan runs past the end time the host set (stops added from Roam, or a long
// outing with many categories, can), else ''. Said under the plan's end; nothing is refused.
const lateText = computed(() => (lastStop.value ? lateLine(lastStop.value.end, session.value?.end) : ''))
// A confirmed plan with two or more stops can be rearranged, and a stop deleted, while editing.
const canMove = computed(() => confirmed.value && mayEdit.value && (itinerary.value?.stops.length || 0) > 1)
const canEdit = computed(() => canMove.value && editing.value)
// Any stop of a confirmed plan can be replaced by the host while editing, even when it is the only one. Anyone else proposes a stop instead.
const canReplace = computed(() => confirmed.value && editing.value && session.value?.hostId === auth.myId)

// Open the plan page for one stop, to choose another place for it.
// How to call: replaceStop(stop)
const replaceStop = (stop) => router.push({ path: `/sessions/${props.id}/plan`, query: { replace: stop.slotId } })

// ── Weather ──
// The marks and the line come from the plan (kept when it was confirmed) until the check on the day has an answer; the check's
// answer, when there is one, is newer and wins.
const showWeather = computed(() => confirmed.value && !!itinerary.value)
const check = computed(() => events.weatherChecks[props.id])
// The shared clock: rain is drawn only while its forecast is current.
const now = useNow()
// A stop's weather: the check's if there is one, else the plan's. How to call: weatherOf(itinerary.stops[0]) -> { state: 'dry', ... } or null
const weatherOf = (stop) => check.value?.stops?.[stop.slotId] ?? stop.weather
// The mark under a stop, or null when the plan is not confirmed. How to call: markOf(itinerary.stops[0]) -> { label: 'Dry', tone: 'neutral', ... }
const markOf = (stop) => (showWeather.value ? stopMark(weatherOf(stop), venueSetting(stop.venue)) : null)
// The block the line reads: the latest check; else what the plan kept; else "not available" when the check failed and the plan
// kept nothing.
const weatherBlock = computed(() => {
  if (check.value?.weather) return check.value.weather
  if (itinerary.value?.weather) return itinerary.value.weather
  if (check.value?.failed) return { source: 'unavailable', reason: 'unavailable' }
  return null
})
// The rain on the map: a wash and drops over each stop where rain is likely (live or simulated forecast), and the chip that says
// where the forecast came from (lib/rainLook.js). None until the plan is confirmed, as the marks.
// How to call: mapRain.value -> { places: [{ lat, lng }], text: 'Rain likely · next 2 h' }
const mapRain = computed(() => (showWeather.value ? itineraryRain(itinerary.value?.stops, weatherOf, weatherBlock.value, now.value) : { places: [], text: '' }))
// The last check did not work, and there is a forecast from before to show next to that.
const refreshFailed = computed(() => !!check.value?.failed && !!(check.value?.weather || itinerary.value?.weather))

// The check on the day: when the itinerary of a confirmed plan opens on its day, and every 30 minutes while it stays open.
// It asks again at once when the stops change (a swap, a move, a delete) or the demo's rain switch is flipped, and not on
// anything else. It stops when the page is left.
const checker = createWeatherCheck({ run: () => events.checkWeather(props.id) })
const stopsKey = computed(() => (itinerary.value?.stops || []).map((s) => `${s.slotId}:${s.venue.id}:${s.start}`).join('|'))
const simulatedRain = computed(() => !!planner.conditions?.rain)
const checking = computed(() => today.value && !!itinerary.value)
// What the check was last asked for, so opening the screen asks once and not twice.
let askedFor = ''
watch(
  [checking, () => props.id],
  ([on]) => {
    checker.stop()
    if (!on) return
    askedFor = stopsKey.value
    checker.start()
  },
  { immediate: true },
)
watch([stopsKey, simulatedRain], ([key, rain], [, was]) => {
  if (!checker.active() || (key === askedFor && rain === was)) return
  askedFor = key
  checker.poke()
})
onBeforeUnmount(() => {
  checker.stop()
  stopWatching()
})

// Put the "Plan confirmed" words into the live region once the card is on screen.
watch(
  () => justConfirmed.value && confirmed.value && !!itinerary.value,
  (ready) => {
    clearTimeout(announceTimer)
    // The words are about the plan as it was confirmed: they go when it is no longer confirmed.
    if (!ready) {
      announcement.value = ''
      return
    }
    announceTimer = setTimeout(() => {
      announcement.value = `Plan confirmed. ${confirmedLine.value}`
    }, 400)
  },
  { immediate: true },
)
onBeforeUnmount(() => clearTimeout(announceTimer))
// "Plan confirmed" (the card and the words read out) describes the plan at the moment it was confirmed. A stop moved, added, deleted or
// replaced, a changed leg, or the end of the outing makes it untrue, so it goes then, whoever made the change.
watch(stopsKey, (key, was) => {
  if (justConfirmed.value && was && key !== was) dismissConfirmed()
})
watch(confirmed, (is) => {
  if (!is && justConfirmed.value) dismissConfirmed()
})

// The latest pictures for the strip, from the events store (a session summary has only photoCount). A failed load
// only leaves the strip without thumbnails; the count and the link stay.
const photos = computed(() => events.photos[props.id] || [])
const photoCount = computed(() => session.value?.photoCount || 0)
const loadPhotos = () => photoCount.value && events.loadPhotos(props.id).catch(() => {})
watch([() => props.id, photoCount], loadPhotos, { immediate: true })

const mapPlaces = computed(() =>
  (itinerary.value?.stops || []).map((s, i) => ({ id: s.venue.id, name: s.venue.name, lat: s.venue.lat, lng: s.venue.lng, label: String(i + 1), category: s.category })),
)

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

// After a delete the focused button is gone, so focus moves to the heading of the stop that took its place (or the
// new last stop), and to the list itself if there is none. A newer load can still be on its way when the delete
// returns, so wait until the list has really lost a stop before looking for the heading.
const timeline = ref(null)
function whenShorterThan(count) {
  return new Promise((resolve) => {
    if ((itinerary.value?.stops.length ?? 0) < count) return resolve()
    const stop = watch(() => itinerary.value?.stops.length ?? 0, (n) => n < count && done())
    const timer = setTimeout(done, 2000)
    function done() {
      stop()
      clearTimeout(timer)
      resolve()
    }
  })
}
async function removeStop() {
  const target = removing.value
  removing.value = null
  const stops = itinerary.value?.stops ?? []
  const index = stops.findIndex((s) => (s.stopId ?? s.slotId) === target?.key)
  if (index < 0) {
    error.value = 'That stop is not in the plan any more.'
    return
  }
  const count = stops.length
  await act(() => events.deleteStop(props.id, index))
  if (error.value) return
  await whenShorterThan(count)
  await nextTick()
  const names = timeline.value?.querySelectorAll('.stop__name') || []
  const next = names[Math.min(index, names.length - 1)] || timeline.value
  next?.focus()
}

async function replan() {
  busy.value = true
  error.value = ''
  try {
    await events.replan(props.id)
    replanOpen.value = false
    router.push(`/sessions/${props.id}/plan`)
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function endPlan() {
  busy.value = true
  error.value = ''
  try {
    await events.endPlan(props.id)
    endOpen.value = false
    editing.value = false
    toast.value = true
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else-if="loadError" class="screen" data-testid="plan-load-error">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <EmptyState title="Could not load this plan" :text="loadError" role="alert">
        <AppButton variant="secondary" @click="load">Retry</AppButton>
      </EmptyState>
    </div>
  </main>
  <main v-else-if="session" class="screen" data-testid="event-view">
    <SessionHeader :session="session" :title="today ? 'Today\'s plan' : ''">
      <template v-if="session.plan" #actions>
        <IconButton v-if="confirmed && mayEdit" label="Edit itinerary" :tone="editing ? 'brand' : ''" :aria-pressed="String(editing)" @click="editing = !editing">
          <AppIcon :name="editing ? 'check' : 'edit'" />
        </IconButton>
      </template>
    </SessionHeader>

    <div class="screen__body">
      <SessionNotices :session="session" />
      <WeatherSource v-if="showWeather" :block="weatherBlock" banner />
      <RainBanners v-if="today && itinerary" :session="session" :itinerary="itinerary" :my-id="myId" />

      <EmptyState v-if="!session.plan" title="No itinerary yet">
        <AppButton variant="secondary" :to="`/sessions/${id}/plan`">Vote on places</AppButton>
      </EmptyState>

      <template v-else>
        <p class="sr-only" role="status">{{ announcement }}</p>
        <Transition name="celebrate" appear>
          <section v-if="justConfirmed && confirmed" class="celebrate" aria-labelledby="celebrate-title">
            <span class="celebrate__icon"><AppIcon name="check" :size="22" /></span>
            <div class="celebrate__text">
              <h2 id="celebrate-title" class="display-sm">Plan confirmed</h2>
              <p class="body-sm">{{ confirmedLine }}</p>
            </div>
            <IconButton label="Dismiss" class="celebrate__close" @click="dismissConfirmed"><AppIcon name="close" :size="16" /></IconButton>
          </section>
        </Transition>
        <BannerNote v-if="status === 'completed' && session.paid !== false && !remote" icon="trophy">
          Completed · +{{ POINTS_PER_MEETUP }} points each to spend on sample café vouchers
          <template #actions>
            <AppButton small variant="secondary" to="/rewards">Rewards</AppButton>
          </template>
        </BannerNote>
        <BannerNote v-for="trip in longTrips" :key="trip.id" tone="warning" icon="warning">
          Long trip home: {{ trip.name }}, about {{ trip.minutes }} min
        </BannerNote>

        <LedgerCard v-if="remote && status === 'completed'" :ledger="ledgerState?.row ?? null" :loading="ledgerLoading" :failed="!!ledgerState?.failed" :loaded="!!ledgerState" @retry="loadLedger" />

        <!-- Photos from the day: always here once the plan is set, so it is clear where to add them. -->
        <RouterLink v-if="!remote" :to="`/sessions/${id}/photos`" class="photos-cta">
          <span class="photos-cta__icon" aria-hidden="true"><AppIcon name="camera" :size="20" /></span>
          <span class="photos-cta__text">
            <span class="title-sm">Photos from the day</span>
            <span class="caption-sm text-muted">{{ photoCount ? `${photoCount} ${photoCount === 1 ? 'photo' : 'photos'} so far. Add yours.` : 'Add your photos for everyone in the group to see.' }}</span>
          </span>
          <span v-if="photoCount" class="photos-cta__strip" aria-hidden="true">
            <img v-for="p in photos.slice(-3)" :key="p.id" :src="p.src" alt="" />
          </span>
          <span class="photos-cta__go" aria-hidden="true"><span class="photos-cta__word">Add photos</span> <AppIcon name="arrow-right" :size="16" /></span>
        </RouterLink>
        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>

        <!-- Where the suggested order came from, when the host confirmed it. Moving or deleting a stop by hand clears it. -->
        <p v-if="itinerary?.aiNote" class="ai-note caption-sm text-muted" role="status">
          <AppIcon :name="sourceIcon(itinerary.aiNote)" :size="14" />
          <span>{{ sourceText(itinerary.aiNote) }}</span>
        </p>

        <SplitView v-model:view="view" label="Itinerary" even>
          <template #list>
            <div v-if="!itinerary" class="stack gap-md">
              <SkeletonRow v-for="n in 3" :key="n" avatar />
            </div>
            <template v-else>
              <!-- A light meetup (Roam from Home) starts with no stops: it says so, and "What next?" below is the way in. -->
              <EmptyState v-if="!itinerary.stops.length" title="No stops yet" text="Find something nearby with What next?, then add it to the plan." data-testid="no-stops" />
              <div v-else ref="timeline" class="timeline card" tabindex="-1">
                <SortableList
                  :items="itinerary.stops"
                  :item-key="(s) => s.slotId"
                  :item-label="(s) => s.venue.name"
                  :disabled="!canEdit"
                  label="Stops"
                  @move="moveStop"
                >
                  <template #item="{ item: stop, index: i, dragging, lifted, handle }">
                    <!-- The legs belong to pairs of stops, so they step aside while a stop is dragged. -->
                    <div v-if="i > 0" v-show="!dragging" class="timeline__leg">
                      <TravelConnector
                        :options="itinerary.legs[i - 1].options"
                        :mode="itinerary.legs[i - 1].mode"
                        :readonly="!confirmed || !mayEdit"
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
                      :warning="stop.open === false ? 'Closed at this time' : stop.withinWindow === false ? 'Past the session end' : stop.withinStay === false ? 'Past the group’s stay-until time' : ''"
                      :mark="markOf(stop)"
                      :lifted="lifted || selected === stop.venue.id"
                    >
                      <template v-if="canReplace || canEdit" #actions>
                        <IconButton v-if="canReplace" outline :label="`Replace stop: ${stop.venue.name}`" :data-testid="`replace-${stop.slotId}`" @click="replaceStop(stop)"><AppIcon name="search" /></IconButton>
                        <IconButton v-if="canEdit" outline :label="`Delete stop: ${stop.venue.name}`" @click="askRemove(stop)"><AppIcon name="trash" /></IconButton>
                      </template>
                      <template v-if="canEdit" #handle>
                        <button v-bind="handle" class="drag-handle"><AppIcon name="grip" /></button>
                      </template>
                    </StopCard>
                  </template>
                </SortableList>
                <div v-if="itinerary.end" class="timeline__end">
                  <span class="timeline__flag" aria-hidden="true"><AppIcon name="flag" :size="14" /></span>
                  <div class="stack">
                    <span class="title-sm">Ends {{ dayTime(lastStop.end) }}</span>
                    <span v-if="lateText" class="timeline__warning caption-sm" data-testid="plan-late"><AppIcon name="warning" :size="12" /> {{ lateText }}</span>
                    <span class="caption-sm text-muted">about {{ itinerary.end.mrtWalk }} min walk to {{ itinerary.end.mrt }} MRT</span>
                    <span v-if="itinerary.end.farFromMrt" class="timeline__warning caption-sm"><AppIcon name="warning" :size="12" /> Far from the MRT</span>
                  </div>
                </div>
              </div>

              <WeatherSource v-if="showWeather" :block="weatherBlock" :refresh-failed="refreshFailed" />

              <ProposedStops v-if="confirmed" :session="session" :itinerary="itinerary" :my-id="myId" @emptied="timeline?.focus()" />

              <AppButton v-if="underway" variant="secondary" class="whatnext" :to="`/sessions/${id}/roam`">
                <AppIcon name="sparkle" />
                What next?
              </AppButton>

              <details v-if="itinerary.trips.length" class="home">
                <summary class="home__summary">
                  <span class="title-sm">Trips home</span>
                  <span class="caption-sm text-muted">Longest about {{ Math.max(...itinerary.trips.map((t) => t.minutes)) }} min</span>
                  <AppIcon name="chevron-down" class="home__chevron" />
                </summary>
                <ul class="home__list">
                  <li v-for="trip in itinerary.trips" :key="trip.id" class="home__row" :class="{ 'is-long': trip.long }">
                    <span class="body-sm">{{ trip.name }}</span>
                    <span class="caption-sm text-muted truncate">{{ trip.place }}</span>
                    <span class="caption home__min">about {{ trip.minutes }} min</span>
                  </li>
                </ul>
              </details>

              <AppButton v-if="editing && confirmed" variant="tertiary" underline class="replan" @click="replanOpen = true">Re-plan</AppButton>
            </template>
          </template>

          <template #map>
            <PlannerMap :places="mapPlaces" :area="itinerary?.area" :rain="mapRain.places" :rain-label="mapRain.text" route fit-to="places" label="Itinerary map" :selected="selected" @select="selected = $event" />
            <CategoryKey :categories="mapPlaces.map((p) => p.category)" />
            <AppButton variant="secondary" small class="map-open" :to="`/sessions/${id}/map`">
              <AppIcon name="expand" />
              View map
            </AppButton>
          </template>
        </SplitView>
      </template>
    </div>

    <footer v-if="footer" class="screen__footer">
      <AppButton v-if="footer === 'finish' && mayEdit" block :disabled="busy" @click="endOpen = true">Finish outing</AppButton>
      <!-- Only the host finishes an outing on the server. -->
      <template v-else-if="footer === 'finish'">
        <p class="caption text-muted footer-note" data-testid="host-finishes">{{ session.hostName || 'The host' }} finishes the outing.</p>
        <AppButton block variant="secondary" to="/">Back to Home</AppButton>
      </template>
      <AppButton v-else block to="/">Save plan</AppButton>
    </footer>

    <ModalDialog v-model:open="endOpen" title="Finish outing?">
      <template #content>
        <p v-if="remote" class="body-md" data-testid="remote-finish">The outing ends for everyone. Jio keeps how far each of you travelled.</p>
        <p v-else-if="earns" class="body-md" data-testid="earns-coins">+<CoinBadge :amount="POINTS_PER_MEETUP" /> each for {{ session.activeIds.length }} people, to spend on sample café vouchers</p>
        <p v-else class="body-md" data-testid="no-coins">{{ NO_COINS.before }}</p>
        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
      </template>
      <AppButton block :disabled="busy" @click="endPlan">Finish outing</AppButton>
      <AppButton block variant="secondary" @click="endOpen = false">Not yet</AppButton>
    </ModalDialog>

    <ModalDialog :open="removing !== null" :title="removing ? `Delete ${removing.name}?` : 'Delete stop?'" @update:open="(v) => !v && (removing = null)">
      <AppButton block variant="secondary" @click="removing = null">Keep</AppButton>
      <AppButton block variant="danger" @click="removeStop">Delete</AppButton>
    </ModalDialog>

    <ModalDialog v-model:open="replanOpen" title="Re-plan?">
      <template #content>
        <p class="body-md">Back to voting. Votes are kept unless the meeting area moves.</p>
        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
      </template>
      <AppButton block variant="secondary" @click="replanOpen = false">Keep plan</AppButton>
      <AppButton block :disabled="busy" @click="replan">Re-plan</AppButton>
    </ModalDialog>

    <ToastMessage v-model:show="toast" :text="toastText" :offset="120" />
  </main>
  <main v-else class="screen" data-testid="event-view">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <p class="sr-only" role="status">Loading the plan</p>
      <SkeletonRow v-for="n in 4" :key="n" avatar />
    </div>
  </main>
</template>

<style scoped>
/* The latest photos from the day, as a stack of thumbnails linking to Photos. */
/* Photos from the day: a row that leads to the photos page, with the latest few and "Add photos". */
.photos-cta { display: flex; align-items: center; gap: var(--spacing-md); padding: var(--spacing-md) var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); color: var(--ink); text-decoration: none; transition: border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out); }
@media (hover: hover) { .photos-cta:hover { border-color: var(--border-strong); box-shadow: var(--shadow-float); } .photos-cta:hover .photos-cta__go { text-decoration: underline; } }
.photos-cta:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.photos-cta__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); }
.photos-cta__text { flex: 1 1 0; display: flex; flex-direction: column; min-width: 0; }
.photos-cta__strip { display: inline-flex; }
.photos-cta__strip img { width: 36px; height: 36px; margin-left: -8px; border-radius: 10px; object-fit: cover; box-shadow: 0 0 0 2px var(--canvas); transform: rotate(-3deg); }
.photos-cta__strip img:nth-child(even) { transform: rotate(3deg); }
.photos-cta__go { flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; color: var(--primary-active); font: var(--text-button-sm); }
/* Phones: no thumbnails, and just the arrow, so the words have room. */
@media (max-width: 743px) { .photos-cta__strip, .photos-cta__word { display: none; } }
/* Opens the full-screen map screen. On desktop SplitView's own expand control does this job. */
.map-open { position: absolute; top: var(--spacing-md); right: var(--spacing-md); z-index: 500; box-shadow: var(--shadow-float); }
@media (min-width: 1128px) { a.map-open, button.map-open { display: none; } }

/* The timeline: one rail joins every stop, leg and the end point. */
.timeline:focus { outline: none; }
.ai-note { display: flex; align-items: flex-start; gap: 6px; margin: 0; }
.ai-note :deep(svg) { flex-shrink: 0; margin-top: 2px; }
.timeline:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
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
.footer-note { margin: 0 0 var(--spacing-sm); text-align: center; }
.whatnext { align-self: flex-start; }

/* "Plan confirmed", right after confirming: a warm card that pops in under the confetti. */
.celebrate { position: relative; display: flex; align-items: center; gap: var(--spacing-base); padding: var(--spacing-base) calc(var(--tap-min) + var(--spacing-md)) var(--spacing-base) var(--spacing-base); border-radius: var(--rounded-md); background: linear-gradient(120deg, color-mix(in srgb, var(--primary-bright) 14%, var(--canvas)), color-mix(in srgb, var(--cat-shop-fg) 12%, var(--canvas))); }
.celebrate__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); box-shadow: 0 0 0 6px color-mix(in srgb, var(--primary-bright) 18%, transparent); }
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
