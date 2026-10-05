<script setup>
// Step 6: choose what to do (diverge).
//   6a  Each person picks categories and how long they can stay. Jio turns the most picked categories
//       into ordered time slots inside the session window. Ian can delete a slot.
//   6b  For each slot, 3 suggested places near the meeting area. Anyone can add more (up to 6).
//       One vote per person per slot; a second tap changes it. The leader is highlighted.
//   Step 7  "Confirm plan" once at least 2 people have voted.
// The list and the map show the same suggestions; the map has a crowd heat layer.
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
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import SessionNotices from '@/components/event/SessionNotices.vue'
import SuggestionCard from '@/components/event/SuggestionCard.vue'
import PlannerMap from '@/components/map/PlannerMap.vue'
import NotFoundView from './NotFoundView.vue'
import { CATEGORIES, CATEGORY_LABELS } from '@/lib/planner/slots.js'
import { durationLabel, fromMinutes, timeAndDuration } from '@/lib/planner/format.js'
import { crowdText } from '@/lib/planner/crowd.js'
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
const mapSlot = ref('')
const selected = ref('')
const showHeat = ref(true)
const deleting = ref(null)
const confirmOpen = ref(false)
const busy = ref(false)
const adding = ref({ open: false, slot: null, query: '', results: [] })
const loadingMore = ref('')

async function load() {
  missing.value = false
  try {
    await Promise.all([events.loadSession(props.id), groups.loadPeople(), planner.loadConditions()])
    await planner.loadPlan(props.id)
  } catch {
    missing.value = true
  }
}
onMounted(load)
watch(() => props.id, load)

const session = computed(() => events.byId[props.id])
const plan = computed(() => planner.plans[props.id])
const loading = computed(() => planner.loading[props.id] && !plan.value?.slots?.length)
const voting = computed(() => session.value?.status === 'voting')
const nameOf = (id) => (id === 'ian' ? auth.user.name : groups.nameOf(id))
const active = computed(() => session.value?.activeIds || [])
const myPrefs = computed(() => plan.value?.prefs?.ian || { categories: [], until: null })
const slots = computed(() => plan.value?.slots || [])
const voterIds = computed(() => plan.value?.voters || [])
const canConfirm = computed(() => voterIds.value.length >= 2 && slots.value.length > 0)

watch(slots, (list) => {
  if (!list.find((s) => s.id === mapSlot.value)) mapSlot.value = list[0]?.id || ''
})

const donutPeople = computed(() => active.value.map((id) => ({ name: nameOf(id), done: voterIds.value.includes(id) })))
const counts = computed(() => plan.value?.counts || {})
const responders = computed(() => active.value.filter((id) => plan.value?.prefs?.[id]?.categories?.length).length)

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
const windowEnd = computed(() => session.value?.end)
function setStay(minutes) {
  savePrefs({ until: minutes })
}

async function deleteSlot() {
  const slot = deleting.value
  deleting.value = null
  await planner.deleteSlot(props.id, slot.id)
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
  await planner.addMore(props.id, slot.id)
  loadingMore.value = ''
}

