// clash.js: the rule that one person cannot be in two meetups at the same time.
// A meetup counts while it is still ahead or under way (not finished or cancelled), and only when the person has joined it.
// Two meetups on the same day clash when their times overlap; one that ends when the next starts does not.
// The database holds the same rule (db/migrations/20261028000000_jio_no_clashing_meetups.sql), so this file is the early,
// friendly answer and the database is the one that cannot be skipped.

// The states of a session in which its time is still held for the people in it.
export const HOLDING = ['inviting', 'locating', 'voting', 'confirmed']

// What the person sees when a time is taken. `clash` is the meetup in the way: { id, title, date, start, end }.
// How to call: throw new ClashError({ id: 's1', title: 'Dinner', date: '2026-10-28', start: '19:00', end: '21:00' })
export class ClashError extends Error {
  constructor(clash) {
    super(`You already have "${clash.title}" at that time.`)
    this.name = 'ClashError'
    this.code = 'schedule_clash'
    this.clash = clash
  }
}

// "HH:MM" to minutes, so times compare as numbers. How to call: minutesOf('19:30') -> 1170
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

// Whether two times of one day overlap. Back to back is fine. How to call: overlaps('18:00', '20:00', '20:00', '22:00') -> false
export function overlaps(startA, endA, startB, endB) {
  return minutesOf(startA) < minutesOf(endB) && minutesOf(startB) < minutesOf(endA)
}

// The first meetup of `sessions` that the person is in and that overlaps the given time, or null. `sessions` are as the data layer
// lists them (date, start, end, status, members). `excludeId` leaves out the meetup being edited. The demo's own sessions
// (keepOpen) are never in the way, so loading the showcase does not block a real plan.
// How to call: findClash(sessions, { me: 'faith', date: '2026-10-28', start: '19:00', end: '21:00' }) -> { id, title, date, start, end } or null
export function findClash(sessions, { me, date, start, end, excludeId = null }) {
  const found = (sessions || []).find(
    (s) =>
      s.id !== excludeId &&
      !s.keepOpen &&
      HOLDING.includes(s.status) &&
      s.date === date &&
      (s.members || []).some((m) => m.id === me && m.state === 'joined') &&
      overlaps(s.start, s.end, start, end),
  )
  return found ? { id: found.id, title: found.title, date: found.date, start: found.start, end: found.end } : null
}
