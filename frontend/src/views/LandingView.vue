<script setup>
// Home: "Create session", Ian's points and what café discounts they buy, his current session and places near him,
// with one Filter button.
// The filter has toggles (Touristy spots, Hidden gems, CDC Vouchers accepted, Food, Café),
// a budget slider (the most to spend per person) and a distance slider.
import { computed, onMounted, ref } from 'vue'
import { format } from 'date-fns'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import RangeSlider from '@/components/ui/RangeSlider.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import PlaceCard from '@/components/event/PlaceCard.vue'
import SessionCard from '@/components/event/SessionCard.vue'
import * as api from '@/lib/api.js'
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
const loadingPlaces = ref(true)
const filterOpen = ref(false)
const shown = ref(PAGE)

const emptyFilters = () => ({ touristy: false, hidden: false, cdc: false, food: false, cafe: false, budget: BUDGET.max, distance: DISTANCE.max })
// What the list shows, and what the sheet is editing. "Show places" copies one to the other.
const filters = ref(emptyFilters())
const today = format(new Date(), 'EEEE d MMMM')
const editing = ref(emptyFilters())

onMounted(async () => {
  const jobs = [groups.loadPeople(), groups.loadLeaderboard(), groups.loadRewards()]
  if (!events.loaded) jobs.push(events.loadSessions())
  places.value = await api.nearbyPlaces(auth.user.homeAreaId)
  loadingPlaces.value = false
  await Promise.all(jobs)
})

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

// Points, in terms of what they buy: "320 points: enough for 5 café discounts, like SGD 3 off any coffee at Nylon Coffee Roasters."
const pointsLine = computed(() => {
  const points = groups.me?.points
  if (points == null || !groups.rewards.length) return ''
  const affordable = groups.rewards.filter((r) => r.cost <= points).sort((a, b) => b.cost - a.cost)
  if (!affordable.length) {
    const cheapest = Math.min(...groups.rewards.map((r) => r.cost))
    return `You have ${points} points. ${cheapest - points} more and you can get your first café discount. Every meetup you finish earns 100.`
  }
  const best = affordable[0]
  const count = affordable.length === 1 ? 'a café discount' : `${affordable.length} café discounts`
  // "One free cupcake" reads "one free cupcake" mid-sentence; "SGD 5 off" stays as it is.
  const offer = /^[A-Z][a-z]/.test(best.offer) ? best.offer[0].toLowerCase() + best.offer.slice(1) : best.offer
  return `You have ${points} points: enough for ${count}, like ${offer} at ${best.cafe}.`
})

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
        </div>
        <RouterLink to="/profile" class="home__me mobile-only" aria-label="Profile" title="Profile">
          <UserAvatar :name="auth.user.name" :src="auth.user.photo" :size="44" />
        </RouterLink>
      </div>
    </header>

    <div class="screen__body">
      <section class="section rise" aria-label="Your session">
        <SkeletonRow v-if="!events.loaded" :lines="3" />
        <SessionCard v-else-if="events.current" hero class="home__session" :session="events.current" :names="(id) => (id === 'ian' ? auth.user.name : groups.nameOf(id))" />
        <RouterLink v-else to="/sessions/new" class="home__new">
          <span class="home__new-icon"><AppIcon name="plus" :size="22" /></span>
          <span class="display-sm">Create session</span>
        </RouterLink>
        <RouterLink v-if="events.sessions.length > 1" to="/sessions" class="home__all caption">All sessions <AppIcon name="chevron-right" :size="14" /></RouterLink>
      </section>

      <BannerNote v-if="pointsLine" class="rise" style="--i: 1" icon="gift">
        {{ pointsLine }}
        <template #actions>
          <AppButton small variant="secondary" to="/leaderboard#rewards">See café discounts</AppButton>
        </template>
      </BannerNote>

      <section class="section rise" style="--i: 2" aria-labelledby="home-places">
        <div class="section__head">
          <h2 id="home-places" class="display-sm">Nearby</h2>
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
            <li v-for="place in filtered.slice(0, shown)" :key="place.id"><PlaceCard :place="place" /></li>
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
  </main>
</template>

<style scoped>
.home__top { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--spacing-md); }
.home__me { border-radius: var(--rounded-full); }
.home__session { max-width: 640px; }
.home__all { display: inline-flex; align-items: center; gap: 2px; align-self: flex-start; min-height: var(--tap-min); color: var(--ink); text-decoration: underline; }
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
