import { describe, expect, it } from 'vitest'
import { loadPlanData } from '../src/db/venues.js'
import { mockTravelMinutes } from '../src/planner/geo.js'
import {
  approvalCount,
  describeChange,
  knownPlaceRow,
  locatedMembers,
  lostApprovalAreas,
  lostApprovalsNote,
  meetingAtSpot,
  methodFor,
  orderedSpots,
  plannerMethod,
  preselectedSpot,
  priceAreaRun,
  relistedRows,
  spotRowsFrom,
  suggestedAreaIds,
} from '../src/services/session-plan.js'

// The rules of the meeting spots as pure functions (services/session-plan.js): rows in, rows out.
const data = loadPlanData()
const areasById = new Map(data.areas.map((a) => [a.id, a]))
const A = '1111111a-1111-4111-8111-11111111111b'
const B = '2222222c-2222-4222-8222-22222222222d'
const C = '3333333e-3333-4333-8333-33333333333f'
const member = (id, start, extra = {}) => ({ user_id: id, role: 'guest', state: 'joined', start_area_id: start, end_area_id: null, ...extra })

describe('locatedMembers', () => {
  it('plans for joined members whose start is a known area, from the centre of that area, and reports the others as skipped', () => {
    const { located, skipped } = locatedMembers(
      [member(A, 'bugis'), member(B, 'not-an-area'), member(C, null), member('4444444a-4444-4444-8444-44444444444a', 'bishan', { state: 'opted_out' })],
      areasById,
    )
    expect(located).toHaveLength(1)
    expect(located[0]).toMatchObject({ id: A, start: { lat: areasById.get('bugis').lat, lng: areasById.get('bugis').lng } })
    expect(skipped).toEqual([B, C])
  })

  it('takes the end from the end area when it is known, else the start, and gives the engine bare points', () => {
    const { located } = locatedMembers([member(A, 'bugis', { end_area_id: 'bishan' }), member(B, 'bugis', { end_area_id: 'nowhere' })], areasById)
    expect(located[0].end).toEqual({ lat: areasById.get('bishan').lat, lng: areasById.get('bishan').lng })
    expect(located[1].end).toEqual(located[1].start)
    expect(located[0].start).not.toHaveProperty('id')
  })

  it('writes ids the way Postgres prints them, so a spot\'s minutes pass the database check', () => {
    const { located } = locatedMembers([member(A.toUpperCase(), 'bugis')], areasById)
    expect(located[0].id).toBe(A)
  })
})

