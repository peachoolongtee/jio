import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadNeeds } from '../src/db/sessions.js'
import { loadPlanData } from '../src/db/venues.js'
import { createWorld, fakeSupabase, userClient } from './helpers/fake-supabase.js'
import { addMember, addSession, GUEST, HOST, OTHER, SESSION, startSessionApp, STRANGER } from './helpers/session-app.js'

// PUT /api/sessions/:id/dietary and GET /api/sessions/:id/dietary: a member's dietary needs for one outing, the host's dropped needs, the
// re-pick of a voting session's places when the group's needs change, and the privacy of all of it. The database is the fake in
// helpers/fake-supabase.js (its session_member_needs answers a member's outing needs over their profile's, and the two new tables are
// server only); the login check is the real code. Nothing touches the network.
//
// The people: HOST has vegan on their profile, GUEST halal, OTHER nothing. Three have joined unless a test says otherwise.
const DATA = await loadPlanData()
const venue = (id) => DATA.venues.find((v) => v.id === id)

let world
let t
const started = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(started.splice(0).map((s) => s.stop()))
})

const path = (tail = '') => `/api/sessions/${SESSION}${tail}`
const session = () => world.sessions.find((s) => s.id === SESSION)
const get = (as, id = SESSION) => t.call('GET', `/api/sessions/${id}/dietary`, undefined, as)
const put = (as, body, id = SESSION) => t.call('PUT', `/api/sessions/${id}/dietary`, body, as)
const writes = () => world.calls.filter((c) => c.rpc === 'apply_session_plan')
const dietaryRows = () => world.session_member_dietary.filter((d) => d.session_id === SESSION)
const droppedRows = () => world.session_dietary_dropped.filter((d) => d.session_id === SESSION).map((d) => d.need)

// A world with one session in `status` and its members, and an app over it. `people` are who has joined (the host first).
// How to call: await start({ status: 'inviting', people: [HOST, GUEST] })
async function start({ status = 'inviting', people = [HOST, GUEST, OTHER], profiles = { [HOST]: ['vegan'], [GUEST]: ['halal'], [OTHER]: [] }, appOptions = {} } = {}) {
  world = createWorld()
  addSession(world, { id: SESSION, status, version: 4 })
  for (const id of people) addMember(world, SESSION, id, { role: id === HOST ? 'host' : 'guest' })
  world.profile_private = Object.entries(profiles).map(([id, dietary]) => ({ id, dietary, home_area_id: 'bugis', budget_max_per_person: null, needs_step_free: false }))
  t = await startSessionApp(world, appOptions)
  started.push(t)
  return t
}

describe('GET /api/sessions/:id/dietary (the outing’s own needs)', () => {
  it('answers the five fields, and for a member with no row of their own their profile’s needs, unconfirmed', async () => {
    await start()
    const res = await get(GUEST)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ dietary: ['halal', 'vegan'], others: ['vegan'], mine: ['halal'], checked: false, dropped: [] })
    expect(Object.keys(res.body).sort()).toEqual(['checked', 'dietary', 'dropped', 'mine', 'others'])
  })

  it('shows the outing’s needs over the profile’s, and lists nobody’s name or id', async () => {
    await start()
    world.session_member_dietary.push({ session_id: SESSION, user_id: GUEST, dietary: ['vegetarian'], confirmed_at: '2026-10-20T08:00:00Z' })
    const asGuest = await get(GUEST)
    expect(asGuest.body).toEqual({ dietary: ['vegetarian', 'vegan'], others: ['vegan'], mine: ['vegetarian'], checked: true, dropped: [] })
    expect((await get(HOST)).body).toEqual({ dietary: ['vegetarian', 'vegan'], others: ['vegetarian'], mine: ['vegan'], checked: false, dropped: [] })
    const text = JSON.stringify(asGuest.body)
    for (const leak of [HOST, GUEST, OTHER, 'bugis', 'budget', 'step']) expect(text).not.toContain(leak)
  })

  it('with fewer than three joined, tells nothing about the others: no others and no dropped, even when the host dropped a need earlier', async () => {
    await start({ people: [HOST, GUEST] })
    world.session_dietary_dropped.push({ session_id: SESSION, need: 'vegan' })
    for (const who of [HOST, GUEST]) {
      const res = await get(who)
      expect(res.body.others).toEqual([])
      expect(res.body.dropped).toEqual([])
    }
    // The dropped need is out of the group's needs in effect, and not named as dropped.
    expect((await get(GUEST)).body).toMatchObject({ dietary: ['halal'], mine: ['halal'] })
  })

  it('lists a dropped need only while someone still has it', async () => {
    await start()
    world.session_dietary_dropped.push({ session_id: SESSION, need: 'halal' }, { session_id: SESSION, need: 'vegetarian' })
    // Nobody has vegetarian: it is stored as dropped but there is nothing to say about it.
    expect((await get(HOST)).body).toMatchObject({ dietary: ['vegan'], others: ['halal'], dropped: ['halal'] })
  })

  it('reads the outing’s tables only with the server’s key', async () => {
    await start()
    await get(GUEST)
    expect(world.calls.filter((c) => ['session_member_dietary', 'session_dietary_dropped'].includes(c.table)).every((c) => c.who === null)).toBe(true)
    // A person’s own client is refused the tables outright, even on their own row.
    const mine = userClient(world, GUEST)
    expect((await mine.from('session_member_dietary').select('dietary')).error.code).toBe('42501')
    expect((await mine.from('session_member_dietary').insert({ session_id: SESSION, user_id: GUEST, dietary: [] })).error.code).toBe('42501')
    expect((await mine.from('session_dietary_dropped').insert({ session_id: SESSION, need: 'halal' })).error.code).toBe('42501')
    expect((await mine.from('session_dietary_dropped').select('need')).error.code).toBe('42501')
  })
})

