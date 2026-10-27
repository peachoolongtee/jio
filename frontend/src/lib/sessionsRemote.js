// A real account's sessions, kept in Supabase instead of this browser. This is the other half of the choice lib/api.js makes
// for each session function: the demo account and local accounts stay on the local data layer, a real account comes here.
//
// It reads and writes the database directly, as the browser may (ticket #79's table, CLAUDE.md "what a browser may write
// directly"): a new session, its title, date and times while it is inviting, its start and cancel, the host's invite links,
// and (stage 3) a member's own start and end (the area on their member row, the exact place in `session_member_places`) and
// their own "Works for me". The database's own rules decide who may do what; this file turns a refusal into a plain sentence.
// What the database refuses to a browser goes through the Jio server instead (`backend`): a member leaving or being removed,
// the meeting spots (worked out, suggested, withdrawn), confirming a spot, a known place, opting out and rejoining.
//
// It answers in the shape the local data layer keeps a session in ({ id, title, date, start, end, hostId, status, members,
// createdAt, updatedAt }), plus `remote: true`, and from stage 3 the fields the Locate step reads: `locations` (the area each
// member starts from), `meeting` (once a spot is confirmed), `spots` (the list, who suggested what, who said it works for
// them), `banner` and `planVersion`. lib/api.js adds what belongs to the later stages (votes, the plan) as empty and runs the
// same summary as for a local session, so screens do not change.
//
// Stage 4 adds voting: the slots (one per category), the places offered in each, and the votes. They are read here for a session that is
// voting (`slotRows`, `optionRows`, and the shapes the screens keep: `options`, `votes`, `prefs`, `deletedSlots`, `radius`). A person's
// own vote is a direct write to `votes` under the database's rules (the session is voting, the person has joined, the place is one of the
// slot's options; `castVote`). Everything that changes what the group is offered (the radius, removing or bringing back a category,
// adding, swapping or asking for more places, the plan from people's picks) is a call to the Jio server. Live: a vote reaches the
// other devices as a change to `votes`, which reads the votes alone (`readSlotVotes`); the server's writes reach them as a change to the
// session's version, which is read again. `details` (what the planner said of each slot and place) is read only for the Vote page
// (`readPlan`), not for the list Home uses; and the votes are read so that the 1,000 rows one answer can hold never cuts any off.
//
// Stage 5 adds the plan: the itinerary (`stops`, in order, with each stop's earliest start and how the group gets to it, and the session's
// order columns: the sentence about the order and who chose it, and when the plan starts), the places members have put forward as the
// next stop (`stop_proposals`, pending ones only), the "Re-plan?" question (`sessions.replan`) and, once the outing is over, a person's own
// travel ledger row. They are read here for a session that is confirmed or completed (`outingOf`) and answered in the shape the local data
// layer keeps a plan in (`plan: { stops, modes, startAt, aiNote }`, `proposals`, `replan`), so the screens and the rules that lay the
// itinerary out do not change. Everything that changes the plan is a call to the Jio server: the suggested order and the confirm (the
// browser sends only which order it saw and that order's `basis`, never stops, a reason or a source), re-planning, ending the outing,
// moving, deleting and timing stops, changing a stop's place, and Roam (the list, proposing, answering a proposal).
//
// Another member's exact place is never read, shown or kept: `session_member_places` is read with the person's own id and
// only its two labels, so what comes back is the person's own, and everyone else's start is the area name. The table is
// not listened to. A person who is not a member is shown only the preview of an invite (title, date, times, the host's name).
//
// `client()` is the Supabase client (or null), `me()` the signed-in user's id, `backend` the calls to the Jio server
// (`removeMember`, `refreshSpots`, `putSpot`, `deleteSpot`, `confirmSpot`, `knownPlace`, `optOut`, `rejoin`, and from stage 4 `syncPlan`,
// `setRadius`, `deleteSlot`, `restoreSlots`, `addOption`, `moreOptions`, `swapOption`, `searchSlot`, `venues`, and from stage 5
// `suggestOrder`, `tripsHome`, `confirmPlan`, `replan`, `complete`, `patchStop`, `deleteStop`, `reorderStops`, `stopSwap`, `stopChoices`,
// `changeStopPlace`, `keepRain`, `roam`, `propose`, `resolve`), `now()` the clock
// in milliseconds.
// How to call: const remote = createSessionsRemote({ client: () => auth.dataClient(), me: () => currentUserId(), backend, now: Date.now })

import { isUuid } from './peopleSource.js'
import { fromMinutes, toMinutes } from './planner/format.js'

// The words a person reads. Written once so a screen and a test say the same thing.
export const WORDS = {
  offline: 'Jio could not be reached. Check your connection and try again.',
  signedOut: 'Log in to do that.',
  noSession: 'This session does not exist, or you are not in it.',
  // The database answers the same for a link that expired, was replaced or turned off, was a personal invitation meant for
  // someone else or already used, belongs to a session that is under way or over, or never existed, so a stranger cannot
  // use it to learn anything. The page can only name all the possibilities.
  linkDeadWhy: 'It may have expired, the host may have replaced or turned it off, or the session may already be under way.',
  linkDead: 'This link no longer works. It may have expired, the host may have replaced or turned it off, or the session may already be under way.',
  full: 'This session is full.',
  notAllowed: "You can't do that in this session.",
  // A demo account or a local account lives in this browser only; the invite functions are for a real account.
  needsAccount: 'Shared sessions need a Jio account. Log in with one.',
  started: "You can't leave once voting has started; ask the host to cancel.",
  alreadyInvited: 'You have already invited that person.',
  startedRemove: "You can't remove someone once voting has started; cancel the session instead.",
  // The server answers not_yet only for a confirmed plan (its itinerary is a later stage's work); voting is served.
  notYet: "That isn't possible once the plan is confirmed.",
  hostLeave: 'The host cannot leave. Cancel the session instead.',
  hostOnlyRemove: 'Only the host can remove someone.',
  closed: 'This session has ended.',
  gone: 'That person is not in this session any more.',
  notSaved: 'That could not be saved. Try again.',
  notLoaded: 'Your sessions could not be loaded. Try again.',
  // Stage 3: the meeting spots and where people start.
  spotsClosed: 'Spots can only change while the group is choosing where to meet.',
  alreadyConfirmed: 'The host has already confirmed the spot, so your mark stays.',
  startClosed: "Where you start can't be changed now.",
  needTwoStarts: 'Spots open once two people have shared where they start.',
  tooManySpots: 'The group can suggest up to 8 different spots. Ask someone to withdraw theirs first.',
  spotGone: 'That spot is not on the list any more.',
  needTwoPeople: 'A session needs at least 2 people.',
  noArea: 'This area does not exist.',
  noTrips: 'The planner could not work out travel times to that area.',
  hostOnly: 'Only the host can do that.',
  notIn: 'Only people in this session can do that.',
  hostOptOut: 'The host cannot opt out.',
  busy: 'Jio is busy with another change to this session. Try again in a moment.',
  // Stage 5: the plan, the itinerary and finishing.
  notShared: "That isn't available in a shared session yet.",
  photosLater: 'Photos are not shared yet. They come in a later update.',
  placeMissing: 'A place in the plan could not be found. Try again in a moment.',
  // The name drawn for a stop whose place the server no longer describes (it left the list since the plan was made).
  placeUnlisted: 'A place that is no longer listed',
  // A route the server does not have (yet): the stand-in for the parts of stage 5 that the server may not have built.
  notBuilt: 'That is not available yet. Try again after the next update.',
  planClosed: 'The plan can only be confirmed while the group is voting.',
  notEnoughVotes: 'At least 2 people need to vote first.',
  nothingToConfirm: 'Vote for at least one place first.',
  orderStale: 'The votes changed, so the suggested order changed too. Look at it again and confirm.',
  orderChanged: 'The votes changed, so the order below was updated.',
  hostPlan: 'Only the host can do that to the plan.',
  needConfirmed: 'Only a confirmed plan can be changed.',
  stopGone: 'That stop is not in the plan any more.',
  lastStop: 'A plan needs at least one stop.',
  noLeg: 'The first stop has no travel into it.',
  planChanged: 'The plan changed. Look at it again.',
  planFull: 'The plan has 8 stops, the most it can hold.',
  alreadyStop: 'That place is already in the plan.',
  tooManyProposals: 'Too many places are waiting. Take one back, or ask the host to decide on them.',
  proposalGone: 'That proposal is no longer there.',
  completeClosed: 'Only a confirmed plan can be ended.',
  alreadyCompleted: 'This outing has already finished.',
  roamClosed: 'Places can be proposed once the plan is confirmed.',
  // Stage 4: voting on places.
  votesClosed: 'Votes are read-only once the plan is confirmed.',
  placesClosed: 'Places can only change while the group is voting.',
  optionGone: 'That place is no longer an option.',
  slotGone: 'That category is not on the list any more.',
  slotFull: 'A category holds up to 6 places.',
  noVenue: 'That place could not be found.',
  doesNotFit: 'That place does not fit this category.',
  hostRadius: 'Only the host can change how far to search.',
  hostSlots: 'Only the host can remove or bring back a category.',
  rejoinClosed: "You can't rejoin once the plan is confirmed.",
  optOutClosed: "You can't opt out once the plan is confirmed.",
  // 409 no_meeting_area: voting is paused because nobody has shared where they start (the meeting area was taken away).
  // 42703 on sessions.meet_by: the database is one migration behind the app.
  needsMeetBy: 'The database needs an update before sessions can load (db/migrations/20261026000000_jio_session_meet_by.sql). Ask whoever runs the project to apply it.',
  noMeetingArea: 'Places open once two people have shared where they start.',
}

