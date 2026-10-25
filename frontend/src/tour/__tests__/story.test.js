// The demo tour's data (tour/story.js, tour/load.js, tour/store.js): one outing saved at eight checkpoints, the side cases,
// what Home lists for each checkpoint, where each checkpoint opens, and the stand-in planner. Everything is built through the
// public functions of lib/api.js with the planner backend not there (a closed port), at a fixed moment.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { addDays, format, parseISO } from 'date-fns'
import { singaporeDate } from '@/lib/session.js'
import { createMemoryHistory, createRouter } from 'vue-router'
import { loadApi } from '../../lib/__tests__/planFixture.js'
import { activeMeetups } from '../../lib/homeMeetups.js'
import { guardFor } from '../../router/guard.js'
import { routes } from '../../router/routes.js'
import { waitingFor } from '../../stores/events.js'
import { DEMO_ACCOUNT } from '../../components/dev/demoAccount.js'

vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 })

const NOW = new Date('2026-10-10T14:20:00+08:00')
const stubPhotos = async (kinds, count) => Array.from({ length: count }, (_, i) => `data:image/jpeg;base64,AAAA${i}`)
const DEAD_BACKEND = 'http://127.0.0.1:1'
const FOUR = ['ian', 'darius', 'nicole', 'faith']
// The date `days` from now in Singapore, where a session's day is counted.
const dateAt = (days) => format(addDays(parseISO(singaporeDate(NOW)), days), 'yyyy-MM-dd')

