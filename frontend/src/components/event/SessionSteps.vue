<script>
// The five steps, and what each one is for a session on the page at `path`. No DOM, so it can be tested on its own.
//   Create    the form for the title, day and times (/edit once the session exists)
//   Invite    /invite: who is in, and for the host the way to add people while that is still open
//   Locate    the session page (/sessions/:id, which is also the lobby while the session is inviting)
//   Vote      /plan
//   Itinerary /itinerary (and its photos, full map, "What next?" and "How was it?")
const STEPS = [
  { key: 'create', label: 'Create', page: '/edit' },
  { key: 'invite', label: 'Invite', page: '/invite' },
  { key: 'locate', label: 'Locate', page: '' },
  { key: 'vote', label: 'Vote', page: '/plan' },
  { key: 'itinerary', label: 'Itinerary', page: '/itinerary' },
]
const ORDER = ['inviting', 'locating', 'voting', 'confirmed']
// The pages that belong to the Itinerary step without being it: they go back to it. '/replace' is the plan page opened to
// replace one stop of a confirmed plan (tailOf), which belongs to the Itinerary and not to Vote.
const ITINERARY_PAGES = ['/photos', '/map', '/roam', '/replace', '/review']

// The screens inside each step (Faith's walkthrough, 30 October 2026: a step can hold several screens, so each step's bar is split into one
// segment per screen and fills up to the screen on show). Invite, in the order the host goes through them (Create, the Start choice, then
// the invite page, walkthrough of 30 October 2026): how to pick the meeting point (the Start choice, with its area step, or the session
// page while inviting, which has the Next button to it), then who to invite (the invite page). Locate: where to meet while the group chooses, then the confirmed
// meeting spot. Itinerary: the plan, then "How was it?".
const SCREENS = { create: 1, invite: 2, locate: 2, vote: 1, itinerary: 2 }

// Which screen of its step the page on screen is, from 0. How to call: screenOf({ status: 'voting' }, '', 2) -> 1
export function screenOf(session, tail, viewing) {
  if (!session) return 0
  const key = STEPS[viewing]?.key
  if (key === 'invite') return tail === '/invite' ? 1 : 0
  if (key === 'locate') return tail === '' && !['inviting', 'locating'].includes(session.status) ? 1 : 0
  if (key === 'itinerary') return tail === '/review' ? 1 : 0
  return 0
}

// How each segment of each step's bar is drawn: 'done' (a screen before this one, or this one), 'ahead' (a screen the session has reached
// that is past the page on screen, so the bar never claims the page is further on than it is) or 'todo' (not reached yet).
// How to call: segmentsFor(1, 2, 0, 3) -> ['done', 'ahead']
export function segmentsFor(step, viewing, screen, reached) {
  const count = SCREENS[STEPS[step].key]
  return Array.from({ length: count }, (_, n) => {
    if (step < viewing || (step === viewing && n <= screen)) return 'done'
    return step <= reached ? 'ahead' : 'todo'
  })
}

// The last step the session reached: 0 is Create, so a session that exists has always passed it. A cancelled one
// stops where it was called off.
// How to call: reachedStep({ status: 'voting' }) -> 3
export function reachedStep(session) {
  if (!session) return 0
  if (session.status === 'completed') return 4
  if (session.status !== 'cancelled') return ORDER.indexOf(session.status) + 1
  if (session.plan) return 4
  if (session.meeting) return 3
  return session.activeIds?.length > 1 ? 2 : 1
}

// The step for the page on screen. `tail` is the path after /sessions/:id ('' for the session page, '/plan'...).
// The session page is Locate once the session has gone past inviting (before that it is the lobby, which is Invite), and
// the invite page is always Invite.
// How to call: viewingStep({ status: 'voting' }, '/plan') -> 3
export function viewingStep(session, tail) {
  if (!session) return 0
  if (ITINERARY_PAGES.includes(tail)) return 4
  if (tail === '/invite') return 1
  const index = STEPS.findIndex((step) => step.page && step.page === tail)
  if (index >= 0) return index
  return reachedStep(session) >= 2 ? 2 : 1
}

// Every step as the bar draws it. open: a link (every step the session has reached, and Create for the host). locked: the
// Create step of a session that has started (the page it opens says the day and times can no longer change). `mine`: the
// signed-in person is the host, the only one who may open Create. here: the page on screen. exact: that step's own page,
// which has nothing to link to.
// How to call: stepsFor(session, '/sessions/s1/plan', true) -> [{ key: 'create', open: true, locked: true, ... }, ...]
export function stepsFor(session, path, mine = true) {
  const tail = tailOf(session, path)
  const reached = reachedStep(session)
  const viewing = viewingStep(session, tail)
  const screen = screenOf(session, tail, viewing)
  return STEPS.map((step, i) => ({
    ...step,
    segments: segmentsFor(i, viewing, screen, session ? reached : -1),
    to: session ? `/sessions/${session.id}${step.page}` : '',
    done: i <= reached,
    open: !!session && (i === 0 ? mine : i <= reached),
    locked: i === 0 && !!session && session.status !== 'inviting',
    here: i === viewing,
    exact: i === viewing && tail === step.page,
  }))
}

