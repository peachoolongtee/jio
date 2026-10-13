// The words on a Vote card that are worked out rather than copied: the opening-hours tag, which tags are shown, who voted,
// and where the walking times are from. Pure functions, so the wording is tested without a screen.
import { fromMinutes, toMinutes } from './planner/format.js'

const DAY = 1440
// Most tags a card shows besides "Leading" and the rain warning.
export const TAGS_MAX = 3
// Reasons from the planner that repeat the line above them ("about 1 min walk") or that nothing measures.
const REPEATS = ['Short walk']
// The most people for whom a card names the voters; a larger group keeps the count.
export const NAMED_GROUP_MAX = 4

// Opening periods as minutes after midnight, in order, with touching or overlapping periods joined. A closing time that
// is not after the opening time runs past midnight; the same period a day earlier and a day later is kept too, so the small
// hours after a late night, and a stop that runs into the next morning, are found. A string that is not "HH:MM-HH:MM" is left out.
// How to call: openPeriods(['11:00-14:00', '14:00-22:00']) -> [[660, 1320]]
export function openPeriods(hours) {
  const periods = []
  for (const text of Array.isArray(hours) ? hours : []) {
    const found = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(text).trim())
    if (!found) continue
    const open = toMinutes(`${found[1]}:${found[2]}`)
    const rawClose = toMinutes(`${found[3]}:${found[4]}`)
    const close = rawClose <= open ? rawClose + DAY : rawClose
    periods.push([open, close], [open - DAY, close - DAY], [open + DAY, close + DAY])
  }
  periods.sort((a, b) => a[0] - b[0])
  const joined = []
  for (const [open, close] of periods) {
    const last = joined.at(-1)
    if (last && open <= last[1]) last[1] = Math.max(last[1], close)
    else joined.push([open, close])
  }
  return joined
}

// A closing time for the tag: "22:00", and "midnight" for 00:00 (a place that shuts at 24:00 or 00:00).
// How to call: clock(1440) -> 'midnight'
const clock = (minutes) => (minutes % DAY === 0 ? 'midnight' : fromMinutes(minutes))

// What a place's opening hours say about one stop that starts at `start` (minutes after midnight) and lasts `duration`
// minutes: { text, tone } or null. Null when the place lists no hours, or the stop's time is not known, because a guess
// would be worse than nothing.
//   Open through the stop:  "Open until 22:00" or "Open until midnight" (neutral), or "Open 24 hours"
//   Closes during the stop: "Closes at 21:00" (warning)
//   Not open at the start:  "Closed at this time" (warning)
// How to call: hoursNote(['10:00-22:00'], 19 * 60, 90) -> { text: 'Open until 22:00', tone: 'neutral' }
export function hoursNote(hours, start, duration) {
  if (!Number.isFinite(start) || !Number.isFinite(duration)) return null
  const periods = openPeriods(hours)
  if (!periods.length) return null
  const period = periods.find(([open, close]) => start >= open && start < close)
  if (!period) return { text: 'Closed at this time', tone: 'warning' }
  const [open, close] = period
  const around = close - open >= DAY - 1
  if (start + duration <= close) return { text: around ? 'Open 24 hours' : `Open until ${clock(close)}`, tone: 'neutral' }
  return { text: `Closes at ${clock(close)}`, tone: 'warning' }
}

// The tags under a card's name, other than "Leading" and the rain warning: the planner's reasons without the ones that
// repeat the line above or that nothing measures, and the hours tag. At most TAGS_MAX; the hours tag wins over the planner's
// second reason, so with more than fit the first reason, the hours and then the rest are kept.
// reasons: strings. note: the answer of hoursNote, or null. Returns [{ key, text, tone, icon }] in the order shown (reasons, then hours).
// How to call: cardTags(['Near MRT', 'Short walk'], { text: 'Open until 22:00', tone: 'neutral' }) -> Near MRT, Open until 22:00
export function cardTags(reasons, note) {
  const kept = (reasons || []).filter((r) => typeof r === 'string' && r && !r.startsWith('Quiet at') && !REPEATS.includes(r))
  const room = note ? TAGS_MAX - 1 : TAGS_MAX
  const tags = kept.slice(0, room).map((text) => ({ key: text, text, tone: 'neutral', icon: '' }))
  if (note) tags.push({ key: 'hours', text: note.text, tone: note.tone, icon: note.tone === 'warning' ? 'clock' : '' })
  return tags
}

// Who voted for a place, in words. A group of up to NAMED_GROUP_MAX people gets names, with "You" first; a larger group,
// or a card that was not told the group's size, gets the count. Nobody voting reads "0 votes" either way.
// voters: [{ id, name }]. me: the signed-in person's id. groupSize: how many people are active in the session.
// How to call: votersText({ voters: [{ id: 'ian', name: 'Ian' }, { id: 'darius', name: 'Darius' }], votes: 2, groupSize: 4, me: 'ian' }) -> 'You and Darius voted'
export function votersText({ voters = [], votes = 0, groupSize = 0, me = '' } = {}) {
  const count = `${votes} ${votes === 1 ? 'vote' : 'votes'}`
  if (!votes || groupSize < 1 || groupSize > NAMED_GROUP_MAX) return count
  // Names that are missing, or a list that does not match the count, are not worth guessing from.
  if (voters.length !== votes || voters.some((v) => !(v.id === me || (typeof v.name === 'string' && v.name.trim())))) return count
  if (groupSize > 1 && votes >= groupSize) return 'Everyone voted'
  const names = [...voters.filter((v) => v.id === me).map(() => 'You'), ...voters.filter((v) => v.id !== me).map((v) => v.name.trim())]
  const list = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `${list} voted`
}

// The one line that says where the walking times on the Vote page are measured from. Nothing when there is no meeting area.
// How to call: walkFromText('Bugis') -> 'Walking times are from Bugis'
export function walkFromText(areaName) {
  const name = typeof areaName === 'string' ? areaName.trim() : ''
  return name ? `Walking times are from ${name}` : ''
}
