// A stand-in for the Jio server's session routes of stage 3 (the contract on ticket #128), for tests. It is an axios adapter: put it
// on an app's planner client (`app.api.api.defaults.adapter = server.adapter`) and the real lib/plannerApi.js talks to it, with
// the real paths, bodies and login token, so a change to either side that makes them disagree fails a test. It acts on the stand-in
// database (components/dev/fakeDatabase.js) with the service key, the way the real server does, and knows who is asking by the
// token (the database learns whose token is whose). Not a test file itself (the name does not end in .test.js).
//
// What it answers (all flat errors { error, message }, 401 without a token, 404 session_not_found for a stranger):
//   POST   /api/sessions/:id/meeting-area   { trigger? }          E1: works the spots out; writes session_spots
//   PUT    /api/sessions/:id/spots/mine     { areaId, here? }     E19: the caller's suggestion
//   DELETE /api/sessions/:id/spots/mine                            E20
//   POST   /api/sessions/:id/voting         { areaId? }           E2: the host confirms a spot
//   PUT    /api/sessions/:id/known-place    { areaId }            E21
//   POST   /api/sessions/:id/opt-out, /rejoin                      E10, E11
//   DELETE /api/sessions/:id/members/:userId|me                   E25 (leave, remove)
//
// Its rules are the design's: a write is applied only if the session still has the status and version it was worked out for
// (otherwise 409 wrong_status and nothing is written: a late answer never undoes a confirmation), spots are changed as a
// difference (an approval of a spot that stays is kept), travel times are worked out from each area's centre and never from an
// exact place, and opting out or leaving takes the person's approvals and suggestion with them. Travel is a straight-line
// estimate, 5 minutes and 4 per km, so a test can compute what it expects.
//
// Hooks for a test: `server.down = true` (no answer at all, like a lost connection), `server.after.<route> = async () => {}` (run after
// the server has read the session and before it writes, so another change can land in between), `server.calls` (every request).
// How to call: const server = fakeSessionsServer(database); app.api.api.defaults.adapter = server.adapter
import { AxiosError } from 'axios'
import { SERVICE } from '../../components/dev/fakeDatabase.js'
import { AREAS } from '../mock/places.js'
import { distanceKm } from '../planner/index.js'

const OPEN = ['inviting', 'locating']
const SUGGESTIONS_MAX = 8

// Minutes from one area to another, unrounded. How to call: tripMinutes('bugis', 'tampines') -> 21.7...
export function tripMinutes(fromId, toId) {
  const a = AREAS.find((x) => x.id === fromId)
  const b = AREAS.find((x) => x.id === toId)
  return 5 + distanceKm(a, b) * 4
}

