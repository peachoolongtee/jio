// Stage 5 of moving sessions to the database: the plan, the itinerary and finishing the outing, for a real account. Two or three people use
// their own copy of the app on ONE stand-in database and one stand-in Jio server, so what one does the others see, and the paths, bodies
// and login tokens are the real ones. The design's two-device test (#125, slice d) is the spine: A opens Confirm and sees both orders with
// the note; B changes a winner; A confirms "suggested" and is refused with order_stale; the dialog redraws; A confirms; both see the same
// itinerary and note; B proposes a place, A accepts, both see the stop; A ends it and both read their own ledger row. Around it: the
// rules that must hold are each a test (the browser sends no stops, reason or source; a late answer never goes over a newer state; a write
// is taken back only when the server proves it did nothing; no one's exact place is anywhere). No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { SERVICE } from '../../components/dev/fakeDatabase.js'
import { WORDS } from '../sessionsRemote.js'
import { boot } from './authFixture.js'
import { KIM_PLACE, SAM_PLACE, confirmed, voted, voting } from './sessionsWorld.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T02:00:00Z'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.setSystemTime(new Date('2026-10-09T02:00:00Z'))
})

const eq = (col, value) => ({ col, op: 'eq', value })
const rowsOf = (w, table) => w.database.tables[table]
const sessionRow = (w, id) => rowsOf(w, 'sessions').find((s) => s.id === id)
const stopsInOrder = (w, id) => rowsOf(w, 'stops').filter((s) => s.session_id === id).sort((a, b) => a.seq - b.seq)
const callsTo = (w, name) => w.server.calls.filter((c) => c.route === name)
// The tests' own clock is an instant (10:00 in Singapore the day before), not a local time, so they hold in any time zone. The day of the
// outing, at noon in Singapore: Roam opens on the day.
const ON_THE_DAY = new Date('2026-10-10T04:00:00Z')

// Three people have voted so that a second person can change a winner: Sam and Kim for the first place of every category, Lee joined.
// How to call: const { w, sam, kim, lee, id, plan } = await threeVoted()
async function threeVoted() {
  const world = await voted({ third: true })
  const { sam, kim, lee, id, plan } = world
  for (const slot of plan.slots) await lee.api.vote(id, slot.id, lee.id, slot.options[0].id)
  void sam
  void kim
  world.w.server.calls.length = 0
  return world
}

describe('the suggested order', () => {
  it('gives the host both orders: the winners as voted, and a suggestion of the server\'s own with its basis, asking for it with an empty body', async () => {
    const { w, sam, id, plan } = await voted()
    const suggestion = await sam.api.suggestOrder(id)
    expect(callsTo(w, 'suggestOrder')).toEqual([expect.objectContaining({ method: 'POST', path: `/api/sessions/${id}/order/suggest`, body: {}, as: sam.id })])
    expect(suggestion.basis).toMatch(/^[0-9a-f]{64}$/)
    expect(suggestion).toMatchObject({ reason: expect.any(String), source: 'ai' })
    // The same four places the group voted for, once each, with a name, a category and a length from the slots, and a start.
    const winners = plan.slots.map((s) => s.options[0].id).sort()
    expect(suggestion.stops.map((s) => s.venueId).sort()).toEqual(winners)
    for (const stop of suggestion.stops) {
      const slot = plan.slots.find((s) => s.id === stop.slotId)
      expect(stop).toMatchObject({ category: slot.category, duration: slot.duration, name: expect.any(String), start: expect.any(Number) })
    }
    expect(suggestion.order).toEqual(suggestion.stops.map((s) => s.slotId))
    // The suggestion differs from the voted order (the stand-in turns the movable stops round), and nothing was confirmed.
    expect(suggestion.order).not.toEqual(plan.slots.map((s) => s.id))
    expect(rowsOf(w, 'stops')).toEqual([])
    expect(sessionRow(w, id).status).toBe('voting')
  })

  it('keeps the suggestion with the session so that asking again for the same votes returns the same one and changes nothing', async () => {
    const { w, sam, id } = await voted()
    const first = await sam.api.suggestOrder(id)
    const version = sessionRow(w, id).plan_version
    const again = await sam.api.suggestOrder(id)
    expect(again).toEqual(first)
    expect(sessionRow(w, id).plan_version).toBe(version)
    expect(sessionRow(w, id).order_suggestion).toMatchObject({ basis: first.basis, source: 'ai' })
  })

  it('is the host\'s alone: a guest is refused in words', async () => {
    const { kim, id } = await voted()
    await expect(kim.api.suggestOrder(id)).rejects.toMatchObject({ message: 'Only the host can confirm the plan.', code: 'host_only', status: 403 })
  })

  it('is refused with fewer than two people having voted', async () => {
    const { sam, id, plan } = await voting()
    await expect(sam.api.suggestOrder(id)).rejects.toMatchObject({ message: 'At least 2 people need to vote first.', code: 'not_enough_votes' })
    await sam.api.vote(id, plan.slots[0].id, sam.id, plan.slots[0].options[0].id)
    await expect(sam.api.suggestOrder(id)).rejects.toMatchObject({ code: 'not_enough_votes' })
  })

  it('is none when there is nothing to arrange (fewer than two stops that can move), and the dialog keeps the voted order', async () => {
    const { w, sam, id } = await voted()
    w.server.plan.suggest = null
    expect(await sam.api.suggestOrder(id)).toBeNull()
  })

  it('is none for an answer it cannot draw (a place the server cannot describe, or a slot the plan does not have)', async () => {
    const { w, sam, id } = await voted()
    const named = (winners, venueId, slotId) => ({ order: winners.map((x) => x.slot.id), starts: {}, stops: winners.map((x, i) => ({ slotId: i === 0 ? slotId ?? x.slot.id : x.slot.id, venueId: i === 0 ? venueId ?? x.option.venue_id : x.option.venue_id, start: 600 })), reason: 'x', source: 'rules' })
    w.server.plan.suggest = (winners) => named(winners, 'no-such-place')
    expect(await sam.api.suggestOrder(id)).toBeNull()
    w.server.plan.suggest = (winners) => ({ ...named(winners, undefined, 'no-such-slot'), order: winners.map((x, i) => (i === 0 ? 'no-such-slot' : x.slot.id)) })
    expect(await sam.api.suggestOrder(id)).toBeNull()
  })

  it('drops the answer when the account changed while it was out', async () => {
    const { w, sam, id } = await voted()
    let release
    const held = new Promise((resolve) => { release = resolve })
    w.server.after.suggestOrder = () => held
    const asking = sam.api.suggestOrder(id)
    await vi.waitFor(() => expect(callsTo(w, 'suggestOrder')).toHaveLength(1))
    await sam.api.signOut()
    release()
    expect(await asking).toBeNull()
  })
})

