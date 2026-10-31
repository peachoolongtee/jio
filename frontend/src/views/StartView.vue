<script setup>
// What the host sees after pressing Start session: how to pick the meeting point (the Start choice). The session is still inviting
// until the main button is pressed, so going back loses nothing.
//   /sessions/:id/start               two cards, "Find the fairest spot" (the default) and "We already know where", and a main
//                                     button named for the choice. The fairest spot starts the session (everyone shares where they
//                                     start); "We already know where" goes on to the follow-up.
//   /sessions/:id/start?where=1       the follow-up: search for an area or tap a popular one, or "We're here now" (the browser's
//                                     location, turned into the nearest area; only the area is kept). The button reads "Meet at
//                                     <area>". It starts the session with the choice saved as 'known', names the area through the
//                                     known place (events.setKnownPlace), and takes the host on to choosing places.
// The choice is saved with the start (sessions.meet_by), so every guest sees it. The step is in the address, so the browser's back
// button and a reload both work; the cards' choice is kept while the page is open.
// With the prop `change` (the route /sessions/:id/change-place) the same two screens serve the host who is changing the meeting place after it was
// set: the session is voting or confirmed (not inviting), the cards are the same, the main buttons say what they do ("Work out the spots again",
// "Meet at <area>"), nothing is changed until the last button (events.changeMeetingPlace: the votes, the places to vote on and the plan are cleared,
// everyone's starts are kept), and the back arrow goes to the Vote or Itinerary screen the host came from.
// The host of a session still choosing where to meet (locating) reaches the follow-up from Locate's "Pick the place yourself"
// (/sessions/:id/change-place?where=1; walkthrough, 30 October 2026, in place of Locate's own "We already have a place"). There the
// area is set as the known place (events.setKnownPlace, which is what that button did): nothing was voted on yet, so nothing is
// released, and back goes to Locate.
// Loading, not found and failed loads have their own states. A person who is not the host, or a session that has gone past inviting, goes
// back to the session page. If the follow-up fails after the session has started (the choice is already saved), this page stays open on
// the follow-up, and pressing the button again names the area without starting twice.
// "We're here now" cannot open "What next?" (Roam needs a confirmed plan on the day), so it sets the nearest area as the known place and
// goes to choosing places. If location is off, a sentence says so and the area chips still work.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import TextField from '@/components/ui/TextField.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import InviteDialog from '@/components/group/InviteDialog.vue'
import ChoiceCard from '@/components/start/ChoiceCard.vue'
import NotFoundView from './NotFoundView.vue'
import * as api from '@/lib/api.js'
import { AREAS } from '@/lib/mock/places.js'
import { vRadioGroup } from '@/lib/radioGroup.js'
import { CHANGE_HEAD, CHANGE_NOTE, CHOICES, START_NOTE, WHERE_NOTE, areaHere, changeLabel, findAreas, startLabel, whereLabel } from '@/lib/startChoice.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ id: { type: String, required: true }, change: { type: Boolean, default: false } })

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const events = useEventsStore()

const missing = ref(false)
const loadError = ref('')
// A save is running (the start, the known place, or asking for the location). The guard below waits for it.
const busy = ref(false)
// The save finished and this page is about to hand over to the next one: the guard below leaves it alone.
const leaving = ref(false)
const error = ref('')
// The card chosen on the first screen, and on the follow-up the area chosen ('here' is "We're here now"; '' is none yet). The search box
// holds the chosen area's name, so a chosen area is never hidden behind an empty box (Faith, 31 October 2026).
const choice = ref('fairest')
const where = ref('')
const query = ref('')
const heading = ref(null)

