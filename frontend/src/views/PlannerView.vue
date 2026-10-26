<script setup>
// Step 6: choose what to do.
//   Places near the meeting area for every category at once (Eat, Drink, Shop, Activity), 3 each to start; a filter
//   narrows the list and the map to one category. Anyone can add more (up to 6 per category) or search for a place.
//   One vote per person per category: voting for another place moves it, tapping your vote again takes it back.
//   The plan is made from the categories people voted in, laid out in the session window.
//   Step 7  "Confirm plan" once at least 2 people have voted.
// The list and the map show the same places, and the map has a key to the categories of the places on it.
// Search within (ticket #122): while voting, a row of radius chips under the filter (Auto, 100 m to 3 km). The map draws the
// radius as a ring round the meeting area, and the places follow it: places outside drop out with their votes, and each
// category tops up again (lib/api.js setRadius). A category with too few places inside offers "Widen to ...".
// Weather: a card keeps its small rain mark (SuggestionCard), and one muted line under the list says where the forecast came
// from (WeatherSource); a simulated forecast also shows a banner at the top.
// Dietary needs (ticket #107): when the group has any, one line under Eat says which needs the places fit ("Showing places
// that fit halal and vegetarian"), with no names and no count. Food places are filtered strictly; when fewer than 3 fit, a
// line says so and offers "Show places we couldn't confirm", each then labelled on its card. "Only places that fit" goes back.
// Each person is asked once per outing, when it reaches voting, to "Confirm dietary needs" (DietaryConfirm), with the outing's
// needs already selected; their picks are for this outing only, and the profile is left as it is. While voting, "Group dietary
// needs" under the radius holds the same chips (DietaryChips), saved at each tap, so the needs can be changed at any time. A
// shared session shows none of this yet: its places are chosen by the server, which already filters them by the group's needs.
// A shared session (one kept on the server, session.remote) reaches this page once the host has confirmed the meeting spot. It shows the
// places the server offered for each category, read from the database (a reload asks the planner nothing), and the votes of everyone
// in it, which arrive live. A person's own vote shows at once and is taken back if the database refuses it. Only the host changes how
// far to search; the others see the radius as a line. Only the host confirms the plan: the host has "Confirm plan" (the dialog below), and
// everyone else reads "Waiting for {host} to confirm the plan." with the way back to the people. A person who opted out sees that, can
// rejoin, and cannot vote. The Confirm dialog of a shared session shows the voted order and, when the server has one, the suggested order
// with its note (the server asks the AI and keeps the answer, so what the host confirms is what the server made). Confirming sends only
// which of the two orders the host saw. If the votes changed since (the server refuses with `order_stale`, writing nothing), the dialog
// stays open, draws the orders again from the stored votes and says so in one line; any other refusal or failure is one line inside the
// dialog with Confirm still there to try again. A suggested order that could not be asked for says so, with Try again.
// Only a session that does not exist shows "Not found". If the planner fails, an inline error with "Try again"
// shows the message and the rest of the page stays usable.
// Replace (/sessions/:id/plan?replace=<slot>, from Replace on the itinerary of a confirmed plan): the page shows the one
// stop being replaced, a row of categories (Eat, Drink, Shop, Activity; the stop's own to start), and the places of the
// chosen category that fit the stop's time, the ones the group voted on first, each with "Use this place". Choosing a
// place of another category turns the stop into that category, at the same time. Choosing one puts it in the
// itinerary and goes back there; "Keep this stop" goes back without a change. Nobody votes again and the plan stays confirmed.
// Only the host may replace a stop (anyone else sees a sentence saying so and the way back). The header lights Itinerary
// and goes back to it, as on the photos and the map. Only a list of the category the tabs show is ever on the page.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AvatarStack from '@/components/ui/AvatarStack.vue'
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
import ChangePlan from '@/components/event/ChangePlan.vue'
import DietaryChips, { dietChips } from '@/components/event/DietaryChips.vue'
import { DIETARY_OPTIONS } from '@/lib/signupRules.js'
import DietaryConfirm from '@/components/event/DietaryConfirm.vue'
import SuggestionCard from '@/components/event/SuggestionCard.vue'
import WeatherSource from '@/components/weather/WeatherSource.vue'
import CategoryKey from '@/components/map/CategoryKey.vue'
import PlannerMap from '@/components/map/PlannerMap.vue'
import NotFoundView from './NotFoundView.vue'
import { watchSessions } from '@/lib/api.js'
import { CATEGORIES, CATEGORY_LABELS } from '@/lib/planner/slots.js'
import { distanceText } from '@/lib/planner/format.js'
import { ORDER_TABS, VOTED, confirmKey, confirmView, sourceIcon, sourceText, votedRows } from '@/lib/confirmOrder.js'
import { placeImage } from '@/lib/placeImages.js'
import { walkFromText } from '@/lib/cardText.js'
import { usePlaceDetail } from '@/lib/usePlaceDetail.js'
import { fewLine, fitLine, unfitDietText, unfitGroupNeedsText } from '@/lib/dietText.js'
import { confetti } from '@/lib/confetti.js'
import { mealWindow, MEAL_WINDOWS } from '@/lib/planner/timeOfDay.js'
import { isBehind } from '@/lib/stepNav.js'
import { CANCEL_OUTING } from '@/lib/session.js'
import { WORDS } from '@/lib/sessionsRemote.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'
import { usePlannerStore } from '@/stores/planner.js'
import { vRadioGroup } from '@/lib/radioGroup.js'

