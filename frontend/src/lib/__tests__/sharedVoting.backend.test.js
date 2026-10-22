// Voting on places (stage 4), the frontend and the backend together: api.js (real, with the real planner client) calls the real Express
// routes under /api/sessions/:id/... and GET /api/venues, started in this process, which write the stand-in database
// (components/dev/fakeDatabase.js, with the port of apply_session_plan) that both sides use. The login check is the stand-in's. There is
// no hand-made server in between, unlike sessionsVoting.test.js (which uses lib/__tests__/fakeSessionsServer.js): if the request, the
// answer or what is stored drifts apart between the halves, this fails. No network (the weather and OneMap are stubbed or off).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../../backend/src/app.js'
import { createHttp } from '../../../../backend/src/services/http.js'
import { loadPlanData } from '../../../../backend/src/db/venues.js'
import { OTHER, PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { SERVICE, createDataClient, createDatabase } from '../../components/dev/fakeDatabase.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

const servers = []
afterAll(() => servers.forEach((s) => s.close()))

// The database, the real backend on it, and a way to open the app as someone with its planner client pointed at that backend.
// How to call: const w = await world(); const sam = await w.open(PROFILE)
async function world() {
  const database = createDatabase({ profiles: {} })
  const facade = {
    service: createDataClient({ database, as: () => SERVICE }),
    forUser: (token) => createDataClient({ database, as: () => database.userForToken(token) }),
    verifyToken: async (token) => {
      const id = database.userForToken(token)
      return id ? { id, email: null } : null
    },
  }
  const server = createApp({ frontendOrigin: 'http://localhost:5173', http: createHttp({ stub: true }), supabase: facade }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  servers.push(server)
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    database,
    async open(profile) {
      const fake = fakeSupabase({ database, memoryOnly: true })
      const app = await boot(fake, {}, { shared: true })
      app.api.api.defaults.baseURL = base
      const user = await app.api.signUp({ ...profile })
      return { ...app, fake, user, id: user.id }
    },
  }
}

// Sam hosts, Kim joins; both share where they start; the host confirms the first spot (or the area named): the group is voting and the
// real server has made the slots and their places.
// How to call: const { w, sam, kim, id, plan } = await voting({ known: 'tampines' })
async function voting({ known = null } = {}) {
  const w = await world()
  const sam = await w.open(PROFILE)
  const kim = await w.open(OTHER)
  const { id } = await sam.api.createSession({ ...SESSION })
  const { token } = await sam.api.makeInviteLink(id)
  await kim.api.joinWithLink(token)
  await sam.api.startSession(id)
  await sam.api.setLocation(id, sam.id, 'start', { areaId: 'tampines', label: 'Tampines Mall' })
  await kim.api.setLocation(id, kim.id, 'start', { areaId: 'bishan', label: 'Bishan Junction 8' })
  if (known) await sam.api.setKnownPlace(id, known)
  else await sam.api.confirmSpot(id)
  const plan = await sam.api.getPlan(id)
  return { w, sam, kim, id, plan }
}

const rows = (w, table) => w.database.tables[table]
const slotRow = (w, category) => rows(w, 'slots').find((x) => x.category === category)
const optionRows = (w, category) => rows(w, 'slot_options').filter((o) => o.slot_id === slotRow(w, category).id)
const bySlot = (plan, category) => plan.slots.find((s) => s.category === category)

describe('what the real server stores when the host confirms, and what the Vote page reads of it', () => {
  it('makes the four categories with their places, and stores a slot\'s details in the one shape the page reads', async () => {
    const { w, kim, id, plan } = await voting()
    expect(plan.slots.map((s) => s.category).sort()).toEqual(['activity', 'drink', 'eat', 'shop'])
    for (const slot of rows(w, 'slots')) {
      // { widened, few, empty, moreAvailable, weather }: the notice, the empty state with its reason and hints, and "more available".
      expect(Object.keys(slot.details).sort()).toEqual(['empty', 'few', 'moreAvailable', 'weather', 'widened'])
      expect(typeof slot.details.widened).toBe('boolean')
      expect(typeof slot.details.moreAvailable).toBe('boolean')
    }
    for (const slot of plan.slots) {
      expect(slot.options.length).toBeGreaterThan(0)
      expect(slot).toMatchObject({ widened: expect.any(Boolean), canAddMore: expect.any(Boolean) })
      expect(slot.empty).toBeNull()
    }
    // What is stored for a place is what a card reads: the walk, the reasons, the warnings, the swap, the explanation, the caveats.
    const stored = optionRows(w, 'eat')[0].details
    expect(stored).toMatchObject({ walkMinutes: expect.any(Number), reasons: expect.any(Array), warnings: expect.any(Array), explanation: expect.any(String), verify: expect.any(Array), dietUnknown: expect.any(Array), approximate: expect.any(Boolean) })
    expect(plan.slots.find((s) => s.category === 'eat').options[0]).toMatchObject({ walk: stored.walkMinutes, reasons: stored.reasons, explanation: stored.explanation })
    // The other device reads the same places.
    const seen = await kim.api.getPlan(id)
    expect(seen.slots.map((s) => [s.id, s.options.map((o) => o.id)])).toEqual(plan.slots.map((s) => [s.id, s.options.map((o) => o.id)]))
  })

  it('shows the "few options" notice and the widening hint the server stored, in the page\'s own fields', async () => {
    const { w, sam, id } = await voting()
    // A narrow ring: the planner finds few places inside it and says how far to widen; both are stored with the slot.
    await sam.api.setRadius(id, 100)
    const plan = await sam.api.getPlan(id)
    expect(plan.radius).toBe(100)
    for (const slot of plan.slots) {
      const stored = slotRow(w, slot.category).details
      expect(slot.widened).toBe(stored.widened)
      expect(slot.few).toEqual(stored.few ? { found: stored.few.found, widenToKm: stored.few.widenToKm } : null)
      expect(slot.empty).toEqual(stored.empty ? { reason: stored.empty.reason, nearestKm: stored.empty.nearestKm, widenToKm: stored.empty.widenToKm } : null)
    }
    // At least one category has a notice or an empty state at 100 m around a suburb.
    expect(plan.slots.some((s) => s.few || s.empty || s.widened)).toBe(true)
    for (const slot of plan.slots.filter((s) => s.few)) expect(slot.few).toEqual({ found: expect.any(Number), widenToKm: expect.any(Number) })
    for (const slot of plan.slots.filter((s) => s.empty)) expect(slot.empty).toEqual({ reason: expect.any(String), nearestKm: expect.any(Number), widenToKm: expect.any(Number) })
  })

  it('counts, in a slot, the members who picked the kind, and nothing else', async () => {
    const { w, sam, kim, id } = await voting()
    expect(rows(w, 'slots').map((x) => x.picks)).toEqual([0, 0, 0, 0])
    await sam.api.setPreferences(id, sam.id, { categories: ['eat', 'drink'], until: null })
    await kim.api.setPreferences(id, kim.id, { categories: ['eat'], until: null })
    const picks = Object.fromEntries(rows(w, 'slots').map((x) => [x.category, x.picks]))
    expect(picks).toEqual({ eat: 2, drink: 1, shop: 0, activity: 0 })
    expect(bySlot(await sam.api.getPlan(id), 'eat').picks).toBe(2)
  })
})

describe('changing what the group is offered', () => {
  it('searches the saved places for a slot and adds one; the search says why a place does not fit, and what was added already', async () => {
    const { w, sam, kim, id, plan } = await voting()
    const eat = bySlot(plan, 'eat')
    const found = await kim.api.searchVenuesForSlot(id, eat.id, 'market')
    expect(found.length).toBeGreaterThan(0)
    expect(found.length).toBeLessThanOrEqual(12)
    for (const r of found) expect(r).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), area: expect.any(String), category: expect.any(String), walk: expect.any(Number), unfit: expect.any(String), verify: expect.any(Array), dietUnknown: expect.any(Array), added: expect.any(Boolean) }))
    const fit = found.find((r) => !r.unfit && !r.added)
    expect(fit).toBeTruthy()
    const after = await kim.api.addOption(id, eat.id, fit.id)
    expect(after.options[eat.id]).toContain(fit.id)
    expect(optionRows(w, 'eat').find((o) => o.venue_id === fit.id)).toMatchObject({ source: 'member', added_by: kim.id })
    expect((await sam.api.searchVenuesForSlot(id, eat.id, fit.name)).find((r) => r.id === fit.id).added).toBe(true)
    // Nothing in the answer says where a person is.
    expect(JSON.stringify(found)).not.toMatch(/lat|lng|label/i)
  })

  it('swaps a place in place: the votes follow it, and a swap into a place that is already there merges the votes', async () => {
    const { w, sam, kim, id, plan } = await voting()
    const eat = bySlot(plan, 'eat')
    const [a, b] = eat.options.map((o) => o.id)
    await sam.api.vote(id, eat.id, sam.id, a)
    await kim.api.vote(id, eat.id, kim.id, a)
    const fresh = (await kim.api.searchVenuesForSlot(id, eat.id, 'a')).find((r) => !r.unfit && !r.added && ![a, b].includes(r.id))
    const swapped = await sam.api.swapOption(id, eat.id, a, fresh.id)
    // The votes are on the new place, and the page shows them there.
    expect(swapped.options[eat.id]).toContain(fresh.id)
    expect(swapped.options[eat.id]).not.toContain(a)
    expect(rows(w, 'votes').filter((v) => v.slot_id === eat.id).map((v) => v.venue_id)).toEqual([fresh.id, fresh.id])
    const read = bySlot(await kim.api.getPlan(id), 'eat')
    expect(read.options.find((o) => o.id === fresh.id)).toMatchObject({ votes: 2 })
    expect(read.myVote).toBe(fresh.id)
    // Into a place that is already an option: the votes move to it and the old place goes.
    await sam.api.vote(id, eat.id, sam.id, b)
    await sam.api.swapOption(id, eat.id, b, fresh.id)
    expect(optionRows(w, 'eat').map((o) => o.venue_id)).not.toContain(b)
    expect(rows(w, 'votes').filter((v) => v.slot_id === eat.id).map((v) => v.venue_id)).toEqual([fresh.id, fresh.id])
  })

  it('takes more places three at a time, up to six, and says no more when the slot is full', async () => {
    const { sam, id, plan } = await voting()
    const eat = bySlot(plan, 'eat')
    const first = await sam.api.addMoreOptions(id, eat.id)
    expect(first.options[eat.id].length).toBeGreaterThan(eat.options.length)
    expect(first.options[eat.id].length).toBeLessThanOrEqual(6)
    expect(bySlot(await sam.api.getPlan(id), 'eat').canAddMore).toBe(first.options[eat.id].length < 6)
  })

  it('lets only the host remove and bring back a category and set the radius, in words', async () => {
    const { w, sam, kim, id, plan } = await voting()
    const drink = bySlot(plan, 'drink')
    await expect(kim.api.deleteSlot(id, drink.id)).rejects.toMatchObject({ code: 'host_only' })
    await expect(kim.api.setRadius(id, 1000)).rejects.toMatchObject({ code: 'host_only' })
    await sam.api.vote(id, drink.id, sam.id, drink.options[0].id)
    await sam.api.deleteSlot(id, drink.id)
    expect(rows(w, 'votes')).toEqual([])
    expect(optionRows(w, 'drink')).toEqual([])
    expect((await sam.api.getPlan(id)).slots.map((s) => s.category)).not.toContain('drink')
    await sam.api.restoreSlots(id)
    expect(bySlot(await sam.api.getPlan(id), 'drink').options.length).toBeGreaterThan(0)
  })
})

