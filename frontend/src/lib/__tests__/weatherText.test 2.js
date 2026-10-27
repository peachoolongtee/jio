// The words and looks of weather: the five states, the mark on a stop, the source line, the licence notice, what the backend's
// answers become, and which stops get a rain warning. Pure functions, so these are plain calls.
import { describe, expect, it } from 'vitest'
import {
  OUTSIDE_WINDOW_TEXT,
  SIMULATED_TEXT,
  STATES,
  UNAVAILABLE_TEXT,
  combineWeather,
  exposureOf,
  homeRainText,
  isDismissed,
  joinNames,
  licenceNotice,
  optionMark,
  rainBannerText,
  rainWarnings,
  singaporeTime,
  sourceLine,
  stateOf,
  stopMark,
  venueSetting,
  weatherFrom,
} from '../weatherText.js'

const EXPOSED = { indoor: false, exposed: true }
const INDOOR = { indoor: true, exposed: false }
const SHELTERED = { indoor: false, exposed: false }

describe('the five states', () => {
  it('are Dry, Cloudy, Showers, Thundery showers and Not known, each with an icon', () => {
    expect(Object.keys(STATES)).toEqual(['dry', 'cloudy', 'showers', 'thundery', 'unknown'])
    expect(Object.values(STATES).map((s) => s.label)).toEqual(['Dry', 'Cloudy', 'Showers', 'Thundery showers', 'Not known'])
    for (const s of Object.values(STATES)) expect(s.icon).toBeTruthy()
  })

  it('read a state the backend sent, and anything else as Not known: never a crash, never blank', () => {
    expect(stateOf('thundery')).toBe('thundery')
    for (const odd of ['hail', '', undefined, null, 7, {}, 'constructor', '__proto__', 'toString']) expect(stateOf(odd)).toBe('unknown')
  })
})

describe('the mark on a stop', () => {
  it.each([
    ['dry', 'Dry'],
    ['cloudy', 'Cloudy'],
    ['showers', 'Showers'],
    ['thundery', 'Thundery showers'],
    ['unknown', 'Not known'],
  ])('says %s as "%s" in words with an icon, in the neutral tone, when rain does not matter', (state, label) => {
    const mark = stopMark({ state, rainLikely: false }, SHELTERED)
    expect(mark.label).toBe(label)
    expect(mark.icon).toBeTruthy()
    expect(mark.tone).toBe('neutral')
  })

  it('reads "Indoor" for an indoor stop when rain is likely there, and it is neutral', () => {
    const mark = stopMark({ state: 'showers', rainLikely: true }, INDOOR)
    expect(mark.label).toBe('Indoor')
    expect(mark.tone).toBe('neutral')
    expect(mark.hint).toContain('under cover')
  })

  it('reads the weather as usual for an indoor stop when rain is not likely', () => {
    expect(stopMark({ state: 'dry', rainLikely: false }, INDOOR).label).toBe('Dry')
    expect(stopMark({ state: 'cloudy', rainLikely: false }, INDOOR).label).toBe('Cloudy')
  })

  it('uses the warning tone only for an exposed stop with rain likely, and says why in words', () => {
    const showers = stopMark({ state: 'showers', rainLikely: true }, EXPOSED)
    expect(showers).toMatchObject({ label: 'Outdoor, showers', tone: 'warning', icon: 'rain' })
    expect(stopMark({ state: 'thundery', rainLikely: true }, EXPOSED)).toMatchObject({ label: 'Outdoor, thundery showers', tone: 'warning', icon: 'thunder' })
  })

  it('is neutral for an exposed stop when rain is not likely, and for a sheltered outdoor stop when it is', () => {
    expect(stopMark({ state: 'dry', rainLikely: false }, EXPOSED).tone).toBe('neutral')
    expect(stopMark({ state: 'cloudy', rainLikely: false }, EXPOSED).tone).toBe('neutral')
    const sheltered = stopMark({ state: 'showers', rainLikely: true }, SHELTERED)
    expect(sheltered).toMatchObject({ label: 'Showers', tone: 'neutral' })
  })

  it('is never the warning tone for a state the backend did not send, or for no weather at all', () => {
    for (const weather of [undefined, null, {}, { state: 'hail' }, { state: 'unknown', rainLikely: false }]) {
      const mark = stopMark(weather, EXPOSED)
      expect(mark.label).toBe('Not known')
      expect(mark.tone).toBe('neutral')
    }
  })

  it('puts NEA\'s own phrase in the words for a screen reader, not in the label', () => {
    const mark = stopMark({ state: 'showers', rainLikely: true, phrase: 'Light Showers' }, EXPOSED)
    expect(mark.label).toBe('Outdoor, showers')
    expect(mark.hint).toContain('NEA says Light Showers')
    expect(stopMark({ state: 'dry', rainLikely: false, phrase: 'Fair (Day)' }, SHELTERED).hint).toBe('NEA says Fair (Day)')
    expect(stopMark({ state: 'dry', rainLikely: false }, SHELTERED).hint).toBe('')
  })
})

