<script setup>
// Step 6: choose what to do.
//   Places near the meeting area for every category at once (Eat, Drink, Shop, Activity), 3 each to start; a filter
//   narrows the list and the map to one category. Anyone can add more (up to 6 per category) or search for a place.
//   One vote per person per category: voting for another place moves it, tapping your vote again takes it back.
//   The plan is made from the categories people voted in, laid out in the session window.
//   Step 7  "Confirm plan" once at least 2 people have voted.
// The list and the map show the same places, and the map has a key to the categories of the places on it.
// Distance (ticket #122): while voting, "Distance from <area>", one row of chips, Auto (the default) then 100 m to 3 km (Darius, 4 November
// 2026; it was an "Auto distance" switch and a slider). A tap saves it: the map draws the radius as a ring round the meeting area, and
// the places follow it: places outside drop out with their votes, and each category tops up again (lib/api.js setRadius). One short line
// under the chips says when places are few at that distance, with one "Widen to ..." far enough for every category.
// Search: one box at the top finds places to add, in the category the filter shows or in every category (each place goes to its own
// category's list). Clicking into it opens a panel: a "CDC vouchers only" toggle, then suggestions (the nearest places that fit) until
// something is typed, then what was found; the toggle applies to both (Faith, 31 October 2026). Under each category a down arrow adds
// more of the planner's places.
// "CDC vouchers" at the end of the filter row shows only the Eat and Drink places that take them, for this person; Shop and Activity stay.
// Weather: a card keeps its small rain mark (SuggestionCard), and one muted line under the list says where the forecast came
// from (WeatherSource); a simulated forecast also shows a banner at the top.
// Dietary needs (ticket #107): when the group has any, one line under Eat says which needs the places fit ("Showing places
// that fit halal and vegetarian"), with no names and no count. Food places are filtered strictly; when fewer than 3 fit, a
// line says so and offers "Show places we couldn't confirm", each then labelled on its card. "Only places that fit" goes back.
// The person's own needs start from their profile, already selected, with no question first (Faith's walkthrough, 30 October 2026: the
// "Confirm dietary needs" popup is gone). "Dietary needs" under the distance holds the chips (DietaryChips), saved at each tap, so
// the needs can be changed at any time; a change is for this outing only, and the profile is left as it is. A
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
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
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
import ClashDialog from '@/components/group/ClashDialog.vue'
import PriceTier from '@/components/ui/PriceTier.vue'
import ProgressDonut from '@/components/ui/ProgressDonut.vue'
import SegmentTabs from '@/components/ui/SegmentTabs.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import SplitView from '@/components/ui/SplitView.vue'
import TextField from '@/components/ui/TextField.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import PlaceDetail from '@/components/event/PlaceDetail.vue'
import SessionNotices from '@/components/event/SessionNotices.vue'
import DietaryChips from '@/components/event/DietaryChips.vue'
import SuggestionCard from '@/components/event/SuggestionCard.vue'
import WeatherSource from '@/components/weather/WeatherSource.vue'
import CategoryKey from '@/components/map/CategoryKey.vue'
import PlannerMap from '@/components/map/PlannerMap.vue'
import NotFoundView from './NotFoundView.vue'
import { watchSessions } from '@/lib/api.js'
import { CATEGORIES, CATEGORY_LABELS } from '@/lib/planner/slots.js'
import { distanceText } from '@/lib/planner/format.js'
import { ORDER_TABS, VOTED, confirmKey, confirmView, sourceIcon, sourceText, suggestedRows, votedRows, rowProblem as problemOf } from '@/lib/confirmOrder.js'
import { placeImage } from '@/lib/placeImages.js'
import { walkFromText } from '@/lib/cardText.js'
import { usePlaceDetail } from '@/lib/usePlaceDetail.js'
import { fewLine, fitLine, unfitDietText, unfitGroupNeedsText } from '@/lib/dietText.js'
import { confetti } from '@/lib/confetti.js'
import { mealWindow, MEAL_WINDOWS } from '@/lib/planner/timeOfDay.js'
import { isBehind } from '@/lib/stepNav.js'
import { CANCEL_OUTING } from '@/lib/session.js'
import { WORDS } from '@/lib/sessionsRemote.js'
import { useReturnFocus } from '@/lib/useReturnFocus.js'
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
// The search at the top: what was typed, the places found (each with the slot of its own category), and whether it is asking.
const finding = ref({ query: '', results: [], busy: false })
// The places ticked to add, kept across searches until they are added: [result]. How to call: ticked.value -> [{ id, slot, ... }]
const ticked = ref([])
const addingPicked = ref(false)
// The toggle at the top of the search's panel: only places that take CDC vouchers, in the suggestions and in what is found.
const cdcOnly = ref(false)
// The panel under the box (the toggle, then the suggestions or what was found) is open while the box or the panel has focus, or while
// something is typed. A press anywhere else closes it.
const findEl = ref(null)
const findFocused = ref(false)
// Escape shuts the panel while the box keeps focus; typing or moving focus into the box again opens it.
const findShut = ref(false)
const findOpen = computed(() => !findShut.value && (findFocused.value || !!finding.value.query.trim()))
const findPanelId = `find-panel-${useId()}`
// Escape in the box or the panel: close the panel and, from inside the panel, hand focus back to the box.
// How to call: <div @keydown.esc="onFindEscape">
function onFindEscape(event) {
  if (!findOpen.value) return
  findShut.value = true
  event.stopPropagation()
  if (!isInput(event.target)) findEl.value?.querySelector('input')?.focus()
}
const isInput = (el) => String(el?.tagName || el?.tag || '').toLowerCase() === 'input'
// Focus coming into the box from outside opens the panel again. How to call: <div @focusin="onFindFocusIn">
function onFindFocusIn(event) {
  if (!findFocused.value && isInput(event.target)) findShut.value = false
  findFocused.value = true
}
// Close the search: the panel shut, the box empty and no longer focused. How to call: closeFind()
function closeFind() {
  findShut.value = true
  findFocused.value = false
  finding.value.query = ''
  const input = findEl.value?.querySelector?.('input')
  if (input && globalThis.document?.activeElement === input) input.blur()
}
// What a screen reader hears as the search works: that it is looking, then how many places came back.
// How to call: findStatus.value -> '3 places found'
const findStatus = computed(() => {
  if (!findOpen.value) return ''
  const f = finding.value
  if (f.busy) return 'Searching…'
  const n = f.results.length
  if (f.query.trim()) return n ? `${n} ${n === 1 ? 'place' : 'places'} found` : 'No places found'
  return n ? `${n} suggested ${n === 1 ? 'place' : 'places'}` : ''
})
// How to call: <div @focusout="onFindFocusOut">
function onFindFocusOut(event) {
  if (event.relatedTarget && !findEl.value?.contains(event.relatedTarget)) findFocused.value = false
}
function onPagePointerDown(event) {
  if (findFocused.value && !findEl.value?.contains(event.target)) findFocused.value = false
}
onMounted(() => document.addEventListener('pointerdown', onPagePointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onPagePointerDown))
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
// The meetup in the way when coming back would put the person in two at once (the popup).
const rejoinClash = ref(null)
const showRejoinClash = ref(false)
// Rejoin is disabled while it runs, so it hands focus back when the popup closes.
const { remember: rememberRejoin } = useReturnFocus(showRejoinClash)
// Come back after opting out. How to call: rejoin()
async function rejoin() {
  rejoining.value = true
  error.value = ''
  try {
    await events.rejoin(props.id)
  } catch (e) {
    if (e?.code === 'schedule_clash') {
      rejoinClash.value = e.clash || null
      showRejoinClash.value = true
    } else {
      error.value = e.message
    }
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
// "CDC vouchers" beside the filter: Eat and Drink show only the places that take them (Faith, 31 October 2026). It is this person's view
// alone: nothing is saved, and Shop and Activity are left as they are. `cdcHidden` counts what a category hides.
const CDC_KINDS = ['eat', 'drink']
const cdcView = ref(false)
const takesCdc = (option) => (option.venue?.tags || []).includes('cdc')
const viewSlots = computed(() =>
  slots.value.map((s) => {
    if (!cdcView.value || !CDC_KINDS.includes(s.category)) return s
    const options = s.options.filter(takesCdc)
    return { ...s, options, cdcHidden: s.options.length - options.length }
  }),
)
const shown = computed(() => (filter.value ? viewSlots.value.filter((s) => s.category === filter.value) : viewSlots.value))
// Under All, categories with nothing nearby fold into one line instead of an empty section each. Eat left empty by the group's
// dietary needs keeps its section, which offers the places we could not confirm, as does a category the CDC filter emptied.
const keepsSection = (s) => s.options.length > 0 || !!s.dietFew || !!s.cdcHidden
const listed = computed(() => (filter.value ? shown.value : shown.value.filter(keepsSection)))
const emptyLabels = computed(() => (filter.value ? [] : shown.value.filter((s) => !keepsSection(s)).map((s) => CATEGORY_LABELS[s.category])))
const listJoin = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`)
const countOf = (category) => viewSlots.value.find((s) => s.category === category)?.options.length ?? 0
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

// Search the slots the filter shows (every category under All), each for places of its own category, so each place found is checked
// against its own slot's time and goes to its own list. Fitting places first, at most 12. With the CDC toggle on, only places that take
// CDC vouchers are asked for. With nothing typed while the panel is open, the suggestions: the nearest few places that fit, per category.
// How to call: await findPlaces('laksa')
let searchTimer = null
async function findPlaces(q) {
  const targets = filter.value ? slots.value.filter((s) => s.category === filter.value) : slots.value
  const browse = !q.trim() && findOpen.value
  if ((!q.trim() && !browse) || !targets.length) {
    finding.value = { query: q, results: [], busy: false }
    return
  }
  finding.value = { ...finding.value, busy: true }
  try {
    const cdc = cdcOnly.value
    // A suggestion is a place the group does not have yet: up to 4 a category.
    // Each list keeps where Google stood for it (`google`), which the filtering below would drop.
    const lists = await Promise.all(targets.map((slot) => planner.searchVenues(props.id, slot.id, q, { cdcOnly: cdc, browse }).then((rs) => Object.assign(rs.filter((r) => r.category === slot.category && !(browse && r.added)).slice(0, browse ? 4 : undefined).map((r) => ({ ...r, slot })), { google: rs.google ?? null }))))
    // Only the newest typing (and the toggle as it is now) applies; an answer for older text is dropped.
    if (finding.value.query !== q || cdcOnly.value !== cdc) return
    const results = lists.flat().sort((a, b) => Number(!!a.unfit) - Number(!!b.unfit)).slice(0, 12)
    // Google did not answer (its limit for the key, say): only the saved places were searched, and the panel says so.
    finding.value = { query: q, results, busy: false, googleDown: lists.some((l) => l.google === 'unavailable') }
    rowNote.value = {}
  } catch (e) {
    if (finding.value.query === q) finding.value = { ...finding.value, busy: false }
    error.value = e.message
  }
}
// Typing opens a panel Escape shut.
watch(() => finding.value.query, () => { findShut.value = false })
watch([() => finding.value.query, filter, cdcOnly, findOpen], ([q]) => {
  clearTimeout(searchTimer)
  // A short pause after typing, so each word typed costs one search (and at most one Google call), not one a letter.
  searchTimer = setTimeout(() => findPlaces(q), 400)
})
// A category that already has six places takes no more. How to call: slotFull(result.slot) -> true
const slotFull = (slot) => (slots.value.find((s) => s.id === slot?.id)?.options.length ?? 0) >= 6
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
// Each row of the search's panel has one button of one size: "Add", or "Added" once it is an option. "Added" can be pressed again to take
// the place back when this person added it and nobody else has voted for it (Faith, 31 October 2026). A refusal is said on the row
// itself, under the place's name, not at the top of the page. The row stays where it is after either, so a slip is undone in place.
const rowKey = (r) => `${r.slot.id}:${r.id}`
const rowNote = ref({})
const rowBusy = ref('')
// The option a result already is, if any. How to call: optionOf(result) -> { id, addedBy, voters, ... } | null
const optionOf = (r) => slots.value.find((s) => s.id === r.slot.id)?.options.find((o) => o.id === r.id) || null
// May this person take the place back? Theirs, and no one else's vote on it.
function canTakeBack(r) {
  const o = optionOf(r)
  return !!o && o.addedBy === auth.myId && !(o.voters || []).some((v) => v.id !== auth.myId)
}
const isTicked = (r) => ticked.value.some((p) => rowKey(p) === rowKey(r))
// A place can be ticked if it fits, is not a choice already, and its category has room for it with the others ticked for it.
function canPick(r) {
  if (r.unfit || r.added) return false
  const slot = slots.value.find((s) => s.id === r.slot.id)
  const tickedHere = ticked.value.filter((p) => p.slot.id === r.slot.id).length
  return (slot?.options.length ?? 0) + tickedHere < 6
}
// How to call: togglePick(result)
function togglePick(r) {
  if (r.added || addingPicked.value) return
  if (isTicked(r)) ticked.value = ticked.value.filter((p) => rowKey(p) !== rowKey(r))
  else if (canPick(r)) ticked.value = [...ticked.value, r]
}
// When nothing is typed, only the first few suggestions (Darius, 4 November 2026); a search shows everything it found.
const SUGGESTED_SHOWN = 5
// Places already in the vote are left out, so every row starts unticked (Darius, 4 November 2026: they showed as grey ticks).
const shownResults = computed(() => {
  const fresh = finding.value.results.filter((r) => !r.added)
  return finding.value.query.trim() ? fresh : fresh.slice(0, SUGGESTED_SHOWN)
})
// Add every ticked place, one after another. All in: the ticks clear and the search closes. One that fails keeps its tick and says why
// on its row (the ones before it are added), and the search stays open.
// How to call: await addPicked()
async function addPicked() {
  if (addingPicked.value || !ticked.value.length) return
  addingPicked.value = true
  error.value = ''
  try {
    for (const r of [...ticked.value]) {
      const key = rowKey(r)
      rowNote.value = { ...rowNote.value, [key]: '' }
      try {
        await planner.addOption(props.id, r.slot.id, r.id)
        r.added = true
        ticked.value = ticked.value.filter((p) => rowKey(p) !== key)
      } catch (e) {
        rowNote.value = { ...rowNote.value, [key]: e.message }
        return
      }
    }
    closeFind()
  } finally {
    addingPicked.value = false
  }
}
async function takeBack(result) {
  const key = rowKey(result)
  if (rowBusy.value) return
  rowBusy.value = key
  rowNote.value = { ...rowNote.value, [key]: '' }
  try {
    await planner.removeOption(props.id, result.slot.id, result.id)
    result.added = false
  } catch (e) {
    // Said at the top of the page: "Remove" is on the place's card now, not in the search.
    error.value = e.message
  } finally {
    rowBusy.value = ''
  }
}
// Nothing to suggest within the radius: how far that is, and (for whoever may change it) a way to look as far as 3 km.
const suggestReach = computed(() => radiusLabel(radius.value ?? 3000))
const canReachFurther = computed(() => canSetRadius.value && radius.value != null && radius.value < 3000)

// ── Search radius ──
// The choices, in metres; null is Auto (the planner starts at 500 m and looks further out until 3 places fit). One row of chips, Auto
// first (Darius, 4 November 2026; it was an "Auto distance" switch and a slider).
const RADII = [null, 100, 250, 500, 1000, 2000, 3000]
// How to call: radiusLabel(1000) -> '1 km'
const radiusLabel = (m) => (m == null ? 'Auto' : m >= 1000 ? `${m / 1000} km` : `${m} m`)
const radius = computed(() => plan.value?.radius ?? null)
// True while a change runs. The chips are `disabled` in ChipButton's sense: aria-disabled, still focusable, clicks ignored (a
// natively disabled button would lose keyboard focus and throw the person out to the page). The row is one Tab stop and the
// arrow keys choose, as the Show chips do (v-radio-group).
const settingRadius = ref(false)
// The newest value asked for while a save was running, as { metres }, or null. The slider keeps moving while a save runs, so its last
// value waits here and is saved next, never dropped (null metres is Auto, hence the wrapper).
let queuedRadius = null
// Save a radius. A value asked for while one is being saved waits and is saved after it (only the newest of them). The draft the slider
// and switch show is let go only once the plan has come back with the value it shows (the watch below): the plan is read again after the
// save ends, and letting go sooner showed the old value for half a second (Faith's recording, 4 November 2026). A failed save lets it go at
// once, so the slider shows what is really saved.
// How to call: await setRadius(1000)
async function setRadius(metres) {
  if (settingRadius.value) {
    queuedRadius = { metres }
    return
  }
  if (metres !== radius.value) {
    settingRadius.value = true
    error.value = ''
    try {
      await planner.setRadius(props.id, metres)
    } catch (e) {
      error.value = e.message
      if (draftRadius.value === metres) draftRadius.value = undefined
    } finally {
      settingRadius.value = false
    }
  } else if (draftRadius.value === metres) {
    draftRadius.value = undefined
  }
  const next = queuedRadius
  queuedRadius = null
  if (next) await setRadius(next.metres)
}
// The smallest choice that reaches `km`, for "Widen to ...". How to call: radiusFor(1.4) -> 2000
const radiusFor = (km) => RADII.find((m) => m != null && m >= km * 1000) ?? null
// How far the places may be, in words: the chosen radius, or the planner's own limit of 3 km under Auto.
const reachText = computed(() => radiusLabel(radius.value ?? 3000))
// The chip just tapped, shown as chosen (and the map's ring drawn at it) until the plan comes back with it saved.
const draftRadius = ref(undefined)
watch(radius, (saved) => {
  if (draftRadius.value === saved) draftRadius.value = undefined
})
const shownRadius = computed(() => (draftRadius.value !== undefined ? draftRadius.value : radius.value))
// A distance chip: it shows as chosen at once, and is saved (one request per tap). How to call: pickRadius(1000); pickRadius(null) for Auto
function pickRadius(metres) {
  if (settingRadius.value || metres === shownRadius.value) return
  draftRadius.value = metres
  setRadius(metres)
}
// One line for every category that is short of places within the radius, with one way to widen it: far enough for all of them (it was
// a "Widen to" under each category). How to call: shortOfPlaces.value -> { labels: ['Drink', 'Shop'], to: 3000 }
const shortOfPlaces = computed(() => {
  if (radius.value == null) return null
  const short = slots.value.filter((s) => (s.options.length ? s.few : !s.dietFew))
  if (!short.length) return null
  const km = Math.max(0, ...short.map((s) => (s.options.length ? s.few?.widenToKm : s.empty?.widenToKm) || 0))
  const to = km ? radiusFor(km) : null
  return { labels: short.map((s) => CATEGORY_LABELS[s.category]), to: to && to > radius.value ? to : null }
})

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

// The "Confirm dietary needs" dialog is not on this page any more (the needs start from the profile, and the chips below change them);
// DietaryConfirm.vue is kept for a later way in, and the page's code for it was removed on 1 November 2026.
// The change being saved, { mine, dropped }, or null. The tags and chips show it at once, while the places load behind them.
const pendingDiet = ref(null)
// Whether a chip change is being saved: the chips are off until it ends, so two taps never race.
const dietBusy = ref(false)
// The person's own needs and the dropped ones as the page shows them: the change being saved, else the outing's.
const shownMine = computed(() => pendingDiet.value?.mine ?? plan.value?.myDietary ?? [])
const shownDropped = computed(() => pendingDiet.value?.dropped ?? plan.value?.dietDropped ?? [])

// Asks again for the outing's dietary needs, by reading the plan again. A failure shows on the line again, so nothing else is said.
// How to call: await retryDiet()
async function retryDiet() {
  await planner.loadPlan(props.id, { quiet: true }).catch(() => {})
}

// A tap on the Vote page's dietary chips, saved at once: the person's own needs and the others' needs not to filter for.
// How to call: await saveDiet({ mine: ['halal'], dropped: [] })
async function saveDiet({ mine, dropped }) {
  if (dietBusy.value) return
  dietBusy.value = true
  pendingDiet.value = { mine, dropped }
  error.value = ''
  try {
    const answer = await refilter(() => planner.confirmDiet(props.id, mine, dropped, { confirmed: false }))
    if (answer?.syncError) error.value = answer.syncError
  } catch (e) {
    error.value = e.message
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
  if (slot.cdcHidden) return `None of these ${CATEGORY_LABELS[slot.category]} places take CDC vouchers. Search for one to add.`
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
// A shared session's voted order is the server's own: its stops in the order it will store them, at the starts it will store (laid out with
// the travel between them), so what the dialog shows is what is saved. The slots' own times are not those. Until the server has answered
// there is nothing to show, and Confirm waits for it.
const serverVoted = computed(() => (shared.value ? order.value?.answer?.voted ?? null : null))
const votedList = computed(() => (shared.value ? suggestedRows({ stops: serverVoted.value ?? [] }) : votedRows(winners.value)))
const orderReady = computed(() => !shared.value || !!serverVoted.value)
const orderKey = computed(() => confirmKey(winners.value, session.value, planner.conditions?.rain))
// The answer to this question, once asked: its loading flag and its suggestion.
const order = computed(() => {
  const entry = events.orders[props.id]
  return confirmOpen.value && entry && entry.key === orderKey.value ? entry : null
})
const suggesting = computed(() => confirmOpen.value && (!order.value || order.value.loading))
const orderView = computed(() => confirmView({ voted: votedList.value, suggestion: order.value?.answer ?? null, picked: picked.value }))
// What is wrong with a stop in the dialog, if anything: the place is closed for its time (by the venue's listed hours), or it ends after the
// session does. A warning, not a block: the host can still confirm ("Confirm anyway") and change stops on the itinerary (Darius, 4 November
// 2026: these showed only after confirming). How to call: rowProblem(row) -> 'Ends after 18:00' | 'Closed at this time' | ''
const venueOfRow = (row) => winners.value.find((w) => w.option?.venue?.id === row.venueId)?.option?.venue || null
const rowProblem = (row) => problemOf(row, venueOfRow(row), session.value?.end)
const problemCount = computed(() => orderView.value.rows.filter((row) => rowProblem(row)).length)
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
    <SessionHeader :session="session" :change-plan="!replaceMode" />

    <div class="screen__body">
      <p class="sr-only" role="status">{{ loadingSaid }}</p>
      <SessionNotices :session="session" />
      <BannerNote v-if="planError" tone="error" icon="warning" role="alert" data-testid="plan-error">
        {{ planError }}
        <template #actions>
          <AppButton small variant="secondary" :disabled="!!planner.loading[id]" @click="load">Try again</AppButton>
        </template>
      </BannerNote>

      <WeatherSource v-if="plan?.weather && session.meeting" :block="plan.weather" banner />

      <BannerNote v-if="optedOut && ['voting'].includes(session.status)" icon="info" data-testid="opted-out">
        You opted out of this session, so you can't vote and your trips are not counted.
        <template #actions><AppButton small variant="secondary" :disabled="rejoining" @click="rememberRejoin($event); rejoin()">Rejoin</AppButton></template>
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

        <!-- One filter for the list and the map, and the CDC toggle for Eat and Drink. -->
        <div class="filter scroll-x">
          <div class="filter__set" role="radiogroup" v-radio-group aria-label="Show">
            <ChipButton radio :selected="!filter" @click="filter = ''">All</ChipButton>
            <ChipButton v-for="c in CATEGORIES" :key="c" radio :selected="filter === c" :aria-label="`${CATEGORY_LABELS[c]}, ${countOf(c)} places`" @click="filter = c">
              <template #leading><CategoryIcon :category="c" :size="24" /></template>
              {{ CATEGORY_LABELS[c] }}<span class="filter__count tnum">{{ countOf(c) }}</span>
            </ChipButton>
          </div>
          <span class="filter__rule" aria-hidden="true"></span>
          <ChipButton check :selected="cdcView" title="Eat and Drink show only places that take CDC vouchers" aria-label="CDC-friendly: only places that take CDC vouchers in Eat and Drink" data-testid="list-cdc" @click="cdcView = !cdcView">CDC-friendly</ChipButton>
        </div>

        <!-- Search for a place to add, in the category the filter shows (or every category). -->
        <div v-if="voting && slots.length && !optedOut" ref="findEl" class="find" data-testid="place-search" @focusin="onFindFocusIn" @focusout="onFindFocusOut" @keydown.esc="onFindEscape">
          <TextField v-model="finding.query" :label="filter ? `Search ${CATEGORY_LABELS[filter]} places` : 'Search places'" hide-label :placeholder="filter ? `Search ${CATEGORY_LABELS[filter]} places to add` : 'Search places to add'" type="search" inputmode="search" autocomplete="off" role="combobox" aria-autocomplete="list" :aria-expanded="findOpen ? 'true' : 'false'" :aria-controls="findPanelId">
            <template #leading><AppIcon name="search" :size="18" /></template>
          </TextField>
          <!-- Open while the box is in use: the CDC toggle on top, then suggestions (nothing typed) or what was found. -->
          <p class="sr-only" role="status" data-testid="search-status">{{ findStatus }}</p>
          <div v-if="findOpen" :id="findPanelId" class="find__panel" data-testid="search-panel">
            <div class="find__filters">
              <ChipButton check :selected="cdcOnly" data-testid="search-cdc" @click="cdcOnly = !cdcOnly">Search CDC vouchers only</ChipButton>
            </div>
            <p v-if="!finding.query.trim() && finding.results.length" class="caption text-muted find__caption">Suggested near {{ session.area.name }}</p>
          <!-- Pick, then add (Darius, 4 November 2026, in the style of "Invite friends"): each place has a circle to tick, the ticks are kept
               across searches, and one "Add" at the foot adds them all and closes the search. Until something is typed, a few suggestions.
               Places already in the vote are not listed; one you added is taken back from its card ("Remove"). -->
          <ul v-if="shownResults.length" class="add-results" :aria-label="finding.query.trim() ? 'Places found' : 'Suggested places'">
            <li v-for="r in shownResults" :key="rowKey(r)" class="add-row" :class="{ 'has-note': rowNote[rowKey(r)], 'is-ticked': isTicked(r) }">
              <button
                type="button"
                class="add-row__pick"
                role="checkbox"
                :aria-checked="isTicked(r) ? 'true' : 'false'"
                :aria-disabled="!isTicked(r) && !canPick(r) ? 'true' : undefined"
                :aria-label="r.name"
                :data-testid="`pick-${r.id}`"
                @click="togglePick(r)"
              >
                <CategoryIcon :category="r.category" :size="32" />
                <span class="add-row__text">
                  <span class="title-sm truncate">{{ r.name }}</span>
                  <span v-if="r.unfit" class="caption-sm text-error">{{ unfitText(r, r.slot) }}</span>
                  <span v-else-if="!isTicked(r) && !canPick(r)" class="caption-sm text-muted">{{ CATEGORY_LABELS[r.category] }} already has 6 places</span>
                  <span v-else class="caption-sm text-muted">{{ CATEGORY_LABELS[r.category] }} · about {{ r.walk }} min walk<template v-if="r.cdc"> · CDC vouchers</template></span>
                  <span v-if="rowNote[rowKey(r)]" class="add-row__note body-sm text-error" role="alert"><AppIcon name="warning" :size="16" />{{ rowNote[rowKey(r)] }}</span>
                </span>
                <span class="add-row__tick" :class="{ 'is-on': isTicked(r) }" aria-hidden="true"><AppIcon v-if="isTicked(r)" name="check" :size="14" /></span>
              </button>
            </li>
          </ul>
          <p v-else-if="finding.query.trim() && !finding.busy" class="body-sm text-muted">No new places{{ cdcOnly ? ' that take CDC vouchers' : '' }} match "{{ finding.query.trim() }}".</p>
          <p v-if="finding.query.trim() && finding.googleDown && !finding.busy" class="caption-sm text-muted find__note" role="status" data-testid="google-down"><AppIcon name="info" :size="14" /><span>Google isn't answering right now, so only Jio's saved places were searched. <AppButton variant="tertiary" underline small data-testid="search-again" @click="findPlaces(finding.query)">Search again</AppButton></span></p>
          <p v-else-if="!finding.busy" class="few-line" data-testid="suggest-none">
            <span class="body-sm text-muted">No places{{ cdcOnly ? ' that take CDC vouchers' : '' }} to suggest within {{ suggestReach }} of {{ session.area.name }}. Type a name to search.</span>
            <AppButton v-if="canReachFurther" variant="tertiary" underline small :disabled="settingRadius" @click="setRadius(3000)">Look within 3 km</AppButton>
          </p>
          <!-- One button adds every ticked place. -->
          <div class="find__foot">
            <AppButton block :disabled="!ticked.length || addingPicked" :aria-busy="addingPicked ? 'true' : undefined" data-testid="add-picked" @click="addPicked">{{ ticked.length > 1 ? `Add ${ticked.length} places` : 'Add' }}</AppButton>
          </div>
          </div>
        </div>

        <!-- How far from the meeting area places may be. The map shows it as a ring. -->
        <div v-if="voting && slots.length && !canSetRadius" class="radius" data-testid="radius-readonly">
          <span class="caption text-muted">Search within</span>
          <span class="body-sm">{{ radius == null ? 'Auto' : radiusLabel(radius) }} of {{ session.area.name }}, set by {{ hostName }}.</span>
        </div>
        <!-- One row of choices (Darius, 4 November 2026: the "Auto distance" switch and the slider were confusing): Auto, or a distance.
             A tap saves it. -->
        <div v-else-if="voting && slots.length" class="radius" data-testid="radius">
          <span class="caption text-muted">Distance from {{ session.area.name }}</span>
          <div class="scroll-x radius__chips" role="radiogroup" v-radio-group :aria-label="`Distance from ${session.area.name}`" :aria-busy="settingRadius ? 'true' : undefined" data-testid="radius-chips">
            <ChipButton v-for="m in RADII" :key="m ?? 'auto'" radio :selected="shownRadius === m" :disabled="settingRadius" :title="m == null ? 'Jio looks further out until 3 places fit, up to 3 km' : undefined" @click="pickRadius(m)">{{ radiusLabel(m) }}</ChipButton>
          </div>
          <!-- Short of places at this distance: said once, with one way to widen far enough. -->
          <p v-if="shortOfPlaces" class="few-line" data-testid="radius-short">
            <span class="caption-sm text-muted">Few places within {{ radiusLabel(radius) }}.</span>
            <AppButton v-if="shortOfPlaces.to" variant="tertiary" underline small :disabled="settingRadius" data-testid="radius-widen" @click="setRadius(shortOfPlaces.to)">Widen to {{ radiusLabel(shortOfPlaces.to) }}</AppButton>
          </p>
        </div>

        <!-- The outing's dietary needs, laid out like "Search within": the label with the needs selected below as tags, then the
             Halal, Vegetarian and Vegan chips the places are filtered by. A tap saves at once; taking off a need someone else has
             is the host's alone, and asks first (DietaryChips). -->
        <!-- The server could not say what the outing needs (a failure, or the limit): the last answer stays on the page, and this says so. -->
        <p v-if="voting && plan?.dietUnavailable" class="diet-unavailable caption-sm text-muted" role="status" data-testid="diet-unavailable">
          Couldn't load the group's dietary needs.
          <AppButton variant="tertiary" underline small :disabled="loading" data-testid="diet-retry" @click="retryDiet">Try again</AppButton>
        </p>
        <div v-if="voting && plan?.myDietary" class="diet-edit" data-testid="diet-edit">
          <span class="caption text-muted">Dietary needs</span>
          <DietaryChips :mine="shownMine" :others="plan.othersDietary || []" :dropped="shownDropped" :can-drop="isHost" :busy="dietBusy" @change="saveDiet" />
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

              <p v-if="slot.cdcHidden && slot.options.length" class="caption-sm text-muted" data-testid="cdc-hidden">Only places that take CDC vouchers. {{ slot.cdcHidden }} {{ slot.cdcHidden === 1 ? 'other is' : 'others are' }} hidden.</p>
              <template v-if="!slot.options.length">
                <p class="body-sm text-muted">{{ emptyText(slot) }}</p>
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
                    :removable="voting && !optedOut && canTakeBack({ slot, id: option.id })"
                    @vote="vote(slot, $event)"
                    @swap="swap(slot, $event)"
                    @open="openReviews"
                    @remove="takeBack({ slot, id: option.id, name: option.venue.name })"
                  />
                </div>

                <div v-if="voting && !optedOut && slot.options.length < 6 && slot.canAddMore" class="slot__more">
                  <button type="button" class="more-arrow" :disabled="loadingMore === slot.id" :aria-busy="loadingMore === slot.id ? 'true' : undefined" :aria-label="`More ${CATEGORY_LABELS[slot.category]} places`" :title="`More ${CATEGORY_LABELS[slot.category]} places`" :data-testid="`more-${slot.category}`" @click="more(slot)">
                    <AppIcon name="chevron-down" :size="20" />
                  </button>
                </div>
              </template>
            </section>
            <p v-if="!loading && slots.length && emptyLabels.length" class="body-sm text-muted">No {{ listJoin(emptyLabels) }} places within {{ reachText }} of {{ session.area.name }} yet.</p>
            <WeatherSource v-if="!loading && slots.length && plan?.weather" :block="plan.weather" />
          </template>

          <template #map>
            <PlannerMap :area="session.area" :places="mapPlaces" :radius="voting ? shownRadius || 0 : 0" :selected="selected" label="Places map" @select="selected = $event" />
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

    <ClashDialog v-model:open="showRejoinClash" :clash="rejoinClash" mode="join" />

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
              <span v-if="rowProblem(row)" class="winners__warn caption-sm text-error" data-testid="confirm-warning"><AppIcon name="warning" :size="12" />{{ rowProblem(row) }}</span>
            </span>
          </li>
        </ul>
        <p class="order-note caption-sm text-muted" :class="{ 'order-note--held': suggesting || !!orderView.note }" role="status">
          <template v-if="orderView.note">
            <AppIcon :name="sourceIcon(orderView.note)" :size="14" />
            <span>{{ sourceText(orderView.note) }}</span>
          </template>
        </p>
        <p v-if="shared && order?.failed" class="order-failed caption-sm text-muted" data-testid="order-failed">
          {{ order.refusal || 'Could not get the order of the stops.' }}
          <AppButton variant="tertiary" underline small data-testid="order-retry" @click="retryOrder">Try again</AppButton>
        </p>
        <!-- A live region that is on the page from the start, empty, so that what is put in it is announced; it takes no room until it has words. -->
        <p v-if="shared" :class="staleNote ? 'caption-sm text-muted dialog-line' : 'sr-only'" role="status" data-testid="order-stale">{{ staleNote }}</p>
        <p v-if="confirmError" class="body-sm text-error dialog-line" role="alert" data-testid="confirm-error">{{ confirmError }}</p>
      </template>
      <p v-if="problemCount" class="body-sm text-error dialog-line" data-testid="confirm-problems">{{ problemCount === 1 ? '1 stop has a problem.' : `${problemCount} stops have problems.` }} You can change stops on the itinerary after confirming.</p>
      <AppButton block :disabled="busy || !orderReady" @click="confirm">{{ problemCount ? 'Confirm anyway' : 'Confirm' }}</AppButton>
      <AppButton block variant="secondary" @click="confirmOpen = false">Not yet</AppButton>
    </ModalDialog>

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
/* The switch (its name and the line under it), then the slider with its own name: spaced so they read as two things. */
.radius { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.few-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); margin: 0; }
/* The filter: one row of chips, scrolling sideways on a phone. */
.filter { display: flex; align-items: center; gap: var(--spacing-sm); }
.filter__set { display: flex; gap: var(--spacing-sm); }
.filter__rule { flex: 0 0 1px; align-self: stretch; margin-block: var(--spacing-sm); background: var(--hairline); }
.filter__count { margin-left: var(--spacing-xs); opacity: 0.6; }
/* Every chip in the row the same height, the ones with a category icon and the ones without (Darius, 4 November 2026). */
.filter :deep(.chip__pill) { height: 40px; }
.walk-from { margin: 0; }
.diet-line { margin: 0; }
/* "Group dietary needs": the same stack as "Search within" above it; the label and the selected needs share a line. */
.diet-unavailable { display: flex; align-items: center; flex-wrap: wrap; gap: var(--spacing-xs); margin: 0; }
.diet-edit { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.slot { display: flex; flex-direction: column; gap: var(--spacing-md); }
.slot + .slot { padding-top: var(--spacing-lg); }
.slot__head { display: flex; align-items: center; gap: var(--spacing-md); }
.slot__options { display: flex; flex-direction: column; gap: var(--spacing-md); }
/* More places: a round down arrow under the category's cards. */
.slot__more { display: flex; justify-content: center; }
.more-arrow { display: inline-flex; align-items: center; justify-content: center; width: var(--tap-min); height: var(--tap-min); border: 1px solid var(--hairline); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
@media (hover: hover) { .more-arrow:not(:disabled):hover { border-color: var(--ink); background: var(--surface-soft); } }
.more-arrow:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.more-arrow:disabled { opacity: 0.5; cursor: progress; }
/* The search at the top and what it found, in one column no wider than the cards. */
.find { display: flex; flex-direction: column; gap: var(--spacing-xs); max-width: 560px; }
/* The search box in the style of "Invite friends": a soft grey pill with no border, and a 2px ink ring on focus (Darius,
   4 November 2026). */
.find :deep(.field__input) { height: 44px; padding: 0 var(--spacing-md) 0 42px; border: 0; border-radius: var(--rounded-full); background: var(--surface-soft); font: var(--text-body-sm); }
.find :deep(.field__input:focus) { padding: 0 var(--spacing-md) 0 42px; border: 0; box-shadow: 0 0 0 2px var(--ink); }
.find :deep(.field__lead) { left: var(--spacing-md); }
.find__filters { display: flex; flex-wrap: wrap; gap: 0 var(--spacing-sm); }
.find__panel { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.find__caption { margin: 0; }
.find__note { display: flex; align-items: flex-start; gap: var(--spacing-xs); margin: 0; }
.find__note :deep(svg) { flex-shrink: 0; margin-top: 2px; }
.empty-wrap { padding-top: var(--spacing-lg); }
.empty-actions { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
.confirm-next { margin: 0 0 var(--spacing-sm); text-align: center; }
/* Replace: the stop being replaced, above the places that could take its place. */
/* White with a thin grey border, not a grey fill; the bold ink outline is for things that are selected (Darius, 4 November 2026). */
.replace { display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-base); border: 1px solid var(--border-strong); border-radius: var(--rounded-md); background: var(--canvas); }
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
.winners__warn { display: inline-flex; align-items: center; gap: var(--spacing-xxs); }
.winners__row { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: var(--spacing-md); }
.add-results { display: flex; flex-direction: column; }
.add-row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 64px; }
.add-row + .add-row { border-top: 1px solid var(--hairline-soft); }
.add-row.has-note { align-items: flex-start; padding-block: var(--spacing-sm); }
.add-row__note { display: flex; align-items: flex-start; gap: var(--spacing-xs); }
.add-row__note :deep(svg) { flex-shrink: 0; margin-top: 2px; }
/* One size for every row's button, whatever it says. */
.find__foot { position: sticky; bottom: 0; padding: var(--spacing-sm) 0 var(--spacing-xs); background: var(--canvas); }
/* A place to tick: the whole row is the button, its circle on the right, as on "Invite friends". */
.add-row__pick { display: flex; flex: 1 1 0; align-items: center; gap: var(--spacing-md); min-width: 0; min-height: 64px; margin: 0; padding: var(--spacing-xs) 0; border: 0; background: transparent; color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.add-row__pick[aria-disabled="true"] { cursor: default; }
.add-row__pick:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: var(--rounded-sm); }
.add-row__tick { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 2px solid var(--border-strong); border-radius: var(--rounded-full); background: var(--canvas); color: var(--on-selected); }
.add-row__tick.is-on { border-color: var(--selected); background: var(--selected); }
/* A place that cannot be ticked (its category is full, or it does not fit): a faded circle. */
.add-row__pick[aria-disabled="true"] .add-row__tick { opacity: 0.4; }
.add-btn.btn { flex-shrink: 0; min-width: 92px; justify-content: center; gap: var(--spacing-xs); }
/* "Added": an ink outline with a tick, quieter than "Add" (a dark pill) and never red. Its disabled state (already a choice, or someone
   else voted for it) keeps the muted words at 5.4:1 on white, not the grey of a switched-off button. */
.add-btn.btn.is-added { background: var(--canvas); color: var(--ink); box-shadow: inset 0 0 0 1.5px var(--ink); }
.add-btn.btn.is-added:not(:disabled):active { background: var(--surface-strong); }
.add-btn.btn.is-added:disabled { background: var(--canvas); color: var(--muted); box-shadow: inset 0 0 0 1.5px var(--border-control); }
@media (hover: hover) { .add-btn.btn.is-added:not(:disabled):hover { background: var(--surface-soft); } }
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