const session = computed(() => events.byId[props.id])
const isHost = computed(() => !!session.value && session.value.hostId === auth.myId)
const step = computed(() => (route.query.where ? 'where' : 'how'))
const hereNow = computed(() => where.value === 'here')
const chosenArea = computed(() => AREAS.find((a) => a.id === where.value) || null)
// Is the box a search? Not when it is empty or holds the chosen area's name as it was picked.
const searching = computed(() => {
  const q = query.value.trim().toLowerCase()
  return !!q && q !== chosenArea.value?.name.toLowerCase()
})
// The areas the follow-up lists: the popular ones, or only what the search finds.
const areas = computed(() => findAreas(searching.value ? query.value : ''))
// With no search, every other area follows the popular ones, so the whole list is on the page.
const otherAreas = computed(() => (searching.value ? [] : AREAS.filter((a) => !areas.value.some((x) => x.id === a.id)).sort((a, b) => a.name.localeCompare(b.name))))
// Nothing matches the search.
const noMatch = computed(() => searching.value && areas.value.length === 0)
// Tap an area: it is chosen, and its name goes into the box. How to call: pick({ id: 'jurong-east', name: 'Jurong East' })
function pick(area) {
  where.value = area.id
  query.value = area.name
}
// Typing something the chosen area's name no longer contains (or emptying the box) lets the choice go, so the button never names an
// area the box does not show.
watch(query, (q) => {
  const name = chosenArea.value?.name.toLowerCase()
  if (name && !(q.trim() && name.includes(q.trim().toLowerCase().replace(/\s+/g, ' ')))) where.value = ''
})

async function load() {
  missing.value = false
  loadError.value = ''
  try {
    await events.loadSession(props.id)
  } catch (err) {
    if (err?.code === 'not_found') missing.value = true
    else loadError.value = err?.message || 'The session could not be loaded.'
  }
}
// A shared session changes under this page (someone leaves, the host starts it on another device): it is read again as it happens.
// The host left this page (Back, or any other link) while something was pending, such as the browser's question about their location:
// a late answer must not start the session or take them on to another page.
let cancelled = false
onBeforeUnmount(() => { cancelled = true })
let stopWatching = () => {}
onMounted(() => {
  stopWatching = api.watchSessions()
  load()
})
onBeforeUnmount(() => stopWatching())
watch(() => props.id, load)

const sessionPath = computed(() => `/sessions/${props.id}`)
// This page's own address, and where the host came from (the Itinerary for a plan, the Vote screen before it).
const pagePath = computed(() => `${sessionPath.value}/${props.change ? 'change-place' : 'start'}`)
const cameFrom = computed(() => (session.value?.status === 'locating' ? sessionPath.value : `${sessionPath.value}/${session.value?.status === 'confirmed' ? 'itinerary' : 'plan'}`))
// The host came from Locate's "Pick the place yourself": the session is still choosing where to meet.
const fromLocate = computed(() => props.change && session.value?.status === 'locating')
// The host came from the Locate page's "Change meeting spot" dialog (`?from=locate`): back goes there, not to Vote.
const backToLocate = computed(() => props.change && route.query.from === 'locate')
// Who may be here: the host of a session that is inviting (however many are in: the page says when a second person is needed), or that
// started with "We already know where" and has not got its area yet (a retry). Everyone else belongs on the session page. Not while a save
// is running: it moves the session on itself.
const allowed = computed(() => {
  const s = session.value
  if (!s || !isHost.value) return false
  if (props.change) return ['voting', 'confirmed'].includes(s.status) || (s.status === 'locating' && step.value === 'where')
  if (s.status === 'inviting') return true
  return s.status === 'locating' && s.meetBy === 'known' && step.value === 'where'
})
watch([session, allowed, busy, leaving], () => {
  if (session.value && !busy.value && !leaving.value && !allowed.value) router.replace(sessionPath.value)
})

// A session starts with two people in. Until then (the host came on without inviting, or the invites are still waiting) the page says so,
// with the way to invite, and its button waits.
const tooFew = computed(() => session.value?.status === 'inviting' && (session.value.activeIds || []).length < 2)
const waitingInvites = computed(() => (session.value?.members || []).filter((m) => m.state === 'invited').length)
const inviteOpen = ref(false)

// Move focus to the new screen's heading when the step changes, so a keyboard or screen reader user lands on the question.
watch(step, async () => {
  await nextTick()
  heading.value?.focus?.({ preventScroll: true })
})

// The back button at the top left: from the follow-up to the choice, from the choice to the session's page.
const back = computed(() => (backToLocate.value ? sessionPath.value : step.value === 'where' && !fromLocate.value ? pagePath.value : props.change ? cameFrom.value : sessionPath.value))

