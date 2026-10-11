// Every read and write in the app goes through this file.
//
// The meeting area and the suggestions come from the Jio backend's planner (see plannerApi.js).
// Everything else is still a mock: the data lives in memory (and in localStorage, so a reload keeps the demo).
// When Supabase exists, replace the bodies of these functions; the screens and stores do not change.
//
// Every function is async, like a network call. Writes notify subscribers, the way Supabase live updates will.
import { coins } from './currency.js'
import { ADDRESSES, AREAS } from './mock/places.js'
import { VENUES } from './mock/venues.js'
import { HOST_ID, PAST_ACTIVITY, PEOPLE, LAST_SEASON_MEETUPS, POINTS_PER_MEETUP, SEASON_MEETUPS, STARTING_MEETUPS, isCommunity } from './mock/people.js'
import { REWARDS } from './mock/rewards.js'
import { pastMeetupDates } from './mock/history.js'
import { reviewsFor } from './mock/reviews.js'
import * as Season from './season.js'
import * as P from './planner/index.js'
import * as planner from './plannerApi.js'
import * as auth from './auth.js'
import { localAccountsAllowed } from './supabase.js'
import { addDays, format, isValid, parseISO } from 'date-fns'

export { api } from './plannerApi.js'

const STORAGE_KEY = 'jio-demo-v1'
// 5: the backend planner (db.venues) and photos, itinerary order and seasons.
// 6: full standings kept for past seasons, and each friend's fixed meetups this season (no ties in the demo).
// Older saves start fresh, keeping the account and friends.
// 8: everyone starts with points this season and a finished last season.
const VERSION = 8
// How many ranked places to ask for per slot: enough to top a slot up to its maximum.
const RANKED_MAX = 10
// meeting: the least time the "finding the meeting point" loading bar shows (long enough for it to fill up). The planner answers in milliseconds
// with estimated travel times; with real routing it takes longer on its own.
const DELAY = { read: 80, plan: 300, write: 40, meeting: 1200 }
// Photos are stored as data URLs in local storage, which holds only a few megabytes, so a session keeps a few.
export const PHOTOS_MAX = 12
const STORAGE_FULL = "Could not save: this browser's storage is full. Remove some photos and try again."

// ── Storage ────────────────────────────────────────────────────────────────

// A starting number from mock/people.js. Ian is the signed-in person: only the demo account starts with the sample
// history, a person who signed up through the form starts with none. How to call: seeded(STARTING_MEETUPS, 'ian', false) -> 0
const seeded = (table, id, demo) => (id === HOST_ID && !demo ? 0 : table[id])

// Past meetup dates for a person, as the profile graph and the season standings both read them.
// How to call: historyOf('darius', false) -> ['2026-08-02', ...]
function historyOf(id, demo, now = new Date()) {
  return pastMeetupDates(id, seeded(STARTING_MEETUPS, id, demo), now, seeded(SEASON_MEETUPS, id, demo), seeded(LAST_SEASON_MEETUPS, id, demo))
}

// The leaderboard season now, the one before it, and how many points each person earned in each: their past
// meetups in those dates (the same dates as their profile graph). The last season is already finished, with the
// friends' standings kept and its winner paid, the way closeSeason leaves one. `demo`: Ian has the sample history.
function freshSeason(now = new Date(), demo = false) {
  const quarter = Season.quarterOf(now)
  const season = { number: 2, ...quarter }
  const last = { number: 1, ...Season.quarterOf(new Date(quarter.startsAt - 1)) }
  const day = (at) => format(new Date(at), 'yyyy-MM-dd')
  const dates = (id) => historyOf(id, demo, now)
  const earned = (id) => dates(id).filter((d) => d >= day(season.startsAt)).length * POINTS_PER_MEETUP
  const earnedLast = (id) => dates(id).filter((d) => d >= day(last.startsAt) && d < day(last.endsAt)).length * POINTS_PER_MEETUP
  const standings = PEOPLE.filter((p) => !isCommunity(p.id)).map((p) => ({ id: p.id, name: p.name, seasonPoints: earnedLast(p.id), allTime: seeded(STARTING_MEETUPS, p.id, demo) * POINTS_PER_MEETUP }))
  const winners = Season.seasonWinners(standings)
  const pastSeason = {
    ...last,
    prize: Season.SEASON_PRIZE,
    winners: winners.map((id) => ({ id, seasonPoints: earnedLast(id) })),
    standings: standings.map(({ id, seasonPoints }) => ({ id, seasonPoints })),
  }
  return { season, earned, pastSeason }
}

const defaultConditions = () => ({ rain: false, routing: true, sessionDay: false })

