// Session helpers shared by the screens: where a session opens, its date line and each person's status.
import { differenceInCalendarDays, format, isValid, parseISO } from 'date-fns'

// The screen a session card opens, by status. A completed session with no plan (it closed by itself, two days past its end
// with no plan confirmed) opens its own page, as there is no itinerary to show.
export function sessionPath(session) {
  if (session.status === 'voting') return `/sessions/${session.id}/plan`
  if (session.status === 'confirmed' || (session.status === 'completed' && session.plan)) return `/sessions/${session.id}/itinerary`
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

// The words for calling an outing off, written once so the hold button in the header, its dialog and the "not enough
// people" notice say the same thing. The status pill still says "Cancelled".
export const CANCEL_OUTING = {
  hold: 'Hold to cancel',
  action: 'Cancel outing',
  title: 'Cancel outing?',
  text: 'The outing is cancelled for everyone in it and moves to your past sessions. This cannot be undone.',
  keep: 'Keep outing',
  confirm: 'Cancel outing',
}

// May this person invite people to this session now, and if not, what to tell them. Only the host invites. It is open
// while the session is inviting, locating or voting, and for a confirmed plan only when too few people are left (the
// "not enough people" notice links to the invite page). Once the plan is confirmed with enough people, or the session is
// over, it is closed: the page shows who is in and says so.
// How to call: inviteAccess({ status: 'voting', activeIds: ['ian', 'faith'] }, true) -> { open: true, text: '' }
export function inviteAccess(session, mine, hostName = 'the host') {
  const closed = (text) => ({ open: false, text })
  if (session.status === 'completed') return closed('The outing is over, so invites are closed.')
  if (session.status === 'cancelled') return closed('The outing was cancelled, so invites are closed.')
  if (session.status === 'confirmed' && !isPaused(session)) return closed('The plan is confirmed, so invites are closed.')
  if (!mine) return closed(`Only ${hostName} can invite people.`)
  return { open: true, text: '' }
}

// What the itinerary's main button does. 'finish' on the session's day for a confirmed plan (it completes the outing and
// pays out the coins); 'save' before the day (it only goes Home: the plan was saved when it was confirmed); null for a
// session that is not confirmed (voting, completed or cancelled).
// How to call: itineraryAction({ status: 'confirmed', isToday: false }) -> 'save'
export function itineraryAction(session) {
  if (!session || session.status !== 'confirmed') return null
  return session.isToday ? 'finish' : 'save'
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

// How long after its end time an outing that never got a confirmed plan stays open before it closes by itself.
export const CLOSE_AFTER_MS = 2 * 24 * 60 * 60 * 1000

// The moment a session's time window closes, from its own date (the demo's session-day switch does not move it), or null
// when the date or end time is missing. How to call: sessionEnd({ date: '2026-10-10', end: '21:00' }) -> Date
export function sessionEnd(session) {
  if (!session?.date || !session.end) return null
  const end = parseISO(`${session.date}T${session.end}`)
  return isValid(end) ? end : null
}

// What should happen now to a session whose end time has passed. 'finish': a confirmed plan finishes by itself, and pays
// out its coins as "Finish outing" does. 'close': a session with no confirmed plan, two days past its end, is completed
// with no coins. null: nothing yet, and never anything for a completed or cancelled session.
// How to call: dueEnding({ status: 'confirmed', date: '2026-10-10', end: '21:00' }, new Date('2026-10-10T21:05')) -> 'finish'
export function dueEnding(session, now = new Date()) {
  if (!session || ['completed', 'cancelled'].includes(session.status)) return null
  const end = sessionEnd(session)
  if (!end || now < end) return null
  if (session.status === 'confirmed') return 'finish'
  return now - end >= CLOSE_AFTER_MS ? 'close' : null
}

// A session past its end time that has not been completed, which Home reminds the group about, with when it closes by
// itself: { closesAt }, or null. A confirmed plan past its end is included until the next read finishes it.
// How to call: overdueOuting({ status: 'voting', date: '2026-10-10', end: '21:00' }, now) -> { closesAt: Date }
export function overdueOuting(session, now = new Date()) {
  if (!session || ['completed', 'cancelled'].includes(session.status)) return null
  const end = sessionEnd(session)
  if (!end || now < end) return null
  return { closesAt: new Date(end.getTime() + CLOSE_AFTER_MS) }
}

// Is the plan under way, so that people can ask "What next?" and propose places? Yes for a confirmed plan on the session's
// day, which is the same moment the itinerary's main button becomes "Finish outing".
// How to call: roamOpen({ status: 'confirmed', isToday: true }) -> true
export function roamOpen(session) {
  return itineraryAction(session) === 'finish'
}

// The Locate page's main button once the meeting spot is confirmed: named for where it goes, never a bare "Next".
// While the group votes it opens the Vote page; once the plan is confirmed, the plan itself (titled for today on the day).
// How to call: locateNext({ id: 's1', status: 'voting' }) -> { label: 'Choose places', to: '/sessions/s1/plan' }
export function locateNext(session) {
  if (session.status === 'voting') return { label: 'Choose places', to: `/sessions/${session.id}/plan` }
  const label = session.status === 'confirmed' && session.isToday ? "Today's plan" : 'See the plan'
  return { label, to: `/sessions/${session.id}/itinerary` }
}

// The times a new session's form starts with: the next round hour, and three hours after it (no later than 23:59).
// After 23:00 the next round hour is midnight, for an outing on a later day.
// How to call: defaultTimes(new Date('2026-10-17T14:20')) -> { start: '15:00', end: '18:00' }
export function defaultTimes(now = new Date()) {
  const hour = (now.getHours() + 1) % 24
  const pad = (n) => String(n).padStart(2, '0')
  const endMinutes = Math.min((hour + 3) * 60, 23 * 60 + 59)
  return { start: `${pad(hour)}:00`, end: `${pad(Math.floor(endMinutes / 60))}:${pad(endMinutes % 60)}` }
}
