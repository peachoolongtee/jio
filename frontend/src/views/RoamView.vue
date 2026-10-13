<script setup>
// "What next?": things to do near where the group is, for a plan that is under way. It is a list; nothing is voted on.
//   - It is centred on the meeting area ("Near Bishan"). "Use my location" asks the browser for a position only when it is
//     pressed, and the list is then centred on the person ("Near you, in Toa Payoh"). The position stays in this page's
//     memory for this list: it is never saved, put in the address or shown to the group, who would see the area's name at most.
//     If the browser refuses, has no position, or the person is outside Singapore, a sentence says so and the area picker
//     opens, so there is always a way forward.
//   - Chips narrow the list to one kind of place (All, Eat, Drink, Shop, Activity).
//   - Each place is the voting page's card (SuggestionCard) with how far it is, why it was chosen and a rain mark. Its foot
//     is "Propose" for anyone in the meetup; a place that is proposed says by whom ("Proposed by you" with "Take back",
//     or "Proposed by Faith"), a place already in the plan says "In the plan". The host adds a proposal to the plan on the
//     itinerary.
//   - Loading, empty ("Nothing nearby fits"), the planner being unreachable (with Retry) and "not open yet" each have their
//     own state. The page keeps the Itinerary step lit and its back arrow goes to the itinerary.
//   - Weather: the rain mark on a card follows the planner's weather state ("Outdoor, showers"), one muted line under the list
//     says where the forecast came from, and a simulated forecast adds a banner at the top (WeatherSource).
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import CategoryIcon from '@/components/ui/CategoryIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import InfoTag from '@/components/ui/InfoTag.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import LocationSheet from '@/components/group/LocationSheet.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import SessionNotices from '@/components/event/SessionNotices.vue'
import SuggestionCard from '@/components/event/SuggestionCard.vue'
import WeatherSource from '@/components/weather/WeatherSource.vue'
import NotFoundView from './NotFoundView.vue'
import * as api from '@/lib/api.js'
import { CATEGORY_LABELS } from '@/lib/planner/slots.js'
import { ROAM_CATEGORIES, ROAM_WORDS, centreLine, closedText, placeAction, placeState, proposeBlock, travelLine } from '@/lib/roam.js'
import { roamOpen, sessionPath } from '@/lib/session.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ id: { type: String, required: true } })

const auth = useAuthStore()
const events = useEventsStore()

const missing = ref(false)
// Where the list is centred: 'meeting' (the meeting area), 'here' (the person's own position) or 'area' (an area they picked).
const centre = ref({ mode: 'meeting', areaName: '' })
// The person's position, for the next requests only. It lives in this page and goes nowhere else.
const position = ref(null)
// '' is All; otherwise one category.
const kind = ref('')
const answer = ref(null)
const loading = ref(true)
const loadError = ref('')
const actionError = ref('')
const note = ref('')
const locating = ref(false)
const pickerOpen = ref(false)
const working = ref('')
let ticket = 0

const session = computed(() => events.byId[props.id])
const myId = computed(() => auth.myId)
const closed = computed(() => closedText(session.value))
const open = computed(() => !!session.value && roamOpen(session.value))
const meetingName = computed(() => session.value?.areaName || '')
const centreName = computed(() => (centre.value.mode === 'meeting' ? meetingName.value : centre.value.areaName))
const centreText = computed(() => centreLine(centre.value.mode, centreName.value))

// The places with the plan and the proposals as they are now, so a proposal made elsewhere shows without asking again.
const stopIds = computed(() => (session.value?.plan?.stops || []).map((s) => s.venueId))
const places = computed(() =>
  (answer.value?.places || []).map((place) => {
    const { state, proposal } = placeState(place.id, stopIds.value, session.value?.proposals || [])
    return { ...place, state, proposal: proposal && { id: proposal.id, by: proposal.by, byName: proposal.byName } }
  }),
)
const blocked = computed(() => {
  const waiting = session.value?.proposals || []
  return proposeBlock({ stops: stopIds.value.length, mine: waiting.filter((p) => p.by === myId.value).length, total: waiting.length })
})
const announcement = computed(() => {
  if (loading.value) return `Finding places near ${centreName.value}`
  if (loadError.value) return ''
  return `${places.value.length} ${places.value.length === 1 ? 'place' : 'places'} near ${centreName.value}`
})

