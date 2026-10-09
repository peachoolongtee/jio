<script setup>
// A leaderboard in one card: title and date range, an optional picker between runs (seasons),
// the top three on a podium, and everyone else in a paged list.
//   <LeaderboardCard title="Season 4" from-date="2026-10-01" to-date="2026-12-31"
//     :podium-rankings="top3" :rankings="rest" current-user-id="ian"
//     :run-options="[{ id: '4', label: 'This season' }]" v-model:selected-run-id="run" />
// Rankings use the shapes in LeaderboardPodium and LeaderboardRankings; pass everyone in `rankings`,
// the top three included. The default slot sits between the header and the podium.
import { computed, useId } from 'vue'
import { format } from 'date-fns'
import LeaderboardPodium from './LeaderboardPodium.vue'
import LeaderboardRankings from './LeaderboardRankings.vue'

const props = defineProps({
  title: { type: String, default: 'Leaderboard' },
  fromDate: { type: [String, Date, Number], required: true },
  toDate: { type: [String, Date, Number], required: true },
  podiumRankings: { type: Array, required: true },
  rankings: { type: Array, required: true },
  currentUserId: { type: String, default: '' },
  // [{ id, label }]. Leave empty to hide the picker.
  runOptions: { type: Array, default: () => [] },
  pageSize: { type: Number, default: 10 },
})
const run = defineModel('selectedRunId', { type: String, default: '' })

const pickerId = `run-${useId()}`
const dateLabel = (d) => {
  const date = d instanceof Date ? d : new Date(d)
  return Number.isNaN(date.getTime()) ? '' : format(date, 'd MMM yyyy')
}
// "1 Oct – 31 Dec 2026", or with both years when the range crosses one.
const range = computed(() => {
  const from = dateLabel(props.fromDate)
  const to = dateLabel(props.toDate)
  return from.slice(-4) === to.slice(-4) ? `${from.slice(0, -5)} – ${to}` : `${from} – ${to}`
})
// Without a v-model, the picker starts on the first option.
const active = computed({
  get: () => run.value || props.runOptions[0]?.id || '',
  set: (v) => { run.value = v },
})
</script>

<template>
  <section class="lb card">
    <header class="lb__head">
      <div class="lb__title">
        <h2 class="display-sm">{{ title }}</h2>
        <p class="body-sm text-muted tnum">{{ range }}</p>
      </div>
      <template v-if="runOptions.length">
        <label :for="pickerId" class="sr-only">Season</label>
        <select :id="pickerId" v-model="active" class="lb__picker caption">
          <option v-for="opt in runOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
        </select>
      </template>
    </header>

    <slot />

    <LeaderboardPodium v-if="podiumRankings.length" :rankings="podiumRankings" :current-user-id="currentUserId" />
    <LeaderboardRankings v-if="rankings.length" :rankings="rankings" :current-user-id="currentUserId" show-pagination :default-page-size="pageSize" />
    <slot name="empty" />
  </section>
</template>

<style scoped>
.lb { gap: var(--spacing-lg); padding: var(--spacing-lg); border-radius: var(--rounded-lg); }
@media (max-width: 599px) { .lb { padding: var(--spacing-lg) var(--spacing-base); } }
.lb__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing-base); }
.lb__title { display: flex; flex-direction: column; gap: var(--spacing-xxs); min-width: 0; }
.lb__picker {
  flex-shrink: 0;
  height: 36px;
  max-width: 50%;
  padding: 0 32px 0 12px;
  border: 1px solid var(--hairline);
  border-radius: var(--rounded-sm);
  background: var(--canvas) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23222' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E") no-repeat right 12px center / 14px;
  color: var(--ink);
  text-overflow: ellipsis;
  appearance: none;
  cursor: pointer;
}
.lb__picker:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
</style>
