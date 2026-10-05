// Confirm: the most voted place wins each slot. A tie goes to the place with the better planner score.
// The plan can be confirmed once at least 2 people have voted.

export const MIN_VOTERS = 2

// votes: { [personId]: venueId } for one slot.
export function tally(votes) {
  const counts = {}
  for (const venueId of Object.values(votes || {})) counts[venueId] = (counts[venueId] || 0) + 1
  return counts
}

// optionIds in their current order, scores: { [venueId]: number }.
export function pickWinner(optionIds, votes, scores = {}) {
  if (!optionIds.length) return null
  const counts = tally(votes)
  return [...optionIds].sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || (scores[b] ?? 0) - (scores[a] ?? 0))[0]
}

// The option currently ahead, or null when nobody has voted or the top is tied.
export function leader(optionIds, votes) {
  const counts = tally(votes)
  const top = Math.max(0, ...optionIds.map((id) => counts[id] || 0))
  if (!top) return null
  const ahead = optionIds.filter((id) => (counts[id] || 0) === top)
  return ahead.length === 1 ? ahead[0] : null
}

// People who have voted in at least one slot. votesBySlot: { [slotId]: { [personId]: venueId } }.
export function voters(votesBySlot, activeIds) {
  const set = new Set()
  for (const votes of Object.values(votesBySlot || {})) {
    for (const personId of Object.keys(votes)) if (activeIds.includes(personId)) set.add(personId)
  }
  return [...set]
}

export function canConfirm(votesBySlot, activeIds) {
  return voters(votesBySlot, activeIds).length >= MIN_VOTERS
}