const props = defineProps({ id: { type: String, required: true } })

const router = useRouter()
const route = useRoute()
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
// Inside the Confirm dialog of a shared session: why the orders were drawn again, and why a confirm did not go through.
const staleNote = ref('')
const confirmError = ref('')
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
// A shared session's votes and places arrive live while this page is open (a no-op for the demo and local accounts).
let stopWatching = () => {}
onMounted(() => {
  stopWatching = watchSessions()
  load()
})
onBeforeUnmount(() => stopWatching())
watch(() => props.id, load)

const session = computed(() => events.byId[props.id])
const plan = computed(() => planner.plans[props.id])
// The grey placeholder rows: on the page's first load, and again while a change to the group's dietary needs picks the places
// afresh (`refiltering`, under Dietary needs).
const refiltering = ref(false)
const loading = computed(() => refiltering.value || (planner.loading[props.id] && !plan.value?.slots?.length))
const voting = computed(() => session.value?.status === 'voting')
// A shared session is one kept on the server. Its host is the one who changes the radius; a person who opted out sees the page and
// does not vote (the database would refuse it).
const shared = computed(() => !!session.value?.remote)
const optedOut = computed(() => shared.value && (session.value.members || []).some((m) => m.id === auth.myId && m.state === 'opted_out'))
const rejoining = ref(false)
// Come back after opting out. How to call: rejoin()
async function rejoin() {
  rejoining.value = true
  error.value = ''
  try {
    await events.rejoin(props.id)
  } catch (e) {
    error.value = e.message
  } finally {
    rejoining.value = false
  }
}
const nameOf = (id) => (id === auth.myId ? auth.user?.name ?? '' : groups.nameOf(id))
const active = computed(() => session.value?.activeIds || [])
// Who a card's review line may quote: the other people in this outing (`outingIds`, below), then the signed-in person's friends.
const friendIds = computed(() => groups.friends.map((p) => p.id))
const slots = computed(() => plan.value?.slots || [])
// Where the walking times on the cards are measured from, said once above the list. Nothing without a meeting area.
const walkFrom = computed(() => (session.value?.meeting ? walkFromText(session.value.area?.name) : ''))
const shown = computed(() => (filter.value ? slots.value.filter((s) => s.category === filter.value) : slots.value))
// Under All, categories with nothing nearby fold into one line instead of an empty section each. Eat left empty by the group's
// dietary needs keeps its section, which offers the places we could not confirm.
const keepsSection = (s) => s.options.length > 0 || !!s.dietFew
const listed = computed(() => (filter.value ? shown.value : shown.value.filter(keepsSection)))
const emptyLabels = computed(() => (filter.value ? [] : shown.value.filter((s) => !keepsSection(s)).map((s) => CATEGORY_LABELS[s.category])))
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
// A card's name, photo or review line opens the place's detail over this page (lib/usePlaceDetail.js, shared with Roam).
// `outingIds` are the other people in the outing, whose reviews it puts first.
const { detail: reviewing, outing: outingIds, open: openReviews, close: closeReviews } = usePlaceDetail(() => session.value)

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
    try {
      const results = await planner.searchVenues(props.id, adding.value.slot.id, q)
      // Only the newest typing applies; an answer for older text is dropped.
      if (adding.value.query === q) adding.value.results = results
    } catch (e) {
      error.value = e.message
    }
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
  if (result.unfit === 'diet') return unfitDietText(result.need)
  // A shared session's search never says which need.
  if (result.unfit === 'group_needs') return unfitGroupNeedsText
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
// The choices, in metres; null is Auto (the planner starts at 500 m and looks further out until 3 places fit).
const RADII = [null, 100, 250, 500, 1000, 2000, 3000]
// How to call: radiusLabel(1000) -> '1 km'
const radiusLabel = (m) => (m == null ? 'Auto' : m >= 1000 ? `${m / 1000} km` : `${m} m`)
const radius = computed(() => plan.value?.radius ?? null)
// True while a change runs. The chips are `disabled` in ChipButton's sense: aria-disabled, still focusable, clicks ignored (a
// natively disabled button would lose keyboard focus and throw the person out to the page). The row is one Tab stop and the
// arrow keys choose, as the Show chips do (v-radio-group).
const settingRadius = ref(false)
// How to call: await setRadius(1000)
async function setRadius(metres) {
  if (metres === radius.value || settingRadius.value) return
  settingRadius.value = true
  error.value = ''
  try {
    await planner.setRadius(props.id, metres)
  } catch (e) {
    error.value = e.message
  } finally {
    settingRadius.value = false
  }
}
// The smallest choice that reaches `km`, for "Widen to ...". How to call: radiusFor(1.4) -> 2000
const radiusFor = (km) => RADII.find((m) => m != null && m >= km * 1000) ?? null
// How far the places may be, in words: the chosen radius, or the planner's own limit of 3 km under Auto.
const reachText = computed(() => radiusLabel(radius.value ?? 3000))

