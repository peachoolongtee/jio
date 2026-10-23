import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSupabase } from '../src/db/supabase.js'
import { loadPlanData } from '../src/db/venues.js'
import { MAX } from '../src/routes/plan-schemas.js'
import { createWeatherResolver } from '../src/planner/weather-window.js'
import { createHttp } from '../src/services/http.js'
import { createOneMap } from '../src/services/onemap.js'
import { createPlannerRuns } from '../src/services/planner-runs.js'
import { createSessions } from '../src/services/sessions.js'
import { MAX_ROUTED_TRIPS_PER_REQUEST } from '../src/services/travel-times.js'
import { createWeather } from '../src/services/weather.js'
import { applySessionPlan, createWorld, fakeSupabase, jwksFetch, SUPABASE_URL, userClient } from './helpers/fake-supabase.js'
import { addMember, addSession, GUEST, HOST, OTHER, SESSION, startSessionApp, STRANGER } from './helpers/session-app.js'

// The voting endpoints (stage 4, server half), tested without the network: the slots and their places made at the host's confirm, E1 in
// voting, E3 sync, E4 radius, E5 and E6 slots, E7 to E9 places, E17 search and E18 venues. The login check is the real code; the database is
// the fake in helpers/fake-supabase.js, whose apply_session_plan is a JavaScript twin of the SQL function and whose votes follow the
// access rules of db/policies.sql. The forecast answers from the stub fixtures.
//
// The people: HOST starts at Tampines, GUEST at Clementi, OTHER at Bishan. The session is on 25 October 2026 from 10:00 to 20:00.
const NAMES = { [HOST]: 'Ian', [GUEST]: 'Faith', [OTHER]: 'Jonathan' }

let world
let t
const started = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(started.splice(0).map((s) => s.stop()))
})

// A world with one session and three members, and an app over it. `status` is where the session starts; a voting session is made by the
// real endpoints (the spots, then the host's confirm), so its slots are the server's own.
// How to call: await start({ status: 'voting' })
async function start({ status = 'voting', starts = { [HOST]: 'tampines', [GUEST]: 'clementi', [OTHER]: 'bishan' }, appOptions = {}, known = null, people = [HOST, GUEST, OTHER] } = {}) {
  world = createWorld()
  addSession(world, { id: SESSION, status: status === 'voting' ? 'locating' : status })
  addMember(world, SESSION, HOST, { role: 'host', start: starts[HOST], name: NAMES[HOST] })
  addMember(world, SESSION, GUEST, { start: starts[GUEST], name: NAMES[GUEST] })
  if (people.includes(OTHER)) addMember(world, SESSION, OTHER, { start: starts[OTHER], name: NAMES[OTHER] })
  for (const id of people) world.profile_private.push({ id, dietary: [], budget_max_per_person: null, needs_step_free: false })
  t = await startSessionApp(world, appOptions)
  started.push(t)
  if (status === 'voting') {
    if (known) expect((await t.call('PUT', path('/known-place'), { areaId: known }, HOST)).status).toBe(200)
    else {
      await t.call('POST', path('/meeting-area'), {}, HOST)
      expect((await t.call('POST', path('/voting'), {}, HOST)).status).toBe(200)
    }
  }
  return t
}

const path = (tail = '') => `/api/sessions/${SESSION}${tail}`
const session = () => world.sessions.find((s) => s.id === SESSION)
const slotOf = (category) => world.slots.find((s) => s.session_id === SESSION && s.category === category)
const optionsOf = (category) => world.slot_options.filter((o) => o.slot_id === slotOf(category).id)
const idsOf = (category) => optionsOf(category).map((o) => o.venue_id).sort()
const votesOf = (category) => world.votes.filter((v) => v.slot_id === slotOf(category).id)
const writes = () => world.calls.filter((c) => c.rpc === 'apply_session_plan')
const serviceReads = () => world.calls.filter((c) => c.who === null && c.kind !== 'rpc')
// A vote is a direct write by the person's browser, under the access rules.
const vote = (who, category, venueId) => userClient(world, who).from('votes').insert({ slot_id: slotOf(category).id, user_id: who, venue_id: venueId })
const everyVoteCount = () => world.votes.length

describe('the host\'s confirm makes the slots and their places (E2)', () => {
  it('writes the status move, the four slots and each slot\'s first places in one apply_session_plan call', async () => {
    await start({ status: 'locating' })
    await t.call('POST', path('/meeting-area'), {}, HOST)
    const before = writes().length
    const res = await t.call('POST', path('/voting'), {}, HOST)
    expect(res.status).toBe(200)
    expect(res.body.slotCount).toBe(4)
    expect(writes().length - before).toBe(1)
    expect(world.slots.map((s) => s.category).sort()).toEqual(['activity', 'drink', 'eat', 'shop'])
    for (const category of ['eat', 'drink', 'shop', 'activity']) {
      const options = optionsOf(category)
      expect(options.length, category).toBeGreaterThanOrEqual(1)
      expect(options.length, category).toBeLessThanOrEqual(3)
      for (const o of options) {
        expect(o.source).toBe('planner')
        expect(o.added_by).toBeNull()
        // An option's id is held to the tables' limit (160: the saved hawker centres have ids of 86 characters), not the old 80.
        expect(o.venue_id.length).toBeLessThanOrEqual(MAX.venueId)
        expect(Number.isFinite(o.score)).toBe(true)
        expect(o.details).toMatchObject({ approximate: expect.any(Boolean), reasons: expect.any(Array), explanation: expect.any(String) })
      }
      expect(slotOf(category)).toMatchObject({ deleted: false })
      expect(slotOf(category).details).toMatchObject({ widened: expect.any(Boolean), moreAvailable: expect.any(Boolean) })
    }
    // Eat at a meal, the others in the middle of the day; the last of the four is flagged.
    expect(slotOf('eat').start_minute).toBe(720)
    expect(world.slots.filter((s) => s.is_last)).toHaveLength(1)
    expect(slotOf('activity').is_last).toBe(true)
    expect(session().status).toBe('voting')
  })

  it('counts who picked each kind, and lays the day out from how long people can stay', async () => {
    await start({ status: 'locating' })
    Object.assign(world.session_members.find((m) => m.user_id === HOST), { categories: ['eat', 'drink'], stay_until: '16:00:00' })
    Object.assign(world.session_members.find((m) => m.user_id === GUEST), { categories: ['eat'], stay_until: '15:00:00' })
    await t.call('POST', path('/meeting-area'), {}, HOST)
    await t.call('POST', path('/voting'), {}, HOST)
    expect([slotOf('eat').picks, slotOf('drink').picks, slotOf('shop').picks]).toEqual([2, 1, 0])
    // Half the group can stay until 15:00 or later, so nothing is laid out past it.
    for (const s of world.slots) expect(s.start_minute + s.duration_minutes).toBeLessThanOrEqual(15 * 60 + 90)
  })

  it('a known place makes them too, even before anyone has shared a start (everyone is planned for at the place)', async () => {
    await start({ status: 'inviting', starts: { [HOST]: null, [GUEST]: null, [OTHER]: null } })
    const res = await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)
    expect(res.status).toBe(200)
    expect(world.slots).toHaveLength(4)
    expect(world.slot_options.length).toBeGreaterThanOrEqual(4)
    expect(session()).toMatchObject({ status: 'voting', meeting_area_id: 'bugis', meeting_method: 'chosen' })
  })
})

