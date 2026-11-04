<script setup>
// Home: a band across the top with a muted dotted map of Singapore. Routes draw in from around the island and meet at
// one point, with the greeting above. Below, on white, what comes next. Three states:
//   No active meetup        the band's action is a map pin in the middle, "Jio your friends", on the meeting point;
//                           below, Your meetups (past ones, or an empty state).
//   One or more going       every meetup that has a meeting point is a pin on the map (a button: its day on it). Home opens
//                           on the map alone, nothing selected, with the week chips above it, unless a meetup is happening
//                           right now, which opens by itself (the lead's flow of 4 November 2026). Picking a pin selects it: the routes meet at its meeting area, only that pin bobs, and a tall panel opens with everything about
//                           it (from 1024px down the right of the screen, the map sliding left; below, a sheet from the
//                           bottom): its card (when, where it stands, who is in, what it needs next from you, Open
//                           meetup) and the places near its meeting area. Its ×, Escape, or the empty map closes it.
//                           With two or more, "List" under the chips shows Your meetups (a row selects, like a pin;
//                           hovering or focusing a pin opens a small card of its details), and a meetup with no meeting
//                           point yet is there, with no pin. A new meetup starts from the tab bar's Create
//                           (the list has no row of its own for it: one way in is enough). Nothing sits in the
//                           map's corner, so no pin has a control beside it.
//   Meetup with a midpoint  Places near that meeting area, in the panel under its card: nearest first, with one Filter
//                           button. They follow the selected meetup.
// The selected meetup lives in the address (?meetup=id), so a reload or a shared link opens the same one; with no id, or
// one that is not listed, nothing is selected except a meetup happening now (lib/homeMeetups.js homeSelection). What decides the order, the pins and the next step is lib/homeMeetups.js.
// The filter has toggles (Touristy spots, Hidden gems, CDC Vouchers accepted, Food, Café),
// a budget slider (the most to spend per person) and a distance slider (from the midpoint).
// Tapping a place opens it (?place=id): its card grows into PlaceDetail and shrinks back on close. If the place
// cannot be loaded, PlaceDetail says so (or, for a link to a place that is not there, a note appears on Home).
// A failed load of the meetups or of the nearby places shows a message with a Retry button, never a skeleton for ever.
// An outing past its end time with no confirmed plan gets a banner that says when it closes by itself (lib/session.js
// overdueOuting). A confirmed one is finished by its host, never by the clock ("Finish outing"), and a shared outing likewise, so past
// its end time it gets a banner that says so. Outings past their end time are listed after the ones still to come, take no pin while
// another meetup can have it, and with several there is one banner for them all (review of 1 November 2026).
// "Already out?" is not on Home any more: it is the "Already out" choice on Create session (walkthrough, 30 October 2026), reached
// from the navigation's Create, so there is one way to start a light meetup.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { format, parseISO } from 'date-fns'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import { vRadioGroup } from '@/lib/radioGroup.js'
import BannerNote from '@/components/ui/BannerNote.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import SingaporeMap from '@/components/ui/SingaporeMap.vue'
import PinButton from '@/components/ui/PinButton.vue'
import RangeSlider from '@/components/ui/RangeSlider.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import PlaceTile from '@/components/event/PlaceTile.vue'
import PlaceDetail from '@/components/event/PlaceDetail.vue'
import WeatherSource from '@/components/weather/WeatherSource.vue'
import InvitationList from '@/components/event/InvitationList.vue'
import SessionCard from '@/components/event/SessionCard.vue'
import MeetupDetail from '@/components/home/MeetupDetail.vue'
import MeetupList from '@/components/home/MeetupList.vue'
import MeetupPins from '@/components/home/MeetupPins.vue'
import AddFriends from '@/components/home/AddFriends.vue'
import LiquidMetalButton from '@/components/ui/LiquidMetalButton.vue'
import * as api from '@/lib/api.js'
import { MEETUP_RANGES, activeMeetups, needsMe, allMeetupsLabel, dayLabel, defaultRange, homeList, homeSelection, meetupsIn, pinName, pinnedMeetups, pinsFor, rangeCounts } from '@/lib/homeMeetups.js'
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
// Which meetups "Your meetups" and the map show (walkthrough, 30 October 2026): This week, Next week, Later or All, starting on This
// week (or All when nothing is on this week). A chip with nothing in it is faded and cannot be chosen. The selected meetup comes from the
// chip's meetups, so the card, the rows and the pins always agree.
const rangePicked = ref(null)
// What a screen reader hears when a filter or the selected meetup changes (the status under the list).
const announce = ref('')
const range = computed(() => rangePicked.value ?? defaultRange(meetups.value, now.value))
const counts = computed(() => rangeCounts(meetups.value, now.value))
const inWeek = computed(() => meetupsIn(meetups.value, range.value, now.value))
// "Your turn", a check chip after the week chips (as Rewards' "Can claim"): every meetup waiting on the person, whatever its week, so one
// that needs a vote next week is not missed on This week (Faith, 31 October 2026). It counts them all and shows while at least one is.
// Turning it on lists only those and leaves no week chip chosen (the list is not any one week's, and All would count more than it shows);
// turning it off goes back to the week that was chosen; picking a week turns it off. Each change is announced.
const onlyMine = ref(false)
const allMine = computed(() => meetups.value.filter((m) => needsMe(m, auth.myId)))
const inRangeMeetups = computed(() => (onlyMine.value && allMine.value.length ? allMine.value : inWeek.value))
// How to call: pickRange('next')
function pickRange(id) {
  if (!counts.value[id]) return
  rangePicked.value = id
  onlyMine.value = false
  const n = counts.value[id]
  announce.value = `Showing ${MEETUP_RANGES.find((r) => r.id === id).label.toLowerCase()}, ${n} ${n === 1 ? 'meetup' : 'meetups'}`
}
// How to call: toggleMine()
function toggleMine() {
  onlyMine.value = !onlyMine.value
  const n = allMine.value.length
  announce.value = onlyMine.value ? `Showing only the ${n} ${n === 1 ? 'meetup' : 'meetups'} waiting for you` : `Showing ${MEETUP_RANGES.find((r) => r.id === range.value).label.toLowerCase()} again`
}
// "Your meetups" lists a few (lib/homeMeetups.js homeList), and the selected one is one of them, so the card, the rows and the pins
// agree and picking a pin changes nothing else on the map. "See all N meetups" opens Sessions when there are more, or finished ones.
const shownMeetups = computed(() => homeList(inRangeMeetups.value.length ? inRangeMeetups.value : meetups.value))
// Closing the card of a meetup that opened by itself (happening now) keeps it closed until Home is opened again.
const liveDismissed = ref(false)
const selected = computed(() => homeSelection(shownMeetups.value, route.query.meetup, now.value, { liveDismissed: liveDismissed.value }))
const past = computed(() => sessions.value.filter((s) => !meetups.value.includes(s)).slice(0, 3))
const hasFinished = computed(() => sessions.value.length > meetups.value.length)
const moreMeetups = computed(() => meetups.value.length > shownMeetups.value.length || hasFinished.value)
const area = computed(() => selected.value?.area || null)