// Run a save with the busy flag on; the flag is cleared whatever happens, and a failure is the screen's error line.
// How to call: await run(() => events.start(props.id, { meetBy: 'fairest' }))
async function run(fn) {
  if (busy.value) return false
  busy.value = true
  error.value = ''
  try {
    await fn()
    return true
  } catch (e) {
    error.value = e.message
    // The change went through as far as releasing the meeting area (only the naming of the new area failed): the session is locating again, so
    // this page is no longer the host's. They go to Locate, where the store shows what went wrong and "Pick the place yourself" finishes it.
    if (e?.released) {
      leaving.value = true
      router.replace(sessionPath.value)
    }
    return false
  } finally {
    busy.value = false
  }
}

// Is this page still the one on screen, so a finished save may take the host on? False once it was left.
// How to call: if (stillHere()) await router.replace(...)
const stillHere = () => !cancelled && router.currentRoute.value.path === pagePath.value

// The main button of the first screen. The fairest spot starts the session and the host stays on its page, now the Locate step; the
// other choice goes on to the follow-up without saving anything yet.
// How to call: choose()
async function choose() {
  if (choice.value === 'known') {
    error.value = ''
    await router.push({ path: pagePath.value, query: { where: '1' } })
    return
  }
  const ok = await run(async () => {
    // Changing: the new spots are worked out, and the spot the group had stays on the list to vote on.
    if (props.change) await events.chooseSpotAgain(props.id, 'vote')
    else await events.start(props.id, { meetBy: 'fairest' })
    leaving.value = true
  })
  if (ok && stillHere()) await router.replace(sessionPath.value)
}

// The main button of the follow-up: the area (or the nearest area to where the person is) becomes the known place, and the group goes on
// to choosing places. The location is asked for first, so a refusal starts nothing. The exact place is never kept: only the area is saved.
// How to call: meet()
async function meet() {
  let done = false
  const ok = await run(async () => {
    const areaId = hereNow.value ? (await areaHere(typeof navigator === 'undefined' ? null : navigator.geolocation, api.placeFromCoords)).areaId : where.value
    // The host went back while the browser was asking: nothing is started.
    if (cancelled) return
    if (fromLocate.value) {
      await events.setKnownPlace(props.id, areaId)
    } else if (props.change) {
      await events.changeMeetingPlace(props.id, { meetBy: 'known', areaId })
    } else {
      if (session.value?.status === 'inviting') await events.start(props.id, { meetBy: 'known' })
      await events.setKnownPlace(props.id, areaId)
    }
    done = true
    leaving.value = true
  })
  if (ok && done && stillHere()) await router.replace(`${sessionPath.value}/plan`)
}

