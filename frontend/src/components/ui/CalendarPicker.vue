<script setup>
// A month calendar for picking one day. Weeks start on Monday; days before `min` are greyed out.
//   <CalendarPicker v-model="date" label="Date" />            date is "yyyy-MM-dd", or "" for none picked
//   <CalendarPicker v-model="date" label="Date" min="2026-10-09" max="2026-12-31" />
// The arrows move a month at a time and stop at the months that hold `min` and `max`.
import { computed, ref, watch } from 'vue'
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameMonth, parseISO, startOfDay, startOfMonth, startOfWeek } from 'date-fns'
import AppIcon from './AppIcon.vue'

const model = defineModel({ type: String, default: '' })
const props = defineProps({
  label: { type: String, default: 'Date' },
  // The earliest and latest days that can be picked, as "yyyy-MM-dd". `min` defaults to today.
  min: { type: String, default: '' },
  max: { type: String, default: '' },
})

const KEY = 'yyyy-MM-dd'
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const todayKey = format(startOfDay(new Date()), KEY)
const minKey = computed(() => props.min || todayKey)

// The month on show: the picked day's month, or this month.
const month = ref(startOfMonth(model.value ? parseISO(model.value) : new Date()))
watch(model, (v) => { if (v) month.value = startOfMonth(parseISO(v)) })

const canBack = computed(() => format(month.value, 'yyyy-MM') > minKey.value.slice(0, 7))
const canForward = computed(() => !props.max || format(month.value, 'yyyy-MM') < props.max.slice(0, 7))

// Six rows of seven, Monday first, padded with the neighbouring months' days.
const weeks = computed(() => {
  const first = startOfWeek(startOfMonth(month.value), { weekStartsOn: 1 })
  const last = endOfWeek(endOfMonth(month.value), { weekStartsOn: 1 })
  const days = []
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const key = format(d, KEY)
    days.push({
      key,
      number: format(d, 'd'),
      label: format(d, 'EEEE d MMMM yyyy'),
      inMonth: isSameMonth(d, month.value),
      disabled: key < minKey.value || (props.max && key > props.max),
      today: key === todayKey,
    })
  }
  return Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7))
})
</script>

<template>
  <div class="cal" role="group" :aria-label="label">
    <div class="cal__head">
      <span class="title-md" aria-live="polite">{{ format(month, 'MMMM yyyy') }}</span>
      <div class="cal__nav">
        <button type="button" class="cal__arrow" :disabled="!canBack" aria-label="Previous month" @click="month = addMonths(month, -1)">
          <AppIcon name="back" :size="16" />
        </button>
        <button type="button" class="cal__arrow" :disabled="!canForward" aria-label="Next month" @click="month = addMonths(month, 1)">
          <AppIcon name="chevron-right" :size="16" />
        </button>
      </div>
    </div>
    <table class="cal__grid">
      <thead>
        <tr><th v-for="w in WEEKDAYS" :key="w" scope="col" class="caption-sm text-muted">{{ w }}</th></tr>
      </thead>
      <tbody>
        <tr v-for="(week, i) in weeks" :key="i">
          <td v-for="day in week" :key="day.key">
            <button
              type="button"
              class="cal__day"
              :class="{ 'is-selected': model === day.key, 'is-today': day.today, 'is-outside': !day.inMonth }"
              :disabled="day.disabled"
              :aria-label="day.label"
              :aria-pressed="String(model === day.key)"
              @click="model = day.key"
            >
              {{ day.number }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.cal { display: flex; flex-direction: column; gap: var(--spacing-md); padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.cal__head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); padding-left: var(--spacing-xs); }
.cal__nav { display: flex; gap: var(--spacing-xs); }
.cal__arrow { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border: 1px solid var(--hairline); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); cursor: pointer; }
.cal__arrow:disabled { color: var(--muted-soft); cursor: default; }
.cal__grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
.cal__grid th { padding-bottom: var(--spacing-xs); font-weight: 500; text-align: center; }
.cal__grid td { padding: 2px; text-align: center; }
/* A day: a round button that fills ink when picked. Today has a ring; other months' days are faint. */
.cal__day { width: 100%; max-width: 44px; aspect-ratio: 1; padding: 0; border: 1px solid transparent; border-radius: var(--rounded-full); background: transparent; color: var(--ink); font: var(--text-body-sm); cursor: pointer; }
.cal__day.is-outside { color: var(--muted); }
.cal__day.is-today { border-color: var(--border-strong); font-weight: 600; }
.cal__day.is-selected { border-color: var(--selected); background: var(--selected); color: var(--on-selected); font-weight: 600; }
.cal__day:disabled { color: var(--muted-soft); cursor: default; text-decoration: line-through; text-decoration-color: var(--hairline); }
@media (hover: hover) { .cal__day:not(:disabled):not(.is-selected):hover { background: var(--surface-soft); } }
.cal__day:focus-visible, .cal__arrow:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
</style>
