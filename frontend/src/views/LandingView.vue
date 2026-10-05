<script setup>
// Home: "Create session", Ian's current session and places near him, with one Filter button.
// The filter has toggles (Touristy spots, Hidden gems, CDC Vouchers accepted, Food, Café),
// a budget slider (the most to spend per person) and a distance slider.
import { computed, onMounted, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
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
const editing = ref(emptyFilters())

onMounted(async () => {
  const jobs = [groups.loadPeople()]
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

const budgetText = (v) => (v >= BUDGET.max ? 'Any budget' : `Up to SGD ${v}`)
const distanceText = (v) => (v >= DISTANCE.max ? 'Any distance' : `Within ${v} km`)
</script>

<template>
  <main class="screen home" data-testid="landing-view">
    <header class="screen__header">
      <div class="screen__bar">
        <span class="display-xl text-brand mobile-only" aria-hidden="true">Jio</span>
        <RouterLink to="/profile" class="home__me mobile-only" aria-label="Profile">
          <UserAvatar :name="auth.user.name" :src="auth.user.photo" :size="40" />
        </RouterLink>
      </div>
      <div class="screen__titles">
        <h1 class="display-xl">Hi, {{ auth.user.name }}</h1>
      </div>
    </header>

    <div class="screen__body">
      <AppButton class="home__create" to="/sessions/new">
        <AppIcon name="plus" />
        Create session
      </AppButton>

      <section class="section" aria-labelledby="home-current">
        <div class="section__head">
          <h2 id="home-current" class="display-sm">Current session</h2>
          <AppButton v-if="events.sessions.length > 1" variant="tertiary" underline to="/sessions">All sessions</AppButton>
        </div>
        <SkeletonRow v-if="!events.loaded" :lines="3" />
        <SessionCard v-else-if="events.current" class="home__session" :session="events.current" :names="(id) => (id === 'ian' ? auth.user.name : groups.nameOf(id))" />
        <EmptyState v-else title="No session yet" text="Create one and invite your friends." />
      </section>

      <section class="section" aria-labelledby="home-places">
        <div class="section__head">
          <h2 id="home-places" class="display-sm">Places near you</h2>
          <button type="button" class="filter-btn" :class="{ 'is-on': activeCount }" :aria-label="activeCount ? `Filter, ${activeCount} on` : 'Filter'" @click="openFilter">
            <AppIcon name="filter" />
            <span>Filter</span>
            <span v-if="activeCount" class="filter-btn__count" aria-hidden="true">{{ activeCount }}</span>
          </button>
        </div>

        <div v-if="loadingPlaces" class="grid-3">
          <SkeletonRow v-for="n in 6" :key="n" avatar />
        </div>
        <EmptyState v-else-if="!filtered.length" title="No places match these filters" text="Try a bigger budget or distance, or clear the filters.">
          <AppButton variant="secondary" @click="clearApplied">Clear all</AppButton>
        </EmptyState>
        <template v-else>
          <p class="caption-sm text-muted">{{ filtered.length }} places</p>
          <ul class="grid-3">
            <li v-for="place in filtered.slice(0, shown)" :key="place.id"><PlaceCard :place="place" /></li>
          </ul>
          <AppButton v-if="filtered.length > shown" variant="secondary" class="home__more" @click="shown += PAGE">Show more places</AppButton>
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
.home__me { border-radius: var(--rounded-full); }
.home__create { align-self: flex-start; }
.home__session { max-width: 560px; }
.home__more { align-self: center; }
.filter-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-height: var(--tap-min);
  padding: 0 var(--spacing-base);
  border: 1px solid var(--border-strong);
  border-radius: var(--rounded-full);
  background: var(--canvas);
  color: var(--ink);
  font: var(--text-button-sm);
}
.filter-btn.is-on { border-color: var(--primary); color: var(--primary-active); }
.filter-btn__count { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); font: var(--text-badge); }
@media (hover: hover) { .filter-btn:hover { border-color: var(--ink); } }
.filter-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-base); }
</style>