// How to call: const server = fakeSessionsServer(database)
export function fakeSessionsServer(database) {
  const calls = []
  const after = {}
  const server = { calls, after, down: false, adapter: null }

  const rows = (table) => database.tables[table]
  const sessionOf = (id) => rows('sessions').find((s) => s.id === id)
  const memberOf = (id, user) => rows('session_members').find((m) => m.session_id === id && m.user_id === user)
  // How to call: await write({ kind: 'update', table: 'sessions', values: { status: 'voting' }, filters: [...] })
  const write = (op) => database.run({ as: SERVICE, ...op })
  const eq = (col, value) => ({ col, op: 'eq', value })

  class Refusal extends Error {
    constructor(status, error, message) {
      super(message)
      this.status = status
      this.body = { error, message }
    }
  }
  const refuse = (status, error, message = error) => {
    throw new Refusal(status, error, message)
  }

  // Who is asking, and which session: a stranger gets 404, an opted-out person 403 where the route needs a joined one.
  // How to call: const { session, member } = load(user, id, { joined: true })
  function load(user, id, { joined = true } = {}) {
    const session = sessionOf(id)
    const member = session && memberOf(id, user)
    if (!session || !member) refuse(404, 'session_not_found', 'This session does not exist, or you are not in it.')
    if (joined && member.state !== 'joined') refuse(403, 'not_joined', 'Only people in this session can do that.')
    return { session, member }
  }

  // The members who have shared where they start, with the area. How to call: located(id) -> [{ id: '7f3c...', area: 'bugis' }]
  const located = (id) => rows('session_members').filter((m) => m.session_id === id && m.state === 'joined' && m.start_area_id).map((m) => ({ id: m.user_id, area: m.start_area_id }))

  // Each member's trip to an area, from the centres of the areas they start in. How to call: pricing('bugis', located(id))
  function pricing(areaId, people) {
    const travel = Object.fromEntries(people.map((p) => [p.id, tripMinutes(p.area, areaId)]))
    const minutes = Object.values(travel)
    return { worst: Math.max(...minutes), mean: minutes.reduce((sum, m) => sum + m, 0) / minutes.length, travel }
  }

  // The spots the list should hold now: the app's three fairest areas, then each suggested area that is not one of them. Nothing
  // below two starts (the suggestions are kept).
  // How to call: wanted(id) -> [{ areaId, rank, ...pricing }]
  function wanted(id) {
    const people = located(id)
    if (people.length < 2) return []
    const ranked = AREAS.map((a) => ({ areaId: a.id, ...pricing(a.id, people) }))
      .sort((a, b) => a.worst - b.worst || a.mean - b.mean || a.areaId.localeCompare(b.areaId))
      .slice(0, 3)
      .map((spot, i) => ({ ...spot, rank: i + 1 }))
    const suggested = [...new Set(rows('spot_suggestions').filter((x) => x.session_id === id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map((x) => x.area_id))]
    return [...ranked, ...suggested.filter((a) => !ranked.some((r) => r.areaId === a)).map((areaId) => ({ areaId, rank: null, ...pricing(areaId, people) }))]
  }

  // Apply a patch to a session only if it still has the status and version the patch was worked out for (apply_session_plan).
  // How to call: await apply(id, loaded, async () => { ...writes... }, { banner })
  async function apply(id, loaded, writes, patch = {}) {
    const now = sessionOf(id)
    if (!now || now.status !== loaded.status) refuse(409, 'wrong_status', 'The session has moved on, so that was not applied.')
    if (now.plan_version !== loaded.version) refuse(409, 'plan_busy', 'Another change was made at the same time. Try again.')
    await writes()
    const version = now.plan_version + 1
    await write({ kind: 'update', table: 'sessions', values: { plan_version: version, ...patch(version) }, filters: [eq('id', id)] })
    return version
  }

  // Work the list out again as a difference and say how many approvals went. The list is changed in place: spots that stay keep
  // their approvals, only the ones that dropped out lose theirs.
  // How to call: const lost = await relist(id)
  async function relist(id) {
    const want = wanted(id)
    const keep = new Set(want.map((w) => w.areaId))
    const before = rows('spot_approvals').filter((x) => x.session_id === id).length
    for (const old of rows('session_spots').filter((x) => x.session_id === id && !keep.has(x.area_id))) {
      await write({ kind: 'delete', table: 'session_spots', filters: [eq('session_id', id), eq('area_id', old.area_id)] })
    }
    // Ranks are unique, so they are cleared before they are handed out again.
    for (const old of rows('session_spots').filter((x) => x.session_id === id && x.rank != null)) {
      await write({ kind: 'update', table: 'session_spots', values: { rank: null }, filters: [eq('session_id', id), eq('area_id', old.area_id)] })
    }
    const computed = new Date().toISOString()
    for (const w of want) {
      const values = { rank: w.rank, worst_minutes: w.worst, mean_minutes: Math.min(w.mean, w.worst), travel_minutes: w.travel, approximate: false, computed_at: computed }
      const exists = rows('session_spots').some((x) => x.session_id === id && x.area_id === w.areaId)
      const answer = exists
        ? await write({ kind: 'update', table: 'session_spots', values, filters: [eq('session_id', id), eq('area_id', w.areaId)] })
        : await write({ kind: 'insert', table: 'session_spots', values: { session_id: id, area_id: w.areaId, ...values } })
      if (answer.error) throw new Error(`The stand-in server could not write a spot: ${answer.error.message}`)
    }
    return before - rows('spot_approvals').filter((x) => x.session_id === id).length
  }

  // The banner that says approvals went with a spot that left the list, in the shape the real server writes (apply_session_plan):
  // { text, at, approvalsRemoved: true }. `at` is the time in milliseconds; the version is added so that two banners written in the
  // same millisecond (the tests hold the clock still) still differ.
  // How to call: bannerFor(2) -> (version) => ({ banner: { text, at: Date.now() + version, approvalsRemoved: true } })
  const bannerFor = (lost) => (version) => (lost > 0 ? { banner: { text: `${lost === 1 ? 'A spot is' : 'Some spots are'} no longer on the list, so approvals for ${lost === 1 ? 'it' : 'them'} were removed.`, at: Date.now() + version, approvalsRemoved: true } } : {})

  // The routes ------------------------------------------------------------

  const routes = {
    // E1
    async meetingArea(user, id) {
      const { session } = load(user, id)
      if (!OPEN.includes(session.status)) refuse(409, 'wrong_status', 'The session has moved on.')
      const loaded = { status: session.status, version: session.plan_version }
      const skipped = rows('session_members').filter((m) => m.session_id === id && m.state === 'joined' && !m.start_area_id).map((m) => m.user_id)
      await after.meetingArea?.(id)
      let lost = 0
      const version = await apply(id, loaded, async () => { lost = await relist(id) }, (v) => bannerFor(lost)(v))
      return { status: 200, body: { planVersion: version, meetingAreaId: null, moved: false, votesCleared: false, skipped } }
    },
    // E19
    async putSpot(user, id, body) {
      const { session } = load(user, id)
      if (session.status !== 'locating') refuse(409, 'wrong_status', 'The group is not choosing where to meet.')
      if (typeof body.areaId !== 'string' || !AREAS.some((a) => a.id === body.areaId)) refuse(422, 'unknown_area', 'That area is not one Jio knows.')
      if (located(id).length < 2) refuse(409, 'no_spots', 'Spots open once two people have shared where they start.')
      const others = new Set(rows('spot_suggestions').filter((x) => x.session_id === id && x.user_id !== user).map((x) => x.area_id))
      if (new Set([...others, body.areaId]).size > SUGGESTIONS_MAX) refuse(409, 'too_many_spots', 'Too many spots.')
      const loaded = { status: session.status, version: session.plan_version }
      await after.putSpot?.(id)
      let lost = 0
      const version = await apply(id, loaded, async () => {
        await write({ kind: 'delete', table: 'spot_suggestions', filters: [eq('session_id', id), eq('user_id', user)] })
        await write({ kind: 'insert', table: 'spot_suggestions', values: { session_id: id, user_id: user, area_id: body.areaId, here: !!body.here } })
        lost = await relist(id)
      }, (v) => bannerFor(lost)(v))
      return { status: 200, body: { planVersion: version, spots: rows('session_spots').filter((x) => x.session_id === id).length, approvalsRemoved: lost } }
    },
    // E20
    async deleteSpot(user, id) {
      const { session } = load(user, id)
      if (session.status !== 'locating') refuse(409, 'wrong_status', 'The group is not choosing where to meet.')
      const loaded = { status: session.status, version: session.plan_version }
      let lost = 0
      const version = await apply(id, loaded, async () => {
        await write({ kind: 'delete', table: 'spot_suggestions', filters: [eq('session_id', id), eq('user_id', user)] })
        lost = await relist(id)
      }, (v) => bannerFor(lost)(v))
      return { status: 200, body: { planVersion: version } }
    },
    // E2
    async confirm(user, id, body) {
      const { session } = load(user, id)
      if (session.host_id !== user) refuse(403, 'host_only', 'Only the host can do that.')
      if (session.status !== 'locating') refuse(409, 'wrong_status', 'The group is not choosing where to meet.')
      const spots = rows('session_spots').filter((x) => x.session_id === id)
      if (!spots.length) refuse(409, 'no_spots', 'There is nothing to confirm yet.')
      const approvals = (areaId) => rows('spot_approvals').filter((x) => x.session_id === id && x.area_id === areaId && memberOf(id, x.user_id)?.state === 'joined').length
      let chosen
      if (body.areaId) {
        chosen = spots.find((x) => x.area_id === body.areaId)
        if (!chosen) refuse(404, 'spot_not_found', 'That spot is not on the list.')
      } else {
        const most = Math.max(...spots.map((x) => approvals(x.area_id)))
        chosen = spots.filter((x) => approvals(x.area_id) === most).sort((a, b) => a.worst_minutes - b.worst_minutes)[0]
      }
      const loaded = { status: session.status, version: session.plan_version }
      await after.confirm?.(id)
      const method = approvals(chosen.area_id) > 0 ? 'voted' : 'chosen'
      const times = Object.values(chosen.travel_minutes).map(Math.round)
      const version = await apply(id, loaded, async () => {}, () => ({
        status: 'voting',
        meeting_area_id: chosen.area_id,
        meeting_method: method,
        meeting_max_minutes: Math.max(...times),
        meeting_total_minutes: times.reduce((sum, m) => sum + m, 0),
        meeting_count: times.length,
        meeting_approximate: false,
        banner: null,
      }))
      return { status: 200, body: { planVersion: version, status: 'voting', meetingAreaId: chosen.area_id, method, slotCount: 0 } }
    },
    // E21
    async knownPlace(user, id, body) {
      const { session } = load(user, id)
      if (session.host_id !== user) refuse(403, 'host_only', 'Only the host can do that.')
      if (!OPEN.includes(session.status)) refuse(409, 'wrong_status', 'The session has moved on.')
      if (typeof body.areaId !== 'string' || !AREAS.some((a) => a.id === body.areaId)) refuse(422, 'unknown_area', 'That area is not one Jio knows.')
      if (rows('session_members').filter((m) => m.session_id === id && m.state === 'joined').length < 2) refuse(409, 'needs_two_people', 'A session needs at least 2 people.')
      const loaded = { status: session.status, version: session.plan_version }
      const people = located(id)
      const priced = people.length ? pricing(body.areaId, people) : null
      await after.knownPlace?.(id)
      const version = await apply(id, loaded, async () => {
        for (const table of ['spot_suggestions', 'session_spots']) await write({ kind: 'delete', table, filters: [eq('session_id', id)] })
        const answer = await write({ kind: 'insert', table: 'session_spots', values: { session_id: id, area_id: body.areaId, rank: null, worst_minutes: priced?.worst ?? 0, mean_minutes: priced?.mean ?? 0, travel_minutes: priced?.travel ?? {} } })
        if (answer.error) throw new Error(answer.error.message)
      }, () => {
        const times = priced ? Object.values(priced.travel).map(Math.round) : []
        return { status: 'voting', meeting_area_id: body.areaId, meeting_method: 'chosen', meeting_max_minutes: times.length ? Math.max(...times) : 0, meeting_total_minutes: times.reduce((sum, m) => sum + m, 0), meeting_count: times.length, meeting_approximate: false, banner: null }
      })
      return { status: 200, body: { planVersion: version, status: 'voting' } }
    },
    // E10
    async optOut(user, id) {
      const { session, member } = load(user, id, { joined: false })
      if (member.role === 'host') refuse(403, 'host_cannot_opt_out', 'The host cannot opt out.')
      if (member.state === 'opted_out') return { status: 200, body: { planVersion: session.plan_version, state: 'opted_out' } }
      if (!OPEN.includes(session.status)) refuse(409, 'wrong_status', 'The session has moved on.')
      const loaded = { status: session.status, version: session.plan_version }
      let lost = 0
      const version = await apply(id, loaded, async () => {
        await write({ kind: 'update', table: 'session_members', values: { state: 'opted_out' }, filters: [eq('session_id', id), eq('user_id', user)] })
        for (const table of ['spot_approvals', 'spot_suggestions']) await write({ kind: 'delete', table, filters: [eq('session_id', id), eq('user_id', user)] })
        lost = await relist(id)
      }, (v) => bannerFor(lost)(v))
      return { status: 200, body: { planVersion: version, state: 'opted_out' } }
    },
    // E11
    async rejoin(user, id) {
      const { session, member } = load(user, id, { joined: false })
      if (member.state === 'joined') return { status: 200, body: { planVersion: session.plan_version, state: 'joined' } }
      if (!OPEN.includes(session.status)) refuse(409, 'wrong_status', 'The session has moved on.')
      const loaded = { status: session.status, version: session.plan_version }
      const version = await apply(id, loaded, async () => {
        await write({ kind: 'update', table: 'session_members', values: { state: 'joined' }, filters: [eq('session_id', id), eq('user_id', user)] })
        await relist(id)
      }, () => ({}))
      return { status: 200, body: { planVersion: version, state: 'joined' } }
    },
    // E25
    async removeMember(user, id, who) {
      const { session, member } = load(user, id, { joined: false })
      const target = who === 'me' ? user : who
      if (target !== user && session.host_id !== user) refuse(403, 'host_only', 'Only the host can remove someone.')
      if (target === session.host_id) refuse(403, 'host_cannot_leave', 'The host cannot leave. Cancel the session instead.')
      if (!memberOf(id, target)) refuse(404, 'member_not_found', 'That person is not in this session.')
      if (!OPEN.includes(session.status)) refuse(409, member && session.status === 'voting' ? 'session_started' : 'session_closed', 'Not now.')
      const loaded = { status: session.status, version: session.plan_version }
      let lost = 0
      const version = await apply(id, loaded, async () => {
        await write({ kind: 'delete', table: 'session_members', filters: [eq('session_id', id), eq('user_id', target)] })
        lost = await relist(id)
      }, (v) => bannerFor(lost)(v))
      return { status: 200, body: { planVersion: version, left: true } }
    },
  }

  // The adapter -------------------------------------------------------------

  // Which route a request is, with the session id and the rest.
  // How to call: route('POST', '/api/sessions/3b1f.../voting') -> { name: 'confirm', id: '3b1f...' }
  function route(method, path) {
    const m = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(path)
    if (!m) return null
    const [, id, tail = ''] = m
    const key = `${method} ${tail.replace(/^\/members\/.+$/, '/members/:who')}`
    const table = {
      'POST /meeting-area': 'meetingArea',
      'PUT /spots/mine': 'putSpot',
      'DELETE /spots/mine': 'deleteSpot',
      'POST /voting': 'confirm',
      'PUT /known-place': 'knownPlace',
      'POST /opt-out': 'optOut',
      'POST /rejoin': 'rejoin',
      'DELETE /members/:who': 'removeMember',
    }
    const name = table[key]
    return name ? { name, id: decodeURIComponent(id), who: decodeURIComponent(tail.split('/')[2] || '') } : null
  }

  server.adapter = async (config) => {
    const method = String(config.method || 'get').toUpperCase()
    const path = String(config.url || '').replace(/^https?:\/\/[^/]+/, '')
    const body = config.data ? JSON.parse(config.data) : {}
    const respond = (status, data) => {
      const response = { data, status, statusText: String(status), headers: {}, config, request: {} }
      if (status >= 400) throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response)
      return response
    }
    if (server.down) throw new AxiosError('Network Error', 'ERR_NETWORK', config, {})
    const token = String(config.headers?.get?.('Authorization') || '').replace(/^Bearer /, '')
    const user = token ? database.userForToken(token) : null
    const found = route(method, path)
    calls.push({ method, path, body, as: user, route: found?.name || null })
    if (!found) return respond(404, { error: 'not_found', message: 'No such route.' })
    if (!user) return respond(401, { error: 'unauthenticated', message: 'Log in to do that.' })
    try {
      const { status, body: data } = await routes[found.name](user, found.id, found.name === 'removeMember' ? found.who : body, body)
      return respond(status, data)
    } catch (err) {
      if (err instanceof Refusal) return respond(err.status, err.body)
      throw err
    }
  }
  return server
}
