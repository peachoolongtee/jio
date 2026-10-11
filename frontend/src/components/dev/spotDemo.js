// What the demo tools do for friends while a session is choosing where to meet. Friends cannot act in a single-user build,
// so each of these calls the data layer's public functions for them, the way their own phones would. `api` is lib/api.js
// (or a stand-in with the same functions, which is how these are tested). Each returns the sentence the panel shows.
import { AREAS } from '@/lib/mock/places.js'
import { PEOPLE } from '@/lib/mock/people.js'

// Areas a friend tries first, so a suggestion is usually somewhere the app did not list. The last has the longest name.
export const SUGGESTED_AREAS = ['kovan', 'novena', 'serangoon', 'orchard', 'botanic-gardens']

// Which spots each friend says work for them, as places in the list: the friend's turn, and what they pick. The second
// spot leads, so a vote has a clear winner.
const APPROVAL_PICKS = [[1, 0], [1], [1, 2], [2], [1]]

// Is there a list of spots to act on? Spots change only while the group is choosing where to meet.
// How to call: hasSpots(session) -> true
export const hasSpots = (session) => !!session && session.status === 'locating' && (session.spots?.list || []).length > 0

// A friend suggests a spot: the first friend who has not suggested one yet (or the first friend, whose suggestion is then
// replaced), at the first area on the list above that is not already a spot. `here` marks "we are here already".
// How to call: await friendSuggests(api, session, ['jonathan', 'faith'], { here: true }) -> 'Jonathan suggested Kovan, and is there already.'
export async function friendSuggests(api, session, friendIds, { here = false } = {}) {
  if (!friendIds.length) return 'Invite a friend first.'
  const suggestions = session.spots.suggestions || {}
  const listed = new Set(session.spots.list.map((s) => s.areaId))
  const friend = friendIds.find((id) => !suggestions[id]) || friendIds[0]
  const taken = new Set([...listed, ...Object.values(suggestions).map((s) => s.areaId)])
  const areaId = [...SUGGESTED_AREAS, ...AREAS.map((a) => a.id)].find((id) => !taken.has(id) && AREAS.some((a) => a.id === id))
  await api.suggestSpot(session.id, friend, areaId, { here })
  const name = AREAS.find((a) => a.id === areaId).name
  return `${friendName(friend)} suggested ${name}${here ? ', and is there already' : ''}.`
}

// Friends say which spots work for them: each approves the spots their turn picks (the second spot gets the most).
// How to call: await friendsApprove(api, session, ['jonathan', 'faith']) -> 'Friends said which spots work for them.'
export async function friendsApprove(api, session, friendIds) {
  const spots = session.spots.list
  if (!friendIds.length) return 'Invite a friend first.'
  for (const [i, friend] of friendIds.entries()) {
    for (const index of APPROVAL_PICKS[i % APPROVAL_PICKS.length]) {
      const spot = spots[index % spots.length]
      await api.approveSpot(session.id, friend, spot.areaId, true)
    }
  }
  return 'Friends said which spots work for them.'
}

// Take back every approval, the signed-in person's too, so the host starts from nothing.
// How to call: await clearApprovals(api, session) -> 'Cleared 3 approvals.'
export async function clearApprovals(api, session) {
  let cleared = 0
  for (const [person, areas] of Object.entries(session.spots.approvals || {})) {
    for (const areaId of areas) {
      await api.approveSpot(session.id, person, areaId, false)
      cleared += 1
    }
  }
  return cleared ? `Cleared ${cleared} ${cleared === 1 ? 'approval' : 'approvals'}.` : 'Nobody had said which spots work.'
}

// A friend's name for the note. Falls back to the id.
// How to call: friendName('jonathan') -> 'Jonathan'
const friendName = (id) => PEOPLE.find((p) => p.id === id)?.name || id
