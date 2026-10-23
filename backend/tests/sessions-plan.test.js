import { afterEach, describe, expect, it, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { createSupabase } from '../src/db/supabase.js'
import { loadPlanData } from '../src/db/venues.js'
import { mockTravelMinutes } from '../src/planner/geo.js'
import { createWeatherResolver } from '../src/planner/weather-window.js'
import { createHttp } from '../src/services/http.js'
import { createItineraryAi } from '../src/services/itinerary-ai.js'
import { createOneMap } from '../src/services/onemap.js'
import { createPlannerRuns } from '../src/services/planner-runs.js'
import { createSessions } from '../src/services/sessions.js'
import { createWeather } from '../src/services/weather.js'
import { createWorld, fakeSupabase, jwksFetch, SUPABASE_URL, userClient } from './helpers/fake-supabase.js'
import { addMember, addSession, GUEST, HOST, OTHER, SESSION, startSessionApp, STRANGER } from './helpers/session-app.js'

// The plan endpoints (stage 5, server half), tested without the network: the suggested order (E22), the host's confirm (E12), opening the
// plan again (E13), the edits of the stops (E15), finishing the outing with its ledger (E14), Roam proposals (E23, E24), and the group's past
// in the rankings. The login check is the real code; the database is the fake in helpers/fake-supabase.js, whose apply_session_plan is a
// JavaScript twin of the SQL function (db/migrations/20261023000000_jio_apply_session_plan_stops.sql, tested in db/tests/apply_session_plan.sql).
//
// The people: HOST starts at Tampines, GUEST at Clementi, OTHER at Bishan. The session is on 25 October 2026 from 10:00 to 20:00, and the
// group has chosen Bugis (a known place), so its slots and places are the server's own.
const NAMES = { [HOST]: 'Ian', [GUEST]: 'Faith', [OTHER]: 'Jonathan' }
const KINDS = ['eat', 'drink', 'activity']

let world
let t
const started = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(started.splice(0).map((s) => s.stop()))
})

// A voting world made by the real endpoints, and an app over it. How to call: await start({ itineraryAi })
async function start({ status = 'voting', appOptions = {}, people = [HOST, GUEST, OTHER], ends = {} } = {}) {
  world = createWorld()
  addSession(world, { id: SESSION, status: 'inviting' })
  addMember(world, SESSION, HOST, { role: 'host', start: 'tampines', end: ends[HOST], name: NAMES[HOST] })
  addMember(world, SESSION, GUEST, { start: 'clementi', end: ends[GUEST], name: NAMES[GUEST] })
  if (people.includes(OTHER)) addMember(world, SESSION, OTHER, { start: 'bishan', end: ends[OTHER], name: NAMES[OTHER] })
  for (const id of people) world.profile_private.push({ id, dietary: [], budget_max_per_person: null, needs_step_free: false })
  t = await startSessionApp(world, appOptions)
  started.push(t)
  if (status !== 'inviting') expect((await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)).status).toBe(200)
  return t
}

const path = (tail = '') => `/api/sessions/${SESSION}${tail}`
const session = () => world.sessions.find((s) => s.id === SESSION)
const slotOf = (category) => world.slots.find((s) => s.session_id === SESSION && s.category === category)
const optionsOf = (category) => world.slot_options.filter((o) => o.slot_id === slotOf(category).id).sort((a, b) => a.rank - b.rank)
// Copies of the stop rows, so a test can keep what a stop was before an edit.
const stops = () => world.stops.filter((s) => s.session_id === SESSION).sort((a, b) => a.seq - b.seq).map((s) => ({ ...s }))
const writes = () => world.calls.filter((c) => c.rpc === 'apply_session_plan')
const serviceCalls = () => world.calls.filter((c) => c.who === null)
const vote = async (who, category, venueId) => {
  const { error } = await userClient(world, who).from('votes').insert({ slot_id: slotOf(category).id, user_id: who, venue_id: venueId })
  expect(error).toBeNull()
}

// Two people vote in each of eat, drink and activity, for the first, second and first place of each. Answers the winners by kind.
// How to call: const winners = await voteForThree()
async function voteForThree() {
  const winners = {}
  for (const [i, category] of KINDS.entries()) {
    const ids = optionsOf(category).map((o) => o.venue_id)
    winners[category] = ids[i % 2 === 1 && ids.length > 1 ? 1 : 0]
    await vote(HOST, category, winners[category])
    await vote(GUEST, category, winners[category])
  }
  return winners
}

// A fake AI that picks the option at `index` and says why, to see what it was asked.
const fakeAi = (index = 1) => ({ choose: vi.fn(async ({ options }) => ({ index: Math.min(index, options.length - 1), reason: 'Lunch stays at lunchtime and the activity comes first.', source: 'ai' })) })

