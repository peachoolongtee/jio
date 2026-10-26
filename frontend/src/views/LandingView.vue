<script setup>
// Home: a band across the top with a muted dotted map of Singapore. Routes draw in from around the island and meet at
// one point, with the greeting above. Below, on white, what comes next. Three states:
//   No active meetup        the band's action is a map pin in the middle, "Jio your friends", on the meeting point;
//                           below, Your meetups (past ones, or an empty state).
//   One or more going       every meetup that has a meeting point is a pin on the map (a button: its day on it), and the
//                           soonest is selected. The routes meet at the selected one's meeting area, only that pin bobs,
//                           and under the map a card shows it: when, where it stands, who is in, what it needs next from
//                           you, and Open meetup. With two or more, Your meetups lists them all (a row selects, like
//                           a pin; hovering or focusing a pin opens a small card of its details), and a meetup with no
//                           meeting point yet is there, with no pin. The first row of that list is "Plan a new meetup" /
//                           "Jio your friends" (StartMeetupRow), a link to the create screen that is not a meetup and
//                           never selects; with one meetup going it is the only row, under the card. Nothing sits in the
//                           map's corner, so no pin has a control beside it.
//   Meetup with a midpoint  Places near that meeting area below: places around it, nearest first, with one Filter
//                           button. They follow the selected meetup.
// The selected meetup lives in the address (?meetup=id), so a reload or a shared link opens the same one; an id that
// is not there falls back to the soonest. What decides the order, the pins and the next step is lib/homeMeetups.js.
// The filter has toggles (Touristy spots, Hidden gems, CDC Vouchers accepted, Food, Café),
// a budget slider (the most to spend per person) and a distance slider (from the midpoint).
// Tapping a place opens it (?place=id): its card grows into PlaceDetail and shrinks back on close. If the place
// cannot be loaded, PlaceDetail says so (or, for a link to a place that is not there, a note appears on Home).
// A failed load of the meetups or of the nearby places shows a message with a Retry button, never a skeleton for ever.
// An outing past its end time with no confirmed plan gets a banner that says when it closes by itself (lib/session.js
// overdueOuting). A confirmed one finishes by itself: when its end time passes while Home is open, the list is read again,
// which completes it (lib/api.js settleOutings). A shared outing is finished by its host, from its day on, so past its end time it gets a
// banner of its own that says so (nothing closes it by a clock).
// "Already out? Find something nearby" (RoamFromHome) sits under the meetups, or alone under the band when there are none,
// for a local account: it starts a light meetup around one area and opens its Roam list (ticket #98).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { format, parseISO } from 'date-fns'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import SingaporeMap from '@/components/ui/SingaporeMap.vue'
import PinButton from '@/components/ui/PinButton.vue'
import RangeSlider from '@/components/ui/RangeSlider.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import PlaceCard from '@/components/event/PlaceCard.vue'
import PlaceDetail from '@/components/event/PlaceDetail.vue'
import WeatherSource from '@/components/weather/WeatherSource.vue'
import InvitationList from '@/components/event/InvitationList.vue'
import SessionCard from '@/components/event/SessionCard.vue'
import MeetupDetail from '@/components/home/MeetupDetail.vue'
import MeetupList from '@/components/home/MeetupList.vue'
import MeetupPins from '@/components/home/MeetupPins.vue'
import RoamFromHome from '@/components/home/RoamFromHome.vue'
import * as api from '@/lib/api.js'
import { enterGame } from '@/lib/enterGame.js'
import { activeMeetups, dayLabel, pinName, pinsFor, routesFor, selectMeetup } from '@/lib/homeMeetups.js'
import { visibleSessions } from '@/lib/sessionFilter.js'
import { AREAS } from '@/lib/mock/places.js'
import { useHomeRain } from '@/lib/useHomeRain.js'
import { FADE_IN_MS, rainChipText } from '@/lib/rainLook.js'
import { project } from '@/lib/singaporeDots.js'
import RainChip from '@/components/weather/RainChip.vue'
import { dueEnding, overdueOuting, sessionPath, singaporeDate, singaporeDayTime } from '@/lib/session.js'
import { useNow } from '@/lib/useNow.js'
import { canViewTransition, withViewTransition } from '@/lib/viewTransition.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'
import { usePlannerStore } from '@/stores/planner.js'

const BUDGET = { min: 5, max: 60, step: 5 }
const DISTANCE = { min: 1, max: 20, step: 1 }
const PAGE = 12
const TOGGLES = [
  { key: 'touristy', label: 'Touristy spots' },
  { key: 'hidden', label: 'Hidden gems' },
  { key: 'cdc', label: 'CDC Vouchers accepted' },
  { key: 'food', label: 'Food' },
  { key: 'cafe', label: 'Café' },
]

