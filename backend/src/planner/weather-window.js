// weather-window.js: which forecast a stop is judged against, decided by how far away the stop is.
//
//   within 2 hours of now (or already past)   the area forecast (two-hour), as it always was
//   up to 25 hours ahead, when a period of the   the regional forecast (24-hour), each venue taking the forecast of the
//   regional forecast covers the stop's start    region its two-hour area falls in
//   anything else                              weather has no effect: no penalty, no rain warning, no indoor swap
//
// A simulated weather case (a request's `weatherCase`, when the server allows it) skips all of this and applies at any
// date. See backend/docs/planner-api.md, "Weather".
//
// How to use it. One resolver is built per app and shared by the planner routes and POST /api/weather/stops:
//   const resolver = createWeatherResolver({ data: loadPlanData(), weather, now: Date.now })
//   const { planData, weatherCase, forecast, weather: block } = await resolver.resolve({ start: '2026-10-12T19:00' })

import { createRegionLookup } from '../services/weather-regions.js'
import { ExternalApiError } from '../services/errors.js'
import { periodCovering } from '../services/weather.js'
import { nearestArea, approxRegion } from './cdc-adapter.js'
import { LIVE_WEATHER_CASE, NO_WEATHER_CASE, regionalAreaForecast, withLiveWeather, withNoWeather } from './live-weather.js'
import { rainWarning, weatherOf } from './scoring.js'

const HOUR_MS = 60 * 60 * 1000

/** A stop starting within this long of now is judged by the two-hour (area) forecast. */
export const AREA_WITHIN_MS = 2 * HOUR_MS

/**
 * A stop further ahead than this cannot be covered by the regional forecast, which reaches 18 to 24 hours and 25
 * minutes ahead. The regional forecast is not even fetched for it. Not the lead's rule, only the longest reach seen.
 */
export const REGIONAL_REACH_MS = 25 * HOUR_MS

/** How often one kind of failure is logged, at most. */
const LOG_EVERY_MS = 60 * 1000

/**
 * Singapore local time now, as the planner writes it: "2026-10-10T19:00". Singapore has no daylight saving, so this is
 * the clock plus 8 hours; the server's own time zone plays no part.
 *
 * How to call:
 *   singaporeNow(Date.now()) // '2026-10-10T19:00'
 */
export const singaporeNow = (nowMs) => new Date(nowMs + 8 * HOUR_MS).toISOString().slice(0, 16)

/**
 * A stop's local start ("2026-10-10T19:00", Singapore time) as milliseconds since the epoch, or NaN when it is not in
 * that form. Built with Date.UTC, so it does not depend on the server's time zone.
 *
 * How to call:
 *   localStartMs('2026-10-10T19:00') // 1760094000000
 */
export function localStartMs(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local ?? '')
  if (!m) return NaN
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 8, Number(m[5]))
}

/**
 * Which forecast a stop calls for: 'area', 'regional', or 'beyond' (further ahead than the regional forecast can
 * reach, so nothing is fetched). A stop in the past, or with no start, counts as now.
 *
 * How to call:
 *   forecastKindFor('2026-10-10T19:30', Date.parse('2026-10-10T19:00:00+08:00')) // 'area'
 *   forecastKindFor(undefined, Date.now())                                       // 'area'
 */
export function forecastKindFor(start, nowMs) {
  const startMs = start === undefined ? nowMs : localStartMs(start)
  const ahead = Number.isFinite(startMs) ? startMs - nowMs : 0
  if (ahead <= AREA_WITHIN_MS) return 'area'
  return ahead <= REGIONAL_REACH_MS ? 'regional' : 'beyond'
}

// The one sentence every area of a forecast shares, or null when they differ.
const commonPhrase = (areas) => {
  const phrases = new Set(areas.map((a) => a.forecast))
  return phrases.size === 1 ? [...phrases][0] : null
}

// Leaves out the fields a block does not have, so the answer carries no `undefined` or `null` clutter.
const compact = (block) => Object.fromEntries(Object.entries(block).filter(([, v]) => v !== undefined && v !== null))

