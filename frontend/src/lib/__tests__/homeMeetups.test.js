import { describe, expect, it } from 'vitest'
import { FAN_PX, HOME_MEETUPS_SHOWN, MEETUP_RANGES, activeMeetups, allMeetupsLabel, dayLabel, defaultRange, homeList, inRange, layoutPins, meetupsIn, rangeCounts, nextStepFor, pinName, pinsFor, placeCard, routesFor, selectMeetup, whenLine, whereStands } from '../homeMeetups.js'

const NOW = new Date('2026-10-10T09:00:00+08:00')
const BUGIS = { id: 'bugis', name: 'Bugis', lat: 1.30065, lng: 103.85585 }
const TAMPINES = { id: 'tampines', name: 'Tampines', lat: 1.35408, lng: 103.94535 }
const start = (area) => ({ areaId: area.id, name: area.name, lat: area.lat, lng: area.lng })

// A session summary with only the fields Home reads.
const make = (over = {}) => ({
  id: 's1',
  title: 'Saturday lunch',
  date: '2026-10-17',
  start: '12:00',
  end: '15:00',
  hostId: 'ian',
  status: 'inviting',
  createdAt: 1,
  members: [{ id: 'ian', role: 'host', state: 'joined' }],
  activeIds: ['ian'],
  locations: {},
  votes: {},
  meeting: null,
  area: null,
  findingMeeting: false,
  replan: null,
  isToday: false,
  ...over,
})
const ids = (list) => list.map((s) => s.id)

describe('activeMeetups', () => {
  it('leaves out completed and cancelled sessions', () => {
    const list = [make({ id: 'a' }), make({ id: 'b', status: 'completed' }), make({ id: 'c', status: 'cancelled' }), make({ id: 'd', status: 'voting' })]
    expect(ids(activeMeetups(list, NOW))).toEqual(['a', 'd'])
  })

  it('puts the soonest day first, whatever order they were made in', () => {
    const list = [make({ id: 'late', date: '2026-11-01', createdAt: 3 }), make({ id: 'soon', date: '2026-10-11', createdAt: 1 }), make({ id: 'mid', date: '2026-10-20', createdAt: 2 })]
    expect(ids(activeMeetups(list, NOW))).toEqual(['soon', 'mid', 'late'])
  })

  it('orders the same day by start time', () => {
    const list = [make({ id: 'eve', start: '19:00' }), make({ id: 'morn', start: '09:30' }), make({ id: 'noon', start: '12:00' })]
    expect(ids(activeMeetups(list, NOW))).toEqual(['morn', 'noon', 'eve'])
  })

  it('puts a missing start time, and a missing date, after the ones that have one', () => {
    const list = [make({ id: 'no-time', start: undefined }), make({ id: 'timed', start: '18:00' }), make({ id: 'no-date', date: undefined, start: '08:00' })]
    expect(ids(activeMeetups(list, NOW))).toEqual(['timed', 'no-time', 'no-date'])
  })

  it('breaks a full tie by who was made first, then by id, the same every time', () => {
    const list = [make({ id: 's10', createdAt: 5 }), make({ id: 's9', createdAt: 5 }), make({ id: 's2', createdAt: 1 })]
    expect(ids(activeMeetups(list, NOW))).toEqual(['s2', 's9', 's10'])
    expect(ids(activeMeetups([...list].reverse(), NOW))).toEqual(['s2', 's9', 's10'])
  })

  it('treats the demo session day as today', () => {
    const list = [make({ id: 'far', date: '2026-10-12', start: '10:00' }), make({ id: 'demo', date: '2026-12-25', start: '20:00', isToday: true })]
    expect(ids(activeMeetups(list, NOW))).toEqual(['demo', 'far'])
  })

  it('does not change the list it was given, and copes with none', () => {
    const list = [make({ id: 'b', date: '2026-10-20' }), make({ id: 'a', date: '2026-10-11' })]
    activeMeetups(list, NOW)
    expect(ids(list)).toEqual(['b', 'a'])
    expect(activeMeetups(undefined, NOW)).toEqual([])
  })
})