describe('votes are direct writes, and the server keeps them in step', () => {
  it('a vote is saved and the other device reads it; a place that is not an option, or someone else\'s name, is refused', async () => {
    await start()
    const [venue] = idsOf('eat')
    expect((await vote(HOST, 'eat', venue)).error).toBeNull()
    const seen = await userClient(world, GUEST).from('votes').select('slot_id, user_id, venue_id')
    expect(seen.data).toEqual([expect.objectContaining({ user_id: HOST, venue_id: venue })])
    expect((await vote(HOST, 'drink', 'not-an-option')).error.code).toBe('23503')
    expect((await userClient(world, GUEST).from('votes').insert({ slot_id: slotOf('eat').id, user_id: HOST, venue_id: venue })).error.code).toBe('42501')
    expect((await userClient(world, STRANGER).from('votes').select('venue_id')).data).toEqual([])
  })

  it('a member who has opted out cannot vote, and their votes are deleted when they opt out', async () => {
    await start()
    const [venue] = idsOf('eat')
    await vote(OTHER, 'eat', venue)
    expect(everyVoteCount()).toBe(1)
    const res = await t.call('POST', path('/opt-out'), undefined, OTHER)
    expect(res.status).toBe(200)
    expect(everyVoteCount()).toBe(0)
    expect((await vote(OTHER, 'eat', venue)).error.code).toBe('42501')
    expect((await t.call('POST', path('/rejoin'), undefined, OTHER)).body.state).toBe('joined')
    expect((await vote(OTHER, 'eat', venue)).error).toBeNull()
  })

  it('leaving or being removed takes the person\'s votes too', async () => {
    // A chosen area, so the area cannot move and take every vote with it (that is tested below).
    await start({ known: 'bugis' })
    await vote(GUEST, 'eat', idsOf('eat')[0])
    await vote(OTHER, 'drink', idsOf('drink')[0])
    expect((await t.call('DELETE', path('/members/me'), undefined, GUEST)).status).toBe(200)
    expect(world.votes.some((v) => v.user_id === GUEST)).toBe(false)
    expect((await t.call('DELETE', path(`/members/${OTHER}`), undefined, HOST)).status).toBe(200)
    expect(everyVoteCount()).toBe(0)
  })
})

// A direct write by a member of their own start, as the browser does before it asks the server to work the plan out again.
const setStart = (who, area) => userClient(world, who).from('session_members').update({ start_area_id: area }).eq('session_id', SESSION).eq('user_id', who)
const setPicks = (who, patch) => userClient(world, who).from('session_members').update(patch).eq('session_id', SESSION).eq('user_id', who)

describe('POST /api/sessions/:id/meeting-area in voting (E1)', () => {
  it('a chosen area stays where it is and only its travel times move; options that still fit keep their votes', async () => {
    await start({ known: 'bugis' })
    const eat = idsOf('eat')
    await vote(HOST, 'eat', eat[0])
    const minutesBefore = world.session_members.find((m) => m.user_id === GUEST).travel_minutes
    await setStart(GUEST, 'woodlands')
    const res = await t.call('POST', path('/meeting-area'), { trigger: 'start' }, GUEST)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ meetingAreaId: 'bugis', moved: false, votesCleared: false })
    expect(session()).toMatchObject({ meeting_area_id: 'bugis', meeting_method: 'chosen' })
    expect(world.session_members.find((m) => m.user_id === GUEST).travel_minutes).not.toBe(minutesBefore)
    // Woodlands is far from Bugis: the guest's trip is long, and the longest trip on the meeting area is theirs.
    expect(session().meeting_max_minutes).toBe(world.session_members.find((m) => m.user_id === GUEST).travel_minutes)
    expect(session().banner.text).toMatch(/^Meeting area stays at Bugis\. Faith's start location changed\.$/)
    expect(session().banner.votesCleared).toBeUndefined()
    for (const category of ['eat', 'drink', 'shop', 'activity']) expect(optionsOf(category).length).toBeGreaterThanOrEqual(1)
  })

  it('the planner\'s own pick may move: then the options and every vote are cleared and chosen again, and the group is told', async () => {
    await start()
    expect(session().meeting_method).toBe('fairest')
    const from = session().meeting_area_id
    await vote(HOST, 'eat', idsOf('eat')[0])
    await vote(OTHER, 'drink', idsOf('drink')[0])
    // Everyone ends up far to the west.
    await setStart(HOST, 'jurong-east')
    await setStart(GUEST, 'boon-lay')
    await setStart(OTHER, 'jurong-east')
    const res = await t.call('POST', path('/meeting-area'), { trigger: 'start' }, HOST)
    expect(res.status).toBe(200)
    expect(res.body.moved).toBe(true)
    expect(res.body.votesCleared).toBe(true)
    expect(res.body.meetingAreaId).not.toBe(from)
    expect(session().meeting_area_id).toBe(res.body.meetingAreaId)
    expect(everyVoteCount()).toBe(0)
    expect(session().banner).toMatchObject({ votesCleared: true })
    expect(session().banner.text).toMatch(/^Meeting area moved from .+ to .+ because Ian's start location changed\. Votes for places were cleared\.$/)
    expect(typeof session().banner.at).toBe('number')
    // Each slot has places, or says why it has none (nothing for a drink or a shop within 3 km of Jurong East).
    for (const category of ['eat', 'drink', 'shop', 'activity']) {
      if (optionsOf(category).length === 0) expect(slotOf(category).details.empty).toMatchObject({ reason: 'outside_max_radius' })
    }
    expect(optionsOf('eat').length).toBeGreaterThanOrEqual(1)
  })

  it('a repeat that changes nothing writes nothing and adds no notice', async () => {
    await start()
    const version = session().plan_version
    const res = await t.call('POST', path('/meeting-area'), { trigger: 'start' }, HOST)
    expect(res.body.planVersion).toBe(version)
    expect(res.body).toMatchObject({ moved: false, votesCleared: false })
    expect(session().banner).toBeNull()
  })

  it('pauses voting when fewer than two people have a start: no area, no options, the votes go; it comes back with the second start', async () => {
    await start()
    await vote(HOST, 'eat', idsOf('eat')[0])
    await setStart(GUEST, null)
    await setStart(OTHER, null)
    const paused = await t.call('POST', path('/meeting-area'), { trigger: 'start' }, GUEST)
    expect(paused.status).toBe(200)
    expect(paused.body).toMatchObject({ meetingAreaId: null, moved: true })
    expect(session()).toMatchObject({ status: 'voting', meeting_area_id: null })
    expect(world.slot_options).toHaveLength(0)
    expect(everyVoteCount()).toBe(0)
    expect(session().banner.text).toMatch(/^Meeting area cleared because /)
    // The places are not offered, and adding one says why.
    const slotId = slotOf('eat').id
    const add = await t.call('POST', path(`/slots/${slotId}/options`), { venueId: 'tiong-bahru-bakery' }, HOST)
    expect(add.status).toBe(409)
    expect(add.body.error).toBe('no_meeting_area')
    await setStart(GUEST, 'clementi')
    const back = await t.call('POST', path('/meeting-area'), { trigger: 'added' }, GUEST)
    expect(back.body.meetingAreaId).not.toBeNull()
    expect(session().banner.text).toMatch(/^Meeting area set to .+ because Faith added a start location\.$/)
    for (const category of ['eat', 'drink', 'shop', 'activity']) expect(optionsOf(category).length).toBeGreaterThanOrEqual(1)
  })

  it('is refused for a person who has opted out, a stranger (404, and the service key is never used) and once the plan is confirmed', async () => {
    await start()
    world.session_members.find((m) => m.user_id === OTHER).state = 'opted_out'
    expect((await t.call('POST', path('/meeting-area'), {}, OTHER)).body.error).toBe('not_joined')
    const before = serviceReads().length
    const stranger = await t.call('POST', path('/meeting-area'), {}, STRANGER)
    expect(stranger.status).toBe(404)
    expect(serviceReads().length).toBe(before)
    session().status = 'confirmed'
    expect((await t.call('POST', path('/meeting-area'), {}, HOST)).body.error).toBe('not_yet')
  })
})

