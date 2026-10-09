import { haversineKm } from '../planner/geo.js'
import { createCache } from './cache.js'
import { currentScenario } from './scenario.js'

// Live weather from NEA (National Environment Agency), through data.gov.sg. No API key is needed.
//
// The 2-hour forecast gives a short text ("Fair (Day)", "Heavy Thundery Showers") for 47 named areas, each with
// a point. This file turns that into what the planner reads: a rain risk from 0 to 1 per area, and the nearest
// area for every venue. Every call goes through the shared HTTP helper, so stub mode answers from fixtures.
//
// Source: https://data.gov.sg/collections/1456/view (Weather Forecast, NEA).

export const TWO_HOUR_FORECAST_URL = 'https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast'

// The forecast is refreshed every 30 minutes by NEA, so 5 minutes stale is fine and saves calls.
const FORECAST_TTL_MS = 5 * 60 * 1000

// How likely rain is for each kind of NEA forecast text, from 0 to 1. Checked in order: the first match wins,
// so the stronger words come first. These are our judgements, not NEA figures: NEA gives a word, not a percentage.
// The words are NEA's published forecast abbreviations (FA, FN, PC, CL, LR, RA, HR, PS, LS, SH, HS, TL, HT...).
const RAIN_RISK_RULES = [
  [/heavy thundery/i, 0.95],
  [/thundery/i, 0.9],
  [/heavy (rain|showers)/i, 0.85],
  [/^(rain|moderate rain)/i, 0.75],
  [/^showers/i, 0.7],
  [/(passing|light) showers|light rain|drizzle/i, 0.5],
  [/cloudy/i, 0.15], // "Cloudy" and "Partly Cloudy"
  [/fair|hazy|haze|windy|mist|fog|sunny|warm/i, 0.05],
]

// Unknown text is not "dry": a middle value, and the caller is told the text was not recognised.
const UNKNOWN_RAIN_RISK = 0.3

// Rain risk for one forecast text.
//
// How to call:
//   rainRiskOf('Heavy Thundery Showers') // { rainRisk: 0.95, known: true }
//   rainRiskOf('Something new')          // { rainRisk: 0.3, known: false }
export function rainRiskOf(text) {
  for (const [pattern, risk] of RAIN_RISK_RULES) if (pattern.test(text ?? '')) return { rainRisk: risk, known: true }
  return { rainRisk: UNKNOWN_RAIN_RISK, known: false }
}

// Reads the NEA answer into a plain shape. Throws if the answer is not the shape we expect, so a changed API
// fails loudly instead of quietly giving every venue no weather.
//
// How to call:
//   const forecast = parseTwoHourForecast(await http.getJson(TWO_HOUR_FORECAST_URL))
//   forecast.areas[0]          // { name: 'Ang Mo Kio', lat: 1.375, lng: 103.839, forecast: 'Fair (Day)', rainRisk: 0.05 }
//   forecast.validFrom         // '2026-10-05T09:30:00+08:00'
export function parseTwoHourForecast(body) {
  const data = body?.data
  const item = data?.items?.[0]
  if (!Array.isArray(data?.area_metadata) || !Array.isArray(item?.forecasts)) {
    throw new Error('NEA two-hour forecast: unexpected answer shape (no area_metadata or forecasts)')
  }
  const textByArea = new Map(item.forecasts.map((f) => [f.area, f.forecast]))
  const unknownTexts = new Set()
  const areas = data.area_metadata
    .filter((a) => textByArea.has(a.name))
    .map((a) => {
      const forecast = textByArea.get(a.name)
      const { rainRisk, known } = rainRiskOf(forecast)
      if (!known) unknownTexts.add(forecast)
      return { name: a.name, lat: a.label_location.latitude, lng: a.label_location.longitude, forecast, rainRisk }
    })
  if (areas.length === 0) throw new Error('NEA two-hour forecast: no area has a forecast')
  return {
    areas,
    validFrom: item.valid_period?.start ?? null,
    validTo: item.valid_period?.end ?? null,
    validText: item.valid_period?.text ?? null,
    updatedAt: item.update_timestamp ?? item.timestamp ?? null,
    unknownTexts: [...unknownTexts],
  }
}

// Is a local planner time ("2026-10-10T19:00", Singapore time) inside the forecast's period?
// The 2-hour forecast says nothing about later in the day or another day, so it must not be used for them.
//
// How to call:
//   coversTime(forecast, '2026-10-05T10:00') // true when the forecast runs 09:30 to 11:30 that day
export function coversTime(forecast, dateTime) {
  if (!forecast.validFrom || !forecast.validTo) return false
  const t = Date.parse(`${dateTime}:00+08:00`)
  return t >= Date.parse(forecast.validFrom) && t < Date.parse(forecast.validTo)
}

// The nearest NEA area to a point, by straight-line distance.
//
// How to call:
//   nearestForecastArea({ lat: 1.3, lng: 103.85 }, forecast.areas) // { name: 'Downtown Core', ... }
export function nearestForecastArea(point, areas) {
  let best = null
  let bestKm = Infinity
  for (const a of areas) {
    const km = haversineKm(point, a)
    if (km < bestKm) [best, bestKm] = [a, km]
  }
  return best
}

// Builds the weather service.
//
// How to call:
//   const weather = createWeather({ http: req.app.locals.http })
//   const forecast = await weather.twoHourForecast()
//
// Options:
//   http   - The shared HTTP helper (services/http.js). Stub mode answers from the fixtures.
//   apiKey - Optional data.gov.sg key (DATAGOV_API_KEY). Not needed; it only raises the rate limit.
//   cache  - Optional. Tests pass their own to check what is fetched.
export function createWeather({ http, apiKey = null, cache = createCache({ ttlMs: FORECAST_TTL_MS }) }) {
  const headers = apiKey ? { 'x-api-key': apiKey } : undefined
  return {
    // The current 2-hour forecast, parsed. Cached for 5 minutes. The key includes the stub scenario, so a rain
    // test never leaks its forecast into the next dry test (see services/scenario.js).
    //
    // How to call:
    //   const { areas, validFrom, validTo } = await weather.twoHourForecast()
    //
    // Throws ExternalApiError when data.gov.sg fails. The planner routes catch it and plan without live weather.
    twoHourForecast: () =>
      cache.getOrSet(`two-hr-forecast:${currentScenario()}`, async () => parseTwoHourForecast(await http.getJson(TWO_HOUR_FORECAST_URL, { headers }))),
  }
}
