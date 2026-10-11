// The words and small decisions behind the meeting spots on the Locate screen, written once so the list, the map's card
// and the tests say the same thing. Nothing here touches a screen or the data layer; every function takes the session
// as lib/api.js gives it (session.spots, session.locations, session.activeIds).
import { travelTone } from '@/lib/planner/travel.js'
import { AREAS } from '@/lib/mock/places.js'

// The most different areas a group can suggest at once (the planner's limit; lib/api.js refuses more).
export const SUGGESTIONS_MAX = 8

// A trip in words. Estimated times say "about"; a trip of nothing says so; no time at all says nothing (never "null" or
// "0 min").
// How to call: timeText(25, true) -> 'about 25 min'; timeText(0, false) -> 'already there'; timeText(null) -> ''
export function timeText(minutes, approximate = false) {
  if (minutes == null || !Number.isFinite(minutes)) return ''
  if (minutes === 0) return 'already there'
  return `${approximate ? 'about ' : ''}${minutes} min`
}

// The longest trip and the average, as the line under a spot's name. Empty when there are no trips to count (a known
// place before anyone shared a start).
// How to call: tripsLine({ worstMinutes: 30, meanMinutes: 25, approximate: true }) -> 'Longest trip about 30 min · Average about 25 min'
export function tripsLine(spot) {
  if (spot.worstMinutes === 0) return 'Nobody has to travel'
  const longest = timeText(spot.worstMinutes, spot.approximate)
  const average = timeText(spot.meanMinutes, spot.approximate)
  return [longest && `Longest trip ${longest}`, average && `Average ${average}`].filter(Boolean).join(' · ')
}

// Each person's trip to a spot, in the order the planner gave them: who, the words, and the travel colour's name.
// Anyone without a start has no trip and is left out. `names` is (id) => name; the signed-in person reads "You".
// How to call: peopleTrips(spot, nameOf, 'ian') -> [{ id: 'ian', name: 'You', text: 'about 25 min', tone: 'short' }]
export function peopleTrips(spot, names, myId) {
  return Object.entries(spot.times || {})
    .filter(([, minutes]) => minutes != null)
    .map(([id, minutes]) => ({ id, name: id === myId ? 'You' : names(id), text: timeText(minutes, spot.approximate), tone: travelTone(minutes) }))
}

// Who put a spot forward: the app, or a member by name.
// How to call: byLine({ by: 'app', byName: null }) -> 'Suggested by Jio'
export function byLine(spot, myId = '') {
  if (spot.by === 'app') return 'Suggested by Jio'
  return `Suggested by ${spot.by === myId ? 'you' : spot.byName || 'a member'}`
}

// How many people said a spot works for them, in words (the avatars beside it are only a picture of the same).
// How to call: worksForText({ approvalCount: 2 }) -> 'Works for 2 people'
export function worksForText(spot) {
  const n = spot.approvalCount || 0
  return n === 0 ? 'No one yet' : `Works for ${n} ${n === 1 ? 'person' : 'people'}`
}

// How many active people have shared where they start.
// How to call: startsShared(session) -> 2
export const startsShared = (session) => (session.activeIds || []).filter((id) => session.locations?.[id]?.start).length

// Is the group choosing where to meet? Spots change only then.
// How to call: isChoosing(session) -> true
export const isChoosing = (session) => session.status === 'locating'

// May this person suggest a spot now, without being refused? The group must be choosing, the person must be in it, two
// starts must be in (so there are trips to compare), and the group must not already hold the most different suggestions
// from other people (a new one would be refused).
// How to call: canSuggest(session, 'ian') -> true
export function canSuggest(session, myId) {
  if (!isChoosing(session) || !(session.activeIds || []).includes(myId)) return false
  if (startsShared(session) < 2) return false
  const suggestions = session.spots?.suggestions || {}
  const others = new Set(Object.entries(suggestions).filter(([id]) => id !== myId).map(([, s]) => s.areaId))
  return others.size < SUGGESTIONS_MAX
}

// May this person say a spot works for them? The group must be choosing and the person must be in it.
// How to call: canApprove(session, 'ian') -> true
export const canApprove = (session, myId) => isChoosing(session) && (session.activeIds || []).includes(myId)

// The spot that is shown as chosen for now: the one the person picked in the list if it is still there, otherwise the one
// the most people approved (session.spots.preselectedAreaId), otherwise the first. Null with no spots.
// How to call: shownSpotId(session.spots, picked) -> 'bugis'
export function shownSpotId(spots, picked = '') {
  const list = spots?.list || []
  if (picked && list.some((s) => s.areaId === picked)) return picked
  if (spots?.preselectedAreaId && list.some((s) => s.areaId === spots.preselectedAreaId)) return spots.preselectedAreaId
  return list[0]?.areaId ?? null
}

// Has the group settled where to meet? Yes from Voting on: the host confirmed a spot (or named a known place), and the
// Locate screen keeps showing the spots, with that one marked and nothing left to press.
// How to call: isSettled({ status: 'voting' }) -> true
export const isSettled = (session) => ['voting', 'confirmed', 'completed'].includes(session.status)

