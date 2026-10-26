import { afterEach, describe, expect, it, vi } from 'vitest'
import { applySessionPlan, createWorld, userClient } from './helpers/fake-supabase.js'
import { addMember, addSession, GUEST, HOST, OTHER, SESSION, startSessionApp, STRANGER } from './helpers/session-app.js'

// The host changes the meeting place (POST /api/sessions/:id/change-meeting-place), tested without the network: the one write that releases
// the meeting area (the op `release_meeting` of apply_session_plan, db/migrations/20261027000000_jio_change_meeting_place.sql, whose JavaScript
// twin is in helpers/fake-supabase.js and whose SQL is tested in db/tests/apply_session_plan.sql, steps 301 onwards), and the known place that
// follows it. The people: HOST starts at Tampines, GUEST at Clementi, OTHER at Bishan. The group has chosen Bugis (a known place), so the session
// is voting with its slots and places, and some tests vote and confirm the plan first.
const NAMES = { [HOST]: 'Ian', [GUEST]: 'Faith', [OTHER]: 'Jonathan' }
const KINDS = ['eat', 'drink', 'activity']

let world
let t
const started = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(started.splice(0).map((s) => s.stop()))
})

// A voting world made by the real endpoints. How to call: await start({ status: 'inviting' })
async function start({ status = 'voting' } = {}) {
  world = createWorld()
  addSession(world, { id: SESSION, status: 'inviting' })
  addMember(world, SESSION, HOST, { role: 'host', start: 'tampines', name: NAMES[HOST] })
  addMember(world, SESSION, GUEST, { start: 'clementi', name: NAMES[GUEST] })
  addMember(world, SESSION, OTHER, { start: 'bishan', name: NAMES[OTHER] })
  for (const id of [HOST, GUEST, OTHER]) world.profile_private.push({ id, dietary: [], budget_max_per_person: null, needs_step_free: false })
  t = await startSessionApp(world)
  started.push(t)
  if (status !== 'inviting') expect((await t.call('PUT', path('/known-place'), { areaId: 'bugis' }, HOST)).status).toBe(200)
  return t
}

const path = (tail = '') => `/api/sessions/${SESSION}${tail}`
const session = () => world.sessions.find((s) => s.id === SESSION)
const slotOf = (category) => world.slots.find((s) => s.session_id === SESSION && s.category === category)
const writes = () => world.calls.filter((c) => c.rpc === 'apply_session_plan')
const change = (body, who = HOST) => t.call('POST', path('/change-meeting-place'), body, who)

// Two people vote for the first place of each of eat, drink and activity.
async function voteForThree() {
  for (const category of KINDS) {
    const venue = world.slot_options.filter((o) => o.slot_id === slotOf(category).id).sort((a, b) => a.rank - b.rank)[0].venue_id
    for (const who of [HOST, GUEST]) {
      const { error } = await userClient(world, who).from('votes').insert({ slot_id: slotOf(category).id, user_id: who, venue_id: venue })
      expect(error).toBeNull()
    }
  }
}

// A confirmed plan with a proposal waiting, an order note, a start, a prompt and a kept rain warning.
async function confirmed() {
  await start()
  await voteForThree()
  expect((await t.call('POST', path('/confirm'), {}, HOST)).status).toBe(200)
  world.stop_proposals.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', session_id: SESSION, venue_id: 'x', proposed_by: GUEST, status: 'pending', created_at: 't', resolved_at: null, resolved_by: null })
  Object.assign(session(), { order_reason: 'Because.', order_source: 'rules', plan_start_minute: 700, replan: { reason: 'someone opted out' }, weather_kept: { s1: 'showers' } })
}

