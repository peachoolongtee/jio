// The showcase (components/dev/showcase.js): ten sessions, one for each state a screen can show, made through the public
// functions of lib/api.js. Run twice on purpose: once with the planner backend not there (the stand-in answers) and once
// against the real Express app started in this process, with its outside calls stubbed. Set SHOWCASE_TABLE=1 to print
// what Home shows for each session.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { addDays, format } from 'date-fns'
import { createApp } from '../../../../../backend/src/app.js'
import { createHttp } from '../../../../../backend/src/services/http.js'
import { STORAGE_KEY, loadApi } from '../../../lib/__tests__/planFixture.js'
import { activeMeetups, dayLabel, nextStepFor, whereStands } from '../../../lib/homeMeetups.js'
import { distanceKm } from '../../../lib/planner/index.js'
import { waitingFor } from '../../../stores/events.js'
import { DEMO_ACCOUNT } from '../demoAccount.js'

const NOW = new Date('2026-10-10T14:20:00')
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
    voting: by('Saturday movie and makan'),
    revoted: by('Sunday kopi and a long walk'),
    today: by('Chinatown makan crawl'),
    ahead: by('Dessert run after the gym'),
    completed: by('Orchard Road wander and dinner'),
    long: all.find((s) => s.title.length === 60),
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
  const dateAt = (days) => format(addDays(NOW, days), 'yyyy-MM-dd')

  // 1. just created: nobody invited
  expect(s.fresh).toMatchObject({ status: 'inviting', hostId: 'ian', activeIds: ['ian'], date: dateAt(14) })
  expect(s.fresh.members).toHaveLength(1)

  // 2. invites sent: some accepted, some still pending
  expect(s.invited.status).toBe('inviting')
  expect(['darius', 'nicole'].map((id) => stateOf(s.invited, id))).toEqual(['joined', 'joined'])
  expect(['faith', 'darryl'].map((id) => stateOf(s.invited, id))).toEqual(['invited', 'invited'])

  // 3. waiting on locations: Ian has shared, two friends have not
  expect(s.waiting.status).toBe('locating')
  expect(s.waiting.locations.ian.start.areaId).toBe('bishan')
  expect(waitingFor(s.waiting)).toEqual(['nicole', 'faith'])
  expect(s.waiting.area).toBeNull()

  // 4. voting, Ian has not voted
  expect(s.voting.status).toBe('voting')
  expect(s.voting.area).toBeTruthy()
  expect(voters(s.voting)).toEqual(['darius', 'nicole'])
  expect(Object.keys(s.voting.prefs).sort()).toEqual(['darius', 'ian', 'nicole'])

  // 5. voting, Ian has voted and others have not; Jonathan opted out; the banner says the votes were cleared
  expect(s.revoted.status).toBe('voting')
  expect(stateOf(s.revoted, 'jonathan')).toBe('opted_out')
  expect(s.revoted.banner).toMatchObject({ votesCleared: true })
  expect(s.revoted.banner.text).toMatch(/Faith's start location changed\. Votes for places were cleared\.$/)
  expect(voters(s.revoted)).toEqual(['ian'])

  // 6. confirmed for today, with an itinerary
  expect(s.today).toMatchObject({ status: 'confirmed', date: dateAt(0), isToday: true })
  expect((await api.getItinerary(s.today.id)).stops.length).toBeGreaterThanOrEqual(2)

  // 7. confirmed a few days ahead, in an area next to the one session 6 meets in
  expect(s.ahead).toMatchObject({ status: 'confirmed', date: dateAt(3) })
  expect(distanceKm(s.today.area, s.ahead.area)).toBeLessThan(2.5)
  expect((await api.getItinerary(s.ahead.id)).stops.length).toBeGreaterThanOrEqual(1)

  // 8. completed last week, with photos
  expect(s.completed).toMatchObject({ status: 'completed', date: dateAt(-7), photoCount: 8 })
  expect((await api.getPhotos(s.completed.id)).map((p) => p.name).slice(0, 4)).toEqual(['Ian', 'Darius', 'Nicole', 'Faith'])

  // 9. the longest title the app allows: 60 characters, with a meeting point and a pin
  expect(s.long.title).toHaveLength(60)
  expect(s.long.status).toBe('locating')
  expect(s.long.area).toBeTruthy()

  // 10. invited to, hosted by someone else
  expect(s.guest.hostId).toBe('darius')
  expect(s.guest.members.map((m) => [m.id, m.role])).toEqual([['darius', 'host'], ['ian', 'guest'], ['faith', 'guest'], ['nicole', 'guest']])
  expect(s.guest.locations.ian).toBeUndefined()

  // Rewards: one voucher redeemed. The season before this one is still there.
  expect(await api.listRedemptions()).toHaveLength(1)
  expect((await api.getSeason()).past.length).toBeGreaterThanOrEqual(1)
  return s
}

// What Home shows for the showcase: nine meetups going, the completed one not among them.
// How to call: expectHome(s)
function expectHome(s) {
  const going = activeMeetups(s.all, NOW)
  expect(going.map((m) => m.title)).toEqual([
    s.today, s.voting, s.ahead, s.revoted, s.waiting, s.long, s.guest, s.invited, s.fresh,
  ].map((m) => m.title))
  const step = (session) => nextStepFor(session, 'ian')
  expect(step(s.fresh)).toMatchObject({ label: 'Invite friends', tone: 'action' })
  expect(step(s.invited)).toMatchObject({ label: 'Start session', tone: 'action' })
  expect(step(s.waiting)).toMatchObject({ label: 'Waiting for others', tone: 'wait' })
  expect(step(s.voting)).toMatchObject({ label: 'Vote', tone: 'action' })
  expect(step(s.revoted)).toMatchObject({ label: 'Waiting for others', tone: 'wait' })
  expect(step(s.today)).toMatchObject({ label: "Today's plan", tone: 'done' })
  expect(step(s.ahead)).toMatchObject({ label: 'See the plan', tone: 'done' })
  expect(step(s.long)).toMatchObject({ label: 'Confirm the meeting point', tone: 'action' })
  expect(step(s.guest)).toMatchObject({ label: 'Share your start', tone: 'action' })
  expect(whereStands(s.waiting, 'ian').text).toBe('No meeting point yet · 2 of 4 locations shared')
  expect(dayLabel(s.today, NOW)).toBe('Today')
  // A pin for each meetup that has a meeting area: voting, the two confirmed, the one with a long title and the re-voted one.
  expect(going.filter((m) => m.area).map((m) => m.title).sort()).toEqual([s.voting, s.revoted, s.today, s.ahead, s.long].map((m) => m.title).sort())
  if (process.env.SHOWCASE_TABLE) {
    console.table([...s.all].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map((m) => ({ id: m.id, title: m.title, status: m.status, area: m.area?.name || '', home: ['completed', 'cancelled'].includes(m.status) ? '(not on Home)' : nextStepFor(m, 'ian').label })))
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
