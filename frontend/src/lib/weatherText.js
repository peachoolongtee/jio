// What the screens say about the weather, in one place: the five states and their words, the mark on a stop, and the one
// muted line that says where the forecast came from. Pure functions, so every screen and every test says the same thing.
// The words are the ones in CONTEXT.md ("Needs and weather"): area forecast, regional forecast, forecast window, exposed
// stop, rain warning. The backend's side is backend/docs/planner-api.md, "Weather".
import { fromMinutes } from './planner/format.js'

// A weather object, as the data layer stores it with a plan (every field is optional; an old save has none):
//   { state, phrase, rainLikely, source, basis, issuedAt, validUntil, reason }
//   state       'dry' | 'cloudy' | 'showers' | 'thundery' | 'unknown'
//   phrase      NEA's own words for the place ("Light Showers"), or absent
//   rainLikely  the planner's threshold (true over an indoor stop too)
//   source      'live' | 'simulated' | 'unavailable' | 'none'
//   basis       'area' | 'regional' | 'simulated' | 'none' ('mixed' only for several stops together)
//   issuedAt, validUntil  ISO times with the +08:00 offset
//   reason      'outside_window' | 'unavailable', for basis 'none'

// The five states. The labels are the words on screen; the icons are drawn by AppIcon.
export const STATES = {
  dry: { label: 'Dry', icon: 'sun' },
  cloudy: { label: 'Cloudy', icon: 'cloud' },
  showers: { label: 'Showers', icon: 'rain' },
  thundery: { label: 'Thundery showers', icon: 'thunder' },
  unknown: { label: 'Not known', icon: 'info' },
}

// The words of the source line that are not "NEA forecast, 14:10".
export const OUTSIDE_WINDOW_TEXT = 'Weather is checked from the day before'
export const UNAVAILABLE_TEXT = 'Weather is not available right now'
export const SIMULATED_TEXT = 'Simulated forecast'
export const SIMULATED_NOTE = 'The weather on this screen is made up for the demo, not the real forecast.'

// A backend state as one of the five names. Anything else, including nothing, is 'unknown': never a crash, never blank.
// How to call: stateOf('thundery') -> 'thundery'; stateOf('hail') -> 'unknown'; stateOf(undefined) -> 'unknown'
export function stateOf(value) {
  return typeof value === 'string' && Object.hasOwn(STATES, value) ? value : 'unknown'
}

// A string kept to a length it can be shown at, or undefined when it is not a string or is empty.
// How to call: text('Light Showers') -> 'Light Showers'; text(5) -> undefined
const text = (value, max = 80) => (typeof value === 'string' && value ? value.slice(0, max) : undefined)
// An object without its undefined fields, so nothing stored carries empty keys.
// How to call: compact({ a: 1, b: undefined }) -> { a: 1 }
const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined))

// The source a basis implies, for a stop answer that has a basis but no source of its own.
// How to call: sourceOfBasis('regional', undefined) -> 'live'; sourceOfBasis('none', 'unavailable') -> 'unavailable'
function sourceOfBasis(basis, reason) {
  if (basis === 'area' || basis === 'regional') return 'live'
  if (basis === 'simulated') return 'simulated'
  return reason === 'unavailable' ? 'unavailable' : 'none'
}

// One planner answer about one place as the weather object the data layer keeps. `result` is a ranking result's `weather`
// ({ state, phrase, rainLikely }) or one stop of POST /api/weather/stops (the same fields, plus basis, issuedAt, validUntil
// and reason). `block` is the answer's top-level `weather` block, for the fields a ranking result does not carry. Returns
// null when there is nothing usable, so a screen shows "Not known".
// How to call: weatherFrom({ state: 'showers', phrase: null, rainLikely: true }, { source: 'live', basis: 'area', issuedAt: '...' })
export function weatherFrom(result, block = null) {
  if (!result || typeof result !== 'object') return null
  // A stop answer has its own basis and times, which say its source, and takes nothing from the summary. A ranking result
  // takes the answer's block.
  const own = typeof result.basis === 'string'
  const from = own ? result : { ...(block && typeof block === 'object' ? block : {}), ...result }
  const basis = text(from.basis, 20)
  const reason = text(from.reason, 30)
  return compact({
    state: stateOf(result.state),
    rainLikely: result.rainLikely === true,
    phrase: text(result.phrase),
    source: own ? sourceOfBasis(basis, reason) : (text(from.source, 20) ?? (basis ? sourceOfBasis(basis, reason) : undefined)),
    basis,
    issuedAt: text(from.issuedAt, 40),
    validUntil: text(from.validUntil, 40),
    reason,
  })
}

