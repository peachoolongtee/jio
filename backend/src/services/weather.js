import { ExternalApiError } from './errors.js'
import { currentScenario } from './scenario.js'

// The two-hour weather forecast from data.gov.sg (NEA): one forecast sentence for each of 47 areas of
// Singapore, issued every 30 minutes. The call needs no key. Unkeyed it allows 6 requests per 10 seconds,
// so the forecast is cached here and never fetched per venue or per request.

export const TWO_HR_FORECAST_URL = 'https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast'

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
  }
}

// Builds the weather service.
//
// How to call:
//   const weather = createWeather({ http })                   // http from createHttp(), shared by the app.
//   const forecast = await weather.twoHourForecast()
//   forecast.validPeriod.end // '2026-10-05T11:30:00+08:00'
//   forecast.areas           // 47 entries: { area, lat, lng, forecast, rainRisk }
//
// In a test, control the clock and watch the cache:
//   const weather = createWeather({ http, now: () => clock })
//
// Options:
//   http      - The shared HTTP helper. Every call goes through http.getJson, so stub mode answers from fixtures.
//   now       - Returns the time in milliseconds. Defaults to Date.now.
//   cacheMs   - How long a forecast is reused. Default 5 minutes. NEA issues one every 30 minutes.
//   failureMs - How long a failed fetch is remembered, so a data.gov.sg outage costs one slow request
//               rather than one per planner request. Default 30 seconds.
//   warn      - Where to report an unknown forecast sentence. Defaults to console.warn.
//
// twoHourForecast() rejects with ExternalApiError when data.gov.sg fails (including a timeout). Callers
// decide what to do then. Any other error, such as a missing stub, is a bug and is never cached.
//
// The scenario is part of the cache key. Outside stub mode it is always 'dry', so this changes nothing
// there; in stub mode it stops a rain test from leaking its forecast into the next dry one.
export function createWeather({ http, now = Date.now, cacheMs = 5 * 60 * 1000, failureMs = 30 * 1000, warn = console.warn }) {
  // One entry per cache key: { at, failed, promise }. The promise is stored, not the result, so callers
  // who arrive while a fetch is running share it instead of starting their own.
  const entries = new Map()
  // Each unknown sentence is reported once, not once per request.
  const reported = new Set()

  const onUnknown = (text) => {
    if (reported.has(text)) return
    reported.add(text)
    warn(`Unknown two-hour forecast "${text}": scored as ${UNKNOWN_RAIN_RISK}. Add it to RAIN_RISK in services/weather.js.`)
  }

  const fetchForecast = async () => parseTwoHourForecast(await http.getJson(TWO_HR_FORECAST_URL), { onUnknown })

  return {
    twoHourForecast() {
      const key = `two-hr-forecast:${currentScenario()}`
      const at = now()
      const hit = entries.get(key)
      if (hit && at - hit.at < (hit.failed ? failureMs : cacheMs)) return hit.promise

      const entry = { at, failed: false, promise: null }
      entry.promise = fetchForecast().catch((err) => {
        // Remember an API failure briefly. Anything else is a bug: forget it so the next call retries.
        if (err instanceof ExternalApiError) entry.failed = true
        else if (entries.get(key) === entry) entries.delete(key)
        throw err
      })
      entries.set(key, entry)
      return entry.promise
    },
  }
}
