import { afterEach, describe, expect, it, vi } from 'vitest'
import { meetingArea } from '../src/planner/engine.js'
import { leanFor, MIN_DEBT_MINUTES, NOT_OWED, picksFor } from '../src/services/session-lean.js'
import { SPOT_RULE } from '../src/services/session-plan.js'
import { createWorld } from './helpers/fake-supabase.js'
import { addMember, addSession, GUEST, HOST, OTHER, SESSION, startSessionApp, STRANGER } from './helpers/session-app.js'

// GET /api/sessions/:id/travel-lean: whether the caller's own past travel counts in the pick of the meeting spots, for the one quiet line on the
// Locate step. The login check is the real code; the database is the fake in helpers/fake-supabase.js (its session_travel_debt is the SQL
// function's twin, and only the service key may call it). Nothing touches the network.
//
// The people: HOST starts at Tampines, GUEST at Clementi, OTHER has not shared a start yet.
const OTHER_SESSION = '99999999-9999-4999-8999-999999999991'

let world
let t
const started = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(started.splice(0).map((s) => s.stop()))
})

const path = (id = SESSION) => `/api/sessions/${id}/travel-lean`
const get = (as, id = SESSION) => t.call('GET', path(id), undefined, as)
const debtReads = () => world.calls.filter((c) => c.rpc === 'session_travel_debt')

// A world with one session in `status`, three members, and an app over it. `owes` gives people a ledger row in an earlier outing (minutes more than
// their share, negative for fewer).
// How to call: await start({ owes: { [HOST]: 12.5, [GUEST]: -12.5 } })
async function start({ status = 'locating', starts = { [HOST]: 'tampines', [GUEST]: 'clementi', [OTHER]: null }, owes = {}, appOptions = {}, states = {} } = {}) {
  world = createWorld()
  addSession(world, { id: SESSION, status })
  addMember(world, SESSION, HOST, { role: 'host', start: starts[HOST], state: states[HOST] })
  addMember(world, SESSION, GUEST, { start: starts[GUEST], state: states[GUEST] })
  addMember(world, SESSION, OTHER, { start: starts[OTHER], state: states[OTHER] })
  for (const [user, delta] of Object.entries(owes)) {
    world.commute_ledger.push({ session_id: OTHER_SESSION, user_id: user, minutes_in: 10, minutes_between: 5, minutes_home: 5, delta_from_mean: delta })
  }
  t = await startSessionApp(world, appOptions)
  started.push(t)
  return t
}

