import { describe, expect, it } from 'vitest'
import { barHeight, buildGrid, camera, computeStats, dayMs, levelOf, monthLabels, project, riseAt } from '../skyline.js'

const today = new Date(2026, 9, 8) // Thursday 8 October 2026

describe('buildGrid', () => {
  it('starts on a Monday and ends today, with weekdays as rows', () => {
    const { cells, weeks } = buildGrid({ today, weeks: 4 })
    expect(new Date(dayMs(cells[0].date)).getUTCDay()).toBe(1)
    expect(cells[cells.length - 1].date).toBe('2026-10-08')
    expect(cells[cells.length - 1].today).toBe(true)
    expect(weeks).toBe(4)
    expect(cells[9]).toMatchObject({ week: 1, day: 2 })
  })
  it('adds up repeated dates and marks planned days', () => {
    const { cells } = buildGrid({ today, weeks: 2, history: [{ date: '2026-10-03', count: 1 }, { date: '2026-10-03', count: 1 }], planned: ['2026-10-10'] })
    expect(cells.find((c) => c.date === '2026-10-03')).toMatchObject({ count: 2, level: 2 })
    const planned = cells.find((c) => c.date === '2026-10-10')
    expect(planned).toMatchObject({ planned: true, future: true })
  })
  it('stretches ahead for planned meetups, but no more than six weeks', () => {
    const near = buildGrid({ today, weeks: 2, planned: ['2026-10-20'] })
    expect(near.cells[near.cells.length - 1].date).toBe('2026-10-20')
    const far = buildGrid({ today, weeks: 2, planned: ['2027-03-01'] })
    expect(far.cells[far.cells.length - 1].date).toBe('2026-10-08')
  })
})

describe('levelOf', () => {
  it('is the number of meetups, up to 4', () => {
    expect([0, 1, 2, 3, 9].map(levelOf)).toEqual([0, 1, 2, 3, 4])
  })
})

describe('computeStats', () => {
  it('counts streaks in weeks, and the current one can end last week', () => {
    const history = ['2026-09-12', '2026-09-19', '2026-09-26', '2026-09-27', '2026-10-03'].map((date) => ({ date, count: 1 }))
    const stats = computeStats(buildGrid({ today, weeks: 8, history }).cells)
    expect(stats.total).toBe(5)
    expect(stats.longest.weeks).toBe(4)
    expect(stats.current.weeks).toBe(4)
    expect(stats.busiest).toEqual({ count: 1, date: '2026-09-12' })
  })
  it('ignores planned days in the future', () => {
    const stats = computeStats(buildGrid({ today, weeks: 2, planned: ['2026-10-10'] }).cells)
    expect(stats.total).toBe(0)
    expect(stats.current.weeks).toBe(0)
  })
})

describe('monthLabels', () => {
  it('labels the week each month starts', () => {
    const { cells, weeks } = buildGrid({ today, weeks: 12 })
    expect(monthLabels(cells, weeks).map((m) => m.label)).toEqual(['Aug', 'Sep', 'Oct'])
  })
})

describe('the scene', () => {
  it('looks straight down in the flat view, so heights do not show', () => {
    const flat = camera(0)
    const [x1, y1] = project(flat, 3, 2, 5)
    const [x0, y0] = project(flat, 3, 2, 0)
    expect(x1).toBeCloseTo(x0)
    expect(y1).toBeCloseTo(y0)
    expect(project(camera(1), 3, 2, 5)).not.toEqual(project(camera(1), 3, 2, 0))
  })
  it('raises every bar from flat to full during the morph', () => {
    expect(riseAt(0, 10, 20, 3)).toBe(0)
    expect(riseAt(1, 10, 20, 3)).toBe(1)
    expect(riseAt(0.3, 0, 20, 0)).toBeGreaterThan(riseAt(0.3, 19, 20, 0))
  })
  it('keeps empty days thin and one meetup modest', () => {
    expect(barHeight(0, 1)).toBe(0.2)
    expect(barHeight(1, 1)).toBeLessThan(barHeight(3, 3))
  })
})
