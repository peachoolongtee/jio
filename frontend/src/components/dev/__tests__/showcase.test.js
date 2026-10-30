// The showcase (components/dev/showcase.js): ten sessions, one for each state a screen can show (the meeting spots' vote
// included), made through the public functions of lib/api.js. Run twice on purpose: once with the planner backend not there (the stand-in answers) and once
// against the real Express app started in this process, with its outside calls stubbed. Set SHOWCASE_TABLE=1 to print
// what Home shows for each session.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { addDays, format, parseISO } from 'date-fns'
import { singaporeDate } from '@/lib/session.js'
import { createApp } from '../../../../../backend/src/app.js'
import { createHttp } from '../../../../../backend/src/services/http.js'
import { STORAGE_KEY, loadApi } from '../../../lib/__tests__/planFixture.js'
import { activeMeetups, dayLabel, nextStepFor, whereStands } from '../../../lib/homeMeetups.js'
import { distanceKm } from '../../../lib/planner/index.js'
import { waitingFor } from '../../../stores/events.js'
import { DEMO_ACCOUNT } from '../demoAccount.js'

const NOW = new Date('2026-10-10T14:20:00+08:00')
const stubPhotos = async (kinds, count) => Array.from({ length: count }, (_, i) => `data:image/jpeg;base64,AAAA${i}`)

