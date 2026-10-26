import { mockTravelMinutes } from '../planner/geo.js'

// The travel ledger of a finished outing, as pure functions: rows in, rows out. No database, no planner call, no clock.
//
// The ledger says how far each person travelled for one outing, in three parts: in (from where they started to the meeting area, which the
// server stored when the host confirmed the spot), between (the legs from stop to stop, the same for everyone who stayed), and home (from the
// last stop to where they end the day). `delta_from_mean` is a person's total minus the group's average: positive means they travelled more
// than their share, so the planner favours them next time (session_travel_debt() in the database). The deltas of one outing sum to exactly
// zero, so the ledger only moves effort around.
//
// Nothing here knows an exact place: the start and the end are the centres of areas, as everywhere on the server.
//
// How to call:
//   const rows = ledgerFor([{ userId, minutesIn: 24, minutesBetween: 15, minutesHome: 31 }, ...])

// The people of an outing who have a ledger row: the joined members whose minutes in were stored when the meeting spot was confirmed. A
// member who never shared where they start has no travel to put in a ledger, and is left out rather than counted as zero.
//
// How to call:
//   ledgerPeople(draft.members) // the member rows that count
export const ledgerPeople = (members) => members.filter((m) => m.state === 'joined' && m.travel_minutes !== null && m.travel_minutes !== undefined)

// The ledger rows for the people given, ready for apply_session_plan: whole minutes in, between and home, and the delta from the mean in
// hundredths of a minute. The deltas are rounded to hundredths and the rounding left over goes to the person with the most minutes (the lowest
// id on a tie), so they sum to exactly zero as the database requires. No people, no rows.
//
// How to call:
//   ledgerFor([{ userId: 'a', minutesIn: 20, minutesBetween: 10, minutesHome: 30 }, { userId: 'b', minutesIn: 50, minutesBetween: 10, minutesHome: 30 }])
//   // [{ user_id: 'a', minutes_in: 20, minutes_between: 10, minutes_home: 30, delta_from_mean: -15 }, { user_id: 'b', ..., delta_from_mean: 15 }]
export function ledgerFor(people) {
  if (people.length === 0) return []
  const whole = (minutes) => Math.max(0, Math.round(Number.isFinite(minutes) ? minutes : 0))
  const rows = people.map((p) => {
    const minutesIn = whole(p.minutesIn)
    const minutesBetween = whole(p.minutesBetween)
    const minutesHome = whole(p.minutesHome)
    return { user_id: p.userId, minutes_in: minutesIn, minutes_between: minutesBetween, minutes_home: minutesHome, total: minutesIn + minutesBetween + minutesHome }
  })
  const sum = rows.reduce((s, r) => s + r.total, 0)
  // total - sum / n, in hundredths: (n x total - sum) x 100 / n.
  const cents = rows.map((r) => Math.round(((rows.length * r.total - sum) * 100) / rows.length))
  const left = -cents.reduce((s, c) => s + c, 0)
  if (left !== 0) {
    let at = 0
    rows.forEach((r, i) => {
      if (r.total > rows[at].total || (r.total === rows[at].total && String(r.user_id) < String(rows[at].user_id))) at = i
    })
    cents[at] += left
  }
  return rows.map(({ total: _total, ...r }, i) => ({ ...r, delta_from_mean: cents[i] / 100 }))
}

// The minutes between stops: the sum of the minutes stored on the stops (each is the leg into it; the first has none).
//
// How to call:
//   minutesBetween([{ travel_minutes: null }, { travel_minutes: 12 }, { travel_minutes: 9 }]) // 21
export const minutesBetween = (stops) => stops.reduce((sum, s) => sum + (Number.isFinite(s.travel_minutes) ? s.travel_minutes : 0), 0)

// The engine's work for the trips home: from the last stop to where each person ends the day. It asks the engine's travel function for each
// person's trip and falls back to the estimate (the one the travel layer hands in, else the straight-line guess) where there is no real
// time. The last stop carries an `id` and the end points do not, so the travel-time layer (services/travel-times.js) sees one candidate: all
// of these trips, routed together or not at all. That keeps a request inside the OneMap cap whatever the group's size.
//
// How to call (through the shared runs, so the OneMap cap and budget apply):
//   const { result } = await runs.runWithTravel({ from: { id, lat, lng }, people: [{ id, end: { lat, lng } }], dateTime }, data, homeTripsRun)
//   // result: { minutes: { <user id>: 31 } }
export function homeTripsRun(input, _data, deps = {}) {
  const estimate = deps.estimateMinutes ?? mockTravelMinutes
  const ask = deps.travelMinutes ?? estimate
  const minutes = {}
  for (const person of input.people) {
    const m = ask(input.from, person.end)
    minutes[person.id] = Number.isFinite(m) && m >= 0 ? m : estimate(input.from, person.end)
  }
  return { minutes }
}
