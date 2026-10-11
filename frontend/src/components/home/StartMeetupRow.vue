<script setup>
// The action that starts another meetup, as the first row of Home's list of meetups (and alone under the card when only one
// is going). It is a link to the create screen, not a meetup: it is never selected and never changes ?meetup=.
//   <StartMeetupRow :href="startHref" @start="startAnother" />
// It has the box of a meetup row (MeetupList), with a plus where the row has its day, and the label "Plan a new meetup" over
// "Jio your friends". It stands out as the list's action with a red-tinted outline and badge, as the current tab in TabBar
// is tinted, and not with a red fill: white on the brand red is below 4.5:1 (DESIGN.md, Known Conflicts). The plus is red
// on the tint (an icon, 3:1), and every word is ink or muted. A click with no modifier key is handed to the parent as
// `start`, which plays the red burst from the plus (the element marked data-burst); a click that opens a new tab is left alone.
import AppIcon from '../ui/AppIcon.vue'

defineProps({
  href: { type: String, required: true },
})
const emit = defineEmits(['start'])
</script>

<template>
  <a class="srow" :href="href" @click="emit('start', $event)">
    <span class="srow__plus" data-burst aria-hidden="true"><AppIcon name="plus" :size="20" /></span>
    <span class="srow__text">
      <span class="srow__title title-md">Plan a new meetup</span>
      <span class="srow__meta body-sm text-muted">Jio your friends</span>
    </span>
  </a>
</template>

<style scoped>
/* The same box as .mrow in MeetupList: padding, 1px border, 14px corners, a 44px badge, a 12px gap. */
.srow {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  width: 100%;
  min-height: var(--tap-min);
  padding: var(--spacing-md) var(--spacing-base);
  border: 1px solid color-mix(in srgb, var(--primary) 35%, var(--canvas));
  border-radius: var(--rounded-md);
  background: var(--canvas);
  color: var(--ink);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
  transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}
@media (hover: hover) { .srow:hover { border-color: var(--primary); background: var(--surface-soft); } }
.srow__plus { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: var(--rounded-full); background: color-mix(in srgb, var(--primary) 11%, var(--canvas)); color: var(--primary); }
.srow__text { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-xs); flex: 1 1 0; min-width: 0; }
.srow__title, .srow__meta { display: block; max-width: 100%; }
@media (prefers-reduced-motion: reduce) { .srow { transition: none; } }
</style>
