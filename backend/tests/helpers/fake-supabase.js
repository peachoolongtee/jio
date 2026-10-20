import { generateKeyPairSync, sign } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

// A stand-in for Supabase, for the session tests. Nothing here touches the network.
//
// The database is a `world` of arrays, one per table. Two kinds of client read it:
//   - a user's client (`forUser`) sees only what the access rules in db/policies.sql let that person see, and can write only
//     what a browser may write directly: "Works for me" (spot_approvals), a member's own start and end area, their own exact place;
//   - the service client (`service`) sees everything, is the only one that may call apply_session_plan, and records every request.
// `applySessionPlan` below is a JavaScript twin of the SQL function in db/migrations/20261020000000_jio_apply_session_plan.sql.
// It is a second implementation of the same rules, so the real function must still be tested on the live project
// (db/tests/apply_session_plan.sql); the point of the twin is that the server's code can be tested offline.
//
// How to use it:
//   const world = createWorld()
//   const supabase = fakeSupabase(world)            // { service, forUser, verifyToken } as createSupabase() gives
//   await supabase.service.rpc('apply_session_plan', { sid, expected_version: 0, expected_status: 'locating', patch })

export const SUPABASE_URL = 'https://project.supabase.test'

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
export const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'ES256', use: 'sig', key_ops: ['verify'] }

