<script setup>
// Home: a greeting, then what Ian needs next. Three states:
//   No active meetup        greeting, a short line about Jio, "Create meetup", and Your meetups (past ones, or an
//                           empty state with a create prompt).
//   Meetup, no midpoint     a "Your meetup" card: name, friends, where the midpoint stands, Open meetup.
//   Meetup with a midpoint  the same card with the meeting area, and Places near your meetup below: places around
//                           the midpoint, nearest first, with one Filter button.
// The filter has toggles (Touristy spots, Hidden gems, CDC Vouchers accepted, Food, Café),
// a budget slider (the most to spend per person) and a distance slider (from the midpoint).
// Tapping a place opens it (?place=id): its card grows into PlaceDetail and shrinks back on close.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { format } from 'date-fns'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AvatarStack from '@/components/ui/AvatarStack.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import RangeSlider from '@/components/ui/RangeSlider.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import PlaceCard from '@/components/event/PlaceCard.vue'
import PlaceDetail from '@/components/event/PlaceDetail.vue'
import SessionCard from '@/components/event/SessionCard.vue'
import * as api from '@/lib/api.js'
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
const filterOpen = ref(false)
const shown = ref(PAGE)

const emptyFilters = () => ({ touristy: false, hidden: false, cdc: false, food: false, cafe: false, budget: BUDGET.max, distance: DISTANCE.max })
// What the list shows, and what the sheet is editing. "Show places" copies one to the other.
const filters = ref(emptyFilters())
const today = format(new Date(), 'EEEE d MMMM')
const editing = ref(emptyFilters())

onMounted(async () => {
  const jobs = [groups.loadPeople()]
  if (!events.loaded) jobs.push(events.loadSessions())
  await Promise.all(jobs)
})

// ── The meetup ──
const nameOf = (id) => (id === 'ian' ? auth.user.name : groups.nameOf(id))
// The meetup still going (not completed or cancelled). Home is about this one.
const meetup = computed(() => events.sessions.find((s) => !['completed', 'cancelled'].includes(s.status)) || null)
const past = computed(() => events.sessions.filter((s) => s !== meetup.value).slice(0, 3))
const area = computed(() => meetup.value?.area || null)
const friends = computed(() => (meetup.value?.activeIds || []).filter((id) => id !== 'ian'))
const friendPeople = computed(() => friends.value.map((id) => ({ id, name: nameOf(id) })))
const friendsText = computed(() => `${friends.value.length} ${friends.value.length === 1 ? 'friend' : 'friends'}`)

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
  if (!meetup.value) return 'Plan a meetup with friends. Jio finds the fairest place for everyone to meet.'
  if (area.value) return `Your group meets at ${area.value.name}. Here is what is nearby.`
  return 'Once everyone shares where they are starting, Jio works out the fairest midpoint.'
})

// Places near the midpoint, nearest first. Loaded again when the midpoint moves.
watch(
  () => area.value?.id,
  async (areaId) => {
    if (!areaId) {
      places.value = []
      return
    }
    loadingPlaces.value = true
    places.value = await api.nearbyPlaces(areaId)
    loadingPlaces.value = false
  },
  { immediate: true },
)

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