describe('POST /api/sessions/:id/plan/sync (E3)', () => {
  it('lays the slots out again from what people picked and how long they stay; places that still fit keep their votes', async () => {
    await start({ known: 'bugis' })
    const eat = idsOf('eat')
    await vote(GUEST, 'eat', eat[0])
    const before = { start: slotOf('drink').start_minute, picks: slotOf('drink').picks }
    await setPicks(HOST, { categories: ['eat', 'drink'], stay_until: '15:00:00' })
    await setPicks(GUEST, { categories: ['drink'], stay_until: '14:00:00' })
    const res = await t.call('POST', path('/plan/sync'), {}, HOST)
    expect(res.status).toBe(200)
    expect(res.body.changed).toBe(true)
    expect(slotOf('drink').picks).toBe(2)
    expect(slotOf('drink').start_minute).not.toBe(before.start)
    expect(slotOf('eat').picks).toBe(1)
    expect(votesOf('eat').map((v) => v.venue_id)).toEqual(idsOf('eat').filter((id) => id === eat[0]))
  })

  it('a second call changes nothing: the version stays and changed is false', async () => {
    await start({ known: 'bugis' })
    await setPicks(HOST, { categories: ['eat'] })
    const first = await t.call('POST', path('/plan/sync'), {}, HOST)
    const second = await t.call('POST', path('/plan/sync'), {}, GUEST)
    expect(first.body.changed).toBe(true)
    expect(second.body).toEqual({ planVersion: first.body.planVersion, changed: false })
  })

  it('makes the slots of a voting session that has none (one confirmed before this stage)', async () => {
    await start({ known: 'bugis' })
    world.slot_options.length = 0
    world.votes.length = 0
    world.slots.length = 0
    const res = await t.call('POST', path('/plan/sync'), {}, GUEST)
    expect(res.body.changed).toBe(true)
    expect(world.slots).toHaveLength(4)
    expect(world.slot_options.length).toBeGreaterThanOrEqual(4)
  })

  it('does nothing while inviting or locating, and is refused once confirmed', async () => {
    await start({ status: 'locating' })
    const res = await t.call('POST', path('/plan/sync'), {}, HOST)
    expect(res.body.changed).toBe(false)
    expect(writes()).toHaveLength(0)
    session().status = 'confirmed'
    expect((await t.call('POST', path('/plan/sync'), {}, HOST)).status).toBe(409)
  })
})

describe('PUT /api/sessions/:id/radius (E4)', () => {
  const setRadius = (who, radiusMeters) => t.call('PUT', path('/radius'), { radiusMeters }, who)

  it('is the host\'s: a guest is refused (403), and a radius outside 100 to 3000 is a 400', async () => {
    await start({ known: 'bugis' })
    expect((await setRadius(GUEST, 500)).body.error).toBe('host_only')
    for (const bad of [50, 3001, 1.5, 'x', undefined]) expect((await setRadius(HOST, bad)).status, String(bad)).toBe(400)
    expect(session().radius_meters).toBeNull()
  })

  it('keeps only the places inside the ring, tops each slot up, drops the votes of places that left and says so', async () => {
    await start({ known: 'bugis' })
    const eatBefore = idsOf('eat')
    for (const [who, category] of [[HOST, 'eat'], [GUEST, 'eat'], [OTHER, 'drink']]) await vote(who, category, idsOf(category)[0])
    const res = await setRadius(HOST, 100)
    expect(res.status).toBe(200)
    expect(res.body.radiusMeters).toBe(100)
    expect(session().radius_meters).toBe(100)
    // Every place left is within 100 m of Bugis (the engine's own ring); the others went with their votes.
    for (const o of world.slot_options) expect(o.venue_id.length).toBeLessThanOrEqual(80)
    const lost = 3 - everyVoteCount()
    if (lost > 0) expect(session().banner).toMatchObject({ text: 'Votes for places outside the new ring were cleared.', votesCleared: true, byRadius: true })
    expect(eatBefore.length).toBeGreaterThan(0)
  })

  it('a ring that drops no vote leaves no notice, and takes back its own earlier one', async () => {
    await start({ known: 'bugis' })
    session().banner = { text: 'Votes for places outside the new ring were cleared.', at: 1, votesCleared: true, byRadius: true }
    const res = await setRadius(HOST, 3000)
    expect(res.status).toBe(200)
    expect(session().banner).toBeNull()
    session().banner = { text: 'Meeting area moved from A to B because x.', at: 2 }
    await setRadius(HOST, 2500)
    expect(session().banner).toMatchObject({ at: 2 }) // another notice is left alone
  })

  it('setting the same radius again, or null for none, is a no-op the second time', async () => {
    await start({ known: 'bugis' })
    const first = await setRadius(HOST, 1500)
    const again = await setRadius(HOST, 1500)
    expect(again.body.planVersion).toBe(first.body.planVersion)
    const cleared = await setRadius(HOST, null)
    expect(cleared.body.radiusMeters).toBeNull()
    expect(session().radius_meters).toBeNull()
  })

  it('works while locating too: it sets the radius and ranks nothing', async () => {
    await start({ status: 'locating' })
    const res = await setRadius(HOST, 800)
    expect(res.status).toBe(200)
    expect(session().radius_meters).toBe(800)
    expect(world.slots).toHaveLength(0)
    session().status = 'confirmed'
    expect((await setRadius(HOST, 900)).body.error).toBe('not_yet')
  })
})

describe('slots: remove (E5) and restore (E6)', () => {
  it('the host removes a slot: its places and their votes go, nothing else moves; a guest is refused; a repeat is a no-op', async () => {
    await start({ known: 'bugis' })
    await vote(HOST, 'drink', idsOf('drink')[0])
    await vote(HOST, 'eat', idsOf('eat')[0])
    const slotId = slotOf('drink').id
    expect((await t.call('DELETE', path(`/slots/${slotId}`), undefined, GUEST)).body.error).toBe('host_only')
    const eatBefore = idsOf('eat')
    const res = await t.call('DELETE', path(`/slots/${slotId}`), undefined, HOST)
    expect(res.status).toBe(200)
    expect(slotOf('drink').deleted).toBe(true)
    expect(optionsOf('drink')).toHaveLength(0)
    expect(votesOf('drink')).toHaveLength(0)
    expect(idsOf('eat')).toEqual(eatBefore)
    expect(votesOf('eat')).toHaveLength(1)
    const again = await t.call('DELETE', path(`/slots/${slotId}`), undefined, HOST)
    expect(again.body.planVersion).toBe(res.body.planVersion)
    expect((await t.call('DELETE', path('/slots/99999999-9999-4999-8999-999999999999'), undefined, HOST)).body.error).toBe('slot_not_found')
    expect((await t.call('DELETE', path('/slots/not-a-uuid'), undefined, HOST)).status).toBe(400)
  })

  it('removed slots stay out of the layout; restoring brings back one or all, ranked afresh with their top places', async () => {
    await start({ known: 'bugis' })
    const drink = slotOf('drink').id
    const shop = slotOf('shop').id
    await t.call('DELETE', path(`/slots/${drink}`), undefined, HOST)
    await t.call('DELETE', path(`/slots/${shop}`), undefined, HOST)
    // A sync does not bring them back.
    await t.call('POST', path('/plan/sync'), {}, HOST)
    expect(slotOf('drink').deleted).toBe(true)
    expect((await t.call('POST', path('/slots/restore'), { slotId: drink }, GUEST)).body.error).toBe('host_only')
    const one = await t.call('POST', path('/slots/restore'), { slotId: drink }, HOST)
    expect(one.body.restored).toEqual([drink])
    expect(slotOf('drink').deleted).toBe(false)
    expect(optionsOf('drink').length).toBeGreaterThanOrEqual(1)
    expect(slotOf('shop').deleted).toBe(true)
    const all = await t.call('POST', path('/slots/restore'), {}, HOST)
    expect(all.body.restored).toEqual([shop])
    expect(world.slots.every((s) => !s.deleted)).toBe(true)
    expect((await t.call('POST', path('/slots/restore'), {}, HOST)).body.restored).toEqual([])
    expect((await t.call('POST', path('/slots/restore'), { slotId: '99999999-9999-4999-8999-999999999999' }, HOST)).body.error).toBe('slot_not_found')
  })
})

