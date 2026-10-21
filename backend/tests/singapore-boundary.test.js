// Which coordinates and dates the planner accepts: Singapore's land and waters (backend/src/planner/singapore.js) and real
// calendar dates (backend/src/routes/plan-schemas.js). Nothing here touches a network.
import { describe, expect, it } from 'vitest'
import { loadPlanData } from '../src/db/venues.js'
import { isSingaporePoint } from '../src/planner/singapore.js'
import { makePlanSchemas } from '../src/routes/plan-schemas.js'

const schemas = makePlanSchemas(loadPlanData())

describe('isSingaporePoint', () => {
  // Outer islands and outlying land: the polygons accept them, the central envelope does not reach them.
  it.each([
    ['Pulau Ubin', 1.404, 103.965],
    ['Pulau Tekong', 1.4, 104.04],
    ['Sentosa', 1.2494, 103.8303],
    ['Changi', 1.3644, 103.9915],
    ['Tuas Link', 1.3404, 103.6368],
    ['Woodlands Checkpoint', 1.4465, 103.7686],
    ['Sembawang Park', 1.458, 103.835],
    ['Raffles Lighthouse', 1.1598, 103.7407],
    ["St John's Island", 1.221, 103.849],
    ['Lazarus Island', 1.225, 103.858],
  ])('accepts %s', (_name, lat, lng) => {
    expect(isSingaporePoint({ lat, lng })).toBe(true)
  })

  // Inside the central envelope or near it: ordinary places.
  it.each([
    ['Orchard', 1.3007, 103.8558],
    ['Jurong Island', 1.265, 103.699],
    ['Kranji', 1.43, 103.762],
    ['Seletar', 1.409, 103.869],
    ['Punggol Point', 1.417, 103.907],
    ['Lim Chu Kang', 1.429, 103.704],
  ])('accepts %s', (_name, lat, lng) => {
    expect(isSingaporePoint({ lat, lng })).toBe(true)
  })

  it.each([
    ['Johor Bahru CIQ', 1.463, 103.765],
    ['Batam', 1.13, 104.05],
    ['the Singapore Strait, south of the Western Islands', 1.2, 103.7],
    // Between latitude 1.44 and 1.455, over the Strait of Johor.
    ['Johor, north of the Causeway', 1.452, 103.76],
    ['Johor, west of Woodlands', 1.448, 103.75],
    ['Johor, further west', 1.442, 103.74],
    // West Johor, beyond the western edge of the envelope.
    ['west Johor, longitude 103.62', 1.43, 103.62],
    ['west Johor, longitude 103.60', 1.4, 103.6],
  ])('rejects %s', (_name, lat, lng) => {
    expect(isSingaporePoint({ lat, lng })).toBe(false)
  })

  it('rejects a missing or non-numeric point', () => {
    expect(isSingaporePoint()).toBe(false)
    expect(isSingaporePoint({ lat: NaN, lng: 103.8 })).toBe(false)
    expect(isSingaporePoint({ lat: '1.3', lng: 103.8 })).toBe(false)
  })
})

describe('a point in a request', () => {
  const roam = (current) => ({ current, members: [{ id: 'ian' }], occasion: 'casual_meal', dateTime: '2026-10-20T19:00' })

  it('is refused with the issue on the coordinate when it is in Johor but inside the old box', () => {
    const result = schemas.roam.safeParse(roam({ lat: 1.452, lng: 103.76 }))
    expect(result.success).toBe(false)
    expect(result.error.issues.map((i) => i.path.join('.'))).toContain('current.lat')
  })

  it('is accepted on an outer island', () => {
    expect(schemas.roam.safeParse(roam({ lat: 1.404, lng: 103.965 })).success).toBe(true)
  })
})

describe('the date in a request', () => {
  const withDate = (dateTime) => schemas.roam.safeParse({ current: { lat: 1.3007, lng: 103.8558 }, members: [{ id: 'ian' }], occasion: 'casual_meal', dateTime })
  const dateIssue = (dateTime) => withDate(dateTime).error?.issues.map((i) => i.path.join('.'))

  it('accepts 29 February in a leap year and refuses it in any other', () => {
    expect(withDate('2028-02-29T19:00').success).toBe(true)
    expect(dateIssue('2026-02-29T19:00')).toContain('dateTime')
    expect(dateIssue('2100-02-29T19:00')).toContain('dateTime') // Divisible by 100 but not 400: not a leap year.
    expect(withDate('2000-02-29T19:00').success).toBe(true)
  })

  it('refuses month 00 and day 00', () => {
    expect(dateIssue('2026-00-10T19:00')).toContain('dateTime')
    expect(dateIssue('2026-10-00T19:00')).toContain('dateTime')
  })

  it('refuses the 31st of a 30-day month and month 13', () => {
    expect(dateIssue('2026-04-31T19:00')).toContain('dateTime')
    expect(dateIssue('2026-13-01T19:00')).toContain('dateTime')
    expect(withDate('2026-12-31T19:00').success).toBe(true)
  })
})
