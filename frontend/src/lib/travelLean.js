// "Jio remembers": the one quiet line on the first meeting spot of the Locate step, "This spot is closer to you.", for the person the planner
// leans towards. Pure functions: no store, no clock, no request. The data layer (lib/api.js travelLean) decides whether the planner counted the
// signed-in person's past travel in this pick, from the server for a real account (GET /api/sessions/:id/travel-lean) or from this browser's
// finished outings for a demo or local account (localDebts), and the spot list shows what leanLine says, on the first spot only.
//
// What may be said is only what is certain. Whatever the rule (backend planner/engine.js and balance.js), a past debt does not decide the first
// spot alone, and the answer does not say the pick moved. So the line makes one claim that can be checked on the screen: this spot is closer to
// the person than the group's average, from the minutes the row already shows to everyone (closerToYou). It is the same for every rule, says
// nothing about past travel, ties or shares, and names no one else, so it reveals nothing new. It shows only for a debt of MIN_DEBT_MINUTES or
// more, and shows nothing when the person's minutes are missing or are not below the average.
//
// How to call:
//   leanLine('longest') // 'This spot is closer to you.'
//   closerToYou({ ian: 20, darius: 40 }, 'ian') // true

// The rule the browser's own planner requests use for the meeting spots: the default, "longest" (lib/plannerApi.js meetingArea sends neither a
// rule nor 'balanced'). Routing off asks for the geographic centre instead: the first spot is then the centre, which counts nobody's
// past travel, so the line is not shown (see localLean). The runners-up are still ordered by the worst trip and then the fair mean, where a debt
// counts, but the line says nothing of them.
export const LOCAL_RULE = 'longest'

// How many minutes of past travel a person must be owed before the line is shown: the server's number (backend services/session-lean.js).
export const MIN_DEBT_MINUTES = 5

// How far back finished outings count, in days: the server's session_travel_debt() reads the same 90.
export const DEBT_DAYS = 90

// The line for each rule: one sentence for all of them. A rule not listed has no line: nothing is claimed for a rule this code does not know.
export const LEAN_LINES = Object.freeze({
  longest: 'This spot is closer to you.',
  balanced: 'This spot is closer to you.',
})

// The line to show for a rule, or '' for a rule it does not know.
//
// How to call:
//   leanLine('balanced') // 'This spot is closer to you.'
export const leanLine = (rule) => LEAN_LINES[rule] ?? ''

// Is this spot closer to the person than to the group on average? True only when their own minutes are there and are below the average of the
// minutes everyone has to the spot (the same figures its row shows). Missing minutes, a person who is not in them, or minutes that are not
// numbers give false, as does a trip at or above the average.
//   times  { <person id>: minutes } of a spot      myId  the signed-in person
//
// How to call:
//   closerToYou({ ian: 20, darius: 40 }, 'ian') // true
export function closerToYou(times, myId) {
  const mine = times?.[myId]
  if (!Number.isFinite(mine)) return false
  const all = Object.values(times).filter((minutes) => Number.isFinite(minutes))
  return mine < all.reduce((sum, minutes) => sum + minutes, 0) / all.length
}

// Each person's travel debt in minutes from finished outings in this browser: for every outing that was completed in the last `DEBT_DAYS` days
// (other than `exceptId`), a person's trip to the meeting area minus the average of the people who had a trip. Positive means they travelled
// more than their share, as the ledger's delta_from_mean does on the server (which also counts the legs between stops and the trip home; a
// session kept in this browser keeps only the trip in). Outings with one person with a trip leave everyone at nothing. Only people who were in
// a counted outing are in the answer. An outing that closed by itself with no confirmed plan (`endedBy` 'closed') never happened, so it is not
// counted, as lib/hangouts.js does not count it.
//   sessions  [{ id, status, endedBy, completedAt, meeting: { times: { <person id>: minutes } } }]
//
// How to call:
//   localDebts(db.sessions, { now: Date.now(), exceptId: 's9' }) // Map { 'ian' => 8.5, 'faith' => -8.5 }
export function localDebts(sessions, { now, exceptId = null }) {
  const since = now - DEBT_DAYS * 24 * 3600 * 1000
  const debts = new Map()
  for (const session of sessions) {
    if (session.id === exceptId || session.status !== 'completed' || session.endedBy === 'closed' || !(session.completedAt > since)) continue
    const trips = Object.entries(session.meeting?.times || {}).filter(([, minutes]) => Number.isFinite(minutes) && minutes >= 0)
    if (trips.length < 2) continue
    const mean = trips.reduce((sum, [, minutes]) => sum + minutes, 0) / trips.length
    for (const [person, minutes] of trips) debts.set(person, (debts.get(person) ?? 0) + (minutes - mean))
  }
  return debts
}

// Does this browser's planner count the signed-in person's past travel in the pick for this session? The same rules as the server's: the group
// is choosing where to meet (`locating`), the host did not name the place, the person and at least one other have shared where they start,
// routing is on (off, the planner takes the geographic centre, so no spot is picked by a trip), and the person's debt is at least MIN_DEBT_MINUTES.
//   starts  how many active people have shared a start      mine  whether the signed-in person is one of them
//
// How to call:
//   localLean({ session, myId: 'ian', debts, routing: true, starts: 2, mine: true }) // { owed: true, rule: 'longest' }
export function localLean({ session, myId, debts, routing, starts, mine }) {
  const none = { owed: false, rule: LOCAL_RULE }
  if (session.status !== 'locating' || session.meetBy === 'known' || !routing || !mine || starts < 2) return none
  return (debts.get(myId) ?? 0) >= MIN_DEBT_MINUTES ? { owed: true, rule: LOCAL_RULE } : none
}
