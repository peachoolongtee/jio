// Session helpers shared by the screens: where a session opens, its date line and each person's status.
import { addDays, differenceInCalendarDays, format, isValid, parseISO } from 'date-fns'

// ── Singapore's clock ──────────────────────────────────────────────────────
// A session's date and times are Singapore local time (UTC+8, no daylight saving), whatever time zone the browser is in, so every
// "now" that is compared with them is read on Singapore's clock through these helpers and never through `getHours` or `format(now)`.
const DATE_PARTS = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' })
const TIME_PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

// The calendar date in Singapore at an instant, as yyyy-MM-dd.
// How to call: singaporeDate(new Date('2026-10-17T16:30:00Z')) -> '2026-10-18'
export function singaporeDate(now = new Date()) {
  const parts = Object.fromEntries(DATE_PARTS.formatToParts(now).map(({ type, value }) => [type, value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

// Are photos open for an outing? From its Singapore day on, for every member, and not before. The demo's session-day switch
// (`isToday`) counts today as the day, as it does for the countdown. A session with no date is not open.
// How to call: photosOpen({ date: '2026-10-17' }, new Date('2026-10-16T16:30:00Z')) -> true (it is the 17th in Singapore)
export function photosOpen(session, now = new Date()) {
  const today = singaporeDate(now)
  const day = session?.isToday ? today : session?.date
  return !!day && day <= today
}

// The words for adding a photo before the outing's day. How to call: throw new Error(PHOTOS_BEFORE_DAY)
export const PHOTOS_BEFORE_DAY = 'Photos open on the day of the outing.'

// The time of day in Singapore at an instant, as HH:mm.
// How to call: singaporeTime(new Date('2026-10-17T08:30:00Z')) -> '16:30'
export function singaporeTime(now = new Date()) {
  return TIME_PARTS.format(now)
}

// The minutes since midnight in Singapore at an instant.
// How to call: singaporeMinutes(new Date('2026-10-17T08:30:00Z')) -> 990
export function singaporeMinutes(now = new Date()) {
  const [hours, minutes] = singaporeTime(now).split(':').map(Number)
  return hours * 60 + minutes
}

// An instant as Singapore's wall clock says it, for a line of text: "Mon 12 Oct, 20:00".
// How to call: singaporeDayTime(new Date('2026-10-12T12:00:00Z')) -> 'Mon 12 Oct, 20:00'
export function singaporeDayTime(at) {
  return `${format(parseISO(singaporeDate(at)), 'EEE d MMM')}, ${singaporeTime(at)}`
}

// The instant a Singapore date and time fall on, or null when either is missing or not a real moment.
// How to call: singaporeInstant('2026-10-17', '16:30') -> the same instant as new Date('2026-10-17T08:30:00Z')
export function singaporeInstant(date, time) {
  if (!date || !time) return null
  const at = new Date(`${date}T${time}:00+08:00`)
  // The date is read back, because the engine rolls a 30 February over to March instead of refusing it.
  return isValid(at) && singaporeDate(at) === date ? at : null
}

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

// A session pauses when fewer than 2 people are left before it ends. A light meetup (Roam from Home) never does: one
// person out on their own is how it starts, and inviting friends is optional.
export function isPaused(session) {
  return !session.light && ['locating', 'voting', 'confirmed'].includes(session.status) && session.activeIds.length < 2
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
// "not enough people" notice links to the invite page), or for a light meetup at any time. Once the plan is confirmed with enough people, or the session is
// over, it is closed: the page shows who is in and says so.
// How to call: inviteAccess({ status: 'voting', activeIds: ['ian', 'faith'] }, true) -> { open: true, text: '' }
export function inviteAccess(session, mine, hostName = 'the host') {
  const closed = (text) => ({ open: false, text })
  if (session.status === 'completed') return closed('The outing is over, so invites are closed.')
  if (session.status === 'cancelled') return closed('The outing was cancelled, so invites are closed.')
  // A light meetup is under way from the start, and its host may bring friends along at any time.
  if (session.status === 'confirmed' && !session.light && !isPaused(session)) return closed('The plan is confirmed, so invites are closed.')
  if (!mine) return closed(`Only ${hostName} can invite people.`)
  return { open: true, text: '' }
}

// Whether a person is in the session or waiting on an invite to it (joined or invited), which no screen offers again.
// How to call: isInOrInvited({ members: [{ id: 'faith', state: 'joined' }] }, 'faith') -> true
export function isInOrInvited(session, personId) {
  return !!session?.members?.some((m) => m.id === personId && ['joined', 'invited'].includes(m.state))
}

// Whether the host can still invite a person to this session by name. For a demo or local session that is anyone not in it or
// waiting on an invite. For a shared one the database keeps one invitation per person per session, and refuses a person who has
// any member row (an opted-out one too), so it is also no one who has any row in `members` or whose invitation by name exists in
// any state (`namedInvites`: waiting, taken back, declined or used). Those people can still come in with the session's link.
// How to call: canInviteByName({ remote: true, members: [], namedInvites: ['kim'] }, 'kim') -> false
export function canInviteByName(session, personId) {
  if (isInOrInvited(session, personId)) return false
  if (!session?.remote) return true
  return !session.members.some((m) => m.id === personId) && !(session.namedInvites || []).includes(personId)
}

// What the itinerary's main button does. 'finish' on the session's day for a confirmed plan (it completes the outing and
// pays out the coins), and after it for a shared one (`pastDay`: nothing finishes a shared outing by itself, so the host can, from its day
// on); 'save' before the day (it only goes Home: the plan was saved when it was confirmed); null for a session that is not confirmed
// (voting, completed or cancelled).
// How to call: itineraryAction({ status: 'confirmed', isToday: false }) -> 'save'
export function itineraryAction(session) {
  if (!session || session.status !== 'confirmed') return null
  return session.isToday || session.pastDay ? 'finish' : 'save'
}

// When the session starts, relative to now: "Starts in 50 min", "Starts in 3 h", "Tomorrow", "In 5 days",
// "Live now" during the time window and "Ended" after it. Null for completed or cancelled sessions.
// `isToday` (the demo's session-day switch) moves the session to today's date.
export function startsIn(session, now = new Date()) {
  if (!session?.date || ['completed', 'cancelled'].includes(session.status)) return null
  const day = session.isToday ? singaporeDate(now) : session.date
  const start = singaporeInstant(day, session.start)
  const end = singaporeInstant(day, session.end)
  if (!start || !end) return null
  const minutes = Math.round((start - now) / 60000)
  if (now >= end) return { text: 'Ended', tone: 'muted' }
  if (now >= start) return { text: 'Live now', tone: 'live' }
  if (minutes < 60) return { text: `Starts in ${Math.max(1, minutes)} min`, tone: 'soon' }
  if (minutes < 12 * 60) return { text: `Starts in ${Math.round(minutes / 60)} h`, tone: 'soon' }
  // Whole days between two Singapore calendar dates.
  const days = differenceInCalendarDays(parseISO(day), parseISO(singaporeDate(now)))
  if (days <= 0) return { text: `Today, ${session.start}`, tone: 'soon' }
  if (days === 1) return { text: `Tomorrow, ${session.start}`, tone: 'later' }
  return { text: `In ${days} days`, tone: 'later' }
}

// How long after its end time an outing that never got a confirmed plan stays open before it closes by itself.
export const CLOSE_AFTER_MS = 2 * 24 * 60 * 60 * 1000

// The moment a session's time window closes, in Singapore time, from its own date (the demo's session-day switch does not move it),
// or null when the date or end time is missing. How to call: sessionEnd({ date: '2026-10-10', end: '21:00' }) -> Date
export function sessionEnd(session) {
  return singaporeInstant(session?.date, session?.end)
}

// What should happen now to a session whose end time has passed. 'finish': a confirmed plan finishes by itself, and pays
// out its coins as "Finish outing" does. 'close': a session with no confirmed plan, two days past its end, is completed
// with no coins. null: nothing yet, and never anything for a completed or cancelled session, or for a demo session built to
// stay as it is (keepOpen, set by the showcase and the tour: their times are fixed when they are loaded, whatever the hour).
// How to call: dueEnding({ status: 'confirmed', date: '2026-10-10', end: '21:00' }, new Date('2026-10-10T21:05:00+08:00')) -> 'finish'
export function dueEnding(session, now = new Date()) {
  // A shared outing is finished by its host (POST /complete), never by a browser's clock: there is no sweep on the server yet.
  if (!session || session.keepOpen || session.remote || ['completed', 'cancelled'].includes(session.status)) return null
  const end = sessionEnd(session)
  if (!end || now < end) return null
  if (session.status === 'confirmed') return 'finish'
  return now - end >= CLOSE_AFTER_MS ? 'close' : null
}

// A session past its end time that has not been completed, which Home reminds the group about, with when it closes by
// itself: { closesAt }, or null. A confirmed plan past its end is included until the next read finishes it. A shared outing closes by no
// clock (its host finishes it, or cancels it), so its `closesAt` is null.
// How to call: overdueOuting({ status: 'voting', date: '2026-10-10', end: '21:00' }, now) -> { closesAt: Date }
export function overdueOuting(session, now = new Date()) {
  if (!session || session.keepOpen || ['completed', 'cancelled'].includes(session.status)) return null
  const end = sessionEnd(session)
  if (!end || now < end) return null
  return { closesAt: session.remote ? null : new Date(end.getTime() + CLOSE_AFTER_MS) }
}

// Is the plan under way, so that people can ask "What next?" and propose places? Yes for a confirmed plan on the session's
// day, which is the same moment the itinerary's main button becomes "Finish outing".
// How to call: roamOpen({ status: 'confirmed', isToday: true }) -> true
export function roamOpen(session) {
  return session?.status === 'confirmed' && !!session.isToday
}

// The Locate page's main button once the meeting spot is confirmed: named for where it goes, never a bare "Next".
// While the group votes it opens the Vote page; once the plan is confirmed, the plan itself (titled for today on the day).
// How to call: locateNext({ id: 's1', status: 'voting' }) -> { label: 'Choose places', to: '/sessions/s1/plan' }
export function locateNext(session) {
  if (session.status === 'voting') return { label: 'Choose places', to: `/sessions/${session.id}/plan` }
  const label = session.status === 'confirmed' && session.isToday ? "Today's plan" : 'See the plan'
  return { label, to: `/sessions/${session.id}/itinerary` }
}

// The fewest people an outing needs to earn JioCoins when it finishes. One person out alone starts a light meetup from Home,
// which would otherwise be a way to earn coins again and again.
export const EARN_MIN_PEOPLE = 2

// What is said when an outing of one person pays nothing: in the Finish outing dialog (before), in the toast after it, and in the
// notice on a finished outing's page (done, which is also what an outing that finished by itself shows).
export const NO_COINS = {
  before: 'Outings with friends earn JioCoins. This one is just you, so it earns none.',
  toast: 'No JioCoins for an outing of one. Outings with friends earn them.',
  done: 'This outing was just you, so it earned no JioCoins. Outings with friends earn them.',
}

// Does an outing with this many people in it earn coins when it finishes?
// How to call: earnsCoins(1) -> false, earnsCoins(2) -> true
export const earnsCoins = (people) => people >= EARN_MIN_PEOPLE

// The times a new session's form starts with: the next round hour in Singapore, and three hours after it (no later than 23:59).
// After 23:00 the next round hour is midnight, for an outing on a later day.
// How to call: defaultTimes(new Date('2026-10-17T14:20:00+08:00')) -> { start: '15:00', end: '18:00' }
export function defaultTimes(now = new Date()) {
  const hour = (Math.floor(singaporeMinutes(now) / 60) + 1) % 24
  const pad = (n) => String(n).padStart(2, '0')
  const endMinutes = Math.min((hour + 3) * 60, 23 * 60 + 59)
  return { start: `${pad(hour)}:00`, end: `${pad(Math.floor(endMinutes / 60))}:${pad(endMinutes % 60)}` }
}

// The day a new session's form starts with: nothing (the person picks), except late at night in Singapore, when the default start
// is after midnight and so belongs to tomorrow. A form that left the day empty there would let someone pick today and get an
// outing that began hours ago. Returns a yyyy-MM-dd string or ''.
// How to call: defaultDate(new Date('2026-10-17T23:30:00+08:00')) -> '2026-10-18'
export function defaultDate(now = new Date()) {
  return Math.floor(singaporeMinutes(now) / 60) === 23 ? format(addDays(parseISO(singaporeDate(now)), 1), 'yyyy-MM-dd') : ''
}

// Has this end time already passed on this day? The create form refuses such a window for today, as it would be over before
// it began. Only today can be past: any later day is not.
// How to call: endHasPassed('2026-10-17', '15:00', new Date('2026-10-17T16:00:00+08:00')) -> true
export function endHasPassed(date, end, now = new Date()) {
  if (!date || !end || date !== singaporeDate(now)) return false
  return end <= singaporeTime(now)
}

// Is a proposed start time already in the past in Singapore? A session may start later today, but not earlier.
// How to call: startHasPassed('2026-10-17', '16:00', new Date('2026-10-17T08:30:00Z')) -> true
export function startHasPassed(date, start, now = new Date()) {
  if (!date || !start || date !== singaporeDate(now)) return false
  return start <= singaporeTime(now)
}

// The create form's implicit six-hour end, capped at 23:59. A start at 23:59 therefore has no positive-length window.
// How to call: defaultSessionEnd('15:00') -> '21:00'
export function defaultSessionEnd(start, end = '', duration = 360) {
  if (end || !start) return end
  const [hours, minutes] = start.split(':').map(Number)
  const total = Math.min(hours * 60 + minutes + duration, 23 * 60 + 59)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
