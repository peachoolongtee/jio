<script setup>
// Step 6: choose what to do (diverge).
//   6a  Each person picks categories and how long they can stay. Jio turns the most picked categories
//       into ordered time slots inside the session window. Ian can delete a slot.
//   6b  For each slot, 3 suggested places near the meeting area. Anyone can add more (up to 6).
//       One vote per person per slot; a second tap changes it. The leader is highlighted.
//   Step 7  "Confirm plan" once at least 2 people have voted.
// The list and the map show the same suggestions.
// Only a session that does not exist shows "Not found". If the planner fails, an inline error with "Try again"
// shows the message and the rest of the page stays usable.
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import CategoryIcon from '@/components/ui/CategoryIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import InfoTag from '@/components/ui/InfoTag.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import PriceTier from '@/components/ui/PriceTier.vue'
import ProgressDonut from '@/components/ui/ProgressDonut.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import SplitView from '@/components/ui/SplitView.vue'
import TextField from '@/components/ui/TextField.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import SessionNotices from '@/components/event/SessionNotices.vue'
import SuggestionCard from '@/components/event/SuggestionCard.vue'
import PlannerMap from '@/components/map/PlannerMap.vue'
import NotFoundView from './NotFoundView.vue'
import { CATEGORIES, CATEGORY_LABELS } from '@/lib/planner/slots.js'
import { distanceText, fromMinutes, timeAndDuration } from '@/lib/planner/format.js'
import { placeImage } from '@/lib/placeImages.js'
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
// Why the session or its plan did not load. The planner store keeps the plan's own message in planner.errors.
const loadError = ref('')
const view = ref('list')
const mapSlot = ref('')
const selected = ref('')
const deleting = ref(null)
const confirmOpen = ref(false)
const busy = ref(false)
const adding = ref({ open: false, slot: null, query: '', results: [] })
const loadingMore = ref('')

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
onMounted(load)
watch(() => props.id, load)

const session = computed(() => events.byId[props.id])
const plan = computed(() => planner.plans[props.id])
const loading = computed(() => planner.loading[props.id] && !plan.value?.slots?.length)
const planError = computed(() => loadError.value || planner.errors?.[props.id] || '')
const voting = computed(() => session.value?.status === 'voting')
const nameOf = (id) => (id === 'ian' ? auth.user.name : groups.nameOf(id))
const active = computed(() => session.value?.activeIds || [])
const myPrefs = computed(() => plan.value?.prefs?.ian || { categories: [], until: null })
const slots = computed(() => plan.value?.slots || [])
const voterIds = computed(() => plan.value?.voters || [])
const canConfirm = computed(() => voterIds.value.length >= 2 && slots.value.length > 0)
const donutPeople = computed(() => active.value.map((id) => ({ name: nameOf(id), done: voterIds.value.includes(id) })))

watch(slots, (list) => {
  if (!list.find((s) => s.id === mapSlot.value)) mapSlot.value = list[0]?.id || ''
})

// ── 6a ──
async function savePrefs(patch) {
  error.value = ''
  try {
    await planner.setMyPreferences(props.id, { ...myPrefs.value, ...patch })
  } catch (e) {
    error.value = e.message
  }
}
function toggleCategory(category) {
  const list = myPrefs.value.categories
  savePrefs({ categories: list.includes(category) ? list.filter((c) => c !== category) : [...list, category] })
}
// The last stay option is the end of the session, stored as "the whole time" (null).
const stayValue = (m) => (fromMinutes(m) === session.value?.end ? null : m)

async function deleteSlot() {
  const slot = deleting.value
  deleting.value = null
  error.value = ''
  try {
    await planner.deleteSlot(props.id, slot.id)
  } catch (e) {
    error.value = e.message
  }
}

