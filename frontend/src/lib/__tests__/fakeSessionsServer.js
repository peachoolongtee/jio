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
// Stage 4 (voting, ticket 129; the design's E3 to E9, E17, E18, and E1 in voting) adds, on the same terms:
//   POST   /api/sessions/:id/plan/sync                                E3: slots and places worked out again from people's picks
//   PUT    /api/sessions/:id/radius                { radiusMeters }   E4 (host)
//   DELETE /api/sessions/:id/slots/:slotId                            E5 (host)
//   POST   /api/sessions/:id/slots/restore         { slotId? }        E6 (host)
//   POST   /api/sessions/:id/slots/:slotId/options { venueId }        E7
//   POST   /api/sessions/:id/slots/:slotId/options/more { have }      E8
//   POST   /api/sessions/:id/slots/:slotId/options/:venueId/swap { toVenueId }   E9
//   GET    /api/sessions/:id/slots/:slotId/venue-search?q=            E17
//   GET    /api/venues?ids=a,b                                        E18
// The confirm (E2) now makes the four slots with their places (the demo planner's answers, components/dev/offlinePlanner.js, ranked
// around the meeting area), E1 in voting prices a pinned area and re-ranks an unpinned one (clearing the votes if it moved), and opting
// out takes the person's votes. WHAT IS AN ASSUMPTION about the real server is marked "ASSUMED" below and listed in the report: the
// answers' fields beyond the design's, what a slot's `details` and an option's `details` hold, and the texts of the banners.
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
import { VENUES } from '../mock/venues.js'
import { asBackendVenue, standInConverge, standInSearch } from '../../components/dev/offlinePlanner.js'
import { OPTIONS_MAX, distanceKm, fromMinutes, reconcileOptions, toMinutes } from '../planner/index.js'

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

  // ── Stage 4: the slots, their places and the votes ─────────────────────────

  // How long each category lasts, in minutes (the browser's own durations).
  const IDEAL = { activity: 120, shop: 90, drink: 60, eat: 90 }
  const ORDER = ['activity', 'shop', 'drink', 'eat']
  // The weather block the server stores with a slot's details: the planner's own block, in the fields a card needs (weatherNote).
  const WEATHER = { source: 'live', basis: 'area', issuedAt: '2026-10-09T10:00:00+08:00' }
  // The step the radius chips go up in, for "widen to".
  const WIDEN = [500, 1000, 2000, 3000]

  // The slots of a session in the order they happen, not removed. How to call: slotsOf(id) -> [{ id, category, ... }]
  const slotsOf = (id) => rows('slots').filter((x) => x.session_id === id).sort((a, b) => a.start_minute - b.start_minute)
  const optionsOf = (slotId) => rows('slot_options').filter((o) => o.slot_id === slotId)
  const votesIn = (id) => rows('votes').filter((v) => slotsOf(id).some((x) => x.id === v.slot_id))
  const areaOf = (areaId) => AREAS.find((a) => a.id === areaId)
  // How to call: stamp(session, slot) -> '2026-10-09T12:00'
  const stamp = (session, slot) => `${session.date}T${fromMinutes(slot.start_minute)}`

  // What the planner ranks for a slot around the meeting area, best first, with the places already offered always scored.
  // How to call: rank(session, slot, ['v25'], 1000) -> [{ venueId, score, walkMinutes, venue, ... }]
  function rank(session, slot, currentIds, radius) {
    const answer = standInConverge({
      categories: [slot.category],
      centre: areaOf(session.meeting_area_id),
      dateTime: stamp(session, slot),
      durationMinutes: slot.duration_minutes,
      currentOptionIds: currentIds,
      topN: 10,
      radiusMeters: radius || undefined,
    })
    const all = [...answer.results]
    for (const r of answer.current) if (!all.some((x) => x.venueId === r.venueId)) all.push(r)
    return all
  }

  // A place's row as the server stores it (session-slots.js optionDetails): `details` holds the ranking result's own fields (walkMinutes,
  // crowd, reasons, warnings, swap: { venueId, name, weather } | null, explanation, verify, dietUnknown, approximate, weather?).
  // How to call: optionValues(result, 1)
  const optionValues = (r, rankNumber) => ({
    rank: rankNumber,
    score: r.score,
    details: { walkMinutes: r.walkMinutes, crowd: r.crowd ?? null, reasons: r.reasons, warnings: r.warnings, swap: r.swap, explanation: r.explanation, verify: r.verify, dietUnknown: r.dietUnknown, approximate: r.approximate },
  })

  // Rank a slot again and write what it should offer: the places that are offered and still fit stay (with their votes), the rest
  // go (and their votes with them), and it is topped up to three. Also stores what the planner said of the slot as a whole.
  // `fresh` offers nothing to start with (the area moved). `add` names places that must be scored and kept (a member's addition).
  // How to call: await fill(id, session, slot, { fresh: true })
  async function fill(id, session, slot, { fresh = false, add = [], radius = session.radius_meters } = {}) {
    const have = fresh ? [] : optionsOf(slot.id).map((o) => o.venue_id)
    const list = rank(session, slot, [...have, ...add], radius)
    const rankedIds = [...new Set(list.map((r) => r.venueId))]
    const keep = reconcileOptions(have, rankedIds)
    for (const venueId of add) if (rankedIds.includes(venueId) && !keep.includes(venueId) && keep.length < OPTIONS_MAX) keep.push(venueId)
    for (const old of optionsOf(slot.id).filter((o) => !keep.includes(o.venue_id))) {
      await write({ kind: 'delete', table: 'slot_options', filters: [eq('slot_id', slot.id), eq('venue_id', old.venue_id)] })
    }
    for (const [index, venueId] of keep.entries()) {
      const r = list.find((x) => x.venueId === venueId)
      const values = optionValues(r, index + 1)
      const exists = optionsOf(slot.id).some((o) => o.venue_id === venueId)
      const answer = exists
        ? await write({ kind: 'update', table: 'slot_options', values, filters: [eq('slot_id', slot.id), eq('venue_id', venueId)] })
        : await write({ kind: 'insert', table: 'slot_options', values: { slot_id: slot.id, venue_id: venueId, source: add.includes(venueId) ? 'member' : 'planner', ...values } })
      if (answer.error) throw new Error(`The stand-in server could not write a place: ${answer.error.message}`)
    }
    // A slot's details, as the real server stores them (backend/src/services/session-slots.js slotDetails):
    // { widened, few: { found, widenToKm } | null, empty: { reason, nearestKm, widenToKm } | null, moreAvailable, weather }.
    const centre = areaOf(session.meeting_area_id)
    const nearest = VENUES.filter((v) => v.category === slot.category).map((v) => distanceKm(centre, v)).sort((a, b) => a - b)[0]
    const few = radius && list.length > 0 && list.length < 3 ? { found: list.length, widenToKm: (WIDEN.find((m) => m > radius) ?? 3000) / 1000 } : null
    const details = {
      widened: few !== null,
      few,
      empty: list.length ? null : { reason: 'outside_max_radius', nearestKm: Math.round(nearest * 10) / 10, widenToKm: Math.ceil(nearest) },
      moreAvailable: rankedIds.length > keep.length && keep.length < OPTIONS_MAX,
      weather: WEATHER,
    }
    await write({ kind: 'update', table: 'slots', values: { details }, filters: [eq('id', slot.id)] })
    return keep
  }

  // Make the four slots of a session whose meeting area is `session.meeting_area_id`, with their places. ASSUMED: every category at once,
  // in the order activity, shop, drink, eat, half an hour apart from the start of the session, as long as they fit.
  // How to call: await buildSlots(id, { ...session, meeting_area_id: 'bugis' })
  async function buildSlots(id, session) {
    const start = toMinutes(String(session.start_time).slice(0, 5))
    const end = toMinutes(String(session.end_time).slice(0, 5))
    const people = rows('session_members').filter((m) => m.session_id === id && m.state === 'joined').length
    for (const [index, category] of ORDER.entries()) {
      const begin = Math.min(start + index * 30, 1439)
      const answer = await write({ kind: 'insert', table: 'slots', values: { session_id: id, category, start_minute: begin, duration_minutes: Math.max(1, Math.min(IDEAL[category], end - begin)), picks: people, is_last: index === ORDER.length - 1, details: {} } })
      if (answer.error) throw new Error(`The stand-in server could not make a slot: ${answer.error.message}`)
      await fill(id, session, slotsOf(id).find((x) => x.category === category), { fresh: true })
    }
    return ORDER.length
  }

  // The banner for votes that went, in the shape the server writes. ASSUMED: { text, at, votesCleared: true, byRadius?: true }.
  // How to call: votesBanner('Votes for places outside the new ring were cleared.', 3, { byRadius: true })(2) -> { banner: { ... } }
  const votesBanner = (text, lost, extra = {}) => (version) => (lost > 0 ? { banner: { text, at: Date.now() + version, votesCleared: true, ...extra } } : {})

  // The slot a request names, in this session, for a member who may change the places: the group is voting and the slot is not removed.
  // How to call: const slot = voting(session, slotId)
  function assertVoting(session) {
    if (session.status !== 'voting') refuse(409, 'wrong_status', 'This cannot be done while the session is in this state.')
  }
  function voting(session, slotId, { removed = false } = {}) {
    assertVoting(session)
    const slot = slotsOf(session.id).find((x) => x.id === slotId)
    if (!slot || (!removed && slot.deleted)) refuse(404, 'slot_not_found', 'That category is not on the list.')
    return slot
  }

  // Work out the meeting area again for a session that is voting, after a start changed or someone opted out or came back. A pinned area
  // (voted, chosen) never moves: only the numbers are written. An unpinned one is re-chosen (the fairest of all); if it moved, the places
  // and votes are cleared and the places made again. Returns the number of votes that went.
  // How to call: const lost = await repriceVoting(id, session)
  async function repriceVoting(id, session) {
    const people = located(id)
    if (!people.length) return { lost: 0, patch: () => ({}) }
    const pinned = ['voted', 'chosen'].includes(session.meeting_method)
    let target = session.meeting_area_id
    if (!pinned) {
      target = AREAS.map((a) => ({ id: a.id, ...pricing(a.id, people) })).sort((a, b) => a.worst - b.worst || a.mean - b.mean || a.id.localeCompare(b.id))[0].id
    }
    const priced = pricing(target, people)
    const times = Object.values(priced.travel).map(Math.round)
    let lost = 0
    if (target !== session.meeting_area_id) {
      lost = votesIn(id).length
      const moved = { ...session, meeting_area_id: target }
      // Every place goes (and the votes with them) and each slot is ranked afresh around the new area.
      for (const slot of slotsOf(id)) {
        await write({ kind: 'delete', table: 'slot_options', filters: [eq('slot_id', slot.id)] })
        if (!slot.deleted) await fill(id, moved, slot, { fresh: true })
      }
    }
    for (const [user, minutes] of Object.entries(priced.travel)) {
      await write({ kind: 'update', table: 'session_members', values: { travel_minutes: Math.round(minutes) }, filters: [eq('session_id', id), eq('user_id', user)] })
    }
    const from = areaOf(session.meeting_area_id).name
    const to = areaOf(target).name
    const text = target === session.meeting_area_id ? '' : `Meeting area moved from ${from} to ${to}.${lost ? ' Votes for places were cleared.' : ''}`
    return {
      lost,
      patch: (version) => ({
        meeting_area_id: target,
        meeting_max_minutes: Math.max(...times),
        meeting_total_minutes: times.reduce((sum, m) => sum + m, 0),
        meeting_count: times.length,
        ...(text ? { banner: { text, at: Date.now() + version, ...(lost ? { votesCleared: true } : {}) } } : {}),
      }),
    }
  }

  // The routes ------------------------------------------------------------

  const routes = {
    // E1
    async meetingArea(user, id) {
      const { session } = load(user, id)
      if (session.status === 'voting') {
        const loadedVoting = { status: session.status, version: session.plan_version }
        const areaBefore = session.meeting_area_id
        const skippedVoting = rows('session_members').filter((m) => m.session_id === id && m.state === 'joined' && !m.start_area_id).map((m) => m.user_id)
        await after.meetingArea?.(id)
        let repriced
        const version = await apply(id, loadedVoting, async () => { repriced = await repriceVoting(id, session) }, (v) => repriced.patch(v))
        return { status: 200, body: { planVersion: version, meetingAreaId: rows('sessions').find((x) => x.id === id).meeting_area_id, moved: rows('sessions').find((x) => x.id === id).meeting_area_id !== areaBefore, votesCleared: repriced.lost > 0, skipped: skippedVoting } }
      }
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
      let slotCount = 0
      const version = await apply(id, loaded, async () => { slotCount = await buildSlots(id, { ...session, meeting_area_id: chosen.area_id }) }, () => ({
        status: 'voting',
        meeting_area_id: chosen.area_id,
        meeting_method: method,
        meeting_max_minutes: Math.max(...times),
        meeting_total_minutes: times.reduce((sum, m) => sum + m, 0),
        meeting_count: times.length,
        meeting_approximate: false,
        banner: null,
      }))
      return { status: 200, body: { planVersion: version, status: 'voting', meetingAreaId: chosen.area_id, method, slotCount } }
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
      const version = await apply(id, loaded, async () => {
        for (const table of ['spot_suggestions', 'session_spots']) await write({ kind: 'delete', table, filters: [eq('session_id', id)] })
        const answer = await write({ kind: 'insert', table: 'session_spots', values: { session_id: id, area_id: body.areaId, rank: null, worst_minutes: priced?.worst ?? 0, mean_minutes: priced?.mean ?? 0, travel_minutes: priced?.travel ?? {} } })
        if (answer.error) throw new Error(answer.error.message)
        await buildSlots(id, { ...session, meeting_area_id: body.areaId })
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
      if (session.status === 'voting') {
        // ASSUMED (the design's E10): in voting the person's votes go and the area is worked out again without them.
        const loadedVoting = { status: session.status, version: session.plan_version }
        let repriced
        const version = await apply(id, loadedVoting, async () => {
          await write({ kind: 'update', table: 'session_members', values: { state: 'opted_out' }, filters: [eq('session_id', id), eq('user_id', user)] })
          for (const slot of slotsOf(id)) await write({ kind: 'delete', table: 'votes', filters: [eq('slot_id', slot.id), eq('user_id', user)] })
          repriced = await repriceVoting(id, session)
        }, (v) => repriced.patch(v))
        return { status: 200, body: { planVersion: version, state: 'opted_out' } }
      }
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
      if (session.status === 'voting') {
        const loadedVoting = { status: session.status, version: session.plan_version }
        let repriced
        const version = await apply(id, loadedVoting, async () => {
          await write({ kind: 'update', table: 'session_members', values: { state: 'joined' }, filters: [eq('session_id', id), eq('user_id', user)] })
          repriced = await repriceVoting(id, session)
        }, (v) => repriced.patch(v))
        return { status: 200, body: { planVersion: version, state: 'joined' } }
      }
      if (!OPEN.includes(session.status)) refuse(409, 'wrong_status', 'The session has moved on.')
      const loaded = { status: session.status, version: session.plan_version }
      const version = await apply(id, loaded, async () => {
        await write({ kind: 'update', table: 'session_members', values: { state: 'joined' }, filters: [eq('session_id', id), eq('user_id', user)] })
        await relist(id)
      }, () => ({}))
      return { status: 200, body: { planVersion: version, state: 'joined' } }
    },
    // E3: the slots and places worked out again from people's picks. ASSUMED: it changes nothing while no pick changed what is offered.
    async syncPlan(user, id) {
      const { session } = load(user, id)
      if (!['voting', 'inviting', 'locating'].includes(session.status)) refuse(409, 'wrong_status', 'The session has moved on.')
      if (session.status !== 'voting') return { status: 200, body: { planVersion: session.plan_version, changed: false } }
      const loaded = { status: session.status, version: session.plan_version }
      await after.syncPlan?.(id)
      const version = await apply(id, loaded, async () => {
        for (const slot of slotsOf(id).filter((x) => !x.deleted)) await fill(id, session, slot)
      }, () => ({}))
      return { status: 200, body: { planVersion: version, changed: version !== loaded.version } }
    },
    // E4: the host sets the radius. Places outside it go with their votes and each slot is topped up again.
    async radius(user, id, body) {
      const { session } = load(user, id)
      if (session.host_id !== user) refuse(403, 'host_only', 'Only the host can do that.')
      assertVoting(session)
      if (body.radiusMeters !== null && !(Number.isInteger(body.radiusMeters) && body.radiusMeters >= 100 && body.radiusMeters <= 3000)) refuse(400, 'invalid_input', 'Pick a radius from 100 to 3000 metres.')
      const loaded = { status: session.status, version: session.plan_version }
      const before = votesIn(id).length
      await after.radius?.(id)
      const version = await apply(id, loaded, async () => {
        for (const slot of slotsOf(id).filter((x) => !x.deleted)) await fill(id, session, slot, { radius: body.radiusMeters })
      }, (v) => {
        const lost = before - votesIn(id).length
        const text = body.radiusMeters == null ? 'Votes for places that no longer fit were cleared.' : 'Votes for places outside the new ring were cleared.'
        return { radius_meters: body.radiusMeters, banner: lost > 0 ? votesBanner(text, lost, { byRadius: true })(v).banner : null }
      })
      return { status: 200, body: { planVersion: version, radiusMeters: body.radiusMeters } }
    },
    // E5
    async deleteSlot(user, id, body, { slot: slotId }) {
      const { session } = load(user, id)
      if (session.host_id !== user) refuse(403, 'host_only', 'Only the host can do that.')
      const slot = voting(session, slotId, { removed: true })
      if (slot.deleted) return { status: 200, body: { planVersion: session.plan_version } }
      const loaded = { status: session.status, version: session.plan_version }
      const version = await apply(id, loaded, async () => {
        await write({ kind: 'delete', table: 'slot_options', filters: [eq('slot_id', slot.id)] })
        await write({ kind: 'update', table: 'slots', values: { deleted: true }, filters: [eq('id', slot.id)] })
      }, () => ({}))
      return { status: 200, body: { planVersion: version } }
    },
    // E6
    async restoreSlots(user, id, body) {
      const { session } = load(user, id)
      if (session.host_id !== user) refuse(403, 'host_only', 'Only the host can do that.')
      assertVoting(session)
      const wanted = body.slotId ? slotsOf(id).filter((x) => x.id === body.slotId) : slotsOf(id).filter((x) => x.deleted)
      if (body.slotId && !wanted.length) refuse(404, 'slot_not_found', 'That category is not on the list.')
      const loaded = { status: session.status, version: session.plan_version }
      const restored = wanted.filter((x) => x.deleted).map((x) => x.id)
      const version = await apply(id, loaded, async () => {
        for (const slotId of restored) {
          await write({ kind: 'update', table: 'slots', values: { deleted: false }, filters: [eq('id', slotId)] })
          await fill(id, session, slotsOf(id).find((x) => x.id === slotId), { fresh: true })
        }
      }, () => ({}))
      return { status: 200, body: { planVersion: version, restored } }
    },
    // E7: a member adds a place. ASSUMED answers: 201 { planVersion, added: true }, 200 { planVersion, added: false } when it was there.
    async addOption(user, id, body, { slot: slotId }) {
      const { session } = load(user, id)
      const slot = voting(session, slotId)
      if (typeof body.venueId !== 'string' || !body.venueId || body.venueId.length > 80) refuse(400, 'invalid_input', 'Send a place id.')
      const have = optionsOf(slot.id)
      if (have.some((o) => o.venue_id === body.venueId)) return { status: 200, body: { planVersion: session.plan_version, added: false } }
      if (have.length >= OPTIONS_MAX) refuse(409, 'slot_full', 'A category holds up to 6 places.')
      const venue = VENUES.find((v) => v.id === body.venueId)
      if (!venue) refuse(404, 'venue_not_found', 'That place could not be found.')
      const fits = rank(session, slot, [...have.map((o) => o.venue_id), body.venueId], session.radius_meters).some((r) => r.venueId === body.venueId)
      if (!fits) refuse(422, 'venue_does_not_fit', 'That place does not fit this category.')
      const loaded = { status: session.status, version: session.plan_version }
      await after.addOption?.(id)
      const version = await apply(id, loaded, async () => {
        const r = rank(session, slot, [...have.map((o) => o.venue_id), body.venueId], session.radius_meters).find((x) => x.venueId === body.venueId)
        const answer = await write({ kind: 'insert', table: 'slot_options', values: { slot_id: slot.id, venue_id: body.venueId, source: 'member', added_by: user, ...optionValues(r, have.length + 1) } })
        if (answer.error) throw new Error(answer.error.message)
      }, () => ({}))
      return { status: 201, body: { planVersion: version, added: true } }
    },
    // E8: more places, up to three more and never past six. `have` is what the person is looking at.
    async moreOptions(user, id, body, { slot: slotId }) {
      const { session } = load(user, id)
      const slot = voting(session, slotId)
      const have = optionsOf(slot.id).map((o) => o.venue_id)
      const target = Math.min(OPTIONS_MAX, (Number.isInteger(body.have) ? body.have : have.length) + 3)
      const list = rank(session, slot, have, session.radius_meters)
      const extra = []
      for (const r of list) {
        if (have.length + extra.length >= target) break
        if (!have.includes(r.venueId)) extra.push(r)
      }
      const loaded = { status: session.status, version: session.plan_version }
      const version = await apply(id, loaded, async () => {
        for (const [index, r] of extra.entries()) {
          const answer = await write({ kind: 'insert', table: 'slot_options', values: { slot_id: slot.id, venue_id: r.venueId, source: 'planner', ...optionValues(r, have.length + index + 1) } })
          if (answer.error) throw new Error(answer.error.message)
        }
      }, () => ({}))
      return { status: 200, body: { planVersion: version, added: extra.map((r) => r.venueId) } }
    },
    // E9: swap a place for another in place; the votes follow it.
    async swapOption(user, id, body, { slot: slotId, venue: fromId }) {
      const { session } = load(user, id)
      const slot = voting(session, slotId)
      const option = optionsOf(slot.id).find((o) => o.venue_id === fromId)
      const toId = body.toVenueId
      if (!option) {
        // Already swapped (a repeat): the place it was swapped for is there and the old one is not.
        if (optionsOf(slot.id).some((o) => o.venue_id === toId)) return { status: 200, body: { planVersion: session.plan_version, swapped: false } }
        refuse(404, 'option_not_found', 'That place is not offered.')
      }
      if (!VENUES.some((v) => v.id === toId)) refuse(404, 'venue_not_found', 'That place could not be found.')
      const current = optionsOf(slot.id).map((o) => o.venue_id)
      const found = rank(session, slot, [...current, toId], session.radius_meters).find((x) => x.venueId === toId)
      if (!found) refuse(422, 'venue_does_not_fit', 'That place does not fit this category.')
      const loaded = { status: session.status, version: session.plan_version }
      const version = await apply(id, loaded, async () => {
        if (current.includes(toId)) {
          // It is offered already: the old one simply goes, with its votes.
          await write({ kind: 'delete', table: 'slot_options', filters: [eq('slot_id', slot.id), eq('venue_id', fromId)] })
          return
        }
        // ASSUMED (the design's E9): the votes follow the swapped place. The real function updates the option in place and the foreign key
        // carries the votes; here the new place is written, the votes are moved to it, and the old one goes.
        const made = await write({ kind: 'insert', table: 'slot_options', values: { slot_id: slot.id, venue_id: toId, source: option.source, added_by: option.added_by, ...optionValues(found, option.rank) } })
        if (made.error) throw new Error(made.error.message)
        await write({ kind: 'update', table: 'votes', values: { venue_id: toId }, filters: [eq('slot_id', slot.id), eq('venue_id', fromId)] })
        await write({ kind: 'delete', table: 'slot_options', filters: [eq('slot_id', slot.id), eq('venue_id', fromId)] })
      }, () => ({}))
      return { status: 200, body: { planVersion: version, swapped: true } }
    },
    // E17: places found by name for a slot.
    async venueSearch(user, id, body, { slot: slotId, query }) {
      const { session } = load(user, id)
      const slot = voting(session, slotId)
      const q = String(query?.q ?? '').trim()
      if (!q || q.length > 60) refuse(400, 'invalid_input', 'Send a search of 1 to 60 characters.')
      const have = optionsOf(slot.id).map((o) => o.venue_id)
      const found = standInSearch({ query: q, categories: [slot.category], centre: areaOf(session.meeting_area_id), dateTime: stamp(session, slot), durationMinutes: slot.duration_minutes, maxKm: session.radius_meters ? session.radius_meters / 1000 : undefined })
      return { status: 200, body: { results: found.results.map((r) => ({ ...r, added: have.includes(r.venueId) })) } }
    },
    // E18: places by id, in the shape the backend sends them; one it does not know is left out.
    async venues(user, id, body, { query }) {
      const ids = String(query?.ids ?? '').split(',').filter(Boolean)
      if (ids.length > 50) refuse(400, 'invalid_input', 'Ask for up to 50 places.')
      return { status: 200, body: { venues: ids.flatMap((venueId) => VENUES.filter((v) => v.id === venueId).map(asBackendVenue)) } }
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
  const PATTERNS = [
    ['POST', /^\/meeting-area$/, 'meetingArea'],
    ['PUT', /^\/spots\/mine$/, 'putSpot'],
    ['DELETE', /^\/spots\/mine$/, 'deleteSpot'],
    ['POST', /^\/voting$/, 'confirm'],
    ['PUT', /^\/known-place$/, 'knownPlace'],
    ['POST', /^\/opt-out$/, 'optOut'],
    ['POST', /^\/rejoin$/, 'rejoin'],
    ['DELETE', /^\/members\/([^/]+)$/, 'removeMember', ['who']],
    ['POST', /^\/plan\/sync$/, 'syncPlan'],
    ['PUT', /^\/radius$/, 'radius'],
    ['POST', /^\/slots\/restore$/, 'restoreSlots'],
    ['DELETE', /^\/slots\/([^/]+)$/, 'deleteSlot', ['slot']],
    ['POST', /^\/slots\/([^/]+)\/options$/, 'addOption', ['slot']],
    ['POST', /^\/slots\/([^/]+)\/options\/more$/, 'moreOptions', ['slot']],
    ['POST', /^\/slots\/([^/]+)\/options\/([^/]+)\/swap$/, 'swapOption', ['slot', 'venue']],
    ['GET', /^\/slots\/([^/]+)\/venue-search$/, 'venueSearch', ['slot']],
  ]
  function route(method, path) {
    if (method === 'GET' && path === '/api/venues') return { name: 'venues', id: null }
    const m = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(path)
    if (!m) return null
    const [, id, tail = ''] = m
    for (const [verb, pattern, name, params = []] of PATTERNS) {
      const hit = verb === method ? pattern.exec(tail) : null
      if (hit) return { name, id: decodeURIComponent(id), extra: Object.fromEntries(params.map((key, i) => [key, decodeURIComponent(hit[i + 1])])) }
    }
    return null
  }

  server.adapter = async (config) => {
    const method = String(config.method || 'get').toUpperCase()
    const path = String(config.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    const body = config.data ? JSON.parse(config.data) : {}
    const query = config.params || {}
    const respond = (status, data) => {
      const response = { data, status, statusText: String(status), headers: {}, config, request: {} }
      if (status >= 400) throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response)
      return response
    }
    if (server.down) throw new AxiosError('Network Error', 'ERR_NETWORK', config, {})
    const token = String(config.headers?.get?.('Authorization') || '').replace(/^Bearer /, '')
    const user = token ? database.userForToken(token) : null
    const found = route(method, path)
    calls.push({ method, path, body, query, as: user, route: found?.name || null })
    if (!found) return respond(404, { error: 'not_found', message: 'No such route.' })
    if (!user) return respond(401, { error: 'unauthenticated', message: 'Log in to do that.' })
    try {
      const extra = { ...found.extra, query }
      const { status, body: data } = await routes[found.name](user, found.id, found.name === 'removeMember' ? found.extra.who : body, found.name === 'removeMember' ? body : extra)
      return respond(status, data)
    } catch (err) {
      if (err instanceof Refusal) return respond(err.status, err.body)
      throw err
    }
  }
  return server
}