// The path after /sessions/:id: '' for the session page, '/plan', '/invite'... Null with no session. A query on `path` is
// read only for one thing: the plan page of a confirmed session opened with ?replace= is '/replace', not '/plan'.
// How to call: tailOf({ id: 's1' }, '/sessions/s1/plan') -> '/plan'
//              tailOf({ id: 's1', status: 'confirmed' }, '/sessions/s1/plan?replace=eat') -> '/replace'
function tailOf(session, path) {
  if (!session) return null
  const tail = path.split(/[?#]/)[0].replace(`/sessions/${session.id}`, '')
  return tail === '/plan' && session.status === 'confirmed' && /[?&]replace=/.test(path) ? '/replace' : tail
}

// Where the button at the top left goes from the page at `path`. From a session's own pages (the session page, Vote and
// the Itinerary) it leaves the session: the steps bar is how a person moves between steps, so the button does not
// repeat it. It leaves to `exit`, the screen the person opened the session from (exitFor in lib/stepNav.js), which is
// Home unless told otherwise. The photos, the full map and "What next?" belong to the Itinerary, so they go back to it. The two forms
// keep their order: Invite goes back to Create for the host (one stop in the browser's history, so it replaces), and
// Create, or Invite for a guest, leaves the session. `label` says where it goes.
// How to call: backFor({ id: 's1', status: 'voting' }, '/sessions/s1/plan', true) -> { label: 'Back to Home', to: '/' }
//              backFor(session, path, true, { label: 'Back to Sessions', to: '/sessions' }) -> that, from a step's page
export function backFor(session, path, mine = true, exit = { label: 'Back to Home', to: '/' }) {
  const home = exit
  if (!session) return home
  const tail = tailOf(session, path)
  if (ITINERARY_PAGES.includes(tail)) return { label: 'Back to Itinerary', to: `/sessions/${session.id}/itinerary` }
  if (['', '/plan', '/itinerary'].includes(tail)) return home
  const viewing = viewingStep(session, tail)
  const target = Math.min(viewing - 1, reachedStep(session))
  if (target < 0 || (target === 0 && !mine)) return home
  const step = STEPS[target]
  const to = `/sessions/${session.id}${step.page}`
  const swaps = ['/invite', '/edit'].includes(tail) && target <= 1
  return { label: target === 0 ? 'Back to date and times' : `Back to ${step.label}`, to: swaps ? { path: to, replace: true } : to }
}

// Going to the next screen builds its bar from scratch, so the step that was pressed goes with the old screen and focus
// would drop to the page. The step pressed is remembered here, and the next bar to appear puts focus on the same step.
let carried = null
</script>

<script setup>
// Where a session is, as a progress bar of its five steps, which doubles as its navigation:
//   Create · Invite · Locate · Vote · Itinerary
// It starts on the create page, before the session exists (no `session`), and runs until the itinerary is
// confirmed. Each step's bar has a segment per screen in it (SCREENS), filled in Rausch up to the page on screen, never further: a
// screen the session has reached past the page on screen is an outline in Rausch, and one it has not reached is grey. Steps the session has reached
// open their page (Invite the invite page, Locate the session page, Vote the plan, Itinerary the itinerary). Create opens the form again
// with the session's values, for the host; once the session has started the form says they are locked. The page you
// are on has its label in bold ink. A step that is the page just behind this one in the browser's history goes Back
// instead of adding another entry (lib/stepNav.js), and Create and Invite replace each other.
// The itinerary's own pages (photos, the full map) count as the Itinerary step.
// The bar has its own view-transition name, like the tab bar, so it stays where it is while the screens around it
// cross-fade; it sits right under the back row on every session screen so it is in the same place on all of them; and
// pressing a step leaves focus on that step on the next screen.
//   <SessionSteps :session="session" />    on a session's pages
//   <SessionSteps />                        on the create page
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { goBackIfBehind } from '@/lib/stepNav.js'
import { useAuthStore } from '@/stores/auth.js'

const props = defineProps({ session: { type: Object, default: null } })
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const root = ref(null)

const steps = computed(() => stepsFor(props.session, route.fullPath, props.session?.hostId === auth.myId))
// The Create and Invite screens are one stop in the browser's history (leaving either for the other replaces it), so
// Back from either goes to where the person came from, never to an empty create form.
const swapsHistory = computed(() => route.path.endsWith('/invite') || route.path.endsWith('/edit'))

// How to call: label(step, 0) -> "Step 1 of 5: Create, locked once the session starts"
function label(step, i) {
  const note = step.locked ? ', locked once the session starts' : step.done ? '' : ', not reached yet'
  return `Step ${i + 1} of ${steps.value.length}: ${step.label}${note}`
}

// How to call: @click="remember('vote')"
function remember(key) {
  carried = { key, at: Date.now() }
}

// While a page changes, the browser shows a picture of it and a press lands on the picture (the document itself), not
// on the new page beneath, so a quick second press on a step would be lost. It is passed on to the step under it.
// How to call: document.addEventListener('click', passOn)
function passOn(event) {
  const page = document.documentElement
  if (event.target !== page || !page.dataset.vt) return
  const over = (a) => { const r = a.getBoundingClientRect(); return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom }
  ;[...(root.value?.querySelectorAll('a.steps__step') || [])].find(over)?.click()
}
onMounted(() => document.addEventListener('click', passOn))
onBeforeUnmount(() => document.removeEventListener('click', passOn))

onMounted(() => {
  const wanted = carried
  carried = null
  if (wanted && Date.now() - wanted.at < 3000) root.value?.querySelector(`[data-step="${wanted.key}"]`)?.focus({ preventScroll: true })
})
</script>

<template>
  <nav ref="root" class="steps" :class="{ 'is-cancelled': session?.status === 'cancelled' }" aria-label="Session steps" style="view-transition-name: session-steps">
    <ol class="steps__list">
      <li v-for="(step, i) in steps" :key="step.key" class="steps__item" :class="{ 'is-done': step.done, 'is-here': step.here }">
        <RouterLink
          v-if="step.open && !step.exact"
          :to="step.to"
          :replace="['create', 'invite'].includes(step.key) && swapsHistory"
          class="steps__step"
          :data-step="step.key"
          :aria-label="label(step, i)"
          :aria-current="step.here ? 'step' : undefined"
          :title="step.locked ? 'The date and times are locked once the session starts' : undefined"
          @click.capture="goBackIfBehind($event, router, step.to)"
          @click="remember(step.key)"
        >
          <span class="steps__bar" aria-hidden="true"><span v-for="(seg, n) in step.segments" :key="n" class="steps__seg" :class="`is-${seg}`" /></span>
          <span class="steps__label">{{ step.label }}</span>
        </RouterLink>
        <span v-else class="steps__step" :data-step="step.key" :tabindex="step.here ? -1 : undefined" :aria-current="step.here ? 'page' : undefined" :aria-disabled="step.here ? undefined : 'true'">
          <span class="steps__bar" aria-hidden="true"><span v-for="(seg, n) in step.segments" :key="n" class="steps__seg" :class="`is-${seg}`" /></span>
          <span class="steps__label">
            {{ step.label }}
            <span class="sr-only">{{ step.here ? ', this page' : step.done ? ', done' : ', not reached yet' }}</span>
          </span>
        </span>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.steps { margin: 0; }
.steps__list { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; margin: 0; padding: 0; list-style: none; }
.steps__step { display: flex; flex-direction: column; gap: var(--spacing-xs); min-height: var(--tap-min); padding-top: var(--spacing-xs); color: var(--muted-soft); text-decoration: none; -webkit-tap-highlight-color: transparent; }
/* The bar: one segment per screen of the step. Rausch up to the page on screen; a screen the session has reached past it is an outline in
   Rausch (a shape, not a paler tint, which was 1.1:1 against the grey and could not be told from it); grey for the rest. */
.steps__bar { display: flex; gap: 3px; height: 6px; transition: transform var(--motion-fast) var(--ease-out); }
.steps__seg { flex: 1 1 0; border-radius: var(--rounded-full); background: var(--surface-strong); transition: background-color var(--motion-fast) var(--ease-out); }
.steps__seg.is-done { background: var(--primary); }
.steps__seg.is-ahead { background: var(--canvas); box-shadow: inset 0 0 0 1.5px var(--primary); }
.steps__label { font: var(--text-caption); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.is-done .steps__step, a.steps__step { color: var(--body); }
/* The page on screen: its label bold in Rausch-dark, with its bar a touch taller, so it is plain which step this is. */
.is-here .steps__step { color: var(--primary-active); }
.is-here .steps__label { font-weight: 700; }
.is-here .steps__bar { transform: scaleY(1.35); }
@media (hover: hover) {
  a.steps__step:hover { color: var(--ink); }
  a.steps__step:hover .steps__label { text-decoration: underline; text-underline-offset: 3px; }
  a.steps__step:hover .steps__seg.is-todo { background: var(--border-strong); }
}
/* Focus on a link, or on the page's own step after one was pressed. */
.steps__step:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: var(--rounded-xs, 4px); }
/* Called off: the filled steps turn grey. */
.is-cancelled .steps__seg.is-done { background: var(--muted-soft); }
.is-cancelled .steps__seg.is-ahead { box-shadow: inset 0 0 0 1.5px var(--muted-soft); }
@media (prefers-reduced-motion: reduce) { .steps__bar, .steps__seg { transition: none; } }
</style>