// ── Dietary needs ──
// The line under Eat, or '' when the group has no needs.
const dietLine = computed(() => fitLine(plan.value?.dietary))
// A change to the group's dietary filter picks the places again, so the list goes back to its placeholder rows, as on the first
// load, and the sections rise in again when the new places are in. The rows stay at least this long, so a quick answer does
// not flash.
const REFILTER_MIN_MS = 450
// How to call: await refilter(() => planner.setUnconfirmed(props.id, true))
async function refilter(work) {
  refiltering.value = true
  const started = Date.now()
  try {
    return await work()
  } finally {
    const left = REFILTER_MIN_MS - (Date.now() - started)
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left))
    refiltering.value = false
  }
}
// How to call: sameNeeds(['halal'], ['halal']) -> true
const sameNeeds = (a = [], b = []) => a.length === b.length && a.every((n) => b.includes(n))
// True when { mine, dropped } differs from what the outing already has. How to call: dietChanges({ mine: ['halal'], dropped: [] })
const dietChanges = ({ mine, dropped }) => !sameNeeds(mine, plan.value?.myDietary) || !sameNeeds(dropped, plan.value?.dietDropped)
// True while the group's choice of places runs (the same rule as the radius chips: clicks are ignored meanwhile).
const settingDiet = ref(false)
// Show the food places we could not confirm, or only the ones that fit.
// How to call: await showUnconfirmed(true)
async function showUnconfirmed(on) {
  if (settingDiet.value) return
  settingDiet.value = true
  error.value = ''
  try {
    await refilter(() => planner.setUnconfirmed(props.id, on))
  } catch (e) {
    error.value = e.message
  } finally {
    settingDiet.value = false
  }
}

// "Confirm dietary needs": opens by itself while voting until the signed-in person has confirmed for this outing. (Replacing a
// stop is for a confirmed plan, never while voting, so it never opens there.) Each value is compared on its own, so the session
// being read again does not count as a change; a dialog answered on this page is never opened again for the outing, even
// while the plan that says so is still loading; and it closes once the plan says it is confirmed (in another tab, say).
const dietOpen = ref(false)
const dietBusy = ref(false)
const dietError = ref('')
const dietChecked = computed(() => plan.value?.dietChecked)
const hasMeeting = computed(() => !!session.value?.meeting)
const dietAnswered = new Set()
watch(
  [voting, hasMeeting, dietChecked],
  ([isVoting, meeting, checked]) => {
    if (checked === true) dietOpen.value = false
    else if (isVoting && meeting && checked === false && !dietAnswered.has(props.id)) dietOpen.value = true
  },
  { immediate: true },
)
// A need's name for its tag. How to call: needLabel('halal') -> 'Halal'
const needLabel = (need) => DIETARY_OPTIONS.find((o) => o.value === need)?.label ?? need
// The change being saved, { mine, dropped }, or null. The tags and chips show it at once, while the places load behind them.
const pendingDiet = ref(null)
// The person's own needs and the dropped ones as the page shows them: the change being saved, else the outing's.
const shownMine = computed(() => pendingDiet.value?.mine ?? plan.value?.myDietary ?? [])
const shownDropped = computed(() => pendingDiet.value?.dropped ?? plan.value?.dietDropped ?? [])
// The tags under "Group dietary needs": the selected chips, in the chips' order.
const shownNeeds = computed(() => (pendingDiet.value
  ? dietChips({ mine: shownMine.value, others: plan.value?.othersDietary || [], dropped: shownDropped.value }).filter((c) => c.selected).map((c) => c.value)
  : plan.value?.dietary || []))

// A tap on the Vote page's dietary chips, saved at once: the person's own needs and the others' needs not to filter for.
// How to call: await saveDiet({ mine: ['halal'], dropped: [] })
async function saveDiet({ mine, dropped }) {
  if (dietBusy.value) return
  dietBusy.value = true
  pendingDiet.value = { mine, dropped }
  error.value = ''
  try {
    const answer = await refilter(() => planner.confirmDiet(props.id, mine, dropped))
    if (answer?.syncError) error.value = answer.syncError
  } catch (e) {
    error.value = e.message
  } finally {
    pendingDiet.value = null
    dietBusy.value = false
  }
}

// answer: { mine, dropped } from the dialog: the person's own needs, and the others' needs the group should not filter for.
// How to call: await confirmDiet({ mine: ['halal'], dropped: [] })
async function confirmDiet({ mine, dropped }) {
  if (dietBusy.value) return
  dietBusy.value = true
  dietError.value = ''
  // A change closes the dialog at once and shows the list loading behind it; confirming the needs as they are just saves.
  const changes = dietChanges({ mine, dropped })
  if (changes) {
    dietAnswered.add(props.id)
    dietOpen.value = false
    pendingDiet.value = { mine, dropped }
  }
  try {
    const answer = await (changes ? refilter(() => planner.confirmDiet(props.id, mine, dropped)) : planner.confirmDiet(props.id, mine, dropped))
    dietAnswered.add(props.id)
    dietOpen.value = false
    // Saved here but not to the account: said under the votes, as the page says other failures.
    if (answer?.syncError) error.value = answer.syncError
  } catch (e) {
    dietError.value = e.message
    dietOpen.value = true
  } finally {
    pendingDiet.value = null
    dietBusy.value = false
  }
}