function freshDb(keep = {}) {
  const { season, earned, pastSeason } = freshSeason(new Date(), !!keep.user?.demo)
  const meetups = (id) => seeded(STARTING_MEETUPS, id, !!keep.user?.demo)
  const prize = (id) => (pastSeason.winners.some((w) => w.id === id) ? pastSeason.prize : 0)
  return {
    version: VERSION,
    user: keep.user || null,
    friends: keep.friends || [],
    sessions: [],
    // points: what each person can spend. seasonPoints: what they earned this season, for the leaderboard.
    stats: Object.fromEntries(PEOPLE.map((p) => [p.id, { meetups: meetups(p.id), points: meetups(p.id) * POINTS_PER_MEETUP + prize(p.id), seasonPoints: earned(p.id) }])),
    season,
    // Past seasons, latest first: { number, startsAt, endsAt, winners: [{ id, seasonPoints }], prize, standings }.
    pastSeasons: [pastSeason],
    redemptions: [],
    conditions: defaultConditions(),
    // Every venue the planner has sent, by id. Suggestions can be any of the backend's venues, not only VENUES.
    venues: {},
    seq: 1,
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isCount = (v) => typeof v === 'number' && Number.isFinite(v)
const isList = (v, check) => Array.isArray(v) && v.every(check)

// The account in a save, when it looks like one. How to call: validUser({ id: 'ian', name: 'Ian', username: 'ian' }) -> true
const validUser = (u) => isObject(u) && ['id', 'name', 'username'].every((key) => typeof u[key] === 'string')

// A session in a save, when every field the screens read without checking is there.
const validSession = (s) =>
  isObject(s) &&
  typeof s.id === 'string' &&
  Array.isArray(s.members) &&
  Array.isArray(s.deletedSlots) &&
  ['locations', 'prefs', 'options', 'votes'].every((key) => isObject(s[key]))

// Does a save with the current version hold every top-level field freshDb() makes, of the right kind?
// A version number alone is not proof: a hand-edited or half-written save would crash the first screen that reads it.
// How to call: hasShape(JSON.parse(localStorage.getItem('jio-demo-v1'))) -> true
function hasShape(saved) {
  return (
    isObject(saved) &&
    saved.version === VERSION &&
    (saved.user === null || validUser(saved.user)) &&
    isList(saved.friends, (f) => typeof f === 'string') &&
    isList(saved.sessions, validSession) &&
    isObject(saved.stats) &&
    PEOPLE.every((p) => isObject(saved.stats[p.id]) && ['meetups', 'points', 'seasonPoints'].every((key) => isCount(saved.stats[p.id][key]))) &&
    isObject(saved.season) &&
    ['number', 'startsAt', 'endsAt'].every((key) => isCount(saved.season[key])) &&
    isList(saved.pastSeasons, (x) => isObject(x) && isCount(x.endsAt) && Array.isArray(x.winners)) &&
    isList(saved.redemptions, isObject) &&
    isObject(saved.conditions) &&
    isObject(saved.venues) &&
    isCount(saved.seq)
  )
}

// What a replaced save keeps: the account and friends, when they look right.
const keepable = (saved) => ({
  user: validUser(saved.user) ? saved.user : null,
  friends: isList(saved.friends, (f) => typeof f === 'string') ? saved.friends : [],
})

// Where the save in `db` is written. A local account (and every account before Supabase) uses STORAGE_KEY. A real
// account has its own key, so two accounts in one browser never share a save and a local save is never shown to a
// real account. null: nobody is signed in after a real account signed out, so nothing is written and the local
// save, if there is one, is left alone.
let storageKey = STORAGE_KEY
// How to call: accountKey('7f3c...') -> 'jio-demo-v1:acct:7f3c...'
const accountKey = (authId) => `${STORAGE_KEY}:acct:${authId}`

// How to call: load() for the local save, or load(accountKey(user.id)) for a real account's
function load(key = STORAGE_KEY) {
  try {
    const saved = JSON.parse(localStorage.getItem(key))
    if (hasShape(saved)) {
      // Only the switches the demo knows (a save from before the crowd switch was cut still has one).
      const defaults = defaultConditions()
      for (const key of Object.keys(defaults)) if (typeof saved.conditions[key] === 'boolean') defaults[key] = saved.conditions[key]
      return { ...saved, conditions: defaults }
    }
    // An older save: its sessions point at venues this version cannot look up. Keep the account, start fresh.
    // A save of this version that fails the shape check is treated the same way.
    if (isObject(saved) && saved.version <= VERSION) return freshDb(keepable(saved))
  } catch {
    // No storage, or something unreadable: start fresh.
  }
  return freshDb()
}

let db = load()

// The state as text, for the save. A real account's date of birth stays out of it: it is a private field in the account
// (profile_private), so it is kept in memory for this visit and read back from the account or the session, never left
// in plain text in the browser after sign-out.
// How to call: asText() -> '{"version":8,"user":{"id":"ian","authId":"7f3c..."},...}' (no "dob" on a real account)
function asText(state = db) {
  if (!state.user?.authId || !('dob' in state.user)) return JSON.stringify(state)
  const { dob: _private, ...user } = state.user
  return JSON.stringify({ ...state, user })
}

// The state as last saved (or loaded), as text. A write that cannot be saved puts the demo back to this.
let stored = asText()
const listeners = new Set()

// Can storage take a small write at all? Without it (no storage, or a private window that refuses everything),
// the demo keeps working in memory for this visit. How to call: if (storageWorks()) ...
function storageWorks() {
  try {
    localStorage.setItem(`${STORAGE_KEY}:probe`, '1')
    localStorage.removeItem(`${STORAGE_KEY}:probe`)
    return true
  } catch {
    return false
  }
}

// Returns false only when storage works but refuses this write because it is full.
function save() {
  const text = asText()
  try {
    if (storageKey !== null) localStorage.setItem(storageKey, text)
  } catch {
    if (storageWorks()) return false
  }
  stored = text
  return true
}

// Swap the contents of an object in place, so everyone holding a reference sees the change.
function replaceContents(target, source) {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, source)
}

// Put the in-memory state back to what is stored. Sessions are restored in place: a write still waiting on the
// planner keeps working on the same object.
function rollback() {
  const back = JSON.parse(stored)
  const dob = db.user?.authId ? db.user.dob : undefined
  const live = new Map(db.sessions.map((s) => [s.id, s]))
  back.sessions = back.sessions.map((s) => {
    const same = live.get(s.id)
    if (!same) return s
    replaceContents(same, s)
    return same
  })
  replaceContents(db, back)
  // The date of birth is not in the save (see asText), so it is put back from memory.
  if (dob && db.user?.authId) db.user.dob = dob
}

function broadcast(event) {
  for (const fn of listeners) fn(event)
}

// Save, then tell subscribers. When the save fails the state goes back to what is stored and this throws, so
// the write that called it rejects: nothing fails silently, and nothing is half-saved.
// How to call: emit({ type: 'session', sessionId: 's1' })
function emit(event) {
  if (!save()) {
    rollback()
    throw new Error(STORAGE_FULL)
  }
  broadcast(event)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const clone = (value) => (value == null ? value : structuredClone(value))

// Live updates: fn({ type, sessionId }) runs after every write. Returns a function that stops listening.
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// ── Lookups ────────────────────────────────────────────────────────────────

const personById = (id) => PEOPLE.find((p) => p.id === id)
// Who is on Ian's leaderboard: his circle, and anyone else on Jio once he has added them as a friend.
const leaderboardPeople = () => PEOPLE.filter((p) => !isCommunity(p.id) || db.friends.includes(p.id))
const areaById = (id) => AREAS.find((a) => a.id === id)
const venueById = (id) => db.venues[id] || VENUES.find((v) => v.id === id)

function nameOf(id) {
  if (id === HOST_ID && db.user) return db.user.name
  return personById(id)?.name || ''
}

function sessionById(id) {
  const session = db.sessions.find((s) => s.id === id)
  if (!session) throw new Error('This session does not exist.')
  settleInvites(session)
  return session
}

// Pending invites. In the demo a friend accepts on their own a moment after being invited (their phone would ask
// them): each invite stores when it will be accepted, a timer accepts it then, and reading a session accepts any
// whose time has passed (after a reload, the timers are gone). Returns true when someone joined.
const ACCEPT_AFTER = 1400
const ACCEPT_GAP = 900
// An invite held longer than this gets no timer (a page that stays open for days should not hold one); a read accepts it.
const TIMER_MAX = 60 * 1000
function settleInvites(session, now = Date.now()) {
  let changed = false
  for (const member of session.members) {
    if (member.state === 'invited' && member.acceptAt <= now) {
      member.state = 'joined'
      delete member.acceptAt
      changed = true
    }
  }
  return changed
}
function scheduleAccept(session, at) {
  setTimeout(() => {
    const current = db.sessions.find((s) => s.id === session.id)
    if (current && settleInvites(current)) touch(current, 'session')
  }, Math.max(0, at - Date.now()) + 20)
}

const activeIds = (session) => session.members.filter((m) => m.state === 'joined').map((m) => m.id)
const windowOf = (session) => ({ windowStart: P.toMinutes(session.start), windowEnd: P.toMinutes(session.end) })

function todayKey() {
  return format(new Date(), 'yyyy-MM-dd')
}

function isSessionDay(session) {
  return session.date === todayKey() || db.conditions.sessionDay
}

// ── Planner, run on the backend ────────────────────────────────────────────

// Each person with a start location, as the backend expects them: start and end as points.
function membersFor(session) {
  return activeIds(session)
    .filter((id) => session.locations[id]?.start)
    .map((id) => {
      const start = areaById(session.locations[id].start.areaId)
      const end = endPlaceOf(session, id)
      return { id, name: nameOf(id), start: { lat: start.lat, lng: start.lng }, end: { lat: end.lat, lng: end.lng } }
    })
}

// Sessions whose meeting area the planner is working out right now. getSession shows it as `findingMeeting`.
const finding = new Set()

// The meeting area, in the shape meetingResultLine and recalculate read: { areaId, method, times, maxMinutes, ... }.
async function computeMeeting(session) {
  const members = membersFor(session)
  if (members.length < P.MIN_LOCATIONS) return null
  // While the group is collecting locations, the meeting point waits for everyone. Once the plan has moved on, a
  // late location (someone invited later) is worked in through the re-plan prompt instead.
  if (session.status === 'locating' && members.length < activeIds(session).length) return null
  // Show the new location and the "finding" animation straight away; the answer follows.
  finding.add(session.id)
  let data
  try {
    emit({ type: 'pending', sessionId: session.id })
    ;[data] = await Promise.all([planner.meetingArea({ members, routing: db.conditions.routing }), wait(DELAY.meeting)])
  } finally {
    finding.delete(session.id)
  }
  const times = Object.fromEntries(Object.entries(data.travelByMember).map(([id, minutes]) => [id, Math.round(minutes)]))
  const minutes = Object.values(times)
  const same = members.every((m) => P.distanceKm(m.start, members[0].start) < P.SAME_PLACE_KM)
  return {
    areaId: data.area.id,
    method: same ? 'same' : data.method === 'station' ? 'fairest' : 'centre',
    times,
    maxMinutes: Math.max(...minutes),
    totalMinutes: minutes.reduce((sum, m) => sum + m, 0),
    count: members.length,
    approximate: data.approximate,
  }
}

function activePrefs(session) {
  const ids = activeIds(session)
  return Object.fromEntries(Object.entries(session.prefs).filter(([id]) => ids.includes(id)))
}

// What people browse and vote on: every category at once, so nobody has to pick categories first. Each is ranked
// as if it were the only stop: Eat at lunch or dinner, the others in the middle of the session (at its start most
// shops and bars are not open yet). Slot ids are the category names.
function slotsOf(session) {
  const prefs = activePrefs(session)
  const window = windowOf(session)
  return P.CATEGORIES.filter((c) => !session.deletedSlots.includes(c)).flatMap((c) => {
    const everyone = Object.fromEntries(activeIds(session).map((id) => [id, { categories: [c], until: prefs[id]?.until ?? null }]))
    return P.buildSlots({ prefs: everyone, ...window }).map((slot) => {
      if (c === 'eat') return slot
      const planEnd = P.groupStayUntil(everyone, window.windowEnd)
      const start = window.windowStart + Math.floor((planEnd - window.windowStart - slot.duration) / 2 / 15) * 15
      return { ...slot, start, time: P.fromMinutes(start) }
    })
  })
}

// The plan the votes make: only the categories someone voted in, laid out back to back in the session window.
function planSlotsOf(session) {
  const prefs = activePrefs(session)
  const voted = P.CATEGORIES.filter((c) => Object.keys(session.votes[c] || {}).length && !session.deletedSlots.includes(c))
  const everyone = Object.fromEntries(activeIds(session).map((id) => [id, { categories: voted, until: prefs[id]?.until ?? null }]))
  return P.buildSlots({ prefs: everyone, ...windowOf(session) })
}

function endPlaceOf(session, id) {
  const loc = session.locations[id]
  const areaId = loc?.end?.areaId || loc?.start?.areaId
  return areaId ? areaById(areaId) : null
}

// Rank one slot on the backend. The slot's current options are always scored, so they come back in `current`
// while they still fit. Every venue in the answer is remembered, so options and the itinerary can show it later.
async function rankSlot(session, slot, slots, currentOptionIds = session.options[slot.id] || []) {
  const ranked = await planner.rankSlot({
    members: membersFor(session),
    centre: areaById(session.meeting.areaId),
    date: session.date,
    slot,
    lastStop: slots[slots.length - 1]?.id === slot.id,
    currentOptionIds,
    conditions: db.conditions,
    radiusMeters: session.radius || undefined,
    topN: RANKED_MAX,
  })
  for (const o of [...ranked.options, ...ranked.current]) db.venues[o.venue.id] = o.venue
  return ranked
}

const rankAll = (session, slots) => Promise.all(slots.map((slot) => rankSlot(session, slot, slots)))
// The categories people browse are not stops in a plan yet, so none is ranked as the last stop (near an MRT).
const rankBrowse = (session, slots) => Promise.all(slots.map((slot) => rankSlot(session, slot, [])))

// Friends can change things while the planner is still answering (the demo panel does this on purpose).
// Each sync takes a ticket, and only the latest one for a session applies its answer.
const tickets = {}
const takeTicket = (session, kind) => {
  const key = `${session.id}:${kind}`
  const ticket = (tickets[key] = (tickets[key] || 0) + 1)
  return () => ticket === tickets[key]
}

// Every place that fits a slot, best first: the suggestions, then current options ranked further down.
const rankedIds = (ranked) => [...new Set([...ranked.options, ...ranked.current].map((o) => o.venue.id))]

// Keep the options in step with the current slots: drop options that no longer fit, top up to three,
// and drop votes for options or people that are gone.
async function syncOptions(session) {
  if (!session.meeting || session.status !== 'voting') return
  const slots = slotsOf(session)
  const isLatest = takeTicket(session, 'options')
  const rankings = await rankBrowse(session, slots)
  // Applied once every slot is ranked, to the session as it is now, so a vote cast meanwhile is kept.
  if (!isLatest() || session.status !== 'voting') return
  const ids = activeIds(session)
  const nextOptions = {}
  const nextVotes = {}
  slots.forEach((slot, i) => {
    nextOptions[slot.id] = P.reconcileOptions(session.options[slot.id], rankedIds(rankings[i]))
    const votes = session.votes[slot.id] || {}
    nextVotes[slot.id] = Object.fromEntries(Object.entries(votes).filter(([person, venue]) => ids.includes(person) && nextOptions[slot.id].includes(venue)))
  })
  session.options = nextOptions
  session.votes = nextVotes
}

// The sentence that follows a banner when the meeting area moved and took the votes with it.
const VOTES_CLEARED = 'Votes for places were cleared.'
// Does a session hold any vote for a place? How to call: hasVotes(session) -> true
const hasVotes = (session) => Object.values(session.votes || {}).some((votes) => Object.keys(votes).length > 0)

// A start or end location changed, a late location arrived, or someone opted out.
async function applyTrigger(session, trigger) {
  const isLatest = takeTicket(session, 'meeting')
  const next = await computeMeeting(session)
  if (!isLatest()) return
  const previous = session.meeting
  const outcome = P.recalculate({
    status: session.status,
    previous,
    next,
    trigger,
    previousName: previous ? areaById(previous.areaId).name : null,
    nextName: next ? areaById(next.areaId).name : null,
  })
  if (outcome.mode === 'prompt') {
    session.replan = { reason: outcome.reason, trigger }
    return
  }
  if (outcome.mode !== 'apply') return
  session.meeting = next
  // Votes that were there and are gone: the banner says so, and SessionNotices shows it (votesCleared).
  const cleared = outcome.clearVotes && hasVotes(session)
  if (outcome.clearVotes) session.votes = {}
  if (outcome.refreshSuggestions) session.options = {}
  await syncOptions(session)
  if (outcome.banner) session.banner = { text: cleared ? `${outcome.banner} ${VOTES_CLEARED}` : outcome.banner, at: Date.now(), ...(cleared ? { votesCleared: true } : {}) }
}

// For a write that needs the planner: if the planner cannot answer, put the session back as it was, so nothing
// is half-saved (a location kept but not shown, Voting with no options). The caller still gets the error.
async function orUndo(session, change) {
  const before = clone(session)
  try {
    return await change()
  } catch (err) {
    for (const key of Object.keys(session)) delete session[key]
    Object.assign(session, before)
    // Save the session as it was, and show it again (a "pending" update may have shown the change already).
    // If storage refuses even that, the caller still gets the first error, which is the one worth reading.
    save()
    broadcast({ type: 'pending', sessionId: session.id })
    throw err
  }
}

// Save, tell subscribers, and answer with the session as getSession would.
function touch(session, type) {
  session.updatedAt = Date.now()
  emit({ type, sessionId: session.id })
  return summary(session)
}

// ── Account ────────────────────────────────────────────────────────────────

// The account, with its home area's name. It is always `id: HOST_ID` (the local id of "me"). `authId` is the Supabase
// user id of a real account and null for a local one; `local` is true for a local account (the demo account, and every
// account when Supabase is not set up). `email` is '' when none is known.
// How to call: account() -> { id: 'ian', authId: null, local: true, email: 'ian@jio.demo', name: 'Ian', ... }
function account() {
  if (!db.user) return null
  return {
    ...clone(db.user),
    email: db.user.email || '',
    authId: db.user.authId || null,
    local: !db.user.authId,
    homeAreaName: areaById(db.user.homeAreaId)?.name || '',
  }
}

// Is sign-up and sign-in against a real Supabase project? False: every account is local, as before.
// How to call: if (realAccountsOn()) showLoginLink()
export function realAccountsOn() {
  return auth.configured()
}

// Real accounts being switched to, by Supabase user id, so two callers share one switch.
const adopting = new Map()
// How many sign-up, sign-in or sign-out calls of this file are running, so the session listener does not answer its own.
let acting = 0

// Make a real account the signed-in one: load its own save (or start a fresh one) and write to its own key.
// `known`: the details just typed at sign-up ({ name, username, dob, homeAreaId, photo, friends }); without it the
// profile comes from Supabase (when `fetchProfile` is true), then from the save, then from the sign-up metadata, so a
// failed read still signs in. At start-up `fetchProfile` is false: the person is shown from the save at once and the
// profile is read afterwards (see refreshProfile).
// How to call: await adoptAccount({ id: authId, email: 'sam@example.com', username: 'sam', dob: '2001-05-06' })
async function adoptAccount(sessionUser, known = null, fetchProfile = true) {
  let remote = null
  if (!known && fetchProfile) {
    try {
      remote = await auth.loadProfile(sessionUser.id)
    } catch {
      remote = null
    }
  }
  const key = accountKey(sessionUser.id)
  const found = load(key)
  const mine = found.user?.authId === sessionUser.id ? found : null
  const was = mine?.user
  const pick = known || remote || {}
  const user = {
    id: HOST_ID,
    authId: sessionUser.id,
    email: sessionUser.email || was?.email || '',
    name: pick.name || was?.name || sessionUser.username || '',
    username: pick.username || was?.username || sessionUser.username || '',
    // The date of birth is never read from the save (it is not written to it): it comes from the account or the session.
    dob: pick.dob || sessionUser.dob || '',
    // A photo stays in this browser: it is a data URL in the save, never uploaded.
    photo: known ? known.photo || '' : was?.photo || '',
    homeAreaId: pick.homeAreaId || was?.homeAreaId || '',
  }
  const { conditions } = db
  if (mine) {
    db = { ...mine, user }
  } else {
    db = freshDb({ user, friends: [...(known?.friends || [])] })
    db.conditions = conditions
  }
  storageKey = key
  stored = asText()
  // A save that cannot be written (storage full or missing) does not stop sign-in: the account works in memory.
  save()
  broadcast({ type: 'user' })
  return account()
}

// How to call: await adopt(sessionUser) (the same account asked for twice at once is switched to once)
//   await adopt(sessionUser, null, false) switches without reading the profile first (start-up)
function adopt(sessionUser, known = null, fetchProfile = true) {
  if (known) return adoptAccount(sessionUser, known)
  if (!adopting.has(sessionUser.id)) {
    adopting.set(sessionUser.id, adoptAccount(sessionUser, null, fetchProfile).finally(() => adopting.delete(sessionUser.id)))
  }
  return adopting.get(sessionUser.id)
}

// Read the signed-in person's profile from their account and bring the account up to date with it: the name, username,
// date of birth and home area. A field changed here while the read was running is left as it is. Quiet when the read
// fails or the person has changed. Called after the first screen is up, never waited for.
// How to call: await refreshProfile()
export async function refreshProfile() {
  const authId = db.user?.authId
  if (!authId) return
  const before = { ...db.user }
  let remote
  try {
    remote = await auth.loadProfile(authId)
  } catch {
    return
  }
  if (!remote || db.user?.authId !== authId) return
  const fresh = { name: remote.name, username: remote.username, dob: remote.dob, homeAreaId: remote.homeAreaId }
  const changes = Object.fromEntries(Object.entries(fresh).filter(([key, value]) => value && db.user[key] === before[key] && db.user[key] !== value))
  if (Object.keys(changes).length === 0) return
  db.user = { ...db.user, ...changes }
  // A save that cannot be written does not matter here: the change is in memory.
  save()
  broadcast({ type: 'user' })
}

// End the Supabase session on this browser, if Supabase is set up. Never throws.
// How to call: await endSession()
async function endSession() {
  if (!auth.configured()) return
  acting += 1
  try {
    await auth.signOut()
  } finally {
    acting -= 1
  }
}

// Nobody is signed in any more, but a real account's save stays where it is. Nothing is written until someone signs up.
// How to call: detachAccount()
function detachAccount() {
  const { conditions } = db
  db = freshDb()
  db.conditions = conditions
  storageKey = null
  stored = asText()
}

// The Supabase session changed without this app asking: another tab signed out (or in), or the refresh token expired.
auth.onChange(({ event, user }) => {
  if (acting > 0 || adopting.size > 0) return
  if (event === 'signedOut' && db.user?.authId) {
    detachAccount()
    broadcast({ type: 'reset', reason: 'session-ended' })
  } else if (event === 'signedIn' && user && db.user?.authId !== user.id && (db.user?.authId || !db.user)) {
    // Another tab signed in as someone else: getUser switches to them.
    setTimeout(() => broadcast({ type: 'user' }), 0)
  } else if (event === 'refreshed') {
    // A token was refreshed, so Supabase can be reached again: a "could not be reached" note is out of date.
    broadcast({ type: 'reachable' })
  }
})

// A local account with no Supabase account behind it is not a login when real accounts are on, unless this build keeps
// local accounts (development, or VITE_ALLOW_LOCAL_ACCOUNTS=1). The local save is left where it is and is not shown.
// How to call: dropStrayLocalAccount()
function dropStrayLocalAccount() {
  if (auth.configured() && !localAccountsAllowed() && db.user && !db.user.authId) detachAccount()
}
dropStrayLocalAccount()

// Who is signed in, and whether Supabase could be asked. With Supabase set up, a stored session decides who is signed
// in: its account's own save is loaded (the profile is not read here; see refreshProfile). A session that cannot be
// checked because Supabase cannot be reached (or does not answer within `bounded` milliseconds) is neither kept nor
// thrown away: the person is shown from the saved copy and `unreachable` is true. With no session, the answer is the
// local account in the local save, when this build keeps local accounts, or null.
// How to call: const { user, unreachable } = await whoIsSignedIn({ bounded: auth.timing.startMs })
async function whoIsSignedIn({ bounded = 0 } = {}) {
  let unreachable = false
  if (auth.configured()) {
    const asking = auth.checkSession()
    const answer = bounded ? await Promise.race([asking, auth.pause(bounded).then(() => ({ user: null, unreachable: true }))]) : await asking
    unreachable = answer.unreachable
    const session = answer.user || (unreachable ? auth.savedUser() : null)
    if (session) {
      if (db.user?.authId !== session.id) await adopt(session, null, false)
    } else if (db.user?.authId && !unreachable) {
      detachAccount()
    }
    if (!session) dropStrayLocalAccount()
  }
  return { user: account(), unreachable }
}

// The signed-in person, or null.
// How to call: const user = await getUser() (null when nobody is signed in)
export async function getUser() {
  await wait(DELAY.read)
  return (await whoIsSignedIn()).user
}

// The signed-in person for the first screen: from the saved copy, within a fixed time, without reading the profile.
// `unreachable` is true when the session could not be checked, so the screen can say so.
// How to call: const { user, unreachable } = await startUser()
export async function startUser() {
  await wait(DELAY.read)
  return whoIsSignedIn({ bounded: auth.timing.startMs })
}

// Sign-up rules, the same as the database's: a username is 3 to 20 lowercase letters, numbers or underscores,
// a name is 1 to 50 characters, and a date of birth is a real date from 1900 up to today.
// Each message is shown under its field, so it names the field.
const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/
const NAME_MAX = 50
const DOB_MIN = '1900-01-01'

// How to call: assertUsername('ian_99') (throws an Error with a message for the field when it is not allowed)
function assertUsername(username) {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    throw new Error('Username must be 3 to 20 characters: lowercase letters, numbers or underscores.')
  }
}

// How to call: assertName('Ian')
function assertName(name) {
  const text = typeof name === 'string' ? name.trim() : ''
  if (!text) throw new Error('Enter your name.')
  if (text.length > NAME_MAX) throw new Error(`Your name can be up to ${NAME_MAX} characters.`)
}

// How to call: assertDob('2004-03-18')
function assertDob(dob) {
  const match = typeof dob === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob) : null
  if (!match) throw new Error('Enter your date of birth as YYYY-MM-DD.')
  const [year, month, day] = match.slice(1).map(Number)
  // Date rolls 31 February over to March, so a real date is one that survives the round trip.
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error('That date of birth does not exist.')
  }
  if (dob > todayKey()) throw new Error('Your date of birth cannot be in the future.')
  if (dob < DOB_MIN) throw new Error('Your date of birth cannot be before 1900.')
}

