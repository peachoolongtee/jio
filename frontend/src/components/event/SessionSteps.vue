<script>
// The five steps, and what each one is for a session on the page at `path`. No DOM, so it can be tested on its own.
//   Create    the form for the title, day and times (/edit once the session exists)
//   Invite    the people page (Invite and Locate are both /sessions/:id)
//   Locate    the people page
//   Vote      /plan
//   Itinerary /itinerary (and its photos and full map)
const STEPS = [
  { key: 'create', label: 'Create', page: '/edit' },
  { key: 'invite', label: 'Invite', page: '' },
  { key: 'locate', label: 'Locate', page: '' },
  { key: 'vote', label: 'Vote', page: '/plan' },
  { key: 'itinerary', label: 'Itinerary', page: '/itinerary' },
]
const ORDER = ['inviting', 'locating', 'voting', 'confirmed']

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

// The step for the page on screen. `tail` is the path after /sessions/:id ('' for the people page, '/plan'...).
// The people page is Locate once the session has gone past inviting, and the invite page is always Invite.
// How to call: viewingStep({ status: 'voting' }, '/plan') -> 3
export function viewingStep(session, tail) {
  if (!session) return 0
  if (['/photos', '/map'].includes(tail)) return 4
  if (tail === '/invite') return 1
  const index = STEPS.findIndex((step) => step.page && step.page === tail)
  if (index >= 0) return index
  return reachedStep(session) >= 2 ? 2 : 1
}

// Every step as the bar draws it. open: a link. locked: the Create step of a session that has started (the page it
// opens says the day and times can no longer change). `mine`: the signed-in person is the host, the only one who may
// open Create. here: the page on screen. exact: that step's own page, which has nothing to link to.
// How to call: stepsFor(session, '/sessions/s1/plan', true) -> [{ key: 'create', open: true, locked: true, ... }, ...]
export function stepsFor(session, path, mine = true) {
  const tail = session ? path.replace(`/sessions/${session.id}`, '') : null
  const reached = reachedStep(session)
  const viewing = viewingStep(session, tail)
  return STEPS.map((step, i) => ({
    ...step,
    to: session ? `/sessions/${session.id}${step.page}` : '',
    done: i <= reached,
    open: !!session && (i === 0 ? mine : i <= reached),
    locked: i === 0 && !!session && session.status !== 'inviting',
    here: i === viewing,
    exact: i === viewing && tail === step.page,
  }))
}

// Going to the next screen builds its bar from scratch, so the step that was pressed goes with the old screen and focus
// would drop to the page. The step pressed is remembered here, and the next bar to appear puts focus on the same step.
let carried = null
</script>

<script setup>
// Where a session is, as a progress bar of its five steps, which doubles as its navigation:
//   Create · Invite · Locate · Vote · Itinerary
// It starts on the create page, before the session exists (no `session`), and runs until the itinerary is
// confirmed. Steps the session has reached are filled in Rausch and open their page (Invite and Locate are both
// the People page); later steps are greyed out. Create opens the form again with the session's values, for the
// host; once the session has started the form says they are locked. The page you are on has its label in bold ink.
// The itinerary's own pages (photos, the full map) count as the Itinerary step.
// The bar has its own view-transition name, like the tab bar, so it stays where it is while the screens around it
// cross-fade; it sits right under the back row on every session screen so it is in the same place on all of them; and
// pressing a step leaves focus on that step on the next screen.
//   <SessionSteps :session="session" />    on a session's pages
//   <SessionSteps />                        on the create page
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { HOST_ID } from '@/lib/mock/people.js'

const props = defineProps({ session: { type: Object, default: null } })
const route = useRoute()
const root = ref(null)

const steps = computed(() => stepsFor(props.session, route.path, props.session?.hostId === HOST_ID))
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
          :replace="step.key === 'create' && swapsHistory"
          class="steps__step"
          :data-step="step.key"
          :aria-label="label(step, i)"
          :title="step.locked ? 'The date and times are locked once the session starts' : undefined"
          @click="remember(step.key)"
        >
          <span class="steps__bar" aria-hidden="true" />
          <span class="steps__label">{{ step.label }}</span>
        </RouterLink>
        <span v-else class="steps__step" :data-step="step.key" :tabindex="step.here ? -1 : undefined" :aria-current="step.here ? 'page' : undefined" :aria-disabled="step.here ? undefined : 'true'">
          <span class="steps__bar" aria-hidden="true" />
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
/* The bar: grey until the session reaches the step, then Rausch. */
.steps__bar { height: 6px; border-radius: var(--rounded-full); background: var(--surface-strong); transition: background-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
.is-done .steps__bar { background: var(--primary); }
.steps__label { font: var(--text-caption); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.is-done .steps__step, a.steps__step { color: var(--body); }
/* The page on screen: bold ink, with its bar a touch taller. */
.is-here .steps__step { color: var(--ink); }
.is-here .steps__label { font-weight: 600; }
.is-here .steps__bar { transform: scaleY(1.35); }
@media (hover: hover) {
  a.steps__step:hover { color: var(--ink); }
  a.steps__step:hover .steps__label { text-decoration: underline; text-underline-offset: 3px; }
  .steps__item:not(.is-done) a.steps__step:hover .steps__bar { background: var(--border-strong); }
}
/* Focus on a link, or on the page's own step after one was pressed. */
.steps__step:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: var(--rounded-xs, 4px); }
/* Called off: the filled steps turn grey. */
.is-cancelled .is-done .steps__bar { background: var(--muted-soft); }
@media (prefers-reduced-motion: reduce) { .steps__bar { transition: none; } }
</style>
