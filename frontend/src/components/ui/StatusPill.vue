<script>
// Kept outside <script setup> so the prop validator below can use it.
const LABELS = {
  inviting: 'Inviting',
  locating: 'Locating',
  voting: 'Voting',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
}
</script>

<script setup>
// The status of a session. Show it on every session card and at the top of every session screen.
// Usage: <StatusPill status="voting" />
//   Inviting   outlined
//   Locating   Lagoon tint
//   Voting     Lagoon tint
//   Confirmed  Lagoon fill
//   Completed  ink
//   Cancelled  error red
import { computed } from 'vue'

const props = defineProps({
  status: { type: String, required: true, validator: (v) => v in LABELS },
})

const label = computed(() => LABELS[props.status])
</script>

<template>
  <span class="pill" :class="`pill--${status}`">{{ label }}</span>
</template>

<style scoped>
.pill {
  flex-shrink: 0;
  display: inline-block;
  padding: var(--spacing-xs) 10px;
  border: 1px solid transparent;
  border-radius: var(--rounded-full);
  font: var(--text-badge);
  white-space: nowrap;
}
.pill--inviting { border-color: var(--ink); background: var(--canvas); color: var(--ink); }
.pill--locating, .pill--voting { border-color: var(--primary-tint); background: var(--primary-tint); color: var(--primary-active); }
.pill--confirmed { border-color: var(--primary); background: var(--primary); color: var(--on-primary); }
.pill--completed { border-color: var(--ink); background: var(--ink); color: var(--on-dark); }
.pill--cancelled { border-color: var(--primary-error-text); background: var(--primary-error-text); color: var(--on-primary); }
</style>
