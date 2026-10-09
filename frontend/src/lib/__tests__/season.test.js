import { describe, expect, it } from 'vitest'
import { compareStandings, endsInText, nextSeason, quarterOf, seasonRange, seasonWinners } from '../season.js'

const at = (iso) => new Date(iso)

describe('quarterOf', () => {
  it('runs from the first day of the quarter to the first day of the next', () => {
    const q = quarterOf(at('2026-10-08T15:00:00'))
    expect(new Date(q.startsAt)).toEqual(at('2026-10-01T00:00:00'))
    expect(new Date(q.endsAt)).toEqual(at('2027-01-01T00:00:00'))
  })
})

describe('nextSeason', () => {
  it('starts when the last one ended and runs to the end of that calendar quarter', () => {
    const next = nextSeason({ number: 4 }, at('2026-10-08T12:00:00').getTime())
    expect(next.number).toBe(5)
    expect(new Date(next.startsAt)).toEqual(at('2026-10-08T12:00:00'))
    // Not three months from the click (8 Jan): the quarter boundary.
    expect(new Date(next.endsAt)).toEqual(at('2027-01-01T00:00:00'))
  })
  it('follows on from a season that ended on its boundary', () => {
    const next = nextSeason({ number: 1 }, at('2027-01-01T00:00:00').getTime())
    expect(new Date(next.endsAt)).toEqual(at('2027-04-01T00:00:00'))
  })
  it('shows the real last day of a season ended part-way through', () => {
    const next = nextSeason({ number: 1 }, at('2026-11-15T09:30:00').getTime())
    expect(seasonRange(next)).toBe('15 Nov to 31 Dec')
    expect(seasonRange({ startsAt: at('2026-10-01T00:00:00').getTime(), endsAt: at('2026-11-15T09:30:00').getTime() })).toBe('1 Oct to 15 Nov')
  })
})

describe('seasonWinners', () => {
  it('is whoever earned the most points this season', () => {
    expect(seasonWinners([{ id: 'a', seasonPoints: 300 }, { id: 'b', seasonPoints: 500 }])).toEqual(['b'])
  })
  it('gives a tie for first one winner: the higher all-time points', () => {
    const rows = [{ id: 'a', name: 'Ann', seasonPoints: 500, allTime: 900 }, { id: 'b', name: 'Bo', seasonPoints: 500, allTime: 1200 }, { id: 'c', name: 'Cy', seasonPoints: 100, allTime: 5000 }]
    expect(seasonWinners(rows)).toEqual(['b'])
    expect(seasonWinners([...rows].reverse())).toEqual(['b'])
  })
  it('settles a tie on all-time points by name, whatever the order of the rows', () => {
    const rows = [{ id: 'z', name: 'Zed', seasonPoints: 300, allTime: 700 }, { id: 'm', name: 'Maya', seasonPoints: 300, allTime: 700 }]
    expect(seasonWinners(rows)).toEqual(['m'])
    expect(seasonWinners([...rows].reverse())).toEqual(['m'])
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

describe('compareStandings', () => {
  it('orders by season points, then all-time points, then name', () => {
    const rows = [
      { id: 'c', name: 'Cy', seasonPoints: 100, allTime: 0 },
      { id: 'b', name: 'Bo', seasonPoints: 200, allTime: 100 },
      { id: 'a', name: 'Ann', seasonPoints: 200, allTime: 100 },
      { id: 'd', name: 'Di', seasonPoints: 200, allTime: 300 },
    ]
    expect([...rows].sort(compareStandings).map((r) => r.id)).toEqual(['d', 'a', 'b', 'c'])
  })
})