describe('the mark on a card on the voting page and in Roam', () => {
  it('is left out when the option has no rain warning', () => {
    expect(optionMark({ warnings: [], weather: { state: 'showers', rainLikely: true } })).toBeNull()
    expect(optionMark({ warnings: undefined })).toBeNull()
  })

  it('follows the weather state when the option has one', () => {
    expect(optionMark({ warnings: ['rain'], weather: { state: 'thundery', rainLikely: true } })).toMatchObject({ label: 'Outdoor, thundery showers', tone: 'warning' })
    expect(optionMark({ warnings: ['rain'], weather: { state: 'showers', rainLikely: true } }).label).toBe('Outdoor, showers')
  })

  it('keeps the old words for an option from before weather states, and still warns', () => {
    expect(optionMark({ warnings: ['rain'] })).toMatchObject({ label: 'Outdoor, rain expected', tone: 'warning', icon: 'rain' })
  })

  it('warns whatever state it was given, since a warning means rain is likely', () => {
    expect(optionMark({ warnings: ['rain'], weather: { state: 'unknown', rainLikely: false } })).toMatchObject({ tone: 'warning', label: 'Outdoor, not known' })
  })
})

describe('the source line', () => {
  const live = { source: 'live', basis: 'area', issuedAt: '2026-10-11T14:10:00+08:00' }

  it('says the forecast and its time for a live forecast, in 24-hour Singapore time', () => {
    expect(sourceLine(live)).toEqual({ kind: 'live', text: 'NEA forecast, 14:10' })
    expect(sourceLine({ source: 'live', basis: 'regional', issuedAt: '2026-10-11T00:05:00+08:00' }).text).toBe('NEA forecast, 00:05')
  })

  it('reads the time in Singapore whatever offset it came with', () => {
    expect(sourceLine({ source: 'live', basis: 'area', issuedAt: '2026-10-11T06:10:00Z' }).text).toBe('NEA forecast, 14:10')
  })

  it('adds NEA\'s phrase when the whole forecast has one', () => {
    expect(sourceLine({ ...live, phrase: 'Light Showers' }).text).toBe('NEA forecast, 14:10 · Light Showers')
  })

  it('says the forecast with no time when the planner sent none', () => {
    expect(sourceLine({ source: 'live', basis: 'regional' }).text).toBe('NEA forecast')
  })

  it('says a regional forecast the same way', () => {
    expect(sourceLine({ source: 'live', basis: 'regional', issuedAt: '2026-10-11T14:42:00+08:00' })).toEqual({ kind: 'live', text: 'NEA forecast, 14:42' })
  })

  it('says a stop outside the forecast window is checked from the day before', () => {
    expect(sourceLine({ source: 'none', basis: 'none', reason: 'outside_window' })).toEqual({ kind: 'outside', text: 'Weather is checked from the day before' })
    expect(OUTSIDE_WINDOW_TEXT).toBe('Weather is checked from the day before')
  })

  it('reads a plan saved before weather was kept (no block) the same way', () => {
    expect(sourceLine(null).kind).toBe('outside')
    expect(sourceLine(undefined).text).toBe(OUTSIDE_WINDOW_TEXT)
  })

  it('says plainly when the forecast could not be fetched', () => {
    expect(sourceLine({ source: 'unavailable', basis: 'none', reason: 'unavailable' })).toEqual({ kind: 'unavailable', text: 'Weather is not available right now' })
    expect(sourceLine({ source: 'none', basis: 'none', reason: 'unavailable' }).text).toBe(UNAVAILABLE_TEXT)
  })

  it('says "Simulated forecast" for a simulated one, as its own kind', () => {
    expect(sourceLine({ source: 'simulated', basis: 'simulated' })).toEqual({ kind: 'simulated', text: 'Simulated forecast' })
    expect(SIMULATED_TEXT).toBe('Simulated forecast')
    // Whatever else the block says, simulated wins.
    expect(sourceLine({ source: 'simulated', issuedAt: '2026-10-11T14:10:00+08:00', phrase: 'Fair' }).text).toBe('Simulated forecast')
  })

  it('says a check on the day that did not work, next to the forecast it kept', () => {
    expect(sourceLine(live, { refreshFailed: true }).text).toBe('NEA forecast, 14:10 · could not check again')
  })

  it('does not crash on a time it cannot read', () => {
    expect(sourceLine({ source: 'live', issuedAt: 'not a time' }).text).toBe('NEA forecast')
  })
})