// A place that fits a slot (and is not an option yet), found through the search the screen uses.
// How to call: await fitting('eat', 'a') // 'some-venue-id'
async function fitting(category, query = 'a', count = 1) {
  const res = await t.call('GET', path(`/slots/${slotOf(category).id}/venue-search?q=${encodeURIComponent(query)}`), undefined, HOST)
  const fits = res.body.results.filter((r) => r.fits && !r.added).map((r) => r.venueId)
  expect(fits.length, `places that fit ${category}`).toBeGreaterThanOrEqual(count)
  return count === 1 ? fits[0] : fits.slice(0, count)
}

describe('places: add (E7), more (E8), swap (E9) and search (E17)', () => {
  it('searches the saved places by name for a slot: fits, why not, and whether already an option; only for a joined member', async () => {
    await start({ known: 'bugis' })
    const written = writes().length
    const slot = slotOf('eat').id
    const res = await t.call('GET', path(`/slots/${slot}/venue-search?q=a`), undefined, GUEST)
    expect(res.status).toBe(200)
    expect(res.body.results.length).toBeGreaterThan(0)
    expect(res.body.results.length).toBeLessThanOrEqual(12)
    for (const r of res.body.results) {
      expect(r).toEqual(expect.objectContaining({ venueId: expect.any(String), name: expect.any(String), fits: expect.any(Boolean), unfit: expect.any(Array), added: expect.any(Boolean) }))
      expect(r.source).not.toBe('google')
      expect(r).not.toHaveProperty('lat')
    }
    const have = idsOf('eat')[0]
    const name = loadPlanData().venues.find((v) => v.id === have).name
    const mine = await t.call('GET', path(`/slots/${slot}/venue-search?q=${encodeURIComponent(name)}`), undefined, GUEST)
    expect(mine.body.results.find((r) => r.venueId === have)?.added).toBe(true)
    expect((await t.call('GET', path(`/slots/${slot}/venue-search?q=`), undefined, GUEST)).status).toBe(400)
    expect((await t.call('GET', path(`/slots/${slot}/venue-search?q=${'x'.repeat(61)}`), undefined, GUEST)).status).toBe(400)
    expect((await t.call('GET', path(`/slots/${slot}/venue-search?q=a`), undefined, STRANGER)).status).toBe(404)
    world.session_members.find((m) => m.user_id === OTHER).state = 'opted_out'
    expect((await t.call('GET', path(`/slots/${slot}/venue-search?q=a`), undefined, OTHER)).body.error).toBe('not_joined')
    expect(writes().length).toBe(written) // search never writes
  })

  it('a member adds a place that fits: 201, kept as theirs; again is 200 and nothing more; the other device sees it', async () => {
    await start({ known: 'bugis' })
    const venue = await fitting('eat')
    const slot = slotOf('eat').id
    const res = await t.call('POST', path(`/slots/${slot}/options`), { venueId: venue }, GUEST)
    expect(res.status).toBe(201)
    expect(res.body.added).toBe(true)
    const row = optionsOf('eat').find((o) => o.venue_id === venue)
    expect(row).toMatchObject({ source: 'member', added_by: GUEST })
    expect(row.details.explanation).toEqual(expect.any(String))
    const seen = await userClient(world, HOST).from('slot_options').select('venue_id').eq('slot_id', slot)
    expect(seen.data.map((o) => o.venue_id)).toContain(venue)
    const again = await t.call('POST', path(`/slots/${slot}/options`), { venueId: venue }, OTHER)
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ planVersion: res.body.planVersion, added: false })
  })

  it('refuses a place that is unknown (404), does not fit (422), or a seventh (409), and a deleted slot', async () => {
    await start({ known: 'bugis' })
    const slot = slotOf('eat').id
    const add = (venueId, who = GUEST) => t.call('POST', path(`/slots/${slot}/options`), { venueId }, who)
    expect((await add('no-such-place')).body.error).toBe('venue_not_found')
    expect((await add('')).status).toBe(400)
    expect((await add('x'.repeat(161))).status).toBe(400)
    // A place of another kind does not fit an Eat slot.
    const drinks = await t.call('GET', path(`/slots/${slotOf('drink').id}/venue-search?q=a`), undefined, HOST)
    const other = drinks.body.results.find((r) => r.fits && r.category === 'drink')
    const res = await add(other.venueId)
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('venue_does_not_fit')
    // Fill the slot to six, then the seventh is refused.
    const venues = await fitting('eat', 'a', 6 - optionsOf('eat').length)
    for (const v of Array.isArray(venues) ? venues : [venues]) expect((await add(v)).status).toBe(201)
    expect(optionsOf('eat')).toHaveLength(6)
    const seventh = await t.call('GET', path(`/slots/${slot}/venue-search?q=a`), undefined, HOST)
    const extra = seventh.body.results.find((r) => r.fits && !r.added)
    if (extra) expect((await add(extra.venueId)).body.error).toBe('slot_full')
    await t.call('DELETE', path(`/slots/${slot}`), undefined, HOST)
    expect((await add(idsOf('drink')[0])).body.error).toBe('slot_not_found')
  })

  it('"more suggestions" adds up to three more than the caller saw, to six; a retry with the same count adds nothing', async () => {
    await start({ known: 'bugis' })
    const slot = slotOf('eat').id
    const have = optionsOf('eat').length
    const more = (n, who = GUEST) => t.call('POST', path(`/slots/${slot}/options/more`), { have: n }, who)
    const first = await more(have)
    expect(first.status).toBe(200)
    expect(first.body.added.length).toBe(Math.min(6, have + 3) - have)
    expect(optionsOf('eat')).toHaveLength(Math.min(6, have + 3))
    const version = first.body.planVersion
    expect((await more(have, OTHER)).body).toEqual({ planVersion: version, added: [] })
    expect((await more(7)).status).toBe(400)
    expect((await more(-1)).status).toBe(400)
    // Added places are the planner's, not the caller's.
    for (const id of first.body.added) expect(optionsOf('eat').find((o) => o.venue_id === id)).toMatchObject({ source: 'planner', added_by: null })
  })

  it('a swap changes the place in place: the votes follow it; swapping again is a no-op; a place that does not fit is refused', async () => {
    await start({ known: 'bugis' })
    const slot = slotOf('eat').id
    const [from] = idsOf('eat')
    const to = await fitting('eat')
    await vote(HOST, 'eat', from)
    await vote(GUEST, 'eat', from)
    const swap = (a, b, who = OTHER) => t.call('POST', path(`/slots/${slot}/options/${a}/swap`), { toVenueId: b }, who)
    const res = await swap(from, to)
    expect(res.status).toBe(200)
    expect(res.body.swapped).toBe(true)
    expect(idsOf('eat')).toContain(to)
    expect(idsOf('eat')).not.toContain(from)
    expect(votesOf('eat').map((v) => v.venue_id)).toEqual([to, to])
    const again = await swap(from, to)
    expect(again.body).toEqual({ planVersion: res.body.planVersion, swapped: false })
    // The place it swapped from is gone and the place it swapped to is there: nothing to do. A place that was never an option is a 404.
    expect((await swap('nothing-here', await fitting('eat'))).body.error).toBe('option_not_found')
    expect((await swap(to, 'no-such-place')).body.error).toBe('venue_not_found')
    const drinks = await t.call('GET', path(`/slots/${slotOf('drink').id}/venue-search?q=a`), undefined, HOST)
    expect((await swap(to, drinks.body.results.find((r) => r.fits).venueId)).body.error).toBe('venue_does_not_fit')
  })

  it('swapping into a place that is already an option merges the votes into it', async () => {
    await start({ known: 'bugis' })
    const slot = slotOf('eat').id
    const [a, b] = idsOf('eat')
    await vote(HOST, 'eat', a)
    await vote(GUEST, 'eat', b)
    const res = await t.call('POST', path(`/slots/${slot}/options/${a}/swap`), { toVenueId: b }, HOST)
    expect(res.body.swapped).toBe(true)
    expect(idsOf('eat')).not.toContain(a)
    expect(votesOf('eat').map((v) => v.venue_id)).toEqual([b, b])
  })
})

