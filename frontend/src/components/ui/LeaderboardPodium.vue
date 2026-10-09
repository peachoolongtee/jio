<script setup>
// The top three on stepped blocks: 2nd on the left, 1st raised in the middle, 3rd on the right.
//   <LeaderboardPodium :rankings="[{ userId: 'ian', userName: 'Ian', rank: 1, value: 300 }]" current-user-id="ian" />
// Each ranking: { userId, userName, rank, value, photo?, to? }. `to` makes the spot a link (a profile).
// The order passed in decides who stands where; the block's height follows the rank, so a tie for first
// puts both on a first-place block.
import { computed } from 'vue'
import UserAvatar from './UserAvatar.vue'
import { COIN } from '@/lib/currency.js'

const props = defineProps({
  rankings: { type: Array, required: true },
  currentUserId: { type: String, default: '' },
})

// Position 1, 2, 3 in the order given, laid out 2 · 1 · 3.
const spots = computed(() => {
  const [a, b, c] = props.rankings
  return [
    b && { ...b, place: 2 },
    a && { ...a, place: 1 },
    c && { ...c, place: 3 },
  ].filter(Boolean)
})
</script>

<template>
  <ol class="podium" aria-label="Top three">
    <li
      v-for="spot in spots"
      :key="spot.userId"
      class="podium__spot rise"
      :class="[`podium__spot--${Math.min(spot.rank, 3)}`, { 'is-me': spot.userId === currentUserId }]"
      :style="{ '--i': spot.place === 1 ? 0 : spot.place }"
    >
      <component
        :is="spot.to ? 'RouterLink' : 'div'"
        :to="spot.to || undefined"
        class="podium__person"
        :aria-label="`Rank ${spot.rank}: ${spot.userName}${spot.userId === currentUserId ? ' (you)' : ''}, ${spot.value} ${COIN}`"
      >
        <UserAvatar :name="spot.userName" :src="spot.photo || ''" :person="spot.userId" :size="spot.rank === 1 ? 64 : 40" />
        <span class="podium__name title-sm truncate">{{ spot.userName }}</span>
        <span class="podium__value"><span class="title-md tnum">{{ spot.value.toLocaleString('en-SG') }}</span> <span class="caption-sm text-muted">{{ COIN }}</span></span>
      </component>
      <span class="podium__block" aria-hidden="true"><span class="podium__rank">{{ spot.rank }}</span></span>
    </li>
  </ol>
</template>

<style scoped>
.podium { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: end; gap: var(--spacing-sm); margin: 0; padding: 0; list-style: none; }
.podium__spot { display: flex; flex-direction: column; align-items: stretch; min-width: 0; }
.podium__person { display: flex; flex-direction: column; align-items: center; gap: var(--spacing-xs); min-width: 0; padding: 0 var(--spacing-xs) var(--spacing-sm); color: var(--ink); text-align: center; text-decoration: none; }
@media (hover: hover) { a.podium__person:hover .podium__name { text-decoration: underline; } }
.podium__person :deep(.avatar) { margin-bottom: var(--spacing-xs); box-shadow: 0 0 0 3px var(--canvas), 0 0 0 4px var(--hairline); }
.podium__name { max-width: 100%; }
.podium__value { white-space: nowrap; }
.podium__spot.is-me .podium__name::after { content: " (you)"; color: var(--muted); font-weight: 400; }
.podium__spot.is-me .podium__person :deep(.avatar) { box-shadow: 0 0 0 3px var(--canvas), 0 0 0 5px var(--ink); }
/* The blocks: 1st tallest and in ink, 2nd and 3rd in soft grey, stepping down. */
.podium__block { display: flex; justify-content: center; padding-top: var(--spacing-sm); border-radius: var(--rounded-sm) var(--rounded-sm) 0 0; background: var(--surface-strong); color: var(--ink); }
.podium__spot--1 .podium__block { height: 96px; background: var(--ink); color: var(--on-dark); }
.podium__spot--2 .podium__block { height: 68px; }
.podium__spot--3 .podium__block { height: 48px; background: var(--surface-soft); }
.podium__rank { font: var(--text-display-sm); }
.podium__spot--1 .podium__rank { font: var(--text-display-xl); }
</style>
