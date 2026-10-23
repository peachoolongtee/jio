// The slot plan: which time slots a voting session has and how its options are chosen. Pure functions, no database and no planner
// call. This is a port of the browser's rules (frontend/src/lib/planner/slots.js, suggestions.js and confirm.js, and slotsOf() in
// frontend/src/lib/api.js), so the server and the demo account lay a day out the same way; backend/tests/slot-plan.test.js checks the
// two against each other.
//
// What a slot is: one kind of stop (eat, drink, shop or activity) at a time of day, which the group votes on. Everyone sees all four
// kinds while voting, so nobody has to pick categories first. Each is laid out as if it were the only stop of the day: Eat at lunch
// or dinner, the others in the middle of the time the group can stay.
//
// How to call:
//   const slots = layoutSlots({ members: [{ categories: ['eat'], until: null }], windowStart: 600, windowEnd: 1200 })
//   // [{ category: 'eat', start: 720, time: '12:00', duration: 90 }, { category: 'drink', ... }]
//   const options = reconcileOptions(['a', 'b'], ['b', 'c', 'd']) // ['b', 'c', 'd']

export const CATEGORIES = ['eat', 'drink', 'shop', 'activity']

// How long each kind of slot lasts, and the shortest it can be squeezed to.
export const SLOT_DURATIONS = {
  activity: { ideal: 120, min: 60 },
  shop: { ideal: 90, min: 45 },
  drink: { ideal: 60, min: 45 },
  eat: { ideal: 90, min: 60 },
}

// A slot starts with three options and holds up to six.
export const OPTIONS_START = 3
export const OPTIONS_MAX = 6

// "More suggestions" adds this many at a time.
export const OPTIONS_MORE = 3

// The order of slots before Eat is placed, and the times a meal is anchored to (lunch and dinner).
const SEQUENCE = ['activity', 'shop', 'drink']
const MEAL_ANCHORS = [12 * 60, 18 * 60 + 30]

// "15:00" or "15:00:00" to 900 (minutes after midnight). A time that is not one gives null.
//
// How to call:
//   toMinutes('15:30:00') // 930
export function toMinutes(time) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(time ?? ''))
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

// 900 to "15:00" (wraps past midnight, as the browser's does).
//
// How to call:
//   fromMinutes(930) // '15:30'
export function fromMinutes(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

// How many people picked each kind. prefs: { <person>: { categories: ['eat', ...], until } }.
//
// How to call:
//   categoryCounts({ ian: { categories: ['eat'] } }) // { eat: 1, drink: 0, shop: 0, activity: 0 }
export function categoryCounts(prefs) {
  const counts = { eat: 0, drink: 0, shop: 0, activity: 0 }
  for (const pref of Object.values(prefs || {})) {
    for (const category of pref.categories || []) if (category in counts) counts[category] += 1
  }
  return counts
}

// The time by which at least half the group can still stay. `until` is minutes after midnight, or null for "the whole time".
//
// How to call:
//   groupStayUntil({ ian: { categories: ['eat'], until: 900 } }, 1200) // 900
export function groupStayUntil(prefs, windowEnd) {
  const untils = Object.values(prefs || {})
    .filter((p) => (p.categories || []).length || p.until != null)
    .map((p) => (p.until == null ? windowEnd : Math.min(p.until, windowEnd)))
    .sort((a, b) => b - a)
  if (!untils.length) return windowEnd
  return untils[Math.floor((untils.length - 1) / 2)]
}

// Each kind's length when the categories must share `available` minutes: the ideal if it fits, squeezed towards the minimum if not,
// and null if even the minimum does not fit.
//
// How to call:
//   fitDurations(['eat', 'drink'], 120) // { eat: 60, drink: 60 }
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

// Lays the categories out back to back, choosing where Eat goes and when the plan starts.
//
// How to call:
//   layout(['eat'], { eat: 90 }, 600, 1200) // { order: ['eat'], start: 690, cost: 0 }
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

// The slots a set of picks makes inside the session's window: the most picked kinds, back to back, with Eat near a meal time, dropping
// the least picked while they do not fit. Returns [{ category, start, time, duration, picks }].
//
// How to call:
//   buildSlots({ prefs: { ian: { categories: ['eat'], until: null } }, windowStart: 600, windowEnd: 1200 })
export function buildSlots({ prefs, windowStart, windowEnd, deleted = [] }) {
  const responders = Object.values(prefs || {}).filter((p) => (p.categories || []).length)
  if (!responders.length) return []

  const counts = categoryCounts(prefs)
  const top = Math.max(...Object.values(counts))
  const needed = Math.min(Math.ceil(responders.length / 2), top)
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
    const slot = { category, start: cursor, time: fromMinutes(cursor), duration: durations[category], picks: counts[category] }
    cursor += durations[category]
    return slot
  })
}

// The slots a voting session shows: one for every kind that has not been removed, each laid out as if it were the only stop. Eat sits
// at a meal, the others in the middle of the time the group can stay. A kind that cannot be laid out (the day is shorter than half an
// hour) has no slot. `members` are the people in the session now: { categories, until }, `until` in minutes after midnight or null.
// `picks` is how many of them picked the kind (the browser's own slot says how many are in; the database column says how many picked).
// Returns [{ category, start, time, duration, picks }] in the order eat, drink, shop, activity.
//
// How to call:
//   layoutSlots({ members: [{ categories: ['eat'], until: null }], windowStart: 600, windowEnd: 1200, removed: ['shop'] })
export function layoutSlots({ members, windowStart, windowEnd, removed = [] }) {
  const picked = categoryCounts(Object.fromEntries(members.map((m, i) => [i, m])))
  return CATEGORIES.filter((c) => !removed.includes(c)).flatMap((category) => {
    const everyone = Object.fromEntries(members.map((m, i) => [i, { categories: [category], until: m.until ?? null }]))
    return buildSlots({ prefs: everyone, windowStart, windowEnd }).map((slot) => {
      if (category === 'eat') return { ...slot, picks: picked[category] }
      const planEnd = groupStayUntil(everyone, windowEnd)
      const start = windowStart + Math.floor((planEnd - windowStart - slot.duration) / 2 / 15) * 15
      return { ...slot, start, time: fromMinutes(start), picks: picked[category] }
    })
  })
}

// Keeps the options people are already voting on while they still fit, and tops up to three from the ranking. Never more than six.
// Both lists are venue ids; `rankedIds` is best first.
//
// How to call:
//   reconcileOptions(['a', 'z'], ['b', 'a', 'c', 'd']) // ['a', 'b', 'c']
export function reconcileOptions(currentIds, rankedIds, { start = OPTIONS_START, max = OPTIONS_MAX } = {}) {
  const valid = new Set(rankedIds)
  const kept = (currentIds || []).filter((id) => valid.has(id)).slice(0, max)
  for (const id of rankedIds) {
    if (kept.length >= start) break
    if (!kept.includes(id)) kept.push(id)
  }
  return kept
}

// "More suggestions": adds the next best places, `add` more than the slot has now and up to six.
//
// How to call:
//   moreOptions(['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e', 'f', 'g']) // ['a', 'b', 'c', 'd', 'e', 'f']
export function moreOptions(currentIds, rankedIds, { add = OPTIONS_MORE, max = OPTIONS_MAX } = {}) {
  const next = [...currentIds]
  for (const id of rankedIds) {
    if (next.length >= Math.min(max, currentIds.length + add)) break
    if (!next.includes(id)) next.push(id)
  }
  return next
}
