<script setup>
// The places members proposed as the next stop, under the itinerary's stops. A proposed stop is not a stop yet: it has
// no number, no time and no place on the rail. Each row says who proposed it.
//   - The host sees "Add to plan" and "Not now" on each. Adding appends it to the end of the plan; the stops above
//     then show it with its time.
//   - The person who proposed one can take it back, with a cross (MarkButton; "Take back" is its word for screen readers).
//   - Everyone else sees who proposed it and that the host decides.
// It writes through the events store and says what went wrong in its own line (role="alert"). The buttons stay enabled
// while a change saves (aria-busy) and ignore a second press, so keyboard focus is never thrown away; after a change the
// focus lands on the next row's first button; when none is left it emits `emptied` and the screen moves focus (the
// section is gone). A live region, always on the page, says what was done, and only what was done: a proposal that is not
// there any more (an opt-out or a re-plan took it) is said to be gone, not "added". After "Add to plan" the itinerary is
// loaded again before anything is announced and focus moves, so what is said matches what is on the page.
// The host is told before pressing "Add to plan" when the stop would end after the session's end ("Would end at 22:10,
// after the session's end, 21:30"), worked out from `itinerary`'s last stop.
// The visible words of each button are in its accessible name ("Add to plan: Green Kitchen").
//   <ProposedStops :session="session" :itinerary="itinerary" my-id="ian" @emptied="timeline?.focus()" />
import { computed, nextTick, ref } from 'vue'
import AppButton from '../ui/AppButton.vue'
import MarkButton from '@/components/ui/MarkButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import CategoryIcon from '../ui/CategoryIcon.vue'
import InfoTag from '../ui/InfoTag.vue'
import PriceTier from '../ui/PriceTier.vue'
import { placeImage } from '@/lib/placeImages.js'
import { ROAM_WORDS, proposedRows } from '@/lib/roam.js'
import { singaporeMinutes } from '@/lib/session.js'
import { useNow } from '@/lib/useNow.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({
  session: { type: Object, required: true },
  // The itinerary as the store holds it, for the end of the last stop. Optional: without it no "would end after" line.
  itinerary: { type: Object, default: null },
  myId: { type: String, required: true },
})

const emit = defineEmits(['emptied'])
const events = useEventsStore()
const root = ref(null)
const working = ref('')
const error = ref('')
const announcement = ref('')
// Said in words on the page as well, for a change that did not happen.
const note = ref('')
const now = useNow()

const rows = computed(() =>
  proposedRows(props.session, props.myId, {
    lastStop: props.itinerary?.stops?.at(-1) || null,
    nowMinutes: singaporeMinutes(now.value),
  }),
)
const isHost = computed(() => props.session.hostId === props.myId)
const guidance = computed(() => (isHost.value ? 'Add a place to the plan, or leave it out for now.' : `${props.session.hostName || 'The host'} decides what goes into the plan.`))

// Decide on one proposal. `accept` adds the place to the plan; otherwise it is left out (or taken back by whoever proposed it).
// How to call: decide(row, true)
async function decide(row, accept) {
  if (working.value) return
  working.value = row.id
  error.value = ''
  announcement.value = ''
  note.value = ''
  try {
    const changed = await events.resolveProposal(props.session.id, row.id, accept)
    if (changed === false) {
      announcement.value = ROAM_WORDS.gone
      note.value = ROAM_WORDS.gone
    } else {
      // The itinerary shows the new stop only once it is loaded again (the store does that on the change, a moment later).
      // Wait for it, so the words and the focus come after what they are about. A failed reload is not a failed change.
      if (accept) await events.loadItinerary(props.session.id).catch(() => {})
      announcement.value = accept ? `${row.name} was added to the plan.` : row.canTakeBack ? ROAM_WORDS.takenBack(row.name) : `${row.name} was left out.`
    }
    await nextTick()
    const next = root.value?.querySelector('.proposed__actions button')
    if (next) next.focus()
    else emit('emptied')
  } catch (e) {
    error.value = e.message
  } finally {
    working.value = ''
  }
}
</script>

