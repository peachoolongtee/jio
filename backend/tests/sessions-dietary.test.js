import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOutingDiet, withOutingDiet } from '../src/db/sessions.js'
import { loadPlanData } from '../src/db/venues.js'
import { createWorld, fakeSupabase, jwksFetch, SUPABASE_URL, userClient } from './helpers/fake-supabase.js'
import { addMember, addSession, GUEST, HOST, OTHER, SESSION, startSessionApp, STRANGER } from './helpers/session-app.js'
import { createSupabase } from '../src/db/supabase.js'

// An outing's own dietary needs (UAT of 29 October 2026, item 5): GET and PUT /api/sessions/:id/dietary, and the ranking reading a
// member's needs for the outing in place of their profile's, less the needs the host dropped. Tested without the network over the fake
// database in helpers/fake-supabase.js, where (as in db/policies.sql) no browser can read or write session_member_diet or
// session_diet_dropped. The people: HOST starts at Tampines, GUEST at Clementi, OTHER at Bishan.
const NAMES = { [HOST]: 'Ian', [GUEST]: 'Faith', [OTHER]: 'Jonathan' }

let world
let t
const started = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(started.splice(0).map((s) => s.stop()))
})

// A world with one session and its members, each with a profile need, and an app over it. A voting session is made by the real
// endpoints (the spots, then the host's confirm), so its slots are the server's own.
// How to call: await start({ status: 'voting', needs: { [GUEST]: ['halal'] } })
async function start({ status = 'inviting', people = [HOST, GUEST, OTHER], needs = {} } = {}) {
  world = createWorld()
  addSession(world, { id: SESSION, status: status === 'voting' ? 'locating' : status })
  const starts = { [HOST]: 'tampines', [GUEST]: 'clementi', [OTHER]: 'bishan' }
  for (const id of people) {
    addMember(world, SESSION, id, { ...(id === HOST && { role: 'host' }), start: starts[id], name: NAMES[id] })
    world.profile_private.push({ id, dietary: needs[id] ?? [], budget_max_per_person: null, needs_step_free: false })
  }
  t = await startSessionApp(world)
  started.push(t)
  if (status === 'voting') {
    await t.call('POST', path('/meeting-area'), {}, HOST)
    expect((await t.call('POST', path('/voting'), {}, HOST)).status).toBe(200)
  }
  return t
}

const path = (tail = '') => `/api/sessions/${SESSION}${tail}`
const read = (who) => t.call('GET', path('/dietary'), undefined, who)
const put = (who, body) => t.call('PUT', path('/dietary'), body, who)
const session = () => world.sessions.find((s) => s.id === SESSION)
const profileOf = (id) => world.profile_private.find((p) => p.id === id)

describe('PUT /api/sessions/:id/dietary: each person\'s own needs for the outing', () => {
  it('keeps what a person picks for this outing, says they confirmed, and leaves their profile as it was', async () => {
    await start({ needs: { [GUEST]: ['halal'] } })
    expect((await read(GUEST)).body).toMatchObject({ mine: ['halal'], checked: false })
    const res = await put(GUEST, { mine: ['vegan'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ dietary: ['vegan'], mine: ['vegan'], checked: true })
    expect(profileOf(GUEST).dietary).toEqual(['halal'])
    expect(world.session_member_diet).toEqual([expect.objectContaining({ session_id: SESSION, user_id: GUEST, needs: ['vegan'] })])
    // No needs is an answer too: the profile's halal no longer counts for this outing.
    expect((await put(GUEST, { mine: [] })).body).toMatchObject({ dietary: [], mine: [], checked: true })
    // Someone else still sees only the needs together.
    expect((await read(HOST)).body).toEqual({ dietary: [], others: [], mine: [], dropped: [], checked: false })
  })

  it('refuses a stranger and someone who opted out, a need it does not know, the same need twice, and a finished outing', async () => {
    await start()
    expect((await put(STRANGER, { mine: ['halal'] })).status).toBe(404)
    world.session_members.find((m) => m.user_id === OTHER).state = 'opted_out'
    expect((await put(OTHER, { mine: ['halal'] })).body.error).toBe('not_joined')
    expect((await put(GUEST, { mine: ['durian-free'] })).status).toBe(400)
    expect((await put(GUEST, { mine: ['halal', 'halal'] })).status).toBe(400)
    expect((await put(GUEST, { mine: ['halal'], extra: 1 })).status).toBe(400)
    session().status = 'completed'
    expect((await put(GUEST, { mine: ['halal'] })).status).toBe(409)
    expect(world.session_member_diet).toEqual([])
  })

  it('says it is not set up (503) on a project without the tables, and the reads fall back to the profiles', async () => {
    await start({ needs: { [GUEST]: ['halal'] } })
    world.noDietTables = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await read(GUEST)).body).toEqual({ dietary: ['halal'], others: [], mine: ['halal'], dropped: [], checked: false })
    const res = await put(GUEST, { mine: ['vegan'] })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('not_set_up')
  })
})

