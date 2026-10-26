import { describe, expect, it } from 'vitest'
import { roamReply } from '../src/services/session-slots.js'

// roamReply: the engine's Roam answer as the members of a session may read it. Pure, so it is tested without a server.
const result = (extra = {}) => ({
  rank: 1,
  venueId: 'a',
  name: 'Ya Kun',
  venue: { id: 'a', name: 'Ya Kun' },
  score: 12.3456,
  travelMinutes: 7.46,
  distanceKm: 0.4,
  walkMinutes: 6.04,
  crowd: 'quiet',
  reasons: ['Short walk'],
  warnings: [],
  swap: null,
  explanation: 'A good fit.',
  approximate: false,
  breakdown: { price: 10 },
  verify: [],
  dietUnknown: [],
  ...extra,
})
const context = { weather: { source: 'live' }, stopVenueIds: new Set(['b']), proposedBy: new Map([['c', 'user-1']]) }

describe('roamReply', () => {
  it('keeps what a card needs, rounds minutes to one decimal, and leaves out the point, the breakdown and the engine\'s counters', () => {
    const reply = roamReply({ status: 'ok', centre: { lat: 1.3, lng: 103.8 }, results: [result()], notice: null, diagnostics: { x: 1 } }, context)
    expect(reply).toEqual({
      status: 'ok',
      results: [expect.objectContaining({ venueId: 'a', travelMinutes: 7.5, walkMinutes: 6, distanceKm: 0.4, isStop: false, proposedBy: null })],
      notice: null,
      weather: { source: 'live' },
    })
    expect(reply.results[0]).not.toHaveProperty('breakdown')
    expect(JSON.stringify(reply)).not.toContain('103.8')
  })

  it('turns the needs a place only likely meets into one flag that names none', () => {
    const [checked, plain] = roamReply({ status: 'ok', results: [result({ verify: ['halal'] }), result({ venueId: 'x', dietUnknown: [] })] }, context).results
    expect(checked.checkNeeds).toBe(true)
    expect(plain).not.toHaveProperty('checkNeeds')
    expect(checked).not.toHaveProperty('verify')
    expect(checked).not.toHaveProperty('dietUnknown')
    expect(JSON.stringify(checked)).not.toContain('halal')
    expect(roamReply({ status: 'ok', results: [result({ dietUnknown: ['vegan'] })] }, context).results[0].checkNeeds).toBe(true)
  })

  it('says which places are stops and who put a place forward', () => {
    const reply = roamReply({ status: 'ok', results: [result({ venueId: 'b' }), result({ venueId: 'c' }), result({ venueId: 'd' })] }, context)
    expect(reply.results.map((r) => [r.isStop, r.proposedBy])).toEqual([[true, null], [false, 'user-1'], [false, null]])
  })

  it('cuts an empty answer down to its reason and the distances: the hints that say which need to relax never leave', () => {
    const hinted = roamReply({ status: 'empty', reason: 'no_venue_passes_constraints', results: [], hints: [{ drop: 'diet:halal', kind: 'diet', passes: 4 }, { drop: 'step_free', kind: 'constraint', passes: 9 }] }, context)
    expect(hinted).toEqual({ status: 'empty', reason: 'no_venue_passes_constraints', hints: {}, results: [], weather: { source: 'live' } })
    const far = roamReply({ status: 'empty', reason: 'outside_max_radius', results: [], hints: { nearestKm: 4.2, widenToKm: 5 } }, context)
    expect(far.hints).toEqual({ nearestKm: 4.2, widenToKm: 5 })
  })
})