const auth = useAuthStore()
const events = useEventsStore()
const groups = useGroupsStore()
const planner = usePlannerStore()

const places = ref([])
const loadingPlaces = ref(false)
const placesError = ref(false)
const loadError = ref(false)
const filterOpen = ref(false)
const shown = ref(PAGE)

const emptyFilters = () => ({ touristy: false, hidden: false, cdc: false, food: false, cafe: false, budget: BUDGET.max, distance: DISTANCE.max })
// What the list shows, and what the sheet is editing. "Show places" copies one to the other.
const filters = ref(emptyFilters())
const today = format(parseISO(singaporeDate()), 'EEEE d MMMM')
const editing = ref(emptyFilters())

// How to call: loadHome() (on mount, and from Retry)
async function loadHome() {
  loadError.value = false
  const jobs = [groups.loadPeople()]
  if (!events.loaded) jobs.push(events.loadSessions())
  try {
    await Promise.all(jobs)
  } catch {
    loadError.value = true
  }
}
// Shared sessions change while Home is open (someone joins, a session is called off, an invitation arrives).
let stopWatching = () => {}
onBeforeUnmount(() => stopWatching())
onMounted(() => {
  stopWatching = api.watchSessions()
  // Outings whose end time passed while Home was not on screen are settled now, not only when the clock next crosses one.
  loadHome().then(settleDue)
  // The demo's "Simulate rain" switch, which decides what the rain below asks for.
  planner.loadConditions().catch(() => {})
})

// ── The meetups ──
const route = useRoute()
const router = useRouter()
const now = useNow()
const nameOf = (id) => (id === auth.myId ? auth.user?.name ?? '' : groups.nameOf(id))
// The meetups still going (not completed or cancelled), soonest first, and the one selected: named by ?meetup=, else
// the soonest. Home is about the selected one.
// What the lists show: every session, unless the demo tour is on (lib/sessionFilter.js).
const sessions = computed(() => visibleSessions(events.sessions))
const meetups = computed(() => activeMeetups(sessions.value, now.value))
const hasMeetups = computed(() => meetups.value.length > 0)
const selected = computed(() => selectMeetup(meetups.value, route.query.meetup))
const past = computed(() => sessions.value.filter((s) => !meetups.value.includes(s)).slice(0, 3))
const hasFinished = computed(() => sessions.value.length > meetups.value.length)
const area = computed(() => selected.value?.area || null)
// The person's home area, a quick choice for "Already out?".
const homeArea = computed(() => (auth.user?.homeAreaId ? { id: auth.user.homeAreaId, name: auth.user.homeAreaName } : null))

// Outings past their end time that have not been completed, each with when it closes by itself. A confirmed one is left
// out: it is finishing (below).
const overdue = computed(() =>
  meetups.value.flatMap((s) => {
    const late = overdueOuting(s, now.value)
    return late && !dueEnding(s, now.value) ? [{ session: s, closes: late.closesAt ? singaporeDayTime(late.closesAt) : null }] : []
  }),
)
// A confirmed outing whose end time has passed: reading the list again finishes it and pays its coins (lib/api.js settleOutings).
// Run when Home opens, since the store may already be loaded with an outing that ended while the person was on another page
// (nothing then changes for the watcher below to notice), and again whenever the clock crosses an end time while Home is open.
// How to call: settleDue() (the clock is read again, as the shared one may be older than the page)
function settleDue() {
  const at = new Date()
  if (sessions.value.some((s) => dueEnding(s, at))) return events.loadSessions().catch(() => {})
}
watch(
  () => meetups.value.some((s) => dueEnding(s, now.value)),
  (due) => {
    if (due) settleDue()
  },
)

// Selecting by pin or by row is the same thing: put the id in the address (replacing the entry, so Back does not
// step through selections) and keep any other part of the address, such as an open place.
// How to call: select('s3')
const announce = ref('')
function select(id) {
  if (id === selected.value?.id) return
  announce.value = `${meetups.value.find((m) => m.id === id)?.title || 'Meetup'} selected`
  router.replace({ query: { ...route.query, meetup: id } })
}