beforeAll(() => {
  // The data layer reads the real clock for "today", so it is moved to the same moment as `now`. Only Date is faked.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterAll(() => vi.useRealTimers())
afterAll(() => vi.unstubAllGlobals())

// A fresh data layer on a fake storage, signed in as the demo account, and the showcase module on top of it.
// How to call: const { api, loadShowcase, storage } = await start('http://127.0.0.1:1')
async function start(baseURL) {
  const api = await loadApi()
  await api.signUp(DEMO_ACCOUNT)
  api.api.defaults.baseURL = baseURL
  const { loadShowcase } = await import('../showcase.js')
  return { api, loadShowcase, storage: api.storage }
}

// The ten sessions as Home reads them, by short name.
async function sessionsOf(api) {
  const all = await api.listSessions()
  const by = (title) => all.find((s) => s.title === title)
  return {
    all,
    fresh: by('Weekend brunch'),
    invited: by('Birthday dinner for Nicole'),
    waiting: by('Hawker lunch near the office'),
    known: by('Saturday movie and makan'),
    revoted: by('Sunday kopi and a long walk'),
    today: by('Chinatown makan crawl'),
    ahead: by('Dessert run after the gym'),
    completed: by('Orchard Road wander and dinner'),
    // The spot vote the user hosts, which also has the longest title the app allows.
    long: all.find((s) => s.title.length === 60),
    // The spot vote a friend hosts.
    guest: by("Darius's board game night"),
  }
}

const stateOf = (session, id) => session.members.find((m) => m.id === id)?.state
const voters = (session) => [...new Set(Object.values(session.votes).flatMap((byPerson) => Object.keys(byPerson)))].sort()

// What every run of the showcase must have made, whichever planner answered.
// How to call: await expectEveryState(api)
async function expectEveryState(api) {
  const s = await sessionsOf(api)
  expect(s.all.map((x) => x.id).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))).toEqual(Array.from({ length: 10 }, (_, i) => `s${i + 1}`))
  for (const session of s.all) {
    expect(session.title.length, session.title).toBeLessThanOrEqual(60)
    expect(session.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(session.hostId).toBeTruthy()
  }
  // The date `days` from now in Singapore, where a session's day is counted.
  const dateAt = (days) => format(addDays(parseISO(singaporeDate(NOW)), days), 'yyyy-MM-dd')

  // 1. just created: nobody invited
  expect(s.fresh).toMatchObject({ status: 'inviting', hostId: 'ian', activeIds: ['ian'], date: dateAt(14) })
  expect(s.fresh.members).toHaveLength(1)

  // 2. invites sent: some accepted, some still pending
  expect(s.invited.status).toBe('inviting')
  expect(['darius', 'nicole'].map((id) => stateOf(s.invited, id))).toEqual(['joined', 'joined'])
  expect(['faith', 'darryl'].map((id) => stateOf(s.invited, id))).toEqual(['invited', 'invited'])

  // 3. waiting on locations: Ian has shared and three friends have not, so there are no spots to vote on yet (they open at two starts)
  expect(s.waiting.status).toBe('locating')
  expect(s.waiting.locations.ian.start.areaId).toBe('bishan')
  expect(waitingFor(s.waiting)).toEqual(['darius', 'nicole', 'faith'])
  expect(s.waiting.area).toBeNull()
  expect(s.waiting.spots.list).toEqual([])

  // 4. voting, Ian has not voted; the host named the place before anyone shared a start ("We already have a place")
  expect(s.known.status).toBe('voting')
  expect(s.known.meeting.method).toBe('chosen')
  expect(s.known.area.id).toBe('bugis')
  expect(s.known.spots.list.map((spot) => spot.areaId)).toEqual(['bugis'])
  expect(Object.keys(s.known.locations)).toEqual([])
  expect(voters(s.known)).toEqual(['darius', 'nicole'])
  expect(Object.keys(s.known.prefs).sort()).toEqual(['darius', 'ian', 'nicole'])

  // 5. voting, Ian has voted and others have not; Jonathan opted out; the banner says the votes were cleared
  expect(s.revoted.status).toBe('voting')
  expect(stateOf(s.revoted, 'jonathan')).toBe('opted_out')
  expect(s.revoted.banner).toMatchObject({ votesCleared: true })
  expect(s.revoted.banner.text).toMatch(/Faith's start location changed\. Votes for places were cleared\.$/)
  expect(voters(s.revoted)).toEqual(['ian'])
  // The host took the app's first spot with nobody's approval, so the area was found, not chosen, and could move with a start.
  expect(s.revoted.meeting.method).toBe('fairest')

  // 6. confirmed for today, with an itinerary; the host took the app's first spot
  expect(s.today).toMatchObject({ status: 'confirmed', date: dateAt(0), isToday: true })
  expect(s.today.meeting.method).toBe('fairest')
  expect((await api.getItinerary(s.today.id)).stops.length).toBeGreaterThanOrEqual(2)

  // 7. confirmed a few days ahead, in an area next to the one session 6 meets in
  expect(s.ahead).toMatchObject({ status: 'confirmed', date: dateAt(3) })
  expect(distanceKm(s.today.area, s.ahead.area)).toBeLessThan(2.5)
  // ...which the group voted for: both said the app's first spot works, and the host confirmed it
  expect(s.ahead.meeting.method).toBe('voted')
  expect(s.ahead.spots.approvals).toEqual({ ian: [s.ahead.area.id], nicole: [s.ahead.area.id] })
  expect((await api.getItinerary(s.ahead.id)).stops.length).toBeGreaterThanOrEqual(1)

  // 8. completed last week, with photos
  expect(s.completed).toMatchObject({ status: 'completed', date: dateAt(-7), photoCount: 8 })
  expect((await api.getPhotos(s.completed.id)).map((p) => p.name).slice(0, 4)).toEqual(['Ian', 'Darius', 'Nicole', 'Faith'])

  // 9. the spot vote Ian hosts, under the longest title the app allows (60 characters): the app's three spots and Nicole's, where
  // she starts ("we are here already"); the second app spot leads with three approvals; Ian has marked nothing, the host confirms
  expect(s.long.title).toHaveLength(60)
  expect(s.long.status).toBe('locating')
  expect(s.long.hostId).toBe('ian')
  const hosted = s.long.spots
  expect(hosted.list.map((spot) => spot.by)).toEqual(['app', 'app', 'app', 'nicole'])
  expect(hosted.list[3]).toMatchObject({ areaId: 'serangoon', here: true, byName: 'Nicole' })
  expect(hosted.list.map((spot) => spot.approvalCount)).toEqual([1, 3, 0, 1])
  expect(hosted.preselectedAreaId).toBe(hosted.list[1].areaId)
  expect(hosted.approvals.ian).toBeUndefined()
  for (const spot of hosted.list) expect(Object.keys(spot.times).sort(), spot.areaId).toEqual(['darius', 'faith', 'ian', 'nicole'])
  expect(s.long.area).toBeTruthy()

  // 10. the spot vote a friend hosts: Ian has shared where he starts and marked nothing; the first spot leads
  expect(s.guest.hostId).toBe('darius')
  expect(s.guest.status).toBe('locating')
  expect(s.guest.members.map((m) => [m.id, m.role])).toEqual([['darius', 'host'], ['ian', 'guest'], ['faith', 'guest'], ['nicole', 'guest']])
  expect(s.guest.locations.ian.start.areaId).toBe('bishan')
  const guest = s.guest.spots
  expect(guest.list.map((spot) => spot.by)).toEqual(['app', 'app', 'app', 'nicole'])
  expect(guest.list[3]).toMatchObject({ here: false, byName: 'Nicole' })
  expect(guest.list.map((spot) => spot.approvalCount)).toEqual([3, 0, 1, 0])
  expect(guest.preselectedAreaId).toBe(guest.list[0].areaId)
  expect(guest.approvals.ian).toBeUndefined()

  // Rewards: one voucher redeemed. The season before this one is still there.
  expect(await api.listRedemptions()).toHaveLength(1)
  expect((await api.getSeason()).past.length).toBeGreaterThanOrEqual(1)
  return s
}

// What Home shows for the showcase: nine meetups going, the completed one not among them. Home's chip for a session in the
// spot vote is the host's "Confirm the spot", or a guest's "Pick your spots" until they mark one.
// How to call: expectHome(s)
function expectHome(s) {
  const going = activeMeetups(s.all, NOW)
  expect(going.map((m) => m.title)).toEqual([
    s.today, s.known, s.ahead, s.revoted, s.waiting, s.long, s.guest, s.invited, s.fresh,
  ].map((m) => m.title))
  const step = (session) => nextStepFor(session, 'ian')
  expect(step(s.fresh)).toMatchObject({ label: 'Invite friends', tone: 'action' })
  expect(step(s.invited)).toMatchObject({ label: 'Start session', tone: 'action' })
  expect(step(s.waiting)).toMatchObject({ label: 'Waiting for others', tone: 'wait' })
  expect(step(s.known)).toMatchObject({ label: 'Vote', tone: 'action' })
  expect(step(s.revoted)).toMatchObject({ label: 'Waiting for others', tone: 'wait' })
  expect(step(s.today)).toMatchObject({ label: "Today's plan", tone: 'done' })
  expect(step(s.ahead)).toMatchObject({ label: 'See the plan', tone: 'done' })
  expect(step(s.long)).toMatchObject({ label: 'Confirm the spot', tone: 'action' })
  expect(step(s.guest)).toMatchObject({ label: 'Pick your spots', tone: 'action' })
  expect(whereStands(s.waiting, 'ian').text).toBe('No meeting point yet · 1 of 4 locations shared')
  // The row names the spot that leads, with the minutes it takes Ian.
  const lead = s.long.spots.list[1]
  expect(whereStands(s.long, 'ian')).toMatchObject({ kind: 'spots', areaName: lead.area.name, minutes: lead.times.ian })
  expect(whereStands(s.guest, 'ian')).toMatchObject({ kind: 'spots', areaName: s.guest.spots.list[0].area.name })
  expect(whereStands(s.known, 'ian').text).toBe('Bugis')
  expect(dayLabel(s.today, NOW)).toBe('Today')
  // A pin for each meetup that has a meeting area: the place that was named, the two confirmed, the re-voted one, and the two
  // in the spot vote (the planner's own pick is the area until the host confirms one).
  expect(going.filter((m) => m.area).map((m) => m.title).sort()).toEqual([s.known, s.revoted, s.today, s.ahead, s.long, s.guest].map((m) => m.title).sort())
  if (process.env.SHOWCASE_TABLE) {
    console.table([...s.all].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map((m) => ({ id: m.id, title: m.title, status: m.status, area: m.area?.name || '', method: m.meeting?.method || '', home: ['completed', 'cancelled'].includes(m.status) ? '(not on Home)' : nextStepFor(m, 'ian').label })))
  }
}

describe('the showcase with the planner backend not running', () => {
  let ctx
  let result
  beforeAll(async () => {
    ctx = await start('http://127.0.0.1:1')
    result = await ctx.loadShowcase({ now: NOW, makePhotos: stubPhotos })
  }, 120_000)

  it('answers from the stand-in and says so', () => {
    expect(result.planner).toBe('stand-in')
    expect(result.sessions).toHaveLength(10)
    expect(result.photos).toBe(8)
    expect(result.redeemed).toBe(true)
  })

  it('makes every state', async () => {
    await expectEveryState(ctx.api)
  })

  it('shows on Home what it should', async () => {
    expectHome(await sessionsOf(ctx.api))
  })

  it('has Ian owed for his travel in the finished outing, so the two spot votes show "Jio remembers" to him and no other session does', async () => {
    const s = await sessionsOf(ctx.api)
    const owed = Object.fromEntries(await Promise.all(s.all.map(async (x) => [x.id, (await ctx.api.travelLean(x.id)).owed])))
    expect(Object.keys(owed).filter((id) => owed[id]).sort()).toEqual([s.long.id, s.guest.id].sort())
    // The finished outing is why: Ian's trip there was above the group's average.
    const times = s.completed.meeting.times
    expect(times.ian).toBeGreaterThan(Object.values(times).reduce((sum, m) => sum + m, 0) / Object.values(times).length)
  })

  it('is stored as the data layer wants it: reloading keeps all ten', async () => {
    const reloaded = await loadApi({ data: { [STORAGE_KEY]: ctx.storage.store[STORAGE_KEY] } })
    expect((await reloaded.listSessions()).map((s) => s.id).sort()).toHaveLength(10)
  })

  it('keeps the invites that were left pending, as an edit to the title still works on an open session', async () => {
    const s = await sessionsOf(ctx.api)
    await expect(ctx.api.updateSession(s.fresh.id, { title: s.fresh.title, date: s.fresh.date, start: s.fresh.start, end: s.fresh.end })).resolves.toBeTruthy()
    await expect(ctx.api.updateSession(s.invited.id, { title: s.invited.title, date: s.invited.date, start: s.invited.start, end: s.invited.end })).resolves.toBeTruthy()
  })

  it('gives the same ten when run again, not twenty', async () => {
    const again = await ctx.loadShowcase({ now: NOW, makePhotos: stubPhotos })
    expect(again.sessions.map((s) => s.id)).toEqual(result.sessions.map((s) => s.id))
    expect(await ctx.api.listSessions()).toHaveLength(10)
    expect(await ctx.api.listRedemptions()).toHaveLength(1)
    await expectEveryState(ctx.api)
  }, 120_000)

  it('leaves the planner client as it found it', () => {
    expect(ctx.api.api.defaults.adapter).toEqual(['xhr', 'http', 'fetch'])
  })
})

describe('the showcase with the planner backend running', () => {
  let server
  beforeAll(async () => {
    server = createApp({ frontendOrigin: 'http://localhost:5173', allowSimulatedWeather: true, http: createHttp({ stub: true }) }).listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
  })
  afterAll(() => server?.close())

  it('uses the backend, and makes every state', async () => {
    const { api, loadShowcase } = await start(`http://127.0.0.1:${server.address().port}`)
    const result = await loadShowcase({ now: NOW, makePhotos: stubPhotos })
    expect(result.planner).toBe('backend')
    expect(result.sessions.map((s) => s.status)).toEqual(['inviting', 'inviting', 'locating', 'voting', 'voting', 'confirmed', 'confirmed', 'completed', 'locating', 'locating'])
    const s = await expectEveryState(api)
    expectHome(s)
    // The demo's next step works against the backend: the host confirms the spot that leads, which the group voted for.
    const confirmed = await api.confirmSpot(s.long.id, s.long.spots.preselectedAreaId)
    expect(confirmed).toMatchObject({ status: 'voting' })
    expect(confirmed.meeting).toMatchObject({ areaId: s.long.spots.list[1].areaId, method: 'voted' })
    expect(nextStepFor(confirmed, 'ian').label).toBe('Vote')
    // ...and a friend's suggestion in the other spot vote is priced for everyone, with a spot added to the list.
    await api.suggestSpot(s.guest.id, 'faith', 'orchard')
    const guest = (await api.getSession(s.guest.id)).spots.list.find((spot) => spot.areaId === 'orchard')
    expect(guest).toMatchObject({ by: 'faith', here: false })
    expect(Object.keys(guest.times).sort()).toEqual(['darius', 'faith', 'ian', 'nicole'])
  }, 120_000)
})

// OneMap is the shared, slow part of the planner. Sample data must never spend it: the showcase and the tour build their sessions
// with `travel: 'estimate'`, which the backend answers without routing. The backend here has a OneMap that counts its calls.
describe('sample data never asks OneMap for a route', () => {
  let server
  let routeMinutes
  beforeAll(async () => {
    routeMinutes = vi.fn(async () => 20)
    const onemap = { routingEnabled: true, routeMinutes, reportFallback: () => {} }
    server = createApp({ frontendOrigin: 'http://localhost:5173', allowSimulatedWeather: true, http: createHttp({ stub: true }), onemap }).listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
  })
  afterAll(() => server?.close())

  it('the showcase makes all ten sessions with no OneMap call, and a person\'s own request afterwards is routed', async () => {
    const { api, loadShowcase } = await start(`http://127.0.0.1:${server.address().port}`)
    const requests = []
    api.api.interceptors.request.use((config) => (requests.push(config), config))
    const result = await loadShowcase({ now: NOW, makePhotos: stubPhotos })
    expect(result.planner).toBe('backend')
    expect(result.sessions).toHaveLength(10)
    // The planner was asked a good many times, and every ranking request said it needs no routing.
    const ranking = requests.filter((c) => ['/api/meeting-area', '/api/converge', '/api/roam'].includes(c.url))
    expect(ranking.length).toBeGreaterThan(10)
    for (const config of ranking) expect(JSON.parse(config.data).travel, config.url).toBe('estimate')
    expect(routeMinutes).not.toHaveBeenCalled()

    // The same backend still routes for a person: the first ranking after the showcase carries no such field.
    requests.length = 0
    const { meetingArea } = await import('../../../lib/plannerApi.js')
    const members = [{ id: 'a', start: { lat: 1.3541, lng: 103.9446 } }, { id: 'b', start: { lat: 1.315, lng: 103.765 } }]
    const answer = await meetingArea({ members, routing: true })
    expect(JSON.parse(requests.at(-1).data)).not.toHaveProperty('travel')
    expect(answer.travel.source).toBe('onemap')
    expect(routeMinutes).toHaveBeenCalled()
  }, 120_000)

  it('the demo tour makes its sessions with no OneMap call either', async () => {
    routeMinutes.mockClear()
    const { api } = await start(`http://127.0.0.1:${server.address().port}`)
    const { loadTour } = await import('../../../tour/load.js')
    const manifest = await loadTour({ now: NOW, makePhotos: stubPhotos })
    expect(manifest.story.length).toBeGreaterThan(0)
    expect((await api.listSessions()).length).toBeGreaterThan(10)
    expect(routeMinutes).not.toHaveBeenCalled()
  }, 120_000)
})

describe('the showcase over a save from before the meeting spots', () => {
  it('keeps the account and friends, and replaces the sessions', async () => {
    // A version 8 save: the account is there, and the session has no spots.
    const first = await start('http://127.0.0.1:1')
    const saved = JSON.parse(first.storage.store[STORAGE_KEY])
    saved.version = 8
    saved.sessions = [{ id: 's1', title: 'Old session', members: [], status: 'locating' }]
    const api = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(saved) } })
    api.api.defaults.baseURL = 'http://127.0.0.1:1'
    expect(await api.listSessions()).toEqual([])
    expect(await api.getUser()).toMatchObject({ id: 'ian', demo: true })
    const { loadShowcase } = await import('../showcase.js')
    const result = await loadShowcase({ now: NOW, makePhotos: stubPhotos })
    expect(result.sessions).toHaveLength(10)
    expect(result.planner).toBe('stand-in')
    expect(await api.getUser()).toMatchObject({ id: 'ian', demo: true })
    // Friends can still be invited by id, and the user's friends are kept.
    expect(JSON.parse(api.storage.store[STORAGE_KEY]).friends).toEqual(saved.friends)
    expect((await sessionsOf(api)).all.some((x) => x.title === 'Old session')).toBe(false)
  }, 120_000)
})

describe('when the showcase stops part way', () => {
  it('says which sessions were loaded and which were not', async () => {
    const { api, loadShowcase } = await start('http://127.0.0.1:1')
    // The photos fail for the completed session only.
    const failing = async () => {
      throw new Error('Could not load the park photo.')
    }
    const error = await loadShowcase({ now: NOW, makePhotos: failing }).catch((e) => e)
    expect(error.name).toBe('ShowcaseError')
    expect(error.loaded).toHaveLength(9)
    expect(error.failed).toEqual([expect.objectContaining({ title: 'Orchard Road wander and dinner', step: 'photos' })])
    expect(error.message).toMatch(/^Loaded 9 of 10 sessions\. Not finished: "Orchard Road wander and dinner" stopped at photos \(Could not load the park photo\.\)/)
    expect(await api.listSessions()).toHaveLength(10)
  }, 120_000)

  it('refuses to start without an account, and changes nothing', async () => {
    const api = await loadApi()
    api.api.defaults.baseURL = 'http://127.0.0.1:1'
    const { loadShowcase } = await import('../showcase.js')
    await expect(loadShowcase({ now: NOW })).rejects.toThrow(/Sign in first/)
  })
})
