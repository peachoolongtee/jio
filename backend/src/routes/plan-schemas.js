import { z } from 'zod'
import { MAX_MOVABLE_STOPS } from '../planner/arrange.js'

// Request checks for the planner endpoints. Every request is checked here BEFORE the engine runs, so the
// engine only ever sees input it can score, and the frontend gets a 400 that says which field is wrong.
//
// How to call:
//   const schemas = makePlanSchemas(data)        // data = loadPlanData(), for the occasion and weather names
//   const input = schemas.converge.parse(req.body) // throws a ZodError on bad input

// Upper limits on everything a caller can send. Without them one request could keep the server busy
// for minutes: the planner re-runs every filter once per group constraint, and it routes every venue
// listed in currentOptionIds. Each limit is well above what the app sends.
//
// How to use: MAX.constraints, MAX.text and so on, in the schemas below.
const MAX = {
  text: 80, // ids, names and labels
  members: 30,
  alternatives: 3, // runners-up a /meeting-area request may ask for
  includedAreas: 8, // areas a /meeting-area request may name in `include`
  listPerMember: 20, // cuisine likes and dislikes
  constraints: 10, // group constraints
  currentOptions: 30, // the app shows at most 6 options per slot
  excludedVenues: 200,
  categories: 4, // there are only 4 kinds of place
  weight: 1000,
  money: 10000,
  minutes: 1440,
  // How many places to look for and to score per slot (minOptions, shortlistSize). Each scored place costs a
  // OneMap route per member and trip, so 30 is the most one request may ask for.
  options: 30,
  // Rearranging an itinerary: the stops in it, and the orders already shown. Every order of the movable stops is
  // tried, so the stops are capped (planner/arrange.js also allows at most 6 to move).
  stops: 8,
  movableStops: MAX_MOVABLE_STOPS, // the stops that are not meals
  stopMinutes: { min: 15, max: 720 }, // how long one stop lasts
  stopHours: 4, // opening-hour ranges per stop
  mrtWalkMinutes: 120,
  shownOrders: 50,
}
const text = (max = MAX.text) => z.string().min(1).max(max)

// Singapore, with a little margin. Catches swapped lat/lng and (0, 0) from a failed geocode.
const point = z.object({
  lat: z.number().min(1.1).max(1.5),
  lng: z.number().min(103.5).max(104.1),
  label: z.string().max(MAX.text).optional(),
})

// "2026-10-10T19:00": local time, no time zone, sliced not parsed (see filters.js).
const dateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, 'use local time as YYYY-MM-DDTHH:MM, e.g. 2026-10-10T19:00')

// Lowercased first, so "Halal" from a form still means halal instead of rejecting every venue.
const diet = z.string().transform((s) => s.toLowerCase()).pipe(z.enum(['halal', 'vegetarian', 'vegan']))

const constraint = z
  .string()
  .max(MAX.text)
  .regex(
    /^(step_free|sockets|quiet|indoor_only|max_price_pp:\d{1,5}(\.\d{1,2})?|near_mrt:\d{1,3})$/,
    'one of step_free, sockets, quiet, indoor_only, max_price_pp:N, near_mrt:N',
  )

const category = z.enum(['eat', 'drink', 'shop', 'activity'])
// At most 4 (there are only 4 kinds), and a repeated kind counts once.
const categories = z
  .array(category)
  .min(1)
  .max(MAX.categories)
  .transform((c) => [...new Set(c)])
  .optional()