describe('selectMeetup', () => {
  const meetups = [make({ id: 'a' }), make({ id: 'b' })]
  it('picks the one the address names', () => {
    expect(selectMeetup(meetups, 'b').id).toBe('b')
  })
  it('falls back to the soonest for an id that is not there, a repeated one, or none', () => {
    expect(selectMeetup(meetups, 'nope').id).toBe('a')
    expect(selectMeetup(meetups, undefined).id).toBe('a')
    expect(selectMeetup(meetups, ['b', 'a']).id).toBe('b')
    expect(selectMeetup(meetups, ['zzz']).id).toBe('a')
  })
  it('is null when nothing is going', () => {
    expect(selectMeetup([], 'a')).toBeNull()
  })
})

describe('dayLabel and whenLine', () => {
  it('says Today, a weekday inside the week, then the date', () => {
    expect(dayLabel(make({ date: '2026-10-10' }), NOW)).toBe('Today')
    expect(dayLabel(make({ date: '2026-10-11' }), NOW)).toBe('Sun')
    expect(dayLabel(make({ date: '2026-10-16' }), NOW)).toBe('Fri')
    expect(dayLabel(make({ date: '2026-10-17' }), NOW)).toBe('17 Oct')
    expect(dayLabel(make({ date: '2026-10-03' }), NOW)).toBe('3 Oct')
  })
  it('says Today for the demo session day', () => {
    expect(dayLabel(make({ date: '2026-12-25', isToday: true }), NOW)).toBe('Today')
  })
  it('is empty without a date', () => {
    expect(dayLabel(make({ date: undefined }), NOW)).toBe('')
  })
  it('writes the day and start, leaving out what is missing', () => {
    expect(whenLine(make({ date: '2026-10-17', start: '12:00' }), NOW)).toBe('Sat 17 Oct · 12:00')
    expect(whenLine(make({ date: '2026-10-17', start: undefined }), NOW)).toBe('Sat 17 Oct')
    expect(whenLine(make({ date: undefined, start: '12:00' }), NOW)).toBe('12:00')
  })
})

describe('whereStands', () => {
  it('names the meeting area and how long it takes this person', () => {
    const s = make({ status: 'voting', area: BUGIS, meeting: { areaId: 'bugis', times: { ian: 25, darius: 31 } } })
    expect(whereStands(s, 'ian')).toMatchObject({ kind: 'area', text: 'Bugis · about 25 min for you', areaName: 'Bugis', minutes: 25 })
  })
  it('names just the area when there is no time for this person', () => {
    const s = make({ status: 'voting', area: BUGIS, meeting: { areaId: 'bugis', times: {} } })
    expect(whereStands(s, 'ian').text).toBe('Bugis')
  })
  it('counts the locations shared while there is no meeting point', () => {
    const s = make({
      status: 'locating',
      activeIds: ['ian', 'a', 'b', 'c', 'd'],
      locations: { ian: { start: start(BUGIS), end: null }, a: { start: start(TAMPINES), end: null }, b: { start: null, end: null } },
    })
    expect(whereStands(s, 'ian')).toMatchObject({ kind: 'waiting', text: 'No meeting point yet · 2 of 5 locations shared' })
  })
  it('says the planner is working', () => {
    expect(whereStands(make({ status: 'locating', findingMeeting: true }), 'ian')).toMatchObject({ kind: 'finding', text: 'Finding the fairest midpoint…' })
  })
  it('says there is no meeting point while people are still being invited', () => {
    expect(whereStands(make(), 'ian')).toMatchObject({ kind: 'none', text: 'No meeting point yet' })
  })
})