/**
 * Builds the resolver. Options:
 *   data      The plan data (venues and weather cases) that rankings are scored on.
 *   weather   The weather service from createWeather().
 *   now       Returns the time in milliseconds. Defaults to Date.now. Tests pass a fake clock.
 *   warn      Where a failure is logged, at most once a minute per forecast. Defaults to console.warn.
 *
 * How to call:
 *   const resolver = createWeatherResolver({ data, weather })
 *   const { forecast, ...rest } = await resolver.forecastFor({ start: '2026-10-12T19:00' }) // no plan data built
 *   const { planData, weatherCase, weather: block } = await resolver.resolve({ start: '2026-10-12T19:00' })
 */
export function createWeatherResolver({ data, weather, now = Date.now, warn = (...args) => console.warn(...args) }) {
  const regionOf = createRegionLookup({ warn })
  const lastLogged = new Map()

  // Logs a failure, at most once a minute for each kind of forecast.
  //
  // How to call:
  //   logFailure('regional', err)
  function logFailure(kind, err) {
    const at = now()
    const last = lastLogged.get(kind)
    if (last !== undefined && at - last < LOG_EVERY_MS) return
    lastLogged.set(kind, at)
    warn(`Weather unavailable (${kind} forecast), planning as if clear: ${err.message}`)
  }

  const none = (reason) => ({
    kind: 'none',
    source: reason === 'unavailable' ? 'unavailable' : 'none',
    basis: 'none',
    reason,
  })

  /**
   * Works out which forecast one stop is judged against, and fetches it. Never throws because data.gov.sg is down.
   * Resolves to { kind, source, basis, reason?, forecast?, issuedAt?, validUntil?, phrase? }:
   *   kind      'area' | 'regional' | 'simulated' | 'none'
   *   forecast  an area-style forecast ({ areas }) that withLiveWeather can place venues with (area and regional)
   *
   * How to call:
   *   const f = await resolver.forecastFor({ start: '2026-10-12T19:00' })
   *   f.basis // 'regional'
   */
  async function forecastFor({ start, weatherCase } = {}) {
    if (weatherCase !== undefined) return { kind: 'simulated', source: 'simulated', basis: 'simulated', weatherCase }
    const nowMs = now()
    const kind = forecastKindFor(start, nowMs)
    if (kind === 'beyond') return none('outside_window')
    try {
      if (kind === 'area') {
        const forecast = await weather.twoHourForecast()
        return {
          kind: 'area',
          source: 'live',
          basis: 'area',
          forecast,
          issuedAt: forecast.issuedAt ?? undefined,
          validUntil: forecast.validPeriod.end ?? undefined,
          phrase: commonPhrase(forecast.areas) ?? undefined,
        }
      }
      const regional = await weather.regionalForecast()
      const period = periodCovering(regional, localStartMs(start))
      if (!period) return none('outside_window')
      const forecast = regionalAreaForecast(period, regionOf)
      return {
        kind: 'regional',
        source: 'live',
        basis: 'regional',
        forecast,
        issuedAt: regional.issuedAt ?? undefined,
        validUntil: period.end,
        phrase: commonPhrase(forecast.areas) ?? undefined,
      }
    } catch (err) {
      // Only an API failure falls back. A bug must still reach the error handler.
      if (!(err instanceof ExternalApiError)) throw err
      logFailure(kind, err)
      return none('unavailable')
    }
  }

  /**
   * The `weather` block of an answer: which weather was used. Fields that do not apply are left out.
   *   source      'live' | 'simulated' | 'unavailable' | 'none'
   *   basis       'area' | 'regional' | 'simulated' | 'none'
   *   issuedAt    when the forecast was issued
   *   validUntil  when it ends (the covering period's end for a regional forecast)
   *   phrase      the service's own sentence, when the whole forecast used has just one
   *   reason      for basis 'none': 'outside_window' | 'unavailable'
   *
   * How to call:
   *   resolver.blockOf(await resolver.forecastFor({ start })) // { source: 'live', basis: 'area', issuedAt, validUntil }
   */
  const blockOf = (f) =>
    compact({ source: f.source, basis: f.basis, issuedAt: f.issuedAt, validUntil: f.validUntil, phrase: f.phrase, reason: f.reason })

  /**
   * Resolves a ranking's weather and the plan data to score it on.
   * Resolves to { source, validUntil, weatherCase, planData, forecast, weather }: `weather` is the answer's block.
   * `forecast` is what withLiveWeather(data, forecast) places any venue added later in the request with; it is
   * undefined for a simulated forecast and for "no effect", where venues keep their own labels.
   *
   * How to call:
   *   const { planData, weatherCase, forecast, weather: block } = await resolver.resolve({ start: input.dateTime, weatherCase: input.weatherCase })
   */
  async function resolve(args = {}) {
    const f = await forecastFor(args)
    const common = { source: f.source, validUntil: f.validUntil, weather: blockOf(f) }
    if (f.kind === 'simulated') return { ...common, weatherCase: f.weatherCase, planData: data }
    if (f.kind === 'none') return { ...common, weatherCase: NO_WEATHER_CASE, planData: withNoWeather(data) }
    return { ...common, weatherCase: LIVE_WEATHER_CASE, planData: withLiveWeather(data, f.forecast), forecast: f.forecast }
  }

  /**
   * The weather at one stop: { basis, state, phrase, rainLikely, rainWarning } plus `reason` when basis is 'none',
   * and `issuedAt` and `validUntil` when there is a forecast. The warning is the planner's rule: rain likely, the stop
   * not indoor, and its exposure 2 or more (no exposure counts as 0, so no warning).
   *
   * How to call:
   *   const f = await resolver.forecastFor({ start, weatherCase })
   *   resolver.stopWeather(f, { point: { lat: 1.3, lng: 103.8 }, setting: 'outdoor', exposure: 5 })
   */
  function stopWeather(f, { point, setting, exposure = 0 }) {
    let state = 'unknown'
    let phrase = null
    let rainLikely = false
    let warning = false
    if (f.kind !== 'none') {
      let byArea
      let area
      if (f.kind === 'simulated') {
        byArea = data.weatherCases[f.weatherCase]
        area = approxRegion(point)
      } else {
        byArea = Object.fromEntries(f.forecast.areas.map((a) => [a.area, { rainRisk: a.rainRisk, forecast: a.forecast }]))
        area = nearestArea(point, f.forecast.areas.map((a) => ({ name: a.area, lat: a.lat, lng: a.lng })))
      }
      const place = { forecastArea: area, setting, exposure }
      ;({ state, phrase, rainLikely } = weatherOf(place, byArea))
      warning = byArea[area] ? rainWarning(place, byArea) : false
    }
    return {
      basis: f.basis,
      ...compact({ reason: f.reason, issuedAt: f.issuedAt, validUntil: f.validUntil }),
      state,
      phrase,
      rainLikely,
      rainWarning: warning,
    }
  }

  return { forecastFor, resolve, blockOf, stopWeather }
}