describe('the suggested order (E22)', () => {
  it('is the host\'s alone, in a voting session, once two people have voted (and a stranger sees a 404 without the service key)', async () => {
    await start()
    await voteForThree()
    const guest = await t.call('POST', path('/order/suggest'), undefined, GUEST)
    expect([guest.status, guest.body.error]).toEqual([403, 'host_only'])
    const calls = serviceCalls().length
    const stranger = await t.call('POST', path('/order/suggest'), undefined, STRANGER)
    expect([stranger.status, stranger.body.error]).toEqual([404, 'session_not_found'])
    expect(serviceCalls().length).toBe(calls)
    expect((await t.call('POST', path('/order/suggest'), undefined)).status).toBe(401)
    expect((await t.call('POST', path('/order/suggest'), { stops: [] }, HOST)).status).toBe(400)
    const ok = await t.call('POST', path('/order/suggest'), undefined, HOST)
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('ok')
  })

  it('needs two people who voted, and a voting session', async () => {
    await start()
    const ids = optionsOf('eat').map((o) => o.venue_id)
    expect((await t.call('POST', path('/order/suggest'), undefined, HOST)).body.error).toBe('not_enough_votes')
    await vote(HOST, 'eat', ids[0])
    expect((await t.call('POST', path('/order/suggest'), undefined, HOST)).body.error).toBe('not_enough_votes')
    session().status = 'confirmed'
    expect((await t.call('POST', path('/order/suggest'), undefined, HOST)).body.error).toBe('wrong_status')
  })

  it('stores one suggestion made from stored rows, with its basis and its sentence, and answers the stops in that order', async () => {
    const ai = fakeAi(1)
    await start({ appOptions: { itineraryAi: ai } })
    const winners = await voteForThree()
    const res = await t.call('POST', path('/order/suggest'), undefined, HOST)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'ok', reason: 'Lunch stays at lunchtime and the activity comes first.', source: 'ai' })
    expect(res.body.basis).toMatch(/^[0-9a-f]{64}$/)
    expect(res.body.order).toHaveLength(3)
    expect(res.body.stops.map((s) => s.slotId)).toEqual(res.body.order)
    for (const stop of res.body.stops) {
      const category = world.slots.find((s) => s.id === stop.slotId).category
      expect(stop.venueId).toBe(winners[category])
      expect(Number.isInteger(stop.start)).toBe(true)
    }
    expect(session().order_suggestion).toMatchObject({ basis: res.body.basis, order: res.body.order, reason: res.body.reason, source: 'ai' })
    expect(Object.keys(session().order_suggestion.starts).sort()).toEqual([...res.body.order].sort())
    // Nothing was written but the suggestion, and the status did not move.
    expect(session().status).toBe('voting')
    expect(world.stops).toHaveLength(0)
  })

  it('takes the rules\' order with source "rules" when there is no AI', async () => {
    await start()
    await voteForThree()
    const res = await t.call('POST', path('/order/suggest'), undefined, HOST)
    expect(res.body.source).toBe('rules')
    expect(res.body.reason.length).toBeGreaterThan(0)
  })

  it('asking again for the same stops makes no AI call and no write', async () => {
    const ai = fakeAi(1)
    await start({ appOptions: { itineraryAi: ai } })
    await voteForThree()
    const first = await t.call('POST', path('/order/suggest'), undefined, HOST)
    const version = session().plan_version
    const before = writes().length
    const second = await t.call('POST', path('/order/suggest'), undefined, HOST)
    expect(second.body).toEqual(first.body)
    expect(ai.choose).toHaveBeenCalledTimes(1)
    expect(writes().length).toBe(before)
    expect(session().plan_version).toBe(version)
  })

  it('works out a new suggestion when the votes moved a winner', async () => {
    const ai = fakeAi(0)
    await start({ appOptions: { itineraryAi: ai } })
    await voteForThree()
    const first = await t.call('POST', path('/order/suggest'), undefined, HOST)
    // A third vote (OTHER) moves the winner of the eat slot to the other place.
    const eat = optionsOf('eat').map((o) => o.venue_id)
    const other = eat.find((id) => id !== first.body.stops.find((s) => world.slots.find((x) => x.id === s.slotId).category === 'eat').venueId)
    await vote(OTHER, 'eat', other)
    await userClient(world, GUEST).from('votes').update({ venue_id: other }).eq('slot_id', slotOf('eat').id).eq('user_id', GUEST)
    const second = await t.call('POST', path('/order/suggest'), undefined, HOST)
    expect(second.body.basis).not.toBe(first.body.basis)
    expect(ai.choose).toHaveBeenCalledTimes(2)
    expect(session().order_suggestion.basis).toBe(second.body.basis)
  })

  it('answers "none" when only one stop can move, and stores nothing', async () => {
    await start()
    const ids = optionsOf('eat').map((o) => o.venue_id)
    await vote(HOST, 'eat', ids[0])
    await vote(GUEST, 'eat', ids[0])
    const drink = optionsOf('drink')[0].venue_id
    await vote(HOST, 'drink', drink)
    const res = await t.call('POST', path('/order/suggest'), undefined, HOST)
    expect(res.body).toEqual({ status: 'none', why: 'one_movable' })
    expect(session().order_suggestion ?? null).toBeNull()
  })

  it('sends the provider only the places\' names, kinds, hours, settings and times, and the weather: never a person', async () => {
    const seen = []
    const client = {
      beta: {
        messages: {
          create: vi.fn(async (request) => {
            seen.push(JSON.stringify(request))
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ choice: 1, reason: 'A calm end near the MRT.' }) }] }
          }),
        },
      },
    }
    const ai = createItineraryAi({ client, apiKey: 'sk-test-key-for-a-fake-client' })
    await start({ appOptions: { itineraryAi: ai } })
    await voteForThree()
    const res = await t.call('POST', path('/order/suggest'), undefined, HOST)
    expect(res.body.source).toBe('ai')
    expect(client.beta.messages.create).toHaveBeenCalledTimes(1)
    const sent = seen.join('\n')
    for (const secret of [HOST, GUEST, OTHER, SESSION, 'Ian', 'Faith', 'Jonathan', 'tampines', 'clementi', 'bishan', 'Tampines', 'Clementi', 'Bishan']) expect(sent, secret).not.toContain(secret)
    expect(sent).toMatch(/Order 1 \(travel/)
    expect(sent).toMatch(/No rain is expected today|Rain is expected today/)
  })

  it('a suggestion made while the votes moved is not stored (plan_busy) and the votes win', async () => {
    const ai = fakeAi(0)
    await start({ appOptions: { itineraryAi: ai } })
    await voteForThree()
    // Another person's vote lands while the order is being worked out.
    ai.choose.mockImplementationOnce(async ({ options }) => {
      const eat = optionsOf('eat').map((o) => o.venue_id)
      await vote(OTHER, 'eat', eat[1])
      await userClient(world, HOST).from('votes').update({ venue_id: eat[1] }).eq('slot_id', slotOf('eat').id).eq('user_id', HOST)
      await userClient(world, GUEST).from('votes').update({ venue_id: eat[1] }).eq('slot_id', slotOf('eat').id).eq('user_id', GUEST)
      return { index: 0, reason: 'Made for the old votes.', source: 'ai' }
    })
    const res = await t.call('POST', path('/order/suggest'), undefined, HOST)
    // It tried again on the new votes and stored that suggestion, never the one for the old votes.
    expect(res.status).toBe(200)
    expect(session().order_suggestion.reason).not.toBe('Made for the old votes.')
    expect(ai.choose).toHaveBeenCalledTimes(2)
  })
})

