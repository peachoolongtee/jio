import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorld, userClient } from './helpers/fake-supabase.js'
import { addMember, addSession, GUEST, HOST, OTHER, SESSION, startSessionApp, STRANGER } from './helpers/session-app.js'

// A saved place Jio does not know, added to a vote (Faith, 4 November 2026): kept as a copy with its option, it goes through the same steps as any place
// (voted on, working the slots out again, confirmed, laid out, replaced), and the planner never ranks it. The database is the fake in
// helpers/fake-supabase.js, whose apply_session_plan is a JavaScript twin of the SQL function. No network.
const NAMES = { [HOST]: 'Ian', [GUEST]: 'Faith', [OTHER]: 'Jonathan' }
const PLACE_ID = '7f3c2a10-0000-4000-8000-000000000001'
const COPY_ID = `saved_${PLACE_ID}`
const PINNED = { id: PLACE_ID, name: 'Amoy Hotel', category: 'eat', address: '76 Telok Ayer St, 048458', lat: 1.2813, lng: 103.8483, rough: false, googlePlaceId: 'g_one' }
const NO_PIN = { ...PINNED, address: null, lat: null, lng: null, googlePlaceId: null }

let world
let t
const started = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(started.splice(0).map((s) => s.stop()))
})

// A voting world made by the real endpoints, at Bugis. How to call: await start({ dietary: ['halal'] })
async function start({ dietary = [] } = {}) {
  world = createWorld()
  addSession(world, { id: SESSION, status: 'inviting' })
  addMember(world, SESSION, HOST, { role: 'host', start: 'tampines', name: NAMES[HOST] })
  addMember(world, SESSION, GUEST, { start: 'clementi', name: NAMES[GUEST] })
  addMember(world, SESSION, OTHER, { start: 'bishan', name: NAMES[OTHER] })
  for (const id of [HOST, GUEST, OTHER]) world.profile_private.push({ id, dietary: id === GUEST ? dietary : [], budget_max_per_person: null, needs_step_free: false })
  t = await startSessionApp(world)
  started.push(t)
  expect((await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)).status).toBe(200)
}

const path = (tail = '') => `/api/sessions/${SESSION}${tail}`
const slotOf = (category) => world.slots.find((s) => s.session_id === SESSION && s.category === category)
const optionsOf = (category) => world.slot_options.filter((o) => o.slot_id === slotOf(category).id)
const copyRow = () => optionsOf('eat').find((o) => o.venue_id === COPY_ID)
const add = (saved = PINNED, who = GUEST, category = 'eat') => t.call('POST', path(`/slots/${slotOf(category).id}/options`), { saved }, who)
const vote = async (who, category, venueId) => {
  const { error } = await userClient(world, who).from('votes').insert({ slot_id: slotOf(category).id, user_id: who, venue_id: venueId })
  expect(error).toBeNull()
}
const stops = () => world.stops.filter((s) => s.session_id === SESSION).sort((a, b) => a.seq - b.seq)

describe('adding a saved place to a vote', () => {
  it('keeps a copy with the option, as the adder\'s, with no rank or score; again is 200 and nothing more', async () => {
    await start()
    const res = await add()
    expect(res.status).toBe(201)
    expect(res.body.added).toBe(true)
    expect(copyRow()).toMatchObject({ source: 'member', added_by: GUEST, rank: null, score: null })
    expect(copyRow().details.place).toEqual({ ...PINNED, id: COPY_ID })
    const seen = await userClient(world, HOST).from('slot_options').select('venue_id, details').in('venue_id', [COPY_ID])
    expect(seen.data[0].details.place.name).toBe('Amoy Hotel')
    const again = await add(PINNED, OTHER)
    expect(again.status).toBe(200)
    expect(again.body.added).toBe(false)
    expect(copyRow().added_by).toBe(GUEST)
  })

  it('with no pin it stands at the meeting area and says so', async () => {
    await start()
    expect((await add(NO_PIN)).status).toBe(201)
    const bugis = world.sessions.find((s) => s.id === SESSION).meeting_area_id
    expect(bugis).toBe('bugis')
    const { place } = copyRow().details
    expect(place.noPin).toBe(true)
    expect(Number.isFinite(place.lat) && Number.isFinite(place.lng)).toBe(true)
  })

  it('refuses a place of another kind than the slot, a stranger, a point outside Singapore, half a point, and extra fields', async () => {
    await start()
    expect((await add(PINNED, GUEST, 'drink')).body.error).toBe('venue_does_not_fit')
    expect((await add(PINNED, STRANGER)).status).toBe(404)
    expect((await add({ ...PINNED, lat: 40 })).status).toBe(400)
    expect((await add({ ...PINNED, lat: null })).status).toBe(400)
    expect((await add({ ...PINNED, rating: 4.5 })).status).toBe(400)
    expect(copyRow()).toBeUndefined()
  })

  it('flags a copy for the group\'s needs without naming one, for food and drink only', async () => {
    await start({ dietary: ['halal'] })
    await add()
    expect(copyRow().details.checkNeeds).toBe(true)
    expect(JSON.stringify(copyRow().details)).not.toContain('halal')
    await add({ ...PINNED, id: '7f3c2a10-0000-4000-8000-000000000002', category: 'activity' }, GUEST, 'activity')
    expect(optionsOf('activity').find((o) => o.venue_id.startsWith('saved_')).details.checkNeeds).toBeUndefined()
  })

  it('can be taken back by its adder only while nobody else has voted for it', async () => {
    await start()
    await add()
    const del = () => t.call('DELETE', path(`/slots/${slotOf('eat').id}/options/${COPY_ID}`), undefined, GUEST)
    await vote(HOST, 'eat', COPY_ID)
    expect((await del()).body.error).toBe('has_votes')
    world.votes = world.votes.filter((v) => v.venue_id !== COPY_ID)
    expect((await t.call('DELETE', path(`/slots/${slotOf('eat').id}/options/${COPY_ID}`), undefined, OTHER)).body.error).toBe('not_yours')
    expect((await del()).body.removed).toBe(true)
    expect(copyRow()).toBeUndefined()
  })
})