describe('"fairest": the session goes back to locating and the spots are worked out again', () => {
  it('from voting: one write releases the area, the slots with their votes and the notice names the host', async () => {
    await start()
    await voteForThree()
    world.session_spots.push({ session_id: SESSION, area_id: 'orchard', rank: 1, worst_minutes: 1, mean_minutes: 1, travel_minutes: {}, approximate: false, computed_at: 'old' })
    world.spot_suggestions.push({ session_id: SESSION, user_id: GUEST, area_id: 'orchard', here: false, created_at: 'x' })
    world.spot_approvals.push({ session_id: SESSION, area_id: 'orchard', user_id: GUEST, created_at: 'x' })
    const before = writes().length
    const res = await change({ meetBy: 'fairest' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'locating', meetBy: 'fairest', planVersion: expect.any(Number) })
    // One write, carrying the op.
    expect(writes().length).toBe(before + 1)
    expect(session()).toMatchObject({
      status: 'locating', meet_by: 'fairest', meeting_area_id: null, meeting_method: null, meeting_max_minutes: null, meeting_total_minutes: null,
      meeting_count: null, meeting_approximate: null, meeting_computed_at: null, order_suggestion: null, replan: null,
    })
    expect(session().banner).toMatchObject({ text: 'Ian changed the meeting place, so the votes were cleared.', released: true, at: expect.any(Number) })
    expect(world.slots).toHaveLength(0)
    expect(world.slot_options).toHaveLength(0)
    expect(world.votes).toHaveLength(0)
    expect(world.spot_suggestions).toHaveLength(0)
    expect(world.spot_approvals).toHaveLength(0)
    // The list is worked out again from the starts that stay, in the same write, so there is never an empty list between the two.
    const areas = world.session_spots.filter((s) => s.session_id === SESSION).map((s) => s.area_id)
    expect(areas.length).toBeGreaterThanOrEqual(3)
    expect(areas).not.toContain('orchard-not-listed')
    // Starts and ends stay; the minutes to the old area went.
    expect(world.session_members.map((m) => m.start_area_id).sort()).toEqual(['bishan', 'clementi', 'tampines'])
    expect(world.session_members.every((m) => m.travel_minutes === null)).toBe(true)
  })

  it('from confirmed: the stops go too, the note, the start, the prompt and the kept warnings clear, the proposals are dismissed, and the notice says the plan went', async () => {
    await confirmed()
    expect(world.stops.length).toBeGreaterThan(0)
    const res = await change({ meetBy: 'fairest' })
    expect(res.status).toBe(200)
    expect(session()).toMatchObject({ status: 'locating', order_reason: null, order_source: null, plan_start_minute: null, replan: null, weather_kept: null })
    expect(session().banner.text).toBe('Ian changed the meeting place, so the votes and the plan were cleared.')
    expect(world.stops).toHaveLength(0)
    expect(world.stop_proposals.map((p) => p.status)).toEqual(['dismissed'])
  })

  it('says the places were chosen again when nobody had voted', async () => {
    await start()
    await change({ meetBy: 'fairest' })
    expect(session().banner.text).toBe('Ian changed the meeting place, so the places to vote on were chosen again.')
  })

  it('names the host and nobody else, and reads no exact place', async () => {
    await start()
    await voteForThree()
    await change({ meetBy: 'fairest' })
    expect(session().banner.text).not.toMatch(/Faith|Jonathan/)
    expect(world.calls.some((c) => c.table === 'session_member_places')).toBe(false)
  })

  it('leaves the session ready for the usual flow: the host confirms a spot and the slots are made again', async () => {
    await start()
    await voteForThree()
    await change({ meetBy: 'fairest' })
    const res = await t.call('POST', path('/voting'), {}, HOST)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'voting', meetingAreaId: expect.any(String) })
    expect(world.slots.length).toBeGreaterThan(0)
    expect(world.votes).toHaveLength(0)
  })

  it('a second call, now that the session is locating, is refused and writes nothing', async () => {
    await start()
    expect((await change({ meetBy: 'fairest' })).status).toBe(200)
    const before = writes().length
    const again = await change({ meetBy: 'fairest' })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('wrong_status')
    expect(writes().length).toBe(before)
  })

  it('retries on a late write: the session moved while the spots were worked out', async () => {
    await start()
    world.staleApply = 1
    expect((await change({ meetBy: 'fairest' })).status).toBe(200)
    expect(session().status).toBe('locating')
  })
})