<template>
  <div ref="root" class="proposed-wrap">
    <p class="sr-only" role="status">{{ announcement }}</p>
    <section v-if="rows.length" class="proposed" aria-labelledby="proposed-title" data-testid="proposed-stops">
    <div class="proposed__head">
      <h2 id="proposed-title" class="title-md">Proposed stops</h2>
      <p class="caption-sm text-muted">{{ guidance }}</p>
    </div>
    <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    <p v-if="note" class="body-sm text-muted" data-testid="proposed-gone">{{ note }}</p>
    <ul class="proposed__list">
      <li v-for="row in rows" :key="row.id">
        <article class="proposed__card" :aria-label="`${row.name}. ${row.tag}`">
          <img class="proposed__photo" :src="placeImage(row.venue)" alt="" loading="lazy" width="56" height="56" />
          <div class="proposed__body">
            <h3 class="title-sm clamp-2">{{ row.name }}</h3>
            <p class="proposed__meta">
              <CategoryIcon :category="row.venue.category" :size="22" />
              <span v-if="row.venue.area" class="caption-sm text-muted truncate">{{ row.venue.area }}</span>
              <PriceTier :price="row.venue.price" />
            </p>
            <InfoTag tone="strong" class="proposed__tag">{{ row.tag }}</InfoTag>
            <p v-if="row.late" class="proposed__late caption-sm" data-testid="proposed-late"><AppIcon name="warning" :size="12" /> {{ row.late }}</p>
          </div>
          <div v-if="row.canDecide || row.canTakeBack || row.waiting" class="proposed__actions">
            <template v-if="row.canDecide">
              <AppButton small variant="secondary" :aria-busy="working === row.id ? 'true' : undefined" :aria-label="`Add to plan: ${row.name}`" @click="decide(row, true)">Add to plan</AppButton>
              <AppButton small variant="tertiary" :aria-busy="working === row.id ? 'true' : undefined" :aria-label="`Not now: ${row.name}`" @click="decide(row, false)">Not now</AppButton>
            </template>
            <template v-else>
              <p v-if="row.waiting" class="proposed__waiting caption-sm text-muted"><AppIcon name="clock" :size="14" /> {{ row.waiting }}</p>
              <MarkButton v-if="row.canTakeBack" symbol="close" :busy="working === row.id" :label="`Take back your proposal of ${row.name}`" @click="decide(row, false)">Take back</MarkButton>
            </template>
          </div>
        </article>
      </li>
    </ul>
    </section>
    <p v-else-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    <p v-else-if="note" class="body-sm text-muted" data-testid="proposed-gone">{{ note }}</p>
  </div>
</template>

<style scoped>
.proposed-wrap { display: contents; }
.proposed { display: flex; flex-direction: column; gap: var(--spacing-md); }
.proposed__head { display: flex; flex-direction: column; gap: var(--spacing-xxs); }
.proposed__list { display: flex; flex-direction: column; gap: var(--spacing-md); }
/* A dashed card: tentative, not a stop yet. */
.proposed__card { display: grid; grid-template-columns: 56px minmax(0, 1fr); align-items: start; gap: var(--spacing-md); padding: var(--spacing-md); border: 1px dashed var(--border-strong); border-radius: var(--rounded-md); background: var(--canvas); }
.proposed__photo { width: 56px; height: 56px; object-fit: cover; border-radius: var(--rounded-sm); background: var(--surface-strong); }
.proposed__body { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-xxs); min-width: 0; }
.proposed__meta { display: flex; align-items: center; gap: var(--spacing-sm); min-width: 0; max-width: 100%; }
.proposed__tag { margin-top: var(--spacing-xs); }
.proposed__late { display: inline-flex; align-items: flex-start; gap: var(--spacing-xs); color: var(--primary-error-text); }
.proposed__actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--spacing-sm); }
.proposed__waiting { display: inline-flex; align-items: center; gap: var(--spacing-xs); margin-right: auto; }
</style>
