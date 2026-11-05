<script setup>
// Where a meetup stands, on Home's rows and its card (walkthrough, 30 October 2026), as tinted badges (StatusBadge): the stage
// (Planning blue, Voting amber, Ready green, Done violet, Cancelled red), then, only when it is on the person, an orange "Your turn ·
// Vote", or, when it is on someone else, a grey "Waiting for the host". A meetup with nothing to do shows its stage alone. Not a
// control: the row or the card's button opens the meetup.
//   <MeetupStatus :status="homeStatus(session, 'ian')" />
import StatusBadge from '../ui/StatusBadge.vue'

const TONE = { Planning: 'planning', Voting: 'voting', Ready: 'ready', Done: 'done', Cancelled: 'cancelled' }

defineProps({
  // { stage, turn, waiting } from lib/homeMeetups.js homeStatus.
  status: { type: Object, required: true },
})
</script>

<template>
  <span class="meetup-status" data-testid="meetup-status">
    <StatusBadge :tone="TONE[status.stage] || 'planning'">{{ status.stage }}</StatusBadge>
    <StatusBadge v-if="status.turn" tone="turn" data-testid="your-turn">Your turn · {{ status.turn }}</StatusBadge>
    <StatusBadge v-else-if="status.waiting" tone="waiting">{{ status.waiting }}</StatusBadge>
  </span>
</template>

<style scoped>
.meetup-status { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs); min-width: 0; max-width: 100%; }
</style>