describe('a place with a long id (the saved hawker centres)', () => {
  it('is found, added, voted for and read back, and a halal group is offered it', async () => {
    const { w, sam, kim, id } = await voting({ known: 'tampines' })
    w.database.setNeeds(sam.id, { dietary: ['halal'] })
    const long = loadPlanData().venues.find((v) => v.name === 'Tampines Round Market and Food Centre')
    expect(long.id.length).toBeGreaterThan(80)
    // A halal member is in the group: the server ranks the eat slot with the strict diet rule, and never says whose need it is.
    await sam.api.setPreferences(id, sam.id, { categories: ['eat'], until: null })
    for (const o of optionRows(w, 'eat')) expect(o.details.dietUnknown).toEqual([])
    expect(JSON.stringify(rows(w, 'slot_options'))).not.toContain(sam.id)
    const eat = bySlot(await kim.api.getPlan(id), 'eat')
    const found = (await kim.api.searchVenuesForSlot(id, eat.id, 'Tampines Round Market')).find((r) => r.id === long.id)
    // A halal hawker centre is "likely" (some stalls are certified), so it fits and says to check the stalls.
    expect(found).toMatchObject({ unfit: '', verify: ['halal'], dietUnknown: [] })
    if (!found.added) await kim.api.addOption(id, eat.id, long.id)
    await kim.api.vote(id, eat.id, kim.id, long.id)
    const read = bySlot(await sam.api.getPlan(id), 'eat')
    expect(read.options.find((o) => o.id === long.id)).toMatchObject({ votes: 1, venue: { name: long.name } })
  })
})