// The earlier of two ISO times with the same offset (compared as text), ignoring a missing one.
// How to call: earlier('2026-10-11T14:10:00+08:00', undefined) -> '2026-10-11T14:10:00+08:00'
const earlier = (a, b) => (!a ? b : !b ? a : a < b ? a : b)

// Several weather objects (the stops of a plan, or the slots of a ranking) as the one block the source line reads. Simulated
// wins, then live, then unavailable, then none. The basis is shared or 'mixed'; the times are the earliest; the phrase is
// kept only when every stop with a forecast has the same one. Null when there is nothing to combine.
// How to call: combineWeather([stop1.weather, stop2.weather]) -> { source: 'live', basis: 'area', issuedAt: '...' }
export function combineWeather(list) {
  const items = (list || []).filter(Boolean)
  if (!items.length) return null
  const has = (source) => items.some((w) => w.source === source)
  const source = has('simulated') ? 'simulated' : has('live') ? 'live' : has('unavailable') ? 'unavailable' : 'none'
  const bases = new Set(items.map((w) => w.basis).filter(Boolean))
  const basis = bases.size === 1 ? [...bases][0] : bases.size > 1 ? 'mixed' : undefined
  const forecasts = items.filter((w) => w.source === 'live' || w.source === 'simulated')
  const phrases = new Set(forecasts.map((w) => w.phrase ?? null))
  return compact({
    source,
    basis,
    issuedAt: items.map((w) => w.issuedAt).reduce(earlier, undefined),
    validUntil: items.map((w) => w.validUntil).reduce(earlier, undefined),
    phrase: phrases.size === 1 ? ([...phrases][0] ?? undefined) : undefined,
    reason: source === 'unavailable' ? 'unavailable' : source === 'none' ? 'outside_window' : undefined,
  })
}

// A time as Singapore people read it on the clock: 24-hour, "14:10", whatever zone the browser is in. An ISO time with an
// offset, or a Date. Empty text when it cannot be read.
// How to call: singaporeTime('2026-10-11T14:42:00+08:00') -> '14:42'
export function singaporeTime(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}

// The one muted line under the stops (or the list): where the forecast came from and when.
//   kind  'simulated' (say it loudly), 'live', 'unavailable' or 'outside' (the stop is outside the forecast window)
//   text  the words
// A block that is missing (a save from before weather was kept) reads as outside the window, which is the usual reason.
// `refreshFailed` adds that the last check on the day did not work, so the forecast shown is the one before it.
// How to call: sourceLine({ source: 'live', basis: 'area', issuedAt: '2026-10-11T14:10:00+08:00' }) -> { kind: 'live', text: 'NEA forecast, 14:10' }
export function sourceLine(block, { refreshFailed = false } = {}) {
  const source = block?.source
  if (source === 'simulated') return { kind: 'simulated', text: SIMULATED_TEXT }
  if (source === 'unavailable' || block?.reason === 'unavailable') return { kind: 'unavailable', text: UNAVAILABLE_TEXT }
  if (source === 'live') {
    const time = singaporeTime(block.issuedAt)
    const parts = [time ? `NEA forecast, ${time}` : 'NEA forecast']
    if (block.phrase) parts.push(block.phrase)
    if (refreshFailed) parts.push('could not check again')
    return { kind: 'live', text: parts.join(' · ') }
  }
  return { kind: 'outside', text: OUTSIDE_WINDOW_TEXT }
}

