import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSupabase } from '../src/db/supabase.js'
import { loadPlanData } from '../src/db/venues.js'
import { createPlannerRuns } from '../src/services/planner-runs.js'
import { createSessions } from '../src/services/sessions.js'
import { createWorld, fakeSupabase, jwksFetch, SUPABASE_URL, userClient } from './helpers/fake-supabase.js'
import { addMember, addSession, GUEST, HOST, OTHER, SESSION, startSessionApp, STRANGER } from './helpers/session-app.js'

// The meeting-spot endpoints (stage 3, server half), tested without the network: E1 meeting-area, E19 and E20 spots/mine, E2 voting,
// E21 known-place, E10 opt-out and E11 rejoin. The login check is the real code; the database is the fake in
// helpers/fake-supabase.js, whose apply_session_plan is a JavaScript twin of the SQL function. Leave and remove (E25) are in
// sessions.test.js and the OneMap cap and the queue are in sessions-planner.test.js.
//
// The people: HOST starts at Tampines, GUEST at Clementi, OTHER has not shared a start yet.
const BOTH = [GUEST, HOST].sort()
const NAMES = { [HOST]: 'Ian', [GUEST]: 'Faith', [OTHER]: 'Jonathan' }

let world
let t
const started = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(started.splice(0).map((s) => s.stop()))
})

// A world with one session and three members, and an app over it.
//   status:  the session's status (default locating)
//   starts:  start area by person (default as described above)
// How to call: await start({ status: 'inviting' })
async function start({ status = 'locating', version = 0, starts = { [HOST]: 'tampines', [GUEST]: 'clementi', [OTHER]: null }, appOptions = {} } = {}) {
  world = createWorld()
  addSession(world, { id: SESSION, status, version })
  addMember(world, SESSION, HOST, { role: 'host', start: starts[HOST], name: NAMES[HOST] })
  addMember(world, SESSION, GUEST, { start: starts[GUEST], name: NAMES[GUEST] })
  addMember(world, SESSION, OTHER, { start: starts[OTHER], name: NAMES[OTHER] })
  t = await startSessionApp(world, appOptions)
  started.push(t)
  return t
}

const path = (tail = '') => `/api/sessions/${SESSION}${tail}`
const session = () => world.sessions.find((s) => s.id === SESSION)
const spots = () => world.session_spots.filter((s) => s.session_id === SESSION)
const ranked = () => spots().filter((s) => s.rank !== null).sort((a, b) => a.rank - b.rank)
const areaIds = () => spots().map((s) => s.area_id).sort()
const approvalsOf = (area) => world.spot_approvals.filter((a) => a.area_id === area).map((a) => a.user_id).sort()
const writes = () => world.calls.filter((c) => c.rpc === 'apply_session_plan')

// "Works for me" is a direct write by the browser, under the access rules.
// How to call: await approve(GUEST, 'bugis')
const approve = (who, area) => userClient(world, who).from('spot_approvals').insert({ session_id: SESSION, area_id: area, user_id: who })
const withdrawApproval = (who, area) => userClient(world, who).from('spot_approvals').delete().eq('session_id', SESSION).eq('area_id', area).eq('user_id', who)
// A member's own start, also a direct write.
const setStart = (who, area) => userClient(world, who).from('session_members').update({ start_area_id: area }).eq('session_id', SESSION).eq('user_id', who)

// The first ranked spot, and the two areas the group could suggest that are not among the app's three.
const notRanked = (count = 1) => ['bugis', 'orchard', 'woodlands', 'bedok', 'jurong-east', 'punggol', 'tuas-link', 'boon-lay', 'changi-airport']
  .filter((a) => !ranked().some((s) => s.area_id === a)).slice(0, count)

