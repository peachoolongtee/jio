// The Vote page's price filter: the chips "$" and "$$" (a limit: "$$" also keeps the $ places) beside the category chips. It narrows what this person sees and nothing else:
// nothing is saved, and the planner still ranks every place (Faith, 13 November 2026). It uses the same tiers as the $ marks on the
// cards (priceTier in lib/planner/format.js): $ is under SGD 10 a person, $$ is SGD 10 to 25, $$$ is above SGD 25.
import { priceTier } from './planner/format.js'

// The two limits worth a chip. "Up to $$$" would hide nothing, so it is not offered.
export const PRICE_LIMITS = [
  { tier: 1, label: '$', title: 'Only places under SGD 10 per person' },
  { tier: 2, label: '$$', title: 'Only places up to SGD 25 per person' },
]

// The tier of a price as a number, 1 to 3, or null when the price is not known (a saved place Jio does not know).
// How to call: tierOfPrice(12) -> 2
export function tierOfPrice(price) {
  return Number.isFinite(price) ? priceTier(price).length : null
}

// Whether a place's price is within the chosen limit. No limit (0) lets everything through, and so does a place with no known price:
// a filter should not hide a place just because Jio does not know what it costs.
// How to call: withinPrice(12, 1) -> false
export function withinPrice(price, limit) {
  if (!limit) return true
  const tier = tierOfPrice(price)
  return tier === null || tier <= limit
}

// The sentence under a category that the price filter has cut down, or '' when it cut nothing.
// How to call: priceNote(2, 3) -> 'Only places up to SGD 25. 3 others are hidden.'
export function priceNote(limit, hidden) {
  const step = PRICE_LIMITS.find((p) => p.tier === limit)
  if (!step || !hidden) return ''
  const words = limit === 1 ? 'under SGD 10' : 'up to SGD 25'
  return `Only places ${words}. ${hidden} ${hidden === 1 ? 'other is' : 'others are'} hidden.`
}