// Outings past their end time that have not been completed, each with when it closes by itself (none for a confirmed or a shared one,
// which its host finishes). One that is due to close this very read is left out: it is closing (below).
const overdue = computed(() =>
  meetups.value.flatMap((s) => {
    const late = overdueOuting(s, now.value)
    return late && !dueEnding(s, now.value) ? [{ session: s, closes: late.closesAt ? singaporeDayTime(late.closesAt) : null }] : []
  }),
)
// The names of the outings the single note lists, a few and a count of the rest. How to call: overdueTitles.value -> 'Dinner, Hike and 2 more'
const overdueTitles = computed(() => {
  const titles = overdue.value.map((o) => o.session.title || 'Untitled')
  return titles.length <= 2 ? titles.join(' and ') : `${titles.slice(0, 2).join(', ')} and ${titles.length - 2} more`
})
// An outing with no plan, two days past its end time: reading the list again closes it with no coins (lib/api.js settleOutings).
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
async function select(id) {
  if (id === selected.value?.id) return
  announce.value = `${meetups.value.find((m) => m.id === id)?.title || 'Meetup'} selected`
  await router.replace({ query: { ...route.query, meetup: id } })
  // The panel scrolls back to its top for the new meetup.
  if (panel.value) panel.value.scrollTop = 0
}

