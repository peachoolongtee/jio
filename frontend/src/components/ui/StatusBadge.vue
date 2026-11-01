<script>
// Kept outside <script setup> so the prop validator below can use it.
const ICON = { turn: 'warning', planning: 'circle-dashed', voting: 'scan-search', ready: 'circle-check', done: 'circle-check', cancelled: 'circle-x', waiting: 'clock' }
</script>

<script setup>
// A status badge (walkthrough, 30 October 2026): a rounded pill with a bold icon and bold words, in the app's own colours (Faith, 31 October
// 2026), each pair over 4.5:1 (tokens.css, --status-*). Not a control. The tones and their icons:
//   turn       solid deep Rausch, white   warning        it is on you
//   voting     Rausch tint, dark Rausch   scan           voting
//   ready      solid ink, white           circle tick    the plan is confirmed
//   planning   light grey, ink            dashed circle  inviting or finding the place
//   done       pale grey, muted           circle tick    the outing is over
//   cancelled  pale grey, error red       circle cross
//   waiting    pale grey, muted           clock          it is on someone else
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
.status-badge { --fg: var(--status-waiting-fg); --bg: var(--status-waiting-bg); display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-height: 28px; padding: 0 var(--spacing-sm); border-radius: 10px; background: var(--bg); color: var(--fg); font: var(--text-caption); font-weight: 600; white-space: nowrap; }
.status-badge__icon { flex-shrink: 0; stroke-width: 2.25; }
.status-badge--turn { --fg: var(--status-turn-fg); --bg: var(--status-turn-bg); }
.status-badge--planning { --fg: var(--status-planning-fg); --bg: var(--status-planning-bg); }
.status-badge--voting { --fg: var(--status-voting-fg); --bg: var(--status-voting-bg); }
.status-badge--ready { --fg: var(--status-ready-fg); --bg: var(--status-ready-bg); }
.status-badge--done { --fg: var(--status-done-fg); --bg: var(--status-done-bg); }
.status-badge--cancelled { --fg: var(--status-cancelled-fg); --bg: var(--status-cancelled-bg); }
.status-badge--waiting { --fg: var(--status-waiting-fg); --bg: var(--status-waiting-bg); }
</style>
