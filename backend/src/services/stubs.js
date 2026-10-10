import { readFileSync } from 'node:fs'
import { ExternalApiError } from './errors.js'

// Where the fixture files live: backend/tests/fixtures/.
const FIXTURES_DIR = new URL('../../tests/fixtures/', import.meta.url)

// Fixtures already read from disk, so each file is read once.
const fixtureCache = new Map()

// Reads one fixture file and returns its parsed JSON.
//
// How to call. The path is relative to backend/tests/fixtures/:
//   const forecast = loadFixture('datagov/two-hr-forecast.dry.json')
//
// The demo-day rain override can call this directly to serve a rain forecast.
export function loadFixture(relativePath) {
  if (!fixtureCache.has(relativePath)) {
    const text = readFileSync(new URL(relativePath, FIXTURES_DIR), 'utf8')
    fixtureCache.set(relativePath, JSON.parse(text))
  }
  // Hand back a copy, so a caller that edits the result cannot change the cache.
  return structuredClone(fixtureCache.get(relativePath))
}

// Turns OneMap's "lat,lng" text into numbers.
function parsePoint(text, name, url) {
  const [lat, lng] = String(text ?? '').split(',').map(Number)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new ExternalApiError(`onemap stub: "${name}" must look like "1.3521,103.8198"`, {
      service: 'onemap',
      status: 400,
      url,
    })
  }
  return { lat, lng }
}

// Straight-line distance between two points, in metres.
function haversineMetres(a, b) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180
  const dLat = toRadians(b.lat - a.lat)
  const dLng = toRadians(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(h))
}

// Used when a route request carries no usable date and time: 5 Jan 2026, 12:00 Singapore time.
const FIXED_START_MS = Date.UTC(2026, 0, 5, 4, 0, 0)

// Turns OneMap's date (MM-DD-YYYY) and time (HH:MM:SS), which are Singapore
// time, into epoch milliseconds.
function startTimeMs(date, time) {
  const d = /^(\d{2})-(\d{2})-(\d{4})$/.exec(date ?? '')
  const t = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time ?? '')
  if (!d || !t) return FIXED_START_MS
  // Singapore is UTC+8, so subtract 8 hours to get UTC.
  return Date.UTC(Number(d[3]), Number(d[1]) - 1, Number(d[2]), Number(t[1]) - 8, Number(t[2]), Number(t[3]))
}

// Builds a fake OneMap route from the straight-line distance between two points.
// The same inputs always give the same route, and a farther venue always takes
// longer, so tests can assert on ranking.
//
// How to call. You normally never do: http.getJson calls it for you in stub
// mode. Directly, it takes the same URL you would send to OneMap:
//   const route = syntheticRoute(new URL('https://www.onemap.gov.sg/api/public/routingsvc/route' +
//     '?start=1.4360,103.7860&end=1.3048,103.8318&routeType=pt&date=10-05-2026&time=18:30:00'))
//   route.plan.itineraries[0].duration // Seconds.
//
// routeType=pt returns the public transport shape, the same as
// tests/fixtures/onemap/route.pt.sample.json. routeType=walk returns OneMap's
// route_summary shape.
export function syntheticRoute(url) {
  const params = url.searchParams
  const start = parsePoint(params.get('start'), 'start', url.href)
  const end = parsePoint(params.get('end'), 'end', url.href)
  const metres = haversineMetres(start, end)

  if (params.get('routeType') === 'walk') {
    // Real paths bend, so pad the straight line by 30%. Walking pace is 80 metres a minute.
    const walkMetres = Math.round(metres * 1.3)
    return {
      status_message: 'Found route between points',
      status: 0,
      route_geometry: '',
      route_instructions: [],
      route_name: [],
      route_summary: {
        start_point: '',
        end_point: '',
        total_time: Math.round(walkMetres / (80 / 60)), // Seconds.
        total_distance: walkMetres, // Metres.
      },
    }
  }

  // Public transport: a 3 minute walk at each end, a train at about 30 km/h,
  // and a 4 minute wait for the first train and for every transfer.
  const transfers = metres < 6000 ? 0 : metres < 14000 ? 1 : 2
  const walkEachEnd = 180
  const walkTime = walkEachEnd * 2
  const transitTime = Math.round(metres / 8.3)
  const waitingTime = 240 * (1 + transfers)
  const duration = walkTime + transitTime + waitingTime

  const startTime = startTimeMs(params.get('date'), params.get('time'))
  const boardTime = startTime + (walkEachEnd + waitingTime) * 1000
  const alightTime = boardTime + transitTime * 1000
  const endTime = startTime + duration * 1000

  const from = { name: 'Origin', lat: start.lat, lon: start.lng }
  const to = { name: 'Destination', lat: end.lat, lon: end.lng }

  return {
    requestParameters: { date: params.get('date'), time: params.get('time'), mode: 'TRANSIT,WALK' },
    plan: {
      date: startTime,
      from,
      to,
      itineraries: [
        {
          duration, // Seconds.
          startTime, // Epoch milliseconds.
          endTime,
          walkTime,
          transitTime,
          waitingTime,
          walkDistance: 480,
          transfers,
          fare: '1.50',
          legs: [
            {
              startTime,
              endTime: startTime + walkEachEnd * 1000,
              mode: 'WALK',
              transitLeg: false,
              route: '',
              distance: 240,
              duration: walkEachEnd,
              from: { ...from, departure: startTime },
              to: { name: 'STUB MRT STATION A', arrival: startTime + walkEachEnd * 1000, departure: boardTime },
            },
            {
              startTime: boardTime,
              endTime: alightTime,
              mode: 'SUBWAY',
              transitLeg: true,
              route: 'STUB',
              routeShortName: 'STUB',
              routeLongName: 'STUB LINE',
              agencyName: 'Stub Transit',
              distance: Math.round(metres),
              duration: transitTime,
              from: { name: 'STUB MRT STATION A', departure: boardTime },
              to: { name: 'STUB MRT STATION B', arrival: alightTime, departure: alightTime },
            },
            {
              startTime: alightTime,
              endTime,
              mode: 'WALK',
              transitLeg: false,
              route: '',
              distance: 240,
              duration: walkEachEnd,
              from: { name: 'STUB MRT STATION B', departure: alightTime },
              to: { ...to, arrival: endTime },
            },
          ],
        },
      ],
    },
  }
}

