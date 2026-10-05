<script setup>
// Step 1: create a session. Title, date and a time window.
// Next stays disabled until the title, the date and the start time are set.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { addDays, format, startOfDay } from 'date-fns'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import IconButton from '@/components/ui/IconButton.vue'
import TextField from '@/components/ui/TextField.vue'
import { fromMinutes, toMinutes } from '@/lib/planner/format.js'
import { useEventsStore } from '@/stores/events.js'

const TITLE_IDEAS = ['Saturday hangout', 'Dinner catch-up', 'Weekend makan trip']
const DEFAULT_LENGTH = 6 * 60

const router = useRouter()
const events = useEventsStore()

const title = ref('')
const date = ref('') // yyyy-MM-dd
const start = ref('')
const end = ref('')
const busy = ref(false)
const error = ref('')

// The date strip shows the next two weeks, starting today.
const today = startOfDay(new Date())
const days = Array.from({ length: 14 }, (_, i) => {
  const day = addDays(today, i)
  return { key: format(day, 'yyyy-MM-dd'), weekday: format(day, 'EEE'), number: format(day, 'd'), label: format(day, 'EEEE d MMMM') }
})

const dateText = computed(() => days.find((day) => day.key === date.value)?.label || format(today, 'MMMM yyyy'))
// Without an end time the window runs six hours, up to midnight.
const endValue = computed(() => end.value || (start.value ? fromMinutes(Math.min(toMinutes(start.value) + DEFAULT_LENGTH, 23 * 60 + 59)) : ''))
const endError = computed(() => (start.value && end.value && toMinutes(end.value) <= toMinutes(start.value) ? 'End time must be after the start time.' : ''))
const ready = computed(() => title.value.trim().length > 0 && date.value !== '' && start.value !== '' && !endError.value)

async function next() {
  if (!ready.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const session = await events.create({ title: title.value, date: date.value, start: start.value, end: endValue.value })
    router.replace(`/sessions/${session.id}/invite`)
  } catch (e) {
    error.value = e.message
    busy.value = false
  }
}
</script>

<template>
  <main class="screen screen--form" data-testid="create-event-view">
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton label="Back" to="/"><AppIcon name="back" /></IconButton>
        <span class="caption text-muted">Step 1 of 2</span>
        <span class="bar-spacer" />
      </div>
      <div class="screen__titles">
        <h1 class="display-xl">Create session</h1>
      </div>
    </header>

    <form class="screen__body" novalidate @submit.prevent="next">
      <div class="stack gap-xs">
        <TextField v-model="title" label="Title" placeholder="Name your session" maxlength="60" />
        <div class="scroll-x" role="group" aria-label="Title ideas">
          <ChipButton v-for="idea in TITLE_IDEAS" :key="idea" :selected="title === idea" @click="title = idea">{{ idea }}</ChipButton>
        </div>
      </div>

      <div class="stack gap-sm">
        <div class="row between">
          <span id="date-label" class="caption text-muted">Date</span>
          <span class="caption-sm text-brand">{{ dateText }}</span>
        </div>
        <div class="scroll-x days" role="radiogroup" aria-labelledby="date-label">
          <div v-for="day in days" :key="day.key" class="day">
            <span class="caption-sm text-muted" aria-hidden="true">{{ day.weekday }}</span>
            <button
              type="button"
              class="day__button"
              :class="{ 'is-selected': date === day.key }"
              role="radio"
              :aria-checked="String(date === day.key)"
              :aria-label="day.label"
              @click="date = day.key"
            >
              {{ day.number }}
            </button>
          </div>
        </div>
      </div>

      <div class="two-up">
        <TextField v-model="start" label="Start time" type="time" step="900" />
        <TextField v-model="end" label="End time" type="time" step="900" :placeholder="endValue" :error="endError" :hint="!end && start ? `Ends ${endValue}` : ''" />
      </div>
      <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    </form>

    <footer class="screen__footer">
      <AppButton block :disabled="!ready || busy" @click="next">Next</AppButton>
    </footer>
  </main>
</template>

<style scoped>
.bar-spacer { width: var(--tap-min); }
.two-up { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }

/* The date strip: one column per day, a round 40px button that turns Lagoon when picked. */
.days { padding: var(--spacing-xxs) var(--gutter) var(--spacing-xxs) var(--spacing-xxs); }
.day { flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: var(--spacing-xs); width: 44px; }
.day__button {
  position: relative;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--rounded-full);
  background: var(--canvas);
  color: var(--ink);
  font: var(--text-body-sm);
}
.day__button.is-selected { border-color: var(--primary); background: var(--primary); color: var(--on-primary); }
@media (hover: hover) { .day__button:not(.is-selected):hover { border-color: var(--ink); } }
@media (min-width: 1128px) {
  .screen__footer { justify-content: stretch; }
  .screen__footer > :deep(.btn--block) { width: 100%; }
}
</style>