// ── 6b ──
async function vote(slot, option) {
  error.value = ''
  try {
    await planner.vote(props.id, slot.id, option.id)
  } catch (e) {
    error.value = e.message
  }
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

// ── Search radius ──
// null: the planner widens on its own (500 m, then 1, 2 and 3 km). Otherwise only places this close are suggested.
const RADII = [null, 100, 250, 500, 1000, 2000, 3000]
const radiusLabel = (m) => (m == null ? 'Auto' : m >= 1000 ? `${m / 1000} km` : `${m} m`)
const radius = computed(() => plan.value?.radius ?? null)
const settingRadius = ref(false)
async function setRadius(metres) {
  if (metres === radius.value) return
  settingRadius.value = true
  error.value = ''
  try {
    await planner.setRadius(props.id, metres)
  } catch (e) {
    error.value = e.message
  }
  settingRadius.value = false
}
// The smallest radius choice that reaches `km`, for "Widen to …".
const radiusFor = (km) => RADII.find((m) => m != null && m >= km * 1000) ?? null

// Who leads a slot, in words: "Leading: Ming Kee Chicken Rice · 2 votes", or a tie.
function leadText(slot) {
  const name = (id) => slot.options.find((o) => o.id === id)?.venue.name || ''
  const votes = `${slot.topVotes} ${slot.topVotes === 1 ? 'vote' : 'votes'}`
  if (slot.leader) return `Leading: ${name(slot.leader)} · ${votes}`
  if (slot.tied?.length) return `Tied: ${slot.tied.map(name).join(' and ')} · ${votes} each`
  return ''
}

// Why a slot has nothing, in words.
function emptyText(slot) {
  const e = slot.empty
  // The nearest distance may be missing, so the sentence about it is optional.
  const nearest = e?.nearestKm != null ? ` The nearest is ${e.nearestKm.toFixed(1)} km away.` : ''
  if (e?.reason === 'outside_max_radius' && radius.value) return `Nothing that fits is within ${radiusLabel(radius.value)}.${nearest}`
  if (e?.reason === 'outside_max_radius') return `Nothing that fits is within 3 km.${nearest}`
  return 'Jio found no place that is open and fits this time.'
}

// ── Map ──
const currentMapSlot = computed(() => slots.value.find((s) => s.id === mapSlot.value) || slots.value[0])
const mapPlaces = computed(() =>
  (currentMapSlot.value?.options || []).map((o) => ({ id: o.id, name: o.venue.name, lat: o.venue.lat, lng: o.venue.lng, category: o.venue.category, highlight: currentMapSlot.value.leader === o.id, muted: !!currentMapSlot.value.leader && currentMapSlot.value.leader !== o.id })),
)
const selectedOption = computed(() => currentMapSlot.value?.options.find((o) => o.id === selected.value) || null)

// ── Confirm ──
const winners = computed(() =>
  slots.value.map((slot) => {
    // Most votes first; a tie goes to the better planner score, which is a penalty (lower is better).
    const sorted = [...slot.options].sort((a, b) => b.votes - a.votes || a.score - b.score)
    return { slot, option: sorted[0] }
  }),
)
async function confirm() {
  busy.value = true
  error.value = ''
  try {
    await events.confirm(props.id)
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
    <SessionHeader :session="session" back="/" />

    <div class="screen__body">
      <SessionNotices :session="session" />
      <BannerNote v-if="planner.conditions.rain && session.meeting" tone="warning" icon="rain">Rain expected</BannerNote>
      <BannerNote v-if="planError" tone="error" icon="warning" role="alert" data-testid="plan-error">
        {{ planError }}
        <template #actions>
          <AppButton small variant="secondary" :disabled="!!planner.loading[id]" @click="load">Try again</AppButton>
        </template>
      </BannerNote>

      <div v-if="!session.meeting || ['inviting', 'locating'].includes(session.status)" class="empty-wrap">
        <EmptyState title="No meeting area yet">
          <AppButton variant="secondary" :to="`/sessions/${id}`">People</AppButton>
        </EmptyState>
      </div>

      <template v-else>
        <!-- 6a: categories and timing -->
        <section v-if="voting" class="picks" aria-label="Your picks">
          <div class="picks__row" role="group" aria-label="Your categories">
            <ChipButton v-for="c in CATEGORIES" :key="c" :selected="myPrefs.categories.includes(c)" :style="{ '--chip-on': `var(--cat-${c}-fg)` }" @click="toggleCategory(c)">
              <template #leading><CategoryIcon :category="c" :size="28" /></template>
              {{ CATEGORY_LABELS[c] }}
            </ChipButton>
          </div>
          <div class="picks__stay">
            <span id="stay-label" class="caption text-muted">Stay until</span>
            <div class="scroll-x" role="radiogroup" aria-labelledby="stay-label">
              <ChipButton
                v-for="m in plan?.stayOptions || []"
                :key="m"
                radio
                :selected="(myPrefs.until ?? null) === stayValue(m)"
                @click="savePrefs({ until: stayValue(m) })"
              >
                {{ fromMinutes(m) }}
              </ChipButton>
            </div>
          </div>
        </section>

        <ProgressDonut compact title="Votes" :people="donutPeople" done-label="Voted" />
        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>

        <!-- 6b: vote on places -->
        <div v-if="voting && slots.length" class="radius">
          <span id="radius-label" class="caption text-muted">Search within</span>
          <div class="scroll-x" role="radiogroup" aria-labelledby="radius-label">
            <ChipButton v-for="m in RADII" :key="m ?? 'auto'" radio :selected="radius === m" :disabled="settingRadius" @click="setRadius(m)">{{ radiusLabel(m) }}</ChipButton>
          </div>
          <span class="caption-sm text-muted">{{ radius == null ? 'Auto starts at 500 m and looks further out until 3 places fit.' : `Only places within ${radiusLabel(radius)} of ${session.area.name}.` }}</span>
        </div>

        <SplitView v-model:view="view" label="Places">
          <template #list>
            <div v-if="loading" class="stack gap-md">
              <SkeletonRow v-for="n in 3" :key="n" avatar :lines="3" />
            </div>
            <EmptyState v-else-if="!slots.length && !planError" title="No slots yet" text="Pick a category to start." />
            <section v-for="(slot, si) in slots" v-else :key="slot.id" class="slot rise" :style="{ '--i': si }" :aria-labelledby="`slot-${slot.id}`">
              <header class="slot__head">
                <CategoryIcon :category="slot.category" :size="32" />
                <div class="slot__title">
                  <h2 :id="`slot-${slot.id}`" class="title-md">{{ timeAndDuration(slot.time, slot.duration) }}</h2>
                  <span class="caption-sm text-muted">{{ CATEGORY_LABELS[slot.category] }}</span>
                </div>
                <IconButton v-if="voting" :label="`Delete the ${CATEGORY_LABELS[slot.category]} slot`" @click="deleting = slot"><AppIcon name="trash" /></IconButton>
              </header>

              <EmptyState v-if="!slot.options.length" title="Nothing nearby for this slot" :text="emptyText(slot)">
                <AppButton v-if="voting && radius && slot.empty?.widenToKm && radiusFor(slot.empty.widenToKm)" variant="secondary" small :disabled="settingRadius" @click="setRadius(radiusFor(slot.empty.widenToKm))">Widen to {{ radiusLabel(radiusFor(slot.empty.widenToKm)) }}</AppButton>
                <AppButton v-if="voting" variant="secondary" small @click="deleting = slot">Delete slot</AppButton>
              </EmptyState>
              <template v-else>
                <p v-if="slot.totalVotes && leadText(slot)" class="lead-line" role="status"><AppIcon name="trophy" :size="14" /> {{ leadText(slot) }}</p>
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
                    @vote="vote(slot, $event)"
                    @swap="swap(slot, $event)"
                  />
                </div>
                <p v-if="voting && radius && slot.few" class="few-line">
                  <span class="caption-sm text-muted">Only {{ slot.few.found }} {{ slot.few.found === 1 ? 'place fits' : 'places fit' }} within {{ radiusLabel(radius) }}.</span>
                  <AppButton v-if="slot.few.widenToKm && radiusFor(slot.few.widenToKm)" variant="tertiary" underline small :disabled="settingRadius" @click="setRadius(radiusFor(slot.few.widenToKm))">Widen to {{ radiusLabel(radiusFor(slot.few.widenToKm)) }}</AppButton>
                </p>
                <div v-if="voting && slot.options.length < 6" class="slot__more">
                  <IconButton label="More suggestions" :disabled="!slot.canAddMore || loadingMore === slot.id" @click="more(slot)"><AppIcon name="plus" /></IconButton>
                  <IconButton label="Search a place" @click="openAdd(slot)"><AppIcon name="search" /></IconButton>
                </div>
              </template>
            </section>
            <AppButton v-if="voting && plan?.deletedSlots?.length" variant="tertiary" underline class="restore" @click="planner.restoreSlots(id)">Restore deleted slots</AppButton>
          </template>

          <template #map>
            <div class="map-tools">
              <div class="map-tools__slots" role="radiogroup" aria-label="Slot on the map">
                <ChipButton v-for="slot in slots" :key="slot.id" radio :selected="mapSlot === slot.id" :style="{ '--chip-on': `var(--cat-${slot.category}-fg)` }" @click="mapSlot = slot.id; selected = ''">
                  <template #leading><CategoryIcon :category="slot.category" :size="24" /></template>
                  {{ slot.time }}
                </ChipButton>
              </div>
            </div>
            <PlannerMap :area="session.area" :places="mapPlaces" :radius="radius || 0" :selected="selected" label="Places map" @select="selected = $event" />
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
                <InfoTag v-if="currentMapSlot.leader === selectedOption.id" tone="strong" icon="trophy">Leading</InfoTag>
              </div>
              <div class="row between">
                <span class="caption">{{ selectedOption.votes }} {{ selectedOption.votes === 1 ? 'vote' : 'votes' }}</span>
                <ChipButton v-if="voting" radio check :selected="currentMapSlot.myVote === selectedOption.id" @click="vote(currentMapSlot, selectedOption)">
                  {{ currentMapSlot.myVote === selectedOption.id ? 'Voted' : 'Vote' }}
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
      <AppButton block :to="`/sessions/${id}/itinerary`">Itinerary</AppButton>
    </footer>

    <ModalDialog :open="!!deleting" :title="deleting ? `Delete the ${CATEGORY_LABELS[deleting.category]} slot?` : ''" @update:open="(v) => !v && (deleting = null)">
      <AppButton block variant="secondary" @click="deleting = null">Keep</AppButton>
      <AppButton block variant="danger" @click="deleteSlot">Delete</AppButton>
    </ModalDialog>

    <ModalDialog v-model:open="confirmOpen" title="Confirm plan?">
      <template #content>
        <ul class="winners">
          <li v-for="w in winners" :key="w.slot.id" class="winners__row">
            <CategoryIcon :category="w.slot.category" :size="28" />
            <span class="stack">
              <span class="caption-sm text-muted">{{ w.slot.time }}</span>
              <span class="title-sm">{{ w.option?.venue.name || 'No place' }}</span>
            </span>
          </li>
        </ul>
      </template>
      <AppButton block :disabled="busy" @click="confirm">Confirm</AppButton>
      <AppButton block variant="secondary" @click="confirmOpen = false">Not yet</AppButton>
    </ModalDialog>

    <BottomSheet v-model:open="adding.open" :title="adding.slot ? `Add to ${adding.slot.time}` : 'Add a place'" tall>
      <TextField v-model="adding.query" label="Search places" hide-label placeholder="Search places" type="text" inputmode="search" autocomplete="off" />
      <p v-if="addSlotFull" class="body-sm text-error" role="alert">This slot already has 6 options.</p>
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
    </BottomSheet>
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
.picks { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.picks__row { display: flex; flex-wrap: wrap; gap: 0 var(--spacing-sm); }
.picks__stay { display: flex; align-items: center; gap: var(--spacing-md); min-width: 0; }
.picks__stay > .caption { flex-shrink: 0; white-space: nowrap; }
.picks__stay .scroll-x { flex: 1 1 auto; min-width: 0; }
.slot { display: flex; flex-direction: column; gap: var(--spacing-md); }
.slot + .slot { padding-top: var(--spacing-lg); }
.slot__head { display: flex; align-items: center; gap: var(--spacing-md); }
.slot__title { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
.slot__options { display: flex; flex-direction: column; gap: var(--spacing-md); }
.slot__more { display: flex; justify-content: center; gap: var(--spacing-md); }
.restore { align-self: flex-start; }
.empty-wrap { padding-top: var(--spacing-lg); }
.map-tools { position: absolute; top: var(--spacing-sm); left: 56px; right: var(--spacing-sm); z-index: 500; display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); pointer-events: none; }
.map-tools > * { pointer-events: auto; }
.map-tools__slots { display: flex; flex-wrap: wrap; gap: 0 var(--spacing-xs); }
.map-tools__slots :deep(.chip__pill) { box-shadow: var(--shadow-float); }
@media (min-width: 1128px) { .map-tools { right: 150px; } }
.pin-card { position: absolute; left: var(--spacing-sm); right: var(--spacing-sm); bottom: var(--spacing-xl); z-index: 600; display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-md) var(--spacing-md) var(--spacing-sm) var(--spacing-base); border-radius: var(--rounded-md); background: var(--canvas); box-shadow: var(--shadow-float); }
.radius { display: flex; flex-direction: column; gap: var(--spacing-xs); }
/* Who leads the slot: an ink pill, like the "Leading" tag on the card and the label on the map. */
.lead-line { display: inline-flex; align-items: center; gap: var(--spacing-xs); align-self: flex-start; margin: 0; padding: var(--spacing-xxs) var(--spacing-sm); border-radius: var(--rounded-full); background: var(--ink); color: var(--on-dark); font: var(--text-caption); }
.few-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); margin: 0; }
.pin-card__photo { flex-shrink: 0; width: 56px; height: 56px; object-fit: cover; border-radius: var(--rounded-sm); }
.pin-card__name { flex: 1 1 0; min-width: 0; }
.winners { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.winners__row { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: var(--spacing-md); }
.add-results { display: flex; flex-direction: column; }
.add-row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 64px; }
.add-row + .add-row { border-top: 1px solid var(--hairline-soft); }
.add-row__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
</style>