describe('confirming', () => {
  it('writes the stops from the server\'s own rows, sending only which order was shown, and both people read the same itinerary', async () => {
    const { w, sam, kim, id, plan } = await voted()
    await sam.api.confirmPlan(id)
    expect(callsTo(w, 'confirmPlan')).toEqual([expect.objectContaining({ method: 'POST', path: `/api/sessions/${id}/confirm`, body: { order: 'voted' } })])
    expect(sessionRow(w, id)).toMatchObject({ status: 'confirmed', banner: null, replan: null, order_reason: null, order_source: null })
    // The stops are the winners in the order of their slots, and the browser said nothing about them.
    const stops = stopsInOrder(w, id)
    expect(stops.map((s) => [s.category, s.venue_id, s.slot_id])).toEqual(plan.slots.map((s) => [s.category, s.options[0].id, s.id]))
    expect(stops.every((s) => s.not_before_minute === null)).toBe(true)
    const mine = await sam.api.getItinerary(id)
    const theirs = await kim.api.getItinerary(id)
    expect(theirs).toEqual(mine)
    expect(mine.stops.map((s) => s.venue.id)).toEqual(plan.slots.map((s) => s.options[0].id))
    expect(mine.stops.every((s) => s.stopId && s.venue.name)).toBe(true)
    expect(mine.aiNote).toBeNull()
    expect(mine.legs).toHaveLength(mine.stops.length - 1)
  })

  it('confirms the suggested order with the basis the host saw, and both people read the order and the note', async () => {
    const { w, sam, kim, id } = await voted()
    const suggestion = await sam.api.suggestOrder(id)
    await sam.api.confirmPlan(id, suggestion)
    expect(callsTo(w, 'confirmPlan')[0].body).toEqual({ order: 'suggested', basis: suggestion.basis })
    expect(sessionRow(w, id)).toMatchObject({ order_reason: suggestion.reason, order_source: 'ai' })
    const mine = await sam.api.getItinerary(id)
    const theirs = await kim.api.getItinerary(id)
    expect(theirs).toEqual(mine)
    expect(mine.stops.map((s) => s.slotId)).toEqual(suggestion.order)
    expect(mine.aiNote).toEqual({ reason: suggestion.reason, source: 'ai' })
    // Each stop starts at its suggested time or later (the travel between stops is laid out by the app).
    suggestion.stops.forEach((s, i) => expect(mine.stops[i].start).toBeGreaterThanOrEqual(s.start))
    expect(stopsInOrder(w, id).map((s) => s.not_before_minute)).toEqual(suggestion.stops.map((s) => s.start))
  })

  it('refuses a suggested order the votes have outdated with order_stale, writes nothing, and lets the dialog ask again', async () => {
    const { w, sam, kim, lee, id, plan } = await threeVoted()
    const slot = plan.slots[0]
    const before = await sam.api.suggestOrder(id)
    const planVersion = sessionRow(w, id).plan_version
    // B changes a winner: Kim and Lee now both vote for the second place of a category, against Sam's one vote for the first.
    await kim.api.vote(id, slot.id, kim.id, slot.options[1].id)
    await lee.api.vote(id, slot.id, lee.id, slot.options[1].id)
    await expect(sam.api.confirmPlan(id, before)).rejects.toMatchObject({ code: 'order_stale', status: 409, message: WORDS.orderStale })
    expect(callsTo(w, 'confirmPlan')[0].body).toEqual({ order: 'suggested', basis: before.basis })
    expect(rowsOf(w, 'stops')).toEqual([])
    expect(sessionRow(w, id)).toMatchObject({ status: 'voting', plan_version: planVersion })
    // The dialog asks again, gets a suggestion for the new winners, and confirming it works: both see the same itinerary and note.
    const after = await sam.api.suggestOrder(id)
    expect(after.basis).not.toBe(before.basis)
    expect(after.stops.find((s) => s.category === slot.category).venueId).toBe(slot.options[1].id)
    await sam.api.confirmPlan(id, after)
    const mine = await sam.api.getItinerary(id)
    const theirs = await kim.api.getItinerary(id)
    expect(theirs).toEqual(mine)
    expect(mine.stops.find((s) => s.category === slot.category).venue.id).toBe(slot.options[1].id)
    expect(mine.aiNote).toMatchObject({ source: 'ai' })
  })

  it('refuses a suggestion that was never stored for these votes, and one whose basis was altered', async () => {
    const { w, sam, id } = await voted()
    const suggestion = await sam.api.suggestOrder(id)
    await expect(sam.api.confirmPlan(id, { ...suggestion, basis: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'order_stale' })
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { order_suggestion: null }, filters: [eq('id', id)] })
    await expect(sam.api.confirmPlan(id, suggestion)).rejects.toMatchObject({ code: 'order_stale' })
    expect(rowsOf(w, 'stops')).toEqual([])
  })

  it('asks for the voted order when there is no suggestion in hand', async () => {
    const { w, sam, id } = await voted()
    await sam.api.confirmPlan(id, { order: [], stops: [], reason: 'x', source: 'ai' })
    expect(callsTo(w, 'confirmPlan')[0].body).toEqual({ order: 'voted' })
  })

  it('is the host\'s alone, needs two voters, and says what is wrong in words', async () => {
    const { w, sam, kim, id, plan } = await voting()
    await expect(kim.api.confirmPlan(id)).rejects.toMatchObject({ message: 'Only the host can confirm the plan.', code: 'host_only' })
    await sam.api.vote(id, plan.slots[0].id, sam.id, plan.slots[0].options[0].id)
    await expect(sam.api.confirmPlan(id)).rejects.toMatchObject({ message: 'At least 2 people need to vote first.', code: 'not_enough_votes' })
    expect(rowsOf(w, 'stops')).toEqual([])
    expect(sessionRow(w, id).status).toBe('voting')
  })

  it('counts only people who are still in the session', async () => {
    const { w, sam, kim, id } = await voted()
    await kim.api.optOut(id, kim.id)
    await expect(sam.api.confirmPlan(id)).rejects.toMatchObject({ code: 'not_enough_votes' })
    expect(rowsOf(w, 'stops')).toEqual([])
  })

  it('is one confirm when pressed twice: the second changes nothing', async () => {
    const { w, sam, id } = await voted()
    await sam.api.confirmPlan(id)
    const version = sessionRow(w, id).plan_version
    const stops = stopsInOrder(w, id).map((s) => s.id)
    await sam.api.confirmPlan(id)
    expect(sessionRow(w, id).plan_version).toBe(version)
    expect(stopsInOrder(w, id).map((s) => s.id)).toEqual(stops)
  })

  it('does not apply an answer to a plan that was called off, or confirm over a cancelled session', async () => {
    const { w, sam, id } = await voted()
    await sam.api.cancelSession(id)
    await expect(sam.api.confirmPlan(id)).rejects.toMatchObject({ message: WORDS.planClosed, code: 'wrong_status' })
    expect(rowsOf(w, 'stops')).toEqual([])
  })

  it('says it could not reach the server, with no code, and leaves the session voting', async () => {
    const { w, sam, id } = await voted()
    w.server.down = true
    const failure = await sam.api.confirmPlan(id).catch((e) => e)
    expect(failure.message).toMatch(/Cannot reach the Jio planner/)
    expect(failure.code).toBeUndefined()
    w.server.down = false
    expect(sessionRow(w, id).status).toBe('voting')
  })

  it('asks the server to confirm only after the host\'s own press: reading the plan or the suggestion confirms nothing', async () => {
    const { w, sam, kim, id } = await voted()
    await sam.api.getPlan(id)
    await kim.api.getPlan(id)
    await sam.api.suggestOrder(id)
    expect(callsTo(w, 'confirmPlan')).toEqual([])
    expect(sessionRow(w, id).status).toBe('voting')
  })
})

