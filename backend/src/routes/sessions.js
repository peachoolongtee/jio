import { Router } from 'express'
import { ZodError } from 'zod'
import { requireUser } from '../middleware/auth.js'
import { SessionError } from '../services/sessions.js'
import { sessionSchemas } from './session-schemas.js'

// The session endpoints for where a group meets. The rules are in services/sessions.js; this file reads the request, calls
// them, and answers. Every route needs a login (`requireUser`), then the per-person limit, and answers in the flat error shape.
//
//   POST   /api/sessions/:id/meeting-area     { trigger? }            work the meeting spots out again (after a start or end changed)
//   PUT    /api/sessions/:id/spots/mine       { areaId, here? }       suggest a spot, replacing the caller's earlier one
//   DELETE /api/sessions/:id/spots/mine                               take the caller's suggestion back
//   POST   /api/sessions/:id/voting           { areaId? }             the host confirms a spot (the preselected one if none is named)
//   PUT    /api/sessions/:id/known-place      { areaId }              the host sets the area straight away
//   POST   /api/sessions/:id/opt-out                                  the caller steps out
//   POST   /api/sessions/:id/rejoin                                   the caller comes back
//   DELETE /api/sessions/:id/members/me                               the caller leaves
//   DELETE /api/sessions/:id/members/:userId                          the host removes a guest
//   GET    /api/sessions/:id/dietary                                  the outing's dietary needs together, no names (below)
//   POST   /api/sessions/:id/plan/sync                                work the slots and their places out again (after picks changed)
//   PUT    /api/sessions/:id/radius           { radiusMeters }        the host sets how far places are offered (100 to 3000, or null)
//   DELETE /api/sessions/:id/slots/:slotId                            the host removes a slot
//   POST   /api/sessions/:id/slots/restore    { slotId? }             the host brings back a slot, or every removed slot
//   POST   /api/sessions/:id/slots/:slotId/options            { venueId }      a member adds a place
//   POST   /api/sessions/:id/slots/:slotId/options/more       { have }         more suggestions
//   POST   /api/sessions/:id/slots/:slotId/options/:venueId/swap { toVenueId } swap one place for another
//   GET    /api/sessions/:id/slots/:slotId/venue-search?q=                     search the saved places for a slot
//
// Answers (200, JSON):
//   meeting-area   { planVersion, meetingAreaId: null, moved: false, votesCleared: false, skipped: [userId], spots: n, approvalsRemoved: [areaId] }
//   spots/mine PUT { planVersion, spots: n, approvalsRemoved: [areaId] }       DELETE { planVersion }
//   meeting-area   while voting: meetingAreaId is the area (null when paused), moved and votesCleared say what happened to it
//   voting         { planVersion, status: 'voting', meetingAreaId, method, slotCount }   (the slots and their places are made in the same write)
//   known-place    { planVersion, status: 'voting' }
//   opt-out        { planVersion, state: 'opted_out' }        rejoin { planVersion, state: 'joined' }
//   members/me     { planVersion, left: true }                members/:userId { planVersion, removed: true }
//   plan/sync      { planVersion, changed }                   radius { planVersion, radiusMeters }
//   slots/:id DELETE { planVersion }                          slots/restore { planVersion, restored: [slotId] }
//   options POST   201 { planVersion, added: true }, or 200 { planVersion, added: false } when the place is already there
//   options/more   { planVersion, added: [venueId] }          swap { planVersion, swapped }
//   venue-search   { results: [{ venueId, name, area, category, source, matchedStall, walkMinutes, distanceKm, fits, unfit, added }] }
// A member's own vote is written by the browser directly (votes, under the database's rules); the server only reads it.
// Approvals ("Works for me") and a member's own start and end are written by the browser directly, under the database's rules;
// the server only reads them. No answer carries a label or a coordinate.
//
// Errors, all { error: '<code>', message }:
//   400 invalid_input (a path id that is not a uuid, a body that is wrong; `issues` lists the fields)
//   401 unauthenticated, 503 auth_unavailable (from the login check), 429 rate_limited
//   403 not_joined, host_only, host_cannot_leave, host_cannot_opt_out
//   404 session_not_found (also for a session the caller is not in), member_not_found, spot_not_found, slot_not_found, venue_not_found,
//       option_not_found
//   409 wrong_status, not_yet (work of a later stage: a confirmed plan), session_closed and session_started (leave and remove), no_spots,
//       too_many_spots, needs_two_people, area_pinned, no_meeting_area (voting is paused), slot_full, plan_busy (with Retry-After: 1)
//   422 unknown_area, area_not_priced, venue_does_not_fit
//   500 server_error (a database that fails)
//
// How to mount it (app.js does this when Supabase is configured):
//   app.use('/api', createSessionsRouter({ supabase, sessions, limiter, readLimiter }))
//
// How to call it from the frontend (lib/plannerApi.js):
//   await api.put(`/api/sessions/${id}/spots/mine`, { areaId: 'bugis', here: true })
//
// An outing's dietary needs (ticket #107), for "Confirm dietary needs", which opens with them selected:
//   GET /api/sessions/:id/dietary   →   { dietary: ['halal', 'vegetarian'], others: ['halal'] }
// `dietary` is every joined member's needs together; `others` is everyone's but the caller's, the ones the caller cannot take
// off. A need is private (profile_private, read only by its owner and the server), so the answer never says whose a need is,
// how many people have it, or anything else from a member's private row (home area, budget, step-free). The caller must be in
// the session (404 session_not_found otherwise, the same as for a session that does not exist). The needs are read with the
// service key through session_member_needs(), which only the server may call. The answer is not cached anywhere. It has its
// own per-person limit (`readLimiter`), so reading never uses up the other routes'.
//   const { data } = await api.get(`/api/sessions/${id}/dietary`)   (lib/plannerApi.js sessionDietary)

