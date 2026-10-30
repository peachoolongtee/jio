<script>
// Kept outside <script setup> so the prop validator below can use it.
const ICON = { turn: 'warning', planning: 'circle-dashed', voting: 'scan-search', ready: 'circle-check', done: 'circle-check', cancelled: 'circle-x', waiting: 'clock' }
</script>

<script setup>
// A status badge (walkthrough, 30 October 2026): a rounded pill tinted in its tone's hue, with a bold icon and bold words in the same
// hue, darker, so the words stay over 4.5:1 on the tint. Not a control. The tones and their icons:
//   turn       orange, warning        it is on you
//   planning   blue, dashed circle    inviting or finding the place
//   voting     amber, scan            voting
//   ready      green, circle tick     the plan is confirmed
//   done       violet, circle tick    the outing is over
//   cancelled  red, circle cross
//   waiting    grey, clock            it is on someone else
//   <StatusBadge tone="ready">Ready</StatusBadge>
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  tone: { type: String, required: true, validator: (v) => v in ICON },
})
const icon = computed(() => ICON[props.tone])
</script>

<template>
  <span class="status-badge" :class="`status-badge--${tone}`"><AppIcon :name="icon" :size="14" class="status-badge__icon" /><span class="truncate"><slot /></span></span>
</template>

<style scoped>
.status-badge { --fg: var(--status-waiting-fg); display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-height: 28px; padding: 0 var(--spacing-sm); border-radius: 10px; background: color-mix(in srgb, var(--fg) 10%, var(--canvas)); color: var(--fg); font: var(--text-caption); font-weight: 600; white-space: nowrap; }
.status-badge__icon { flex-shrink: 0; stroke-width: 2.25; }
.status-badge--turn { --fg: var(--status-turn-fg); }
.status-badge--planning { --fg: var(--status-planning-fg); }
.status-badge--voting { --fg: var(--status-voting-fg); }
.status-badge--ready { --fg: var(--status-ready-fg); }
.status-badge--done { --fg: var(--status-done-fg); }
.status-badge--cancelled { --fg: var(--status-cancelled-fg); }
.status-badge--waiting { --fg: var(--status-waiting-fg); }
</style>