describe('the licence notice', () => {
  it('names the two-hour forecast and the day it was issued', () => {
    const n = licenceNotice({ source: 'live', basis: 'area', issuedAt: '2026-10-11T14:10:00+08:00' })
    expect(n.before).toBe('Contains information from 2-hour Weather Forecast accessed on 11 Oct 2026 from data.gov.sg which is made available under the terms of the')
    expect(n.licence).toBe('Singapore Open Data Licence version 1.0')
    expect(n.url).toBe('https://data.gov.sg/open-data-licence')
  })

  it('names the 24-hour forecast for a regional one, and both for stops that differ', () => {
    expect(licenceNotice({ source: 'live', basis: 'regional', issuedAt: '2026-10-11T14:42:00+08:00' }).before).toContain('24-hour Weather Forecast accessed')
    expect(licenceNotice({ source: 'live', basis: 'mixed', issuedAt: '2026-10-11T14:42:00+08:00' }).before).toContain('24-hour Weather Forecast and 2-hour Weather Forecast')
  })

  it('has no day when none was issued, and is not shown for anything but a live forecast', () => {
    expect(licenceNotice({ source: 'live', basis: 'area' }).before).not.toContain('accessed on')
    for (const source of ['simulated', 'unavailable', 'none', undefined]) expect(licenceNotice({ source })).toBeNull()
    expect(licenceNotice(null)).toBeNull()
  })
})

describe('singaporeTime', () => {
  it('is 24-hour and Singapore\'s, and empty for a time it cannot read', () => {
    expect(singaporeTime('2026-10-11T14:42:00+08:00')).toBe('14:42')
    expect(singaporeTime('2026-10-11T16:30:00Z')).toBe('00:30')
    expect(singaporeTime(new Date('2026-10-11T06:00:00Z'))).toBe('14:00')
    expect(singaporeTime('nope')).toBe('')
    expect(singaporeTime(undefined)).toBe('')
  })
})

