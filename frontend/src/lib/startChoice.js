// The Start choice: how the host decides to pick the meeting point when they press Start session, and the words for it.
// Two ways: 'fairest' (everyone shares where they start and Jio finds a fair spot, the default) and 'known' (the host names the
// area and the group goes straight to choosing places). Guests see which one the host chose. The choice is saved on the session
// (`meetBy`, the column sessions.meet_by) in the same write that starts it; a session with none reads as 'fairest'.
// Nothing here touches a screen or the data layer.
import { AREAS } from '@/lib/mock/places.js'

// The two cards on the choice screen, in order. title/text/meta are the card's words.
export const CHOICES = [
  {
    key: 'fairest',
    title: 'Find the fairest spot',
    tag: 'Default',
    text: 'Everyone shares where they are starting. Jio finds a meeting point that is fair on every trip.',
    meta: 'Best when people start from different places',
    icon: 'people',
  },
  {
    key: 'known',
    title: 'We already know where',
    tag: '',
    text: 'You pick the area. The group goes straight to choosing places.',
    meta: 'Or set it to where you are right now',
    icon: 'pin',
  },
]

// The areas offered as chips on the follow-up, by id. All are in the app's area list (areas.test checks it).
export const POPULAR_AREAS = ['bishan', 'tampines', 'jurong-east', 'bugis', 'orchard', 'punggol', 'woodlands']

// The value of a session's choice: 'fairest' or 'known'. A session with none (started before the choice existed) is 'fairest'.
// How to call: meetByOf({ meetBy: null }) -> 'fairest'
export const meetByOf = (session) => (session?.meetBy === 'known' ? 'known' : 'fairest')

// The notice the group reads when the host changed the meeting place (the server writes the same words; backend/src/services/session-plan.js
// releasedBannerText). It names the host and nobody else, and says what went. `status` is what the session was (voting or confirmed), `hadVotes`
// whether anyone had voted, `placeName` the new area when the host named it.
// How to call: releasedNotice({ hostName: 'Ian', status: 'confirmed', hadVotes: true }) -> 'Ian changed the meeting place, so the votes and the plan were cleared.'
export function releasedNotice({ hostName, status, hadVotes, placeName = null }) {
  // With no votes there is nothing to say about them: the places to vote on were cleared, and with a named area they are chosen again there.
  const gone = status === 'confirmed' ? 'the votes and the plan were cleared' : hadVotes ? 'the votes were cleared' : placeName ? 'the places to vote on were chosen again' : 'the places to vote on were cleared'
  return `${hostName} changed the meeting place${placeName ? ` to ${placeName}` : ''}, so ${gone}.`
}

// The words of the host's "Change plan" choices and of the question that comes first. What is lost is named in plain words; what stays is said too.
export const CHANGE_PLAN = {
  button: 'Change plan',
  title: 'Change plan',
  text: 'What do you want to change?',
  // The re-plan works the meeting area out again: a chosen one stays, the planner's own pick may move, and then the votes go (the notice says so).
  again: { title: 'Choose places again', text: 'Back to voting. The stops go; the votes stay unless the meeting area moves.' },
  place: { title: 'Change meeting place', text: 'Pick the meeting area again. Everyone keeps where they start.' },
  confirmTitle: 'Change the meeting place?',
  // Shown before anything is lost. The plan is only named when there is one.
  lost: (confirmed) => [
    'everyone\'s votes',
    'the places to vote on',
    'the "Works for me" marks and the suggested spots',
    ...(confirmed ? ['the itinerary\'s stops and any proposed places'] : []),
  ],
  keeps: 'Everyone\'s starting places are kept.',
  keep: 'Keep the meeting place',
  go: 'Choose a new meeting place',
}

// The words on the host's main button on the choice screen, and the note under it.
// How to call: startLabel('known') -> 'Choose the area'
export const startLabel = (choice) => (choice === 'known' ? 'Choose the area' : 'Ask everyone to share where they start')
export const START_NOTE = 'Guests see that you chose this.'
// The same, when the host is changing the meeting place after it was set (views/StartView.vue with `change`). The starts are kept, so the first
// choice does not ask anyone to share them again; the note says what the button will clear.
// How to call: changeLabel('fairest') -> 'Work out the spots again'
export const changeLabel = (choice) => (choice === 'known' ? 'Choose the area' : 'Work out the spots again')
export const CHANGE_NOTE = 'This clears the votes and the plan. Everyone keeps where they start.'
export const CHANGE_HEAD = { title: 'How do you want to pick the new meeting point?', text: 'Nothing changes until you press the button below.' }

