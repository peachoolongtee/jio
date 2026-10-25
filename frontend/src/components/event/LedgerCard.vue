<script setup>
// "Your travel": the person's own row of the travel ledger for a finished outing on the server. How long they spent getting there, between
// stops and getting home, and how that compares with the group's average. Only the signed-in person's own row is ever passed in; what the
// others travelled is not shown here.
//   <LedgerCard :ledger="{ minutesIn: 25, minutesBetween: 10, minutesHome: 30, total: 65, delta: 4 }" :loaded="true" />
// States: placeholder rows while the first read is out (`loading`, or not `loaded` yet); `failed` (could not load, with Try again, which stays
// on the page and is only disabled while the new read is out, so focus is never lost); the row; and, once the read has answered with no row,
// "No travel was recorded for you." with no retry (the server writes every row when it finishes the outing, so a missing row is a person who
// was not in it: opted out, or no start). One live region is on the page from the start, empty, and says what is happening. Estimates say "about".
import { computed } from 'vue'
import AppButton from '../ui/AppButton.vue'
import SkeletonRow from '../ui/SkeletonRow.vue'

const props = defineProps({
  ledger: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  failed: { type: Boolean, default: false },
  // The server has answered at least once (with a row or with none).
  loaded: { type: Boolean, default: false },
})
defineEmits(['retry'])

// How to call: about(25) -> 'about 25 min'
const about = (minutes) => `about ${Math.round(minutes)} min`
const rows = computed(() => {
  const l = props.ledger
  if (!l) return []
  return [
    { label: 'Getting there', value: about(l.minutesIn) },
    ...(l.minutesBetween > 0 ? [{ label: 'Between stops', value: about(l.minutesBetween) }] : []),
    { label: 'Getting home', value: about(l.minutesHome) },
    { label: 'Total', value: about(l.total), strong: true },
  ]
})
// How the total compares with the group's average, in words.
// What the live region says: that the read is out, or that it failed. Empty otherwise (it is on the page from the start, so it announces).
const announcement = computed(() => {
  if (props.loading) return 'Loading your travel'
  return props.failed ? 'Could not load your travel.' : ''
})
// How to call: compare(4) -> 'About 4 min more than the group\'s average.'
const compare = computed(() => {
  const delta = props.ledger?.delta
  if (!Number.isFinite(delta)) return ''
  if (Math.abs(delta) < 1) return "About the same as the group's average."
  return `About ${Math.round(Math.abs(delta))} min ${delta > 0 ? 'more' : 'less'} than the group's average.`
})
</script>

<template>
  <section class="ledger" aria-labelledby="ledger-title" :aria-busy="loading ? 'true' : undefined" data-testid="ledger-card">
    <h2 id="ledger-title" class="title-md">Your travel</h2>
    <p class="sr-only" role="status" data-testid="ledger-status">{{ announcement }}</p>
    <template v-if="ledger">
      <dl class="ledger__rows">
        <div v-for="row in rows" :key="row.label" class="ledger__row" :class="{ 'ledger__row--total': row.strong }">
          <dt class="body-sm">{{ row.label }}</dt>
          <dd class="body-sm tnum">{{ row.value }}</dd>
        </div>
      </dl>
      <p class="caption-sm text-muted" data-testid="ledger-compare">{{ compare }}</p>
    </template>
    <div v-else-if="failed" class="ledger__none">
      <p class="body-sm text-muted" data-testid="ledger-none">Could not load your travel.</p>
      <AppButton small variant="secondary" :disabled="loading" data-testid="ledger-retry" @click="$emit('retry')">Try again</AppButton>
    </div>
    <div v-else-if="loading || !loaded" class="stack gap-md" aria-hidden="true" data-testid="ledger-loading">
      <SkeletonRow :lines="2" />
    </div>
    <p v-else class="body-sm text-muted" data-testid="ledger-none">No travel was recorded for you.</p>
  </section>
</template>

<style scoped>
.ledger { display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.ledger h2, .ledger p, .ledger dl { margin: 0; }
.ledger__rows { display: flex; flex-direction: column; }
.ledger__row { display: flex; align-items: baseline; justify-content: space-between; gap: var(--spacing-md); min-height: 32px; }
.ledger__row--total { margin-top: var(--spacing-xs); padding-top: var(--spacing-sm); border-top: 1px solid var(--hairline-soft); font-weight: 600; }
.ledger__row--total dt, .ledger__row--total dd { font-weight: 600; }
.ledger__none { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--spacing-md); }
</style>