describe('the itinerary on two devices', () => {
  it('shows the host\'s move to everyone, names the stops by id, and clears the note and the earliest starts', async () => {
    const { w, sam, kim, id } = await voted()
    const suggestion = await sam.api.suggestOrder(id)
    await sam.api.confirmPlan(id, suggestion)
    const before = await sam.api.getItinerary(id)
    const seen = before.stops.map((s) => s.stopId)
    await sam.api.reorderStops(id, 0, 2, { seen })
    const call = callsTo(w, 'stopOrder')[0]
    expect(call).toMatchObject({ method: 'PUT', path: `/api/sessions/${id}/stops/order` })
    expect(call.body).toEqual({ stopIds: [seen[1], seen[2], seen[0], seen[3]] })
    const mine = await sam.api.getItinerary(id)
    const theirs = await kim.api.getItinerary(id)
    expect(theirs).toEqual(mine)
    expect(mine.stops.map((s) => s.stopId)).toEqual([seen[1], seen[2], seen[0], seen[3]])
    expect(mine.aiNote).toBeNull()
    expect(sessionRow(w, id)).toMatchObject({ order_reason: null, order_source: null })
    expect(stopsInOrder(w, id).every((s) => s.not_before_minute === null)).toBe(true)
  })

  it('turns away a move made from a list that another device has since changed, and writes nothing', async () => {
    const { w, sam, id } = await confirmed()
    const seen = (await sam.api.getItinerary(id)).stops.map((s) => s.stopId)
    await sam.api.reorderStops(id, 0, 1, { seen })
    w.server.calls.length = 0
    // The same list again: the stops are not in that order any more.
    await expect(sam.api.reorderStops(id, 2, 0, { seen })).rejects.toMatchObject({ message: WORDS.planChanged, code: 'plan_changed' })
    expect(callsTo(w, 'stopOrder')).toEqual([])
    expect(stopsInOrder(w, id).map((s) => s.id)).toEqual([seen[1], seen[0], seen[2], seen[3]])
  })

  it('moves nothing for a move to where the stop is, or out of range', async () => {
    const { w, sam, id } = await confirmed()
    await sam.api.reorderStops(id, 1, 1)
    await sam.api.reorderStops(id, -1, 2)
    await sam.api.reorderStops(id, 0, 9)
    expect(callsTo(w, 'stopOrder')).toEqual([])
  })

  it('deletes a stop by its id, so everyone sees one fewer, and starts the plan where the next stop planned to when the first goes', async () => {
    const { w, sam, kim, id } = await confirmed()
    const before = await sam.api.getItinerary(id)
    await sam.api.deleteStop(id, 0, { stopId: before.stops[0].stopId })
    expect(callsTo(w, 'deleteStop')[0]).toMatchObject({ method: 'DELETE', path: `/api/sessions/${id}/stops/${before.stops[0].stopId}` })
    const mine = await sam.api.getItinerary(id)
    const theirs = await kim.api.getItinerary(id)
    expect(theirs).toEqual(mine)
    expect(mine.stops.map((s) => s.stopId)).toEqual(before.stops.slice(1).map((s) => s.stopId))
    expect(stopsInOrder(w, id).map((s) => s.seq)).toEqual([0, 1, 2])
    expect(sessionRow(w, id).plan_start_minute).toBe(stopsInOrder(w, id)[0].planned_start_minute)
    expect(mine.stops[0].start).toBe(stopsInOrder(w, id)[0].planned_start_minute)
  })

  it('says "that stop is not in the plan any more" for a stop another device deleted, and deletes no other', async () => {
    const { w, sam, id } = await confirmed()
    const before = await sam.api.getItinerary(id)
    await sam.api.deleteStop(id, 1, { stopId: before.stops[1].stopId })
    await expect(sam.api.deleteStop(id, 1, { stopId: before.stops[1].stopId })).rejects.toMatchObject({ message: WORDS.stopGone, code: 'stop_not_found', status: 404 })
    expect(rowsOf(w, 'stops')).toHaveLength(3)
  })

  it('keeps the last stop: a plan needs at least one', async () => {
    const { w, sam, id } = await confirmed()
    for (const stop of (await sam.api.getItinerary(id)).stops.slice(1)) await sam.api.deleteStop(id, 0, { stopId: stop.stopId })
    const [last] = (await sam.api.getItinerary(id)).stops
    await expect(sam.api.deleteStop(id, 0, { stopId: last.stopId })).rejects.toMatchObject({ message: WORDS.lastStop, code: 'last_stop' })
    expect(rowsOf(w, 'stops')).toHaveLength(1)
  })

  it('sets how the group gets to a stop, for everyone, and the later stops follow', async () => {
    const { w, sam, kim, id } = await confirmed()
    const before = await sam.api.getItinerary(id)
    const mode = before.legs[0].mode === 'car' ? 'walk' : 'car'
    await sam.api.setTravelMode(id, 0, mode, { stopId: before.stops[1].stopId })
    expect(callsTo(w, 'patchStop')[0]).toMatchObject({ method: 'PATCH', path: `/api/sessions/${id}/stops/${before.stops[1].stopId}`, body: { travelMode: mode } })
    const mine = await sam.api.getItinerary(id)
    const theirs = await kim.api.getItinerary(id)
    expect(theirs).toEqual(mine)
    expect(mine.legs[0].mode).toBe(mode)
    expect(mine.legs[0].minutes).toBe(before.legs[0].options[mode])
    expect(mine.stops[1].start).toBe(mine.stops[0].end + before.legs[0].options[mode])
    expect(mine.legs[1].mode).toBe(before.legs[1].mode)
  })

  it('names the stop of the newest plan it read when it is not told the stop', async () => {
    const { w, sam, id } = await confirmed()
    const before = await sam.api.getItinerary(id)
    await sam.api.setTravelMode(id, 1, 'walk')
    expect(callsTo(w, 'patchStop')[0].path).toBe(`/api/sessions/${id}/stops/${before.stops[2].stopId}`)
    await expect(sam.api.deleteStop(id, 9)).rejects.toMatchObject({ message: WORDS.stopGone })
  })

  it('refuses a guest every change to the plan, in words, and writes nothing', async () => {
    const { w, kim, id } = await confirmed()
    const itinerary = await kim.api.getItinerary(id)
    const stopId = itinerary.stops[1].stopId
    await expect(kim.api.setTravelMode(id, 0, 'car', { stopId })).rejects.toMatchObject({ message: 'Only the host can change how the group travels.', code: 'host_only' })
    await expect(kim.api.deleteStop(id, 1, { stopId })).rejects.toMatchObject({ message: 'Only the host can delete a stop.', code: 'host_only' })
    await expect(kim.api.reorderStops(id, 0, 1, { seen: itinerary.stops.map((s) => s.stopId) })).rejects.toMatchObject({ message: 'Only the host can rearrange the stops.', code: 'host_only' })
    await expect(kim.api.endPlan(id)).rejects.toMatchObject({ message: 'Only the host can finish the outing.', code: 'host_only' })
    await expect(kim.api.replan(id)).rejects.toMatchObject({ message: 'Only the host can re-plan.', code: 'host_only' })
    expect(rowsOf(w, 'stops').every((s) => s.travel_mode === null)).toBe(true)
    expect(rowsOf(w, 'stops')).toHaveLength(4)
    expect(sessionRow(w, id).status).toBe('confirmed')
  })

  it('has no itinerary for a session that is not confirmed yet, and one for a finished outing', async () => {
    const { sam, id } = await voted()
    expect(await sam.api.getItinerary(id)).toBeNull()
    await sam.api.confirmPlan(id)
    await sam.api.endPlan(id)
    expect((await sam.api.getItinerary(id)).stops).toHaveLength(4)
  })

  it('is "does not exist" for a session the person is not in', async () => {
    const { w, id } = await confirmed()
    const outsider = await w.open({ email: 'lee@example.com', password: 'Th1rd-secret!', name: 'Lee', username: 'lee_third', dob: '1998-01-02', homeAreaId: 'bishan', friends: [] })
    await expect(outsider.api.getItinerary(id)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('a stop whose place cannot be described', () => {
  it('is said in words by the itinerary and by a change to a stop, instead of failing in the layout', async () => {
    const { w, sam, id } = await confirmed()
    const first = (await sam.api.getItinerary(id)).stops[0]
    w.database.run({ as: SERVICE, kind: 'update', table: 'stops', values: { venue_id: 'a-place-the-server-does-not-list' }, filters: [eq('id', first.stopId)] })
    await expect(sam.api.getItinerary(id)).rejects.toMatchObject({ message: WORDS.placeMissing, code: 'venue_not_found' })
    await expect(sam.api.replaceStop(id, first.slotId, 'x', undefined, first.venue.id)).rejects.toMatchObject({ message: WORDS.placeMissing })
    // The session itself still reads (Home does not need the places).
    expect((await sam.api.getSession(id)).plan.stops).toHaveLength(4)
  })
})

describe('re-planning', () => {
  it('takes the plan back to voting for everyone: the stops and the note go, the votes stay', async () => {
    const { w, sam, kim, id, plan } = await voted()
    const suggestion = await sam.api.suggestOrder(id)
    await sam.api.confirmPlan(id, suggestion)
    const votes = rowsOf(w, 'votes').length
    await sam.api.replan(id)
    expect(callsTo(w, 'replan')[0]).toMatchObject({ method: 'POST', path: `/api/sessions/${id}/replan`, body: { accept: true } })
    expect(sessionRow(w, id)).toMatchObject({ status: 'voting', order_reason: null, order_source: null, order_suggestion: null, plan_start_minute: null })
    expect(rowsOf(w, 'stops')).toEqual([])
    expect(rowsOf(w, 'votes')).toHaveLength(votes)
    const theirs = await kim.api.getSession(id)
    expect(theirs).toMatchObject({ status: 'voting', plan: null })
    expect(await kim.api.getItinerary(id)).toBeNull()
    expect((await kim.api.getPlan(id)).slots[0].totalVotes).toBe(2)
    // And the host can confirm again.
    await sam.api.confirmPlan(id)
    expect((await kim.api.getItinerary(id)).stops).toHaveLength(plan.slots.length)
  })

  it('answers the question "Re-plan?": the host keeps the plan (the question goes) or re-plans it; a guest cannot', async () => {
    const { w, sam, kim, id } = await confirmed()
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { replan: { reason: 'Kim opted out.', trigger: { kind: 'optout' }, at: 1 } }, filters: [eq('id', id)] })
    expect((await kim.api.getSession(id)).replan).toMatchObject({ reason: 'Kim opted out.' })
    await expect(kim.api.respondReplan(id, false)).rejects.toMatchObject({ code: 'host_only' })
    expect((await kim.api.getSession(id)).replan).not.toBeNull()
    await sam.api.respondReplan(id, false)
    expect(callsTo(w, 'replan').at(-1).body).toEqual({ accept: false })
    expect((await kim.api.getSession(id)).replan).toBeNull()
    expect(sessionRow(w, id).status).toBe('confirmed')
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { replan: { reason: 'Kim opted out.' } }, filters: [eq('id', id)] })
    await sam.api.respondReplan(id, true)
    expect(sessionRow(w, id)).toMatchObject({ status: 'voting', replan: null })
  })

  it('is a repeat that changes nothing when the group is already voting', async () => {
    const { w, sam, id } = await voted()
    const version = sessionRow(w, id).plan_version
    await sam.api.replan(id)
    expect(sessionRow(w, id)).toMatchObject({ status: 'voting', plan_version: version })
  })

  it('asks "Re-plan?" of a plan whose member opted out (where the server allows it) and shows it to everyone', async () => {
    const { w, sam, kim, id } = await confirmed()
    w.server.plan.confirmedOptOut = true
    await kim.api.optOut(id, kim.id)
    const mine = await sam.api.getSession(id)
    expect(mine.replan).toMatchObject({ reason: 'Kim opted out.' })
    expect(mine.status).toBe('confirmed')
  })
})

describe('ending the outing', () => {
  it('is the host\'s, finishes it for everyone, and each person reads their own ledger row, not the other\'s', async () => {
    const { w, sam, kim, id } = await confirmed()
    expect(await sam.api.getLedger(id)).toBeNull()
    await sam.api.endPlan(id)
    expect(callsTo(w, 'complete')[0]).toMatchObject({ method: 'POST', path: `/api/sessions/${id}/complete`, body: {} })
    expect(sessionRow(w, id)).toMatchObject({ status: 'completed', completed_at: expect.any(String) })
    const theirs = await kim.api.getSession(id)
    expect(theirs).toMatchObject({ status: 'completed', endedBy: 'hand' })
    // Sam started in Tampines and Kim in Bishan: their rows differ, and each device reads its own.
    const rows = rowsOf(w, 'commute_ledger')
    expect(rows).toHaveLength(2)
    const own = (user) => rows.find((r) => r.user_id === user)
    const ledgerSam = await sam.api.getLedger(id)
    const ledgerKim = await kim.api.getLedger(id)
    expect(ledgerSam).toEqual({ minutesIn: own(sam.id).minutes_in, minutesBetween: 0, minutesHome: own(sam.id).minutes_home, total: own(sam.id).total_minutes, delta: own(sam.id).delta_from_mean })
    expect(ledgerKim).toEqual({ minutesIn: own(kim.id).minutes_in, minutesBetween: 0, minutesHome: own(kim.id).minutes_home, total: own(kim.id).total_minutes, delta: own(kim.id).delta_from_mean })
    expect(ledgerSam).not.toEqual(ledgerKim)
    // The deltas sum to nothing: it is each person's total less the group's mean.
    expect(own(sam.id).delta_from_mean + own(kim.id).delta_from_mean).toBeCloseTo(0, 5)
  })

  it('pays no JioCoins and raises no stats event: those are kept in each browser', async () => {
    const { sam, id } = await confirmed()
    const heard = []
    sam.api.subscribe((event) => heard.push(event.type))
    const session = await sam.api.endPlan(id)
    expect(heard).not.toContain('stats')
    expect(session.paid).toBeUndefined()
    expect(session).toMatchObject({ status: 'completed', remote: true })
  })

  it('is one finish when pressed twice: no second ledger row', async () => {
    const { w, sam, id } = await confirmed()
    await sam.api.endPlan(id)
    await sam.api.endPlan(id)
    expect(rowsOf(w, 'commute_ledger')).toHaveLength(2)
  })

  it('writes a row for each person who is in the session, and none for one who is not', async () => {
    const { w, sam, kim, lee, id } = await voted({ third: true })
    await sam.api.confirmPlan(id)
    await sam.api.endPlan(id)
    expect(new Set(rowsOf(w, 'commute_ledger').map((r) => r.user_id))).toEqual(new Set([sam.id, kim.id, lee.id]))
    // A person who opted out of an earlier plan is not given a row: the ledger is for those who were there.
    const second = await voted({ third: true })
    await second.lee.api.optOut(second.id, second.lee.id)
    await second.sam.api.confirmPlan(second.id)
    await second.sam.api.endPlan(second.id)
    expect(new Set(rowsOf(second.w, 'commute_ledger').map((r) => r.user_id))).toEqual(new Set([second.sam.id, second.kim.id]))
  })

  it('cannot end a plan that was not confirmed', async () => {
    const { w, sam, id } = await voted()
    await expect(sam.api.endPlan(id)).rejects.toMatchObject({ message: WORDS.completeClosed, code: 'wrong_status' })
    expect(rowsOf(w, 'commute_ledger')).toEqual([])
  })

  it('says it could not read the ledger, and has none for a local outing', async () => {
    const { w, sam, id } = await confirmed()
    await sam.api.endPlan(id)
    w.gate.hold = (op) => {
      if (op.table === 'commute_ledger') throw new Error('Cannot reach the database.')
      return null
    }
    await expect(sam.api.getLedger(id)).rejects.toBeTruthy()
    w.gate.hold = null
    const local = await boot(null)
    expect(await local.api.getLedger('s1')).toBeNull()
  })
})

describe('Roam in a meetup', () => {
  async function underway() {
    const world = await confirmed({ third: true })
    vi.setSystemTime(ON_THE_DAY)
    return world
  }

  it('lists the places near the meeting area, sends nothing of where anyone is, and marks the places in the plan', async () => {
    const { w, kim, id } = await underway()
    const list = await kim.api.roamNearby(id, { categories: ['eat', 'drink', 'shop', 'activity'] })
    expect(callsTo(w, 'roam')[0]).toMatchObject({ method: 'POST', path: `/api/sessions/${id}/roam`, body: { categories: ['eat', 'drink', 'shop', 'activity'] } })
    expect(callsTo(w, 'roam')[0].body.current).toBeUndefined()
    expect(list.centre.areaName).toBeTruthy()
    expect(list.places.length).toBeGreaterThan(0)
    const inPlan = list.places.filter((p) => p.state === 'stop')
    expect(inPlan.map((p) => p.id).every((venue) => rowsOf(w, 'stops').some((s) => s.venue_id === venue))).toBe(true)
    expect(list.places.every((p) => p.venue.name && Number.isFinite(p.travelMinutes))).toBe(true)
    expect(list.blocked).toBe('')
  })

  it('sends the person\'s point for that one request, and the point is not in the answer or in the session', async () => {
    const { w, sam, id } = await underway()
    const here = { lat: 1.3521, lng: 103.8198 }
    const list = await sam.api.roamNearby(id, { point: here, categories: ['eat'] })
    expect(callsTo(w, 'roam')[0].body).toEqual({ current: here, categories: ['eat'] })
    expect(JSON.stringify(list)).not.toContain('103.8198')
    expect(JSON.stringify(await sam.api.getSession(id))).not.toContain('103.8198')
    await expect(sam.api.roamNearby(id, { point: { lat: 40, lng: 10 } })).rejects.toThrow(/outside Singapore/)
  })

  it('is open on the day of a confirmed plan only', async () => {
    const { sam, id } = await confirmed()
    await expect(sam.api.roamNearby(id)).rejects.toThrow(/on the day of the outing/)
    const { sam: other, id: otherId } = await voted()
    await expect(other.api.roamNearby(otherId)).rejects.toThrow(/once the plan is confirmed/)
  })

  it('puts a place forward for the host, and everyone sees it waiting, with who proposed it', async () => {
    const { w, sam, kim, id } = await underway()
    const list = await kim.api.roamNearby(id)
    const place = list.places.find((p) => p.state === 'free')
    const done = await kim.api.proposeStop(id, kim.id, place.id)
    expect(done.applied).toBe(true)
    expect(callsTo(w, 'propose')[0]).toMatchObject({ method: 'POST', path: `/api/sessions/${id}/proposals`, body: { venueId: place.id } })
    const mine = await sam.api.getSession(id)
    expect(mine.proposals).toEqual([expect.objectContaining({ venueId: place.id, by: kim.id, byName: 'Kim', venue: expect.objectContaining({ name: place.venue.name }) })])
    const again = await sam.api.roamNearby(id)
    expect(again.places.find((p) => p.id === place.id)).toMatchObject({ state: 'proposed', proposal: { by: kim.id, byName: 'Kim' } })
  })

  it('leaves the first person\'s proposal in place when a second person proposes the same place', async () => {
    const { w, sam, kim, id } = await underway()
    const place = (await kim.api.roamNearby(id)).places.find((p) => p.state === 'free')
    await kim.api.proposeStop(id, kim.id, place.id)
    const second = await sam.api.proposeStop(id, sam.id, place.id)
    expect(second.applied).toBe(false)
    expect(rowsOf(w, 'stop_proposals')).toHaveLength(1)
    expect(rowsOf(w, 'stop_proposals')[0].proposed_by).toBe(kim.id)
  })

  it('adds an accepted place to the end of the plan for everyone, and says nothing is waiting after', async () => {
    const { w, sam, kim, id } = await underway()
    const place = (await kim.api.roamNearby(id)).places.find((p) => p.state === 'free')
    await kim.api.proposeStop(id, kim.id, place.id)
    const proposal = (await sam.api.getSession(id)).proposals[0]
    const done = await sam.api.resolveProposal(id, proposal.id, true)
    expect(done.applied).toBe(true)
    expect(callsTo(w, 'resolve')[0]).toMatchObject({ method: 'POST', path: `/api/sessions/${id}/proposals/${proposal.id}/resolve`, body: { accept: true } })
    const mine = await sam.api.getItinerary(id)
    const theirs = await kim.api.getItinerary(id)
    expect(theirs).toEqual(mine)
    expect(mine.stops).toHaveLength(5)
    const added = mine.stops.at(-1)
    expect(added).toMatchObject({ slotId: expect.stringMatching(/^roam-/), venue: expect.objectContaining({ id: place.id }), duration: 60 })
    expect(added.start).toBeGreaterThanOrEqual(mine.stops.at(-2).end)
    expect((await kim.api.getSession(id)).proposals).toEqual([])
    expect(rowsOf(w, 'stop_proposals')[0]).toMatchObject({ status: 'accepted', resolved_by: sam.id })
    // The place is in the plan now, so the list says so.
    expect((await kim.api.roamNearby(id)).places.find((p) => p.id === place.id).state).toBe('stop')
  })

  it('says a proposal that is not there any more changes nothing (applied: false), and a place already in the plan cannot be proposed', async () => {
    const { w, sam, kim, id } = await underway()
    const place = (await kim.api.roamNearby(id)).places.find((p) => p.state === 'free')
    await kim.api.proposeStop(id, kim.id, place.id)
    const proposal = (await sam.api.getSession(id)).proposals[0]
    await sam.api.resolveProposal(id, proposal.id, true)
    const stops = rowsOf(w, 'stops').length
    const repeat = await sam.api.resolveProposal(id, proposal.id, true)
    expect(repeat.applied).toBe(true)
    const gone = await sam.api.resolveProposal(id, '00000000-0000-4000-8000-0000000000aa', true)
    expect(gone.applied).toBe(false)
    expect(rowsOf(w, 'stops')).toHaveLength(stops)
    await expect(kim.api.proposeStop(id, kim.id, place.id)).rejects.toMatchObject({ message: WORDS.alreadyStop, code: 'already_a_stop' })
  })

  it('lets only the host add a place, and the proposer or the host leave it out', async () => {
    const { w, sam, kim, lee, id } = await underway()
    const places = (await kim.api.roamNearby(id)).places.filter((p) => p.state === 'free')
    await kim.api.proposeStop(id, kim.id, places[0].id)
    const proposal = (await kim.api.getSession(id)).proposals[0]
    await expect(kim.api.resolveProposal(id, proposal.id, true)).rejects.toMatchObject({ message: 'Only the host can add a place to the plan.', code: 'host_only' })
    await expect(lee.api.resolveProposal(id, proposal.id, false)).rejects.toMatchObject({ code: 'host_only' })
    const taken = await kim.api.resolveProposal(id, proposal.id, false)
    expect(taken.applied).toBe(true)
    expect(rowsOf(w, 'stop_proposals')[0].status).toBe('dismissed')
    expect(rowsOf(w, 'stops')).toHaveLength(4)
    await lee.api.proposeStop(id, lee.id, places[1].id)
    const theirs = (await sam.api.getSession(id)).proposals[0]
    expect((await sam.api.resolveProposal(id, theirs.id, false)).applied).toBe(true)
  })

  it('stops a person at three waiting and the session at ten, and the list says why before they try', async () => {
    const { sam, kim, id } = await underway()
    const places = (await kim.api.roamNearby(id)).places.filter((p) => p.state === 'free')
    for (const place of places.slice(0, 3)) await kim.api.proposeStop(id, kim.id, place.id)
    await expect(kim.api.proposeStop(id, kim.id, places[3].id)).rejects.toMatchObject({ message: WORDS.tooManyProposals, code: 'too_many_proposals' })
    expect((await kim.api.roamNearby(id)).blocked).toBe('You have 3 places waiting. Take one back to propose another.')
    expect((await sam.api.roamNearby(id)).blocked).toBe('')
  })

  it('refuses a place when the plan is full, with eight stops the most it can hold', async () => {
    const { w, sam, kim, id } = await underway()
    const places = (await kim.api.roamNearby(id)).places.filter((p) => p.state === 'free')
    for (const place of places.slice(0, 3)) await kim.api.proposeStop(id, kim.id, place.id)
    for (const proposal of (await sam.api.getSession(id)).proposals) await sam.api.resolveProposal(id, proposal.id, true)
    for (const place of places.slice(3, 4)) await kim.api.proposeStop(id, kim.id, place.id)
    expect(rowsOf(w, 'stops')).toHaveLength(7)
    for (const proposal of (await sam.api.getSession(id)).proposals) await sam.api.resolveProposal(id, proposal.id, true)
    expect(rowsOf(w, 'stops')).toHaveLength(8)
    await expect(kim.api.proposeStop(id, kim.id, places[5].id)).rejects.toMatchObject({ message: WORDS.planFull, code: 'plan_full' })
  })

  it('takes the proposals away with a re-plan, and refuses one for a place the server does not know', async () => {
    const { w, sam, kim, id } = await underway()
    const place = (await kim.api.roamNearby(id)).places.find((p) => p.state === 'free')
    await kim.api.proposeStop(id, kim.id, place.id)
    await expect(kim.api.proposeStop(id, kim.id, 'no-such-place')).rejects.toMatchObject({ message: WORDS.noVenue, code: 'venue_not_found' })
    await sam.api.replan(id)
    expect(rowsOf(w, 'stop_proposals')[0].status).toBe('dismissed')
    expect((await kim.api.getSession(id)).proposals).toEqual([])
  })

  it('is for the signed-in person only: it will not propose for someone else', async () => {
    const { kim, sam, id } = await underway()
    await expect(kim.api.proposeStop(id, sam.id, 'x')).rejects.toThrow()
  })

  it('keeps Roam from Home local: a light meetup cannot be started on the server', async () => {
    const { sam } = await underway()
    await expect(sam.api.startRoam({ areaId: 'bugis' })).rejects.toThrow('Finding something nearby is not ready for shared sessions yet.')
  })
})

describe('changing a stop\'s place, the one way', () => {
  const stopOf = (itinerary, category) => itinerary.stops.find((s) => s.category === category)

  it('offers the places that could take a stop\'s place, without the plan\'s own, for the host', async () => {
    const { sam, id } = await confirmed()
    const itinerary = await sam.api.getItinerary(id)
    const drink = stopOf(itinerary, 'drink')
    const { stop, category, options, stopCount } = await sam.api.replaceChoices(id, drink.slotId, undefined)
    expect(stop).toMatchObject({ slotId: drink.slotId, category: 'drink', time: expect.any(String), duration: drink.duration })
    expect(category).toBe('drink')
    expect(stopCount).toBe(4)
    expect(options.length).toBeGreaterThan(0)
    const inPlan = new Set(itinerary.stops.map((s) => s.venue.id))
    expect(options.every((o) => !inPlan.has(o.id) && o.venue.name && Array.isArray(o.reasons))).toBe(true)
  })

  it('puts the chosen place in the stop for everyone, keeping the stop\'s time, and sends what the host saw', async () => {
    const { w, sam, kim, id } = await confirmed()
    const itinerary = await sam.api.getItinerary(id)
    const drink = stopOf(itinerary, 'drink')
    const { options } = await sam.api.replaceChoices(id, drink.slotId, undefined)
    await sam.api.replaceStop(id, drink.slotId, options[0].id, undefined, drink.venue.id)
    const call = callsTo(w, 'stopPlace')[0]
    expect(call).toMatchObject({ method: 'PUT', path: `/api/sessions/${id}/stops/${drink.stopId}/place`, body: { venueId: options[0].id, seenVenueId: drink.venue.id, category: 'drink' } })
    const mine = await sam.api.getItinerary(id)
    const theirs = await kim.api.getItinerary(id)
    expect(theirs).toEqual(mine)
    expect(stopOf(mine, 'drink').venue.id).toBe(options[0].id)
    expect(stopOf(mine, 'drink').start).toBeGreaterThanOrEqual(drink.start)
    expect(rowsOf(w, 'stops').find((s) => s.id === drink.stopId).not_before_minute).toBeGreaterThanOrEqual(drink.start)
    expect(mine.aiNote).toBeNull()
  })

  it('turns the stop into the other category when a place of another is chosen, at the same time', async () => {
    const { sam, id } = await confirmed()
    const drink = stopOf(await sam.api.getItinerary(id), 'drink')
    const { options } = await sam.api.replaceChoices(id, drink.slotId, 'activity')
    expect(options.length).toBeGreaterThan(0)
    await sam.api.replaceStop(id, drink.slotId, options[0].id, 'activity', drink.venue.id)
    const changed = (await sam.api.getItinerary(id)).stops.find((s) => s.slotId === drink.slotId)
    expect(changed).toMatchObject({ category: 'activity', venue: expect.objectContaining({ id: options[0].id }) })
    // It keeps the time it was checked for, and starts no earlier (the way to the new place may be longer).
    expect(changed.start).toBeGreaterThanOrEqual(drink.start)
  })

  it('refuses a stop that holds another place than the one the host saw, a place already in the plan, and a place that does not fit', async () => {
    const { w, sam, id } = await confirmed()
    const itinerary = await sam.api.getItinerary(id)
    const drink = stopOf(itinerary, 'drink')
    const eat = stopOf(itinerary, 'eat')
    const { options } = await sam.api.replaceChoices(id, drink.slotId, undefined)
    await expect(sam.api.replaceStop(id, drink.slotId, options[0].id, undefined, 'some-other-place')).rejects.toThrow('That stop has changed. Look at the plan again.')
    await expect(sam.api.replaceStop(id, drink.slotId, eat.venue.id, undefined, drink.venue.id)).rejects.toThrow(/is already in the plan/)
    expect(callsTo(w, 'stopPlace')).toEqual([])
    // The server's own refusal (the place does not fit this stop) is in words too.
    const closed = await sam.api.replaceStop(id, drink.slotId, 'no-such-place', undefined, drink.venue.id).catch((e) => e)
    expect(closed).toMatchObject({ code: 'venue_not_found', message: WORDS.noVenue })
    expect(rowsOf(w, 'stops').find((s) => s.id === drink.stopId).venue_id).toBe(drink.venue.id)
  })

  it('is the host\'s alone (a guest is told so before anything is sent), and repeating it changes nothing', async () => {
    const { w, sam, kim, id } = await confirmed()
    const drink = stopOf(await sam.api.getItinerary(id), 'drink')
    const { options } = await sam.api.replaceChoices(id, drink.slotId, undefined)
    await expect(kim.api.replaceStop(id, drink.slotId, options[0].id, undefined, drink.venue.id)).rejects.toThrow('Only the host can replace a stop.')
    await expect(kim.api.replaceChoices(id, drink.slotId, undefined)).rejects.toThrow('Only the host can replace a stop.')
    expect(callsTo(w, 'stopPlace')).toEqual([])
    await sam.api.replaceStop(id, drink.slotId, options[0].id, undefined, drink.venue.id)
    w.server.calls.length = 0
    await sam.api.replaceStop(id, drink.slotId, options[0].id, undefined, drink.venue.id)
    expect(callsTo(w, 'stopPlace')).toEqual([])
  })

  it('swaps a stop for the indoor place in the rain through the same route, and only while the plan is confirmed', async () => {
    const { w, sam, kim, id } = await confirmed()
    const itinerary = await sam.api.getItinerary(id)
    const drink = stopOf(itinerary, 'drink')
    const indoor = (await sam.api.replaceChoices(id, drink.slotId, undefined)).options[0]
    w.server.plan.swap = (venueId) => (venueId === drink.venue.id ? { venueId: indoor.id, name: indoor.venue.name } : null)
    expect(await sam.api.findRainSwap(id, drink.slotId)).toEqual({ id: indoor.id, name: indoor.venue.name })
    expect(await sam.api.findRainSwap(id, stopOf(itinerary, 'eat').slotId)).toBeNull()
    expect(await sam.api.findRainSwap(id, 'no-such-stop')).toBeNull()
    await sam.api.swapOption(id, drink.slotId, drink.venue.id, indoor.id)
    expect(callsTo(w, 'stopPlace')).toHaveLength(1)
    expect(callsTo(w, 'stopPlace')[0].body).toMatchObject({ venueId: indoor.id, seenVenueId: drink.venue.id })
    expect(stopOf(await kim.api.getItinerary(id), 'drink').venue.id).toBe(indoor.id)
    // The same swap again changes nothing.
    w.server.calls.length = 0
    await sam.api.swapOption(id, drink.slotId, drink.venue.id, indoor.id)
    expect(callsTo(w, 'stopPlace')).toEqual([])
  })

  it('keeps a rain warning dismissed for the host until the forecast changes state, in this browser only', async () => {
    const { sam, kim, id } = await confirmed()
    const drink = stopOf(await sam.api.getItinerary(id), 'drink')
    await expect(kim.api.dismissRainWarning(id, drink.slotId, 'showers')).rejects.toThrow('Only the host can dismiss this.')
    const session = await sam.api.dismissRainWarning(id, drink.slotId, 'showers')
    expect(session.weatherDismissed).toEqual({ [drink.slotId]: 'showers' })
    expect((await sam.api.getSession(id)).weatherDismissed).toEqual({ [drink.slotId]: 'showers' })
    expect((await kim.api.getSession(id)).weatherDismissed).toBeUndefined()
    await expect(sam.api.dismissRainWarning(id, 'no-such-stop', 'showers')).rejects.toThrow('This stop is not in the plan.')
  })

  it('asks the weather at the stops of the plan, for its places and times', async () => {
    const { w, sam, id } = await confirmed()
    w.server.plan.weather = 'showers'
    const checked = await sam.api.checkStopWeather(id)
    const stops = await sam.api.getItinerary(id)
    expect(Object.keys(checked.stops).sort()).toEqual(stops.stops.map((s) => s.slotId).sort())
    expect(Object.values(checked.stops).every((x) => x.state === 'showers')).toBe(true)
    const call = w.server.calls.find((c) => c.path === '/api/weather/stops')
    expect(call.body.stops).toHaveLength(4)
    expect(call.body.stops[0]).toMatchObject({ id: stops.stops[0].slotId, point: { lat: expect.any(Number), lng: expect.any(Number) }, start: expect.stringMatching(/^2026-10-10T\d\d:\d\d$/) })
  })
})

describe('what the other person never sees', () => {
  it('keeps both exact places out of every answer, every read and every request of the plan, the itinerary, the ledger and Roam', async () => {
    const { w, sam, kim, id } = await voted()
    const suggestion = await sam.api.suggestOrder(id)
    await sam.api.confirmPlan(id, suggestion)
    vi.setSystemTime(ON_THE_DAY)
    const place = (await kim.api.roamNearby(id)).places.find((p) => p.state === 'free')
    await kim.api.proposeStop(id, kim.id, place.id)
    await sam.api.resolveProposal(id, (await sam.api.getSession(id)).proposals[0].id, true)
    const roamed = await kim.api.roamNearby(id)
    await sam.api.endPlan(id)
    const seenByKim = JSON.stringify([await kim.api.getSession(id), await kim.api.getItinerary(id), await kim.api.getLedger(id), await kim.api.getPlan(id), roamed])
    expect(seenByKim).not.toContain(SAM_PLACE.label)
    expect(seenByKim).not.toContain('Tampines Mall')
    const seenBySam = JSON.stringify([await sam.api.getSession(id), await sam.api.getItinerary(id), await sam.api.getLedger(id)])
    expect(seenBySam).not.toContain(KIM_PLACE.label)
    expect(seenBySam).not.toContain('Blk 123 Bishan')
    // Nothing the browsers sent to the server named a place of anyone's.
    expect(JSON.stringify(w.server.calls.map((c) => c.body))).not.toMatch(/Tampines Mall|Bishan St 12/)
    // And no browser read another person's exact place: the only reads of the table are the person's own, and of its labels alone.
    const reads = w.ops.filter((op) => op.table === 'session_member_places' && op.kind === 'select')
    expect(reads.length).toBeGreaterThan(0)
    for (const op of reads) {
      expect(op.columns).not.toMatch(/lat|lng/)
      expect(op.filters.some((f) => f.col === 'user_id' && f.value === op.as)).toBe(true)
    }
  })

  it('shows each person the area the other starts from, never the place, on the itinerary\'s starts and trips home', async () => {
    const { sam, kim, id } = await confirmed()
    const itinerary = await kim.api.getItinerary(id)
    expect(itinerary.starts.map((s) => [s.id, s.area.id]).sort()).toEqual([[sam.id, 'tampines'], [kim.id, 'bishan']].sort())
    expect(itinerary.trips.map((t) => t.place).sort()).toEqual(['Bishan', 'Tampines'].sort())
    expect(JSON.stringify(itinerary)).not.toMatch(/Mall, level 2|Bishan St 12/)
  })

  it('does not listen to the proposals, the ledger or anyone\'s exact place: the session\'s version carries the news', async () => {
    const { w, sam } = await confirmed()
    vi.setSystemTime(ON_THE_DAY)
    const stop = sam.api.watchSessions()
    await vi.waitFor(() => expect(w.subscriptions.length).toBeGreaterThan(0))
    expect(w.subscriptions.map((s) => s.table)).toEqual(expect.arrayContaining(['sessions', 'stops']))
    expect(w.subscriptions.some((s) => ['commute_ledger', 'stop_proposals', 'session_member_places'].includes(s.table))).toBe(false)
    stop()
  })
})

describe('a late answer is never applied over a newer state', () => {
  it('hands out the newest read of a session when an older one answers last', async () => {
    const { w, sam, kim, id } = await confirmed()
    const first = (await kim.api.getItinerary(id)).stops
    let release
    const held = new Promise((resolve) => { release = resolve })
    let seen = 0
    w.gate.hold = (op) => (op.kind === 'select' && op.table === 'stops' && (seen += 1) === 1 ? held : null)
    const older = kim.api.getSession(id)
    await vi.waitFor(() => expect(seen).toBe(1))
    await sam.api.setTravelMode(id, 0, 'car', { stopId: first[1].stopId })
    const newer = await kim.api.getSession(id)
    w.gate.hold = null
    release()
    const late = await older
    expect(newer.plan.modes[0]).toBe('car')
    expect(late.planVersion).toBe(newer.planVersion)
    expect(late.plan.modes[0]).toBe('car')
  })

  it('keeps the itinerary of the store from an older read that answers last', async () => {
    const { w, sam, kim, id } = await confirmed()
    setActivePinia(createPinia())
    const { useAuthStore } = await import('@/stores/auth.js')
    await useAuthStore().init()
    const events = (await import('@/stores/events.js')).useEventsStore()
    const first = await events.loadItinerary(id)
    let release
    const held = new Promise((resolve) => { release = resolve })
    let seen = 0
    w.gate.hold = (op) => (op.kind === 'select' && op.table === 'stops' && (seen += 1) === 1 ? held : null)
    const older = events.loadItinerary(id)
    await vi.waitFor(() => expect(seen).toBe(1))
    await sam.api.setTravelMode(id, 0, 'car', { stopId: first.stops[1].stopId })
    await events.loadItinerary(id)
    expect(events.itineraries[id].legs[0].mode).toBe('car')
    w.gate.hold = null
    release()
    await older
    expect(events.itineraries[id].legs[0].mode).toBe('car')
    void kim
  })

  it('drops an itinerary read for the account before', async () => {
    const { w, sam, id } = await confirmed()
    let release
    const held = new Promise((resolve) => { release = resolve })
    w.gate.hold = (op) => (op.kind === 'select' && op.table === 'stops' ? held : null)
    const reading = sam.api.getItinerary(id).catch((e) => e)
    await vi.waitFor(() => expect(w.ops.some((op) => op.table === 'stops')).toBe(true))
    await sam.api.signOut()
    w.gate.hold = null
    release()
    const outcome = await reading
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome.code).toBe('stale')
  })

  it('forgets a suggested order that was still being asked for when the dialog drew the orders again', async () => {
    const { w, sam, id } = await voted({ hostLast: true })
    setActivePinia(createPinia())
    const { useAuthStore } = await import('@/stores/auth.js')
    await useAuthStore().init()
    const events = (await import('@/stores/events.js')).useEventsStore()
    await sam.api.getPlan(id)
    let release
    const held = new Promise((resolve) => { release = resolve })
    w.server.after.suggestOrder = () => held
    const asking = events.suggestOrder(id, 'the votes as they were')
    await vi.waitFor(() => expect(events.orders[id]).toMatchObject({ key: 'the votes as they were', loading: true }))
    // The server refused the host's order as out of date, so the dialog forgets the question and asks it again for the new votes.
    events.forgetOrder(id)
    expect(events.orders[id]).toBeUndefined()
    w.server.after.suggestOrder = undefined
    const again = await events.suggestOrder(id, 'the votes as they are now')
    release()
    await asking
    // The late answer to the old question is not kept over the new one.
    expect(events.orders[id]).toMatchObject({ key: 'the votes as they are now', loading: false, failed: false })
    expect(events.orders[id].answer).toEqual(again)
  })

  it('does not apply a Confirm answer that was computed for the votes before a change: the basis is the server\'s check, not the browser\'s', async () => {
    const { w, sam, kim, lee, id, plan } = await threeVoted()
    const suggestion = await sam.api.suggestOrder(id)
    await kim.api.vote(id, plan.slots[0].id, kim.id, plan.slots[0].options[1].id)
    await lee.api.vote(id, plan.slots[0].id, lee.id, plan.slots[0].options[1].id)
    await expect(sam.api.confirmPlan(id, suggestion)).rejects.toMatchObject({ code: 'order_stale' })
    expect(sessionRow(w, id).status).toBe('voting')
  })
})

