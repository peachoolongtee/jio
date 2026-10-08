import { z } from 'zod'

// Request checks for the planner endpoints. Every request is checked here BEFORE the engine runs, so the
// engine only ever sees input it can score, and the frontend gets a 400 that says which field is wrong.
//
// How to call:
//   const schemas = makePlanSchemas(data)        // data = loadPlanData(), for the occasion and weather names
//   const input = schemas.converge.parse(req.body) // throws a ZodError on bad input

// Singapore, with a little margin. Catches swapped lat/lng and (0, 0) from a failed geocode.
const point = z.object({
  lat: z.number().min(1.1).max(1.5),
  lng: z.number().min(103.5).max(104.1),
  label: z.string().optional(),
})

// "2026-10-10T19:00": local time, no time zone, sliced not parsed (see filters.js).
const dateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, 'use local time as YYYY-MM-DDTHH:MM, e.g. 2026-10-10T19:00')

// Lowercased first, so "Halal" from a form still means halal instead of rejecting every venue.
const diet = z.string().transform((s) => s.toLowerCase()).pipe(z.enum(['halal', 'vegetarian', 'vegan']))

const constraint = z
  .string()
  .regex(
    /^(step_free|sockets|quiet|indoor_only|max_price_pp:\d+(\.\d+)?|near_mrt:\d+)$/,
    'one of step_free, sockets, quiet, indoor_only, max_price_pp:N, near_mrt:N',
  )

const category = z.enum(['eat', 'drink', 'shop', 'activity'])

const memberFields = {
  id: z.string().min(1),
  name: z.string().optional(),
  home: point.optional(),
  start: point.optional(),
  end: point.optional(),
  dietary: z.array(diet).default([]),
  prefersHealthy: z.boolean().default(false),
  cuisineLikes: z.array(z.string()).default([]),
  cuisineDislikes: z.array(z.string()).default([]),
  budgetMaxPerPerson: z.number().positive().optional(),
  maxReturnMinutes: z.number().positive().optional(),
  travelDebtMinutes: z.number().default(0),
}
const withName = (m) => ({ ...m, name: m.name ?? m.id })

// Converge and the meeting area need to know where each person starts.
const travellingMember = z
  .object(memberFields)
  .refine((m) => m.start || m.home, { message: 'each member needs a start or a home point' })
  .transform(withName)
// Roam only uses members for diet, budget, tastes and group size.
const roamMember = z.object(memberFields).transform(withName)

const uniqueIds = (members) => new Set(members.map((m) => m.id)).size === members.length

// Weights must be 0 or more, and only for factors that engine computes (combine() throws on others).
const weightsFor = (keys) => z.record(z.enum(keys), z.number().min(0)).optional()
const CONVERGE_FACTORS = ['worst', 'mean', 'returnWorst', 'occasion', 'preference', 'rating', 'weather', 'price', 'cdc', 'antiRepeat', 'crowd']
const ROAM_FACTORS = ['distance', 'occasion', 'preference', 'rating', 'weather', 'price', 'cdc', 'antiRepeat', 'crowd']

export function makePlanSchemas(data) {
  const occasion = z.enum(Object.keys(data.occasionProfiles))
  const weatherCase = z.enum(Object.keys(data.weatherCases)).optional()

  // Shared by /converge and /roam.
  const rankFields = {
    occasion,
    dateTime,
    durationMinutes: z.number().int().min(0).max(720).optional(),
    categories: z.array(category).min(1).optional(),
    groupConstraints: z.array(constraint).default([]),
    excludeVenueIds: z.array(z.string()).default([]),
    // The options the group is already voting on, so a rain swap never suggests one of them again.
    currentOptionIds: z.array(z.string()).default([]),
    unknownPolicy: z.enum(['strict', 'lenient']).default('strict'),
    weatherCase,
    groupId: z.string().optional(),
    topN: z.number().int().min(1).max(20).optional(),
    travelCeilingMinutes: z.number().positive().max(180).optional(),
  }

  const groupFields = {
    members: z.array(travellingMember).min(1).max(30).refine(uniqueIds, 'member ids must be unique'),
    overrides: z.record(z.object({ start: point.optional(), end: point.optional() })).default({}),
    optedOut: z.array(z.string()).default([]),
  }
  const someoneLeft = (b) => b.members.some((m) => !b.optedOut.includes(m.id))
  const NOBODY = { message: 'everyone has opted out', path: ['optedOut'] }

  const converge = z
    .object({
      ...groupFields,
      ...rankFields,
      centre: point.optional(),
      seed: z.enum(['weighted_centroid', 'centroid', 'minimax']).optional(),
      lastStop: z.boolean().default(false),
      lastStopMrtWalkMinutes: z.number().int().min(1).max(30).optional(),
      // The group's chosen search radius around the centre. Without it the search widens on its own up to 3 km.
      radiusMeters: z.number().int().min(100).max(3000).optional(),
      weights: weightsFor(CONVERGE_FACTORS),
    })
    .refine(someoneLeft, NOBODY)
    .refine((b) => b.seed !== 'minimax' || b.centre || b.members.length <= 12, {
      message: 'minimax supports up to 12 people; send a centre or use another seed',
      path: ['seed'],
    })

  const roam = z.object({
    ...rankFields,
    current: point,
    members: z.array(roamMember).min(1).max(30).refine(uniqueIds, 'member ids must be unique'),
    weights: weightsFor(ROAM_FACTORS),
  })

  const meetingArea = z
    .object({
      ...groupFields,
      method: z.enum(['station', 'weighted_centroid', 'centroid', 'minimax']).default('station'),
      maxCandidates: z.number().int().min(1).max(50).optional(),
    })
    .refine(someoneLeft, NOBODY)
    .refine((b) => b.method !== 'minimax' || b.members.length <= 12, {
      message: 'minimax supports up to 12 people',
      path: ['method'],
    })

  // Search by name to add an option. Members are optional: send them to see diet and group-size reasons.
  const search = z.object({
    query: z.string().trim().min(1).max(60),
    centre: point,
    dateTime,
    durationMinutes: z.number().int().min(0).max(720).optional(),
    categories: z.array(category).min(1).optional(),
    lastStop: z.boolean().default(false),
    lastStopMrtWalkMinutes: z.number().int().min(1).max(30).optional(),
    members: z.array(roamMember).max(30).default([]),
    groupConstraints: z.array(constraint).default([]),
    unknownPolicy: z.enum(['strict', 'lenient']).default('strict'),
    maxKm: z.number().positive().max(30).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })

  return { converge, roam, meetingArea, search }
}