// profile: { email, name, username, dob ('YYYY-MM-DD'), photo?, homeAreaId, friends?, demo? }. Rejects with a message fit
// to show under the field when the name, username or date of birth breaks a rule.
// `demo: true` is for the demo tools' account only: it starts with the sample history in mock/people.js (10 meetups
// and 1,000 JioCoins). Anyone else starts with no meetups, no JioCoins and no rank.
//
// With Supabase set up, a sign-up that is not `demo` creates a real account: `profile.password` goes to Supabase and
// nowhere else. It resolves with the account as soon as the account exists, without waiting for its name and home area
// to be written to it; if that write fails, a `{ type: 'sync-failed', message }` event follows (`syncError` is always
// ''). When the project wants the email confirmed first it resolves with
// `{ needsConfirmation: true, email }` and nobody signed in. It rejects with the messages in lib/auth.js.
// How to call: const user = await signUp({ email, password, name, username, dob, homeAreaId, friends })
export async function signUp(profile) {
  await wait(DELAY.write)
  assertName(profile.name)
  assertUsername(profile.username)
  assertDob(profile.dob)
  if (auth.configured() && !profile.demo) return signUpReal(profile)
  // The demo account is always local, even with Supabase set up, and ends any real session first.
  await endSession()
  // The demo account is always the host, Ian's id.
  const user = {
    id: HOST_ID,
    email: profile.email,
    name: profile.name.trim(),
    username: profile.username,
    dob: profile.dob,
    photo: profile.photo || '',
    homeAreaId: profile.homeAreaId,
    ...(profile.demo ? { demo: true } : {}),
  }
  // Ian's starting numbers (stats, season standings) depend on the kind of account, so they are made again for it.
  const { conditions } = db
  db = freshDb({ user, friends: [...(profile.friends || [])] })
  db.conditions = conditions
  if (storageKey !== STORAGE_KEY) {
    // Coming from a real account (or from nobody): a local account writes to the local save again.
    storageKey = STORAGE_KEY
    stored = asText()
  }
  emit({ type: 'user' })
  return account()
}

