// Everything the Confirm dialog decides about the order of the stops that needs no screen: the rows of each order,
// whether the two differ, which one is shown and selected, what Confirm hands over, and how the source of a
// suggestion is worded. It takes plain data, so it is tested without a browser.
//
// The rule behind it: the app proposes and the host decides. The voted order is selected whenever the dialog opens
// or a suggestion arrives, so the rows never change order unless the host taps "Suggested order".
import { timeAndDuration, toMinutes } from './planner/format.js'
import { isOpenDuring } from './planner/itinerary.js'

export const VOTED = 'voted'
export const SUGGESTED = 'suggested'

// The two choices, voted first (the safer one first, as in every dialog).
export const ORDER_TABS = [
  { id: VOTED, label: 'Voted order' },
  { id: SUGGESTED, label: 'Suggested order' },
]

// The rows for the order the votes make. winners: [{ stop: { category, time, duration }, option }] from the planner view.
// How to call: votedRows(winners) -> [{ key: 'eat', category: 'eat', venueId: 'v1', when: '12:00 · 1 h', name: 'Cafe' }]
export function votedRows(winners) {
  return (winners || []).map((w) => ({
    key: w.stop.category,
    category: w.stop.category,
    venueId: w.option?.venue?.id ?? null,
    when: timeAndDuration(w.stop.time, w.stop.duration),
    name: w.option?.venue?.name || 'No place',
    // The start in minutes after midnight and the length, for the dialog's "Closed at this time" and "Ends after" warnings.
    start: w.stop.start ?? w.stop.time,
    duration: w.stop.duration,
  }))
}

// The rows for a suggestion (api.suggestOrder), in its order and at its times.
// How to call: suggestedRows(suggestion) -> [{ key: 'shop', category: 'shop', venueId: 'v2', when: '10:00 · 1 h', name: 'Mall' }]
export function suggestedRows(suggestion) {
  return (suggestion?.stops || []).map((s) => ({
    key: s.slotId,
    category: s.category,
    venueId: s.venueId ?? null,
    when: timeAndDuration(s.start, s.duration),
    name: s.name,
    start: s.start,
    duration: s.duration,
  }))
}

// What the answer depends on, as text: the same text means the same question, so the dialog may reuse an answer.
// How to call: confirmKey(winners, session, false) -> '["12:00","18:00",...]'
export function confirmKey(winners, session, rain = false) {
  return JSON.stringify([session?.date ?? '', session?.start ?? '', session?.end ?? '', !!rain, ...votedRows(winners).map((r) => [r.category, r.venueId, r.when])])
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

// The suggestion when confirming it could apply: it covers the same places as the voted rows, so Confirm will not
// quietly fall back to the voted order. Otherwise null (a tie in the votes can come out differently).
// How to call: usableSuggestion(votedRows(winners), suggestion) -> suggestion | null
export function usableSuggestion(voted, suggestion) {
  const stops = suggestion?.stops
  if (!Array.isArray(stops) || !stops.length || stops.length !== voted.length) return null
  if (voted.some((r) => r.venueId == null)) return null
  const places = (list) => list.map((x) => `${x.category}:${x.venueId}`).sort()
  return sameList(places(stops), places(voted)) ? suggestion : null
}

// What the dialog shows and what Confirm hands over.
//   voted:      votedRows(winners)
//   suggestion: the answer for this question, or null (none yet, none worth showing, or the request failed)
//   picked:     VOTED or SUGGESTED, the host's choice; only read when the two orders differ
// Returns { rows, choice, selected, pass, note }:
//   choice    true when the two orders differ, so the dialog shows the two-way control
//   selected  VOTED or SUGGESTED
//   pass      the suggestion to hand to confirm(id, pass), or null for the voted order
//   note      { reason, source } of the suggestion when there is one to show, whichever order is selected, else null
// When the suggestion keeps the voted order there is nothing to choose; its times (a meal waits for its time) are
// shown and applied.
// How to call: confirmView({ voted, suggestion, picked: VOTED }) -> { rows, choice: true, selected: 'voted', pass: null, note }
export function confirmView({ voted, suggestion, picked = VOTED }) {
  const usable = usableSuggestion(voted, suggestion)
  if (!usable) return { rows: voted, choice: false, selected: VOTED, pass: null, note: null }
  const note = { reason: usable.reason, source: usable.source }
  const suggested = suggestedRows(usable)
  if (sameList(suggested.map((r) => r.category), voted.map((r) => r.category))) {
    return { rows: suggested, choice: false, selected: SUGGESTED, pass: usable, note }
  }
  if (picked === SUGGESTED) return { rows: suggested, choice: true, selected: SUGGESTED, pass: usable, note }
  return { rows: voted, choice: true, selected: VOTED, pass: null, note }
}

// Where a sentence about the order came from, in words, for the dialog and the itinerary. An AI's sentence is
// introduced as an AI suggestion; a rules answer says what it went by (travel and waiting time), and nothing about the AI.
// note: { reason, source }. How to call: sourceText({ reason: 'Shops first.', source: 'ai' }) -> 'AI suggestion: Shops first.'
export function sourceText(note) {
  const reason = typeof note?.reason === 'string' ? note.reason.trim() : ''
  if (note?.source === 'ai') return reason ? `AI suggestion: ${reason}` : 'Order suggested by AI.'
  return reason ? `Suggestion chosen by travel and waiting time. ${reason}` : 'Suggestion chosen by travel and waiting time.'
}

// The icon that goes with the source: the sparkle only for the AI.
// How to call: sourceIcon({ source: 'rules' }) -> 'route'
export function sourceIcon(note) {
  return note?.source === 'ai' ? 'sparkle' : 'route'
}

// What is wrong with a stop in the confirm dialog, if anything: the place is closed for its time (by its listed hours), or the stop ends
// after the session does. A warning, not a block (Darius, 4 November 2026). row: { start (minutes or "HH:MM"), duration }. venue: the place, or
// null. sessionEnd: "HH:MM", or empty.
// How to call: rowProblem({ start: 1200, duration: 120 }, null, '21:00') -> 'Ends after 21:00'
export function rowProblem(row, venue, sessionEnd) {
  const start = typeof row?.start === 'number' ? row.start : row?.start ? toMinutes(row.start) : NaN
  if (!Number.isFinite(start) || !row.duration) return ''
  const end = start + row.duration
  if (venue && !isOpenDuring(venue, start, end)) return 'Closed at this time'
  const close = sessionEnd ? toMinutes(sessionEnd) : NaN
  if (Number.isFinite(close) && end > close) return `Ends after ${sessionEnd}`
  return ''
}
