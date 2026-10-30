// Who the signed-in person goes out with most, for the invite page (ticket #121), and the outings two people have had together, for
// profiles and for the line where an outing finishes. "Outings together" is the number of outings two people have completed
// together, not a run of weeks (the lead's reading; the profile's Longest and Current streak are weeks in a row). Only an outing
// that really happened counts: one completed by hand or by its end time passing, with both people in it. One that closed by itself
// with no confirmed plan (endedBy 'closed', lib/api.js settleOutings), a cancelled one, and anyone who opted out or never accepted,
// do not. Takes plain session summaries (lib/api.js), so it is tested without a browser.

// How many people the "Frequent hangouts" group holds at most; the rest of the friends are under "All friends".
export const FREQUENT_MAX = 5

const joined = (session, id) => (session.members || []).some((m) => m.id === id && m.state === 'joined')
// Did this outing really happen, with `myId` in it?
const happened = (session, myId) => session.status === 'completed' && session.endedBy !== 'closed' && joined(session, myId)

// The outings together with each person: how many completed outings they shared with `myId`. People with none are left out.
// How to call: outingsTogether(events.sessions, 'ian') -> { faith: 3, darius: 1 }
export function outingsTogether(sessions, myId) {
  const counts = {}
  for (const session of sessions || []) {
    if (!happened(session, myId)) continue
    for (const member of session.members) {
      if (member.id === myId || member.state !== 'joined') continue
      counts[member.id] = (counts[member.id] || 0) + 1
    }
  }
  return counts
}

// The outings `myId` and one other person have shared, with the day of the latest: `count`, and `last` as a 'yyyy-MM-dd' date or
// null with none. The same rule as outingsTogether.
// How to call: outingsWith(events.sessions, 'ian', 'faith') -> { count: 3, last: '2026-10-12' }
export function outingsWith(sessions, myId, otherId) {
  let count = 0
  let last = null
  for (const session of sessions || []) {
    if (!happened(session, myId) || !joined(session, otherId)) continue
    count += 1
    if (session.date && (!last || session.date > last)) last = session.date
  }
  return { count, last }
}

// The invite page's friends in two groups. `frequent`: up to FREQUENT_MAX friends with outings together, most outings first, then
// by name. `all`: every other friend, by name. Each person comes back with their `together` count (0 for none). With no history
// at all, `frequent` is empty and `all` is the one plain list.
// How to call: inviteGroups(friends, outingsTogether(sessions, 'ian')) -> { frequent: [{ id, name, together: 3 }], all: [...] }
export function inviteGroups(friends, counts) {
  const byName = (a, b) => a.name.localeCompare(b.name)
  const rows = (friends || []).map((p) => ({ ...p, together: counts?.[p.id] || 0 }))
  const frequent = rows
    .filter((p) => p.together > 0)
    .sort((a, b) => b.together - a.together || byName(a, b))
    .slice(0, FREQUENT_MAX)
  const top = new Set(frequent.map((p) => p.id))
  return { frequent, all: rows.filter((p) => !top.has(p.id)).sort(byName) }
}

// The words beside a name: "1 outing together", "3 outings together", or '' for none.
// How to call: togetherText(3) -> '3 outings together'
export function togetherText(count) {
  if (!count) return ''
  return `${count} ${count === 1 ? 'outing' : 'outings'} together`
}

// The line on someone's profile: "3 outings together · last on 12 Oct 2026". The caller formats the date.
// How to call: togetherLine(3, '12 Oct 2026') -> '3 outings together · last on 12 Oct 2026'
export function togetherLine(count, lastText) {
  if (!count) return ''
  return `${togetherText(count)}${lastText ? ` · last on ${lastText}` : ''}`
}

// ── Milestones ──
// Is the nth outing together one to mark? The 1st, the 5th, the 10th, then every 10th.
// How to call: isMilestone(5) -> true
export function isMilestone(n) {
  return n === 1 || n === 5 || (n >= 10 && n % 10 === 0)
}

// The ordinal word for a count: "first", then "2nd", "3rd", "5th", "11th", "21st".
// How to call: ordinalWord(5) -> '5th'
export function ordinalWord(n) {
  if (n === 1) return 'first'
  const v = n % 100
  const suffix = ['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'
  return `${n}${suffix}`
}

// When an outing finished, to put two in order: the time it was completed, else the start of its day.
const finishedAt = (s) => (Number.isFinite(s.completedAt) ? s.completedAt : Date.parse(`${s.date}T${s.start || '00:00'}:00`) || 0)

// The friends for whom this outing was a milestone: [{ id, n }], where `n` is which outing together it was with that friend, counting
// in the order the outings finished, so the number does not change when later ones are added. `session` is a finished outing; with
// one that did not happen (not completed, closed with no plan, `myId` not in it) nobody is at a milestone. A friend who opted out
// or never joined is not counted. Friends keep the order of the session's members.
// How to call: outingMilestones(events.sessions, 'ian', session) -> [{ id: 'faith', n: 5 }]
export function outingMilestones(sessions, myId, session) {
  if (!session || !happened(session, myId)) return []
  const all = [...(sessions || []).filter((s) => s.id !== session.id), session]
  const out = []
  for (const member of session.members) {
    if (member.id === myId || member.state !== 'joined') continue
    const shared = all.filter((s) => happened(s, myId) && joined(s, member.id)).sort((a, b) => finishedAt(a) - finishedAt(b) || String(a.id).localeCompare(String(b.id)))
    const n = shared.findIndex((s) => s.id === session.id) + 1
    if (isMilestone(n)) out.push({ id: member.id, n })
  }
  return out
}

// The sentence for those milestones, in the app's voice, or '' with none. Friends at the same number share a sentence: one name,
// "A and B", or "A, B and 2 others" (two are named at most). When the numbers differ, the biggest comes first, and at most two sentences.
// How to call: milestoneText([{ id: 'faith', n: 5 }], (id) => 'Faith') -> "That's your 5th outing with Faith."
export function milestoneText(milestones, nameOf) {
  const groups = new Map()
  for (const m of milestones || []) groups.set(m.n, [...(groups.get(m.n) || []), nameOf(m.id) || 'a friend'])
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, 2)
    .map(([n, names]) => {
      const rest = names.length - 2
      const who = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`
      return `That's your ${ordinalWord(n)} outing with ${who}.`
    })
    .join(' ')
}
