// The Sessions list on your own profile, by time: All, Upcoming or Completed (UAT of 29 October 2026, item 2). People look
// for what is next, not for the app's stages, so there is no filter by status (locating, voting and so on).
//   Upcoming   every session still going (not completed or cancelled), soonest first, with a live one pinned at the top
//   Completed  the finished outings, the latest first
//   All        Upcoming, then Completed, then the cancelled ones, the latest first
// Pure functions over plain session summaries (lib/api.js), so they are tested without a browser.
import { activeMeetups, dayOf } from './homeMeetups.js'
import { startsIn } from './session.js'

// The chips, in the order they are shown.
export const SESSION_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'completed', label: 'Completed' },
]

// The words under the chips when a filter has nothing in it.
export const EMPTY_TEXT = { all: 'No meetups yet', upcoming: 'Nothing coming up', completed: 'No finished meetups yet' }

// Latest first: by day, then start time, then id, so the order never shuffles between loads.
// How to call: [...sessions].sort(latestFirst(new Date()))
const latestFirst = (now) => (a, b) =>
  (dayOf(b, now) || '').localeCompare(dayOf(a, now) || '') ||
  (b.start || '').localeCompare(a.start || '') ||
  String(b.id).localeCompare(String(a.id), undefined, { numeric: true })

// The sessions still going, soonest first, with the ones live now (inside their time window today) moved to the top.
// How to call: upcomingSessions(events.sessions) -> [live, soonest, ..., latest]
export function upcomingSessions(sessions, now = new Date()) {
  const active = activeMeetups(sessions, now)
  const live = active.filter((s) => startsIn(s, now)?.tone === 'live')
  return [...live, ...active.filter((s) => !live.includes(s))]
}

// The sessions one chip shows, in its order. An unknown filter is All.
// How to call: profileSessions(events.sessions, 'upcoming') -> [live, soonest, ...]
export function profileSessions(sessions, filter = 'all', now = new Date()) {
  const list = sessions || []
  const upcoming = upcomingSessions(list, now)
  const completed = list.filter((s) => s.status === 'completed').sort(latestFirst(now))
  if (filter === 'upcoming') return upcoming
  if (filter === 'completed') return completed
  const cancelled = list.filter((s) => s.status === 'cancelled').sort(latestFirst(now))
  return [...upcoming, ...completed, ...cancelled]
}
