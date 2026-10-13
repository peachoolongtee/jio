<script setup>
// Step 6: choose what to do.
//   Places near the meeting area for every category at once (Eat, Drink, Shop, Activity), 3 each to start; a filter
//   narrows the list and the map to one category. Anyone can add more (up to 6 per category) or search for a place.
//   One vote per person per category: voting for another place moves it, tapping your vote again takes it back.
//   The plan is made from the categories people voted in, laid out in the session window.
//   Step 7  "Confirm plan" once at least 2 people have voted.
// The list and the map show the same places, and the map has a key to the categories of the places on it.
// Weather: a card keeps its small rain mark (SuggestionCard), and one muted line under the list says where the forecast came
// from (WeatherSource); a simulated forecast also shows a banner at the top.
// Only a session that does not exist shows "Not found". If the planner fails, an inline error with "Try again"
// shows the message and the rest of the page stays usable.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import CategoryIcon from '@/components/ui/CategoryIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import InfoTag from '@/components/ui/InfoTag.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import PopoverPanel from '@/components/ui/PopoverPanel.vue'
import PriceTier from '@/components/ui/PriceTier.vue'
import ProgressDonut from '@/components/ui/ProgressDonut.vue'
import SegmentTabs from '@/components/ui/SegmentTabs.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import SplitView from '@/components/ui/SplitView.vue'
import TextField from '@/components/ui/TextField.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import PlaceDetail from '@/components/event/PlaceDetail.vue'
import SessionNotices from '@/components/event/SessionNotices.vue'
import SuggestionCard from '@/components/event/SuggestionCard.vue'
import WeatherSource from '@/components/weather/WeatherSource.vue'
import CategoryKey from '@/components/map/CategoryKey.vue'
import PlannerMap from '@/components/map/PlannerMap.vue'
import NotFoundView from './NotFoundView.vue'
import { CATEGORIES, CATEGORY_LABELS } from '@/lib/planner/slots.js'
import { distanceText } from '@/lib/planner/format.js'
import { ORDER_TABS, VOTED, confirmKey, confirmView, sourceIcon, sourceText, votedRows } from '@/lib/confirmOrder.js'
import { placeImage } from '@/lib/placeImages.js'
import { placeFromOption } from '@/lib/reviewPick.js'
import { walkFromText } from '@/lib/cardText.js'
import { reviewsFor } from '@/lib/mock/reviews.js'
import { getPlace } from '@/lib/api.js'
import { confetti } from '@/lib/confetti.js'
import { mealWindow, MEAL_WINDOWS } from '@/lib/planner/timeOfDay.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'
import { usePlannerStore } from '@/stores/planner.js'

const props = defineProps({ id: { type: String, required: true } })

const router = useRouter()
const auth = useAuthStore()
const events = useEventsStore()
const groups = useGroupsStore()
const planner = usePlannerStore()

const missing = ref(false)
const error = ref('')
const view = ref('list')
// The category filter: '' for all of them.
const filter = ref('')
const selected = ref('')
// Why the session or its plan did not load. The planner store keeps the plan's own message in planner.errors.
const loadError = ref('')
const confirmOpen = ref(false)
const busy = ref(false)
const adding = ref({ open: false, slot: null, query: '', results: [] })
const loadingMore = ref('')

// How to call: load() (on mount, when the id changes, and from Try again)
async function load() {
  missing.value = false
  loadError.value = ''
  try {
    await events.loadSession(props.id)
  } catch (e) {
    // A session that is not there is "Not found". Anything else is a failure to show and retry.
    if (/does not exist/i.test(e.message)) missing.value = true
    else loadError.value = e.message
    return
  }
  try {
    await Promise.all([groups.loadPeople(), planner.loadConditions()])
    await planner.loadPlan(props.id)
  } catch (e) {
    loadError.value = e.message || 'The plan could not be loaded.'
  }
}
const planError = computed(() => loadError.value || planner.errors?.[props.id] || '')
onMounted(load)
watch(() => props.id, load)