/**
 * The block for a request about several stops, from each stop's own forecast result (forecastFor's answer).
 *   basis       the stops' shared basis, or 'mixed' when they differ
 *   source      'simulated' | 'live' when any stop has a forecast, else 'unavailable' when any stop failed, else 'none'
 *   issuedAt    the earliest issue time among the forecasts used
 *   validUntil  the earliest end among them
 *   phrase      the sentence, when every stop with a forecast has the same one
 *   reason      for basis 'none': 'unavailable' if any stop failed, else 'outside_window'
 *
 * How to call:
 *   summariseBlocks(forecasts, stopAnswers)
 */
export function summariseBlocks(forecasts, stopAnswers) {
  const bases = new Set(forecasts.map((f) => f.basis))
  const basis = bases.size === 1 ? [...bases][0] : 'mixed'
  const has = (kind) => forecasts.some((f) => f.kind === kind)
  const failed = forecasts.some((f) => f.reason === 'unavailable')
  const source = has('simulated') ? 'simulated' : has('area') || has('regional') ? 'live' : failed ? 'unavailable' : 'none'
  const earliest = (field) => forecasts.map((f) => f[field]).filter(Boolean).sort()[0]
  const phrases = new Set(stopAnswers.filter((s) => s.basis === 'area' || s.basis === 'regional').map((s) => s.phrase))
  return compact({
    source,
    basis,
    issuedAt: earliest('issuedAt'),
    validUntil: earliest('validUntil'),
    phrase: phrases.size === 1 ? [...phrases][0] : undefined,
    reason: basis === 'none' ? (failed ? 'unavailable' : 'outside_window') : undefined,
  })
}