describe('"known": the area is named and the group goes straight to voting there', () => {
  it('releases, then sets the known place with a notice that names the host and the new area', async () => {
    await start()
    await voteForThree()
    const res = await change({ meetBy: 'known', areaId: 'orchard' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'voting', meetBy: 'known' })
    expect(session()).toMatchObject({ status: 'voting', meeting_area_id: 'orchard', meeting_method: 'chosen', meet_by: 'known' })
    expect(session().banner).toMatchObject({ text: 'Ian changed the meeting place to Orchard, so the votes were cleared.', released: true, votesCleared: true })
    // New slots, and none of the old votes.
    expect(world.slots.length).toBeGreaterThan(0)
    expect(world.votes).toHaveLength(0)
    expect(world.session_spots.filter((s) => s.session_id === SESSION).map((s) => s.area_id)).toEqual(['orchard'])
  })

  it('from confirmed, the plan goes and the notice says so', async () => {
    await confirmed()
    expect((await change({ meetBy: 'known', areaId: 'bishan' })).status).toBe(200)
    expect(world.stops).toHaveLength(0)
    expect(session()).toMatchObject({ status: 'voting', meeting_area_id: 'bishan' })
    expect(session().banner.text).toBe('Ian changed the meeting place to Bishan, so the votes and the plan were cleared.')
  })

  it('may name the same area as before: the group still starts again', async () => {
    await start()
    await voteForThree()
    expect((await change({ meetBy: 'known', areaId: 'bugis' })).status).toBe(200)
    expect(world.votes).toHaveLength(0)
    expect(session().meeting_area_id).toBe('bugis')
  })

  it('if naming the area fails, the session stays on Locate with the host\'s choice recorded and the notice, nothing in memory', async () => {
    await start()
    await voteForThree()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let applies = 0
    world.hooks.beforeApply = () => {
      applies += 1
      if (applies === 2) throw new Error('the database went away')
    }
    const res = await change({ meetBy: 'known', areaId: 'orchard' })
    expect(res.status).toBe(500)
    expect(session()).toMatchObject({ status: 'locating', meet_by: 'known', meeting_area_id: null })
    expect(session().banner.text).toBe('Ian changed the meeting place, so the votes were cleared.')
    // The host names the area from Locate with the known place that already exists.
    world.hooks.beforeApply = undefined
    expect((await t.call('PUT', path('/known-place'), { areaId: 'orchard' }, HOST)).status).toBe(200)
    expect(session()).toMatchObject({ status: 'voting', meeting_area_id: 'orchard' })
  })
})

describe('who may, and when', () => {
  it('is the host\'s alone: a guest is 403, a stranger is 404 before the service key is used, nobody is 401', async () => {
    await start()
    const calls = world.calls.length
    expect((await change({ meetBy: 'fairest' }, GUEST)).body.error).toBe('host_only')
    const stranger = await change({ meetBy: 'fairest' }, STRANGER)
    expect(stranger.status).toBe(404)
    expect(stranger.body.error).toBe('session_not_found')
    expect(world.calls.slice(calls).some((c) => c.who === null)).toBe(false)
    expect((await t.call('POST', path('/change-meeting-place'), { meetBy: 'fairest' }, null)).status).toBe(401)
    expect(session().status).toBe('voting')
  })

  it.each([['inviting'], ['locating'], ['completed'], ['cancelled']])('is refused while the session is %s', async (status) => {
    await start()
    session().status = status
    const before = writes().length
    const res = await change({ meetBy: 'fairest' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('wrong_status')
    expect(writes().length).toBe(before)
    expect(session().status).toBe(status)
  })

  it('a host who has opted out is refused', async () => {
    await start()
    world.session_members.find((m) => m.user_id === HOST).state = 'opted_out'
    expect((await change({ meetBy: 'fairest' })).status).toBe(403)
  })
})

describe('the body', () => {
  it.each([
    ['nothing', {}],
    ['an unknown way', { meetBy: 'anywhere' }],
    ['"fairest" with an area', { meetBy: 'fairest', areaId: 'bugis' }],
    ['"known" with no area', { meetBy: 'known' }],
    ['an extra field', { meetBy: 'fairest', note: 'x' }],
    ['an area that is not text', { meetBy: 'known', areaId: 4 }],
  ])('refuses %s with 400 and the one error shape', async (_label, body) => {
    await start()
    const res = await change(body)
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'invalid_input', message: expect.any(String) })
    expect(session().status).toBe('voting')
  })

  it('refuses an area the planner does not know with 422, and a session id that is not a uuid with 400', async () => {
    await start()
    const unknown = await change({ meetBy: 'known', areaId: 'atlantis' })
    expect(unknown.status).toBe(422)
    expect(unknown.body.error).toBe('unknown_area')
    expect((await t.call('POST', '/api/sessions/not-a-uuid/change-meeting-place', { meetBy: 'fairest' }, HOST)).status).toBe(400)
    expect(session().status).toBe('voting')
  })
})

