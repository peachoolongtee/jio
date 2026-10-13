import { ExternalApiError } from './errors.js'
import { currentScenario } from './scenario.js'
import { REGIONS } from './weather-regions.js'

// The two-hour weather forecast from data.gov.sg (NEA): one forecast sentence for each of 47 areas of
// Singapore, issued every 30 minutes. The call needs no key. Unkeyed it allows 6 requests per 10 seconds,
// so the forecast is cached here and never fetched per venue or per request.

export const TWO_HR_FORECAST_URL = 'https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast'

// The 24-hour (regional) forecast: one forecast sentence for each of five regions, for three or four periods
// that reach 18 to 24 hours ahead. It is issued four times a day and needs no key. It shares the unkeyed limit
// of 6 requests per 10 seconds with the two-hour forecast, so it is cached here too.
export const TWENTY_FOUR_HR_FORECAST_URL = 'https://api-open.data.gov.sg/v2/real-time/api/twenty-four-hr-forecast'

// How likely rain is, from 0 (none) to 1 (certain), for each forecast sentence NEA can send. The planner's
// weather score multiplies it by how exposed a venue is, and treats 0.6 or more as "rain is likely".
//
// Keys are written the way normaliseForecast() returns them: lower case, with a trailing "(day)" or
// "(night)" removed. So "Partly Cloudy (Night)" is looked up as "partly cloudy".
//
// The strings come from the NEA historical forecasts for 2021 and 2022 (17 distinct sentences) and NEA's
// own code table; see ticket #4. The sentences marked "code table only" were never seen in the data but
// NEA defines them, so they are kept to avoid a surprise.
const RAIN_RISK = new Map([
  // No rain.
  ['fair', 0],
  ['fair & warm', 0],
  ['fair and warm', 0], // The specification's spelling. Every real answer says "Fair & Warm"; this is a guard.
  ['partly cloudy', 0],
  ['sunny', 0], // Code table only.
  // Grey or windy, but dry.
  ['cloudy', 0.1],
  ['overcast', 0.1], // Code table only.
  ['hazy', 0.1],
  ['slightly hazy', 0.1],
  ['mist', 0.1],
  ['fog', 0.1],
  ['windy', 0.1],
  ['windy, cloudy', 0.1], // Code table only.
  ['windy, fair', 0.1], // Code table only.
  ['strong winds', 0.1], // Code table only.
  // Light rain: possible, and not worth moving a plan for.
  ['light rain', 0.5],
  ['light showers', 0.5],
  ['passing showers', 0.5],
  ['drizzle', 0.5], // Code table only.
  // Rain.
  ['showers', 0.8],
  ['moderate rain', 0.8],
  ['rain', 0.8], // Not an NEA sentence, kept as a harmless alias.
  ['windy, rain', 0.8], // Code table only.
  ['windy, showers', 0.8], // Code table only.
  ['strong winds, rain', 0.8], // Code table only.
  // Heavy rain or thunder.
  ['heavy rain', 1],
  ['heavy showers', 1],
  ['thundery showers', 1],
  ['heavy thundery showers', 1],
  ['heavy thundery showers with gusty winds', 1],
  ['strong winds, showers', 1], // Code table only.
])

// What an unknown sentence is worth: a middle value, below the 0.6 "rain is likely" line, so a sentence
// we have not seen neither raises a rain warning nor claims the day is dry. Never 0.
export const UNKNOWN_RAIN_RISK = 0.5

// Every sentence the table knows, in the form the table uses. Tests walk this list.
export const KNOWN_FORECASTS = [...RAIN_RISK.keys()]

// The four states a screen shows for a forecast sentence, plus 'unknown' for "Not known". The planner and the
// weather route send these; the screens turn them into words and marks.
export const WEATHER_STATES = ['dry', 'cloudy', 'showers', 'thundery', 'unknown']