describe('what the backend\'s answers become', () => {
  it('keeps a ranking result\'s state with the answer\'s block', () => {
    const block = { source: 'live', basis: 'regional', issuedAt: '2026-10-11T14:42:00+08:00', validUntil: '2026-10-11T18:00:00+08:00' }
    expect(weatherFrom({ state: 'thundery', phrase: 'Thundery Showers', rainLikely: true }, block)).toEqual({
      state: 'thundery', rainLikely: true, phrase: 'Thundery Showers', source: 'live', basis: 'regional', issuedAt: block.issuedAt, validUntil: block.validUntil,
    })
  })

  it('leaves out what the planner left out', () => {
    expect(weatherFrom({ state: 'showers', phrase: null, rainLikely: true }, { source: 'simulated', basis: 'simulated' })).toEqual({
      state: 'showers', rainLikely: true, source: 'simulated', basis: 'simulated',
    })
  })

  it('reads a stop\'s own basis, whatever the summary says (stops that differ)', () => {
    const block = { source: 'live', basis: 'mixed', issuedAt: '2026-10-11T14:42:00+08:00' }
    const outside = weatherFrom({ basis: 'none', reason: 'outside_window', state: 'unknown', phrase: null, rainLikely: false }, block)
    expect(outside).toEqual({ state: 'unknown', rainLikely: false, source: 'none', basis: 'none', reason: 'outside_window' })
    const failed = weatherFrom({ basis: 'none', reason: 'unavailable', state: 'unknown', rainLikely: false }, block)
    expect(failed.source).toBe('unavailable')
    const area = weatherFrom({ basis: 'area', issuedAt: '2026-10-11T14:10:00+08:00', state: 'dry', rainLikely: false }, block)
    expect(area).toMatchObject({ source: 'live', basis: 'area', issuedAt: '2026-10-11T14:10:00+08:00' })
  })

  it('reads an unknown state as unknown and nothing at all as null', () => {
    expect(weatherFrom({ state: 'snow', rainLikely: false }).state).toBe('unknown')
    for (const nothing of [undefined, null, 'x', 5]) expect(weatherFrom(nothing, { source: 'live' })).toBeNull()
  })

  it('keeps no more than it can show', () => {
    const w = weatherFrom({ state: 'dry', phrase: 'x'.repeat(500), rainLikely: false })
    expect(w.phrase).toHaveLength(80)
  })
})

describe('several stops as one block', () => {
  const live = (over = {}) => ({ state: 'dry', rainLikely: false, source: 'live', basis: 'area', issuedAt: '2026-10-11T14:10:00+08:00', validUntil: '2026-10-11T16:10:00+08:00', ...over })

  it('is null with nothing to combine (a save from before)', () => {
    expect(combineWeather([])).toBeNull()
    expect(combineWeather([null, undefined])).toBeNull()
    expect(combineWeather(undefined)).toBeNull()
  })

  it('keeps a shared basis, the earliest times, and a phrase only when every stop has the same', () => {
    expect(combineWeather([live({ phrase: 'Fair' }), live({ phrase: 'Fair', issuedAt: '2026-10-11T13:10:00+08:00' })])).toEqual({
      source: 'live', basis: 'area', issuedAt: '2026-10-11T13:10:00+08:00', validUntil: '2026-10-11T16:10:00+08:00', phrase: 'Fair',
    })
    expect(combineWeather([live({ phrase: 'Fair' }), live({ phrase: 'Showers' })]).phrase).toBeUndefined()
  })

  it('says mixed when the stops differ, and live when any stop has a forecast', () => {
    const block = combineWeather([live(), live({ basis: 'regional' }), { state: 'unknown', rainLikely: false, source: 'none', basis: 'none', reason: 'outside_window' }])
    expect(block).toMatchObject({ source: 'live', basis: 'mixed' })
  })

  it('lets simulated win over everything, then live, unavailable and none', () => {
    expect(combineWeather([live(), { source: 'simulated', basis: 'simulated' }]).source).toBe('simulated')
    expect(combineWeather([{ source: 'none', basis: 'none' }, { source: 'unavailable', basis: 'none', reason: 'unavailable' }])).toMatchObject({ source: 'unavailable', reason: 'unavailable' })
    expect(combineWeather([{ source: 'none', basis: 'none', reason: 'outside_window' }])).toMatchObject({ source: 'none', reason: 'outside_window' })
  })
})

