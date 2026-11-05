// What the demo tools do for friends while a plan is under way: a friend proposes a place from "What next?", so the host's
// side (adding it to the plan, or leaving it out) can be shown without a second phone. Friends cannot act in a single-user
// build, so this calls the data layer's public functions for them, the way their own phone would. `api` is lib/api.js (or a
// stand-in with the same functions, which is how this is tested). It returns the sentence the panel shows.
import { PEOPLE } from '@/lib/mock/people.js'
import { ROAM } from '@/lib/roam.js'

// How to call: friendName('faith') -> 'Faith'
const friendName = (id) => PEOPLE.find((p) => p.id === id)?.name || id

// A friend proposes the best place on the Roam list that nobody has proposed and that is not in the plan yet. The friend is
// the first one with the fewest places waiting, so a second press is a second friend, and a friend at the limit is passed over.
// How to call: await friendProposes(api, session, ['faith', 'jonathan']) -> 'Faith proposed Bishan Green Halal Kitchen.'
export async function friendProposes(api, session, friendIds) {
  if (!friendIds.length) return 'Invite a friend first.'
  const waiting = (id) => (session.proposals || []).filter((p) => p.by === id).length
  const friend = [...friendIds].sort((a, b) => waiting(a) - waiting(b))[0]
  if (waiting(friend) >= ROAM.perMember) return `${friendName(friend)} already has ${ROAM.perMember} places waiting.`
  const { places } = await api.roamNearby(session.id)
  const place = places.find((p) => p.state === 'free')
  if (!place) return 'Nothing nearby is free to propose.'
  await api.proposeStop(session.id, friend, place.id)
  return `${friendName(friend)} proposed ${place.venue.name}.`
}