describe('nextStepFor', () => {
  const two = { activeIds: ['ian', 'darius'], members: [{ id: 'ian', state: 'joined' }, { id: 'darius', state: 'joined' }] }
  const located = { ian: { start: start(BUGIS), end: null }, darius: { start: start(TAMPINES), end: null } }

  it('asks the host to invite friends when nobody else is in', () => {
    expect(nextStepFor(make(), 'ian')).toEqual({ label: 'Invite friends', tone: 'action', to: '/sessions/s1' })
  })
  it('waits when invites are out and nobody has accepted', () => {
    const s = make({ members: [{ id: 'ian', state: 'joined' }, { id: 'darius', state: 'invited' }] })
    expect(nextStepFor(s, 'ian')).toMatchObject({ label: 'Waiting for friends', tone: 'wait' })
  })
  it('asks the host to start once two are in', () => {
    expect(nextStepFor(make(two), 'ian')).toMatchObject({ label: 'Start session', tone: 'action', to: '/sessions/s1' })
  })
  it('tells a guest to wait for the host while inviting', () => {
    expect(nextStepFor(make({ ...two, hostId: 'darius' }), 'ian')).toMatchObject({ label: 'Waiting for the host', tone: 'wait' })
  })
  it('asks for your start while locating', () => {
    const s = make({ ...two, status: 'locating', locations: { darius: { start: start(TAMPINES), end: null } } })
    expect(nextStepFor(s, 'ian')).toEqual({ label: 'Share your start', tone: 'action', to: '/sessions/s1' })
  })
  it('waits for the others once your start is in', () => {
    const s = make({ ...two, status: 'locating', locations: { ian: { start: start(BUGIS), end: null } } })
    expect(nextStepFor(s, 'ian')).toMatchObject({ label: 'Waiting for others', tone: 'wait' })
  })
  it('waits while the planner finds the midpoint', () => {
    const s = make({ ...two, status: 'locating', locations: located, findingMeeting: true })
    expect(nextStepFor(s, 'ian')).toMatchObject({ label: 'Finding the midpoint', tone: 'wait' })
  })
  it('asks the host to confirm the meeting point once it is found, and a guest to wait', () => {
    const s = make({ ...two, status: 'locating', locations: located, meeting: { areaId: 'bugis' }, area: BUGIS })
    expect(nextStepFor(s, 'ian')).toMatchObject({ label: 'Confirm the meeting point', tone: 'action' })
    expect(nextStepFor({ ...s, hostId: 'darius' }, 'ian')).toMatchObject({ label: 'Waiting for the host', tone: 'wait' })
  })
  it('asks for a vote, and opens the voting screen', () => {
    const s = make({ ...two, status: 'voting', locations: located, meeting: { areaId: 'bugis' }, area: BUGIS, votes: { eat: { darius: 'v1' } } })
    expect(nextStepFor(s, 'ian')).toEqual({ label: 'Vote', tone: 'action', to: '/sessions/s1/plan' })
  })
  it('waits for the others once you have voted', () => {
    const s = make({ ...two, status: 'voting', locations: located, meeting: { areaId: 'bugis' }, area: BUGIS, votes: { eat: { ian: 'v1' } } })
    expect(nextStepFor(s, 'ian')).toMatchObject({ label: 'Waiting for others', tone: 'wait', to: '/sessions/s1/plan' })
  })
  it('does not ask for a vote when voting has no meeting area (nobody has a start): it waits, or asks for your start', () => {
    // Two joined, only Darius has a start: there is nothing to vote on until a second start is shared.
    const paused = make({ ...two, remote: true, status: 'voting', locations: { darius: { start: start(TAMPINES), end: null } }, meeting: null, area: null })
    expect(nextStepFor(paused, 'ian')).toEqual({ label: 'Share your start', tone: 'action', to: '/sessions/s1' })
    expect(nextStepFor(paused, 'darius')).toMatchObject({ label: 'Waiting for others', tone: 'wait' })
    expect(nextStepFor(paused, 'ian').label).not.toBe('Vote')
    expect(nextStepFor(paused, 'darius').label).not.toBe('Vote')
  })
  it('points at the plan once it is confirmed', () => {
    const s = make({ ...two, status: 'confirmed', locations: located })
    expect(nextStepFor(s, 'ian')).toEqual({ label: 'See the plan', tone: 'done', to: '/sessions/s1/itinerary' })
    expect(nextStepFor({ ...s, isToday: true }, 'ian').label).toBe("Today's plan")
  })
  it('asks for a decision when a confirmed plan needs a re-plan', () => {
    const s = make({ ...two, status: 'confirmed', locations: located, replan: { reason: 'moved' } })
    expect(nextStepFor(s, 'ian')).toMatchObject({ label: 'Review the re-plan', tone: 'action', to: '/sessions/s1/itinerary' })
  })
  it('asks for more people when too few are left after the session started', () => {
    expect(nextStepFor(make({ status: 'voting' }), 'ian')).toMatchObject({ label: 'Invite friends', tone: 'action', to: '/sessions/s1/plan' })
    expect(nextStepFor(make({ status: 'locating', hostId: 'darius' }), 'ian')).toMatchObject({ label: 'Waiting for the host', tone: 'wait' })
  })
})

