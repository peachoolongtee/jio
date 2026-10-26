import { lower } from './session-plan.js'

// What the planner may know of a group's past, as pure functions: rows in, rows out. The planner uses two things from the past of the people
// in a session: the places the group has been to lately (so a ranking does not offer the same place again soon), and how much each person has
// travelled more than their share in other outings (their travel debt, so the meeting area leans towards whoever has travelled most).
//
// Both are an extra, never a need. The service (services/sessions.js) reads them softly: if anything fails, or the history is slow, the
// planner answers without it, and no request is ever refused because the history could not be read.
//
// Only the caller's own finished outings are read (the database's rules show nobody else's), the newest 30 of the last 60 days (the
// planner's repeat penalty fades to nothing at 60 days), and an outing counts as "the same group" only when at least two of this session's
// joined members were in it (or both, in a group of two). Nothing in a visit says who went: it is a place and a day.
//
// How to call:
//   const visits = visitsFrom({ outings, sessionId, joined: new Set(['u1', 'u2']) }) // [{ groupId: sessionId, venueId: 'a', date: '2026-10-03' }]

// How far back finished outings are read, in days: the repeat penalty is 0 after 60.
export const HISTORY_DAYS = 60

// The most finished outings read.
export const HISTORY_OUTINGS = 30

// When history is read from, as the ISO time `HISTORY_DAYS` before `now`.
//
// How to call:
//   historySince(Date.parse('2026-10-23T00:00:00Z')) // '2026-08-24T00:00:00.000Z'
export const historySince = (now) => new Date(now - HISTORY_DAYS * 24 * 3600 * 1000).toISOString()

// The visits of the group in the finished outings read: for every outing that shares enough people with this session, each of its stops as
// { groupId, venueId, date } with the group id the engine matches on (this session's id) and the outing's own date. A place that was a stop
// twice in a day counts once for that day.
//   outings  { sessions: [{ id, date }], members: [{ session_id, user_id, state }], stops: [{ session_id, venue_id }] }
//   joined   a Set of the lower-case ids of this session's joined members
//
// How to call:
//   visitsFrom({ outings, sessionId, joined })
export function visitsFrom({ outings, sessionId, joined }) {
  const need = Math.min(2, joined.size)
  if (need === 0) return []
  const here = new Set()
  const visits = []
  for (const outing of outings.sessions) {
    if (lower(outing.id) === lower(sessionId)) continue
    const together = new Set(outings.members.filter((m) => lower(m.session_id) === lower(outing.id) && m.state === 'joined' && joined.has(lower(m.user_id))).map((m) => lower(m.user_id)))
    if (together.size < need) continue
    for (const stop of outings.stops) {
      if (lower(stop.session_id) !== lower(outing.id)) continue
      const key = `${stop.venue_id}|${outing.date}`
      if (here.has(key) || !/^\d{4}-\d{2}-\d{2}$/.test(String(outing.date))) continue
      here.add(key)
      visits.push({ groupId: sessionId, venueId: stop.venue_id, date: outing.date })
    }
  }
  return visits
}