describe('a saved place with a long id', () => {
  // The 32 hawker centres saved from OneMap have ids of 86 characters. They are the places a halal group gets, so they must be
  // options like any other: found by search, added, swapped to and from, voted for and read back (the table allows 160).
  const NAME = 'Tampines Round Market and Food Centre'
  const longVenue = () => loadPlanData().venues.find((v) => v.name === NAME)

  it('is found by search, added, voted for, swapped away and swapped back', async () => {
    await start({ known: 'tampines' })
    const long = longVenue()
    expect(long.id.length).toBeGreaterThan(80)
    const slot = slotOf('eat').id
    const found = await t.call('GET', path(`/slots/${slot}/venue-search?q=${encodeURIComponent(NAME)}`), undefined, GUEST)
    expect(found.body.results.find((r) => r.venueId === long.id)).toMatchObject({ fits: true, added: idsOf('eat').includes(long.id) })
    if (!idsOf('eat').includes(long.id)) {
      const added = await t.call('POST', path(`/slots/${slot}/options`), { venueId: long.id }, GUEST)
      expect(added.status).toBe(201)
    }
    expect(idsOf('eat')).toContain(long.id)
    await vote(HOST, 'eat', long.id)
    const other = await fitting('eat')
    const away = await t.call('POST', path(`/slots/${slot}/options/${long.id}/swap`), { toVenueId: other }, OTHER)
    expect(away.body.swapped).toBe(true)
    expect(votesOf('eat').map((v) => v.venue_id)).toEqual([other])
    const back = await t.call('POST', path(`/slots/${slot}/options/${other}/swap`), { toVenueId: long.id }, OTHER)
    expect(back.body.swapped).toBe(true)
    expect(votesOf('eat').map((v) => v.venue_id)).toEqual([long.id])
    const venues = await t.call('GET', `/api/venues?ids=${long.id}`, undefined, HOST)
    expect(venues.body.venues.map((v) => v.id)).toEqual([long.id])
  })

  it('is ranked like any other: the planner is given every saved place, not only those with a short id', async () => {
    const { sessions, runs, as } = await serviceFor({ known: 'tampines' })
    runs.runWithTravel.mockClear()
    await sessions.syncPlan({ ...as(HOST) })
    const [[, planData]] = runs.runWithTravel.mock.calls.filter(([input]) => input.categories)
    expect(planData.venues.some((v) => v.id.length > 80)).toBe(true)
  })
})

describe('GET /api/venues?ids= (E18)', () => {
  it('needs a login, answers the planner\'s venues in the order asked, once each, and leaves unknown ids out', async () => {
    await start({ known: 'bugis' })
    const [a, b] = idsOf('eat')
    expect((await t.call('GET', `/api/venues?ids=${a}`)).status).toBe(401)
    const res = await t.call('GET', `/api/venues?ids=${b},nope,${a},${b}`, undefined, STRANGER)
    expect(res.status).toBe(200)
    expect(res.body.venues.map((v) => v.id)).toEqual([b, a])
    expect(res.body.venues[0]).toMatchObject({ name: expect.any(String), lat: expect.any(Number), category: 'eat' })
    expect((await t.call('GET', '/api/venues?ids=nope', undefined, HOST)).body).toEqual({ venues: [] })
  })

  it('takes at most 50 ids of at most 160 characters, and at least one', async () => {
    await start({ known: 'bugis' })
    const fifty = Array.from({ length: 50 }, (_, i) => `p${i}`).join(',')
    expect((await t.call('GET', `/api/venues?ids=${fifty}`, undefined, HOST)).status).toBe(200)
    const res = await t.call('GET', `/api/venues?ids=${fifty},p50`, undefined, HOST)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_input')
    expect((await t.call('GET', `/api/venues?ids=${'x'.repeat(160)}`, undefined, HOST)).status).toBe(200)
    expect((await t.call('GET', `/api/venues?ids=${'x'.repeat(161)}`, undefined, HOST)).status).toBe(400)
    expect((await t.call('GET', '/api/venues', undefined, HOST)).status).toBe(400)
    expect((await t.call('GET', '/api/venues?ids=,,', undefined, HOST)).status).toBe(400)
  })
})