// A real sign-up. The profile's other fields (photo, friends) stay in this browser, in the account's own save.
// How to call: await signUpReal({ email, password, name, username, dob, homeAreaId })
async function signUpReal(profile) {
  const name = profile.name.trim()
  acting += 1
  try {
    const result = await auth.signUp({
      email: profile.email,
      password: profile.password,
      username: profile.username,
      dob: profile.dob,
      name,
      homeAreaId: profile.homeAreaId,
    })
    if (result.needsConfirmation) return { needsConfirmation: true, email: result.user.email }
    const known = { name, username: profile.username, dob: profile.dob, homeAreaId: profile.homeAreaId, photo: profile.photo, friends: profile.friends }
    const mine = await adopt(result.user, known)
    // The name and home area are written to the account in the background; a failure is announced when it happens.
    result.profileWrite?.then((message) => {
      if (message) broadcast({ type: 'sync-failed', message })
    })
    return { ...mine, syncError: '' }
  } finally {
    acting -= 1
  }
}

// Sign in to a real account with its email and password, and bring back that account's own save on this browser (a
// browser with no save for it starts fresh). Rejects with the messages in lib/auth.js; the same message whether the
// email is registered or not.
// How to call: const user = await signIn({ email: 'sam@example.com', password: 'Sup3r-secret' })
export async function signIn({ email, password }) {
  await wait(DELAY.write)
  acting += 1
  try {
    const { user } = await auth.signIn({ email, password })
    return await adopt(user)
  } finally {
    acting -= 1
  }
}

// What a signed-in person may change on a real account: the name, photo, home area and date of birth. The username
// and email are not editable.
const REAL_EDITABLE = ['name', 'photo', 'homeAreaId', 'dob']

// patch: { name?, photo?, homeAreaId?, dob?, ... }. A local account takes any field, as before. A real account takes
// the four it may edit, and the name, home area and date of birth are also written to Supabase. The change is kept
// here even when that write fails: the answer then carries `syncError` with a message to show.
// How to call: const user = await updateUser({ name: 'Sam T.' })
export async function updateUser(patch) {
  await wait(DELAY.write)
  if (!db.user?.authId) {
    db.user = { ...db.user, ...patch }
    emit({ type: 'user' })
    return account()
  }
  const allowed = Object.fromEntries(REAL_EDITABLE.filter((key) => key in patch).map((key) => [key, patch[key]]))
  db.user = { ...db.user, ...allowed }
  emit({ type: 'user' })
  const { photo, ...remote } = allowed
  let syncError = ''
  if (Object.keys(remote).length > 0) {
    try {
      await auth.saveProfile(db.user.authId, remote)
    } catch (err) {
      syncError = err.message
    }
  }
  return { ...account(), syncError }
}

// A local account: erases the account and every meetup, as before. A real account: ends this browser's session and
// leaves the account's save where it is for the next sign-in. Resolves even when Supabase cannot be reached.
// How to call: await signOut()
export async function signOut() {
  await wait(DELAY.write)
  const local = !!db.user && !db.user.authId
  if (!local) await endSession()
  const wasLocalSave = storageKey === STORAGE_KEY
  db = freshDb()
  if (!wasLocalSave) {
    storageKey = null
    stored = asText()
  }
  emit({ type: 'reset' })
}

// Rejects with a message fit to show under the field when the username breaks the rules. With Supabase set up this asks
// the database function username_available; without it, the local list.
// How to call: const { available } = await checkUsername('sam')
export async function checkUsername(username) {
  await wait(DELAY.read)
  assertUsername(username)
  if (auth.configured()) return { available: await auth.usernameAvailable(username) }
  const taken = PEOPLE.some((p) => p.id !== HOST_ID && p.username === username)
  return { available: !taken }
}

// ── People, friends and the leaderboard ────────────────────────────────────

function publicPerson(id) {
  const base = personById(id)
  const isMe = id === HOST_ID && db.user
  return {
    id,
    name: isMe ? db.user.name : base.name,
    username: isMe ? db.user.username : base.username,
    photo: isMe ? db.user.photo : '',
    homeAreaId: isMe ? db.user.homeAreaId : base.homeAreaId,
    homeArea: areaById(isMe ? db.user.homeAreaId : base.homeAreaId)?.name || '',
    meetups: db.stats[id].meetups,
    points: db.stats[id].points,
    isFriend: db.friends.includes(id),
  }
}

export async function listPeople() {
  await wait(DELAY.read)
  return PEOPLE.filter((p) => p.id !== HOST_ID).map((p) => publicPerson(p.id))
}

export async function getPerson(id) {
  await wait(DELAY.read)
  if (!personById(id)) throw new Error('This person does not exist.')
  const sessions = db.sessions
    .filter((s) => s.members.some((m) => m.id === id))
    .map((s) => ({ id: s.id, title: s.title, date: s.date, status: s.status, areaName: s.meeting ? areaById(s.meeting.areaId).name : '' }))
  const activity = [
    ...sessions.filter((s) => s.status === 'completed').map((s) => ({ date: s.date, text: `Successful meetup at ${s.areaName}`, sessionId: s.id })),
    ...(PAST_ACTIVITY[id] || []),
    ...db.pastSeasons
      .filter((x) => x.winners.some((w) => w.id === id))
      .map((x) => ({ date: format(new Date(x.endsAt), 'yyyy-MM-dd'), text: `Won season ${x.number} · +${coins(x.prize)}` })),
  ].sort((a, b) => b.date.localeCompare(a.date))
  // The activity graph: one entry per day with a meetup, plus days with an upcoming session (planned).
  const counts = {}
  for (const date of historyOf(id, !!db.user?.demo)) counts[date] = (counts[date] || 0) + 1
  for (const s of sessions.filter((x) => x.status === 'completed')) counts[s.date] = (counts[s.date] || 0) + 1
  const planned = sessions.filter((x) => !['completed', 'cancelled'].includes(x.status)).map((x) => x.date)
  const history = Object.entries(counts).map(([date, count]) => ({ date, count }))
  return { ...publicPerson(id), sessions, activity, history, planned }
}

export async function setFriend(id, isFriend) {
  await wait(DELAY.write)
  db.friends = isFriend ? [...new Set([...db.friends, id])] : db.friends.filter((f) => f !== id)
  emit({ type: 'friends' })
  return [...db.friends]
}

