import { Router } from 'express'
import { z } from 'zod'
import { requireUser } from '../middleware/auth.js'

// Leaving a session, and the host removing a guest. The database gives a browser no way to delete a member row
// (db/policies.sql: session_members has no insert, update or delete grant for a signed-in user), so this is the server's
// job, done with the service key after the caller has been checked as the user.
//
//   DELETE /api/sessions/:id/members/me        →   { planVersion, left: true }      the caller leaves
//   DELETE /api/sessions/:id/members/:userId   →   { planVersion, removed: true }   the host removes a guest
//
// Who may do what, decided from what the database lets the caller read (their own rules, through the user's client):
//   - the caller must be in the session, or the answer is 404 session_not_found (the same for a session that does not exist,
//     so a stranger learns nothing);
//   - the host cannot leave and cannot be removed: 403 host_cannot_leave (they cancel the session instead);
//   - only the host removes someone else: 403 host_only;
//   - a person who is not in the session cannot be removed: 404 member_not_found;
//   - a completed or cancelled session is closed: 409 session_closed;
//   - for now only a session that is still inviting can be left or taken out of: 409 session_started for any other. The
//     database lets a host start a session directly, and a person who left it would leave their votes and spot approvals
//     counted. Stage 3 takes those with the member and lifts this.
// The member row is deleted with the service key; the person's exact place goes with it by the foreign key. The server then
// raises sessions.plan_version by one, which every member of the session hears as an update of the session row, so their
// lists follow (a delete of a member row is also published, but cannot be filtered by the database's rules).
//
// Every failure is { error, message }: 400 invalid_input (a path that is not a uuid or "me"), 401 and 503 from the login
// check, 403, 404, 409, 429 over the limit. A database that fails answers 500 through the app's error handler.
//
// How to mount it (app.js does this when Supabase is configured):
//   app.use('/api', createSessionsRouter({ supabase, limiter }))
//
// How to call it from the frontend (lib/plannerApi.js removeSessionMember):
//   await api.delete(`/api/sessions/${id}/members/me`)

const uuid = z.string().uuid()
const target = z.union([z.literal('me'), uuid])
const completedStop = z.object({
  category: z.enum(['eat', 'drink', 'shop', 'activity']),
  venueId: z.string().min(1).max(80),
  plannedStartMinute: z.number().int().min(0).max(1439),
  durationMinutes: z.number().int().min(1).max(720),
  notBeforeMinute: z.number().int().min(0).max(1439).nullable().optional(),
})
const completion = z.object({ stops: z.array(completedStop).min(1).max(8) })

// How many times the version is read and written again when another write got in between.
const BUMP_TRIES = 4

// Answers in the flat error shape. How to call: refuse(res, 403, 'host_only', 'Only the host can remove someone.')
function refuse(res, status, error, message) {
  res.status(status).json({ error, message })
}

// Raise a session's plan_version by one without moving it backwards. Writes `seen + 1` only where the version still is `seen`;
// when it is not (another write got in between) reads it again and retries, up to BUMP_TRIES. Resolves with the version it
// wrote, or with the last one it saw when it could not (then logged, never thrown).
//
// How to call:
//   const planVersion = await raiseVersion(supabase.service, sessionId, 4)  // 5
async function raiseVersion(service, sessionId, firstSeen) {
  let seen = Number(firstSeen ?? 0)
  for (let attempt = 0; attempt < BUMP_TRIES; attempt += 1) {
    const { data, error } = await service
      .from('sessions')
      .update({ plan_version: seen + 1 })
      .eq('id', sessionId)
      .eq('plan_version', seen)
      .select('plan_version')
    if (error) {
      console.warn(`Could not raise the session's version after a member went (${error.code ?? 'no code'}).`)
      return seen
    }
    if (data?.length) return seen + 1
    const { data: now, error: readError } = await service.from('sessions').select('plan_version').eq('id', sessionId).maybeSingle()
    if (readError || !now) break
    seen = Number(now.plan_version ?? 0)
  }
  console.warn("Could not raise the session's version after a member went (another write kept changing it).")
  return seen
}