describe('the function\'s rules (the twin of the SQL)', () => {
  const apply = (patch, status = 'voting', version = session().plan_version) => applySessionPlan(world, { sid: SESSION, expected_version: version, expected_status: status, patch })
  const hintOf = (patch, status) => {
    try {
      apply(patch, status)
    } catch (err) {
      return err.hint ?? err.code
    }
    return 'none'
  }
  const op = { op: 'release_meeting', meet_by: 'fairest' }

  it('does not go back to locating without the op, and the op needs the move', async () => {
    await start()
    expect(hintOf({ session: { status: 'locating' } })).toBe('status_transition')
    expect(hintOf({ ops: [op] })).toBe('release_status')
    expect(hintOf({ ops: [op], session: { status: 'confirmed' } })).toBe('release_status')
    session().status = 'locating'
    expect(hintOf({ ops: [op], session: { status: 'locating' } }, 'locating')).toBe('release_status')
  })

  it('needs fairest or known, and brings no meeting of its own', async () => {
    await start()
    expect(hintOf({ ops: [{ op: 'release_meeting' }], session: { status: 'locating' } })).toBe('22023')
    expect(hintOf({ ops: [{ op: 'release_meeting', meet_by: 'nowhere' }], session: { status: 'locating' } })).toBe('22023')
    expect(hintOf({ ops: [op], session: { status: 'locating', meeting: { area_id: 'orchard', method: 'chosen' } } })).toBe('release_meeting')
    expect(session().status).toBe('voting')
  })

  it('keeps area_pinned on every other path', async () => {
    await start()
    expect(session().meeting_method).toBe('chosen')
    expect(hintOf({ session: { meeting: { area_id: 'orchard', method: 'fairest', max_minutes: 1, total_minutes: 1, count: 2, approximate: false } } })).toBe('area_pinned')
    expect(hintOf({ session: { meeting: null } })).toBe('area_pinned')
    expect(session().meeting_area_id).toBe('bugis')
  })

  it('a refusal writes nothing: the session, its slots and votes are as they were', async () => {
    await start()
    await voteForThree()
    const snapshot = JSON.stringify([world.sessions, world.slots, world.slot_options, world.votes, world.session_spots])
    hintOf({ ops: [op], session: { status: 'confirmed' } })
    hintOf({ ops: [{ op: 'release_meeting' }], session: { status: 'locating' } })
    expect(JSON.stringify([world.sessions, world.slots, world.slot_options, world.votes, world.session_spots])).toBe(snapshot)
  })

  it('answers null for a late release', async () => {
    await start()
    expect(apply({ ops: [op], session: { status: 'locating' } }, 'voting', session().plan_version - 1)).toBeNull()
    expect(apply({ ops: [op], session: { status: 'locating' } }, 'confirmed')).toBeNull()
    expect(session().status).toBe('voting')
  })
})