// A login token for a person, signed the way Supabase Auth does.
//
// How to call:
//   tokenFor('1111111a-1111-4111-8111-11111111111b')
export function tokenFor(id) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'ES256', typ: 'JWT', kid: 'key-1' })
  const body = b64({ iss: `${SUPABASE_URL}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: id, email: 'x@example.test', iat: now, exp: now + 3600 })
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

// The fetch function that serves the public signing key the way Supabase does, so the login check is the real code.
//
// How to call:
//   createSupabase({ url: SUPABASE_URL, anonKey: 'a', serviceKey: 's', fetchImpl: jwksFetch })
export async function jwksFetch(input) {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (url.pathname === '/auth/v1/.well-known/jwks.json') {
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response('{}', { status: 404 })
}

const TABLES = ['sessions', 'session_members', 'session_spots', 'spot_suggestions', 'spot_approvals', 'slots', 'profiles', 'session_member_places']

// An empty database. `calls` records every request: { table | rpc, kind, who } with who = the user id, or null for the service key.
// Fields a test may set:
//   hooks.beforeApply   (args) => void, run inside apply_session_plan before it looks at the session: to play another writer
//   staleApply          a number: that many calls answer null (the session "moved on") without writing
//   failApply           true: apply_session_plan fails as a database error
//   hangApply           true: apply_session_plan never answers (a database that hung)
//   hangReads           true: the service key's reads never answer
//   hooks.beforeRead    ({ table }) => void, run before each read by the service key: to play a request that arrives while a run loads
//
// How to call:
//   const world = createWorld()
export function createWorld() {
  const world = { calls: [], hooks: {}, staleApply: 0, failApply: false, hangApply: false, hangReads: false, t: Date.parse('2026-10-20T08:00:00Z') }
  for (const table of TABLES) world[table] = []
  return world
}

// The next moment, one millisecond on from the last, as the timestamp Postgres would write.
//
// How to call:
//   created_at: tick(world)
export function tick(world) {
  world.t += 1
  return new Date(world.t).toISOString()
}

// A database error in the shape supabase-js hands back. How to call: throw dbError('P0001', 'The meeting area is pinned.', 'area_pinned')
const dbError = (code, message, hint) => ({ code, message, ...(hint && { hint }) })

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Are two values equal as the database sees them? A uuid is equal to the same uuid in any case, as Postgres compares them.
//
// How to call:
//   sameValue('AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') // true
const sameValue = (a, b) => a === b || (typeof a === 'string' && typeof b === 'string' && UUID_ANY.test(a) && UUID_ANY.test(b) && a.toLowerCase() === b.toLowerCase())

// The database's own checks on a row of session_spots (db/schema.sql), so a row the server should never write is caught here.
//
// How to call:
//   checkSpot({ area_id: 'bishan', rank: 1, worst_minutes: 30, mean_minutes: 25, travel_minutes: {} })
function checkSpot(row) {
  const bad = (why) => {
    throw dbError('23514', `session_spots check failed: ${why}`)
  }
  if (typeof row.area_id !== 'string' || row.area_id.length < 1 || row.area_id.length > 60) bad('area_id')
  if (row.rank !== null && row.rank !== undefined && ![1, 2, 3].includes(row.rank)) bad('rank')
  for (const key of ['worst_minutes', 'mean_minutes']) if (!(typeof row[key] === 'number' && row[key] >= 0 && row[key] <= 1440)) bad(key)
  if (row.mean_minutes > row.worst_minutes + 0.001) bad('mean_minutes above worst_minutes')
  const minutes = row.travel_minutes
  if (minutes === null || typeof minutes !== 'object' || Array.isArray(minutes)) bad('travel_minutes is not an object')
  for (const [id, value] of Object.entries(minutes)) {
    if (!UUID_LOWER.test(id)) bad(`travel_minutes key ${id}`)
    if (!(typeof value === 'number' && value >= 0 && value <= 1440)) bad(`travel_minutes value for ${id}`)
  }
}

// A JavaScript twin of apply_session_plan(sid, expected_version, expected_status, patch). Returns the new version, null when the
// session moved on, or the current version when nothing changed. Throws a database error object for the rules and the checks.
//
// How to call:
//   const version = applySessionPlan(world, { sid, expected_version: 4, expected_status: 'locating', patch: { ops: [], spots: [] } })
export function applySessionPlan(world, { sid, expected_version: expectedVersion, expected_status: expectedStatus, patch }) {
  world.hooks.beforeApply?.({ sid, expectedVersion, expectedStatus, patch })
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw dbError('22023', 'The plan must be a JSON object.')
  const session = world.sessions.find((s) => sameValue(s.id, sid))
  if (world.staleApply > 0) {
    world.staleApply -= 1
    return null
  }
  if (!session || Number(session.plan_version) !== Number(expectedVersion) || session.status !== expectedStatus) return null

  // Everything below is undone if a rule or a check fails, as a transaction would be.
  const snapshot = structuredClone({ sessions: world.sessions, session_members: world.session_members, session_member_places: world.session_member_places, session_spots: world.session_spots, spot_suggestions: world.spot_suggestions, spot_approvals: world.spot_approvals })
  try {
    return apply(world, session, patch)
  } catch (err) {
    for (const [name, rows] of Object.entries(snapshot)) world[name] = rows
    throw err
  }
}

// A figure rounded the way the database writes it into an integer column, or null when there is none.
//
// How to call:
//   roundOrNull(10.4) // 10
const roundOrNull = (value) => (value === undefined || value === null ? null : Math.round(Number(value)))

// The body of the twin, run on a session already locked and found current. It enforces the same rules in the same order as the SQL:
// a pinned meeting stays; a status moves only from inviting or locating to voting with an area; a pin comes only with that move (or
// when the same pin is stored); the host is never opted out or removed; leaving inviting needs two joined members after the ops;
// and the version rises only when a value differs from the stored row.
//
// How to call (applySessionPlan does this):
//   const version = apply(world, session, patch)
function apply(world, session, patch) {
  const sid = session.id
  const sp = patch.session ?? {}
  const meeting = sp.meeting
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
  let changed = false
  // When the server loaded the members the spots are worked out from; absent, the moment of the write.
  const loadedAt = patch.loaded_at ? new Date(patch.loaded_at) : null
  if (loadedAt && Number.isNaN(loadedAt.getTime())) throw dbError('22007', `invalid input syntax for type timestamp with time zone: "${patch.loaded_at}"`)
  // Never later than the database's clock, as least(loaded_at, now()) in the SQL.
  const stamp = () => { const now = tick(world); return loadedAt && loadedAt.toISOString() < now ? loadedAt.toISOString() : now }
  const newStatus = sp.status ?? session.status
  const moving = newStatus !== session.status

  // Rule 4: a pinned meeting area stays.
  if (has(sp, 'meeting') && ['voted', 'chosen'].includes(session.meeting_method) && ((meeting?.area_id ?? null) !== session.meeting_area_id || (meeting?.method ?? null) !== session.meeting_method)) {
    throw dbError('P0001', 'The meeting area was chosen and cannot be changed by a recompute.', 'area_pinned')
  }
  // Rule 1: the only move is inviting or locating to voting, with an area.
  if (moving) {
    if (!(['inviting', 'locating'].includes(session.status) && newStatus === 'voting') || !meeting?.area_id) {
      throw dbError('P0001', `A session cannot go from ${session.status} to ${newStatus} this way.`, 'status_transition')
    }
    changed = true
  }
  // Rule 5: a pin only with a confirm: the move to voting in this patch, or the same pin already stored.
  if (['voted', 'chosen'].includes(meeting?.method) && !moving && !(session.meeting_method === meeting.method && (session.meeting_area_id ?? null) === (meeting.area_id ?? null))) {
    throw dbError('P0001', 'A meeting area is pinned only when the host confirms it.', 'pin_without_confirm')
  }

  const dropApprovals = (test) => {
    const before = world.spot_approvals.length
    world.spot_approvals = world.spot_approvals.filter((a) => !(a.session_id === sid && test(a)))
    return before !== world.spot_approvals.length
  }
  const dropSuggestions = (test) => {
    const before = world.spot_suggestions.length
    world.spot_suggestions = world.spot_suggestions.filter((g) => !(g.session_id === sid && test(g)))
    return before !== world.spot_suggestions.length
  }

  for (const op of patch.ops ?? []) {
    const user = op.user_id
    const member = world.session_members.find((m) => m.session_id === sid && m.user_id === user)
    // Rule 6: the host is never opted out or removed here.
    if ((op.op === 'opt_out' || op.op === 'remove_member') && sameValue(user, session.host_id)) {
      throw dbError('P0001', op.op === 'opt_out' ? 'The host cannot opt out.' : 'The host cannot be removed.', 'host_member')
    }
    if (op.op === 'opt_out') {
      if (member?.state === 'joined') {
        member.state = 'opted_out'
        changed = true
      }
      changed = dropApprovals((a) => a.user_id === user) || changed
      changed = dropSuggestions((g) => g.user_id === user) || changed
    } else if (op.op === 'rejoin') {
      if (member?.state === 'opted_out') {
        member.state = 'joined'
        changed = true
      }
    } else if (op.op === 'remove_member') {
      if (member) {
        world.session_members = world.session_members.filter((m) => m !== member)
        world.session_member_places = world.session_member_places.filter((p) => !(p.session_id === sid && p.user_id === user))
        dropApprovals((a) => a.user_id === user)
        dropSuggestions((g) => g.user_id === user)
        changed = true
      }
    } else if (op.op === 'suggest') {
      if (!member) throw dbError('23503', 'spot_suggestions: the member is not in the session')
      const here = op.here ?? false
      const existing = world.spot_suggestions.find((g) => g.session_id === sid && g.user_id === user)
      if (!existing) {
        world.spot_suggestions.push({ session_id: sid, user_id: user, area_id: op.area_id, here, created_at: tick(world) })
        changed = true
      } else if (existing.area_id !== op.area_id || existing.here !== here) {
        Object.assign(existing, { area_id: op.area_id, here, created_at: tick(world) })
        changed = true
      }
    } else if (op.op === 'unsuggest') {
      changed = dropSuggestions((g) => g.user_id === user) || changed
    } else if (op.op === 'clear_approvals') {
      changed = dropApprovals(() => true) || changed
    } else if (op.op === 'clear_suggestions') {
      changed = dropSuggestions(() => true) || changed
    } else {
      throw dbError('22023', `Unknown operation ${op.op}.`)
    }
  }

  // Rule 2: leaving inviting needs two joined members, counted after the ops.
  if (session.status === 'inviting' && moving && world.session_members.filter((m) => m.session_id === sid && m.state === 'joined').length < 2) {
    throw dbError('P0001', 'A session needs at least two people before it can start.', 'needs_two_people')
  }

  let bannerText = null
  if (has(patch, 'spots')) {
    if (!Array.isArray(patch.spots)) throw dbError('22023', 'The spots must be a JSON list.')
    const listed = new Set(patch.spots.map((r) => r.area_id))
    const lostApprovals = world.spot_approvals.some((a) => a.session_id === sid && !listed.has(a.area_id))
    const goneSpots = world.session_spots.filter((x) => x.session_id === sid && !listed.has(x.area_id))
    if (goneSpots.length > 0) {
      world.session_spots = world.session_spots.filter((x) => !goneSpots.includes(x))
      world.spot_approvals = world.spot_approvals.filter((a) => !(a.session_id === sid && !listed.has(a.area_id)))
      changed = true
    }
    for (const row of patch.spots) {
      const next = {
        session_id: sid,
        area_id: row.area_id,
        rank: row.rank ?? null,
        worst_minutes: Number(row.worst_minutes),
        mean_minutes: Number(row.mean_minutes),
        travel_minutes: row.travel_minutes ?? {},
        approximate: row.approximate ?? false,
      }
      checkSpot(next)
      const existing = world.session_spots.find((x) => x.session_id === sid && x.area_id === row.area_id)
      if (!existing) {
        world.session_spots.push({ ...next, computed_at: stamp() })
        changed = true
      } else {
        const same = ['rank', 'worst_minutes', 'mean_minutes', 'approximate'].every((k) => existing[k] === next[k]) && JSON.stringify(existing.travel_minutes) === JSON.stringify(next.travel_minutes)
        if (!same) {
          Object.assign(existing, next, { computed_at: stamp() })
          changed = true
        }
      }
    }
    // The ranks are unique in a session (checked at the end of the transaction).
    const ranks = world.session_spots.filter((x) => x.session_id === sid && x.rank !== null).map((x) => x.rank)
    if (new Set(ranks).size !== ranks.length) throw dbError('23505', 'session_spots: two spots with one rank')
    // A run that worked the spots out with the planner brings the time of working out forward on the spots that are older than
    // when its inputs were loaded, but that is not a change.
    if (patch.recomputed === true) {
      const at = stamp()
      for (const x of world.session_spots.filter((row) => row.session_id === sid && Date.parse(row.computed_at) < Date.parse(at))) x.computed_at = at
    }
    if (lostApprovals) bannerText = patch.banner_text || 'Some spots are no longer on the list, so approvals for them were removed.'
  }

  // Rule 3: the session section is a change only where a value differs from the stored row (the meeting as it would be written).
  const nextMeeting = [meeting?.area_id ?? null, meeting?.method ?? null, roundOrNull(meeting?.max_minutes), roundOrNull(meeting?.total_minutes), roundOrNull(meeting?.count), meeting?.approximate ?? null]
  const storedMeeting = [session.meeting_area_id, session.meeting_method, session.meeting_max_minutes, session.meeting_total_minutes, session.meeting_count, session.meeting_approximate].map((v) => v ?? null)
  const meetingChanged = has(sp, 'meeting') && !isDeepStrictEqual(storedMeeting, nextMeeting)
  const bannerChanged = has(sp, 'banner') && !isDeepStrictEqual(session.banner ?? null, sp.banner ?? null)
  if (meetingChanged || bannerChanged || bannerText !== null) changed = true
  if (!changed) return Number(session.plan_version)

  if (has(sp, 'meeting') && meeting && typeof meeting === 'object' && meeting.travel) {
    for (const m of world.session_members.filter((row) => row.session_id === sid && row.state === 'joined')) {
      m.travel_minutes = has(meeting.travel, m.user_id) ? Math.round(meeting.travel[m.user_id]) : null
    }
  }
  session.status = newStatus
  if (meetingChanged) {
    session.meeting_area_id = meeting?.area_id ?? null
    session.meeting_method = meeting?.method ?? null
    session.meeting_max_minutes = nextMeeting[2]
    session.meeting_total_minutes = nextMeeting[3]
    session.meeting_count = nextMeeting[4]
    session.meeting_approximate = nextMeeting[5]
    session.meeting_computed_at = meeting?.area_id ? tick(world) : null
  }
  if (bannerText !== null) session.banner = { text: bannerText, at: world.t, approvalsRemoved: true }
  else if (bannerChanged) session.banner = sp.banner ?? null
  session.plan_version = Number(session.plan_version) + 1
  return session.plan_version
}

// Is this person in the session, joined or not? How to call: isMember(world, GUEST, SESSION)
const isMember = (world, who, sessionId) => world.session_members.some((m) => m.session_id === sessionId && m.user_id === who)
// Do the access rules show this row to this person? `who` is a lower-case user id, or null for the service key (which sees
// everything). How to call: canSee(world, 'session_spots', row, GUEST)
function canSee(world, table, row, who) {
  if (who === null) return true
  if (table === 'sessions') return row.host_id === who || isMember(world, who, row.id)
  if (table === 'profiles') return true
  if (table === 'session_member_places') return row.user_id === who
  return isMember(world, who, row.session_id)
}

// A query over one table, in the shape of supabase-js's builder (select, eq, in, maybeSingle, insert, update, delete, upsert).
// Reads show the person only what the rules show. A write by a person is allowed only where a browser may write; a write by the
// service key is allowed anywhere.
//
// How to call (through the client):
//   const { data, error } = await client.from('session_spots').select('area_id').eq('session_id', id)
function query(world, table, who) {
  const op = { kind: 'select', filters: [], rows: null, patch: null, returning: false, single: false, upsert: false }
  const matches = (row) => canSee(world, table, row, who) && op.filters.every(([column, test]) => test(row[column]))
  const log = () => world.calls.push({ table, kind: op.kind, who, filters: op.filters.map(([c]) => c) })

  // What a browser may write, by the rules in db/policies.sql. Returns an error object, or null when it is allowed.
  const refuseWrite = (row, kind) => {
    if (who === null) return null
    const session = world.sessions.find((s) => s.id === (row.session_id ?? row.id))
    const mine = world.session_members.find((m) => m.session_id === session?.id && m.user_id === who)
    const denied = dbError('42501', `new row violates row-level security policy for table "${table}"`)
    if (table === 'spot_approvals') {
      if (row.user_id !== who && kind !== 'delete') return denied
      if (kind === 'delete' && row.user_id !== who) return denied
      if (!(mine?.state === 'joined' && session?.status === 'locating')) return denied
      if (kind === 'insert' && !world.session_spots.some((s) => s.session_id === row.session_id && s.area_id === row.area_id)) return dbError('23503', 'spot_approvals: the spot is not listed')
      return null
    }
    if (table === 'session_members' && kind === 'update') {
      return mine?.state === 'joined' && ['inviting', 'locating', 'voting'].includes(session?.status) && row.user_id === who ? null : denied
    }
    if (table === 'session_member_places') {
      return row.user_id === who && mine?.state === 'joined' && ['inviting', 'locating', 'voting'].includes(session?.status) ? null : denied
    }
    return dbError('42501', `permission denied for table ${table}`)
  }

  const run = () => {
    log()
    if (who === null && op.kind === 'select') {
      world.hooks.beforeRead?.({ table })
      // A database that hung: the service key's reads never answer.
      if (world.hangReads) return new Promise(() => {})
    }
    const rows = world[table]
    if (op.kind === 'select') {
      const found = rows.filter(matches)
      return op.single ? { data: found[0] ? { ...found[0] } : null, error: null } : { data: found.map((r) => ({ ...r })), error: null }
    }
    try {
      if (op.kind === 'insert') {
        const added = []
        for (const row of op.rows) {
          const denied = refuseWrite(row, 'insert')
          if (denied) return { data: null, error: denied }
          const key = (r) => (table === 'spot_approvals' ? [r.session_id, r.area_id, r.user_id] : [r.session_id, r.user_id]).join('|')
          const dup = rows.find((r) => key(r) === key(row))
          if (dup && !op.upsert) return { data: null, error: dbError('23505', `duplicate key in ${table}`) }
          if (dup) Object.assign(dup, row)
          else rows.push({ created_at: tick(world), ...row })
          added.push(row)
        }
        return { data: op.returning ? added : null, error: null }
      }
      const found = rows.filter(matches)
      if (op.kind === 'update') {
        for (const row of found) {
          const denied = refuseWrite(row, 'update')
          if (denied) return { data: null, error: denied }
        }
        for (const row of found) Object.assign(row, op.patch)
        return { data: op.returning ? found.map((r) => ({ ...r })) : null, error: null }
      }
      if (op.kind === 'delete') {
        for (const row of found) {
          const denied = refuseWrite(row, 'delete')
          if (denied) return { data: null, error: denied }
        }
        world[table] = rows.filter((r) => !found.includes(r))
        if (table === 'spot_approvals') return { data: op.returning ? found : null, error: null }
        return { data: op.returning ? found : null, error: null }
      }
    } catch (err) {
      return { data: null, error: err }
    }
    return { data: null, error: { code: 'XX000', message: 'unsupported' } }
  }

  const builder = {
    select() {
      if (op.kind !== 'select') op.returning = true
      return builder
    },
    insert(rows) {
      op.kind = 'insert'
      op.rows = Array.isArray(rows) ? rows : [rows]
      return builder
    },
    upsert(rows) {
      op.kind = 'insert'
      op.upsert = true
      op.rows = Array.isArray(rows) ? rows : [rows]
      return builder
    },
    update(patch) {
      op.kind = 'update'
      op.patch = patch
      return builder
    },
    delete() {
      op.kind = 'delete'
      return builder
    },
    eq(column, value) {
      op.filters.push([column, (v) => sameValue(v, value)])
      return builder
    },
    in(column, values) {
      op.filters.push([column, (v) => values.some((candidate) => sameValue(v, candidate))])
      return builder
    },
    maybeSingle() {
      op.single = true
      return builder
    },
    then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
  }
  return builder
}

// One client over the world. `who` is a lower-case user id, or null for the service key.
//
// How to call:
//   const client = clientOver(world, null)
function clientOver(world, who) {
  return {
    from: (table) => {
      if (!TABLES.includes(table)) throw new Error(`the fake has no table ${table}`)
      return query(world, table, who)
    },
    async rpc(name, args) {
      world.calls.push({ rpc: name, kind: 'rpc', who })
      if (name !== 'apply_session_plan') return { data: null, error: dbError('42883', `no function ${name}`) }
      if (who !== null) return { data: null, error: dbError('42501', 'permission denied for function apply_session_plan') }
      if (world.hangApply) return new Promise(() => {})
      if (world.failApply) return { data: null, error: dbError('XX000', 'boom') }
      try {
        return { data: applySessionPlan(world, args), error: null }
      } catch (err) {
        return { data: null, error: err }
      }
    },
  }
}

// What createSupabase() gives the server, over a world: the real login check (it verifies tokens signed by tokenFor), and fake
// clients. Pass `real` (a createSupabase() result built with fetchImpl: jwksFetch) to take its verifyToken.
//
// How to call:
//   const real = createSupabase({ url: SUPABASE_URL, anonKey: 'anon', serviceKey: 'service', fetchImpl: jwksFetch })
//   const supabase = fakeSupabase(world, real)
export function fakeSupabase(world, real) {
  return {
    ...real,
    service: clientOver(world, null),
    // The token's subject, in lower case: Postgres compares uuids without regard to case, and so does the fake.
    forUser: (token) => clientOver(world, JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub.toLowerCase()),
  }
}

// A client as the browser of one person, for the writes a browser makes directly ("Works for me", their own start and end area).
//
// How to call:
//   await userClient(world, GUEST).from('spot_approvals').insert({ session_id: SESSION, area_id: 'bugis', user_id: GUEST })
export const userClient = (world, id) => clientOver(world, id.toLowerCase())
