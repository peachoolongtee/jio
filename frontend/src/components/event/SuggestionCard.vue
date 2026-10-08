<script setup>
// One suggested place in a slot, with its vote.
//   <SuggestionCard :option="option" leading mine @vote="vote" @swap="swap" />
// Name, category icon, walking time, price tier, crowd (an estimate), up to two reasons,
// a rain warning with an indoor swap, and who voted. The leader is outlined in ink.
import { computed } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import AvatarStack from '../ui/AvatarStack.vue'
import CategoryIcon from '../ui/CategoryIcon.vue'
import ChipButton from '../ui/ChipButton.vue'
import InfoTag from '../ui/InfoTag.vue'
import PriceTier from '../ui/PriceTier.vue'
import { crowdText } from '@/lib/planner/crowd.js'

const props = defineProps({
  option: { type: Object, required: true },
  leading: { type: Boolean, default: false },
  mine: { type: Boolean, default: false },
  closed: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
})
defineEmits(['vote', 'swap'])

// Crowd stays neutral (one accent only); Busy gets an ink outline so it stands out without colour.
const CROWD_TONE = { quiet: 'neutral', moderate: 'neutral', busy: 'strong' }
// The crowd tag already says "Quiet", so a "Quiet at 15:00" reason would repeat it.
const reasons = computed(() => props.option.reasons.filter((r) => !r.startsWith('Quiet at')))
</script>

<template>
  <article class="sugg" :class="{ 'is-leading': leading, 'is-selected': selected }" :aria-label="option.venue.name">
    <div class="sugg__top">
      <CategoryIcon :category="option.venue.category" :size="36" />
      <div class="sugg__title">
        <h4 class="title-md clamp-2">{{ option.venue.name }}</h4>
        <p class="sugg__meta caption-sm text-muted">
          <span>{{ option.walk }} min walk</span>
          <PriceTier :price="option.venue.price" />
        </p>
      </div>
    </div>

    <div class="sugg__tags">
      <InfoTag :tone="CROWD_TONE[option.crowd]">{{ crowdText(option.crowd) }}</InfoTag>
      <InfoTag v-for="reason in reasons" :key="reason">{{ reason }}</InfoTag>
      <InfoTag v-if="option.warnings.includes('rain')" tone="warning" icon="rain">Outdoor, rain expected</InfoTag>
    </div>
    <AppButton v-if="option.swap && !closed" variant="secondary" small class="sugg__swap" @click="$emit('swap', option)">
      <AppIcon name="swap" />
      Swap for {{ option.swap.name }}
    </AppButton>

    <div class="sugg__vote">
      <span class="sugg__count">
        <AvatarStack v-if="option.voters.length" :people="option.voters" :size="20" :max="4" />
        <span class="caption" :class="{ 'sugg__lead': leading }">{{ option.votes }} {{ option.votes === 1 ? 'vote' : 'votes' }}</span>
      </span>
      <ChipButton v-if="!closed" radio check :selected="mine" :aria-label="`${mine ? 'Your vote' : 'Vote for'} ${option.venue.name}`" @click="$emit('vote', option)">
        {{ mine ? 'Voted' : 'Vote' }}
      </ChipButton>
    </div>
  </article>
</template>

<style scoped>
.sugg { display: flex; flex-direction: column; gap: var(--spacing-md); padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); transition: box-shadow var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
/* The leader is outlined in ink, 2px, like a selected date. */
.sugg.is-leading { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
.sugg.is-selected { box-shadow: var(--shadow-float); }
.sugg__top { display: flex; align-items: flex-start; gap: var(--spacing-md); }
.sugg__title { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-xxs); }
.sugg__meta { display: flex; align-items: center; gap: var(--spacing-sm); }
.sugg__tags { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); }
.sugg__swap { align-self: flex-start; }
.sugg__vote { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); margin: 0 calc(var(--spacing-xs) * -1) -6px 0; }
.sugg__lead { font-weight: 700; }
.sugg__count { display: inline-flex; align-items: center; gap: var(--spacing-sm); min-width: 0; }
</style>
