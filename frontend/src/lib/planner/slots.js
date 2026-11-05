// Diverge, part 1: turn everyone's category picks into ordered time slots inside the session window.
//
// - Each person picks the categories they want (Eat, Drink, Shop, Activity) and how long they can stay.
// - The most picked categories become slots: a category needs picks from at least half of the people who answered.
// - Slots are laid out back to back, with Eat placed as close as possible to lunch (12:00) or dinner (18:30).
// - The plan ends when at least half the group can still stay.
// - A deleted slot stays deleted; the others move to fill the time.
import { fromMinutes } from './format.js'

export const CATEGORIES = ['eat', 'drink', 'shop', 'activity']
export const CATEGORY_LABELS = { eat: 'Eat', drink: 'Drink', shop: 'Shop', activity: 'Activity' }

// How long each kind of slot lasts, and the shortest it can be squeezed to.
export const SLOT_DURATIONS = {
  activity: { ideal: 120, min: 60 },
  shop: { ideal: 90, min: 45 },
  drink: { ideal: 60, min: 45 },
  eat: { ideal: 90, min: 60 },
}

// The order of slots before Eat is placed.
const SEQUENCE = ['activity', 'shop', 'drink']
const MEAL_ANCHORS = [12 * 60, 18 * 60 + 30]

export function categoryCounts(prefs) {
  const counts = { eat: 0, drink: 0, shop: 0, activity: 0 }
  for (const pref of Object.values(prefs || {})) {
    for (const category of pref.categories || []) counts[category] += 1
  }
  return counts
}

// The time by which at least half the group can still stay. `until` is minutes after midnight, or null for "the whole time".
export function groupStayUntil(prefs, windowEnd) {
  const untils = Object.values(prefs || {})
    .filter((p) => (p.categories || []).length || p.until != null)
    .map((p) => (p.until == null ? windowEnd : Math.min(p.until, windowEnd)))
    .sort((a, b) => b - a)
  if (!untils.length) return windowEnd
  return untils[Math.floor((untils.length - 1) / 2)]
}

// Choices for "How long can you stay": every hour from two hours after the start, up to the end.
export function stayOptions(windowStart, windowEnd) {
  const options = []
  for (let m = Math.ceil((windowStart + 120) / 60) * 60; m < windowEnd; m += 60) options.push(m)
  options.push(windowEnd)
  return options
}

function fitDurations(categories, available) {
  const ideal = categories.reduce((sum, c) => sum + SLOT_DURATIONS[c].ideal, 0)
  if (ideal <= available) return Object.fromEntries(categories.map((c) => [c, SLOT_DURATIONS[c].ideal]))
  const min = categories.reduce((sum, c) => sum + SLOT_DURATIONS[c].min, 0)
  if (min > available) return null
  let extra = available - min
  const durations = {}
  for (const c of categories) {
    const add = Math.min(extra, SLOT_DURATIONS[c].ideal - SLOT_DURATIONS[c].min)
    durations[c] = SLOT_DURATIONS[c].min + add
    extra -= add
  }
  return durations
}

// Lay the categories out back to back, choosing where Eat goes and when the plan starts.
function layout(categories, durations, windowStart, planEnd) {
  const others = SEQUENCE.filter((c) => categories.includes(c))
  const total = categories.reduce((sum, c) => sum + durations[c], 0)
  const latestStart = planEnd - total
  if (!categories.includes('eat')) return { order: others, start: windowStart }

  let best = null
  for (const anchor of MEAL_ANCHORS) {
    for (let k = 0; k <= others.length; k += 1) {
      const order = [...others.slice(0, k), 'eat', ...others.slice(k)]
      const before = others.slice(0, k).reduce((sum, c) => sum + durations[c], 0)
      const start = Math.min(Math.max(anchor - before, windowStart), latestStart)
      const cost = Math.abs(start + before - anchor)
      if (!best || cost < best.cost) best = { order, start, cost }
    }
  }
  return best
}

// prefs: { [personId]: { categories: ['eat', ...], until: minutes | null } }
// Returns [{ id, category, start (minutes), time ("15:00"), duration, picks }].
export function buildSlots({ prefs, windowStart, windowEnd, deleted = [] }) {
  const responders = Object.values(prefs || {}).filter((p) => (p.categories || []).length)
  if (!responders.length) return []

  const counts = categoryCounts(prefs)
  const needed = Math.ceil(responders.length / 2)
  // Most picked first; ties follow the usual order of an outing.
  const rank = (c) => [...SEQUENCE, 'eat'].indexOf(c)
  let chosen = CATEGORIES.filter((c) => counts[c] >= needed && counts[c] > 0 && !deleted.includes(c)).sort(
    (a, b) => counts[b] - counts[a] || rank(a) - rank(b),
  )
  if (!chosen.length) return []

  const planEnd = Math.min(windowEnd, groupStayUntil(prefs, windowEnd))
  const available = planEnd - windowStart
  let durations = fitDurations(chosen, available)
  // Not enough time: drop the least picked slot until the rest fit.
  while (!durations && chosen.length > 1) {
    chosen = chosen.slice(0, -1)
    durations = fitDurations(chosen, available)
  }
  if (!durations) {
    if (available < 30) return []
    durations = { [chosen[0]]: available }
  }

  const { order, start } = layout(chosen, durations, windowStart, planEnd)
  let cursor = start
  return order.map((category) => {
    const slot = { id: category, category, start: cursor, time: fromMinutes(cursor), duration: durations[category], picks: counts[category] }
    cursor += durations[category]
    return slot
  })
}