// The routes on the map. With no meetups, or one with no meeting point yet: friends from all round the island meeting
// in the middle (Toa Payoh), always these, spread out, rather than one meetup's starts (often a few stops apart).
// With a selected meetup that has a meeting point: from each member's start area to that meeting area.
const at = (id) => AREAS.find((a) => a.id === id)
// Until there is a meetup Home has nothing below the band, so the band fills the screen and Singapore is drawn large.
const fullMap = computed(() => events.loaded && !hasMeetups.value)
// How much of the map always shows around the middle. Full screen: all of Singapore on a wide screen; on a phone a
// little closer, so the island fills the width (only the tips of Tuas and Changi run off the sides).
const narrow = ref(false)
let narrowQuery = null
const syncNarrow = () => { narrow.value = !!narrowQuery?.matches }
onMounted(() => {
  narrowQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 743px)') : null
  syncNarrow()
  narrowQuery?.addEventListener('change', syncNarrow)
})
onBeforeUnmount(() => narrowQuery?.removeEventListener('change', syncNarrow))
const mapSpan = computed(() => (!fullMap.value ? [340, 260] : narrow.value ? [340, 300] : [400, 320]))
const MEET = at('toa-payoh')
const defaultRoutes = ['boon-lay', 'jurong-east', 'woodlands', 'punggol', 'tampines', 'harbourfront'].map((id) => ({ from: at(id), to: MEET }))
const ownRoutes = computed(() => (selected.value ? routesFor(selected.value) : []))
const mapRoutes = computed(() => (ownRoutes.value.length ? ownRoutes.value : defaultRoutes))
// A new key redraws the routes: when the selection changes, or the selected meetup's starts or meeting area do.
const mapKey = computed(() => (ownRoutes.value.length ? `${selected.value.id}:${ownRoutes.value.map((r) => `${r.from.lat},${r.from.lng}`).join('|')}` : 'default'))
// The first draw is the full, slow one; a redraw after the person changes the selection is quicker.
const quickMap = ref(false)
watch(() => selected.value?.id, (id, before) => { if (id && before && id !== before) quickMap.value = true })

// The pins: one per meetup with a meeting point, each with its day and the words a screen reader says.
const pins = computed(() => {
  const byId = Object.fromEntries(meetups.value.map((m) => [m.id, m]))
  return pinsFor(meetups.value).map((pin) => ({ ...pin, label: dayLabel(byId[pin.id], now.value), name: pinName(byId[pin.id], now.value) }))
})

// Rain on the map: only when an outing is within two hours. With none, nothing is asked and nothing is drawn. The layer is on
// the map (SingaporeMap `rain`); its words, and where the forecast came from, are under the greeting.
const rain = useHomeRain({ meetups, now, simulated: computed(() => !!planner.conditions?.rain), ask: api.weatherAt })
// The chip over the map's rain: "Rain likely · next 2 h" for the live two-hour forecast, "Rain likely" for another live one, "Simulated
// rain" for the demo's, and none when the forecast's source is not known (lib/rainLook.js rainChipText). The words for a screen reader
// are the line under the greeting, worded by the same rule (lib/weatherText.js homeRainText).
const rainChip = computed(() => (rain.view.value ? rainChipText(rain.view.value.block) : ''))
// The chip sits just under the first place where rain is likely, at the map's own scale (the same centre and span as the pins, so
// the box is a size container and a map unit is --k px; see MeetupPins).
// How to call: rainChipFrame.value -> { '--w': 400, '--h': 320, '--dx': 12, '--dy': 40 }
const rainChipFrame = computed(() => {
  const place = rain.view.value?.places[0]
  if (!place) return null
  const c = project(MEET.lat, MEET.lng)
  const p = project(place.lat, place.lng)
  return { '--w': mapSpan.value[0], '--h': mapSpan.value[1], '--dx': p.x - c.x, '--dy': p.y - c.y }
})
// The rain fades in once. Picking another meetup draws the map again (its key changes), and the same rain must not fade out and in
// with it: once the places have been on screen for the fade's length, the map is told not to fade them again.
const rainPlacesKey = computed(() => (rain.view.value?.places || []).map((p) => `${p.lat},${p.lng}`).join('|'))
const rainFaded = ref('')
let fadeTimer = 0
watch(rainPlacesKey, (key) => {
  clearTimeout(fadeTimer)
  if (!key) return void (rainFaded.value = '')
  fadeTimer = setTimeout(() => (rainFaded.value = key), FADE_IN_MS)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(fadeTimer))
const fadeRain = computed(() => !rainPlacesKey.value || rainFaded.value !== rainPlacesKey.value)

// One line under the greeting, about where things stand.
const blurb = computed(() => {
  if (!selected.value) return 'Pick a day, invite your friends, and Jio finds the fairest place for everyone to meet.'
  if (meetups.value.length > 1) return `You have ${meetups.value.length} meetups going. Pick one to see where it stands.`
  if (area.value) return `Your group meets at ${area.value.name}. Here is what is nearby.`
  return 'Once everyone shares where they are starting, Jio works out the midpoint.'
})

// "Plan a new meetup" while meetups are going: the same move as the main pin (the red burst into the create screen), from
// the plus on the row (StartMeetupRow). A click with a modifier key opens a new tab as a link does.
// How to call: <MeetupList :start-href="startHref" @start="startAnother" />
const startHref = computed(() => router.resolve('/sessions/new').href)
let starting = false
async function startAnother(event) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
  event.preventDefault()
  if (starting) return
  starting = true
  const box = (event.currentTarget.querySelector('[data-burst]') || event.currentTarget).getBoundingClientRect()
  try {
    await enterGame({ x: box.left + box.width / 2, y: box.top + box.height / 2, go: () => router.push('/sessions/new') })
  } finally {
    starting = false
  }
}