describe('dropping a need someone else has', () => {
  it('is the host\'s alone, with three joined: a guest is refused, and the group stops filtering for it without naming anyone', async () => {
    await start({ needs: { [GUEST]: ['halal'], [OTHER]: ['vegan'] } })
    const guestTry = await put(OTHER, { mine: ['vegan'], dropped: ['halal'] })
    expect(guestTry.status).toBe(403)
    expect(guestTry.body.error).toBe('host_only')
    expect(world.session_diet_dropped).toEqual([])
    const res = await put(HOST, { mine: [], dropped: ['halal'] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ planVersion: expect.any(Number), dietary: ['vegan'], others: ['halal', 'vegan'], mine: [], dropped: ['halal'], checked: true })
    expect(world.session_diet_dropped).toEqual([expect.objectContaining({ session_id: SESSION, need: 'halal' })])
    // The guest whose need it is sees it dropped, and nothing says whose it was.
    expect((await read(GUEST)).body).toEqual({ dietary: ['vegan'], others: ['vegan'], mine: ['halal'], dropped: ['halal'], checked: false })
  })

  it('ignores a need nobody else has, and drops nothing with only two joined', async () => {
    await start({ people: [HOST, GUEST], needs: { [GUEST]: ['halal'] } })
    const res = await put(HOST, { mine: ['vegan'], dropped: ['halal'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ dietary: ['halal', 'vegan'], others: [], dropped: [] })
    expect(world.session_diet_dropped).toEqual([])
  })

  it('comes back when the host asks, or when the person who has it selects it again; confirming the same needs keeps it dropped', async () => {
    await start({ needs: { [GUEST]: ['halal'], [OTHER]: ['vegan'] } })
    await put(HOST, { mine: [], dropped: ['halal'] })
    // The guest confirms what they had: the host's choice stands.
    expect((await put(GUEST, { mine: ['halal'] })).body).toMatchObject({ dietary: ['vegan'], dropped: ['halal'] })
    // OTHER cannot bring back a need that is not theirs.
    expect((await put(OTHER, { mine: ['vegan'], dropped: [] })).body.error).toBe('host_only')
    // The guest takes it off, then selects it again: it is filtered for again.
    await put(GUEST, { mine: [] })
    expect((await put(GUEST, { mine: ['halal'] })).body).toMatchObject({ dietary: ['halal', 'vegan'], dropped: [] })
    // And the host can bring one back on their own.
    await put(HOST, { mine: [], dropped: ['vegan'] })
    expect((await put(HOST, { mine: [], dropped: [] })).body).toMatchObject({ dietary: ['halal', 'vegan'], dropped: [] })
  })
})

describe('while voting, a change ranks the places again', () => {
  it('a halal need for the outing leaves only food places that fit it, takes the votes for the others, and the notice names no one', async () => {
    await start({ status: 'voting' })
    const byId = new Map(loadPlanData().venues.map((v) => [v.id, v]))
    const eat = world.slots.find((s) => s.session_id === SESSION && s.category === 'eat')
    const eatOptions = () => world.slot_options.filter((o) => o.slot_id === eat.id)
    // Food is ranked strictly for a need (services/session-slots.js): only a place whose halal is known to fit stays.
    const fits = (o) => ['full', 'options', 'likely'].includes(byId.get(o.venue_id)?.diet?.halal)
    const unfit = eatOptions().find((o) => !fits(o))
    expect(unfit, 'the fixture offers a food place not known to be halal before the change').toBeTruthy()
    expect((await userClient(world, OTHER).from('votes').insert({ slot_id: eat.id, user_id: OTHER, venue_id: unfit.venue_id })).error).toBeNull()
    const before = session().plan_version
    const res = await put(GUEST, { mine: ['halal'] })
    expect(res.status).toBe(200)
    expect(res.body.planVersion).toBeGreaterThan(before)
    expect(eatOptions().length).toBeGreaterThan(0)
    for (const option of eatOptions()) expect(fits(option), option.venue_id).toBe(true)
    expect(world.votes.filter((v) => v.slot_id === eat.id)).toEqual([])
    expect(session().banner).toMatchObject({ byDiet: true, votesCleared: true, text: "The group's dietary needs changed, so places were ranked again. Votes for places that no longer fit were cleared." })
    for (const name of Object.values(NAMES)) expect(session().banner.text).not.toContain(name)
  })

  it('ranks nothing when what the group is filtered for did not change', async () => {
    await start({ status: 'voting', needs: { [GUEST]: ['halal'] } })
    const writesBefore = world.calls.filter((c) => c.rpc === 'apply_session_plan').length
    expect((await put(GUEST, { mine: ['halal'] })).status).toBe(200)
    expect(world.calls.filter((c) => c.rpc === 'apply_session_plan').length).toBe(writesBefore)
  })
})

describe('the needs a ranking reads', () => {
  const rows = [
    { user_id: HOST, dietary: ['vegan'], budget_max_per_person: 20, needs_step_free: true },
    { user_id: GUEST, dietary: ['halal'], budget_max_per_person: null, needs_step_free: false },
    { user_id: OTHER, dietary: [], budget_max_per_person: null, needs_step_free: false },
  ]

  it('takes a person\'s needs for the outing over their profile\'s, takes off the dropped ones, and keeps every other field', () => {
    const outing = { mine: new Map([[GUEST, ['vegetarian']]]), dropped: ['vegan'], ready: true }
    expect(withOutingDiet(rows, outing)).toEqual([
      { user_id: HOST, dietary: [], budget_max_per_person: 20, needs_step_free: true },
      { user_id: GUEST, dietary: ['vegetarian'], budget_max_per_person: null, needs_step_free: false },
      { user_id: OTHER, dietary: [], budget_max_per_person: null, needs_step_free: false },
    ])
  })

  it('drops nothing below three joined, so a dropped need never hides the only other person\'s', () => {
    const outing = { mine: new Map(), dropped: ['halal'], ready: true }
    expect(withOutingDiet(rows.slice(0, 2), outing).map((r) => r.dietary)).toEqual([['vegan'], ['halal']])
  })

  it('reads the profile\'s needs on a project without the tables', async () => {
    const w = createWorld()
    w.noDietTables = true
    const service = fakeSupabase(w, createSupabase({ url: SUPABASE_URL, anonKey: 'anon', serviceKey: 'service', fetchImpl: jwksFetch })).service
    const outing = await loadOutingDiet(service, SESSION)
    expect(outing.ready).toBe(false)
    expect(withOutingDiet(rows, outing).map((r) => r.dietary)).toEqual([['vegan'], ['halal'], []])
  })
})