async function showPlace(id) {
  const card = places.value.find((p) => p.id === id)
  reviews.value = null
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
  } catch {
    // A link to a place that does not exist: just show Home.
    router.replace({ query: {} })
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
    <header class="screen__header">
      <div class="home__top">
        <div class="screen__titles">
          <p class="caption text-muted">{{ today }}</p>
          <h1 class="display-xl">Hi, {{ auth.user.name }}</h1>
          <p class="body-md text-muted home__blurb">{{ blurb }}</p>
        </div>
        <RouterLink to="/profile" class="home__me" aria-label="Profile" title="Profile">
          <UserAvatar :name="auth.user.name" :src="auth.user.photo" person="ian" :size="44" />
        </RouterLink>
      </div>
    </header>

    <div class="screen__body">
      <SkeletonRow v-if="!events.loaded" :lines="3" />

      <!-- No meetup going: one clear way to start. -->
      <AppButton v-else-if="!meetup" class="home__create rise" to="/sessions/new">
        <AppIcon name="plus" />
        Create meetup
      </AppButton>

      <!-- The meetup going now. -->
      <article v-else class="meetup rise" aria-labelledby="meetup-name">
        <p class="meetup__label caption">Your meetup</p>
        <h2 id="meetup-name" class="display-sm meetup__name">{{ meetup.title }}</h2>
        <div class="meetup__meta">
          <span class="meetup__row">
            <AvatarStack v-if="friendPeople.length" :people="friendPeople" :size="24" :max="4" />
            <span>{{ friendsText }}</span>
          </span>
          <span v-if="area" class="meetup__row">
            <AppIcon name="pin" :size="16" />
            <span>Meeting at <strong>{{ area.name }}</strong></span>
          </span>
          <span v-else class="meetup__row" :class="{ 'is-finding': meetup.findingMeeting }">
            <span class="meetup__pulse" aria-hidden="true" />
            <span>{{ midpointStatus }}</span>
          </span>
        </div>
        <AppButton class="meetup__open" :to="openTo">
          Open meetup
          <AppIcon name="chevron-right" :size="16" />
        </AppButton>
      </article>

      <!-- No meetup going: the ones before, or a prompt to make the first. -->
      <section v-if="events.loaded && !meetup" class="section rise" aria-labelledby="home-meetups">
        <div class="section__head">
          <h2 id="home-meetups" class="display-sm">Your meetups</h2>
          <AppButton v-if="events.sessions.length > 3" variant="tertiary" underline to="/sessions">All meetups</AppButton>
        </div>
        <ul v-if="past.length" class="grid-3">
          <li v-for="s in past" :key="s.id"><SessionCard :session="s" :names="nameOf" /></li>
        </ul>
        <EmptyState v-else title="No meetups yet" text="Start one and invite your friends. Jio finds the fairest place to meet." />
        <RouterLink to="/sessions/new" class="home__new">
          <span class="home__new-icon"><AppIcon name="plus" :size="22" /></span>
          <span class="stack">
            <span class="title-md">Create meetup</span>
            <span class="caption-sm text-muted">Pick a day, invite friends, and let Jio find the midpoint.</span>
          </span>
        </RouterLink>
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

        <div v-if="loadingPlaces" class="grid-3">
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
    <PlaceDetail v-if="openPlace" :place="openPlace" :reviews="reviews" :from="area?.name || 'home'" @close="closePlace" />
  </main>
</template>

<style scoped>
.home__top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing-md); }
.home__blurb { max-width: 560px; margin: var(--spacing-xs) 0 0; }
.home__me { flex-shrink: 0; border-radius: var(--rounded-full); }
.home__create { align-self: flex-start; }
.home__context { display: inline-flex; align-items: center; gap: var(--spacing-xs); margin: 0; }

/* Your meetup: a white card that floats a little, like a reservation card. */
.meetup { display: flex; flex-direction: column; gap: var(--spacing-md); max-width: 560px; padding: var(--spacing-lg); border: 1px solid var(--hairline); border-radius: var(--rounded-lg); background: var(--canvas); box-shadow: var(--shadow-float); }
.meetup__label { margin: 0; color: var(--muted); font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; }
.meetup__name { margin: 0; overflow-wrap: anywhere; }
.meetup__meta { display: flex; flex-direction: column; gap: var(--spacing-sm); color: var(--body); font: var(--text-body-sm); }
.meetup__row { display: inline-flex; align-items: center; gap: var(--spacing-sm); }
.meetup__row strong { color: var(--ink); font-weight: 600; }
.meetup__open { align-self: flex-start; }
/* The midpoint is still to come: a soft Rausch pulse, quicker while the planner is working it out. */
.meetup__pulse { position: relative; flex-shrink: 0; width: 10px; height: 10px; margin: 0 3px; border-radius: var(--rounded-full); background: var(--primary); }
.meetup__pulse::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: var(--primary); animation: meetup-pulse 2s ease-out infinite; }
.is-finding .meetup__pulse::after { animation-duration: 0.9s; }
@keyframes meetup-pulse { from { transform: scale(1); opacity: 0.6; } to { transform: scale(3); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .meetup__pulse::after { animation: none; } }

/* A place card is a link to its detail view. */
.place-link { display: block; border-radius: var(--rounded-md); color: inherit; text-decoration: none; }
.place-link:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.home__new { display: flex; align-items: center; gap: var(--spacing-base); max-width: 640px; padding: var(--spacing-lg); border: 1px dashed var(--border-strong); border-radius: var(--rounded-md); background: var(--canvas); color: var(--ink); text-decoration: none; }
.home__new-icon { display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); }
@media (hover: hover) { .home__new:hover { border-color: var(--ink); box-shadow: var(--shadow-float); } }
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