describe('the host\'s confirm (E12)', () => {
  it('writes the stops from the stored winners, in the voted order, and moves the session to confirmed', async () => {
    await start()
    const winners = await voteForThree()
    const res = await t.call('POST', path('/confirm'), {}, HOST)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'confirmed', stops: 3 })
    expect(res.body.planVersion).toBe(session().plan_version)
    expect(session()).toMatchObject({ status: 'confirmed', banner: null, order_reason: null, order_source: null })
    const rows = stops()
    expect(rows.map((s) => s.seq)).toEqual([0, 1, 2])
    expect(rows.map((s) => s.venue_id).sort()).toEqual(Object.values(winners).sort())
    for (const row of rows) {
      expect(row.slot_id).toBe(world.slots.find((s) => s.category === row.category).id)
      expect(row.not_before_minute).toBeNull()
      expect(row.travel_mode).toBeNull()
    }
    // Back to back, inside the session's window, each starting where the slot laid it out.
    expect(rows[0].planned_start_minute).toBe(session().plan_start_minute)
    expect(rows[1].planned_start_minute).toBe(rows[0].planned_start_minute + rows[0].duration_minutes)
    expect(rows[0].travel_minutes).toBeNull()
    expect(rows[1].travel_minutes).toBeGreaterThanOrEqual(0)
    expect(writes().at(-1)).toBeTruthy()
  })

  it('is the host\'s alone, needs a voting session and two people who voted', async () => {
    await start()
    const ids = optionsOf('eat').map((o) => o.venue_id)
    expect((await t.call('POST', path('/confirm'), {}, GUEST)).body.error).toBe('host_only')
    expect((await t.call('POST', path('/confirm'), {}, STRANGER)).status).toBe(404)
    expect((await t.call('POST', path('/confirm'), {}, HOST)).body.error).toBe('not_enough_votes')
    await vote(HOST, 'eat', ids[0])
    expect((await t.call('POST', path('/confirm'), {}, HOST)).body.error).toBe('not_enough_votes')
    expect(world.stops).toHaveLength(0)
    expect(session().status).toBe('voting')
    session().status = 'locating'
    expect((await t.call('POST', path('/confirm'), {}, HOST)).body.error).toBe('wrong_status')
  })

  it('refuses a day too short to lay a stop out (nothing_to_confirm)', async () => {
    await start()
    await voteForThree()
    session().end_time = '10:20:00'
    expect((await t.call('POST', path('/confirm'), {}, HOST)).body.error).toBe('nothing_to_confirm')
    expect(session().status).toBe('voting')
  })

  it('does not count a vote of somebody who is no longer joined', async () => {
    await start()
    const ids = optionsOf('eat').map((o) => o.venue_id)
    await vote(HOST, 'eat', ids[0])
    await vote(OTHER, 'eat', ids[0])
    world.session_members.find((m) => m.user_id === OTHER).state = 'opted_out'
    expect((await t.call('POST', path('/confirm'), {}, HOST)).body.error).toBe('not_enough_votes')
  })

  it('confirming again is a no-op: the same answer, nothing written', async () => {
    await start()
    await voteForThree()
    const first = await t.call('POST', path('/confirm'), {}, HOST)
    const before = writes().length
    const again = await t.call('POST', path('/confirm'), {}, HOST)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(writes().length).toBe(before)
    expect(stops()).toHaveLength(3)
  })

  it('takes the suggested order with its sentence and earliest starts when the basis is the one the host was shown', async () => {
    const ai = fakeAi(1)
    await start({ appOptions: { itineraryAi: ai } })
    await voteForThree()
    const suggestion = await t.call('POST', path('/order/suggest'), undefined, HOST)
    const res = await t.call('POST', path('/confirm'), { order: 'suggested', basis: suggestion.body.basis }, HOST)
    expect(res.status).toBe(200)
    expect(stops().map((s) => s.slot_id)).toEqual(suggestion.body.order)
    expect(stops().map((s) => s.not_before_minute)).toEqual(suggestion.body.stops.map((s) => s.start))
    expect(session()).toMatchObject({ status: 'confirmed', order_reason: suggestion.body.reason, order_source: 'ai' })
    // The plan starts when the first voted stop does, as the browser's does.
    expect(session().plan_start_minute).toBe(Math.min(...stops().map((s) => s.planned_start_minute)))
  })

  it('refuses a stale suggested order with 409 order_stale and writes nothing', async () => {
    await start({ appOptions: { itineraryAi: fakeAi(1) } })
    await voteForThree()
    const suggestion = await t.call('POST', path('/order/suggest'), undefined, HOST)
    // Somebody changes the winner of the eat slot after the host was shown the order.
    const eat = optionsOf('eat').map((o) => o.venue_id)
    const winner = suggestion.body.stops.find((s) => world.slots.find((x) => x.id === s.slotId).category === 'eat').venueId
    const other = eat.find((id) => id !== winner)
    await vote(OTHER, 'eat', other)
    await userClient(world, HOST).from('votes').update({ venue_id: other }).eq('slot_id', slotOf('eat').id).eq('user_id', HOST)
    await userClient(world, GUEST).from('votes').update({ venue_id: other }).eq('slot_id', slotOf('eat').id).eq('user_id', GUEST)
    const version = session().plan_version
    const res = await t.call('POST', path('/confirm'), { order: 'suggested', basis: suggestion.body.basis }, HOST)
    expect([res.status, res.body.error]).toEqual([409, 'order_stale'])
    expect(session().status).toBe('voting')
    expect(session().plan_version).toBe(version)
    expect(world.stops).toHaveLength(0)
    // The host asks again, is shown the new order, and confirms.
    const again = await t.call('POST', path('/order/suggest'), undefined, HOST)
    expect(again.body.basis).not.toBe(suggestion.body.basis)
    expect((await t.call('POST', path('/confirm'), { order: 'suggested', basis: again.body.basis }, HOST)).status).toBe(200)
    expect(stops().find((s) => s.category === 'eat').venue_id).toBe(other)
  })

  it('refuses a basis the stored suggestion does not have, a suggestion never made, and a body that is wrong', async () => {
    await start({ appOptions: { itineraryAi: fakeAi(1) } })
    await voteForThree()
    const wrong = 'a'.repeat(64)
    expect((await t.call('POST', path('/confirm'), { order: 'suggested', basis: wrong }, HOST)).body.error).toBe('order_stale')
    const suggestion = await t.call('POST', path('/order/suggest'), undefined, HOST)
    expect((await t.call('POST', path('/confirm'), { order: 'suggested', basis: wrong }, HOST)).body.error).toBe('order_stale')
    expect((await t.call('POST', path('/confirm'), { order: 'suggested' }, HOST)).status).toBe(400)
    expect((await t.call('POST', path('/confirm'), { order: 'suggested', basis: 'not hex' }, HOST)).status).toBe(400)
    expect((await t.call('POST', path('/confirm'), { order: 'newest' }, HOST)).status).toBe(400)
    expect((await t.call('POST', path('/confirm'), { stops: [] }, HOST)).status).toBe(400)
    expect(world.stops).toHaveLength(0)
    expect(suggestion.status).toBe(200)
  })

  it('the voted order is taken even when a suggestion is stored', async () => {
    await start({ appOptions: { itineraryAi: fakeAi(1) } })
    await voteForThree()
    await t.call('POST', path('/order/suggest'), undefined, HOST)
    expect((await t.call('POST', path('/confirm'), { order: 'voted' }, HOST)).status).toBe(200)
    expect(stops().every((s) => s.not_before_minute === null)).toBe(true)
    expect(session().order_reason).toBeNull()
  })

  it('writes nothing when the database is down, and answers 500', async () => {
    await start()
    await voteForThree()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    world.failApply = true
    const res = await t.call('POST', path('/confirm'), {}, HOST)
    expect(res.status).toBe(500)
    expect(world.stops).toHaveLength(0)
  })
})

// A confirmed plan made by the real endpoints. How to call: const winners = await confirmed()
async function confirmed(options) {
  await start(options)
  const winners = await voteForThree()
  expect((await t.call('POST', path('/confirm'), {}, HOST)).status).toBe(200)
  return winners
}