// The follow-up's button: named for the area, or for using where the person is.
// How to call: whereLabel({ name: 'Bishan' }) -> 'Meet at Bishan'; whereLabel(null, true) -> 'Use my location'
export function whereLabel(area, here = false) {
  if (here) return 'Use my location'
  return area ? `Meet at ${area.name}` : 'Choose an area'
}
export const WHERE_NOTE = 'Then you choose places together.'
// Under the button once "We're here now" is chosen: it is the outing's meeting area that is set, not a look at what is nearby.
export const HERE_NOTE = 'This sets the meeting area to where you are now. Then you choose places together.'

// The areas whose name contains what was typed (case and spaces ignored), in the app's order; the popular ones when nothing is typed.
// How to call: findAreas('bis') -> [{ id: 'bugis', ... }, { id: 'bishan', ... }]
export function findAreas(query, limit = 8) {
  const q = String(query ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (!q) return POPULAR_AREAS.map((id) => AREAS.find((a) => a.id === id)).filter(Boolean)
  return AREAS.filter((a) => a.name.toLowerCase().includes(q)).slice(0, limit)
}

// What a guest is told on the Locate step about the host's choice, or null when there is nothing to say: the session has no
// recorded choice (it started before the choice existed), the reader is the host, or the group has moved on. `settled` is a confirmed meeting spot.
//   { title: 'Ian chose to find the fairest spot', text: 'Add where you are starting. ...' }
//   { title: 'Ian chose the place', text: 'They are picking the area now. ...' } (a known place not set yet)
// How to call: guestLine({ meetBy: 'fairest', status: 'locating', hostId: 'ian' }, 'Ian', 'faith')
export function guestLine(session, hostName, myId) {
  if (!session?.meetBy || session.status !== 'locating' || session.hostId === myId) return null
  if (session.meetBy === 'known') {
    return { title: `${hostName} chose the place`, text: 'They are picking the area now. Then the group goes straight to choosing places.' }
  }
  return {
    title: `${hostName} chose to find the fairest spot`,
    text: "Add where you are starting. Jio then finds the meeting point that is fair on everyone's trip. You can still suggest a spot.",
  }
}

// What the host sees on the Locate step when they chose "We already know where" and the place is not set yet (the write that
// names it failed, or they left before it finished). Null otherwise.
// How to call: hostPendingLine({ meetBy: 'known', status: 'locating', hostId: 'ian' }, 'ian')
export function hostPendingLine(session, myId) {
  if (session?.meetBy !== 'known' || session.status !== 'locating' || session.hostId !== myId) return null
  return 'You chose a place you already know, but have not named the area. Use "We already have a place" below to carry on.'
}

// Why the browser could not give a place, in a sentence. `error` is a GeolocationPositionError ({ code }) or an Error with `message`.
// How to call: locationError({ code: 1 }) -> 'Location access is off. Pick an area instead.'
export function locationError(error) {
  if (error?.code === 1) return 'Location access is off. Pick an area instead.'
  if (error?.code === 2) return 'Your location could not be found. Pick an area instead.'
  if (error?.code === 3) return 'Finding your location took too long. Pick an area instead.'
  return error?.message || 'Your location could not be used. Pick an area instead.'
}

// Ask the browser where the person is, and give back the area nearest to it. Only the area leaves this function: the coordinates are
// not kept, sent or shown. Throws a sentence (locationError) when location is not offered or refused, and another when the person
// is outside Singapore.
// `geolocation` and `placeFromCoords` are passed in (navigator.geolocation and api.placeFromCoords) so a test can stand in for them.
// How to call: const place = await areaHere(navigator.geolocation, api.placeFromCoords) -> { areaId: 'tampines', sub: 'Tampines', ... }
export async function areaHere(geolocation, placeFromCoords, timeout = 10000) {
  if (!geolocation) throw new Error('This browser cannot share your location. Pick an area instead.')
  const position = await new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(resolve, (error) => reject(new Error(locationError(error))), { timeout })
  })
  const place = await placeFromCoords(position.coords.latitude, position.coords.longitude)
  if (!place) throw new Error('Your location is outside Singapore. Pick an area instead.')
  return place
}