// Which state each sentence in RAIN_RISK shows as. Keys are written the same way. A test checks that every
// sentence in RAIN_RISK has a row here.
//
//   dry       no rain risk (0 above)
//   cloudy    grey, hazy or windy but dry (0.1 above)
//   showers   any rain, light or heavy, without thunder (0.5 and above)
//   thundery  thundery showers of any strength
const FORECAST_STATE = new Map([
  ['fair', 'dry'],
  ['fair & warm', 'dry'],
  ['fair and warm', 'dry'],
  ['partly cloudy', 'dry'],
  ['sunny', 'dry'],
  ['cloudy', 'cloudy'],
  ['overcast', 'cloudy'],
  ['hazy', 'cloudy'],
  ['slightly hazy', 'cloudy'],
  ['mist', 'cloudy'],
  ['fog', 'cloudy'],
  ['windy', 'cloudy'],
  ['windy, cloudy', 'cloudy'],
  ['windy, fair', 'cloudy'],
  ['strong winds', 'cloudy'],
  ['light rain', 'showers'],
  ['light showers', 'showers'],
  ['passing showers', 'showers'],
  ['drizzle', 'showers'],
  ['showers', 'showers'],
  ['moderate rain', 'showers'],
  ['rain', 'showers'],
  ['windy, rain', 'showers'],
  ['windy, showers', 'showers'],
  ['strong winds, rain', 'showers'],
  ['heavy rain', 'showers'],
  ['heavy showers', 'showers'],
  ['strong winds, showers', 'showers'],
  ['thundery showers', 'thundery'],
  ['heavy thundery showers', 'thundery'],
  ['heavy thundery showers with gusty winds', 'thundery'],
])

// Trims, lower-cases, collapses spaces and drops a trailing "(Day)" or "(Night)", so the table does not
// need a row for each.
//
// How to call:
//   normaliseForecast('Partly Cloudy (Night)') // 'partly cloudy'
//   normaliseForecast('  Fair & Warm ')        // 'fair & warm'
export function normaliseForecast(text) {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/ \((day|night)\)$/, '')
}

// Looks one forecast sentence up in the table. Never throws: an unknown sentence gets UNKNOWN_RAIN_RISK
// and `known: false`, so the caller can log it.
//
// How to call:
//   rainRiskOf('Heavy Thundery Showers') // { risk: 1, known: true }
//   rainRiskOf('Blizzard')               // { risk: 0.5, known: false }
export function rainRiskOf(text) {
  const risk = RAIN_RISK.get(normaliseForecast(text))
  return risk === undefined ? { risk: UNKNOWN_RAIN_RISK, known: false } : { risk, known: true }
}

// The state a forecast sentence shows as. Never throws: an unknown sentence is 'unknown', and `known: false`
// lets the caller log it.
//
// How to call:
//   forecastStateOf('Heavy Thundery Showers') // { state: 'thundery', known: true }
//   forecastStateOf('Partly Cloudy (Night)')  // { state: 'dry', known: true }
//   forecastStateOf('Blizzard')               // { state: 'unknown', known: false }
export function forecastStateOf(text) {
  const state = FORECAST_STATE.get(normaliseForecast(text))
  return state === undefined ? { state: 'unknown', known: false } : { state, known: true }
}

// Turns data.gov.sg's two-hour answer into the shape the planner uses. Each area comes with its own
// coordinates, read by key because the order of latitude and longitude is not fixed.
//
// How to call. You normally never do: createWeather calls it. `onUnknown` hears each unknown sentence:
//   const forecast = parseTwoHourForecast(await http.getJson(TWO_HR_FORECAST_URL))
//   forecast.areas[0] // { area: 'Ang Mo Kio', lat: 1.375, lng: 103.839, forecast: 'Fair (Day)', rainRisk: 0 }
//
// Throws ExternalApiError when the answer does not look like a forecast, so a caller that falls back on
// ExternalApiError also covers a changed response.
export function parseTwoHourForecast(payload, { onUnknown = () => {} } = {}) {
  const fail = (reason) =>
    new ExternalApiError(`datagov sent an unexpected forecast: ${reason}`, {
      service: 'datagov',
      status: null,
      url: TWO_HR_FORECAST_URL,
    })

  if (payload?.code !== 0) throw fail(`code ${payload?.code ?? 'missing'}`)
  const item = payload.data?.items?.[0]
  const metadata = payload.data?.area_metadata
  if (!item || !Array.isArray(item.forecasts) || !Array.isArray(metadata)) throw fail('no forecast or no areas')

  const places = new Map()
  for (const m of metadata) {
    const lat = m?.label_location?.latitude
    const lng = m?.label_location?.longitude
    if (typeof m?.name === 'string' && Number.isFinite(lat) && Number.isFinite(lng)) places.set(m.name, { lat, lng })
  }

  // An area with no coordinates or no forecast is left out: the planner cannot place a venue in it.
  const areas = []
  for (const f of item.forecasts) {
    const place = places.get(f?.area)
    if (!place || typeof f.forecast !== 'string') continue
    const { risk, known } = rainRiskOf(f.forecast)
    if (!known) onUnknown(f.forecast)
    areas.push({ area: f.area, lat: place.lat, lng: place.lng, forecast: f.forecast, rainRisk: risk })
  }
  if (areas.length === 0) throw fail('no area has both a forecast and a location')

  const period = item.valid_period ?? {}
  return {
    areas,
    validPeriod: { start: period.start ?? null, end: period.end ?? null },
    updatedAt: item.update_timestamp ?? null,
    issuedAt: item.timestamp ?? item.update_timestamp ?? null,
  }
}