// ── Seasons ────────────────────────────────────────────────────────────────

// What decides a season: points earned this season, then all-time points from meetups, then the name.
// How to call: standingOf('ian') -> { id, name, seasonPoints, allTime }
const standingOf = (id) => ({ id, name: nameOf(id), seasonPoints: db.stats[id].seasonPoints, allTime: db.stats[id].meetups * POINTS_PER_MEETUP })

// End the current season at `at`: the winner get the prize to spend, then season points start again.
function closeSeason(at) {
  const ended = { ...db.season, endsAt: at }
  const winners = Season.seasonWinners(leaderboardPeople().map((p) => standingOf(p.id)))
  for (const id of winners) db.stats[id].points += Season.SEASON_PRIZE
  // standings: everyone's season total, so the leaderboard can show a past season in full.
  const standings = leaderboardPeople().map((p) => ({ id: p.id, seasonPoints: db.stats[p.id].seasonPoints }))
  db.pastSeasons.unshift({ ...ended, prize: Season.SEASON_PRIZE, winners: winners.map((id) => ({ id, seasonPoints: db.stats[id].seasonPoints })), standings })
  for (const p of PEOPLE) db.stats[p.id].seasonPoints = 0
  db.season = Season.nextSeason(db.season, at)
}

// Seasons that ran out while nobody had the app open end now, in order. Returns true when one ended.
// It changes memory only: the caller saves it, together with the rest of its write.
function catchUpSeasons(now = Date.now()) {
  let ended = false
  while (now >= db.season.endsAt) {
    closeSeason(db.season.endsAt)
    ended = true
  }
  return ended
}

function publicSeason(season) {
  return {
    ...clone(season),
    winners: (season.winners || []).map((w) => ({ ...w, name: nameOf(w.id), isMe: w.id === HOST_ID })),
  }
}

// The season now, the prize, and the last few seasons with their winners.
export async function getSeason() {
  await wait(DELAY.read)
  if (catchUpSeasons()) emit({ type: 'stats' })
  return { ...publicSeason(db.season), prize: Season.SEASON_PRIZE, past: db.pastSeasons.slice(0, 4).map(publicSeason) }
}

// Demo: end the season now instead of waiting for the end of the quarter. Returns the season that ended.
// The next season runs to the end of the calendar quarter it starts in.
export async function endSeason() {
  await wait(DELAY.write)
  catchUpSeasons()
  closeSeason(Date.now())
  emit({ type: 'stats' })
  return publicSeason(db.pastSeasons[0])
}

// One ranking: points earned this season. Ties share a rank, in the order that picks the season's winner.
// Nobody is ranked at 0 points: `rank` is null until a person has earned some.
export async function getLeaderboard() {
  await wait(DELAY.read)
  if (catchUpSeasons()) emit({ type: 'stats' })
  return ranked(leaderboardPeople().map((p) => ({ id: p.id, seasonPoints: db.stats[p.id].seasonPoints })))
}

// A past season's final ranking, the same shape as getLeaderboard. [] for a season with no standings kept.
export async function getSeasonStandings(number) {
  await wait(DELAY.read)
  const past = db.pastSeasons.find((s) => s.number === number)
  return past?.standings ? ranked(past.standings) : []
}

// rows: [{ id, seasonPoints }], ranked highest first by Season.compareStandings (this season, then all-time, then
// name). Ties on this season's JioCoins share a rank; anyone with none this season has no rank yet (rank null).
// seasonMeetups: meetups finished this season. Season JioCoins only come from finished meetups, so it is always
// seasonPoints / POINTS_PER_MEETUP and the two never disagree.
// How to call: ranked([{ id: 'ian', seasonPoints: 300 }]) -> [{ ...person, seasonPoints, seasonMeetups, rank, isMe }]
function ranked(rows) {
  const sorted = rows
    .map((r) => ({ ...publicPerson(r.id), seasonPoints: r.seasonPoints, seasonMeetups: Math.round(r.seasonPoints / POINTS_PER_MEETUP) }))
    .sort((a, b) => Season.compareStandings({ ...a, allTime: a.meetups * POINTS_PER_MEETUP }, { ...b, allTime: b.meetups * POINTS_PER_MEETUP }))
  let rank = 0
  let last = null
  return sorted.map((row, i) => {
    if (!row.seasonPoints) return { ...row, rank: null, isMe: row.id === HOST_ID }
    if (row.seasonPoints !== last) {
      rank = i + 1
      last = row.seasonPoints
    }
    return { ...row, rank, isMe: row.id === HOST_ID }
  })
}

// ── Places ─────────────────────────────────────────────────────────────────

export async function listAreas() {
  await wait(DELAY.read)
  return clone(AREAS)
}

// Search for a start or end location by place name, address or postal code.
export async function searchPlaces(query) {
  await wait(DELAY.read)
  const q = query.trim().toLowerCase()
  if (!q) return []
  const areas = AREAS.filter((a) => a.name.toLowerCase().includes(q)).map((a) => ({ id: a.id, label: a.name, sub: 'MRT station and area', areaId: a.id }))
  const addresses = ADDRESSES.filter((a) => a.label.toLowerCase().includes(q) || a.postal.startsWith(q)).map((a) => ({
    id: a.id,
    label: a.label,
    sub: `Singapore ${a.postal} · ${areaById(a.areaId).name}`,
    areaId: a.areaId,
  }))
  return [...areas, ...addresses].slice(0, 8)
}

// The known area for a pair of coordinates, or null outside Singapore.
export async function placeFromCoords(lat, lng) {
  await wait(DELAY.read)
  const point = { lat, lng }
  if (!P.inSingapore(point)) return null
  const area = P.nearest(point, AREAS)
  return { id: `here-${area.id}`, label: 'Current location', sub: area.name, areaId: area.id }
}

// Places near an area, for Home. Each has its distance in km.
const withDistance = (venue, home) => ({ ...clone(venue), distanceKm: Math.round(P.distanceKm(home, venue) * 10) / 10 })

export async function nearbyPlaces(areaId) {
  await wait(DELAY.plan)
  const home = areaById(areaId) || AREAS[0]
  return VENUES.map((v) => withDistance(v, home)).sort((a, b) => a.distanceKm - b.distanceKm)
}

// One place for the detail view: what its card shows (with the same distance), its address and its reviews.
export async function getPlace(id, areaId) {
  await wait(DELAY.read)
  const venue = VENUES.find((v) => v.id === id)
  if (!venue) throw new Error('This place does not exist.')
  return { ...withDistance(venue, areaById(areaId) || AREAS[0]), reviews: reviewsFor(venue) }
}

// ── Sessions ───────────────────────────────────────────────────────────────

// Locations as other people may see them: the area only. The exact label is kept for the viewer (Ian) alone.
function publicLocations(session) {
  const place = (loc, own) => {
    if (!loc) return null
    const area = areaById(loc.areaId)
    return { areaId: area.id, name: area.name, lat: area.lat, lng: area.lng, ...(own ? { label: loc.label } : {}) }
  }
  return Object.fromEntries(
    Object.entries(session.locations).map(([id, loc]) => [id, { start: place(loc.start, id === HOST_ID), end: place(loc.end, id === HOST_ID) }]),
  )
}

// A session as the screens read it. Photos are big (data URLs), so a session carries only their count:
// getPhotos has the pictures.
function summary(session) {
  // The plan forming so far: the categories with votes, at their times.
  const slots = session.status === 'voting' && session.meeting ? planSlotsOf(session) : []
  const area = session.meeting ? areaById(session.meeting.areaId) : null
  const { photos, confirmedRanking, ...rest } = session
  return {
    ...clone(rest),
    locations: publicLocations(session),
    area: area ? { ...area } : null,
    photoCount: (photos || []).length,
    resultLine: area ? P.meetingResultLine(session.meeting, area.name) : '',
    // Only the routing fallback needs explaining on screen; the fairest result speaks for itself.
    areaNote: session.meeting?.method === 'centre' ? 'Routing unavailable. Showing the geographic centre.' : '',
    activeIds: activeIds(session),
    areaName: session.meeting ? areaById(session.meeting.areaId).name : '',
    isToday: isSessionDay(session),
    findingMeeting: finding.has(session.id),
    // The search radius the group chose, in metres, or null to let the planner widen on its own.
    radius: session.radius ?? null,
    slots: slots.map((s) => ({ ...s, optionCount: (session.options[s.id] || []).length })),
  }
}

export async function listSessions() {
  await wait(DELAY.read)
  db.sessions.forEach((s) => settleInvites(s))
  return db.sessions.map(summary).sort((a, b) => b.createdAt - a.createdAt)
}

export async function getSession(id) {
  await wait(DELAY.read)
  return summary(sessionById(id))
}

// hostId: the app always makes the signed-in person the host. A friend's id makes a session that friend hosts, with the
// signed-in person already a guest in it (the demo's showcase uses it to show a session the person does not run).
// How to call: await createSession({ title: 'Dinner', date: '2026-10-17', start: '18:00', end: '21:00', hostId: 'darius' })
export async function createSession({ title, date, start, end, hostId = HOST_ID }) {
  await wait(DELAY.write)
  if (hostId !== HOST_ID && !personById(hostId)) throw new Error('This person does not exist.')
  const session = {
    id: `s${db.seq++}`,
    title: title.trim(),
    date,
    start,
    end,
    hostId,
    status: 'inviting',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    members: [{ id: hostId, role: 'host', state: 'joined' }, ...(hostId === HOST_ID ? [] : [{ id: HOST_ID, role: 'guest', state: 'joined' }])],
    locations: {},
    meeting: null,
    prefs: {},
    deletedSlots: [],
    options: {},
    votes: {},
    plan: null,
    banner: null,
    replan: null,
    photos: [],
    radius: null,
  }
  db.sessions.push(session)
  return touch(session, 'session')
}

