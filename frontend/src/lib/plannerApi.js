// The planner runs on the Jio backend (backend/src/planner). This file is the frontend's side of it:
// it sends the requests and turns the answers into the shapes the screens already read.
// Request and response details: backend/docs/planner-api.md.
//
// Every function takes plain values (members, points, a slot), not a session, so api.js stays the one
// place that knows how a session is stored.
import axios from 'axios'
import { ref } from 'vue'
import * as auth from './auth.js'
import { currentUserId } from './currentUser.js'
import { weatherFrom } from './weatherText.js'

// Calls to the Jio backend (planner, geocode and weather proxy).
// Each request carries the Supabase session token when there is one (see the interceptors below). The backend
// verifies it locally; a local account or a build without Supabase has none, and the requests go without.
// In development, leave VITE_API_BASE_URL blank: requests go to /api on the page's own address and the Vite dev
// server forwards them to the backend (see vite.config.js). Deployed, it is the backend's URL.
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '',
  timeout: 15000,
})

// What the login check's answers say, in words a person can act on.
const SESSION_ENDED = 'Your session has ended. Log in again.'
const LOGIN_NEEDED = 'The planner needs you to be logged in. Log in and try again.'
const AUTH_UNAVAILABLE = 'Jio cannot check your login right now. Try again in a moment.'

// The planner checks coordinates against Singapore's land (backend/src/planner/singapore.js), which is tighter than the box the
// browser checks (lib/planner/geo.js), so a place just over the border reaches the planner and comes back as a 400 whose issue
// points at a coordinate. This is the sentence for it, the same one a place the browser refuses gets.
const OUTSIDE_SINGAPORE = 'That place is outside Singapore. Pick an area instead.'

// Is this 400 answer a coordinate the planner will not take (a path ending in lat or lng, and a message about the range)?
// How to call: isOutsideSingapore({ error: 'invalid_input', issues: [{ path: 'current.lat', message: 'coordinates must be in Singapore' }] }) -> true
function isOutsideSingapore(data) {
  if (data?.error !== 'invalid_input' || !Array.isArray(data.issues)) return false
  return data.issues.some(
    (i) => /(^|\.)(lat|lng)$/.test(String(i?.path)) && /Singapore|^Number must be (greater|less) than/.test(String(i?.message)),
  )
}