describe('pinsFor', () => {
  it('gives a pin only to a meetup that has a meeting area', () => {
    const pins = pinsFor([make({ id: 'a', area: BUGIS }), make({ id: 'b', area: null }), make({ id: 'c', area: TAMPINES })])
    expect(pins.map((p) => p.id)).toEqual(['a', 'c'])
    expect(pins[0]).toMatchObject({ areaId: 'bugis', areaName: 'Bugis', lat: BUGIS.lat, lng: BUGIS.lng, offset: { x: 0, y: 0 } })
  })
  it('leaves out an area with no coordinates', () => {
    expect(pinsFor([make({ area: { id: 'x', name: 'X' } })])).toEqual([])
  })
  it('fans meetups that share an area out sideways, centred, in the order given', () => {
    const pins = pinsFor([make({ id: 'a', area: BUGIS }), make({ id: 'b', area: TAMPINES }), make({ id: 'c', area: BUGIS }), make({ id: 'd', area: BUGIS })])
    expect(pins.map((p) => [p.id, p.offset.x])).toEqual([['a', -FAN_PX], ['b', 0], ['c', 0], ['d', FAN_PX]])
  })
  it('puts two at an area either side of it', () => {
    const pins = pinsFor([make({ id: 'a', area: BUGIS }), make({ id: 'b', area: BUGIS })])
    expect(pins.map((p) => p.offset.x)).toEqual([-FAN_PX / 2, FAN_PX / 2])
  })
  it('gives the same answer every time', () => {
    const list = [make({ id: 'a', area: BUGIS }), make({ id: 'b', area: BUGIS })]
    expect(pinsFor(list)).toEqual(pinsFor(list))
  })
  it('keeps the pins about 44px apart or more when they share an area', () => {
    expect(FAN_PX).toBeGreaterThanOrEqual(44)
  })
})

describe('pinName', () => {
  it('names the title, area and when', () => {
    expect(pinName(make({ area: BUGIS }), NOW)).toBe('Saturday lunch, Bugis, Sat 17 Oct · 12:00')
  })
  it('leaves out the area when there is none', () => {
    expect(pinName(make(), NOW)).toBe('Saturday lunch, Sat 17 Oct · 12:00')
  })
})

describe('routesFor', () => {
  it('draws one route from each start area to the meeting area', () => {
    const s = make({ activeIds: ['ian', 'darius'], area: BUGIS, locations: { ian: { start: start(TAMPINES) }, darius: { start: start({ id: 'orchard', name: 'Orchard', lat: 1.30406, lng: 103.83186 }) } } })
    expect(routesFor(s)).toEqual([
      { from: { lat: TAMPINES.lat, lng: TAMPINES.lng }, to: { lat: BUGIS.lat, lng: BUGIS.lng } },
      { from: { lat: 1.30406, lng: 103.83186 }, to: { lat: BUGIS.lat, lng: BUGIS.lng } },
    ])
  })
  it('makes one route for an area several people start from, and none for a start at the meeting area', () => {
    const s = make({ activeIds: ['ian', 'a', 'b'], area: BUGIS, locations: { ian: { start: start(TAMPINES) }, a: { start: start(TAMPINES) }, b: { start: start(BUGIS) } } })
    expect(routesFor(s)).toHaveLength(1)
  })
  it('ignores people who have left, and people with no start yet', () => {
    const s = make({ activeIds: ['ian'], area: BUGIS, locations: { ian: { start: null }, gone: { start: start(TAMPINES) } } })
    expect(routesFor(s)).toEqual([])
  })
  it('is empty with no meeting point, so the map draws its own routes', () => {
    expect(routesFor(make({ locations: { ian: { start: start(TAMPINES) } } }))).toEqual([])
  })
})