describe('PUT /api/sessions/:id/dietary (a member’s own needs for this outing)', () => {
  it('saves the list for the outing, leaves the profile alone, and changes the group’s needs', async () => {
    await start()
    const res = await put(GUEST, { mine: ['vegetarian'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ dietary: ['vegetarian', 'vegan'], others: ['vegan'], mine: ['vegetarian'], checked: false, dropped: [], repicked: false })
    expect(dietaryRows()).toEqual([expect.objectContaining({ user_id: GUEST, dietary: ['vegetarian'] })])
    expect(dietaryRows()[0].confirmed_at ?? null).toBeNull()
    expect(world.profile_private.find((p) => p.id === GUEST).dietary).toEqual(['halal'])
    // The host reads the same needs, still without a name.
    expect((await get(HOST)).body.others).toEqual(['vegetarian'])
    // An inviting session has no places to pick again, so the database function was not asked to write.
    expect(writes()).toHaveLength(0)
  })

  it('removes a need for one outing with an empty list, and keeps the order of the app', async () => {
    await start()
    expect((await put(GUEST, { mine: [] })).body).toMatchObject({ dietary: ['vegan'], mine: [] })
    const twice = await put(OTHER, { mine: ['VEGAN', 'halal', 'vegan'] })
    expect(twice.status).toBe(200)
    expect(twice.body.mine).toEqual(['halal', 'vegan'])
    expect(dietaryRows().find((d) => d.user_id === OTHER).dietary).toEqual(['halal', 'vegan'])
  })

  it('confirms for the outing: with a list it saves the list, without one it keeps the profile’s needs as the outing’s', async () => {
    await start()
    const only = await put(GUEST, { checked: true })
    expect(only.body).toMatchObject({ mine: ['halal'], checked: true, dietary: ['halal', 'vegan'] })
    expect(dietaryRows().find((d) => d.user_id === GUEST)).toMatchObject({ dietary: ['halal'], confirmed_at: expect.any(String) })
    const both = await put(OTHER, { mine: ['vegetarian'], checked: true })
    expect(both.body).toMatchObject({ mine: ['vegetarian'], checked: true })
    // A later change of the list keeps the confirmation.
    const again = await put(OTHER, { mine: ['vegan'] })
    expect(again.body).toMatchObject({ mine: ['vegan'], checked: true })
  })

  it('writes nothing when nothing changes', async () => {
    await start()
    await put(GUEST, { mine: ['halal'], checked: true })
    const before = JSON.stringify(world.session_member_dietary)
    const calls = world.calls.length
    const repeat = await put(GUEST, { mine: ['halal'], checked: true })
    expect(repeat.status).toBe(200)
    expect(JSON.stringify(world.session_member_dietary)).toBe(before)
    expect(world.calls.slice(calls).filter((c) => c.who === null && c.kind !== 'select' && c.kind !== 'rpc')).toEqual([])
    expect(repeat.body.repicked).toBe(false)
  })

  it('works while locating and voting, and the answer is the GET’s', async () => {
    await start({ status: 'locating' })
    const res = await put(HOST, { mine: ['halal'] })
    expect(res.status).toBe(200)
    expect(res.body.planVersion).toBe(4)
    const { planVersion, repicked, ...view } = res.body
    expect(view).toEqual((await get(HOST)).body)
    expect(repicked).toBe(false)
  })

  it('is refused for the wrong body: nothing to do, an unknown need, a need twice too many, a stray field, checked: false', async () => {
    await start()
    for (const body of [{}, { mine: ['kosher'] }, { mine: ['halal', 'vegan', 'vegetarian', 'halal'] }, { mine: ['halal'], who: GUEST }, { checked: false }, { dropped: ['pork'] }, { planVersion: -1, mine: [] }]) {
      const res = await put(GUEST, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error).toBe('invalid_input')
    }
    expect((await put(GUEST, { mine: [] }, 'not-a-uuid')).status).toBe(400)
    expect(dietaryRows()).toEqual([])
  })

  it('needs a login and a member: a stranger gets the same 404 as a missing session, an opted-out member is told to rejoin', async () => {
    await start()
    world.session_members.find((m) => m.user_id === OTHER).state = 'opted_out'
    expect((await put(null, { mine: [] })).status).toBe(401)
    const stranger = await put(STRANGER, { mine: ['halal'] })
    const missing = await put(STRANGER, { mine: ['halal'] }, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    expect(stranger.status).toBe(404)
    expect(stranger.body).toEqual(missing.body)
    const out = await put(OTHER, { mine: ['halal'] })
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('not_joined')
    expect(dietaryRows()).toEqual([])
    // Nothing private was read for a stranger.
    expect(world.calls.some((c) => c.kind === 'rpc')).toBe(false)
  })

  it('is refused once the session has ended (session_closed) and once the plan is confirmed (wrong_status)', async () => {
    await start({ status: 'cancelled' })
    const ended = await put(GUEST, { mine: [] })
    expect(ended.status).toBe(409)
    expect(ended.body.error).toBe('session_closed')
    await start({ status: 'completed' })
    expect((await put(GUEST, { mine: [] })).body.error).toBe('session_closed')
    await start({ status: 'confirmed' })
    const confirmed = await put(GUEST, { mine: [] })
    expect(confirmed.status).toBe(409)
    expect(confirmed.body.error).toBe('wrong_status')
    expect(dietaryRows()).toEqual([])
  })

  it('refuses a stale planVersion and writes nothing', async () => {
    await start()
    const stale = await put(GUEST, { mine: [], planVersion: 3 })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('stale_plan')
    expect(dietaryRows()).toEqual([])
    expect((await put(GUEST, { mine: [], planVersion: 4 })).status).toBe(200)
  })

  it('fails as a server error without telling the database’s words, and leaves the rows as they were', async () => {
    await start()
    world.failNeeds = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await put(GUEST, { mine: [] })
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('server_error')
    expect(JSON.stringify(res.body)).not.toContain('boom')
    expect(dietaryRows()).toEqual([])
  })

  it('two people changing their needs at once are both saved', async () => {
    await start()
    const [a, b] = await Promise.all([put(GUEST, { mine: ['vegetarian'] }), put(OTHER, { mine: ['halal'] })])
    expect([a.status, b.status]).toEqual([200, 200])
    expect((await get(HOST)).body).toMatchObject({ dietary: ['halal', 'vegetarian', 'vegan'], others: ['halal', 'vegetarian'] })
  })

  it('a member who leaves takes their needs for the outing with them', async () => {
    await start()
    await put(GUEST, { mine: ['vegetarian'] })
    expect((await t.call('DELETE', path('/members/me'), undefined, GUEST)).status).toBe(200)
    expect(dietaryRows()).toEqual([])
    expect((await get(HOST)).body.dietary).toEqual(['vegan'])
  })

  it('has its own limit, shared with the other writes of the session', async () => {
    await start({ appOptions: { sessionRateLimit: { windowMs: 60_000, max: 2 } } })
    expect((await put(GUEST, { mine: [] })).status).toBe(200)
    expect((await put(GUEST, { mine: ['halal'] })).status).toBe(200)
    expect((await put(GUEST, { mine: [] })).status).toBe(429)
  })
})

describe('PUT /api/sessions/:id/dietary (the host’s dropped needs)', () => {
  it('lets the host drop a need that someone else has, takes it out of the group’s needs, and keeps it in the others’ list', async () => {
    await start()
    const res = await put(HOST, { dropped: ['halal'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ dietary: ['vegan'], others: ['halal'], mine: ['vegan'], dropped: ['halal'] })
    expect(droppedRows()).toEqual(['halal'])
    // Everyone sees that it is dropped, and still not whose it was.
    const asGuest = await get(GUEST)
    expect(asGuest.body).toMatchObject({ dietary: ['vegan'], others: ['vegan'], mine: ['halal'], dropped: ['halal'] })
    expect(JSON.stringify(asGuest.body)).not.toContain(HOST)
  })

  it('takes a drop back, with an empty list or a shorter one', async () => {
    await start()
    await put(HOST, { dropped: ['halal'] })
    const back = await put(HOST, { dropped: [] })
    expect(back.body).toMatchObject({ dietary: ['halal', 'vegan'], dropped: [] })
    expect(droppedRows()).toEqual([])
    world.profile_private.find((p) => p.id === OTHER).dietary = ['vegetarian']
    await put(HOST, { dropped: ['halal', 'vegetarian'] })
    expect((await put(HOST, { dropped: ['vegetarian'] })).body.dropped).toEqual(['vegetarian'])
    expect(droppedRows()).toEqual(['vegetarian'])
  })

  it('is the host’s alone', async () => {
    await start()
    const res = await put(GUEST, { dropped: ['vegan'] })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('host_only')
    expect(droppedRows()).toEqual([])
  })

  it('needs three people joined', async () => {
    await start({ people: [HOST, GUEST] })
    const res = await put(HOST, { dropped: ['halal'] })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('needs_three_people')
    expect(droppedRows()).toEqual([])
  })

  it('counts joined people only: an opted-out member does not make three', async () => {
    await start()
    world.session_members.find((m) => m.user_id === OTHER).state = 'opted_out'
    expect((await put(HOST, { dropped: ['halal'] })).body.error).toBe('needs_three_people')
  })

  it('refuses a need nobody else has, and the host’s own need is not another’s to drop', async () => {
    await start()
    const own = await put(HOST, { dropped: ['vegan'] })
    expect(own.status).toBe(422)
    expect(own.body.error).toBe('need_not_found')
    expect((await put(HOST, { dropped: ['vegetarian'] })).body.error).toBe('need_not_found')
    expect((await put(HOST, { dropped: ['halal', 'vegetarian'] })).status).toBe(422)
    expect(droppedRows()).toEqual([])
  })

  it('keeps a need that is already dropped on the list even when nobody else has it now', async () => {
    await start()
    await put(HOST, { dropped: ['halal'] })
    // The guest who had halal changes their list for the outing: halal is no longer anyone else's, and still dropped.
    await put(GUEST, { mine: ['vegetarian'] })
    expect(droppedRows()).toEqual(['halal'])
    const res = await put(HOST, { dropped: ['halal', 'vegetarian'] })
    expect(res.status).toBe(200)
    expect(droppedRows().sort()).toEqual(['halal', 'vegetarian'])
  })

  it('brings a drop back when a member adds the need to their own list', async () => {
    await start()
    await put(HOST, { dropped: ['halal'] })
    const res = await put(OTHER, { mine: ['halal'] })
    expect(res.body.dropped).toEqual([])
    expect(droppedRows()).toEqual([])
    expect(res.body.dietary).toEqual(['halal', 'vegan'])
    // Sending the list they already have does not bring a drop back: only adding the need does.
    await put(HOST, { dropped: ['halal'] })
    await put(OTHER, { mine: ['halal'] })
    expect(droppedRows()).toEqual(['halal'])
  })

  it('takes a drop off the rankings: the needs a ranking reads are the outing’s, without the dropped ones', async () => {
    await start()
    const service = fakeSupabase(world, null).service
    expect((await loadNeeds(service, SESSION)).map((n) => n.dietary).sort()).toEqual([[], ['halal'], ['vegan']])
    await put(GUEST, { mine: ['halal', 'vegetarian'] })
    await put(HOST, { dropped: ['halal'] })
    const needs = await loadNeeds(service, SESSION)
    expect(needs.map((n) => [...n.dietary].sort())).toEqual([['vegan'], ['vegetarian'], []])
    // The other private fields are untouched.
    expect(needs.every((n) => n.home_area_id === 'bugis' && n.needs_step_free === false)).toBe(true)
  })

  it('a stale planVersion is refused for a drop too', async () => {
    await start()
    expect((await put(HOST, { dropped: ['halal'], planVersion: 1 })).body.error).toBe('stale_plan')
    expect(droppedRows()).toEqual([])
  })
})

describe('a change of the group’s needs while voting picks the places again', () => {
  const slotOf = (category) => world.slots.find((s) => s.session_id === SESSION && s.category === category)
  const optionIds = (category) => world.slot_options.filter((o) => o.slot_id === slotOf(category).id).map((o) => o.venue_id).sort()
  const vote = (who, category, venueId) => userClient(world, who).from('votes').insert({ slot_id: slotOf(category).id, user_id: who, venue_id: venueId })
  const voteWrites = () => world.calls.filter((c) => c.table === 'votes' && c.who === null && c.kind !== 'select')
  const fits = (id, need) => ['full', 'options', 'likely'].includes(venue(id).diet?.[need])

  // A voting session made by the real endpoints, with nobody's profile naming a need, and each of the three people voting for a different eat place.
  async function voting(profiles = { [HOST]: [], [GUEST]: [], [OTHER]: [] }) {
    world = createWorld()
    addSession(world, { id: SESSION, status: 'locating' })
    addMember(world, SESSION, HOST, { role: 'host', start: 'tampines' })
    addMember(world, SESSION, GUEST, { start: 'clementi' })
    addMember(world, SESSION, OTHER, { start: 'bishan' })
    world.profile_private = Object.entries(profiles).map(([id, dietary]) => ({ id, dietary, budget_max_per_person: null, needs_step_free: false }))
    t = await startSessionApp(world)
    started.push(t)
    await t.call('POST', path('/meeting-area'), {}, HOST)
    expect((await t.call('POST', path('/voting'), {}, HOST)).status).toBe(200)
    const eat = optionIds('eat')
    for (const [who, id] of [HOST, GUEST, OTHER].map((p, i) => [p, eat[i]])) if (id) expect((await vote(who, 'eat', id)).error).toBeNull()
  }

  it('picks the slots again for a need added, keeps the votes of the places that still fit, and says so without naming anyone or any need', async () => {
    await voting()
    const before = optionIds('eat')
    const votesBefore = world.votes.map((v) => ({ user_id: v.user_id, venue_id: v.venue_id }))
    expect(votesBefore).toHaveLength(Math.min(3, before.length))
    const version = session().plan_version
    const res = await put(GUEST, { mine: ['vegan'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ dietary: ['vegan'], repicked: true, mine: ['vegan'] })
    expect(session().plan_version).toBeGreaterThan(version)
    expect(res.body.planVersion).toBe(session().plan_version)

    // Every place of the food slot now fits the need, and the places that did were kept.
    const after = optionIds('eat')
    expect(after.length).toBeGreaterThan(0)
    for (const id of after) expect(fits(id, 'vegan'), id).toBe(true)
    for (const id of before.filter((x) => fits(x, 'vegan'))) expect(after).toContain(id)
    expect(after).not.toEqual(before)

    // A vote for a place that stayed stays; one for a place that went is gone; the server wrote none.
    const kept = world.votes.map((v) => ({ user_id: v.user_id, venue_id: v.venue_id }))
    expect(kept).toEqual(votesBefore.filter((v) => after.includes(v.venue_id)))
    expect(voteWrites()).toEqual([])

    // The notice for everyone: no name, no need, flagged as the dietary notice; it says votes went when they did.
    const banner = session().banner
    expect(banner).toMatchObject({ text: expect.stringContaining("The group's dietary needs changed, so the places were picked again."), byDiet: true })
    expect(banner.votesCleared === true).toBe(kept.length < votesBefore.length)
    for (const word of ['vegan', 'halal', 'vegetarian', 'Ian', 'Faith', HOST, GUEST, OTHER]) expect(JSON.stringify(banner)).not.toContain(word)
  })

  it('does the same when the host drops a need, and ranks the slots again (the places already offered stay while they fit)', async () => {
    await voting({ [HOST]: [], [GUEST]: ['vegan'], [OTHER]: [] })
    const before = optionIds('eat')
    for (const id of before) expect(fits(id, 'vegan')).toBe(true)
    const version = session().plan_version
    const res = await put(HOST, { dropped: ['vegan'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ dietary: [], dropped: ['vegan'], repicked: true })
    // Nothing that was offered stops fitting when a need is dropped, so every place and vote stays and no notice is needed.
    expect(optionIds('eat')).toEqual(before)
    expect(world.votes).toHaveLength(Math.min(3, before.length))
    expect(session().plan_version).toBeGreaterThanOrEqual(version)
    expect(session().banner).toBeNull()
  })

  it('picks again for a need taken away, then for it coming back', async () => {
    await voting({ [HOST]: [], [GUEST]: ['vegan'], [OTHER]: [] })
    const withVegan = optionIds('eat')
    const away = await put(GUEST, { mine: [] })
    expect(away.body).toMatchObject({ dietary: [], repicked: true })
    const back = await put(GUEST, { mine: ['vegan'] })
    expect(back.body).toMatchObject({ dietary: ['vegan'], repicked: true })
    for (const id of optionIds('eat')) expect(fits(id, 'vegan')).toBe(true)
    expect(withVegan.length).toBeGreaterThan(0)
  })

  it('does not rank anything again when the group’s needs are the same (one member changing which of two people has a need)', async () => {
    await voting({ [HOST]: ['vegan'], [GUEST]: ['vegan'], [OTHER]: [] })
    const writesBefore = world.calls.filter((c) => c.rpc === 'apply_session_plan').length
    // Another member of the group has vegan too, so the group's needs stay the same when the guest drops it.
    const res = await put(GUEST, { mine: [], checked: true })
    expect(res.body).toMatchObject({ dietary: ['vegan'], repicked: false, checked: true })
    expect(world.calls.filter((c) => c.rpc === 'apply_session_plan').length).toBe(writesBefore)
  })

  it('leaves the slots alone before voting', async () => {
    await start({ status: 'locating' })
    const res = await put(GUEST, { mine: ['vegetarian'] })
    expect(res.body.repicked).toBe(false)
    expect(world.slots).toHaveLength(0)
    expect(writes()).toHaveLength(0)
  })

  it('a ranking earlier in the same run reads the old needs, and the places are still picked for the new ones', async () => {
    await voting()
    // The first request is held while it loads; "more suggestions" (which ranks with the needs it reads first) and the change of needs
    // wait behind it and share the next run, in that order.
    let release
    const held = new Promise((resolve) => { release = resolve })
    let first = true
    world.hooks.beforeRead = ({ table }) => {
      if (table !== 'sessions' || !first) return undefined
      first = false
      return held
    }
    const slot = slotOf('eat').id
    const holder = t.call('POST', path('/plan/sync'), {}, HOST)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const more = t.call('POST', path(`/slots/${slot}/options/more`), { have: 3 }, HOST)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const change = put(GUEST, { mine: ['vegan'] })
    setTimeout(() => release(), 40)
    const answers = await Promise.all([holder, more, change])
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200])
    expect(answers[2].body.repicked).toBe(true)
    const after = optionIds('eat')
    expect(after.length).toBeGreaterThan(0)
    for (const id of after) expect(fits(id, 'vegan'), id).toBe(true)
  })

  it('searching a slot for a place uses the new needs at once', async () => {
    await voting()
    const slot = slotOf('eat').id
    const find = () => t.call('GET', path(`/slots/${slot}/venue-search?q=a`), undefined, HOST)
    const before = (await find()).body.results
    await put(GUEST, { mine: ['halal'] })
    const after = (await find()).body.results
    // Searching never names a need, but a place that does not fit now says "group needs".
    expect(JSON.stringify(after)).not.toContain('halal')
    expect(after.filter((r) => r.fits).length).toBeLessThanOrEqual(before.filter((r) => r.fits).length)
  })
})
