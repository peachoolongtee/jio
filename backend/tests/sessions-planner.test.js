import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSupabase } from '../src/db/supabase.js'
import { loadPlanData } from '../src/db/venues.js'
import { createHttp } from '../src/services/http.js'
import { createOneMap } from '../src/services/onemap.js'
import { createPlannerRuns } from '../src/services/planner-runs.js'
import { SCENARIO_HEADER } from '../src/services/scenario.js'
import { createSessionQueue } from '../src/services/session-queue.js'
import { createSessions } from '../src/services/sessions.js'
import { MAX_ROUTED_TRIPS_PER_REQUEST } from '../src/services/travel-times.js'
import { createWorld, fakeSupabase, jwksFetch, SUPABASE_URL, userClient } from './helpers/fake-supabase.js'
import { addMember, addSession, GUEST, HOST, OTHER, SESSION, startSessionApp } from './helpers/session-app.js'

// How the session endpoints use the planner: the OneMap cap and budget, the stub scenarios, and the line a session's writes wait in.
// No call leaves this machine: OneMap answers from the stub fixtures, and the database is the fake in helpers/fake-supabase.js.

let world
const stopped = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(stopped.splice(0).map((stop) => stop()))
})

// Counts the OneMap calls that reach the HTTP layer, in stub mode (the same stand-in onemap-limits.test.js uses).
function countingStubHttp() {
  const real = createHttp({ stub: true })
  const calls = { route: 0, login: 0 }
  return {
    calls,
    getJson: (url, options) => {
      if (url.includes('/routingsvc/route')) calls.route += 1
      return real.getJson(url, options)
    },
    postJson: (url, body, options) => {
      if (url.includes('getToken')) calls.login += 1
      return real.postJson(url, body, options)
    },
  }
}