// The words for what the Jio server refused, by its code (backend/src/routes/sessions.js). A caller can word a code its own way.
const CODE_WORDS = {
  session_not_found: WORDS.noSession,
  not_joined: WORDS.notIn,
  host_only: WORDS.hostOnly,
  host_cannot_leave: WORDS.hostLeave,
  host_cannot_opt_out: WORDS.hostOptOut,
  session_closed: WORDS.closed,
  session_started: WORDS.started,
  not_yet: WORDS.notYet,
  member_not_found: WORDS.gone,
  wrong_status: WORDS.spotsClosed,
  no_spots: WORDS.needTwoStarts,
  too_many_spots: WORDS.tooManySpots,
  spot_not_found: WORDS.spotGone,
  needs_two_people: WORDS.needTwoPeople,
  unknown_area: WORDS.noArea,
  area_not_priced: WORDS.noTrips,
  plan_busy: WORDS.busy,
  slot_not_found: WORDS.slotGone,
  slot_full: WORDS.slotFull,
  venue_not_found: WORDS.noVenue,
  venue_does_not_fit: WORDS.doesNotFit,
  option_not_found: WORDS.optionGone,
  no_meeting_area: WORDS.noMeetingArea,
  not_enough_votes: WORDS.notEnoughVotes,
  nothing_to_confirm: WORDS.nothingToConfirm,
  order_stale: WORDS.orderStale,
  // The outing's day: it cannot be finished before it, and Roam looks only on it.
  before_the_day: 'This outing can be finished from its day.',
  wrong_day: 'Places near the group can be looked up on the day of the outing.',
  stop_not_found: WORDS.stopGone,
  last_stop: WORDS.lastStop,
  // The server's 409s for a plan that moved under the caller (stops_changed: the list sent is not the plan's; stop_changed: the stop holds another place).
  stops_changed: WORDS.planChanged,
  stop_changed: WORDS.planChanged,
  no_leg: WORDS.noLeg,
  plan_full: WORDS.planFull,
  already_a_stop: WORDS.alreadyStop,
  too_many_proposals: WORDS.tooManyProposals,
  proposal_not_found: WORDS.proposalGone,
}

// A refusal from the Jio server as an Error with a sentence fit to show, its code kept on `code` and the HTTP status (when the
// server answered) on `status`, so a caller can tell a refusal that did nothing (4xx) from a failure that may have (5xx, no answer).
// `words` changes the sentence for a code in one place (removing someone says "remove", not "do that").
// How to call: throw problem(err, { host_only: WORDS.hostOnlyRemove })
export function problem(err, words = {}) {
  const code = typeof err?.code === 'string' ? err.code : undefined
  const message = (code && (words[code] || CODE_WORDS[code])) || err?.message || WORDS.notSaved
  return Object.assign(new Error(message), { code }, Number.isInteger(err?.status) ? { status: err.status } : {})
}

// A link's token is 32 random bytes written as 43 URL-safe characters (db/schema.sql). Anything else cannot be a link.
// How to call: looksLikeToken('q3D9_-aZ...') -> true
export const looksLikeToken = (text) => typeof text === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(text)

// "18:00:00" from the database to "18:00" as the screens keep it. How to call: hhmm('18:00:00') -> '18:00'
const hhmm = (time) => String(time ?? '').slice(0, 5)
// How to call: pending({ revoked: false, declined_at: null, uses: 0, expires_at: '2026-10-20T00:00:00Z' }, Date.now()) -> true
const pending = (invite, at) => !invite.revoked && invite.declined_at == null && invite.uses === 0 && Date.parse(invite.expires_at) > at

// A failed call as an Error with a sentence fit to show, and the database's code kept on `code`.
// How to call: throw plain(error, WORDS.notSaved)
export function plain(error, fallback = WORDS.notSaved) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const text = String(error?.message ?? '')
  let message = fallback
  if (error?.status === 0 || /failed to fetch|network|timed out|load failed/i.test(text)) message = WORDS.offline
  // The project does not have the column the app now reads: its migration has not been applied. Say which, so it is found quickly.
  else if (['42703', 'PGRST204'].includes(code) && /meet_by/.test(text)) message = WORDS.needsMeetBy
  else if (code === 'P0002') message = WORDS.linkDead
  else if (code === 'P0001' && error?.hint === 'session_full') message = WORDS.full
  else if (code === '28000') message = WORDS.signedOut
  else if (code === '23505') message = /one_live_link/.test(text) ? 'This session already has a link. Reload to see it.' : WORDS.alreadyInvited
  // The database refuses a day or start that has passed with its own sentence, written for people; any other check is not.
  else if (code === '23514') message = /^(That day has passed\.|That start time has already passed today\.)$/.test(text) ? text : 'That is not allowed. Check the title, day and times.'
  // The database's own sentences for a refused action are written for people (a trigger's); its generic ones are not.
  else if (code === '42501' && !/row-level security|permission denied/i.test(text)) message = text
  else if (code === '42501') message = WORDS.notAllowed
  return Object.assign(new Error(message), { code: code || undefined })
}

// Nothing read for planning yet. How to call: toSession(row, members, invites, NO_PLANNING)
const NO_PLANNING = { spots: [], suggestions: [], approvals: [], places: [], slots: [], options: [], votes: [], stops: [], proposals: [] }