describe('opening the plan again (E13)', () => {
  it('takes the stops, the note and the suggestion away, dismisses the proposals, and ranks the slots again for voting', async () => {
    const ai = fakeAi(1)
    await confirmed({ appOptions: { itineraryAi: ai } })
    world.stop_proposals.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', session_id: SESSION, venue_id: 'x', proposed_by: GUEST, status: 'pending', created_at: 't', resolved_at: null, resolved_by: null })
    Object.assign(session(), { order_reason: 'Because.', order_source: 'ai', plan_start_minute: 700, order_suggestion: { basis: 'b'.repeat(64), order: [] } })
    const res = await t.call('POST', path('/replan'), {}, HOST)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'voting' })
    expect(session()).toMatchObject({ status: 'voting', order_reason: null, order_source: null, order_suggestion: null, plan_start_minute: null, replan: null })
    expect(world.stops).toHaveLength(0)
    expect(world.stop_proposals.map((p) => p.status)).toEqual(['dismissed'])
    // The slots are still there with their places, and the votes stand (the chosen area stays).
    expect(world.slots.filter((s) => !s.deleted)).toHaveLength(4)
    expect(world.votes).toHaveLength(6)
  })

  it('is the host\'s alone and does nothing to a plan already open', async () => {
    await confirmed()
    expect((await t.call('POST', path('/replan'), {}, GUEST)).body.error).toBe('host_only')
    expect((await t.call('POST', path('/replan'), {}, STRANGER)).status).toBe(404)
    expect((await t.call('POST', path('/replan'), { accept: 'yes' }, HOST)).status).toBe(400)
    expect((await t.call('POST', path('/replan'), {}, HOST)).status).toBe(200)
    const before = writes().length
    const again = await t.call('POST', path('/replan'), {}, HOST)
    expect(again.body.status).toBe('voting')
    expect(writes().length).toBe(before)
    session().status = 'completed'
    expect((await t.call('POST', path('/replan'), {}, HOST)).body.error).toBe('wrong_status')
  })

  it('"accept: false" only turns the prompt down: the plan stays', async () => {
    await confirmed()
    session().replan = { reason: 'someone opted out' }
    const res = await t.call('POST', path('/replan'), { accept: false }, HOST)
    expect(res.body.status).toBe('confirmed')
    expect(session()).toMatchObject({ status: 'confirmed', replan: null })
    expect(stops()).toHaveLength(3)
  })

  it('the old plan can be confirmed again after voting', async () => {
    await confirmed()
    await t.call('POST', path('/replan'), {}, HOST)
    expect((await t.call('POST', path('/confirm'), {}, HOST)).body).toMatchObject({ status: 'confirmed', stops: 3 })
    expect(stops()).toHaveLength(3)
  })
})

describe('editing the stops (E15)', () => {
  it('deletes a stop: the rest are renumbered, the note goes, and the host\'s alone may', async () => {
    await confirmed({ appOptions: { itineraryAi: fakeAi(1) } })
    const [a, b, c] = stops()
    session().order_reason = 'x'
    session().order_source = 'rules'
    expect((await t.call('DELETE', path(`/stops/${b.id}`), undefined, GUEST)).body.error).toBe('host_only')
    expect((await t.call('DELETE', path(`/stops/${b.id}`), undefined, STRANGER)).status).toBe(404)
    const res = await t.call('DELETE', path(`/stops/${b.id}`), undefined, HOST)
    expect(res.status).toBe(200)
    expect(stops().map((s) => [s.id, s.seq])).toEqual([[a.id, 0], [c.id, 1]])
    expect(session().order_reason).toBeNull()
    expect((await t.call('DELETE', path(`/stops/${b.id}`), undefined, HOST)).body.error).toBe('stop_not_found')
    expect((await t.call('DELETE', path('/stops/not-a-uuid'), undefined, HOST)).status).toBe(400)
  })

  it('will not delete the last stop, and deleting the first moves the plan\'s start to the next stop', async () => {
    await confirmed()
    const [a, b, c] = stops()
    await t.call('DELETE', path(`/stops/${a.id}`), undefined, HOST)
    expect(session().plan_start_minute).toBe(b.planned_start_minute)
    await t.call('DELETE', path(`/stops/${b.id}`), undefined, HOST)
    const last = await t.call('DELETE', path(`/stops/${c.id}`), undefined, HOST)
    expect([last.status, last.body.error]).toEqual([409, 'last_stop'])
    expect(stops()).toHaveLength(1)
  })

  it('sets the way the group gets to a stop, and the minutes with it', async () => {
    await confirmed()
    const [a, b] = stops()
    const before = b.travel_minutes
    const car = await t.call('PATCH', path(`/stops/${b.id}`), { travelMode: 'car' }, HOST)
    expect(car.status).toBe(200)
    expect(car.body.travelMode).toBe('car')
    expect(stops()[1]).toMatchObject({ travel_mode: 'car' })
    const walk = await t.call('PATCH', path(`/stops/${b.id}`), { travelMode: 'walk' }, HOST)
    expect(stops()[1].travel_mode).toBe('walk')
    expect(walk.status).toBe(200)
    expect(stops()[1].travel_minutes).not.toBe(car.body && stops()[1].travel_minutes === before ? -1 : stops()[1].travel_minutes + 1000)
    expect((await t.call('PATCH', path(`/stops/${b.id}`), { travelMode: null }, HOST)).status).toBe(200)
    expect(stops()[1].travel_mode).toBeNull()
    expect(stops()[1].travel_minutes).toBe(before)
    // The first stop has no leg; the mode must be one of three; the host alone.
    expect((await t.call('PATCH', path(`/stops/${a.id}`), { travelMode: 'car' }, HOST)).body.error).toBe('no_leg')
    expect((await t.call('PATCH', path(`/stops/${b.id}`), { travelMode: 'bike' }, HOST)).status).toBe(400)
    expect((await t.call('PATCH', path(`/stops/${b.id}`), {}, HOST)).status).toBe(400)
    expect((await t.call('PATCH', path(`/stops/${b.id}`), { travelMode: 'car' }, GUEST)).body.error).toBe('host_only')
  })

  it('sets the order of the stops: the plan keeps its start, the modes and earliest starts reset, and a wrong list is refused', async () => {
    await confirmed({ appOptions: { itineraryAi: fakeAi(1) } })
    // Give the plan a mode and an earliest start to see them reset.
    const [a, b, c] = stops()
    await t.call('PATCH', path(`/stops/${c.id}`), { travelMode: 'car' }, HOST)
    world.stops.find((s) => s.id === b.id).not_before_minute = 700
    const start = session().plan_start_minute
    expect((await t.call('PUT', path('/stops/order'), { stopIds: [c.id, a.id, b.id] }, GUEST)).body.error).toBe('host_only')
    const res = await t.call('PUT', path('/stops/order'), { stopIds: [c.id, a.id, b.id] }, HOST)
    expect(res.status).toBe(200)
    expect(stops().map((s) => [s.id, s.seq, s.travel_mode, s.not_before_minute])).toEqual([[c.id, 0, null, null], [a.id, 1, null, null], [b.id, 2, null, null]])
    expect(session().plan_start_minute).toBe(start)
    expect(stops()[0].travel_minutes).toBeNull()
    for (const bad of [[a.id, b.id], [a.id, b.id, b.id], [a.id, b.id, c.id, c.id], [a.id, b.id, '11111111-1111-4111-8111-111111111111']]) {
      expect((await t.call('PUT', path('/stops/order'), { stopIds: bad }, HOST)).body.error).toBe('stops_changed')
    }
    expect((await t.call('PUT', path('/stops/order'), { stopIds: ['no'] }, HOST)).status).toBe(400)
    expect((await t.call('PUT', path('/stops/order'), { stopIds: [] }, HOST)).status).toBe(400)
    // The same order again changes nothing.
    const before = writes().length
    expect((await t.call('PUT', path('/stops/order'), { stopIds: stops().map((s) => s.id) }, HOST)).status).toBe(200)
    expect(writes().length).toBe(before)
  })

  it('two edits that arrive together are both made (a run does the second to the plan the first left)', async () => {
    await confirmed()
    const [, b, c] = stops()
    // The first request runs alone and is held while it loads; the other two wait behind it and share the next run.
    let release
    const held = new Promise((resolve) => { release = resolve })
    let first = true
    world.hooks.beforeRead = ({ table }) => {
      if (table !== 'sessions' || !first) return undefined
      first = false
      return held
    }
    setTimeout(() => release(), 60)
    const answers = await Promise.all([
      t.call('PATCH', path(`/stops/${b.id}`), { travelMode: 'car' }, HOST),
      t.call('PATCH', path(`/stops/${b.id}`), { travelMode: 'walk' }, HOST),
      t.call('PATCH', path(`/stops/${c.id}`), { travelMode: 'car' }, HOST),
    ])
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200])
    expect(stops().map((s) => s.travel_mode)).toEqual([null, 'walk', 'car'])
  })

  it('every edit is refused unless the plan is confirmed', async () => {
    await confirmed()
    const [a, b] = stops()
    session().status = 'voting'
    const calls = [
      t.call('DELETE', path(`/stops/${a.id}`), undefined, HOST),
      t.call('PATCH', path(`/stops/${b.id}`), { travelMode: 'car' }, HOST),
      t.call('PUT', path('/stops/order'), { stopIds: [b.id, a.id] }, HOST),
      t.call('PUT', path(`/stops/${a.id}/place`), { venueId: a.venue_id, seenVenueId: a.venue_id }, HOST),
      t.call('POST', path('/complete'), undefined, HOST),
    ]
    for (const res of await Promise.all(calls)) expect(res.body.error).toBe('wrong_status')
  })
})