// Places near the selected meetup's meeting area, nearest first. Loaded again when the selection moves to another
// area. Only the answer for the area now showing counts, so a slow older answer never lands on a newer area.
// How to call: loadPlaces(area.value.id)
async function loadPlaces(areaId) {
  placesError.value = false
  shown.value = PAGE
  if (!areaId) {
    places.value = []
    loadingPlaces.value = false
    return
  }
  loadingPlaces.value = true
  try {
    const list = await api.nearbyPlaces(areaId)
    if (area.value?.id === areaId) places.value = list
  } catch {
    if (area.value?.id === areaId) placesError.value = true
  } finally {
    if (area.value?.id === areaId) loadingPlaces.value = false
  }
}
watch(() => area.value?.id, loadPlaces, { immediate: true })

function countOn(f) {
  return TOGGLES.filter((t) => f[t.key]).length + (f.budget < BUDGET.max ? 1 : 0) + (f.distance < DISTANCE.max ? 1 : 0)
}

function apply(list, f) {
  return list.filter((p) => {
    const tags = p.tags || []
    // Vibe toggles widen each other; so do the type toggles. Each group narrows the list.
    const vibes = [f.touristy && 'touristy', f.hidden && 'hidden'].filter(Boolean)
    if (vibes.length && !vibes.some((v) => tags.includes(v))) return false
    if (f.cdc && !tags.includes('cdc')) return false
    const types = []
    if (f.food) types.push((x) => x.category === 'eat')
    if (f.cafe) types.push((x) => x.kind === 'cafe')
    if (types.length && !types.some((t) => t(p))) return false
    if (f.budget < BUDGET.max && p.price > f.budget) return false
    if (f.distance < DISTANCE.max && p.distanceKm > f.distance) return false
    return true
  })
}

const filtered = computed(() => apply(places.value, filters.value))
const preview = computed(() => apply(places.value, editing.value).length)
const activeCount = computed(() => countOn(filters.value))

function openFilter() {
  editing.value = { ...filters.value }
  filterOpen.value = true
}

function clearAll() {
  editing.value = emptyFilters()
}

function showPlaces() {
  filters.value = { ...editing.value }
  shown.value = PAGE
  filterOpen.value = false
}

function clearApplied() {
  filters.value = emptyFilters()
  editing.value = emptyFilters()
}

// ── Place detail ──
// The open place lives in the URL, so Back closes it and a link opens it straight away. The card and the detail
// view share view-transition names (PlaceCard `morph`, PlaceDetail), so the card grows into the view and back.
// Without the View Transitions API, or when the card is out of sight, the view simply opens and closes.
const openPlace = ref(null)
const reviews = ref(null)
// The card that carries the shared names right now: only around a transition, and only one.
const morphId = ref('')

const cardOf = (id) => document.querySelector(`[data-place="${CSS.escape(id)}"]`)
function inView(el) {
  const r = el?.getBoundingClientRect()
  return !!r && r.bottom > 0 && r.top < window.innerHeight && r.width > 0
}

// Why the open place could not be loaded, shown inside PlaceDetail. A link to a place that is not there has nothing
// to open, so it leaves a dismissible note on Home instead.
const placeError = ref('')
const missingPlace = ref(false)

async function showPlace(id) {
  const card = places.value.find((p) => p.id === id)
  reviews.value = null
  placeError.value = ''
  missingPlace.value = false
  const loading = api.getPlace(id, area.value?.id || auth.user?.homeAreaId)
  // Wait a moment for the details and reviews, so the view opens complete and nothing arrives mid-animation to
  // make it jump. A slow answer is not waited for: the view opens with placeholders and fills in.
  const early = await Promise.race([loading.catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), 350))])
  if (route.query.place !== id) return
  const first = early ? { ...card, ...early } : card
  if (card && canViewTransition() && inView(cardOf(id))) {
    morphId.value = id
    await nextTick()
    await withViewTransition(() => {
      morphId.value = ''
      openPlace.value = first
      if (early) reviews.value = early.reviews
    })
  } else if (card) {
    openPlace.value = first
    if (early) reviews.value = early.reviews
  }
  // Opened from a link with no card on screen: the try below opens it with the details.
  if (early && card) return
  try {
    const place = await loading
    if (route.query.place !== id) return
    openPlace.value = { ...(openPlace.value || {}), ...place }
    reviews.value = place.reviews
  } catch (e) {
    if (route.query.place !== id) return
    if (openPlace.value) {
      placeError.value = e?.message || 'This place could not be loaded.'
    } else {
      missingPlace.value = true
      router.replace({ query: withoutPlace() })
    }
  }
}

