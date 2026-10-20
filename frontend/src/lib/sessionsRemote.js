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
// Another member's exact place is never read, shown or kept: `session_member_places` is read with the person's own id and
// only its two labels, so what comes back is the person's own, and everyone else's start is the area name. The table is
// not listened to. A person who is not a member is shown only the preview of an invite (title, date, times, the host's name).
//
// `client()` is the Supabase client (or null), `me()` the signed-in user's id, `backend` the calls to the Jio server
// (`removeMember`, `refreshSpots`, `putSpot`, `deleteSpot`, `confirmSpot`, `knownPlace`, `optOut`, `rejoin`), `now()` the clock
// in milliseconds.
// How to call: const remote = createSessionsRemote({ client: () => auth.dataClient(), me: () => currentUserId(), backend, now: Date.now })

import { isUuid, personFromRow } from './peopleSource.js'

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
  started: 'People can only leave or be removed before the session starts, for now.',
  badUsername: 'Enter a full username: 3 to 20 lowercase letters, numbers or underscores.',
  alreadyInvited: 'You have already invited that person.',
  hostLeave: 'The host cannot leave. Cancel the session instead.',
  hostOnlyRemove: 'Only the host can remove someone.',
  closed: 'This session has ended.',
  gone: 'That person is not in this session any more.',
  notSaved: 'That could not be saved. Try again.',
  notLoaded: 'Your sessions could not be loaded. Try again.',
  // Stage 3: the meeting spots and where people start.
  spotsClosed: 'Spots can only change while the group is choosing where to meet.',
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
  tooLarge: 'This group is too large to plan.',
  // What stops at the next stage: choosing places and the plan, with friends. Shown where a real account's session reaches it.
  comesNext: 'Choosing places and the plan with friends comes in the next update.',
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
  member_not_found: WORDS.gone,
  wrong_status: WORDS.spotsClosed,
  no_spots: WORDS.needTwoStarts,
  too_many_spots: WORDS.tooManySpots,
  spot_not_found: WORDS.spotGone,
  needs_two_people: WORDS.needTwoPeople,
  unknown_area: WORDS.noArea,
  area_not_priced: WORDS.noTrips,
  plan_busy: WORDS.busy,
  group_too_large: WORDS.tooLarge,
}

// A refusal from the Jio server as an Error with a sentence fit to show, and its code kept on `code`. `words` changes the
// sentence for a code in one place (removing someone says "remove", not "do that").
// How to call: throw problem(err, { host_only: WORDS.hostOnlyRemove })
export function problem(err, words = {}) {
  const code = typeof err?.code === 'string' ? err.code : undefined
  const message = (code && (words[code] || CODE_WORDS[code])) || err?.message || WORDS.notSaved
  return Object.assign(new Error(message), { code })
}

// A link's token is 32 random bytes written as 43 URL-safe characters (db/schema.sql). Anything else cannot be a link.
// How to call: looksLikeToken('q3D9_-aZ...') -> true
export const looksLikeToken = (text) => typeof text === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(text)

// A username as the database holds it: 3 to 20 lowercase letters, numbers or underscores.
// How to call: cleanUsername(' @Sam_1 ') -> 'sam_1'; cleanUsername('s') -> ''
export function cleanUsername(text) {
  const name = String(text ?? '').trim().replace(/^@/, '').toLowerCase()
  return /^[a-z0-9_]{3,20}$/.test(name) ? name : ''
}

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
  else if (code === 'P0002') message = WORDS.linkDead
  else if (code === 'P0001' && error?.hint === 'session_full') message = WORDS.full
  else if (code === '28000') message = WORDS.signedOut
  else if (code === '23505') message = /one_live_link/.test(text) ? 'This session already has a link. Reload to see it.' : WORDS.alreadyInvited
  else if (code === '23514') message = 'That is not allowed. Check the title, day and times.'
  // The database's own sentences for a refused action are written for people (a trigger's); its generic ones are not.
  else if (code === '42501' && !/row-level security|permission denied/i.test(text)) message = text
  else if (code === '42501') message = WORDS.notAllowed
  return Object.assign(new Error(message), { code: code || undefined })
}