// Builds the router. `limiter` limits how often one signed-in caller may use it, or is null for no limit (tests only).
//
// How to call:
//   const router = createSessionsRouter({ supabase, limiter: rateLimit({ windowMs: 60_000, max: 60 }) })
export function createSessionsRouter({ supabase, limiter = null }) {
  const router = Router()

  // Persist the places an authenticated member says the group actually completed. The database function writes
  // all stops and marks the session completed in one transaction, so a retry cannot leave half a history record.
  router.post('/sessions/:id/complete', requireUser({ supabase }), ...(limiter ? [limiter] : []), async (req, res, next) => {
    try {
      const id = uuid.safeParse(req.params.id)
      const input = completion.safeParse(req.body ?? {})
      if (!id.success || !input.success) {
        return refuse(res, 400, 'invalid_input', 'Send a session id and between 1 and 8 completed stops.')
      }

      const { data: session, error: sessionError } = await req.supabase
        .from('sessions')
        .select('id, status')
        .eq('id', id.data)
        .maybeSingle()
      if (sessionError) throw new Error(`Could not load the session: ${sessionError.message}`)
      if (!session) return refuse(res, 404, 'session_not_found', 'This session does not exist, or you are not in it.')

      const { data: members, error: membersError } = await req.supabase
        .from('session_members')
        .select('user_id, state')
        .eq('session_id', id.data)
      if (membersError) throw new Error(`Could not load the session members: ${membersError.message}`)
      if (!members?.some((m) => m.user_id.toLowerCase() === req.user.id.toLowerCase() && m.state === 'joined')) {
        return refuse(res, 404, 'session_not_found', 'This session does not exist, or you are not in it.')
      }
      if (session.status !== 'confirmed' && session.status !== 'completed') {
        return refuse(res, 409, 'session_not_confirmed', 'Only a confirmed outing can be completed.')
      }
      if (session.status === 'completed') return res.json({ completed: true, stopsSaved: 0, alreadyCompleted: true })

      const { error } = await supabase.service.rpc('complete_session_with_stops', {
        p_session_id: id.data,
        p_stops: input.data.stops.map((stop, seq) => ({
          seq,
          category: stop.category,
          venue_id: stop.venueId,
          planned_start_minute: stop.plannedStartMinute,
          duration_minutes: stop.durationMinutes,
          not_before_minute: stop.notBeforeMinute ?? null,
        })),
      })
      if (error) {
        if (error.message?.includes('session is not confirmed')) {
          return refuse(res, 409, 'session_not_confirmed', 'Only a confirmed outing can be completed.')
        }
        throw new Error(`Could not save the completed outing: ${error.message}`)
      }
      res.json({ completed: true, stopsSaved: input.data.stops.length })
    } catch (err) {
      next(err)
    }
  })

  router.delete('/sessions/:id/members/:userId', requireUser({ supabase }), ...(limiter ? [limiter] : []), async (req, res, next) => {
    try {
      const id = uuid.safeParse(req.params.id)
      const who = target.safeParse(req.params.userId)
      if (!id.success || !who.success) {
        return refuse(res, 400, 'invalid_input', 'Send a session id and "me" or a person\'s id.')
      }
      // Postgres compares uuids without regard to the case of the letters, and the token's subject and the path may not be in the
      // case the database prints, so every id is compared in lower case.
      const me = req.user.id.toLowerCase()
      const person = who.data === 'me' ? me : who.data.toLowerCase()

      // Read as the caller: the database shows a session only to people in it.
      const { data: session, error: sessionError } = await req.supabase
        .from('sessions')
        .select('id, host_id, status, plan_version')
        .eq('id', id.data)
        .maybeSingle()
      if (sessionError) throw new Error(`Could not load the session: ${sessionError.message}`)
      const { data: members, error: membersError } = await req.supabase
        .from('session_members')
        .select('user_id, role')
        .eq('session_id', id.data)
      if (membersError) throw new Error(`Could not load the members: ${membersError.message}`)
      if (!session || !members?.some((m) => m.user_id.toLowerCase() === me)) {
        return refuse(res, 404, 'session_not_found', 'This session does not exist, or you are not in it.')
      }

      const host = session.host_id.toLowerCase()
      const leaving = person === me
      // The host is the only one who could ask to remove the host, and then it is the host leaving.
      if (leaving && host === me) {
        return refuse(res, 403, 'host_cannot_leave', 'The host cannot leave a session. Cancel it instead.')
      }
      if (!leaving && host !== me) {
        return refuse(res, 403, 'host_only', 'Only the host can remove someone from a session.')
      }
      if (['completed', 'cancelled'].includes(session.status)) {
        return refuse(res, 409, 'session_closed', 'This session has ended, so nobody can leave or be removed.')
      }
      if (session.status !== 'inviting') {
        return refuse(res, 409, 'session_started', 'Nobody can leave or be removed once the session has started, for now.')
      }
      if (!members.some((m) => m.user_id.toLowerCase() === person)) {
        return refuse(res, 404, 'member_not_found', 'That person is not in this session.')
      }

      // The server's own key: a browser cannot delete a member row.
      const { data: removed, error: removeError } = await supabase.service
        .from('session_members')
        .delete()
        .eq('session_id', id.data)
        .eq('user_id', person)
        .select('user_id')
      if (removeError) throw new Error(`Could not remove the member: ${removeError.message}`)
      if (!removed?.length) {
        // Gone between the check and the delete (two requests at once): the outcome the caller wanted is already true.
        return refuse(res, 404, 'member_not_found', 'That person is not in this session.')
      }

      // Tell the others by raising the session's version. The version is written only if it is still what was read (so another
      // server write that raised it meanwhile is never moved backwards, and two raises at once are two), a few tries. Best
      // effort: the member is already gone, so failing to raise it is logged and the answer is still success (the others find
      // out on their next read).
      const planVersion = await raiseVersion(supabase.service, id.data, session.plan_version)
      res.json(leaving ? { planVersion, left: true } : { planVersion, removed: true })
    } catch (err) {
      next(err)
    }
  })

  return router
}
