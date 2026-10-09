// Session helpers shared by the screens: where a session opens, its date line and each person's status.
import { differenceInCalendarDays, format, parseISO } from 'date-fns'

// The screen a session card opens, by status.
export function sessionPath(session) {
  if (session.status === 'voting') return `/sessions/${session.id}/plan`
  if (session.status === 'confirmed' || session.status === 'completed') return `/sessions/${session.id}/itinerary`
  return `/sessions/${session.id}`
}

// "Sat 10 Oct · 15:00 to 21:00"
export function dateLine(session) {
  const day = session.date ? format(parseISO(session.date), 'EEE d MMM') : ''
  return `${day} · ${session.start} to ${session.end}`
}

// A person's submission status: Joined, Location submitted, Voted, Opted out.
export function submissionStatus(session, personId, voterIds = []) {
  const member = session.members.find((m) => m.id === personId)
  if (!member) return ''
  if (member.state === 'opted_out') return 'Opted out'
  if (voterIds.includes(personId)) return 'Voted'
  if (session.locations?.[personId]?.start) return 'Location submitted'
  return 'Joined'
}

export const STATUS_TONE = { Joined: 'neutral', 'Location submitted': 'strong', Voted: 'strong', 'Opted out': 'error' }

// A session pauses when fewer than 2 people are left before it ends.
export function isPaused(session) {
  return ['locating', 'voting', 'confirmed'].includes(session.status) && session.activeIds.length < 2
}

// When the session starts, relative to now: "Starts in 50 min", "Starts in 3 h", "Tomorrow", "In 5 days",
// "Live now" during the time window and "Ended" after it. Null for completed or cancelled sessions.
// `isToday` (the demo's session-day switch) moves the session to today's date.
export function startsIn(session, now = new Date()) {
  if (!session?.date || ['completed', 'cancelled'].includes(session.status)) return null
  const day = session.isToday ? format(now, 'yyyy-MM-dd') : session.date
  const start = parseISO(`${day}T${session.start}`)
  const end = parseISO(`${day}T${session.end}`)
  const minutes = Math.round((start - now) / 60000)
  if (now >= end) return { text: 'Ended', tone: 'muted' }
  if (now >= start) return { text: 'Live now', tone: 'live' }
  if (minutes < 60) return { text: `Starts in ${Math.max(1, minutes)} min`, tone: 'soon' }
  if (minutes < 12 * 60) return { text: `Starts in ${Math.round(minutes / 60)} h`, tone: 'soon' }
  const days = differenceInCalendarDays(start, now)
  if (days <= 0) return { text: `Today, ${session.start}`, tone: 'soon' }
  if (days === 1) return { text: `Tomorrow, ${session.start}`, tone: 'later' }
  return { text: `In ${days} days`, tone: 'later' }
}
