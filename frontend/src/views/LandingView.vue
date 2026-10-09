<script setup>
// Home: a band across the top with a muted dotted map of Singapore. Routes draw in from around the island and meet
// in the middle, where the one main action sits (a HeroButton) in a clearing in the dots, with the greeting above it. Below, on white, what
// comes next. Three states:
//   No active meetup        the band's action is "Start a session"; below, Your meetups (past ones, or an empty state).
//   A meetup going          the band's action is "Open meetup", with the meetup's name and where it stands under it.
//   Meetup, no midpoint     a "Your meetup" card: name, friends, where the midpoint stands, Open meetup.
//   Meetup with a midpoint  the same card with the meeting area, and Places near your meetup below: places around
//                           the midpoint, nearest first, with one Filter button.
// The filter has toggles (Touristy spots, Hidden gems, CDC Vouchers accepted, Food, Café),
// a budget slider (the most to spend per person) and a distance slider (from the midpoint).
// Tapping a place opens it (?place=id): its card grows into PlaceDetail and shrinks back on close. If the place
// cannot be loaded, PlaceDetail says so (or, for a link to a place that is not there, a note appears on Home).
// A failed load of the meetups or of the nearby places shows a message with a Retry button, never a skeleton for ever.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { format } from 'date-fns'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AvatarStack from '@/components/ui/AvatarStack.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import SingaporeMap from '@/components/ui/SingaporeMap.vue'
import HeroButton from '@/components/ui/HeroButton.vue'
import RangeSlider from '@/components/ui/RangeSlider.vue'
import SampleNote from '@/components/ui/SampleNote.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import PlaceCard from '@/components/event/PlaceCard.vue'
import PlaceDetail from '@/components/event/PlaceDetail.vue'
import SessionCard from '@/components/event/SessionCard.vue'
import * as api from '@/lib/api.js'
import { AREAS } from '@/lib/mock/places.js'
import { canViewTransition, withViewTransition } from '@/lib/viewTransition.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'

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

const places = ref([])
const loadingPlaces = ref(false)
const placesError = ref(false)
const loadError = ref(false)
const filterOpen = ref(false)
const shown = ref(PAGE)

const emptyFilters = () => ({ touristy: false, hidden: false, cdc: false, food: false, cafe: false, budget: BUDGET.max, distance: DISTANCE.max })
// What the list shows, and what the sheet is editing. "Show places" copies one to the other.
const filters = ref(emptyFilters())
const today = format(new Date(), 'EEEE d MMMM')
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
onMounted(loadHome)

// ── The meetup ──
const nameOf = (id) => (id === 'ian' ? auth.user.name : groups.nameOf(id))
// The meetup still going (not completed or cancelled). Home is about this one.
const meetup = computed(() => events.sessions.find((s) => !['completed', 'cancelled'].includes(s.status)) || null)
const past = computed(() => events.sessions.filter((s) => s !== meetup.value).slice(0, 3))
const area = computed(() => meetup.value?.area || null)
const friends = computed(() => (meetup.value?.activeIds || []).filter((id) => id !== 'ian'))
const friendPeople = computed(() => friends.value.map((id) => ({ id, name: nameOf(id) })))
const friendsText = computed(() => `${friends.value.length} ${friends.value.length === 1 ? 'friend' : 'friends'}`)

// The routes on the map: friends from all round the island meeting in the middle (Toa Payoh), which is where the
// band's button sits. Always these, spread out, rather than one meetup's starts (often a few stops apart).
const at = (id) => AREAS.find((a) => a.id === id)
// Until there is a midpoint (no meetup, or one still waiting on locations) Home has nothing below the band, so the
// band fills the screen and Singapore is drawn large.
const fullMap = computed(() => events.loaded && !area.value)
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
const mapRoutes = ['boon-lay', 'jurong-east', 'woodlands', 'punggol', 'tampines', 'harbourfront'].map((id) => ({ from: at(id), to: MEET }))

// Where the midpoint stands, in words, while there is none yet.
const midpointStatus = computed(() => {
  const m = meetup.value
  if (!m || area.value) return ''
  if (m.findingMeeting) return 'Finding the fairest midpoint…'
  if (m.status === 'inviting') return 'Midpoint comes once everyone shares where they start'
  const shared = m.activeIds.filter((id) => m.locations?.[id]?.start).length
  return `Waiting for locations · ${shared} of ${m.activeIds.length} shared`
})