// The checks the create form makes before it lets a host carry on: a title of 1 to 60 characters, a real day from
// today to three months ahead, two times of the day, the end after the start. Throws the first thing wrong; answers
// the values as they are stored (the title trimmed).
// How to call: checkSessionFields({ title: ' Dinner ', date: '2026-10-17', start: '18:00', end: '21:00' })
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
function checkSessionFields({ title, date, start, end }) {
  const name = String(title ?? '').trim()
  if (!name) throw new Error('A session needs a title.')
  if (name.length > 60) throw new Error('A title can be at most 60 characters.')
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? parseISO(date) : null
  if (!day || !isValid(day) || format(day, 'yyyy-MM-dd') !== date) throw new Error('Pick a day for the session.')
  if (date < todayKey()) throw new Error('That day has passed.')
  if (date > format(addDays(new Date(), 90), 'yyyy-MM-dd')) throw new Error('Sessions can be planned up to 3 months ahead.')
  if (!TIME.test(start || '')) throw new Error('Start must be a time such as 14:00.')
  if (!TIME.test(end || '')) throw new Error('End must be a time such as 18:00.')
  if (end <= start) throw new Error('End time must be after the start time.')
  return { title: name, date, start, end }
}

// Changes a session's title, day and times, for the host going back to the create form from the invite step. Only the
// host may, and only while the session is inviting: once it starts, the group plans around the day and times. Nothing
// else on the session changes. Checked like the create form (checkSessionFields).
// How to call: await updateSession('s1', { title: 'Dinner', date: '2026-10-17', start: '18:00', end: '21:00' })
export async function updateSession(id, fields) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.hostId !== HOST_ID) throw new Error('Only the host can change a session.')
  if (session.status !== 'inviting') throw new Error('The date and times can only change before the session starts.')
  Object.assign(session, checkSessionFields(fields))
  return touch(session, 'session')
}

// Invited friends accept automatically: they already have the app.
// Invite friends. By default they join straight away (tests and demo scripts). With { pending: true }, as the app
// does, each one is Invited until they accept, which in the demo they do on their own, one after another.
// acceptAfter (with pending): how long the first invite stays pending, in ms, instead of ACCEPT_AFTER. A long wait gets
// no timer; the invite is accepted by the first read after it passes. The demo's showcase uses it to leave invites pending.
// How to call: await inviteFriends('s1', ['faith'], { pending: true, acceptAfter: 7 * 24 * 60 * 60 * 1000 })
export async function inviteFriends(id, personIds, { pending = false, acceptAfter = ACCEPT_AFTER } = {}) {
  await wait(DELAY.write)
  const session = sessionById(id)
  let at = Date.now() + acceptAfter
  for (const personId of personIds) {
    let member = session.members.find((m) => m.id === personId)
    if (member?.state === 'joined') continue
    if (!member) {
      member = { id: personId, role: 'guest' }
      session.members.push(member)
    }
    if (pending) {
      member.state = 'invited'
      member.acceptAt = at
      if (acceptAfter <= TIMER_MAX) scheduleAccept(session, at)
      at += ACCEPT_GAP
    } else {
      member.state = 'joined'
      delete member.acceptAt
    }
  }
  return touch(session, 'session')
}

export async function startSession(id) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (activeIds(session).length < 2) throw new Error('A session needs at least 2 people.')
  // Invites nobody accepted yet lapse: the session goes ahead with whoever is in.
  session.members = session.members.filter((m) => m.state !== 'invited')
  session.status = 'locating'
  return touch(session, 'session')
}

// which: 'start' | 'end'. place: { areaId, label }. Only the area is ever shown to other people.
export async function setLocation(id, personId, which, place) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (['completed', 'cancelled'].includes(session.status)) throw new Error('This session has ended.')
  return orUndo(session, async () => {
    const loc = session.locations[personId] || { start: null, end: null }
    const hadStart = !!loc.start
    loc[which] = place ? { areaId: place.areaId, label: place.label || areaById(place.areaId).name } : null
    session.locations[personId] = loc
    const kind = which === 'end' ? 'end' : hadStart ? 'start' : 'added'
    await applyTrigger(session, { kind, personName: nameOf(personId) })
    return touch(session, 'location')
  })
}

export async function useMeetingArea(id) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (!session.meeting) throw new Error('Everyone needs to share where they are starting first.')
  return orUndo(session, async () => {
    session.status = 'voting'
    session.banner = null
    await syncOptions(session)
    return touch(session, 'session')
  })
}

export async function optOut(id, personId) {
  await wait(DELAY.write)
  const session = sessionById(id)
  const member = session.members.find((m) => m.id === personId)
  if (!member || member.role === 'host') throw new Error('The host cannot opt out.')
  return orUndo(session, async () => {
    member.state = 'opted_out'
    await applyTrigger(session, { kind: 'optout', personName: nameOf(personId) })
    await syncOptions(session)
    return touch(session, 'optout')
  })
}

export async function dismissBanner(id) {
  const session = sessionById(id)
  session.banner = null
  return touch(session, 'session')
}

export async function cancelSession(id) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.status === 'completed') throw new Error('A completed session cannot be cancelled.')
  session.status = 'cancelled'
  session.replan = null
  return touch(session, 'session')
}

// ── Step 6: categories, timing, suggestions and votes ──────────────────────

export async function setPreferences(id, personId, prefs) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.status !== 'voting') throw new Error('Categories can only change while voting.')
  return orUndo(session, async () => {
    session.prefs[personId] = { categories: [...prefs.categories], until: prefs.until ?? null }
    await syncOptions(session)
    return touch(session, 'prefs')
  })
}

export async function deleteSlot(id, slotId) {
  await wait(DELAY.write)
  const session = sessionById(id)
  return orUndo(session, async () => {
    session.deletedSlots = [...new Set([...session.deletedSlots, slotId])]
    delete session.options[slotId]
    delete session.votes[slotId]
    await syncOptions(session)
    return touch(session, 'slots')
  })
}

export async function restoreSlots(id) {
  await wait(DELAY.write)
  const session = sessionById(id)
  return orUndo(session, async () => {
    session.deletedSlots = []
    await syncOptions(session)
    return touch(session, 'slots')
  })
}

// The search radius around the meeting area, in metres (100 to 3000), or null to let the planner widen on its own.
// Options outside the new radius drop out, with their votes, and each slot tops up to three again.
export async function setRadius(id, metres) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (metres != null && !(metres >= 100 && metres <= 3000)) throw new Error('Pick a radius from 100 m to 3 km.')
  return orUndo(session, async () => {
    session.radius = metres ?? null
    await syncOptions(session)
    return touch(session, 'options')
  })
}

export async function addMoreOptions(id, slotId) {
  await wait(DELAY.plan)
  const session = sessionById(id)
  const slots = slotsOf(session)
  const slot = slots.find((s) => s.id === slotId)
  const ranked = await rankSlot(session, slot, [])
  session.options[slotId] = P.moreOptions(session.options[slotId] || [], rankedIds(ranked))
  return touch(session, 'options')
}

// Search places to add to a slot. Each result says whether it fits, and why not.
export async function searchVenuesForSlot(id, slotId, query) {
  const session = sessionById(id)
  const slots = slotsOf(session)
  const slot = slots.find((s) => s.id === slotId)
  const q = query.trim()
  if (!q || !slot) return []
  const results = await planner.searchSlot({
    query: q,
    members: membersFor(session),
    centre: areaById(session.meeting.areaId),
    date: session.date,
    slot,
    lastStop: false,
    maxKm: session.radius ? session.radius / 1000 : undefined,
  })
  return results.map((r) => ({ ...r, added: (session.options[slotId] || []).includes(r.id) }))
}

export async function addOption(id, slotId, venueId) {
  await wait(DELAY.write)
  const session = sessionById(id)
  const slots = slotsOf(session)
  const slot = slots.find((s) => s.id === slotId)
  const options = session.options[slotId] || []
  if (options.includes(venueId)) return touch(session, 'options')
  if (options.length >= P.OPTIONS_MAX) throw new Error('A slot holds up to 6 options.')
  // The planner scores current options whenever they fit, so ask it with this place included.
  const ranked = await rankSlot(session, slot, [], [...options, venueId])
  if (!ranked.current.some((o) => o.venue.id === venueId)) throw new Error(`${venueById(venueId)?.name || 'This place'} does not fit this slot.`)
  session.options[slotId] = [...(session.options[slotId] || []), venueId]
  return touch(session, 'options')
}

// Replace an outdoor option with an indoor one when it rains.
export async function swapOption(id, slotId, fromId, toId) {
  await wait(DELAY.write)
  const session = sessionById(id)
  session.options[slotId] = (session.options[slotId] || []).map((v) => (v === fromId ? toId : v))
  const votes = session.votes[slotId] || {}
  for (const person of Object.keys(votes)) if (votes[person] === fromId) delete votes[person]
  return touch(session, 'options')
}

// One vote per person per category. Voting for another place in it moves the vote; voting for the same place
// again takes it back (a category nobody votes in stays out of the plan).
export async function vote(id, slotId, personId, venueId) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.status !== 'voting') throw new Error('Votes are read-only once the plan is confirmed.')
  if (!(session.options[slotId] || []).includes(venueId)) throw new Error('That place is no longer an option.')
  const votes = { ...(session.votes[slotId] || {}) }
  if (votes[personId] === venueId) delete votes[personId]
  else votes[personId] = venueId
  session.votes[slotId] = votes
  return touch(session, 'vote')
}

// What a ranked option says about a place, kept when the plan is confirmed so the confirmed plan can be shown
// again without asking the planner. How to call: rankedDetail(option)
const rankedDetail = (o) => ({
  score: o.score,
  walk: o.walk,
  reasons: o.reasons,
  warnings: o.warnings,
  swap: o.swap,
  explanation: o.explanation,
  dietUnknown: o.dietUnknown,
  verify: o.verify,
  approximate: o.approximate,
})

// The options of a confirmed or completed slot, from what was stored: no planner call, so nothing is re-ranked
// for a plan that cannot change. A plan confirmed before the details were kept shows its places without them.
// How to call: storedOptions(session, slot, area) -> { [venueId]: { venue, score, walk, ... } }
function storedOptions(session, slot, area) {
  const kept = session.confirmedRanking?.[slot.id] || {}
  const found = {}
  for (const venueId of session.options[slot.id] || []) {
    const venue = venueById(venueId)
    if (!venue) continue
    const detail = kept[venueId] || { score: 0, walk: P.walkMinutes(area, venue), reasons: [], warnings: [], swap: null, explanation: '', dietUnknown: [], verify: [], approximate: false }
    found[venueId] = { venue, ...detail }
  }
  return found
}