describe('working the slots out again', () => {
  it('keeps the copy through a radius change, with its votes, and does not hand it to the planner', async () => {
    await start()
    await add()
    await vote(HOST, 'eat', COPY_ID)
    expect((await t.call('PUT', path('/radius'), { radiusMeters: 500 }, HOST)).status).toBe(200)
    expect(copyRow().details.place.name).toBe('Amoy Hotel')
    expect(world.votes.some((v) => v.venue_id === COPY_ID)).toBe(true)
  })

  it('keeps the copy when the needs change, though nobody voted for it, and brings its flag up to date', async () => {
    await start()
    await add()
    expect(copyRow().details.checkNeeds).toBeUndefined()
    expect((await t.call('PUT', path('/dietary'), { mine: ['halal'], dropped: [] }, GUEST)).status).toBe(200)
    expect(copyRow().details.checkNeeds).toBe(true)
  })

  it('counts towards the six a slot holds, and "more suggestions" tops up around it', async () => {
    await start()
    await add()
    const have = optionsOf('eat').length
    const more = await t.call('POST', path(`/slots/${slotOf('eat').id}/options/more`), { have }, GUEST)
    expect(more.status).toBe(200)
    expect(optionsOf('eat').length).toBeLessThanOrEqual(6)
    expect(copyRow()).toBeDefined()
  })
})

describe('a copy that wins its vote', () => {
  // A plan whose Eat stop is the copy. How to call: await confirmedWith(PINNED)
  async function confirmedWith(saved) {
    await start()
    await add(saved)
    await vote(HOST, 'eat', COPY_ID)
    await vote(GUEST, 'eat', COPY_ID)
    for (const category of ['drink', 'activity']) {
      const first = optionsOf(category)[0].venue_id
      await vote(HOST, category, first)
      await vote(GUEST, category, first)
    }
    const res = await t.call('POST', path('/confirm'), {}, HOST)
    expect(res.status).toBe(200)
    return stops().find((s) => s.venue_id === COPY_ID)
  }

  it('confirms as a stop, keeps its copy to read, and lays the legs out from its pin', async () => {
    const stop = await confirmedWith(PINNED)
    expect(stop.category).toBe('eat')
    expect(copyRow().details.place.lat).toBe(PINNED.lat)
    expect(stops().every((s) => Number.isFinite(s.planned_start_minute))).toBe(true)
  })

  it('confirms with no pin, the legs measured from the meeting area', async () => {
    const stop = await confirmedWith(NO_PIN)
    expect(stop).toBeDefined()
    expect(stops().every((s) => Number.isFinite(s.planned_start_minute))).toBe(true)
  })

  it('leaves the plan when the host replaces its stop', async () => {
    const stop = await confirmedWith(PINNED)
    const list = await t.call('GET', path(`/stops/${stop.id}/choices`), undefined, HOST)
    expect(list.status).toBe(200)
    expect(list.body.options.map((o) => o.venueId)).not.toContain(COPY_ID) // It is the stop already.
    const other = list.body.options[0].venueId
    expect((await t.call('PUT', path(`/stops/${stop.id}/place`), { venueId: other, seenVenueId: COPY_ID }, HOST)).status).toBe(200)
    expect(stops().map((s) => s.venue_id)).not.toContain(COPY_ID)
  })

  it('is in Replace\'s list when another place won, and the host can put it in the stop, keeping its copy', async () => {
    await start()
    await add()
    const winners = {}
    for (const category of ['eat', 'drink', 'activity']) {
      winners[category] = optionsOf(category).find((o) => o.venue_id !== COPY_ID).venue_id
      await vote(HOST, category, winners[category])
      await vote(GUEST, category, winners[category])
    }
    expect((await t.call('POST', path('/confirm'), {}, HOST)).status).toBe(200)
    const stop = stops().find((s) => s.category === 'eat')
    const list = await t.call('GET', path(`/stops/${stop.id}/choices`), undefined, HOST)
    expect(list.body.options.map((o) => o.venueId)).toContain(COPY_ID)
    expect(list.body.options.find((o) => o.venueId === COPY_ID).details.place.name).toBe('Amoy Hotel')
    expect((await t.call('PUT', path(`/stops/${stop.id}/place`), { venueId: COPY_ID, seenVenueId: winners.eat }, HOST)).status).toBe(200)
    expect(stops().find((s) => s.category === 'eat').venue_id).toBe(COPY_ID)
    expect(copyRow().details.place.name).toBe('Amoy Hotel')
  })

  it('is suggested an order with the rest of the plan, reading its point', async () => {
    await start()
    await add()
    await vote(HOST, 'eat', COPY_ID)
    await vote(GUEST, 'eat', COPY_ID)
    for (const category of ['drink', 'activity']) {
      const first = optionsOf(category)[0].venue_id
      await vote(HOST, category, first)
      await vote(GUEST, category, first)
    }
    const res = await t.call('POST', path('/order/suggest'), undefined, HOST)
    expect(res.status).toBe(200)
    expect(res.body.why).not.toBe('unknown_place')
  })
})
