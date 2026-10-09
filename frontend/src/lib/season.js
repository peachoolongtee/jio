// Leaderboard seasons. The leaderboard runs for three months at a time, following the calendar quarters
// (January to March, April to June, ...).
//
// Rules
// - The ranking is by points earned this season: every meetup you finish earns 100.
// - When the season ends, whoever is first wins SEASON_PRIZE points to spend on café discounts.
//   A tie for first has one winner: the one with more all-time points, then the name that comes first.
//   Nobody wins a season in which nobody earned points.
// - Then season points start again from 0. Points you can spend are kept.
import { addMonths, differenceInCalendarDays, format, startOfQuarter } from 'date-fns'

export const SEASON_MONTHS = 3
export const SEASON_PRIZE = 500

// The season a date falls in: the calendar quarter, as timestamps. `endsAt` is the first moment after it.
export function quarterOf(date) {
  const start = startOfQuarter(date)
  return { startsAt: start.getTime(), endsAt: addMonths(start, SEASON_MONTHS).getTime() }
}

// The season after one that ended at `at`. It starts then and runs to the end of that calendar quarter, so a season
// ended early in the demo does not push every later one off the quarter boundaries.
export function nextSeason(previous, at) {
  return { number: previous.number + 1, startsAt: at, endsAt: quarterOf(new Date(at)).endsAt }
}

// Order of standings, best first: more points this season, then more all-time points, then the name, then the id.
// a, b: { id, name, seasonPoints, allTime }. How to call: rows.sort(compareStandings)
export function compareStandings(a, b) {
  return (
    b.seasonPoints - a.seasonPoints ||
    (b.allTime || 0) - (a.allTime || 0) ||
    (a.name || '').localeCompare(b.name || '', 'en') ||
    a.id.localeCompare(b.id, 'en')
  )
}

// rows: [{ id, name, seasonPoints, allTime }]. The id that finishes first, as a list of one, or [] when nobody
// earned points. A tie is settled by compareStandings, so the winner is the same every time.
export function seasonWinners(rows) {
  const [first] = [...rows].sort(compareStandings)
  return first && first.seasonPoints > 0 ? [first.id] : []
}

// The last day of a season, for "Ends 31 Dec": the day that holds its last moment. A season ended early in the
// demo ends part-way through a day, so subtracting a whole day would name the day before.
export function lastDay(season) {
  return new Date(season.endsAt - 1)
}

// How long the season has left, in words: "Ends in 84 days", "Ends tomorrow", "Ends today".
export function endsInText(season, now = new Date()) {
  const days = differenceInCalendarDays(lastDay(season), now)
  if (days <= 0) return 'Ends today'
  if (days === 1) return 'Ends tomorrow'
  return `Ends in ${days} days`
}

// "1 Oct to 31 Dec"
export function seasonRange(season) {
  return `${format(new Date(season.startsAt), 'd MMM')} to ${format(lastDay(season), 'd MMM')}`
}