// Everything the voting screen needs, ranked with the current weather. Once the plan is confirmed the stored
// options are returned as they were: only a session in Voting asks the planner.
export async function getPlan(id) {
  await wait(DELAY.plan)
  const session = sessionById(id)
  const ids = activeIds(session)
  if (!session.meeting || !['voting', 'confirmed', 'completed'].includes(session.status)) {
    return { slots: [], voters: [], prefs: clone(session.prefs), counts: P.categoryCounts(activePrefs(session)), stayUntil: null }
  }
  const slots = slotsOf(session)
  const area = areaById(session.meeting.areaId)
  const settled = session.status !== 'voting'
  const rankings = settled ? null : await rankBrowse(session, slots)
  const view = slots.map((slot, i) => {
    const ranked = settled ? { options: [], current: [], widened: false, few: null, empty: null } : rankings[i]
    const byId = settled ? storedOptions(session, slot, area) : Object.fromEntries([...ranked.options, ...ranked.current].map((o) => [o.venue.id, o]))
    const optionIds = (session.options[slot.id] || []).filter((v) => byId[v])
    const votes = session.votes[slot.id] || {}
    const counts = P.tally(votes)
    const options = optionIds
      .map((venueId) => {
        const o = byId[venueId]
        return {
          id: venueId,
          venue: clone(o.venue),
          score: o.score,
          walk: o.walk,
          // As the crow flies from the meeting area, for the card ("180 m").
          distanceM: Math.round(P.distanceKm(area, o.venue) * 1000),
          reasons: o.reasons,
          warnings: o.warnings,
          votes: counts[venueId] || 0,
          voters: Object.keys(votes).filter((p) => votes[p] === venueId).map((id) => ({ id, name: nameOf(id) })),
          swap: o.swap,
          explanation: o.explanation,
          dietUnknown: o.dietUnknown,
          verify: o.verify,
          approximate: o.approximate,
        }
      })
      // The planner's score is a penalty: lowest first is best first.
      .sort((a, b) => a.score - b.score)
    return {
      ...slot,
      isLast: slots[slots.length - 1].id === slot.id,
      options,
      canAddMore: !settled && options.length < P.OPTIONS_MAX && rankedIds(ranked).length > options.length,
      widened: ranked.widened,
      // Why the slot has no options: { reason, nearestKm, widenToKm } from the planner, or null.
      empty: ranked.empty ? { reason: ranked.empty.reason, nearestKm: ranked.empty.hints?.nearestKm ?? null, widenToKm: ranked.empty.hints?.widenToKm ?? null } : null,
      // Fewer than 3 places fit inside the search radius: { found, widenToKm }, or null.
      few: ranked.few,
      leader: P.leader(optionIds, votes),
      // The most votes any option has, and the options sharing it when there is no single leader.
      topVotes: Math.max(0, ...optionIds.map((v) => counts[v] || 0)),
      tied: P.leader(optionIds, votes) ? [] : optionIds.filter((v) => counts[v] && counts[v] === Math.max(...optionIds.map((o) => counts[o] || 0))),
      totalVotes: Object.keys(votes).length,
      myVote: votes[HOST_ID] || null,
    }
  })
  return {
    area: { ...area },
    radius: session.radius ?? null,
    slots: view,
    voters: P.voters(session.votes, ids),
    prefs: clone(session.prefs),
    counts: P.categoryCounts(activePrefs(session)),
    stayUntil: P.groupStayUntil(activePrefs(session), windowOf(session).windowEnd),
    deletedSlots: [...session.deletedSlots],
    stayOptions: P.stayOptions(windowOf(session).windowStart, windowOf(session).windowEnd),
    // The stops the votes so far would make: { category, time, duration } in order.
    planned: planSlotsOf(session).map((s) => ({ category: s.category, start: s.start, time: s.time, duration: s.duration })),
  }
}

// ── Step 7 and after: confirm, the itinerary, the day itself ───────────────

// suggestion: the Confirm dialog's order from suggestOrder(), or null for the voted order. It is used when it covers
// exactly the stops this confirm makes and its times belong to its order (P.suggestionFits); otherwise (a tie came out
// differently) the plan keeps the voted order.
export async function confirmPlan(id, suggestion = null) {
  await wait(DELAY.plan)
  const session = sessionById(id)
  const ids = activeIds(session)
  if (session.status !== 'voting') throw new Error('Only a session in Voting can be confirmed.')
  if (!P.canConfirm(session.votes, ids)) throw new Error('At least 2 people need to vote first.')
  const slots = planSlotsOf(session)
  if (!slots.length) throw new Error('Vote for at least one place first.')
  const rankings = await rankAll(session, slots)
  if (session.status !== 'voting') throw new Error('Only a session in Voting can be confirmed.')
  const stops = []
  const confirmedRanking = {}
  slots.forEach((slot, i) => {
    const ranked = [...rankings[i].options, ...rankings[i].current]
    // What the cards said when the group confirmed, so the confirmed plan does not need the planner again.
    confirmedRanking[slot.id] = Object.fromEntries(ranked.filter((o) => (session.options[slot.id] || []).includes(o.venue.id)).map((o) => [o.venue.id, rankedDetail(o)]))
    // pickWinner breaks a tie on the higher score. The planner's score is a penalty, so flip it.
    const scores = Object.fromEntries([...rankings[i].options, ...rankings[i].current].map((o) => [o.venue.id, -o.score]))
    const winner = P.pickWinner(session.options[slot.id] || [], session.votes[slot.id], scores)
    if (winner) stops.push({ slotId: slot.id, category: slot.category, venueId: winner, plannedStart: slot.start, duration: slot.duration })
  })
  session.plan = { stops, modes: [], startAt: stops[0]?.plannedStart ?? null }
  // A plain copy: the screen hands over a reactive object, which cannot be stored.
  suggestion = suggestion ? JSON.parse(JSON.stringify(suggestion)) : null
  if (suggestion && P.suggestionFits(stops, suggestion)) {
    applyOrder(session, { order: suggestion.order, stops: suggestion.stops.map((s) => ({ id: s.slotId, start: s.start })), reason: suggestion.reason, source: suggestion.source })
  }
  session.confirmedRanking = confirmedRanking
  session.status = 'confirmed'
  session.banner = null
  session.replan = null
  return touch(session, 'session')
}

export async function getItinerary(id) {
  await wait(DELAY.read)
  const session = sessionById(id)
  if (!session.plan) return null
  const stops = session.plan.stops.map((s) => ({ ...s, venue: venueById(s.venueId) }))
  const startAt = session.plan.startAt ?? Math.min(...session.plan.stops.map((s) => s.plannedStart))
  const { stops: timed, legs } = P.buildItinerary(stops, session.plan.modes, startAt)
  const last = timed[timed.length - 1]?.venue || null
  const people = activeIds(session)
    .map((pid) => ({ id: pid, name: nameOf(pid), place: endPlaceOf(session, pid) }))
    .filter((p) => p.place)
    .map((p) => ({ id: p.id, name: p.name, end: { ...p.place } }))
  const area = session.meeting ? areaById(session.meeting.areaId) : null
  return {
    stops: timed.map((s, index) => ({ index, slotId: s.slotId, category: s.category, venue: clone(s.venue), start: s.start, end: s.end, duration: s.duration, open: s.open })),
    legs,
    end: P.endPoint(last),
    trips: P.tripsHome(last, people),
    // Why the AI chose this order on confirm: { reason, source: 'ai' | 'rules' }, or null once a stop is moved by hand.
    aiNote: session.plan.aiNote ? { reason: P.cleanReason(session.plan.aiNote.reason), source: session.plan.aiNote.source === 'ai' ? 'ai' : 'rules' } : null,
    area: area ? { ...area } : null,
    starts: activeIds(session)
      .filter((pid) => session.locations[pid]?.start)
      .map((pid) => ({ id: pid, name: nameOf(pid), area: { ...areaById(session.locations[pid].start.areaId) } })),
  }
}

// The plan of a session that has one. How to call: planOf(session) -> { stops, modes, startAt }
function planOf(session) {
  if (!session.plan) throw new Error('This session has no plan yet. Confirm one first.')
  return session.plan
}

export async function setTravelMode(id, legIndex, mode) {
  await wait(DELAY.write)
  const session = sessionById(id)
  planOf(session)
  const modes = [...(session.plan.modes || [])]
  modes[legIndex] = mode
  session.plan.modes = modes
  return touch(session, 'plan')
}

// Asks the backend for an order of `stops` (plan stops: { slotId, category, venueId, plannedStart, duration }). Food
// stops keep their place and their slot's time; Claude chooses among the orders that keep every place open.
// How to call: await requestOrder(session, stops, { startAt: 600 })
async function requestOrder(session, stops, { startAt, modes = [] }) {
  const HOURS = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/
  // The times the itinerary would show now.
  const shownNow = P.buildItinerary(stops.map((s) => ({ ...s, venue: venueById(s.venueId) })), modes, startAt).stops
  const startMinutes = P.toMinutes(session.start)
  let endAt = P.toMinutes(session.end)
  if (endAt <= startMinutes) endAt += 1440
  return planner.arrangeItinerary({
    stops: stops.map((s, i) => {
      const v = venueById(s.venueId)
      return {
        id: s.slotId,
        name: String(v.name).slice(0, 80),
        category: s.category,
        ...(v.kind ? { kind: String(v.kind).slice(0, 80) } : {}),
        lat: v.lat,
        lng: v.lng,
        duration: s.duration,
        // A meal is anchored to its slot's time from voting.
        start: s.category === 'eat' && Number.isFinite(s.plannedStart) ? s.plannedStart : shownNow[i].start,
        hours: (v.hours || []).filter((h) => HOURS.test(h)).slice(0, 4),
        ...(typeof v.indoor === 'boolean' ? { indoor: v.indoor } : {}),
        ...(Number.isFinite(v.mrtWalk) ? { mrtWalk: v.mrtWalk } : {}),
      }
    }),
    startAt,
    endAt,
    rain: !!db.conditions.rain,
    // The voted order may be the best one, so it is allowed too.
    includeCurrent: true,
  })
}

