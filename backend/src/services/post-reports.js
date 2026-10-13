// What to do about people reporting that a saved place is closed, moved or not what the post said. Pure rules: no
// database, no network. Reports are stored by whoever builds the saved list (Supabase); this decides what they mean.
//
// The rules are built so one person, or one angry or mistaken report, can never remove a place:
//   - Only one report counts per person (their latest), and only the last 30 days of reports count.
//   - 1 or 2 people: the place stays, with a warning that says how many reported it.
//   - 3 or more people: the place is checked against Google. If Google also says it is not operating (or has no such
//     place, as with a pop-up), it is hidden from suggestions. If Google says it is open, it stays with a stronger
//     warning and goes to the team's review queue: a person decides, not the count.
//   - Google saying "permanently closed" is enough on its own: no reports needed.
//   - People saying "it's open" cancel reports: two more of them than the closed reports clears the warning.
//   - Hiding never deletes anything. A hidden place can come back when the reports age out or people say it is open.

export const REPORT_WINDOW_DAYS = 30
export const REPORTS_TO_HIDE = 3
export const CONFIRMATIONS_TO_CLEAR = 2

// What a person can say, and which side it is on.
export const REPORT_KINDS = { closed: 'against', moved: 'against', wrong_place: 'against', ended: 'against', open: 'for' }

// Decides what a set of reports means for one place.
//   reports       [{ userId, kind: 'closed' | 'moved' | 'wrong_place' | 'ended' | 'open', at (milliseconds) }]
//   googleStatus  Google's businessStatus ('OPERATIONAL', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY'), or null when
//                 Google has no such place or was not asked
//   now           the time in milliseconds
// Returns { verdict, against, confirmations, hide, warn, review, why }:
//   verdict  'ok', 'warn', 'needs_review', 'hidden' or 'closed'
//   against  people who reported a problem; confirmations: people who said it is open
//   hide     keep the place out of suggestions
//   warn     show a warning on the place
//   review   put it in the review queue for a team member
//
// How to call:
//   assessReports({ reports: [{ userId: 'a', kind: 'closed', at: Date.now() }], googleStatus: 'OPERATIONAL', now: Date.now() })
//   // { verdict: 'warn', against: 1, confirmations: 0, hide: false, warn: true, review: false, why: '1 person reported a problem.' }
export function assessReports({ reports = [], googleStatus = null, now = Date.now() }) {
  const since = now - REPORT_WINDOW_DAYS * 86400000
  // The latest report of each person within the window.
  const latest = new Map()
  for (const r of reports) {
    if (!r || typeof r.userId !== 'string' || !(r.kind in REPORT_KINDS) || !Number.isFinite(r.at) || r.at < since || r.at > now) continue
    const had = latest.get(r.userId)
    if (!had || r.at > had.at) latest.set(r.userId, r)
  }
  const side = (s) => [...latest.values()].filter((r) => REPORT_KINDS[r.kind] === s).length
  const against = side('against')
  const confirmations = side('for')
  const answer = (verdict, why, flags) => ({ verdict, against, confirmations, hide: false, warn: false, review: false, ...flags, why })

  if (googleStatus === 'CLOSED_PERMANENTLY') return answer('closed', 'Google lists it as permanently closed.', { hide: true })
  if (against === 0) return answer('ok', 'No reports.')
  if (confirmations >= against + CONFIRMATIONS_TO_CLEAR) return answer('ok', `${confirmations} people said it is open, more than the ${against} who reported a problem.`)
  if (against < REPORTS_TO_HIDE) return answer('warn', `${against} ${against === 1 ? 'person' : 'people'} reported a problem.`, { warn: true })
  // Enough people. Google decides whether that is enough to hide it, and a person decides when Google disagrees.
  if (googleStatus === 'OPERATIONAL') return answer('needs_review', `${against} people reported a problem but Google lists it as open: a team member checks.`, { warn: true, review: true })
  return answer('hidden', `${against} people reported a problem and Google does not list it as open.`, { hide: true, warn: true, review: true })
}