describe('POST /api/sessions/:id/meeting-area (E1)', () => {
  it('lists the app\'s three spots from two starts, with each located member\'s minutes, and writes nothing else', async () => {
    await start()
    const res = await t.call('POST', path('/meeting-area'), { trigger: 'start' }, GUEST)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ planVersion: 1, meetingAreaId: null, moved: false, votesCleared: false, skipped: [OTHER], spots: 3, approvalsRemoved: [] })
    expect(ranked().map((s) => s.rank)).toEqual([1, 2, 3])
    for (const s of spots()) {
      expect(Object.keys(s.travel_minutes).sort()).toEqual(BOTH)
      expect(s.worst_minutes).toBe(Math.max(...Object.values(s.travel_minutes)))
      expect(s.mean_minutes).toBeLessThanOrEqual(s.worst_minutes)
    }
    // The first spot is the fairest: its longest trip is the shortest of the three.
    expect(ranked()[0].worst_minutes).toBeLessThanOrEqual(ranked()[1].worst_minutes)
    // The meeting area stays empty while locating.
    expect(session().meeting_area_id).toBeNull()
    expect(session().meeting_method).toBeNull()
    expect(session().status).toBe('locating')
  })

  it('works in inviting too, and a changed start moves the times on the list', async () => {
    await start({ status: 'inviting' })
    expect((await t.call('POST', path('/meeting-area'), {}, HOST)).status).toBe(200)
    const before = JSON.stringify(spots().map((s) => [s.area_id, s.travel_minutes]))
    await setStart(GUEST, 'woodlands')
    const res = await t.call('POST', path('/meeting-area'), { trigger: 'start' }, GUEST)
    expect(res.status).toBe(200)
    expect(JSON.stringify(spots().map((s) => [s.area_id, s.travel_minutes]))).not.toBe(before)
    expect(res.body.planVersion).toBe(2)
  })

  it('lists nothing under two starts, and says who has not shared one', async () => {
    await start({ starts: { [HOST]: 'tampines', [GUEST]: null, [OTHER]: null } })
    const res = await t.call('POST', path('/meeting-area'), {}, HOST)
    expect(res.status).toBe(200)
    expect(res.body.spots).toBe(0)
    expect(res.body.skipped.sort()).toEqual([GUEST, OTHER].sort())
    expect(spots()).toEqual([])
    expect(res.body.planVersion).toBe(0) // nothing changed, so the version did not move
  })

  it('skips a member whose start is not an area the planner knows, instead of failing', async () => {
    await start({ starts: { [HOST]: 'tampines', [GUEST]: 'clementi', [OTHER]: 'not-an-area' } })
    const res = await t.call('POST', path('/meeting-area'), {}, HOST)
    expect(res.status).toBe(200)
    expect(res.body.skipped).toEqual([OTHER])
    expect(spots()).toHaveLength(3)
  })

  it('keeps a member\'s suggestion on the list when the app\'s three would not include it, and leaves the app\'s three as they are', async () => {
    await start()
    await t.call('POST', path('/meeting-area'), {}, HOST)
    const appsThree = ranked().map((s) => s.area_id)
    const [far] = notRanked()
    world.spot_suggestions.push({ session_id: SESSION, user_id: OTHER, area_id: far, here: false, created_at: '2026-10-20T08:00:00.000Z' })
    const res = await t.call('POST', path('/meeting-area'), {}, HOST)
    expect(res.status).toBe(200)
    expect(ranked().map((s) => s.area_id)).toEqual(appsThree)
    const suggested = spots().find((s) => s.area_id === far)
    expect(suggested.rank).toBeNull()
    expect(Object.keys(suggested.travel_minutes).sort()).toEqual(BOTH)
    expect(res.body.spots).toBe(4)
  })

  it('writes a difference: approvals on surviving spots stay, a spot that drops out takes its approvals and the group is told', async () => {
    await start()
    await t.call('POST', path('/meeting-area'), {}, HOST)
    const before = ranked().map((s) => s.area_id)
    for (const area of before) {
      await approve(HOST, area)
      await approve(GUEST, area)
    }
    // The guest moves far away, so the fairest spots change.
    await setStart(GUEST, 'woodlands')
    const res = await t.call('POST', path('/meeting-area'), { trigger: 'start' }, GUEST)
    const after = ranked().map((s) => s.area_id)
    const dropped = before.filter((a) => !after.includes(a))
    const kept = before.filter((a) => after.includes(a))
    expect(dropped.length).toBeGreaterThan(0) // the scenario really changes the list
    expect(res.body.approvalsRemoved.sort()).toEqual([...dropped].sort())
    for (const a of dropped) expect(approvalsOf(a)).toEqual([])
    for (const a of kept) expect(approvalsOf(a)).toEqual([GUEST, HOST].sort())
    expect(session().banner.approvalsRemoved).toBe(true)
    expect(session().banner.text).toContain("Faith's start location changed.")
    expect(session().banner.text).toContain('no longer on the list, so approvals for')
    expect(typeof session().banner.at).toBe('number')
  })

  it('sets no banner when a spot drops out that nobody approved', async () => {
    await start()
    await t.call('POST', path('/meeting-area'), {}, HOST)
    await setStart(GUEST, 'woodlands')
    const res = await t.call('POST', path('/meeting-area'), {}, GUEST)
    expect(res.body.approvalsRemoved).toEqual([])
    expect(session().banner).toBeNull()
  })

  it('does not raise the version when nothing changed, so repeating it leaves the database as it was', async () => {
    await start()
    const first = await t.call('POST', path('/meeting-area'), {}, HOST)
    const rows = JSON.stringify(spots())
    const second = await t.call('POST', path('/meeting-area'), {}, GUEST)
    expect(second.body.planVersion).toBe(first.body.planVersion)
    expect(JSON.stringify(spots())).toBe(rows)
  })

  it('answers 409 not_yet in voting, and 409 wrong_status once confirmed, completed or cancelled', async () => {
    await start({ status: 'voting' })
    const voting = await t.call('POST', path('/meeting-area'), {}, HOST)
    expect(voting.status).toBe(409)
    expect(voting.body.error).toBe('not_yet')
    for (const status of ['confirmed', 'completed', 'cancelled']) {
      session().status = status
      const res = await t.call('POST', path('/meeting-area'), {}, HOST)
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('wrong_status')
    }
    expect(spots()).toEqual([])
  })

  it('refuses a person outside the session with 404 and never touches the service key', async () => {
    await start()
    const res = await t.call('POST', path('/meeting-area'), {}, STRANGER)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('session_not_found')
    expect(world.calls.filter((c) => c.who === null)).toEqual([])
  })

  it('refuses a member who opted out with 403 not_joined', async () => {
    await start()
    world.session_members.find((m) => m.user_id === OTHER).state = 'opted_out'
    const res = await t.call('POST', path('/meeting-area'), {}, OTHER)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('not_joined')
  })

  it('checks the login and the input: no token, a bad session id, a bad trigger, an extra field', async () => {
    await start()
    expect((await t.call('POST', path('/meeting-area'), {}, null)).status).toBe(401)
    const badId = await t.call('POST', '/api/sessions/not-a-uuid/meeting-area', {}, HOST)
    expect(badId.status).toBe(400)
    expect(badId.body.error).toBe('invalid_input')
    const badTrigger = await t.call('POST', path('/meeting-area'), { trigger: 'sideways' }, HOST)
    expect(badTrigger.status).toBe(400)
    expect(badTrigger.body.issues[0].path).toBe('trigger')
    expect((await t.call('POST', path('/meeting-area'), { trigger: 'start', members: [] }, HOST)).status).toBe(400)
    expect(writes()).toHaveLength(0)
  })

  it('works out the spots from the centres of areas and never reads an exact place', async () => {
    await start()
    world.session_member_places.push({ session_id: SESSION, user_id: GUEST, start_label: '12 Secret Lane, Singapore 123456', start_lat: 1.3333, start_lng: 103.8888, end_label: null, end_lat: null, end_lng: null })
    const res = await t.call('POST', path('/meeting-area'), {}, HOST)
    expect(world.calls.some((c) => c.table === 'session_member_places')).toBe(false)
    const everything = JSON.stringify([res.body, spots(), session()])
    for (const secret of ['Secret Lane', '123456', '1.3333', '103.8888', 'lat', 'lng']) expect(everything).not.toContain(secret)
  })
})