const primary = computed(() => (step.value === 'how' ? (props.change ? changeLabel(choice.value) : startLabel(choice.value)) : whereLabel(chosenArea.value, hereNow.value)))
const note = computed(() => (props.change ? CHANGE_NOTE : step.value === 'how' ? START_NOTE : WHERE_NOTE))
const onPrimary = () => (step.value === 'how' ? choose() : meet())
const primaryOff = computed(() => busy.value || tooFew.value || (step.value === 'where' && !hereNow.value && !chosenArea.value))
const primaryText = computed(() => (busy.value ? (step.value === 'where' && hereNow.value ? 'Finding where you are…' : 'Saving…') : primary.value))
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else-if="session && (allowed || busy || leaving)" class="screen" data-testid="start-view">
    <SessionHeader :session="session" :back="back" />

    <div class="screen__body">
      <!-- 1. How to pick the meeting point. -->
      <template v-if="step === 'how'">
        <div class="head">
          <h2 ref="heading" tabindex="-1" class="display-sm">{{ change ? CHANGE_HEAD.title : 'How do you want to pick the meeting point?' }}</h2>
          <p v-if="change" class="body-sm text-muted">{{ CHANGE_HEAD.text }}</p>
        </div>
        <BannerNote v-if="tooFew" icon="people" data-testid="start-too-few">
          {{ waitingInvites ? 'Waiting for your friends to accept. The session can start once one of them joins.' : 'Only you are in so far. Invite at least one friend to start the session.' }}
          <template #actions><AppButton variant="secondary" small @click="inviteOpen = true"><AppIcon name="user-plus" :size="16" />Invite</AppButton></template>
        </BannerNote>
        <div class="choices choices--cards" role="radiogroup" v-radio-group aria-label="How to pick the meeting point">
          <ChoiceCard v-for="c in CHOICES" :key="c.key" :selected="choice === c.key" :disabled="busy" :icon="c.icon" @click="choice = c.key">
            <template #title>{{ c.title }}</template>
            <template v-if="c.tag" #tag>{{ c.tag }}</template>
            <template #text>{{ c.text }}</template>
            <template #meta>{{ c.meta }}</template>
          </ChoiceCard>
        </div>
      </template>

      <!-- 2. "We already know where": the area, or where the host is now. -->
      <template v-else>
        <div class="head">
          <h2 ref="heading" tabindex="-1" class="display-sm">Pick the meeting area</h2>
          <p v-if="change && !fromLocate" class="body-sm text-muted">The group then votes on places around it. Votes and the plan are cleared.</p>
        </div>
        <div class="start__search">
          <TextField v-model="query" label="Search for an area" placeholder="Bishan, Tampines, Jurong East" type="text" autocomplete="off" enterkeyhint="search" :maxlength="40">
            <template #leading><AppIcon name="search" :size="18" /></template>
          </TextField>
        </div>
        <div class="choices" role="radiogroup" v-radio-group :aria-label="searching ? 'Areas that match' : 'Popular areas'">
          <p class="caption text-muted" aria-hidden="true">{{ searching ? 'Areas that match' : 'Popular areas' }}</p>
          <div class="chips">
            <ChipButton v-for="a in areas" :key="a.id" radio :selected="where === a.id" :disabled="busy" @click="pick(a)">{{ a.name }}</ChipButton>
          </div>
          <p v-if="noMatch" class="body-sm text-muted" role="status">No area matches that. Try the start of its name.</p>
          <template v-if="otherAreas.length">
            <p class="caption text-muted" aria-hidden="true">All areas</p>
            <div class="chips">
              <ChipButton v-for="a in otherAreas" :key="a.id" radio :selected="where === a.id" :disabled="busy" @click="pick(a)">{{ a.name }}</ChipButton>
            </div>
          </template>
        </div>
      </template>

      <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    </div>

    <footer class="screen__footer">
      <p v-if="note" class="caption-sm text-muted start__note">{{ note }}</p>
      <AppButton class="start__go" next block :disabled="primaryOff" :aria-busy="busy ? 'true' : undefined" data-testid="start-next" @click="onPrimary">{{ primaryText }}</AppButton>
    </footer>
    <InviteDialog v-model:open="inviteOpen" :session="session" />
  </main>
  <main v-else-if="loadError" class="screen" data-testid="start-load-error">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <EmptyState title="Could not load this session" :text="loadError" role="alert">
        <AppButton variant="secondary" @click="load">Retry</AppButton>
      </EmptyState>
    </div>
  </main>
  <main v-else class="screen" data-testid="start-loading">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <SkeletonRow v-for="n in 3" :key="n" avatar />
    </div>
  </main>
</template>

<style scoped>
.head { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.head h2, .head p { margin: 0; }
.head h2:focus { outline: none; }
.head h2:focus-visible { outline: 2px solid var(--ink); outline-offset: 4px; border-radius: var(--rounded-sm); }
/* The cards, or the chips and the "here now" card, stacked. */
.choices { display: flex; flex-direction: column; gap: var(--spacing-md); min-width: 0; max-width: 880px; margin: 0; }
/* The two ways to pick the meeting point: stacked on a phone, side by side from 744px, so a wide screen is not one narrow column. */
@media (min-width: 744px) { .choices--cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; } .choices--cards > * { height: 100%; } }
.choices p { margin: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 0 var(--spacing-sm); }
.or { display: flex; align-items: center; gap: var(--spacing-md); font: var(--text-caption-sm); color: var(--muted); }
.or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--hairline); }
.start__note { margin: 0; }
.start__search { max-width: 880px; }
/* The longest label ("Ask everyone to share where they start") wraps on a 320px phone instead of being cut off. */
.start__go.btn { height: auto; min-height: 48px; padding-top: var(--spacing-md); padding-bottom: var(--spacing-md); white-space: normal; text-align: center; line-height: 1.25; }
@media (min-width: 744px) { .start__note { margin-right: auto; } }
</style>
