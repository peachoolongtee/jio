// Everything Home decides about the meetups going now that needs no screen: which are current and in what order,
// what each one needs from the signed-in person, where it stands, where its pin goes, and which one is selected.
// All of it takes plain session summaries (lib/api.js), so it is tested without a browser.
import { differenceInCalendarDays, format, isValid, parseISO } from 'date-fns'
import { proposalsOf } from './roam.js'
import { isPaused, sessionPath } from './session.js'

// How far apart, in px, pins that share a meeting area are drawn, so each one can still be tapped (a pin is 48px
// wide). They fan out sideways around the area, centred on it.
export const FAN_PX = 46

const FINISHED = ['completed', 'cancelled']

// The day a meetup falls on. The demo's session-day switch (isToday) moves it to today, as it does for the countdown.
// How to call: dayOf({ date: '2026-10-10' }, new Date()) -> '2026-10-10'
export function dayOf(session, now) {
  return session.isToday ? format(now, 'yyyy-MM-dd') : session.date || ''
}

// A missing date or time sorts after one that is there.
const byText = (a, b) => (a === b ? 0 : !a ? 1 : !b ? -1 : a < b ? -1 : 1)

// The meetups still going (not completed or cancelled), soonest first: by day, then start time, then the one made
// earlier, then by id, so the order never shuffles between loads.
// How to call: activeMeetups(events.sessions) -> [soonest, ..., latest]
export function activeMeetups(sessions, now = new Date()) {
  return (sessions || [])
    .filter((s) => !FINISHED.includes(s.status))
    .sort(
      (a, b) =>
        byText(dayOf(a, now), dayOf(b, now)) ||
        byText(a.start, b.start) ||
        (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
        String(a.id).localeCompare(String(b.id), undefined, { numeric: true }),
    )
}

// The meetup Home shows: the one named by the URL, otherwise the soonest. An id that is not there (or two ids, as a
// hand-edited address can give) falls back to the soonest without complaint.
// How to call: selectMeetup(meetups, route.query.meetup) -> a meetup, or null when there are none
export function selectMeetup(meetups, id) {
  const wanted = Array.isArray(id) ? id[0] : id
  return meetups.find((m) => m.id === wanted) || meetups[0] || null
}

// The short word on a pin: "Today", a weekday inside the coming week ("Sat"), otherwise the date ("24 Oct").
// How to call: dayLabel({ date: '2026-10-10' }, new Date()) -> 'Today'
export function dayLabel(session, now = new Date()) {
  const day = parseISO(dayOf(session, now))
  if (!isValid(day)) return ''
  const away = differenceInCalendarDays(day, now)
  if (away === 0) return 'Today'
  return away > 0 && away < 7 ? format(day, 'EEE') : format(day, 'd MMM')
}

// "Sat 10 Oct · 15:00", with whatever part is missing left out.
// How to call: whenLine({ date: '2026-10-10', start: '15:00' }) -> 'Sat 10 Oct · 15:00'
export function whenLine(session, now = new Date()) {
  const day = parseISO(dayOf(session, now))
  return [isValid(day) ? format(day, 'EEE d MMM') : '', session.start || ''].filter(Boolean).join(' · ')
}

const sharedStarts = (session) => (session.activeIds || []).filter((id) => session.locations?.[id]?.start).length

// While the group is choosing where to meet, the spots listed (empty otherwise) and the one that leads: the spot the most
// people said works for them (session.spots.preselectedAreaId), or null while nobody has said.
// How to call: leadingSpot(session) -> { areaId: 'bugis', area: { name: 'Bugis' }, approvalCount: 2, ... }, or null
export function leadingSpot(session) {
  if (session.status !== 'locating') return null
  const lead = (session.spots?.list || []).find((s) => s.areaId === session.spots.preselectedAreaId)
  return lead && lead.approvalCount > 0 ? lead : null
}

// The place a meetup row names: the meeting point, or while the group is still choosing, the spot that leads, otherwise
// that the group is choosing (the planner's fairest area is only a spot among others until the host confirms one).
// How to call: placeText(session) -> 'Bugis', or 'choosing a spot', or 'no meeting point yet'
export function placeText(session) {
  if (session.status === 'locating' && session.spots?.list?.length) return leadingSpot(session)?.area.name || 'choosing a spot'
  return session.area ? session.area.name : 'no meeting point yet'
}

// Where a meetup stands, for the detail card and the rows. kind: 'area' (a meeting point), 'spots' (the group is choosing
// among spots: the one that leads, or how many there are), 'finding' (the planner is working), 'waiting' (locations still
// coming in) or 'none' (nothing to say yet). `note` is what follows the name.
// How to call: whereStands(session, 'ian') -> { kind: 'area', text: 'Bugis · about 25 min for you', areaName: 'Bugis', minutes: 25, note: 'about 25 min for you' }
export function whereStands(session, myId) {
  if (session.status === 'locating' && session.spots?.list?.length) {
    const lead = leadingSpot(session)
    if (lead) {
      const minutes = lead.times?.[myId] || null
      const note = minutes ? `is leading · about ${minutes} min for you` : 'is leading'
      return { kind: 'spots', text: `${lead.area.name} ${note}`, areaName: lead.area.name, minutes, note }
    }
    const n = session.spots.list.length
    const text = `${n} ${n === 1 ? 'spot' : 'spots'} to choose from`
    return { kind: 'spots', text, areaName: '', minutes: null, note: '' }
  }
  if (session.area) {
    const minutes = session.meeting?.times?.[myId] || null
    const name = session.area.name
    return { kind: 'area', text: minutes ? `${name} · about ${minutes} min for you` : name, areaName: name, minutes, note: minutes ? `about ${minutes} min for you` : '' }
  }
  if (session.findingMeeting) return { kind: 'finding', text: 'Finding the fairest midpoint…', areaName: '', minutes: null }
  if (session.status === 'locating') {
    const text = `No meeting point yet · ${sharedStarts(session)} of ${(session.activeIds || []).length} locations shared`
    return { kind: 'waiting', text, areaName: '', minutes: null }
  }
  return { kind: 'none', text: 'No meeting point yet', areaName: '', minutes: null }
}

// The one thing a meetup needs from this person, and where to go to do it. tone: 'action' (it is on you), 'wait'
// (it is on someone else) or 'done' (nothing to do). `to` opens the meetup at the step it is on.
// How to call: nextStepFor(session, 'ian') -> { label: 'Share your start', tone: 'action', to: '/sessions/s3' }
export function nextStepFor(session, myId) {
  const to = sessionPath(session)
  const step = (label, tone) => ({ label, tone, to })
  const isHost = session.hostId === myId
  const active = session.activeIds || []

  if (session.status === 'inviting') {
    if (!isHost) return step('Waiting for the host', 'wait')
    if (active.length < 2) {
      const waiting = (session.members || []).some((m) => m.state === 'invited')
      return waiting ? step('Waiting for friends', 'wait') : step('Invite friends', 'action')
    }
    return step('Start session', 'action')
  }
  // Someone left and fewer than two are in: the group needs people before anything else.
  if (isPaused(session)) return isHost ? step('Invite friends', 'action') : step('Waiting for the host', 'wait')

  if (session.status === 'locating') {
    if (!session.locations?.[myId]?.start) return step('Share your start', 'action')
    if (session.findingMeeting) return step('Finding the midpoint', 'wait')
    // Spots are listed: the host settles it, and a member who has approved none is asked to pick. The label is short on purpose:
    // every chip on Home is a pill, and a longer one would need its own shape.
    if (session.spots?.list?.length) {
      if (isHost) return step('Confirm the spot', 'action')
      return session.spots.approvals?.[myId]?.length ? step('Waiting for the host', 'wait') : step('Pick your spots', 'action')
    }
    if (session.meeting) return isHost ? step('Confirm the meeting point', 'action') : step('Waiting for the host', 'wait')
    return step('Waiting for others', 'wait')
  }
  if (session.status === 'voting') {
    const voted = Object.values(session.votes || {}).some((byPerson) => byPerson?.[myId])
    return voted ? step('Waiting for others', 'wait') : step('Vote', 'action')
  }
  if (session.status === 'confirmed') {
    if (session.replan) return step('Review the re-plan', 'action')
    // Someone proposed a place from "What next?" and the host has not decided. Only the host has anything to do; everyone
    // else sees what they saw before. The label is short on purpose: every chip on Home is a pill.
    if (isHost && proposalsOf(session).length) return step('Review a proposal', 'action')
    return step(session.isToday ? "Today's plan" : 'See the plan', 'done')
  }
  return step('Open meetup', 'done')
}

// One pin per meetup that has a meeting point. Meetups that share an area are spread sideways by FAN_PX (in px, so
// they stay apart at every map size), in the order they were given, centred on the area. Nothing here is a member's
// exact place: a pin is always the meeting area.
// How to call: pinsFor(meetups) -> [{ id, areaId, areaName, lat, lng, offset: { x: 0, y: 0 } }]
export function pinsFor(meetups) {
  const placed = meetups.filter((m) => m.area && Number.isFinite(m.area.lat) && Number.isFinite(m.area.lng))
  const sharing = {}
  for (const m of placed) sharing[m.area.id] = (sharing[m.area.id] || 0) + 1
  const seen = {}
  return placed.map((m) => {
    const index = seen[m.area.id] || 0
    seen[m.area.id] = index + 1
    const x = (index - (sharing[m.area.id] - 1) / 2) * FAN_PX
    return { id: m.id, areaId: m.area.id, areaName: m.area.name, lat: m.area.lat, lng: m.area.lng, offset: { x, y: 0 } }
  })
}

// The words a screen reader says for a pin: the title, the area and when.
// How to call: pinName(meetup) -> 'Saturday lunch, Bugis, Sat 10 Oct · 15:00'
export function pinName(session, now = new Date()) {
  return [session.title, session.area?.name, whenLine(session, now)].filter(Boolean).join(', ')
}

// The routes for the map when this meetup is selected: from each member's start area (an area, never an exact
// place) to the meeting area. Areas shared by several members make one route, and a member who starts at the
// meeting area has none. Empty when there is no meeting point or no start is known yet, and the map then draws its
// own default routes.
// How to call: routesFor(meetup) -> [{ from: { lat, lng }, to: { lat, lng } }]
export function routesFor(session) {
  const to = session.area
  if (!to) return []
  const starts = new Map()
  for (const id of session.activeIds || []) {
    const start = session.locations?.[id]?.start
    if (start && start.areaId !== to.id && Number.isFinite(start.lat) && Number.isFinite(start.lng)) starts.set(start.areaId, start)
  }
  return [...starts.values()].map((s) => ({ from: { lat: s.lat, lng: s.lng }, to: { lat: to.lat, lng: to.lng } }))
}

// Where a pin's popover goes. Everything is in one coordinate space (the viewport's, in px). tip: the point the pin
// stands on. pin: how far the drawn pin reaches above the tip (height, with its growth and bob) and to each side
// (halfWidth), so the card never covers its head. size: the card's { w, h }. bounds: the box the card should stay in
// (the map's, less the bars); fallback: the box to use when it fits nowhere in the first, such as a phone, where
// the whole viewport is allowed. Tries above, below, then right and left of the pin; the card slides along its edge to
// stay inside. caret: how far along the card's edge the pin is, for a pointer toward it.
// How to call: placeCard({ tip: { x: 200, y: 300 }, pin: { height: 90, halfWidth: 30 }, size: { w: 264, h: 200 }, bounds })
//   -> { side: 'above', left, top, caret, inside: true }
export function placeCard({ tip, pin, size, bounds, fallback = null, gap = 8, caretMin = 18 }) {
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi))
  const head = tip.y - pin.height * 0.55
  const at = (side, b) => {
    const across = (v, len, lo, hi) => clamp(v, lo, hi - len)
    let left, top
    if (side === 'above' || side === 'below') {
      left = across(tip.x - size.w / 2, size.w, b.left, b.right)
      top = side === 'above' ? tip.y - pin.height - gap - size.h : tip.y + gap
    } else {
      top = across(head - size.h / 2, size.h, b.top, b.bottom)
      left = side === 'right' ? tip.x + pin.halfWidth + gap : tip.x - pin.halfWidth - gap - size.w
    }
    const vertical = side === 'above' || side === 'below'
    const caret = clamp(vertical ? tip.x - left : head - top, caretMin, (vertical ? size.w : size.h) - caretMin)
    return { side, left, top, caret }
  }
  const within = (c, b) => c.left >= b.left && c.top >= b.top && c.left + size.w <= b.right && c.top + size.h <= b.bottom
  for (const b of [bounds, fallback].filter(Boolean)) {
    for (const side of ['above', 'below', 'right', 'left']) {
      const c = at(side, b)
      if (within(c, b)) return { ...c, inside: true }
    }
  }
  // Nowhere fits (a box smaller than the card): the side with the most room, pulled into the last box tried.
  const b = fallback || bounds
  const room = { above: tip.y - pin.height - gap - b.top, below: b.bottom - tip.y - gap }
  const side = room.above >= room.below ? 'above' : 'below'
  const c = at(side, b)
  return { ...c, top: clamp(c.top, b.top, b.bottom - size.h), inside: false }
}