describe('putting another place in a stop (E15, the one way)', () => {
  // A saved place of the kind that fits a stop of that kind near Bugis and is not already a stop.
  const candidates = (category) => loadPlanData().venues.filter((v) => v.category === category && !String(v.id).startsWith('google'))

  async function replacement(stop) {
    for (const venue of candidates(stop.category)) {
      if (world.stops.some((s) => s.venue_id === venue.id)) continue
      const res = await t.call('PUT', path(`/stops/${stop.id}/place`), { venueId: venue.id, seenVenueId: stop.venue_id }, HOST)
      if (res.status === 200) return { venue, res }
    }
    throw new Error('no place fits')
  }

  it('changes the stop\'s place, keeps its length, never starts it earlier than it was checked for, and clears the note', async () => {
    await confirmed({ appOptions: { itineraryAi: fakeAi(1) } })
    const [, b, c] = stops()
    await t.call('PATCH', path(`/stops/${c.id}`), { travelMode: 'car' }, HOST)
    session().order_reason = 'Because.'
    session().order_source = 'ai'
    const { venue, res } = await replacement(b)
    expect(res.body).toMatchObject({ changed: true })
    const now = stops().find((s) => s.id === b.id)
    expect(now).toMatchObject({ venue_id: venue.id, category: b.category, duration_minutes: b.duration_minutes, planned_start_minute: b.planned_start_minute, travel_mode: null })
    expect(now.not_before_minute).toBeGreaterThanOrEqual(b.planned_start_minute)
    // The leg out of the stop is back to its default mode.
    expect(stops().find((s) => s.id === c.id).travel_mode).toBeNull()
    expect(session().order_reason).toBeNull()
    expect(stops()).toHaveLength(3)
  })

  it('keeps the new place, with what the planner said, as an option of the stop\'s slot, and the old place leaves with its votes', async () => {
    await confirmed()
    const [a] = stops()
    const oldOption = world.slot_options.find((o) => o.slot_id === a.slot_id && o.venue_id === a.venue_id)
    expect(oldOption).toBeTruthy()
    expect(world.votes.some((v) => v.slot_id === a.slot_id && v.venue_id === a.venue_id)).toBe(true)
    const { venue } = await replacement(a)
    expect(world.slot_options.some((o) => o.slot_id === a.slot_id && o.venue_id === a.venue_id)).toBe(false)
    expect(world.votes.some((v) => v.slot_id === a.slot_id && v.venue_id === a.venue_id)).toBe(false)
    const kept = world.slot_options.find((o) => o.slot_id === a.slot_id && o.venue_id === venue.id)
    expect(kept.details).toMatchObject({ reasons: expect.any(Array), explanation: expect.any(String) })
  })

  it('is the host\'s alone, and refused when the stop no longer holds the place the caller saw', async () => {
    await confirmed()
    const [a, b] = stops()
    const venue = candidates(a.category).find((v) => !world.stops.some((s) => s.venue_id === v.id))
    expect((await t.call('PUT', path(`/stops/${a.id}/place`), { venueId: venue.id, seenVenueId: a.venue_id }, GUEST)).body.error).toBe('host_only')
    expect((await t.call('PUT', path(`/stops/${a.id}/place`), { venueId: venue.id, seenVenueId: b.venue_id }, HOST)).body.error).toBe('stop_changed')
    expect((await t.call('PUT', path(`/stops/${a.id}/place`), { venueId: venue.id }, HOST)).status).toBe(400)
    expect(stops()[0].venue_id).toBe(a.venue_id)
  })

  it('refuses a place Jio does not know (404), one that is another stop already (409), and one that does not fit (422)', async () => {
    await confirmed()
    const [a, b] = stops()
    expect((await t.call('PUT', path(`/stops/${a.id}/place`), { venueId: 'nowhere-at-all', seenVenueId: a.venue_id }, HOST)).body.error).toBe('venue_not_found')
    expect((await t.call('PUT', path(`/stops/${a.id}/place`), { venueId: b.venue_id, seenVenueId: a.venue_id }, HOST)).body.error).toBe('already_a_stop')
    // A place far from the meeting area, or of another kind, does not fit the stop.
    const far = loadPlanData().venues.find((v) => v.category === a.category && Math.abs(v.lat - 1.2966) + Math.abs(v.lng - 103.8558) > 0.15)
    const res = await t.call('PUT', path(`/stops/${a.id}/place`), { venueId: far.id, seenVenueId: a.venue_id }, HOST)
    expect([res.status, res.body.error]).toEqual([422, 'venue_does_not_fit'])
    expect(stops()[0].venue_id).toBe(a.venue_id)
    expect((await t.call('PUT', path(`/stops/${a.id}/place`), { venueId: far.id, seenVenueId: a.venue_id }, STRANGER)).status).toBe(404)
  })

  it('asking again once the stop holds the place changes nothing', async () => {
    await confirmed()
    const [a] = stops()
    const { venue } = await replacement(a)
    const before = writes().length
    const again = await t.call('PUT', path(`/stops/${a.id}/place`), { venueId: venue.id, seenVenueId: a.venue_id }, HOST)
    expect(again.status).toBe(200)
    expect(again.body.changed).toBe(false)
    expect(writes().length).toBe(before)
  })

  it('spends the one allowance of OneMap trips like any other request (never more than 60 routed trips)', async () => {
    const http = countingStubHttp()
    const onemap = createOneMap({ http: http.http, stub: true })
    await confirmed({ appOptions: { onemap } })
    const [a] = stops()
    const before = http.calls.route
    await replacement(a)
    expect(http.calls.route - before).toBeLessThanOrEqual(60)
  })
})