// The 37 areas, for a group that is spread out.
const AREAS = loadPlanData().areas.map((a) => a.id)
const idOf = (i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`

// A locating session whose members are the host and `count - 1` guests, each starting in a different area.
//
// How to call:
//   const people = fillSession(30) // [HOST, ...guest ids]
function fillSession(count, { status = 'locating' } = {}) {
  world = createWorld()
  addSession(world, { id: SESSION, status })
  addMember(world, SESSION, HOST, { role: 'host', start: AREAS[0] })
  const people = [HOST]
  for (let i = 1; i < count; i += 1) {
    addMember(world, SESSION, idOf(i), { start: AREAS[i % AREAS.length] })
    people.push(idOf(i))
  }
  return people
}

describe('the OneMap cap: 30 members, one request, at most 60 trips', () => {
  async function appWithCountedOneMap(options = {}) {
    const http = countingStubHttp()
    const onemap = createOneMap({ http, email: 'someone@example.test', password: 'not-a-real-password', stub: true })
    const t = await startSessionApp(world, { onemap, ...options })
    stopped.push(t.stop)
    return { t, calls: http.calls }
  }

  it('meeting spots for 30 members, with eight suggestions: at most 60 route calls, whole areas only, the rest estimated and flagged', async () => {
    fillSession(30)
    const suggested = ['bugis', 'orchard', 'woodlands', 'bedok', 'jurong-east', 'punggol', 'tuas-link', 'boon-lay']
    suggested.forEach((area, i) => world.spot_suggestions.push({ session_id: SESSION, user_id: idOf(i + 1), area_id: area, here: false, created_at: `2026-10-20T08:00:0${i}.000Z` }))
    const { t, calls } = await appWithCountedOneMap()
    const res = await t.call('POST', `/api/sessions/${SESSION}/meeting-area`, {}, HOST)
    expect(res.status).toBe(200)
    expect(res.body.spots).toBe(11)
    expect(calls.route).toBeGreaterThan(0)
    expect(calls.route).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
    // Whole areas only: an area is real for every member or estimated for every member, so the flag is per area.
    const rows = world.session_spots
    expect(rows.some((r) => r.approximate)).toBe(true)
    expect(rows.every((r) => Object.keys(r.travel_minutes).length === 30)).toBe(true)
  })

  it('a suggestion for 30 members: still at most 60 route calls in the request', async () => {
    fillSession(30)
    const { t, calls } = await appWithCountedOneMap()
    await t.call('POST', `/api/sessions/${SESSION}/meeting-area`, {}, HOST)
    const afterList = calls.route
    const res = await t.call('PUT', `/api/sessions/${SESSION}/spots/mine`, { areaId: 'tuas-link' }, idOf(1))
    expect(res.status).toBe(200)
    // The first request's trips are cached, so the second spends at most what is left of its own allowance of 60.
    expect(calls.route - afterList).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
  })

  it('a known place for 30 members prices that one area with at most 30 route calls', async () => {
    fillSession(30)
    const { t, calls } = await appWithCountedOneMap()
    const res = await t.call('PUT', `/api/sessions/${SESSION}/known-place`, { areaId: 'bugis' }, HOST)
    expect(res.status).toBe(200)
    expect(calls.route).toBeGreaterThan(0)
    expect(calls.route).toBeLessThanOrEqual(30)
    expect(world.session_spots).toHaveLength(1)
    expect(world.session_spots[0].approximate).toBe(false)
    expect(Object.keys(world.session_spots[0].travel_minutes)).toHaveLength(30)
  })

  it('asks the same OneMap the planner routes use: with no account every time is the engine\'s estimate, flagged approximate', async () => {
    fillSession(3)
    const t = await startSessionApp(world)
    stopped.push(t.stop)
    const res = await t.call('POST', `/api/sessions/${SESSION}/meeting-area`, {}, HOST)
    expect(res.status).toBe(200)
    expect(world.session_spots).toHaveLength(3)
    expect(world.session_spots.every((r) => r.approximate)).toBe(true)
  })

  it('a routing failure never fails the request: the stub scenario "routing-fail" gives estimates, flagged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fillSession(3)
    const t = await startSessionApp(world, { stub: true })
    stopped.push(t.stop)
    const res = await t.call('POST', `/api/sessions/${SESSION}/meeting-area`, {}, HOST, { [SCENARIO_HEADER]: 'routing-fail' })
    expect(res.status).toBe(200)
    expect(world.session_spots).toHaveLength(3)
    expect(world.session_spots.every((r) => r.approximate)).toBe(true)
  })

  it('a dry stub scenario routes: real times, not flagged', async () => {
    fillSession(3)
    const t = await startSessionApp(world, { stub: true })
    stopped.push(t.stop)
    const res = await t.call('POST', `/api/sessions/${SESSION}/meeting-area`, {}, HOST)
    expect(res.status).toBe(200)
    expect(world.session_spots.some((r) => !r.approximate)).toBe(true)
  })
})

// A service over a world, with the planner run counted and optionally held back, for the tests of the line.
// How to call: const { sessions, runs, hold, as } = serviceOver(world)   // a second argument adds options for createSessions
function serviceOver(over, sessionOptions = {}) {
  const supabase = fakeSupabase(over, createSupabase({ url: SUPABASE_URL, anonKey: 'a', serviceKey: 's', fetchImpl: jwksFetch }))
  const data = loadPlanData()
  const base = createPlannerRuns({ data, weatherResolver: null, onemap: null })
  const control = { gate: null, edit: null }
  const runs = {
    ...base,
    runWithTravel: vi.fn(async (...args) => {
      const gate = control.gate
      control.gate = null // only the next run is held back
      if (gate) await gate
      const out = await base.runWithTravel(...args)
      return control.edit ? control.edit(out) : out
    }),
  }
  const sessions = createSessions({ supabase, data, runs, ...sessionOptions })
  // Holds back the next planner run until `release()` is called.
  const hold = () => {
    let release
    control.gate = new Promise((resolve) => {
      release = resolve
    })
    return release
  }
  const as = (id) => ({ client: userClient(over, id), id: SESSION, userId: id })
  return { sessions, runs, hold, as, control }
}

const writesOf = () => world.calls.filter((c) => c.rpc === 'apply_session_plan')
const sessionRow = (id = SESSION) => world.sessions.find((s) => s.id === id)

function lineWorld(status = 'locating') {
  world = createWorld()
  addSession(world, { id: SESSION, status })
  addMember(world, SESSION, HOST, { role: 'host', start: 'tampines' })
  addMember(world, SESSION, GUEST, { start: 'clementi' })
  addMember(world, SESSION, OTHER, { start: 'bishan' })
}

describe('one run at a time per session, at most one waiting', () => {
  it('answers a rush of recomputes with two planner runs and one write, every caller with the same answer', async () => {
    lineWorld()
    const { sessions, runs, hold, as } = serviceOver(world)
    const release = hold()
    const first = sessions.recompute({ ...as(HOST), trigger: 'start' })
    await vi.waitFor(() => expect(runs.runWithTravel).toHaveBeenCalledTimes(1))
    const second = sessions.recompute({ ...as(GUEST), trigger: 'start' })
    const third = sessions.recompute({ ...as(OTHER), trigger: 'added' })
    await vi.waitFor(() => expect(sessions.queue.waiting(SESSION)).toBe(2))
    release()
    const answers = await Promise.all([first, second, third])
    // The first run finished while another waited, so it did not write: the waiting run did the work for all three.
    expect(runs.runWithTravel).toHaveBeenCalledTimes(2)
    expect(writesOf()).toHaveLength(1)
    expect(answers[0]).toEqual(answers[1])
    expect(answers[1]).toEqual(answers[2])
    expect(answers[0]).toMatchObject({ planVersion: 1, spots: 3, skipped: [] })
    expect(sessions.queue.busy()).toBe(0)
  })

  it('never drops a change that is not a plain recompute: a suggestion waiting behind a recompute is written by the run that serves both', async () => {
    lineWorld()
    const { sessions, runs, hold, as } = serviceOver(world)
    const release = hold()
    const recompute = sessions.recompute({ ...as(HOST) })
    await vi.waitFor(() => expect(runs.runWithTravel).toHaveBeenCalledTimes(1))
    const suggest = sessions.suggestSpot({ ...as(GUEST), areaId: 'tuas-link', here: false })
    await vi.waitFor(() => expect(sessions.queue.waiting(SESSION)).toBe(1))
    release()
    const [a, b] = await Promise.all([recompute, suggest])
    expect(world.spot_suggestions).toEqual([expect.objectContaining({ user_id: GUEST, area_id: 'tuas-link' })])
    expect(world.session_spots.map((s) => s.area_id)).toContain('tuas-link')
    expect(writesOf()).toHaveLength(1)
    expect(a.planVersion).toBe(b.planVersion)
  })

  it('writes a running change first and the waiting recompute after it, and the second does not raise the version when nothing moved', async () => {
    lineWorld()
    const { sessions, runs, hold, as } = serviceOver(world)
    await sessions.recompute({ ...as(HOST) })
    const release = hold()
    const suggest = sessions.suggestSpot({ ...as(GUEST), areaId: 'tuas-link' })
    await vi.waitFor(() => expect(runs.runWithTravel).toHaveBeenCalledTimes(2))
    const recompute = sessions.recompute({ ...as(OTHER) })
    await vi.waitFor(() => expect(sessions.queue.waiting(SESSION)).toBe(1))
    release()
    const [s, r] = await Promise.all([suggest, recompute])
    expect(runs.runWithTravel).toHaveBeenCalledTimes(3)
    expect(s.planVersion).toBe(2)
    expect(r.planVersion).toBe(2) // the recompute found nothing new to write
    expect(sessionRow().plan_version).toBe(2)
  })

  it('gives a host\'s confirm its own turn, and a recompute queued after it is refused: a late answer never undoes the confirmation', async () => {
    lineWorld()
    const { sessions, runs, hold, as } = serviceOver(world)
    await sessions.recompute({ ...as(HOST) })
    const order = []
    const release = hold()
    const running = sessions.recompute({ ...as(GUEST) }).then((r) => order.push('recompute'), () => order.push('recompute failed'))
    await vi.waitFor(() => expect(runs.runWithTravel).toHaveBeenCalledTimes(2))
    const confirm = sessions.confirmSpot({ ...as(HOST) }).then((r) => order.push('confirm'))
    const late = sessions.recompute({ ...as(OTHER) }).then(() => order.push('late ok'), (err) => order.push(`late ${err.code}`))
    await vi.waitFor(() => expect(sessions.queue.waiting(SESSION)).toBe(2))
    // Everything on the list but the time it was worked out, which the running recompute may bring forward.
    const spotContent = () => JSON.stringify(world.session_spots.map(({ computed_at: _at, ...rest }) => rest))
    const spotsBefore = spotContent()
    release()
    await Promise.all([running, confirm, late])
    expect(order).toEqual(['recompute', 'confirm', 'late not_yet'])
    expect(sessionRow()).toMatchObject({ status: 'voting', meeting_method: 'fairest' })
    expect(spotContent()).toBe(spotsBefore)
  })

  it('does not hold one session behind another', async () => {
    lineWorld()
    const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    addSession(world, { id: other })
    addMember(world, other, HOST, { role: 'host', start: 'bedok' })
    addMember(world, other, GUEST, { start: 'jurong-east' })
    const { sessions, runs, hold, as } = serviceOver(world)
    const release = hold()
    const held = sessions.recompute({ ...as(HOST) })
    await vi.waitFor(() => expect(runs.runWithTravel).toHaveBeenCalledTimes(1))
    const quick = await sessions.recompute({ ...as(HOST), id: other })
    expect(quick.spots).toBe(3)
    release()
    await held
    expect(sessions.queue.busy()).toBe(0)
  })

  it('refuses a job on its own when the planner could not price its area, and does the others without it', async () => {
    lineWorld()
    const { sessions, runs, hold, as, control } = serviceOver(world)
    // The planner "forgets" every area that was only included, so a suggestion cannot be priced.
    control.edit = (out) => ({ ...out, result: { ...out.result, candidates: out.result.candidates.filter((c) => c.source !== 'included') } })
    const release = hold()
    const recompute = sessions.recompute({ ...as(HOST) })
    await vi.waitFor(() => expect(runs.runWithTravel).toHaveBeenCalledTimes(1))
    const bad = sessions.suggestSpot({ ...as(GUEST), areaId: 'tuas-link' }).then(() => 'ok', (err) => `${err.status} ${err.code}`)
    const good = sessions.recompute({ ...as(OTHER) })
    await vi.waitFor(() => expect(sessions.queue.waiting(SESSION)).toBe(2))
    release()
    expect(await bad).toBe('422 area_not_priced')
    expect((await good).spots).toBe(3)
    await recompute
    expect(world.spot_suggestions).toEqual([])
    expect(world.session_spots.map((s) => s.area_id)).not.toContain('tuas-link')
  })

  it('loads again and does the work again when the session moved on, and says plan_busy after three tries', async () => {
    lineWorld()
    const { sessions, runs, as } = serviceOver(world)
    world.staleApply = 1
    const ok = await sessions.recompute({ ...as(HOST) })
    expect(ok.spots).toBe(3)
    expect(runs.runWithTravel).toHaveBeenCalledTimes(2)
    world.staleApply = 3
    world.session_spots.length = 0
    const busy = await sessions.recompute({ ...as(HOST) }).catch((err) => err)
    expect(busy).toMatchObject({ status: 409, code: 'plan_busy', retryAfter: 1 })
  })

  it('works out the spots for a session once per attempt and shares one allowance of OneMap trips across the attempts', async () => {
    lineWorld()
    const seen = []
    const http = countingStubHttp()
    const onemap = createOneMap({ http, email: 'someone@example.test', password: 'not-a-real-password', stub: true })
    const supabase = fakeSupabase(world, createSupabase({ url: SUPABASE_URL, anonKey: 'a', serviceKey: 's', fetchImpl: jwksFetch }))
    const data = loadPlanData()
    const base = createPlannerRuns({ data, weatherResolver: null, onemap })
    const runs = {
      ...base,
      runWithTravel: vi.fn(async (input, planData, run, options) => {
        const resolved = typeof options === 'function' ? options(input) : options
        seen.push(resolved)
        const out = await base.runWithTravel(input, planData, run, options)
        resolved.routedAfter = out.travel.routed
        return out
      }),
    }
    const sessions = createSessions({ supabase, data, runs })
    world.staleApply = 1 // the first write finds the session moved on, so the run loads again and works the spots out a second time
    await sessions.recompute({ client: userClient(world, HOST), id: SESSION, userId: HOST })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ maxTrips: MAX_ROUTED_TRIPS_PER_REQUEST, rankByEstimate: true })
    expect(seen[0].deadlineMs).toBeGreaterThan(0)
    expect(seen[0].namedAreas.afterShortlist).toEqual([]) // no suggestions yet
    // The first attempt spent trips, and the second may spend only what was left: the allowance is the request's, not each attempt's.
    expect(seen[0].routedAfter).toBeGreaterThan(0)
    expect(seen[1].maxTrips).toBe(MAX_ROUTED_TRIPS_PER_REQUEST - seen[0].routedAfter)
    expect(seen[1].maxTrips).toBeLessThan(seen[0].maxTrips)
    expect(http.calls.route).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
  })
})

describe('what a run does before it pays, and when the database does not answer', () => {
  it('has one line for a session however its id is written', async () => {
    lineWorld()
    const { sessions, runs, hold, as } = serviceOver(world)
    const release = hold()
    const upper = sessions.recompute({ ...as(HOST), id: SESSION.toUpperCase() })
    await vi.waitFor(() => expect(runs.runWithTravel).toHaveBeenCalledTimes(1))
    const lower = sessions.recompute({ ...as(GUEST) })
    // The second waits behind the first: it is in the same lane, not a lane of its own that runs at the same time.
    await vi.waitFor(() => expect(sessions.queue.waiting(SESSION)).toBe(1))
    expect(runs.runWithTravel).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([upper, lower])
    expect(sessions.queue.busy()).toBe(0)
  })

  it('hands a pure recompute over before the planner when an ordinary batch is already waiting, so it spends no OneMap calls', async () => {
    lineWorld()
    const { sessions, runs, as } = serviceOver(world)
    // A request joins the line while the run is reading the session, so the batch is waiting when the run looks at it.
    let late
    world.hooks.beforeRead = ({ table }) => {
      if (table !== 'sessions' || late) return
      late = sessions.queue.enqueue(SESSION, {
        exclusive: false,
        check: () => {},
        prepare: () => ({ ops: [], needs: 'recompute', nameIds: [], answer: ({ version, rows }) => ({ planVersion: version, spots: rows.length }) }),
      })
    }
    const answer = await sessions.recompute({ ...as(HOST) })
    expect(await late).toEqual({ planVersion: 1, spots: 3 })
    expect(runs.runWithTravel).toHaveBeenCalledTimes(1) // the waiting batch's run only
    expect(writesOf()).toHaveLength(1)
    expect(answer).toMatchObject({ planVersion: 1, spots: 3 })
  })

  it('fails a run whose database read never answers, with 503 unavailable, and the line moves on', async () => {
    lineWorld()
    const { sessions, runs, as } = serviceOver(world, { dbDeadlineMs: 40 })
    world.hangReads = true
    const hung = await sessions.recompute({ ...as(HOST) }).catch((err) => err)
    expect(hung).toMatchObject({ name: 'SessionError', status: 503, code: 'unavailable', retryAfter: 2 })
    expect(runs.runWithTravel).not.toHaveBeenCalled()
    expect(sessions.queue.busy()).toBe(0)
    world.hangReads = false
    expect((await sessions.recompute({ ...as(HOST) })).spots).toBe(3)
  })

  it('fails a run whose write never answers the same way, and a request waiting behind it is served', async () => {
    lineWorld()
    const { sessions, as } = serviceOver(world, { dbDeadlineMs: 40 })
    world.hangApply = true
    const hung = sessions.recompute({ ...as(HOST) }).catch((err) => err)
    await vi.waitFor(() => expect(writesOf()).toHaveLength(1))
    world.hangApply = false
    const next = sessions.recompute({ ...as(GUEST) })
    expect(await hung).toMatchObject({ status: 503, code: 'unavailable' })
    expect((await next).spots).toBe(3)
    expect(sessions.queue.busy()).toBe(0)
  })

  it('names the job that took the spot away in the notice, not another member\'s start change that shares the batch', async () => {
    lineWorld()
    const { sessions, runs, hold, as } = serviceOver(world)
    await sessions.recompute({ ...as(HOST) })
    const [far] = ['tuas-link']
    await sessions.suggestSpot({ ...as(GUEST), areaId: far })
    world.spot_approvals.push({ session_id: SESSION, area_id: far, user_id: HOST, created_at: '2026-10-20T08:00:00.000Z' })
    const release = hold()
    const first = sessions.recompute({ ...as(HOST), trigger: 'start' })
    await vi.waitFor(() => expect(runs.runWithTravel).toHaveBeenCalledTimes(3))
    const withdrawn = sessions.withdrawSpot({ ...as(GUEST) })
    await vi.waitFor(() => expect(sessions.queue.waiting(SESSION)).toBe(1))
    release()
    await Promise.all([first, withdrawn])
    expect(sessionRow().banner.text).toMatch(/^Person 22 withdrew their suggestion\. .* no longer on the list/)
    expect(sessionRow().banner.text).not.toContain('Person 11')
  })

  it('says only that the list changed when several jobs share the batch and none of them removed the spot', async () => {
    lineWorld()
    const { sessions, runs, hold, as } = serviceOver(world)
    await sessions.recompute({ ...as(HOST) })
    const ranked = world.session_spots.filter((s) => s.rank !== null).map((s) => s.area_id)
    for (const area of ranked) world.spot_approvals.push({ session_id: SESSION, area_id: area, user_id: HOST, created_at: '2026-10-20T08:00:00.000Z' })
    const release = hold()
    const first = sessions.recompute({ ...as(HOST), trigger: 'start' })
    await vi.waitFor(() => expect(runs.runWithTravel).toHaveBeenCalledTimes(2))
    // The guest moves far away while the run works; their recompute joins the batch that follows.
    world.session_members.find((m) => m.user_id === GUEST).start_area_id = 'woodlands'
    const second = sessions.recompute({ ...as(GUEST), trigger: 'start' })
    await vi.waitFor(() => expect(sessions.queue.waiting(SESSION)).toBe(1))
    release()
    await Promise.all([first, second])
    expect(world.session_spots.filter((s) => s.rank !== null).map((s) => s.area_id)).not.toEqual(ranked) // the scenario really changes the list
    expect(sessionRow().banner.text).toMatch(/^The list of spots changed\. .* no longer on the list/)
  })
})

describe('createSessionQueue', () => {
  it('runs one batch at a time and settles every job; a runner that throws rejects the jobs it left', async () => {
    const seen = []
    const queue = createSessionQueue(async (id, batch) => {
      seen.push(batch.jobs.map((j) => j.name))
      await new Promise((resolve) => setTimeout(resolve, 5))
      for (const job of batch.jobs) {
        if (job.name === 'bad') throw new Error('boom')
        job.settle.resolve(job.name)
      }
    })
    const [a, b, c] = await Promise.allSettled([queue.enqueue('s', { name: 'a' }), queue.enqueue('s', { name: 'b' }), queue.enqueue('s', { name: 'bad' })])
    expect(seen).toEqual([['a'], ['b', 'bad']]) // b and bad joined one waiting batch
    expect(a).toEqual({ status: 'fulfilled', value: 'a' })
    expect(b).toEqual({ status: 'fulfilled', value: 'b' })
    expect(c.status).toBe('rejected')
    expect(queue.busy()).toBe(0)
  })

  it('keeps an exclusive job in a batch of its own, between the batches around it', async () => {
    const seen = []
    const queue = createSessionQueue(async (id, batch) => {
      seen.push(batch.jobs.map((j) => j.name))
      await new Promise((resolve) => setTimeout(resolve, 5))
      for (const job of batch.jobs) job.settle.resolve(job.name)
    })
    await Promise.all([
      queue.enqueue('s', { name: 'a' }),
      queue.enqueue('s', { name: 'b' }),
      queue.enqueue('s', { name: 'confirm', exclusive: true }),
      queue.enqueue('s', { name: 'c' }),
      queue.enqueue('s', { name: 'd' }),
    ])
    expect(seen).toEqual([['a'], ['b'], ['confirm'], ['c', 'd']])
  })

  it('hands the jobs it is given to the waiting ordinary batch, which then answers them', async () => {
    const seen = []
    const queue = createSessionQueue(async (id, batch, { handOver }) => {
      seen.push(batch.jobs.map((j) => j.name))
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (batch.jobs[0].name === 'a' && handOver(batch.jobs)) return
      for (const job of batch.jobs) job.settle.resolve(job.name)
    })
    const results = await Promise.all([queue.enqueue('s', { name: 'a' }), queue.enqueue('s', { name: 'b' })])
    expect(seen).toEqual([['a'], ['a', 'b']]) // the second run holds both
    expect(results).toEqual(['a', 'b'])
  })

  it('does not hand over to a waiting exclusive batch', async () => {
    const handed = []
    const queue = createSessionQueue(async (id, batch, { handOver }) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      handed.push(handOver(batch.jobs))
      batch.jobs.forEach((j) => j.settle.resolve('done'))
    })
    await Promise.all([queue.enqueue('s', { name: 'a' }), queue.enqueue('s', { name: 'confirm', exclusive: true })])
    expect(handed).toEqual([false, false])
  })

  it('does not hand over when nothing ordinary is waiting', async () => {
    let handed = null
    const queue = createSessionQueue(async (id, batch, { handOver }) => {
      handed = handOver(batch.jobs)
      batch.jobs.forEach((j) => j.settle.resolve('done'))
    })
    expect(await queue.enqueue('s', { name: 'a' })).toBe('done')
    expect(handed).toBe(false)
  })
})
