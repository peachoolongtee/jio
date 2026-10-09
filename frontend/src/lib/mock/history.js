// Past meetup dates for the profile activity graph. Mock data, generated the same way every time
// for a person (seeded by their id), spread over the last 26 weeks and leaning towards weekends.
import { differenceInCalendarDays, format, startOfQuarter, subDays } from 'date-fns'

// A random number generator that gives the same sequence every time for the same text.
export function seeded(text) {
  let h = 2166136261
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

// Day of the week weights, Sunday first: friends mostly meet on Fridays and weekends.
const WEEKDAY_WEIGHT = [0.25, 0.05, 0.05, 0.06, 0.08, 0.18, 0.33]

// `count` meetup dates (yyyy-MM-dd, oldest first) in the 182 days before `today`. Exactly `thisSeason` of them fall
// in the current leaderboard season (the calendar quarter `today` is in, up to yesterday) and `lastSeason` in the
// quarter before it; the rest come before that. On a season's first day there is no yesterday in it yet, so its
// meetups are dated today.
export function pastMeetupDates(personId, count, today = new Date(), thisSeason = 0, lastSeason = 0) {
  const random = seeded(personId)
  const seasonStart = startOfQuarter(today)
  const intoSeason = differenceInCalendarDays(today, seasonStart)
  const recent = Math.min(thisSeason, count)
  const dates = []
  for (let i = 0; i < recent; i++) {
    const day = intoSeason > 0 ? subDays(today, 1 + Math.floor(random() * intoSeason)) : today
    dates.push(format(day, 'yyyy-MM-dd'))
  }
  // Last season: any day of the previous quarter, so its count is exact.
  const lastSpan = differenceInCalendarDays(seasonStart, startOfQuarter(subDays(seasonStart, 1)))
  const previous = Math.min(lastSeason, count - recent)
  for (let i = 0; i < previous; i++) dates.push(format(subDays(seasonStart, 1 + Math.floor(random() * lastSpan)), 'yyyy-MM-dd'))
  // The rest: before last season when it was asked for, otherwise anywhere before this one.
  const before = subDays(seasonStart, lastSeason ? lastSpan : 0)
  const span = Math.max(1, 182 - differenceInCalendarDays(today, before))
  let guard = 0
  while (dates.length < count && guard < 5000) {
    guard += 1
    const day = subDays(before, 1 + Math.floor(random() * span))
    if (random() < WEEKDAY_WEIGHT[day.getDay()] * 3) dates.push(format(day, 'yyyy-MM-dd'))
  }
  return dates.sort()
}
