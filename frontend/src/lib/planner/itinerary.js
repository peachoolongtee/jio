// The itinerary: stops in order, the travel between them, the end point and each person's trip home.
//
// - Each leg offers Walk, MRT and Car, each with its own time. The chosen mode sets when the next stop starts,
//   so changing it moves every later stop.
// - If anyone's trip home is over 60 minutes, the itinerary warns with that person's name.
// - Stops can be rearranged. The plan keeps its start time; each stop follows the one before it, and a stop that
//   would be closed at its new time is flagged (never silently kept as if it were fine).
import { legOptions, transitMinutes, defaultMode } from './travel.js'
import { toMinutes } from './format.js'

export const LONG_TRIP_MINUTES = 60

// The last stop should be this close to an MRT station (minutes on foot), so everyone can get home.
export const LAST_STOP_MRT_WALK = 10

// Is the venue open for the whole of [start, end) (minutes after midnight)? Hours are strings such as
// "07:30-20:00"; a closing time before the opening time runs past midnight. A venue with no hours listed
// (most CDC sites) counts as open: there is nothing to warn about.
export function isOpenDuring(venue, start, end) {
  const hours = venue.hours || []
  if (!hours.length) return true
  return hours.some((text) => {
    const [open, rawClose] = text.split('-').map(toMinutes)
    const close = rawClose <= open ? rawClose + 1440 : rawClose
    // Try the stop as it is, and shifted by a day for places that open late and close after midnight.
    return [0, 1440].some((shift) => start + shift >= open && end + shift <= close)
  })
}

// stops: [{ venue, plannedStart, duration, notBefore? }] in order. modes: ['walk' | 'mrt' | 'car'] per leg, or empty for defaults.
// startAt: when the plan starts (minutes). Defaults to the first stop's planned start.
// notBefore: the stop never starts earlier than this (minutes), leaving free time before it. The AI order on confirm
// sets it, so a meal keeps its time and a shop waits until it opens. Moving or deleting a stop by hand clears it.
// Each timed stop says whether the place is open for its whole time (`open`).
export function buildItinerary(stops, modes = [], startAt = null, { windowEnd = null, stayUntil = null } = {}) {
  const legs = []
  const timed = []
  stops.forEach((stop, i) => {
    let start = i === 0 && startAt != null ? startAt : stop.plannedStart
    if (i > 0) {
      const prev = timed[i - 1]
      const options = legOptions(prev.venue, stop.venue)
      // A mode this version does not offer (a plan saved with "grab") falls back to the default.
      const mode = modes[i - 1] in options ? modes[i - 1] : defaultMode(options)
      legs.push({ index: i - 1, options, mode, minutes: options[mode] })
      start = prev.end + options[mode]
    }
    if (stop.notBefore != null) start = Math.max(start, stop.notBefore)
    const end = start + stop.duration
    timed.push({
      ...stop,
      start,
      end,
      open: isOpenDuring(stop.venue, start, end),
      withinWindow: windowEnd == null || end <= windowEnd,
      withinStay: stayUntil == null || end <= stayUntil,
    })
  })
  return { stops: timed, legs }
}

// The longest sentence about the order that is kept. The AI is asked for one short sentence; this is the limit if it
// does not obey.
export const REASON_MAX = 200

// A sentence from the AI or the rules, made safe to keep and show as text: control characters (line breaks, escapes)
// become spaces, runs of spaces become one, and it is cut to REASON_MAX characters. Not a string gives ''.
// How to call: cleanReason('Shops first.\n\u0007Then lunch.') -> 'Shops first. Then lunch.'
export function cleanReason(text) {
  if (typeof text !== 'string') return ''
  const plain = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  // Count characters, not code units, so a cut never splits an emoji in half.
  return [...plain].slice(0, REASON_MAX).join('').trim()
}

// Can the Confirm dialog's suggestion be applied to the stops this confirm makes? Yes only when its times belong to
// the order it names: the same slots, places and lengths as the voted stops, each stop listed once in the order
// named, times in the day that never overlap, and a meal never earlier than its time from voting.
// stops: [{ slotId, category, venueId, plannedStart, duration }] (the voted stops).
// suggestion: { order: [slotId], stops: [{ slotId, category, venueId, duration, start }] }.
// How to call: suggestionFits(stops, { order: ['a', 'b'], stops: [{ slotId: 'a', ... start: 600 }, ...] }) -> true
export function suggestionFits(stops, suggestion) {
  const order = suggestion?.order
  const timed = suggestion?.stops
  if (!Array.isArray(order) || !Array.isArray(timed) || !stops.length) return false
  if (order.length !== stops.length || timed.length !== stops.length) return false
  const voted = new Map(stops.map((s) => [s.slotId, s]))
  if (voted.size !== stops.length) return false
  let freeFrom = 0
  const seen = new Set()
  return timed.every((s, i) => {
    const mine = voted.get(s.slotId)
    if (!mine || order[i] !== s.slotId || seen.has(s.slotId)) return false
    seen.add(s.slotId)
    if (s.venueId !== mine.venueId || s.category !== mine.category || s.duration !== mine.duration) return false
    if (!Number.isFinite(s.start) || s.start < freeFrom || s.start >= 2880) return false
    if (mine.category === 'eat' && Number.isFinite(mine.plannedStart) && s.start < mine.plannedStart) return false
    freeFrom = s.start + s.duration
    return true
  })
}

// Move one item of a list to another position, for rearranging stops. Returns a new array.
export function moveItem(list, from, to) {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item)
  return next
}

// people: [{ id, name, end: { lat, lng, name } }]
export function tripsHome(lastVenue, people, travel = transitMinutes) {
  if (!lastVenue) return []
  return people.map((p) => {
    const minutes = travel(lastVenue, p.end)
    return { id: p.id, name: p.name, place: p.end.name, minutes, long: minutes > LONG_TRIP_MINUTES }
  })
}

// The end point of the plan: the last stop and its MRT station.
export function endPoint(lastVenue) {
  if (!lastVenue) return null
  // After rearranging, the last stop may no longer be near an MRT station: say so.
  return { name: lastVenue.name, mrt: lastVenue.mrt, mrtWalk: lastVenue.mrtWalk, farFromMrt: lastVenue.mrtWalk > LAST_STOP_MRT_WALK }
}
