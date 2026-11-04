<script setup>
// "What next?" itself: things to do near where the group is, for a plan that is under way. It is a list beside a map; nothing is
// voted on. The Roam page (views/RoamView.vue) shows it under its header, and the itinerary of a plan with no stops yet (a light
// meetup from Home's "Already out?") shows it in place of the empty timeline, so there is one page and not two.
//   <RoamPanel :session="session" />
//   <RoamPanel :session="session" proposals-above />   (the proposed stops are drawn just above it)
//   - It is centred on the meeting area ("Near Bishan"). "Use my location" asks the browser for a position only when it is
//     pressed, and the list is then centred on the person ("Near you, in Toa Payoh"). The position stays in this panel's
//     memory for this list: it is never saved, put in the address or shown to the group, who would see the area's name at most.
//     If the browser refuses, has no position, or the person is outside Singapore, a sentence says so and the area picker
//     opens, so there is always a way forward.
//   - A card's name, photo or review line opens the place's detail (the Vote page's), with no planner request.
//   - Chips narrow the list to one kind of place (All, Eat, Drink, Shop, Activity).
//   - Each place is the voting page's card (SuggestionCard) with how far it is, why it was chosen and a rain mark. Its foot
//     is a + to propose it, for anyone in the meetup; a place that is proposed says by whom ("Proposed by you" with a
//     cross to take it back, or "Proposed by Faith"), a place already in the plan says "In the plan". The + and the cross
//     carry their words for screen readers only. The host adds a proposal to the plan on the itinerary. Just after a +, one
//     visible line under the card says what happens next ("Proposed. Add it to the plan above", with a button that moves focus to
//     the proposal for the host; "Proposed. Faith decides" for a guest).
//   - The map beside the list (List / Map on a phone, as on the Vote page) shows the places as category dots around the centre.
//     Pressing a dot opens a small card of the place with the same + or cross, so a place can be proposed from the map.
//   - Loading, empty ("Nothing nearby fits"), the planner being unreachable (with Retry) and "not open yet" each have their
//     own state.
//   - Weather: the rain mark on a card follows the planner's weather state ("Outdoor, showers"), one muted line under the list
//     says where the forecast came from, and a simulated forecast adds a banner at the top (WeatherSource).
//   - Dietary needs work as on the Vote page (ticket #107): while the list holds food, one line says which needs the places
//     fit, with no names; when fewer than 3 food places fit, a line offers "Show places we couldn't confirm", each then
//     labelled on its card. That choice is this person's own, for this panel only.
//   - Places from Google are never shown here, in the list or on the map: Google's terms do not allow them beside a OneMap map.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import CategoryIcon from '@/components/ui/CategoryIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import InfoTag from '@/components/ui/InfoTag.vue'
import MarkButton from '@/components/ui/MarkButton.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import SplitView from '@/components/ui/SplitView.vue'
import LocationSheet from '@/components/group/LocationSheet.vue'
import PlaceDetail from '@/components/event/PlaceDetail.vue'
import SuggestionCard from '@/components/event/SuggestionCard.vue'
import CategoryKey from '@/components/map/CategoryKey.vue'
import PlannerMap from '@/components/map/PlannerMap.vue'
import WeatherSource from '@/components/weather/WeatherSource.vue'
import * as api from '@/lib/api.js'
import { CATEGORY_LABELS } from '@/lib/planner/slots.js'
import { placeImage } from '@/lib/placeImages.js'
import { ROAM_CATEGORIES, ROAM_WORDS, centreLine, closedText, memberBlock, placeAction, placeState, proposeBlock, proposedResult, travelLine } from '@/lib/roam.js'
import { roamOpen, sessionPath } from '@/lib/session.js'
import { usePlaceDetail } from '@/lib/usePlaceDetail.js'
import { fewLine, fitLine } from '@/lib/dietText.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { vRadioGroup } from '@/lib/radioGroup.js'

