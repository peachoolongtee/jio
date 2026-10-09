// live-weather.js: lets the engine score venues against the real two-hour forecast without any change to the
// engine itself.
//
// The engine looks a venue's rain risk up as data.weatherCases[weatherCase][venue.forecastArea].rainRisk. The mock
// data has five rough regions there. For live weather this file hands the engine a copy of the plan data in which
//   - every venue's forecastArea is the nearest of data.gov.sg's 47 forecast areas, and
//   - a case called LIVE_WEATHER_CASE holds the forecast's rain risk for each of those areas.
// The shared plan data is never changed.

import { nearestArea } from './cdc-adapter.js';

/** The weather case name that holds the live forecast. It is not in the request schema, so a caller cannot send it. */
export const LIVE_WEATHER_CASE = 'live';

// Venues already placed in forecast areas, per venue list: { signature, venues }. Placing ~1,500 venues takes
// a few milliseconds, and the area coordinates almost never change, so it is done once and reused.
const placed = new WeakMap();

/**
 * Plan data for scoring against a live forecast. Pass the result as `data` and LIVE_WEATHER_CASE as `weatherCase`.
 *
 * How to call:
 *   const forecast = await weather.twoHourForecast()            // services/weather.js
 *   const live = withLiveWeather(data, forecast)
 *   converge({ ...input, weatherCase: LIVE_WEATHER_CASE }, live)
 *
 * @param {object} data      Plan data from loadPlanData().
 * @param {{areas: {area:string,lat:number,lng:number,forecast:string,rainRisk:number}[]}} forecast
 */
export function withLiveWeather(data, forecast) {
  const places = forecast.areas.map(a => ({ name: a.area, lat: a.lat, lng: a.lng }));
  const signature = places.map(p => `${p.name}:${p.lat},${p.lng}`).join('|');

  let hit = placed.get(data.venues);
  if (!hit || hit.signature !== signature) {
    hit = { signature, venues: data.venues.map(v => ({ ...v, forecastArea: nearestArea(v, places) })) };
    placed.set(data.venues, hit);
  }

  const byArea = Object.fromEntries(forecast.areas.map(a => [a.area, { rainRisk: a.rainRisk, forecast: a.forecast }]));
  return { ...data, venues: hit.venues, weatherCases: { ...data.weatherCases, [LIVE_WEATHER_CASE]: byArea } };
}
