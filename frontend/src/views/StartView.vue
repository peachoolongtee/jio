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
import SessionHeader from '@/components/event/SessionHeader.vue'
import ChoiceCard from '@/components/start/ChoiceCard.vue'
import NotFoundView from './NotFoundView.vue'
import * as api from '@/lib/api.js'
import { AREAS } from '@/lib/mock/places.js'
import { vRadioGroup } from '@/lib/radioGroup.js'
import { CHOICES, HERE_NOTE, START_NOTE, WHERE_NOTE, areaHere, findAreas, startLabel, whereLabel } from '@/lib/startChoice.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ id: { type: String, required: true } })

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
// The card chosen on the first screen, and on the follow-up the area chosen ('here' is "We're here now").
const choice = ref('fairest')
const where = ref('bishan')
const query = ref('')
const heading = ref(null)

const session = computed(() => events.byId[props.id])
const isHost = computed(() => !!session.value && session.value.hostId === auth.myId)
const step = computed(() => (route.query.where ? 'where' : 'how'))
const hereNow = computed(() => where.value === 'here')
const chosenArea = computed(() => AREAS.find((a) => a.id === where.value) || null)
// The areas the follow-up lists: the popular ones, or what the search finds. The chosen area stays listed so it never vanishes under a search.
const areas = computed(() => {
  const found = findAreas(query.value)
  return chosenArea.value && !found.some((a) => a.id === chosenArea.value.id) ? [...found, chosenArea.value] : found
})
// Nothing matches the search (the chosen area is kept in the list, so it is the matches that are counted).
const noMatch = computed(() => !!query.value.trim() && findAreas(query.value).length === 0)

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
// Who may be here: the host of a session that is inviting with two people in, or that started with "We already know where" and has not
// got its area yet (a retry). Everyone else belongs on the session page. Not while a save is running: it moves the session on itself.
const allowed = computed(() => {
  const s = session.value
  if (!s || !isHost.value) return false
  if (s.status === 'inviting') return (s.activeIds || []).length >= 2
  return s.status === 'locating' && s.meetBy === 'known' && step.value === 'where'
})
watch([session, allowed, busy, leaving], () => {
  if (session.value && !busy.value && !leaving.value && !allowed.value) router.replace(sessionPath.value)
})

// Move focus to the new screen's heading when the step changes, so a keyboard or screen reader user lands on the question.
watch(step, async () => {
  await nextTick()
  heading.value?.focus?.({ preventScroll: true })
})

// The back button at the top left: from the follow-up to the choice, from the choice to the session's page.
const back = computed(() => (step.value === 'where' ? `${sessionPath.value}/start` : sessionPath.value))

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
    return false
  } finally {
    busy.value = false
  }
}

// Is this page still the one on screen, so a finished save may take the host on? False once it was left.
// How to call: if (stillHere()) await router.replace(...)
const stillHere = () => !cancelled && router.currentRoute.value.path === `${sessionPath.value}/start`

// The main button of the first screen. The fairest spot starts the session and the host stays on its page, now the Locate step; the
// other choice goes on to the follow-up without saving anything yet.
// How to call: choose()
async function choose() {
  if (choice.value === 'known') {
    error.value = ''
    await router.push({ path: `${sessionPath.value}/start`, query: { where: '1' } })
    return
  }
  const ok = await run(async () => {
    await events.start(props.id, { meetBy: 'fairest' })
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
    if (session.value?.status === 'inviting') await events.start(props.id, { meetBy: 'known' })
    await events.setKnownPlace(props.id, areaId)
    done = true
    leaving.value = true
  })
  if (ok && done && stillHere()) await router.replace(`${sessionPath.value}/plan`)
}

const primary = computed(() => (step.value === 'how' ? startLabel(choice.value) : whereLabel(chosenArea.value, hereNow.value)))
const note = computed(() => (step.value === 'how' ? START_NOTE : hereNow.value ? HERE_NOTE : WHERE_NOTE))
const onPrimary = () => (step.value === 'how' ? choose() : meet())
const primaryOff = computed(() => busy.value || (step.value === 'where' && !hereNow.value && !chosenArea.value))
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
          <h2 ref="heading" tabindex="-1" class="display-sm">How do you want to pick the meeting point?</h2>
          <p class="body-sm text-muted">Everyone sees which one you choose.</p>
        </div>
        <div class="choices" role="radiogroup" v-radio-group aria-label="How to pick the meeting point">
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
          <h2 ref="heading" tabindex="-1" class="display-sm">Where is the place?</h2>
          <p class="body-sm text-muted">The group then goes straight to choosing places.</p>
        </div>
        <div class="start__search">
          <TextField v-model="query" label="Search for an area" placeholder="Bishan, Tampines, Jurong East" type="text" autocomplete="off" enterkeyhint="search" :maxlength="40">
            <template #leading><AppIcon name="search" :size="18" /></template>
          </TextField>
        </div>
        <div class="choices" role="radiogroup" v-radio-group :aria-label="query.trim() ? 'Areas that match' : 'Popular areas'">
          <p class="caption text-muted" aria-hidden="true">{{ query.trim() ? 'Areas that match' : 'Popular areas' }}</p>
          <div class="chips">
            <ChipButton v-for="a in areas" :key="a.id" radio :selected="where === a.id" :disabled="busy" @click="where = a.id">{{ a.name }}</ChipButton>
          </div>
          <p v-if="noMatch" class="body-sm text-muted" role="status">No area matches that. Try the start of its name.</p>
        </div>
        <div class="or" aria-hidden="true">or</div>
        <!-- Its own group: the card is not one of the areas. Choosing it, or an area, unchooses the other. -->
        <div class="choices" role="radiogroup" v-radio-group aria-label="Or use where you are">
          <ChoiceCard :selected="hereNow" :disabled="busy" icon="locate" @click="where = 'here'">
            <template #title>We're here now</template>
            <template #text>Use where you are, asking your browser for it.</template>
          </ChoiceCard>
        </div>
      </template>

      <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    </div>

    <footer class="screen__footer">
      <p class="caption-sm text-muted start__note">{{ note }}</p>
      <AppButton class="start__go" block :disabled="primaryOff" :aria-busy="busy ? 'true' : undefined" @click="onPrimary">{{ primaryText }}</AppButton>
    </footer>
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
.choices { display: flex; flex-direction: column; gap: var(--spacing-md); min-width: 0; max-width: 560px; margin: 0; }
.choices p { margin: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 0 var(--spacing-sm); }
.or { display: flex; align-items: center; gap: var(--spacing-md); font: var(--text-caption-sm); color: var(--muted); }
.or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--hairline); }
.start__note { margin: 0; }
.start__search { max-width: 560px; }
/* The longest label ("Ask everyone to share where they start") wraps on a 320px phone instead of being cut off. */
.start__go.btn { height: auto; min-height: 48px; padding-top: var(--spacing-md); padding-bottom: var(--spacing-md); white-space: normal; text-align: center; line-height: 1.25; }
@media (min-width: 744px) { .start__note { margin-right: auto; } }
</style>
