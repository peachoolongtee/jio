<script setup>
// One suggested place in a slot, with its vote.
//   <SuggestionCard :option="option" :slot-time="'15:00'" :total="4" leading mine @vote="vote" @swap="swap" />
// Shows: name, category icon, walking time from the meeting area, price tier, crowd (an estimate),
// up to two reason tags, a rain warning with an indoor swap, and the vote count with a bar.
// `leading` highlights the card in Lagoon. `closed` makes the vote read-only.
import { computed } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import CategoryIcon from '../ui/CategoryIcon.vue'
import ChipButton from '../ui/ChipButton.vue'
import InfoTag from '../ui/InfoTag.vue'
import PriceTier from '../ui/PriceTier.vue'
import { crowdText } from '@/lib/planner/crowd.js'

const props = defineProps({
  option: { type: Object, required: true },
  total: { type: Number, default: 0 },
  leading: { type: Boolean, default: false },
  mine: { type: Boolean, default: false },
  closed: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
})
defineEmits(['vote', 'swap', 'focus'])

const CROWD_TONE = { quiet: 'lagoon', moderate: 'warning', busy: 'error' }
const width = computed(() => `${props.total ? Math.round((props.option.votes / props.total) * 100) : 0}%`)
const count = computed(() => `${props.option.votes} ${props.option.votes === 1 ? 'vote' : 'votes'}`)
</script>

<template>
  <article class="sugg" :class="{ 'is-leading': leading, 'is-selected': selected }" :aria-label="option.venue.name" :data-option="option.id">
    <div class="sugg__top">
      <CategoryIcon :category="option.venue.category" :size="36" />
      <div class="sugg__title">
        <h4 class="title-md clamp-2">{{ option.venue.name }}</h4>
        <p class="caption-sm text-muted">
          <AppIcon name="walk" :size="12" class="sugg__inline" />
          {{ option.walk }} min walk · {{ option.venue.area }}
        </p>
      </div>
      <PriceTier :price="option.venue.price" />
    </div>

    <div class="sugg__tags">
      <InfoTag :tone="CROWD_TONE[option.crowd]" icon="people">{{ crowdText(option.crowd) }}</InfoTag>
      <InfoTag v-for="reason in option.reasons" :key="reason" tone="neutral">{{ reason }}</InfoTag>
    </div>

    <div v-if="option.warnings.includes('rain')" class="sugg__rain">
      <InfoTag tone="warning" icon="rain">Outdoor · rain expected</InfoTag>
      <AppButton v-if="option.swap && !closed" variant="secondary" small @click="$emit('swap', option)">
        <AppIcon name="swap" />
        Swap for {{ option.swap.name }}
      </AppButton>
    </div>

    <div class="sugg__vote">
      <div class="sugg__count">
        <span class="caption">
          {{ count }}<template v-if="leading"> · <span class="text-brand">Leading</span></template>
        </span>
        <span class="sugg__track" aria-hidden="true"><span class="sugg__fill" :style="{ width }" /></span>
        <span v-if="option.voters.length" class="caption-sm text-muted truncate">{{ option.voters.join(', ') }}</span>
      </div>
      <ChipButton v-if="!closed" radio check :selected="mine" :aria-label="`${mine ? 'Your vote' : 'Vote for'} ${option.venue.name}`" @click="$emit('vote', option)">
        {{ mine ? 'Your vote' : 'Vote' }}
      </ChipButton>
    </div>
  </article>
</template>

<style scoped>
.sugg { display: flex; flex-direction: column; gap: var(--spacing-md); padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); transition: border-color var(--motion-fast) ease; }
.sugg.is-leading { border: 2px solid var(--primary); padding: calc(var(--spacing-base) - 1px); }
.sugg.is-selected { box-shadow: var(--shadow-float); }
.sugg__top { display: flex; align-items: flex-start; gap: var(--spacing-md); }
.sugg__title { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-xxs); }
.sugg__inline { display: inline-block; vertical-align: -1px; }
.sugg__tags { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); }
.sugg__rain { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); }
.sugg__vote { display: flex; align-items: center; gap: var(--spacing-md); }
.sugg__count { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-xs); }
.sugg__track { display: block; height: 6px; overflow: hidden; border-radius: var(--rounded-full); background: var(--primary-tint); }
.sugg__fill { display: block; height: 100%; border-radius: var(--rounded-full); background: var(--primary); transition: width var(--motion-fast) ease; }
</style>
