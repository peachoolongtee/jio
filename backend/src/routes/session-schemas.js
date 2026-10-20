import { z } from 'zod'
import { MAX } from './plan-schemas.js'

// Request checks for the session endpoints (routes/sessions.js). Every id and body is checked here before anything is read or
// written, so the service only ever sees input of the right shape and size. A body takes exactly the fields listed: an extra
// field is a 400, so a misspelt `areaId` cannot be quietly ignored.
//
// How to call:
//   const body = sessionSchemas.suggestSpot.parse(req.body ?? {})   // throws a ZodError on bad input
//   const id = sessionSchemas.sessionId.parse(req.params.id)

const areaId = z.string().min(1).max(MAX.areaId)

export const sessionSchemas = {
  // A uuid in a path. Postgres reads one without regard to the case of its letters; the service compares them in lower case.
  sessionId: z.string().uuid(),
  // A person in the path of a leave or remove: "me" or their id.
  member: z.union([z.literal('me'), z.string().uuid()]),
  // POST /api/sessions/:id/meeting-area. `trigger` says what changed, for the notice the group may be shown.
  meetingArea: z.object({ trigger: z.enum(['start', 'end', 'added']).optional() }).strict(),
  // PUT /api/sessions/:id/spots/mine
  suggestSpot: z.object({ areaId, here: z.boolean().optional() }).strict(),
  // POST /api/sessions/:id/voting. Without an area, the host confirms the spot that is preselected.
  confirmSpot: z.object({ areaId: areaId.optional() }).strict(),
  // PUT /api/sessions/:id/known-place
  knownPlace: z.object({ areaId }).strict(),
  // POST /api/sessions/:id/opt-out and /rejoin take no body. A body, if sent, must be empty.
  nothing: z.object({}).strict(),
}