describe('placeCard', () => {
  const pin = { height: 90, halfWidth: 30 }
  const size = { w: 264, h: 200 }
  const box = { left: 8, top: 8, right: 1272, bottom: 700 }
  const overlaps = (c, tip) => c.left < tip.x + pin.halfWidth && c.left + size.w > tip.x - pin.halfWidth && c.top < tip.y && c.top + size.h > tip.y - pin.height
  const inside = (c, b) => c.left >= b.left && c.top >= b.top && c.left + size.w <= b.right && c.top + size.h <= b.bottom

  it('goes above the pin when there is room, centred on it, clear of its head', () => {
    const tip = { x: 600, y: 500 }
    const c = placeCard({ tip, pin, size, bounds: box })
    expect(c.side).toBe('above')
    expect(c.left).toBe(600 - 132)
    expect(c.top + size.h).toBeLessThanOrEqual(tip.y - pin.height)
    expect(c.caret).toBe(132)
    expect(c.inside).toBe(true)
  })

  it('goes below when there is no room above', () => {
    const tip = { x: 600, y: 160 }
    const c = placeCard({ tip, pin, size, bounds: box })
    expect(c.side).toBe('below')
    expect(c.top).toBeGreaterThan(tip.y)
    expect(inside(c, box)).toBe(true)
  })

  it('slides sideways to stay inside the box, and the caret keeps pointing at the pin', () => {
    const left = placeCard({ tip: { x: 20, y: 500 }, pin, size, bounds: box })
    expect(left.left).toBe(box.left)
    expect(left.caret).toBe(18 > 20 - box.left ? 18 : 20 - box.left)
    const right = placeCard({ tip: { x: 1270, y: 500 }, pin, size, bounds: box })
    expect(right.left + size.w).toBe(box.right)
    expect(right.caret).toBe(size.w - 18)
  })

  it('uses the side of the pin when it fits neither above nor below in a short box', () => {
    const short = { left: 8, top: 100, right: 1272, bottom: 400 }
    const tip = { x: 600, y: 250 }
    const c = placeCard({ tip, pin, size, bounds: short })
    expect(['right', 'left']).toContain(c.side)
    expect(inside(c, short)).toBe(true)
    expect(overlaps(c, tip)).toBe(false)
  })

  it('falls back to the larger box (a phone: the viewport) when the map box is too small', () => {
    const phoneMap = { left: 8, top: 270, right: 312, bottom: 630 }
    const viewport = { left: 8, top: 8, right: 312, bottom: 700 }
    const tip = { x: 160, y: 400 }
    const c = placeCard({ tip, pin, size, bounds: phoneMap, fallback: viewport })
    expect(c.inside).toBe(true)
    expect(inside(c, viewport)).toBe(true)
    expect(overlaps(c, tip)).toBe(false)
  })

  it('never covers the pin, whichever side it picks, across the box', () => {
    for (let x = 40; x <= 1240; x += 100) {
      for (let y = 120; y <= 650; y += 90) {
        const tip = { x, y }
        const c = placeCard({ tip, pin, size, bounds: box })
        expect(overlaps(c, tip)).toBe(false)
        expect(inside(c, box)).toBe(true)
      }
    }
  })

  it('still answers, and says it does not fit, when the box is smaller than the card', () => {
    const tiny = { left: 0, top: 0, right: 200, bottom: 150 }
    const c = placeCard({ tip: { x: 100, y: 120 }, pin, size, bounds: tiny })
    expect(c.inside).toBe(false)
    expect(c.top).toBeGreaterThanOrEqual(tiny.top)
  })
})

