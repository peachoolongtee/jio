import { describe, expect, it } from 'vitest'
import { chooseMeetingArea, meetingResultLine } from '../meetingArea.js'
import { transitMinutes } from '../travel.js'
import { AREAS } from '../../mock/places.js'

const area = (id) => AREAS.find((a) => a.id === id)
const origin = (personId, areaId) => ({ ...area(areaId), id: personId })
const DEMO = [
  origin('ian', 'tiong-bahru'),
  origin('darius', 'bugis'),
  origin('jonathan', 'jurong-east'),
  origin('nicole', 'tampines'),
  origin('faith', 'punggol'),
  origin('darryl', 'bishan'),
]

describe('meeting area', () => {
  it('needs at least 2 locations', () => {
    expect(chooseMeetingArea({ origins: [], candidates: AREAS })).toBeNull()
    expect(chooseMeetingArea({ origins: [DEMO[0]], candidates: AREAS })).toBeNull()
  })

  it('keeps the longest trip as short as possible', () => {
    const result = chooseMeetingArea({ origins: DEMO, candidates: AREAS })
    for (const candidate of AREAS) {
      const worst = Math.max(...DEMO.map((o) => transitMinutes(o, candidate)))
      expect(result.maxMinutes).toBeLessThanOrEqual(worst)
    }
  })

  it('breaks a tie on the longest trip with the lower total', () => {
    const result = chooseMeetingArea({ origins: DEMO, candidates: AREAS })
    const tied = AREAS.filter((c) => Math.max(...DEMO.map((o) => transitMinutes(o, c))) === result.maxMinutes)
    expect(tied.length).toBeGreaterThan(1)
    for (const candidate of tied) {
      const total = DEMO.reduce((sum, o) => sum + transitMinutes(o, candidate), 0)
      expect(result.totalMinutes).toBeLessThanOrEqual(total)
    }
    expect(result.areaId).toBe('bishan')
  })

  it('snaps to a real place from the candidate list', () => {
    const result = chooseMeetingArea({ origins: DEMO, candidates: AREAS })
    expect(AREAS.map((a) => a.id)).toContain(result.areaId)
  })

  it('falls back to the geographic centre when routing is unavailable, and says so', () => {
    const result = chooseMeetingArea({ origins: DEMO, candidates: AREAS, routing: false })
    expect(result.method).toBe('centre')
    expect(AREAS.map((a) => a.id)).toContain(result.areaId)
    expect(meetingResultLine(result, 'Toa Payoh')).toMatch(/Routing is unavailable/)
  })

  it('uses the shared place when everyone starts from the same place', () => {
    const result = chooseMeetingArea({ origins: [origin('ian', 'novena'), origin('darius', 'novena'), origin('nicole', 'novena')], candidates: AREAS })
    expect(result.areaId).toBe('novena')
    expect(result.maxMinutes).toBe(0)
    expect(meetingResultLine(result, 'Novena')).toBe('Fairest for 3 people: everyone starts from Novena.')
  })

  it('still works, with honest times, when starts are far apart', () => {
    const result = chooseMeetingArea({ origins: [origin('jonathan', 'jurong-east'), origin('faith', 'punggol')], candidates: AREAS })
    expect(result).not.toBeNull()
    expect(result.times.jonathan).toBeGreaterThan(20)
    expect(result.times.faith).toBeGreaterThan(20)
    expect(result.maxMinutes).toBe(Math.max(result.times.jonathan, result.times.faith))
  })

  it('writes the result line', () => {
    const result = chooseMeetingArea({ origins: DEMO, candidates: AREAS })
    expect(meetingResultLine(result, 'Bishan')).toBe(`Fairest for 6 people: nobody travels more than ${result.maxMinutes} minutes.`)
  })
})

describe('choosing another meeting area', () => {
  it('gives travel times to the chosen area', async () => {
    const { meetingAt } = await import('../meetingArea.js')
    const novena = AREAS.find((a) => a.id === 'novena')
    const result = meetingAt({ origins: DEMO, area: novena })
    expect(result.areaId).toBe('novena')
    expect(result.method).toBe('chosen')
    expect(result.times.jonathan).toBe(transitMinutes(DEMO[2], novena))
  })

  it('needs at least 2 locations', async () => {
    const { meetingAt } = await import('../meetingArea.js')
    expect(meetingAt({ origins: [DEMO[0]], area: AREAS[0] })).toBeNull()
  })

  it('ranks the alternatives fairest first, with the fairest matching the automatic choice', async () => {
    const { rankAreas } = await import('../meetingArea.js')
    const ranked = rankAreas({ origins: DEMO, candidates: AREAS })
    expect(ranked).toHaveLength(AREAS.length)
    expect(ranked[0].areaId).toBe(chooseMeetingArea({ origins: DEMO, candidates: AREAS }).areaId)
    for (let i = 1; i < ranked.length; i++) expect(ranked[i].maxMinutes).toBeGreaterThanOrEqual(ranked[i - 1].maxMinutes)
  })
})