describe('opting out, rejoining and a paused session', () => {
  it('takes the person\'s votes when they opt out, lets them rejoin while voting, and refuses it once confirmed in words', async () => {
    const { w, sam, kim, id, plan } = await voting({ known: 'bugis' })
    const eat = bySlot(plan, 'eat')
    await kim.api.vote(id, eat.id, kim.id, eat.options[0].id)
    await sam.api.vote(id, eat.id, sam.id, eat.options[0].id)
    await kim.api.optOut(id, kim.id)
    expect(rows(w, 'votes').map((v) => v.user_id)).toEqual([sam.id])
    await kim.api.rejoinSession(id)
    expect(rows(w, 'session_members').find((m) => m.user_id === kim.id).state).toBe('joined')
    // The plan is confirmed (stage 5 does this; here the row is set): opting out and rejoining are not possible any more.
    rows(w, 'sessions')[0].status = 'confirmed'
    await expect(kim.api.optOut(id, kim.id)).rejects.toMatchObject({ code: 'not_yet', message: "You can't opt out once the plan is confirmed." })
    await expect(kim.api.rejoinSession(id)).rejects.toMatchObject({ code: 'not_yet', message: "You can't rejoin once the plan is confirmed." })
  })

  it('pauses voting when nobody but one person has a start, clears the votes, says so in words, and resumes on rejoin', async () => {
    const { w, sam, kim, id, plan } = await voting()
    const eat = bySlot(plan, 'eat')
    const [a, b] = eat.options.map((o) => o.id)
    const fit = (await kim.api.searchVenuesForSlot(id, eat.id, 'a')).find((r) => !r.unfit && !r.added)
    await sam.api.vote(id, eat.id, sam.id, a)
    await sam.api.deleteSlot(id, bySlot(plan, 'drink').id)
    expect(rows(w, 'slot_options').length).toBeGreaterThan(0)
    // The area was the planner's pick, not the host's: with one start left it has no meaning, so it is taken away with the votes.
    await kim.api.optOut(id, kim.id)
    expect(rows(w, 'sessions')[0]).toMatchObject({ status: 'voting', meeting_area_id: null })
    expect(rows(w, 'votes')).toEqual([])
    const words = 'Places open once two people have shared where they start.'
    await expect(sam.api.addOption(id, eat.id, fit.id)).rejects.toMatchObject({ code: 'no_meeting_area', message: words })
    await expect(sam.api.addMoreOptions(id, eat.id)).rejects.toMatchObject({ code: 'no_meeting_area', message: words })
    // A swap names a place that is no longer an option (the pause cleared them), so it is told that; it is refused for want of an area
    // only when the place is still there, which a paused session never has.
    await expect(sam.api.swapOption(id, eat.id, a, b)).rejects.toMatchObject({ code: 'option_not_found' })
    await expect(sam.api.searchVenuesForSlot(id, eat.id, 'market')).rejects.toMatchObject({ code: 'no_meeting_area', message: words })
    await expect(sam.api.restoreSlots(id)).rejects.toMatchObject({ code: 'no_meeting_area', message: words })
    // Rejoining brings the second start back, and the places with it.
    await kim.api.rejoinSession(id)
    expect(rows(w, 'sessions')[0].meeting_area_id).toEqual(expect.any(String))
    expect((await sam.api.getPlan(id)).slots.length).toBeGreaterThan(0)
  })
})
