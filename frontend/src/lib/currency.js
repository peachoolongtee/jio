// Jio's own currency. Every meetup you finish earns some; spend them on café discounts in Rewards.
// The code still calls the amounts "points" (points, seasonPoints); only what people read says JioCoins.
export const COIN = 'JioCoins'
export const COIN_ONE = 'JioCoin'

// 1250 → "1,250 JioCoins", 1 → "1 JioCoin".
export function coins(n) {
  return `${Number(n).toLocaleString('en-SG')} ${n === 1 ? COIN_ONE : COIN}`
}

// Short form for tight spaces: 950 → "950", 1250 → "1.3k", 289400 → "289.4k".
const short = new Intl.NumberFormat('en-SG', { notation: 'compact', maximumFractionDigits: 1 })
export function compact(n) {
  return short.format(n).toLowerCase()
}