// Walkthrough, 30 October 2026: Home lists a few meetups and points to the rest with "See all N meetups".
describe('the meetups Home lists', () => {
  const m = (id) => ({ id })
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(m)

  it('lists at most four, soonest first as given', () => {
    expect(HOME_MEETUPS_SHOWN).toBe(4)
    expect(homeList(six).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(homeList(six.slice(0, 2)).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('does not change with the selected one, so picking a pin moves nothing', () => {
    expect(homeList(six).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('says how many there are in all', () => {
    expect(allMeetupsLabel(9)).toBe('See all 9 meetups')
    expect(allMeetupsLabel(1)).toBe('See all meetups')
  })
})

// Walkthrough, 30 October 2026: chips choose which meetups Home's list and map show. Friday 30 October 2026 in Singapore; this week
// runs Monday 26 October to Sunday 1 November, next week 2 to 8 November.
describe('the week chips on Home', () => {
  const NOW = new Date('2026-10-30T10:00:00+08:00')
  const on = (id, date) => ({ id, date })
  const list = [on('overdue', '2026-10-28'), on('today', '2026-10-30'), on('sun', '2026-11-01'), on('mon', '2026-11-02'), on('nextsun', '2026-11-08'), on('later', '2026-11-09')]
  const ids = (xs) => xs.map((x) => x.id)

  it('are This week, Next week, Later and All', () => {
    expect(MEETUP_RANGES.map((r) => r.label)).toEqual(['This week', 'Next week', 'Later', 'All'])
  })

  it('put each meetup in exactly one of the first three, Monday to Sunday in Singapore, an overdue one in this week', () => {
    expect(ids(meetupsIn(list, 'week', NOW))).toEqual(['overdue', 'today', 'sun'])
    expect(ids(meetupsIn(list, 'next', NOW))).toEqual(['mon', 'nextsun'])
    expect(ids(meetupsIn(list, 'later', NOW))).toEqual(['later'])
    expect(ids(meetupsIn(list, 'all', NOW))).toEqual(ids(list))
    const counts = rangeCounts(list, NOW)
    expect(counts).toEqual({ week: 3, next: 2, later: 1, all: 6 })
    expect(counts.week + counts.next + counts.later).toBe(counts.all)
  })

  it('reads the day in Singapore, whatever the browser\'s zone: late Sunday night there is next week already', () => {
    const sundayNight = new Date('2026-11-01T16:30:00Z') // 00:30 on Monday 2 November in Singapore
    expect(inRange(on('mon', '2026-11-02'), 'week', sundayNight)).toBe(true)
    expect(inRange(on('nextmon', '2026-11-09'), 'next', sundayNight)).toBe(true)
  })

  it('start on This week, or All when nothing is on this week', () => {
    expect(defaultRange(list, NOW)).toBe('week')
    expect(defaultRange([on('mon', '2026-11-02')], NOW)).toBe('all')
    expect(defaultRange([], NOW)).toBe('all')
  })
})

// Walkthrough, 30 October 2026: nearby pins covered each other on Home's small map. They now stand in a row, which does not move when
// another pin is selected (an earlier version kept the selected pin on its spot, and pins swapped places at each pick).
describe('laying out the pins on Home', () => {
  const ROW = { fan: 58, width: 60, height: 76 }
  const at = (moves, points) => Object.fromEntries(points.map((p) => [p.id, { x: p.x + moves.get(p.id).x, y: p.y + moves.get(p.id).y }]))
  const overlaps = (spots) => {
    const list = Object.values(spots)
    // Drawn, a pin is 50px wide and the selected one 60px, so two tips closer than 55px across (and a pin's height down) touch.
    return list.some((a, i) => list.slice(i + 1).some((b) => Math.abs(a.x - b.x) < 55 && Math.abs(a.y - b.y) < ROW.height))
  }

  it('leaves pins that are far apart where they are', () => {
    const points = [{ id: 'a', x: -200, y: 0 }, { id: 'b', x: 200, y: 50 }]
    const moves = layoutPins(points, ROW)
    expect([...moves.values()]).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }])
  })

  it('puts nearby pins in a row in list order, centred on them, none covering another', () => {
    const points = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 8 }, { id: 'c', x: -4, y: 4 }]
    const spots = at(layoutPins(points, ROW), points)
    expect(spots.a.x).toBeCloseTo(2 - 58)
    expect(spots.b.x).toBeCloseTo(2)
    expect(spots.c.x).toBeCloseTo(2 + 58)
    expect(new Set(Object.values(spots).map((p) => p.y)).size).toBe(1)
    expect(overlaps(spots)).toBe(false)
  })

  it('does not depend on which pin is selected: it takes no selection at all', () => {
    const points = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 20, y: 0 }]
    expect([...layoutPins(points, ROW).entries()]).toEqual([...layoutPins([...points], ROW).entries()])
  })

  it('joins a row to another group it would run into, until nothing overlaps', () => {
    const points = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 5, y: 5 }, { id: 'c', x: 70, y: 10 }, { id: 'd', x: 300, y: 0 }]
    const spots = at(layoutPins(points, ROW), points)
    expect(overlaps(spots)).toBe(false)
    expect(spots.d).toEqual({ x: 300, y: 0 })
  })

  it('slides a row back inside the box when it would run past an edge', () => {
    const points = [{ id: 'a', x: 140, y: 0 }, { id: 'b', x: 145, y: 0 }, { id: 'c', x: 150, y: 0 }]
    const spots = at(layoutPins(points, { ...ROW, maxX: 150 }), points)
    expect(Math.max(...Object.values(spots).map((p) => p.x))).toBeLessThanOrEqual(150)
    expect(overlaps(spots)).toBe(false)
  })
})