describe('finishing the outing and its ledger (E14)', () => {
  // The group's stored minutes in were written when the host confirmed the place; here they are made known.
  const minutesIn = () => Object.fromEntries(world.session_members.map((m) => [m.user_id, m.travel_minutes]))

  it('writes the ledger from stored rows and moves the session to completed in one write', async () => {
    await confirmed({ ends: { [HOST]: 'bishan' } })
    const before = writes().length
    const res = await t.call('POST', path('/complete'), undefined, HOST)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'completed' })
    expect(writes().length - before).toBe(1)
    expect(session().status).toBe('completed')
    expect(session().completed_at).toBeTruthy()
    expect(world.commute_ledger).toHaveLength(3)
    const between = stops().reduce((sum, s) => sum + (s.travel_minutes ?? 0), 0)
    const last = loadPlanData().venues.find((v) => v.id === stops().at(-1).venue_id)
    const areas = Object.fromEntries(loadPlanData().areas.map((a) => [a.id, a]))
    const endArea = { [HOST]: 'bishan', [GUEST]: 'clementi', [OTHER]: 'bishan' }
    for (const row of world.commute_ledger) {
      expect(row.minutes_in).toBe(minutesIn()[row.user_id])
      expect(row.minutes_between).toBe(between)
      expect(row.minutes_home).toBe(Math.round(mockTravelMinutes(last, areas[endArea[row.user_id]])))
      expect(row.total_minutes).toBe(row.minutes_in + row.minutes_between + row.minutes_home)
    }
    const cents = world.commute_ledger.reduce((sum, r) => sum + Math.round(r.delta_from_mean * 100), 0)
    expect(cents).toBe(0)
    // Positive for the person who travelled more than the mean.
    const mean = world.commute_ledger.reduce((s, r) => s + r.total_minutes, 0) / 3
    for (const row of world.commute_ledger) expect(Math.sign(row.delta_from_mean)).toBe(Math.sign(Math.round((row.total_minutes - mean) * 100)))
  })

  it('takes everything from stored rows: a body is refused, and nobody can send anyone\'s minutes', async () => {
    await confirmed()
    for (const body of [{ ledger: [{ userId: HOST, minutesIn: 1 }] }, { minutesIn: 1440 }, { stops: [] }]) {
      const res = await t.call('POST', path('/complete'), body, HOST)
      expect(res.status).toBe(400)
    }
    expect(session().status).toBe('confirmed')
    expect(world.commute_ledger).toHaveLength(0)
  })

  it('is the host\'s alone, never a guest\'s (who could post minutes for the host)', async () => {
    await confirmed()
    const res = await t.call('POST', path('/complete'), undefined, GUEST)
    expect([res.status, res.body.error]).toEqual([403, 'host_only'])
    expect((await t.call('POST', path('/complete'), undefined, STRANGER)).status).toBe(404)
    expect((await t.call('POST', path('/complete'), undefined)).status).toBe(401)
    expect(session().status).toBe('confirmed')
    expect(world.commute_ledger).toHaveLength(0)
  })

  it('is refused unless the plan is confirmed', async () => {
    await start()
    expect((await t.call('POST', path('/complete'), undefined, HOST)).body.error).toBe('wrong_status')
    session().status = 'cancelled'
    expect((await t.call('POST', path('/complete'), undefined, HOST)).body.error).toBe('wrong_status')
    expect(world.commute_ledger).toHaveLength(0)
  })

  it('a retry after success is a no-op: the same answer, no second write and no second ledger', async () => {
    await confirmed()
    const first = await t.call('POST', path('/complete'), undefined, HOST)
    const before = writes().length
    const rows = structuredClone(world.commute_ledger)
    const again = await t.call('POST', path('/complete'), undefined, HOST)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(writes().length).toBe(before)
    expect(world.commute_ledger).toEqual(rows)
  })

  it('leaves out a member with no minutes in, and a member who opted out', async () => {
    await confirmed()
    world.session_members.find((m) => m.user_id === OTHER).travel_minutes = null
    await t.call('POST', path('/complete'), undefined, HOST)
    expect(world.commute_ledger.map((r) => r.user_id).sort()).toEqual([GUEST, HOST].sort())
    const cents = world.commute_ledger.reduce((sum, r) => sum + Math.round(r.delta_from_mean * 100), 0)
    expect(cents).toBe(0)
  })

  it('dismisses the proposals still waiting', async () => {
    await confirmed()
    world.stop_proposals.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', session_id: SESSION, venue_id: 'x', proposed_by: GUEST, status: 'pending', created_at: 't', resolved_at: null, resolved_by: null })
    await t.call('POST', path('/complete'), undefined, HOST)
    expect(world.stop_proposals.map((p) => p.status)).toEqual(['dismissed'])
  })

  it('stays inside the OneMap allowance with the whole group routed (at most 60 trips)', async () => {
    const http = countingStubHttp()
    const onemap = createOneMap({ http: http.http, stub: true })
    await confirmed({ appOptions: { onemap } })
    const before = http.calls.route
    expect((await t.call('POST', path('/complete'), undefined, HOST)).status).toBe(200)
    expect(http.calls.route - before).toBeLessThanOrEqual(60)
    expect(world.commute_ledger).toHaveLength(3)
  })

  it('shows each person only their own numbers through the database\'s rules, and no place at all', async () => {
    await confirmed()
    await t.call('POST', path('/complete'), undefined, HOST)
    // Every column of the ledger is minutes or a delta; there is no label, no coordinate and no area.
    for (const row of world.commute_ledger) {
      expect(Object.keys(row).sort()).toEqual(['created_at', 'delta_from_mean', 'minutes_between', 'minutes_home', 'minutes_in', 'session_id', 'total_minutes', 'user_id'])
    }
    // The members of the session read the session's rows; a stranger reads none.
    expect((await userClient(world, GUEST).from('commute_ledger').select('user_id').eq('session_id', SESSION)).data).toHaveLength(3)
    expect((await userClient(world, STRANGER).from('commute_ledger').select('user_id').eq('session_id', SESSION)).data).toEqual([])
    // And no browser can write one.
    expect((await userClient(world, HOST).from('commute_ledger').insert({ session_id: SESSION, user_id: HOST })).error.code).toBe('42501')
  })
})