describe('suggestedAreaIds', () => {
  const at = (n) => `2026-10-20T08:00:0${n}.000Z`
  it('lists each suggested area once, oldest first, for joined members and known areas only', () => {
    const suggestions = [
      { user_id: B, area_id: 'orchard', created_at: at(2) },
      { user_id: A, area_id: 'bugis', created_at: at(1) },
      { user_id: C, area_id: 'bugis', created_at: at(3) },
      { user_id: C, area_id: 'atlantis', created_at: at(0) },
    ]
    expect(suggestedAreaIds(suggestions, [member(A), member(B), member(C)], areasById)).toEqual(['bugis', 'orchard'])
    expect(suggestedAreaIds(suggestions, [member(A), member(B, null, { state: 'opted_out' }), member(C)], areasById)).toEqual(['bugis'])
  })

  it('keeps at most eight areas', () => {
    const ids = data.areas.slice(0, 12).map((a, i) => ({ user_id: `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, area_id: a.id, created_at: `2026-10-20T08:00:${String(i).padStart(2, '0')}.000Z` }))
    const members = ids.map((s) => member(s.user_id))
    expect(suggestedAreaIds(ids, members, areasById)).toHaveLength(8)
  })
})

describe('spotRowsFrom', () => {
  const candidate = (id, source, minutes, approximate = false) => ({ area: { id }, source, worstMinutes: Math.max(...Object.values(minutes)), meanMinutes: Object.values(minutes).reduce((s, m) => s + m, 0) / Object.keys(minutes).length, travelByMember: minutes, approximate })

  it('gives the chosen area and its runners-up ranks 1 to 3, and an included area no rank', () => {
    const rows = spotRowsFrom(
      { candidates: [candidate('bishan', 'ranked', { [A]: 20.4, [B]: 30.4 }), candidate('bugis', 'ranked', { [A]: 25, [B]: 31 }), candidate('orchard', 'ranked', { [A]: 26, [B]: 33 }), candidate('tampines', 'included', { [A]: 40, [B]: 5 })] },
      { source: 'onemap' },
    )
    expect(rows.map((r) => [r.area_id, r.rank])).toEqual([['bishan', 1], ['bugis', 2], ['orchard', 3], ['tampines', null]])
  })

  it('keeps the minutes unrounded and keyed by lower-case member id', () => {
    const [row] = spotRowsFrom({ candidates: [candidate('bishan', 'ranked', { [A.toUpperCase()]: 20.4, [B]: 30.45 })] }, { source: 'onemap' })
    expect(row.worst_minutes).toBe(30.45)
    expect(row.mean_minutes).toBeCloseTo(25.425, 6)
    expect(row.travel_minutes).toEqual({ [A]: 20.4, [B]: 30.45 })
  })

  it('marks a spot approximate when its own trips were estimates or when the whole answer is the estimate', () => {
    const rows = spotRowsFrom({ candidates: [candidate('bishan', 'ranked', { [A]: 20 }, true), candidate('bugis', 'ranked', { [A]: 21 }, false)] }, { source: 'onemap' })
    expect(rows.map((r) => r.approximate)).toEqual([true, false])
    expect(spotRowsFrom({ candidates: [candidate('bugis', 'ranked', { [A]: 21 })] }, { source: 'estimate' })[0].approximate).toBe(true)
  })

  it('never writes a figure the database would refuse', () => {
    const [row] = spotRowsFrom({ candidates: [candidate('bishan', 'ranked', { [A]: Number.NaN, [B]: 5000 })] }, { source: 'estimate' })
    expect(row.worst_minutes).toBeLessThanOrEqual(1440)
    expect(Object.values(row.travel_minutes).every((m) => m >= 0 && m <= 1440)).toBe(true)
    expect(row.mean_minutes).toBeLessThanOrEqual(row.worst_minutes)
  })
})

describe('relistedRows and orderedSpots', () => {
  const stored = [
    { area_id: 'a', rank: 2 },
    { area_id: 'b', rank: null },
    { area_id: 'c', rank: 1 },
    { area_id: 'd', rank: null },
  ]
  it('keeps the app\'s ranked spots and the stored spots a suggestion still names', () => {
    expect(relistedRows(stored, ['d']).map((s) => s.area_id)).toEqual(['a', 'c', 'd'])
    expect(relistedRows(stored, []).map((s) => s.area_id)).toEqual(['a', 'c'])
  })

  it('orders the app\'s spots by rank, then the members\' by who suggested first', () => {
    const suggestions = [
      { user_id: A, area_id: 'd', created_at: '2026-10-20T08:00:01.000Z' },
      { user_id: B, area_id: 'b', created_at: '2026-10-20T08:00:02.000Z' },
    ]
    expect(orderedSpots(stored, suggestions).map((s) => s.area_id)).toEqual(['c', 'a', 'd', 'b'])
  })
})

describe('preselectedSpot, methodFor and meetingAtSpot', () => {
  const spot = (area, rank, worst, travel = { [A]: worst, [B]: worst }) => ({ area_id: area, rank, worst_minutes: worst, mean_minutes: worst, travel_minutes: travel, approximate: false })
  const list = [spot('x', 1, 30), spot('y', 2, 28.5), spot('z', null, 28.4)]
  const members = [member(A, 'bugis'), member(B, 'bishan'), member(C, null)]
  const approve = (area, ...users) => users.map((user_id) => ({ area_id: area, user_id }))

  it('offers the first spot when nobody approved anything', () => {
    expect(preselectedSpot(list, [], members).area_id).toBe('x')
    expect(preselectedSpot([], [], members)).toBeNull()
  })

  it('offers the most approved; a tie goes to the shorter longest trip, compared exactly, then to the list order', () => {
    expect(preselectedSpot(list, [...approve('y', A, B), ...approve('x', C)], members).area_id).toBe('y')
    expect(preselectedSpot(list, [...approve('x', A), ...approve('y', B), ...approve('z', C)], members).area_id).toBe('z') // 28.4 < 28.5 < 30
    expect(preselectedSpot([spot('p', 1, 20), spot('q', 2, 20)], [...approve('p', A), ...approve('q', B)], members).area_id).toBe('p')
  })

  it('counts only joined members', () => {
    const out = [member(A, 'bugis'), member(B, 'bishan', { state: 'opted_out' })]
    expect(approvalCount([...approve('x', A, B)], 'x', out)).toBe(1)
  })

  it('calls a confirmed spot voted, the planner\'s own method, or chosen', () => {
    const { located } = locatedMembers(members, areasById)
    expect(methodFor(list[1], approve('y', A), members, located)).toBe('voted')
    expect(methodFor(list[0], [], members, located)).toBe('fairest')
    expect(methodFor(list[1], [], members, located)).toBe('chosen')
    expect(methodFor(list[2], [], members, located)).toBe('chosen')
    const together = locatedMembers([member(A, 'bugis'), member(B, 'bugis')], areasById).located
    expect(plannerMethod(together)).toBe('same')
    expect(methodFor(list[0], [], members, together)).toBe('same')
  })

  it('describes the meeting area from a spot\'s stored figures, in the rounded minutes the screens show', () => {
    const meeting = meetingAtSpot(spot('y', 2, 28.5, { [A]: 20.4, [B]: 28.5 }), 'voted')
    expect(meeting).toEqual({ area_id: 'y', method: 'voted', max_minutes: 29, total_minutes: 20 + 29, count: 2, approximate: false, travel: { [A]: 20, [B]: 29 } })
    expect(meetingAtSpot(spot('y', null, 0, {}), 'chosen')).toMatchObject({ max_minutes: 0, total_minutes: 0, count: 0 })
  })
})

describe('what the group is told', () => {
  it('names the spots whose approvals went, as the browser\'s planner does', () => {
    const name = (id) => ({ orchard: 'Orchard', bugis: 'Bugis', bishan: 'Bishan' })[id]
    expect(lostApprovalsNote(['orchard'], name)).toBe('Orchard is no longer on the list, so approvals for it were removed.')
    expect(lostApprovalsNote(['orchard', 'bugis', 'bishan'], name)).toBe('Orchard, Bugis and Bishan are no longer on the list, so approvals for them were removed.')
  })

  it('finds the areas whose approvals a new list takes: dropped spots that someone approved', () => {
    const stored = [{ area_id: 'a' }, { area_id: 'b' }, { area_id: 'c' }]
    const approvals = [{ area_id: 'a', user_id: A }, { area_id: 'a', user_id: B }, { area_id: 'b', user_id: A }]
    expect(lostApprovalAreas(stored, [{ area_id: 'b' }, { area_id: 'c' }], approvals)).toEqual(['a'])
    expect(lostApprovalAreas(stored, [], approvals).sort()).toEqual(['a', 'b'])
    expect(lostApprovalAreas(stored, stored, approvals)).toEqual([])
  })

  it('says why the list changed', () => {
    expect(describeChange('start', 'Ian')).toBe("Ian's start location changed.")
    expect(describeChange('optout', 'Ian')).toBe('Ian opted out.')
    expect(describeChange('left', 'Ian')).toBe('Ian left.')
    expect(describeChange('something else', 'Ian')).toBe('The group changed.')
  })
})

describe('pricing one area (the host\'s known place)', () => {
  const bugis = areasById.get('bugis')
  const area = { id: bugis.id, lat: bugis.lat, lng: bugis.lng }
  const { located } = locatedMembers([member(A, 'tampines'), member(B, 'clementi')], areasById)

  it('uses the estimate with no routing and says it is approximate only where it had to fall back', () => {
    const priced = priceAreaRun({ members: located, area }, data, {})
    expect(priced.approximate).toBe(false)
    expect(priced.travelByMember[A]).toBeCloseTo(mockTravelMinutes(located[0].start, area), 9)
  })

  it('reads the time the travel layer has, and falls back to the estimate, flagged, when it has none', () => {
    const priced = priceAreaRun({ members: located, area }, data, { travelMinutes: (from) => (from === located[0].start ? 17 : null) })
    expect(priced.travelByMember[A]).toBe(17)
    expect(priced.travelByMember[B]).toBeCloseTo(mockTravelMinutes(located[1].start, area), 9)
    expect(priced.approximate).toBe(true)
  })

  it('makes the row of a known place: no rank, the longest and mean trip, zeros when nobody has a start', () => {
    const row = knownPlaceRow('bugis', { travelByMember: { [A]: 20, [B]: 30 }, approximate: false }, { source: 'onemap' })
    expect(row).toMatchObject({ area_id: 'bugis', rank: null, worst_minutes: 30, mean_minutes: 25, approximate: false, travel_minutes: { [A]: 20, [B]: 30 } })
    expect(knownPlaceRow('bugis', null, null)).toMatchObject({ worst_minutes: 0, mean_minutes: 0, travel_minutes: {}, approximate: false })
    expect(knownPlaceRow('bugis', { travelByMember: { [A]: 20 }, approximate: false }, { source: 'estimate' }).approximate).toBe(true)
  })
})
