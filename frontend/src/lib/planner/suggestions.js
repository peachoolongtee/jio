// Diverge, part 2: the options each slot puts to a vote.
//
// The ranking itself (what fits a slot, crowd, rain, the last stop near an MRT) runs on the backend planner:
// backend/src/planner, called through lib/plannerApi.js. These rules decide which ranked places are options.
//
// Rules
// - A slot starts with three options and holds up to six.
// - Options people are voting on stay while they still fit.
export const OPTIONS_START = 3
export const OPTIONS_MAX = 6

// Keep the options people are already voting on while they still fit, and top up to three
// from the ranking. Never more than six.
export function reconcileOptions(currentIds, rankedIds, { start = OPTIONS_START, max = OPTIONS_MAX } = {}) {
  const valid = new Set(rankedIds)
  const kept = (currentIds || []).filter((id) => valid.has(id)).slice(0, max)
  for (const id of rankedIds) {
    if (kept.length >= start) break
    if (!kept.includes(id)) kept.push(id)
  }
  return kept
}

// "More suggestions": add the next best places, up to six in the slot.
export function moreOptions(currentIds, rankedIds, { add = 3, max = OPTIONS_MAX } = {}) {
  const next = [...currentIds]
  for (const id of rankedIds) {
    if (next.length >= Math.min(max, currentIds.length + add)) break
    if (!next.includes(id)) next.push(id)
  }
  return next
}