// The Singapore Open Data Licence asks for a notice wherever NEA's forecast is shown (backend/docs/external-apis.md). The line
// carries the short form; this is the full notice, one tap away. It names the forecast the block used (the 2-hour area
// forecast, the 24-hour regional forecast, or both) and the day it was issued. Null for a block with no live forecast.
//   before  the words up to the licence's name; licence  the name, which the screen links to `url`; after  what follows it
// How to call: licenceNotice({ source: 'live', basis: 'area', issuedAt: '2026-10-11T14:10:00+08:00' }).before
//   -> 'Contains information from 2-hour Weather Forecast accessed on 11 Oct 2026 from data.gov.sg which is made available under the terms of the'
export function licenceNotice(block) {
  if (block?.source !== 'live') return null
  const name = block.basis === 'area' ? '2-hour Weather Forecast' : block.basis === 'regional' ? '24-hour Weather Forecast' : '24-hour Weather Forecast and 2-hour Weather Forecast'
  const issued = new Date(block.issuedAt)
  const day = Number.isNaN(issued.getTime()) ? '' : new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' }).format(issued)
  return {
    before: `Contains information from ${name}${day ? ` accessed on ${day}` : ''} from data.gov.sg which is made available under the terms of the`,
    licence: 'Singapore Open Data Licence version 1.0',
    after: '.',
    url: 'https://data.gov.sg/open-data-licence',
  }
}

// Is this a simulated forecast? The label for it is shown on every screen that shows weather.
// How to call: isSimulated({ source: 'simulated' }) -> true
export const isSimulated = (block) => block?.source === 'simulated'

// How exposed a venue is to rain, 0 to 5: the backend's own number when the venue carries it, otherwise worked out the way
// the backend does (venue-adapter.js): open air is 4 (5 for a park or sports ground), indoors is 0 to 2 by the walk from the MRT.
// How to call: exposureOf({ exposure: 5 }) -> 5; exposureOf({ indoor: true, mrtWalk: 1 }) -> 0
export function exposureOf(venue) {
  if (Number.isFinite(venue?.exposure)) return Math.max(0, Math.min(5, venue.exposure))
  const indoor = venue?.setting ? venue.setting === 'indoor' : venue?.indoor === true
  if (!indoor) return venue?.kind === 'park' || venue?.kind === 'sports' ? 5 : 4
  const walk = Number.isFinite(venue?.mrtWalk) ? venue.mrtWalk : 10
  return walk <= 2 ? 0 : walk <= 8 ? 1 : 2
}

// Is a venue indoors, and is it exposed (open-air, or a long walk from shelter: the backend's exposure of 2 or more)?
// How to call: venueSetting({ setting: 'outdoor', exposure: 5 }) -> { indoor: false, exposed: true, exposure: 5 }
export function venueSetting(venue) {
  const indoor = venue?.setting ? venue.setting === 'indoor' : venue?.indoor === true
  const exposure = exposureOf(venue)
  return { indoor, exposed: !indoor && exposure >= 2, exposure }
}