const props = defineProps({
  session: { type: Object, required: true },
  // Whether the proposed stops are drawn above this panel on the same page (the itinerary), so a host who has just proposed a place
  // can be led to the row where it is added to the plan. On the Roam page they are on the next page, and the card says so.
  proposalsAbove: { type: Boolean, default: false },
})

// Is this place one that Google supplied? The planner adds Google places to a Roam answer when it has a Google key (their ids start with
// `google_` and the venue says `source: 'google'`). Google's terms do not allow them on or beside a OneMap map, and this panel draws a
// OneMap map beside its list, so they are left out of both until the lead decides otherwise (see CLAUDE.md).
// How to call: isGooglePlace({ id: 'google_ChIJ123', venue: { source: 'google' } }) -> true
function isGooglePlace(place) {
  return String(place?.id ?? '').startsWith('google_') || place?.venue?.source === 'google'
}

const auth = useAuthStore()
const events = useEventsStore()

// Where the list is centred: 'meeting' (the meeting area), 'here' (the person's own position) or 'area' (an area they picked).
const centre = ref({ mode: 'meeting', areaName: '' })
// The person's position, for the next requests only. It lives in this panel and goes nowhere else.
const position = ref(null)
// '' is All; otherwise one category.
const kind = ref('')
// Whether the food places we could not confirm for the group's dietary needs are shown too. This panel only.
const unconfirmed = ref(false)
const answer = ref(null)
const loading = ref(true)
const loadError = ref('')
const actionError = ref('')
const note = ref('')
const locating = ref(false)
const pickerOpen = ref(false)
const working = ref('')
// List or Map, on a phone; and the place whose dot was pressed on the map.
const view = ref('list')
const selected = ref('')
// What a press of the tick or the cross did, for a screen reader (the list's own announcement is separate).
const said = ref('')
// What a press left on the page, for a line under that place's card: { placeId, expects ('proposed' or 'free', the state the place must
// still be in for the line to be true), text, go (see proposedResult) }. It goes when the place moves on (added to the plan, say).
const result = ref(null)
let ticket = 0

const session = computed(() => props.session)
const myId = computed(() => auth.myId)
const closed = computed(() => closedText(session.value))
const open = computed(() => roamOpen(session.value))
const meetingName = computed(() => session.value?.areaName || '')
const centreName = computed(() => (centre.value.mode === 'meeting' ? meetingName.value : centre.value.areaName))
const centreText = computed(() => centreLine(centre.value.mode, centreName.value))

// A card's name, photo or review line opens the place's detail over this panel, the same one the Vote page opens
// (lib/usePlaceDetail.js): no planner request, focus back on the control that opened it, the meetup's people first in the reviews.
const { detail, outing, open: openPlace, close: closePlace, reset: resetPlace } = usePlaceDetail(() => session.value)
// Where the detail measures its distance from: the person ("you") when the list is centred on their position, else the area's name.
const detailFrom = computed(() => (centre.value.mode === 'here' ? 'you' : centreName.value))

// The places with the plan and the proposals as they are now, so a proposal made elsewhere shows without asking again.
const stopIds = computed(() => (session.value?.plan?.stops || []).map((s) => s.venueId))
const places = computed(() =>
  (answer.value?.places || []).filter((place) => !isGooglePlace(place)).map((place) => {
    const { state, proposal } = placeState(place.id, stopIds.value, session.value?.proposals || [])
    return { ...place, state, proposal: proposal && { id: proposal.id, by: proposal.by, byName: proposal.byName } }
  }),
)
// Why the tick is off, said in words on the page: the person is not in the meetup (or opted out of it), or the limits are reached.
const blocked = computed(() => {
  const outside = memberBlock(session.value, myId.value)
  if (outside) return outside
  const waiting = session.value?.proposals || []
  return proposeBlock({ stops: stopIds.value.length, mine: waiting.filter((p) => p.by === myId.value).length, total: waiting.length })
})
const announcement = computed(() => {
  if (loading.value) return `Finding places near ${centreName.value}`
  if (loadError.value) return ''
  return `${places.value.length} ${places.value.length === 1 ? 'place' : 'places'} near ${centreName.value}`
})