// Closing the card: nothing selected, the map alone again. Focus goes back to the selected pin, if a pin had it.
// How to call: closeMeetup()
function closeMeetup() {
  if (!selected.value) return
  const doc = globalThis.document
  const pin = doc && typeof panel.value?.contains === 'function' && panel.value.contains(doc.activeElement) ? doc.querySelector('.hero__pins .mpin[aria-pressed="true"]') : null
  announce.value = `${selected.value.title || 'Meetup'} closed`
  liveDismissed.value = true
  const query = Object.fromEntries(Object.entries(route.query).filter(([key]) => key !== 'meetup'))
  router.replace({ query })
  pin?.focus({ preventScroll: true })
}
// A click on the map that is not on a pin or its card closes the open meetup.
// How to call: onStageClick(event)
function onStageClick(event) {
  if (!selected.value || event.target.closest?.('.mwrap, button, a')) return
  closeMeetup()
}
// Escape closes the open meetup, unless something above it is open (a place, the filter) or a pin's own card is open (its Escape
// closes that card first, MeetupPins).
// How to call: window.addEventListener('keydown', onKey)
function onKey(event) {
  if (event.key !== 'Escape' || event.defaultPrevented || !selected.value || openPlace.value || filterOpen.value) return
  if (globalThis.document?.activeElement?.closest?.('.mwrap.is-open')) return
  closeMeetup()
}
onMounted(() => globalThis.window?.addEventListener('keydown', onKey))
onBeforeUnmount(() => globalThis.window?.removeEventListener('keydown', onKey))
const panel = ref(null)
// The tall panel is open while a meetup is selected.
const drawerOpen = computed(() => events.loaded && !!selected.value)
// Below 1024px the panel is a sheet over the lower part of the screen, so when it opens the page scrolls the map up into the room above
// it (the body leaves room to scroll, in the CSS), and the selected pin stays in sight.
const stage = ref(null)
watch(drawerOpen, async (open) => {
  if (!open || typeof matchMedia !== 'function' || !matchMedia('(max-width: 1023px)').matches) return
  await nextTick()
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  stage.value?.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
}, { flush: 'post' })

// "List" under the week chips shows Your meetups under the map. Off at first, so Home is the map; the choice is remembered in this
// browser only (a convenience, so a reload keeps it).
const LIST_KEY = 'jio-home-list'
const listOpen = ref(false)
try { listOpen.value = localStorage.getItem(LIST_KEY) === '1' } catch { /* storage blocked: start closed */ }
// How to call: toggleList()
function toggleList() {
  listOpen.value = !listOpen.value
  try { localStorage.setItem(LIST_KEY, listOpen.value ? '1' : '0') } catch { /* storage blocked: the choice lasts this visit */ }
  announce.value = listOpen.value ? 'Showing the list of meetups' : 'List hidden'
}

