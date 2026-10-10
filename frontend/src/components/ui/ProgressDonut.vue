<script setup>
// Who has done something, as a Rausch donut on a pale Rausch track, with the count written beside it.
//   <ProgressDonut title="Locations" :people="[{ name: 'Ian', done: true }, { name: 'Darius', done: false }]" done-label="Submitted" />
// Default: the donut with every name and its state listed beside it.
// `compact`: a small donut with "4 of 6 located" beside it, for screens where the names are listed right below.
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  title: { type: String, required: true },
  people: { type: Array, required: true },
  doneLabel: { type: String, default: 'Done' },
  todoLabel: { type: String, default: 'Waiting' },
  compact: { type: Boolean, default: false },
  size: { type: Number, default: 0 },
})

const done = computed(() => props.people.filter((p) => p.done).length)
const total = computed(() => props.people.length)
const px = computed(() => props.size || (props.compact ? 40 : 112))
const stroke = computed(() => (props.compact ? 6 : 12))
const radius = computed(() => (px.value - stroke.value) / 2)
const circumference = computed(() => 2 * Math.PI * radius.value)
const dash = computed(() => (total.value ? (done.value / total.value) * circumference.value : 0))
</script>

<template>
  <section class="donut" :class="{ 'donut--compact': compact }" :aria-label="`${title}: ${done} of ${total}`">
    <div class="donut__chart" aria-hidden="true">
      <svg :width="px" :height="px" :viewBox="`0 0 ${px} ${px}`">
        <circle class="donut__track" :cx="px / 2" :cy="px / 2" :r="radius" :stroke-width="stroke" fill="none" />
        <circle
          v-if="done"
          class="donut__arc"
          :cx="px / 2"
          :cy="px / 2"
          :r="radius"
          :stroke-width="stroke"
          fill="none"
          stroke-linecap="round"
          :stroke-dasharray="`${dash} ${circumference}`"
          :transform="`rotate(-90 ${px / 2} ${px / 2})`"
        />
      </svg>
      <span v-if="!compact" class="donut__count display-sm">{{ done }}/{{ total }}</span>
    </div>

    <p v-if="compact" class="donut__line">
      <span class="title-sm">{{ done }} of {{ total }}</span>
      <span class="caption-sm text-muted">{{ doneLabel.toLowerCase() }}</span>
    </p>

    <div v-else class="donut__text">
      <h3 class="title-md">{{ title }}</h3>
      <ul class="donut__list">
        <li v-for="person in people" :key="person.name" class="donut__row" :class="{ 'is-done': person.done }">
          <span class="donut__mark"><AppIcon v-if="person.done" name="check" :size="10" /></span>
          <span class="body-sm truncate">{{ person.name }}</span>
          <span class="caption-sm donut__state">{{ person.done ? doneLabel : todoLabel }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.donut { display: flex; align-items: flex-start; gap: var(--spacing-lg); }
.donut--compact { align-items: center; gap: var(--spacing-md); }
.donut__chart { position: relative; flex-shrink: 0; display: flex; }
.donut__track { stroke: color-mix(in srgb, var(--primary) 14%, var(--canvas)); }
.donut__arc { stroke: var(--primary); transition: stroke-dasharray var(--motion-fast) var(--ease-out); }
.donut__count { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.donut__line { display: flex; flex-direction: column; }
.donut__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-sm); }
.donut__list { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.donut__row { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-sm); min-height: 24px; }
.donut__mark { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border: 1.5px solid var(--border-strong); border-radius: var(--rounded-full); color: var(--on-primary); }
.donut__row.is-done .donut__mark { border-color: var(--primary); background: var(--primary); }
.donut__state { color: var(--muted); }
.donut__row.is-done .donut__state { color: var(--ink); }
</style>
