<script setup>
// Who has done something, as a Lagoon donut with the names and counts beside it as text.
//   <ProgressDonut title="Locations" :people="[{ name: 'Ian', done: true }, { name: 'Darius', done: false }]" done-label="Submitted" todo-label="Waiting" />
// The chart is decoration: the count and every name are always written out beside it.
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  title: { type: String, required: true },
  people: { type: Array, required: true },
  doneLabel: { type: String, default: 'Done' },
  todoLabel: { type: String, default: 'Waiting' },
  size: { type: Number, default: 112 },
})

const done = computed(() => props.people.filter((p) => p.done).length)
const total = computed(() => props.people.length)
const stroke = 12
const radius = computed(() => (props.size - stroke) / 2)
const circumference = computed(() => 2 * Math.PI * radius.value)
const dash = computed(() => (total.value ? (done.value / total.value) * circumference.value : 0))
</script>

<template>
  <section class="donut" :aria-label="`${title}: ${done} of ${total}`">
    <div class="donut__chart" aria-hidden="true">
      <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`">
        <circle class="donut__track" :cx="size / 2" :cy="size / 2" :r="radius" :stroke-width="stroke" fill="none" />
        <circle
          v-if="done"
          class="donut__arc"
          :cx="size / 2"
          :cy="size / 2"
          :r="radius"
          :stroke-width="stroke"
          fill="none"
          stroke-linecap="round"
          :stroke-dasharray="`${dash} ${circumference}`"
          :transform="`rotate(-90 ${size / 2} ${size / 2})`"
        />
      </svg>
      <span class="donut__count">
        <span class="display-sm">{{ done }}/{{ total }}</span>
      </span>
    </div>
    <div class="donut__text">
      <h3 class="title-md">{{ title }} <span class="caption-sm text-muted">{{ done }} of {{ total }}</span></h3>
      <ul class="donut__list">
        <li v-for="person in people" :key="person.name" class="donut__row" :class="{ 'is-done': person.done }">
          <span class="donut__mark"><AppIcon v-if="person.done" name="check" :size="10" /></span>
          <span class="body-sm truncate">{{ person.name }}</span>
          <span class="caption-sm donut__state">{{ person.note || (person.done ? doneLabel : todoLabel) }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.donut { display: flex; align-items: flex-start; gap: var(--spacing-lg); }
.donut__chart { position: relative; flex-shrink: 0; }
.donut__track { stroke: var(--primary-tint); }
.donut__arc { stroke: var(--primary); transition: stroke-dasharray var(--motion-fast) ease; }
.donut__count { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--ink); }
.donut__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-sm); }
.donut__list { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.donut__row { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-sm); min-height: 24px; }
.donut__mark { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border: 1.5px solid var(--border-strong); border-radius: var(--rounded-full); color: var(--on-primary); }
.donut__row.is-done .donut__mark { border-color: var(--primary); background: var(--primary); }
.donut__state { color: var(--muted); }
.donut__row.is-done .donut__state { color: var(--primary-active); }
</style>