const memberFields = {
  id: text(),
  name: z.string().max(MAX.text).optional(),
  home: point.optional(),
  start: point.optional(),
  end: point.optional(),
  dietary: z.array(diet).max(3).default([]),
  prefersHealthy: z.boolean().default(false),
  cuisineLikes: z.array(text()).max(MAX.listPerMember).default([]),
  cuisineDislikes: z.array(text()).max(MAX.listPerMember).default([]),
  budgetMaxPerPerson: z.number().positive().max(MAX.money).optional(),
  maxReturnMinutes: z.number().positive().max(MAX.minutes).optional(),
  travelDebtMinutes: z.number().min(-MAX.minutes * 10).max(MAX.minutes * 10).default(0),
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
// They also have a ceiling: huge weights overflow to Infinity and turn every score into NaN.
const weightsFor = (keys) => z.record(z.enum(keys), z.number().min(0).max(MAX.weight)).optional()
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
    categories,
    groupConstraints: z.array(constraint).max(MAX.constraints).default([]),
    excludeVenueIds: z.array(text()).max(MAX.excludedVenues).default([]),
    // The options the group is already voting on, so a rain swap never suggests one of them again.
    currentOptionIds: z.array(text()).max(MAX.currentOptions).default([]),
    unknownPolicy: z.enum(['strict', 'lenient']).default('strict'),
    weatherCase,
    groupId: text().optional(),
    topN: z.number().int().min(1).max(20).optional(),
    // Keep widening the search (500 m, 1 km, 2 km, 3 km) until at least this many places fit. Default 3.
    minOptions: z.number().int().min(1).max(MAX.options).optional(),
    // How many places are fully scored, with real travel times. Default 10. More costs more OneMap calls.
    shortlistSize: z.number().int().min(1).max(MAX.options).optional(),
    travelCeilingMinutes: z.number().positive().max(180).optional(),
  }

  const groupFields = {
    members: z.array(travellingMember).min(1).max(MAX.members).refine(uniqueIds, 'member ids must be unique'),
    overrides: z
      .record(text(), z.object({ start: point.optional(), end: point.optional() }))
      .refine((o) => Object.keys(o).length <= MAX.members, `at most ${MAX.members} overrides`)
      .default({}),
    optedOut: z.array(text()).max(MAX.members).default([]),
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
    members: z.array(roamMember).min(1).max(MAX.members).refine(uniqueIds, 'member ids must be unique'),
    weights: weightsFor(ROAM_FACTORS),
  })

  // The `include` list of /meeting-area: at most MAX.includedAreas ids, each a known area and none repeated.
  // An issue names the entry it is about, for example `include.2`.
  const areaIds = new Set((data.areas ?? []).map((a) => a.id))
  const includedAreas = z
    .array(text())
    .max(MAX.includedAreas)
    .superRefine((ids, ctx) => {
      const seen = new Set()
      ids.forEach((id, i) => {
        if (!areaIds.has(id)) ctx.addIssue({ code: 'custom', path: [i], message: 'not an area id the planner knows' })
        else if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [i], message: 'each area can be included once' })
        seen.add(id)
      })
    })

  const meetingArea = z
    .object({
      ...groupFields,
      method: z.enum(['station', 'weighted_centroid', 'centroid', 'minimax']).default('station'),
      maxCandidates: z.number().int().min(1).max(50).optional(),
      // When the group sets off, for real public transport times. Without it, the server uses the time now.
      dateTime: dateTime.optional(),
      // How many runners-up to answer with besides the chosen area. Left out, the answer has no `candidates`.
      alternatives: z.number().int().min(0).max(MAX.alternatives).optional(),
      // Areas to evaluate whatever their rank. Each must be an area id the planner knows, and each only once.
      include: includedAreas.optional(),
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
    categories,
    lastStop: z.boolean().default(false),
    lastStopMrtWalkMinutes: z.number().int().min(1).max(30).optional(),
    members: z.array(roamMember).max(MAX.members).default([]),
    groupConstraints: z.array(constraint).max(MAX.constraints).default([]),
    unknownPolicy: z.enum(['strict', 'lenient']).default('strict'),
    maxKm: z.number().positive().max(30).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })

  // GET /api/places/search?q=... : an address, postal code or building name, sent to OneMap.
  const placeSearch = z.object({ q: z.string().trim().min(1).max(MAX.text) })

  // POST /api/itinerary/arrange: a confirmed itinerary, to put in a new order (see planner/arrange.js).
  const openingHours = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/
  const arrangeStop = z.object({
    id: text(),
    name: text(),
    category,
    kind: text().optional(),
    lat: point.shape.lat,
    lng: point.shape.lng,
    duration: z.number().int().min(MAX.stopMinutes.min).max(MAX.stopMinutes.max),
    // When the itinerary shows the stop starting now, in minutes after midnight. A meal keeps this time.
    start: z.number().int().min(0).max(2 * MAX.minutes).optional(),
    hours: z
      .array(z.string().regex(openingHours, 'use HH:MM-HH:MM, e.g. 10:00-22:00'))
      .max(MAX.stopHours)
      .default([]),
    indoor: z.boolean().optional(),
    mrtWalk: z.number().min(0).max(MAX.mrtWalkMinutes).optional(),
  })
  const arrange = z
    .object({
      stops: z.array(arrangeStop).min(2).max(MAX.stops),
      // When the plan starts, in minutes after midnight.
      startAt: z.number().int().min(0).max(MAX.minutes - 1),
      // When the session ends, in minutes after midnight (over 1440 for past midnight). No order may run past it.
      endAt: z.number().int().min(0).max(2 * MAX.minutes).optional(),
      // Orders already shown, as lists of stop ids, so the next one is different.
      shown: z.array(z.array(text()).max(MAX.stops)).max(MAX.shownOrders).default([]),
      rain: z.boolean().default(false),
      // The first suggestion, when the plan is confirmed: the current order may be the one chosen.
      includeCurrent: z.boolean().default(false),
    })
    .refine((b) => new Set(b.stops.map((s) => s.id)).size === b.stops.length, { message: 'stop ids must be different', path: ['stops'] })
    .refine((b) => b.stops.filter((s) => s.category !== 'eat').length <= MAX.movableStops, {
      message: `at most ${MAX.movableStops} stops that are not food can be rearranged`,
      path: ['stops'],
    })

  return { converge, roam, meetingArea, search, placeSearch, arrange }
}