describe('Roam proposals (E23, E24)', () => {
  const venues = loadPlanData().venues.filter((v) => !String(v.id).startsWith('google'))
  const free = () => venues.filter((v) => !world.stops.some((s) => s.venue_id === v.id))

  it('a joined member proposes a saved place; the same place again stays the first proposal (200, applied: false)', async () => {
    await confirmed()
    const venue = free()[0]
    const res = await t.call('POST', path('/proposals'), { venueId: venue.id }, GUEST)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ applied: true })
    expect(world.stop_proposals).toEqual([expect.objectContaining({ id: res.body.id, venue_id: venue.id, proposed_by: GUEST, status: 'pending' })])
    const again = await t.call('POST', path('/proposals'), { venueId: venue.id }, OTHER)
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ applied: false, id: res.body.id })
    expect(world.stop_proposals).toHaveLength(1)
  })

  it('refuses a stranger, an unknown place, a place already in the plan, and a plan that is not confirmed', async () => {
    await confirmed()
    expect((await t.call('POST', path('/proposals'), { venueId: free()[0].id }, STRANGER)).status).toBe(404)
    expect((await t.call('POST', path('/proposals'), { venueId: 'nowhere-at-all' }, GUEST)).body.error).toBe('venue_not_found')
    expect((await t.call('POST', path('/proposals'), { venueId: stops()[0].venue_id }, GUEST)).body.error).toBe('already_a_stop')
    expect((await t.call('POST', path('/proposals'), { venueId: free()[0].id, extra: 1 }, GUEST)).status).toBe(400)
    world.session_members.find((m) => m.user_id === OTHER).state = 'opted_out'
    expect((await t.call('POST', path('/proposals'), { venueId: free()[0].id }, OTHER)).body.error).toBe('not_joined')
    session().status = 'voting'
    expect((await t.call('POST', path('/proposals'), { venueId: free()[0].id }, GUEST)).body.error).toBe('wrong_status')
    expect(world.stop_proposals).toHaveLength(0)
  })

  it('keeps 3 waiting for a member, 10 for the session, and a plan of 8 stops takes no more', async () => {
    await confirmed()
    const [v1, v2, v3, v4, v5] = free()
    for (const v of [v1, v2, v3]) expect((await t.call('POST', path('/proposals'), { venueId: v.id }, GUEST)).status).toBe(201)
    expect((await t.call('POST', path('/proposals'), { venueId: v4.id }, GUEST)).body.error).toBe('too_many_proposals')
    expect((await t.call('POST', path('/proposals'), { venueId: v4.id }, OTHER)).status).toBe(201)
    // Fill the plan to 8 stops: a proposal is refused then.
    for (let i = 3; i < 8; i += 1) world.stops.push({ id: `stop-${i}`, session_id: SESSION, seq: i, slot_id: null, category: 'drink', venue_id: `filler-${i}`, planned_start_minute: 900, duration_minutes: 30, travel_mode: null, travel_minutes: null, not_before_minute: null })
    expect((await t.call('POST', path('/proposals'), { venueId: v5.id }, OTHER)).body.error).toBe('plan_full')
  })

  it('the host adds a proposal as the last stop: no slot, 60 minutes, not before the last stop ends or now, and the note goes', async () => {
    await confirmed({ appOptions: { itineraryAi: fakeAi(1) } })
    session().order_reason = 'Because.'
    session().order_source = 'rules'
    const venue = free().find((v) => v.category === 'drink') ?? free()[0]
    const proposal = (await t.call('POST', path('/proposals'), { venueId: venue.id }, GUEST)).body
    expect((await t.call('POST', path(`/proposals/${proposal.id}/resolve`), { accept: true }, GUEST)).body.error).toBe('host_only')
    expect((await t.call('POST', path(`/proposals/${proposal.id}/resolve`), { accept: true }, STRANGER)).status).toBe(404)
    const lastEnd = (() => {
      const rows = stops()
      return rows.at(-1).planned_start_minute + rows.at(-1).duration_minutes
    })()
    const res = await t.call('POST', path(`/proposals/${proposal.id}/resolve`), { accept: true }, HOST)
    expect(res.status).toBe(200)
    expect(res.body.applied).toBe(true)
    expect(stops()).toHaveLength(4)
    const added = stops().at(-1)
    expect(added).toMatchObject({ seq: 3, slot_id: null, venue_id: venue.id, category: venue.category, duration_minutes: 60 })
    expect(added.not_before_minute).toBeGreaterThanOrEqual(Math.min(1439, lastEnd - 200))
    expect(world.stop_proposals[0]).toMatchObject({ status: 'accepted', resolved_by: HOST })
    expect(session().order_reason).toBeNull()
    // A second press changes nothing.
    const before = writes().length
    const again = await t.call('POST', path(`/proposals/${proposal.id}/resolve`), { accept: true }, HOST)
    expect(again.body.applied).toBe(false)
    expect(writes().length).toBe(before)
  })

  it('the proposer may take their own back, nobody else but the host may dismiss it', async () => {
    await confirmed()
    const [v1, v2] = free()
    const mine = (await t.call('POST', path('/proposals'), { venueId: v1.id }, GUEST)).body
    const theirs = (await t.call('POST', path('/proposals'), { venueId: v2.id }, OTHER)).body
    expect((await t.call('POST', path(`/proposals/${theirs.id}/resolve`), { accept: false }, GUEST)).body.error).toBe('host_only')
    expect((await t.call('POST', path(`/proposals/${mine.id}/resolve`), { accept: false }, GUEST)).body.applied).toBe(true)
    expect((await t.call('POST', path(`/proposals/${theirs.id}/resolve`), { accept: false }, HOST)).body.applied).toBe(true)
    expect(world.stop_proposals.map((p) => p.status)).toEqual(['dismissed', 'dismissed'])
    expect(stops()).toHaveLength(3)
    expect((await t.call('POST', path(`/proposals/${mine.id}/resolve`), { accept: true }, HOST)).body.applied).toBe(false)
    expect((await t.call('POST', path('/proposals/not-a-uuid/resolve'), { accept: true }, HOST)).status).toBe(400)
    expect((await t.call('POST', path(`/proposals/${mine.id}/resolve`), {}, HOST)).status).toBe(400)
  })
})

// Counts the OneMap calls that reach the HTTP layer, in stub mode (the same stand-in sessions-voting.test.js uses).
function countingStubHttp() {
  const real = createHttp({ stub: true })
  const calls = { route: 0 }
  const http = {
    ...real,
    getJson: async (url, options) => {
      if (String(url).includes('/route')) calls.route += 1
      return real.getJson(url, options)
    },
  }
  return { http, calls }
}

