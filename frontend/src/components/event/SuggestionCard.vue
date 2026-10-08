<script setup>
// One suggested place in a slot, with its vote.
//   <SuggestionCard :option="option" leading mine @vote="vote" @swap="swap" />
// A photo of the kind of place with its category icon, the name, walking time, price tier, crowd (an estimate),
// up to two reasons, a rain warning with an indoor swap, and who voted.
// Colour coding: a stripe in the category colour, and crowd on the data scale. `leading` outlines the card in ink
// and tags it "Leading"; `behind` (another place leads) mutes the vote count. `closed` makes the vote read-only.
import { computed } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import AvatarStack from '../ui/AvatarStack.vue'
import CategoryIcon from '../ui/CategoryIcon.vue'
import ChipButton from '../ui/ChipButton.vue'
import InfoTag from '../ui/InfoTag.vue'
import PriceTier from '../ui/PriceTier.vue'
import { crowdText, crowdTone } from '@/lib/planner/crowd.js'
import { placeImage } from '@/lib/placeImages.js'

const props = defineProps({
  option: { type: Object, required: true },
  leading: { type: Boolean, default: false },
  behind: { type: Boolean, default: false },
  mine: { type: Boolean, default: false },
  closed: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
})
defineEmits(['vote', 'swap'])

// The crowd tag already says "Quiet", so a "Quiet at 15:00" reason would repeat it.
const reasons = computed(() => props.option.reasons.filter((r) => !r.startsWith('Quiet at')))
</script>

<template>
  <article class="sugg" :class="[`sugg--${option.venue.category}`, { 'is-leading': leading, 'is-behind': behind, 'is-selected': selected }]" :aria-label="option.venue.name" :data-option="option.id">
    <div class="sugg__top">
      <span class="sugg__photo">
        <img :src="placeImage(option.venue)" alt="" loading="lazy" width="72" height="72" />
        <CategoryIcon class="sugg__cat" :category="option.venue.category" :size="28" />
      </span>
      <div class="sugg__title">
        <h4 class="title-md clamp-2">{{ option.venue.name }}</h4>
        <p class="sugg__meta caption-sm text-muted">
          <span>{{ option.walk }} min walk</span>
          <PriceTier :price="option.venue.price" />
        </p>
      </div>
    </div>

    <div class="sugg__tags">
      <InfoTag v-if="leading" tone="strong" icon="trophy">Leading</InfoTag>
      <InfoTag :tone="crowdTone(option.crowd)">{{ crowdText(option.crowd) }}</InfoTag>
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
/* A stripe on the left in the category colour, matching the place's pin on the map. */
.sugg--eat { --sugg-cat: var(--cat-eat-fg); }
.sugg--drink { --sugg-cat: var(--cat-drink-fg); }
.sugg--shop { --sugg-cat: var(--cat-shop-fg); }
.sugg--activity { --sugg-cat: var(--cat-activity-fg); }
.sugg { box-shadow: inset 4px 0 0 var(--sugg-cat, transparent); }
/* The leader is outlined in ink, 2px, like a selected date. */
.sugg.is-leading { border-color: var(--ink); box-shadow: inset 4px 0 0 var(--sugg-cat, transparent), inset 0 0 0 1px var(--ink); }
.sugg.is-selected { box-shadow: inset 4px 0 0 var(--sugg-cat, transparent), var(--shadow-float); }
.sugg.is-leading.is-selected { box-shadow: inset 4px 0 0 var(--sugg-cat, transparent), inset 0 0 0 1px var(--ink), var(--shadow-float); }
.sugg.is-behind .sugg__count .caption { color: var(--muted); }
.sugg__photo { position: relative; flex-shrink: 0; width: 72px; height: 72px; }
.sugg__photo img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: var(--rounded-sm); background: var(--surface-strong); }
.sugg__cat { position: absolute; right: -6px; bottom: -6px; box-shadow: 0 0 0 2px var(--canvas); border-radius: var(--rounded-full); }
.sugg__top { display: flex; align-items: flex-start; gap: var(--spacing-md); }
.sugg__title { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-xxs); }
.sugg__meta { display: flex; align-items: center; gap: var(--spacing-sm); }
.sugg__tags { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); }
.sugg__swap { align-self: flex-start; }
.sugg__vote { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); margin: 0 calc(var(--spacing-xs) * -1) -6px 0; }
.sugg__lead { font-weight: 700; }
.sugg__count { display: inline-flex; align-items: center; gap: var(--spacing-sm); min-width: 0; }
</style>
