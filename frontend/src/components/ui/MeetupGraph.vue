<script setup>
// Meetup frequency, in the style of a GitHub contribution graph but with circles.
// Columns are weeks (oldest on the left), rows are days Monday to Sunday.
//   <MeetupGraph :history="[{ date: '2026-09-26', count: 1 }]" :planned="['2026-10-10']" />
// Shades of Rausch show how many meetups happened that day; hatched circles are planned sessions;
// a ring marks today. The summary line and legend say the same thing in words.
import { computed, nextTick, onMounted, ref } from 'vue'
import { addDays, differenceInCalendarWeeks, format, parseISO, startOfWeek, subWeeks } from 'date-fns'

const props = defineProps({
  history: { type: Array, default: () => [] },
  planned: { type: Array, default: () => [] },
  weeks: { type: Number, default: 26 },
  today: { type: Date, default: () => new Date() },
})

const scroller = ref(null)
const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', '']

const counts = computed(() => Object.fromEntries(props.history.map((h) => [h.date, h.count])))
const plannedSet = computed(() => new Set(props.planned))
const todayKey = computed(() => format(props.today, 'yyyy-MM-dd'))

// Show the last `weeks` weeks, and stretch to the right to include planned sessions up to 6 weeks ahead.
const grid = computed(() => {
  const first = startOfWeek(subWeeks(props.today, props.weeks - 1), { weekStartsOn: 1 })
  const lastPlanned = props.planned.map((d) => parseISO(d)).filter((d) => d > props.today).sort((a, b) => b - a)[0]
  const extra = lastPlanned ? Math.min(6, Math.max(0, differenceInCalendarWeeks(lastPlanned, props.today, { weekStartsOn: 1 }))) : 0
  const columns = []
  for (let w = 0; w < props.weeks + extra; w += 1) {
    const days = []
    for (let d = 0; d < 7; d += 1) {
      const day = addDays(first, w * 7 + d)
      const key = format(day, 'yyyy-MM-dd')
      const count = counts.value[key] || 0
      const future = key > todayKey.value
      days.push({
        key,
        count,
        level: count >= 3 ? 3 : count,
        planned: plannedSet.value.has(key) && !count,
        today: key === todayKey.value,
        future,
        label: `${format(day, 'EEE d MMM')}: ${plannedSet.value.has(key) && !count ? 'planned session' : count ? `${count} ${count === 1 ? 'meetup' : 'meetups'}` : 'no meetups'}`,
      })
    }
    columns.push({ key: days[0].key, month: format(addDays(first, w * 7), 'MMM'), days })
  }
  // Only label a column when the month changes.
  return columns.map((c, i) => ({ ...c, showMonth: i === 0 || c.month !== columns[i - 1].month }))
})

const total = computed(() => props.history.reduce((sum, h) => sum + h.count, 0))
const months = computed(() => Math.round(props.weeks / 4.35))
const upcoming = computed(() => props.planned.filter((d) => d >= todayKey.value).length)

// Start scrolled to the most recent weeks on narrow screens.
onMounted(async () => {
  await nextTick()
  if (scroller.value) scroller.value.scrollLeft = scroller.value.scrollWidth
})
</script>

<template>
  <figure class="graph">
    <figcaption class="graph__head">
      <span class="display-sm tnum">{{ total }}</span>
      <span class="caption-sm text-muted">{{ total === 1 ? 'meetup' : 'meetups' }} in the last {{ months }} months<template v-if="upcoming"> · {{ upcoming }} planned</template></span>
    </figcaption>

    <div class="graph__body">
      <div class="graph__days" aria-hidden="true">
        <span class="graph__month" />
        <span v-for="(d, i) in DAY_LABELS" :key="i" class="graph__daylabel">{{ d }}</span>
      </div>
      <div ref="scroller" class="graph__scroll">
      <div class="graph__grid" role="img" :aria-label="`${total} meetups in the last ${months} months${upcoming ? `, ${upcoming} planned` : ''}`">
        <div v-for="col in grid" :key="col.key" class="graph__col" aria-hidden="true">
          <span class="graph__month">{{ col.showMonth ? col.month : '' }}</span>
          <span
            v-for="day in col.days"
            :key="day.key"
            class="graph__cell"
            :class="[`lvl-${day.level}`, { 'is-planned': day.planned, 'is-today': day.today, 'is-future': day.future && !day.planned }]"
            :title="day.label"
          />
        </div>
      </div>
      </div>
    </div>

    <div class="graph__legend caption-sm text-muted" aria-hidden="true">
      <span>Less</span>
      <span class="graph__cell lvl-0" />
      <span class="graph__cell lvl-1" />
      <span class="graph__cell lvl-2" />
      <span class="graph__cell lvl-3" />
      <span>More</span>
      <span class="graph__cell is-planned graph__gap" />
      <span>Planned</span>
    </div>
  </figure>
</template>

<style scoped>
.graph { display: flex; flex-direction: column; gap: var(--spacing-md); margin: 0; }
.graph__head { display: flex; align-items: baseline; gap: var(--spacing-sm); }
.graph__body { display: flex; gap: 4px; min-width: 0; }
.graph__scroll { flex: 1 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.graph__scroll::-webkit-scrollbar { display: none; }
.graph__grid { display: flex; gap: 4px; width: max-content; }
.graph__days, .graph__col { display: grid; grid-template-rows: 16px repeat(7, 14px); gap: 4px; }
/* The day labels sit outside the scrolling weeks, so they never scroll away. */
.graph__days { flex-shrink: 0; }
.graph__daylabel { width: 26px; color: var(--muted); font: var(--text-caption-sm); font-size: 10px; line-height: 14px; }
.graph__month { color: var(--muted); font-size: 10px; line-height: 16px; white-space: nowrap; width: 14px; overflow: visible; }

.graph__cell { display: block; width: 14px; height: 14px; border-radius: var(--rounded-full); }
.lvl-0 { box-shadow: inset 0 0 0 1px var(--hairline); }
.lvl-1 { background: var(--primary-disabled); }
.lvl-2 { background: color-mix(in srgb, var(--primary) 60%, var(--canvas)); }
.lvl-3 { background: var(--primary); }
/* Planned: ink hatching, like a booked slot. */
.graph__cell.is-planned { background: repeating-linear-gradient(-45deg, var(--ink) 0 1.5px, var(--canvas) 1.5px 4px); box-shadow: inset 0 0 0 1px var(--ink); }
.graph__cell.is-future { opacity: 0.35; }
.graph__cell.is-today { outline: 2px solid var(--ink); outline-offset: 1px; }

.graph__legend { display: flex; align-items: center; gap: 5px; }
.graph__legend .graph__cell { width: 11px; height: 11px; }
.graph__gap { margin-left: var(--spacing-sm); }
</style>