// Reads a time from data.gov.sg into milliseconds since the epoch. Times carry an offset (`+08:00`); a time with
// none is taken as Singapore time, never as the server's, so the answer does not depend on the machine's zone.
// Returns NaN for anything else.
//
// How to call:
//   parseForecastTime('2026-10-11T18:00:00+08:00') // 1760176800000
//   parseForecastTime('2026-10-11T18:00:00')       // the same
//   parseForecastTime('tomorrow')                  // NaN
export function parseForecastTime(text) {
  if (typeof text !== 'string') return NaN
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})?$/.exec(text.trim())
  if (!match) return NaN
  return Date.parse(`${match[1]}${match[2] ?? '+08:00'}`)
}

// Turns data.gov.sg's 24-hour answer into the shape the planner uses: the periods of the latest issue, each with
// a forecast sentence for each region. Everything is read by key, because the order of keys is not fixed, and
// the number of periods is not assumed (three or four are seen).
//
// How to call. You normally never do: createWeather calls it. `onUnknown` hears each unknown sentence:
//   const forecast = parseTwentyFourHourForecast(await http.getJson(TWENTY_FOUR_HR_FORECAST_URL))
//   forecast.periods[0].regions.west // { forecast: 'Thundery Showers', rainRisk: 1 }
//   forecast.lastEndMs               // when the last period ends
//
// A period with an unreadable time, or with none of the five regions, is left out. A region without a sentence
// is left out of its period. Throws ExternalApiError when the answer does not look like a forecast or has no
// period left, so a caller that falls back on ExternalApiError also covers a changed response.
export function parseTwentyFourHourForecast(payload, { onUnknown = () => {} } = {}) {
  const fail = (reason) =>
    new ExternalApiError(`datagov sent an unexpected 24-hour forecast: ${reason}`, {
      service: 'datagov',
      status: null,
      url: TWENTY_FOUR_HR_FORECAST_URL,
    })

  if (payload?.code !== 0) throw fail(`code ${payload?.code ?? 'missing'}`)
  const records = payload.data?.records
  if (!Array.isArray(records) || records.length === 0) throw fail('no record')

  // The latest issue. An answer for one moment holds one record; one for a whole day holds every issue.
  const issuedMs = (r) => parseForecastTime(r?.updatedTimestamp ?? r?.timestamp)
  const record = records
    .filter((r) => r && typeof r === 'object')
    .reduce((best, r) => (best === null || issuedMs(r) > issuedMs(best) ? r : best), null)
  if (!record || !Array.isArray(record.periods)) throw fail('no periods')

  const periods = []
  for (const p of record.periods) {
    const startMs = parseForecastTime(p?.timePeriod?.start)
    const endMs = parseForecastTime(p?.timePeriod?.end)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue
    const regions = {}
    for (const region of REGIONS) {
      const text = p.regions?.[region]?.text
      if (typeof text !== 'string' || text.trim() === '') continue
      const { risk, known } = rainRiskOf(text)
      if (!known) onUnknown(text)
      regions[region] = { forecast: text, rainRisk: risk }
    }
    if (Object.keys(regions).length === 0) continue
    periods.push({ start: p.timePeriod.start, end: p.timePeriod.end, startMs, endMs, regions })
  }
  if (periods.length === 0) throw fail('no period has a time and a region')

  const general = record.general?.forecast?.text
  return {
    periods,
    lastEndMs: Math.max(...periods.map((p) => p.endMs)),
    general: typeof general === 'string' && general.trim() !== '' ? general : null,
    issuedAt: record.timestamp ?? record.updatedTimestamp ?? null,
    updatedAt: record.updatedTimestamp ?? null,
  }
}

// The period of a regional forecast that covers a moment, or null. A period covers its start and not its end.
// A forecast whose last period has ended covers nothing, however old the moment.
//
// How to call:
//   const period = periodCovering(forecast, Date.parse('2026-10-12T09:00:00+08:00'))
//   period?.regions.east // { forecast: 'Partly Cloudy (Day)', rainRisk: 0 }
export function periodCovering(forecast, ms) {
  return forecast.periods.find((p) => p.startMs <= ms && ms < p.endMs) ?? null
}

