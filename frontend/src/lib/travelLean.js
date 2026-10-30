// "Jio remembers": the one quiet line on the Locate step that tells a person their past travel is counted when the meeting spot is picked.
// Pure functions: no store, no clock, no request. The data layer (lib/api.js travelLean) decides whether the line is for the signed-in person,
// from the server for a real account (GET /api/sessions/:id/travel-lean) or from this browser's finished outings for a demo or local account
// (localDebts), and the spot list shows what leanLine says.
//
// What is true, and so what may be said, depends on the rule the spots are picked by (backend planner/engine.js and balance.js):
//   longest   the spot where the longest trip is shortest wins; a person's past travel only breaks an exact tie between spots. The line says
//             exactly that, and does not say the pick moved for them.
//   balanced  a person's trip counts up to three times as much while the spot is chosen, among spots about as good for the group. The line
//             says their trip is counted for more.
// Either line is about the person it is shown to alone: no name, no other person, no number of minutes, no "the most".
//
// How to call:
//   leanLine('longest') // 'You have travelled more than your share lately. If two spots tie on the longest trip, Jio counts your trip more.'

// The rule the browser's own planner requests use for the meeting spots: the default, "longest" (lib/plannerApi.js meetingArea sends neither a
// rule nor 'balanced'). Routing off asks for the geographic centre instead, which counts nobody's past travel (see localLean).
export const LOCAL_RULE = 'longest'

// How far back finished outings count, in days: the server's session_travel_debt() reads the same 90.
export const DEBT_DAYS = 90

// The line for each rule. A rule not listed has no line: nothing is claimed that the rule does not do.
export const LEAN_LINES = Object.freeze({
  longest: 'You have travelled more than your share lately. If two spots tie on the longest trip, Jio counts your trip more.',
  balanced: 'You have travelled more than your share lately, so Jio counts your trip for more when it picks a spot.',
})

// The line to show for a rule, or '' for a rule it does not know.
//
// How to call:
//   leanLine('balanced') // 'You have travelled more than your share lately, so Jio counts your trip for more when it picks a spot.'
export const leanLine = (rule) => LEAN_LINES[rule] ?? ''

// Each person's travel debt in minutes from finished outings in this browser: for every outing that was completed in the last `DEBT_DAYS` days
// (other than `exceptId`), a person's trip to the meeting area minus the average of the people who had a trip. Positive means they travelled
// more than their share, as the ledger's delta_from_mean does on the server (which also counts the legs between stops and the trip home; a
// session kept in this browser keeps only the trip in). Outings with one person with a trip leave everyone at nothing. Only people who were in
// a counted outing are in the answer.
//   sessions  [{ id, status, completedAt, meeting: { times: { <person id>: minutes } } }]
//
// How to call:
//   localDebts(db.sessions, { now: Date.now(), exceptId: 's9' }) // Map { 'ian' => 8.5, 'faith' => -8.5 }
export function localDebts(sessions, { now, exceptId = null }) {
  const since = now - DEBT_DAYS * 24 * 3600 * 1000
  const debts = new Map()
  for (const session of sessions) {
    if (session.id === exceptId || session.status !== 'completed' || !(session.completedAt > since)) continue
    const trips = Object.entries(session.meeting?.times || {}).filter(([, minutes]) => Number.isFinite(minutes) && minutes >= 0)
    if (trips.length < 2) continue
    const mean = trips.reduce((sum, [, minutes]) => sum + minutes, 0) / trips.length
    for (const [person, minutes] of trips) debts.set(person, (debts.get(person) ?? 0) + (minutes - mean))
  }
  return debts
}

// Does this browser's planner count the signed-in person's past travel in the pick for this session? The same rules as the server's: the group
// is choosing where to meet (`locating`), the host did not name the place, the person and at least one other have shared where they start,
// routing is on (off, the planner takes the geographic centre and counts nobody's past travel), and the person's debt is above nothing.
//   starts  how many active people have shared a start      mine  whether the signed-in person is one of them
//
// How to call:
//   localLean({ session, myId: 'ian', debts, routing: true, starts: 2, mine: true }) // { owed: true, rule: 'longest' }
export function localLean({ session, myId, debts, routing, starts, mine }) {
  const none = { owed: false, rule: LOCAL_RULE }
  if (session.status !== 'locating' || session.meetBy === 'known' || !routing || !mine || starts < 2) return none
  return (debts.get(myId) ?? 0) > 0 ? { owed: true, rule: LOCAL_RULE } : none
}