// Open the meetup at the step it is on.
const openTo = computed(() => {
  const m = meetup.value
  if (!m) return '/sessions'
  if (m.status === 'voting') return `/sessions/${m.id}/plan`
  if (m.status === 'confirmed') return `/sessions/${m.id}/itinerary`
  return `/sessions/${m.id}`
})

// One line under the greeting, about where things stand.
const blurb = computed(() => {
  if (!meetup.value) return 'Pick a day, invite your friends, and Jio finds the fairest place for everyone to meet.'
  if (area.value) return `Your group meets at ${area.value.name}. Here is what is nearby.`
  return 'Once everyone shares where they are starting, Jio works out the fairest midpoint.'
})

// Places near the midpoint, nearest first. Loaded again when the midpoint moves. Only the answer for the area now
// showing counts, so a slow older answer never lands on a newer midpoint.
// How to call: loadPlaces(area.value.id)
async function loadPlaces(areaId) {
  placesError.value = false
  if (!areaId) {
    places.value = []
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
const route = useRoute()
const router = useRouter()
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
  const loading = api.getPlace(id, area.value?.id || auth.user.homeAreaId)
  if (card && canViewTransition() && inView(cardOf(id))) {
    morphId.value = id
    await nextTick()
    await withViewTransition(() => {
      morphId.value = ''
      openPlace.value = card
    })
  } else if (card) {
    openPlace.value = card
  }
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
      router.replace({ query: {} })
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

// Back, when the place was opened from this list; otherwise (a shared link) just drop it from the URL.
function closePlace() {
  const back = window.history.state?.back
  if (back && router.resolve(back).path === route.path && !router.resolve(back).query.place) router.back()
  else router.replace({ query: {} })
}

const budgetText = (v) => (v >= BUDGET.max ? 'Any budget' : `Up to SGD ${v}`)
const distanceText = (v) => (v >= DISTANCE.max ? 'Any distance' : `Within ${v} km`)
</script>

<template>
  <main class="screen home" data-testid="landing-view">
    <!-- The band: a muted map of Singapore; the routes meet under the main action, in the middle. -->
    <section class="hero" :class="{ 'has-meetup': meetup, 'hero--full': fullMap }" aria-labelledby="home-hello">
      <RouterLink to="/profile" class="home__me" aria-label="Profile" title="Profile">
        <UserAvatar :name="auth.user.name" :src="auth.user.photo" person="ian" :size="44" />
      </RouterLink>

      <div class="hero__hello">
        <p class="caption text-muted">{{ today }}</p>
        <h1 id="home-hello" class="display-xl">Hi, {{ auth.user.name }}</h1>
        <p class="body-md home__blurb">{{ blurb }}</p>
      </div>

      <!-- The map, with the button where the routes meet. -->
      <div class="hero__stage">
        <SingaporeMap class="hero__map" :routes="mapRoutes" :center="MEET" :span="mapSpan" hide-meet />
        <div class="hero__action">
          <SkeletonRow v-if="!events.loaded && !loadError" :lines="1" />
          <AppButton v-else-if="!events.loaded" variant="secondary" @click="loadHome">Could not load your meetups · Retry</AppButton>
          <HeroButton v-else :to="meetup ? openTo : '/sessions/new'" class="rise">{{ meetup ? 'Open meetup' : 'Start a session' }}</HeroButton>
        </div>

        <!-- The meetup going now, in one line under the button. -->
        <p v-if="meetup" class="hero__meetup">
          <AvatarStack v-if="friendPeople.length" :people="friendPeople" :size="24" :max="4" />
          <span class="title-sm truncate">{{ meetup.title }}</span>
          <span v-if="area" class="hero__where"><AppIcon name="pin" :size="14" /> {{ area.name }}</span>
          <span v-else class="hero__where" :class="{ 'is-finding': meetup.findingMeeting }"><span class="meetup__pulse" aria-hidden="true" /> {{ midpointStatus }}</span>
        </p>
      </div>
    </section>

    <div class="screen__body home__body">
      <BannerNote v-if="missingPlace" tone="warning" icon="warning" dismissible @dismiss="missingPlace = false">That place could not be found.</BannerNote>
      <!-- No meetup going: the ones before, or a prompt to make the first. -->
      <section v-if="events.loaded && !meetup" class="section rise" aria-labelledby="home-meetups">
        <div class="section__head">
          <h2 id="home-meetups" class="display-sm">Your meetups</h2>
          <AppButton v-if="events.sessions.length > 3" variant="tertiary" underline to="/sessions">All meetups</AppButton>
        </div>
        <ul v-if="past.length" class="grid-3">
          <li v-for="s in past" :key="s.id"><SessionCard :session="s" :names="nameOf" /></li>
        </ul>
        <EmptyState v-else title="No meetups yet" text="Your meetups show here once you start one." />
      </section>

      <!-- A midpoint: places around it, nearest first. -->
      <section v-if="area" class="section rise" aria-labelledby="home-places">
        <div class="section__head">
          <div class="stack">
            <h2 id="home-places" class="display-sm">Places near your meetup</h2>
            <p class="caption text-muted home__context"><AppIcon name="pin" :size="14" /> Around {{ area.name }}, the fairest midpoint for {{ meetup.activeIds.length }} people</p>
          </div>
          <button type="button" class="filter-btn" :class="{ 'is-on': activeCount }" :aria-label="activeCount ? `Filter, ${activeCount} on` : 'Filter'" title="Filter" @click="openFilter">
            <AppIcon name="filter" :size="18" />
            <span v-if="activeCount" class="filter-btn__count" aria-hidden="true">{{ activeCount }}</span>
          </button>
        </div>

        <SampleNote>Sample places, ratings and reviews for the demo</SampleNote>
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
              <RouterLink :to="{ query: { place: place.id } }" class="place-link" :data-place="place.id">
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
/* With a meetup, the clearing reaches down to take in the line under the button. */
.has-meetup .hero__map { --clearing: radial-gradient(ellipse 250px 130px at 50% calc(50% + 26px), transparent 55%, #000 100%); }
.hero__action { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); }
.hero__meetup { position: absolute; left: 50%; top: calc(50% + 48px); transform: translateX(-50%); display: inline-flex; align-items: center; gap: var(--spacing-sm); max-width: calc(100% - var(--gutter) * 2); margin: 0; white-space: nowrap; }
.hero__where { display: inline-flex; align-items: center; gap: var(--spacing-xs); color: var(--muted); font: var(--text-body-sm); }
.home__me { position: absolute; z-index: 2; top: var(--spacing-md); right: var(--gutter); flex-shrink: 0; border-radius: var(--rounded-full); }
@media (max-width: 743px) {
  /* Phones: the avatar sits top right, so the greeting keeps clear of it on both sides (to stay centred). */
  .hero__hello { align-self: stretch; padding-right: calc(var(--gutter) + 52px); padding-left: calc(var(--gutter) + 52px); }
  /* The map is narrow here, so it fades out later, nearer the edges. */
  .hero__map { --edge: radial-gradient(ellipse 70% 60% at 50% 50%, #000 70%, transparent 100%); }
  /* A smaller clearing to match the smaller map. */
  .hero__map { --clearing: radial-gradient(ellipse 160px 60px at 50% 50%, transparent 60%, #000 100%); }
  .has-meetup .hero__map { --clearing: radial-gradient(ellipse 180px 90px at 50% calc(50% + 24px), transparent 60%, #000 100%); }
}
@media (min-width: 744px) {
  .hero { padding-top: var(--spacing-xxl); }
  .hero__stage { height: 440px; }
  /* The top bar has Profile from here up. */
  .home__me { display: none; }
}
/* No midpoint yet: the band fills the screen under the top bar (above the tab bar on phones), the stage takes all
   the room under the greeting, and the map runs edge to edge, fading only at the very edges. */
.hero--full { min-height: calc(100dvh - var(--topbar-height) - var(--tabbar-height)); margin-bottom: 0; }
.hero--full .hero__stage { flex: 1 1 auto; height: auto; min-height: 420px; }
.hero--full .hero__map { --edge: radial-gradient(ellipse 72% 72% at 50% 50%, #000 70%, transparent 100%); width: 100vw; }
/* On a phone the map is drawn small, so its dots are drawn a little bigger to keep the island's shape clear. */
@media (max-width: 743px) { .hero--full .hero__map :deep(.sgmap__dots) { stroke-width: 2.8; } }
.home__body { padding-top: 0; }
.home__context { display: inline-flex; align-items: center; gap: var(--spacing-xs); margin: 0; }

/* The midpoint is still to come: a soft Rausch pulse, quicker while the planner is working it out. */
.meetup__pulse { position: relative; flex-shrink: 0; width: 10px; height: 10px; margin: 0 3px; border-radius: var(--rounded-full); background: var(--primary); }
.meetup__pulse::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: var(--primary-bright); animation: meetup-pulse 2s ease-out infinite; }
.is-finding .meetup__pulse::after { animation-duration: 0.9s; }
@keyframes meetup-pulse { from { transform: scale(1); opacity: 0.6; } to { transform: scale(3); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .meetup__pulse::after { animation: none; } }

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
