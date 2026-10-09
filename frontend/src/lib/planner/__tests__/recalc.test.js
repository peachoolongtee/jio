import { describe, expect, it } from 'vitest'
import { recalculate, recalcBanner } from '../recalc.js'

const bishan = { areaId: 'bishan' }
const serangoon = { areaId: 'serangoon' }

describe('re-calculation before Confirmed', () => {
  it('keeps all votes when the meeting area stays the same', () => {
    const out = recalculate({ status: 'voting', previous: bishan, next: bishan, trigger: { kind: 'start', personName: 'Darius' }, previousName: 'Bishan', nextName: 'Bishan' })
    expect(out.mode).toBe('apply')
    expect(out.moved).toBe(false)
    expect(out.clearVotes).toBe(false)
    expect(out.refreshSuggestions).toBe(false)
    expect(out.banner).toBe("Meeting area stays at Bishan. Darius's start location changed.")
  })

  it('refreshes suggestions and clears place votes when the area moves, but keeps categories and timing', () => {
    const out = recalculate({ status: 'voting', previous: bishan, next: serangoon, trigger: { kind: 'optout', personName: 'Jonathan' }, previousName: 'Bishan', nextName: 'Serangoon' })
    expect(out.moved).toBe(true)
    expect(out.clearVotes).toBe(true)
    expect(out.refreshSuggestions).toBe(true)
    expect(out.keepPreferences).toBe(true)
    expect(out.banner).toBe('Meeting area moved from Bishan to Serangoon because Jonathan opted out.')
  })

  it('updates the area at once while Locating', () => {
    const out = recalculate({ status: 'locating', previous: bishan, next: serangoon, trigger: { kind: 'start', personName: 'Jonathan' }, previousName: 'Bishan', nextName: 'Serangoon' })
    expect(out.mode).toBe('apply')
    expect(out.meeting).toBe(serangoon)
    expect(out.banner).toMatch(/moved from Bishan to Serangoon because Jonathan's start location changed/)
  })

  it('treats a late location like any other change once voting has started', () => {
    const out = recalculate({ status: 'voting', previous: bishan, next: bishan, trigger: { kind: 'added', personName: 'Faith' }, previousName: 'Bishan', nextName: 'Bishan' })
    expect(out.banner).toBe('Meeting area stays at Bishan. Faith added a start location.')
  })
})

describe('re-calculation after Confirmed', () => {
  it('never changes the plan silently: it asks to re-plan, with the reason', () => {
    const out = recalculate({ status: 'confirmed', previous: bishan, next: serangoon, trigger: { kind: 'optout', personName: 'Jonathan' }, previousName: 'Bishan', nextName: 'Serangoon' })
    expect(out.mode).toBe('prompt')
    expect(out.keepPlan).toBe(true)
    expect(out.reason).toBe('Jonathan opted out. The fairest meeting area is now Serangoon.')
  })
})

describe('banner text', () => {
  it('names the end location too', () => {
    expect(recalcBanner({ previousName: 'Bishan', nextName: 'Bishan', trigger: { kind: 'end', personName: 'Nicole' } })).toBe("Meeting area stays at Bishan. Nicole's end location changed.")
  })
})