const session = computed(() => events.byId[props.id])
const plan = computed(() => planner.plans[props.id])
const loading = computed(() => planner.loading[props.id] && !plan.value?.slots?.length)
const voting = computed(() => session.value?.status === 'voting')
const nameOf = (id) => (id === auth.myId ? auth.user?.name ?? '' : groups.nameOf(id))
const active = computed(() => session.value?.activeIds || [])
// Who a card's review line may quote: the other people in this outing, then the signed-in person's friends.
const outingIds = computed(() => active.value.filter((id) => id !== auth.myId))
const friendIds = computed(() => groups.friends.map((p) => p.id))
const slots = computed(() => plan.value?.slots || [])
// Where the walking times on the cards are measured from, said once above the list. Nothing without a meeting area.
const walkFrom = computed(() => (session.value?.meeting ? walkFromText(session.value.area?.name) : ''))
const shown = computed(() => (filter.value ? slots.value.filter((s) => s.category === filter.value) : slots.value))
// Under All, categories with nothing nearby fold into one line instead of an empty section each.
const listed = computed(() => (filter.value ? shown.value : shown.value.filter((s) => s.options.length)))
const emptyLabels = computed(() => (filter.value ? [] : shown.value.filter((s) => !s.options.length).map((s) => CATEGORY_LABELS[s.category])))
const listJoin = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`)
const countOf = (category) => slots.value.find((s) => s.category === category)?.options.length ?? 0
const voterIds = computed(() => plan.value?.voters || [])
const canConfirm = computed(() => voterIds.value.length >= 2 && slots.value.length > 0)
const donutPeople = computed(() => active.value.map((id) => ({ name: nameOf(id), done: voterIds.value.includes(id) })))

watch(filter, () => { selected.value = '' })

async function vote(slot, option) {
  error.value = ''
  try {
    await planner.vote(props.id, slot.id, option.id)
  } catch (e) {
    error.value = e.message
  }
}

// ── Sample reviews ──
// A card's review line opens the place's detail over this page. It is built from the option, so no request is made and it
// opens with the planner off; the address is added from the place list when the place is in it.
const reviewing = ref(null)

// How to call: openReviews(option, 'name') (from a card's name or photo; 'review' from its review line, the default)
function openReviews(option, from = 'review') {
  const place = placeFromOption(option)
  reviewing.value = { optionId: option.id, from, place, reviews: reviewsFor(option.venue) }
  if (place.address) return
  getPlace(option.venue.id, session.value?.area?.id)
    .then((known) => {
      if (reviewing.value?.optionId === option.id && known.address) reviewing.value.place = { ...reviewing.value.place, address: known.address }
    })
    .catch(() => {})
}

// Close the detail and put focus back on the control that opened it: the card's name (its photo shares that control) or its review line.
// How to call: closeReviews()
async function closeReviews() {
  const id = reviewing.value?.optionId
  const attr = reviewing.value?.from === 'name' ? 'data-open-for' : 'data-review-for'
  reviewing.value = null
  await nextTick()
  document.querySelector(`[${attr}="${CSS.escape(id ?? '')}"]`)?.focus({ preventScroll: true })
}

async function more(slot) {
  loadingMore.value = slot.id
  error.value = ''
  try {
    await planner.addMore(props.id, slot.id)
  } catch (e) {
    error.value = e.message
  } finally {
    loadingMore.value = ''
  }
}

async function swap(slot, option) {
  error.value = ''
  try {
    await planner.swapOption(props.id, slot.id, option.id, option.swap.id)
  } catch (e) {
    error.value = e.message
  }
}

function openAdd(slot) {
  adding.value = { open: true, slot, query: '', results: [] }
}
let searchTimer = null
watch(() => adding.value.query, (q) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    if (!adding.value.slot) return
    adding.value.results = await planner.searchVenues(props.id, adding.value.slot.id, q)
  }, 150)
})
const addSlotFull = computed(() => {
  const slot = slots.value.find((s) => s.id === adding.value.slot?.id)
  return slot ? slot.options.length >= 6 : false
})
function unfitText(result, slot) {
  if (result.unfit === 'category') return `${CATEGORY_LABELS[result.category]}, not ${CATEGORY_LABELS[slot.category]}`
  if (result.unfit === 'far') return `Too far from ${session.value.area.name}`
  if (result.unfit === 'closed') return `Closed at ${slot.time}`
  if (result.unfit === 'meal') return `Not open for ${MEAL_WINDOWS.find((w) => w.id === mealWindow(slot.start)).label.toLowerCase()}`
  if (result.unfit === 'mrt') return 'Too far from MRT'
  return ''
}
async function add(result) {
  error.value = ''
  try {
    await planner.addOption(props.id, adding.value.slot.id, result.id)
    adding.value.results = await planner.searchVenues(props.id, adding.value.slot.id, adding.value.query)
  } catch (e) {
    error.value = e.message
  }
}

// Why a slot has nothing, in words.
function emptyText(slot) {
  const e = slot.empty
  // The nearest distance may be missing, so the sentence about it is optional.
  const nearest = e?.nearestKm != null ? ` The nearest is ${e.nearestKm.toFixed(1)} km away.` : ''
  if (e?.reason === 'outside_max_radius') return `Nothing that fits is within 3 km.${nearest}`
  return 'Jio found no place that is open and fits this time.'
}

// ── Map ──
// The same places as the list: every category, or the one the filter shows.
const mapOptions = computed(() => shown.value.flatMap((slot) => slot.options.map((option) => ({ slot, option }))))
const mapPlaces = computed(() =>
  mapOptions.value.map(({ slot, option: o }) => ({ id: o.id, name: o.venue.name, lat: o.venue.lat, lng: o.venue.lng, category: o.venue.category, highlight: slot.leader === o.id, muted: !!slot.leader && slot.leader !== o.id })),
)
const selectedEntry = computed(() => mapOptions.value.find(({ option }) => option.id === selected.value) || null)
const selectedOption = computed(() => selectedEntry.value?.option || null)

// ── Confirm ──
// The plan the votes make: each voted category at its time, with the place that has the most votes there.
const winners = computed(() =>
  (plan.value?.planned || []).map((stop) => {
    const slot = slots.value.find((s) => s.category === stop.category)
    // Most votes first; a tie goes to the better planner score, which is a penalty (lower is better).
    const sorted = [...(slot?.options || [])].sort((a, b) => b.votes - a.votes || a.score - b.score)
    return { stop, option: sorted[0] }
  }),
)

// The suggested order, asked for when the dialog opens (the AI's, or the rules' when it is not set up or is slow). The
// dialog opens on the voted order, usable at once; a suggestion that differs is offered as a second choice and never
// selected for the host. The store keeps one answer per question and ignores late older ones (events.suggestOrder).
// Without a suggestion (nothing to arrange, a failure, a timeout) the voted order stays.
const picked = ref(VOTED)
const votedList = computed(() => votedRows(winners.value))
const orderKey = computed(() => confirmKey(winners.value, session.value, planner.conditions?.rain))
// The answer to this question, once asked: its loading flag and its suggestion.
const order = computed(() => {
  const entry = events.orders[props.id]
  return confirmOpen.value && entry && entry.key === orderKey.value ? entry : null
})
const suggesting = computed(() => confirmOpen.value && (!order.value || order.value.loading))
const orderView = computed(() => confirmView({ voted: votedList.value, suggestion: order.value?.answer ?? null, picked: picked.value }))
watch([confirmOpen, orderKey], ([open]) => {
  if (!open) return
  // A new open, or new votes, start again from the voted order.
  picked.value = VOTED
  events.suggestOrder(props.id, orderKey.value)
})

async function confirm() {
  busy.value = true
  error.value = ''
  // What is shown is what is saved: the suggestion when its order is shown, nothing for the voted order.
  const { pass } = orderView.value
  try {
    await events.confirm(props.id, pass)
    confirmOpen.value = false
    // A moment to celebrate: confetti, and the itinerary opens with a "Plan confirmed" card.
    confetti()
    router.push({ path: `/sessions/${props.id}/itinerary`, state: { justConfirmed: true } })
  } catch (e) {
    error.value = e.message
    confirmOpen.value = false
  }
  busy.value = false
}
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else-if="session" class="screen" data-testid="planner-view">
    <SessionHeader :session="session" />

    <div class="screen__body">
      <SessionNotices :session="session" />
      <BannerNote v-if="planError" tone="error" icon="warning" role="alert" data-testid="plan-error">
        {{ planError }}
        <template #actions>
          <AppButton small variant="secondary" :disabled="!!planner.loading[id]" @click="load">Try again</AppButton>
        </template>
      </BannerNote>

      <WeatherSource v-if="plan?.weather && session.meeting" :block="plan.weather" banner />

      <div v-if="!session.meeting || ['inviting', 'locating'].includes(session.status)" class="empty-wrap">
        <EmptyState title="No meeting area yet">
          <AppButton variant="secondary" :to="`/sessions/${id}`">People</AppButton>
        </EmptyState>
      </div>

      <template v-else>
        <ProgressDonut compact title="Votes" :people="donutPeople" done-label="Voted" />
        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>

        <!-- One filter for the list and the map. -->
        <div class="filter scroll-x" role="radiogroup" aria-label="Show">
          <ChipButton radio :selected="!filter" @click="filter = ''">All</ChipButton>
          <ChipButton v-for="c in CATEGORIES" :key="c" radio :selected="filter === c" :aria-label="`${CATEGORY_LABELS[c]}, ${countOf(c)} places`" @click="filter = c">
            <template #leading><CategoryIcon :category="c" :size="24" /></template>
            {{ CATEGORY_LABELS[c] }}<span class="filter__count tnum">{{ countOf(c) }}</span>
          </ChipButton>
        </div>

        <SplitView v-model:view="view" label="Places">
          <template #list>
            <p v-if="!loading && listed.length && walkFrom" class="walk-from caption-sm text-muted" data-testid="walk-from">{{ walkFrom }}</p>
            <div v-if="loading" class="stack gap-md">
              <SkeletonRow v-for="n in 3" :key="n" avatar :lines="3" />
            </div>
            <EmptyState v-else-if="!slots.length && !planError" title="Nothing nearby yet" text="Jio found no places that fit this session." />
            <section v-for="(slot, si) in listed" v-else :key="slot.id" class="slot rise" :style="{ '--i': si }" :aria-labelledby="`slot-${slot.id}`">
              <header class="slot__head">
                <CategoryIcon :category="slot.category" :size="32" />
                <h2 :id="`slot-${slot.id}`" class="title-md">{{ CATEGORY_LABELS[slot.category] }}</h2>
              </header>

              <p v-if="!slot.options.length" class="body-sm text-muted">{{ emptyText(slot) }}</p>
              <template v-else>
                <div class="slot__options" role="radiogroup" :aria-labelledby="`slot-${slot.id}`">
                  <SuggestionCard
                    v-for="option in slot.options"
                    :key="option.id"
                    :option="option"
                    :leading="slot.leader === option.id"
                    :behind="!!slot.leader && slot.leader !== option.id"
                    :mine="slot.myVote === option.id"
                    :closed="!voting"
                    :selected="selected === option.id"
                    :outing="outingIds"
                    :friends="friendIds"
                    :stop="{ start: slot.start, duration: slot.duration }"
                    :group-size="active.length"
                    :me="auth.myId"
                    @vote="vote(slot, $event)"
                    @swap="swap(slot, $event)"
                    @open="openReviews"
                  />
                </div>
                <div v-if="voting && slot.options.length < 6" class="slot__more">
                  <AppButton variant="tertiary" underline small :disabled="!slot.canAddMore || loadingMore === slot.id" @click="more(slot)">More places</AppButton>
                  <AppButton variant="tertiary" underline small @click="openAdd(slot)">Search</AppButton>
                </div>
              </template>
            </section>
            <p v-if="!loading && slots.length && emptyLabels.length" class="body-sm text-muted">No {{ listJoin(emptyLabels) }} places within 3 km of {{ session.area.name }} yet.</p>
            <WeatherSource v-if="!loading && slots.length && plan?.weather" :block="plan.weather" />
          </template>

          <template #map>
            <PlannerMap :area="session.area" :places="mapPlaces" :selected="selected" label="Places map" @select="selected = $event" />
            <CategoryKey :categories="mapPlaces.map((p) => p.category)" />
            <div v-if="selectedOption" class="pin-card" role="dialog" :aria-label="selectedOption.venue.name">
              <div class="row between gap-sm">
                <img class="pin-card__photo" :src="placeImage(selectedOption.venue)" alt="" width="56" height="56" />
                <span class="title-md clamp-2 pin-card__name">{{ selectedOption.venue.name }}</span>
                <IconButton label="Close" @click="selected = ''"><AppIcon name="close" :size="14" /></IconButton>
              </div>
              <div class="row gap-sm wrap">
                <CategoryIcon :category="selectedOption.venue.category" :size="24" />
                <span class="caption-sm">about {{ selectedOption.walk }} min walk · {{ distanceText(selectedOption.distanceM) }}</span>
                <PriceTier :price="selectedOption.venue.price" />
                <InfoTag v-if="selectedEntry.slot.leader === selectedOption.id" tone="strong" icon="trophy">Leading</InfoTag>
              </div>
              <div class="row between">
                <span class="caption">{{ selectedOption.votes }} {{ selectedOption.votes === 1 ? 'vote' : 'votes' }}</span>
                <ChipButton v-if="voting" radio check :selected="selectedEntry.slot.myVote === selectedOption.id" @click="vote(selectedEntry.slot, selectedOption)">
                  {{ selectedEntry.slot.myVote === selectedOption.id ? 'Voted' : 'Vote' }}
                </ChipButton>
              </div>
            </div>
          </template>
        </SplitView>
      </template>
    </div>

    <footer v-if="voting && session.meeting" class="screen__footer">
      <AppButton block :disabled="!canConfirm" @click="confirmOpen = true">
        {{ canConfirm ? 'Confirm plan' : 'Needs 2 voters' }}
      </AppButton>
    </footer>
    <footer v-else-if="['confirmed', 'completed'].includes(session.status)" class="screen__footer">
      <AppButton next block :to="`/sessions/${id}/itinerary`">Itinerary</AppButton>
    </footer>

    <PlaceDetail v-if="reviewing" :place="reviewing.place" :reviews="reviewing.reviews" :outing="outingIds" :from="session.area.name" @close="closeReviews" />

    <ModalDialog v-model:open="confirmOpen" title="Confirm plan?">
      <template #content>
        <div v-if="suggesting || orderView.choice" class="order-pick">
          <SegmentTabs v-if="orderView.choice" v-model="picked" label="Order of the stops" :tabs="ORDER_TABS" />
          <p v-else class="caption-sm text-muted">Looking for a suggested order…</p>
        </div>
        <ul class="winners">
          <li v-for="row in orderView.rows" :key="row.key" class="winners__row">
            <CategoryIcon :category="row.category" :size="28" />
            <span class="stack">
              <span class="caption-sm text-muted">{{ row.when }}</span>
              <span class="title-sm">{{ row.name }}</span>
            </span>
          </li>
        </ul>
        <p class="order-note caption-sm text-muted" :class="{ 'order-note--held': suggesting || !!orderView.note }" role="status">
          <template v-if="orderView.note">
            <AppIcon :name="sourceIcon(orderView.note)" :size="14" />
            <span>{{ sourceText(orderView.note) }}</span>
          </template>
          <template v-else>You can rearrange stops after confirming.</template>
        </p>
      </template>
      <AppButton block :disabled="busy" @click="confirm">Confirm</AppButton>
      <AppButton block variant="secondary" @click="confirmOpen = false">Not yet</AppButton>
    </ModalDialog>

    <PopoverPanel v-model:open="adding.open" :title="adding.slot ? `Add to ${CATEGORY_LABELS[adding.slot.category]}` : 'Add a place'" :width="420">
      <TextField v-model="adding.query" label="Search places" hide-label placeholder="Search places" type="text" inputmode="search" autocomplete="off" />
      <p v-if="addSlotFull" class="body-sm text-error" role="alert">{{ CATEGORY_LABELS[adding.slot.category] }} already has 6 places.</p>
      <ul v-if="adding.results.length" class="add-results">
        <li v-for="r in adding.results" :key="r.id" class="add-row">
          <CategoryIcon :category="r.category" :size="32" />
          <span class="add-row__text">
            <span class="title-sm truncate">{{ r.name }}</span>
            <span v-if="r.unfit" class="caption-sm text-error">{{ unfitText(r, adding.slot) }}</span>
            <span v-else class="caption-sm text-muted">about {{ r.walk }} min walk</span>
          </span>
          <InfoTag v-if="r.added" tone="strong">Added</InfoTag>
          <AppButton v-else variant="secondary" small :disabled="!!r.unfit || addSlotFull" :aria-label="`Add ${r.name}`" @click="add(r)">Add</AppButton>
        </li>
      </ul>
      <p v-else-if="adding.query.trim()" class="body-sm text-muted">No places match "{{ adding.query.trim() }}".</p>
    </PopoverPanel>
  </main>
  <main v-else class="screen" data-testid="planner-view">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <BannerNote v-if="loadError" tone="error" icon="warning" role="alert">
        {{ loadError }}
        <template #actions>
          <AppButton small variant="secondary" @click="load">Try again</AppButton>
        </template>
      </BannerNote>
      <SkeletonRow v-for="n in 4" v-else :key="n" avatar />
    </div>
  </main>
</template>

<style scoped>
/* The filter: one row of chips, scrolling sideways on a phone. */
.filter { display: flex; gap: var(--spacing-sm); }
.filter__count { margin-left: var(--spacing-xs); opacity: 0.6; }
.walk-from { margin: 0; }
.slot { display: flex; flex-direction: column; gap: var(--spacing-md); }
.slot + .slot { padding-top: var(--spacing-lg); }
.slot__head { display: flex; align-items: center; gap: var(--spacing-md); }
.slot__options { display: flex; flex-direction: column; gap: var(--spacing-md); }
.slot__more { display: flex; gap: var(--spacing-base); }
.empty-wrap { padding-top: var(--spacing-lg); }
.pin-card { position: absolute; left: var(--spacing-sm); right: var(--spacing-sm); bottom: var(--spacing-xl); z-index: 600; display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-md) var(--spacing-md) var(--spacing-sm) var(--spacing-base); border-radius: var(--rounded-md); background: var(--canvas); box-shadow: var(--shadow-float); }
.pin-card__photo { flex-shrink: 0; width: 56px; height: 56px; object-fit: cover; border-radius: var(--rounded-sm); }
.pin-card__name { flex: 1 1 0; min-width: 0; }
.winners { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.winners__row { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: var(--spacing-md); }
.add-results { display: flex; flex-direction: column; }
.add-row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 64px; }
.add-row + .add-row { border-top: 1px solid var(--hairline-soft); }
.add-row__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
.order-pick { display: flex; align-items: center; min-height: var(--tap-min); }
.order-pick p { margin: 0; }
.order-pick :deep(.seg) { flex: 1 1 auto; }
.order-note { display: flex; align-items: flex-start; gap: 6px; margin: 0; }
.order-note :deep(svg) { flex-shrink: 0; margin-top: 2px; }
/* While an answer is awaited or shown, room for three lines, so the buttons below do not move when it arrives. */
.order-note--held { min-height: 3lh; }
</style>
