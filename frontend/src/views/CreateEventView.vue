<script setup>
// Step 1: create a session. Title, a day from the calendar and a time window.
// The times sit to the right of the calendar from tablet up (start on top, end below), and under it on phones.
// Next stays disabled until the title, the date and the start time are set.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { addDays, format, startOfDay } from 'date-fns'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import CalendarPicker from '@/components/ui/CalendarPicker.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import IconButton from '@/components/ui/IconButton.vue'
import SessionSteps from '@/components/event/SessionSteps.vue'
import RadialTimePicker from '@/components/ui/RadialTimePicker.vue'
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

// Sessions can be planned up to three months ahead.
const today = startOfDay(new Date())
const lastDay = format(addDays(today, 90), 'yyyy-MM-dd')
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
  <main class="screen screen--wide-form" data-testid="create-event-view">
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton label="Back" to="/"><AppIcon name="back" /></IconButton>
      </div>
      <div class="screen__titles">
        <h1 class="display-xl">Create session</h1>
      </div>
      <SessionSteps />
    </header>

    <form class="screen__body" novalidate @submit.prevent="next">
      <div class="stack gap-xs">
        <TextField v-model="title" label="Title" placeholder="Name your session" maxlength="60" />
        <div class="scroll-x" role="group" aria-label="Title ideas">
          <ChipButton v-for="idea in TITLE_IDEAS" :key="idea" :selected="title === idea" @click="title = idea">{{ idea }}</ChipButton>
        </div>
      </div>

      <section class="when" aria-labelledby="when-label">
        <span id="when-label" class="sr-only">Date and time</span>
        <CalendarPicker v-model="date" class="when__calendar" label="Date" :max="lastDay" />
        <div class="when__times">
          <RadialTimePicker v-model="start" label="Start time" fallback="09:00" />
          <RadialTimePicker v-model="end" label="End time" :fallback="endValue || '18:00'" :error="endError" :hint="!end && start ? `Ends ${endValue} unless you change it` : ''" />
        </div>
      </section>
      <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    </form>

    <footer class="screen__footer">
      <AppButton next block :disabled="!ready || busy" @click="next">Next</AppButton>
    </footer>
  </main>
</template>

<style scoped>

/* Date and time: the calendar, then the times. Phones stack them; from tablet up the times sit to the right,
   start at the top and end at the bottom, each centred so its buttons have room to fly out. */
.when { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--spacing-md) var(--spacing-xl); }
.when__times { display: flex; flex-direction: column; align-items: center; gap: var(--spacing-xl); padding: var(--spacing-base) 0; }
@media (min-width: 744px) {
  .when { grid-template-columns: minmax(0, 1fr) 240px; grid-template-areas: "calendar times"; }
  .when__calendar { grid-area: calendar; }
  .when__times { grid-area: times; justify-content: space-between; padding: var(--spacing-lg) 0; }
}
/* Tablet and up: the action follows the form, right-aligned at a normal width, instead of a full-width bar
   pinned to the bottom of the window. Phones keep the pinned bar, where the thumb is. */
@media (min-width: 744px) {
  .screen__body { flex: 0 0 auto; }
  .screen__footer { position: static; flex-direction: row; justify-content: flex-end; padding-top: 0; border-top: 0; }
}
</style>
