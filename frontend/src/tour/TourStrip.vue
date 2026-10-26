<script setup>
// The demo tour's strip: a bar at the top of every screen while the tour is on (App.vue draws it, so it is not part of any
// screen). It lists the ten checkpoints of one outing in order, marks the current one, moves back and forward, and lets
// the visitor restart or leave the tour. Pressing a checkpoint opens the page that shows that state best (tour/story.js).
//
//   <TourStrip />
//
// Layout. It is part of the page, not fixed over it, so it covers neither the top bar, the steps bar, a screen's footer button
// nor the phone's tab bar; it only moves the page down, by the same height on every screen so the steps bar below does not
// shift between checkpoints (the line of text under the controls always has the same room). From 744px the checkpoints are a
// row of ten numbers with the current one's name spelled out, with Restart and Leave beside it. Under 744px the bar is one line, "3 of 10, Sharing
// locations", with the arrows; pressing the name opens the list of checkpoints, Restart and Leave below it.
// The choice between the two is made in CSS, so resizing keeps what is open.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import IconButton from '@/components/ui/IconButton.vue'
import { CHECKPOINTS } from './story.js'
import { useTourStore } from './store.js'

const tour = useTourStore()
const router = useRouter()
const route = useRoute()

const total = CHECKPOINTS.length
const open = ref(false)
const list = ref(null)
const toggle = ref(null)
const here = computed(() => tour.checkpoint)
// The short line above the controls: what these pages are, and when the planner is a stand-in.
const caption = computed(() => (tour.rough ? 'Sample data. Places and times are rough.' : 'Demo tour. Sample data.'))

// Open checkpoint `i` (0 to 9): select it and go to the page that shows it. The same page again does nothing, so the
// history does not fill with repeats.
// How to call: go(3)
async function go(i) {
  if (i < 0 || i >= total) return
  tour.select(i)
  const path = tour.pathFor(i)
  if (route.fullPath !== path) await router.push(path)
  // The list closes after a choice (under 744px). The button that was pressed goes with it, so focus goes to the one that
  // opened the list instead of falling to the page.
  if (open.value) {
    open.value = false
    await nextTick()
    toggle.value?.focus?.()
  }
}

// Keep the current checkpoint in view in the row of chips.
async function reveal() {
  await nextTick()
  const chip = list.value?.querySelector?.('[aria-current="step"]')
  if (typeof chip?.scrollIntoView !== 'function') return
  // People who asked for less motion get no gliding.
  const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  chip.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduce ? 'auto' : 'smooth' })
}
onMounted(reveal)
watch(() => tour.index, reveal)

// Left and right arrows, Home and End move between the checkpoints' buttons; Tab works as well.
// How to call: <ol @keydown="arrows">
function arrows(event) {
  const keys = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 }
  const buttons = [...list.value.querySelectorAll('button')]
  const at = buttons.indexOf(document.activeElement)
  if (at < 0) return
  let next = -1
  if (event.key in keys) next = (at + keys[event.key] + buttons.length) % buttons.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = buttons.length - 1
  if (next < 0) return
  event.preventDefault()
  buttons[next].focus()
}

// Escape closes the list on a phone and puts focus back on the button that opened it.
// How to call: <section @keydown.esc="close">
function close() {
  if (!open.value) return
  open.value = false
  toggle.value?.focus?.()
}

// Leaving keeps the account and its sessions. Restart goes to the page that asks first, because it replaces them.
async function leave() {
  tour.leave()
  await router.push('/')
}
</script>

<template>
  <section v-if="tour.live" class="tour" aria-label="Demo tour" style="view-transition-name: tour-strip" data-testid="tour-strip" @keydown.esc="close">
    <p class="tour__caption caption-sm text-muted">
      <AppIcon name="info" :size="12" />
      <span>{{ caption }}</span>
    </p>

    <div class="tour__row">
      <IconButton class="tour__prev" label="Previous checkpoint" :disabled="tour.index === 0" @click="go(tour.index - 1)">
        <AppIcon name="back" :size="16" />
      </IconButton>

      <button ref="toggle" type="button" class="tour__toggle" :aria-expanded="open" aria-controls="tour-list" @click="open = !open">
        <span class="tour__count caption-sm text-muted">{{ tour.index + 1 }} of {{ total }}</span>
        <span class="tour__title">
          <span class="tour__name title-sm truncate">{{ here.name }}</span>
          <AppIcon class="tour__chevron" name="chevron-down" :size="16" />
        </span>
      </button>

      <ol id="tour-list" ref="list" class="tour__list" :class="{ 'is-open': open }" aria-label="Checkpoints" @keydown="arrows">
        <li v-for="(stop, i) in CHECKPOINTS" :key="stop.key">
          <button type="button" class="tour__stop" :class="{ 'is-here': i === tour.index }" :title="stop.name" :aria-current="i === tour.index ? 'step' : undefined" @click="go(i)">
            <span class="tour__num">{{ i + 1 }}</span>
            <span class="tour__label">{{ stop.name }}</span>
          </button>
        </li>
      </ol>

      <IconButton class="tour__next" label="Next checkpoint" :disabled="tour.index === total - 1" @click="go(tour.index + 1)">
        <AppIcon name="chevron-right" :size="16" />
      </IconButton>

      <div class="tour__actions" :class="{ 'is-open': open }">
        <AppButton variant="tertiary" underline small to="/demo" aria-label="Restart the tour">Restart</AppButton>
        <AppButton variant="tertiary" underline small @click="leave">Leave tour</AppButton>
      </div>
    </div>

    <p class="tour__look body-sm" role="status">
      <span class="sr-only">Checkpoint {{ tour.index + 1 }} of {{ total }}, {{ here.name }}. </span>{{ here.look }}
    </p>
  </section>
