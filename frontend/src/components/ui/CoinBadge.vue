<script setup>
// The JioCoins badge: a pink coin with a crown. It stands in for the word "JioCoins" wherever an amount is shown.
//   <CoinBadge />                  the badge alone, read out as "JioCoins"
//   <CoinBadge :amount="500" />    "500" and the badge, read out as "500 JioCoins"
//   <CoinBadge :amount="1250" short />   "1.3k" and the badge, still read out as "1,250 JioCoins"
// Text that cannot hold a picture (toasts, dialog titles, error messages) keeps the word: coins(n) in lib/currency.js.
// size: the badge's height in px; by default 1.1em, so it sits in a line of text at any font size.
import { computed } from 'vue'
import { COIN, compact } from '@/lib/currency.js'

const props = defineProps({
  amount: { type: Number, default: null },
  size: { type: Number, default: null },
  short: { type: Boolean, default: false },
})

const label = computed(() => (props.amount == null ? COIN : `${props.amount.toLocaleString('en-SG')} ${COIN}`))
const shown = computed(() => (props.short ? compact(props.amount) : props.amount?.toLocaleString('en-SG')))
const box = computed(() => (props.size ? `${props.size}px` : '1.1em'))
</script>

<template>
  <span class="coin-amount" role="img" :aria-label="label">
    <span v-if="amount != null" class="coin-amount__value tnum" aria-hidden="true">{{ shown }}</span>
    <svg class="coin-badge" :style="{ width: box, height: box }" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="15.5" fill="#f7365e" />
      <circle cx="16" cy="16" r="12.25" fill="none" stroke="#ff9db1" stroke-width="1.5" />
      <path d="M6.2 13.2a10.4 10.4 0 0 1 7-7.1" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" opacity="0.6" />
      <path d="M10.3 20.3 9.4 12.6l3.8 3.1L16 10.9l2.8 4.8 3.8-3.1-.9 7.7Z" fill="#fff4e6" stroke="#fff4e6" stroke-width="0.9" stroke-linejoin="round" />
      <rect x="10.3" y="21.4" width="11.4" height="1.9" rx="0.95" fill="#fff4e6" />
    </svg>
  </span>
</template>

<style scoped>
.coin-amount {
  display: inline-flex;
  align-items: center;
  gap: 0.25em;
  vertical-align: middle;
  white-space: nowrap;
}
.coin-badge { flex: none; display: block; }
</style>