describe('PUT and DELETE /api/sessions/:id/spots/mine (E19, E20)', () => {
  const listed = async () => {
    await start()
    await t.call('POST', path('/meeting-area'), {}, HOST)
  }

  it('suggests an area that is not listed: priced for everyone, no rank, the suggestion saved with "here"', async () => {
    await listed()
    const [far] = notRanked()
    const res = await t.call('PUT', path('/spots/mine'), { areaId: far, here: true }, GUEST)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ planVersion: 2, spots: 4, approvalsRemoved: [] })
    const spot = spots().find((s) => s.area_id === far)
    expect(spot.rank).toBeNull()
    expect(Object.keys(spot.travel_minutes).sort()).toEqual(BOTH)
    expect(world.spot_suggestions).toEqual([expect.objectContaining({ user_id: GUEST, area_id: far, here: true })])
  })

  it('suggests an area the app already lists without a planner run, and the suggestion keeps it listed', async () => {
    await listed()
    const [first] = ranked()
    const computedAt = first.computed_at
    const res = await t.call('PUT', path('/spots/mine'), { areaId: first.area_id }, OTHER)
    expect(res.status).toBe(200)
    expect(res.body.spots).toBe(3)
    expect(world.spot_suggestions).toEqual([expect.objectContaining({ user_id: OTHER, area_id: first.area_id, here: false })])
    expect(spots().find((s) => s.area_id === first.area_id).computed_at).toBe(computedAt) // not priced again
  })

  it('replaces the caller\'s earlier suggestion: the old spot leaves the list with its approvals, and the group is told', async () => {
    await listed()
    const [a, b] = notRanked(2)
    await t.call('PUT', path('/spots/mine'), { areaId: a }, GUEST)
    await approve(HOST, a)
    const res = await t.call('PUT', path('/spots/mine'), { areaId: b }, GUEST)
    expect(res.status).toBe(200)
    expect(res.body.approvalsRemoved).toEqual([a])
    expect(areaIds()).not.toContain(a)
    expect(areaIds()).toContain(b)
    expect(approvalsOf(a)).toEqual([])
    expect(world.spot_suggestions).toHaveLength(1)
    expect(session().banner.text).toContain('Faith suggested')
    expect(session().banner.text).toContain('no longer on the list')
  })

  it('lets two members suggest one area, and keeps it listed until both have taken theirs back', async () => {
    await listed()
    const [far] = notRanked()
    await t.call('PUT', path('/spots/mine'), { areaId: far }, GUEST)
    await t.call('PUT', path('/spots/mine'), { areaId: far }, OTHER)
    expect(world.spot_suggestions).toHaveLength(2)
    await t.call('DELETE', path('/spots/mine'), undefined, GUEST)
    expect(areaIds()).toContain(far)
    await t.call('DELETE', path('/spots/mine'), undefined, OTHER)
    expect(areaIds()).not.toContain(far)
  })

  it('takes a suggestion back with no planner run; the app\'s own spot stays, and approvals for a spot that goes go with it', async () => {
    await listed()
    const [far] = notRanked()
    const [first] = ranked()
    await t.call('PUT', path('/spots/mine'), { areaId: first.area_id }, OTHER)
    await t.call('PUT', path('/spots/mine'), { areaId: far }, GUEST)
    await approve(HOST, far)
    const stays = await t.call('DELETE', path('/spots/mine'), undefined, OTHER)
    expect(stays.status).toBe(200)
    expect(areaIds()).toContain(first.area_id)
    const goes = await t.call('DELETE', path('/spots/mine'), undefined, GUEST)
    expect(goes.body).toEqual({ planVersion: goes.body.planVersion })
    expect(areaIds()).not.toContain(far)
    expect(approvalsOf(far)).toEqual([])
    expect(session().banner.approvalsRemoved).toBe(true)
    expect(session().banner.text).toContain('Faith withdrew their suggestion.')
  })

  it('does nothing, and writes nothing, when there is no suggestion to take back', async () => {
    await listed()
    const version = session().plan_version
    const res = await t.call('DELETE', path('/spots/mine'), undefined, OTHER)
    expect(res.status).toBe(200)
    expect(res.body.planVersion).toBe(version)
    expect(session().plan_version).toBe(version)
  })

  it('refuses a ninth different area with 409 too_many_spots, but lets the same area be suggested again', async () => {
    await listed()
    const members = [HOST, GUEST, OTHER]
    const extra = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`)
    extra.forEach((id) => addMember(world, SESSION, id, { start: 'bishan' }))
    const all = [...members, ...extra]
    const areas = ['bugis', 'orchard', 'woodlands', 'bedok', 'jurong-east', 'punggol', 'tuas-link', 'boon-lay', 'changi-airport']
    for (let i = 0; i < 8; i += 1) {
      expect((await t.call('PUT', path('/spots/mine'), { areaId: areas[i] }, all[i])).status).toBe(200)
    }
    const ninth = await t.call('PUT', path('/spots/mine'), { areaId: areas[8] }, all[8])
    expect(ninth.status).toBe(409)
    expect(ninth.body.error).toBe('too_many_spots')
    expect(world.spot_suggestions).toHaveLength(8)
    // The same area as another member's is not a new area.
    expect((await t.call('PUT', path('/spots/mine'), { areaId: areas[0] }, all[8])).status).toBe(200)
  })

  it('refuses a new area under two starts with 409 no_spots', async () => {
    await start({ starts: { [HOST]: 'tampines', [GUEST]: null, [OTHER]: null } })
    const res = await t.call('PUT', path('/spots/mine'), { areaId: 'bugis' }, HOST)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('no_spots')
    expect(world.spot_suggestions).toEqual([])
  })

  it('refuses an area the planner does not know with 422 unknown_area, before anything is read or written', async () => {
    await listed()
    const calls = world.calls.length
    const res = await t.call('PUT', path('/spots/mine'), { areaId: 'atlantis' }, GUEST)
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('unknown_area')
    expect(world.calls.length).toBe(calls)
    expect(world.spot_suggestions).toEqual([])
  })

  it('needs locating, a joined caller, and a valid body', async () => {
    await listed()
    session().status = 'inviting'
    expect((await t.call('PUT', path('/spots/mine'), { areaId: 'bugis' }, GUEST)).body.error).toBe('wrong_status')
    expect((await t.call('DELETE', path('/spots/mine'), undefined, GUEST)).body.error).toBe('wrong_status')
    session().status = 'locating'
    expect((await t.call('PUT', path('/spots/mine'), { areaId: 'bugis' }, STRANGER)).status).toBe(404)
    world.session_members.find((m) => m.user_id === OTHER).state = 'opted_out'
    expect((await t.call('PUT', path('/spots/mine'), { areaId: 'bugis' }, OTHER)).body.error).toBe('not_joined')
    expect((await t.call('PUT', path('/spots/mine'), {}, GUEST)).status).toBe(400)
    expect((await t.call('PUT', path('/spots/mine'), { areaId: 'x'.repeat(61) }, GUEST)).status).toBe(400)
    expect((await t.call('PUT', path('/spots/mine'), { areaId: 'bugis', here: 'yes' }, GUEST)).status).toBe(400)
    expect((await t.call('PUT', path('/spots/mine'), { areaId: 'bugis', extra: 1 }, GUEST)).status).toBe(400)
    expect(world.spot_suggestions).toEqual([])
  })
})

describe('"Works for me" and a member\'s own start are direct writes under the access rules', () => {
  it('lets a joined member approve a listed spot while locating, and refuses once the host has confirmed', async () => {
    await start()
    await t.call('POST', path('/meeting-area'), {}, HOST)
    const [first] = ranked()
    expect((await approve(GUEST, first.area_id)).error).toBeNull()
    const confirmed = await t.call('POST', path('/voting'), {}, HOST)
    expect(confirmed.status).toBe(200)
    const late = await approve(OTHER, first.area_id)
    expect(late.error.code).toBe('42501')
    expect(approvalsOf(first.area_id)).toEqual([GUEST])
  })

  it('refuses an approval for a spot that is not listed, for someone else, or by someone who opted out', async () => {
    await start()
    await t.call('POST', path('/meeting-area'), {}, HOST)
    expect((await approve(GUEST, 'atlantis')).error.code).toBe('23503')
    const [first] = ranked()
    const forOther = await userClient(world, GUEST).from('spot_approvals').insert({ session_id: SESSION, area_id: first.area_id, user_id: HOST })
    expect(forOther.error.code).toBe('42501')
    world.session_members.find((m) => m.user_id === OTHER).state = 'opted_out'
    expect((await approve(OTHER, first.area_id)).error.code).toBe('42501')
  })
})

describe('POST /api/sessions/:id/voting (E2)', () => {
  const listed = async (options) => {
    await start(options)
    await t.call('POST', path('/meeting-area'), {}, HOST)
  }

  it('confirms the preselected spot: the one with the most approvals, from its stored figures, and moves to voting', async () => {
    await listed()
    const [first, second] = ranked()
    await approve(GUEST, second.area_id)
    await approve(OTHER, second.area_id)
    await approve(HOST, first.area_id)
    const res = await t.call('POST', path('/voting'), {}, HOST)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ planVersion: res.body.planVersion, status: 'voting', meetingAreaId: second.area_id, method: 'voted', slotCount: 0 })
    expect(session()).toMatchObject({
      status: 'voting',
      meeting_area_id: second.area_id,
      meeting_method: 'voted',
      meeting_count: 2,
      meeting_max_minutes: Math.round(Math.max(...Object.values(second.travel_minutes))),
      meeting_approximate: second.approximate,
      banner: null,
    })
    expect(session().meeting_total_minutes).toBe(Object.values(second.travel_minutes).reduce((s, m) => s + Math.round(m), 0))
    expect(world.session_members.find((m) => m.user_id === GUEST).travel_minutes).toBe(Math.round(second.travel_minutes[GUEST]))
    expect(world.session_members.find((m) => m.user_id === OTHER).travel_minutes).toBeNull()
    // The spots stay as the record.
    expect(spots()).toHaveLength(3)
  })

  it('breaks a tie between spots by the shorter longest trip, then by the list\'s own order', async () => {
    await listed()
    const [first, second, third] = ranked()
    // Ranked fairest first, so on a tie the first of the list wins.
    await approve(GUEST, second.area_id)
    await approve(GUEST, third.area_id)
    await approve(HOST, second.area_id)
    await approve(HOST, third.area_id)
    expect((await t.call('POST', path('/voting'), {}, HOST)).body.meetingAreaId).toBe(second.area_id)
    // A suggestion with a shorter longest trip than the one that would win a tie takes it: make the third spot the shortest.
    world.sessions[0].status = 'locating'
    world.sessions[0].meeting_area_id = null
    world.sessions[0].meeting_method = null
    third.worst_minutes = 1
    third.mean_minutes = 1
    third.travel_minutes = { [HOST]: 1, [GUEST]: 1 }
    expect((await t.call('POST', path('/voting'), {}, HOST)).body.meetingAreaId).toBe(third.area_id)
    expect(first.rank).toBe(1)
  })

  it('offers the first spot, the planner\'s own pick, when nobody approved anything, and keeps the planner\'s method', async () => {
    await listed()
    const [first] = ranked()
    const res = await t.call('POST', path('/voting'), {}, HOST)
    expect(res.body.meetingAreaId).toBe(first.area_id)
    expect(res.body.method).toBe('fairest')
  })

  it('calls it "same" when everyone starts in one place, and "chosen" when the host picks a spot the app did not put first', async () => {
    await listed({ starts: { [HOST]: 'bishan', [GUEST]: 'bishan', [OTHER]: null } })
    expect((await t.call('POST', path('/voting'), {}, HOST)).body.method).toBe('same')
    await start()
    await t.call('POST', path('/meeting-area'), {}, HOST)
    const [, second] = ranked()
    const res = await t.call('POST', path('/voting'), { areaId: second.area_id }, HOST)
    expect(res.body).toMatchObject({ meetingAreaId: second.area_id, method: 'chosen' })
  })

  it('confirms a named spot, including a member\'s suggestion', async () => {
    await listed()
    const [far] = notRanked()
    await t.call('PUT', path('/spots/mine'), { areaId: far, here: true }, GUEST)
    const res = await t.call('POST', path('/voting'), { areaId: far }, HOST)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ meetingAreaId: far, method: 'chosen' })
  })

  it('refuses a spot that is not on the list (404 spot_not_found), an unknown area (422), and an empty list (409 no_spots)', async () => {
    await listed()
    const [far] = notRanked()
    const missing = await t.call('POST', path('/voting'), { areaId: far }, HOST)
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('spot_not_found')
    expect((await t.call('POST', path('/voting'), { areaId: 'atlantis' }, HOST)).status).toBe(422)
    await start({ starts: { [HOST]: 'tampines', [GUEST]: null, [OTHER]: null } })
    await t.call('POST', path('/meeting-area'), {}, HOST)
    const none = await t.call('POST', path('/voting'), {}, HOST)
    expect(none.status).toBe(409)
    expect(none.body.error).toBe('no_spots')
    expect(session().status).toBe('locating')
  })

  it('is the host\'s alone: a guest, an outsider and someone who opted out are refused', async () => {
    await listed()
    const guest = await t.call('POST', path('/voting'), {}, GUEST)
    expect(guest.status).toBe(403)
    expect(guest.body.error).toBe('host_only')
    expect((await t.call('POST', path('/voting'), {}, STRANGER)).status).toBe(404)
    world.session_members.find((m) => m.user_id === HOST).state = 'opted_out'
    expect((await t.call('POST', path('/voting'), {}, HOST)).body.error).toBe('not_joined')
    expect(session().status).toBe('locating')
  })

  it('needs locating: inviting and a finished session are 409 wrong_status', async () => {
    await listed()
    for (const status of ['inviting', 'confirmed', 'completed', 'cancelled']) {
      session().status = status
      const res = await t.call('POST', path('/voting'), {}, HOST)
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('wrong_status')
    }
  })

  it('answers a repeat for the same spot with the same answer and writes nothing more', async () => {
    await listed()
    const first = await t.call('POST', path('/voting'), {}, HOST)
    const again = await t.call('POST', path('/voting'), { areaId: first.body.meetingAreaId }, HOST)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    const other = ranked().find((s) => s.area_id !== first.body.meetingAreaId)
    const different = await t.call('POST', path('/voting'), { areaId: other.area_id }, HOST)
    expect(different.status).toBe(409)
    expect(different.body.error).toBe('wrong_status')
    expect(session().meeting_area_id).toBe(first.body.meetingAreaId)
  })

  it('does not count the approvals of someone who is no longer joined', async () => {
    await listed()
    const [first, second] = ranked()
    await approve(OTHER, second.area_id)
    world.session_members.find((m) => m.user_id === OTHER).state = 'opted_out' // (the server also deletes the approvals; this is the belt)
    const res = await t.call('POST', path('/voting'), {}, HOST)
    expect(res.body.meetingAreaId).toBe(first.area_id)
  })

  it('leaves the slots to the voting stage and says so: slotCount is what exists', async () => {
    await listed()
    const res = await t.call('POST', path('/voting'), {}, HOST)
    expect(res.body.slotCount).toBe(0)
    world.slots.push({ id: 's1', session_id: SESSION, deleted: false }, { id: 's2', session_id: SESSION, deleted: true })
    expect((await t.call('POST', path('/voting'), {}, HOST)).body.slotCount).toBe(1)
  })
})

describe('a late answer never undoes a confirmation', () => {
  it('drops a recompute worked out while locating once the host has confirmed, and leaves the meeting area alone', async () => {
    await start()
    await t.call('POST', path('/meeting-area'), {}, HOST)
    const [first] = ranked()
    const before = JSON.stringify(spots())
    // The host's confirm lands while the other request is working out its answer: it is the first write the other one meets.
    world.hooks.beforeApply = () => {
      world.hooks.beforeApply = null
      Object.assign(session(), { status: 'voting', meeting_area_id: first.area_id, meeting_method: 'voted', plan_version: session().plan_version + 1 })
    }
    await setStart(GUEST, 'woodlands')
    const late = await t.call('POST', path('/meeting-area'), { trigger: 'start' }, GUEST)
    expect(late.status).toBe(409)
    expect(late.body.error).toBe('not_yet')
    expect(JSON.stringify(spots())).toBe(before)
    expect(session()).toMatchObject({ status: 'voting', meeting_area_id: first.area_id, meeting_method: 'voted' })
  })

  it('drops a late suggestion too, and a late confirm cannot be made twice', async () => {
    await start()
    await t.call('POST', path('/meeting-area'), {}, HOST)
    const [far] = notRanked()
    world.hooks.beforeApply = () => {
      world.hooks.beforeApply = null
      Object.assign(session(), { status: 'voting', meeting_area_id: ranked()[0].area_id, meeting_method: 'chosen', plan_version: session().plan_version + 1 })
    }
    const late = await t.call('PUT', path('/spots/mine'), { areaId: far }, GUEST)
    expect(late.status).toBe(409)
    expect(late.body.error).toBe('wrong_status')
    expect(world.spot_suggestions).toEqual([])
    expect(areaIds()).not.toContain(far)
  })

  it('refuses, inside the write, any patch that would move a pinned meeting area (the twin of the SQL rule)', async () => {
    await start({ status: 'voting' })
    Object.assign(session(), { meeting_area_id: 'bugis', meeting_method: 'chosen' })
    const supabase = fakeSupabase(world, createSupabase({ url: SUPABASE_URL, anonKey: 'a', serviceKey: 's', fetchImpl: jwksFetch }))
    const meeting = (area, method) => ({ area_id: area, method, max_minutes: 10, total_minutes: 20, count: 2, approximate: false, travel: {} })
    const apply = (m) => supabase.service.rpc('apply_session_plan', { sid: SESSION, expected_version: 0, expected_status: 'voting', patch: { session: { meeting: m } } })
    expect((await apply(meeting('orchard', 'chosen'))).error.hint).toBe('area_pinned')
    expect((await apply(meeting('bugis', 'voted'))).error.hint).toBe('area_pinned')
    expect((await apply(null)).error.hint).toBe('area_pinned')
    expect(session()).toMatchObject({ meeting_area_id: 'bugis', meeting_method: 'chosen', plan_version: 0 })
    // The same area and method again is allowed (and changes nothing but the time it was worked out).
    expect((await apply(meeting('bugis', 'chosen'))).error).toBeNull()
  })

  it('moves a status only from inviting or locating to voting, with an area, and from inviting only with two people (the twin of the SQL rules)', async () => {
    await start({ status: 'inviting' })
    const supabase = fakeSupabase(world, createSupabase({ url: SUPABASE_URL, anonKey: 'a', serviceKey: 's', fetchImpl: jwksFetch }))
    const meeting = { area_id: 'bugis', method: 'chosen', max_minutes: 0, total_minutes: 0, count: 0, approximate: false, travel: {} }
    const apply = (expected, patch) => supabase.service.rpc('apply_session_plan', { sid: SESSION, expected_version: 0, expected_status: expected, patch })
    expect((await apply('inviting', { session: { status: 'confirmed', meeting } })).error.hint).toBe('status_transition')
    expect((await apply('inviting', { session: { status: 'voting' } })).error.hint).toBe('status_transition') // no area
    world.session_members.splice(1)
    expect((await apply('inviting', { session: { status: 'voting', meeting } })).error.hint).toBe('needs_two_people')
    expect(session().status).toBe('inviting')
    // A stale status writes nothing and answers null, never an error.
    expect((await apply('locating', { ops: [{ op: 'clear_approvals' }] })).data).toBeNull()
  })
})

describe('PUT /api/sessions/:id/known-place (E21)', () => {
  it('sets the area straight away: the list becomes that one area, the pick is pinned, and the times come from the starts there are', async () => {
    await start()
    await t.call('POST', path('/meeting-area'), {}, HOST)
    const [far] = notRanked()
    await t.call('PUT', path('/spots/mine'), { areaId: far }, GUEST)
    await approve(HOST, ranked()[0].area_id)
    const res = await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ planVersion: res.body.planVersion, status: 'voting' })
    expect(areaIds()).toEqual(['bugis'])
    expect(spots()[0].rank).toBeNull()
    expect(Object.keys(spots()[0].travel_minutes).sort()).toEqual(BOTH)
    expect(world.spot_suggestions).toEqual([])
    expect(world.spot_approvals).toEqual([])
    expect(session()).toMatchObject({ status: 'voting', meeting_area_id: 'bugis', meeting_method: 'chosen', meeting_count: 2, banner: null })
    expect(world.session_members.find((m) => m.user_id === HOST).travel_minutes).toBe(Math.round(spots()[0].travel_minutes[HOST]))
  })

  it('works from inviting with two people and no starts at all: the times are zero', async () => {
    await start({ status: 'inviting', starts: { [HOST]: null, [GUEST]: null, [OTHER]: null } })
    const res = await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)
    expect(res.status).toBe(200)
    expect(spots()).toEqual([expect.objectContaining({ area_id: 'bugis', worst_minutes: 0, mean_minutes: 0, travel_minutes: {}, approximate: false })])
    expect(session()).toMatchObject({ status: 'voting', meeting_area_id: 'bugis', meeting_method: 'chosen', meeting_max_minutes: 0, meeting_count: 0 })
  })

  it('needs two people (409 needs_two_people), a known area (422), the host (403) and an open status (409)', async () => {
    await start({ status: 'inviting' })
    world.session_members.splice(1)
    const alone = await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)
    expect(alone.status).toBe(409)
    expect(alone.body.error).toBe('needs_two_people')
    await start()
    expect((await t.call('PUT', path('/known-place'), { areaId: 'atlantis' }, HOST)).body.error).toBe('unknown_area')
    expect((await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, GUEST)).body.error).toBe('host_only')
    expect((await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, STRANGER)).status).toBe(404)
    expect((await t.call('PUT', path('/known-place'), {}, HOST)).status).toBe(400)
    for (const status of ['voting', 'confirmed', 'completed', 'cancelled']) {
      session().status = status
      const res = await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('wrong_status')
    }
    expect(spots()).toEqual([])
  })

  it('answers a repeat of the same place with the same answer, and another place after it with 409', async () => {
    await start()
    const first = await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)
    const again = await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)
    expect(again.body).toEqual(first.body)
    expect((await t.call('PUT', path('/known-place'), { areaId: 'orchard' }, HOST)).status).toBe(409)
    expect(session().meeting_area_id).toBe('bugis')
  })

  it('leaves the group, in the pinned state, unable to move the area by recomputing', async () => {
    await start()
    await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)
    const res = await t.call('POST', path('/meeting-area'), {}, GUEST)
    expect(res.body.error).toBe('not_yet')
    expect(session()).toMatchObject({ meeting_area_id: 'bugis', meeting_method: 'chosen' })
  })
})

describe('POST /api/sessions/:id/opt-out and /rejoin (E10, E11)', () => {
  const listed = async () => {
    await start()
    await t.call('POST', path('/meeting-area'), {}, HOST)
  }

  it('opts a guest out: their approvals and suggestion go, and the spots are worked out without them', async () => {
    await listed()
    const [far] = notRanked()
    await t.call('PUT', path('/spots/mine'), { areaId: far }, GUEST)
    await approve(GUEST, ranked()[0].area_id)
    await approve(HOST, ranked()[0].area_id)
    const res = await t.call('POST', path('/opt-out'), undefined, GUEST)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ planVersion: res.body.planVersion, state: 'opted_out' })
    expect(world.session_members.find((m) => m.user_id === GUEST).state).toBe('opted_out')
    expect(world.spot_suggestions).toEqual([])
    expect(world.spot_approvals.map((a) => a.user_id)).not.toContain(GUEST)
    // One located member is left, so there is nothing to be fair about: the list is empty (and the approvals went with it).
    expect(spots()).toEqual([])
    expect(res.body.planVersion).toBeGreaterThan(1)
  })

  it('tells the group when approvals go with a spot that dropped out', async () => {
    await start({ starts: { [HOST]: 'tampines', [GUEST]: 'clementi', [OTHER]: 'woodlands' } })
    await t.call('POST', path('/meeting-area'), {}, HOST)
    const before = ranked().map((s) => s.area_id)
    for (const a of before) await approve(HOST, a)
    await t.call('POST', path('/opt-out'), undefined, OTHER)
    const after = ranked().map((s) => s.area_id)
    const dropped = before.filter((a) => !after.includes(a))
    expect(dropped.length).toBeGreaterThan(0)
    expect(session().banner.text).toContain('Jonathan opted out.')
    expect(session().banner.approvalsRemoved).toBe(true)
  })

  it('refuses the host (403), and does nothing when already out (the version does not move)', async () => {
    await listed()
    const host = await t.call('POST', path('/opt-out'), undefined, HOST)
    expect(host.status).toBe(403)
    expect(host.body.error).toBe('host_cannot_opt_out')
    await t.call('POST', path('/opt-out'), undefined, GUEST)
    const version = session().plan_version
    const again = await t.call('POST', path('/opt-out'), undefined, GUEST)
    expect(again.body).toEqual({ planVersion: version, state: 'opted_out' })
    expect(session().plan_version).toBe(version)
  })

  it('works in inviting and locating; voting and confirmed are the later stage (409 not_yet), finished is 409 wrong_status', async () => {
    await listed()
    session().status = 'inviting'
    expect((await t.call('POST', path('/opt-out'), undefined, OTHER)).status).toBe(200)
    await t.call('POST', path('/rejoin'), undefined, OTHER)
    for (const status of ['voting', 'confirmed']) {
      session().status = status
      expect((await t.call('POST', path('/opt-out'), undefined, OTHER)).body.error).toBe('not_yet')
      expect((await t.call('POST', path('/rejoin'), undefined, OTHER)).body.error).toBe('not_yet')
    }
    for (const status of ['completed', 'cancelled']) {
      session().status = status
      expect((await t.call('POST', path('/opt-out'), undefined, OTHER)).body.error).toBe('wrong_status')
    }
  })

  it('brings a member back: they join the spots again, and rejoining while joined still works the spots out', async () => {
    await listed()
    await t.call('POST', path('/opt-out'), undefined, GUEST)
    expect(spots()).toEqual([])
    const res = await t.call('POST', path('/rejoin'), undefined, GUEST)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ planVersion: res.body.planVersion, state: 'joined' })
    expect(spots()).toHaveLength(3)
    // A rejoin whose answer was lost: the member is already in, and the spots are worked out again.
    spots().forEach((s) => world.session_spots.splice(world.session_spots.indexOf(s), 1))
    const again = await t.call('POST', path('/rejoin'), undefined, GUEST)
    expect(again.body.state).toBe('joined')
    expect(spots()).toHaveLength(3)
  })

  it('needs a login, a member, and no body', async () => {
    await listed()
    expect((await t.call('POST', path('/opt-out'), undefined, null)).status).toBe(401)
    expect((await t.call('POST', path('/opt-out'), undefined, STRANGER)).status).toBe(404)
    expect((await t.call('POST', path('/rejoin'), { force: true }, GUEST)).status).toBe(400)
  })
})

describe('leaving and being removed while locating (E25)', () => {
  it('takes the member\'s approvals and suggestion, works the spots out without them and tells the group', async () => {
    await start({ starts: { [HOST]: 'tampines', [GUEST]: 'clementi', [OTHER]: 'woodlands' } })
    await t.call('POST', path('/meeting-area'), {}, HOST)
    const before = ranked().map((s) => s.area_id)
    for (const a of before) await approve(HOST, a)
    await approve(OTHER, before[0])
    const [far] = notRanked()
    await t.call('PUT', path('/spots/mine'), { areaId: far }, OTHER)
    const res = await t.call('DELETE', path('/members/me'), undefined, OTHER)
    expect(res.status).toBe(200)
    expect(res.body.left).toBe(true)
    expect(world.session_members.some((m) => m.user_id === OTHER)).toBe(false)
    expect(world.spot_suggestions).toEqual([])
    expect(approvalsOf(before[0])).not.toContain(OTHER)
    expect(areaIds()).not.toContain(far)
    expect(session().banner.text).toContain('Jonathan left.')
  })

  it('lets the host remove a guest during locating, with the guest named in the notice', async () => {
    await start({ starts: { [HOST]: 'tampines', [GUEST]: 'clementi', [OTHER]: 'woodlands' } })
    await t.call('POST', path('/meeting-area'), {}, HOST)
    for (const s of ranked()) await approve(HOST, s.area_id)
    const res = await t.call('DELETE', path(`/members/${OTHER}`), undefined, HOST)
    expect(res.body.removed).toBe(true)
    expect(session().banner.text).toContain('Jonathan was removed.')
  })
})

describe('two devices, start to finish', () => {
  it('shares starts, spots and marks; no address reaches the other device; concurrent changes end on one list; the confirm closes the marks', async () => {
    await start({ starts: { [HOST]: 'tampines', [GUEST]: null, [OTHER]: null } })
    // The guest shares where they start: the area on the member row, the exact place where only they and the server read it.
    expect((await setStart(GUEST, 'clementi')).error).toBeNull()
    world.session_member_places.push({ session_id: SESSION, user_id: GUEST, start_label: '12 Secret Lane, Singapore 123456', start_lat: 1.3333, start_lng: 103.8888 })
    const answers = []
    answers.push(await t.call('POST', path('/meeting-area'), { trigger: 'added' }, GUEST))
    expect(answers[0].body.spots).toBe(3)

    // The host's device reads the same three spots with both people's minutes, and nothing of the guest's address.
    const host = userClient(world, HOST)
    const seen = (await host.from('session_spots').select('*').eq('session_id', SESSION)).data
    expect(seen).toHaveLength(3)
    expect(seen.every((s) => Object.keys(s.travel_minutes).sort().join() === BOTH.join())).toBe(true)
    expect((await host.from('session_member_places').select('*').eq('session_id', SESSION)).data).toEqual([])

    // The guest suggests a spot they are at already. Both mark it. The host is offered it.
    const [far] = notRanked()
    answers.push(await t.call('PUT', path('/spots/mine'), { areaId: far, here: true }, GUEST))
    expect((await approve(GUEST, far)).error).toBeNull()
    expect((await approve(HOST, far)).error).toBeNull()
    expect((await host.from('spot_approvals').select('*').eq('area_id', far)).data).toHaveLength(2)

    // Both change their start at once, and the two requests end on the one list a single recompute gives.
    await setStart(HOST, 'bedok')
    await setStart(GUEST, 'woodlands')
    answers.push(...(await Promise.all([t.call('POST', path('/meeting-area'), { trigger: 'start' }, HOST), t.call('POST', path('/meeting-area'), { trigger: 'start' }, GUEST)])))
    expect(answers.slice(-2).map((a) => a.status)).toEqual([200, 200])
    const afterBoth = JSON.stringify(spots().map((s) => [s.area_id, s.rank, s.travel_minutes]).sort())
    await start({ starts: { [HOST]: 'bedok', [GUEST]: 'woodlands', [OTHER]: null } })
    world.spot_suggestions.push({ session_id: SESSION, user_id: GUEST, area_id: far, here: true, created_at: '2026-10-20T08:00:00.000Z' })
    await t.call('POST', path('/meeting-area'), {}, HOST)
    expect(JSON.stringify(spots().map((s) => [s.area_id, s.rank, s.travel_minutes]).sort())).toBe(afterBoth)

    // The host confirms; the guest's late mark is refused; and no answer or row anywhere carried the address.
    const confirmed = await t.call('POST', path('/voting'), {}, HOST)
    expect(confirmed.status).toBe(200)
    answers.push(confirmed)
    expect((await approve(GUEST, ranked()[0].area_id)).error.code).toBe('42501')
    const everything = JSON.stringify([answers.map((a) => a.body), spots(), session(), world.spot_suggestions, world.spot_approvals])
    for (const secret of ['Secret Lane', '123456', '1.3333', '103.8888']) expect(everything).not.toContain(secret)
  })
})

describe('no answer carries a label or a coordinate', () => {
  it('holds for every endpoint, and the exact places are never read', async () => {
    await start({ starts: { [HOST]: 'tampines', [GUEST]: 'clementi', [OTHER]: 'woodlands' } })
    for (const who of [HOST, GUEST, OTHER]) {
      world.session_member_places.push({ session_id: SESSION, user_id: who, start_label: `Home of ${NAMES[who]} at 9 Private Road`, start_lat: 1.31 + Math.random() / 100, start_lng: 103.81 + Math.random() / 100, end_label: 'Elsewhere Drive', end_lat: 1.4, end_lng: 103.7 })
    }
    const [far, other] = notRanked(2)
    const bodies = []
    const go = async (...args) => bodies.push((await t.call(...args)).body)
    await go('POST', path('/meeting-area'), { trigger: 'start' }, HOST)
    await go('PUT', path('/spots/mine'), { areaId: far, here: true }, GUEST)
    await go('PUT', path('/spots/mine'), { areaId: other }, OTHER)
    await go('DELETE', path('/spots/mine'), undefined, OTHER)
    await go('POST', path('/opt-out'), undefined, OTHER)
    await go('POST', path('/rejoin'), undefined, OTHER)
    await go('DELETE', path('/members/me'), undefined, OTHER)
    await go('POST', path('/voting'), {}, HOST)
    await go('POST', path('/meeting-area'), {}, HOST) // a refusal carries nothing either
    const text = JSON.stringify([bodies, spots(), session(), world.spot_suggestions, world.spot_approvals])
    for (const secret of ['Private Road', 'Elsewhere Drive', 'Home of', 'start_lat', 'start_lng', '"lat"', '"lng"', 'label']) expect(text).not.toContain(secret)
    expect(world.calls.some((c) => c.table === 'session_member_places')).toBe(false)
  })
})
