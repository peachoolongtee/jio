<script setup>
// Where a session is, as a progress bar of its four steps, which doubles as its navigation:
//   Invite · Locate · Vote · Itinerary
// Steps the session has reached are filled in Rausch and open their page (Invite and Locate are both the People
// page); later steps are greyed out. The page you are on has its label in bold ink. The itinerary's own pages
// (photos, the full map) count as the Itinerary step.
//   <SessionSteps :session="session" />
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

const props = defineProps({ session: { type: Object, required: true } })
const route = useRoute()

const STEPS = [
  { key: 'invite', label: 'Invite', page: '' },
  { key: 'locate', label: 'Locate', page: '' },
  { key: 'vote', label: 'Vote', page: '/plan' },
  { key: 'itinerary', label: 'Itinerary', page: '/itinerary' },
]
const ORDER = ['inviting', 'locating', 'voting', 'confirmed']

// The last step the session reached. A cancelled one stops where it was called off.
const reached = computed(() => {
  const s = props.session
  if (s.status === 'completed') return 3
  if (s.status !== 'cancelled') return ORDER.indexOf(s.status)
  if (s.plan) return 3
  if (s.meeting) return 2
  return s.activeIds?.length > 1 ? 1 : 0
})

const canOpen = (i) => i <= reached.value

// The step for the page on screen.
const tail = computed(() => route.path.replace(`/sessions/${props.session.id}`, ''))
const viewing = computed(() => {
  if (['/photos', '/map'].includes(tail.value)) return 3
  const index = STEPS.findIndex((step) => step.page && step.page === tail.value)
  if (index >= 0) return index
  return reached.value >= 1 ? 1 : 0
})

const steps = computed(() =>
  STEPS.map((step, i) => ({
    ...step,
    to: `/sessions/${props.session.id}${step.page}`,
    done: i <= reached.value,
    open: canOpen(i),
    here: i === viewing.value,
    // On the step's own page (not one of its pages, such as photos): nothing to link to.
    exact: i === viewing.value && tail.value === step.page,
  })),
)
</script>

<template>
  <nav class="steps" :class="{ 'is-cancelled': session.status === 'cancelled' }" aria-label="Session steps">
    <ol class="steps__list">
      <li v-for="(step, i) in steps" :key="step.key" class="steps__item" :class="{ 'is-done': step.done, 'is-here': step.here }">
        <RouterLink
          v-if="step.open && !step.exact"
          :to="step.to"
          class="steps__step"
          :aria-label="`Step ${i + 1} of 4: ${step.label}${step.done ? '' : ', not reached yet'}`"
        >
          <span class="steps__bar" aria-hidden="true" />
          <span class="steps__label">{{ step.label }}</span>
        </RouterLink>
        <span v-else class="steps__step" :aria-current="step.here ? 'page' : undefined" :aria-disabled="step.here ? undefined : 'true'">
          <span class="steps__bar" aria-hidden="true" />
          <span class="steps__label">
            {{ step.label }}
            <span class="sr-only">{{ step.here ? ', this page' : ', not reached yet' }}</span>
          </span>
        </span>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.steps { margin-top: var(--spacing-sm); }
.steps__list { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin: 0; padding: 0; list-style: none; }
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
a.steps__step:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: var(--rounded-xs, 4px); }
/* Called off: the filled steps turn grey. */
.is-cancelled .is-done .steps__bar { background: var(--muted-soft); }
@media (prefers-reduced-motion: reduce) { .steps__bar { transition: none; } }
</style>
