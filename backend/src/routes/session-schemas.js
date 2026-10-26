import { z } from 'zod'
import { CATEGORIES, OPTIONS_MAX } from '../planner/slot-plan.js'
import { categoryList, MAX, pointInput } from './plan-schemas.js'

// Request checks for the session endpoints (routes/sessions.js). Every id and body is checked here before anything is read or
// written, so the service only ever sees input of the right shape and size. A body takes exactly the fields listed: an extra
// field is a 400, so a misspelt `areaId` cannot be quietly ignored.
//
// How to call:
//   const body = sessionSchemas.suggestSpot.parse(req.body ?? {})   // throws a ZodError on bad input
//   const id = sessionSchemas.sessionId.parse(req.params.id)

const areaId = z.string().min(1).max(MAX.areaId)
// A place's id: the same limit as the database's on slot_options.venue_id (160, so the long ids of saved OneMap places fit).
const venueId = z.string().min(1).max(MAX.venueId)
// A uuid in a path or a body, in lower case (see sessionId).
const uuid = z.string().uuid().transform((id) => id.toLowerCase())

export const sessionSchemas = {
  // A uuid in a path. Postgres reads one without regard to the case of its letters; the service compares them in lower case, so it is
  // lower-cased here once and each session has one line however its id is written.
  sessionId: z.string().uuid().transform((id) => id.toLowerCase()),
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
  // POST /api/sessions/:id/opt-out, /rejoin and /plan/sync take no body. A body, if sent, must be empty.
  nothing: z.object({}).strict(),
  // POST /api/sessions/:id/change-meeting-place. `meetBy` is how the meeting point is picked again; `planVersion` is the version the caller saw (a stale one is 409 `stale_plan`, so a retry never wipes votes cast since); "known" names the area (`areaId`), "fairest" does not.
  changeMeetingPlace: z
    .object({ meetBy: z.enum(['fairest', 'known']), areaId: areaId.optional(), planVersion: z.number().int().min(0).optional() })
    .strict()
    .refine((body) => (body.meetBy === 'known') === (body.areaId !== undefined), { message: 'send an area with "known", and none with "fairest"', path: ['areaId'] }),
  // A slot in a path.
  slotId: uuid,
  // A place in a path (swap).
  venueId,
  // PUT /api/sessions/:id/radius. Metres from 100 to 3000, or null to let the planner widen on its own.
  radius: z.object({ radiusMeters: z.number().int().min(100).max(3000).nullable() }).strict(),
  // POST /api/sessions/:id/slots/restore. Without a slot, every removed slot comes back.
  restoreSlots: z.object({ slotId: uuid.optional() }).strict(),
  // POST /api/sessions/:id/slots/:slotId/options
  addOption: z.object({ venueId }).strict(),
  // POST /api/sessions/:id/slots/:slotId/options/more. `have` is how many places the caller sees in the slot.
  moreOptions: z.object({ have: z.number().int().min(0).max(OPTIONS_MAX) }).strict(),
  // POST /api/sessions/:id/slots/:slotId/options/:venueId/swap
  swapOption: z.object({ toVenueId: venueId }).strict(),
  // GET /api/sessions/:id/slots/:slotId/venue-search?q=
  venueSearch: z.object({ q: z.string().trim().min(1).max(MAX.searchQuery) }).strict(),
  // POST /api/sessions/:id/confirm. `order: 'suggested'` takes the stored suggested order and needs the `basis` the caller was shown.
  confirmPlan: z
    .object({ order: z.enum(['voted', 'suggested']).optional(), basis: z.string().regex(/^[0-9a-f]{64}$/, 'a 64-character hash, as the suggestion gave it').optional() })
    .strict()
    .refine((body) => body.order !== 'suggested' || body.basis !== undefined, { message: 'send the basis of the suggested order', path: ['basis'] }),
  // POST /api/sessions/:id/replan. `accept: false` only turns the "plan again?" prompt down.
  replan: z.object({ accept: z.boolean().optional() }).strict(),
  // A stop in a path.
  stopId: uuid,
  // PATCH /api/sessions/:id/stops/:stopId. null is the default mode for the leg.
  travelMode: z.object({ travelMode: z.enum(['walk', 'mrt', 'car']).nullable() }).strict(),
  // PUT /api/sessions/:id/stops/order: every stop of the plan once, in the new order.
  stopOrder: z.object({ stopIds: z.array(uuid).min(1).max(MAX.stops) }).strict(),
  // PUT /api/sessions/:id/stops/:stopId/place. `seenVenueId` is the place the caller saw in the stop.
  stopPlace: z.object({ venueId, seenVenueId: venueId, category: z.enum(CATEGORIES).optional() }).strict(),
  // GET /api/sessions/:id/stops/:stopId/choices?category=  (the kind of place to list; the stop's own when left out)
  stopChoices: z.object({ category: z.enum(CATEGORIES).optional() }).strict(),
  // POST /api/sessions/:id/roam. `current` is where the group is now, used for this one request and never stored; left out, the
  // meeting area's centre. `categories` narrows the list (up to 4 kinds).
  roam: z.object({ current: pointInput.optional(), categories: categoryList }).strict(),
  // PUT /api/sessions/:id/stops/:stopId/kept-rain. `state` is the forecast's state the host kept the stop in (a short lower-case word).
  keepRain: z.object({ state: z.string().regex(/^[a-z_]{1,24}$/) }).strict(),
  // POST /api/sessions/:id/proposals
  proposal: z.object({ venueId }).strict(),
  // A proposal in a path.
  proposalId: uuid,
  // POST /api/sessions/:id/proposals/:proposalId/resolve
  resolveProposal: z.object({ accept: z.boolean() }).strict(),
}