beforeAll(() => {
  // The data layer reads the real clock for "today", so it is moved to the same moment as `now`. Only Date is faked.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// A fresh data layer on a fake storage, signed in as the demo account with the planner backend not there, and the tour store
// on top of it, attached the way main.js does.
// How to call: const t = await boot()
async function boot() {
  const api = await loadApi()
  await api.signUp(DEMO_ACCOUNT)
  api.api.defaults.baseURL = DEAD_BACKEND
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const { useTourStore } = await import('../store.js')
  const tour = useTourStore()
  await tour.attach()
  await tour.settled()
  const { visibleSessions } = await import('../../lib/sessionFilter.js')
  return { api, tour, visibleSessions, storage: api.storage }
}

let first
beforeAll(async () => {
  first = await boot()
  first.result = await first.tour.start({ now: NOW, makePhotos: stubPhotos })
  first.all = await first.api.listSessions()
  first.byId = Object.fromEntries(first.all.map((s) => [s.id, s]))
  first.story = first.tour.manifest.story.map((id) => first.byId[id])
})

const stateOf = (session, id) => session.members.find((m) => m.id === id)?.state
const voters = (session) => [...new Set(Object.values(session.votes).flatMap((byPerson) => Object.keys(byPerson)))].sort()

describe('the story: one outing saved at ten checkpoints', () => {
  it('makes ten sessions with one title and the same people, then the side cases', () => {
    const { story, all } = first
    expect(story).toHaveLength(10)
    expect(new Set(story.map((s) => s.title)).size).toBe(1)
    expect(story[0].title).toBe('Catch-up makan with the gang')
    expect(story.every((s) => s.hostId === 'ian')).toBe(true)
    // Nobody outside the four is in any save; from the third checkpoint the four are all in.
    for (const s of story) expect(s.members.every((m) => FOUR.includes(m.id))).toBe(true)
    for (const s of story.slice(2)) expect(s.activeIds.sort()).toEqual([...FOUR].sort())
    expect(all).toHaveLength(10 + 3)
    expect(first.tour.manifest.side).toHaveLength(3)
    expect(first.tour.manifest.story).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'])
  })

  it('counts the days from now: some days ahead for eight saves, then the day itself', () => {
    const { story } = first
    expect(story.slice(0, 8).map((s) => s.date)).toEqual(Array(8).fill(dateAt(3)))
    expect(story.slice(8).map((s) => s.date)).toEqual([dateAt(0), dateAt(0)])
    expect(new Set(story.map((s) => `${s.start}-${s.end}`)).size).toBe(1)
  })

  it('1. just created: nobody invited', () => {
    expect(first.story[0]).toMatchObject({ status: 'inviting', activeIds: ['ian'] })
    expect(first.story[0].members).toHaveLength(1)
  })

  it('2. invites out: two said yes, one has not answered', () => {
    const s = first.story[1]
    expect(s.status).toBe('inviting')
    expect([stateOf(s, 'darius'), stateOf(s, 'nicole'), stateOf(s, 'faith')]).toEqual(['joined', 'joined', 'invited'])
  })

  it('5. sharing locations: Ian has shared, three have not', () => {
    const s = first.story[4]
    expect(s.status).toBe('locating')
    expect(s.meetBy).toBe('fairest')
    expect(Object.keys(s.locations)).toEqual(['ian'])
    expect(waitingFor(s).sort()).toEqual(['darius', 'faith', 'nicole'])
    expect(s.area).toBeNull()
  })

  it('6. choosing the spot: everyone shared, spots listed, a friend added one, friends say which work, the host has not confirmed', () => {
    const s = first.story[5]
    expect(s.status).toBe('locating')
    expect(Object.keys(s.locations).sort()).toEqual([...FOUR].sort())
    expect(s.spots.list.length).toBeGreaterThanOrEqual(4)
    expect(s.spots.list.filter((x) => x.by === 'nicole')).toHaveLength(1)
    expect(Object.keys(s.spots.approvals).sort()).toEqual(['darius', 'faith', 'nicole'])
    expect(s.spots.preselectedAreaId).toBeTruthy()
    const lead = s.spots.list.find((x) => x.areaId === s.spots.preselectedAreaId)
    expect(lead.approvalCount).toBeGreaterThanOrEqual(2)
  })

  it('7. voting on places: the spot is set, three have voted, Ian has not', () => {
    const s = first.story[6]
    expect(s.status).toBe('voting')
    expect(s.meeting.areaId).toBe(first.story[5].spots.preselectedAreaId)
    expect(s.meeting.method).toBe('voted')
    expect(voters(s)).toEqual(['darius', 'faith', 'nicole'])
    expect(Object.values(s.options).some((list) => list.length > 0)).toBe(true)
  })

  it('8. plan confirmed: everyone voted, a plan with stops, not yet the day', () => {
    const s = first.story[7]
    expect(s.status).toBe('confirmed')
    expect(voters(s)).toEqual([...FOUR].sort())
    expect(s.plan.stops.length).toBeGreaterThanOrEqual(2)
    expect(s.isToday).toBe(false)
  })

  it('9. on the day: the same plan, dated today', () => {
    const s = first.story[8]
    expect(s.status).toBe('confirmed')
    expect(s.isToday).toBe(true)
    expect(s.plan.stops.map((x) => x.venueId)).toEqual(first.story[7].plan.stops.map((x) => x.venueId))
  })

  it('10. finished with photos: completed, an album, JioCoins paid', async () => {
    const s = first.story[9]
    expect(s.status).toBe('completed')
    expect(s.photoCount).toBe(8)
    expect(s.plan.stops.map((x) => x.venueId)).toEqual(first.story[7].plan.stops.map((x) => x.venueId))
    const photos = await first.api.getPhotos(s.id)
    expect(new Set(photos.map((p) => p.personId)).size).toBeGreaterThan(1)
  })

  it('has the planner stand-in answer when the backend is not there, and notes that the saves are rough', () => {
    expect(first.tour.manifest.rough).toBe(true)
    expect(first.tour.rough).toBe(true)
  })
})

describe('the side cases', () => {
  const side = () => first.tour.manifest.side.map((id) => first.byId[id])

  it('has one the user does not host, one with an opted-out friend, and one with the longest title', () => {
    const [guest, optedOut, long] = side()
    expect(guest.hostId).toBe('darius')
    expect(stateOf(guest, ian())).toBe('joined')
    expect(stateOf(optedOut, 'jonathan')).toBe('opted_out')
    expect(optedOut.activeIds.sort()).toEqual(['darius', 'ian', 'nicole'])
    expect(optedOut.spots.list.length).toBeGreaterThan(0)
    expect(long.title).toHaveLength(60)
    expect(long.hostId).toBe('ian')
  })

  it('redeems a reward, so Rewards has a history', async () => {
    expect(first.result.redeemed).toBe(true)
    expect(await first.api.listRedemptions()).toHaveLength(1)
  })

  const ian = () => 'ian'
})

describe('loading twice', () => {
  it('gives the same set, not twice as many', async () => {
    const summary = (list) => list.map((s) => [s.id, s.title, s.status, s.date, s.members.map((m) => `${m.id}:${m.state}`).join(',')])
    const before = summary(first.all)
    await first.tour.start({ now: NOW, makePhotos: stubPhotos })
    const after = await first.api.listSessions()
    expect(after).toHaveLength(13)
    expect(summary(after).sort()).toEqual(before.sort())
    expect(first.tour.manifest.story).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'])
    expect(await first.api.listRedemptions()).toHaveLength(1)
  })
})

describe('what Home lists', () => {
  it('shows one story meetup plus the side cases, whichever checkpoint is selected', async () => {
    const { tour, visibleSessions, api } = first
    const sessions = await api.listSessions()
    const sideIds = tour.manifest.side
    for (let i = 0; i < 10; i++) {
      tour.select(i)
      const shown = visibleSessions(sessions)
      const fromStory = shown.filter((s) => tour.manifest.story.includes(s.id))
      expect(fromStory.map((s) => s.id), `checkpoint ${i + 1}`).toEqual([tour.manifest.story[i]])
      expect(sideIds.every((id) => shown.some((s) => s.id === id))).toBe(true)
      expect(shown).toHaveLength(1 + sideIds.length)
      // Home lists the meetups still going; a finished outing is in the list of past ones instead.
      const going = activeMeetups(shown, NOW).filter((m) => tour.manifest.story.includes(m.id))
      expect(going).toHaveLength(i === 9 ? 0 : 1)
    }
  })

  it('selects the story outing first on Home while it is going, because it is the soonest', async () => {
    const { tour, visibleSessions, api } = first
    const sessions = await api.listSessions()
    for (let i = 0; i < 9; i++) {
      tour.select(i)
      expect(activeMeetups(visibleSessions(sessions), NOW)[0].id, `checkpoint ${i + 1}`).toBe(tour.manifest.story[i])
    }
  })

  it('shows every session when the tour was never loaded, and keeps showing one save after leaving', async () => {
    const { tour, visibleSessions, api } = first
    const sessions = await api.listSessions()
    tour.select(3)
    tour.leave()
    expect(visibleSessions(sessions)).toHaveLength(4)
    tour.resume()
    tour.forget()
    expect(visibleSessions(sessions)).toHaveLength(13)
  })
})

describe('where each checkpoint opens', () => {
  it('is a page that exists, which the demo account is let into', async () => {
    const t = await boot()
    await t.tour.start({ now: NOW, makePhotos: stubPhotos })
    const stub = { render: () => null }
    const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
    const auth = { signedIn: true, realAccounts: false }
    const { CHECKPOINTS } = await import('../story.js')
    const opened = []
    for (let i = 0; i < CHECKPOINTS.length; i++) {
      const path = t.tour.pathFor(i)
      const to = router.resolve(path)
      expect(to.name, path).not.toBe('not-found')
      expect(to.params.id).toBe(t.tour.manifest.story[i])
      expect(guardFor(to, auth), path).toBe(true)
      opened.push(path)
    }
    expect(opened).toEqual(['/sessions/s1', '/sessions/s2/invite', '/sessions/s3/start', '/sessions/s4/plan', '/sessions/s5', '/sessions/s6', '/sessions/s7/plan', '/sessions/s8/itinerary', '/sessions/s9/itinerary', '/sessions/s10/photos'])
    // Every page is the one that shows that state: the session's own pages for its status.
    const { sessionPath } = await import('../../lib/session.js')
    const all = await t.api.listSessions()
    for (const [i, id] of t.tour.manifest.story.entries()) {
      const s = all.find((x) => x.id === id)
      if (['voting', 'confirmed'].includes(s.status)) expect(t.tour.pathFor(i).startsWith(sessionPath(s)), s.status).toBe(true)
    }
  })

  it('has /demo as a route in a build that has the tour', () => {
    expect(routes.find((r) => r.path === '/demo')).toMatchObject({ meta: { public: true } })
  })
})

describe('the stand-in planner', () => {
  let own
  beforeAll(async () => {
    own = await boot()
    await own.tour.start({ now: NOW, makePhotos: stubPhotos })
  })
  const MEMBERS = [{ id: 'ian', name: 'Ian', start: { lat: 1.3329, lng: 103.8472 }, end: { lat: 1.3329, lng: 103.8472 } }, { id: 'darius', name: 'Darius', start: { lat: 1.3526, lng: 103.9452 }, end: { lat: 1.3526, lng: 103.9452 } }]
  const CENTRE = { lat: 1.3, lng: 103.86 }

  // The five requests the screens make, as plannerApi.js sends them.
  const requests = (api) => ({
    '/api/meeting-area': () => api.api.post('/api/meeting-area', { members: MEMBERS, method: 'station', alternatives: 2 }),
    '/api/converge': () => api.api.post('/api/converge', { members: MEMBERS, centre: CENTRE, dateTime: '2026-10-13T12:00', durationMinutes: 90, categories: ['eat'], currentOptionIds: [] }),
    '/api/search': () => api.api.post('/api/search', { query: 'market', centre: CENTRE, dateTime: '2026-10-13T12:00', durationMinutes: 90, categories: ['eat'], members: MEMBERS }),
    '/api/itinerary/arrange': () => api.api.post('/api/itinerary/arrange', { stops: [{ id: 'eat', duration: 90, start: 720 }, { id: 'shop', duration: 60, start: 840 }], startAt: 720, endAt: 1080, includeCurrent: true }),
    '/api/places/search': () => api.api.get('/api/places/search', { params: { q: 'tampines' } }),
  })

  it('answers every planner request the screens make while the tour is on', async () => {
    const answers = {}
    for (const [url, send] of Object.entries(requests(own.api))) answers[url] = (await send()).data
    expect(answers['/api/meeting-area'].area.id).toBeTruthy()
    expect(answers['/api/meeting-area'].candidates.length).toBeGreaterThan(1)
    expect(answers['/api/converge'].results.length).toBeGreaterThan(0)
    expect(answers['/api/search'].results.length).toBeGreaterThan(0)
    expect(answers['/api/itinerary/arrange']).toMatchObject({ status: 'ok', order: ['eat', 'shop'], source: 'rules' })
    expect(answers['/api/places/search'].results.map((r) => r.name)).toContain('TAMPINES MALL')
  })

  it('answers the same thing every time', async () => {
    const send = requests(own.api)['/api/search']
    expect((await send()).data).toEqual((await send()).data)
  })

  it('is off when the tour is left, and when the data it was made of is gone', async () => {
    const t = own
    t.tour.resume()
    await expect(requests(t.api)['/api/search']()).resolves.toBeTruthy()
    t.tour.leave()
    await expect(requests(t.api)['/api/search']()).rejects.toThrow()
    t.tour.resume()
    await expect(requests(t.api)['/api/search']()).resolves.toBeTruthy()
    await t.api.signOut()
    expect(t.tour.manifest).toBeNull()
    await expect(requests(t.api)['/api/search']()).rejects.toThrow()
  })

  it('is never installed for a real account, or without a tour', async () => {
    const t = await boot()
    // No tour was started: a planner request fails as it would.
    await expect(requests(t.api)['/api/search']()).rejects.toThrow()
    await t.tour.start({ now: NOW, makePhotos: stubPhotos })
    await expect(requests(t.api)['/api/search']()).resolves.toBeTruthy()
    // Someone else signs up in this browser: the tour is dropped on the spot, and so is the stand-in.
    await t.api.signUp({ email: 'sam@example.com', name: 'Sam', username: 'sam', dob: '2001-05-06', homeAreaId: 'tampines', friends: [] })
    await t.tour.settled()
    await vi.waitFor(() => expect(t.tour.manifest).toBeNull())
    await expect(requests(t.api)['/api/search']()).rejects.toThrow()
    expect(t.visibleSessions([{ id: 's1' }, { id: 's2' }])).toHaveLength(2)
  })

  it('forgets a saved tour whose sessions are not the tour\'s any more', async () => {
    const t = await boot()
    await t.tour.start({ now: NOW, makePhotos: stubPhotos })
    const saved = t.storage.store['jio-tour-v1']
    expect(saved).toBeTruthy()
    // The development showcase (or anything else) wipes the data and makes other sessions with the same ids.
    await t.api.resetDemo()
    await vi.waitFor(() => expect(t.tour.manifest).toBeNull())
    expect(t.storage.store['jio-tour-v1']).toBeUndefined()
    // A page reload with the old save still in storage is checked against the data too: other sessions under the same ids
    // are not the tour's.
    const { holdsTour, readManifest } = await import('../store.js')
    const manifest = readManifest(saved)
    const other = (await t.api.listSessions()).map((x) => ({ id: x.id, title: x.title }))
    expect(holdsTour(manifest, other)).toBe(false)
    expect(holdsTour(manifest, manifest.story.map((id) => ({ id, title: 'Catch-up makan with the gang' })).concat(manifest.side.map((id) => ({ id, title: 'x' }))))).toBe(true)
    expect(readManifest('not json')).toBeNull()
    expect(readManifest(JSON.stringify({ story: ['s1'], side: [] }))).toBeNull()
  })
})