describe('GET /api/sessions/:id/travel-lean', () => {
  it('tells the person who travelled more than their share that it counts, with the rule in use, and nothing else', async () => {
    await start({ owes: { [HOST]: 12.5, [GUEST]: -12.5 } })
    const res = await get(HOST)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ owed: true, rule: 'longest' })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('tells the other member nothing, though their debt is the mirror of the first: a negative debt is not owed', async () => {
    await start({ owes: { [HOST]: 12.5, [GUEST]: -12.5 } })
    const res = await get(GUEST)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ owed: false, rule: 'longest' })
  })

  it('is not owed with a debt of zero, with no past outings, or with a tie that sums to nothing', async () => {
    await start({ owes: { [HOST]: 0, [GUEST]: 0 } })
    expect((await get(HOST)).body.owed).toBe(false)
    await t.stop()
    started.pop()
    await start()
    expect((await get(HOST)).body.owed).toBe(false)
    await t.stop()
    started.pop()
    await start({ owes: { [HOST]: 5 } })
    world.commute_ledger.push({ session_id: '99999999-9999-4999-8999-999999999992', user_id: HOST, minutes_in: 1, minutes_between: 0, minutes_home: 0, delta_from_mean: -5 })
    expect((await get(HOST)).body.owed).toBe(false)
  })

  it('is not owed for a debt under 5 minutes, and is owed from 5', async () => {
    await start({ owes: { [HOST]: 4.9 } })
    expect((await get(HOST)).body.owed).toBe(false)
    await t.stop()
    started.pop()
    await start({ owes: { [HOST]: 5 } })
    expect((await get(HOST)).body.owed).toBe(true)
  })

  it('does not count the outing itself or one older than 90 days', async () => {
    await start()
    world.commute_ledger.push({ session_id: SESSION, user_id: HOST, minutes_in: 10, minutes_between: 0, minutes_home: 0, delta_from_mean: 30 })
    world.commute_ledger.push({ session_id: OTHER_SESSION, user_id: HOST, minutes_in: 10, minutes_between: 0, minutes_home: 0, delta_from_mean: 30, created_at: new Date(world.t - 91 * 24 * 3600 * 1000).toISOString() })
    expect((await get(HOST)).body.owed).toBe(false)
  })

  it('leaks no id, no number and no name of anyone, and writes nothing', async () => {
    await start({ owes: { [HOST]: 12.5, [GUEST]: 40 } })
    const text = JSON.stringify([(await get(HOST)).body, (await get(GUEST)).body])
    for (const leak of [HOST, GUEST, OTHER, '12.5', '40', 'tampines', 'clementi', 'debt']) expect(text).not.toContain(leak)
    expect(Object.keys((await get(HOST)).body).sort()).toEqual(['owed', 'rule'])
    expect(world.calls.filter((c) => c.rpc === 'apply_session_plan')).toEqual([])
    // The debt is read only with the service key, never as the caller.
    expect(debtReads().length).toBeGreaterThan(0)
    expect(debtReads().every((c) => c.who === null)).toBe(true)
  })

  it('refuses a stranger and a missing session the same way, and a caller without a login', async () => {
    await start({ owes: { [HOST]: 12.5 } })
    const stranger = await get(STRANGER)
    const missing = await get(STRANGER, '77777777-7777-4777-8777-777777777777')
    expect(stranger.status).toBe(404)
    expect(stranger.body).toEqual({ error: 'session_not_found', message: 'This session does not exist, or you are not in it.' })
    expect(missing.body).toEqual(stranger.body)
    expect((await t.call('GET', path())).status).toBe(401)
    expect((await get(HOST, 'not-a-uuid')).status).toBe(400)
    expect(debtReads()).toEqual([])
  })

  it('refuses a member who opted out, who is told to rejoin', async () => {
    await start({ owes: { [HOST]: 12.5, [GUEST]: 12.5 }, states: { [GUEST]: 'opted_out' } })
    const res = await get(GUEST)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('not_joined')
    expect(debtReads()).toEqual([])
  })

  it('says nothing is owed, without a read of the debt, when the group is not choosing where to meet', async () => {
    for (const status of ['inviting', 'voting', 'confirmed', 'completed', 'cancelled']) {
      await start({ status, owes: { [HOST]: 12.5 } })
      expect((await get(HOST)).body).toEqual({ owed: false, rule: 'longest' })
      expect(debtReads()).toEqual([])
      await t.stop()
      started.pop()
    }
  })

  it('says nothing is owed when the host named the place themselves (no planner pick), and when it cannot tell how the host chose', async () => {
    await start({ owes: { [HOST]: 12.5 } })
    world.sessions[0].meet_by = 'known'
    expect((await get(HOST)).body.owed).toBe(false)
    world.sessions[0].meet_by = 'fairest'
    expect((await get(HOST)).body.owed).toBe(true)
    world.sessions[0].meet_by = null
    expect((await get(HOST)).body.owed).toBe(true)
  })

  it('says nothing is owed before two starts are in, or while the caller has not shared theirs', async () => {
    await start({ owes: { [HOST]: 12.5, [OTHER]: 12.5 }, starts: { [HOST]: 'tampines', [GUEST]: null, [OTHER]: null } })
    expect((await get(HOST)).body.owed).toBe(false)
    await t.stop()
    started.pop()
    // The caller (OTHER) has no start, though two others do: there is no trip of theirs to count.
    await start({ owes: { [OTHER]: 12.5 } })
    expect((await get(OTHER)).body.owed).toBe(false)
    expect((await get(HOST)).body.owed).toBe(false)
  })

  it('shows nothing, and does not fail, when the debt cannot be read or never answers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await start({ owes: { [HOST]: 12.5 } })
    world.failDebt = true
    const res = await get(HOST)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ owed: false, rule: 'longest' })
    expect(warn).toHaveBeenCalled()
    for (const [message] of warn.mock.calls) expect(String(message)).not.toMatch(/does not exist|permission|42883/)
  })

  it('is limited per caller with the other reads', async () => {
    await start({ owes: { [HOST]: 12.5 }, appOptions: { sessionRateLimit: { windowMs: 60_000, max: 2 } } })
    expect((await get(HOST)).status).toBe(200)
    expect((await get(HOST)).status).toBe(200)
    const third = await get(HOST)
    expect(third.status).toBe(429)
    expect(third.body.error).toBe('rate_limited')
  })
})

