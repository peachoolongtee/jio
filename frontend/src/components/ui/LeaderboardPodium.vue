<script setup>
// The top three on stepped blocks: 2nd on the left, 1st raised in the middle, 3rd on the right.
//   <LeaderboardPodium :rankings="[{ userId: 'ian', userName: 'Ian', rank: 1, value: 300 }]" current-user-id="ian" />
// Each ranking: { userId, userName, rank, value, photo?, to? }. `to` makes the spot a link (a profile).
// The order passed in decides where each person stands (2 · 1 · 3). The medal (gold, silver, bronze), the block's
// height and the number on it follow the rank, so two people tied for first both stand on gold.
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import CoinBadge from './CoinBadge.vue'
import UserAvatar from './UserAvatar.vue'
import { COIN } from '@/lib/currency.js'

const props = defineProps({
  rankings: { type: Array, required: true },
  currentUserId: { type: String, default: '' },
})

const spots = computed(() => {
  const [a, b, c] = props.rankings
  return [b && { ...b, place: 2 }, a && { ...a, place: 1 }, c && { ...c, place: 3 }].filter(Boolean)
})
</script>

<template>
  <ol class="podium" :style="{ '--spots': spots.length }" aria-label="Top three">
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
        <span class="podium__avatar">
          <UserAvatar :name="spot.userName" :src="spot.photo || ''" :person="spot.userId" :size="spot.rank === 1 ? 64 : 56" />
          <span class="podium__crown"><AppIcon name="crown" :size="14" /></span>
        </span>
        <span class="podium__name title-sm truncate">{{ spot.userId === currentUserId ? 'You' : spot.userName }}</span>
        <CoinBadge class="podium__value body-sm" :amount="spot.value" />
      </component>
      <span class="podium__block" aria-hidden="true">{{ spot.rank }}</span>
    </li>
  </ol>
</template>

<style scoped>
/* Narrower than the card, like a real podium: three equal columns that sit on one floor. */
/* As many columns as people on it (fewer than three early in a season), kept centred. */
.podium { display: grid; grid-template-columns: repeat(var(--spots, 3), minmax(0, 1fr)); align-items: end; gap: var(--spacing-md); width: 100%; max-width: calc(var(--spots, 3) * 148px); margin: 0 auto; padding: 0; list-style: none; }
.podium__spot { display: flex; flex-direction: column; min-width: 0; }
.podium__person { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; padding-bottom: var(--spacing-md); color: var(--ink); text-align: center; text-decoration: none; }
@media (hover: hover) { a.podium__person:hover .podium__name { text-decoration: underline; } }
.podium__avatar { position: relative; margin-bottom: var(--spacing-sm); }
/* The crown sits on the avatar's lower right, in a small round badge. */
.podium__crown { position: absolute; right: -4px; bottom: -2px; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: var(--rounded-full); background: var(--canvas); box-shadow: 0 0 0 1px var(--hairline); }
.podium__name { max-width: 100%; }
.podium__value { color: var(--muted); }
/* The blocks: rounded tops, the rank near the top, stepping down 1st, 2nd, 3rd. */
.podium__block { display: flex; justify-content: center; padding-top: var(--spacing-md); border-radius: var(--rounded-md) var(--rounded-md) 0 0; font: var(--text-display-sm); }
.podium__spot--1 .podium__block { height: 136px; background: var(--medal-gold-bg); color: var(--medal-gold-on); }
.podium__spot--2 .podium__block { height: 104px; background: var(--medal-silver-bg); color: var(--medal-silver-on); }
.podium__spot--3 .podium__block { height: 84px; background: var(--medal-bronze-bg); color: var(--medal-bronze-on); }
.podium__spot--1 .podium__crown { color: var(--medal-gold-fg); }
.podium__spot--2 .podium__crown { color: var(--medal-silver-fg); }
.podium__spot--3 .podium__crown { color: var(--medal-bronze-fg); }
/* A gold, silver or bronze ring around the top three's avatars. */
.podium__spot--1 .podium__avatar :deep(.avatar) { box-shadow: 0 0 0 2px var(--canvas), 0 0 0 4px var(--medal-gold-fg); }
.podium__spot--2 .podium__avatar :deep(.avatar) { box-shadow: 0 0 0 2px var(--canvas), 0 0 0 4px var(--medal-silver-fg); }
.podium__spot--3 .podium__avatar :deep(.avatar) { box-shadow: 0 0 0 2px var(--canvas), 0 0 0 4px var(--medal-bronze-fg); }
</style>