// The routes on the map: friends from all round the island converging on the selected meetup's pin (ROUTE_STARTS, below).
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
// The routes always start from the same six places round the island, so every pin gets the same number of lines (walkthrough, 30 October
// 2026: they used to be the members' own starts, a different number for each meetup). They converge on the selected meetup's pin, its
// meeting area; with no meetup selected, or one with no meeting point yet, on the middle (Toa Payoh), where no pin is.
const ROUTE_STARTS = ['boon-lay', 'jurong-east', 'woodlands', 'punggol', 'tampines', 'harbourfront'].map(at)
// Where each pin is drawn (MeetupPins `drawn`): a pin in a row of nearby ones stands a little off its own area, and the routes meet at
// its tip, not under the pin beside it.
const drawnAt = ref({})
// The routes converge only on something on screen: the selected meetup's pin, or the "Jio your friends" pin when there is no meetup. When
// the selected meetup has no pin (no meeting point yet, as with a chip whose meetups have none), nothing is drawn where they would meet, so
// they do not converge on an empty spot: they run round the island one after another instead (IDLE_LOOP), people out and about.
const selectedPinned = computed(() => !!selected.value && pins.value.some((pin) => pin.id === selected.value.id))
const converging = computed(() => !hasMeetups.value || selectedPinned.value)
const IDLE_LOOP = ['boon-lay', 'woodlands', 'punggol', 'tampines', 'harbourfront', 'jurong-east'].map(at)
const IDLE_ROUTES = IDLE_LOOP.map((from, i) => ({ from, to: IDLE_LOOP[(i + 1) % IDLE_LOOP.length] }))
const routeEnd = computed(() => {
  const area = selected.value?.area
  if (!selectedPinned.value || !Number.isFinite(area?.lat) || !Number.isFinite(area?.lng)) return MEET
  return drawnAt.value[selected.value.id] || { lat: area.lat, lng: area.lng }
})
const mapRoutes = computed(() => (converging.value ? ROUTE_STARTS.map((from) => ({ from, to: routeEnd.value })) : IDLE_ROUTES))
// A new key redraws the routes when they converge somewhere else (rounded, so a sub-pixel change in the measured box does not redraw), or
// when they stop converging.
const mapKey = computed(() => (converging.value ? `${routeEnd.value.lat.toFixed(4)},${routeEnd.value.lng.toFixed(4)}` : 'idle'))
// The first draw is the full, slow one; a redraw after the person changes the selection is quicker.
const quickMap = ref(false)
watch(() => selected.value?.id, (id, before) => { if (id && before && id !== before) quickMap.value = true })