async function hidePlace() {
  const place = openPlace.value
  if (!place) return
  const card = cardOf(place.id)
  if (canViewTransition() && inView(card)) {
    await withViewTransition(() => {
      openPlace.value = null
      morphId.value = place.id
    })
    morphId.value = ''
  } else {
    openPlace.value = null
  }
  reviews.value = null
  card?.focus({ preventScroll: true })
}

watch(
  () => route.query.place,
  (id) => (id ? showPlace(id) : hidePlace()),
  { immediate: true },
)

// The address without the open place; the selected meetup stays.
function withoutPlace() {
  return Object.fromEntries(Object.entries(route.query).filter(([key]) => key !== 'place'))
}

// Back, when the place was opened from this list; otherwise (a shared link) just drop it from the URL.
function closePlace() {
  const back = window.history.state?.back
  if (back && router.resolve(back).path === route.path && !router.resolve(back).query.place) router.back()
  else router.replace({ query: withoutPlace() })
}

const budgetText = (v) => (v >= BUDGET.max ? 'Any budget' : `Up to SGD ${v}`)
const distanceText = (v) => (v >= DISTANCE.max ? 'Any distance' : `Within ${v} km`)
</script>

<template>
  <main class="screen home" data-testid="landing-view">
    <!-- The band: a muted map of Singapore; the routes meet at the selected meetup (or under the main action, in the middle). -->
    <section class="hero" :class="{ 'has-meetup': hasMeetups, 'hero--full': fullMap }" aria-labelledby="home-hello">
      <RouterLink to="/profile" class="home__me" aria-label="Profile" title="Profile">
        <UserAvatar :name="auth.user?.name ?? ''" :src="auth.user?.photo" :person="auth.myId" :size="44" />
      </RouterLink>

      <div class="hero__hello">
        <p class="caption text-muted">{{ today }}</p>
        <h1 id="home-hello" class="hello"><span class="hello__hi">Hi,</span> <span class="hello__name">{{ auth.user?.name }}</span></h1>
        <p class="body-md home__blurb">{{ blurb }}</p>
        <!-- An invitation waiting for an answer: the list is lower down the page, so the band says so and links to it. -->
        <RouterLink v-if="events.invitations.length" :to="{ query: route.query, hash: '#invitations' }" class="home__invites" data-testid="home-invites">
          <AppIcon name="user-plus" :size="16" />{{ events.invitations.length === 1 ? 'You have an invitation' : `You have ${events.invitations.length} invitations` }}
        </RouterLink>
        <!-- Rain within two hours: the map's layer in words, so it does not depend on seeing the map. -->
        <div v-if="rain.view.value" class="home__rain" data-testid="home-rain">
          <p class="home__rain-line caption" role="status"><AppIcon name="rain" :size="16" />{{ rain.view.value.text }}</p>
          <WeatherSource :block="rain.view.value.block" />
        </div>
      </div>

      <!-- The map, with the button where the routes meet, or a pin for each meetup. -->
      <div class="hero__stage">
        <SingaporeMap :key="mapKey" class="hero__map" :routes="mapRoutes" :center="MEET" :span="mapSpan" :quick="quickMap" :rain="rain.view.value?.places || []" :fade-rain="fadeRain" hide-meet />
        <div v-if="rainChip && rainChipFrame" class="hero__rain" :style="rainChipFrame" aria-hidden="true"><RainChip :text="rainChip" class="hero__rain-chip" /></div>
        <template v-if="hasMeetups">
          <MeetupPins class="hero__pins" :pins="pins" :meetups="meetups" :my-id="auth.myId" :names="nameOf" :selected-id="selected.id" :center="MEET" :span="mapSpan" @select="select" />
        </template>
        <div v-else class="hero__action" :class="{ 'is-pin': events.loaded }">
          <SkeletonRow v-if="!events.loaded && !loadError" :lines="1" />
          <AppButton v-else-if="!events.loaded" variant="secondary" @click="loadHome">Could not load your meetups · Retry</AppButton>
          <PinButton v-else to="/sessions/new" class="rise" />
        </div>
      </div>
    </section>

    <div class="screen__body home__body">
      <InvitationList />
      <BannerNote v-for="o in overdue" :key="o.session.id" tone="warning" icon="clock" data-testid="home-overdue">
        <template v-if="o.closes">{{ o.session.title }} has passed its end time without a confirmed plan. It closes by itself on {{ o.closes }}.</template>
        <template v-else>{{ o.session.title }} has passed its end time. It stays open until its host finishes it.</template>
        <template #actions><AppButton variant="secondary" small :to="sessionPath(o.session)">Open outing</AppButton></template>
      </BannerNote>
      <BannerNote v-if="missingPlace" tone="warning" icon="warning" dismissible @dismiss="missingPlace = false">That place could not be found.</BannerNote>
      <!-- No meetup going: the ones before. Nothing at all until there is one. -->
      <section v-if="events.loaded && !hasMeetups && past.length" class="section rise" aria-labelledby="home-meetups">
        <div class="section__head">
          <h2 id="home-meetups" class="display-sm">Your meetups</h2>
          <AppButton v-if="sessions.length > 3" variant="tertiary" underline to="/sessions">All meetups</AppButton>
        </div>
        <ul class="grid-3">
          <li v-for="s in past" :key="s.id"><SessionCard :session="s" :names="nameOf" /></li>
        </ul>
      </section>

      <!-- Meetups going: the selected one, and with two or more, all of them. -->
      <div v-if="events.loaded && selected" class="home__meetups" :class="{ 'is-split': meetups.length > 1 }">
        <MeetupDetail class="rise" :meetup="selected" :my-id="auth.myId" :names="nameOf" />
        <section v-if="meetups.length > 1" class="section rise" style="--i: 1" aria-labelledby="home-meetups">
          <div class="section__head">
            <h2 id="home-meetups" class="display-sm">Your meetups</h2>
            <AppButton v-if="hasFinished" variant="tertiary" underline to="/sessions">All meetups</AppButton>
          </div>
          <MeetupList :meetups="meetups" :selected-id="selected.id" :my-id="auth.myId" :start-href="startHref" @select="select" @start="startAnother" />
        </section>
        <template v-else>
          <!-- One meetup: its card is above, so the list is the action alone. -->
          <MeetupList class="rise" style="--i: 1" :meetups="[]" :start-href="startHref" @start="startAnother" />
          <div v-if="hasFinished" class="home__all"><AppButton variant="tertiary" underline to="/sessions">All meetups</AppButton></div>
        </template>
      </div>
      <p class="sr-only" role="status">{{ announce }}</p>
      <RoamFromHome v-if="events.loaded && auth.sampleWorld" class="rise home__roam" :home="homeArea" />

      <!-- A midpoint: places around it, nearest first. -->
      <section v-if="area" class="section rise" aria-labelledby="home-places">
        <div class="section__head">
          <div class="stack home__headtext">
            <h2 id="home-places" class="display-sm">Places near {{ area.name }}</h2>
            <p class="home__context"><AppIcon name="pin" :size="16" /><span class="truncate">For {{ selected.title }}</span></p>
          </div>
          <button type="button" class="filter-btn" :class="{ 'is-on': activeCount }" :aria-label="activeCount ? `Filter, ${activeCount} on` : 'Filter'" title="Filter" @click="openFilter">
            <AppIcon name="filter" :size="18" />
            <span v-if="activeCount" class="filter-btn__count" aria-hidden="true">{{ activeCount }}</span>
          </button>
        </div>

        <EmptyState v-if="placesError" title="Could not load places" text="Check your connection and try again." role="alert">
          <AppButton variant="secondary" @click="loadPlaces(area.id)">Retry</AppButton>
        </EmptyState>
        <div v-else-if="loadingPlaces" class="grid-3">
          <SkeletonRow v-for="n in 6" :key="n" avatar />
        </div>
        <EmptyState v-else-if="!filtered.length" title="No places match">
          <AppButton variant="secondary" @click="clearApplied">Clear all</AppButton>
        </EmptyState>
        <template v-else>
          <ul class="grid-3">
            <li v-for="(place, i) in filtered.slice(0, shown)" :key="place.id" class="rise" :style="{ '--i': i % PAGE }">
              <RouterLink :to="{ query: { ...route.query, place: place.id } }" class="place-link" :data-place="place.id">
                <PlaceCard :place="place" :morph="morphId === place.id" />
              </RouterLink>
            </li>
          </ul>
          <AppButton v-if="filtered.length > shown" variant="secondary" class="home__more" @click="shown += PAGE">Show more</AppButton>
        </template>
      </section>
    </div>

    <BottomSheet v-model:open="filterOpen" title="Filter">
      <div class="stack">
        <ToggleSwitch v-for="t in TOGGLES" :key="t.key" v-model="editing[t.key]" :label="t.label" />
      </div>
      <RangeSlider v-model="editing.budget" label="Budget per person" :min="BUDGET.min" :max="BUDGET.max" :step="BUDGET.step" :format="budgetText" />
      <RangeSlider v-model="editing.distance" label="Distance" :min="DISTANCE.min" :max="DISTANCE.max" :step="DISTANCE.step" :format="distanceText" />
      <template #footer>
        <div class="filter-foot">
          <AppButton variant="tertiary" underline :disabled="!countOn(editing)" @click="clearAll">Clear all</AppButton>
          <AppButton @click="showPlaces">Show {{ preview }} {{ preview === 1 ? 'place' : 'places' }}</AppButton>
        </div>
      </template>
    </BottomSheet>
    <PlaceDetail v-if="openPlace" :place="openPlace" :reviews="reviews" :error="placeError" :from="area?.name || 'home'" @close="closePlace" />
  </main>