describe('the rule the answer names is the rule the spots are ranked by', () => {
  // A hand-made board: two areas the same longest trip apart, one nearer A, one nearer B. A has travelled more than their share.
  const data = { areas: [{ id: 'near-b', name: 'Near B', lat: 1.34, lng: 103.8 }, { id: 'near-a', name: 'Near A', lat: 1.33, lng: 103.8 }] }
  const a = { id: 'a', start: { lat: 1.3, lng: 103.8 }, end: { lat: 1.3, lng: 103.8 } }
  const b = { id: 'b', start: { lat: 1.4, lng: 103.8 }, end: { lat: 1.4, lng: 103.8 } }
  const times = { 'near-a': { a: 10, b: 20 }, 'near-b': { a: 20, b: 10 } }
  const minutes = (from, to) => times[to.id][from.lat === 1.3 ? 'a' : 'b']
  const pick = (members, extra = {}) => meetingArea({ members, method: 'station', ...extra }, data, { travelMinutes: minutes }).area.id

  it('is the engine\'s default, so a request that says it outright is answered as one that does not', () => {
    expect(SPOT_RULE).toBe('longest')
    const members = [a, b]
    expect(meetingArea({ members, method: 'station', alternatives: 2, rule: SPOT_RULE }, data, { travelMinutes: minutes })).toEqual(
      meetingArea({ members, method: 'station', alternatives: 2 }, data, { travelMinutes: minutes }),
    )
  })

  it('under it a debt only breaks an exact tie on the longest trip, and moves nothing else', () => {
    // Without a debt the tie goes to the first area tried; with a debt on A it goes to the area nearer A.
    expect(pick([a, b], { rule: SPOT_RULE })).toBe('near-b')
    expect(pick([{ ...a, travelDebtMinutes: 30 }, b], { rule: SPOT_RULE })).toBe('near-a')
    // One minute off the tie and the debt changes nothing, however large.
    times['near-a'].b = 21
    try {
      expect(pick([{ ...a, travelDebtMinutes: 600 }, b], { rule: SPOT_RULE })).toBe('near-b')
    } finally {
      times['near-a'].b = 20
    }
  })

  it('under the balanced rule a person\'s trip counts for more, up to three times, among places about as good for the group', () => {
    expect(pick([{ ...a, travelDebtMinutes: 600 }, b], { rule: 'balanced' })).toBe('near-a')
  })
})

describe('leanFor and picksFor (pure)', () => {
  const areasById = new Map([['tampines', {}], ['clementi', {}]])
  const members = [
    { user_id: 'U1', state: 'joined', start_area_id: 'tampines' },
    { user_id: 'u2', state: 'joined', start_area_id: 'clementi' },
    { user_id: 'u3', state: 'joined', start_area_id: null },
  ]
  const base = { status: 'locating', meetBy: 'fairest', members, areasById, userId: 'u1', debts: new Map([['u1', 12.5]]) }

  it('is owed for a debt of 5 minutes or more, and not for less, in the rule in use', () => {
    expect(MIN_DEBT_MINUTES).toBe(5)
    expect(leanFor(base)).toEqual({ owed: true, rule: SPOT_RULE })
    expect(leanFor({ ...base, debts: new Map([['u1', 5]]) })).toEqual({ owed: true, rule: SPOT_RULE })
    expect(leanFor({ ...base, debts: new Map([['u1', 4.99]]) })).toBe(NOT_OWED)
    expect(leanFor({ ...base, debts: new Map([['u1', 0.01]]) })).toBe(NOT_OWED)
    expect(leanFor({ ...base, debts: new Map([['u1', 0]]) })).toBe(NOT_OWED)
    expect(leanFor({ ...base, debts: new Map([['u1', -3]]) })).toBe(NOT_OWED)
    expect(leanFor({ ...base, debts: new Map([['u1', Number.NaN]]) })).toBe(NOT_OWED)
  })

  it('is not owed when the debts are unknown, or the caller is not in them', () => {
    expect(leanFor({ ...base, debts: null })).toBe(NOT_OWED)
    expect(leanFor({ ...base, debts: new Map([['u2', 50]]) })).toBe(NOT_OWED)
  })

  it('has no pick for a caller without a start, one person with a start, a known place or another status', () => {
    expect(picksFor({ ...base, userId: 'u3' })).toBe(false)
    expect(picksFor({ ...base, members: members.slice(0, 1) })).toBe(false)
    expect(picksFor({ ...base, meetBy: 'known' })).toBe(false)
    expect(picksFor({ ...base, status: 'voting' })).toBe(false)
    expect(picksFor({ ...base, members: members.map((m) => ({ ...m, state: m.user_id === 'u2' ? 'opted_out' : m.state })) })).toBe(false)
    expect(picksFor(base)).toBe(true)
  })
})