// Builds the weather service.
//
// How to call:
//   const weather = createWeather({ http })                   // http from createHttp(), shared by the app.
//   const forecast = await weather.twoHourForecast()
//   forecast.validPeriod.end // '2026-10-05T11:30:00+08:00'
//   forecast.areas           // 47 entries: { area, lat, lng, forecast, rainRisk }
//   const regional = await weather.regionalForecast()
//   regional.periods         // 3 or 4 entries: { start, end, startMs, endMs, regions: { west: { forecast, rainRisk }, ... } }
//
// In a test, control the clock and watch the cache:
//   const weather = createWeather({ http, now: () => clock })
//
// Options:
//   http       - The shared HTTP helper. Every call goes through http.getJson, so stub mode answers from fixtures.
//   now        - Returns the time in milliseconds. Defaults to Date.now.
//   cacheMs    - How long a two-hour forecast is reused. Default 5 minutes. NEA issues one every 30 minutes.
//   regionalCacheMs - How long a regional forecast is reused. Default 10 minutes. NEA issues one four times a day.
//   failureMs  - How long a failed fetch is remembered, so a data.gov.sg outage costs one slow request
//                rather than one per planner request. Default 30 seconds. Both forecasts use it.
//   warn       - Where to report an unknown forecast sentence. Defaults to console.warn.
//
// twoHourForecast() and regionalForecast() reject with ExternalApiError when data.gov.sg fails (including a
// timeout), answers something that is not a forecast, or, for the regional one, answers a forecast whose
// periods have all ended. Callers decide what to do then. Any other error, such as a missing stub, is a bug and
// is never cached.
//
// Each forecast has its own cache entry and its own in-flight request: callers who arrive while a fetch is
// running share it. A cached regional forecast whose last period has ended since is fetched again.
//
// The scenario is part of the cache key. Outside stub mode it is always 'dry', so this changes nothing
// there; in stub mode it stops a rain test from leaking its forecast into the next dry one.
export function createWeather({
  http,
  now = Date.now,
  cacheMs = 5 * 60 * 1000,
  regionalCacheMs = 10 * 60 * 1000,
  failureMs = 30 * 1000,
  warn = console.warn,
}) {
  // One entry per cache key: { at, failed, promise, value }. The promise is stored, not the result, so callers
  // who arrive while a fetch is running share it instead of starting their own. `value` is set when it resolves.
  const entries = new Map()
  // Each unknown sentence is reported once, not once per request.
  const reported = new Set()

  const onUnknown = (text) => {
    if (reported.has(text)) return
    reported.add(text)
    warn(`Unknown forecast "${text}": scored as ${UNKNOWN_RAIN_RISK} and shown as unknown. Add it to RAIN_RISK and FORECAST_STATE in services/weather.js.`)
  }

  // Returns the cached forecast of a kind, or fetches it. `usable(value, at)` says whether a cached value may
  // still be served at time `at`.
  //
  // How to call:
  //   return cached('two-hr-forecast', cacheMs, fetchTwoHour)
  function cached(kind, ttlMs, fetchFresh, usable = () => true) {
    const key = `${kind}:${currentScenario()}`
    const at = now()
    const hit = entries.get(key)
    if (hit) {
      if (hit.failed ? at - hit.at < failureMs : at - hit.at < ttlMs && (hit.value === undefined || usable(hit.value, at))) {
        return hit.promise
      }
    }

    const entry = { at, failed: false, promise: null, value: undefined }
    entry.promise = fetchFresh()
      .then((value) => {
        entry.value = value
        return value
      })
      .catch((err) => {
        // Remember an API failure briefly. Anything else is a bug: forget it so the next call retries.
        if (err instanceof ExternalApiError) entry.failed = true
        else if (entries.get(key) === entry) entries.delete(key)
        throw err
      })
    entries.set(key, entry)
    return entry.promise
  }

  const fetchTwoHour = async () => parseTwoHourForecast(await http.getJson(TWO_HR_FORECAST_URL), { onUnknown })

  const fetchRegional = async () => {
    const forecast = parseTwentyFourHourForecast(await http.getJson(TWENTY_FOUR_HR_FORECAST_URL), { onUnknown })
    // An answer whose last period has ended is stale (data.gov.sg can serve old data during maintenance).
    if (forecast.lastEndMs <= now()) {
      throw new ExternalApiError('datagov sent a 24-hour forecast whose periods have all ended', {
        service: 'datagov',
        status: null,
        url: TWENTY_FOUR_HR_FORECAST_URL,
      })
    }
    return forecast
  }

  return {
    twoHourForecast: () => cached('two-hr-forecast', cacheMs, fetchTwoHour),
    regionalForecast: () => cached('twenty-four-hr-forecast', regionalCacheMs, fetchRegional, (f, at) => f.lastEndMs > at),
  }
}