// Puts the plan's stops in the answer's order. Each stop keeps the backend's time as its earliest start, so a meal
// stays at its time and a shop waits to open.
function applyOrder(session, answer) {
  const bySlot = Object.fromEntries(session.plan.stops.map((s) => [s.slotId, s]))
  const startOf = Object.fromEntries(answer.stops.map((s) => [s.id, s.start]))
  session.plan.stops = answer.order.map((slotId) => ({ ...bySlot[slotId], notBefore: startOf[slotId] }))
  session.plan.modes = []
  session.plan.aiNote = { reason: P.cleanReason(answer.reason), source: answer.source === 'ai' ? 'ai' : 'rules' }
}

// The stops confirming would make now: each voted slot with its most voted place. A tie goes to the first option,
// so a tie can come out differently on confirm; confirmPlan then keeps its own order (see `suggestion` there).
function wouldConfirm(session) {
  return planSlotsOf(session)
    .map((slot) => {
      const venueId = P.pickWinner(session.options[slot.id] || [], session.votes[slot.id])
      return venueId ? { slotId: slot.id, category: slot.category, venueId, plannedStart: slot.start, duration: slot.duration } : null
    })
    .filter(Boolean)
}

// The order the Confirm dialog suggests: Claude's choice among the orders that keep every place open, food at meal
// times. It may keep the voted order when that is already the best. Nothing is saved. Returns null when there is
// nothing to arrange (fewer than 2 stops that are not food) or no order works.
// How to call: const suggestion = await suggestOrder('s1')
//   suggestion // { order: ['activity', 'eat', 'shop'], stops: [{ slotId, category, venueId, name, start, duration }], reason, source }
export async function suggestOrder(id) {
  const session = sessionById(id)
  if (session.status !== 'voting') return null
  const stops = wouldConfirm(session)
  if (stops.filter((s) => s.category !== 'eat').length < 2) return null
  const startAt = Math.min(...stops.map((s) => s.plannedStart))
  const answer = await requestOrder(session, stops, { startAt })
  if (answer.status !== 'ok') return null
  const bySlot = Object.fromEntries(stops.map((s) => [s.slotId, s]))
  const startOf = Object.fromEntries(answer.stops.map((s) => [s.id, s.start]))
  return {
    order: answer.order,
    stops: answer.order.map((slotId) => ({ ...bySlot[slotId], name: venueById(bySlot[slotId].venueId).name, start: startOf[slotId] })),
    reason: P.cleanReason(answer.reason),
    source: answer.source === 'ai' ? 'ai' : 'rules',
  }
}

// Rearrange the itinerary: move the stop at `from` to `to`. The plan keeps its start time and every stop is
// re-timed after the one before it. Travel modes go back to their defaults, because the legs are new pairs.
export async function reorderStops(id, from, to) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.status !== 'confirmed') throw new Error('Only a confirmed plan can be rearranged.')
  const { stops } = session.plan
  if (from === to || from < 0 || to < 0 || from >= stops.length || to >= stops.length) return summary(session)
  if (session.plan.startAt == null) session.plan.startAt = Math.min(...stops.map((s) => s.plannedStart))
  session.plan.stops = P.moveItem(stops, from, to).map(({ notBefore, ...s }) => s)
  session.plan.modes = []
  session.plan.aiNote = null
  return touch(session, 'plan')
}

export async function deleteStop(id, index) {
  await wait(DELAY.write)
  const session = sessionById(id)
  const { stops, modes = [] } = planOf(session)
  if (!Number.isInteger(index) || index < 0 || index >= stops.length) throw new Error('This stop does not exist.')
  if (stops.length <= 1) throw new Error('A plan needs at least one stop.')
  session.plan.stops = stops.filter((_, i) => i !== index).map(({ notBefore, ...s }) => s)
  session.plan.aiNote = null
  // The plan starts when its first stop does: if the first stop goes, the next one starts at its own planned time
  // instead of being pulled forward to the old start.
  if (index === 0) session.plan.startAt = session.plan.stops[0].plannedStart
  // The legs on either side of the removed stop merge into one, which starts with its default mode.
  const nextModes = [...modes]
  if (index === 0) nextModes.splice(0, 1)
  else nextModes.splice(index - 1, 2, undefined)
  session.plan.modes = nextModes.slice(0, session.plan.stops.length - 1)
  return touch(session, 'plan')
}

// After Confirmed, a change asks "Re-plan?". Accepting returns the session to Voting; declining keeps the plan.
export async function respondReplan(id, accept) {
  await wait(DELAY.write)
  const session = sessionById(id)
  const trigger = session.replan?.trigger || null
  return orUndo(session, async () => {
    session.replan = null
    if (accept) await reopenVoting(session, trigger)
    return touch(session, 'session')
  })
}

// Edit → Re-plan from the itinerary.
export async function replan(id) {
  await wait(DELAY.write)
  const session = sessionById(id)
  return orUndo(session, async () => {
    await reopenVoting(session, null)
    return touch(session, 'session')
  })
}

async function reopenVoting(session, trigger) {
  const previous = session.meeting
  const next = await computeMeeting(session)
  session.status = 'voting'
  session.plan = null
  delete session.confirmedRanking
  session.meeting = next
  const moved = (previous?.areaId ?? null) !== (next?.areaId ?? null)
  // Votes that were there and are gone: say so, even when the re-plan was asked for by hand (no trigger).
  const cleared = moved && hasVotes(session)
  if (moved) {
    session.votes = {}
    session.options = {}
  }
  await syncOptions(session)
  if (!trigger && !cleared) {
    session.banner = null
    return
  }
  const text = P.recalcBanner({ previousName: previous ? areaById(previous.areaId).name : null, nextName: next ? areaById(next.areaId).name : null, trigger: trigger || { kind: 'replan' } })
  session.banner = { text: cleared ? `${text} ${VOTES_CLEARED}` : text, at: Date.now(), ...(cleared ? { votesCleared: true } : {}) }
}

export async function endPlan(id) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.status !== 'confirmed') throw new Error('Only a confirmed plan can be ended.')
  // A season that ran out before today closes first, so these points count for the season they were earned in.
  catchUpSeasons()
  session.status = 'completed'
  session.completedAt = Date.now()
  session.replan = null
  for (const personId of activeIds(session)) {
    db.stats[personId].meetups += 1
    db.stats[personId].points += POINTS_PER_MEETUP
    db.stats[personId].seasonPoints += POINTS_PER_MEETUP
  }
  emit({ type: 'stats' })
  return touch(session, 'session')
}

// ── Photos: everyone in a session can post pictures from the day ────────────

// Everyone in a session can post up to PHOTOS_MAX pictures. src is a data URL (see image.js).
export async function addPhoto(id, personId, src) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (!['confirmed', 'completed'].includes(session.status)) throw new Error('Photos open once the plan is confirmed.')
  if ((session.photos || []).length >= PHOTOS_MAX) throw new Error(`A session holds up to ${PHOTOS_MAX} photos. Delete one to add another.`)
  session.photos = [...(session.photos || []), { id: `p${db.seq++}`, personId, src, at: Date.now() }]
  // One save: if storage is full it puts the photo back and this rejects.
  return touch(session, 'photos')
}

// The pictures of a session, oldest first, each with the poster's name. `latest` keeps only the newest few
// (the strip on the session and the card thumbnails). A session summary has only photoCount.
// How to call: await getPhotos('s1') or await getPhotos('s1', { latest: 4 })
export async function getPhotos(id, { latest } = {}) {
  await wait(DELAY.read)
  const photos = sessionById(id).photos || []
  return (latest ? photos.slice(-latest) : photos).map((p) => ({ ...p, name: nameOf(p.personId) }))
}

export async function deletePhoto(id, photoId) {
  await wait(DELAY.write)
  const session = sessionById(id)
  session.photos = (session.photos || []).filter((p) => p.id !== photoId)
  return touch(session, 'photos')
}

// ── Rewards ────────────────────────────────────────────────────────────────

export async function listRewards() {
  await wait(DELAY.read)
  return clone(REWARDS)
}

export async function listRedemptions() {
  await wait(DELAY.read)
  return clone(db.redemptions).map((r) => ({ ...r, reward: REWARDS.find((x) => x.id === r.rewardId) }))
}

export async function redeemReward(rewardId) {
  await wait(DELAY.write)
  const reward = REWARDS.find((r) => r.id === rewardId)
  const stats = db.stats[HOST_ID]
  if (!reward) throw new Error('This voucher does not exist.')
  if (stats.points < reward.cost) throw new Error(`You need ${coins(reward.cost - stats.points)} more for this voucher.`)
  stats.points -= reward.cost
  const code = `JIO-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  const redemption = { id: `v${db.seq++}`, rewardId, code, at: Date.now() }
  db.redemptions.unshift(redemption)
  emit({ type: 'stats' })
  return { ...redemption, reward: clone(reward), points: stats.points }
}

// ── Demo conditions (weather, routing, the session day) ────────────────────

export async function getConditions() {
  return clone(db.conditions)
}

export async function setConditions(patch) {
  // The crowd switch is gone: an old caller asking for it changes nothing.
  const { crowd: _crowd, ...known } = patch
  db.conditions = { ...db.conditions, ...known }
  // Routing changes how the meeting area is found, so sessions still locating are re-calculated.
  if ('routing' in known) {
    for (const session of db.sessions.filter((s) => s.status === 'locating')) session.meeting = await computeMeeting(session)
  }
  emit({ type: 'conditions' })
  return clone(db.conditions)
}

// Reset sessions, points and conditions. The account stays signed in.
export async function resetDemo() {
  db = freshDb({ user: db.user, friends: db.friends })
  emit({ type: 'reset' })
}
