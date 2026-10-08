// Leaderboard seasons. The leaderboard runs for three months at a time, following the calendar quarters
// (January to March, April to June, ...).
//
// Rules
// - The ranking is by points earned this season: every meetup you finish earns 100.
// - When the season ends, whoever is first wins SEASON_PRIZE points to spend on café discounts.
//   A tie for first: everyone tied wins. Nobody wins a season in which nobody earned points.
// - Then season points start again from 0. Points you can spend are kept.
import { addMonths, differenceInCalendarDays, format, startOfQuarter, subDays } from 'date-fns'

export const SEASON_MONTHS = 3
export const SEASON_PRIZE = 500

// The season a date falls in: the calendar quarter, as timestamps. `endsAt` is the first moment after it.
export function quarterOf(date) {
  const start = startOfQuarter(date)
  return { startsAt: start.getTime(), endsAt: addMonths(start, SEASON_MONTHS).getTime() }
}

// The season after one that ended at `at`: three months from then.
export function nextSeason(previous, at) {
  return { number: previous.number + 1, startsAt: at, endsAt: addMonths(new Date(at), SEASON_MONTHS).getTime() }
}

// rows: [{ id, seasonPoints }]. The ids that finish first, or [] when nobody earned points.
export function seasonWinners(rows) {
  const top = Math.max(0, ...rows.map((r) => r.seasonPoints))
  if (top === 0) return []
  return rows.filter((r) => r.seasonPoints === top).map((r) => r.id)
}

// The last day of a season, for "Ends 31 Dec".
export function lastDay(season) {
  return subDays(new Date(season.endsAt), 1)
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