// What a failed request says. Screens show err.message, so say what went wrong in words a person can act on.
// Developer text (commands, environment variable names, request details) is only for development builds;
// `dev` is a parameter so both wordings can be tested.
// Three failures are kept apart so the person knows what to do: the planner did not answer in time (a slow connection or
// a busy server: waiting and trying again is right), it could not be reached at all (check the connection), and it
// answered by refusing the request.
// How to call: plannerErrorMessage(err, { dev: false }) -> 'Too many requests. Wait a few seconds and try again.'
export function plannerErrorMessage(err, { dev = import.meta.env.DEV, baseURL = api.defaults.baseURL } = {}) {
  // The request was sent and no answer came before the client's deadline (axios reports ECONNABORTED, or ETIMEDOUT when it
  // is told to be exact). A request that was cancelled on purpose is not a timeout and falls through to the next case.
  if (!err?.response && (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT')) {
    const base = 'The Jio planner is taking too long to answer. Try again in a moment.'
    return dev && err.message ? `${base} (${err.message})` : base
  }
  // No answer at all: the backend is not running, or it refused this page's address (CORS allows one
  // origin, FRONTEND_ORIGIN). The browser reports both the same way, so name both in development.
  if (!err?.response) {
    if (!dev) return 'Cannot reach the Jio planner right now. Check your connection and try again.'
    // No base URL: the Vite dev server forwards /api to the backend, so only the backend can be missing.
    return baseURL
      ? `Cannot reach the Jio planner at ${baseURL}. Check the backend is running ("pnpm dev:backend") ` +
          `and that this page is open at the address it allows (FRONTEND_ORIGIN, by default http://localhost:5173).`
      : 'Cannot reach the Jio planner. Check the backend is running in another terminal ("pnpm dev:backend").'
  }
  const { status, data } = err.response
  if (status === 429) return 'Too many requests. Wait a few seconds and try again.'
  // The login check's two answers (backend/src/middleware/auth.js). A 401 reaches here only when it could not be fixed
  // by refreshing the token, which is a request that carried none.
  if (status === 503 && data?.error === 'auth_unavailable') return AUTH_UNAVAILABLE
  if (status === 401 && data?.error === 'unauthenticated') return LOGIN_NEEDED
  if (status === 400 && isOutsideSingapore(data)) return OUTSIDE_SINGAPORE
  const issues = data?.issues?.map((i) => `${i.path}: ${i.message}`).join('; ')
  if (issues) return dev ? `The planner could not use this request (${issues}).` : 'The planner could not use this request. Try again.'
  // A 404 message names the route, which is developer text.
  if (status === 404 && !dev) return 'The planner had a problem. Try again.'
  // A request the planner refused without saying why (a 400 or 422 with no message) is told apart from the planner failing.
  if ((status === 400 || status === 422) && !data?.message) return 'The planner could not use this request. Try again.'
  return data?.message || 'The planner had a problem. Try again.'
}

// A production build with no VITE_API_BASE_URL would send every request to the static host that serves the page, which
// answers with its HTML page. The request is refused with this sentence for the person; the developer text goes to the
// console once, because the check only runs outside development (in development an empty address means the Vite proxy).
const NO_BACKEND = 'The Jio planner is not available right now. Try again later.'
let toldDeveloper = false

// How to call: refuseWithoutBackend() (throws NO_BACKEND)
function refuseWithoutBackend() {
  if (!toldDeveloper) {
    toldDeveloper = true
    console.error('Jio: this build has no VITE_API_BASE_URL, so it has no backend to call. Set it to the backend URL (see frontend/.env.example) and build again.')
  }
  throw Object.assign(new Error(NO_BACKEND), { planner: true })
}

// What an answer that is not JSON says (usually the static host's HTML page, with status 200).
// How to call: notJsonMessage({ dev: false }) -> 'The planner sent an answer Jio could not read. Try again later.'
export function notJsonMessage({ dev = import.meta.env.DEV } = {}) {
  return dev
    ? 'The planner answered with something other than JSON. Check VITE_API_BASE_URL points at the backend, not the page itself.'
    : 'The planner sent an answer Jio could not read. Try again later.'
}

// Several requests that fail together share one refresh while it runs.
let refreshing = null

// Does this request go to the planner itself (a relative path, or an address on the planner's own origin)? Only such a
// request may carry the login token: an absolute address on another site must never get it.
// How to call: goesToPlanner({ baseURL: 'https://jio-api.example.com', url: '/api/converge' }) -> true
export function goesToPlanner(config) {
  const target = String(config?.url || '')
  // Relative paths are joined to the base address by axios. A protocol-relative address ("//host") is absolute.
  if (!/^([a-z][a-z\d+\-.]*:)?\/\//i.test(target)) return true
  const page = typeof location !== 'undefined' ? location.origin : 'http://localhost'
  try {
    const own = new URL(config.baseURL || page, page).origin
    return new URL(target, own).origin === own
  } catch {
    return false
  }
}

// Sign the person out after the planner refused their login, without letting a failure to do so escape: the error the
// caller sees is the "session has ended" sentence.
// How to call: await endSession()
async function endSession() {
  try {
    await auth.signOut()
  } catch {
    // The caller is told the session has ended whatever happened.
  }
}

// A token to retry a request with after the login check refused `sentToken`. If the session already holds a different
// token (another request's refresh finished since), that one is used and nothing is refreshed. Otherwise the session is
// refreshed (once for requests that fail together). Resolves null, after ending the session, when the refresh is refused.
// Rejects with the "try again" error when the refresh failed for a reason that may pass (no connection, a server error):
// the session is left as it is and the person stays signed in.
// How to call: const token = await renewedToken('token-1')
async function renewedToken(sentToken) {
  const current = await auth.accessToken()
  if (current && current !== sentToken) return current
  if (!refreshing) {
    refreshing = (async () => {
      const token = await auth.refreshedToken()
      if (!token) await endSession()
      return token
    })().finally(() => {
      refreshing = null
    })
  }
  return refreshing
}

// Before each request: stop when a production build has no backend to call, then attach the token read right now (to the
// planner only). A retry (see below) already holds its new token and keeps it.
api.interceptors.request.use(async (config) => {
  const absolute = /^https?:\/\//i.test(config.url || '')
  if (!config.baseURL && !absolute && !import.meta.env.DEV) {
    refuseWithoutBackend()
  }
  if (!config.jioRetried && goesToPlanner(config)) {
    const token = await auth.accessToken()
    if (token) config.headers.set('Authorization', `Bearer ${token}`)
  }
  return config
})

// A 401 from the login check on a request that carried a token: send it again once with the session's current token,
// refreshing first only if the request failed with the current one. A refresh that is refused, or a second 401, ends the
// Supabase session (lib/auth.js signOut, so api.js's listener signs the app out and the screens show the login). A
// refresh that failed for a reason that may pass (no connection, a server error) fails this request with a "try again"
// sentence and leaves the person signed in. It is called here, not api.js's signOut, because api.js imports this file.
api.interceptors.response.use(
  (res) => {
    // A string or nothing is not the planner (the static host's page, say). Reading it as "no places" would be wrong.
    if (res.data === null || typeof res.data !== 'object') throw new Error(notJsonMessage())
    return res
  },
  async (err) => {
    if (err?.planner) throw err
    const loginCheck = err?.response?.status === 401 && err.response.data?.error === 'unauthenticated'
    // A request with no token (a local account) is not retried and signs nobody out.
    if (loginCheck && err.config?.headers?.has?.('Authorization')) {
      if (!err.config.jioRetried) {
        const sent = String(err.config.headers.get('Authorization') || '').replace(/^Bearer /, '')
        let token
        try {
          token = await renewedToken(sent)
        } catch {
          throw new Error(AUTH_UNAVAILABLE)
        }
        if (token) {
          err.config.jioRetried = true
          err.config.headers.set('Authorization', `Bearer ${token}`)
          return api.request(err.config)
        }
      } else {
        await endSession()
      }
      throw new Error(SESSION_ENDED)
    }
    // The server's own code for a refusal (backend/src/routes/sessions.js sends one), so a caller can word it for the person.
    const code = err?.response?.data?.error
    // `clash` is the meetup in the way when the server refuses to put the person in two at once (schedule_clash).
    const clash = err?.response?.data?.clash
    throw Object.assign(
      new Error(plannerErrorMessage(err)),
      typeof code === 'string' ? { code, status: err.response.status } : {},
      code === 'schedule_clash' && clash && typeof clash === 'object' ? { clash } : {},
    )
  },
)

// ── Two things the ranking requests share: sample data that never routes, and one request for identical ones in flight ──

// How many sample-data builds are running right now. While one is, the meeting-area, converge and Roam requests carry
// `travel: 'estimate'`, which the backend answers from its own estimate without a single OneMap call (sample data does not need
// real routes, and routing it made loading the showcase take 14 seconds). A count, not a flag, so builds that overlap do not
// switch each other off.
let estimateBuilds = 0

// The request field that asks for estimated travel while sample data is being built, and nothing otherwise.
// How to call: await api.post('/api/converge', { members, ...travelField() })
const travelField = () => (estimateBuilds > 0 ? { travel: 'estimate' } : {})

// Runs `build` (the code that fills an account with sample data) with every ranking request it makes asking for estimated
// travel. Only the showcase and the tour use this, and they exist only for the demo account in a development build. While the build
// runs the counter is up for the whole page, so a ranking the person themselves asks for in that time (their Vote screen, say) also
// gets estimates: a build is shown behind a busy message and takes seconds. A real account's session endpoints (on the server) take
// no `travel` field and always route, and so does everything the person asks once the build is done.
// Resolves what `build` resolves, and always switches back, even when `build` throws.
// How to call: const built = await withEstimatedTravel(() => buildSessions(specs, options))
export async function withEstimatedTravel(build) {
  estimateBuilds += 1
  try {
    return await build()
  } finally {
    estimateBuilds -= 1
  }
}

// The planner requests that are being waited for right now, by who asked and what: the same person asking the same thing again
// while the first is on its way gets the first one's answer instead of a second trip to the server (and to OneMap).
const inFlight = new Map()

// POST to the planner, sending identical requests that are in flight together once. "Identical" is the same signed-in person
// (lib/currentUser.js), the same path, the same body and the same timeout, so an answer is never shared between two people or
// two different questions. The entry is removed the moment the request settles, success or failure, so nothing is cached:
// the next request goes to the server again. The first caller gets the response itself; any other caller gets its own copy of
// the data, made before anyone could change it, so no screen can alter what another reads. A failure reaches every caller.
// Only for requests that change nothing on the server (the rankings, the search, the weather): never for a write.
// How to call: const { data } = await postShared('/api/converge', { members, centre, categories: ['eat'] })
export function postShared(url, body, config) {
  const key = JSON.stringify([currentUserId(), url, body, config?.timeout ?? null])
  const sharing = inFlight.get(key)
  if (sharing) {
    sharing.followers += 1
    return sharing.settled.then(({ response, copy }) => ({ ...response, data: JSON.parse(copy) }))
  }
  const entry = { followers: 0, settled: null }
  entry.settled = (config === undefined ? api.post(url, body) : api.post(url, body, config)).then(
    (response) => {
      inFlight.delete(key)
      return { response, copy: entry.followers > 0 ? JSON.stringify(response.data) : null }
    },
    (err) => {
      inFlight.delete(key)
      throw err
    },
  )
  inFlight.set(key, entry)
  return entry.settled.then(({ response }) => response)
}

// Does this email have an account? The sign-up screen asks on its email question. The backend answers from the database
// with its own key (POST /api/accounts/email-check) and allows about 10 asks a minute for each caller, so a failure here
// is normal and means "carry on": the message is the error reader's (429 "Too many requests", 503 and no connection
// included). An answer that is not exactly true or false is an error, never a guess.
// How to call: await emailRegistered('sam@example.com') -> true
export async function emailRegistered(email) {
  // A shorter wait than the planner's: the person is held on the email question while this runs.
  const { data } = await api.post('/api/accounts/email-check', { email: String(email || '').trim() }, { timeout: 5000 })
  if (typeof data?.registered !== 'boolean') throw new Error('The planner sent an answer Jio could not read. Try again later.')
  return data.registered
}

// A member leaves a session, or the host removes a guest (`personId` is 'me' for leaving, or the guest's user id). The server
// checks who is asking and who may do what (backend/src/routes/sessions.js) and answers { planVersion, left } or
// { planVersion, removed }. A refusal arrives as an Error whose `code` is one of session_not_found, host_cannot_leave,
// host_only, session_closed, member_not_found.
// How to call: await removeSessionMember('3b1f...', 'me')
export async function removeSessionMember(sessionId, personId = 'me') {
  const { data } = await api.delete(`/api/sessions/${encodeURIComponent(sessionId)}/members/${encodeURIComponent(personId)}`, { timeout: 8000 })
  return data
}

// The needs a dietary answer may carry. How to call: NEEDS.includes('halal') -> true
const NEEDS = ['halal', 'vegetarian', 'vegan']

// An outing's dietary answer as the screens read it, or an Error when the server sent something else. `dietary` (the needs in
// effect, the dropped ones taken out) and `others` (everyone's but the caller's, empty under three joined, the dropped ones
// included) are always lists of known needs. `mine` (the caller's own needs for this outing), `dropped` and `checked` (whether the
// caller confirmed for this outing) are kept when the server sends them; an older server sends only the first two. The server
// names nobody in any of it. A write's answer also carries `planVersion` and `repicked` (true when the places were picked again, so
// the plan is read again).
// How to call: dietaryAnswer({ dietary: ['halal'], others: ['halal'], mine: [], checked: false, dropped: [] })
function dietaryAnswer(data) {
  const known = (list) => Array.isArray(list) && list.every((n) => NEEDS.includes(n))
  if (!known(data?.dietary) || !known(data?.others)) throw new Error(notJsonMessage())
  if ((data.mine !== undefined && !known(data.mine)) || (data.dropped !== undefined && !known(data.dropped)) || (data.checked !== undefined && typeof data.checked !== 'boolean')) throw new Error(notJsonMessage())
  return {
    dietary: data.dietary,
    others: data.others,
    ...(data.mine !== undefined ? { mine: data.mine } : {}),
    ...(data.dropped !== undefined ? { dropped: data.dropped } : {}),
    ...(data.checked !== undefined ? { checked: data.checked } : {}),
    ...(Number.isInteger(data.planVersion) ? { planVersion: data.planVersion } : {}),
    ...(data.repicked === true ? { repicked: true } : {}),
  }
}

// An outing's dietary needs, together and without names (GET /api/sessions/:id/dietary, ticket #107): `dietary` is the needs in
// effect, `others` everyone's but the signed-in person's, `mine` the person's own for this outing, `checked` whether they confirmed
// them, `dropped` the others' needs the host chose not to filter for. Only the server can read a member's needs, so this is how
// "Confirm dietary needs" learns a real friend's. Needs a login; a refusal arrives as an Error with the server's `code`
// (session_not_found, invalid_input). Anything but lists of known needs is an error, never a guess.
// How to call: await sessionDietary('3b1f...') -> { dietary: ['halal', 'vegan'], others: ['halal'], mine: ['vegan'], checked: true, dropped: [] }
export async function sessionDietary(sessionId) {
  const { data } = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/dietary`, { timeout: 8000 })
  return dietaryAnswer(data)
}

// The signed-in person confirms or changes their needs for this outing, or the host drops someone else's need
// (PUT /api/sessions/:id/dietary). `body` has at least one of `mine` (the person's whole list of own needs), `checked: true` (they
// confirmed; a chip tap sends none), `dropped` (the whole list of others' needs not to filter for: the host's alone) and, with them,
// `planVersion` (the one the page saw). Answers like sessionDietary plus `planVersion` and `repicked`. While the group is voting, a
// change of the needs in effect has the server pick each slot's places again, which takes as long as a ranking. A refusal arrives as
// an Error with the server's `code`: invalid_input, not_joined, host_only, session_not_found, session_closed, wrong_status,
// needs_three_people, stale_plan, need_not_found.
// How to call: await putSessionDietary('3b1f...', { mine: ['vegan'], checked: true })
export async function putSessionDietary(sessionId, body) {
  const { data } = await api.put(sessionPath(sessionId, '/dietary'), body, { timeout: SESSION_TIMEOUT_MS })
  return dietaryAnswer(data)
}

// How long a search for people is waited for. Typing makes many of them, so a slow one is given up on sooner than a ranking.
export const PEOPLE_SEARCH_TIMEOUT_MS = 6000

// People whose username starts with `q` (3 to 20 of a-z, 0-9 and _; already cleaned), for the invite field. The server checks who
// is asking, never lists the caller, and answers at most 5: [{ id, name, username, avatarUrl, metBefore }], possibly none
// (backend/src/routes/people.js). Rejects in the client's usual way (an Error whose message a person can read), and with an
// AbortError when `signal` aborts first, so the caller can tell a replaced search from a failed one.
// How to call: await searchPeopleByUsername('sam_t', { signal: controller.signal })
export async function searchPeopleByUsername(q, { signal } = {}) {
  try {
    const { data } = await api.get('/api/people/search', { params: { q }, timeout: PEOPLE_SEARCH_TIMEOUT_MS, signal })
    if (!Array.isArray(data?.people)) throw new Error(notJsonMessage())
    return data.people
  } catch (err) {
    if (signal?.aborted) throw Object.assign(new Error('The search was cancelled.'), { name: 'AbortError' })
    throw err
  }
}

// How long a call about a session's meeting spots is waited for. The server may route trips with OneMap for a few seconds (3 by default,
// ROUTING_DEADLINE_MS) before it answers, and a session run does more than route, so this is longer than a ranking's wait.
export const SESSION_TIMEOUT_MS = 20000

// The path of one of a session's routes. How to call: sessionPath('3b1f...', '/spots/mine') -> '/api/sessions/3b1f.../spots/mine'
const sessionPath = (sessionId, tail) => `/api/sessions/${encodeURIComponent(sessionId)}${tail}`

// Have the server work out a session's meeting spots again, after the person's start or end changed (E1 of the sessions design).
// `trigger` is 'start', 'end' or 'added' (a first start). The server writes the spots; the answer only says what it did and is
// never put into the screens: the session is read again afterwards.
// Resolves { planVersion, meetingAreaId, moved, votesCleared, skipped }. A refusal is an Error whose `code` is one of
// session_not_found, not_joined, not_yet (the group is voting), wrong_status, plan_busy.
// How to call: await refreshSessionSpots('3b1f...', 'start')
export async function refreshSessionSpots(sessionId, trigger) {
  const { data } = await api.post(sessionPath(sessionId, '/meeting-area'), trigger ? { trigger } : {}, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The person suggests an area for the group to meet in (E19), replacing their earlier suggestion. `here` marks it "we are here
// already". Resolves { planVersion, spots, approvalsRemoved }. Refusals: wrong_status, no_spots, too_many_spots, unknown_area,
// area_not_priced.
// How to call: await putSessionSpot('3b1f...', 'bugis', true)
export async function putSessionSpot(sessionId, areaId, here = false) {
  const { data } = await api.put(sessionPath(sessionId, '/spots/mine'), { areaId, here }, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The person takes their suggestion back (E20). Resolves { planVersion }; with nothing to withdraw it is a no-op.
// How to call: await deleteSessionSpot('3b1f...')
export async function deleteSessionSpot(sessionId) {
  const { data } = await api.delete(sessionPath(sessionId, '/spots/mine'), { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The host confirms a meeting spot (E2): the session moves from locating to voting. Without `areaId` the server takes the spot most
// people said works for them. Resolves { planVersion, status, meetingAreaId, method, slotCount }. Refusals: host_only,
// wrong_status, spot_not_found, no_spots.
// How to call: await confirmSessionSpot('3b1f...', 'bugis')
export async function confirmSessionSpot(sessionId, areaId) {
  const { data } = await api.post(sessionPath(sessionId, '/voting'), areaId ? { areaId } : {}, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The host names the place the group already knows (E21), from inviting or locating. Resolves { planVersion, status }. Refusals:
// host_only, wrong_status, needs_two_people, unknown_area.
// How to call: await putSessionKnownPlace('3b1f...', 'bugis')
export async function putSessionKnownPlace(sessionId, areaId) {
  const { data } = await api.put(sessionPath(sessionId, '/known-place'), { areaId }, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The host changes the meeting place from voting or confirmed (design: "Change plan"). `meetBy: 'fairest'` takes the session back to locating and
// has the spots worked out again; `meetBy: 'known'` with an `areaId` goes on to voting at that area. Resolves { planVersion, status, meetBy }.
// Refusals: host_only, wrong_status, unknown_area, session_not_found; if naming the area fails after the release the Error carries the failure's
// code and the session is on Locate (read it again).
// `planVersion` is the version of the session the person saw: the server refuses (409 stale_plan, nothing written) when it has moved on, so a retry
// never wipes votes cast since.
// How to call: await changeSessionMeetingPlace('3b1f...', { meetBy: 'known', areaId: 'bugis', planVersion: 12 })
export async function changeSessionMeetingPlace(sessionId, { meetBy, areaId, planVersion }) {
  const body = { meetBy, ...(meetBy === 'known' ? { areaId } : {}), ...(Number.isInteger(planVersion) ? { planVersion } : {}) }
  const { data } = await api.post(sessionPath(sessionId, '/change-meeting-place'), body, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The person opts out of a session but keeps their place in it (E10), and comes back (E11). Both resolve { planVersion, state }.
// How to call: await optOutOfSession('3b1f...'); await rejoinSession('3b1f...')
export async function optOutOfSession(sessionId) {
  const { data } = await api.post(sessionPath(sessionId, '/opt-out'), {}, { timeout: SESSION_TIMEOUT_MS })
  return data
}
export async function rejoinSession(sessionId) {
  const { data } = await api.post(sessionPath(sessionId, '/rejoin'), {}, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// ── Voting on places, for a session on the server (stage 4, ticket 129; the contract is E3 to E9, E17 and E18 of the sessions design) ──
// The votes themselves are the browser's own writes to the database (lib/sessionsRemote.js); everything that changes what the
// group is offered goes through these. Each resolves the server's small answer, which is never put into the screens (the session is
// read again afterwards), and a refusal is an Error whose `code` is the server's: session_not_found, not_joined, host_only,
// wrong_status, slot_not_found, slot_full, venue_not_found, venue_does_not_fit, option_not_found, plan_busy.

// The server works the slots and options out again from what people picked (E3). Answers { planVersion, changed }.
// How to call: await syncSessionPlan('3b1f...')
export async function syncSessionPlan(sessionId) {
  const { data } = await api.post(sessionPath(sessionId, '/plan/sync'), {}, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The host sets how far from the meeting area places may be, in metres (100 to 3000), or null for the planner's own widening
// (E4). Places outside drop out with their votes and each slot is topped up again. Answers { planVersion, radiusMeters }.
// How to call: await putSessionRadius('3b1f...', 1000)
export async function putSessionRadius(sessionId, radiusMeters) {
  const { data } = await api.put(sessionPath(sessionId, '/radius'), { radiusMeters }, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The host removes a slot (a category) and its places and votes (E5), or brings them back (E6; one slot, or all when `slotId` is
// left out). Answer { planVersion } and { planVersion, restored: [slotId] }.
// How to call: await deleteSessionSlot('3b1f...', '9a2c...'); await restoreSessionSlots('3b1f...')
export async function deleteSessionSlot(sessionId, slotId) {
  const { data } = await api.delete(sessionPath(sessionId, `/slots/${encodeURIComponent(slotId)}`), { timeout: SESSION_TIMEOUT_MS })
  return data
}
export async function restoreSessionSlots(sessionId, slotId) {
  const { data } = await api.post(sessionPath(sessionId, '/slots/restore'), slotId ? { slotId } : {}, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// A member adds a place to a slot (E7). Answers { planVersion, added }: added is false when the place was there already.
// How to call: await addSessionOption('3b1f...', '9a2c...', 'v25')
export async function addSessionOption(sessionId, slotId, venueId) {
  const { data } = await api.post(sessionPath(sessionId, `/slots/${encodeURIComponent(slotId)}/options`), { venueId }, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// A member takes back a place they added (no one else has voted for it). Answers { planVersion, removed }.
// How to call: await removeSessionOption('3b1f...', '9a2c...', 'v25')
export async function removeSessionOption(sessionId, slotId, venueId) {
  const { data } = await api.delete(sessionPath(sessionId, `/slots/${encodeURIComponent(slotId)}/options/${encodeURIComponent(venueId)}`), { timeout: SESSION_TIMEOUT_MS })
  return data
}

// A member asks for more places in a slot (E8). `have` is how many the person is looking at, so asking again after a lost answer
// adds nothing twice. Answers { planVersion, added: [venueId] }.
// How to call: await moreSessionOptions('3b1f...', '9a2c...', 3)
export async function moreSessionOptions(sessionId, slotId, have) {
  const { data } = await api.post(sessionPath(sessionId, `/slots/${encodeURIComponent(slotId)}/options/more`), { have }, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// A member swaps one place of a slot for another, as for an outdoor place in the rain (E9); the votes for it follow. Answers
// { planVersion, swapped }.
// How to call: await swapSessionOption('3b1f...', '9a2c...', 'east-coast-park', 'toa-payoh-library')
export async function swapSessionOption(sessionId, slotId, fromVenueId, toVenueId) {
  const { data } = await api.post(
    sessionPath(sessionId, `/slots/${encodeURIComponent(slotId)}/options/${encodeURIComponent(fromVenueId)}/swap`),
    { toVenueId },
    { timeout: SESSION_TIMEOUT_MS },
  )
  return data
}

// Places to add to a slot, found by name (E17), each saying whether it fits and why not: the same results as POST /api/search, and
// `added` when the place is already an option. With `cdcOnly`, only places that take CDC vouchers; with `browse` and no words, the
// nearest places that fit (the box's suggestions). Resolves [{ id, name, area, category, walk, unfit, cdc, added }]. Rejects in the
// client's usual way.
// How to call: await searchSessionSlot('3b1f...', '9a2c...', 'chicken rice', { cdcOnly: true })
export async function searchSessionSlot(sessionId, slotId, q, { cdcOnly = false, browse = false } = {}) {
  const params = { q, ...(cdcOnly ? { cdc: '1' } : {}), ...(browse ? { browse: '1' } : {}) }
  const { data } = await api.get(sessionPath(sessionId, `/slots/${encodeURIComponent(slotId)}/venue-search`), { params, timeout: 8000 })
  if (!Array.isArray(data?.results)) throw new Error(notJsonMessage())
  return data.results.map((r) => ({ ...toSearchResult(r), added: r.added === true }))
}

// The most places one request for venues may ask for.
export const VENUES_PER_REQUEST = 50

// Places by id (E18), as the cards read them (toCardVenue); an id the server does not know is left out. Asks 50 at a time.
// Rejects in the client's usual way.
// How to call: const venues = await venuesByIds(['v25', 'cdc_570511'])
export async function venuesByIds(ids) {
  const wanted = [...new Set(ids)].filter(Boolean)
  const found = []
  for (let i = 0; i < wanted.length; i += VENUES_PER_REQUEST) {
    const { data } = await api.get('/api/venues', { params: { ids: wanted.slice(i, i + VENUES_PER_REQUEST).join(',') }, timeout: 8000 })
    if (!Array.isArray(data?.venues)) throw new Error(notJsonMessage())
    found.push(...data.venues.map(toCardVenue))
  }
  return found
}

// ── The plan, for a session on the server (stage 5, ticket 130; the contract is E12 to E16 and E22 to E24 of the sessions design) ──
// The itinerary itself is read from the database (lib/sessionsRemote.js); everything that changes it goes through these. The browser
// never sends stops, a reason or a source: the server reads the winners, the order and the sentence from its own rows (E12, E22).
// Each resolves the server's small answer, which is never put into the screens (the session is read again afterwards), and a refusal is
// an Error whose `code` is the server's: session_not_found, not_joined, host_only, wrong_status, plan_busy, and for these routes
// not_enough_votes, nothing_to_confirm, order_stale, stop_not_found, stops_changed, stop_changed, last_stop, proposal_not_found, plan_full, already_a_stop,
// too_many_proposals, venue_not_found.

// The host asks for the suggested order of the winning places (E22): one question to the server, which may ask the AI under its own
// budget. Resolves { status: 'ok', basis, order: [slotId], stops: [{ slotId, venueId, start }], voted: [{ slotId, category, venueId, start,
// duration }], reason, source } or { status: 'none', why, basis, voted }. `voted` and `stops` are the stops of the voted and of the suggested
// order as a confirm would store them, each with the start that is stored for it.
// A refusal: host_only, wrong_status, not_enough_votes.
// How to call: const answer = await suggestSessionOrder('3b1f...')
export async function suggestSessionOrder(sessionId) {
  const { data } = await api.post(sessionPath(sessionId, '/order/suggest'), {}, { timeout: ARRANGE_TIMEOUT_MS + 10000 })
  if (data?.status !== 'ok' && data?.status !== 'none') throw new Error(notJsonMessage())
  return data
}

// The minutes each person needs to get home from the last stop of a confirmed plan: the computation the finished outing's ledger keeps as
// `minutes_home`. A member asks; nothing is written. Resolves { trips: [{ userId, minutes }], approximate }.
// How to call: const { trips } = await getSessionTripsHome('3b1f...') // [{ userId: '9a2c...', minutes: 31 }]
export async function getSessionTripsHome(sessionId) {
  const { data } = await api.get(sessionPath(sessionId, '/trips-home'), { timeout: SESSION_TIMEOUT_MS })
  if (!Array.isArray(data?.trips)) throw new Error(notJsonMessage())
  return data
}

// Whether the signed-in person's own past travel counts in the pick of the meeting spots (GET /api/sessions/:id/travel-lean): their own flag and the
// rule in use, and nothing about anyone else. Resolves { owed: boolean, rule: 'longest' | 'balanced' }. Anything else is an error, never a
// guess: the line on the Locate step is shown only for an answer this function accepts.
// How to call: const { owed, rule } = await getSessionTravelLean('3b1f...') // { owed: true, rule: 'longest' }
export async function getSessionTravelLean(sessionId) {
  const { data } = await api.get(sessionPath(sessionId, '/travel-lean'), { timeout: SESSION_TIMEOUT_MS })
  if (typeof data?.owed !== 'boolean' || !['longest', 'balanced'].includes(data.rule)) throw new Error(notJsonMessage())
  return { owed: data.owed, rule: data.rule }
}

// The host confirms the plan (E12). `order` is 'voted' (the winners in the order of their slots) or 'suggested' with the `basis` of the
// suggestion the host saw. A `basis` may go with the voted order too (the one the server gave when the host looked at the votes): one that is
// no longer the votes' own is refused with 409 `order_stale` and nothing is written, so what the host saw is what is saved. The server also
// reads the tally again under its lock and refuses a stop that is no longer a leader of its slot, with the same code.
// Resolves { planVersion, status, stops: n }.
// How to call: await confirmSessionPlan('3b1f...', { order: 'suggested', basis: 'a3f9...' })
export async function confirmSessionPlan(sessionId, { order = 'voted', basis } = {}) {
  const { data } = await api.post(sessionPath(sessionId, '/confirm'), order === 'suggested' || basis ? { order, basis } : { order }, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The host takes a confirmed plan back to voting (E13, `accept: true`), or only turns the "Re-plan?" question off (`accept: false`).
// Resolves { planVersion, status }.
// How to call: await replanSession('3b1f...', true)
export async function replanSession(sessionId, accept = true) {
  const { data } = await api.post(sessionPath(sessionId, '/replan'), { accept }, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The host ends the outing (E14); the server writes everyone's travel ledger row. Resolves { status }.
// How to call: await completeSession('3b1f...')
export async function completeSession(sessionId) {
  const { data } = await api.post(sessionPath(sessionId, '/complete'), {}, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The host sets how the group gets to a stop from the one before (E15): 'walk', 'mrt' or 'car'. Resolves { planVersion }.
// How to call: await patchSessionStop('3b1f...', '5d0c...', { travelMode: 'mrt' })
export async function patchSessionStop(sessionId, stopId, { travelMode }) {
  const { data } = await api.patch(sessionPath(sessionId, `/stops/${encodeURIComponent(stopId)}`), { travelMode }, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The host removes a stop (E15). Resolves { planVersion }. A refusal: stop_not_found, last_stop.
// How to call: await deleteSessionStop('3b1f...', '5d0c...')
export async function deleteSessionStop(sessionId, stopId) {
  const { data } = await api.delete(sessionPath(sessionId, `/stops/${encodeURIComponent(stopId)}`), { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The host rearranges the stops (E15's order route): `stopIds` is every stop, in the new order. The server rewrites the order and clears
// the earliest starts, the note and the travel modes. Resolves { planVersion }. A refusal: stops_changed (409) when the list is not exactly
// the session's stops, as another device left them (nothing is written).
// How to call: await putSessionStopOrder('3b1f...', ['5d0c...', '9e41...'])
export async function putSessionStopOrder(sessionId, stopIds) {
  const { data } = await api.put(sessionPath(sessionId, '/stops/order'), { stopIds }, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// Changing a confirmed stop's place, the one way (the server's own routes, GET .../stops/:stopId/swap and .../choices, and PUT .../place):
// the indoor place the planner would swap a stop for in the rain (any member may ask), the places that could take a stop's place (the host
// only), and putting one in (the host only). The two reads write nothing and the server ranks them for the stop's own time on its day, so the
// browser sends no time; putting a place in checks that it exists and fits and that the stop still holds `seenVenueId`, and keeps the stop from
// starting earlier than the time it was checked for.
// How to call: await getSessionStopSwap('3b1f...', '5d0c...') -> { swap: { venueId, name } | null }
export async function getSessionStopSwap(sessionId, stopId) {
  const { data } = await api.get(sessionPath(sessionId, `/stops/${encodeURIComponent(stopId)}/swap`), { timeout: 8000 })
  return data
}
// How to call: await getSessionStopChoices('3b1f...', '5d0c...', { category: 'drink' }) -> { category, options: [{ venueId, rank, score, details, votes }] }
export async function getSessionStopChoices(sessionId, stopId, { category } = {}) {
  const { data } = await api.get(sessionPath(sessionId, `/stops/${encodeURIComponent(stopId)}/choices`), { params: { ...(category ? { category } : {}) }, timeout: SESSION_TIMEOUT_MS })
  if (!Array.isArray(data?.options)) throw new Error(notJsonMessage())
  return data
}
// The host keeps a stop as it is in the rain (the Keep button): stored on the session by the server, so every device sees the warning put away.
// `state` is the forecast's state when it was pressed. Resolves { planVersion, kept: true }. A refusal: host_only, wrong_status, stop_not_found.
// How to call: await putSessionStopRain('3b1f...', '5d0c...', 'showers')
export async function putSessionStopRain(sessionId, stopId, state) {
  const { data } = await api.put(sessionPath(sessionId, `/stops/${encodeURIComponent(stopId)}/kept-rain`), { state }, { timeout: SESSION_TIMEOUT_MS })
  return data
}
// How to call: await putSessionStopPlace('3b1f...', '5d0c...', { venueId: 'v25', seenVenueId: 'v12', category: 'drink' }) -> { planVersion, changed }
export async function putSessionStopPlace(sessionId, stopId, { venueId, seenVenueId, category }) {
  const { data } = await api.put(
    sessionPath(sessionId, `/stops/${encodeURIComponent(stopId)}/place`),
    { venueId, seenVenueId, ...(category ? { category } : {}) },
    { timeout: SESSION_TIMEOUT_MS },
  )
  return data
}

// "What next?" for a session (E16): the places near where the group is. The centre is the meeting area unless `current` ({ lat, lng },
// "Use my location") says otherwise; it is used for this request only and the answer does not repeat it. Each place is a Roam card plus
// `isStop` (already in the plan) and `proposedBy` (who put it forward, if anyone). Nothing is written. Resolves the same as roamNearby.
// How to call: await roamSession('3b1f...', { current: { lat: 1.35, lng: 103.85 }, categories: ['eat'] })
export async function roamSession(sessionId, { current, categories } = {}) {
  const { data } = await api.post(
    sessionPath(sessionId, '/roam'),
    { ...(current ? { current: point(current) } : {}), ...(categories?.length ? { categories } : {}) },
    { timeout: ROAM_TIMEOUT_MS },
  )
  return roamAnswer(data)
}

// A member puts a place forward as the next stop (E23). Resolves { planVersion, id, applied: true, existing: false } (201), or `applied: false,
// existing: true` with the first proposal's id when that place is already waiting (200). A refusal: wrong_status, venue_not_found, already_a_stop, too_many_proposals, plan_full.
// How to call: await proposeSessionStop('3b1f...', 'v25')
export async function proposeSessionStop(sessionId, venueId) {
  const { data, status } = await api.post(sessionPath(sessionId, '/proposals'), { venueId }, { timeout: SESSION_TIMEOUT_MS })
  return { ...data, existing: status === 200 }
}

// The host adds a proposal to the plan or leaves it out; the person who proposed it may dismiss it (E24). Resolves { planVersion, applied }:
// `applied` is false (still a 200) when the proposal is not waiting any more (answered, cleared by a re-plan or a finished outing, or never
// there), and nothing was written. A refusal: host_only, plan_full.
// How to call: await resolveSessionProposal('3b1f...', 'c7ae...', true)
export async function resolveSessionProposal(sessionId, proposalId, accept) {
  const { data } = await api.post(sessionPath(sessionId, `/proposals/${encodeURIComponent(proposalId)}/resolve`), { accept: !!accept }, { timeout: SESSION_TIMEOUT_MS })
  return data
}

// The weather the planner used for the last ranking: { source: 'live' | 'simulated' | 'unavailable', simulationIgnored? }.
// The demo panel reads it to say when the server ignored the rain switch. Null until a ranking has come back.
export const lastWeather = ref(null)

// The backend has no occasion picker yet, so every session is a catch-up.
export const DEFAULT_OCCASION = 'catch_up'

// What the planner does with a place it has no data on (a dietary need, step-free access, the walk to the MRT): 'strict' leaves
// it out, 'lenient' keeps it and each option says which dietary needs are unknown (dietUnknown). The caller decides, because it
// knows the group's needs and whether the group asked to see the places we could not confirm (lib/api.js dietPolicy). Left
// out, a request is 'lenient', as it always was. A group's dietary needs are strict on their own (`dietPolicy`, same two words),
// so they never make the walk to the MRT, step-free access or sockets strict as well.
const UNKNOWN_POLICY = 'lenient'

// The policy for dietary needs only, left out of a request when the caller gives none (then the planner follows `unknownPolicy`).
// How to call: dietField('strict') -> { dietPolicy: 'strict' }
const dietField = (dietPolicy) => (dietPolicy ? { dietPolicy } : {})

// The backend's "does not fit" words, in the words the search sheet already knows. A dietary reason ('diet:halal') is 'diet',
// with the need kept apart.
const UNFIT_WORDS = { meal_period: 'meal', near_mrt: 'mrt' }

const point = ({ lat, lng }) => ({ lat, lng })

// A backend venue with the field names the cards read (price, indoor, mrtWalk, rating out of 10...).
// The backend's own fields stay on it too.
export function toCardVenue(v) {
  return {
    ...v,
    price: v.avgPricePerPerson,
    indoor: v.setting === 'indoor',
    mrt: v.nearestMrt,
    mrtWalk: v.mrtWalkMinutes,
    rating: v.rating == null ? null : v.rating * 2,
    hours: (v.openingHours || []).map(([open, close]) => `${open}-${close}`),
    serves: v.mealPeriods || [],
    tags: [...new Set([...(v.tags || []), ...(v.cdcAccepted ? ['cdc'] : [])])],
  }
}

// One ranked backend result as an option. `score` is a penalty: lower is better, and `rank` 1 is the best.
// `block` is the answer's `weather` block; with the result's own `weather` it becomes the option's `weather` (lib/weatherText.js),
// which is left out when the planner sent none.
function toOption(r, block = null) {
  const weather = weatherFrom(r.weather, block)
  return {
    venue: toCardVenue(r.venue),
    rank: r.rank,
    score: r.score,
    walk: r.walkMinutes,
    reasons: r.reasons,
    warnings: r.warnings,
    swap: r.swap ? { id: r.swap.venueId, name: r.swap.name } : null,
    explanation: r.explanation,
    verify: r.verify,
    dietUnknown: r.dietUnknown,
    // "About": the planner used the straight line (`approximate`) or its table of times between the areas (`travelSource: 'table'`) for this place.
    approximate: !!r.approximate || r.travelSource === 'table',
    ...(weather ? { weather } : {}),
  }
}

// Where the group should meet.
//   members: [{ id, name, start: { lat, lng }, end: { lat, lng } }]
//   routing: false is the demo's "routing off" switch: the geographic centre, named after the nearest area.
//   alternatives: how many runners-up to ask for besides the chosen area (0 to 3). The app's three spots are alternatives: 2.
//   include:      area ids to work out whatever their rank (up to 8), such as the spots members suggested.
// Both are optional. Left out, the request is exactly what it always was and the answer has no `candidates`.
// Returns the backend's answer: { area: { id, name, lat, lng }, centre, travelByMember, worstMinutes, method, approximate, travel }.
// With alternatives or include it also has candidates, the chosen area first:
// [{ area, worstMinutes, meanMinutes, travelByMember, approximate, source: 'ranked' | 'included' }].
// `approximate` is false when routing is off, although every time is then an estimate: travel.source is 'estimate' then
// (and 'onemap' when at least one trip got a real time). A server with the table of area times answers 'table' when no trip was
// routed, and each candidate says `travelSource` ('routed' | 'table' | 'estimate'). Say "about" for any but routed.
// How to call: await meetingArea({ members, routing: true, alternatives: 2, include: ['bugis'] })
export async function meetingArea({ members, routing = true, alternatives, include }) {
  const body = { members, method: routing ? 'station' : 'centroid', ...travelField() }
  if (alternatives !== undefined) body.alternatives = alternatives
  if (include?.length) body.include = include
  const { data } = await postShared('/api/meeting-area', body)
  return data
}

// Rank places for one slot around the meeting area.
//   slot: { start (minutes after midnight), time ("HH:MM"), duration, category }
//   currentOptionIds: the options the group is voting on. They are always scored, and come back in `current`
//                     for as long as they still fit.
//   radiusMeters:     the radius the group chose (100 to 3000), or undefined to let the planner widen on its own.
// Returns { options (best first), current (the current options that still fit), widened, few, empty, weather }.
// weather: what the planner used, { source: 'live' | 'simulated' | 'unavailable', simulationIgnored? }.
// The weather case is only sent while the demo rain switch is on; otherwise the planner uses the live forecast.
// few: { found, widenToKm } when fewer than 3 places fit inside the search radius.
// unknownPolicy: 'strict' or 'lenient' (see UNKNOWN_POLICY); dietPolicy: the same for the group's dietary needs alone.
export async function rankSlot({ members, centre, date, slot, lastStop, currentOptionIds = [], conditions = {}, radiusMeters, topN, unknownPolicy = UNKNOWN_POLICY, dietPolicy }) {
  const { data } = await postShared('/api/converge', {
    members,
    occasion: DEFAULT_OCCASION,
    dateTime: `${date}T${slot.time}`,
    durationMinutes: slot.duration,
    categories: [slot.category],
    centre: point(centre),
    lastStop,
    currentOptionIds,
    ...(conditions.rain ? { weatherCase: 'rain' } : {}),
    unknownPolicy,
    ...dietField(dietPolicy),
    radiusMeters,
    topN,
    ...travelField(),
  })
  const weather = data.weather ?? null
  lastWeather.value = weather
  if (data.status !== 'ok') return { options: [], current: [], widened: false, few: null, empty: data, weather }
  const few = data.notice?.type === 'few_options' ? { found: data.notice.found, widenToKm: data.notice.widenToKm } : null
  const option = (r) => toOption(r, weather)
  return { options: data.results.map(option), current: data.current.map(option), widened: !!data.notice, few, empty: null, weather }
}

// How long a Roam list is waited for. The planner routes each place from the current point, so a slow answer is given up
// on sooner than a ranking: the person is standing somewhere, waiting.
export const ROAM_TIMEOUT_MS = 10000

// One Roam result as a card: the voting page's card (toOption) with the planner's time and distance from the current point.
// `distanceM` is the straight-line distance in metres, since the cards say "250 m" and "1.2 km".
function toRoamPlace(r, block = null) {
  return {
    ...toOption(r, block),
    // A session's server names no need (it sends one flag instead of `verify` and `dietUnknown`), so a card still reads lists.
    verify: r.verify ?? [],
    dietUnknown: r.dietUnknown ?? [],
    ...(r.checkNeeds === true ? { checkNeeds: true } : {}),
    id: r.venueId,
    travelMinutes: r.travelMinutes,
    distanceKm: r.distanceKm,
    distanceM: Number.isFinite(r.distanceKm) ? Math.round(r.distanceKm * 1000) : null,
  }
}

// "What next?": the places near one point, best first. The point is used for this request only; nothing here keeps it,
// and the answer does not repeat it.
//   members:   [{ id, name }] the people in the meetup (the planner needs only an id)
//   current:   { lat, lng } where the group is
//   date, time: when the stop would start, "YYYY-MM-DD" and "HH:MM"; minutes: how long it would last
//   categories: any of eat, drink, shop, activity. Left out, the planner uses eat, drink and activity.
//   unknownPolicy: 'strict' or 'lenient' (see UNKNOWN_POLICY); dietPolicy: the same for the group's dietary needs alone.
// Returns { places (best first, each as a voting-page card plus id, travelMinutes, distanceKm, distanceM), empty (the
// planner's answer when nothing fits, else null), widened, weather }.
// How to call: await roamNearby({ members: [{ id: 'ian' }], current: { lat: 1.35, lng: 103.85 }, date: '2026-10-11', time: '15:00', minutes: 60 })
export async function roamNearby({ members, current, date, time, minutes, categories, conditions = {}, topN, unknownPolicy = UNKNOWN_POLICY, dietPolicy }) {
  const { data } = await postShared(
    '/api/roam',
    {
      members,
      occasion: DEFAULT_OCCASION,
      dateTime: `${date}T${time}`,
      durationMinutes: minutes,
      ...(categories?.length ? { categories } : {}),
      current: point(current),
      ...(conditions.rain ? { weatherCase: 'rain' } : {}),
      unknownPolicy,
      ...dietField(dietPolicy),
      topN,
      ...travelField(),
    },
    { timeout: ROAM_TIMEOUT_MS },
  )
  return roamAnswer(data)
}

// A Roam answer (the stateless route's, or a session's) as the screens read it. Records the weather block in `lastWeather`.
// How to call: roamAnswer({ status: 'ok', results: [], weather: null }) -> { places: [], empty: null, widened: false, weather: null }
function roamAnswer(data) {
  const weather = data.weather ?? null
  lastWeather.value = weather
  if (data.status !== 'ok') return { places: [], empty: data, widened: false, weather }
  if (!Array.isArray(data.results)) throw new Error(notJsonMessage())
  return { places: data.results.map((r) => ({ ...toRoamPlace(r, weather), isStop: r.isStop === true, proposedBy: typeof r.proposedBy === 'string' ? r.proposedBy : null })), empty: null, widened: !!data.notice, weather }
}

// The weather at each stop of a plan, from the planner (POST /api/weather/stops): the itinerary asks when it opens on its day and
// every 30 minutes after. It ranks nothing and suggests no swap.
//   stops: [{ id, point: { lat, lng }, start: 'YYYY-MM-DDTHH:MM' (Singapore time), setting?, exposure? }], at most 8
//   conditions: the demo switches; with `rain` on the planner is asked for a simulated rain (it may ignore that: see `weather`)
// Resolves { stops: { [id]: weather object (lib/weatherText.js) }, weather: the answer's block } and records the block in
// `lastWeather`. Rejects in the client's usual way when the planner cannot answer.
// How to call: await stopsWeather({ stops: [{ id: 'eat', point: { lat: 1.35, lng: 103.85 }, start: '2026-10-11T15:00' }] })
export async function stopsWeather({ stops, conditions = {} }) {
  const { data } = await postShared('/api/weather/stops', { stops, ...(conditions.rain ? { weatherCase: 'rain' } : {}) })
  if (!Array.isArray(data.stops)) throw new Error(notJsonMessage())
  const block = data.weather ?? null
  lastWeather.value = block
  const found = {}
  for (const s of data.stops) if (typeof s?.id === 'string') found[s.id] = weatherFrom(s, block)
  return { stops: found, weather: block }
}

// How long the order is waited for: the host can confirm the voted order, so a slow answer is given up on.
export const ARRANGE_TIMEOUT_MS = 10000

// The AI order for a plan, chosen by Claude on the backend (asked for when the group confirms). Food stops keep their
// place and time (meals stay at meal times); the drink, shop and activity stops may move. `includeCurrent` lets the
// voted order be chosen when it is already the best.
//   stops:   [{ id, name, category, kind?, lat, lng, duration, start?, hours: ['10:00-22:00'], indoor?, mrtWalk? }] in the voted order
//   startAt, endAt: when the plan starts and the session ends, in minutes after midnight
// Returns { status: 'ok', order: [stop ids], stops: [{ id, start, end }], reason, source: 'ai' | 'rules' }
//      or { status: 'no_other_order', message }.
// How to call: await arrangeItinerary({ stops, startAt: 600, endAt: 1020, includeCurrent: true })
export async function arrangeItinerary({ stops, startAt, endAt, shown = [], rain = false, includeCurrent = false }) {
  const { data } = await api.post('/api/itinerary/arrange', { stops, startAt, endAt, shown, rain, includeCurrent }, { timeout: ARRANGE_TIMEOUT_MS })
  return data
}

// Find places by name for a slot. Each says whether it fits, and the first reason it does not. A place that fails a dietary
// need says 'diet', with the need in `need`; one that fits says which needs it only likely meets (`verify`) or has no data on
// (`dietUnknown`), as a ranked option does.
// With `cdcOnly`, only places that take CDC vouchers; with `browse` and an empty query, the nearest places that fit, at most `limit`.
// The list carries `google`: where Google stood for this search ('unavailable' when it did not answer).
// How to call: await searchSlot({ query: 'market', members, centre, date: '2026-10-17', slot, lastStop: false, dietPolicy: 'strict', cdcOnly: true })
export async function searchSlot({ query, members, centre, date, slot, lastStop, maxKm, unknownPolicy = UNKNOWN_POLICY, dietPolicy, cdcOnly = false, browse = false, limit }) {
  const { data } = await postShared('/api/search', {
    query,
    centre: point(centre),
    dateTime: `${date}T${slot.time}`,
    durationMinutes: slot.duration,
    categories: [slot.category],
    lastStop,
    members,
    unknownPolicy,
    ...dietField(dietPolicy),
    maxKm,
    ...(cdcOnly ? { cdcOnly: true } : {}),
    ...(browse ? { browse: true } : {}),
    ...(limit ? { limit } : {}),
  })
  // Where Google stood ('google', 'off', 'not_needed', 'unavailable'), kept on the list so the screen can say when only saved places were searched.
  return Object.assign(data.results.map(toSearchResult), { google: data.google?.source ?? null })
}

// One search result as the screen reads it: the first reason it does not fit, in the words the search sheet knows (a dietary reason
// is 'diet' with the need in `need`; a session's own search says only 'group_needs', which names no need), and which dietary needs it
// only likely meets (`verify`) or has no data on (`dietUnknown`), which a session's own search never sends (it would name the needs of
// the other members), and whether it takes CDC vouchers (`cdc`). The stateless search and a session's own search (E17) answer in this shape.
// How to call: toSearchResult({ venueId: 'v25', name: 'Gem Cafe', area: 'Bishan', category: 'eat', walkMinutes: 4, unfit: ['meal_period'] })
export function toSearchResult(r) {
  const reason = (r.unfit || [])[0] || ''
  const diet = reason.startsWith('diet:')
  return {
    id: r.venueId,
    name: r.name,
    area: r.area,
    category: r.category,
    walk: r.walkMinutes,
    unfit: diet ? 'diet' : UNFIT_WORDS[reason] || reason,
    ...(diet ? { need: reason.slice(5) } : {}),
    verify: r.verify || [],
    dietUnknown: r.dietUnknown || [],
    cdc: r.cdcAccepted === true,
  }
}

// How long an address search is waited for. Typing makes many of them, so a slow one is given up on sooner than a ranking.
export const PLACE_SEARCH_TIMEOUT_MS = 6000

// Find an address, postal code or building by name with OneMap, through the backend (it needs no account).
// Resolves the backend's results, at most 10: [{ name, address, postal, lat, lng }], possibly none.
// Rejects in the client's usual way (an Error whose message a person can read) when the backend cannot answer, and with
// an AbortError when `signal` aborts first, so the caller can tell a replaced search from a failed one.
// How to call: await searchAddresses('tampines mall', { signal: controller.signal })
export async function searchAddresses(query, { signal } = {}) {
  try {
    const { data } = await api.get('/api/places/search', { params: { q: query }, timeout: PLACE_SEARCH_TIMEOUT_MS, signal })
    if (!Array.isArray(data.results)) throw new Error(notJsonMessage())
    return data.results
  } catch (err) {
    // The response interceptor turns every failure into a plain Error, so a cancelled request is recognised by its signal.
    if (signal?.aborted) throw Object.assign(new Error('The search was cancelled.'), { name: 'AbortError' })
    throw err
  }
}

// ── Places from a post: the link reader (backend/docs/link-reader-api.md) ──

// How long a post is waited for. The server reads a video for 10 to 40 seconds and stops gathering after 60.
export const POST_READ_TIMEOUT_MS = 75000

// What this server can read, or `{ enabled: false }` when it cannot read posts at all. A server started without LINK_READER=1
// has no such route and answers 404, which is an answer here, not a failure. Any other failure rejects in the client's usual way.
// How to call: await postReaderCapabilities() -> { enabled: true, youtube: { video: true, ... }, tiktok: { caption: true, ... }, ... }
export async function postReaderCapabilities() {
  try {
    const { data } = await api.get('/api/links/capabilities', { timeout: 8000 })
    if (typeof data?.enabled !== 'boolean') throw new Error(notJsonMessage())
    return data
  } catch (err) {
    if (err?.status === 404) return { enabled: false }
    throw err
  }
}

// The places named in one post (a YouTube, TikTok, Instagram or Xiaohongshu link), each with its Google match when there is one.
// Resolves the server's answer as it is: `status` is 'ok' (with `places`) or 'unreadable' (with `reason`, `retryable` and
// `notes`). A link the server will not read rejects with `code` 'not_a_link' or 'unsupported_site', too many reads with
// 'rate_limited', and a server whose AI key is missing with 'link_reader_unavailable'. `centre` leans the Google search towards
// a point in Singapore and may be left out.
// How to call: await readPost('https://www.youtube.com/watch?v=stubVideo01') -> { status: 'ok', source: {...}, places: [...], notes: [] }
export async function readPost(url, { centre, signal } = {}) {
  try {
    const { data } = await api.post('/api/links/read', { url, ...(centre ? { centre } : {}) }, { timeout: POST_READ_TIMEOUT_MS, signal })
    if (data?.status === 'ok' && !Array.isArray(data.places)) throw new Error(notJsonMessage())
    if (data?.status !== 'ok' && data?.status !== 'unreadable') throw new Error(notJsonMessage())
    return data
  } catch (err) {
    if (signal?.aborted) throw Object.assign(new Error('The read was cancelled.'), { name: 'AbortError' })
    throw err
  }
}
