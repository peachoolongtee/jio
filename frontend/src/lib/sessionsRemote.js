// A real account's sessions, kept in Supabase instead of this browser. This is the other half of the choice lib/api.js makes
// for each session function: the demo account and local accounts stay on the local data layer, a real account comes here.
//
// It reads and writes the database directly, as the browser may (ticket #79's table, CLAUDE.md "what a browser may write
// directly"): a new session, its title, date and times while it is inviting, its start and cancel, the host's invite links.
// The database's own rules decide who may do what; this file turns a refusal into a plain sentence. Two things go through
// the Jio server instead, because the database refuses them to a browser: a member leaving, and the host removing a guest.
//
// It answers in the shape the local data layer keeps a session in ({ id, title, date, start, end, hostId, status, members,
// createdAt, updatedAt }), plus `remote: true`; lib/api.js adds the fields that belong to the later stages (locations, the
// meeting area, votes, the plan) as empty and runs the same summary as for a local session, so screens do not change.
//
// Nothing here reads another member's exact place: `session_member_places` is not touched. A person who is not a member
// is shown only the preview of an invite (title, date, times, the host's name).
//
// `client()` is the Supabase client (or null), `me()` the signed-in user's id, `backend.removeMember(sessionId, userId)` the
// call to the Jio server, `now()` the clock in milliseconds.
// How to call: const remote = createSessionsRemote({ client: () => auth.dataClient(), me: () => currentUserId(), backend, now: Date.now })

import { isUuid } from './peopleSource.js'

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
  alreadyInvited: 'You have already invited that person.',
  hostLeave: 'The host cannot leave. Cancel the session instead.',
  hostOnlyRemove: 'Only the host can remove someone.',
  closed: 'This session has ended.',
  gone: 'That person is not in this session any more.',
  notSaved: 'That could not be saved. Try again.',
  notLoaded: 'Your sessions could not be loaded. Try again.',
  // The held start (ticket #127 until stage 3): shown instead of Start session for a session kept on the server.
  startHeld: 'Sharing where you start from, and everything after it, comes in the next update, so a session cannot be started yet.',
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

  // A session as the screens keep it, from its rows. The host first, then the people who joined in the order they came, then
  // the people invited by name who have not answered. A person who opted out stays on the list in that state.
  // How to call: toSession(row, memberRows, inviteRows)
  function toSession(row, memberRows, inviteRows) {
    const joined = memberRows
      .filter((m) => m.session_id === row.id)
      .sort((a, b) => (a.role === 'host' ? -1 : b.role === 'host' ? 1 : String(a.joined_at).localeCompare(String(b.joined_at))))
      .map((m) => ({ id: m.user_id, role: m.role, state: m.state }))
    const invited = inviteRows
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
      remote: true,
    }
  }

  // The most session ids in one read.
  const CHUNK = 100
  // How many channels this factory has opened, for their topics.
  let opened = 0
  const SESSION_COLUMNS = 'id, host_id, title, date, start_time, end_time, status, created_at, updated_at'
  const MEMBER_COLUMNS = 'session_id, user_id, role, state, joined_at'
  const INVITE_COLUMNS = 'session_id, invitee_id, revoked, declined_at, uses, expires_at, created_at'

  // Every session the person is in, newest first, in three reads for all of them.
  // How to call: const sessions = await list()
  async function list() {
    who()
    const rows = answer(await db().from('sessions').select(SESSION_COLUMNS).order('created_at', { ascending: false }), WORDS.notLoaded)
    if (!rows.length) return []
    const ids = rows.map((r) => r.id)
    // The ids go in the address of each read, so a long list is read a hundred sessions at a time.
    const chunks = []
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
    const [members, invites] = await Promise.all([
      Promise.all(chunks.map((chunk) => db().from('session_members').select(MEMBER_COLUMNS).in('session_id', chunk))),
      Promise.all(chunks.map((chunk) => db().from('invites').select(INVITE_COLUMNS).in('session_id', chunk))),
    ])
    const memberRows = members.flatMap((answered) => answer(answered, WORDS.notLoaded))
    const inviteRows = invites.flatMap((answered) => answer(answered, WORDS.notLoaded))
    return rows.map((r) => toSession(r, memberRows, inviteRows))
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
    return toSession(row, answer(members, WORDS.notLoaded), answer(invites, WORDS.notLoaded))
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

  // Starting waits for the later stages: where people start from, the meeting spots, votes and the plan are not on the server
  // yet, so a session started now would be half on the server and half in one browser.
  // How to call: await start('3b1f...') (always throws WORDS.startHeld)
  async function start() {
    throw Object.assign(new Error(WORDS.startHeld), { code: 'start_held' })
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

  // The sentence for a refusal from the server (backend/src/routes/sessions.js), by its code.
  // How to call: throw leaveProblem(err)
  function leaveProblem(err) {
    const words = {
      session_not_found: WORDS.noSession,
      host_cannot_leave: WORDS.hostLeave,
      host_only: WORDS.hostOnlyRemove,
      session_closed: WORDS.closed,
      session_started: WORDS.started,
      member_not_found: WORDS.gone,
    }
    return Object.assign(new Error(words[err?.code] || err?.message || WORDS.notSaved), { code: err?.code })
  }

  // A member leaves, or the host removes a guest (`personId`). Rejects with a sentence.
  // How to call: await removeMember('3b1f...', 'me') ; await removeMember('3b1f...', '7f3c...')
  async function removeMember(sessionId, personId = 'me') {
    who()
    try {
      return await backend.removeMember(sessionId, personId === me() ? 'me' : personId)
    } catch (err) {
      throw leaveProblem(err)
    }
  }

  // ── Live updates ──────────────────────────────────────────────────────────

  // Listen for changes to the person's sessions, on one channel: the sessions they can read, who is in them, invitations
  // addressed to them, and the links and invitations they made as a host. `onChange` hears:
  //   { kind: 'session', sessionId }                  a session, its members or one of its invites changed: read it again;
  //   { kind: 'member-deleted', sessionId, mine }     a membership row was deleted somewhere (`mine`: it was this person's). A
  //                                                   delete carries only keys and cannot be filtered, so the whole table is
  //                                                   listened to for deletes and the caller keeps only those in sessions it
  //                                                   knows;
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

  return { list, get, create, update, cancel, start, currentLink, makeLink, revoke, invitePerson, preview, join, invitations, decline, removeMember, watch }
}