// The pins: one per meetup listed under "Your meetups" that has a meeting point (so a pin always has its row, and the map is not
// crowded with meetups the list leaves out), each with its day and the words a screen reader says. With one meetup going there is no
// list, and that one is pinned.
const pins = computed(() => {
  const byId = Object.fromEntries(meetups.value.map((m) => [m.id, m]))
  // Outings past their end time are listed after the others but take no pin while another meetup can have it.
  const pinned = meetups.value.length > 1 ? pinnedMeetups(shownMeetups.value, now.value) : meetups.value
  return pinsFor(pinned).map((pin) => ({ ...pin, label: dayLabel(byId[pin.id], now.value), name: pinName(byId[pin.id], now.value) }))
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
  if (!hasMeetups.value) return 'Pick a day, invite your friends, and Jio finds the fairest place for everyone to meet.'
  // Meetups on the map, none open: say what a pin does, once, plainly.
  if (!selected.value) return pins.value.length ? 'Choose a pin to see that meetup.' : 'Open List to see your meetups.'
  // Several going, one open: how to move on, in the line's place, so the greeting does not jump as the card opens.
  if (meetups.value.length > 1) return 'Choose another pin, or close the card to see the whole map.'
  if (area.value) return `Your group meets at ${area.value.name}. Here is what is nearby.`
  return 'Once everyone shares where they are starting, Jio works out the midpoint.'
})

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
// view share view-transition names (PlaceTile `morph`, PlaceDetail), so the card grows into the view and back.
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
  <main class="screen home" :class="{ 'has-drawer': drawerOpen }" data-testid="landing-view">
    <!-- The band: a muted map of Singapore; the routes meet at the selected meetup (or under the main action, in the middle). -->
    <section class="hero" :class="{ 'has-meetup': hasMeetups, 'hero--full': fullMap }" aria-labelledby="home-hello">
      <!-- Finding people and adding them as friends (walkthrough, 30 October 2026), and under it finding places from a post, a liquid
           metal button (walkthrough, 1 November 2026, in place of the "Find places from a post" link): the corner opposite the avatar
           on phones, top right from 744px. -->
      <div class="home__tools">
        <AddFriends />
        <LiquidMetalButton label="Find places from a post" caption="From a post" to="/places/from-post" icon="sparkles" data-testid="home-post-places" />
      </div>
      <RouterLink to="/profile" class="home__me" aria-label="Profile" title="Profile">
        <UserAvatar :name="auth.user?.name ?? ''" :src="auth.user?.photo" :person="auth.myId" :size="44" />
      </RouterLink>

      <div class="hero__hello">
        <p class="caption text-muted">{{ today }}</p>
        <h1 id="home-hello" class="hello"><span class="hello__hi">Hi,</span> <span class="hello__name">{{ auth.user?.name }}</span></h1>
        <p v-if="blurb" class="body-md home__blurb">{{ blurb }}</p>
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

      <!-- Which meetups the map pins: the week chips, "Your turn" (every meetup waiting on you, whatever its week), and List, which shows
           them as a list under the map. Above the map, so they never cover a pin. -->
      <div v-if="events.loaded && hasMeetups" class="home__filters" data-testid="home-filters">
        <div v-if="meetups.length > 1" class="scroll-x home__ranges" role="radiogroup" v-radio-group aria-label="Show meetups for" data-testid="meetup-ranges">
          <ChipButton v-for="r in MEETUP_RANGES" :key="r.id" radio :selected="!onlyMine && range === r.id" :disabled="!counts[r.id]" :aria-label="`${r.label}, ${counts[r.id]} ${counts[r.id] === 1 ? 'meetup' : 'meetups'}`" @click="pickRange(r.id)">{{ r.label }}<span class="home__range-count tnum" aria-hidden="true">{{ counts[r.id] }}</span></ChipButton>
        </div>
        <div class="home__toggles">
          <ChipButton v-if="allMine.length && meetups.length > 1" check :selected="onlyMine" :aria-label="`Your turn, ${allMine.length} ${allMine.length === 1 ? 'meetup' : 'meetups'}`" data-testid="your-turn-filter" @click="toggleMine">Your turn<span class="home__range-count tnum" aria-hidden="true">{{ allMine.length }}</span></ChipButton>
          <ChipButton check :selected="listOpen" data-testid="home-list-toggle" @click="toggleList">List</ChipButton>
        </div>
      </div>

      <!-- The map, with the button where the routes meet, or a pin for each meetup. -->
      <div class="hero__room">
        <div ref="stage" class="hero__stage" @click="onStageClick">
          <div class="hero__world">
            <SingaporeMap :key="mapKey" class="hero__map" :routes="mapRoutes" :center="MEET" :span="mapSpan" :quick="quickMap" :rain="rain.view.value?.places || []" :fade-rain="fadeRain" hide-meet />
            <div v-if="rainChip && rainChipFrame" class="hero__rain" :style="rainChipFrame" aria-hidden="true"><RainChip :text="rainChip" class="hero__rain-chip" /></div>
            <template v-if="hasMeetups">
              <MeetupPins class="hero__pins" :pins="pins" :meetups="meetups" :my-id="auth.myId" :names="nameOf" :selected-id="selected?.id || ''" :center="MEET" :span="mapSpan" quiet-selected @select="select" @drawn="drawnAt = $event" />
            </template>
          </div>
          <div v-if="!hasMeetups" class="hero__action" :class="{ 'is-pin': events.loaded }">
            <SkeletonRow v-if="!events.loaded && !loadError" :lines="1" />
            <AppButton v-else-if="!events.loaded" variant="secondary" @click="loadHome">Could not load your meetups · Retry</AppButton>
            <PinButton v-else to="/sessions/new" class="rise" />
          </div>
        </div>
      </div>
    </section>

    <!-- The open meetup: a tall panel, everything about it in one place (the lead's word, 4 November 2026): its card, then the places near
         its meeting area, nearest first. From 1024px it runs the height of the screen on the right and the map, greeting and chips slide
         left to make room; below 1024px it comes up from the bottom as a tall sheet, with the top of the map still showing over it. It is
         not a dialog: the pins stay usable, and picking another one changes what it shows. Its ×, Escape or the empty map closes it. -->
    <Transition name="drawer">
      <aside v-if="drawerOpen" ref="panel" class="home__drawer" aria-labelledby="home-detail-title" data-testid="home-panel">
        <div class="home__drawer-head">
          <span class="home__grip" aria-hidden="true" />
          <button type="button" class="hero__close" aria-label="Close meetup" title="Close" data-testid="home-panel-close" @click="closeMeetup"><AppIcon name="close" :size="18" /></button>
        </div>
        <MeetupDetail class="home__drawer-card" :meetup="selected" :my-id="auth.myId" :names="nameOf" />

        <!-- A midpoint: places around it, nearest first, one under another. -->
        <section v-if="area" class="home__drawer-places" aria-labelledby="home-places">
          <div class="section__head">
            <div class="stack home__headtext">
              <h2 id="home-places" class="title-lg">Places near {{ area.name }}</h2>
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
          <!-- Skeletons only the first time; after that the last places stay, faded, until the new ones come, so the panel does not
               shrink and grow under the person when another meetup is picked (Faith, 31 October 2026). -->
          <div v-else-if="loadingPlaces && !places.length" class="stack">
            <SkeletonRow v-for="n in 4" :key="n" avatar />
          </div>
          <EmptyState v-else-if="!filtered.length && !loadingPlaces" title="No places match">
            <AppButton variant="secondary" @click="clearApplied">Clear all</AppButton>
          </EmptyState>
          <template v-else>
            <ul class="home__places" :class="{ 'is-refreshing': loadingPlaces }" :aria-busy="loadingPlaces ? 'true' : undefined" :aria-label="`Places near ${area.name}`" data-testid="home-places">
              <li v-for="place in filtered.slice(0, shown)" :key="place.id">
                <RouterLink :to="{ query: { ...route.query, place: place.id } }" class="place-link place-link--tile" :data-place="place.id">
                  <PlaceTile :place="place" :morph="morphId === place.id" />
                </RouterLink>
              </li>
            </ul>
            <AppButton v-if="filtered.length > shown" variant="secondary" class="home__more" data-testid="home-places-more" @click="shown += PAGE">Show more · {{ filtered.length - shown }} nearby</AppButton>
          </template>
        </section>
      </aside>
    </Transition>

    <div class="screen__body home__body">
      <InvitationList />
      <BannerNote v-for="o in overdue.length > 1 ? [] : overdue" :key="o.session.id" tone="warning" icon="clock" data-testid="home-overdue">
        <template v-if="o.closes">{{ o.session.title }} has passed its end time without a confirmed plan. It closes by itself on {{ o.closes }}.</template>
        <template v-else>{{ o.session.title }} has passed its end time. It stays open until its host finishes it.</template>
        <template #actions><AppButton variant="secondary" small :to="sessionPath(o.session)">Open outing</AppButton></template>
      </BannerNote>
      <!-- Several past their end time: one note, not one each, with the way to the list. -->
      <BannerNote v-if="overdue.length > 1" tone="warning" icon="clock" data-testid="home-overdue">
        {{ overdue.length }} outings have passed their end time and are not finished: {{ overdueTitles }}.
        <template #actions><AppButton variant="secondary" small to="/sessions">See all meetups</AppButton></template>
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

      <!-- Meetups going, as a list, when List is on: a row selects, like a pin. -->
      <section v-if="events.loaded && hasMeetups && listOpen" id="home-list" class="section rise home__list" aria-labelledby="home-meetups">
        <div class="section__head">
          <h2 id="home-meetups" class="display-sm">Your meetups</h2>
        </div>
        <MeetupList :meetups="shownMeetups" :selected-id="selected?.id || ''" :my-id="auth.myId" @select="select" />
        <AppButton v-if="moreMeetups" variant="secondary" class="home__see-all" to="/sessions" data-testid="see-all-meetups">{{ allMeetupsLabel(sessions.length) }}<AppIcon name="arrow-right" :size="16" /></AppButton>
      </section>
      <p class="sr-only" role="status">{{ announce }}</p>

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
/* The places while the next meetup's are loading: still there, faded. */
.is-refreshing { opacity: 0.5; transition: opacity var(--motion-fast) var(--ease-out); pointer-events: none; }
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
/* Add friends, and the post button under it: top left on phones (opposite the avatar), top right from 744px (where the avatar is in
   the top bar). A column, so the greeting keeps the same clearing either side. */
.home__tools { position: absolute; z-index: 2; top: var(--spacing-md); left: var(--gutter); display: flex; flex-direction: column; align-items: center; gap: var(--spacing-sm); }
@media (min-width: 744px) { .home__tools { right: var(--gutter); left: auto; } }
@media (max-width: 743px) {
  /* Phones: the avatar sits top right and the tools column top left, so the greeting keeps clear of both, by the same amount on
     each side to stay centred. The column is as wide as its widest piece, the post button's caption, held to two short lines
     (a phone check of 3 November 2026 found "From a post" running into the first line of the greeting). */
  .hero__hello { align-self: stretch; padding-right: calc(var(--gutter) + 60px); padding-left: calc(var(--gutter) + 60px); }
  .home__tools :deep(.lm__caption) { max-width: 56px; }
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

/* The chips above the map: the weeks, each with its count after the label, then "Your turn" and List. Centred under the greeting, in
   front of the map's faded top, so they never sit over a pin. */
.home__filters { position: relative; z-index: 3; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: var(--spacing-xs) var(--spacing-md); width: 100%; max-width: 960px; margin-top: var(--spacing-md); padding: 0 var(--gutter); }
.home__filters .scroll-x { min-width: 0; flex: 0 1 auto; }
.home__toggles { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--spacing-xs); }
.home__range-count { margin-left: var(--spacing-xs); opacity: 0.7; }
/* The list, when List is on. */
.home__list { display: flex; flex-direction: column; gap: var(--spacing-base); }

/* The map's layers move together (.hero__world). */
.hero__room { position: relative; align-self: stretch; }
.hero__world { position: absolute; inset: 0; transition: transform 560ms cubic-bezier(0.16, 1, 0.3, 1); }

/* The open meetup's tall panel. Below 1024px a sheet from the bottom, above the tab bar, most of the screen tall, so the top of the map
   (and its pins) still shows over it. From 1024px the full height under the top bar, on the right, and the band (greeting, chips, map)
   narrows to the room left of it, so all of it slides left and stays centred there (the chips wrap if they must), with the map a
   little smaller; the body's list and notes
   keep clear of the panel too. The add-friends tools step aside while it is open. */
.home { --drawer-w: min(440px, 38vw); }
.home__drawer {
  position: fixed;
  z-index: 22;
  right: 0;
  bottom: var(--tabbar-real-height);
  left: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
  max-height: calc(58dvh - var(--tabbar-real-height));
  padding: var(--spacing-xs) var(--gutter) var(--spacing-xl);
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid color-mix(in srgb, var(--hairline) 70%, transparent);
  border-bottom: 0;
  border-radius: var(--rounded-lg) var(--rounded-lg) 0 0;
  /* Frosted glass, as Leaderboard's board: the map shows through softly. */
  background: color-mix(in srgb, var(--canvas) 72%, transparent);
  -webkit-backdrop-filter: blur(14px) saturate(1.3);
  backdrop-filter: blur(14px) saturate(1.3);
  box-shadow: 0 -8px 32px rgb(0 0 0 / 0.14);
  text-align: left;
}
.home__drawer-head { position: sticky; top: calc(var(--spacing-xs) * -1); z-index: 2; display: flex; align-items: center; justify-content: center; min-height: var(--tap-min); margin: 0 calc(var(--gutter) * -1) calc(var(--spacing-lg) * -1); padding: 0 var(--gutter); }
.home__grip { width: 40px; height: 4px; border-radius: var(--rounded-full); background: var(--border-strong); }
.home__drawer .hero__close { position: absolute; top: var(--spacing-xxs); right: var(--gutter); }
/* Inside the panel the meetup's card has no frame of its own: the panel is the frame. */
.home__drawer-card { padding: 0; border: 0; box-shadow: none; background: none; }
.home__drawer-places { display: flex; flex-direction: column; gap: var(--spacing-base); padding-top: var(--spacing-lg); border-top: 1px solid var(--hairline); }
.home__places { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--spacing-base); margin: 0; padding: 0; list-style: none; }
.home__more { align-self: stretch; }
.hero__close { display: inline-flex; align-items: center; justify-content: center; width: var(--tap-min); height: var(--tap-min); border: 1px solid var(--hairline); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); cursor: pointer; }
@media (hover: hover) { .hero__close:hover { background: var(--surface-soft); } }
.hero__close:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.drawer-enter-active { transition: transform 520ms cubic-bezier(0.16, 1, 0.3, 1), opacity 240ms var(--ease-out); }
.drawer-leave-active { transition: transform 260ms var(--ease-out), opacity 200ms var(--ease-out); }
.drawer-enter-from, .drawer-leave-to { transform: translateY(100%); opacity: 0; }
.home__tools { transition: opacity var(--motion-fast) var(--ease-out); }
@media (max-width: 1023px) { .has-drawer .home__body { padding-bottom: 58dvh; } }
@media (min-width: 1024px) {
  .home__drawer { top: var(--topbar-real-height); bottom: 0; left: auto; width: var(--drawer-w); max-height: none; padding: var(--spacing-md) var(--spacing-lg) var(--spacing-xl); border-width: 0 0 0 1px; border-radius: 0; box-shadow: -12px 0 40px rgb(0 0 0 / 0.08); }
  .home__drawer-head { justify-content: flex-end; margin-bottom: calc(var(--tap-min) * -1 - var(--spacing-lg)); background: none; pointer-events: none; }
  .home__drawer-head .hero__close { position: static; pointer-events: auto; }
  .home__grip { display: none; }
  .home__drawer-card { padding-right: calc(var(--tap-min) + var(--spacing-sm)); }
  .home__places { grid-template-columns: 1fr; }
  .drawer-enter-from, .drawer-leave-to { transform: translateX(100%); opacity: 1; }
  .hero { transition: padding-right 560ms cubic-bezier(0.16, 1, 0.3, 1); }
  .has-drawer .hero { padding-right: var(--drawer-w); }
  .has-drawer .hero__world { transform: scale(0.88); }
  .has-drawer .home__tools { opacity: 0; pointer-events: none; visibility: hidden; }
  .home__body { transition: padding-right 560ms cubic-bezier(0.16, 1, 0.3, 1); }
  .has-drawer .home__body { padding-right: calc(var(--drawer-w) + var(--gutter)); }
}
@media (prefers-reduced-motion: reduce) {
  .hero, .hero__world, .home__body, .drawer-enter-active, .drawer-leave-active { transition: none; }
}
/* The way to every meetup: a secondary button under the list, full width on phones and its own width from 744px. */
.home__see-all { align-self: stretch; }
@media (min-width: 744px) { .home__see-all { align-self: flex-start; } }
.home__headtext { min-width: 0; }

/* A place card is a link to its detail view. */
.place-link { display: block; border-radius: var(--rounded-md); color: inherit; text-decoration: none; }
.place-link--tile { height: 100%; }
/* The carousel's last card: more places, as a dashed empty card with a + in a circle. */
.home__more-card { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: var(--spacing-sm); min-height: 100%; padding: var(--spacing-base); border: 1px dashed var(--border-strong); border-radius: var(--rounded-md); background: var(--canvas); color: var(--ink); font: inherit; text-align: center; cursor: pointer; }
@media (hover: hover) { .home__more-card:hover { border-color: var(--ink); background: var(--surface-soft); } }
.home__more-card:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.home__more-icon { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: var(--rounded-full); background: var(--surface-strong); }
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