// How to call: const remote = createSessionsRemote({ client, me, backend, now })
export function createSessionsRemote({ client, me, backend = {}, now = Date.now } = {}) {
  // The client, or a plain "cannot reach" error when there is none.
  // How to call: const { data, error } = await db().from('sessions').select('id')
  function db() {
    const c = client()
    if (!c) throw Object.assign(new Error(WORDS.offline), { code: 'offline' })
    return c
  }
  // Who is acting, or a "log in" error. How to call: const mine = who()
  function who() {
    const id = me()
    if (!id) throw Object.assign(new Error(WORDS.signedOut), { code: '28000' })
    return id
  }
  // The data of a read, or throw its error in words. How to call: const rows = answer(await db().from('sessions').select('id'), WORDS.notLoaded)
  function answer({ data, error }, fallback) {
    if (error) throw plain(error, fallback)
    return data
  }

  // The minutes of a spot, rounded as the screens show them. How to call: minutesOf(24.6) -> 25
  const minutesOf = (value) => Math.round(Number(value))

  // The area an end of a person's route is in, with the label only the person themselves have. Everyone else's is empty:
  // the data layer shows their area's name, and this file never reads their exact place.
  // How to call: endOf('bugis', 'Bugis MRT exit B', true) -> { areaId: 'bugis', label: 'Bugis MRT exit B' }
  const endOf = (areaId, label, own) => (areaId ? { areaId, label: own && label ? label : '' } : null)

  // What the Locate step reads of one session, from the rows read for it: where each member starts and ends (areas), the
  // meeting area once a spot is confirmed, the spots with who suggested and who approved them, and the banner. `planning`
  // holds the rows of spots, suggestions, approvals and the person's own places for all sessions read together.
  // How to call: planningOf(row, memberRows, planning, 'me-id') -> { locations, meeting, spots, banner, spotsStale: '' }
  function planningOf(row, memberRows, planning, mine) {
    const sid = row.id
    const members = memberRows.filter((m) => m.session_id === sid)
    const joined = new Set(members.filter((m) => m.state === 'joined').map((m) => m.user_id))
    const own = planning.places.find((p) => p.session_id === sid)
    const locations = {}
    for (const m of members) {
      if (!m.start_area_id && !m.end_area_id) continue
      const me = m.user_id === mine
      locations[m.user_id] = { start: endOf(m.start_area_id, own?.start_label, me), end: endOf(m.end_area_id, own?.end_label, me) }
    }
    const byTime = (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.user_id).localeCompare(String(b.user_id))
    const suggestionRows = planning.suggestions.filter((x) => x.session_id === sid).sort(byTime)
    const suggestions = Object.fromEntries(suggestionRows.map((x) => [x.user_id, { areaId: x.area_id, here: !!x.here }]))
    const approvals = {}
    for (const x of planning.approvals.filter((a) => a.session_id === sid).sort(byTime)) (approvals[x.user_id] ||= []).push(x.area_id)
    // The app's spots by rank, then each suggested area that is not one of them, the oldest suggestion first.
    const spotRows = planning.spots.filter((x) => x.session_id === sid)
    const apps = spotRows.filter((x) => x.rank != null).sort((a, b) => a.rank - b.rank)
    const suggestedAt = (areaId) => suggestionRows.findIndex((x) => x.area_id === areaId)
    const others = spotRows.filter((x) => x.rank == null).sort((a, b) => (suggestedAt(a.area_id) - suggestedAt(b.area_id)) || a.area_id.localeCompare(b.area_id))
    const spotOf = (x) => {
      const times = Object.fromEntries(Object.entries(x.travel_minutes || {}).filter(([id]) => joined.has(id)).map(([id, m]) => [id, minutesOf(m)]))
      const minutes = Object.values(times)
      const suggesters = suggestionRows.filter((y) => y.area_id === x.area_id)
      return {
        areaId: x.area_id,
        by: x.rank != null || !suggesters.length ? 'app' : suggesters[0].user_id,
        here: suggesters.some((y) => y.here),
        worstMinutes: minutes.length ? Math.max(...minutes) : null,
        meanMinutes: minutes.length ? Math.round(minutes.reduce((sum, m) => sum + m, 0) / minutes.length) : null,
        // The unrounded longest trip: the screens round, but the preselection's tie-break never does.
        exactWorst: minutes.length ? Math.max(...Object.entries(x.travel_minutes).filter(([id]) => joined.has(id)).map(([, m]) => Number(m))) : null,
        times,
        approximate: !!x.approximate,
      }
    }
    const list = [...apps, ...others].map(spotOf)
    const located = members.filter((m) => m.state === 'joined' && m.start_area_id)
    const sameStart = located.length > 0 && located.every((m) => m.start_area_id === located[0].start_area_id)
    const spots = { list, approvals, suggestions, appMethod: apps.length ? (sameStart ? 'same' : 'fairest') : null }
    // Once a spot is confirmed: the meeting area, with each person's trip to it from the spot kept as the record, otherwise
    // from the minutes on their member row.
    let meeting = null
    if (row.meeting_area_id) {
      const kept = list.find((x) => x.areaId === row.meeting_area_id)
      // The minutes on the members' rows are the newest (the server writes them whenever it prices the confirmed area again, as a start
      // changes while voting); the spot kept as the record fills in anyone whose row has none.
      const onRows = Object.fromEntries(members.filter((m) => m.state === 'joined' && m.travel_minutes != null).map((m) => [m.user_id, minutesOf(m.travel_minutes)]))
      const times = { ...(kept ? kept.times : {}), ...onRows }
      const minutes = Object.values(times)
      meeting = {
        areaId: row.meeting_area_id,
        method: row.meeting_method || 'chosen',
        times,
        maxMinutes: row.meeting_max_minutes ?? (minutes.length ? Math.max(...minutes) : 0),
        totalMinutes: row.meeting_total_minutes ?? minutes.reduce((sum, m) => sum + m, 0),
        count: row.meeting_count ?? minutes.length,
        approximate: !!row.meeting_approximate,
      }
    }
    // A start changed and the spots were not worked out again (the call to the server never came): the newest change to the row
    // of a member who has shared a start is later than the newest time any spot was priced. Only two shared starts have anything
    // to price, and a person without a start (a late joiner, say) changes nothing that is priced, so their row is not looked at.
    const newest = (rows, field) => Math.max(0, ...rows.map((x) => Date.parse(x[field]) || 0))
    const changed = newest(located, 'updated_at')
    const stale = row.status === 'locating' && located.length >= 2 && (!spotRows.length || changed > newest(spotRows, 'computed_at'))
    // The time of that change as text (it names the gap, so a screen asks the server once for each), or '' when there is none.
    return { locations, meeting, spots, banner: row.banner && typeof row.banner === 'object' ? { ...row.banner } : null, spotsStale: stale ? String(changed) : '' }
  }

  // The minutes after midnight of a time of day, or null. How to call: minutesOfTime('18:30:00') -> 1110
  const minutesOfTime = (time) => (time == null || time === '' ? null : toMinutes(String(time).slice(0, 5)))

  // The votes of some rows as the screens keep them, by slot and then by person, the newest last so a person's latest stands. Rows for a
  // slot that is not in `slotIds` are left out.
  // How to call: votesBySlot([{ slot_id: '9a2c...', user_id: 'u1', venue_id: 'v25', updated_at: '2026-10-20T10:00:00Z' }], new Set(['9a2c...'])) -> { '9a2c...': { u1: 'v25' } }
  function votesBySlot(rows, slotIds) {
    const votes = {}
    const byTime = (a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) || String(a.user_id).localeCompare(String(b.user_id))
    for (const v of rows.filter((x) => slotIds.has(x.slot_id)).sort(byTime)) (votes[v.slot_id] ||= {})[v.user_id] = v.venue_id
    return votes
  }

  // What the Vote page reads of one session, from the rows read for it: the slots (one per category, in the order they happen),
  // the places offered in each (the best first), the votes, each person's picks, the categories the host removed and the radius.
  // Another member's place is not in any of these: only categories, how long they can stay, and their votes.
  // How to call: planOf(row, memberRows, planning) -> { slotRows, optionRows, options, votes, prefs, deletedSlots, radius }
  function planOf(row, memberRows, planning) {
    const sid = row.id
    const slotRows = planning.slots
      .filter((x) => x.session_id === sid)
      .sort((a, b) => a.start_minute - b.start_minute || a.category.localeCompare(b.category))
      .map((x) => ({
        id: x.id,
        category: x.category,
        start: x.start_minute,
        time: fromMinutes(x.start_minute),
        duration: x.duration_minutes,
        picks: x.picks ?? 0,
        isLast: !!x.is_last,
        deleted: !!x.deleted,
        details: x.details && typeof x.details === 'object' ? x.details : {},
      }))
    const slotIds = new Set(slotRows.map((x) => x.id))
    // The best first: the planner's rank (a place a member added has none yet), then its score, which is a penalty.
    const byRank = (a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (a.score ?? 1e9) - (b.score ?? 1e9) || a.venue_id.localeCompare(b.venue_id)
    const optionRows = {}
    for (const slot of slotRows) {
      optionRows[slot.id] = planning.options
        .filter((o) => o.slot_id === slot.id)
        .sort(byRank)
        .map((o) => ({ venueId: o.venue_id, rank: o.rank ?? null, score: o.score == null ? null : Number(o.score), source: o.source, addedBy: o.added_by ?? null, details: o.details && typeof o.details === 'object' ? o.details : {} }))
    }
    // Only the votes of people who are in the session count: a vote can outlive its person for a moment (it was cast as they opted out),
    // and the server clears it with its next write to the slots. Whatever tallies votes for a screen reads these.
    const joinedIds = new Set(memberRows.filter((x) => x.session_id === sid && x.state === 'joined').map((x) => x.user_id))
    const votes = votesBySlot(planning.votes.filter((v) => joinedIds.has(v.user_id)), slotIds)
    const prefs = {}
    for (const m of memberRows.filter((x) => x.session_id === sid && x.state === 'joined')) {
      const until = minutesOfTime(m.stay_until)
      if ((m.categories || []).length || until != null) prefs[m.user_id] = { categories: [...(m.categories || [])], until }
    }
    return {
      slotRows,
      optionRows,
      options: Object.fromEntries(slotRows.map((x) => [x.id, optionRows[x.id].map((o) => o.venueId)])),
      votes,
      prefs,
      deletedSlots: slotRows.filter((x) => x.deleted).map((x) => x.category),
      radius: row.radius_meters ?? null,
    }
  }

  // What the itinerary and the Roam page read of one session, from the rows read for it: the plan (the stops in order, how the group gets to
  // each from the one before, when the plan starts, and the sentence about the order with who chose it), the "Re-plan?" question, the
  // places members have put forward, and how the outing ended. The plan is the local data layer's own shape, `{ stops, modes, startAt,
  // aiNote }`, so the rules that lay the itinerary out run on it unchanged; each stop also carries its row's `stopId`. A stop made from a
  // proposal has no slot (`slot_id` is null) and is named `roam-<id>`, as the local layer names it. It is a plan only once confirmed.
  // How to call: outingOf(row, planning) -> { plan, replan, proposals, endedBy, completedAt }
  function outingOf(row, planning) {
    const sid = row.id
    const rows = planning.stops.filter((x) => x.session_id === sid).sort((a, b) => a.seq - b.seq)
    const stops = rows.map((x) => ({
      stopId: x.id,
      slotId: x.slot_id ?? `roam-${x.id}`,
      category: x.category,
      venueId: x.venue_id,
      plannedStart: x.planned_start_minute,
      duration: x.duration_minutes,
      ...(x.not_before_minute != null ? { notBefore: x.not_before_minute } : {}),
    }))
    const noted = typeof row.order_reason === 'string' && row.order_reason && ['ai', 'rules'].includes(row.order_source)
    const plan = ['confirmed', 'completed'].includes(row.status) && stops.length
      ? { stops, modes: rows.slice(1).map((x) => x.travel_mode ?? undefined), startAt: row.plan_start_minute ?? null, aiNote: noted ? { reason: row.order_reason, source: row.order_source } : null }
      : null
    // The question the server asks after a change to a confirmed plan. Whatever else it holds, the screens read only the sentence.
    const asked = row.replan && typeof row.replan === 'object' && !Array.isArray(row.replan) ? row.replan : null
    const replan = row.status === 'confirmed' && asked ? { reason: typeof asked.reason === 'string' && asked.reason ? asked.reason : 'The group changed.', trigger: asked.trigger ?? null } : null
    // The rain warnings the host kept (`sessions.weather_kept`, by stop id), as the screens read them: by the stop's slot id, with the forecast's
    // state it was kept in. Only for the confirmed plan's own stops.
    const kept = row.weather_kept && typeof row.weather_kept === 'object' && !Array.isArray(row.weather_kept) ? row.weather_kept : {}
    const weatherDismissed = row.status === 'confirmed' ? Object.fromEntries(stops.filter((x) => typeof kept[x.stopId] === 'string').map((x) => [x.slotId, kept[x.stopId]])) : {}
    const proposals = planning.proposals
      .filter((x) => x.session_id === sid)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
      .map((x) => ({ id: x.id, venueId: x.venue_id, by: x.proposed_by, at: Date.parse(x.created_at) }))
    return {
      plan,
      replan,
      ...(Object.keys(weatherDismissed).length > 0 ? { weatherDismissed } : {}),
      proposals: row.status === 'confirmed' ? proposals : [],
      ...(row.status === 'completed' ? { endedBy: 'hand', completedAt: row.completed_at ? Date.parse(row.completed_at) : null } : {}),
    }
  }

  // A session as the screens keep it, from its rows. The host first, then the people who joined in the order they came, then
  // the people invited by name who have not answered (only while the session is inviting: when it starts, invitations nobody
  // answered lapse). A person who opted out stays on the list in that state.
  // How to call: toSession(row, memberRows, inviteRows, planning)
  function toSession(row, memberRows, inviteRows, planning = NO_PLANNING) {
    const joined = memberRows
      .filter((m) => m.session_id === row.id)
      .sort((a, b) => (a.role === 'host' ? -1 : b.role === 'host' ? 1 : String(a.joined_at).localeCompare(String(b.joined_at))))
      .map((m) => ({ id: m.user_id, role: m.role, state: m.state }))
    const invited = row.status !== 'inviting' ? [] : inviteRows
      .filter((i) => i.session_id === row.id && i.invitee_id && pending(i, now()) && !joined.some((m) => m.id === i.invitee_id))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((i) => ({ id: i.invitee_id, role: 'guest', state: 'invited' }))
    return {
      id: row.id,
      title: row.title,
      date: row.date,
      start: hhmm(row.start_time),
      end: hhmm(row.end_time),
      hostId: row.host_id,
      status: row.status,
      // How the host chose to pick the meeting point ('fairest' or 'known'); null on a session that started before the choice.
      meetBy: row.meet_by || null,
      createdAt: Date.parse(row.created_at),
      updatedAt: Date.parse(row.updated_at),
      members: [...joined, ...invited],
      planVersion: Number(row.plan_version) || 0,
      ...planningOf(row, memberRows, planning, me()),
      ...planOf(row, memberRows, planning),
      ...outingOf(row, planning),
      remote: true,
    }
  }

  // The most session ids in one read.
  const CHUNK = 100
  // How many channels this factory has opened, for their topics.
  let opened = 0
  const SESSION_COLUMNS = 'id, host_id, title, date, start_time, end_time, status, meet_by, created_at, updated_at, plan_version, radius_meters, meeting_area_id, meeting_method, meeting_max_minutes, meeting_total_minutes, meeting_count, meeting_approximate, banner, replan, completed_at, order_reason, order_source, plan_start_minute, weather_kept'
  const MEMBER_COLUMNS = 'session_id, user_id, role, state, joined_at, start_area_id, end_area_id, travel_minutes, updated_at, categories, stay_until'
  // `details` is what the planner said of a slot or a place, and only the Vote page's cards read it, so the reads that Home and the
  // session screens use (list, get) leave it out; readPlan has it.
  const SLOT_COLUMNS = 'id, session_id, category, start_minute, duration_minutes, picks, is_last, deleted'
  const OPTION_COLUMNS = 'slot_id, venue_id, rank, score, source, added_by'
  const WITH_DETAILS = (columns) => `${columns}, details`
  const VOTE_COLUMNS = 'slot_id, user_id, venue_id, updated_at'
  const INVITE_COLUMNS = 'session_id, invitee_id, revoked, declined_at, uses, expires_at, created_at'
  // The itinerary and the proposals waiting. A stop's `travel_mode` is how the group gets to it from the stop before.
  const STOP_COLUMNS = 'id, session_id, seq, slot_id, category, venue_id, planned_start_minute, duration_minutes, travel_mode, not_before_minute'
  const PROPOSAL_COLUMNS = 'id, session_id, venue_id, proposed_by, created_at'
  const LEDGER_COLUMNS = 'session_id, minutes_in, minutes_between, minutes_home, total_minutes, delta_from_mean'
  const SPOT_COLUMNS = 'session_id, area_id, rank, worst_minutes, mean_minutes, travel_minutes, approximate, computed_at'
  const SUGGESTION_COLUMNS = 'session_id, user_id, area_id, here, created_at'
  const APPROVAL_COLUMNS = 'session_id, area_id, user_id, created_at'
  // The person's own two labels, never the coordinates behind them.
  const PLACE_LABELS = 'session_id, start_label, end_label'

  // The rows of spots, suggestions, approvals and the person's own places for the sessions that have got past inviting, a
  // hundred sessions at a time. The exact places are asked for with the person's own id, so only their own row is ever read.
  // How to call: const planning = await readPlanning(['3b1f...'])
  async function readPlanning(ids, planIds = [], { details = false, outing = [] } = {}) {
    if (!ids.length) return NO_PLANNING
    const mine = who()
    const chunks = []
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
    const all = async (build) => (await Promise.all(chunks.map(build))).flatMap((answered) => answer(answered, WORDS.notLoaded))
    const [spots, suggestions, approvals, places, plan, made] = await Promise.all([
      all((chunk) => db().from('session_spots').select(SPOT_COLUMNS).in('session_id', chunk)),
      all((chunk) => db().from('spot_suggestions').select(SUGGESTION_COLUMNS).in('session_id', chunk)),
      all((chunk) => db().from('spot_approvals').select(APPROVAL_COLUMNS).in('session_id', chunk)),
      all((chunk) => db().from('session_member_places').select(PLACE_LABELS).eq('user_id', mine).in('session_id', chunk)),
      readPlanRows(planIds, { details }),
      readOuting(outing),
    ])
    return { spots, suggestions, approvals, places, ...plan, ...made }
  }

  // The stops of some sessions and the places waiting to be added to them, a hundred sessions at a time. Pending proposals only: one that
  // was answered is a stop, or was left out.
  // How to call: const { stops, proposals } = await readOuting(['3b1f...'])
  async function readOuting(sessionIds) {
    if (!sessionIds.length) return { stops: [], proposals: [] }
    const chunks = []
    for (let i = 0; i < sessionIds.length; i += CHUNK) chunks.push(sessionIds.slice(i, i + CHUNK))
    const all = async (build) => (await Promise.all(chunks.map(build))).flatMap((answered) => answer(answered, WORDS.notLoaded))
    const [stops, proposals] = await Promise.all([
      all((chunk) => db().from('stops').select(STOP_COLUMNS).in('session_id', chunk)),
      all((chunk) => db().from('stop_proposals').select(PROPOSAL_COLUMNS).eq('status', 'pending').in('session_id', chunk)),
    ])
    return { stops, proposals }
  }

  // The slots of some sessions, then the places offered in them and the votes for them, a hundred at a time (the votes by the rows they
  // can come to, see readVotes). Two steps, because the places and votes hang on a slot and not on a session. Nothing here names a
  // person's place. `details` also reads what the planner said of each slot and place, which only the Vote page's cards need.
  // How to call: const { slots, options, votes } = await readPlanRows(['3b1f...'], { details: true })
  async function readPlanRows(sessionIds, { details = false } = {}) {
    if (!sessionIds.length) return { slots: [], options: [], votes: [] }
    const chunked = (list) => {
      const chunks = []
      for (let i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK))
      return chunks
    }
    const all = async (build, list) => (await Promise.all(chunked(list).map(build))).flatMap((answered) => answer(answered, WORDS.notLoaded))
    const slotColumns = details ? WITH_DETAILS(SLOT_COLUMNS) : SLOT_COLUMNS
    const optionColumns = details ? WITH_DETAILS(OPTION_COLUMNS) : OPTION_COLUMNS
    const slots = await all((chunk) => db().from('slots').select(slotColumns).in('session_id', chunk), sessionIds)
    if (!slots.length) return { slots, options: [], votes: [] }
    const slotIds = slots.map((x) => x.id)
    const [options, votes] = await Promise.all([
      all((chunk) => db().from('slot_options').select(optionColumns).in('slot_id', chunk), slotIds),
      readVotes(slotIds),
    ])
    return { slots, options, votes }
  }

  // The most rows one read answers: the project's API cuts an answer off at 1,000 rows without saying so.
  const ROW_CAP = 1000
  // The most slots one votes read starts with. A session holds up to 30 people and 4 slots, so a slot has up to 30 votes (a few more
  // while a person who has just left is cleaned up): 25 slots come to about 750 rows, under the cap. A read that still comes back full
  // is split in two and read again (readVotes), so a vote is never dropped silently.
  const VOTE_SLOTS = 25

  // The votes of some slots, read so that none is lost to the row cap: in groups of VOTE_SLOTS slots, and any group whose answer reaches
  // the cap is halved and read again until it fits (a single slot cannot reach it).
  // How to call: const rows = await readVotes(['9a2c...', '7e11...']) -> [{ slot_id, user_id, venue_id, updated_at }]
  async function readVotes(slotIds) {
    const read = async (ids) => {
      const rows = answer(await db().from('votes').select(VOTE_COLUMNS).in('slot_id', ids), WORDS.notLoaded)
      if (rows.length < ROW_CAP || ids.length === 1) return rows
      const half = Math.ceil(ids.length / 2)
      return [...(await read(ids.slice(0, half))), ...(await read(ids.slice(half)))]
    }
    const reads = []
    for (let i = 0; i < slotIds.length; i += VOTE_SLOTS) reads.push(read(slotIds.slice(i, i + VOTE_SLOTS)))
    return (await Promise.all(reads)).flat()
  }

  // The votes of a session's slots, as the screens keep them ({ [slotId]: { [personId]: venueId } }), and nothing else: the one read a
  // live vote needs. Resolves them for exactly the slots given, and only the votes of the people given (the ones who are in the session).
  // How to call: const votes = await readSlotVotes(['9a2c...'], ['u1']) -> { '9a2c...': { u1: 'v25' } }
  async function readSlotVotes(slotIds, joinedIds) {
    who()
    const people = new Set(joinedIds)
    return votesBySlot((await readVotes(slotIds)).filter((v) => people.has(v.user_id)), new Set(slotIds))
  }

  // The sessions that can have spots to read: all but one still inviting.
  // How to call: planned(rows) -> ['3b1f...']
  const planned = (rows) => rows.filter((r) => r.status !== 'inviting').map((r) => r.id)
  // The sessions that can have slots, places and votes to read: those the group is voting in or has gone on from.
  // How to call: withPlan(rows) -> ['3b1f...']
  const withPlan = (rows) => rows.filter((r) => ['voting', 'confirmed', 'completed'].includes(r.status)).map((r) => r.id)
  // The sessions that can have stops and proposals to read: those the plan is confirmed for, or the outing has finished.
  // How to call: withOuting(rows) -> ['3b1f...']
  const withOuting = (rows) => rows.filter((r) => ['confirmed', 'completed'].includes(r.status)).map((r) => r.id)

  // Every session the person is in, newest first, in a few reads for all of them.
  // How to call: const sessions = await list()
  async function list() {
    who()
    const rows = answer(await db().from('sessions').select(SESSION_COLUMNS).order('created_at', { ascending: false }), WORDS.notLoaded)
    if (!rows.length) return []
    const ids = rows.map((r) => r.id)
    // The ids go in the address of each read, so a long list is read a hundred sessions at a time.
    const chunks = []
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
    const [members, invites, planning] = await Promise.all([
      Promise.all(chunks.map((chunk) => db().from('session_members').select(MEMBER_COLUMNS).in('session_id', chunk))),
      Promise.all(chunks.map((chunk) => db().from('invites').select(INVITE_COLUMNS).in('session_id', chunk))),
      readPlanning(planned(rows), withPlan(rows), { details: false, outing: withOuting(rows) }),
    ])
    const memberRows = members.flatMap((answered) => answer(answered, WORDS.notLoaded))
    const inviteRows = invites.flatMap((answered) => answer(answered, WORDS.notLoaded))
    return rows.map((r) => toSession(r, memberRows, inviteRows, planning))
  }

  // One session, or a plain "does not exist" for one that is not there or is not the person's.
  // How to call: const session = await get('3b1f...')
  async function get(id) {
    who()
    // An id that is not a uuid is not a session (the database would call it a type error, not "not found").
    if (!isUuid(id)) throw Object.assign(new Error('This session does not exist.'), { code: 'not_found' })
    const [found, members, invites] = await Promise.all([
      db().from('sessions').select(SESSION_COLUMNS).eq('id', id).maybeSingle(),
      db().from('session_members').select(MEMBER_COLUMNS).eq('session_id', id),
      db().from('invites').select(INVITE_COLUMNS).eq('session_id', id),
    ])
    const row = answer(found, WORDS.notLoaded)
    if (!row) throw Object.assign(new Error('This session does not exist.'), { code: 'not_found' })
    const planning = await readPlanning(planned([row]), withPlan([row]), { details: false, outing: withOuting([row]) })
    return toSession(row, answer(members, WORDS.notLoaded), answer(invites, WORDS.notLoaded), planning)
  }

  // What the Vote page needs of one session, read afresh and without the people, invites or spots: the version it was read at, the
  // status, the meeting area, the radius, the host, and the slots with their places and votes. Reading it asks the planner nothing.
  // A session that is not there, or not the person's, is "does not exist".
  // How to call: const read = await readPlan('3b1f...') -> { version, status, hostId, meetingAreaId, banner, joined, ...planOf }
  async function readPlan(id) {
    who()
    if (!isUuid(id)) throw Object.assign(new Error('This session does not exist.'), { code: 'not_found' })
    const [found, members] = await Promise.all([
      db().from('sessions').select('id, host_id, status, plan_version, radius_meters, meeting_area_id, start_time, end_time').eq('id', id).maybeSingle(),
      db().from('session_members').select('session_id, user_id, state, categories, stay_until').eq('session_id', id),
    ])
    const row = answer(found, WORDS.notLoaded)
    if (!row) throw Object.assign(new Error('This session does not exist.'), { code: 'not_found' })
    const memberRows = answer(members, WORDS.notLoaded)
    const planning = { ...NO_PLANNING, ...(await readPlanRows(withPlan([row]), { details: true })) }
    return {
      version: Number(row.plan_version) || 0,
      status: row.status,
      hostId: row.host_id,
      meetingAreaId: row.meeting_area_id ?? null,
      start: hhmm(row.start_time),
      end: hhmm(row.end_time),
      joined: memberRows.filter((m) => m.state === 'joined').map((m) => m.user_id),
      ...planOf(row, memberRows, planning),
    }
  }

  // A new session; the database adds the host's own member row. `fields` are already checked (title, date, start, end).
  // How to call: const session = await create({ title: 'Dinner', date: '2026-10-17', start: '18:00', end: '21:00' })
  async function create({ title, date, start, end }) {
    const host = who()
    const row = answer(
      await db().from('sessions').insert({ host_id: host, title, date, start_time: start, end_time: end }).select('id').single(),
      WORDS.notSaved,
    )
    return get(row.id)
  }

  // The host changes the title, day and times (the database allows it only while the session is inviting).
  // How to call: await update('3b1f...', { title: 'Dinner', date: '2026-10-17', start: '18:00', end: '21:00' })
  async function update(id, { title, date, start, end }) {
    who()
    const rows = answer(await db().from('sessions').update({ title, date, start_time: start, end_time: end }).eq('id', id).select('id'), WORDS.notSaved)
    if (!rows.length) throw Object.assign(new Error('Only the host can change a session.'), { code: 'host_only' })
    return get(id)
  }

  // The host calls the session off. Only the host's update reaches the row; anyone else changes nothing.
  // How to call: await cancel('3b1f...')
  async function cancel(id) {
    who()
    const rows = answer(await db().from('sessions').update({ status: 'cancelled' }).eq('id', id).select('id'), WORDS.notSaved)
    if (!rows.length) throw Object.assign(new Error('Only the host can cancel a session.'), { code: 'host_only' })
    return get(id)
  }

  // The host starts the session: it goes from inviting to locating, where people say where they start and the group chooses where
  // to meet. The database allows it only to the host, and only with two joined people; its sentence says so. `meetBy` ('fairest' or
  // 'known') is the host's choice of how to pick the meeting point, written in the same update; left out, nothing is written for it.
  // How to call: await start('3b1f...', { meetBy: 'known' })
  async function start(sessionId, { meetBy } = {}) {
    who()
    const values = meetBy ? { status: 'locating', meet_by: meetBy } : { status: 'locating' }
    // Only a session that is still inviting: a stale device cannot rewrite the choice of one that started on another.
    const rows = answer(await db().from('sessions').update(values).eq('id', sessionId).eq('status', 'inviting').select('id'), WORDS.notSaved)
    if (!rows.length) throw Object.assign(new Error('Only the host can start a session, and only once.'), { code: 'host_only' })
  }

  // ── Invite links ──────────────────────────────────────────────────────────

  // The session's link as the host sees it: { token, expiresAt, expired }, or null when there is none. A link the host
  // revoked is not a link. The database allows one that is not revoked per session, even after it has expired.
  // How to call: const link = await currentLink('3b1f...')
  async function currentLink(sessionId) {
    who()
    const rows = answer(
      await db().from('invites').select('token, expires_at, created_at').eq('session_id', sessionId).is('invitee_id', null).eq('revoked', false),
      WORDS.notLoaded,
    )
    const [row] = rows
    return row ? { token: row.token, expiresAt: Date.parse(row.expires_at), expired: Date.parse(row.expires_at) <= now() } : null
  }

  // Make the link, or hand back the one that is live. A link that has expired is turned off first, because the database
  // counts it as the session's one link until it is revoked. Two devices making one at once end up with the same link.
  // How to call: const link = await makeLink('3b1f...')
  async function makeLink(sessionId) {
    const mine = who()
    const have = await currentLink(sessionId)
    if (have && !have.expired) return have
    if (have) await revoke(sessionId)
    const { data, error } = await db().from('invites').insert({ session_id: sessionId, created_by: mine }).select('token, expires_at').single()
    if (error) {
      // Another device made it a moment ago: the one it made is the link.
      if (error.code === '23505') {
        const again = await currentLink(sessionId)
        if (again && !again.expired) return again
      }
      throw plain(error, WORDS.notSaved)
    }
    return { token: data.token, expiresAt: Date.parse(data.expires_at), expired: false }
  }

  // Turn the session's link off for good. A person who opens it afterwards is told it no longer works.
  // How to call: await revoke('3b1f...')
  async function revoke(sessionId) {
    who()
    answer(await db().from('invites').update({ revoked: true }).eq('session_id', sessionId).is('invitee_id', null).eq('revoked', false).select('token'), WORDS.notSaved)
  }

  // ── Invitations to one named person ───────────────────────────────────────

  // The host invites a person by id; they see it on Home and answer it.
  // How to call: await invitePerson('3b1f...', '7f3c...')
  async function invitePerson(sessionId, personId) {
    const mine = who()
    answer(await db().from('invites').insert({ session_id: sessionId, created_by: mine, invitee_id: personId }).select('token').single(), WORDS.notSaved)
  }

  // ── What the person who opens a link or invitation does ──────────────────

  // What a link leads to, for anyone, signed in or not: { title, date, start, end, hostName }, or null when the link does not
  // work for this caller. A made-up token is not sent.
  // How to call: const preview = await preview('q3D9...')
  async function preview(token) {
    if (!looksLikeToken(token)) return null
    const rows = answer(await db().rpc('invite_preview', { invite_token: token }), WORDS.offline)
    const row = Array.isArray(rows) ? rows[0] : null
    return row ? { title: row.title, date: row.date, start: hhmm(row.start_time), end: hhmm(row.end_time), hostName: row.host_name || '' } : null
  }

  // Join with a link or an invitation. `already` is true when the person was in the session before: the database then leaves
  // them as they are. Rejects with the sentence for the way it failed.
  // How to call: const { sessionId, already } = await join('q3D9...')
  async function join(token) {
    who()
    if (!looksLikeToken(token)) throw Object.assign(new Error(WORDS.linkDead), { code: 'P0002' })
    const before = answer(await db().from('sessions').select('id'), WORDS.offline).map((s) => s.id)
    const sessionId = answer(await db().rpc('join_session', { invite_token: token }), WORDS.notSaved)
    return { sessionId, already: before.includes(sessionId) }
  }

  // The open invitations addressed to the person, newest first.
  // How to call: const invitations = await invitations()
  async function invitations() {
    who()
    const rows = answer(await db().rpc('my_invitations'), WORDS.notLoaded)
    return (rows || []).map((r) => ({ token: r.token, title: r.title, date: r.date, start: hhmm(r.start_time), end: hhmm(r.end_time), hostName: r.host_name || '', invitedAt: Date.parse(r.invited_at) }))
  }

  // Say no to an invitation.
  // How to call: await decline('q3D9...')
  async function decline(token) {
    who()
    answer(await db().rpc('decline_invite', { invite_token: token }), WORDS.notSaved)
  }

  // ── Leaving and removing: through the Jio server ──────────────────────────

  // A member leaves, or the host removes a guest (`personId`). Rejects with a sentence.
  // How to call: await removeMember('3b1f...', 'me') ; await removeMember('3b1f...', '7f3c...')
  async function removeMember(sessionId, personId = 'me') {
    who()
    try {
      return await backend.removeMember(sessionId, personId === me() ? 'me' : personId)
    } catch (err) {
      // Someone being taken out is not "leaving": the sentence for a session that has gone on says what the person did.
      const leaving = personId === me() || personId === 'me'
      throw problem(err, { host_only: WORDS.hostOnlyRemove, ...(leaving ? {} : { session_started: WORDS.startedRemove }) })
    }
  }

  // ── Where people start, and the meeting spots ─────────────────────────────

  // Change one end of the person's own route (`which`: 'start' or 'end'): the area on their member row, which the group sees,
  // and the label of the exact place in `session_member_places`, which only they and the server can read. No coordinates are
  // written: travel times are worked out from the area (design question 1). `place` is { areaId, label }, or null to clear.
  // Resolves with what it replaced, for putting back (see restorePlace) and for telling a first start from a change; `written`
  // holds the values this call wrote, which restorePlace needs to take back only its own change.
  // The exact place goes first, because a label with no area shows nothing, while an area with no label shows its name.
  // How to call: const before = await setPlace('3b1f...', 'start', { areaId: 'bugis', label: 'Bugis Junction' })
  async function setPlace(sessionId, which, place) {
    const mine = who()
    const areaColumn = which === 'end' ? 'end_area_id' : 'start_area_id'
    const labelColumn = which === 'end' ? 'end_label' : 'start_label'
    const [memberRead, placeRead] = await Promise.all([
      db().from('session_members').select('start_area_id, end_area_id').eq('session_id', sessionId).eq('user_id', mine).maybeSingle(),
      db().from('session_member_places').select(labelColumn).eq('session_id', sessionId).eq('user_id', mine).maybeSingle(),
    ])
    const member = answer(memberRead, WORDS.notSaved)
    if (!member) throw Object.assign(new Error(WORDS.notIn), { code: 'not_joined' })
    const had = answer(placeRead, WORDS.notSaved)
    const label = place ? String(place.label || '').slice(0, 120) || null : null
    const before = {
      which,
      areaId: member[areaColumn] ?? null,
      label: had?.[labelColumn] ?? null,
      hadStart: !!member.start_area_id,
      written: { areaId: place ? place.areaId : null, label },
    }
    try {
      await writePlace(sessionId, which, before.written.areaId, label)
    } catch (err) {
      await restorePlace(sessionId, before)
      throw err
    }
    return before
  }

  // The two writes of setPlace. How to call: await writePlace('3b1f...', 'start', 'bugis', 'Bugis Junction')
  async function writePlace(sessionId, which, areaId, label) {
    const mine = who()
    const areaColumn = which === 'end' ? 'end_area_id' : 'start_area_id'
    const labelColumn = which === 'end' ? 'end_label' : 'start_label'
    const updated = answer(
      await db().from('session_member_places').update({ [labelColumn]: label }).eq('session_id', sessionId).eq('user_id', mine).select('session_id'),
      WORDS.notSaved,
    )
    if (!updated.length && label !== null) {
      answer(await db().from('session_member_places').insert({ session_id: sessionId, user_id: mine, [labelColumn]: label }), WORDS.notSaved)
    }
    const rows = answer(await db().from('session_members').update({ [areaColumn]: areaId }).eq('session_id', sessionId).eq('user_id', mine).select('user_id'), WORDS.notSaved)
    // The rules filter the rows a person may change: none left means they are out, or the group has moved past this.
    if (!rows.length) throw Object.assign(new Error(WORDS.startClosed), { code: 'start_closed' })
  }

  // Put one end of the person's route back as `before` (what setPlace answered). It takes back only their own change: each of
  // the two values is put back only where the database still holds the value this call wrote (`before.written`), so a newer
  // value from a second quick change or another device stays. It never fails: it is the repair for a failure, and the failure
  // is the one worth reading.
  // How to call: await restorePlace('3b1f...', before)
  async function restorePlace(sessionId, before) {
    try {
      const mine = who()
      const areaColumn = before.which === 'end' ? 'end_area_id' : 'start_area_id'
      const labelColumn = before.which === 'end' ? 'end_label' : 'start_label'
      // A null needs `is`: `eq` never matches it.
      const only = (query, column, value) => (value == null ? query.is(column, null) : query.eq(column, value))
      const { written } = before
      await only(db().from('session_members').update({ [areaColumn]: before.areaId }).eq('session_id', sessionId).eq('user_id', mine), areaColumn, written.areaId).select('user_id')
      await only(db().from('session_member_places').update({ [labelColumn]: before.label }).eq('session_id', sessionId).eq('user_id', mine), labelColumn, written.label).select('session_id')
    } catch {
      // The next read shows what is stored.
    }
  }

  // "Works for me": the person's own approval of a spot, or taking it back (`on: false`). A direct write under the database's
  // rules (the person has joined, the session is locating, the spot is listed). Approving twice is one approval.
  // How to call: await approve('3b1f...', 'bugis', true)
  async function approve(sessionId, areaId, on = true) {
    const mine = who()
    if (!on) {
      const removed = answer(await db().from('spot_approvals').delete().eq('session_id', sessionId).eq('area_id', areaId).eq('user_id', mine).select('user_id'), WORDS.notSaved)
      if (removed.length) return
      // Nothing was deleted: the mark was not there (nothing to do, which is a success), or the rules would not let it go because the
      // group is no longer choosing. The spot is then confirmed (or the session is over), and the person is told so.
      const read = answer(await db().from('sessions').select('status').eq('id', sessionId).maybeSingle(), WORDS.notSaved)
      if (read && read.status !== 'locating') {
        throw Object.assign(new Error(read.status === 'voting' ? WORDS.alreadyConfirmed : WORDS.spotsClosed), { code: 'wrong_status' })
      }
      return
    }
    const { error } = await db().from('spot_approvals').insert({ session_id: sessionId, area_id: areaId, user_id: mine })
    if (!error || error.code === '23505') return
    if (error.code === '23503') throw Object.assign(new Error(WORDS.spotGone), { code: 'spot_not_found' })
    if (error.code === '42501') throw Object.assign(new Error(WORDS.spotsClosed), { code: 'wrong_status' })
    throw plain(error, WORDS.notSaved)
  }

  // A call to the Jio server for the person, with its refusal worded. `words` words a code its own way.
  // How to call: await ask(() => backend.putSpot(id, 'bugis', false), { host_only: WORDS.hostOnlyRemove })
  async function ask(call, words) {
    who()
    try {
      return await call()
    } catch (err) {
      throw problem(err, words)
    }
  }

  // Have the server work the spots out again after a start or end changed (`trigger`: 'start', 'end' or 'added'). The answer
  // is never applied here: the session is read again afterwards, and the server drops what it computed for a group that has
  // moved on.
  // How to call: await refreshSpots('3b1f...', 'start')
  const refreshSpots = (sessionId, trigger) => ask(() => backend.refreshSpots(sessionId, trigger))
  // The person suggests an area (replacing their earlier suggestion), "here already" or not.
  // How to call: await suggest('3b1f...', 'bugis', { here: true })
  const suggest = (sessionId, areaId, { here = false } = {}) => ask(() => backend.putSpot(sessionId, areaId, !!here))
  // The person takes their suggestion back. How to call: await withdraw('3b1f...')
  const withdraw = (sessionId) => ask(() => backend.deleteSpot(sessionId))
  // The host confirms a spot, or the preselected one when `areaId` is left out; the session moves to voting.
  // How to call: await confirm('3b1f...', 'bugis')
  const confirm = (sessionId, areaId) => ask(() => backend.confirmSpot(sessionId, areaId), { host_only: 'Only the host can confirm a spot.' })
  // The host names the place the group already knows. How to call: await knownPlace('3b1f...', 'bugis')
  const knownPlace = (sessionId, areaId) => ask(() => backend.knownPlace(sessionId, areaId), { host_only: 'Only the host can set a known place.', wrong_status: 'A known place can only be set before the group votes on places.' })
  // The host lets the meeting place go (from voting or confirmed): back to locating with the spots worked out again ('fairest'), or straight on
  // to voting at `areaId` ('known'). The server clears the votes, the places to vote on and the plan, and tells the group in a banner.
  // How to call: await changeMeetingPlace('3b1f...', { meetBy: 'known', areaId: 'bugis' })
  const changeMeetingPlace = (sessionId, { meetBy, areaId, planVersion }) =>
    ask(() => backend.changeMeetingPlace(sessionId, { meetBy, areaId, planVersion }), {
      host_only: 'Only the host can change the meeting place.',
      stale_plan: 'The session changed since you looked at it. Look at it again, then change the meeting place.',
      wrong_status: 'The meeting place can only be changed while the group is voting on places or has a plan.',
    })
  // The person opts out of the session (keeping their place in it), and comes back.
  // How to call: await optOut('3b1f...'); await rejoin('3b1f...')
  const optOut = (sessionId) => ask(() => backend.optOut(sessionId), { wrong_status: WORDS.closed, not_yet: WORDS.optOutClosed })
  // The server allows rejoining while inviting, locating and voting; once the plan is confirmed it answers not_yet (and wrong_status
  // after that), both worded as closed.
  const rejoin = (sessionId) => ask(() => backend.rejoin(sessionId), { wrong_status: WORDS.rejoinClosed, not_yet: WORDS.rejoinClosed })

  // ── Voting on places ──────────────────────────────────────────────────────

  // Why a vote that changed no row was turned away, in a sentence: the session is no longer voting, the person is not in it any more, or
  // the category was taken off the list. When none of those is so, nothing is wrong that the person can fix, so it is a plain failure.
  // How to call: throw await whyNoVote('3b1f...', '9a2c...')
  async function whyNoVote(sessionId, slotId) {
    const [read, slot, member] = await Promise.all([
      db().from('sessions').select('status').eq('id', sessionId).maybeSingle(),
      db().from('slots').select('deleted').eq('id', slotId).maybeSingle(),
      db().from('session_members').select('state').eq('session_id', sessionId).eq('user_id', who()).maybeSingle(),
    ])
    const status = answer(read, WORDS.notSaved)?.status
    const state = answer(member, WORDS.notSaved)?.state
    const gone = answer(slot, WORDS.notSaved)
    if (!status) return Object.assign(new Error(WORDS.noSession), { code: 'session_not_found' })
    if (['completed', 'cancelled'].includes(status)) return Object.assign(new Error(WORDS.closed), { code: 'wrong_status' })
    if (status !== 'voting') return Object.assign(new Error(WORDS.votesClosed), { code: 'wrong_status' })
    if (state !== 'joined') return Object.assign(new Error(WORDS.notIn), { code: 'not_joined' })
    if (!gone || gone.deleted) return Object.assign(new Error(WORDS.slotGone), { code: 'slot_not_found' })
    return Object.assign(new Error(WORDS.notSaved), { code: 'not_saved' })
  }

  // The person's vote in one slot: a vote for a place they have not voted for is cast (or moved from the place they voted for), and a
  // vote for the place they have voted for takes it back. A direct write under the database's rules, so the group can vote while the
  // Jio server is asleep; the rules are that the session is voting, the person has joined, the category is still there and the place is
  // still one of its options. It reads the person's own vote first, so two devices of one person agree on what a tap means; if the row
  // appears or goes between that read and the write, the write is made again for what is there now. Resolves with the place the person
  // has voted for in this slot afterwards, or null. A refusal rejects with the sentence for it (`code` `wrong_status`, `not_joined`,
  // `slot_not_found` or `option_not_found`); a write that failed for another reason rejects with `notSaved`, and the vote may or may
  // not have been kept.
  // How to call: const myVote = await castVote('3b1f...', '9a2c...', 'v25')
  async function castVote(sessionId, slotId, venueId) {
    const mine = who()
    if (!isUuid(slotId)) throw Object.assign(new Error(WORDS.slotGone), { code: 'slot_not_found' })
    const mineIn = () => db().from('votes').update({ venue_id: venueId }).eq('slot_id', slotId).eq('user_id', mine)
    for (let attempt = 0; attempt < 3; attempt++) {
      const have = answer(await db().from('votes').select('venue_id').eq('slot_id', slotId).eq('user_id', mine).maybeSingle(), WORDS.notSaved)
      if (have?.venue_id === venueId) {
        // Taking it back: only the vote for this place, so a vote that was moved from another device meanwhile stays.
        const removed = answer(await db().from('votes').delete().eq('slot_id', slotId).eq('user_id', mine).eq('venue_id', venueId).select('user_id'), WORDS.notSaved)
        if (removed.length) return null
        const fresh = answer(await db().from('votes').select('venue_id').eq('slot_id', slotId).eq('user_id', mine).maybeSingle(), WORDS.notSaved)
        if (!fresh) return null
        if (fresh.venue_id !== venueId) return fresh.venue_id
        throw await whyNoVote(sessionId, slotId)
      }
      if (have) {
        const { data, error } = await mineIn().select('user_id')
        if (error?.code === '42501') throw await whyNoVote(sessionId, slotId)
        if (error) throw voteError(error)
        if (data.length) return venueId
        const fresh = answer(await db().from('votes').select('venue_id').eq('slot_id', slotId).eq('user_id', mine).maybeSingle(), WORDS.notSaved)
        if (fresh) throw await whyNoVote(sessionId, slotId)
        continue
      }
      const { error } = await db().from('votes').insert({ slot_id: slotId, user_id: mine, venue_id: venueId })
      if (!error) return venueId
      // Cast from another device a moment ago: the write is made again as a move.
      if (error.code === '23505') continue
      // The rules turned it away: say which one (the session is over, the person is out, the category is gone).
      if (error.code === '42501') throw await whyNoVote(sessionId, slotId)
      throw voteError(error)
    }
    throw Object.assign(new Error(WORDS.notSaved), { code: 'not_saved' })
  }

  // A refused vote write as an Error with its sentence. The place is no longer an option (the foreign key), or the rules do not let
  // the person vote now (the session is not voting, they are out, the category was removed), or something else failed.
  // How to call: throw voteError({ code: '23503' })
  function voteError(error) {
    if (error.code === '23503') return Object.assign(new Error(WORDS.optionGone), { code: 'option_not_found' })
    if (error.code === '42501') return Object.assign(new Error(WORDS.votesClosed), { code: 'wrong_status' })
    return plain(error, WORDS.notSaved)
  }

  // The calls to the Jio server that change what the group is offered. Each rejects with a sentence; none changes anything here (the
  // session is read again afterwards), so a refusal needs nothing taken back.
  // How to call: await setRadius('3b1f...', 1000)
  const setRadius = (sessionId, metres) => ask(() => backend.setRadius(sessionId, metres), { host_only: WORDS.hostRadius, wrong_status: WORDS.placesClosed })
  // The host takes a category off the list and brings them back. How to call: await removeSlot('3b1f...', '9a2c...'); await restoreSlots('3b1f...')
  const removeSlot = (sessionId, slotId) => ask(() => backend.deleteSlot(sessionId, slotId), { host_only: WORDS.hostSlots, wrong_status: WORDS.placesClosed })
  const restoreSlots = (sessionId) => ask(() => backend.restoreSlots(sessionId), { host_only: WORDS.hostSlots, wrong_status: WORDS.placesClosed })
  // A member adds a place to a category. Resolves true when it was added and false when it was there already.
  // How to call: const added = await addOption('3b1f...', '9a2c...', 'v25')
  async function addOption(sessionId, slotId, venueId) {
    const answered = await ask(() => backend.addOption(sessionId, slotId, venueId), { wrong_status: WORDS.placesClosed })
    return answered?.added !== false
  }
  // A member asks for more places in a category, saying how many they are looking at. Resolves the ids added.
  // How to call: const added = await moreOptions('3b1f...', '9a2c...', 3)
  async function moreOptions(sessionId, slotId, have) {
    const answered = await ask(() => backend.moreOptions(sessionId, slotId, have), { wrong_status: WORDS.placesClosed })
    return Array.isArray(answered?.added) ? answered.added : []
  }
  // A member swaps a place for another one in a category. Resolves true when it was swapped.
  // How to call: await swapOption('3b1f...', '9a2c...', 'east-coast-park', 'toa-payoh-library')
  async function swapOption(sessionId, slotId, fromId, toId) {
    const answered = await ask(() => backend.swapOption(sessionId, slotId, fromId, toId), { wrong_status: WORDS.placesClosed })
    return answered?.swapped !== false
  }
  // Places to add to a category, found by name. Resolves [{ id, name, area, category, walk, unfit, added }]. A failure is worded.
  // How to call: const results = await searchSlot('3b1f...', '9a2c...', 'chicken rice')
  const searchSlot = (sessionId, slotId, q) => ask(() => backend.searchSlot(sessionId, slotId, q), { wrong_status: WORDS.placesClosed })
  // The server works the slots and places out again from people's picks. How to call: await syncPlan('3b1f...')
  const syncPlan = (sessionId) => ask(() => backend.syncPlan(sessionId), { wrong_status: WORDS.placesClosed })
  // Places by id for the cards (the server's E18), a failure worded. How to call: const venues = await venues(['v25'])
  const venues = (ids) => ask(() => backend.venues(ids))

  // The person's own picks for the plan: the categories they would like (up to four) and how long they can stay (minutes after midnight,
  // or null for the whole time). A direct write to their member row. Resolves what it replaced and what it wrote, for putting back
  // (see restorePrefs).
  // How to call: const before = await setPrefs('3b1f...', { categories: ['eat', 'drink'], until: 17 * 60 })
  async function setPrefs(sessionId, { categories, until }) {
    const mine = who()
    const stay = until == null ? null : `${fromMinutes(until)}:00`
    const read = answer(await db().from('session_members').select('state, categories, stay_until, updated_at').eq('session_id', sessionId).eq('user_id', mine).maybeSingle(), WORDS.notSaved)
    if (!read) throw Object.assign(new Error(WORDS.notIn), { code: 'not_joined' })
    const rows = answer(await db().from('session_members').update({ categories: [...categories], stay_until: stay }).eq('session_id', sessionId).eq('user_id', mine).select('updated_at'), WORDS.notSaved)
    if (!rows.length) throw Object.assign(new Error(WORDS.notIn), { code: 'not_joined' })
    return { categories: [...(read.categories || [])], stayUntil: read.stay_until ?? null, wroteAt: rows[0].updated_at }
  }

  // Put the person's picks back as `before` (what setPrefs resolved), only if their member row has not changed since the write: a newer
  // change of theirs (from another device) stays. It never fails: it is the repair for a failure, and the failure is the one worth reading.
  // How to call: await restorePrefs('3b1f...', before)
  async function restorePrefs(sessionId, before) {
    try {
      const mine = who()
      await db().from('session_members').update({ categories: before.categories, stay_until: before.stayUntil }).eq('session_id', sessionId).eq('user_id', mine).eq('updated_at', before.wroteAt).select('user_id')
    } catch {
      // The next read shows what is stored.
    }
  }

  // ── The plan: the suggested order, the confirm, the itinerary, finishing ──

  // The 64 hex characters of an order's basis (a hash of the winners and the session's day and times, made by the server).
  const BASIS = /^[0-9a-f]{64}$/

  // The server's suggested order as the Confirm dialog reads it, or null when the server has none to offer or its answer is not one the
  // dialog can show: `{ basis, order: [slotId], stops: [{ slotId, venueId, start }], reason, source }`. The server sends no names, categories
  // or lengths; the caller fills those in from the slots it holds. A malformed answer is no suggestion (the voted order stays), never a guess.
  // How to call: orderFrom({ status: 'ok', basis: 'a3f9...', order: ['a'], stops: [{ slotId: 'a', venueId: 'v1', start: 600 }], reason: 'Shops first.', source: 'ai' })
  function orderFrom(answered) {
    if (answered?.status !== 'ok' || !BASIS.test(String(answered.basis))) return null
    const { order, stops } = answered
    if (!Array.isArray(order) || !Array.isArray(stops) || !order.length || order.length !== stops.length || order.length > 8) return null
    const whole = stops.every((x, i) => x && typeof x.slotId === 'string' && x.slotId === order[i] && typeof x.venueId === 'string' && Number.isFinite(x.start) && x.start >= 0 && x.start < 2880)
    if (!whole || new Set(order).size !== order.length) return null
    return {
      basis: answered.basis,
      order: [...order],
      stops: stops.map((x) => ({ slotId: x.slotId, venueId: x.venueId, start: x.start })),
      reason: typeof answered.reason === 'string' ? answered.reason : '',
      source: answered.source === 'ai' ? 'ai' : 'rules',
    }
  }

  // The stops of the voted order as the server will store them, for the Confirm dialog: `[{ slotId, category, venueId, start, duration }]`, or
  // null when the answer has none the dialog can show (then it shows nothing it cannot vouch for).
  // How to call: votedFrom({ voted: [{ slotId: 'a', category: 'eat', venueId: 'v1', start: 720, duration: 90 }] })
  function votedFrom(answered) {
    const rows = answered?.voted
    if (!Array.isArray(rows) || !rows.length || rows.length > 8) return null
    const whole = rows.every((x) => x && typeof x.slotId === 'string' && typeof x.venueId === 'string' && typeof x.category === 'string' && Number.isFinite(x.start) && x.start >= 0 && x.start < 2880 && Number.isFinite(x.duration) && x.duration > 0)
    if (!whole || new Set(rows.map((x) => x.slotId)).size !== rows.length) return null
    return rows.map((x) => ({ slotId: x.slotId, category: x.category, venueId: x.venueId, start: x.start, duration: x.duration }))
  }

  // The host asks for the suggested order of the winning places. Nothing is saved by this. Resolves the suggestion (see orderFrom), or null
  // when there is none. `onBasis(basis)` is told the basis of the votes the answer was made for, whether or not there is an order to suggest
  // (the server hands it out for "none" too), so the host's confirm of the voted order can say which votes it was looking at. `onVoted(rows)`
  // is told the stops of the voted order with the starts the server will store (see votedFrom), whether or not there is an order to suggest,
  // or null when the answer has none. Rejects with a sentence: the host only; the group is no longer voting; fewer than 2 have voted.
  // How to call: const suggestion = await suggestOrder('3b1f...', { onBasis: (basis) => remember(basis), onVoted: (rows) => show(rows) })
  async function suggestOrder(sessionId, { onBasis, onVoted } = {}) {
    const answered = await ask(() => backend.suggestOrder(sessionId), { host_only: 'Only the host can confirm the plan.', wrong_status: WORDS.planClosed })
    if (BASIS.test(String(answered?.basis))) onBasis?.(answered.basis)
    onVoted?.(votedFrom(answered))
    return orderFrom(answered)
  }

  // The minutes each person needs to get home from the last stop of a confirmed plan, as the server works them out (the figures the finished
  // outing's ledger keeps). Resolves `{ minutes: { <user id>: minutes }, approximate }` (`approximate`: some of them are estimates, not routes);
  // rejects with a sentence.
  // How to call: const { minutes, approximate } = await tripsHome('3b1f...') // minutes: { '9a2c...': 31 }
  async function tripsHome(sessionId) {
    const answered = await ask(() => backend.tripsHome(sessionId), { wrong_status: WORDS.needConfirmed, not_found: WORDS.notBuilt })
    const minutes = {}
    for (const x of answered.trips) if (x && typeof x.userId === 'string' && Number.isFinite(x.minutes) && x.minutes >= 0) minutes[x.userId.toLowerCase()] = x.minutes
    return { minutes, approximate: answered.approximate !== false }
  }

  // The host confirms the plan. `order` is 'voted', or 'suggested' with the `basis` of the suggestion the host was shown; the server writes
  // the stops itself, from its own rows, and refuses a basis that is no longer its own (`code` 'order_stale', 409: it did nothing).
  // Resolves the server's small answer.
  // How to call: await confirmPlan('3b1f...', { order: 'suggested', basis: 'a3f9...' })
  const confirmPlan = (sessionId, { order = 'voted', basis } = {}) => ask(() => backend.confirmPlan(sessionId, { order, basis }), { host_only: 'Only the host can confirm the plan.', wrong_status: WORDS.planClosed })

  // The host takes the plan back to voting (`accept`), or only turns the "Re-plan?" question off.
  // How to call: await replan('3b1f...', true)
  const replan = (sessionId, accept = true) => ask(() => backend.replan(sessionId, accept), { host_only: 'Only the host can re-plan.', wrong_status: WORDS.needConfirmed })

  // The host ends the outing; the server writes everyone's travel ledger row.
  // How to call: await complete('3b1f...')
  const complete = (sessionId) => ask(() => backend.complete(sessionId), { host_only: 'Only the host can finish the outing.', wrong_status: WORDS.completeClosed })

  // The host sets how the group gets to a stop, deletes a stop, or rearranges all of them (`stopIds`, every stop in the new order).
  // How to call: await setTravelMode('3b1f...', '5d0c...', 'mrt'); await deleteStop('3b1f...', '5d0c...'); await reorderStops('3b1f...', ['9e41...', '5d0c...'])
  const setTravelMode = (sessionId, stopId, mode) => ask(() => backend.patchStop(sessionId, stopId, { travelMode: mode }), { host_only: 'Only the host can change how the group travels.', wrong_status: WORDS.needConfirmed })
  const deleteStop = (sessionId, stopId) => ask(() => backend.deleteStop(sessionId, stopId), { host_only: 'Only the host can delete a stop.', wrong_status: WORDS.needConfirmed })
  const reorderStops = (sessionId, stopIds) => ask(() => backend.reorderStops(sessionId, stopIds), { host_only: 'Only the host can rearrange the stops.', wrong_status: WORDS.needConfirmed, stops_changed: WORDS.planChanged })

  // The ids of a session's stops in order, read afresh: what a move is checked against, so a move made from a list another device has
  // since changed is turned away instead of putting a stop where the person did not mean.
  // How to call: const ids = await stopIds('3b1f...') -> ['5d0c...', '9e41...']
  async function stopIds(sessionId) {
    who()
    const rows = answer(await db().from('stops').select('id, seq').eq('session_id', sessionId), WORDS.notLoaded)
    return rows.sort((a, b) => a.seq - b.seq).map((x) => x.id)
  }

  // The indoor swap offered for a stop, the places that could take a stop's place, and putting one in (see plannerApi.js). The first two are
  // reads. `not_found` is a server that does not have the route yet.
  // How to call: await stopSwap('3b1f...', '5d0c...'); await stopChoices('3b1f...', '5d0c...', { category: 'drink' }); await changeStopPlace('3b1f...', '5d0c...', { venueId: 'v25', seenVenueId: 'v12', category: 'drink' })
  const stopSwap = (sessionId, stopId) => ask(() => backend.stopSwap(sessionId, stopId), { wrong_status: WORDS.needConfirmed, not_found: WORDS.notBuilt })
  const stopChoices = (sessionId, stopId, options) => ask(() => backend.stopChoices(sessionId, stopId, options), { host_only: 'Only the host can replace a stop.', wrong_status: WORDS.needConfirmed, not_found: WORDS.notBuilt })
  // The host keeps a stop as it is in the rain; the server stores it on the session.
  // How to call: await keepRain('3b1f...', '5d0c...', 'showers')
  const keepRain = (sessionId, stopId, state) => ask(() => backend.keepRain(sessionId, stopId, state), { host_only: 'Only the host can dismiss this.', wrong_status: WORDS.needConfirmed, stop_not_found: WORDS.stopGone, not_found: WORDS.notBuilt })
  const changeStopPlace = (sessionId, stopId, body) =>
    ask(() => backend.changeStopPlace(sessionId, stopId, body), {
      host_only: 'Only the host can replace a stop.',
      wrong_status: WORDS.needConfirmed,
      venue_does_not_fit: WORDS.doesNotFit,
      stop_changed: WORDS.planChanged,
      not_found: WORDS.notBuilt,
    })

  // Roam. The list of places near the group (nothing is written), a place put forward as the next stop, and the answer to a proposal.
  // `propose` resolves { id, existing } (`existing` when that place was already waiting); `resolve` the server's small answer.
  // How to call: const list = await roam('3b1f...', { current, categories }); await propose('3b1f...', 'v25'); await resolve('3b1f...', 'c7ae...', true)
  const roam = (sessionId, options) => ask(() => backend.roam(sessionId, options), { wrong_status: WORDS.roamClosed, not_found: WORDS.notBuilt })
  const propose = (sessionId, venueId) => ask(() => backend.propose(sessionId, venueId), { wrong_status: WORDS.roamClosed, not_found: WORDS.notBuilt })
  const resolve = (sessionId, proposalId, accept) => ask(() => backend.resolve(sessionId, proposalId, accept), { host_only: 'Only the host can add a place to the plan.', wrong_status: WORDS.roamClosed, not_found: WORDS.notBuilt })

  // The person's own row of the travel ledger for a finished outing: how long they spent getting there, between stops and home, and how that
  // compares with the group's average (minutes more, or fewer when negative). Their row only, whatever the rules let them read. Resolves
  // { minutesIn, minutesBetween, minutesHome, total, delta }, or null while there is none.
  // How to call: const ledger = await myLedger('3b1f...')
  async function myLedger(sessionId) {
    const mine = who()
    const row = answer(await db().from('commute_ledger').select(LEDGER_COLUMNS).eq('session_id', sessionId).eq('user_id', mine).maybeSingle(), WORDS.notLoaded)
    if (!row) return null
    return { minutesIn: row.minutes_in, minutesBetween: row.minutes_between, minutesHome: row.minutes_home, total: row.total_minutes ?? row.minutes_in + row.minutes_between + row.minutes_home, delta: Number(row.delta_from_mean) || 0 }
  }

  // ── Live updates ──────────────────────────────────────────────────────────

  // Listen for changes to the person's sessions, on one channel: the sessions they can read, who is in them, invitations
  // addressed to them, and the links and invitations they made as a host. `onChange` hears:
  //   { kind: 'session', sessionId }                  a session, its members or one of its invites changed: read it again;
  //   { kind: 'member-deleted', sessionId, mine }     a membership row was deleted somewhere (`mine`: it was this person's). A
  //                                                   delete carries only keys and cannot be filtered, so the whole table is
  //                                                   listened to for deletes and the caller keeps only those in sessions it
  //                                                   knows;
  //   { kind: 'vote', slotId }                        a vote was cast, moved or taken back on some slot (the caller maps the slot to
  //                                                   the session it knows, and ignores a slot it does not know);
  //   { kind: 'approval-deleted', sessionId }         a "Works for me" was taken back or removed somewhere (keys only; the
  //                                                   caller keeps those in sessions it knows);
  //   { kind: 'stop-deleted', stopId }                a stop of some itinerary was removed (its key only; the caller maps it to
  //                                                   the session it knows, and ignores a stop it does not know);
  //   { kind: 'invitations' }                         an invitation to this person changed;
  //   { kind: 'resync' }                              the channel has connected: what happened before it did is read again.
  // Returns a function that closes the channel.
  // How to call: const stop = watch((change) => refresh(change))
  function watch(onChange) {
    const mine = who()
    const c = db()
    if (typeof c.channel !== 'function') return () => {}
    // A topic of its own for each channel opened. realtime-js hands back the channel it holds for a topic, even one that is
    // still leaving (and then ignores the new bindings and does not subscribe it), so a channel opened again on the topic
    // of one just closed would never hear anything. A new topic is always a new channel.
    opened += 1
    const channel = c
      .channel(`jio-sessions-${mine}-${opened}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, (p) => {
        const id = p.new?.id || p.old?.id
        if (id) onChange({ kind: 'session', sessionId: id })
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'session_members' }, (p) => p.new?.session_id && onChange({ kind: 'session', sessionId: p.new.session_id }))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'session_members' }, (p) => p.new?.session_id && onChange({ kind: 'session', sessionId: p.new.session_id }))
      // Told as a delete of someone's membership; the caller decides whether it is a session it knows (it ignores the rest).
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'session_members' }, (p) => {
        const sessionId = p.old?.session_id
        if (sessionId) onChange({ kind: 'member-deleted', sessionId, mine: p.old?.user_id === me() })
      })
      // "Works for me": a mark added in a session this person is in. The exact places and the spot list are not listened to: the
      // list changes only with the session's version, which is the sessions row above.
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'spot_approvals' }, (p) => p.new?.session_id && onChange({ kind: 'session', sessionId: p.new.session_id }))
      // A mark taken back, or gone with its spot or its member. Like any delete it carries only keys and reaches everyone who
      // listens, so the caller keeps only the sessions it knows.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'spot_approvals' }, (p) => p.old?.session_id && onChange({ kind: 'approval-deleted', sessionId: p.old.session_id }))
      // A vote cast, moved or taken back. A vote is a row on a slot, not on a session, and a delete carries only its keys and reaches
      // everyone who listens, so the caller keeps only the slots it knows. Inserts and updates reach only the members of the slot's
      // session (row-level security). The slots, places and radius change with the session's version, which is the sessions row above.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'votes' }, (p) => {
        const slotId = p.new?.slot_id || p.old?.slot_id
        if (slotId) onChange({ kind: 'vote', slotId })
      })
      // The itinerary: a stop added, changed or removed. An insert or update names its session; a delete carries only the stop's key and
      // reaches everyone who listens, so the caller keeps only the stops it knows. (The proposals and the ledger are not published: they
      // change with the session's version, which is the sessions row above.)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stops' }, (p) => {
        const sessionId = p.new?.session_id
        if (sessionId) onChange({ kind: 'session', sessionId })
        else if (p.old?.id) onChange({ kind: 'stop-deleted', stopId: p.old.id })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invites', filter: `invitee_id=eq.${mine}` }, () => onChange({ kind: 'invitations' }))
      // The host's own links and invitations: one declined, one used, one turned off or run out (on another device too).
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invites', filter: `created_by=eq.${mine}` }, (p) => {
        const sessionId = p.new?.session_id
        if (sessionId) onChange({ kind: 'session', sessionId })
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') onChange({ kind: 'resync' })
      })
    let closed = false
    return () => {
      if (closed) return
      closed = true
      Promise.resolve(c.removeChannel(channel)).catch(() => {})
    }
  }

  return { list, get, readPlan, readSlotVotes, suggestOrder, tripsHome, confirmPlan, replan, complete, setTravelMode, deleteStop, reorderStops, stopIds, stopSwap, stopChoices, changeStopPlace, keepRain, roam, propose, resolve, myLedger, create, update, cancel, start, setPlace, restorePlace, approve, refreshSpots, suggest, withdraw, confirm, knownPlace, changeMeetingPlace, optOut, rejoin, castVote, setRadius, removeSlot, restoreSlots, addOption, moreOptions, swapOption, searchSlot, syncPlan, venues, setPrefs, restorePrefs, currentLink, makeLink, revoke, invitePerson, preview, join, invitations, decline, removeMember, watch }
}