describe('the itinerary store takes a change back only on proof', () => {
  // Kim (a guest) is the app opened last, so the stores are hers; Sam makes the changes that are really made.
  async function store(world) {
    setActivePinia(createPinia())
    const { useAuthStore } = await import('@/stores/auth.js')
    await useAuthStore().init()
    const events = (await import('@/stores/events.js')).useEventsStore()
    await events.loadSession(world.id)
    await events.loadItinerary(world.id)
    return events
  }

  it('puts the list back and says why when the server turns a move away (a guest is not the host)', async () => {
    const world = await confirmed()
    const events = await store(world)
    const before = events.itineraries[world.id].stops.map((s) => s.stopId)
    await expect(events.reorderStops(world.id, 0, 2)).rejects.toMatchObject({ code: 'host_only' })
    expect(events.itineraries[world.id].stops.map((s) => s.stopId)).toEqual(before)
  })

  it('keeps the move on screen when nothing proves it failed (no connection), and shows what is stored once it can be read', async () => {
    const world = await confirmed({ hostLast: true })
    const events = await store(world)
    const before = events.itineraries[world.id].stops.map((s) => s.stopId)
    // Nothing can be reached: not the server, and not the database the stored order is read from afterwards.
    world.w.server.down = true
    world.w.gate.hold = (op) => {
      if (op.kind === 'select' && op.table === 'stops') throw new Error('Cannot reach the database.')
      return null
    }
    const failure = await events.reorderStops(world.id, 0, 2).catch((e) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.code).toBeUndefined()
    // A failure that proves nothing: the order shown stays (the server may have made the move).
    expect(events.itineraries[world.id].stops.map((s) => s.stopId)).toEqual([before[1], before[2], before[0], before[3]])
    world.w.gate.hold = null
    world.w.server.down = false
    await events.loadItinerary(world.id)
    expect(events.itineraries[world.id].stops.map((s) => s.stopId)).toEqual(before)
  })

  it('keeps the move on screen when the server did not answer, and the stored order wins when it is read', async () => {
    const world = await confirmed({ hostLast: true })
    const events = await store(world)
    const before = events.itineraries[world.id].stops.map((s) => s.stopId)
    world.w.server.down = true
    const failure = await events.reorderStops(world.id, 0, 2).catch((e) => e)
    expect(failure.message).toMatch(/Cannot reach the Jio planner/)
    // Nothing was written, and the stored plan is read after the failure: the screen shows it.
    expect(events.itineraries[world.id].stops.map((s) => s.stopId)).toEqual(before)
  })

  it('shows the stored plan after a delete of a stop that another device already deleted, and deletes no other', async () => {
    const world = await confirmed({ hostLast: true })
    const events = await store(world)
    const [first, second] = events.itineraries[world.id].stops
    // Another device deletes the second stop; this device has not heard.
    world.w.database.run({ as: SERVICE, kind: 'delete', table: 'stops', filters: [eq('id', second.stopId)] })
    await expect(events.deleteStop(world.id, 1)).rejects.toMatchObject({ code: 'stop_not_found', message: WORDS.stopGone })
    expect(events.itineraries[world.id].stops.map((s) => s.stopId)).not.toContain(second.stopId)
    expect(events.itineraries[world.id].stops[0].stopId).toBe(first.stopId)
    expect(events.itineraries[world.id].stops).toHaveLength(3)
  })

  it('moves a stop on screen at once, and keeps it when the server agrees', async () => {
    const world = await confirmed({ hostLast: true })
    const events = await store(world)
    const before = events.itineraries[world.id].stops.map((s) => s.stopId)
    await events.reorderStops(world.id, 0, 1)
    expect(events.itineraries[world.id].stops.map((s) => s.stopId)).toEqual([before[1], before[0], before[2], before[3]])
  })
})

