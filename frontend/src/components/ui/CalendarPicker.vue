<script>
import { addDays, addMonths, endOfWeek, format, parseISO, startOfWeek } from 'date-fns'

// Where the keyboard moves from one day: arrows by a day or a week, Home and End to the start and end of the week
// (Monday to Sunday), Page Up and Page Down by a month. Stays inside `min` and `max` ("yyyy-MM-dd", either may be
// ''). Returns the new day, or null for any other key.
// How to call: dayAfterKey('2026-10-09', 'ArrowRight', '2026-10-01', '') -> '2026-10-10'
export function dayAfterKey(from, key, min = '', max = '') {
  const day = parseISO(from)
  const weekOptions = { weekStartsOn: 1 }
  const moves = {
    ArrowLeft: () => addDays(day, -1),
    ArrowRight: () => addDays(day, 1),
    ArrowUp: () => addDays(day, -7),
    ArrowDown: () => addDays(day, 7),
    Home: () => startOfWeek(day, weekOptions),
    End: () => endOfWeek(day, weekOptions),
    PageUp: () => addMonths(day, -1),
    PageDown: () => addMonths(day, 1),
  }
  if (!moves[key]) return null
  const next = format(moves[key](), 'yyyy-MM-dd')
  if (min && next < min) return min
  if (max && next > max) return max
  return next
}
</script>

<script setup>
// A month calendar for picking one day. Weeks start on Monday; days before `min` are greyed out.
// With a keyboard the grid is one Tab stop: arrows move between days, Home and End go to the start and end of the
// week, Page Up and Page Down change the month. Today is marked for screen readers as the current date.
//   <CalendarPicker v-model="date" label="Date" />            date is "yyyy-MM-dd", or "" for none picked
//   <CalendarPicker v-model="date" label="Date" min="2026-10-09" max="2026-12-31" />
// The arrows move a month at a time and stop at the months that hold `min` and `max`.
import { computed, nextTick, ref, watch } from 'vue'
import { endOfMonth, isSameMonth, startOfDay, startOfMonth } from 'date-fns'
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

// Roving tabindex: the one day Tab reaches. The day last moved to, else the picked day, else today, else the first
// day of the month that can be picked.
const root = ref(null)
const focusKey = ref('')
const tabKey = computed(() => {
  const open = weeks.value.flat().filter((d) => !d.disabled)
  const wanted = [focusKey.value, model.value, todayKey]
  return wanted.find((key) => open.some((d) => d.key === key)) || open.find((d) => d.inMonth)?.key || open[0]?.key || ''
})

async function onDayKeydown(event, day) {
  const next = dayAfterKey(day.key, event.key, props.min || todayKey, props.max)
  if (!next) return
  event.preventDefault()
  focusKey.value = next
  month.value = startOfMonth(parseISO(next))
  await nextTick()
  root.value?.querySelector(`[data-day="${next}"]`)?.focus()
}
</script>

<template>
  <div ref="root" class="cal" role="group" :aria-label="label">
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
              :data-day="day.key"
              :tabindex="day.key === tabKey ? 0 : -1"
              :aria-label="day.label"
              :aria-current="day.today ? 'date' : undefined"
              :aria-pressed="String(model === day.key)"
              @click="model = day.key"
              @keydown="onDayKeydown($event, day)"
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
.cal__arrow { display: inline-flex; align-items: center; justify-content: center; width: var(--tap-min); height: var(--tap-min); border: 1px solid var(--hairline); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); cursor: pointer; }
.cal__arrow:disabled { color: var(--muted-soft); cursor: default; }
.cal__grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
.cal__grid th { padding-bottom: var(--spacing-xs); font-weight: 500; text-align: center; }
.cal__grid td { padding: 0; text-align: center; }
/* A day: a round button that fills Rausch when picked. Today has a ring; other months' days are faint. It is as tall as a
   tap target and as wide as its column, up to the same size; on a narrow screen seven columns are narrower than that. */
.cal__day { width: 100%; max-width: var(--tap-min); height: var(--tap-min); padding: 0; border: 1px solid transparent; border-radius: var(--rounded-full); background: transparent; color: var(--ink); font: var(--text-body-sm); cursor: pointer; }
.cal__day.is-outside { color: var(--muted); }
.cal__day.is-today { border-color: var(--border-strong); font-weight: 600; }
/* The picked day: a solid Rausch circle. */
.cal__day.is-selected { border-color: var(--primary); background: var(--primary); color: var(--on-primary); font-weight: 600; }
.cal__day:disabled { color: var(--muted-soft); cursor: default; text-decoration: line-through; text-decoration-color: var(--hairline); }
@media (max-width: 480px) { .cal { padding: var(--spacing-md) var(--spacing-sm); } }
@media (hover: hover) { .cal__day:not(:disabled):not(.is-selected):hover { background: var(--surface-soft); } }
.cal__day:focus-visible, .cal__arrow:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
</style>