// Answers in the flat error shape. How to call: refuse(res, 403, 'host_only', 'Only the host can remove someone.')
function refuse(res, status, error, message, extra = {}) {
  res.status(status).json({ error, message, ...extra })
}

// The needs a person can have, in the order the app shows them. Anything else in the database is left out.
const NEEDS = ['halal', 'vegetarian', 'vegan']

// How many joined members an outing needs before the others' needs are told to a member. With fewer, the others' list would be
// one known person's own list (two members), so it is empty. How to call: joined.length >= MIN_MEMBERS_FOR_OTHERS
const MIN_MEMBERS_FOR_OTHERS = 3

// Needs from many rows, each once, in the app's order. How to call: needsOf([['vegan'], ['halal', 'vegan'], null]) -> ['halal', 'vegan']
const needsOf = (lists) => NEEDS.filter((need) => lists.some((list) => Array.isArray(list) && list.includes(need)))

// Builds the router over the session rules (`sessions`, services/sessions.js). `limiter` limits how often one signed-in caller
// may use the session routes, `readLimiter` how often they may read an outing's needs, and `searchLimiter` how often they may search
// the saved places for a slot (three counters, so reading and searching never use up the allowance of the writes). Each is null for no
// limit (tests only).
//
// How to call:
//   const router = createSessionsRouter({ supabase, sessions, limiter: rateLimit({ windowMs: 60_000, max: 60 }), readLimiter: rateLimit({ windowMs: 60_000, max: 30 }), searchLimiter: rateLimit({ windowMs: 60_000, max: 120 }) })
export function createSessionsRouter({ supabase, sessions, limiter = null, readLimiter = null, searchLimiter = null }) {
  const router = Router()
  const guard = [requireUser({ supabase }), ...(limiter ? [limiter] : [])]
  const searchGuard = [requireUser({ supabase }), ...(searchLimiter ? [searchLimiter] : [])]

  router.get('/sessions/:id/dietary', requireUser({ supabase }), ...(readLimiter ? [readLimiter] : []), async (req, res, next) => {
    try {
      const id = sessionSchemas.sessionId.safeParse(req.params.id)
      if (!id.success) return refuse(res, 400, 'invalid_input', 'The session id is not valid.')
      const me = req.user.id.toLowerCase()

      // Read as the caller: the database shows a session's members only to people in it. Only a joined member may read the
      // needs: one who opted out gets the same answer as a stranger.
      const { data: members, error: membersError } = await req.supabase
        .from('session_members')
        .select('user_id, state')
        .eq('session_id', id.data)
      if (membersError) throw new Error(`Could not load the members: ${membersError.message}`)
      const joined = (members ?? []).filter((m) => m.state === 'joined')
      if (!joined.some((m) => m.user_id.toLowerCase() === me)) {
        return refuse(res, 404, 'session_not_found', 'This session does not exist, or you are not in it.')
      }

      // The server's own key: only it may read the members' private needs.
      const { data: rows, error: needsError } = await supabase.service.rpc('session_member_needs', { sid: id.data })
      if (needsError) throw new Error(`Could not load the members' needs: ${needsError.message}`)
      const list = Array.isArray(rows) ? rows : []
      res.set('Cache-Control', 'no-store')
      // With one other joined member, "the others' needs" would be that person's own list. So nothing is said about the others
      // until at least three have joined (the caller and two more): see MIN_MEMBERS_FOR_OTHERS.
      res.json({
        dietary: needsOf(list.map((r) => r.dietary)),
        others: joined.length >= MIN_MEMBERS_FOR_OTHERS
          ? needsOf(list.filter((r) => String(r.user_id).toLowerCase() !== me).map((r) => r.dietary))
          : [],
      })
    } catch (err) {
      next(err)
    }
  })

  // Wraps a handler: checks the session id, runs the handler with who is asking ({ client, id, userId }) and the request,
  // answers its result, and turns a bad body and the service's refusals into the flat error shape.
  //
  // How to call:
  //   router.post('/sessions/:id/opt-out', ...guard, handle((who) => sessions.optOut(who)))
  const handle = (run, statusOf = () => 200) => async (req, res, next) => {
    try {
      const id = sessionSchemas.sessionId.safeParse(req.params.id)
      if (!id.success) return refuse(res, 400, 'invalid_input', 'The session id is not valid.')
      const body = await run({ client: req.supabase, id: id.data, userId: req.user.id }, req)
      res.status(statusOf(body)).json(body)
    } catch (err) {
      if (err instanceof ZodError) {
        refuse(res, 400, 'invalid_input', 'Some fields in the request are missing or not valid. See issues.', {
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      } else if (err instanceof SessionError) {
        if (err.retryAfter !== null) res.set('Retry-After', String(err.retryAfter))
        refuse(res, err.status, err.code, err.message)
      } else {
        next(err)
      }
    }
  }

  router.post('/sessions/:id/meeting-area', ...guard, handle((who, req) => {
    const { trigger } = sessionSchemas.meetingArea.parse(req.body ?? {})
    return sessions.recompute({ ...who, trigger })
  }))

  router.put('/sessions/:id/spots/mine', ...guard, handle((who, req) => {
    const { areaId, here } = sessionSchemas.suggestSpot.parse(req.body ?? {})
    return sessions.suggestSpot({ ...who, areaId, here })
  }))

  router.delete('/sessions/:id/spots/mine', ...guard, handle((who) => sessions.withdrawSpot(who)))

  router.post('/sessions/:id/voting', ...guard, handle((who, req) => {
    const { areaId } = sessionSchemas.confirmSpot.parse(req.body ?? {})
    return sessions.confirmSpot({ ...who, areaId })
  }))

  router.put('/sessions/:id/known-place', ...guard, handle((who, req) => {
    const { areaId } = sessionSchemas.knownPlace.parse(req.body ?? {})
    return sessions.setKnownPlace({ ...who, areaId })
  }))

  router.post('/sessions/:id/opt-out', ...guard, handle((who, req) => {
    sessionSchemas.nothing.parse(req.body ?? {})
    return sessions.optOut(who)
  }))

  router.post('/sessions/:id/rejoin', ...guard, handle((who, req) => {
    sessionSchemas.nothing.parse(req.body ?? {})
    return sessions.rejoin(who)
  }))

  router.post('/sessions/:id/plan/sync', ...guard, handle((who, req) => {
    sessionSchemas.nothing.parse(req.body ?? {})
    return sessions.syncPlan(who)
  }))

  router.put('/sessions/:id/radius', ...guard, handle((who, req) => {
    const { radiusMeters } = sessionSchemas.radius.parse(req.body ?? {})
    return sessions.setRadius({ ...who, radiusMeters })
  }))

  // Declared before the routes with a :slotId, so "restore" is never read as one.
  router.post('/sessions/:id/slots/restore', ...guard, handle((who, req) => {
    const { slotId } = sessionSchemas.restoreSlots.parse(req.body ?? {})
    return sessions.restoreSlots({ ...who, slotId })
  }))

  router.delete('/sessions/:id/slots/:slotId', ...guard, handle((who, req) => {
    sessionSchemas.nothing.parse(req.body ?? {})
    return sessions.deleteSlot({ ...who, slotId: sessionSchemas.slotId.parse(req.params.slotId) })
  }))

  // Adding a place answers 201 when it was added and 200 when it was already there.
  router.post('/sessions/:id/slots/:slotId/options', ...guard, handle((who, req) => {
    const { venueId } = sessionSchemas.addOption.parse(req.body ?? {})
    return sessions.addOption({ ...who, slotId: sessionSchemas.slotId.parse(req.params.slotId), venueId })
  }, (body) => (body.added ? 201 : 200)))

  router.post('/sessions/:id/slots/:slotId/options/more', ...guard, handle((who, req) => {
    const { have } = sessionSchemas.moreOptions.parse(req.body ?? {})
    return sessions.addMoreOptions({ ...who, slotId: sessionSchemas.slotId.parse(req.params.slotId), have })
  }))

  router.post('/sessions/:id/slots/:slotId/options/:venueId/swap', ...guard, handle((who, req) => {
    const { toVenueId } = sessionSchemas.swapOption.parse(req.body ?? {})
    return sessions.swapOption({
      ...who,
      slotId: sessionSchemas.slotId.parse(req.params.slotId),
      fromId: sessionSchemas.venueId.parse(req.params.venueId),
      toId: toVenueId,
    })
  }))

  router.get('/sessions/:id/slots/:slotId/venue-search', ...searchGuard, handle((who, req) => {
    const { q } = sessionSchemas.venueSearch.parse(req.query ?? {})
    return sessions.searchSlot({ ...who, slotId: sessionSchemas.slotId.parse(req.params.slotId), query: q })
  }))

  router.delete('/sessions/:id/members/:userId', ...guard, async (req, res, next) => {
    // The target is checked beside the session id, so a bad "userId" is 400 like a bad session id.
    const target = sessionSchemas.member.safeParse(req.params.userId)
    if (!target.success) return refuse(res, 400, 'invalid_input', 'Send a session id and "me" or a person\'s id.')
    return handle((who) => sessions.removeMember({ ...who, target: target.data }))(req, res, next)
  })

  return router
}