// Ask for the places for the centre and kind now chosen. Only the newest request puts its answer in.
// How to call: await load()
async function load() {
  const mine = ++ticket
  loading.value = true
  loadError.value = ''
  actionError.value = ''
  try {
    const result = await api.roamNearby(props.id, {
      point: centre.value.mode === 'meeting' ? undefined : position.value,
      categories: kind.value ? [kind.value] : ROAM_CATEGORIES,
    })
    if (mine !== ticket) return
    answer.value = result
  } catch (e) {
    if (mine !== ticket) return
    answer.value = null
    loadError.value = e.message
  } finally {
    if (mine === ticket) loading.value = false
  }
}

async function start() {
  missing.value = false
  try {
    await events.loadSession(props.id)
  } catch {
    missing.value = true
    return
  }
  if (open.value) await load()
  else loading.value = false
}
onMounted(start)
watch(() => props.id, () => {
  centre.value = { mode: 'meeting', areaName: '' }
  position.value = null
  kind.value = ''
  answer.value = null
  start()
})
// The plan can stop being under way while the page is open (the outing is finished or called off).
watch(open, (now, was) => {
  if (was && !now) {
    ticket += 1
    loading.value = false
  }
})

function pickKind(next) {
  if (kind.value === next) return
  kind.value = next
  load()
}

// The browser is asked for a position here and nowhere else, and only because the button was pressed.
// How to call: useMyLocation()
function useMyLocation() {
  if (locating.value) return
  note.value = ''
  if (!navigator.geolocation) return fallBack(ROAM_WORDS.unsupported)
  locating.value = true
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const place = await api.placeFromCoords(pos.coords.latitude, pos.coords.longitude)
        if (!place) return fallBack(ROAM_WORDS.outside)
        position.value = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        centre.value = { mode: 'here', areaName: place.sub }
        locating.value = false
        await load()
      } finally {
        locating.value = false
      }
    },
    (err) => fallBack(err?.code === 1 ? ROAM_WORDS.refused : ROAM_WORDS.unavailable),
    { timeout: 10000 },
  )
}

// Say why the position cannot be used and offer the areas instead.
// How to call: fallBack('Location access is off.')
function fallBack(text) {
  locating.value = false
  note.value = `${text} ${ROAM_WORDS.pick} instead.`
  pickerOpen.value = true
}

// An area picked in the sheet becomes the centre, at the area's own point.
// How to call: await pickArea({ areaId: 'bishan' })
async function pickArea(place) {
  if (!place?.areaId) return
  const area = (await api.listAreas()).find((a) => a.id === place.areaId)
  if (!area) return
  note.value = ''
  position.value = { lat: area.lat, lng: area.lng }
  centre.value = { mode: 'area', areaName: area.name }
  await load()
}

function backToMeeting() {
  note.value = ''
  position.value = null
  centre.value = { mode: 'meeting', areaName: '' }
  load()
}

// Propose a place, or take a proposal back. The button keeps focus: it is the same button with another word.
// How to call: await act(place, action)
async function act(place, action) {
  if (working.value) return
  working.value = place.id
  actionError.value = ''
  try {
    if (action.kind === 'free') await events.proposeMyStop(props.id, place.id)
    else await events.resolveProposal(props.id, place.proposal.id, false)
    await nextTick()
  } catch (e) {
    actionError.value = e.message
  } finally {
    working.value = ''
  }
}

