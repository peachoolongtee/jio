// What the votes in one slot make of its places: each place's count and voters, who leads, whether there is a tie, how many have voted
// and what the signed-in person voted for. One function, used by the data layer when it builds a shared session's plan (lib/api.js
// getPlan) and by the planner store when it shows a person's own vote before the server has answered, so the two cannot disagree.
// Nothing here asks a server or reads a store.
import { leader, tally } from './planner/confirm.js'

// The places of a slot with the votes counted. `options` are the slot's places (each `{ id, ... }`, in the order to show them, the
// best first); `votes` is `{ [personId]: venueId }` for the slot; `nameOf(id)` names a voter; `me` is the signed-in person's id.
// Votes for a place that is not among `options` are not counted.
// How to call: tallyOptions({ options: [{ id: 'v25' }], votes: { ian: 'v25' }, nameOf: (id) => id, me: 'ian' })
//   -> { options: [{ id: 'v25', votes: 1, voters: [{ id: 'ian', name: 'ian' }] }], leader: 'v25', topVotes: 1, tied: [], totalVotes: 1, myVote: 'v25' }
export function tallyOptions({ options, votes, nameOf, me }) {
  const optionIds = options.map((o) => o.id)
  const counted = Object.fromEntries(Object.entries(votes || {}).filter(([, venueId]) => optionIds.includes(venueId)))
  const counts = tally(counted)
  const top = Math.max(0, ...optionIds.map((id) => counts[id] || 0))
  const ahead = leader(optionIds, counted)
  return {
    options: options.map((o) => ({
      ...o,
      votes: counts[o.id] || 0,
      voters: Object.keys(counted).filter((person) => counted[person] === o.id).map((id) => ({ id, name: nameOf(id) })),
    })),
    leader: ahead,
    // The most votes any place has, and the places sharing it when there is no single leader.
    topVotes: top,
    tied: ahead ? [] : optionIds.filter((id) => counts[id] && counts[id] === top),
    totalVotes: Object.keys(counted).length,
    myVote: counted[me] || null,
  }
}

// A plan as the screens read it (lib/api.js getPlan, for a shared session) with the signed-in person's vote in one slot set to
// `venueId`, or taken back when it is the place they already voted for. Nothing is changed in the plan given; a slot or place that is not
// there leaves it as it is. Their name on the vote is `myName`; the other voters keep the names they have.
// How to call: const next = withMyVote(plan, '9a2c...', 'v25', 'ian', 'Ian')
export function withMyVote(plan, slotId, venueId, me, myName) {
  const slot = plan?.slots?.find((s) => s.id === slotId)
  if (!slot || !slot.options.some((o) => o.id === venueId)) return plan
  const votes = {}
  const names = { [me]: myName }
  for (const o of slot.options) {
    for (const voter of o.voters) {
      votes[voter.id] = o.id
      names[voter.id] = voter.name
    }
  }
  if (votes[me] === venueId) delete votes[me]
  else votes[me] = venueId
  const tallied = tallyOptions({ options: slot.options, votes, nameOf: (id) => names[id] ?? '', me })
  const slots = plan.slots.map((s) => (s.id === slotId ? { ...s, ...tallied } : s))
  const voters = new Set()
  for (const s of slots) for (const o of s.options) for (const v of o.voters) voters.add(v.id)
  return { ...plan, slots, voters: [...voters] }
}