describe('what the server uses and what it never says', () => {
  it('plans from the centres of areas, never reads an exact place, and shows no coordinate or label of a member in a row or an answer', async () => {
    await start()
    world.session_member_places.push({ session_id: SESSION, user_id: GUEST, start_label: 'Block 12 Secret Lane', start_lat: 1.23456, start_lng: 103.65432, end_label: null, end_lat: null, end_lng: null })
    const bodies = []
    const call = async (...args) => bodies.push((await t.call(...args)).body)
    await call('POST', path('/meeting-area'), { trigger: 'start' }, HOST)
    await call('POST', path('/plan/sync'), {}, GUEST)
    await call('PUT', path('/radius'), { radiusMeters: 1500 }, HOST)
    await call('POST', path(`/slots/${slotOf('eat').id}/options/more`), { have: 1 }, OTHER)
    await call('GET', path(`/slots/${slotOf('eat').id}/venue-search?q=a`), undefined, OTHER)
    expect(world.calls.filter((c) => c.table === 'session_member_places' && c.who === null)).toEqual([])
    const everything = JSON.stringify([bodies, world.slots, world.slot_options, world.votes, session()])
    for (const secret of ['Secret Lane', '1.23456', '103.65432', 'start_label', 'start_lat']) expect(everything).not.toContain(secret)
  })

  it('reads the members\' private needs only after admission: a stranger causes no service-key request at all', async () => {
    await start({ known: 'bugis' })
    const before = world.calls.filter((c) => c.who === null).length
    for (const [method, tail, body] of [
      ['POST', '/plan/sync', {}],
      ['PUT', '/radius', { radiusMeters: 500 }],
      ['DELETE', `/slots/${slotOf('eat').id}`, undefined],
      ['POST', '/slots/restore', {}],
      ['POST', `/slots/${slotOf('eat').id}/options`, { venueId: 'x' }],
      ['POST', `/slots/${slotOf('eat').id}/options/more`, { have: 3 }],
      ['POST', `/slots/${slotOf('eat').id}/options/a/swap`, { toVenueId: 'b' }],
      ['GET', `/slots/${slotOf('eat').id}/venue-search?q=a`, undefined],
    ]) {
      const res = await t.call(method, path(tail), body, STRANGER)
      expect(res.status, `${method} ${tail}`).toBe(404)
      expect(res.body.error).toBe('session_not_found')
    }
    expect(world.calls.filter((c) => c.who === null).length).toBe(before)
    // And without a login they are refused before anything is read.
    expect((await t.call('POST', path('/plan/sync'), {})).status).toBe(401)
  })

  it('ranks with the members\' diets and step-free need from their private needs, and each person\'s start from the centre of their area', async () => {
    const { sessions, runs, as } = await serviceFor({ known: 'bugis' })
    world.profile_private.find((p) => p.id === HOST).dietary = ['halal']
    world.profile_private.find((p) => p.id === OTHER).dietary = ['vegetarian']
    world.profile_private.find((p) => p.id === GUEST).needs_step_free = true
    world.profile_private.find((p) => p.id === GUEST).budget_max_per_person = 12
    runs.runWithTravel.mockClear()
    await sessions.syncPlan({ ...as(HOST) })
    const converges = runs.runWithTravel.mock.calls.filter(([input]) => input.categories)
    expect(converges).toHaveLength(4)
    for (const [input] of converges) {
      expect(input.unknownPolicy).toBe('lenient')
      // A place not known to suit every diet is left out, though other unknowns are kept and flagged.
      expect(input.dietPolicy).toBe('strict')
      expect(input.groupConstraints).toEqual(['step_free'])
      expect(input.groupId).toBe(SESSION)
      expect(new Set(input.members.flatMap((m) => m.dietary))).toEqual(new Set(['halal', 'vegetarian']))
      expect(input.members.find((m) => m.id === GUEST).budgetMaxPerPerson).toBe(12)
      expect(input.centre).toEqual({ lat: expect.any(Number), lng: expect.any(Number) })
      const clementi = loadPlanData().areas.find((a) => a.id === 'clementi')
      expect(input.members.find((m) => m.id === GUEST).start).toEqual({ lat: clementi.lat, lng: clementi.lng })
    }
    // Only the saved venues are ranked. The 32 whose id is over 80 characters are among them: the table allows 160.
    for (const [, planData] of converges) expect(planData.venues.every((v) => v.source !== 'google')).toBe(true)
  })

  it('leaves out a place not known to be halal when one member needs it, and names nobody for it', async () => {
    await start({ status: 'locating' })
    world.profile_private.find((p) => p.id === GUEST).dietary = ['halal']
    expect((await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)).status).toBe(200)
    expect((await t.call('POST', path('/plan/sync'), {}, HOST)).status).toBe(200)
    const data = loadPlanData()
    const eat = world.slot_options.filter((o) => o.slot_id === slotOf('eat').id)
    expect(eat.length).toBeGreaterThan(0)
    for (const o of eat) {
      // The stored row names no need (see "what a member's needs never say" below).
      expect(o.details).not.toHaveProperty('dietUnknown')
      expect(o.details).not.toHaveProperty('verify')
      const venue = data.venues.find((v) => v.id === o.venue_id)
      // Evidence of halal, not a guess: 'unknown' would pass only under a lenient rule.
      expect(['full', 'options', 'likely']).toContain(venue.diet.halal)
    }
    expect(JSON.stringify(world.slot_options)).not.toContain(GUEST)
  })

  it('a member with no start yet adds no trip, but what they cannot eat still counts', async () => {
    const { sessions, runs, as } = await serviceFor({ known: 'bugis', starts: { [HOST]: 'tampines', [GUEST]: null, [OTHER]: 'bishan' } })
    world.profile_private.find((p) => p.id === GUEST).dietary = ['vegan']
    runs.runWithTravel.mockClear()
    await sessions.syncPlan({ ...as(HOST) })
    const [[input]] = runs.runWithTravel.mock.calls.filter(([i]) => i.categories)
    expect(input.members.map((m) => m.id).sort()).toEqual([HOST, OTHER].sort())
    expect(new Set(input.members.flatMap((m) => m.dietary))).toEqual(new Set(['vegan']))
  })

  it('fails the request, not silently, when the members\' needs cannot be read', async () => {
    await start({ known: 'bugis' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    world.failNeeds = true
    const res = await t.call('POST', path('/plan/sync'), {}, HOST)
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('server_error')
  })
})

// A service over a voting world with the planner run spied, for the tests that look at what the planner was asked.
// How to call: const { sessions, runs, as } = await serviceFor({ known: 'bugis' })
async function serviceFor({ known = null, starts } = {}) {
  await start({ known, starts })
  const supabase = fakeSupabase(world, createSupabase({ url: SUPABASE_URL, anonKey: 'a', serviceKey: 's', fetchImpl: jwksFetch }))
  const data = loadPlanData()
  const weatherResolver = createWeatherResolver({ data, weather: createWeather({ http: createHttp({ stub: true }) }) })
  const base = createPlannerRuns({ data, weatherResolver, onemap: null })
  const runs = { ...base, runWithTravel: vi.fn((...args) => base.runWithTravel(...args)) }
  const sessions = createSessions({ supabase, data, runs })
  const as = (id) => ({ client: userClient(world, id), id: SESSION, userId: id })
  return { sessions, runs, as }
}

// Counts the OneMap calls that reach the HTTP layer, in stub mode (the same stand-in sessions-planner.test.js uses).
function countingStubHttp() {
  const real = createHttp({ stub: true })
  const calls = { route: 0 }
  return {
    calls,
    getJson: (url, options) => {
      if (url.includes('/routingsvc/route')) calls.route += 1
      return real.getJson(url, options)
    },
    postJson: (url, body, options) => real.postJson(url, body, options),
  }
}

const AREAS = loadPlanData().areas.map((a) => a.id)
const idOf = (i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`

describe('the limits on searching and on fetching the places behind the cards', () => {
  it('count apart from the writes and from each other, per person', async () => {
    // The confirm used one of the writes' four.
    await start({ known: 'bugis', appOptions: { sessionRateLimit: { windowMs: 60_000, max: 4 }, venueRateLimit: { windowMs: 60_000, max: 2 } } })
    const slot = slotOf('eat').id
    const [a] = idsOf('eat')
    // Two card fetches and two searches use up neither the other's nor the writes' allowance.
    expect((await t.call('GET', `/api/venues?ids=${a}`, undefined, HOST)).status).toBe(200)
    expect((await t.call('GET', `/api/venues?ids=${a}`, undefined, HOST)).status).toBe(200)
    expect((await t.call('GET', path(`/slots/${slot}/venue-search?q=a`), undefined, HOST)).status).toBe(200)
    expect((await t.call('GET', path(`/slots/${slot}/venue-search?q=a`), undefined, HOST)).status).toBe(200)
    for (let i = 0; i < 3; i += 1) expect((await t.call('POST', path('/plan/sync'), {}, HOST)).status).toBe(200)
    // The third of each is held, and says when to try again; the writes' allowance is its own and is now spent.
    const venues = await t.call('GET', `/api/venues?ids=${a}`, undefined, HOST)
    expect(venues.status).toBe(429)
    expect(venues.body.error).toBe('rate_limited')
    const search = await t.call('GET', path(`/slots/${slot}/venue-search?q=a`), undefined, HOST)
    expect(search.status).toBe(429)
    expect(Number(search.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await t.call('POST', path('/plan/sync'), {}, HOST)).status).toBe(429)
    // Another person is not held by it.
    expect((await t.call('GET', `/api/venues?ids=${a}`, undefined, GUEST)).status).toBe(200)
    expect((await t.call('GET', path(`/slots/${slot}/venue-search?q=a`), undefined, GUEST)).status).toBe(200)
  })

  it('a search never uses up the allowance of the writes: with only the writes limited, searching is not', async () => {
    await start({ known: 'bugis', appOptions: { sessionRateLimit: { windowMs: 60_000, max: 3 } } })
    const slot = slotOf('eat').id
    for (let i = 0; i < 6; i += 1) expect((await t.call('GET', path(`/slots/${slot}/venue-search?q=a`), undefined, HOST)).status).toBe(200)
    expect((await t.call('POST', path('/plan/sync'), {}, HOST)).status).toBe(200)
  })
})

describe('what a member\'s needs never say, to the other members', () => {
  // Every member reads the slot rows and the search answers, so in a group of two a need named there is the other person's. The rows and
  // answers carry one flag (`checkNeeds`) and one reason (`group_needs`); the browser names the needs it may name, from the places' own
  // diet levels. GUEST needs halal and step-free access, HOST has no need: if anything names either, HOST learns it.
  const NAMES_OF_NEEDS = /halal|vegan|vegetarian|step_free|step-free|diet|verify|dietUnknown/i
  const bugis = () => loadPlanData().areas.find((a) => a.id === 'bugis')
  // A food place near the meeting area that a halal group cannot be offered (no evidence it is halal), by its name.
  const unfitForHalal = () => {
    const area = bugis()
    return loadPlanData().venues
      .filter((v) => v.category === 'eat' && v.diet && ['none', 'unknown'].includes(v.diet.halal) && Math.hypot(v.lat - area.lat, v.lng - area.lng) * 111 < 2)
      .sort((a, b) => a.name.length - b.name.length)[0]
  }
  const needy = () => {
    world.profile_private.find((p) => p.id === GUEST).dietary = ['halal']
    world.profile_private.find((p) => p.id === GUEST).needs_step_free = true
  }

  it('stores one flag for a place whose halal is unconfirmed, and no word of a need, in a group of two', async () => {
    await start({ status: 'locating', people: [HOST, GUEST] })
    needy()
    expect((await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)).status).toBe(200)
    expect((await t.call('POST', path('/plan/sync'), {}, HOST)).status).toBe(200)
    const eat = optionsOf('eat')
    expect(eat.length).toBeGreaterThan(0)
    // The halal places near Bugis are mostly "likely" (a stall's name, not a certificate), so some option must say to check.
    const flagged = eat.filter((o) => o.details.checkNeeds === true)
    expect(flagged.length).toBeGreaterThan(0)
    for (const row of world.slot_options) {
      expect(row.details).not.toHaveProperty('verify')
      expect(row.details).not.toHaveProperty('dietUnknown')
      // The flag is there only when true.
      if (row.details.checkNeeds !== undefined) expect(row.details.checkNeeds).toBe(true)
      expect(JSON.stringify(row)).not.toMatch(NAMES_OF_NEEDS)
    }
    expect(JSON.stringify(world.slots)).not.toMatch(NAMES_OF_NEEDS)
    // Nor does the session, the members or the answers of the writes that made them.
    expect(JSON.stringify([world.sessions, world.session_members, world.votes])).not.toMatch(NAMES_OF_NEEDS)
  })

  it('answers a search with one reason for a need, and no list of the needs a place only likely meets, in a group of two', async () => {
    await start({ known: 'bugis', people: [HOST, GUEST] })
    needy()
    const venue = unfitForHalal()
    expect(venue).toBeTruthy()
    const slot = slotOf('eat').id
    const res = await t.call('GET', path(`/slots/${slot}/venue-search?q=${encodeURIComponent(venue.name)}`), undefined, HOST)
    expect(res.status).toBe(200)
    const found = res.body.results.find((r) => r.venueId === venue.id)
    expect(found).toMatchObject({ fits: false })
    expect(found.unfit).toContain('group_needs')
    expect(found.unfit.filter((reason) => reason === 'group_needs')).toHaveLength(1)
    // Nothing in the answer names a need or a list of needs, for anyone: HOST (who has none) cannot learn GUEST's.
    for (const r of res.body.results) {
      expect(r).not.toHaveProperty('verify')
      expect(r).not.toHaveProperty('dietUnknown')
      for (const reason of r.unfit) expect(reason).not.toMatch(/^diet:|^step_free$/)
    }
    expect(JSON.stringify(res.body)).not.toMatch(NAMES_OF_NEEDS)
    // The reasons about the place itself are still said.
    const far = await t.call('GET', path(`/slots/${slot}/venue-search?q=Changi`), undefined, HOST)
    expect(far.status).toBe(200)
  })

  it('keeps the other reasons a place does not fit (closed, far, another kind) and says a need only once', async () => {
    const { groupSafeResult } = await import('../src/services/session-slots.js')
    const result = { venueId: 'a', name: 'A', unfit: ['not_an_outing', 'diet:halal', 'step_free', 'diet:vegan', 'closed', 'far'], verify: ['halal'], dietUnknown: ['vegan'], fits: false }
    expect(groupSafeResult(result)).toEqual({ venueId: 'a', name: 'A', unfit: ['not_an_outing', 'group_needs', 'closed', 'far'], fits: false })
    expect(groupSafeResult({ venueId: 'b', unfit: [], verify: [], dietUnknown: [] })).toEqual({ venueId: 'b', unfit: [] })
    expect(groupSafeResult({ venueId: 'c' })).toEqual({ venueId: 'c', unfit: [] })
  })

  it('says the same, and names nothing, in a group of three (the browser asks for the needs of the others, which the server gives at three)', async () => {
    await start({ status: 'locating' })
    needy()
    expect((await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)).status).toBe(200)
    expect((await t.call('POST', path('/plan/sync'), {}, HOST)).status).toBe(200)
    expect(JSON.stringify(world.slot_options)).not.toMatch(NAMES_OF_NEEDS)
    const venue = unfitForHalal()
    const res = await t.call('GET', path(`/slots/${slotOf('eat').id}/venue-search?q=${encodeURIComponent(venue.name)}`), undefined, OTHER)
    expect(JSON.stringify(res.body)).not.toMatch(NAMES_OF_NEEDS)
    expect(res.body.results.find((r) => r.venueId === venue.id).unfit).toContain('group_needs')
    // With three joined, the needs of the others are given to a member who asks; with two they are not.
    const three = await t.call('GET', path('/dietary'), undefined, HOST)
    expect(three.body.others).toEqual(['halal'])
    world.session_members.find((m) => m.user_id === OTHER).state = 'opted_out'
    expect((await t.call('GET', path('/dietary'), undefined, HOST)).body.others).toEqual([])
  })
})

describe('the OneMap cap: one request, at most 60 trips, across the meeting area and all four slots', () => {
  async function bigGroup(count, { known = null } = {}) {
    world = createWorld()
    addSession(world, { id: SESSION, status: 'locating' })
    addMember(world, SESSION, HOST, { role: 'host', start: AREAS[0] })
    for (let i = 1; i < count; i += 1) addMember(world, SESSION, idOf(i), { start: AREAS[i % AREAS.length] })
    for (const m of world.session_members) world.profile_private.push({ id: m.user_id, dietary: [], budget_max_per_person: null, needs_step_free: false })
    const http = countingStubHttp()
    const onemap = createOneMap({ http, email: 'someone@example.test', password: 'not-a-real-password', stub: true })
    t = await startSessionApp(world, { onemap })
    started.push(t)
    return { calls: http.calls, known }
  }

  it('a confirm for 30 people ranks four slots with at most 60 route calls, whole places only, the rest estimated and flagged', async () => {
    const { calls } = await bigGroup(30)
    await t.call('POST', path('/meeting-area'), {}, HOST)
    const afterSpots = calls.route
    const res = await t.call('POST', path('/voting'), {}, HOST)
    expect(res.status).toBe(200)
    expect(res.body.slotCount).toBe(4)
    expect(calls.route - afterSpots).toBeGreaterThan(0)
    expect(calls.route - afterSpots).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
    // Each place is real for everyone or estimated for everyone; once the allowance is spent the later slots are estimates.
    expect(world.slot_options.some((o) => o.details.approximate)).toBe(true)
    expect(world.slot_options.every((o) => o.venue_id.length <= 160)).toBe(true)
  })

  it('a start change in voting (the meeting area and four slots again) is still at most 60 calls', async () => {
    const { calls } = await bigGroup(30)
    await t.call('POST', path('/meeting-area'), {}, HOST)
    await t.call('POST', path('/voting'), {}, HOST)
    const before = calls.route
    await setStart(idOf(1), 'woodlands')
    const res = await t.call('POST', path('/meeting-area'), { trigger: 'start' }, idOf(1))
    expect(res.status).toBe(200)
    expect(calls.route - before).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
  })

  it('asks the planner for 30 people without failing any slot', async () => {
    await bigGroup(30)
    expect((await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)).status).toBe(200)
    expect(world.slots).toHaveLength(4)
  })
})

describe('a late answer never overwrites a newer state', () => {
  it('a sync worked out while the session was voting is dropped when it has been confirmed since: nothing is written', async () => {
    await start({ known: 'bugis' })
    const slots = JSON.stringify(world.slots)
    const options = JSON.stringify(world.slot_options)
    world.hooks.beforeApply = () => {
      world.hooks.beforeApply = null
      Object.assign(session(), { status: 'confirmed', plan_version: session().plan_version + 1 })
    }
    await setPicks(HOST, { categories: ['eat'] })
    const res = await t.call('POST', path('/plan/sync'), {}, HOST)
    expect(res.status).toBe(409)
    expect(['wrong_status', 'not_yet']).toContain(res.body.error)
    expect(JSON.stringify(world.slots)).toBe(slots)
    expect(JSON.stringify(world.slot_options)).toBe(options)
  })

  it('a write that finds the version moved loads again and does its work on the new state (a vote cast meanwhile is kept)', async () => {
    await start({ known: 'bugis' })
    const [kept] = idsOf('eat')
    world.hooks.beforeApply = () => {
      world.hooks.beforeApply = null
      // Someone votes, and someone else's write lands, while this request's answer is being written.
      world.votes.push({ slot_id: slotOf('eat').id, user_id: GUEST, venue_id: kept })
      session().plan_version += 1
    }
    const res = await t.call('PUT', path('/radius'), { radiusMeters: 3000 }, HOST)
    expect(res.status).toBe(200)
    expect(session().radius_meters).toBe(3000)
    expect(votesOf('eat').map((v) => v.venue_id)).toEqual([kept])
  })

  it('answers 409 plan_busy when the session keeps moving', async () => {
    await start({ known: 'bugis' })
    world.staleApply = 5
    const res = await t.call('POST', path('/plan/sync'), {}, HOST)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('plan_busy')
    expect(res.headers.get('retry-after')).toBe('1')
  })

  it('a chosen area stays where it is when a start changes in voting, and the function refuses to move it even if told to', async () => {
    await start({ known: 'bugis' })
    expect(session().meeting_method).toBe('chosen')
    await setStart(HOST, 'woodlands')
    await t.call('POST', path('/meeting-area'), { trigger: 'start' }, HOST)
    expect(session()).toMatchObject({ meeting_area_id: 'bugis', meeting_method: 'chosen' })
    const move = { session: { meeting: { area_id: 'orchard', method: 'chosen', max_minutes: 10, total_minutes: 20, count: 2, approximate: false } } }
    expect(() => applySessionPlan(world, { sid: SESSION, expected_version: session().plan_version, expected_status: 'voting', patch: move })).toThrow(/chosen/)
    expect(session()).toMatchObject({ meeting_area_id: 'bugis' })
  })
})

describe('the line a session\'s writes wait in, in voting', () => {
  it('answers a rush of syncs with one write between them', async () => {
    const { sessions, runs, as } = await serviceFor({ known: 'bugis' })
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const real = runs.runWithTravel.getMockImplementation()
    let first = true
    runs.runWithTravel.mockImplementation(async (...args) => {
      if (first) {
        first = false
        await gate
      }
      return real(...args)
    })
    await setPicks(HOST, { categories: ['eat'] })
    const writesBefore = writes().length
    const a = sessions.syncPlan({ ...as(HOST) })
    await vi.waitFor(() => expect(runs.runWithTravel).toHaveBeenCalled())
    const b = sessions.syncPlan({ ...as(GUEST) })
    const c = sessions.syncPlan({ ...as(OTHER) })
    await vi.waitFor(() => expect(sessions.queue.waiting(SESSION)).toBe(2))
    release()
    const answers = await Promise.all([a, b, c])
    // The running sync finished while others waited, so it did not write: the waiting run served all three.
    expect(writes().length - writesBefore).toBe(1)
    expect(new Set(answers.map((x) => x.planVersion)).size).toBe(1)
    expect(sessions.queue.busy()).toBe(0)
  })
})

describe('the stand-in for apply_session_plan keeps the function\'s small rules (db/tests/apply_session_plan.sql steps 151 to 162)', () => {
  const apply = (patch, version = session().plan_version) => applySessionPlan(world, { sid: SESSION, expected_version: version, expected_status: 'voting', patch })

  it('a swap of a place for itself changes nothing: the place, its votes and the version stay', async () => {
    await start({ known: 'bugis' })
    const [venue] = idsOf('eat')
    await vote(HOST, 'eat', venue)
    const version = session().plan_version
    expect(apply({ ops: [{ op: 'swap_option', category: 'eat', from: venue, to: venue }] })).toBe(version)
    expect(idsOf('eat')).toContain(venue)
    expect(votesOf('eat').map((v) => v.venue_id)).toEqual([venue])
    expect(() => apply({ ops: [{ op: 'swap_option', category: 'shop-that-is-not-there', from: venue, to: venue }] })).toThrow(/no .* slot/)
  })

  it('refuses a part of the plan or of the session that it does not know, even from a late writer, and takes the ones it knows', async () => {
    await start({ known: 'bugis' })
    const version = session().plan_version
    expect(() => apply({ slotz: [] })).toThrow(/slotz/)
    expect(() => apply({ session: { radius: 1000 } })).toThrow(/radius/)
    expect(() => apply({ session: [] })).toThrow()
    expect(() => apply({ session: null })).toThrow()
    expect(() => apply({ opz: [] }, version - 1)).toThrow(/opz/)
    expect(session().plan_version).toBe(version)
    expect(apply({ ops: [], slots: [], session: {}, loaded_at: null, recomputed: false, banner_text: null })).toBe(version)
    // The error carries the code the SQL raises.
    try {
      apply({ slotz: [] })
    } catch (err) {
      expect(err.code).toBe('22023')
    }
  })

  it('writes a member\'s minutes only where they differ', async () => {
    await start({ known: 'bugis' })
    const rows = world.session_members.filter((m) => m.session_id === SESSION)
    const writes = new Map()
    for (const row of rows) {
      let value = row.travel_minutes ?? null
      writes.set(row.user_id, 0)
      Object.defineProperty(row, 'travel_minutes', { get: () => value, set: (next) => { value = next; writes.set(row.user_id, writes.get(row.user_id) + 1) }, enumerable: true, configurable: true })
    }
    const travel = Object.fromEntries(rows.map((m) => [m.user_id, 12]))
    const meeting = (minutes) => ({ area_id: 'bugis', method: 'chosen', max_minutes: 12, total_minutes: 36, count: 3, approximate: false, travel: minutes })
    apply({ session: { meeting: meeting(travel), banner: { text: 'First.' } } })
    const first = new Map(writes)
    apply({ session: { meeting: meeting(travel), banner: { text: 'Second.' } } })
    expect(new Map(writes)).toEqual(first)
    apply({ session: { meeting: meeting({ ...travel, [GUEST]: 14 }), banner: { text: 'Third.' } } })
    expect(writes.get(GUEST)).toBe(first.get(GUEST) + 1)
    expect(writes.get(HOST)).toBe(first.get(HOST))
  })
})
