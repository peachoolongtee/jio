<script setup>
// What a meetup needs next, as a small label: "Share your start", "Waiting for others", "See the plan".
//   <NextStepChip :step="nextStepFor(session, 'ian')" />
// step: { label, tone } from lib/homeMeetups.js. 'action' (it is on you) is outlined in ink and bold with an arrow, 'wait'
// is grey with a clock, 'done' is grey with a tick, so the tone never rests on colour alone. Not a control.
import { computed } from 'vue'
import InfoTag from '../ui/InfoTag.vue'

const props = defineProps({
  step: { type: Object, required: true },
})

const ICONS = { action: 'arrow-right', wait: 'clock', done: 'check' }
const icon = computed(() => ICONS[props.step.tone] || '')
</script>

<template>
  <InfoTag :tone="step.tone === 'action' ? 'strong' : 'neutral'" :icon="icon" class="next-step">{{ step.label }}</InfoTag>
</template>

<style scoped>
/* A long step ("Say which spots work for you") wraps inside its row instead of running past it at 320px. The corner is a
   little less round so a wrapped label still sits in a tidy shape. */
.next-step.tag { max-width: 100%; border-radius: var(--rounded-md); white-space: normal; text-align: left; }
</style>
