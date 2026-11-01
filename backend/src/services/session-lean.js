import { lower, MIN_STARTS, SPOT_RULE } from './session-plan.js'

// Whether the caller's own past travel counts in the pick of a session's meeting spots, as a pure function: rows in, one answer out. No database,
// no clock. The planner leans towards whoever travelled more than their share in other outings of the last 90 days (session_travel_debt() in the
// database, services/session-ledger.js writes the ledger), and the Locate step may use that to tell that person, on the first spot, "This spot is closer to you." when the browser can check it from the minutes every
// member sees (frontend/src/lib/travelLean.js closerToYou). It tells only the person it is true of: the answer is the caller's own flag and the rule in
// use, never a number, never another person's debt, never a comparison.
//
// What the debt does depends on the rule (planner/engine.js, planner/balance.js). Under "longest", the rule the spots use (SPOT_RULE), the spot
// with the shortest longest trip wins and a debt only breaks an exact tie between spots (their weighted average trip is lower). Under
// "balanced" a person's trip counts up to three times as much while the spot is chosen. So the answer carries the rule, and the screen claims
// nothing about it beyond what it can check (frontend/src/lib/travelLean.js). Nothing here says the pick moved.
//
// How to call:
//   leanFor({ status: 'locating', meetBy: 'fairest', members, areasById, userId, debts }) // { owed: true, rule: 'longest' }

// How many minutes of past travel a person must be owed before the line is shown to them. A smaller debt can only settle an exact tie, which is
// too rare to say anything about. The browser's own path holds the same number (frontend/src/lib/travelLean.js MIN_DEBT_MINUTES).
//
// How to call:
//   MIN_DEBT_MINUTES // 5
export const MIN_DEBT_MINUTES = 5

// The answer when the line is not for this person now.
//
// How to call:
//   NOT_OWED // { owed: false, rule: 'longest' }
export const NOT_OWED = Object.freeze({ owed: false, rule: SPOT_RULE })

// Is a pick made for the caller now, which their past travel could enter? Only while the group is choosing where to meet (`locating`), only when
// the host did not name the place themselves (`meetBy` is not 'known'; pass null before it is known), and only when the caller and at least one
// other joined member have a start the planner knows (without two starts there are no spots, so nothing is picked).
//   members  [{ user_id, state, start_area_id }]     areasById  Map of the areas the planner knows
//
// How to call:
//   picksFor({ status: 'locating', meetBy: null, members, areasById, userId: 'u1' }) // true
export function picksFor({ status, meetBy, members, areasById, userId }) {
  if (status !== 'locating' || meetBy === 'known') return false
  const me = lower(userId)
  const located = members.filter((m) => m.state === 'joined' && areasById.has(m.start_area_id))
  return located.length >= MIN_STARTS && located.some((m) => lower(m.user_id) === me)
}

// Does the planner count the caller's past travel in a pick that is made now, enough to say so? Only when a pick is made for them (picksFor) and the
// caller's own debt is at least MIN_DEBT_MINUTES. A debt that could not be read (`debts` is null, or has no entry for the caller) is not owed.
//   debts  Map of lower-case user id to minutes, or null
//
// How to call:
//   leanFor({ status: 'locating', meetBy: null, members, areasById, userId: 'u1', debts: new Map([['u1', 12.5]]) }) // { owed: true, rule: 'longest' }
export function leanFor({ debts, ...pick }) {
  if (!picksFor(pick)) return NOT_OWED
  const debt = debts?.get(lower(pick.userId))
  return typeof debt === 'number' && Number.isFinite(debt) && debt >= MIN_DEBT_MINUTES ? { owed: true, rule: SPOT_RULE } : NOT_OWED
}
