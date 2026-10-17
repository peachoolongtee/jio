// Who the signed-in person goes out with most, for the invite page (ticket #121). The Jio streak is the number of outings
// two people have completed together, not a run of weeks (the lead's reading). Only an outing that really happened counts:
// one completed by hand or by its end time passing, with both people in it. One that closed by itself with no confirmed
// plan (endedBy 'closed', lib/api.js settleOutings), a cancelled one, and anyone who opted out or never accepted, do not.
// Takes plain session summaries (lib/api.js), so it is tested without a browser.

// How many people the "Frequent hangouts" group holds at most; the rest of the friends are under "All friends".
export const FREQUENT_MAX = 5

const joined = (session, id) => (session.members || []).some((m) => m.id === id && m.state === 'joined')

// The Jio streak with each person: how many completed outings they shared with `myId`. People with none are left out.
// How to call: outingsTogether(events.sessions, 'ian') -> { faith: 3, darius: 1 }
export function outingsTogether(sessions, myId) {
  const counts = {}
  for (const session of sessions || []) {
    if (session.status !== 'completed' || session.endedBy === 'closed' || !joined(session, myId)) continue
    for (const member of session.members) {
      if (member.id === myId || member.state !== 'joined') continue
      counts[member.id] = (counts[member.id] || 0) + 1
    }
  }
  return counts
}

// The invite page's friends in two groups. `frequent`: up to FREQUENT_MAX friends with a streak, most outings first, then by
// name. `all`: every other friend, by name. Each person comes back with their `streak` (0 for none). With no history at
// all, `frequent` is empty and `all` is the one plain list.
// How to call: inviteGroups(friends, outingsTogether(sessions, 'ian')) -> { frequent: [{ id, name, streak: 3 }], all: [...] }
export function inviteGroups(friends, counts) {
  const byName = (a, b) => a.name.localeCompare(b.name)
  const rows = (friends || []).map((p) => ({ ...p, streak: counts?.[p.id] || 0 }))
  const frequent = rows
    .filter((p) => p.streak > 0)
    .sort((a, b) => b.streak - a.streak || byName(a, b))
    .slice(0, FREQUENT_MAX)
  const top = new Set(frequent.map((p) => p.id))
  return { frequent, all: rows.filter((p) => !top.has(p.id)).sort(byName) }
}

// The words beside a name: "1 outing together", "3 outings together", or '' for none.
// How to call: streakText(3) -> '3 outings together'
export function streakText(streak) {
  if (!streak) return ''
  return `${streak} ${streak === 1 ? 'outing' : 'outings'} together`
}
