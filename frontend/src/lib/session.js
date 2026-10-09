// Session helpers shared by the screens: where a session opens, its date line and each person's status.
import { format, parseISO } from 'date-fns'

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

export const STATUS_TONE = { Joined: 'neutral', 'Location submitted': 'lagoon', Voted: 'lagoon', 'Opted out': 'error' }

// A session pauses when fewer than 2 people are left before it ends.
export function isPaused(session) {
  return ['locating', 'voting', 'confirmed'].includes(session.status) && session.activeIds.length < 2
}