</template>

<style scoped>
/* The band: full width, a soft grey that fades to white at the bottom. The greeting sits at the top, centred; under
   it the stage holds the map, whose centre (where the routes meet) is the stage's centre, and the button sits
   exactly there. The map fades out towards the stage's edges, and also around the button, so the button sits in a
   clearing and the routes fade into it rather than running underneath. */
.hero { position: relative; display: flex; flex-direction: column; align-items: center; margin-bottom: var(--spacing-base); padding-top: var(--spacing-lg); text-align: center; }
.hero::before { content: ""; position: absolute; inset: 0 auto 0 50%; width: 100vw; transform: translateX(-50%); background: linear-gradient(to bottom, var(--surface-soft) 75%, var(--canvas)); }
.hero__hello { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: var(--spacing-xs); padding: 0 var(--gutter); }
.home__blurb { max-width: 460px; margin: 0; color: var(--body); }
.home__invites { display: inline-flex; align-items: center; justify-content: center; gap: var(--spacing-xs); min-height: var(--tap-min); padding: var(--spacing-xxs) var(--spacing-base); text-align: center; border: 1px solid var(--ink); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); font: var(--text-button-sm); text-decoration: none; }
@media (hover: hover) { .home__invites:hover { background: var(--surface-soft); } }
/* Rain within two hours, in words: a line with its icon, and the forecast's source under it. */
.home__rain { display: flex; flex-direction: column; align-items: center; gap: var(--spacing-xxs); max-width: 460px; }
.home__rain-line { display: inline-flex; align-items: center; justify-content: center; gap: var(--spacing-xs); margin: 0; color: var(--ink); font-weight: 600; }
.home__rain :deep(.wx__line) { justify-content: center; }
/* The greeting: big and tight, the name in a sweep of brand pink to red that shines once as the page opens. */
.hello { margin: var(--spacing-xs) 0; color: var(--ink); font: 800 clamp(44px, 9vw, 80px)/0.95 var(--font-sans); letter-spacing: -0.045em; text-wrap: balance; }
.hello__name {
  background: linear-gradient(100deg, var(--primary) 0%, var(--brand-logo) 35%, #ff8a5c 50%, var(--brand-logo) 65%, var(--primary) 100%);
  background-size: 250% 100%;
  background-position: 100% 0;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: hello-shine 1.6s var(--ease-out) 200ms both;
}
@keyframes hello-shine { from { background-position: 100% 0; } to { background-position: 0 0; } }
.hello__hi { display: inline-block; animation: rise 520ms cubic-bezier(0.16, 1, 0.3, 1) both; }
/* Text painted through background-clip is visible only inside its own box. The line is 0.95 tall and the letter-spacing
   is negative, so descenders (g, j, p, q, y) fall below the box and a wide last letter (W) runs past its right edge.
   The padding gives the paint room and the negative margin takes the same room back, so the layout is as before
   (0.06em under the name, as it always was). The gradient keeps spanning the text alone (origin: content-box). */
.hello__name { display: inline-block; padding: 0.12em 0.1em 0.22em 0.06em; margin: -0.12em -0.1em -0.16em -0.06em; background-origin: content-box; }
@media (prefers-reduced-motion: reduce) { .hello__name, .hello__hi { animation: none; } }
.hero__stage { position: relative; align-self: stretch; height: 360px; }
.hero__map {
  position: absolute;
  inset: 0 auto 0 50%;
  width: min(100vw, 1440px);
  transform: translateX(-50%);
  /* Two masks: --edge fades the map out towards the stage's edges, --clearing around the button. */
  --edge: radial-gradient(ellipse 50% 50% at 50% 50%, #000 60%, transparent 100%);
  --clearing: radial-gradient(ellipse 230px 95px at 50% 50%, transparent 55%, #000 100%);
  -webkit-mask-image: var(--edge), var(--clearing);
  -webkit-mask-composite: source-in;
  mask-image: var(--edge), var(--clearing);
  mask-composite: intersect;
}
/* With meetups there is no button in the middle but pins all over, so there is no clearing: the mask is solid. This
   rule is more specific than the phone one below, so it wins there too. */
.has-meetup .hero__map { --clearing: linear-gradient(#000, #000); }
.hero__action { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); }
/* The rain chip sits just under the first place where rain is likely (the pins fan out above a meeting point, so above would be behind
   them), at the map's own scale, over the map and under the pins. It is information: no pointer events. */
.hero__rain { position: absolute; z-index: 2; inset: 0 auto 0 50%; width: min(100vw, 1440px); transform: translateX(-50%); container-type: size; pointer-events: none; }
.hero__rain-chip { --k: min(100cqw / var(--w), 100cqh / var(--h)); position: absolute; left: clamp(84px, calc(50cqw + var(--dx) * var(--k)), calc(100cqw - 84px)); top: clamp(4px, calc(50cqh + var(--dy) * var(--k) + max(var(--k) * 34, 44px)), calc(100cqh - 40px)); translate: -50% 0; }
/* The pin stands on the meeting point: its tip, the bottom of its box, is where the routes meet. */
.hero__action.is-pin { transform: translate(-50%, -100%); }
/* The pins sit over the map in the same box, so the same centre and span put each on its meeting point. Above the map's
   other layers, so a pin's card is never under them; the bars are fixed and above all of this. */
.hero__pins { position: absolute; z-index: 5; inset: 0 auto 0 50%; width: min(100vw, 1440px); transform: translateX(-50%); }
.home__me { position: absolute; z-index: 2; top: var(--spacing-md); right: var(--gutter); flex-shrink: 0; border-radius: var(--rounded-full); }
@media (max-width: 743px) {
  /* Phones: the avatar sits top right, so the greeting keeps clear of it on both sides (to stay centred). */
  .hero__hello { align-self: stretch; padding-right: calc(var(--gutter) + 52px); padding-left: calc(var(--gutter) + 52px); }
  /* The map is narrow here, so it fades out later, nearer the edges. */
  .hero__map { --edge: radial-gradient(ellipse 70% 60% at 50% 50%, #000 70%, transparent 100%); }
  /* A smaller clearing to match the smaller map. */
  .hero__map { --clearing: radial-gradient(ellipse 160px 60px at 50% 50%, transparent 60%, #000 100%); }
}
@media (min-width: 744px) {
  .hero { padding-top: var(--spacing-xxl); }
  .hero__stage { height: 440px; }
  /* The top bar has Profile from here up. */
  .home__me { display: none; }
}
/* No midpoint yet: the band fills the screen under the top bar (above the tab bar on phones), the stage takes all
   the room under the greeting, and the map runs edge to edge, fading only at the very edges. */
.hero--full { min-height: calc(100dvh - var(--topbar-real-height) - var(--tabbar-real-height)); margin-bottom: 0; }
.hero--full .hero__stage { flex: 1 1 auto; height: auto; min-height: 420px; }
.hero--full .hero__map { --edge: radial-gradient(ellipse 72% 72% at 50% 50%, #000 70%, transparent 100%); width: 100vw; }
/* On a phone the map is drawn small, so its dots are drawn a little bigger to keep the island's shape clear. */
@media (max-width: 743px) { .hero--full .hero__map :deep(.sgmap__dots) { stroke-width: 2.8; } }
.home__body { padding-top: 0; }
/* Where the places are: the area name in Rausch, bold, with its pin. */
.home__context { display: inline-flex; align-items: center; gap: var(--spacing-xs); max-width: 100%; margin: 0; color: var(--primary); font: var(--text-title-md); font-weight: 700; }

/* The meetups under the band: the selected one's card, and with two or more the list beside it from 744px, where the
   card stays in view as a long list scrolls. */
.home__meetups { display: flex; flex-direction: column; gap: var(--spacing-lg); }
.home__all { display: flex; }
@media (min-width: 744px) {
  .home__meetups:not(.is-split) > * { max-width: var(--form-max-width); }
  .home__meetups.is-split { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); align-items: start; }
  .home__meetups.is-split > :first-child { position: sticky; top: calc(var(--topbar-real-height) + var(--spacing-base)); }
}
.home__headtext { min-width: 0; }

/* A place card is a link to its detail view. */
.place-link { display: block; border-radius: var(--rounded-md); color: inherit; text-decoration: none; }
.place-link:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.home__more { align-self: center; }
.filter-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--tap-min);
  height: var(--tap-min);
  border: 0;
  border-radius: var(--rounded-full);
  background: var(--canvas);
  border: 1px solid var(--hairline);
  color: var(--ink);
}
.filter-btn.is-on { border: 2px solid var(--ink); }
.filter-btn__count { position: absolute; top: -2px; right: -2px; display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--rounded-full); background: var(--ink); box-shadow: 0 0 0 2px var(--canvas); color: var(--on-dark); font: var(--text-badge); }
@media (hover: hover) { .filter-btn:hover { background: var(--surface-soft); } }
.filter-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-base); }
</style>