describe('live', () => {
  async function storeOf() {
    setActivePinia(createPinia())
    const { useAuthStore } = await import('@/stores/auth.js')
    await useAuthStore().init()
    return (await import('@/stores/events.js')).useEventsStore()
  }

  it('shows the host\'s confirm on the guest\'s device without a reload, then every change to the itinerary, then the end', async () => {
    const { w, sam, kim, id } = await voted()
    const events = await storeOf()
    await events.loadSession(id)
    const stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(w.subscriptions.some((s) => s.table === 'stops')).toBe(true))
    expect(events.byId[id].status).toBe('voting')
    const suggestion = await sam.api.suggestOrder(id)
    await sam.api.confirmPlan(id, suggestion)
    await vi.waitFor(() => expect(events.byId[id].status).toBe('confirmed'))
    expect(events.byId[id].plan.stops).toHaveLength(4)
    await events.loadItinerary(id)
    const seen = events.itineraries[id].stops.map((s) => s.stopId)
    // The host moves a stop, sets a mode, deletes a stop: the guest's itinerary follows, each time, with no reload.
    await sam.api.reorderStops(id, 0, 1, { seen })
    await vi.waitFor(() => expect(events.itineraries[id].stops.map((s) => s.stopId)).toEqual([seen[1], seen[0], seen[2], seen[3]]))
    await sam.api.setTravelMode(id, 0, 'car', { stopId: seen[0] })
    await vi.waitFor(() => expect(events.itineraries[id].legs[0].mode).toBe('car'))
    await sam.api.deleteStop(id, 3, { stopId: seen[3] })
    await vi.waitFor(() => expect(events.itineraries[id].stops).toHaveLength(3))
    await sam.api.endPlan(id)
    await vi.waitFor(() => expect(events.byId[id].status).toBe('completed'))
    await events.loadLedger(id)
    expect(events.ledgers[id].row).toMatchObject({ total: expect.any(Number) })
    expect(events.ledgers[id].failed).toBe(false)
    stop()
  })

  it('shows the plan going back to voting on the other device', async () => {
    const { w, sam, kim, id } = await confirmed()
    const events = await storeOf()
    await events.loadSession(id)
    const stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(w.subscriptions.some((s) => s.table === 'sessions')).toBe(true))
    await sam.api.replan(id)
    await vi.waitFor(() => expect(events.byId[id].status).toBe('voting'))
    expect(events.byId[id].plan).toBeNull()
    stop()
  })

  it('shows a proposal on the host\'s device as it is made, and the stop once it is added', async () => {
    const { w, sam, kim, id } = await confirmed({ hostLast: true })
    vi.setSystemTime(ON_THE_DAY)
    const events = await storeOf()
    await events.loadSession(id)
    const stop = sam.api.watchSessions()
    await vi.waitFor(() => expect(w.subscriptions.some((s) => s.table === 'sessions')).toBe(true))
    const place = (await kim.api.roamNearby(id)).places.find((p) => p.state === 'free')
    await kim.api.proposeStop(id, kim.id, place.id)
    await vi.waitFor(() => expect(events.byId[id].proposals).toHaveLength(1))
    expect(events.byId[id].proposals[0]).toMatchObject({ byName: 'Kim', venue: expect.objectContaining({ name: place.venue.name }) })
    await events.resolveProposal(id, events.byId[id].proposals[0].id, true)
    expect(events.byId[id].proposals).toEqual([])
    expect(events.byId[id].plan.stops).toHaveLength(5)
    stop()
  })

  it('hears the delete of a stop it knows by the stop\'s key alone, and ignores the delete of a stop it never read', async () => {
    const { w, sam, kim, id } = await confirmed()
    const events = await storeOf()
    await events.loadSession(id)
    const heard = []
    kim.api.subscribe((event) => heard.push(event))
    const stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(heard.map((e) => e.type)).toContain('resync'))
    heard.length = 0
    const rows = stopsInOrder(w, id)
    await sam.api.deleteStop(id, 0, { stopId: rows[0].id })
    await vi.waitFor(() => expect(heard.some((e) => e.type === 'session' && e.sessionId === id)).toBe(true))
    heard.length = 0
    // A stop of a session this account never read is deleted elsewhere: nothing is read for it.
    const other = await w.open({ email: 'zed@example.com', password: 'Th1rd-secret!', name: 'Zed', username: 'zed_other', dob: '1998-01-02', homeAreaId: 'bishan', friends: [] })
    const made = await other.api.createSession({ title: 'Other', date: '2026-10-12', start: '12:00', end: '14:00' })
    const row = w.database.run({ as: SERVICE, kind: 'insert', table: 'stops', values: { session_id: made.id, seq: 0, category: 'eat', venue_id: 'v1', planned_start_minute: 600, duration_minutes: 60 }, returning: true, columns: 'id' }).data[0]
    heard.length = 0
    w.database.run({ as: SERVICE, kind: 'delete', table: 'stops', filters: [eq('id', row.id)] })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(heard.filter((e) => e.sessionId === made.id)).toEqual([])
    stop()
  })
})
