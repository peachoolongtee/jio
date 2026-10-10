<script setup>
// Every meetup going, soonest first, as rows that select. Selecting here does the same as selecting its pin on the map.
//   <MeetupList :meetups="meetups" :selected-id="selected.id" my-id="ian" @select="select" />
// Each row is one button: the day, the title, when and where, and what it needs next. A meetup with no meeting point has
// no pin, so its day badge has a dashed outline and its row says so in words. The selected row has a thicker ink outline
// and a filled day badge, and is aria-pressed. A long title is cut with an ellipsis; the whole title is in the text and the tooltip, and the card under the map (select the row) wraps it.
import { dayLabel, nextStepFor, whenLine } from '@/lib/homeMeetups.js'
import NextStepChip from './NextStepChip.vue'

defineProps({
  meetups: { type: Array, required: true },
  selectedId: { type: String, default: '' },
  myId: { type: String, required: true },
})
const emit = defineEmits(['select'])
</script>

<template>
  <ul class="mlist">
    <li v-for="m in meetups" :key="m.id">
      <button type="button" class="mrow" :class="{ 'is-selected': m.id === selectedId }" :aria-pressed="m.id === selectedId" @click="emit('select', m.id)">
        <span class="mrow__day tnum" :class="{ 'is-nopin': !m.area }" aria-hidden="true">{{ dayLabel(m) }}</span>
        <span class="mrow__text">
          <span class="mrow__title title-md truncate" :title="m.title">{{ m.title }}</span>
          <span class="mrow__meta body-sm text-muted clamp-2">{{ whenLine(m) }} · {{ m.area ? m.area.name : 'no meeting point yet' }}</span>
          <NextStepChip :step="nextStepFor(m, myId)" class="mrow__chip" />
        </span>
      </button>
    </li>
  </ul>
</template>

<style scoped>
.mlist { display: flex; flex-direction: column; gap: var(--spacing-sm); margin: 0; padding: 0; list-style: none; }
.mrow {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  width: 100%;
  min-height: var(--tap-min);
  padding: var(--spacing-md) var(--spacing-base);
  border: 1px solid var(--hairline);
  border-radius: var(--rounded-md);
  background: var(--canvas);
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}
/* Selected: a 2px ink outline, the padding giving back the extra pixel so nothing moves. */
.mrow.is-selected { padding: 11px calc(var(--spacing-base) - 1px); border: 2px solid var(--ink); background: var(--surface-soft); }
@media (hover: hover) { .mrow:not(.is-selected):hover { background: var(--surface-soft); } }
.mrow__day { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border: 1px solid transparent; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); font: var(--text-badge); font-weight: 700; white-space: nowrap; }
.mrow__day.is-nopin { border: 1px dashed var(--border-strong); background: var(--canvas); }
.mrow.is-selected .mrow__day { border-style: solid; border-color: transparent; background: var(--selected); color: var(--on-selected); }
.mrow__text { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-xs); flex: 1 1 0; min-width: 0; }
.mrow__title, .mrow__meta { display: block; max-width: 100%; }
.mrow__chip { margin-top: var(--spacing-xxs); }
@media (prefers-reduced-motion: reduce) { .mrow { transition: none; } }
</style>