// Why a slot has nothing, in words.
function emptyText(slot) {
  const e = slot.empty
  // The nearest distance may be missing, so the sentence about it is optional.
  const nearest = e?.nearestKm != null ? ` The nearest is ${e.nearestKm.toFixed(1)} km away.` : ''
  if (e?.reason === 'outside_max_radius') return `Nothing that fits is within ${reachText.value}.${nearest}`
  if (slot.dietFew) return fewLine(0)
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

// ── Voting that is waiting for a start ──
// A shared session that is voting but has no meeting area: nobody has a start the server could plan from (it needs two), so there are no
// places to vote on. The page says so, sends whoever has no start to the page where they can share it (a start can be changed while
// voting; the server works the places out again), and gives the host a way to call the outing off.
const noArea = computed(() => shared.value && voting.value && !session.value?.meeting)
const hasStart = computed(() => !!session.value?.locations?.[auth.myId]?.start)
const cancelOpen = ref(false)
const cancelling = ref(false)
// Call the outing off (the host's, as the header's hold button does). How to call: await cancelOuting()
async function cancelOuting() {
  cancelling.value = true
  error.value = ''
  try {
    await events.cancel(props.id)
    cancelOpen.value = false
  } catch (e) {
    error.value = e.message
    cancelOpen.value = false
  } finally {
    cancelling.value = false
  }
}

// ── Replace one stop of a confirmed plan ──
// The slot of the stop being replaced, from ?replace=. Only a confirmed plan has stops to replace; any other session
// shows the voting page as usual.
const replacing = computed(() => (typeof route.query.replace === 'string' ? route.query.replace : ''))
const replaceMode = computed(() => !!replacing.value && session.value?.status === 'confirmed')
// Only the host replaces a stop (the data layer refuses anyone else): a member proposes a stop for the host to add instead.
const isHost = computed(() => !!session.value && session.value.hostId === auth.myId)
// Who changes how far to search: anyone in a session of this browser; only the host in a shared one (the server's rule).
const canSetRadius = computed(() => !shared.value || isHost.value)
const hostName = computed(() => nameOf(session.value?.hostId) || 'the host')
// The stop being replaced ({ slotId, category, venue, time, duration }), kept apart from the list so a failed request
// does not take it off the page. The last answer ({ category, options }), whether one is being asked for, why it failed,
// and the place being saved.
const stop = ref(null)
const choices = ref(null)
const choicesLoading = ref(false)
const replaceError = ref('')
const choosing = ref('')
// The category the places are of: '' for the stop's own until another is picked.
const replaceCategory = ref('')
const shownCategory = computed(() => replaceCategory.value || stop.value?.category || '')
// Picking another category than the stop's turns the stop into it.
const changesCategory = computed(() => !!stop.value && shownCategory.value !== stop.value.category)
// Only a list of the category the tabs show is ever on the page: an answer for another one (an older request) is not.
const currentChoices = computed(() => (choices.value && choices.value.category === shownCategory.value ? choices.value : null))
// What a screen reader hears while places load; the grey placeholder rows say nothing themselves.
const loadingSaid = computed(() => {
  if (replaceMode.value) return choicesLoading.value && !currentChoices.value ? 'Finding other places' : ''
  if (loading.value) return 'Finding places'
  return loadingMore.value ? 'Finding more places' : ''
})
// Each request is numbered, so an older answer that arrives late (after a quick change of category) is dropped.
let choicesTicket = 0

// Ask for the places of the shown category that could take the stop's place.
// How to call: await loadChoices()
async function loadChoices() {
  if (!replaceMode.value || !isHost.value) return
  const ticket = ++choicesTicket
  const wanted = replaceCategory.value
  choicesLoading.value = true
  try {
    const answer = await events.replaceChoices(props.id, replacing.value, wanted || undefined)
    if (ticket !== choicesTicket) return
    // An answer for another category than the one asked for is not shown as if it were.
    if (wanted && answer.category !== wanted) throw new Error('The places could not be loaded. Reload the page and try again.')
    stop.value = answer.stop
    choices.value = answer
  } catch (e) {
    if (ticket !== choicesTicket) return
    replaceError.value = e.message
  } finally {
    if (ticket === choicesTicket) choicesLoading.value = false
  }
}
watch([replaceMode, replacing, isHost], () => {
  replaceError.value = ''
  replaceCategory.value = ''
  stop.value = null
  choices.value = null
  loadChoices()
}, { immediate: true })

// Ask again for the places after a failure, with the error taken off the page.
// How to call: retryChoices()
function retryChoices() {
  replaceError.value = ''
  loadChoices()
}

// Show the places of another category (or the stop's own again).
// How to call: pickCategory('activity')
function pickCategory(category) {
  // The category that is shown is pressed again only to ask again, after its places could not be loaded.
  if ((category === shownCategory.value && currentChoices.value) || choosing.value) return
  replaceCategory.value = category
  replaceError.value = ''
  selected.value = ''
  loadChoices()
}

// Back to the itinerary: Back when it is the page behind this one, so the history has no repeat.
// How to call: backToItinerary()
function backToItinerary() {
  const to = `/sessions/${props.id}/itinerary`
  if (isBehind(to)) router.back()
  else router.replace(to)
}

// Put the chosen place in the stop's place and go back. When it no longer fits, say so and ask again.
// How to call: await choose(option)
async function choose(option) {
  // Only a place on the list shown now, for the category the tabs show.
  if (choosing.value || !currentChoices.value?.options.some((o) => o.id === option.id)) return
  choosing.value = option.id
  replaceError.value = ''
  try {
    // The place the person saw in the stop goes with it, so a stop that was changed meanwhile is refused.
    await events.replaceStop(props.id, replacing.value, option.id, shownCategory.value || undefined, stop.value?.venue.id)
    backToItinerary()
  } catch (e) {
    replaceError.value = e.message
    await loadChoices()
  } finally {
    choosing.value = ''
  }
}

const replacePlaces = computed(() => (currentChoices.value?.options || []).map((o) => ({ id: o.id, name: o.venue.name, lat: o.venue.lat, lng: o.venue.lng, category: o.venue.category })))

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
watch([confirmOpen, orderKey], ([open, key], [was, before]) => {
  if (!open) {
    staleNote.value = ''
    confirmError.value = ''
    return
  }
  // New votes while the dialog is open redraw it; a shared session says so, so the host does not confirm rows that moved under them.
  if (shared.value && was && before !== key && !staleNote.value) staleNote.value = WORDS.orderChanged
  // A new open, or new votes, start again from the voted order.
  picked.value = VOTED
  events.suggestOrder(props.id, orderKey.value)
})
// The group stopped voting (the plan was confirmed from another device, or called off): the question is moot.
watch(voting, (now) => {
  if (!now) confirmOpen.value = false
})
// Ask for the suggested order again after it failed. How to call: retryOrder()
const retryOrder = () => events.suggestOrder(props.id, orderKey.value)

async function confirm() {
  busy.value = true
  error.value = ''
  // What is shown is what is saved: the suggestion when its order is shown, nothing for the voted order.
  const { pass } = orderView.value
  confirmError.value = ''
  try {
    await events.confirm(props.id, pass)
    confirmOpen.value = false
    // A moment to celebrate: confetti, and the itinerary opens with a "Plan confirmed" card.
    confetti()
    router.push({ path: `/sessions/${props.id}/itinerary`, state: { justConfirmed: true } })
  } catch (e) {
    if (shared.value) await keepDialog(e)
    else {
      error.value = e.message
      confirmOpen.value = false
    }
  } finally {
    busy.value = false
  }
}

// A shared session's confirm that did not go through. The dialog stays open. A suggested order the votes have outdated (`order_stale`: the
// server wrote nothing) is forgotten and both orders are drawn again from the stored votes, with the voted one selected; anything else is
// said in words inside the dialog, and Confirm is still there to try again.
// How to call: await keepDialog(Object.assign(new Error('The votes changed...'), { code: 'order_stale' }))
async function keepDialog(e) {
  if (e.code !== 'order_stale') {
    confirmError.value = e.message
    return
  }
  events.forgetOrder(props.id)
  picked.value = VOTED
  staleNote.value = e.message
  await planner.loadPlan(props.id, { quiet: true }).catch(() => {})
  events.suggestOrder(props.id, orderKey.value)
}
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else-if="session" class="screen" data-testid="planner-view">
    <SessionHeader :session="session" />

    <div class="screen__body">
      <p class="sr-only" role="status">{{ loadingSaid }}</p>
      <SessionNotices :session="session" />
      <ChangePlan v-if="!replaceMode" :session="session" />
      <BannerNote v-if="planError" tone="error" icon="warning" role="alert" data-testid="plan-error">
        {{ planError }}
        <template #actions>
          <AppButton small variant="secondary" :disabled="!!planner.loading[id]" @click="load">Try again</AppButton>
        </template>
      </BannerNote>

      <WeatherSource v-if="plan?.weather && session.meeting" :block="plan.weather" banner />

      <BannerNote v-if="optedOut && ['voting'].includes(session.status)" icon="info" data-testid="opted-out">
        You opted out of this session, so you can't vote and your trips are not counted.
        <template #actions><AppButton small variant="secondary" :disabled="rejoining" @click="rejoin">Rejoin</AppButton></template>
      </BannerNote>

      <div v-if="!session.meeting || ['inviting', 'locating'].includes(session.status)" class="empty-wrap">
        <EmptyState title="No meeting area yet" :text="noArea ? WORDS.noMeetingArea : ''" :data-testid="noArea ? 'waiting-for-starts' : undefined">
          <div class="empty-actions">
            <AppButton variant="secondary" :to="`/sessions/${id}`">{{ noArea && !hasStart ? 'Share where you start' : 'People' }}</AppButton>
            <AppButton v-if="noArea && isHost" variant="secondary" data-testid="cancel-waiting" @click="cancelOpen = true">{{ CANCEL_OUTING.action }}</AppButton>
          </div>
        </EmptyState>
      </div>

      <template v-else-if="replaceMode">
        <section class="replace" aria-labelledby="replace-head" data-testid="replace-view">
          <span class="caption text-muted">Replacing</span>
          <div class="replace__now">
            <CategoryIcon v-if="stop" :category="stop.category" :size="32" />
            <div class="stack">
              <h2 id="replace-head" class="title-md">{{ stop?.venue.name || 'This stop' }}</h2>
              <span v-if="stop" class="caption-sm text-muted">{{ CATEGORY_LABELS[stop.category] }} at {{ stop.time }} · {{ stop.duration }} min</span>
            </div>
          </div>
          <p v-if="isHost" class="body-sm text-muted">Choose another place for this stop, or something else to do instead. This stop keeps its start, and the rest of the plan stays as it is. Later stops may move with the travel time.</p>
        </section>

        <EmptyState v-if="!isHost" title="Only the host can replace a stop" text="You can propose a place for the host to add once the outing is under way." data-testid="replace-host-only" />
        <template v-else>

        <!-- What to do instead: the stop's own category to start, or another one. -->
        <div class="filter scroll-x" role="radiogroup" v-radio-group aria-label="What to do instead" data-testid="replace-categories">
          <ChipButton
            v-for="c in CATEGORIES"
            :key="c"
            radio
            :selected="shownCategory === c"
            :disabled="!!choosing || !stop"
            :data-testid="`replace-cat-${c}`"
            @click="pickCategory(c)"
          >
            <template #leading><CategoryIcon :category="c" :size="24" /></template>
            {{ CATEGORY_LABELS[c] }}
          </ChipButton>
        </div>
        <p v-if="changesCategory" class="body-sm replace__change" data-testid="replace-change">
          <AppIcon name="arrow-right" :size="16" />This stop becomes {{ CATEGORY_LABELS[shownCategory] }} instead of {{ CATEGORY_LABELS[stop.category] }}, at {{ stop.time }}.
        </p>
        <div v-if="replaceError" class="replace__error">
          <p class="body-sm text-error" role="alert" data-testid="replace-error">{{ replaceError }}</p>
          <AppButton small variant="secondary" :disabled="choicesLoading || !!choosing" data-testid="replace-retry" @click="retryChoices">Try again</AppButton>
        </div>

        <SplitView v-model:view="view" label="Places">
          <template #list>
            <div v-if="choicesLoading && !currentChoices" class="stack gap-md" data-testid="replace-loading">
              <SkeletonRow v-for="n in 3" :key="n" avatar :lines="3" />
            </div>
            <EmptyState
              v-else-if="currentChoices && !currentChoices.options.length"
              :title="changesCategory ? `No ${CATEGORY_LABELS[shownCategory]} places fit` : 'Nothing else fits'"
              :text="`No other ${CATEGORY_LABELS[shownCategory]} place nearby is open at ${stop.time}. Try another category, keep this stop${currentChoices.stopCount > 1 ? ', or delete it from the itinerary' : ''}.`"
            />
            <div v-else-if="currentChoices" class="slot__options" data-testid="replace-options">
              <SuggestionCard
                v-for="option in currentChoices.options"
                :key="option.id"
                :option="option"
                closed
                :selected="selected === option.id"
                :outing="outingIds"
                :friends="friendIds"
                :stop="stop ? { start: stop.start, duration: stop.duration } : null"
                :group-size="active.length"
                :me="auth.myId"
                @open="openReviews"
              >
                <!-- No vote here: who voted for the place, and the one button. -->
                <template #foot="{ votedText }">
                  <span class="replace__count">
                    <AvatarStack v-if="option.voters.length" :people="option.voters" :size="20" :max="4" />
                    <span class="caption">{{ votedText }}</span>
                  </span>
                  <AppButton variant="secondary" small :disabled="!!choosing" :aria-label="`Use ${option.venue.name} instead`" @click="choose(option)">{{ choosing === option.id ? 'Saving' : 'Use this place' }}</AppButton>
                </template>
              </SuggestionCard>
            </div>
          </template>

          <template #map>
            <PlannerMap :area="session.area" :places="replacePlaces" :selected="selected" label="Places map" @select="selected = $event" />
            <CategoryKey :categories="replacePlaces.map((p) => p.category)" />
          </template>
        </SplitView>
        </template>
      </template>

      <template v-else>
        <ProgressDonut compact title="Votes" :people="donutPeople" done-label="Voted" />
        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>

        <!-- One filter for the list and the map. -->
        <div class="filter scroll-x" role="radiogroup" v-radio-group aria-label="Show">
          <ChipButton radio :selected="!filter" @click="filter = ''">All</ChipButton>
          <ChipButton v-for="c in CATEGORIES" :key="c" radio :selected="filter === c" :aria-label="`${CATEGORY_LABELS[c]}, ${countOf(c)} places`" @click="filter = c">
            <template #leading><CategoryIcon :category="c" :size="24" /></template>
            {{ CATEGORY_LABELS[c] }}<span class="filter__count tnum">{{ countOf(c) }}</span>
          </ChipButton>
        </div>

        <!-- How far from the meeting area places may be. The map shows it as a ring. -->
        <div v-if="voting && slots.length && !canSetRadius" class="radius" data-testid="radius-readonly">
          <span class="caption text-muted">Search within</span>
          <span class="body-sm">{{ radius == null ? 'Auto' : radiusLabel(radius) }} of {{ session.area.name }}, set by {{ hostName }}.</span>
        </div>
        <div v-else-if="voting && slots.length" class="radius" data-testid="radius">
          <span id="radius-label" class="caption text-muted">Search within</span>
          <div class="filter scroll-x" role="radiogroup" v-radio-group aria-labelledby="radius-label">
            <ChipButton v-for="m in RADII" :key="m ?? 'auto'" radio :selected="radius === m" :disabled="settingRadius" @click="setRadius(m)">{{ radiusLabel(m) }}</ChipButton>
          </div>
          <span class="caption-sm text-muted" aria-live="polite">{{ radius == null ? 'Auto starts at 500 m and looks further out until 3 places fit.' : `Only places within ${radiusLabel(radius)} of ${session.area.name}.` }}</span>
        </div>

        <!-- The outing's dietary needs, laid out like "Search within": the label with the needs selected below as tags, then the
             Halal, Vegetarian and Vegan chips the places are filtered by. A tap saves at once; taking off a need someone else has
             asks first (DietaryChips). -->
        <div v-if="voting && plan?.myDietary" class="diet-edit" data-testid="diet-edit">
          <div class="diet-edit__mine">
            <span class="caption text-muted">Group dietary needs</span>
            <InfoTag v-for="need in shownNeeds" :key="need" :tone="need === 'halal' ? 'halal' : 'veg'" data-testid="diet-mine">{{ needLabel(need) }}</InfoTag>
            <span v-if="!shownNeeds.length" class="caption" data-testid="diet-mine">None</span>
          </div>
          <DietaryChips :mine="shownMine" :others="plan.othersDietary || []" :dropped="shownDropped" :busy="dietBusy" @change="saveDiet" />
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
              <p v-if="slot.category === 'eat' && dietLine" class="diet-line caption-sm text-muted" data-testid="diet-line">{{ dietLine }}</p>
              <p v-if="voting && slot.category === 'eat' && (slot.dietFew || plan.unconfirmed)" class="few-line" data-testid="diet-few">
                <span v-if="plan.unconfirmed" class="caption-sm text-muted">Showing places we couldn't confirm too. Check before you go.</span>
                <span v-else-if="slot.options.length" class="caption-sm text-muted">{{ fewLine(slot.options.length) }}</span>
                <AppButton variant="tertiary" underline small :disabled="settingDiet" data-testid="diet-toggle" @click="showUnconfirmed(!plan.unconfirmed)">{{ plan.unconfirmed ? 'Only places that fit' : "Show places we couldn't confirm" }}</AppButton>
              </p>

              <template v-if="!slot.options.length">
                <p class="body-sm text-muted">{{ emptyText(slot) }}</p>
                <AppButton v-if="voting && canSetRadius && radius && slot.empty?.widenToKm && radiusFor(slot.empty.widenToKm)" variant="secondary" small :disabled="settingRadius" @click="setRadius(radiusFor(slot.empty.widenToKm))">Widen to {{ radiusLabel(radiusFor(slot.empty.widenToKm)) }}</AppButton>
              </template>
              <template v-else>
                <!-- A group, not a radiogroup: each card holds several controls, and every Vote chip has to be a Tab stop of its own. -->
                <div class="slot__options" role="group" :aria-labelledby="`slot-${slot.id}`">
                  <SuggestionCard
                    v-for="option in slot.options"
                    :key="option.id"
                    :option="option"
                    :leading="slot.leader === option.id"
                    :behind="!!slot.leader && slot.leader !== option.id"
                    :mine="slot.myVote === option.id"
                    :closed="!voting || optedOut"
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
                <p v-if="voting && radius && slot.few" class="few-line">
                  <span class="caption-sm text-muted">Only {{ slot.few.found }} {{ slot.few.found === 1 ? 'place fits' : 'places fit' }} within {{ radiusLabel(radius) }}.</span>
                  <AppButton v-if="canSetRadius && slot.few.widenToKm && radiusFor(slot.few.widenToKm)" variant="tertiary" underline small :disabled="settingRadius" @click="setRadius(radiusFor(slot.few.widenToKm))">Widen to {{ radiusLabel(radiusFor(slot.few.widenToKm)) }}</AppButton>
                </p>
                <div v-if="voting && !optedOut && slot.options.length < 6" class="slot__more">
                  <AppButton variant="tertiary" underline small :disabled="!slot.canAddMore || loadingMore === slot.id" @click="more(slot)">More places</AppButton>
                  <AppButton variant="tertiary" underline small @click="openAdd(slot)">Search</AppButton>
                </div>
              </template>
            </section>
            <p v-if="!loading && slots.length && emptyLabels.length" class="body-sm text-muted">No {{ listJoin(emptyLabels) }} places within {{ reachText }} of {{ session.area.name }} yet.</p>
            <WeatherSource v-if="!loading && slots.length && plan?.weather" :block="plan.weather" />
          </template>

          <template #map>
            <PlannerMap :area="session.area" :places="mapPlaces" :radius="voting ? radius || 0 : 0" :selected="selected" label="Places map" @select="selected = $event" />
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
                <ChipButton v-if="voting && !optedOut" check :selected="selectedEntry.slot.myVote === selectedOption.id" @click="vote(selectedEntry.slot, selectedOption)">
                  {{ selectedEntry.slot.myVote === selectedOption.id ? 'Voted' : 'Vote' }}
                </ChipButton>
              </div>
            </div>
          </template>
        </SplitView>
      </template>
    </div>

    <footer v-if="replaceMode" class="screen__footer">
      <AppButton block variant="secondary" :disabled="!!choosing" data-testid="keep-stop" @click="backToItinerary">{{ stop && isHost ? 'Keep this stop' : 'Back to the itinerary' }}</AppButton>
    </footer>
    <footer v-else-if="voting && session.meeting && (!shared || isHost)" class="screen__footer">
      <AppButton block :disabled="!canConfirm" @click="confirmOpen = true">
        {{ canConfirm ? 'Confirm plan' : 'Needs 2 voters' }}
      </AppButton>
    </footer>
    <!-- A shared session: only the host confirms the plan. -->
    <footer v-else-if="voting && session.meeting && shared" class="screen__footer" data-testid="confirm-waiting">
      <p class="caption text-muted confirm-next">Waiting for {{ hostName }} to confirm the plan.</p>
      <AppButton block variant="secondary" :to="`/sessions/${id}`">Back to the people</AppButton>
    </footer>
    <footer v-else-if="['confirmed', 'completed'].includes(session.status)" class="screen__footer">
      <AppButton next block :to="`/sessions/${id}/itinerary`">Itinerary</AppButton>
    </footer>

    <PlaceDetail v-if="reviewing" :place="reviewing.place" :reviews="reviewing.reviews" :outing="outingIds" :from="session.area.name" @close="closeReviews" />

    <DietaryConfirm v-if="plan" v-model:open="dietOpen" :mine="plan.myDietary || []" :others="plan.othersDietary || []" :dropped="plan.dietDropped || []" :busy="dietBusy" :error="dietError" @confirm="confirmDiet" />

    <ModalDialog v-model:open="cancelOpen" :title="CANCEL_OUTING.title" :text="CANCEL_OUTING.text">
      <AppButton block variant="secondary" @click="cancelOpen = false">{{ CANCEL_OUTING.keep }}</AppButton>
      <AppButton block variant="danger" :disabled="cancelling" data-testid="cancel-waiting-confirm" @click="cancelOuting">{{ CANCEL_OUTING.confirm }}</AppButton>
    </ModalDialog>

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
        <p v-if="shared && order?.failed" class="order-failed caption-sm text-muted" data-testid="order-failed">
          Could not get a suggested order.
          <AppButton variant="tertiary" underline small data-testid="order-retry" @click="retryOrder">Try again</AppButton>
        </p>
        <!-- A live region that is on the page from the start, empty, so that what is put in it is announced; it takes no room until it has words. -->
        <p v-if="shared" :class="staleNote ? 'caption-sm text-muted dialog-line' : 'sr-only'" role="status" data-testid="order-stale">{{ staleNote }}</p>
        <p v-if="confirmError" class="body-sm text-error dialog-line" role="alert" data-testid="confirm-error">{{ confirmError }}</p>
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
      <p class="sr-only" role="status">{{ loadError ? '' : 'Loading the session' }}</p>
    </div>
  </main>
</template>

<style scoped>
/* Search within: a label, the chips, and one line on what the choice means. */
.radius { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.few-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); margin: 0; }
/* The filter: one row of chips, scrolling sideways on a phone. */
.filter { display: flex; gap: var(--spacing-sm); }
.filter__count { margin-left: var(--spacing-xs); opacity: 0.6; }
.walk-from { margin: 0; }
.diet-line { margin: 0; }
/* "Group dietary needs": the same stack as "Search within" above it; the label and the selected needs share a line. */
.diet-edit { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.diet-edit__mine { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); }
.slot { display: flex; flex-direction: column; gap: var(--spacing-md); }
.slot + .slot { padding-top: var(--spacing-lg); }
.slot__head { display: flex; align-items: center; gap: var(--spacing-md); }
.slot__options { display: flex; flex-direction: column; gap: var(--spacing-md); }
.slot__more { display: flex; gap: var(--spacing-base); }
.empty-wrap { padding-top: var(--spacing-lg); }
.empty-actions { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
.confirm-next { margin: 0 0 var(--spacing-sm); text-align: center; }
/* Replace: the stop being replaced, above the places that could take its place. */
.replace { display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-base); border-radius: var(--rounded-md); background: var(--surface-soft); }
.replace p, .replace h2 { margin: 0; }
.replace__now { display: flex; align-items: center; gap: var(--spacing-md); min-width: 0; }
.replace__count { display: inline-flex; align-items: center; gap: var(--spacing-sm); min-width: 0; }
.replace__error { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); }
.replace__error p { margin: 0; min-width: 0; }
.replace__change { display: flex; align-items: flex-start; gap: var(--spacing-xs); margin: 0; color: var(--ink); }
.replace__change :deep(svg) { flex-shrink: 0; margin-top: 2px; }
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
.order-failed { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); margin: 0; }
.dialog-line { margin: 0; }
</style>
