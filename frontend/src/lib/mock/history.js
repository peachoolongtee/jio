// Past meetup dates for the profile activity graph. Mock data, generated the same way every time
// for a person (seeded by their id), spread over the last 26 weeks and leaning towards weekends.
import { format, subDays } from 'date-fns'

function seeded(text) {
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

// `count` meetup dates (yyyy-MM-dd, oldest first) in the 182 days before `today`.
export function pastMeetupDates(personId, count, today = new Date()) {
  const random = seeded(personId)
  const dates = []
  let guard = 0
  while (dates.length < count && guard < 5000) {
    guard += 1
    const day = subDays(today, 1 + Math.floor(random() * 182))
    if (random() < WEEKDAY_WEIGHT[day.getDay()] * 3) dates.push(format(day, 'yyyy-MM-dd'))
  }
  return dates.sort()
}