// The words and the look of the mark on one stop.
//   label  what is shown ("Dry", "Showers", "Indoor", "Outdoor, thundery showers", "Not known")
//   tone   'warning' only for an exposed stop with rain likely (the rain warning); everything else is 'neutral'
//   icon   an AppIcon name; the words carry the meaning, the icon and the tone only help
//   state  one of the five names
//   hint   words for a screen reader after the label: NEA's own phrase, or why the stop is flagged
// An indoor stop reads "Indoor" when rain is likely there, since rain does not matter to it. An exposed stop with rain
// likely reads "Outdoor, showers": it says why it is flagged.
// How to call: stopMark({ state: 'showers', rainLikely: true }, { indoor: false, exposed: true }) -> { label: 'Outdoor, showers', tone: 'warning', ... }
export function stopMark(weather, { indoor = false, exposed = false } = {}) {
  const state = stateOf(weather?.state)
  const rainLikely = weather?.rainLikely === true
  const base = STATES[state]
  const phrase = text(weather?.phrase)
  const nea = phrase ? `NEA says ${phrase}` : ''
  if (indoor && rainLikely) return { state, label: 'Indoor', tone: 'neutral', icon: 'home', hint: [`${base.label} likely here, under cover`, nea].filter(Boolean).join('. ') }
  if (exposed && rainLikely) {
    return { state, label: `Outdoor, ${base.label.toLowerCase()}`, tone: 'warning', icon: base.icon, hint: ['Rain is likely at this open-air stop', nea].filter(Boolean).join('. ') }
  }
  return { state, label: base.label, tone: 'neutral', icon: base.icon, hint: nea }
}

// The mark an option has on the voting page and in Roam: only the rain warning, as before. It follows the option's weather
// state when it has one ("Outdoor, showers"); an option without one (a save from before) keeps the old words. Null when the
// option carries no rain warning.
// How to call: optionMark({ warnings: ['rain'], weather: { state: 'thundery', rainLikely: true } }) -> { label: 'Outdoor, thundery showers', tone: 'warning', ... }
export function optionMark(option) {
  if (!option?.warnings?.includes('rain')) return null
  if (!option.weather) return { state: 'unknown', label: 'Outdoor, rain expected', tone: 'warning', icon: 'rain', hint: '' }
  const state = stateOf(option.weather.state)
  // A warning always means rain is likely, whatever state the forecast sentence gave.
  return stopMark({ ...option.weather, state, rainLikely: true }, { indoor: false, exposed: true })
}

// The stops that need a rain warning: exposed, rain likely, and still to come. `stops` are itinerary stops
// ({ slotId, start (minutes), venue }), `checked` the latest check ({ stops: { [slotId]: weather } }), `nowMinutes` the
// clock. A simulated forecast is about no clock, so every stop counts as still to come under it (the demo works at any hour).
// How to call: rainWarnings(itinerary.stops, check, 14 * 60) -> [{ slotId, venueId, name, start, weather }]
export function rainWarnings(stops, checked, nowMinutes) {
  const found = []
  for (const stop of stops || []) {
    const weather = checked?.stops?.[stop.slotId]
    if (!weather?.rainLikely) continue
    if (!venueSetting(stop.venue).exposed) continue
    if (weather.source !== 'simulated' && !(stop.start >= nowMinutes)) continue
    found.push({ slotId: stop.slotId, venueId: stop.venue?.id, name: stop.venue?.name ?? 'this stop', start: stop.start, weather })
  }
  return found
}

// The banner's words for one rain warning, for everyone: where, and when.
// How to call: rainBannerText({ name: 'East Coast Park', start: 900 }) -> 'Rain is likely at East Coast Park around 15:00.'
export function rainBannerText({ name, start }) {
  return `Rain is likely at ${name} around ${fromMinutes(start)}.`
}

// Is the dismissal still good? A dismissed warning stays dismissed for the stop until the forecast changes state.
// `dismissed` is { [slotId]: state } as saved, `warning` one of rainWarnings.
// How to call: isDismissed({ s1: 'showers' }, { slotId: 's1', weather: { state: 'showers' } }) -> true
export function isDismissed(dismissed, warning) {
  return !!dismissed && dismissed[warning.slotId] === stateOf(warning.weather?.state)
}

// "Bishan", "Bishan and Tampines", "Bishan, Tampines and Jurong East".
// How to call: joinNames(['Bishan', 'Tampines']) -> 'Bishan and Tampines'
export function joinNames(names) {
  if (names.length < 2) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

// The text equivalent of the rain on Home's map.
// How to call: homeRainText(['Bishan']) -> 'Rain likely around Bishan in the next two hours'
export function homeRainText(areaNames) {
  return `Rain likely around ${joinNames(areaNames)} in the next two hours`
}
