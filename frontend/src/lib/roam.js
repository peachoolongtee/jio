// Roam ("What next?"): the small rules behind the list of places near the group and the proposals made from it. No screen
// and no storage, so the data layer (api.js), the screens and the tests all read the same limits and the same words.
//
// A proposal is a place from the Roam list that a member puts forward as the next stop. It becomes a stop only when the
// host adds it to the plan. Proposals are stored on the session as `proposals: [{ id, venueId, by, at }]`.
import { distanceText } from './planner/format.js'

// The limits. A member keeps at most `perMember` proposals waiting, a session at most `perSession`, and a plan holds at
// most `stops` stops (the planner's arrange route takes no more). An accepted stop lasts `minutes`.
export const ROAM = Object.freeze({ perMember: 3, perSession: 10, stops: 8, minutes: 60 })

// The categories Roam can look for. "All" on the screen asks for every one of them.
export const ROAM_CATEGORIES = ['eat', 'drink', 'shop', 'activity']

// Is this a proposal as it is stored? A save written by hand, or by an older build, may hold anything.
// How to call: isProposal({ id: 'pp3', venueId: 'v25', by: 'faith', at: 1760000000000 }) -> true
export function isProposal(p) {
  return p !== null && typeof p === 'object' && typeof p.id === 'string' && typeof p.venueId === 'string' && typeof p.by === 'string'
}

// The proposals a session holds, oldest first. A session saved before Roam has none, and a damaged list reads as the
// proposals in it that are whole.
// How to call: proposalsOf({ proposals: undefined }) -> []
export function proposalsOf(session) {
  return Array.isArray(session?.proposals) ? session.proposals.filter(isProposal) : []
}

// Why a place cannot be proposed now, or '' when it can. A full plan comes first, then the session's limit, then the
// person's. `you` says it to the person it is about ("You have 3 places waiting") or about someone else (the demo's friend).
// How to call: proposeBlock({ stops: 8, mine: 0, total: 0 }) -> 'The plan has 8 stops, the most it can hold.'
export function proposeBlock({ stops, mine, total, you = true, name = 'They' }) {
  if (stops >= ROAM.stops) return `The plan has ${ROAM.stops} stops, the most it can hold.`
  if (total >= ROAM.perSession) return `${ROAM.perSession} places are already waiting for the host.`
  if (mine >= ROAM.perMember) return you ? `You have ${ROAM.perMember} places waiting. Take one back to propose another.` : `${name} has ${ROAM.perMember} places waiting.`
  return ''
}

// The sentence under the heading: where the list is centred. `mode` is 'meeting' (the meetup's meeting area), 'here' (the
// person's own position, which only they and the planner ever see: the words name the area) or 'area' (an area they picked).
// How to call: centreLine('here', 'Toa Payoh') -> 'Near you, in Toa Payoh'
export function centreLine(mode, areaName) {
  if (!areaName) return ''
  return mode === 'here' ? `Near you, in ${areaName}` : `Near ${areaName}`
}

// How far a place is and how long it takes to get there, on one line. The planner's time is an estimate, so it says
// "about", and a place right next door says a minute rather than none.
// How to call: travelLine({ travelMinutes: 4.2, distanceM: 250 }) -> 'about 4 min away · 250 m'
export function travelLine(place) {
  const parts = []
  if (Number.isFinite(place?.travelMinutes)) parts.push(`about ${Math.max(1, Math.round(place.travelMinutes))} min away`)
  if (Number.isFinite(place?.distanceM)) parts.push(distanceText(place.distanceM))
  return parts.join(' · ')
}

