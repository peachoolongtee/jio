// Stage 5 of the stand-in Jio server (ticket #130; the design's E12 to E16 and E22 to E24, on #125 and #80): confirming the plan, the
// suggested order, re-planning, ending the outing and its ledger, the stops, and Roam's proposals. It adds its routes to the ones in
// ./fakeSessionsServer.js (which calls `registerPlan`), on the same terms: an axios adapter that acts on the stand-in database with the
// service key, flat errors, 401 without a token, 404 `session_not_found` for a stranger, and a write applied only if the session still has
// the status and version it was worked out for.
//
// Every route here is ASSUMED to the extent the backend half (branch feat/sessions-stage-5) is not written yet: the names of the paths
// are the design's; the answers' fields are the design's; what the design leaves open is marked ASSUMED below. A rule the real server
// has and this one has simpler is marked SIMPLER. The real server writes through apply_session_plan; this one writes straight to the
// tables (the stand-in database's port of that function knows only the stage 3 and 4 parts of a patch).
//
//   POST   /api/sessions/:id/order/suggest                       E22 (host, voting): the winners' suggested order, stored with its basis
//   POST   /api/sessions/:id/confirm   { order?, basis? }        E12 (host, voting to confirmed): the stops, from the server's own rows
//   POST   /api/sessions/:id/replan    { accept? }               E13 (host): back to voting, or only the question turned off
//   POST   /api/sessions/:id/complete                            E14 (host, confirmed to completed): the ledger
//   PATCH  /api/sessions/:id/stops/:stopId   { travelMode }      E15 (host)
//   DELETE /api/sessions/:id/stops/:stopId                       E15 (host)
//   PUT    /api/sessions/:id/stops/order     { stopIds }         E15's order route (host)
//   GET    /api/sessions/:id/stops/:stopId/swap                  ASSUMED: the indoor swap offered for a stop
//   GET    /api/sessions/:id/stops/:stopId/choices?category=&start=   ASSUMED: the places that could take a stop's place
//   PUT    /api/sessions/:id/stops/:stopId/place { venueId, fromVenueId, category?, start? }   ASSUMED: put one in (host)
//   POST   /api/sessions/:id/roam      { current?, categories? } E16 (joined member, confirmed): the list; writes nothing
//   POST   /api/sessions/:id/proposals { venueId }               E23 (joined member, confirmed)
//   POST   /api/sessions/:id/proposals/:proposalId/resolve { accept }   E24 (host; the proposer may dismiss their own)
//
// Also POST /api/weather/stops (the weather at the plan's stops: dry, or `server.plan.weather = 'showers'`), which is not a session route.
//
// What the design leaves open and this stand-in therefore ASSUMES (to be reconciled with the backend half):
//   - the stops E12 writes have `planned_start_minute` = the slot's start and `duration_minutes` = the slot's length; a suggested order
//     also sets each stop's `not_before_minute` to the suggested start; `plan_start_minute` is the earliest start (suggested or planned);
//     `order_reason` and `order_source` carry the suggestion's note (voted: both null); a pending proposal is dismissed on confirm;
//   - E13 (accept) deletes the stops, clears the order columns and the suggestion, dismisses pending proposals and prices the area again;
//   - E14 writes one ledger row per joined member (in = their trip to the meeting area, between = 0, home = in; delta = their total less
//     the group's mean), sets `completed_at`, clears `replan` and dismisses pending proposals;
//   - E15 DELETE and the order route clear every stop's `not_before_minute` (the design says "every stop's") and the order note, and the
//     order route also clears the travel modes; deleting the first stop sets `plan_start_minute` to the next stop's planned start;
//   - E24 (accept) appends a stop with no slot, the place's own category, 60 minutes, starting when the last stop ends, with that start as
//     its earliest start, and clears the order note;
//   - E22 answers `{ status: 'none', why }` when fewer than two stops can move, and stores `{ basis, order, starts, reason, source, at }`.
//
// Hooks for a test, on `server.plan`: `orderSource` ('ai' or 'rules', the source of a suggestion), `suggest` (a function that replaces the
// suggestion: `(winners) => ({ order, starts, reason, source })`, with `stops` to name the stops itself, or null for "none"), `swap` (a function from a place's id to the indoor swap the
// server offers for it, `{ venueId, name }`), `weather`, and `confirmedOptOut` (ASSUMED: opting out of a confirmed plan is allowed and
// asks "Re-plan?", where the stage 4 server still refuses with not_yet). Per route, `server.after.<route>` runs after
// the server has read the session and before it writes.
import { AREAS } from '../mock/places.js'
import { VENUES } from '../mock/venues.js'
import { asBackendVenue, standInConverge } from '../../components/dev/offlinePlanner.js'
import { distanceKm, fromMinutes } from '../planner/index.js'