// The map: the centre of the list as its pin (the person's own position is shown as the area's name only), and every place as a dot.
const mapCentre = computed(() => {
  if (centre.value.mode !== 'meeting' && position.value) return { name: centreName.value, ...position.value }
  const area = session.value?.area
  return area && Number.isFinite(area.lat) ? { name: area.name, lat: area.lat, lng: area.lng } : null
})
const mapPlaces = computed(() => places.value.map((p) => ({ id: p.id, name: p.venue.name, lat: p.venue.lat, lng: p.venue.lng, category: p.venue.category })))
const itineraryPath = computed(() => `/sessions/${session.value.id}/itinerary`)
const isHost = computed(() => session.value?.hostId === myId.value)
const selectedPlace = computed(() => places.value.find((p) => p.id === selected.value) || null)

// Ask for the places for the centre and kind now chosen. Only the newest request puts its answer in.
// How to call: await load()
async function load() {
  const mine = ++ticket
  loading.value = true
  loadError.value = ''
  actionError.value = ''
  try {
    const result = await api.roamNearby(session.value.id, {
      point: centre.value.mode === 'meeting' ? undefined : position.value,
      categories: kind.value ? [kind.value] : ROAM_CATEGORIES,
      unconfirmed: unconfirmed.value,
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

// What the panel asks for first, and again for another session: the places, while the plan is under way.
// How to call: begin()
function begin() {
  if (open.value) load()
  else loading.value = false
}
// What the floating cards cover of the full-screen map from 1128px (app.css "Map-first pages"): the header's card at the top, the column of
// cards on the right (520 px wide) and the button at the foot, so the map frames the places in the rest. Nothing below 1128px.
const mapCover = ref({})
// Sets mapCover for the window's width. How to call: syncCover()
function syncCover() {
  const wide = (globalThis.innerWidth || 0) >= 1128
  mapCover.value = wide ? { top: 170, right: 520 + 48, bottom: 72 } : {}
}
onMounted(() => {
  syncCover()
  globalThis.addEventListener?.('resize', syncCover)
})
onBeforeUnmount(() => globalThis.removeEventListener?.('resize', syncCover))
onMounted(begin)
watch(() => session.value?.id, (now, was) => {
  if (now === was) return
  resetPlace()
  centre.value = { mode: 'meeting', areaName: '' }
  position.value = null
  kind.value = ''
  unconfirmed.value = false
  answer.value = null
  selected.value = ''
  result.value = null
  said.value = ''
  begin()
})
// The plan can stop being under way while the panel is open (the outing is finished or called off).
// And the other way: a session read from the cache that was not under way can turn out to be, once it is read afresh, and then the
// places are asked for if nothing is loaded or on its way.
watch(open, (now, was) => {
  if (was && !now) {
    ticket += 1
    loading.value = false
  } else if (now && !was && !answer.value && !loading.value) begin()
})
// A dot pressed for a place the list no longer has: its card goes.
watch(places, () => {
  if (selected.value && !selectedPlace.value) selected.value = ''
})

// The dietary line, shown while the list can hold food; and the food places that fit, for the "only N fit" line.
const holdsFood = computed(() => !kind.value || kind.value === 'eat')
const dietLine = computed(() => (holdsFood.value ? fitLine(answer.value?.dietary) : ''))
const foodCount = computed(() => places.value.filter((p) => p.venue.category === 'eat').length)

// Show the food places we could not confirm, or only the ones that fit, and ask again.
// How to call: showUnconfirmed(true)
function showUnconfirmed(on) {
  if (unconfirmed.value === on) return
  unconfirmed.value = on
  load()
}

// How to call: pickKind('eat')
function pickKind(next) {
  if (kind.value === next) return
  kind.value = next
  selected.value = ''
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

// How to call: backToMeeting()
function backToMeeting() {
  note.value = ''
  position.value = null
  centre.value = { mode: 'meeting', areaName: '' }
  load()
}

// Propose a place (the tick), or take a proposal back (the cross). The button keeps focus where it can: the tick and the cross
// are the same place in the card.
// How to call: await act(place, action)
async function act(place, action) {
  if (working.value) return
  working.value = place.id
  actionError.value = ''
  said.value = ''
  try {
    const name = place.venue.name
    if (action.kind === 'free') {
      const changed = await events.proposeMyStop(session.value.id, place.id)
      said.value = changed === false ? ROAM_WORDS.alreadyProposed(name) : ROAM_WORDS.proposed(name, session.value?.hostName || 'The host')
      const next = proposedResult({ isHost: isHost.value, hostName: session.value?.hostName, above: props.proposalsAbove })
      result.value = { placeId: place.id, expects: 'proposed', text: changed === false ? `${name} is already proposed.` : next.text, go: next.go }
    } else {
      const changed = await events.resolveProposal(session.value.id, place.proposal.id, false)
      said.value = changed === false ? ROAM_WORDS.gone : ROAM_WORDS.takenBack(name)
      result.value = { placeId: place.id, expects: 'free', text: changed === false ? ROAM_WORDS.gone : ROAM_WORDS.takenBack(name), go: '' }
    }
    await nextTick()
  } catch (e) {
    actionError.value = e.message
  } finally {
    working.value = ''
  }
}

// What a place's foot shows now: its tag and button.
// How to call: actionFor(place) -> { kind: 'free', tag: '', button: 'Propose', ... }
const actionFor = (place) => placeAction(place, { myId: myId.value, blocked: blocked.value })
// The symbol on a place's button: a tick to propose it, a cross to take it back.
// Proposing a place is a + (Darius, 4 November 2026; it was a tick); taking a proposal back is a cross.
// How to call: symbolOf({ kind: 'free' }) -> 'plus'
const symbolOf = (action) => (action.kind === 'free' ? 'plus' : 'close')
// The line under a place's card after a press on it, or null when there is none (or it is no longer true of the place).
// How to call: resultFor(place) -> { text: 'Proposed. Add it to the plan above.', go: 'above' }
const resultFor = (place) => (result.value && result.value.placeId === place.id && result.value.expects === place.state ? result.value : null)

// Moves focus to a place's proposal in the proposed stops above (its first button, else the row), which scrolls it into view.
// How to call: await goToProposal(place)
async function goToProposal(place) {
  const proposal = (session.value?.proposals || []).find((p) => p.venueId === place.id)
  if (!proposal) return
  await nextTick()
  const row = document.getElementById(`proposed-${proposal.id}`)
  ;(row?.querySelector('button') || row)?.focus()
}
</script>

<template>
  <div class="roam-panel" data-testid="roam-panel">
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

      <div class="filter scroll-x" role="radiogroup" v-radio-group aria-label="Kind of place">
        <ChipButton radio :selected="!kind" @click="pickKind('')">All</ChipButton>
        <ChipButton v-for="c in ROAM_CATEGORIES" :key="c" radio :selected="kind === c" @click="pickKind(c)">
          <template #leading><CategoryIcon :category="c" :size="24" /></template>
          {{ CATEGORY_LABELS[c] }}
        </ChipButton>
      </div>

      <template v-if="dietLine && !loading && !loadError">
        <p class="caption-sm text-muted diet-line" data-testid="diet-line">{{ dietLine }}</p>
        <p v-if="answer.dietFew || answer.unconfirmed" class="diet-few" data-testid="diet-few">
          <span class="caption-sm text-muted">{{ answer.unconfirmed ? "Showing places we couldn't confirm too. Check before you go." : fewLine(foodCount) }}</span>
          <AppButton variant="tertiary" underline small data-testid="diet-toggle" @click="showUnconfirmed(!answer.unconfirmed)">{{ answer.unconfirmed ? 'Only places that fit' : "Show places we couldn't confirm" }}</AppButton>
        </p>
      </template>

      <p class="sr-only" role="status">{{ announcement }}</p>
      <p class="sr-only" role="status" data-testid="roam-said">{{ said }}</p>
      <p v-if="actionError" class="body-sm text-error" role="alert" data-testid="roam-error">{{ actionError }}</p>
      <p v-if="blocked && !loading && !loadError" id="roam-blocked" class="body-sm text-muted" data-testid="roam-blocked">{{ blocked }}</p>

      <SplitView v-model:view="view" class="roam-split" label="Places nearby" even map-first>
        <template #list>
          <div v-if="loading" class="stack gap-md" aria-hidden="true" data-testid="roam-loading">
            <SkeletonRow v-for="n in 3" :key="n" avatar :lines="3" />
          </div>
          <EmptyState v-else-if="loadError" title="Could not load places" :text="loadError" role="alert" data-testid="roam-failed">
            <AppButton variant="secondary" @click="load">Retry</AppButton>
          </EmptyState>
          <EmptyState v-else-if="!places.length" :title="ROAM_WORDS.empty" :text="ROAM_WORDS.emptyText" data-testid="roam-empty">
            <AppButton v-if="kind" variant="secondary" @click="pickKind('')">Show all kinds</AppButton>
          </EmptyState>
          <ul v-else class="places" :aria-label="`Places ${centreText.toLowerCase()}`" data-testid="roam-list">
            <li v-for="place in places" :key="place.id" class="places__item" :class="{ 'is-selected': selected === place.id }" :data-place="place.id">
              <SuggestionCard :option="place" :meta="travelLine(place)" @open="openPlace">
                <template #foot>
                  <InfoTag v-if="actionFor(place).tag" tone="strong" :icon="actionFor(place).icon">{{ actionFor(place).tag }}</InfoTag>
                  <span v-else />
                  <MarkButton
                    v-if="actionFor(place).button"
                    :symbol="symbolOf(actionFor(place))"
                    :label="actionFor(place).label"
                    :disabled="actionFor(place).disabled"
                    :busy="working === place.id"
                    :aria-describedby="actionFor(place).disabled ? 'roam-blocked' : undefined"
                    @click="act(place, actionFor(place))"
                  >
                    {{ actionFor(place).button }}
                  </MarkButton>
                </template>
              </SuggestionCard>
              <p v-if="resultFor(place)" class="result caption-sm" data-testid="roam-result">
                <span>{{ resultFor(place).text }}</span>
                <AppButton v-if="resultFor(place).go === 'above'" small variant="tertiary" underline :aria-label="`Go to the proposal of ${place.venue.name}`" @click="goToProposal(place)">Go to the proposal</AppButton>
                <AppButton v-else-if="resultFor(place).go === 'itinerary'" small variant="tertiary" underline :to="itineraryPath">Open the itinerary</AppButton>
              </p>
            </li>
          </ul>
          <WeatherSource v-if="!loading && !loadError && answer?.weather" :block="answer.weather" />
        </template>

        <template #map>
          <PlannerMap :cover="mapCover" :area="mapCentre" :places="mapPlaces" :selected="selected" label="Places nearby map" @select="selected = $event" />
          <CategoryKey :categories="mapPlaces.map((p) => p.category)" />
          <div v-if="selectedPlace" class="pin-card" role="dialog" :aria-label="selectedPlace.venue.name" data-testid="roam-pin-card">
            <div class="pin-card__row">
              <img class="pin-card__photo" :src="placeImage(selectedPlace.venue)" alt="" width="56" height="56" />
              <span class="pin-card__text">
                <button type="button" class="pin-card__name title-md clamp-2" @click="openPlace(selectedPlace, 'name')">{{ selectedPlace.venue.name }}</button>
                <span class="caption-sm text-muted">{{ travelLine(selectedPlace) }}</span>
              </span>
              <IconButton label="Close" @click="selected = ''"><AppIcon name="close" :size="14" /></IconButton>
            </div>
            <p v-if="resultFor(selectedPlace)" class="result caption-sm" data-testid="roam-pin-result">
              <span>{{ resultFor(selectedPlace).text }}</span>
              <AppButton v-if="resultFor(selectedPlace).go === 'above'" small variant="tertiary" underline :aria-label="`Go to the proposal of ${selectedPlace.venue.name}`" @click="goToProposal(selectedPlace)">Go to the proposal</AppButton>
              <AppButton v-else-if="resultFor(selectedPlace).go === 'itinerary'" small variant="tertiary" underline :to="itineraryPath">Open the itinerary</AppButton>
            </p>
            <div class="pin-card__row">
              <InfoTag v-if="actionFor(selectedPlace).tag" tone="strong" :icon="actionFor(selectedPlace).icon">{{ actionFor(selectedPlace).tag }}</InfoTag>
              <CategoryIcon v-else :category="selectedPlace.venue.category" :size="24" />
              <MarkButton
                v-if="actionFor(selectedPlace).button"
                :symbol="symbolOf(actionFor(selectedPlace))"
                :label="actionFor(selectedPlace).label"
                :disabled="actionFor(selectedPlace).disabled"
                :busy="working === selectedPlace.id"
                @click="act(selectedPlace, actionFor(selectedPlace))"
              >
                {{ actionFor(selectedPlace).button }}
              </MarkButton>
            </div>
          </div>
        </template>
      </SplitView>
    </template>

    <PlaceDetail v-if="detail" :place="detail.place" :reviews="detail.reviews" :outing="outing" :from="detailFrom" @close="closePlace" />
    <LocationSheet v-model:open="pickerOpen" which="spot" :title="ROAM_WORDS.pick" @select="pickArea" />
  </div>
</template>

<style scoped>
.roam-panel { display: flex; flex-direction: column; gap: var(--spacing-base); min-width: 0; }
.where { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-sm); }
.where__line { overflow-wrap: anywhere; }
.where__actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); }
.where__privacy { display: flex; align-items: center; gap: var(--spacing-xs); }
/* The filter: one row of chips, scrolling sideways on a phone, as on the voting page. */
.filter { display: flex; gap: var(--spacing-sm); }
.places { display: flex; flex-direction: column; gap: var(--spacing-md); list-style: none; margin: 0; padding: 0; }
.diet-line { margin: 0; }
.diet-few { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); margin: 0; }
.places__item { display: flex; flex-direction: column; gap: var(--spacing-xs); min-width: 0; border-radius: var(--rounded-md); }
/* The line under a card after a press: what was done and, for a host, the way to the proposal. */
.result { display: flex; flex-wrap: wrap; align-items: center; gap: 0 var(--spacing-sm); margin: 0; color: var(--ink); }
.places__item > :deep(.sugg) { flex: 1 1 auto; min-width: 0; }
/* The place whose dot is pressed on the map: an ink ring, as the selected meetup row has. */
.places__item.is-selected { outline: 2px solid var(--ink); outline-offset: 2px; }

/* A pressed dot's card, over the bottom of the map, as on the Vote page. */
.pin-card { position: absolute; left: var(--spacing-sm); right: var(--spacing-sm); bottom: var(--spacing-xl); z-index: 600; display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-md) var(--spacing-md) var(--spacing-sm) var(--spacing-base); border-radius: var(--rounded-md); background: var(--canvas); box-shadow: var(--shadow-float); }
.pin-card__row { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); }
.pin-card__photo { flex-shrink: 0; width: 56px; height: 56px; object-fit: cover; border-radius: var(--rounded-sm); }
.pin-card__text { display: flex; flex-direction: column; flex: 1 1 0; min-width: 0; gap: var(--spacing-xxs); }
.pin-card__name { padding: 0; border: 0; background: none; color: var(--ink); text-align: left; cursor: pointer; }
@media (hover: hover) { .pin-card__name:hover { text-decoration: underline; } }
</style>