// Nothing read for planning yet. How to call: toSession(row, members, invites, NO_PLANNING)
const NO_PLANNING = { spots: [], suggestions: [], approvals: [], places: [] }

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
      const times = kept && Object.keys(kept.times).length
        ? kept.times
        : Object.fromEntries(members.filter((m) => m.state === 'joined' && m.travel_minutes != null).map((m) => [m.user_id, minutesOf(m.travel_minutes)]))
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
    // A start changed and the spots were not worked out again (the call to the server never came): the newest change to a
    // member's row is later than the newest time any spot was priced. Only two shared starts have anything to price.
    const newest = (rows, field) => Math.max(0, ...rows.map((x) => Date.parse(x[field]) || 0))
    const changed = newest(members, 'updated_at')
    const stale = row.status === 'locating' && located.length >= 2 && (!spotRows.length || changed > newest(spotRows, 'computed_at'))
    // The time of that change as text (it names the gap, so a screen asks the server once for each), or '' when there is none.
    return { locations, meeting, spots, banner: row.banner && typeof row.banner === 'object' ? { ...row.banner } : null, spotsStale: stale ? String(changed) : '' }
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
      createdAt: Date.parse(row.created_at),
      updatedAt: Date.parse(row.updated_at),
      members: [...joined, ...invited],
      planVersion: Number(row.plan_version) || 0,
      ...planningOf(row, memberRows, planning, me()),
      remote: true,
    }
  }

  // The most session ids in one read.
  const CHUNK = 100
  // How many channels this factory has opened, for their topics.
  let opened = 0
  const SESSION_COLUMNS = 'id, host_id, title, date, start_time, end_time, status, created_at, updated_at, plan_version, meeting_area_id, meeting_method, meeting_max_minutes, meeting_total_minutes, meeting_count, meeting_approximate, banner'
  const MEMBER_COLUMNS = 'session_id, user_id, role, state, joined_at, start_area_id, end_area_id, travel_minutes, updated_at'
  const INVITE_COLUMNS = 'session_id, invitee_id, revoked, declined_at, uses, expires_at, created_at'
  const SPOT_COLUMNS = 'session_id, area_id, rank, worst_minutes, mean_minutes, travel_minutes, approximate, computed_at'
  const SUGGESTION_COLUMNS = 'session_id, user_id, area_id, here, created_at'
  const APPROVAL_COLUMNS = 'session_id, area_id, user_id, created_at'
  // The person's own two labels, never the coordinates behind them.
  const PLACE_LABELS = 'session_id, start_label, end_label'

  // The rows of spots, suggestions, approvals and the person's own places for the sessions that have got past inviting, a
  // hundred sessions at a time. The exact places are asked for with the person's own id, so only their own row is ever read.
  // How to call: const planning = await readPlanning(['3b1f...'])
  async function readPlanning(ids) {
    if (!ids.length) return NO_PLANNING
    const mine = who()
    const chunks = []
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
    const all = async (build) => (await Promise.all(chunks.map(build))).flatMap((answered) => answer(answered, WORDS.notLoaded))
    const [spots, suggestions, approvals, places] = await Promise.all([
      all((chunk) => db().from('session_spots').select(SPOT_COLUMNS).in('session_id', chunk)),
      all((chunk) => db().from('spot_suggestions').select(SUGGESTION_COLUMNS).in('session_id', chunk)),
      all((chunk) => db().from('spot_approvals').select(APPROVAL_COLUMNS).in('session_id', chunk)),
      all((chunk) => db().from('session_member_places').select(PLACE_LABELS).eq('user_id', mine).in('session_id', chunk)),
    ])
    return { spots, suggestions, approvals, places }
  }

  // The sessions that can have spots to read: all but one still inviting.
  // How to call: planned(rows) -> ['3b1f...']
  const planned = (rows) => rows.filter((r) => r.status !== 'inviting').map((r) => r.id)

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
      readPlanning(planned(rows)),
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
    const planning = await readPlanning(planned([row]))
    return toSession(row, answer(members, WORDS.notLoaded), answer(invites, WORDS.notLoaded), planning)
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
  // to meet. The database allows it only to the host, and only with two joined people; its sentence says so.
  // How to call: await start('3b1f...')
  async function start(sessionId) {
    who()
    const rows = answer(await db().from('sessions').update({ status: 'locating' }).eq('id', sessionId).select('id'), WORDS.notSaved)
    if (!rows.length) throw Object.assign(new Error('Only the host can start a session.'), { code: 'host_only' })
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

  // The person with exactly this username, or null. Only a complete username is asked for, and only the public columns.
  // How to call: const person = await findPerson('kim_2') -> { id, name, username, avatarUrl }
  async function findPerson(text) {
    who()
    const name = cleanUsername(text)
    if (!name) throw Object.assign(new Error(WORDS.badUsername), { code: 'bad_username' })
    const row = answer(await db().from('profiles').select('id, username, display_name, avatar_url').eq('username', name).maybeSingle(), WORDS.notLoaded)
    return row ? personFromRow(row) : null
  }

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
      throw problem(err, { host_only: WORDS.hostOnlyRemove })
    }
  }

  // ── Where people start, and the meeting spots ─────────────────────────────

  // Change one end of the person's own route (`which`: 'start' or 'end'): the area on their member row, which the group sees,
  // and the label of the exact place in `session_member_places`, which only they and the server can read. No coordinates are
  // written: travel times are worked out from the area (design question 1). `place` is { areaId, label }, or null to clear.
  // Resolves with what it replaced, for putting back (see restorePlace) and for telling a first start from a change.
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
    const before = { which, areaId: member[areaColumn] ?? null, label: had?.[labelColumn] ?? null, hadStart: !!member.start_area_id }
    const label = place ? String(place.label || '').slice(0, 120) || null : null
    try {
      await writePlace(sessionId, which, place ? place.areaId : null, label)
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

  // Put one end of the person's route back as `before` (what setPlace answered). Takes back only their own change, and never
  // fails: it is the repair for a failure, and the failure is the one worth reading.
  // How to call: await restorePlace('3b1f...', before)
  async function restorePlace(sessionId, before) {
    try {
      await writePlace(sessionId, before.which, before.areaId, before.label)
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
      answer(await db().from('spot_approvals').delete().eq('session_id', sessionId).eq('area_id', areaId).eq('user_id', mine), WORDS.notSaved)
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
  // The person opts out of the session (keeping their place in it), and comes back.
  // How to call: await optOut('3b1f...'); await rejoin('3b1f...')
  const optOut = (sessionId) => ask(() => backend.optOut(sessionId), { wrong_status: WORDS.closed })
  const rejoin = (sessionId) => ask(() => backend.rejoin(sessionId), { wrong_status: 'You can only rejoin before the group votes on places.' })

  // ── Live updates ──────────────────────────────────────────────────────────

  // Listen for changes to the person's sessions, on one channel: the sessions they can read, who is in them, invitations
  // addressed to them, and the links and invitations they made as a host. `onChange` hears:
  //   { kind: 'session', sessionId }                  a session, its members or one of its invites changed: read it again;
  //   { kind: 'member-deleted', sessionId, mine }     a membership row was deleted somewhere (`mine`: it was this person's). A
  //                                                   delete carries only keys and cannot be filtered, so the whole table is
  //                                                   listened to for deletes and the caller keeps only those in sessions it
  //                                                   knows;
  //   { kind: 'approval-deleted', sessionId }         a "Works for me" was taken back or removed somewhere (keys only; the
  //                                                   caller keeps those in sessions it knows);
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

  return { list, get, create, update, cancel, start, setPlace, restorePlace, approve, refreshSpots, suggest, withdraw, confirm, knownPlace, optOut, rejoin, currentLink, makeLink, revoke, findPerson, invitePerson, preview, join, invitations, decline, removeMember, watch }
}
