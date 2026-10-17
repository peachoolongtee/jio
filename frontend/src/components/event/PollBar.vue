<script setup>
// One option of a poll: name, vote count and a bar. Tap it to vote.
//   <div role="radiogroup" v-radio-group="{ follow: false }" aria-label="Stop 3">
//     <PollBar name="Junction 8" :votes="2" :total="3" leading mine @vote="vote('junction-8')" />
//   </div>
// `leading` highlights the option in ink. `note` is the word after the count: Leading, Winner or Tied.
// Set `closed` once the plan is confirmed: the bar stays but can no longer be tapped.
import { computed } from 'vue'
import AppIcon from '../ui/AppIcon.vue'

const props = defineProps({
  name: { type: String, required: true },
  votes: { type: Number, required: true },
  total: { type: Number, required: true },
  leading: { type: Boolean, default: false },
  // This is the option the current person voted for.
  mine: { type: Boolean, default: false },
  note: { type: String, default: '' },
  closed: { type: Boolean, default: false },
})
defineEmits(['vote'])

const width = computed(() => (props.total ? Math.round((props.votes / props.total) * 100) : 0) + '%')
const count = computed(() => `${props.votes} ${props.votes === 1 ? 'vote' : 'votes'}${props.note ? ' · ' + props.note : ''}`)
</script>

<template>
  <button type="button" class="poll" :class="{ 'is-leading': leading }" role="radio" :aria-checked="String(mine)" :disabled="closed" @click="$emit('vote')">
    <span class="poll__row">
      <span class="poll__name">
        <AppIcon v-if="mine" name="check" :size="14" label="Your vote" />
        <span class="truncate">{{ name }}</span>
      </span>
      <span class="poll__count">{{ count }}</span>
    </span>
    <span class="poll__track" aria-hidden="true"><span class="poll__fill" :style="{ width }" /></span>
  </button>
</template>

<style scoped>
.poll { display: flex; flex-direction: column; gap: var(--spacing-xs); width: 100%; min-height: 52px; padding: var(--spacing-sm) 0; border: 0; border-radius: var(--rounded-sm); background: transparent; color: var(--ink); text-align: left; }
.poll:disabled { cursor: default; }
.poll__row { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); }
.poll__name { display: inline-flex; align-items: center; gap: var(--spacing-xs); min-width: 0; font: var(--text-body-sm); }
.poll.is-leading .poll__name { font-weight: 600; }
.poll__count { flex-shrink: 0; color: var(--muted); font: var(--text-caption-sm); }
.poll__track { display: block; height: var(--spacing-xs); overflow: hidden; border-radius: var(--rounded-full); background: var(--hairline-soft); }
.poll__fill { display: block; height: 100%; border-radius: var(--rounded-full); background: var(--border-strong); transition: width var(--motion-fast) var(--ease-out); }
.poll.is-leading .poll__fill { background: var(--ink); }
@media (hover: hover) { .poll:not(:disabled):hover .poll__name { text-decoration: underline; } }
</style>