async function swap(slot, option) {
  await planner.swapOption(props.id, slot.id, option.id, option.swap.id)
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
  const time = slot.time
  if (result.unfit === 'category') return `${CATEGORY_LABELS[result.category]}, not ${CATEGORY_LABELS[slot.category]}`
  if (result.unfit === 'far') return `Too far from ${session.value.area.name}`
  if (result.unfit === 'closed') return `Closed during ${time} slot`
  if (result.unfit === 'meal') return `Not open for ${MEAL_WINDOWS.find((w) => w.id === mealWindow(slot.start)).label.toLowerCase()}`
  if (result.unfit === 'mrt') return 'Over 10 min walk from MRT'
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

// ── Map ──
const currentMapSlot = computed(() => slots.value.find((s) => s.id === mapSlot.value) || slots.value[0])
const mapPlaces = computed(() =>
  (currentMapSlot.value?.options || []).map((o) => ({ id: o.id, name: o.venue.name, lat: o.venue.lat, lng: o.venue.lng, category: o.venue.category, highlight: currentMapSlot.value.leader === o.id })),
)
const heatPoints = computed(() => (currentMapSlot.value?.options || []).map((o) => ({ lat: o.venue.lat, lng: o.venue.lng, level: o.crowd })))
const selectedOption = computed(() => currentMapSlot.value?.options.find((o) => o.id === selected.value) || null)
function selectPin(id) {
  selected.value = id
}

// ── Confirm ──
const winners = computed(() =>
  slots.value.map((slot) => {
    const sorted = [...slot.options].sort((a, b) => b.votes - a.votes || b.score - a.score)
    return { slot, option: sorted[0] }
  }),
)
async function confirm() {
  busy.value = true
  error.value = ''
  try {
    await events.confirm(props.id)
    confirmOpen.value = false
    router.push(`/sessions/${props.id}/itinerary`)
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
      <BannerNote v-if="planner.conditions.rain" tone="warning" icon="rain">Rain expected · outdoor places ranked lower</BannerNote>

      <EmptyState v-if="!session.meeting || ['inviting', 'locating'].includes(session.status)" title="No meeting area yet" text="Activities open once the meeting area is set.">
        <AppButton variant="secondary" :to="`/sessions/${id}`">People and area</AppButton>
      </EmptyState>

      <template v-else>
        <!-- 6a: categories and timing -->
        <div class="overview">
          <section class="card" aria-labelledby="picks-head">
            <h2 id="picks-head" class="title-md">Your picks</h2>
            <div class="stack gap-xs">
              <span id="cat-label" class="caption text-muted">Categories</span>
              <div class="chip-row" role="group" aria-labelledby="cat-label">
                <ChipButton v-for="c in CATEGORIES" :key="c" check :selected="myPrefs.categories.includes(c)" :disabled="!voting" @click="toggleCategory(c)">
                  <template #leading><CategoryIcon :category="c" :size="28" /></template>
                  {{ CATEGORY_LABELS[c] }}
                </ChipButton>
              </div>
            </div>
            <div class="stack gap-xs">
              <span id="stay-label" class="caption text-muted">You can stay until</span>
              <div class="chip-row" role="radiogroup" aria-labelledby="stay-label">
                <ChipButton
                  v-for="m in plan?.stayOptions || []"
                  :key="m"
                  radio
                  :selected="(myPrefs.until ?? null) === (fromMinutes(m) === windowEnd ? null : m) "
                  :disabled="!voting"
                  @click="setStay(fromMinutes(m) === windowEnd ? null : m)"
                >
                  {{ fromMinutes(m) }}
                </ChipButton>
              </div>
            </div>
          </section>

          <section class="card">
            <ProgressDonut title="Votes" :people="donutPeople" done-label="Voted" todo-label="Not yet" />
          </section>
        </div>

        <section class="section" aria-labelledby="slots-head">
          <div class="section__head">
            <h2 id="slots-head" class="display-sm">Slots</h2>
            <span v-if="plan?.stayUntil != null && slots.length" class="caption text-muted">Group can stay until {{ fromMinutes(plan.stayUntil) }}</span>
          </div>
          <div class="cat-counts" aria-label="Category picks">
            <span v-for="c in CATEGORIES" :key="c" class="cat-count">
              <CategoryIcon :category="c" :size="24" />
              <span class="caption">{{ CATEGORY_LABELS[c] }} {{ counts[c] || 0 }}</span>
            </span>
            <span class="caption-sm text-muted">{{ responders }} of {{ active.length }} picked</span>
          </div>
          <SkeletonRow v-if="loading" />
          <EmptyState v-else-if="!slots.length" title="No slots yet" text="Slots appear once people pick categories." />
          <ol v-else class="slots">
            <li v-for="slot in slots" :key="slot.id" class="slot-row">
              <CategoryIcon :category="slot.category" :size="32" />
              <span class="slot-row__text">
                <span class="title-sm">{{ timeAndDuration(slot.time, slot.duration) }}</span>
                <span class="caption-sm text-muted">{{ CATEGORY_LABELS[slot.category] }} · {{ slot.picks }} {{ slot.picks === 1 ? 'pick' : 'picks' }}</span>
              </span>
              <IconButton v-if="voting" outline :label="`Delete the ${CATEGORY_LABELS[slot.category]} slot`" @click="deleting = slot"><AppIcon name="trash" /></IconButton>
            </li>
          </ol>
          <AppButton v-if="voting && plan?.deletedSlots?.length" variant="tertiary" underline class="slots__restore" @click="planner.restoreSlots(id)">
            Restore deleted slots ({{ plan.deletedSlots.map((c) => CATEGORY_LABELS[c]).join(', ') }})
          </AppButton>
        </section>

        <!-- 6b: vote on places -->
        <section v-if="slots.length || loading" class="section" aria-labelledby="vote-head">
          <h2 id="vote-head" class="display-sm">{{ voting ? 'Vote on places' : 'Places' }}</h2>
          <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
          <SplitView v-model:view="view" label="Suggestions">
            <template #list>
              <div v-if="loading" class="stack gap-md">
                <SkeletonRow v-for="n in 3" :key="n" avatar :lines="3" />
              </div>
              <section v-for="slot in slots" v-else :key="slot.id" class="vote-slot" :aria-labelledby="`slot-${slot.id}`">
                <header class="vote-slot__head">
                  <CategoryIcon :category="slot.category" :size="32" />
                  <div class="stack">
                    <h3 :id="`slot-${slot.id}`" class="title-md">{{ timeAndDuration(slot.time, slot.duration) }}</h3>
                    <span class="caption-sm text-muted">
                      {{ CATEGORY_LABELS[slot.category] }} · {{ slot.totalVotes }} {{ slot.totalVotes === 1 ? 'vote' : 'votes' }}<template v-if="slot.isLast"> · Near MRT for the trip home</template>
                    </span>
                  </div>
                </header>

                <EmptyState v-if="!slot.options.length" title="Nothing nearby for this slot" text="Jio searched further out once and found no place that is open and fits this time.">
                  <AppButton v-if="voting" variant="secondary" @click="deleting = slot">Delete slot</AppButton>
                </EmptyState>
                <template v-else>
                  <p v-if="!slot.totalVotes" class="caption-sm text-muted">No votes yet</p>
                  <div class="vote-slot__options" role="radiogroup" :aria-labelledby="`slot-${slot.id}`">
                    <SuggestionCard
                      v-for="option in slot.options"
                      :key="option.id"
                      :option="option"
                      :total="slot.totalVotes"
                      :leading="slot.leader === option.id"
                      :mine="slot.myVote === option.id"
                      :closed="!voting"
                      :selected="selected === option.id"
                      @vote="vote(slot, $event)"
                      @swap="swap(slot, $event)"
                    />
                  </div>
                  <div v-if="voting" class="vote-slot__more">
                    <AppButton variant="secondary" small :disabled="!slot.canAddMore || loadingMore === slot.id" @click="more(slot)">
                      <AppIcon name="plus" />
                      {{ loadingMore === slot.id ? 'Finding places' : 'More suggestions' }}
                    </AppButton>
                    <AppButton variant="secondary" small :disabled="slot.options.length >= 6" @click="openAdd(slot)">
                      <AppIcon name="search" />
                      Search a place
                    </AppButton>
                    <span class="caption-sm text-muted">{{ slot.options.length }} of 6</span>
                  </div>
                </template>
              </section>
            </template>

            <template #map>
              <div class="map-tools">
                <div class="map-tools__slots" role="radiogroup" aria-label="Slot on the map">
                  <ChipButton v-for="slot in slots" :key="slot.id" radio :selected="mapSlot === slot.id" @click="mapSlot = slot.id; selected = ''">
                    <template #leading><CategoryIcon :category="slot.category" :size="24" /></template>
                    {{ slot.time }}
                  </ChipButton>
                </div>
                <ToggleSwitch v-model="showHeat" label="Crowd heat map" class="map-tools__heat" />
              </div>
              <PlannerMap
                :area="session.area"
                :places="mapPlaces"
                :heat="showHeat"
                :heat-points="heatPoints"
                :selected="selected"
                label="Suggestions map"
                @select="selectPin"
              />
              <div v-if="selectedOption" class="pin-card" role="dialog" :aria-label="selectedOption.venue.name">
                <div class="row between gap-sm">
                  <span class="title-md clamp-2">{{ selectedOption.venue.name }}</span>
                  <IconButton label="Close" @click="selected = ''"><AppIcon name="close" :size="14" /></IconButton>
                </div>
                <div class="row gap-sm wrap">
                  <CategoryIcon :category="selectedOption.venue.category" :size="24" />
                  <span class="caption-sm">{{ selectedOption.walk }} min walk</span>
                  <PriceTier :price="selectedOption.venue.price" />
                  <InfoTag>{{ crowdText(selectedOption.crowd) }}</InfoTag>
                </div>
                <div class="row between">
                  <span class="caption">{{ selectedOption.votes }} {{ selectedOption.votes === 1 ? 'vote' : 'votes' }}</span>
                  <ChipButton v-if="voting" radio check :selected="currentMapSlot.myVote === selectedOption.id" @click="vote(currentMapSlot, selectedOption)">
                    {{ currentMapSlot.myVote === selectedOption.id ? 'Your vote' : 'Vote' }}
                  </ChipButton>
                </div>
              </div>
              <div v-if="showHeat" class="heat-key" aria-label="Crowd, estimated">
                <span class="heat-key__item"><span class="heat-key__dot heat-key__dot--quiet" />Quiet</span>
                <span class="heat-key__item"><span class="heat-key__dot heat-key__dot--moderate" />Moderate</span>
                <span class="heat-key__item"><span class="heat-key__dot heat-key__dot--busy" />Busy</span>
                <span class="caption-sm text-muted">est.</span>
              </div>
            </template>
          </SplitView>
        </section>
      </template>
    </div>

    <footer v-if="voting && session.meeting" class="screen__footer">
      <AppButton block :disabled="!canConfirm" @click="confirmOpen = true">
        {{ canConfirm ? 'Confirm plan' : `Confirm plan · ${voterIds.length} of 2 voters` }}
      </AppButton>
    </footer>
    <footer v-else-if="['confirmed', 'completed'].includes(session.status)" class="screen__footer">
      <AppButton block :to="`/sessions/${id}/itinerary`">View itinerary</AppButton>
    </footer>

    <ModalDialog :open="!!deleting" :title="deleting ? `Delete the ${CATEGORY_LABELS[deleting.category]} slot?` : ''" @update:open="(v) => !v && (deleting = null)">
      <AppButton block variant="secondary" @click="deleting = null">Keep slot</AppButton>
      <AppButton block variant="danger" @click="deleteSlot">Delete slot</AppButton>
    </ModalDialog>

    <ModalDialog v-model:open="confirmOpen" title="Confirm plan?">
      <template #content>
        <ul class="winners">
          <li v-for="w in winners" :key="w.slot.id" class="winners__row">
            <CategoryIcon :category="w.slot.category" :size="28" />
            <span class="stack">
              <span class="caption-sm text-muted">{{ timeAndDuration(w.slot.time, w.slot.duration) }}</span>
              <span class="title-sm">{{ w.option?.venue.name || 'No place' }}</span>
            </span>
            <span class="caption-sm text-muted">{{ w.option?.votes || 0 }} votes</span>
          </li>
        </ul>
      </template>
      <AppButton block :disabled="busy" @click="confirm">Confirm plan</AppButton>
      <AppButton block variant="secondary" @click="confirmOpen = false">Not yet</AppButton>
    </ModalDialog>

    <BottomSheet v-model:open="adding.open" :title="adding.slot ? `Add a place · ${adding.slot.time} ${CATEGORY_LABELS[adding.slot.category]}` : 'Add a place'" tall>
      <TextField v-model="adding.query" label="Place name or area" hide-label placeholder="Search a place or area" type="text" inputmode="search" autocomplete="off" />
      <p v-if="addSlotFull" class="body-sm text-error" role="alert">This slot already has 6 options.</p>
      <ul v-if="adding.results.length" class="add-results">
        <li v-for="r in adding.results" :key="r.id" class="add-row">
          <CategoryIcon :category="r.category" :size="32" />
          <span class="add-row__text">
            <span class="title-sm truncate">{{ r.name }}</span>
            <span class="caption-sm text-muted truncate">{{ r.area }} · {{ r.walk }} min walk</span>
            <span v-if="r.unfit" class="caption-sm text-error">{{ unfitText(r, adding.slot) }}</span>
          </span>
          <InfoTag v-if="r.added" tone="lagoon">Added</InfoTag>
          <AppButton v-else variant="secondary" small :disabled="!!r.unfit || addSlotFull" :aria-label="`Add ${r.name}`" @click="add(r)">Add</AppButton>
        </li>
      </ul>
      <p v-else-if="adding.query.trim()" class="body-sm text-muted">No places match "{{ adding.query.trim() }}".</p>
    </BottomSheet>
  </main>
  <main v-else class="screen" data-testid="planner-view">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <SkeletonRow v-for="n in 4" :key="n" avatar />
    </div>
  </main>
</template>

<style scoped>
.overview { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--spacing-base); }
@media (min-width: 1128px) { .overview { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); } }
.cat-counts { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm) var(--spacing-base); }
.cat-count { display: inline-flex; align-items: center; gap: var(--spacing-xs); }
.slots { display: flex; flex-direction: column; }
.slot-row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 60px; border-bottom: 1px solid var(--hairline-soft); }
.slot-row__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
.slots__restore { align-self: flex-start; }
.vote-slot { display: flex; flex-direction: column; gap: var(--spacing-md); padding-bottom: var(--spacing-lg); border-bottom: 1px solid var(--hairline); }
.vote-slot__head { display: flex; align-items: center; gap: var(--spacing-md); }
.vote-slot__options { display: flex; flex-direction: column; gap: var(--spacing-md); }
.vote-slot__more { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); }
.map-tools { position: absolute; top: var(--spacing-sm); left: 56px; right: var(--spacing-sm); z-index: 500; display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); pointer-events: none; }
.map-tools > * { pointer-events: auto; }
.map-tools__slots { display: flex; flex-wrap: wrap; gap: 0 var(--spacing-xs); }
.map-tools__slots :deep(.chip__pill) { box-shadow: var(--shadow-float); }
.map-tools__heat { padding: 0 var(--spacing-sm); border-radius: var(--rounded-full); background: var(--canvas); box-shadow: var(--shadow-float); }
@media (min-width: 1128px) { .map-tools { right: 150px; } }
.pin-card { position: absolute; left: var(--spacing-sm); right: var(--spacing-sm); bottom: var(--spacing-xl); z-index: 600; display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-md) var(--spacing-md) var(--spacing-sm) var(--spacing-base); border-radius: var(--rounded-md); background: var(--canvas); box-shadow: var(--shadow-float); }
.heat-key { position: absolute; left: var(--spacing-sm); bottom: var(--spacing-xl); z-index: 500; display: flex; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--rounded-full); background: var(--canvas); box-shadow: var(--shadow-float); font: var(--text-caption-sm); }
.pin-card ~ .heat-key { display: none; }
.heat-key__item { display: inline-flex; align-items: center; gap: var(--spacing-xs); }
.heat-key__dot { width: 10px; height: 10px; border-radius: var(--rounded-full); }
.heat-key__dot--quiet { background: var(--crowd-quiet); }
.heat-key__dot--moderate { background: var(--crowd-moderate); }
.heat-key__dot--busy { background: var(--crowd-busy); }
.winners { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.winners__row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-md); }
.add-results { display: flex; flex-direction: column; }
.add-row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 64px; border-bottom: 1px solid var(--hairline-soft); }
.add-row__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
</style>