describe('which stops are exposed', () => {
  it('uses the number the backend sent, and the backend\'s own formula when there is none', () => {
    expect(exposureOf({ exposure: 5 })).toBe(5)
    expect(exposureOf({ exposure: 9 })).toBe(5)
    expect(exposureOf({ indoor: false, kind: 'park' })).toBe(5)
    expect(exposureOf({ indoor: false, kind: 'cafe' })).toBe(4)
    expect(exposureOf({ indoor: true, mrtWalk: 1 })).toBe(0)
    expect(exposureOf({ indoor: true, mrtWalk: 6 })).toBe(1)
    expect(exposureOf({ indoor: true, mrtWalk: 12 })).toBe(2)
    expect(exposureOf({ setting: 'indoor' })).toBe(2)
  })

  it('is exposed when open-air or a long walk from shelter: exposure 2 or more, and not indoor', () => {
    expect(venueSetting({ setting: 'outdoor', exposure: 5 })).toEqual({ indoor: false, exposed: true, exposure: 5 })
    expect(venueSetting({ setting: 'outdoor', exposure: 1 }).exposed).toBe(false)
    expect(venueSetting({ setting: 'indoor', exposure: 2 })).toMatchObject({ indoor: true, exposed: false })
    expect(venueSetting({ indoor: false, kind: 'park' }).exposed).toBe(true)
    expect(venueSetting(undefined)).toMatchObject({ exposed: true })
  })
})

describe('the rain warnings of a day', () => {
  const park = { slotId: 'activity', start: 15 * 60, venue: { id: 'park', name: 'East Coast Park', setting: 'outdoor', exposure: 5 } }
  const library = { slotId: 'eat', start: 12 * 60, venue: { id: 'lib', name: 'Library', setting: 'indoor', exposure: 0 } }
  const check = (stops) => ({ stops })
  const rainy = { state: 'showers', rainLikely: true, source: 'live' }

  it('is one for an exposed stop still to come with rain likely, and not for an indoor one', () => {
    const found = rainWarnings([library, park], check({ eat: rainy, activity: rainy }), 10 * 60)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ slotId: 'activity', venueId: 'park', name: 'East Coast Park', start: 900 })
  })

  it('is none when rain is not likely, or when there was no answer', () => {
    expect(rainWarnings([park], check({ activity: { state: 'dry', rainLikely: false, source: 'live' } }), 600)).toEqual([])
    expect(rainWarnings([park], undefined, 600)).toEqual([])
    expect(rainWarnings([park], check({}), 600)).toEqual([])
  })

  it('is none for a stop that has begun or passed, but a simulated forecast counts every stop (the demo works at any hour)', () => {
    expect(rainWarnings([park], check({ activity: rainy }), 16 * 60)).toEqual([])
    expect(rainWarnings([park], check({ activity: rainy }), 15 * 60)).toHaveLength(1)
    expect(rainWarnings([park], check({ activity: { ...rainy, source: 'simulated' } }), 22 * 60)).toHaveLength(1)
  })

  it('has banner words that say where and when', () => {
    expect(rainBannerText({ name: 'East Coast Park', start: 900 })).toBe('Rain is likely at East Coast Park around 15:00.')
  })

  it('stays dismissed for a stop until the forecast changes state', () => {
    const warning = { slotId: 'activity', weather: { state: 'showers' } }
    expect(isDismissed({ activity: 'showers' }, warning)).toBe(true)
    expect(isDismissed({ activity: 'showers' }, { ...warning, weather: { state: 'thundery' } })).toBe(false)
    expect(isDismissed({ eat: 'showers' }, warning)).toBe(false)
    expect(isDismissed(undefined, warning)).toBe(false)
  })
})

describe('Home\'s words for rain on the map', () => {
  it('joins the places and says the next two hours', () => {
    expect(homeRainText(['Bishan'])).toBe('Rain likely around Bishan in the next two hours')
    expect(homeRainText(['Bishan', 'Tampines'])).toBe('Rain likely around Bishan and Tampines in the next two hours')
    expect(homeRainText(['Bishan', 'Tampines', 'Jurong East'])).toBe('Rain likely around Bishan, Tampines and Jurong East in the next two hours')
    expect(joinNames([])).toBe('')
  })
})
