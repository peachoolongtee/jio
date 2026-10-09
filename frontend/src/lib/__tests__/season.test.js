import { describe, expect, it } from 'vitest'
import { endsInText, nextSeason, quarterOf, seasonRange, seasonWinners } from '../season.js'

const at = (iso) => new Date(iso)

describe('quarterOf', () => {
  it('runs from the first day of the quarter to the first day of the next', () => {
    const q = quarterOf(at('2026-10-08T15:00:00'))
    expect(new Date(q.startsAt)).toEqual(at('2026-10-01T00:00:00'))
    expect(new Date(q.endsAt)).toEqual(at('2027-01-01T00:00:00'))
  })
})

describe('nextSeason', () => {
  it('starts when the last one ended and lasts three months', () => {
    const next = nextSeason({ number: 4 }, at('2026-10-08T12:00:00').getTime())
    expect(next.number).toBe(5)
    expect(new Date(next.endsAt)).toEqual(at('2027-01-08T12:00:00'))
  })
})

describe('seasonWinners', () => {
  it('is whoever earned the most points this season', () => {
    expect(seasonWinners([{ id: 'a', seasonPoints: 300 }, { id: 'b', seasonPoints: 500 }])).toEqual(['b'])
  })
  it('lets everyone tied for first win', () => {
    expect(seasonWinners([{ id: 'a', seasonPoints: 500 }, { id: 'b', seasonPoints: 500 }, { id: 'c', seasonPoints: 100 }])).toEqual(['a', 'b'])
  })
  it('has no winner when nobody earned points', () => {
    expect(seasonWinners([{ id: 'a', seasonPoints: 0 }])).toEqual([])
  })
})

describe('endsInText', () => {
  const season = quarterOf(at('2026-10-08T15:00:00'))
  it('counts the days to the last day of the season', () => {
    expect(endsInText(season, at('2026-10-08T15:00:00'))).toBe('Ends in 84 days')
  })
  it('says tomorrow, then today', () => {
    expect(endsInText(season, at('2026-12-30T09:00:00'))).toBe('Ends tomorrow')
    expect(endsInText(season, at('2026-12-31T23:00:00'))).toBe('Ends today')
  })
  it('names the first and last day', () => {
    expect(seasonRange(season)).toBe('1 Oct to 31 Dec')
  })
})