// The area that was confirmed, or '' while the group is still choosing (or the session was called off before it was).
// How to call: confirmedAreaId({ status: 'voting', meeting: { areaId: 'bugis' } }) -> 'bugis'
export const confirmedAreaId = (session) => (isSettled(session) && session.meeting?.areaId) || ''

// A row for the confirmed area when the list has none (the meeting area moved to somewhere that was never a spot, after a
// start changed during voting), built from the meeting itself. It reads as the app's, and says "Nobody has to travel"
// only when there really are trips to compare.
// How to call: spotFromMeeting(session) -> { areaId, area, by: 'app', worstMinutes, ... } or null
function spotFromMeeting(session) {
  const { meeting } = session
  const area = session.area || AREAS.find((a) => a.id === meeting?.areaId)
  if (!meeting || !area) return null
  const times = { ...(meeting.times || {}) }
  const trips = Object.keys(times).length
  return {
    areaId: meeting.areaId, area: { ...area }, by: 'app', byName: null, here: false,
    worstMinutes: trips ? meeting.maxMinutes : null,
    meanMinutes: trips && meeting.count ? Math.round(meeting.totalMinutes / meeting.count) : null,
    times, approximate: !!meeting.approximate, approvedBy: [], approvalCount: 0,
  }
}

// The spots as the Locate screen lists them. While the group is choosing, the list as the data layer keeps it. Once a
// spot is confirmed, the same spots with the confirmed one first (a known place leaves just that one). Every other spot
// stays, so the page keeps its shape.
// How to call: spotsToShow(session) -> [{ areaId: 'bugis', ... }, { areaId: 'bishan', ... }]
export function spotsToShow(session) {
  const list = session.spots?.list || []
  const confirmed = confirmedAreaId(session)
  if (!confirmed) return list
  const spot = list.find((s) => s.areaId === confirmed) || spotFromMeeting(session)
  return spot ? [spot, ...list.filter((s) => s.areaId !== confirmed)] : list
}

// The spot shown as selected: the one the person picked if it is listed, else the confirmed one, else the usual rule
// (shownSpotId). The row's outline and the map's red pin follow it.
// How to call: shownFor(session, 'bishan') -> 'bishan'
export function shownFor(session, picked = '') {
  const list = spotsToShow(session)
  if (picked && list.some((s) => s.areaId === picked)) return picked
  const confirmed = confirmedAreaId(session)
  if (confirmed && list.some((s) => s.areaId === confirmed)) return confirmed
  return shownSpotId(session.spots, picked)
}

// The Locate screen once the meeting spot is settled: the confirmed area, and everyone who shared a start with their trip
// to it, for the single card and the map's lines. Null while the group is still choosing, and when there is no meeting
// area to show (a session called off first). `names` is (id) => name.
// How to call: settledView(session, nameOf) -> { area: { id, name, lat, lng }, people: [{ id, name, lat, lng, areaName, minutes }] }
export function settledView(session, names) {
  if (!isSettled(session) || !session.meeting || !session.area) return null
  const times = session.meeting.times || {}
  const people = (session.activeIds || [])
    .filter((id) => session.locations?.[id]?.start)
    .map((id) => {
      const start = session.locations[id].start
      return { id, name: names(id), lat: start.lat, lng: start.lng, areaName: start.name, minutes: times[id] ?? null }
    })
  return { area: session.area, people }
}

// The line under "Where to meet" once a spot is confirmed.
// How to call: confirmedLine('Bugis') -> 'Bugis is confirmed as the meeting spot.'
export const confirmedLine = (areaName) => `${areaName} is confirmed as the meeting spot.`

// Your own suggestion when the list has no row for it: it was saved, but a reload came before the planner priced it. Null
// when you have none, it has a row, the planner is working on it right now, or the group is not choosing any more. The
// screen offers to price it again or take it back, so nobody is stuck with a suggestion they cannot withdraw.
// How to call: unpricedSuggestion(session, 'ian') -> { areaId: 'bugis', name: 'Bugis', here: false }, or null
export function unpricedSuggestion(session, myId) {
  const own = session.spots?.suggestions?.[myId]
  if (!own || !isChoosing(session) || session.findingSpots) return null
  if ((session.spots.list || []).some((s) => s.areaId === own.areaId)) return null
  return { areaId: own.areaId, name: AREAS.find((a) => a.id === own.areaId)?.name || own.areaId, here: !!own.here }
}

// What a screen reader says for a spot's pin on the map.
// A confirmed spot says so, after its name.
// How to call: pinName(spot, 1, 'ian') -> 'Spot 1, Bishan. Suggested by Jio. Longest trip about 30 min. Works for 2 people.'
export function pinName(spot, number, myId = '', confirmed = false) {
  return [`Spot ${number}, ${spot.area.name}`, confirmed && 'Confirmed', byLine(spot, myId), tripsLine(spot).split(' · ')[0], worksForText(spot)].filter(Boolean).join('. ') + '.'
}