const actionFor = (place) => placeAction(place, { myId: myId.value, blocked: blocked.value })
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else-if="session" class="screen" data-testid="roam-view">
    <SessionHeader :session="session" title="What next?" />

    <div class="screen__body">
      <SessionNotices :session="session" />
      <WeatherSource v-if="!closed && answer?.weather" :block="answer.weather" banner />

      <EmptyState v-if="closed" :title="closed" data-testid="roam-closed">
        <AppButton variant="secondary" :to="sessionPath(session)">Back to the session</AppButton>
      </EmptyState>

      <template v-else>
        <section class="where" aria-label="Where to look">
          <p class="title-md where__line" data-testid="roam-centre">{{ centreText }}</p>
          <div class="where__actions">
            <AppButton small variant="secondary" :aria-busy="locating ? 'true' : undefined" @click="useMyLocation">
              <AppIcon name="locate" />
              {{ locating ? ROAM_WORDS.finding : ROAM_WORDS.here }}
            </AppButton>
            <AppButton v-if="centre.mode !== 'meeting'" small variant="tertiary" @click="backToMeeting">{{ ROAM_WORDS.back(meetingName) }}</AppButton>
          </div>
          <p v-if="note" class="body-sm text-muted" role="status" data-testid="roam-note">{{ note }}</p>
          <p v-if="centre.mode === 'here'" class="caption-sm text-muted where__privacy"><AppIcon name="lock" :size="12" /> The group sees the area's name, never where you are.</p>
        </section>

        <div class="filter scroll-x" role="radiogroup" aria-label="Kind of place">
          <ChipButton radio :selected="!kind" @click="pickKind('')">All</ChipButton>
          <ChipButton v-for="c in ROAM_CATEGORIES" :key="c" radio :selected="kind === c" @click="pickKind(c)">
            <template #leading><CategoryIcon :category="c" :size="24" /></template>
            {{ CATEGORY_LABELS[c] }}
          </ChipButton>
        </div>

        <p class="sr-only" role="status">{{ announcement }}</p>
        <p v-if="actionError" class="body-sm text-error" role="alert" data-testid="roam-error">{{ actionError }}</p>
        <p v-if="blocked && !loading && !loadError" id="roam-blocked" class="body-sm text-muted" data-testid="roam-blocked">{{ blocked }}</p>

        <div v-if="loading" class="grid-3" aria-hidden="true" data-testid="roam-loading">
          <SkeletonRow v-for="n in 3" :key="n" avatar :lines="3" />
        </div>
        <EmptyState v-else-if="loadError" title="Could not load places" :text="loadError" role="alert" data-testid="roam-failed">
          <AppButton variant="secondary" @click="load">Retry</AppButton>
        </EmptyState>
        <EmptyState v-else-if="!places.length" :title="ROAM_WORDS.empty" :text="ROAM_WORDS.emptyText" data-testid="roam-empty">
          <AppButton v-if="kind" variant="secondary" @click="pickKind('')">Show all kinds</AppButton>
        </EmptyState>
        <ul v-else class="grid-3 places" :aria-label="`Places ${centreText.toLowerCase()}`" data-testid="roam-list">
          <li v-for="place in places" :key="place.id" class="places__item" :data-place="place.id">
            <SuggestionCard :option="place" :meta="travelLine(place)">
              <template #foot>
                <InfoTag v-if="actionFor(place).tag" tone="strong" :icon="actionFor(place).icon">{{ actionFor(place).tag }}</InfoTag>
                <span v-else />
                <AppButton
                  v-if="actionFor(place).button"
                  small
                  :variant="actionFor(place).kind === 'free' ? 'secondary' : 'tertiary'"
                  :disabled="actionFor(place).disabled"
                  :aria-busy="working === place.id ? 'true' : undefined"
                  :aria-label="actionFor(place).label"
                  :aria-describedby="actionFor(place).disabled ? 'roam-blocked' : undefined"
                  @click="act(place, actionFor(place))"
                >
                  {{ actionFor(place).button }}
                </AppButton>
              </template>
            </SuggestionCard>
          </li>
        </ul>
        <WeatherSource v-if="!loading && !loadError && answer?.weather" :block="answer.weather" />
      </template>
    </div>

    <LocationSheet v-model:open="pickerOpen" which="spot" :title="ROAM_WORDS.pick" @select="pickArea" />
  </main>
  <main v-else class="screen" data-testid="roam-view">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <SkeletonRow v-for="n in 4" :key="n" avatar />
    </div>
  </main>
</template>

<style scoped>
.where { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-sm); }
.where__line { overflow-wrap: anywhere; }
.where__actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); }
.where__privacy { display: flex; align-items: center; gap: var(--spacing-xs); }
/* The filter: one row of chips, scrolling sideways on a phone, as on the voting page. */
.filter { display: flex; gap: var(--spacing-sm); }
.places { list-style: none; margin: 0; padding: 0; }
.places__item { display: flex; min-width: 0; }
.places__item > :deep(.sugg) { flex: 1 1 auto; min-width: 0; }
</style>