// What a place on the Roam list is, given the stops in the plan and the proposals waiting: 'stop' (already in the plan),
// 'proposed' (someone put it forward, `proposal` says who) or 'free'.
// How to call: placeState('v25', ['v1'], [{ id: 'pp1', venueId: 'v25', by: 'faith' }]) -> { state: 'proposed', proposal: { id: 'pp1', by: 'faith' } }
export function placeState(venueId, stopVenueIds, proposals) {
  if (stopVenueIds.includes(venueId)) return { state: 'stop', proposal: null }
  const proposal = proposals.find((p) => p.venueId === venueId)
  return proposal ? { state: 'proposed', proposal } : { state: 'free', proposal: null }
}

// What the foot of a place's card shows. A tag says where the place stands; a button, when there is one, is what the
// person can do about it.
//   free      "Propose" (off, with `blocked`'s reason shown on the page, when they cannot)
//   mine      the tag "Proposed by you" and "Take back"
//   theirs    the tag "Proposed by Faith" and nothing to press (the host decides on the itinerary)
//   stop      the tag "In the plan"
// How to call: placeAction({ id: 'v25', name: 'Green Kitchen', state: 'free' }, { myId: 'ian', blocked: '' }) -> { kind: 'free', tag: '', button: 'Propose', ... }
export function placeAction(place, { myId, blocked = '' }) {
  const name = place.venue?.name || place.name || 'this place'
  if (place.state === 'stop') return { kind: 'stop', tag: 'In the plan', icon: 'check', button: '', label: '', disabled: false }
  if (place.state === 'proposed') {
    if (place.proposal.by === myId) return { kind: 'mine', tag: 'Proposed by you', icon: 'check', button: 'Take back', label: `Take back your proposal of ${name}`, disabled: false }
    return { kind: 'theirs', tag: `Proposed by ${place.proposal.byName || 'a friend'}`, icon: 'check', button: '', label: '', disabled: false }
  }
  return { kind: 'free', tag: '', icon: '', button: 'Propose', label: `Propose ${name} as the next stop`, disabled: !!blocked }
}

// The proposed stops under the itinerary, for the person looking. The host can add each to the plan or leave it; the
// person who proposed one can take it back; everyone else sees who proposed it and that the host decides.
// session: { hostId, hostName, proposals: [{ id, venue, by, byName }] } as getSession answers it.
// How to call: proposedRows({ hostId: 'ian', hostName: 'Ian', proposals: [...] }, 'ian') -> [{ id, name, tag: 'Proposed by Faith', canDecide: true, ... }]
export function proposedRows(session, myId) {
  const isHost = session?.hostId === myId
  return (session?.proposals || []).map((p) => {
    const mine = p.by === myId
    return {
      id: p.id,
      venue: p.venue,
      name: p.venue.name,
      tag: mine ? 'Proposed by you' : `Proposed by ${p.byName || 'a friend'}`,
      canDecide: isHost,
      canTakeBack: !isHost && mine,
      // Everyone but the host waits for the host, the proposer included.
      waiting: isHost ? '' : `Waiting for ${session.hostName || 'the host'} to decide`,
    }
  })
}

// What the Roam page says when the plan is not under way (it can be opened by its address at any time), or '' when it is.
// How to call: closedText({ status: 'confirmed', isToday: false }) -> 'What next? opens on the day of the outing.'
export function closedText(session) {
  if (!session) return ''
  if (session.status === 'completed') return 'This outing is over.'
  if (session.status === 'cancelled') return 'This outing was cancelled.'
  if (session.status !== 'confirmed') return 'What next? opens once the plan is confirmed.'
  return session.isToday ? '' : 'What next? opens on the day of the outing.'
}

// The words for where the list is centred and what is going on, one place for the page and its tests.
export const ROAM_WORDS = Object.freeze({
  here: 'Use my location',
  finding: 'Finding you',
  back: (areaName) => `Back to ${areaName}`,
  pick: 'Pick an area',
  refused: 'Location access is off.',
  unavailable: 'Your location is not available right now.',
  unsupported: 'This browser cannot share your location.',
  outside: 'Your location is outside Singapore.',
  empty: 'Nothing nearby fits',
  emptyText: 'Try another kind of place.',
})
