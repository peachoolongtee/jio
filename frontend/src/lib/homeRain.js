// Rain on Home's dotted map: which meetups are close enough to ask about, what to ask, and what to draw and say. Pure functions;
// lib/useHomeRain.js is the part that asks and keeps the answer.
//
// Home asks only when the person has an outing within two hours (or one under way): the two-hour forecast is the only one
// that is about "the next two hours". With no such outing there is no request and no layer. The planner is asked about each
// outing's meeting area (POST /api/weather/stops, at most 8 places), so rain is drawn around the places the person is going
// to, not over all 47 forecast areas: the backend has no route that lists them.
import { dayOf } from './homeMeetups.js'
import { singaporeInstant } from './session.js'
import { homeRainText } from './weatherText.js'

// How far ahead an outing counts, and the most places one request may ask about.
export const SOON_MS = 2 * 60 * 60 * 1000
export const MAX_PLACES = 8

// The outings that count: still going, with a meeting point, starting within two hours or under way (not yet ended).
// How to call: outingsSoon(activeMeetups(sessions), new Date()) -> [meetup, ...]
export function outingsSoon(meetups, now = new Date()) {
  return (meetups || []).filter((m) => {
    if (!m?.area) return false
    const day = dayOf(m, now)
    // The times are Singapore's, which has no daylight saving, so a day is 24 hours.
    const start = singaporeInstant(day, m.start)
    if (!start) return false
    let end = singaporeInstant(day, m.end)
    // An end at or before the start is the next day ("22:00" to "01:00").
    if (end && end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000)
    if (end && now >= end) return false
    return start.getTime() - now.getTime() <= SOON_MS
  })
}

// What to ask the planner: one stop for each meeting area (the earliest outing there), at that outing's start.
// How to call: stopsFor(outings, now) -> [{ id: 'bishan', point: { lat, lng }, start: '2026-10-11T15:00' }]
export function stopsFor(outings, now = new Date()) {
  const places = new Map()
  for (const m of outings) {
    if (places.has(m.area.id)) continue
    places.set(m.area.id, { id: m.area.id, point: { lat: m.area.lat, lng: m.area.lng }, start: `${dayOf(m, now)}T${m.start}` })
  }
  return [...places.values()].slice(0, MAX_PLACES)
}

// What Home draws and says, from the outings and the planner's answer ({ stops: { [areaId]: weather }, weather: block }):
// the places where rain is likely, the words for a screen reader (and everyone), and the block for the source line.
// Null when the answer is missing or no place has rain likely.
// How to call: rainView(outings, answer) -> { places: [{ id, name, lat, lng }], text: 'Rain likely around Bishan in the next two hours', block }
export function rainView(outings, answer) {
  if (!answer?.stops) return null
  const seen = new Set()
  const places = []
  for (const m of outings) {
    if (seen.has(m.area.id)) continue
    seen.add(m.area.id)
    if (answer.stops[m.area.id]?.rainLikely === true) places.push({ id: m.area.id, name: m.area.name, lat: m.area.lat, lng: m.area.lng })
  }
  if (!places.length) return null
  return { places, text: homeRainText(places.map((p) => p.name)), block: answer.weather ?? null }
}