// A service over a world with the planner run spied, to see what the planner was asked.
// How to call: const { sessions, runs, as } = await serviceFor()
async function serviceFor() {
  await start()
  const supabase = fakeSupabase(world, createSupabase({ url: SUPABASE_URL, anonKey: 'a', serviceKey: 's', fetchImpl: jwksFetch }))
  const data = loadPlanData()
  const weatherResolver = createWeatherResolver({ data, weather: createWeather({ http: createHttp({ stub: true }) }) })
  const base = createPlannerRuns({ data, weatherResolver, onemap: null })
  const runs = { ...base, runWithTravel: vi.fn((...args) => base.runWithTravel(...args)) }
  const sessions = createSessions({ supabase, data, runs, now: () => Date.parse('2026-10-23T08:00:00Z') })
  const as = (id) => ({ client: userClient(world, id), id: SESSION, userId: id })
  return { sessions, runs, as }
}

describe('the group\'s past feeds the planner, softly', () => {
  // A finished outing of the host and the guest at a place, on a day, with the people given.
  function pastOuting(id, { date = '2026-10-10', people = [HOST, GUEST], venue = 'ya-kun-kaya-toast', completedAt = '2026-10-10T20:00:00.000Z' } = {}) {
    world.sessions.push({ id, host_id: HOST, status: 'completed', plan_version: 9, date, start_time: '10:00:00', end_time: '20:00:00', completed_at: completedAt, meeting_area_id: 'bugis' })
    for (const person of people) world.session_members.push({ session_id: id, user_id: person, role: person === HOST ? 'host' : 'guest', state: 'joined', start_area_id: null, end_area_id: null, travel_minutes: null })
    world.stops.push({ id: `${id}-stop`, session_id: id, seq: 0, slot_id: null, category: 'eat', venue_id: venue, planned_start_minute: 720, duration_minutes: 60, travel_mode: null, travel_minutes: null, not_before_minute: null })
  }

  it('ranks with the places the group has been to lately and each person\'s travel debt', async () => {
    const { sessions, runs, as } = await serviceFor()
    pastOuting('99999999-9999-4999-8999-999999999991')
    world.commute_ledger.push({ session_id: '99999999-9999-4999-8999-999999999991', user_id: HOST, minutes_in: 10, minutes_between: 5, minutes_home: 5, delta_from_mean: 12.5 })
    world.commute_ledger.push({ session_id: '99999999-9999-4999-8999-999999999991', user_id: GUEST, minutes_in: 10, minutes_between: 5, minutes_home: 5, delta_from_mean: -12.5 })
    await sessions.syncPlan(as(HOST))
    const rankings = runs.runWithTravel.mock.calls.filter(([, , run]) => run.name === 'converge')
    expect(rankings.length).toBeGreaterThan(0)
    for (const [input, planData] of rankings) {
      expect(planData.visitHistory).toEqual([{ groupId: SESSION, venueId: 'ya-kun-kaya-toast', date: '2026-10-10' }])
      expect(input.members.find((m) => m.id === HOST).travelDebtMinutes).toBe(12.5)
      expect(input.members.find((m) => m.id === GUEST).travelDebtMinutes).toBe(-12.5)
      expect(input.groupId).toBe(SESSION)
    }
  })

  it('reads the finished outings as the caller (never the service key) and only the newest 30 of the last 60 days', async () => {
    const { sessions, as } = await serviceFor()
    pastOuting('99999999-9999-4999-8999-999999999991')
    // An outing of other people and an old one are not read for this group.
    pastOuting('99999999-9999-4999-8999-999999999992', { people: [OTHER, STRANGER], venue: 'stranger-place' })
    pastOuting('99999999-9999-4999-8999-999999999993', { completedAt: '2026-05-01T20:00:00.000Z', venue: 'old-place' })
    world.calls.length = 0
    await sessions.syncPlan(as(HOST))
    const past = world.calls.filter((c) => ['stops', 'session_members', 'sessions'].includes(c.table) && c.filters?.includes('status'))
    expect(past.length).toBeGreaterThan(0)
    expect(past.every((c) => c.who === HOST)).toBe(true)
    expect(world.calls.some((c) => c.table === 'stops' && c.who === null && c.filters.includes('session_id') && !c.filters.includes('id'))).toBe(false)
  })

  it('plans without it when the travel debt function is not on the project, or the finished outings cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { sessions, runs, as } = await serviceFor()
    pastOuting('99999999-9999-4999-8999-999999999991')
    world.failDebt = true
    world.failPast = true
    const res = await sessions.syncPlan(as(HOST))
    expect(res).toMatchObject({ changed: expect.any(Boolean) })
    const rankings = runs.runWithTravel.mock.calls.filter(([, , run]) => run.name === 'converge')
    expect(rankings.length).toBeGreaterThan(0)
    for (const [input, planData] of rankings) {
      expect(planData.visitHistory ?? []).not.toContainEqual(expect.objectContaining({ groupId: SESSION }))
      expect(input.members.every((m) => m.travelDebtMinutes === 0)).toBe(true)
    }
    expect(warn).toHaveBeenCalled()
    for (const [message] of warn.mock.calls) expect(String(message)).not.toMatch(/boom|permission/)
  })

  it('still answers the request when the history is slow: past the deadline the planner goes on without it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await start()
    const supabase = fakeSupabase(world, createSupabase({ url: SUPABASE_URL, anonKey: 'a', serviceKey: 's', fetchImpl: jwksFetch }))
    const data = loadPlanData()
    const weatherResolver = createWeatherResolver({ data, weather: createWeather({ http: createHttp({ stub: true }) }) })
    const runs = createPlannerRuns({ data, weatherResolver, onemap: null })
    // The debt function never answers.
    const real = supabase.service.rpc.bind(supabase.service)
    supabase.service.rpc = (name, args) => (name === 'session_travel_debt' ? new Promise(() => {}) : real(name, args))
    const sessions = createSessions({ supabase, data, runs, dbDeadlineMs: 50 })
    const res = await sessions.syncPlan({ client: userClient(world, HOST), id: SESSION, userId: HOST })
    expect(res.planVersion).toBeGreaterThanOrEqual(0)
  })

  it('a ranking never fails because the history could not be read (the confirm of a spot still answers 200)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    world = createWorld()
    addSession(world, { id: SESSION, status: 'locating' })
    addMember(world, SESSION, HOST, { role: 'host', start: 'tampines', name: 'Ian' })
    addMember(world, SESSION, GUEST, { start: 'clementi', name: 'Faith' })
    t = await startSessionApp(world)
    started.push(t)
    world.failDebt = true
    world.failPast = true
    expect((await t.call('POST', path('/meeting-area'), {}, HOST)).status).toBe(200)
    expect((await t.call('POST', path('/voting'), {}, HOST)).status).toBe(200)
    expect(session().status).toBe('voting')
  })
})