// One rule per external endpoint the stubs can answer. The first rule whose
// method, host and path all match the request wins.
//
// How to add an endpoint:
//   1. Save a real response under backend/tests/fixtures/<provider>/.
//   2. Add a rule here. `respond` receives { url, scenario } and returns the data.
//   3. To make it fail in a scenario, throw an ExternalApiError from `respond`.
//
//   {
//     method: 'GET',
//     host: 'api-open.data.gov.sg',
//     path: '/v2/real-time/api/twenty-four-hr-forecast',
//     respond: ({ scenario }) =>
//       loadFixture(`datagov/twenty-four-hr-forecast.${scenario === 'rain' ? 'rain' : 'dry'}.json`),
//   },
const rules = [
  {
    method: 'POST',
    host: 'places.googleapis.com',
    path: '/v1/places:searchNearby',
    // Six invented places near Bishan MRT (made-up ids, names, addresses and ratings, not a recording). Same answer
    // wherever the search is.
    respond: () => loadFixture('google/places-nearby.json'),
  },
  {
    method: 'GET',
    host: 'places.googleapis.com',
    // A photo's address: /v1/places/<place id>/photos/<photo id>/media
    pathPattern: /^\/v1\/places\/[^/]+\/photos\/[^/]+\/media$/,
    respond: ({ url }) => ({ name: url.pathname.slice(4, -6), photoUri: 'https://lh3.googleusercontent.com/stub-photo' }),
  },
  {
    method: 'GET',
    host: 'api-open.data.gov.sg',
    path: '/v2/real-time/api/two-hr-forecast',
    // Rain only in the rain scenario. Every other scenario gets fair weather.
    respond: ({ scenario }) =>
      loadFixture(`datagov/two-hr-forecast.${scenario === 'rain' ? 'rain' : 'dry'}.json`),
  },
  {
    method: 'POST',
    host: 'www.onemap.gov.sg',
    path: '/api/auth/post/getToken',
    respond: () => loadFixture('onemap/token.json'),
  },
  {
    method: 'GET',
    host: 'www.onemap.gov.sg',
    path: '/api/common/elastic/search',
    // Always the same address, whatever was searched for.
    respond: () => loadFixture('onemap/search.json'),
  },
  {
    method: 'GET',
    host: 'www.onemap.gov.sg',
    path: '/api/public/routingsvc/route',
    respond: ({ url, scenario }) => {
      if (scenario === 'routing-fail') {
        throw new ExternalApiError('onemap stub: routing is down in the routing-fail scenario', {
          service: 'onemap',
          status: 503,
          url: url.href,
        })
      }
      return syntheticRoute(url)
    },
  },
]

// Answers one external request from the rules above. createHttp calls this in
// stub mode, so you normally never call it yourself.
//
// How to call:
//   const data = resolveStub('GET', 'https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast', 'rain')
export function resolveStub(method, url, scenario) {
  const parsed = new URL(url)
  const rule = rules.find(
    (r) =>
      r.method === method &&
      r.host === parsed.hostname &&
      (r.path ? r.path === parsed.pathname : r.pathPattern.test(parsed.pathname)),
  )

  // A missing rule is a gap in our stubs, not an API failure. It throws a plain
  // Error on purpose, so fallback code that catches ExternalApiError cannot hide
  // it, and the request never falls through to the real network.
  if (!rule) {
    throw new Error(
      `No stub for ${method} ${parsed.origin}${parsed.pathname}. ` +
        'Add a fixture and a rule in backend/src/services/stubs.js. ' +
        'See backend/tests/fixtures/README.md.',
    )
  }

  return rule.respond({ url: parsed, scenario })
}