</template>

<style scoped>
/* A flat band the page's own width: Surface Soft with a hairline under it, so it reads as part of the page's frame and not as a card. */
.tour {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--gutter);
  border-bottom: 1px solid var(--hairline);
  background: var(--surface-soft);
}
.tour__caption { display: flex; align-items: center; gap: var(--spacing-xs); margin: 0; height: 16px; }

.tour__row {
  display: grid;
  grid-template-columns: var(--tap-min) minmax(0, 1fr) var(--tap-min);
  grid-template-areas: 'prev toggle next' 'list list list' 'actions actions actions';
  align-items: center;
  column-gap: var(--spacing-sm);
}
.tour__prev { grid-area: prev; }
.tour__next { grid-area: next; }
.tour__row :deep(.icon-btn) { background: var(--canvas); border: 1px solid var(--hairline); }

/* Phones: the bar is one line, and the name opens the list. */
.tour__toggle {
  grid-area: toggle;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xxs);
  min-width: 0;
  min-height: var(--tap-min);
  margin: 0;
  padding: 0 var(--spacing-sm);
  border: 0;
  border-radius: var(--rounded-sm);
  background: transparent;
  color: var(--ink);
  cursor: pointer;
}
.tour__title { display: flex; align-items: center; justify-content: center; gap: var(--spacing-xs); max-width: 100%; }
.tour__name { min-width: 0; }
.tour__count { flex-shrink: 0; white-space: nowrap; }
.tour__chevron { flex-shrink: 0; transition: transform var(--motion-fast) var(--ease-out); }
.tour__toggle[aria-expanded='true'] .tour__chevron { transform: rotate(180deg); }

.tour__list { grid-area: list; display: none; margin: var(--spacing-xs) 0 0; padding: 0; list-style: none; }
.tour__list.is-open { display: flex; flex-direction: column; }
.tour__actions { grid-area: actions; display: none; gap: var(--spacing-base); padding-bottom: var(--spacing-xs); }
.tour__actions.is-open { display: flex; }

.tour__stop {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  width: 100%;
  min-height: var(--tap-min);
  margin: 0;
  padding: 0 var(--spacing-sm);
  border: 0;
  border-radius: var(--rounded-sm);
  background: transparent;
  color: var(--ink);
  font: var(--text-caption);
  text-align: left;
  cursor: pointer;
}
.tour__num {
  flex-shrink: 0;
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--border-strong);
  border-radius: var(--rounded-full);
  background: var(--canvas);
  font: var(--text-badge);
}
.tour__stop.is-here { font-weight: 600; }
.tour__stop.is-here .tour__num { border-color: var(--selected); background: var(--selected); color: var(--on-selected); }

/* The line about what to look at: always two lines of room on a phone (14px text, 20px a line) and one from tablet up, so the
   bar is the same height at every checkpoint and the steps bar below it never moves. */
.tour__look { margin: 0; height: 40px; overflow: hidden; color: var(--body); }

@media (min-width: 744px) {
  .tour__row {
    grid-template-columns: var(--tap-min) minmax(0, 1fr) var(--tap-min) auto;
    grid-template-areas: 'prev list next actions';
  }
  .tour__toggle { display: none; }
  /* A row of the ten numbers with the current checkpoint's name spelled out, so all ten fit; it still scrolls sideways
     if a window is narrower than that (`safe` centring keeps the first checkpoint reachable when the row overflows). The padding keeps the 2px focus ring from being cut off at the edges. */
  .tour__list { display: flex; flex-direction: row; justify-content: safe center; gap: var(--spacing-xs); margin: 0; padding: 3px; overflow-x: auto; scroll-snap-type: x proximity; scrollbar-width: none; }
  .tour__list::-webkit-scrollbar { display: none; }
  .tour__stop { width: auto; min-width: var(--tap-min); flex-shrink: 0; justify-content: center; gap: var(--spacing-sm); padding: 0 var(--spacing-sm); border-radius: var(--rounded-full); white-space: nowrap; scroll-snap-align: center; }
  .tour__stop.is-here { padding-right: var(--spacing-md); background: var(--canvas); box-shadow: inset 0 0 0 1px var(--ink); }
  /* The other names are still read out; they are only not drawn. */
  .tour__stop:not(.is-here) .tour__label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .tour__actions { display: flex; gap: var(--spacing-sm); padding: 0; }
  .tour__look { height: 20px; }
}

@media (hover: hover) {
  .tour__toggle:hover, .tour__stop:hover { background: var(--hairline-soft); }
}
</style>

<style>
/* The strip stays where it is while the screens cross-fade, like the tab bar and the steps bar. */
::view-transition-group(tour-strip) { animation-duration: 0s; }
</style>
