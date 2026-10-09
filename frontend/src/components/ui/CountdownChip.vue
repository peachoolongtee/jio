<script setup>
// When a session starts, live: "Starts in 50 min", "Tomorrow, 15:00", "Live now", "Ended".
//   <CountdownChip :session="session" />
// Renders nothing for completed or cancelled sessions.
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { startsIn } from '@/lib/session.js'
import { useNow } from '@/lib/useNow.js'

const props = defineProps({
  session: { type: Object, required: true },
})
const now = useNow()
const info = computed(() => startsIn(props.session, now.value))
</script>

<template>
  <span v-if="info" class="count" :class="`count--${info.tone}`">
    <span v-if="info.tone === 'live'" class="count__live" aria-hidden="true" />
    <AppIcon v-else name="clock" :size="13" />
    <span class="tnum">{{ info.text }}</span>
  </span>
</template>

<style scoped>
.count { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: var(--rounded-full); background: var(--surface-strong); font: var(--text-badge); font-size: 12px; white-space: nowrap; }
.count--soon { color: var(--ink); }
.count--later { color: var(--body); }
.count--muted { color: var(--muted); }
/* Live is a Rausch moment: the session is happening now. */
.count--live { background: var(--primary); color: var(--on-primary); }
/* A real live indicator, not decoration: it only shows while the session is happening. */
.count__live { width: 7px; height: 7px; border-radius: var(--rounded-full); background: currentColor; }
@media (prefers-reduced-motion: no-preference) {
  .count__live { animation: live 1.6s ease-in-out infinite; }
  @keyframes live { 50% { opacity: 0.35; } }
}
</style>