const PLAN_MAX = 8
const MODES = ['walk', 'mrt', 'car']
const PROPOSALS_PER_MEMBER = 3
const PROPOSALS_PER_SESSION = 10
const PROPOSED_MINUTES = 60

// A sha-256 as 64 hex characters. How to call: await sha256('text') -> 'a3f9...'
async function sha256(text) {
  const bytes = new TextEncoder().encode(text)
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// How to call: registerPlan(kit, routes, PATTERNS)
export function registerPlan(kit, routes, PATTERNS) {
  const { rows, write, eq, refuse, load, apply, after, server, repriceVoting, rank, areaOf, slotsOf, optionsOf, tripMinutes, located, pricing } = kit
  server.plan = { orderSource: 'ai', suggest: undefined, confirmedOptOut: false }

  const stopsOf = (id) => rows('stops').filter((x) => x.session_id === id).sort((a, b) => a.seq - b.seq)
  const joinedIds = (id) => rows('session_members').filter((m) => m.session_id === id && m.state === 'joined').map((m) => m.user_id)
  const stamp = (session, minutes) => `${session.date}T${fromMinutes(minutes)}`
  const loadedOf = (session) => ({ status: session.status, version: session.plan_version })
  const asHost = (session, user) => {
    if (session.host_id !== user) refuse(403, 'host_only', 'Only the host can do that.')
  }
  const confirmedOnly = (session) => {
    if (session.status !== 'confirmed') refuse(409, 'wrong_status', 'This can only be done to a confirmed plan.')
  }

  // The winner of each slot somebody voted in, in the order of the slots, and the people who voted (joined members only). The winner is
  // the place with the most votes, then the lower stored score, then the better rank, as the design says (E12): the server's stored rows
  // decide, what the group saw is what wins.
  // How to call: const { winners, voters } = winnersOf('3b1f...') -> winners: [{ slot, option }]
  function winnersOf(id) {
    const joined = new Set(joinedIds(id))
    const winners = []
    const voters = new Set()
    for (const slot of slotsOf(id).filter((x) => !x.deleted)) {
      const votes = rows('votes').filter((v) => v.slot_id === slot.id && joined.has(v.user_id))
      if (!votes.length) continue
      for (const vote of votes) voters.add(vote.user_id)
      const counts = {}
      for (const vote of votes) counts[vote.venue_id] = (counts[vote.venue_id] || 0) + 1
      const best = [...optionsOf(slot.id)].sort((a, b) => (counts[b.venue_id] || 0) - (counts[a.venue_id] || 0) || (a.score ?? 1e9) - (b.score ?? 1e9) || (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.venue_id.localeCompare(b.venue_id))[0]
      if (best) winners.push({ slot, option: best })
    }
    return { winners, voters }
  }

  // A hash of the winners (slot, place, start, length) and the session's day and times: what a suggestion was made for.
  // How to call: await basisOf(session, winners) -> 'a3f9...' (64 hex characters)
  const basisOf = (session, winners) =>
    sha256(JSON.stringify({ winners: winners.map(({ slot, option }) => [slot.id, option.venue_id, slot.start_minute, slot.duration_minutes]), date: session.date, start: session.start_time, end: session.end_time }))

  // The voted order laid out in time, and the suggested one. SIMPLER than the real server (the AI or the planner's rules): the suggestion
  // keeps a meal at its slot's time and turns the other stops round, so a test always has a different order to choose.
  // How to call: suggestionFor(winners) -> { order: [slotId], starts: { [slotId]: minutes }, reason, source } | null
  function suggestionFor(winners) {
    if (server.plan.suggest !== undefined) return server.plan.suggest ? server.plan.suggest(winners) : null
    const movable = winners.filter((w) => w.slot.category !== 'eat')
    if (movable.length < 2) return null
    const reversed = [...movable].reverse()
    const laid = winners.map((w) => (w.slot.category === 'eat' ? w : reversed.shift()))
    let clock = laid[0] ? Math.min(...winners.map((w) => w.slot.start_minute)) : 0
    const starts = {}
    for (const w of laid) {
      const start = Math.max(clock, w.slot.category === 'eat' ? w.slot.start_minute : clock)
      starts[w.slot.id] = start
      clock = start + w.slot.duration_minutes
    }
    return { order: laid.map((w) => w.slot.id), starts, reason: 'The meal keeps its time and the other stops are turned round.', source: server.plan.orderSource }
  }

  // ── E22: the suggested order ──
  routes.suggestOrder = async (user, id) => {
    const { session } = load(user, id)
    asHost(session, user)
    if (session.status !== 'voting') refuse(409, 'wrong_status', 'The group is not voting.')
    const { winners, voters } = winnersOf(id)
    if (voters.size < 2 || !winners.length) refuse(409, 'not_enough_votes', 'At least 2 people need to vote first.')
    const basis = await basisOf(session, winners)
    const stored = session.order_suggestion
    const stopsOfOrder = (made) => made.stops ?? made.order.map((slotId) => ({ slotId, venueId: winners.find((w) => w.slot.id === slotId).option.venue_id, start: made.starts[slotId] }))
    // An unchanged basis returns the stored answer.
    if (stored?.basis === basis) {
      return { status: 200, body: { status: 'ok', basis, order: stored.order, stops: stopsOfOrder(stored), reason: stored.reason, source: stored.source } }
    }
    const made = suggestionFor(winners)
    await after.suggestOrder?.(id)
    if (!made) return { status: 200, body: { status: 'none', why: 'nothing_to_arrange' } }
    const loaded = loadedOf(session)
    await apply(id, loaded, async () => {}, () => ({ order_suggestion: { basis, order: made.order, starts: made.starts ?? {}, reason: made.reason, source: made.source, at: new Date().toISOString() } }))
    return { status: 200, body: { status: 'ok', basis, order: made.order, stops: stopsOfOrder(made), reason: made.reason, source: made.source } }
  }

  // ── E12: confirm ──
  routes.confirmPlan = async (user, id, body) => {
    const { session } = load(user, id)
    asHost(session, user)
    if (session.status === 'confirmed') return { status: 200, body: { planVersion: session.plan_version, status: 'confirmed', stops: stopsOf(id).length } }
    if (session.status !== 'voting') refuse(409, 'wrong_status', 'The group is not voting.')
    const { winners, voters } = winnersOf(id)
    if (voters.size < 2) refuse(409, 'not_enough_votes', 'At least 2 people need to vote first.')
    if (!winners.length) refuse(409, 'nothing_to_confirm', 'Vote for at least one place first.')
    const order = body.order ?? 'voted'
    if (!['voted', 'suggested'].includes(order)) refuse(400, 'invalid_input', 'Order is voted or suggested.')
    if (body.basis !== undefined && !/^[0-9a-f]{64}$/.test(String(body.basis))) refuse(400, 'invalid_input', 'The basis is 64 hex characters.')
    const basis = await basisOf(session, winners)
    const stored = session.order_suggestion
    // Suggested: recomputed from the winners at this moment; the body's basis and the stored one must both equal it, else nothing is written.
    if (order === 'suggested' && !(body.basis === basis && stored?.basis === basis)) refuse(409, 'order_stale', 'The votes changed since that order was suggested.')
    await after.confirmPlan?.(id)
    const loaded = loadedOf(session)
    const sequence = order === 'suggested' ? stored.order.map((slotId) => winners.find((w) => w.slot.id === slotId)) : winners
    const starts = order === 'suggested' ? stored.starts : null
    let count = 0
    await apply(id, loaded, async () => {
      await write({ kind: 'delete', table: 'stops', filters: [eq('session_id', id)] })
      for (const [seq, w] of sequence.entries()) {
        const made = await write({
          kind: 'insert',
          table: 'stops',
          values: { session_id: id, seq, slot_id: w.slot.id, category: w.slot.category, venue_id: w.option.venue_id, planned_start_minute: w.slot.start_minute, duration_minutes: w.slot.duration_minutes, not_before_minute: starts ? starts[w.slot.id] : null },
        })
        if (made.error) throw new Error(`The stand-in server could not write a stop: ${made.error.message}`)
        count += 1
      }
      for (const proposal of rows('stop_proposals').filter((x) => x.session_id === id && x.status === 'pending')) {
        await write({ kind: 'update', table: 'stop_proposals', values: { status: 'dismissed', resolved_at: new Date().toISOString() }, filters: [eq('id', proposal.id)] })
      }
    }, () => ({
      status: 'confirmed',
      banner: null,
      replan: null,
      plan_start_minute: starts ? Math.min(...Object.values(starts)) : Math.min(...winners.map((w) => w.slot.start_minute)),
      order_reason: starts ? stored.reason : null,
      order_source: starts ? stored.source : null,
    }))
    return { status: 200, body: { planVersion: rows('sessions').find((x) => x.id === id).plan_version, status: 'confirmed', stops: count } }
  }

  // ── E13: re-plan ──
  routes.replan = async (user, id, body) => {
    const { session } = load(user, id)
    asHost(session, user)
    const accept = body.accept !== false
    if (accept && session.status === 'voting') return { status: 200, body: { planVersion: session.plan_version, status: 'voting' } }
    confirmedOnly(session)
    const loaded = loadedOf(session)
    await after.replan?.(id)
    if (!accept) {
      const version = await apply(id, loaded, async () => {}, () => ({ replan: null }))
      return { status: 200, body: { planVersion: version, status: 'confirmed' } }
    }
    let repriced = { patch: () => ({}) }
    const version = await apply(id, loaded, async () => {
      await write({ kind: 'delete', table: 'stops', filters: [eq('session_id', id)] })
      for (const proposal of rows('stop_proposals').filter((x) => x.session_id === id && x.status === 'pending')) {
        await write({ kind: 'update', table: 'stop_proposals', values: { status: 'dismissed', resolved_at: new Date().toISOString() }, filters: [eq('id', proposal.id)] })
      }
      repriced = await repriceVoting(id, { ...session, status: 'voting' })
    }, (v) => ({ status: 'voting', replan: null, order_reason: null, order_source: null, order_suggestion: null, plan_start_minute: null, ...repriced.patch(v) }))
    return { status: 200, body: { planVersion: version, status: 'voting' } }
  }

  // ── E14: end the outing ──
  routes.complete = async (user, id) => {
    const { session } = load(user, id)
    asHost(session, user)
    if (session.status === 'completed') return { status: 200, body: { status: 'completed' } }
    confirmedOnly(session)
    const loaded = loadedOf(session)
    await after.complete?.(id)
    const people = rows('session_members').filter((m) => m.session_id === id && m.state === 'joined')
    // SIMPLER: the trip in is the person's own minutes to the meeting area (priced from the centres of the areas, as the spots are); between
    // stops is 0 (the design's default); the trip home is the same as the trip in. The real server routes the way home from the last stop.
    // The delta is each person's total less the mean of the group's.
    const travel = pricing(session.meeting_area_id, located(id)).travel
    const minutesIn = (m) => Math.round(travel[m.user_id] ?? m.travel_minutes ?? 0)
    const totals = people.map((m) => minutesIn(m) * 2)
    const mean = totals.length ? totals.reduce((sum, t) => sum + t, 0) / totals.length : 0
    await apply(id, loaded, async () => {
      for (const [index, m] of people.entries()) {
        const minutes = minutesIn(m)
        const made = await write({ kind: 'insert', table: 'commute_ledger', values: { session_id: id, user_id: m.user_id, minutes_in: minutes, minutes_between: 0, minutes_home: minutes, delta_from_mean: Math.round((totals[index] - mean) * 100) / 100 } })
        if (made.error) throw new Error(`The stand-in server could not write a ledger row: ${made.error.message}`)
      }
      for (const proposal of rows('stop_proposals').filter((x) => x.session_id === id && x.status === 'pending')) {
        await write({ kind: 'update', table: 'stop_proposals', values: { status: 'dismissed', resolved_at: new Date().toISOString() }, filters: [eq('id', proposal.id)] })
      }
    }, () => ({ status: 'completed', completed_at: new Date().toISOString(), replan: null }))
    return { status: 200, body: { status: 'completed' } }
  }

  // The stop a request names in this session.
  // How to call: const stop = stopNamed('3b1f...', '5d0c...')
  function stopNamed(id, stopId) {
    const stop = stopsOf(id).find((x) => x.id === stopId)
    if (!stop) refuse(404, 'stop_not_found', 'That stop is not in the plan.')
    return stop
  }

  // What editing the stops by hand clears, per the design (E15): every stop's earliest start and the note about the order. A stop made
  // from a proposal loses its earliest start too (SIMPLER and the design's wording: "every stop's").
  // How to call: await clearOrderNote(id)
  async function clearOrderNote(id) {
    for (const stop of stopsOf(id).filter((x) => x.not_before_minute != null)) {
      await write({ kind: 'update', table: 'stops', values: { not_before_minute: null }, filters: [eq('id', stop.id)] })
    }
  }

  // ── E15: the stops ──
  routes.patchStop = async (user, id, body, { stop: stopId }) => {
    const { session } = load(user, id)
    asHost(session, user)
    confirmedOnly(session)
    const stop = stopNamed(id, stopId)
    if (!MODES.includes(body.travelMode)) refuse(400, 'invalid_input', 'Travel mode is walk, mrt or car.')
    const loaded = loadedOf(session)
    const version = await apply(id, loaded, async () => {
      await write({ kind: 'update', table: 'stops', values: { travel_mode: body.travelMode }, filters: [eq('id', stop.id)] })
    }, () => ({}))
    return { status: 200, body: { planVersion: version } }
  }
  routes.deleteStop = async (user, id, body, { stop: stopId }) => {
    const { session } = load(user, id)
    asHost(session, user)
    confirmedOnly(session)
    const all = stopsOf(id)
    const stop = stopNamed(id, stopId)
    if (all.length <= 1) refuse(409, 'last_stop', 'A plan needs at least one stop.')
    const loaded = loadedOf(session)
    const index = all.indexOf(stop)
    const rest = all.filter((x) => x !== stop)
    const version = await apply(id, loaded, async () => {
      await write({ kind: 'delete', table: 'stops', filters: [eq('id', stop.id)] })
      for (const [seq, x] of rest.entries()) if (x.seq !== seq) await write({ kind: 'update', table: 'stops', values: { seq }, filters: [eq('id', x.id)] })
      // The leg that now joins the two stops on either side starts with its default mode.
      if (rest[index]) await write({ kind: 'update', table: 'stops', values: { travel_mode: null }, filters: [eq('id', rest[index].id)] })
      await clearOrderNote(id)
    }, () => ({
      order_reason: null,
      order_source: null,
      // Deleting the first stop starts the plan where the next one planned to.
      ...(index === 0 ? { plan_start_minute: rest[0].planned_start_minute } : {}),
    }))
    return { status: 200, body: { planVersion: version } }
  }
  routes.stopOrder = async (user, id, body) => {
    const { session } = load(user, id)
    asHost(session, user)
    confirmedOnly(session)
    const all = stopsOf(id)
    const ids = body.stopIds
    if (!Array.isArray(ids) || ids.length > PLAN_MAX) refuse(400, 'invalid_input', 'Send up to 8 stop ids.')
    if (ids.length !== all.length || new Set(ids).size !== ids.length || ids.some((x) => !all.some((s) => s.id === x))) refuse(404, 'stop_not_found', 'That is not the list of stops in the plan.')
    const loaded = loadedOf(session)
    const version = await apply(id, loaded, async () => {
      // The key on the order is checked at the end of a statement, one stop at a time here: out of the way first.
      for (const x of all) await write({ kind: 'update', table: 'stops', values: { seq: x.seq + 100 }, filters: [eq('id', x.id)] })
      for (const [seq, stopId] of ids.entries()) await write({ kind: 'update', table: 'stops', values: { seq, travel_mode: null }, filters: [eq('id', stopId)] })
      await clearOrderNote(id)
    }, () => ({ order_reason: null, order_source: null }))
    return { status: 200, body: { planVersion: version } }
  }

  // ── ASSUMED: change a stop's place ──
  // The slot a stop is ranked as: its category (or the one asked for), at the time asked for (or its own start).
  // How to call: slotFor(stop, 'drink', 900) -> { id, category, start_minute, duration_minutes }
  const slotFor = (stop, category, start) => ({ id: stop.slot_id ?? stop.id, category: category || stop.category, start_minute: Number.isFinite(start) ? start : stop.not_before_minute ?? stop.planned_start_minute, duration_minutes: stop.duration_minutes })
  routes.stopSwap = async (user, id, body, { stop: stopId }) => {
    const { session } = load(user, id)
    confirmedOnly(session)
    const stop = stopNamed(id, stopId)
    const slot = slotFor(stop)
    const ranked = rank({ ...session, date: session.date }, slot, [stop.venue_id], session.radius_meters)
    // The stand-in ranking offers no indoor swap; a test says what it should offer for a place (`server.plan.swap`).
    const swap = server.plan.swap?.(stop.venue_id) ?? ranked.find((r) => r.venueId === stop.venue_id)?.swap
    return { status: 200, body: { swap: swap ? { venueId: swap.venueId, name: swap.name } : null } }
  }
  routes.stopChoices = async (user, id, body, { stop: stopId, query }) => {
    const { session } = load(user, id)
    asHost(session, user)
    confirmedOnly(session)
    const stop = stopNamed(id, stopId)
    const category = query?.category || stop.category
    if (!['eat', 'drink', 'shop', 'activity'].includes(category)) refuse(400, 'invalid_input', 'Choose Eat, Drink, Shop or Activity.')
    const slot = slotFor(stop, category, Number(query?.start))
    // Not the stop's own place, nor a place another stop already has.
    const inPlan = new Set(stopsOf(id).map((x) => x.venue_id))
    const same = slotsOf(id).find((x) => x.category === category)
    const votes = same ? rows('votes').filter((v) => v.slot_id === same.id) : []
    const ranked = rank(session, slot, same ? optionsOf(same.id).map((o) => o.venue_id) : [], session.radius_meters)
      .filter((r) => !inPlan.has(r.venueId))
    return {
      status: 200,
      body: {
        category,
        options: ranked.map((r, i) => ({ venueId: r.venueId, rank: i + 1, score: r.score, votes: votes.filter((v) => v.venue_id === r.venueId).length, details: { walkMinutes: r.walkMinutes, reasons: r.reasons, warnings: r.warnings, swap: null, explanation: r.explanation, approximate: r.approximate } })),
      },
    }
  }
  routes.stopPlace = async (user, id, body, { stop: stopId }) => {
    const { session } = load(user, id)
    asHost(session, user)
    confirmedOnly(session)
    const stop = stopNamed(id, stopId)
    const category = body.category || stop.category
    if (stop.venue_id === body.venueId && stop.category === category) return { status: 200, body: { planVersion: session.plan_version } }
    if (stop.venue_id !== body.fromVenueId) refuse(409, 'stop_changed', 'That stop has changed.')
    if (!VENUES.some((v) => v.id === body.venueId)) refuse(404, 'venue_not_found', 'That place could not be found.')
    if (stopsOf(id).some((x) => x.id !== stop.id && x.venue_id === body.venueId)) refuse(409, 'already_a_stop', 'That place is already in the plan.')
    const start = Number.isFinite(body.start) ? body.start : stop.not_before_minute ?? stop.planned_start_minute
    if (!rank(session, slotFor(stop, category, start), [body.venueId], session.radius_meters).some((r) => r.venueId === body.venueId)) refuse(422, 'venue_does_not_fit', 'That place does not fit this stop.')
    const all = stopsOf(id)
    const index = all.indexOf(stop)
    const loaded = loadedOf(session)
    await after.stopPlace?.(id)
    const version = await apply(id, loaded, async () => {
      // The stop never starts earlier than the time it was checked for; the legs to and from it go back to their default modes.
      await write({ kind: 'update', table: 'stops', values: { venue_id: body.venueId, category, not_before_minute: Math.min(1439, Math.max(stop.not_before_minute ?? 0, start)), travel_mode: null }, filters: [eq('id', stop.id)] })
      if (all[index + 1]) await write({ kind: 'update', table: 'stops', values: { travel_mode: null }, filters: [eq('id', all[index + 1].id)] })
    }, () => ({ order_reason: null, order_source: null }))
    return { status: 200, body: { planVersion: version } }
  }

  // ── E16, E23, E24: Roam ──
  routes.roam = async (user, id, body) => {
    const { session } = load(user, id)
    confirmedOnly(session)
    const centre = body.current ? { lat: body.current.lat, lng: body.current.lng } : areaOf(session.meeting_area_id)
    const categories = body.categories?.length ? body.categories : ['eat', 'drink', 'activity']
    const stops = stopsOf(id)
    const last = stops.at(-1)
    const start = last ? Math.min(1439, (last.not_before_minute ?? last.planned_start_minute) + last.duration_minutes) : 720
    const answer = standInConverge({ categories, centre, dateTime: stamp(session, start), durationMinutes: PROPOSED_MINUTES, topN: 10 })
    const waiting = rows('stop_proposals').filter((x) => x.session_id === id && x.status === 'pending')
    return {
      status: 200,
      body: {
        status: 'ok',
        results: answer.results.map((r) => ({
          ...r,
          travelMinutes: Math.max(1, Math.round(distanceKm(centre, VENUES.find((v) => v.id === r.venueId)) * 4)),
          distanceKm: Math.round(distanceKm(centre, VENUES.find((v) => v.id === r.venueId)) * 100) / 100,
          isStop: stops.some((x) => x.venue_id === r.venueId),
          proposedBy: waiting.find((p) => p.venue_id === r.venueId)?.proposed_by ?? null,
        })),
        notice: null,
        weather: { source: 'live', basis: 'area', issuedAt: '2026-10-09T10:00:00+08:00' },
      },
    }
  }
  routes.propose = async (user, id, body) => {
    const { session } = load(user, id)
    confirmedOnly(session)
    if (typeof body.venueId !== 'string' || !body.venueId || body.venueId.length > 160) refuse(400, 'invalid_input', 'Send a place id.')
    if (!VENUES.some((v) => v.id === body.venueId)) refuse(404, 'venue_not_found', 'That place could not be found.')
    const stops = stopsOf(id)
    if (stops.some((x) => x.venue_id === body.venueId)) refuse(409, 'already_a_stop', 'That place is already in the plan.')
    const waiting = rows('stop_proposals').filter((x) => x.session_id === id && x.status === 'pending')
    const same = waiting.find((x) => x.venue_id === body.venueId)
    if (same) return { status: 200, body: { id: same.id } }
    if (stops.length >= PLAN_MAX) refuse(409, 'plan_full', 'The plan has 8 stops, the most it can hold.')
    if (waiting.length >= PROPOSALS_PER_SESSION || waiting.filter((x) => x.proposed_by === user).length >= PROPOSALS_PER_MEMBER) refuse(409, 'too_many_proposals', 'Too many places are waiting.')
    const loaded = loadedOf(session)
    let made
    await apply(id, loaded, async () => {
      const row = await write({ kind: 'insert', table: 'stop_proposals', values: { session_id: id, venue_id: body.venueId, proposed_by: user }, returning: true, columns: 'id' })
      if (row.error) throw new Error(`The stand-in server could not write a proposal: ${row.error.message}`)
      made = row.data[0].id
    }, () => ({}))
    return { status: 201, body: { id: made } }
  }
  routes.resolve = async (user, id, body, { proposal: proposalId }) => {
    const { session } = load(user, id)
    confirmedOnly(session)
    const proposal = rows('stop_proposals').find((x) => x.id === proposalId && x.session_id === id)
    if (!proposal) refuse(404, 'proposal_not_found', 'That proposal is not there.')
    const accept = !!body.accept
    if (accept && session.host_id !== user) refuse(403, 'host_only', 'Only the host can add a place to the plan.')
    if (!accept && session.host_id !== user && proposal.proposed_by !== user) refuse(403, 'host_only', 'Only the host, or the person who proposed it, can dismiss it.')
    if (proposal.status !== 'pending') return { status: 200, body: { planVersion: session.plan_version, status: session.status } }
    const stops = stopsOf(id)
    if (accept && !stops.some((x) => x.venue_id === proposal.venue_id) && stops.length >= PLAN_MAX) refuse(409, 'plan_full', 'The plan has 8 stops, the most it can hold.')
    const loaded = loadedOf(session)
    await after.resolve?.(id)
    const venue = VENUES.find((v) => v.id === proposal.venue_id)
    const version = await apply(id, loaded, async () => {
      if (accept && !stops.some((x) => x.venue_id === proposal.venue_id)) {
        // Appended: the next place in the order, no slot, the place's own category, starting when the last stop ends, for an hour.
        const last = stops.at(-1)
        const start = last ? Math.min(1439, (last.not_before_minute ?? last.planned_start_minute) + last.duration_minutes) : 720
        const made = await write({ kind: 'insert', table: 'stops', values: { session_id: id, seq: stops.length, slot_id: null, category: venue.category, venue_id: proposal.venue_id, planned_start_minute: start, duration_minutes: PROPOSED_MINUTES, not_before_minute: start } })
        if (made.error) throw new Error(`The stand-in server could not write a stop: ${made.error.message}`)
        // The note was about the order the stops had.
      }
      await write({ kind: 'update', table: 'stop_proposals', values: { status: accept ? 'accepted' : 'dismissed', resolved_at: new Date().toISOString(), resolved_by: user }, filters: [eq('id', proposal.id)] })
    }, () => (accept ? { order_reason: null, order_source: null } : {}))
    return { status: 200, body: { planVersion: version, status: 'confirmed' } }
  }

  // The weather at a plan's stops (POST /api/weather/stops, not a session route: the plan's screens ask it for the stops' places and times).
  // Dry unless a test says `server.plan.weather = 'showers'`.
  routes.weatherStops = async (user, id, body) => {
    const state = server.plan.weather || 'dry'
    const at = '2026-10-10T12:00:00+08:00'
    return {
      status: 200,
      body: {
        stops: (body.stops || []).map((s) => ({ id: s.id, state, rainLikely: state !== 'dry', phrase: null, basis: 'area', issuedAt: at, validUntil: '2026-10-10T14:00:00+08:00' })),
        weather: { source: 'live', basis: 'area', issuedAt: at },
      },
    }
  }

  // ASSUMED: opting out of a confirmed plan asks "Re-plan?" instead of being refused (design E10: "in confirmed only `sessions.replan`").
  const stageFourOptOut = routes.optOut
  routes.optOut = async (user, id, ...rest) => {
    const { session, member } = load(user, id, { joined: false })
    if (!(server.plan.confirmedOptOut && session.status === 'confirmed' && member.role !== 'host')) return stageFourOptOut(user, id, ...rest)
    if (member.state === 'opted_out') return { status: 200, body: { planVersion: session.plan_version, state: 'opted_out' } }
    const loaded = loadedOf(session)
    const name = kit.nameOf?.(user) ?? 'Someone'
    const version = await apply(id, loaded, async () => {
      await write({ kind: 'update', table: 'session_members', values: { state: 'opted_out' }, filters: [eq('session_id', id), eq('user_id', user)] })
      for (const slot of slotsOf(id)) await write({ kind: 'delete', table: 'votes', filters: [eq('slot_id', slot.id), eq('user_id', user)] })
      for (const proposal of rows('stop_proposals').filter((x) => x.session_id === id && x.proposed_by === user && x.status === 'pending')) {
        await write({ kind: 'delete', table: 'stop_proposals', filters: [eq('id', proposal.id)] })
      }
    }, () => ({ replan: { reason: `${name} opted out.`, trigger: { kind: 'optout' }, at: Date.now() } }))
    return { status: 200, body: { planVersion: version, state: 'opted_out' } }
  }

  // The paths. A stop's order route is matched before a stop's own id.
  PATTERNS.push(
    ['POST', /^\/order\/suggest$/, 'suggestOrder'],
    ['POST', /^\/confirm$/, 'confirmPlan'],
    ['POST', /^\/replan$/, 'replan'],
    ['POST', /^\/complete$/, 'complete'],
    ['PUT', /^\/stops\/order$/, 'stopOrder'],
    ['PATCH', /^\/stops\/([^/]+)$/, 'patchStop', ['stop']],
    ['DELETE', /^\/stops\/([^/]+)$/, 'deleteStop', ['stop']],
    ['GET', /^\/stops\/([^/]+)\/swap$/, 'stopSwap', ['stop']],
    ['GET', /^\/stops\/([^/]+)\/choices$/, 'stopChoices', ['stop']],
    ['PUT', /^\/stops\/([^/]+)\/place$/, 'stopPlace', ['stop']],
    ['POST', /^\/roam$/, 'roam'],
    ['POST', /^\/proposals$/, 'propose'],
    ['POST', /^\/proposals\/([^/]+)\/resolve$/, 'resolve', ['proposal']],
  )
  server.plan.routeOutsideSessions = (method, path) => (method === 'POST' && path === '/api/weather/stops' ? { name: 'weatherStops', id: null } : null)
  // Keep the helper that the tests use to read a place the way the server sends it.
  server.plan.venue = (id) => asBackendVenue(VENUES.find((v) => v.id === id))
  server.plan.tripMinutes = tripMinutes
  void AREAS
}
