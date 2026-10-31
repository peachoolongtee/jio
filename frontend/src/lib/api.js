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
import { HOST_ID, PAST_ACTIVITY, PEOPLE, LAST_SEASON_MEETUPS, POINTS_PER_MEETUP, SAMPLE_DIETARY, SEASON_MEETUPS, STARTING_MEETUPS, isCommunity } from './mock/people.js'
import { REWARDS } from './mock/rewards.js'
import { pastMeetupDates } from './mock/history.js'
import { reviewsFor } from './mock/reviews.js'
import * as Season from './season.js'
import * as P from './planner/index.js'
import * as planner from './plannerApi.js'
import { ROAM, isRoamStop, nextStopStart, placeState, proposalsOf, proposeBlock } from './roam.js'
import { PHOTOS_BEFORE_DAY, canInviteByName, dueEnding, earnsCoins, isInOrInvited, photosOpen, singaporeDate, singaporeMinutes, startHasPassed } from './session.js'
import { dayLabel, validUntilOf, voucherState, voucherValidUntil } from './vouchers.js'
import { combineWeather, stateOf, venueSetting, weatherFrom } from './weatherText.js'
import { SEARCH_MAX_CHARS, SEARCH_MIN_CHARS, displayName, sameKey } from './placeSearch.js'
import * as auth from './auth.js'
import { bindCurrentUser, currentUserId } from './currentUser.js'
import { createPeopleSource, isUuid, personFromRow } from './peopleSource.js'
import { isSearchable, rankPeople, searchTerm } from './peopleSearch.js'
import { WORDS as SHARING_WORDS, createSessionsRemote } from './sessionsRemote.js'
import { releasedNotice } from './startChoice.js'
import { ClashError, findClash } from './clash.js'
import { tallyOptions } from './planVotes.js'
import { isLegacyRealSave, remapLegacySave } from './legacySave.js'
import { cleanDietary } from './signupRules.js'
import { dietCaveats } from './dietText.js'
import { localAccountsAllowed, projectOrigin } from './supabase.js'
import { addDays, format, isValid, parseISO } from 'date-fns'

export { api } from './plannerApi.js'

const STORAGE_KEY = 'jio-demo-v1'
// 5: the backend planner (db.venues) and photos, itinerary order and seasons.
// 6: full standings kept for past seasons, and each friend's fixed meetups this season (no ties in the demo).
// Older saves start fresh, keeping the account and friends.
// 8: everyone starts with points this season and a finished last season.
// 9: a session has `spots` (the meeting spots, suggestions and approvals).
const VERSION = 9
// How many ranked places to ask for per slot: enough to top a slot up to its maximum.
const RANKED_MAX = 10
// meeting: the least time the "finding the meeting point" loading bar shows (long enough for it to fill up). The planner answers in milliseconds
// with estimated travel times; with real routing it takes longer on its own.
const DELAY = { read: 80, plan: 300, write: 40, meeting: 1200 }
// Photos are stored as data URLs in local storage, which holds only a few megabytes, so a session keeps a few.
export const PHOTOS_MAX = 12
const STORAGE_FULL = "Could not save: this browser's storage is full. Remove some photos and try again."

// ── Storage ────────────────────────────────────────────────────────────────

// A starting number from mock/people.js. The sample person HOST_ID is the demo account: only the demo account starts
// with the sample history, a person who signed up through the form starts with none, and so does anyone who is not in
// the sample list (a real account's own id). How to call: seeded(STARTING_MEETUPS, HOST_ID, false) -> 0
const seeded = (table, id, demo) => (id === HOST_ID && !demo ? 0 : table[id] ?? 0)

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
// A person who has earned nothing. How to call: noStats() -> { meetups: 0, points: 0, seasonPoints: 0 }
const noStats = () => ({ meetups: 0, points: 0, seasonPoints: 0 })

// A real account (one with a Supabase user id) has no sample friends, no sample past season and no sample people's
// numbers: nobody else is in its world yet, so its leaderboard is itself, in a first season with nothing before it. Its
// own id gets a stats row of zeros, and a real person who joins a session gets one when first needed (statsOf).
// How to call: freshDb({ user: { id: '7f3c...', authId: '7f3c...' }, friends: [] }) -> a save for that account
function freshDb(keep = {}) {
  const { season, earned, pastSeason } = freshSeason(new Date(), !!keep.user?.demo)
  const real = !!keep.user?.authId
  const meetups = (id) => seeded(STARTING_MEETUPS, id, !!keep.user?.demo)
  const prize = (id) => (pastSeason.winners.some((w) => w.id === id) ? pastSeason.prize : 0)
  const stats = real ? {} : Object.fromEntries(PEOPLE.map((p) => [p.id, { meetups: meetups(p.id), points: meetups(p.id) * POINTS_PER_MEETUP + prize(p.id), seasonPoints: earned(p.id) }]))
  if (keep.user?.id && !stats[keep.user.id]) stats[keep.user.id] = noStats()
  return {
    version: VERSION,
    user: keep.user || null,
    friends: real ? [] : keep.friends || [],
    sessions: [],
    // points: what each person can spend. seasonPoints: what they earned this season, for the leaderboard.
    stats,
    season: real ? { ...season, number: 1 } : season,
    // Past seasons, latest first: { number, startsAt, endsAt, winners: [{ id, seasonPoints }], prize, standings }.
    pastSeasons: real ? [] : [pastSeason],
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

// The meeting spots of a session, when they look right: a list, and who approved and suggested what.
// How to call: validSpots({ list: [], approvals: {}, suggestions: {} }) -> true
const validSpots = (spots) =>
  isObject(spots) &&
  isList(spots.list, (spot) => isObject(spot) && typeof spot.areaId === 'string' && isObject(spot.times)) &&
  isObject(spots.approvals) &&
  Object.values(spots.approvals).every((areas) => isList(areas, (a) => typeof a === 'string')) &&
  isObject(spots.suggestions)

// A session in a save, when every field the screens read without checking is there.
const validSession = (s) =>
  isObject(s) &&
  typeof s.id === 'string' &&
  Array.isArray(s.members) &&
  Array.isArray(s.deletedSlots) &&
  ['locations', 'prefs', 'options', 'votes'].every((key) => isObject(s[key])) &&
  validSpots(s.spots)

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
    // The sample people's numbers are in every save but a real account's, which holds only the numbers of real people.
    (saved.user?.authId ? Object.values(saved.stats).every((row) => isObject(row) && ['meetups', 'points', 'seasonPoints'].every((key) => isCount(row[key]))) : PEOPLE.every((p) => isObject(saved.stats[p.id]) && ['meetups', 'points', 'seasonPoints'].every((key) => isCount(saved.stats[p.id][key])))) &&
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

// The text stored under a key, or null. How to call: readRaw(accountKey('7f3c...')) -> '{"version":9,...}'
function readRaw(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
// How to call: parseOrNull('{"a":1}') -> { a: 1 }, parseOrNull('nope') -> null
function parseOrNull(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
// Copy a save to a key beside its own (`<key>:legacy`, or `<key>:legacy:<time>` when one is already there, so a copy is never
// overwritten). True when the copy is stored.
// How to call: backUp(accountKey('7f3c...'), text) -> true
function backUp(key, text) {
  try {
    const legacy = `${key}:legacy`
    if (localStorage.getItem(legacy) === text) return true
    localStorage.setItem(localStorage.getItem(legacy) === null ? legacy : `${legacy}:${Date.now()}`, text)
    return true
  } catch {
    return false
  }
}

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

// Who is signed in is read from the save by everything that needs it (see lib/currentUser.js): the sample person's id for
// the demo account and local accounts, a real account's own Supabase user id otherwise, and '' for nobody. This file asks
// through `me()`; the stores and helpers ask through currentUserId().
bindCurrentUser(() => db.user?.id ?? '')
// How to call: if (session.hostId === me()) ...
const me = () => currentUserId()
// Is a real account (one with a Supabase user id) signed in? Its world holds no sample friends.
// How to call: if (isReal()) return []
const isReal = () => !!db.user?.authId
// The signed-in person's id, for a write that acts as them, or a plain sentence when nobody is signed in or the write names no
// one. Never lets a row be written under ''. `personId` is who the write is for (the demo tools act for friends too).
// How to call: const mine = requireMe() ; requireMe(personId) before a write for someone ; requireMe(undefined, 'Log in to create a session.')
function requireMe(personId = me(), message = 'Log in to do that.') {
  if (!me() || !personId) throw new Error(message)
  return me()
}
// The people in a real account's sessions that it last announced, as text. A session write that changes who is in them
// announces it ('people'), so the lists built from those people (who can be invited, who is "Someone") are made again.
// Declared here, before anything can sign an account out at load.
let coMembersSeen = ''

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
  restoreFrom(stored)
}

// Put the in-memory state to a save given as text, in place (see rollback). Used to go back to what was stored, and to take up a
// save another tab wrote (adoptNewerSave).
// How to call: restoreFrom(localStorage.getItem('jio-demo-v1'))
function restoreFrom(text) {
  const back = JSON.parse(text)
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

// Another tab may have saved since this one last did, and nothing tells a tab when it has. A read that has to write (settleOutings)
// calls this first and writes on top of the newer save, never over it: otherwise a tab opened before an outing finished, a voucher
// was redeemed or a photo was added would save its old state back. True when it is safe to go on (this tab's state is the stored
// one, or the stored one was just taken up); false when the stored save is not this account's, is of another version or cannot be
// read, and the read must then write nothing.
// How to call: if (adoptNewerSave()) { ...settle against db... }
function adoptNewerSave() {
  if (storageKey === null) return true
  const raw = readRaw(storageKey)
  if (raw === null || raw === stored) return true
  const saved = parseOrNull(raw)
  if (!hasShape(saved) || saved.user?.id !== db.user?.id || saved.user?.authId !== db.user?.authId) return false
  restoreFrom(raw)
  stored = raw
  return true
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
// Who is on the leaderboard, as ids. The demo and local accounts: the sample circle, and anyone else on Jio once added
// as a friend. A real account: only itself, because nobody else is in its world yet.
// How to call: leaderboardIds() -> ['ian', 'darius', ...]
const leaderboardIds = () => (isReal() ? (db.user ? [db.user.id] : []) : PEOPLE.filter((p) => !isCommunity(p.id) || db.friends.includes(p.id)).map((p) => p.id))
const areaById = (id) => AREAS.find((a) => a.id === id)
// A place by id: the built-in ones, the ones a local account saved with a proposal, and (for a session on the server) the ones the server
// described for the cards. How to call: venueById('v25') -> { id, name, ... }
const venueById = (id) => db.venues[id] || VENUES.find((v) => v.id === id) || serverVenues.get(id) || unlistedVenues.get(id)

// A place in a shared plan that the server cannot describe any more (it left the list since the plan was made), as a stand-in the screens can draw:
// by id, for the visit, never stored. It sits at the meeting area, indoor (so no rain warning is made for it), and is named for what it is.
const unlistedVenues = new Map()

// What a person has earned, made when it is first needed (a real person who joined a session of this account).
// How to call: statsOf('7f3c...') -> { meetups: 0, points: 0, seasonPoints: 0 }
const statsOf = (id) => (db.stats[id] ??= noStats())

// The people source: the signed-in account's own profile, the sample people, and (for real people) the `profiles` table
// (lib/peopleSource.js). It is emptied whenever the signed-in person changes, so no account sees another's cache.
// How to call: people.nameOf('7f3c...') -> 'Sam', or 'Someone' until the profile has been read
const people = createPeopleSource({
  client: () => auth.dataClient(),
  own: (id) => (db.user && id === db.user.id ? { id, name: db.user.name, username: db.user.username, avatarUrl: db.user.photo || '' } : null),
  sample: personById,
  avatarOrigin: projectOrigin(),
  timeoutMs: () => auth.timing.peopleMs,
})

// ── A real account's sessions are on the server ────────────────────────────

// Where a real account's sessions live. `on: true` (the normal case) sends the session functions of a real account to
// Supabase (lib/sessionsRemote.js). The demo account and local accounts always use the local data layer below. Tests of
// the local layer for a real account's ids (stage 1) switch it off, through lib/__tests__/authFixture.js.
// How to call: sharedSessions.on = false (a test of the local layer)
export const sharedSessions = { on: true }

// The people in each session of this account that is kept on the server, by session id, as last read. A real account's
// friends are the people it shares a session with (coMemberIds), and a session of the server is not in `db.sessions`.
const serverMembers = new Map()
// Raised whenever what was read from the server belongs to another account (the signed-in account changed). A read that began
// in an earlier epoch is dropped when it answers: it writes into nothing and is shown to nobody.
let epoch = 0

// Does this call go to the server? A real account, with a Supabase client to ask.
// How to call: if (onServer()) return remote.list()
const onServer = () => sharedSessions.on && isReal() && !!auth.dataClient()

// The server's side, built on the Supabase client and the Jio backend (leaving and removing, the meeting spots, confirming, a
// known place, opting out and rejoining).
// How to call: await remote.list()
const remote = createSessionsRemote({
  client: () => auth.dataClient(),
  me: () => currentUserId(),
  backend: {
    removeMember: (sessionId, personId) => planner.removeSessionMember(sessionId, personId),
    refreshSpots: (sessionId, trigger) => planner.refreshSessionSpots(sessionId, trigger),
    putSpot: (sessionId, areaId, here) => planner.putSessionSpot(sessionId, areaId, here),
    deleteSpot: (sessionId) => planner.deleteSessionSpot(sessionId),
    confirmSpot: (sessionId, areaId) => planner.confirmSessionSpot(sessionId, areaId),
    knownPlace: (sessionId, areaId) => planner.putSessionKnownPlace(sessionId, areaId),
    changeMeetingPlace: (sessionId, body) => planner.changeSessionMeetingPlace(sessionId, body),
    optOut: (sessionId) => planner.optOutOfSession(sessionId),
    rejoin: (sessionId) => planner.rejoinSession(sessionId),
    syncPlan: (sessionId) => planner.syncSessionPlan(sessionId),
    setRadius: (sessionId, metres) => planner.putSessionRadius(sessionId, metres),
    getDietary: (sessionId) => planner.sessionDietary(sessionId),
    putDietary: (sessionId, body) => planner.putSessionDietary(sessionId, body),
    deleteSlot: (sessionId, slotId) => planner.deleteSessionSlot(sessionId, slotId),
    restoreSlots: (sessionId) => planner.restoreSessionSlots(sessionId),
    addOption: (sessionId, slotId, venueId) => planner.addSessionOption(sessionId, slotId, venueId),
    removeOption: (sessionId, slotId, venueId) => planner.removeSessionOption(sessionId, slotId, venueId),
    moreOptions: (sessionId, slotId, have) => planner.moreSessionOptions(sessionId, slotId, have),
    swapOption: (sessionId, slotId, fromId, toId) => planner.swapSessionOption(sessionId, slotId, fromId, toId),
    searchSlot: (sessionId, slotId, q, opts) => planner.searchSessionSlot(sessionId, slotId, q, opts),
    venues: (ids) => planner.venuesByIds(ids),
    suggestOrder: (sessionId) => planner.suggestSessionOrder(sessionId),
    tripsHome: (sessionId) => planner.getSessionTripsHome(sessionId),
    confirmPlan: (sessionId, body) => planner.confirmSessionPlan(sessionId, body),
    replan: (sessionId, accept) => planner.replanSession(sessionId, accept),
    complete: (sessionId) => planner.completeSession(sessionId),
    patchStop: (sessionId, stopId, body) => planner.patchSessionStop(sessionId, stopId, body),
    deleteStop: (sessionId, stopId) => planner.deleteSessionStop(sessionId, stopId),
    reorderStops: (sessionId, stopIds) => planner.putSessionStopOrder(sessionId, stopIds),
    stopSwap: (sessionId, stopId) => planner.getSessionStopSwap(sessionId, stopId),
    stopChoices: (sessionId, stopId, options) => planner.getSessionStopChoices(sessionId, stopId, options),
    changeStopPlace: (sessionId, stopId, body) => planner.putSessionStopPlace(sessionId, stopId, body),
    keepRain: (sessionId, stopId, state) => planner.putSessionStopRain(sessionId, stopId, state),
    roam: (sessionId, options) => planner.roamSession(sessionId, options),
    propose: (sessionId, venueId) => planner.proposeSessionStop(sessionId, venueId),
    resolve: (sessionId, proposalId, accept) => planner.resolveSessionProposal(sessionId, proposalId, accept),
  },
})

// The slot of each place being voted on that this account has read, by slot id, so a live change to a vote (which names a slot, not
// a session) is read as a change to the session it belongs to. A slot nobody here has read is ignored: the change that creates it
// raises the session's version, which is heard on its own.
const slotSessions = new Map()
// Remember the slots of a session as last handed out, in place of any it had before (a slot that was removed is no longer one). Called
// only where a read is the newest handed out for its session and its account, never for a read that lost to a newer one.
// How to call: rememberSlots('3b1f...', read.slotRows)
function rememberSlots(sessionId, slotRows) {
  forgetSlots(sessionId)
  for (const slot of slotRows || []) slotSessions.set(slot.id, sessionId)
}
// Forget the slots of a session, when the person is no longer in it (it is not one they can hear votes for).
// How to call: forgetSlots('3b1f...')
function forgetSlots(sessionId) {
  for (const [slotId, owner] of [...slotSessions]) if (owner === sessionId) slotSessions.delete(slotId)
}
// The session of each stop of an itinerary this account has read, by stop id, so a live delete of a stop (which carries only the stop's key)
// is read as a change to the session it belonged to. A stop nobody here has read is ignored: whatever creates it raises the session's version.
const stopSessions = new Map()
// Remember the stops of a session as last handed out, in place of any it had before. Called only where a read is the newest handed out.
// How to call: rememberStops('3b1f...', read.plan)
function rememberStops(sessionId, plan) {
  forgetStops(sessionId)
  for (const stop of plan?.stops || []) if (stop.stopId) stopSessions.set(stop.stopId, sessionId)
}
// How to call: forgetStops('3b1f...')
function forgetStops(sessionId) {
  for (const [stopId, owner] of [...stopSessions]) if (owner === sessionId) stopSessions.delete(stopId)
}
// The rows of each session of the server as last handed out by a read, before they were made into what the screens keep, so that a live
// vote can be folded in by reading the votes alone (getSession with `votesOnly`).
const heldRows = new Map()
// The places the server has described, by id, for the cards. A place is the same for everyone and does not change in a session, so
// it is asked for once and kept for the visit; it is not account data and is not kept across a reload.
const serverVenues = new Map()
// The names of places found by a search this visit, by id, to word a refusal with the place's name.
const searchedNames = new Map()

// The banners the signed-in person dismissed, by session: the stamp of the banner (its time, or the session's version when it
// has none). The server's banner is the group's, so dismissing it is this person's alone: it is kept in this browser, under
// the account, and a newer banner (another stamp) shows again.
const dismissedBanners = new Map()
// The basis of the votes the host was last shown in the Confirm dialog, by session (what the server said it made its answer for, an order or none).
// It is a note of what was on screen, not data: it is sent back with the confirm so the server can tell the votes moved, and forgotten at once.
const shownBasis = new Map()

// The minutes home of a session on the server, by what they depend on (the plan's last stop and where each person ends the day): what was last
// answered ({ minutes, approximate, at }), the questions still out, and the newest question of each session with who to tell when it is
// answered. An answer is kept so unrelated live updates of a plan do not ask again; an approximate one is asked again after TRIPS_RETRY_MS so
// the figures can become the routed ones.
const tripsHomeKnown = new Map()
const tripsHomeAsked = new Map()
const tripsHomeWanted = new Map()
const TRIPS_RETRY_MS = 5 * 60 * 1000

// The server writes `at` (the time it was written, in milliseconds) on every banner, so a newer banner always has a new stamp; the
// version is only the fallback for a banner without one.
// How to call: bannerStamp({ at: 1760000000000 }, 4) -> 1760000000000
const bannerStamp = (banner, version) => (typeof banner.at === 'number' ? banner.at : version)
// How to call: dismissedStamp('3b1f...') -> 1760000000000, or undefined
function dismissedStamp(sessionId) {
  const key = `${me()}:${sessionId}`
  if (dismissedBanners.has(key)) return dismissedBanners.get(key)
  const saved = parseOrNull(readRaw(`${STORAGE_KEY}:banners:${me()}`) ?? 'null')
  return isObject(saved) ? saved[sessionId] : undefined
}
// How to call: rememberDismissed('3b1f...', 1760000000000)
function rememberDismissed(sessionId, stamp) {
  dismissedBanners.set(`${me()}:${sessionId}`, stamp)
  const saved = parseOrNull(readRaw(`${STORAGE_KEY}:banners:${me()}`) ?? 'null')
  try {
    localStorage.setItem(`${STORAGE_KEY}:banners:${me()}`, JSON.stringify({ ...(isObject(saved) ? saved : {}), [sessionId]: stamp }))
  } catch {
    // Kept in memory for this visit.
  }
}

// What the server held of the meeting spots and where people start, kept to areas this app knows (an area it does not know
// would break every screen that names it), with the labels of other people's places replaced by their area's name.
// How to call: knownSpots({ list: [...], approvals: {}, suggestions: {}, appMethod: 'fairest' })
function knownSpots(spots) {
  const list = spots.list.filter((spot) => areaById(spot.areaId))
  const listed = new Set(list.map((spot) => spot.areaId))
  const approvals = Object.fromEntries(Object.entries(spots.approvals).map(([id, areas]) => [id, areas.filter((a) => listed.has(a))]).filter(([, areas]) => areas.length))
  const suggestions = Object.fromEntries(Object.entries(spots.suggestions).filter(([, s]) => areaById(s.areaId)))
  return { list, approvals, suggestions, appMethod: spots.appMethod }
}
// How to call: knownLocations({ '7f3c...': { start: { areaId: 'bugis', label: '' }, end: null } })
function knownLocations(locations) {
  const known = (end) => (end && areaById(end.areaId) ? { areaId: end.areaId, label: end.label || areaById(end.areaId).name } : null)
  return Object.fromEntries(Object.entries(locations).map(([id, loc]) => [id, { start: known(loc.start), end: known(loc.end) }]).filter(([, loc]) => loc.start || loc.end))
}

// The sessions this page has read once, and the gaps already asked the server to close (by session and the time of the change
// that made them). See repairSpots.
const opened = new Set()
const repairs = new Set()
// A start changed and the spots were never worked out again (the call to the server did not come, say the page closed between the
// two writes): the session read says so in `spotsStale`. Only the first read of a session on this page looks, which is the person
// opening it: a later read is a live update, and a change that another device is still working out is not a gap. Ask the server once
// for each such gap, quietly, and read again when it has answered. The answer is never used.
// How to call: repairSpots(read)
function repairSpots(read) {
  const first = !opened.has(read.id)
  opened.add(read.id)
  const key = `${read.id}:${read.spotsStale}`
  if (!first || !read.spotsStale || repairs.has(key)) return
  repairs.add(key)
  const asked = epoch
  remote
    .refreshSpots(read.id, 'added')
    .then(() => asked === epoch && broadcast({ type: 'session', sessionId: read.id }))
    .catch(() => {})
}

// A session read from the server, in the shape summary() makes a summary of for a local session: the plan (the stops, how the group
// travels between them, when it starts and the sentence about the order), the "Re-plan?" question and the places waiting to be added come
// from the server's rows. Where people start, the meeting area, the spots and the
// banner are the server's. The banner is hidden once this person dismissed it.
// How to call: summary(fromServer(await remote.get(id)))
function fromServer(row) {
  serverMembers.set(row.id, row.members.map((m) => m.id))
  // The places as the server keeps them are for getPlan, which reads them afresh; the session carries the slots (summary leaves them
  // out of what it hands the screens) and what the other screens read: the votes and the count of places in each slot.
  const { spotsStale: _stale, banner: held, meeting, optionRows: _options, ...rest } = row
  let banner = null
  if (held && held.text) {
    const stamp = bannerStamp(held, row.planVersion)
    // The banner is the server's, as written: { text, at, approvalsRemoved: true } for approvals that went with a spot that left
    // the list (backend/docs/planner-api.md, "The banner"). Nothing is added here, so the screens show what the server said.
    if (dismissedStamp(row.id) !== stamp) banner = { ...held, at: stamp }
  }
  return {
    ...rest,
    locations: knownLocations(row.locations),
    meeting: meeting && areaById(meeting.areaId) ? meeting : null,
    spots: knownSpots(row.spots),
    banner,
    photos: [],
  }
}

// The newest read of each session of the server that has been handed out, so that a read which began earlier and answers
// later (a live update, a list) never puts an old state over a new one, such as a session still locating over one the host
// has confirmed. A read is older when it holds an older version of the plan, or, at the same version, began before the newest
// one. The version comes first: a read that began earlier but holds a newer version is newer (a member's own start changes no
// version, so at the same version only the order the reads began in tells which is newer).
const newestRead = new Map()
// The same for the Vote page's plan (getPlan): the newest plan handed out for each session, with the version it was read at and the
// ticket of the read. A vote does not raise the version, so at one version the read that began last is the newest.
const newestPlanRead = new Map()
let readCount = 0
// Hand out `make()` unless a newer read of the session has been handed out already, in which case that one stands.
// How to call: return newest('3b1f...', ++readCount, 4, () => summary(fromServer(read)))
function newest(sessionId, ticket, version, make) {
  const have = newestRead.get(sessionId)
  if (have && (version < have.version || (version === have.version && ticket < have.ticket))) return clone(have.session)
  const session = make()
  newestRead.set(sessionId, { ticket: Math.max(ticket, have?.ticket ?? 0), version, session: clone(session) })
  return session
}

// Live updates for a real account's sessions. Screens that show sessions call watchSessions() when they appear and the
// function it returns when they go; one channel serves them all and closes when the last has gone, or when the signed-in
// account changes. Changes arrive as the same events a local write makes: { type: 'session', sessionId } (read it again),
// 'session-gone' (the person is no longer in it), 'invitations' and 'resync' (everything may have changed: the channel has
// just connected, or the tab is back in view).
let watchers = 0
let closeChannel = () => {}
// Is a channel open now? Another watcher joins the one that is.
let channelOpen = false
let closing = 0
const changed = new Map()

// How long the channel stays open after the last screen that watched has gone. Moving from one screen to the next unmounts the
// old one before the new one is drawn, so the watchers go to none and back in one tick; the channel then simply stays. Tests of
// the exact moment of closing set it to 0.
// How to call: sessionsWatch.graceMs = 0
export const sessionsWatch = { graceMs: 800 }

// Read a session again soon: several events for one session (a member row, the session row and an invite change together) are
// read once. A live vote asks for `votesOnly`: the screens then read the votes alone (type 'votes'), unless another change to the same
// session is waiting too, in which case the whole session is read (type 'session').
// How to call: readSoon('3b1f...'); readSoon('3b1f...', { votesOnly: true })
function readSoon(sessionId, { votesOnly = false } = {}) {
  const waiting = changed.get(sessionId)
  if (waiting) {
    if (!votesOnly) waiting.full = true
    return
  }
  const entry = { full: !votesOnly, timer: null }
  entry.timer = setTimeout(() => {
    changed.delete(sessionId)
    broadcast({ type: entry.full ? 'session' : 'votes', sessionId })
  }, 30)
  changed.set(sessionId, entry)
}

// How to call: openChannel() (does nothing without watchers, without a real account, or when a channel is already open)
function openChannel() {
  if (watchers === 0 || channelOpen || !onServer()) return
  channelOpen = true
  const hear = (change) => {
    if (change.kind === 'session') readSoon(change.sessionId)
    else if (change.kind === 'member-deleted') {
      // A delete of any membership anywhere reaches here. Only a session this account knows matters; for any other the answer
      // is nothing at all: no read, and no "gone" for a session the person was never in.
      if (!serverMembers.has(change.sessionId)) return
      if (change.mine) {
        serverMembers.delete(change.sessionId)
        forgetSlots(change.sessionId)
        forgetStops(change.sessionId)
        heldRows.delete(change.sessionId)
        newestPlanRead.delete(change.sessionId)
        broadcast({ type: 'session-gone', sessionId: change.sessionId })
      } else readSoon(change.sessionId)
    } else if (change.kind === 'vote') {
      // A vote names a slot. Only a slot of a session this account has read is read again; the votes of anyone else's sessions
      // reach this browser as deletes only (they carry no session, and cannot be filtered) and are ignored.
      const sessionId = slotSessions.get(change.slotId)
      if (sessionId) readSoon(sessionId, { votesOnly: true })
    } else if (change.kind === 'stop-deleted') {
      // A stop was removed somewhere; only a stop of an itinerary this account has read is read again.
      const sessionId = stopSessions.get(change.stopId)
      if (sessionId) readSoon(sessionId)
    } else if (change.kind === 'approval-deleted') {
      // Like a deleted membership: it reaches everyone who listens, and only a session this account knows is read again.
      if (serverMembers.has(change.sessionId)) readSoon(change.sessionId)
    } else if (change.kind === 'invitations') broadcast({ type: 'invitations' })
    else if (change.kind === 'resync') broadcast({ type: 'resync' })
  }
  const stop = remote.watch(hear)
  // A tab that comes back into view may have missed what happened: read everything again.
  const back = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') broadcast({ type: 'resync' })
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', back)
  closeChannel = () => {
    stop()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', back)
    for (const { timer } of changed.values()) clearTimeout(timer)
    changed.clear()
    channelOpen = false
    closeChannel = () => {}
  }
}

// Start listening for changes to the sessions on the screen. Returns the function that stops listening. Does nothing for
// the demo account and local accounts.
// How to call: onMounted(() => (stop = watchSessions())); onBeforeUnmount(() => stop())
export function watchSessions() {
  watchers += 1
  // Back within the grace time: the channel that is open stays.
  closing += 1
  openChannel()
  let done = false
  return () => {
    if (done) return
    done = true
    watchers -= 1
    if (watchers > 0) return
    const mine = ++closing
    const close = () => {
      if (watchers === 0 && mine === closing) closeChannel()
    }
    if (sessionsWatch.graceMs > 0) setTimeout(close, sessionsWatch.graceMs)
    else close()
  }
}

// A person's name for the screens: the signed-in person's own, a sample person's, a real person's once read, otherwise
// the neutral "Someone". How to call: nameOf(session.hostId)
const nameOf = (id) => people.nameOf(id)

// Read the real people some sessions name, in one request for all of them (the caller collects the ids of every session it
// is about to show, so ten sessions are one request, not ten), then tell the screens when something new arrived. Quiet: a
// failed or offline read leaves them as "Someone". Not waited for.
// How to call: warmPeople(session.members.map((m) => m.id))
function warmPeople(ids) {
  const missing = [...new Set(ids)].filter((id) => isUuid(id) && !people.get(id))
  if (!missing.length) return
  const before = people.version()
  people.load(missing).then(() => {
    if (people.version() !== before) broadcast({ type: 'people' })
  })
}

function sessionById(id) {
  const session = db.sessions.find((s) => s.id === id)
  if (!session && serverMembers.has(id)) throw new Error(SHARING_WORDS.notShared)
  if (!session) throw Object.assign(new Error('This session does not exist.'), { code: 'not_found' })
  settleInvites(session)
  return session
}

// Pending invites. In the demo a friend accepts on their own a moment after being invited (their phone would ask
// them): each invite stores when it will be accepted, a timer accepts it then, and reading a session accepts any
// whose time has passed (after a reload, the timers are gone). Returns true when someone joined.
// Long enough for the host to see the invite and take it back with its × (Faith's walkthrough, 30 October 2026: at 1.4 s nobody could).
const ACCEPT_AFTER = 8000
const ACCEPT_GAP = 3000
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
  return singaporeDate()
}

function isSessionDay(session) {
  return session.date === todayKey() || db.conditions.sessionDay
}

// ── Planner, run on the backend ────────────────────────────────────────────

// Each person with a start location, as the backend expects them: start and end as points. A name is not sent: the planner
// uses only the id (a name it would only echo back, and a long one made of emoji can be over its limit while within the
// database's, which would refuse every request of a session).
function membersFor(session) {
  return activeIds(session)
    .filter((id) => session.locations[id]?.start)
    .map((id) => {
      const start = areaById(session.locations[id].start.areaId)
      const end = endPlaceOf(session, id)
      return { id, start: { lat: start.lat, lng: start.lng }, end: { lat: end.lat, lng: end.lng } }
    })
}

// Who ranking places is for: the people with a start, as membersFor sends them. A known place can be set before
// anyone has shared a start, and the planner needs at least one person, so then everyone is sent starting at the
// meeting area (they have no trip to it, so nobody is favoured).
// The group's dietary needs ride on the first person sent (see withGroupNeeds).
// How to call: rankingMembers(session) -> [{ id, start: { lat, lng }, end: { lat, lng }, dietary? }]
function rankingMembers(session) {
  const members = membersFor(session)
  if (members.length || !session.meeting) return withGroupNeeds(members, groupNeeds(session))
  const centre = areaById(session.meeting.areaId)
  return withGroupNeeds(activeIds(session).map((id) => ({ id, start: { lat: centre.lat, lng: centre.lng }, end: { lat: centre.lat, lng: centre.lng } })), groupNeeds(session))
}

// ── Dietary needs (ticket #107) ──
// A dietary need is a standing, private setting on a person's profile: halal, vegetarian or vegan. It filters food stops,
// and for halal it also keeps bars out of drink stops (the planner's rule). The group sees which needs the places fit,
// never whose they are.

// A person's dietary needs, as far as this browser may know them, for one outing when `session` is given. What the person
// picked for that outing ("Confirm dietary needs" or the Vote page's chips, kept in `session.dietMine`) comes first and is
// for that outing only; otherwise the signed-in person's come from their profile. Anyone else's are private (only the server
// may read them), so the only others known here are the sample friends'; a real friend counts as having none until sessions
// are on the server (ticket #80).
// How to call: dietaryOf('faith') -> ['halal'], dietaryOf('ian', session) -> ['vegan']
function dietaryOf(id, session) {
  const picked = session?.dietMine?.[id]
  if (picked) return cleanDietary(picked)
  if (id === me()) return cleanDietary(db.user?.dietary)
  return cleanDietary(SAMPLE_DIETARY[id])
}
// Each active member's needs for this outing. How to call: membersDietary(session, ['ian', 'faith']) -> ['halal']
const membersDietary = (session, ids) => ids.flatMap((id) => dietaryOf(id, session))

// The needs the group's places are filtered for: every active member's together, each once, in the app's order.
// How to call: groupNeeds(session) -> ['halal', 'vegetarian']
const groupNeeds = (session) => cleanDietary(membersDietary(session, activeIds(session))).filter((need) => !droppedNeeds(session).includes(need))

// The needs someone in the outing has that the group chose not to filter for ("Confirm dietary needs", after a warning that
// someone needs it). Only the host may drop one or bring it back. How to call: droppedNeeds(session) -> ['halal']
const droppedNeeds = (session) => cleanDietary(session.dietDropped)

// How many people an outing needs before the others' needs are listed, and before the host may drop a need. With two, the others' list
// would be the other person's own, so it is empty (the server answers the same: backend/src/services/session-dietary.js).
const MIN_MEMBERS_FOR_OTHERS = 3

// The needs of everyone in the outing but the signed-in person, together and without names: the ones they cannot take off
// (and are warned about when they try). Empty until three people have joined.
// How to call: othersNeeds(session) -> ['halal']
const othersNeeds = (session) => (activeIds(session).length < MIN_MEMBERS_FOR_OTHERS
  ? []
  : cleanDietary(membersDietary(session, activeIds(session).filter((id) => id !== me()))))

// The members as the planner gets them, with the group's needs on the first one only. The planner filters by every need
// in the group whoever holds it, so this changes nothing in the ranking, and a need is never tied to the person who has
// it, even in the request. A member without a start (not sent) still counts.
// How to call: withGroupNeeds([{ id: 'ian', start, end }], ['halal']) -> [{ id: 'ian', start, end, dietary: ['halal'] }]
function withGroupNeeds(members, needs) {
  if (!members.length || !needs.length) return members
  const [first, ...rest] = members
  return [{ ...first, dietary: needs }, ...rest]
}

// An outing's dietary needs for "Confirm dietary needs": `dietary` (everyone's together), `others` (everyone's but the signed-in
// person's, which they cannot take off) and `mine`. No names. A session on the server asks the server, the only one that may
// read a real friend's needs (GET /api/sessions/:id/dietary); a session in this browser knows the signed-in person's own and
// the sample friends'. Rejects as the client does when the server cannot answer.
// How to call: await outingDietary('s1') -> { dietary: ['halal', 'vegetarian'], others: ['halal', 'vegetarian'], mine: [] }
export async function outingDietary(id) {
  if (onServer() && serverMembers.has(id)) {
    const answer = await remote.dietary(id)
    return { dietary: cleanDietary(answer.dietary), others: cleanDietary(answer.others), mine: cleanDietary(answer.mine ?? db.user?.dietary), dropped: cleanDietary(answer.dropped) }
  }
  const session = sessionById(id)
  return { dietary: groupNeeds(session), others: othersNeeds(session), mine: dietaryOf(me(), session), dropped: droppedNeeds(session) }
}

// Are places of this category being filtered strictly for the group's needs? Only food is (a drink stop is not a meal), and
// only until the group asks to see the places we could not confirm (setUnconfirmed).
// How to call: strictFor(session, 'eat') -> true
const strictFor = (session, category) => category === 'eat' && groupNeeds(session).length > 0 && !session.unconfirmed

// What the planner does with a place it has no dietary data for: 'strict' leaves it out, 'lenient' keeps it and says so.
// How to call: dietPolicy(session, 'eat') -> 'strict'
const dietPolicy = (session, category) => (strictFor(session, category) ? 'strict' : 'lenient')

// Fewer than this many food places that fit, and the group is told so and offered the places we could not confirm.
const DIET_FEW = 3

// Sessions whose meeting area the planner is working out right now. getSession shows it as `findingMeeting`.
const finding = new Set()
// Sessions whose meeting spots the planner is working out right now. getSession shows it as `findingSpots`.
const findingSpots = new Set()

// ── Meeting spots ──────────────────────────────────────────────────────────

// The app lists this many spots: the chosen area and its runners-up.
const APP_SPOTS = 3
// The planner prices up to this many extra areas in one request (its `include` limit): members' suggestions.
const SUGGESTIONS_MAX = 8

// The spots of a new session: nothing listed, approved or suggested yet. appMethod is how the planner described its own
// pick last time ('same', 'fairest' or 'centre'), which confirming the app's first spot keeps. How to call: emptySpots()
const emptySpots = () => ({ list: [], approvals: {}, suggestions: {}, appMethod: null })
// How to call: sumOf([20, 25]) -> 45
const sumOf = (numbers) => numbers.reduce((sum, n) => sum + n, 0)
const SESSION_ENDED = 'This session has ended.'

// Minutes by person, rounded. How to call: roundedTimes({ ian: 24.6 }) -> { ian: 25 }
const roundedTimes = (travelByMember) => Object.fromEntries(Object.entries(travelByMember).map(([id, minutes]) => [id, Math.round(minutes)]))

// What the planner answered as a list of priced areas, the chosen one first. An older backend sends no `candidates`:
// then the chosen area is the only one.
// How to call: candidatesOf(data) -> [{ area, travelByMember, approximate, source? }]
const candidatesOf = (data) => (data.candidates?.length ? data.candidates : [data])

// Are the planner's times all its own estimate? The flag on a candidate only says a route call failed, so with no routing
// account (every time is a straight-line estimate) it stays false; the answer's `travel.source` says it. 'table' is the same for the
// screens: minutes from the planner's table of real times between the areas, not routed for this trip, so they say "about".
// How to call: estimatedBy({ travel: { source: 'estimate' } }) -> true
const estimatedBy = (data) => data.travel?.source === 'estimate' || data.travel?.source === 'table'

// Does a priced candidate or answer carry minutes that were not routed? The backend's `approximate` says a straight-line estimate was
// used; `travelSource: 'table'` says the planner's table of times was (real transit minutes between the areas, close but not this trip's route).
// How to call: aboutOnly({ approximate: false, travelSource: 'table' }) -> true
const aboutOnly = (x) => !!x.approximate || x.travelSource === 'table'

// One priced area as a spot's numbers: the longest trip, the average and each person's minutes, all from the same
// rounded minutes the screens show. Alike for the app's spots and a member's. The times are approximate when the
// candidate says so or when `estimated` (the whole answer is the planner's estimate). `exactWorst` is the longest trip
// before rounding: the screens round, but the order of spots never does.
// How to call: pricedSpot({ travelByMember: { ian: 20, jonathan: 30 }, approximate: false }, false) -> { worstMinutes: 30, meanMinutes: 25, ... }
function pricedSpot(candidate, estimated = false) {
  const times = roundedTimes(candidate.travelByMember)
  const minutes = Object.values(times)
  return {
    worstMinutes: Math.max(...minutes),
    meanMinutes: Math.round(sumOf(minutes) / minutes.length),
    exactWorst: Math.max(...Object.values(candidate.travelByMember)),
    times,
    approximate: aboutOnly(candidate) || estimated,
  }
}

// How the planner's own pick is described: 'same' (everyone starts together), 'fairest' or 'centre' (routing is off).
// How to call: plannerMethod(members, data) -> 'fairest'
function plannerMethod(members, data) {
  const same = members.every((m) => P.distanceKm(m.start, members[0].start) < P.SAME_PLACE_KM)
  return same ? 'same' : data.method === 'station' ? 'fairest' : 'centre'
}

// The meeting area, in the shape meetingResultLine and recalculate read: { areaId, method, times, maxMinutes, ... }.
// How to call: meetingFrom(members, data)
function meetingFrom(members, data) {
  const times = roundedTimes(data.travelByMember)
  const minutes = Object.values(times)
  return {
    areaId: data.area.id,
    method: plannerMethod(members, data),
    times,
    maxMinutes: Math.max(...minutes),
    totalMinutes: sumOf(minutes),
    count: members.length,
    approximate: aboutOnly(data) || estimatedBy(data),
  }
}

// The meeting area for a chosen spot: the host's pick, or what the group approved. `spot` has times (maybe none),
// worstMinutes and approximate. With no start shared yet there is no trip to count.
// How to call: meetingAtSpot('bugis', 'chosen', spot) -> { areaId: 'bugis', method: 'chosen', times, maxMinutes, ... }
function meetingAtSpot(areaId, method, spot) {
  const minutes = Object.values(spot.times)
  return { areaId, method, times: { ...spot.times }, maxMinutes: spot.worstMinutes ?? 0, totalMinutes: sumOf(minutes), count: minutes.length, approximate: spot.approximate }
}

// One request to the planner for the meeting area. `bar`: show the "finding the meeting point" bar and keep it up for
// a moment. `spots`: say the spots are being worked out. Show the change straight away; the answer follows.
// How to call: await askMeeting(session, membersFor(session), { alternatives: 2 }, { spots: true })
async function askMeeting(session, members, extra, { bar = false, spots = false } = {}) {
  if (bar) finding.add(session.id)
  if (spots) findingSpots.add(session.id)
  try {
    if (bar || spots) emit({ type: 'pending', sessionId: session.id })
    const [data] = await Promise.all([planner.meetingArea({ members, routing: db.conditions.routing, ...extra }), bar ? wait(DELAY.meeting) : null])
    return data
  } finally {
    finding.delete(session.id)
    findingSpots.delete(session.id)
  }
}

// Which areas members suggested, once each: they go in the planner's `include`.
// How to call: suggestedAreas(session) -> ['bugis']
const suggestedAreas = (session) => [...new Set(Object.values(session.spots.suggestions).map((s) => s.areaId))]

// The planner's answer as spots: the app's areas in its order, and every priced area by id. `method` describes the
// app's first suggestion.
// How to call: spotsFrom(members, data) -> { appIds: ['bishan', ...], entries: Map, method: 'fairest' }
function spotsFrom(members, data) {
  const candidates = candidatesOf(data)
  return {
    appIds: candidates.filter((c) => c.source !== 'included').slice(0, APP_SPOTS).map((c) => c.area.id),
    entries: new Map(candidates.map((c) => [c.area.id, pricedSpot(c, estimatedBy(data))])),
    method: plannerMethod(members, data),
  }
}
// Fewer than two starts: the app has nothing to list.
const NO_SPOTS = { appIds: [], entries: new Map(), method: null }

// The list of spots: the app's, then each suggested area that is not one of them. A spot is the app's when the app
// lists it, even if a member suggested it too; otherwise it is the first member who suggested it, and it carries "here"
// if any of them marked it. An area with no price is left out.
// How to call: listFrom(['bishan'], entries, { jonathan: { areaId: 'bugis', here: false } }) -> [{ areaId: 'bishan', by: 'app', ... }, ...]
function listFrom(appIds, entries, suggestions) {
  const order = [...appIds]
  for (const { areaId } of Object.values(suggestions)) if (!order.includes(areaId)) order.push(areaId)
  return order
    .filter((areaId) => entries.has(areaId))
    .map((areaId) => {
      const suggesters = Object.entries(suggestions).filter(([, s]) => s.areaId === areaId)
      const { worstMinutes, meanMinutes, exactWorst, times, approximate } = entries.get(areaId)
      return { areaId, by: appIds.includes(areaId) ? 'app' : suggesters[0][0], here: suggesters.some(([, s]) => s.here), worstMinutes, meanMinutes, exactWorst, times: { ...times }, approximate }
    })
}

// The list again from what is stored, with no planner: for a change that adds no new area to price.
// How to call: relistFromStored(session) -> a list
function relistFromStored(session) {
  const { list, suggestions } = session.spots
  return listFrom(list.filter((s) => s.by === 'app').map((s) => s.areaId), new Map(list.map((s) => [s.areaId, s])), suggestions)
}

// Make `list` the session's spots. Approvals for a spot that is no longer listed go with it.
// Returns the area ids that lost approvals.
// How to call: setSpotList(session, list) -> ['orchard']
function setSpotList(session, list) {
  const listed = new Set(list.map((s) => s.areaId))
  const lost = new Set()
  const { approvals } = session.spots
  for (const [person, areas] of Object.entries(approvals)) {
    const kept = areas.filter((a) => listed.has(a))
    for (const a of areas) if (!listed.has(a)) lost.add(a)
    if (kept.length) approvals[person] = kept
    else delete approvals[person]
  }
  session.spots.list = list
  return [...lost]
}

// Work in what the planner answered: the app's spots and every spot's travel times are new. A suggestion the planner
// could not price (an older backend) is dropped. Returns the area ids that lost approvals.
// How to call: applyPlannedSpots(session, spotsFrom(members, data)) -> []
function applyPlannedSpots(session, planned) {
  const { spots } = session
  const list = listFrom(planned.appIds, planned.entries, spots.suggestions)
  if (planned !== NO_SPOTS) {
    const listed = new Set(list.map((s) => s.areaId))
    for (const [person, s] of Object.entries(spots.suggestions)) if (!listed.has(s.areaId)) delete spots.suggestions[person]
  }
  spots.appMethod = planned.method
  return setSpotList(session, list)
}

// The words for approvals that went with a spot. How to call: lostApprovalsNote(['orchard']) -> 'Orchard is no longer on the list, so approvals for it were removed.'
function lostApprovalsNote(areaIds) {
  const names = areaIds.map((areaId) => areaById(areaId)?.name || areaId)
  const one = names.length === 1
  const joined = one ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `${joined} ${one ? 'is' : 'are'} no longer on the list, so approvals for ${one ? 'it' : 'them'} were removed.`
}
// The banner that says so, the way VOTES_CLEARED does for votes. `reason` is the sentence before it.
// How to call: lostApprovalsBanner('Jonathan\'s start location changed.', ['orchard']) -> { text, at, approvalsRemoved: true }
const lostApprovalsBanner = (reason, areaIds) => ({ text: `${reason} ${lostApprovalsNote(areaIds)}`, at: Date.now(), approvalsRemoved: true })

// How many active members said a spot works for them. How to call: approvalCount(session, 'bugis') -> 2
const approvalCount = (session, areaId) => activeIds(session).filter((id) => session.spots.approvals[id]?.includes(areaId)).length

// The longest trip to a spot, before rounding when it is known: the screens round, the order never does.
// How to call: longestTrip({ worstMinutes: 30, exactWorst: 29.6 }) -> 29.6
const longestTrip = (spot) => spot.exactWorst ?? spot.worstMinutes ?? 0

// The spot the host is offered. With nobody's approval it is the first of the list, which is the planner's own pick (never
// reordered by rounded minutes). Otherwise the most approved; a tie among those goes to the shortest longest trip, then to
// the list's own order. Null when no spot is listed.
// How to call: preselectedSpot(session) -> { areaId: 'bugis', ... }
function preselectedSpot(session) {
  const { list } = session.spots
  const most = Math.max(0, ...list.map((s) => approvalCount(session, s.areaId)))
  if (!most) return list[0] || null
  return list.filter((s) => approvalCount(session, s.areaId) === most).reduce((best, s) => (longestTrip(s) < longestTrip(best) ? s : best))
}

// A meeting that was chosen, not found: its area stays when a start changes, and only the travel times move. Once the group has moved on
// from choosing where to meet (voting or later), every meeting area is chosen, also the app's first spot confirmed with no votes on it: a
// changed start never moves it on its own (Faith's walkthrough, 30 October 2026, as on the server). The host chooses it again from new
// suggestions instead (changeMeetingPlace), which the session page offers.
// How to call: pinnedAreaOf(session) -> 'bugis', or null
const pinnedAreaOf = (session) => (session.meeting && (['voted', 'chosen'].includes(session.meeting.method) || !['inviting', 'locating'].includes(session.status)) ? session.meeting.areaId : null)

// A chosen meeting area, with its travel times from the starts there are. Asks the planner once, to price that area.
// With no start shared there is nothing to ask. Returns { meeting, pinnedSpot } (pinnedSpot: the area's new numbers).
// How to call: await computePinned(session, membersFor(session), 'bugis')
async function computePinned(session, members, areaId, method = session.meeting.method, { bar = true } = {}) {
  if (!members.length) return { meeting: meetingAtSpot(areaId, method, { times: {}, worstMinutes: null, approximate: false }), pinnedSpot: null }
  const data = await askMeeting(session, members, { include: [areaId] }, { bar })
  const candidate = candidatesOf(data).find((c) => c.area.id === areaId)
  if (!candidate) throw new Error(`The planner could not work out travel times to ${areaById(areaId).name}.`)
  const pinnedSpot = { areaId, ...pricedSpot(candidate, estimatedBy(data)) }
  return { meeting: meetingAtSpot(areaId, method, pinnedSpot), pinnedSpot }
}

// Put a chosen area's new numbers on its spot in the list, when it has one.
// How to call: refreshSpot(session, { areaId, worstMinutes, meanMinutes, exactWorst, times, approximate })
function refreshSpot(session, priced) {
  const spot = session.spots.list.find((s) => s.areaId === priced.areaId)
  if (spot) Object.assign(spot, { worstMinutes: priced.worstMinutes, meanMinutes: priced.meanMinutes, exactWorst: priced.exactWorst, times: { ...priced.times }, approximate: priced.approximate })
}

// The meeting area, and while the group is choosing where to meet, the spots. One request to the planner does both.
// Returns { meeting, spots, pinnedSpot }: meeting in the shape meetingResultLine and recalculate read ({ areaId, method,
// times, maxMinutes, ... }), spots as spotsFrom gives them (or null when they are not worked out in this state).
// How to call: const { meeting, spots } = await computeMeeting(session)
async function computeMeeting(session) {
  const members = membersFor(session)
  const pinned = pinnedAreaOf(session)
  if (pinned) return { spots: null, ...(await computePinned(session, members, pinned)) }
  const locating = session.status === 'locating'
  if (members.length < P.MIN_LOCATIONS) return { meeting: null, spots: locating ? NO_SPOTS : null, pinnedSpot: null }
  // While the group is collecting locations, the meeting point waits for everyone, but the spots are listed from two
  // starts on. Once the plan has moved on, a late location (someone invited later) is worked in through the re-plan
  // prompt instead.
  const wantMeeting = !locating || members.length === activeIds(session).length
  const extra = locating ? { alternatives: APP_SPOTS - 1, include: suggestedAreas(session) } : {}
  const data = await askMeeting(session, members, extra, { bar: wantMeeting, spots: locating })
  return { meeting: wantMeeting ? meetingFrom(members, data) : null, spots: locating ? spotsFrom(members, data) : null, pinnedSpot: null }
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

// The plan forming in a shared session: the categories (slots) someone voted in, at the times the server gave them.
// How to call: votedSlotsOf(session) -> [{ id, category, start, time, duration, picks }]
function votedSlotsOf(session) {
  return (session.slotRows || []).filter((slot) => !slot.deleted && Object.keys(session.votes?.[slot.id] || {}).length)
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
    members: rankingMembers(session),
    centre: areaById(session.meeting.areaId),
    date: session.date,
    slot,
    lastStop: slots[slots.length - 1]?.id === slot.id,
    currentOptionIds,
    conditions: db.conditions,
    radiusMeters: session.radius || undefined,
    topN: RANKED_MAX,
    dietPolicy: dietPolicy(session, slot.category),
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

// What a request for the meeting area and spots depended on: who has a start and where, who is in, whether the group is
// still choosing (or has confirmed an area, which then stays), the routing switch, and the areas members suggested.
// How to call: askedFor(session) -> { basis: '...', suggested: ['bugis'] }
const askedFor = (session) => ({
  basis: JSON.stringify([session.status === 'locating', pinnedAreaOf(session), db.conditions.routing, activeIds(session), membersFor(session)]),
  suggested: suggestedAreas(session),
})
// Was an answer asked for the session as it is now? It must be for the same starts, people and state, and have priced every
// area suggested since (an extra priced area does no harm).
// How to call: fitsNow(asked, session) -> true
function fitsNow(asked, session) {
  const now = askedFor(session)
  return now.basis === asked.basis && now.suggested.every((areaId) => asked.suggested.includes(areaId))
}

// Per session, whether the newest request put its answer in (true), or failed or was out of date (false).
const newestRun = {}
// How many times a request asks again when what it asked for has changed meanwhile.
const ASK_AGAIN = 3

// Ask the planner about the session as it is now and put the answer in with `apply(answer)`, so that an older answer never
// overwrites a newer state. Every request that rebuilds the meeting area or the spots shares one ticket. An answer is put
// in only if it is the newest request's and was asked for the starts, people and suggestions the session has now; if it
// is not the newest, it waits for the newer one and, when that one fails, asks again; if the session changed in a way no
// newer request covers (the host confirmed a spot, say), it asks again for the session as it is. `ask` runs for each try.
// Returns true when an answer is in (this request's or a newer one's), false after the last try.
// How to call: await latestAnswer(session, () => computeMeeting(session), async (answer) => { session.meeting = answer.meeting })
async function latestAnswer(session, ask, apply) {
  for (let attempt = 0; attempt < ASK_AGAIN; attempt++) {
    const isLatest = takeTicket(session, 'meeting')
    const asked = askedFor(session)
    let settle
    newestRun[session.id] = new Promise((resolve) => { settle = resolve })
    let put = false
    try {
      const answer = await ask()
      if (isLatest() && fitsNow(asked, session)) {
        await apply(answer)
        put = true
        return true
      }
    } finally {
      settle(put)
    }
    if (!isLatest() && (await newestRun[session.id])) return true
  }
  return false
}

// Every place that fits a slot, best first: the suggestions, then current options ranked further down.
const rankedIds = (ranked) => [...new Set([...ranked.options, ...ranked.current].map((o) => o.venue.id))]

// Keep the options in step with the current slots: drop options that no longer fit, top up to three,
// and drop votes for options or people that are gone.
// `fresh`: the group's dietary filter changed, so the list is picked again from the new ranking: only the places someone voted
// for stay (while they still fit), and the rest are the planner's best for the new needs. Without it, every place that still fits
// stays, so a filter that the places already met (halal, then halal and vegetarian at the same food centres) would change nothing.
// How to call: await syncOptions(session, { fresh: true })
async function syncOptions(session, { fresh = false } = {}) {
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
    const votes = session.votes[slot.id] || {}
    const voted = new Set(Object.values(votes))
    const keep = fresh ? (session.options[slot.id] || []).filter((venue) => voted.has(venue)) : session.options[slot.id]
    nextOptions[slot.id] = P.reconcileOptions(keep, rankedIds(rankings[i]))
    nextVotes[slot.id] = Object.fromEntries(Object.entries(votes).filter(([person, venue]) => ids.includes(person) && nextOptions[slot.id].includes(venue)))
  })
  session.options = nextOptions
  session.votes = nextVotes
}

// The sentence that follows a banner when the meeting area moved and took the votes with it.
const VOTES_CLEARED = 'Votes for places were cleared.'
// Does a session hold any vote for a place? How to call: hasVotes(session) -> true
const hasVotes = (session) => Object.values(session.votes || {}).some((votes) => Object.keys(votes).length > 0)

// Work what the planner answered into the session after a trigger: the meeting area, the spots (while choosing) and the place
// options. Runs only for an answer that is current (see latestAnswer).
// How to call: await putInMeeting(session, { kind: 'start', personName: 'Ian' }, await computeMeeting(session))
async function putInMeeting(session, trigger, { meeting: next, spots, pinnedSpot }) {
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
  // The spots are new too (while locating). Approvals for a spot that dropped out of the list went with it.
  const lost = spots ? applyPlannedSpots(session, spots) : []
  if (pinnedSpot) refreshSpot(session, pinnedSpot)
  // Votes that were there and are gone: the banner says so, and SessionNotices shows it (votesCleared).
  const cleared = outcome.clearVotes && hasVotes(session)
  if (outcome.clearVotes) session.votes = {}
  if (outcome.refreshSuggestions) session.options = {}
  await syncOptions(session)
  let text = outcome.banner ? (cleared ? `${outcome.banner} ${VOTES_CLEARED}` : outcome.banner) : null
  if (lost.length) text = lostApprovalsBanner(text || P.recalcBanner({ previousName: null, nextName: null, trigger }), lost).text
  if (text) session.banner = { text, at: Date.now(), ...(cleared ? { votesCleared: true } : {}), ...(lost.length ? { approvalsRemoved: true } : {}) }
}

// A start or end location changed, a late location arrived, or someone opted out. The answer is put in only if it is
// current: not the newest request's, or asked before the host confirmed a spot, it is dropped and asked again.
// How to call: await applyTrigger(session, { kind: 'start', personName: 'Ian' })
async function applyTrigger(session, trigger) {
  await latestAnswer(session, () => computeMeeting(session), (answer) => putInMeeting(session, trigger, answer))
}

// ── A write that fails takes back only its own change ───────────────────────

// Writes saved so far, per session. A write that fails compares it with the count it began at: a different count means
// another write was saved while it waited (a host confirmed, someone said a spot works for them).
const commits = {}
const commitsOf = (session) => commits[session.id] || 0
// The writes now waiting on the planner, per session, with what each changed straight away.
const waiting = {}

// Forget everything kept per session id in this file. Every account's first session is `s1`, so when the signed-in account
// changes (or the save is replaced) what was kept for the last one's `s1` must not be taken for the next one's. Answers still
// on their way for the old account find their ticket gone and are dropped. (The venues the planner sent for "What next?" are
// public places keyed by venue id, not by session, and are not account data.)
// How to call: resetSessionState() (when db is replaced by another account's)
function resetSessionState() {
  for (const kept of [tickets, newestRun, commits, waiting]) for (const key of Object.keys(kept)) delete kept[key]
  finding.clear()
  findingSpots.clear()
  // What was read from the server belongs to the last account, and so does the channel that listens for it.
  serverMembers.clear()
  slotSessions.clear()
  heldRows.clear()
  newestRead.clear()
  newestPlanRead.clear()
  opened.clear()
  repairs.clear()
  dismissedBanners.clear()
  shownBasis.clear()
  tripsHomeKnown.clear()
  tripsHomeAsked.clear()
  tripsHomeWanted.clear()
  unlistedVenues.clear()
  epoch += 1
  closeChannel()
}

// An object that is not an array or null. How to call: isPlain({}) -> true
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
// Equal as stored data (the session is plain JSON). How to call: sameValue({ a: 1 }, { a: 1 }) -> true
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// The value at a path of keys, or undefined. How to call: valueAt({ a: { b: 1 } }, ['a', 'b']) -> 1
const valueAt = (root, path) => path.reduce((value, key) => (value == null ? undefined : value[key]), root)

// Where two values differ, as paths of keys, going down through objects; an array or a plain value is compared whole.
// How to call: changedPaths({ a: { b: 1, c: 1 } }, { a: { b: 2, c: 1 } }) -> [['a', 'b']]
function changedPaths(from, to, path = []) {
  if (isPlain(from) && isPlain(to)) return [...new Set([...Object.keys(from), ...Object.keys(to)])].flatMap((key) => changedPaths(from[key], to[key], [...path, key]))
  return sameValue(from, to) ? [] : [path]
}

// Put a value at a path; undefined removes it. A path whose parent is gone is left alone.
// How to call: putAt(session, ['spots', 'suggestions', 'faith'], undefined)
function putAt(root, path, value) {
  const parent = valueAt(root, path.slice(0, -1))
  if (!isPlain(parent)) return
  if (value === undefined) delete parent[path.at(-1)]
  else parent[path.at(-1)] = value
}

// Do two paths run into each other (one is the start of the other)? How to call: overlap(['a', 'b'], ['a']) -> true
const overlap = (a, b) => a.slice(0, b.length).every((key, i) => key === b[i]) && b.slice(0, a.length).every((key, i) => key === a[i])

// Put back what a failed write changed. Alone, that is the whole session as it was. With others around it is only its own
// change: what it changed straight away goes back unless someone changed it since; what it changed later (after the
// planner answered) goes back only if no other write was saved meanwhile, and never what another waiting write changed.
// Whatever the session moved on to (a confirmed spot, an approval) stays.
// How to call: takeBack(session, before, mine, commitsAtStart)
function takeBack(session, before, mine, commitsAtStart) {
  const others = [...(waiting[session.id] || [])].filter((entry) => entry !== mine)
  const movedOn = commitsOf(session) !== commitsAtStart
  if (!others.length && !movedOn) {
    for (const key of Object.keys(session)) delete session[key]
    Object.assign(session, before)
    return
  }
  mine.paths.forEach((path, i) => {
    if (sameValue(valueAt(session, path), mine.values[i])) putAt(session, path, clone(valueAt(before, path)))
  })
  if (movedOn) return
  const theirs = others.flatMap((entry) => entry.paths)
  for (const path of changedPaths(before, session)) if (!theirs.some((other) => overlap(path, other))) putAt(session, path, clone(valueAt(before, path)))
}

// For a write that needs the planner: if the planner cannot answer, take back what the write changed, so nothing is
// half-saved (a location kept but not shown, Voting with no options). The caller still gets the error. It takes back
// only the write's own change: if the session moved on meanwhile (the host confirmed a spot), that stays.
// How to call: return orUndo(session, async () => { session.locations.ian = place; await applyTrigger(...); return touch(session, 'location') })
async function orUndo(session, change) {
  const before = clone(session)
  const commitsAtStart = commitsOf(session)
  const running = change()
  // The part of the write that ran before its first wait is the write's own, whatever else is going on.
  const mine = { paths: changedPaths(before, session) }
  mine.values = mine.paths.map((path) => clone(valueAt(session, path)))
  const mineAndOthers = (waiting[session.id] ||= new Set())
  mineAndOthers.add(mine)
  try {
    return await running
  } catch (err) {
    takeBack(session, before, mine, commitsAtStart)
    // Save the session as it was, and show it again (a "pending" update may have shown the change already).
    // If storage refuses even that, the caller still gets the first error, which is the one worth reading.
    save()
    broadcast({ type: 'pending', sessionId: session.id })
    throw err
  } finally {
    mineAndOthers.delete(mine)
  }
}

// Save, tell subscribers, and answer with the session as getSession would.
function touch(session, type) {
  session.updatedAt = Date.now()
  emit({ type, sessionId: session.id })
  commits[session.id] = commitsOf(session) + 1
  announceCoMembers()
  return summary(session)
}

// ── Account ────────────────────────────────────────────────────────────────

// The account, with its home area's name. `id` is the id the account's data carries: the sample person's id for a local
// account (the demo account, and every account when Supabase is not set up), and the Supabase user id for a real one, which
// is then the same as `authId`. `authId` is null for a local account; `local` is true for it. `email` is '' when none is known.
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
// `known`: the details just typed at sign-up ({ name, username, dob, homeAreaId, dietary, photo }); without it the
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
  const sameAccount = found.user?.authId === sessionUser.id
  let mine = sameAccount && found.user.id === sessionUser.id ? found : null
  const was = sameAccount ? found.user : null
  // Whatever is stored under this account's key and is not taken up as it is (a save from the build when every real account
  // was the sample person, an older version, something unreadable) is copied to a key of its own before anything is written
  // over it. A save of the old real-account kind is then moved to this account's id, table by table (lib/legacySave.js), so
  // the person keeps their sessions; if that cannot be done, they start fresh and the copy is what is left.
  const raw = readRaw(key)
  let backedUp = true
  if (raw && !mine) {
    backedUp = backUp(key, raw)
    const old = parseOrNull(raw)
    if (old && old.version === VERSION && isLegacyRealSave(old, HOST_ID, sessionUser.id) && hasShape(old)) {
      try {
        const moved = remapLegacySave(old, HOST_ID, sessionUser.id, { isSample: personById })
        if (hasShape(moved)) mine = moved
      } catch {
        mine = null
      }
    }
  }
  const pick = known || remote || {}
  const user = {
    id: sessionUser.id,
    authId: sessionUser.id,
    email: sessionUser.email || was?.email || '',
    name: pick.name || was?.name || sessionUser.username || '',
    username: pick.username || was?.username || sessionUser.username || '',
    // The date of birth is never read from the save (it is not written to it): it comes from the account or the session.
    dob: pick.dob || sessionUser.dob || '',
    // A photo stays in this browser: it is a data URL in the save, never uploaded.
    photo: known ? known.photo || '' : was?.photo || '',
    homeAreaId: pick.homeAreaId || was?.homeAreaId || '',
    dietary: cleanDietary(pick.dietary ?? was?.dietary),
  }
  const { conditions } = db
  if (mine) {
    db = { ...mine, user }
  } else {
    // A real account has no sample friends, whatever the sign-up draft held.
    db = freshDb({ user, friends: [] })
    db.conditions = conditions
  }
  people.reset()
  coMembersSeen = ''
  resetSessionState()
  // With no copy of the old save kept, nothing is written this visit: the account works in memory and the old save stays.
  storageKey = backedUp ? key : null
  stored = asText()
  // A save that cannot be written (storage full or missing) does not stop sign-in: the account works in memory.
  save()
  broadcast({ type: 'user' })
  // Screens already waiting for live updates get them for the new account.
  openChannel()
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
// date of birth, home area and dietary needs. A field changed here while the read was running is left as it is. Quiet when the read
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
  // An empty list is a real answer ("no needs"), and two lists are compared by what they hold.
  const dietary = cleanDietary(remote.dietary)
  if (db.user.dietary === before.dietary && dietary.join() !== cleanDietary(db.user.dietary).join()) changes.dietary = dietary
  if (Object.keys(changes).length === 0) return
  db.user = { ...db.user, ...changes }
  // A save that cannot be written does not matter here: the change is in memory.
  save()
  broadcast({ type: 'user' })
  if (changes.dietary) refiltering = refilterForDiet()
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
  people.reset()
  coMembersSeen = ''
  resetSessionState()
  storageKey = null
  stored = asText()
}

// The Supabase session changed without this app asking: another tab signed out (or in), or the refresh token expired.
auth.onChange(({ event, user }) => {
  // A password reset link was accepted. Said before the check below, because it can arrive while the session is being read.
  if (event === 'recovery') {
    broadcast({ type: 'recovery' })
    return
  }
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

// profile: { email, name, username, dob ('YYYY-MM-DD'), photo?, homeAreaId, dietary?, friends?, demo? }. Rejects with a message fit
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
  // The demo account, and a local account, are the sample person Ian: that is the id their data carries.
  const user = {
    id: HOST_ID,
    email: profile.email,
    name: profile.name.trim(),
    username: profile.username,
    dob: profile.dob,
    photo: profile.photo || '',
    homeAreaId: profile.homeAreaId,
    dietary: cleanDietary(profile.dietary),
    ...(profile.demo ? { demo: true } : {}),
  }
  // Ian's starting numbers (stats, season standings) depend on the kind of account, so they are made again for it.
  const { conditions } = db
  db = freshDb({ user, friends: [...(profile.friends || [])] })
  db.conditions = conditions
  people.reset()
  resetSessionState()
  if (storageKey !== STORAGE_KEY) {
    // Coming from a real account (or from nobody): a local account writes to the local save again.
    storageKey = STORAGE_KEY
    stored = asText()
  }
  emit({ type: 'user' })
  return account()
}

// A real sign-up. The photo stays in this browser, in the account's own save; the dietary needs are kept there too, under
// the account's own id, and are also written to the account (profile_private.dietary). The friends the sign-up draft may
// hold are not kept: a real account starts with none (see freshDb).
// How to call: await signUpReal({ email, password, name, username, dob, homeAreaId, dietary })
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
      dietary: cleanDietary(profile.dietary),
    })
    if (result.needsConfirmation) return { needsConfirmation: true, email: result.user.email }
    const known = { name, username: profile.username, dob: profile.dob, homeAreaId: profile.homeAreaId, dietary: cleanDietary(profile.dietary), photo: profile.photo }
    const mine = await adopt(result.user, known)
    // The name, home area and dietary needs are written to the account in the background; a failure is announced when it happens.
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

// Email a link for choosing a new password. Only for real accounts; the link opens /reset-password on this site.
// Resolves the same way whether or not the email is registered. Rejects with the messages in lib/auth.js.
// How to call: await requestPasswordReset('sam@example.com')
export async function requestPasswordReset(email) {
  await wait(DELAY.write)
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  await auth.requestPasswordReset(email, `${origin}/reset-password`)
}

// Was the session in this tab started by a password reset link, and not yet finished with? The reset page shows its form
// only then. Always false with local accounts.
// How to call: if (passwordRecovery()) showTheForm()
export function passwordRecovery() {
  return auth.recoveryPending()
}

// Set a new password for the signed-in real account (the reset link signs the person in). Rejects with the messages
// in lib/auth.js, including MESSAGES.reset_link_invalid when there is no session to change.
// How to call: await changePassword('N3w-secret!')
export async function changePassword(password) {
  await wait(DELAY.write)
  await auth.updatePassword(password)
}

// Change the signed-in real account's password from the edit-profile page: the current password is checked with
// Supabase first, and only then is the new one set. The listener for session changes is held off while the check signs
// the same person in again. Rejects with the messages in lib/auth.js, MESSAGES.wrong_password when the current
// password is not right, and a plain sentence for a local account, which has no password.
// How to call: await changeOwnPassword({ current: 'Sup3rSecret!', next: 'N3wSecret!' })
export async function changeOwnPassword({ current, next }) {
  await wait(DELAY.write)
  if (!db.user?.authId) throw new Error('This account lives only in this browser and has no password to change.')
  acting += 1
  try {
    await auth.checkPassword(db.user.email, current, db.user.authId)
    await auth.updatePassword(next)
  } finally {
    acting -= 1
  }
}

// What a signed-in person may change on a real account: the name, photo, home area, date of birth and dietary needs. The username
// and email are not editable.
const REAL_EDITABLE = ['name', 'photo', 'homeAreaId', 'dob', 'dietary']

// patch: { name?, photo?, homeAreaId?, dob?, dietary?, ... }. A local account takes any field, as before. A real account
// takes the five it may edit, and all but the photo are also written to Supabase. The change is kept
// here even when that write fails: the answer then carries `syncError` with a message to show.
// How to call: const user = await updateUser({ name: 'Sam T.' })
export async function updateUser(patch) {
  await wait(DELAY.write)
  const dietBefore = cleanDietary(db.user?.dietary).join()
  if (!db.user?.authId) {
    db.user = { ...db.user, ...patch }
    emit({ type: 'user' })
    if (cleanDietary(db.user.dietary).join() !== dietBefore) refiltering = refilterForDiet()
    return account()
  }
  const allowed = Object.fromEntries(REAL_EDITABLE.filter((key) => key in patch).map((key) => [key, patch[key]]))
  db.user = { ...db.user, ...allowed }
  emit({ type: 'user' })
  if (cleanDietary(db.user.dietary).join() !== dietBefore) refiltering = refilterForDiet()
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
  people.reset()
  resetSessionState()
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

// Is this email already used by an account? With Supabase set up this asks the Jio backend (POST /api/accounts/email-check),
// which asks the database with its own key and limits how often one caller may ask; the browser cannot ask the database
// itself. With local accounts nothing is registered anywhere else, so the answer is always no. Rejects when the check
// cannot be made (no connection, over the limit, the backend or database down): the sign-up screen then carries on,
// and the sign-up itself still catches a registered email at the end.
// How to call: const { registered } = await checkEmail('sam@example.com')
export async function checkEmail(email) {
  await wait(DELAY.read)
  if (auth.configured()) return { registered: await planner.emailRegistered(email) }
  return { registered: false }
}

// ── People, friends and the leaderboard ────────────────────────────────────

// The ids of the other people in this account's sessions, in whatever state (someone who opted out shared a session too),
// in the order they first appear. For a real
// account these are its friends: a person's friends are whoever they have shared a session with (decided on ticket #125).
// How to call: coMemberIds() -> ['7f3c...']
function coMemberIds() {
  const ids = new Set()
  for (const members of serverMembers.values()) for (const id of members) if (id !== me()) ids.add(id)
  for (const session of db.sessions) for (const m of session.members) if (m.id !== me()) ids.add(m.id)
  return [...ids]
}

// How to call: announceCoMembers() (after a session changed; nothing happens unless the people in the sessions changed)
function announceCoMembers() {
  if (!isReal()) return
  const now = coMemberIds().join(',')
  if (now === coMembersSeen) return
  coMembersSeen = now
  broadcast({ type: 'people' })
}

// A person as a screen shows them. A real account's friends are the people it shares a session with; everyone else's are
// the ones it added. `sample` is true for a made-up person, so a screen can say so and offer no friend button for it to
// a real account.
// How to call: publicPerson('darius') -> { id, name, username, photo, homeAreaId, homeArea, meetups, points, isFriend, sample }
function publicPerson(id) {
  const isMe = id === me() && !!db.user
  const base = personById(id)
  const known = people.get(id)
  const stats = db.stats[id] || noStats()
  const homeAreaId = isMe ? db.user.homeAreaId : base?.homeAreaId || ''
  return {
    id,
    name: people.nameOf(id),
    username: known?.username || '',
    photo: isMe ? db.user.photo : known?.avatarUrl || '',
    homeAreaId,
    homeArea: areaById(homeAreaId)?.name || '',
    meetups: stats.meetups,
    points: stats.points,
    isFriend: isReal() ? coMemberIds().includes(id) : db.friends.includes(id),
    sample: !isMe && !!base,
  }
}

// The people other than the signed-in one that this account knows. The demo and local accounts: the sample people. A real
// account: the people in its sessions (none until a session is shared), read from their profiles in one request.
// How to call: const people = await listPeople()
export async function listPeople() {
  await wait(DELAY.read)
  // With nobody signed in (the sign-up screen's friends step) the sample person is the one signing up, so is left out too.
  if (!isReal()) return PEOPLE.filter((p) => p.id !== (me() || HOST_ID)).map((p) => publicPerson(p.id))
  const ids = coMemberIds()
  await people.load(ids)
  return ids.map(publicPerson)
}

// One person's profile. The demo and local accounts: any sample person. A real account: itself, a person in one of its
// sessions, or a sample person met as the writer of a sample review. Anyone else does not exist as far as it can tell.
// How to call: const profile = await getPerson('darius')
export async function getPerson(id) {
  await wait(DELAY.read)
  const known = id === me() || !!personById(id) || (isReal() && coMemberIds().includes(id))
  if (!known) throw new Error('This person does not exist.')
  if (!people.get(id)) await people.load([id])
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
  const { ids: friendIds, common } = friendsOf(id)
  await people.load(friendIds.filter((x) => !people.get(x)))
  const friends = friendIds.map(publicPerson).sort((a, b) => a.name.localeCompare(b.name))
  return { ...publicPerson(id), sessions, activity, history, planned, friends, friendsInCommon: common }
}

// Whose friends a profile lists (walkthrough, 30 October 2026: a "Friends" count on every profile opens the list, as on Instagram).
// The signed-in person: their own friends (the ones they added, or for a real account the people they have shared a session with).
// Someone else, for the demo and local accounts: sample data, the rest of the sample circle (Darius, Jonathan, Nicole, Faith, Darryl
// are friends with each other), plus the signed-in person if they are friends. Someone else, for a real account: another person's
// friends cannot be read, so it is the friends in common (`common: true`), the people who have been in a session with both.
// How to call: friendsOf('darius') -> { ids: ['faith', 'nicole', ...], common: false }
function friendsOf(id) {
  const meId = me()
  if (id === meId) return { ids: isReal() ? coMemberIds() : [...db.friends], common: false }
  if (isReal()) {
    const mine = new Set(coMemberIds())
    const shared = new Set()
    const memberLists = [...serverMembers.values(), ...db.sessions.map((x) => x.members.map((m) => m.id))]
    for (const members of memberLists) if (members.includes(id)) for (const other of members) if (other !== id && other !== meId && mine.has(other)) shared.add(other)
    return { ids: [...shared], common: true }
  }
  const sample = isCommunity(id) ? [] : PEOPLE.filter((p) => !isCommunity(p.id) && p.id !== id && p.id !== HOST_ID).map((p) => p.id)
  const withMe = db.friends.includes(id) && meId ? [meId] : []
  return { ids: [...new Set([...withMe, ...sample])].filter((x) => x !== id), common: false }
}

// Add or remove a friend. Only the demo and local accounts keep a list of their own; a real account's friends are the people
// it shares sessions with, so there is nothing to add yet.
// How to call: await setFriend('nicole', true)
export async function setFriend(id, isFriend) {
  await wait(DELAY.write)
  if (isReal()) throw new Error('Friends are the people you share a session with.')
  db.friends = isFriend ? [...new Set([...db.friends, id])] : db.friends.filter((f) => f !== id)
  emit({ type: 'friends' })
  return [...db.friends]
}

// ── Seasons ────────────────────────────────────────────────────────────────

// What decides a season: points earned this season, then all-time points from meetups, then the name.
// How to call: standingOf('ian') -> { id, name, seasonPoints, allTime }
const standingOf = (id) => ({ id, name: nameOf(id), seasonPoints: statsOf(id).seasonPoints, allTime: statsOf(id).meetups * POINTS_PER_MEETUP })

// End the current season at `at`: the winner get the prize to spend, then season points start again.
function closeSeason(at) {
  const ended = { ...db.season, endsAt: at }
  const winners = Season.seasonWinners(leaderboardIds().map(standingOf))
  for (const id of winners) statsOf(id).points += Season.SEASON_PRIZE
  // standings: everyone's season total, so the leaderboard can show a past season in full.
  const standings = leaderboardIds().map((id) => ({ id, seasonPoints: statsOf(id).seasonPoints }))
  db.pastSeasons.unshift({ ...ended, prize: Season.SEASON_PRIZE, winners: winners.map((id) => ({ id, seasonPoints: statsOf(id).seasonPoints })), standings })
  for (const id of Object.keys(db.stats)) db.stats[id].seasonPoints = 0
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
    winners: (season.winners || []).map((w) => ({ ...w, name: nameOf(w.id), isMe: w.id === me() })),
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
  return ranked(leaderboardIds().map((id) => ({ id, seasonPoints: statsOf(id).seasonPoints })))
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
    if (!row.seasonPoints) return { ...row, rank: null, isMe: row.id === me() }
    if (row.seasonPoints !== last) {
      rank = i + 1
      last = row.seasonPoints
    }
    return { ...row, rank, isMe: row.id === me() }
  })
}

// ── Places ─────────────────────────────────────────────────────────────────

export async function listAreas() {
  await wait(DELAY.read)
  return clone(AREAS)
}

// The area nearest to a point, or null outside Singapore. The one rule that turns a coordinate into an area:
// the current location and every address the backend finds go through it.
// How to call: areaForPoint({ lat: 1.3521, lng: 103.9448 }) -> the Tampines area
function areaForPoint(point) {
  return P.inSingapore(point) ? P.nearest(point, AREAS) : null
}

const PLACE_ROWS = 8
const ANSWERS_KEPT = 40
// What the backend answered for each query this page has searched, so typing a word again (or backspacing to it) asks
// nothing. Only answers are kept, never failures. Oldest out first.
const placeAnswers = new Map()

const cancelled = () => Object.assign(new Error('The search was cancelled.'), { name: 'AbortError' })

// The backend's results as rows for the search sheet. Only the area they fall in is kept with the building's name, never
// their coordinates. A result outside Singapore, or with no name, is left out; so is a repeat of an earlier row.
// How to call: addressRows([{ name: 'TAMPINES MALL', postal: '529510', lat: 1.3525, lng: 103.9447 }])
function addressRows(results) {
  const seen = new Set()
  const rows = []
  for (const r of results) {
    const area = Number.isFinite(r?.lat) && Number.isFinite(r?.lng) ? areaForPoint(r) : null
    const label = displayName(r?.name)
    if (!area || !label) continue
    const key = `${sameKey(label)}|${r.postal || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({
      id: `om-${r.postal || sameKey(label)}-${rows.length}`,
      label,
      sub: [r.postal && `Singapore ${r.postal}`, area.name].filter(Boolean).join(' · '),
      areaId: area.id,
      areaName: area.name,
      near: label,
    })
  }
  return rows
}

// Can this server read places out of a pasted post? `{ enabled: false }` when it cannot (the route is off, or no AI key).
// How to call: const { enabled } = await postReaderStatus()
export function postReaderStatus() {
  return planner.postReaderCapabilities()
}

// The places named in a pasted post, with their addresses where Google has them (plannerApi.js readPost says what comes back).
// Nothing is saved: the screen shows the answer and lets the person open a place in Google Maps.
// How to call: const answer = await placesFromPost('https://vt.tiktok.com/ZS123/', { signal })
export function placesFromPost(url, { signal } = {}) {
  return planner.readPost(url, { signal })
}

// Search for a start or end location by place name, address or postal code.
// The areas that match come first and at once (onBuiltIn gets them before any network call, so a caller can show them
// while the rest is searched). Then the backend's address search (OneMap) adds addresses and buildings, each with the
// area it falls in. A query under 2 characters, or over what the backend accepts, stays on this page. When the backend
// cannot be reached or answers an error, the areas still come back with unavailable: true, and the built-in sample
// addresses are listed too, as they are whenever the backend had nothing. At most 8 rows.
// `signal` cancels the search: it rejects with an AbortError and the caller drops it.
// Rows are { id, label, sub, areaId, areaName, near }. They carry no coordinates: what a person stores from one is the area
// and the label (setLocation), and the label is private to them.
// How to call: const { places, unavailable } = await searchPlaces('tampines mall', { signal, onBuiltIn: (rows) => show(rows) })
export async function searchPlaces(query, { signal, onBuiltIn } = {}) {
  const text = String(query ?? '').trim()
  const q = text.toLowerCase()
  if (!q) return { places: [], unavailable: false }
  if (signal?.aborted) throw cancelled()
  const areas = AREAS.filter((a) => a.name.toLowerCase().includes(q)).map((a) => ({ id: a.id, label: a.name, sub: 'MRT station and area', areaId: a.id, areaName: a.name, near: null }))
  onBuiltIn?.(areas.slice(0, PLACE_ROWS))

  let found = []
  let unavailable = false
  if (text.length >= SEARCH_MIN_CHARS && text.length <= SEARCH_MAX_CHARS) {
    if (placeAnswers.has(q)) {
      found = placeAnswers.get(q)
    } else {
      try {
        found = addressRows(await planner.searchAddresses(text, { signal }))
        placeAnswers.set(q, found)
        if (placeAnswers.size > ANSWERS_KEPT) placeAnswers.delete(placeAnswers.keys().next().value)
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw cancelled()
        unavailable = true
      }
    }
  }
  if (signal?.aborted) throw cancelled()

  // The areas stand for themselves: a result that is only one of them under another spelling ("Tampines MRT Station") goes.
  const known = new Set(areas.map((a) => sameKey(a.label)))
  const wider = found.filter((row) => !known.has(sameKey(row.label)))
  // The sample addresses are the fallback for when the backend gave nothing.
  const samples = found.length
    ? []
    : ADDRESSES.filter((a) => a.label.toLowerCase().includes(q) || a.postal.startsWith(q)).map((a) => {
        const area = areaById(a.areaId)
        return { id: a.id, label: a.label, sub: `Singapore ${a.postal} · ${area.name}`, areaId: a.areaId, areaName: area.name, near: a.label.split(',')[0] }
      })
  return { places: [...areas, ...wider, ...samples].slice(0, PLACE_ROWS), unavailable }
}

// The known area for a pair of coordinates, or null outside Singapore.
// How to call: await placeFromCoords(1.3521, 103.9448) -> { id: 'here-tampines', label: 'Current location', sub: 'Tampines', areaId: 'tampines' }
export async function placeFromCoords(lat, lng) {
  await wait(DELAY.read)
  const area = areaForPoint({ lat, lng })
  if (!area) return null
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

// Locations as other people may see them: the area only. The exact label is kept for the viewer (the signed-in person) alone.
function publicLocations(session) {
  const place = (loc, own) => {
    if (!loc) return null
    const area = areaById(loc.areaId)
    return { areaId: area.id, name: area.name, lat: area.lat, lng: area.lng, ...(own ? { label: loc.label } : {}) }
  }
  return Object.fromEntries(
    Object.entries(session.locations).map(([id, loc]) => [id, { start: place(loc.start, id === me()), end: place(loc.end, id === me()) }]),
  )
}

// The meeting spots as the screens read them: each spot with its area (name and the area's own coordinates, never a
// member's), who suggested it, who approved it and how many, and the spot the host is offered.
// How to call: spotsView(session) -> { list: [{ areaId, by, byName, here, worstMinutes, meanMinutes, times, approximate, area, approvedBy, approvalCount }], approvals, suggestions, preselectedAreaId, appMethod }
function spotsView(session) {
  const { list, approvals, suggestions, appMethod } = session.spots
  return {
    list: list.map((spot) => {
      const approvedBy = activeIds(session).filter((id) => approvals[id]?.includes(spot.areaId))
      return {
        ...clone(spot),
        byName: spot.by === 'app' ? null : nameOf(spot.by),
        area: { ...areaById(spot.areaId) },
        approvedBy: approvedBy.map((id) => ({ id, name: nameOf(id) })),
        approvalCount: approvedBy.length,
      }
    }),
    approvals: clone(approvals),
    suggestions: clone(suggestions),
    preselectedAreaId: preselectedSpot(session)?.areaId ?? null,
    appMethod,
  }
}

// A session as the screens read it. Photos are big (data URLs), so a session carries only their count:
// getPhotos has the pictures.
function summary(session, { warm = true } = {}) {
  // The plan forming so far: the categories with votes, at their times. A shared session's slots are the server's own.
  const slots = session.status === 'voting' && session.meeting ? (session.remote ? votedSlotsOf(session) : planSlotsOf(session)) : []
  const area = session.meeting ? areaById(session.meeting.areaId) : null
  const { photos, confirmedRanking, slotRows: _slotRows, ...rest } = session
  // A real person in the session is read from their profile; until then they show as "Someone".
  if (warm) warmPeople(session.members.map((m) => m.id))
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
    // The day has passed on a shared outing: nothing finishes it by itself, so its host may from the day on (lib/session.js itineraryAction).
    pastDay: !!session.remote && session.date < todayKey(),
    findingMeeting: finding.has(session.id),
    findingSpots: findingSpots.has(session.id),
    spots: spotsView(session),
    // Roam: places members proposed as the next stop and the host has not decided on yet, oldest first, each with who
    // proposed it and the place. A session saved before Roam has none.
    proposals: proposalsOf(session).flatMap((p) => {
      const venue = venueById(p.venueId)
      return venue ? [{ id: p.id, venueId: p.venueId, by: p.by, byName: nameOf(p.by), at: p.at, venue: clone(venue) }] : []
    }),
    hostName: nameOf(session.hostId),
    // The search radius the group chose, in metres, or null to let the planner widen on its own.
    radius: session.radius ?? null,
    slots: slots.map((s) => ({ ...s, optionCount: (session.options[s.id] || []).length })),
  }
}

export async function listSessions() {
  // A real account's sessions are the database's (the ones it is in), newest first.
  if (onServer()) {
    const asked = epoch
    const ticket = ++readCount
    const read = await remote.list()
    // The account changed while the read was out: what it found belongs to nobody now. It is not kept, not shown, and no
    // person in it is read from their profile.
    if (asked !== epoch) return []
    // The list is every session the account is in, so it also says which it has left or been taken out of.
    serverMembers.clear()
    // A session the list does not have is not one the person is in: its slots are forgotten. The slots of the others are remembered
    // below, for each session whose read is the newest.
    const listed = new Set(read.map((row) => row.id))
    for (const [slotId, sessionId] of [...slotSessions]) if (!listed.has(sessionId)) slotSessions.delete(slotId)
    for (const [stopId, sessionId] of [...stopSessions]) if (!listed.has(sessionId)) stopSessions.delete(stopId)
    for (const id of [...heldRows.keys()]) if (!listed.has(id)) heldRows.delete(id)
    const rows = read.map((row) => ({ row, session: fromServer(row) }))
    announceCoMembers()
    warmPeople(rows.flatMap(({ session }) => session.members.map((m) => m.id)))
    // A session read since this list began (a confirm, a live update) stands over what the list found of it.
    return rows.map(({ row, session }) =>
      newest(session.id, ticket, session.planVersion, () => {
        heldRows.set(row.id, row)
        rememberSlots(row.id, row.slotRows)
        rememberStops(row.id, row.plan)
        return summary(session, { warm: false })
      }),
    )
  }
  await wait(DELAY.read)
  settleOutings()
  db.sessions.forEach((s) => settleInvites(s))
  // One read for every real person in every session, not one per session.
  warmPeople(db.sessions.flatMap((s) => s.members.map((m) => m.id)))
  return db.sessions.map((s) => summary(s, { warm: false })).sort((a, b) => b.createdAt - a.createdAt)
}

// With `votesOnly`, a live vote reads the votes alone and folds them into the session as last handed out (the one request the change
// needs); a session never read before, or one whose slots are not known, is read whole.
// How to call: await getSession('3b1f...'); await getSession('3b1f...', { votesOnly: true })
export async function getSession(id, { votesOnly = false } = {}) {
  if (onServer()) {
    const asked = epoch
    const ticket = ++readCount
    let read
    try {
      const held = votesOnly ? heldRows.get(id) : null
      read = held?.slotRows?.length
        ? { ...held, votes: await remote.readSlotVotes(held.slotRows.map((slot) => slot.id), held.members.filter((m) => m.state === 'joined').map((m) => m.id)) }
        : await remote.get(id)
    } catch (err) {
      // No longer a session this account is in: its people are no longer people it shares a session with.
      if (err?.code === 'not_found' && asked === epoch) {
        serverMembers.delete(id)
        newestRead.delete(id)
        newestPlanRead.delete(id)
        heldRows.delete(id)
        forgetSlots(id)
        forgetStops(id)
      }
      throw err
    }
    // Read for the account before: not kept, not shown.
    if (asked !== epoch) throw Object.assign(new Error('That was read for another account.'), { code: 'stale' })
    // The places of the stops and of the proposals waiting are described so the plan and Roam can draw them. A session read does not fail
    // for want of them: the screens that need them (the itinerary) ask again and say so.
    if (!votesOnly) {
      await ensureVenues([...(read.plan?.stops || []).map((s) => s.venueId), ...(read.proposals || []).map((p) => p.venueId)]).catch(() => {})
      if (asked !== epoch) throw Object.assign(new Error('That was read for another account.'), { code: 'stale' })
    }
    const session = newest(id, ticket, read.planVersion, () => {
      heldRows.set(id, read)
      rememberSlots(id, read.slotRows)
      rememberStops(id, read.plan)
      return summary(fromServer(read))
    })
    announceCoMembers()
    repairSpots(read)
    return session
  }
  await wait(DELAY.read)
  // Opened by its address after its end time: it is finished now, not when Home next reads the list.
  settleOutings()
  return summary(sessionById(id))
}

// hostId: the app always makes the signed-in person the host. A friend's id makes a session that friend hosts, with the
// signed-in person already a guest in it (the demo's showcase uses it to show a session the person does not run).
// keepOpen: only the demo's own sessions (the showcase and the tour) pass it. Such a session is never finished or closed by
// its end time (lib/session.js dueEnding), so the demo stays as it was built whatever the hour it is loaded at.
// How to call: await createSession({ title: 'Dinner', date: '2026-10-17', start: '18:00', end: '21:00', hostId: 'darius' })
export async function createSession({ title, date, start, end, hostId = me(), keepOpen = false }) {
  if (onServer()) {
    requireMe(undefined, 'Log in to create a session.')
    const fields = checkSessionFields({ title, date, start, end })
    await assertFree(fields)
    const session = summary(fromServer(await remote.create(fields)))
    broadcast({ type: 'session', sessionId: session.id })
    return session
  }
  await wait(DELAY.write)
  requireMe(undefined, 'Log in to create a session.')
  if (hostId !== me() && !personById(hostId)) throw new Error('This person does not exist.')
  // The same checks as the server's path and the form, so a past day or a start that has passed is refused here too. The demo's own
  // sessions (keepOpen) are built at fixed times, some already under way, so they skip them.
  const fields = keepOpen ? { title: String(title ?? '').trim(), date, start, end } : checkSessionFields({ title, date, start, end })
  if (!keepOpen) await assertFree(fields)
  const session = {
    id: `s${db.seq++}`,
    ...fields,
    hostId,
    status: 'inviting',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    members: [{ id: hostId, role: 'host', state: 'joined' }, ...(hostId === me() ? [] : [{ id: me(), role: 'guest', state: 'joined' }])],
    locations: {},
    meeting: null,
    spots: emptySpots(),
    prefs: {},
    deletedSlots: [],
    options: {},
    votes: {},
    plan: null,
    banner: null,
    replan: null,
    photos: [],
    radius: null,
    ...(keepOpen ? { keepOpen: true } : {}),
  }
  db.sessions.push(session)
  return touch(session, 'session')
}

// Refuses a day and times that overlap another meetup the signed-in person is in, by throwing a ClashError that names it (the
// screens show it in a popup). A meetup being edited (`excludeId`) is not in its own way. A real account's meetups are the
// server's list; the demo and local accounts' are in the browser. The database refuses the same thing for a real account
// (db/migrations/20261028000000_jio_no_clashing_meetups.sql), so this is the early answer and not the only one.
// How to call: await assertFree({ date: '2026-10-28', start: '19:00', end: '21:00' }, { excludeId: 's1' })
async function assertFree({ date, start, end }, { excludeId = null } = {}) {
  const sessions = onServer() ? await listSessions() : db.sessions
  const clash = findClash(sessions, { me: me(), date, start, end, excludeId })
  if (clash) throw new ClashError(clash)
}

// The checks the create form makes before it lets a host carry on: a title of 1 to 60 characters, a real day from
// today to three months ahead (today in Singapore), two times of the day, the end after the start, and a start that has not
// passed yet in Singapore. Every way into the data layer that makes or changes a session's day and times uses it. Throws the
// first thing wrong; answers the values as they are stored (the title trimmed).
// `current`: the session being edited. When the day and times are the ones it already has, only its title is changing, so a day or
// start that has passed since is not held against the edit.
// How to call: checkSessionFields({ title: ' Dinner ', date: '2026-10-17', start: '18:00', end: '21:00' })
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
function checkSessionFields({ title, date, start, end }, { current = null } = {}) {
  const name = String(title ?? '').trim()
  if (!name) throw new Error('A session needs a title.')
  if (name.length > 60) throw new Error('A title can be at most 60 characters.')
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? parseISO(date) : null
  if (!day || !isValid(day) || format(day, 'yyyy-MM-dd') !== date) throw new Error('Pick a day for the session.')
  const timingKept = !!current && date === current.date && start === current.start && end === current.end
  if (!timingKept && date < todayKey()) throw new Error('That day has passed.')
  if (!timingKept && date > format(addDays(parseISO(todayKey()), 90), 'yyyy-MM-dd')) throw new Error('Sessions can be planned up to 3 months ahead.')
  if (!TIME.test(start || '')) throw new Error('Start must be a time such as 14:00.')
  if (!TIME.test(end || '')) throw new Error('End must be a time such as 18:00.')
  if (end <= start) throw new Error('End time must be after the start time.')
  if (!timingKept && startHasPassed(date, start)) throw new Error('That start time has already passed today.')
  return { title: name, date, start, end }
}

// Changes a session's title, day and times, for the host going back to the create form from the invite step. Only the
// host may, and only while the session is inviting: once it starts, the group plans around the day and times. Nothing
// else on the session changes. Checked like the create form (checkSessionFields), except that a change of the title alone is
// always allowed.
// How to call: await updateSession('s1', { title: 'Dinner', date: '2026-10-17', start: '18:00', end: '21:00' })
export async function updateSession(id, fields) {
  if (onServer()) {
    const checked = checkSessionFields(fields, { current: newestRead.get(id)?.session })
    await assertFree(checked, { excludeId: id })
    const session = summary(fromServer(await remote.update(id, checked)))
    broadcast({ type: 'session', sessionId: id })
    return session
  }
  await wait(DELAY.write)
  requireMe()
  const session = sessionById(id)
  if (session.hostId !== me()) throw new Error('Only the host can change a session.')
  if (session.status !== 'inviting') throw new Error('The date and times can only change before the session starts.')
  const checked = checkSessionFields(fields, { current: session })
  await assertFree(checked, { excludeId: id })
  Object.assign(session, checked)
  return touch(session, 'session')
}

// Invited friends accept automatically: they already have the app.
// Invite friends. By default they join straight away (tests and demo scripts). With { pending: true }, as the app
// does, each one is Invited until they accept, which in the demo they do on their own, one after another.
// acceptAfter (with pending): how long the first invite stays pending, in ms, instead of ACCEPT_AFTER. A long wait gets
// no timer; the invite is accepted by the first read after it passes. The demo's showcase uses it to leave invites pending.
// Inviting someone makes them a friend (walkthrough, 30 October 2026): for the demo and local accounts each invitee is added to the
// account's own list, so the demo tools' invites of people not yet on it count too. A real account's friends are the people in its
// sessions, invitees included, so nothing is stored for it.
// How to call: await inviteFriends('s1', ['faith'], { pending: true, acceptAfter: 7 * 24 * 60 * 60 * 1000 })
export async function inviteFriends(id, personIds, { pending = false, acceptAfter = ACCEPT_AFTER } = {}) {
  // A real account's friends are the people it shares a session with (coMemberIds); each one picked gets the same invitation
  // to them by name that the username search sends, and stays Invited until they answer it on Home.
  if (onServer()) return inviteFriendsOnServer(id, personIds)
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
  const added = isReal() ? [] : personIds.filter((personId) => personId !== me() && !db.friends.includes(personId))
  if (added.length) {
    db.friends = [...db.friends, ...added]
    emit({ type: 'friends' })
  }
  return touch(session, 'session')
}

// The ways a host can choose to pick the meeting point when the session starts (the Start choice): everyone shares where they
// start and the planner finds a fair spot, or the host names the area. A session with neither (started before the choice
// existed) reads as 'fairest'.
export const MEET_BY = ['fairest', 'known']

// Start a session. `meetBy` ('fairest' or 'known') is the host's choice of how the group picks the meeting point; it is saved with
// the start, and the guests see it. Left out, nothing is saved for it. A session on the server is started by the host's own write
// of status and meet_by together (the database checks the host and the two people).
// How to call: await startSession('s1', { meetBy: 'known' })
export async function startSession(id, { meetBy } = {}) {
  if (meetBy !== undefined && !MEET_BY.includes(meetBy)) throw new Error('Choose how to pick the meeting point.')
  if (onServer()) {
    await remote.start(id, { meetBy })
    return afterServerWrite(id, 'session')
  }
  await wait(DELAY.write)
  const session = sessionById(id)
  if (activeIds(session).length < 2) throw new Error('A session needs at least 2 people.')
  // Invites nobody accepted yet lapse: the session goes ahead with whoever is in.
  session.members = session.members.filter((m) => m.state !== 'invited')
  session.status = 'locating'
  if (meetBy) session.meetBy = meetBy
  return touch(session, 'session')
}

// ── A real account's meeting spots are on the server ───────────────────────

// Read a session of the server again after a write of this person's, tell the screens, and answer with it. The server's own
// answer to the write is never put into the session: a late one could not undo a confirmation, because nothing of it is kept.
// How to call: return afterServerWrite(id, 'spots')
async function afterServerWrite(id, type) {
  const session = await getSession(id)
  broadcast({ type, sessionId: id })
  return session
}

// How many changes are working the spots out right now, per session. getSession shows it as `findingSpots`.
const findingCounts = new Map()
// Say the spots are being worked out while `run` goes on, when there is anything to work out: someone else has shared a start
// (what was last read says so), or the list is there already. A first start alone has no spots to wait for.
// When `run` fails nothing was written that the caller will read back (a refused suggestion, no connection), so no read would
// clear the indicator on screen: the session is announced as changed, and the screens read it again and find it off.
// How to call: await whileFindingSpots('3b1f...', () => remote.suggest(id, 'bugis'))
async function whileFindingSpots(id, run) {
  const last = newestRead.get(id)?.session
  const othersStarted = Object.entries(last?.locations || {}).some(([person, loc]) => person !== me() && loc.start)
  const show = othersStarted || !!last?.spots?.list?.length
  if (show) {
    findingCounts.set(id, (findingCounts.get(id) || 0) + 1)
    findingSpots.add(id)
    broadcast({ type: 'pending', sessionId: id })
  }
  let failed = false
  try {
    return await run()
  } catch (err) {
    failed = true
    throw err
  } finally {
    if (show) {
      const left = (findingCounts.get(id) || 1) - 1
      if (left > 0) findingCounts.set(id, left)
      else {
        findingCounts.delete(id)
        findingSpots.delete(id)
      }
      if (failed) broadcast({ type: 'session', sessionId: id })
    }
  }
}

// The codes the server answers when it is asked to work the spots out for a session the host has already confirmed: `not_yet` in
// voting, `wrong_status` once confirmed, completed or cancelled (backend/src/services/sessions.js, requireStatus).
const HOST_MOVED_ON = new Set(['not_yet', 'wrong_status'])

// Did the server's answer prove it did nothing? Only a refusal does: a 4xx that carries the server's error code (the request was
// turned away before any work). A timeout, no answer at all or a 5xx says nothing about what the server did, so it proves nothing.
// How to call: refusedByServer({ code: 'plan_busy', status: 409 }) -> true; refusedByServer(new Error('timed out')) -> false
const refusedByServer = (err) => typeof err?.code === 'string' && err.code !== '' && err.status >= 400 && err.status < 500

// What a start or end that was saved but not priced says (the spots follow once the server has worked them out, or when the page
// next opens the session). It is a notice, not a failure: the screen shows it quietly and the start stays.
export const SAVED_NOT_PRICED = 'Your start is saved. The travel times may take a moment to appear.'

// Changes to one end of one person's route in this browser, one after another: the second starts when the first has finished,
// including its take-back, so two quick changes never interleave their writes. The key is the session and the end.
const locationTurns = new Map()
// Run `run` when the earlier ones with the same key are done; a failure of an earlier one does not stop it.
// How to call: await inTurn('3b1f...:start', () => saveIt())
function inTurn(key, run) {
  const result = (locationTurns.get(key) || Promise.resolve()).then(run)
  const tail = result.catch(() => {})
  locationTurns.set(key, tail)
  tail.then(() => {
    if (locationTurns.get(key) === tail) locationTurns.delete(key)
  })
  return result
}

// A real account's own start or end: the area on its member row and the label of the exact place, written directly, then the
// server works the spots out again. Changes to the same end in this browser go one at a time (inTurn).
// If the server turns the request away (a 4xx with its error code: the request did nothing), this person's own change is taken
// back, only where the database still holds what this call wrote, so a newer change of theirs (from another device, say) stays,
// and they are told. If the server did not answer in time, did not answer at all or failed (5xx), what it did is not known: the
// start stays, because the spots are worked out again by the next change or when the page next opens the session, and
// the person is told it is saved (SAVED_NOT_PRICED, as an Error with the code `saved_not_priced` after the session is announced as changed).
// If the group has moved on meanwhile (the host confirmed), what was saved stays and nothing is worked out: the server does nothing
// once the spot is confirmed. It says so with 409 `not_yet` while the group is voting (a later stage's work) and 409 `wrong_status`
// after that; both are the host having moved on, so neither is an error here (HOST_MOVED_ON).
// How to call: await setLocationOnServer('3b1f...', '7f3c...', 'start', { areaId: 'bugis', label: 'Bugis Junction' })
async function setLocationOnServer(id, personId, which, place) {
  requireMe(personId)
  if (personId !== me()) throw new Error(SHARING_WORDS.notAllowed)
  if (place && !areaById(place.areaId)) throw new Error('This area does not exist.')
  let unpriced = false
  await inTurn(`${id}:${which}`, () =>
    whileFindingSpots(id, async () => {
      const before = await remote.setPlace(id, which, place ? { areaId: place.areaId, label: place.label || areaById(place.areaId).name } : null)
      const trigger = which === 'end' ? 'end' : before.hadStart ? 'start' : 'added'
      try {
        await remote.refreshSpots(id, trigger)
      } catch (err) {
        if (HOST_MOVED_ON.has(err?.code)) return
        if (!refusedByServer(err)) {
          unpriced = true
          return
        }
        await remote.restorePlace(id, before)
        throw err
      }
    }),
  )
  const session = await afterServerWrite(id, 'location')
  if (unpriced) throw Object.assign(new Error(SAVED_NOT_PRICED), { code: 'saved_not_priced', session })
  return session
}

// which: 'start' | 'end'. place: { areaId, label }. Only the area is ever shown to other people.
export async function setLocation(id, personId, which, place) {
  if (onServer()) return setLocationOnServer(id, personId, which, place)
  await wait(DELAY.write)
  requireMe(personId)
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

// Confirm the meeting point: the spot with the most approvals while spots are listed (a tie goes to the shortest longest
// trip), otherwise the meeting area as it is. Moves the session to Voting. For a particular spot, use confirmSpot.
// How to call: await useMeetingArea('s1')
export async function useMeetingArea(id) {
  if (onServer()) {
    await remote.confirm(id)
    return afterServerWrite(id, 'session')
  }
  await wait(DELAY.write)
  const session = sessionById(id)
  if (!session.meeting) throw new Error('Everyone needs to share where they are starting first.')
  return orUndo(session, async () => {
    const spot = session.status === 'locating' ? preselectedSpot(session) : null
    if (spot) return settleOnSpot(session, spot)
    session.status = 'voting'
    session.banner = null
    await syncOptions(session)
    return touch(session, 'session')
  })
}

// ── Meeting spots: suggest, approve, confirm ───────────────────────────────

// The checks every change to the spots makes: the session is still going, and the group is still choosing where to
// meet. With a person, they must be in the session.
// How to call: assertSpotsOpen(session, 'jonathan')
function assertSpotsOpen(session, personId) {
  if (['completed', 'cancelled'].includes(session.status)) throw new Error(SESSION_ENDED)
  if (session.status !== 'locating') throw new Error('Spots can only change while the group is choosing where to meet.')
  if (personId !== undefined && !activeIds(session).includes(personId)) throw new Error('Only people in this session can do that.')
}

// How to call: assertHost(session, 'confirm a spot') (throws unless the signed-in person is the host)
function assertHost(session, what) {
  requireMe()
  if (session.hostId !== me()) throw new Error(`Only the host can ${what}.`)
}

// Settle on a spot: it becomes the meeting area and the session moves to Voting. The method says how it was chosen:
// 'voted' when anyone approved it; the planner's own method when nobody did and it is the app's first suggestion;
// otherwise 'chosen' (the host picked it).
// How to call: await settleOnSpot(session, session.spots.list[0]) (inside orUndo)
async function settleOnSpot(session, spot) {
  const first = session.spots.list[0]
  const appFirst = first?.areaId === spot.areaId && first.by === 'app' && session.spots.appMethod
  const method = approvalCount(session, spot.areaId) > 0 ? 'voted' : appFirst || 'chosen'
  session.meeting = meetingAtSpot(spot.areaId, method, spot)
  session.status = 'voting'
  session.banner = null
  await syncOptions(session)
  return touch(session, 'session')
}

// A member suggests a spot: an area the group could meet in, priced for everyone like the app's own. A member has one
// suggestion at a time; suggesting again replaces it, and approvals for the old spot go with it unless it is still
// listed (the app's own, or another member's). `here: true` only labels it "we are here already"; any member may set it.
// Asks the planner once (not at all for an area already listed). Needs two starts, so the spots exist.
// Throws if the group is not choosing where to meet, the person is not in the session, the area is unknown, or the
// planner cannot answer (nothing is saved then).
// How to call: await suggestSpot('s1', 'jonathan', 'bugis', { here: true })
export async function suggestSpot(id, personId, areaId, { here = false } = {}) {
  if (onServer()) {
    requireMe(personId)
    if (personId !== me()) throw new Error(SHARING_WORDS.notAllowed)
    if (!areaById(areaId)) throw new Error(SHARING_WORDS.noArea)
    await whileFindingSpots(id, () => remote.suggest(id, areaId, { here }))
    return afterServerWrite(id, 'spots')
  }
  await wait(DELAY.write)
  requireMe(personId)
  const session = sessionById(id)
  assertSpotsOpen(session, personId)
  const area = areaById(areaId)
  if (!area) throw new Error('This area does not exist.')
  const { suggestions, list } = session.spots
  const others = Object.entries(suggestions).filter(([person]) => person !== personId).map(([, s]) => s.areaId)
  if (new Set([...others, areaId]).size > SUGGESTIONS_MAX) throw new Error(`The group can suggest up to ${SUGGESTIONS_MAX} different spots. Ask someone to withdraw theirs first.`)
  const listed = list.some((s) => s.areaId === areaId)
  if (!listed && membersFor(session).length < P.MIN_LOCATIONS) throw new Error('Spots open once two people have shared where they start.')
  return orUndo(session, async () => {
    delete suggestions[personId]
    suggestions[personId] = { areaId, here: !!here }
    let lost = []
    if (listed) lost = setSpotList(session, relistFromStored(session))
    else {
      // Every request that rebuilds the list shares one ticket (latestAnswer): this one asks for every suggestion there is,
      // is put in only if it is current, and asks again if the starts or suggestions changed while it waited. If the host
      // confirmed meanwhile, the spots are closed and the asking stops with an error, which takes this suggestion back.
      await latestAnswer(
        session,
        async () => {
          assertSpotsOpen(session)
          const members = membersFor(session)
          return { members, data: await askMeeting(session, members, { alternatives: APP_SPOTS - 1, include: suggestedAreas(session) }, { spots: true }) }
        },
        ({ members, data }) => { lost = applyPlannedSpots(session, spotsFrom(members, data)) },
      )
    }
    assertSpotsOpen(session)
    if (!session.spots.list.some((s) => s.areaId === areaId)) throw new Error(`The planner could not work out travel times to ${area.name}.`)
    if (lost.length) session.banner = lostApprovalsBanner(`${nameOf(personId)} suggested ${area.name}.`, lost)
    return touch(session, 'spots')
  })
}

// A member takes their suggestion back. The spot leaves the list unless it is the app's or another member's, and
// approvals for it go with it. Does nothing (and writes nothing) when the person has no suggestion. No planner call.
// How to call: await withdrawSpot('s1', 'jonathan')
export async function withdrawSpot(id, personId) {
  if (onServer()) {
    requireMe(personId)
    if (personId !== me()) throw new Error(SHARING_WORDS.notAllowed)
    await remote.withdraw(id)
    return afterServerWrite(id, 'spots')
  }
  await wait(DELAY.write)
  requireMe(personId)
  const session = sessionById(id)
  assertSpotsOpen(session, personId)
  if (!session.spots.suggestions[personId]) return summary(session)
  delete session.spots.suggestions[personId]
  const lost = setSpotList(session, relistFromStored(session))
  if (lost.length) session.banner = lostApprovalsBanner(`${nameOf(personId)} withdrew their suggestion.`, lost)
  return touch(session, 'spots')
}

// "Works for me": a member says a spot suits them, or takes it back (on: false). Any number of spots per member, no
// order, no points; approving twice is one approval. Any member, while the group is choosing where to meet. No planner
// call, so it works with the backend off.
// Throws if the spot is not on the list.
// How to call: await approveSpot('s1', 'faith', 'bugis', true)
export async function approveSpot(id, personId, areaId, on = true) {
  if (onServer()) {
    requireMe(personId)
    if (personId !== me()) throw new Error(SHARING_WORDS.notAllowed)
    await remote.approve(id, areaId, on)
    return afterServerWrite(id, 'spots')
  }
  await wait(DELAY.write)
  requireMe(personId)
  const session = sessionById(id)
  assertSpotsOpen(session, personId)
  if (!session.spots.list.some((s) => s.areaId === areaId)) throw new Error('That spot is not on the list.')
  const mine = (session.spots.approvals[personId] || []).filter((a) => a !== areaId)
  const next = on ? [...mine, areaId] : mine
  if (next.length) session.spots.approvals[personId] = next
  else delete session.spots.approvals[personId]
  return touch(session, 'spots')
}

// The host settles on a spot, whether or not anyone approved it: it becomes the meeting area and the session moves to
// Voting, where the places are chosen. The spot offered first is session.spots.preselectedAreaId.
// Throws if the person is not the host, the group is not choosing where to meet, or the spot is not on the list.
// How to call: await confirmSpot('s1', 'bugis')
export async function confirmSpot(id, areaId) {
  if (onServer()) {
    await remote.confirm(id, areaId)
    return afterServerWrite(id, 'session')
  }
  await wait(DELAY.write)
  requireMe()
  const session = sessionById(id)
  if (['completed', 'cancelled'].includes(session.status)) throw new Error(SESSION_ENDED)
  assertHost(session, 'confirm a spot')
  assertSpotsOpen(session)
  const spot = session.spots.list.find((s) => s.areaId === areaId)
  if (!spot) throw new Error('That spot is not on the list.')
  return orUndo(session, () => settleOnSpot(session, spot))
}

// The host sets the meeting area straight away because the group has already decided: from inviting or locating to
// voting. The list becomes that one area (method 'chosen') and approvals are cleared. Members can still share where they
// start; that only adds travel times, and the area stays. From inviting, pending invites lapse and two people are
// needed, as when a session starts. Asks the planner once for travel times when anyone has shared a start.
// Throws if the person is not the host, the session is past locating, the area is unknown, or the planner cannot answer.
// `notice` is the banner the group is shown on arrival ({ text, released: true, votesCleared: true }); the host's change of the meeting place
// passes one, and without it the banner is cleared.
// How to call: await setKnownPlace('s1', 'bugis')
export async function setKnownPlace(id, areaId, { notice = null } = {}) {
  if (onServer()) {
    if (!areaById(areaId)) throw new Error(SHARING_WORDS.noArea)
    // The server records the host's choice itself, after the known place is written (the browser writes nothing more for it here).
    await remote.knownPlace(id, areaId)
    return afterServerWrite(id, 'session')
  }
  await wait(DELAY.write)
  requireMe()
  const session = sessionById(id)
  if (['completed', 'cancelled'].includes(session.status)) throw new Error(SESSION_ENDED)
  assertHost(session, 'set a known place')
  if (!['inviting', 'locating'].includes(session.status)) throw new Error('A known place can only be set before the group votes on places.')
  if (!areaById(areaId)) throw new Error('This area does not exist.')
  if (activeIds(session).length < 2) throw new Error('A session needs at least 2 people.')
  return orUndo(session, async () => {
    // Invites nobody accepted yet lapse: the session goes ahead with whoever is in.
    session.members = session.members.filter((m) => m.state !== 'invited')
    const { meeting, pinnedSpot } = await computePinned(session, membersFor(session), areaId, 'chosen', { bar: false })
    const priced = pinnedSpot || { worstMinutes: null, meanMinutes: null, times: {}, approximate: false }
    session.spots = { ...emptySpots(), list: [{ areaId, by: session.hostId, here: false, worstMinutes: priced.worstMinutes, meanMinutes: priced.meanMinutes, exactWorst: priced.exactWorst, times: { ...priced.times }, approximate: priced.approximate }] }
    session.meeting = meeting
    session.status = 'voting'
    session.meetBy = 'known'
    session.banner = notice ? { ...notice, at: Date.now() } : null
    await syncOptions(session)
    return touch(session, 'session')
  })
}

// The host changes the meeting place after it was set, from voting or confirmed ("Change plan" > "Change meeting place"). The meeting area is
// let go and the session goes back to locating: the votes, the places to vote on, the plan's stops, the proposals, the "Re-plan?" prompt and the
// spots with their approvals and suggestions are cleared, and the group gets a banner that names the host. Everyone's starts, ends, exact places and
// picks stay. `meetBy: 'fairest'` has the spots worked out again from those starts; `meetBy: 'known'` with an `areaId` then names the area through
// the known place (setKnownPlace), which moves straight to voting with new slots and brings the banner along. If naming the area fails after the
// release, the session stays on Locate with the host's choice recorded, and the host names the area there. On the server it is one route and one
// database write (the op `release_meeting`), and the session is read again afterwards, whether it worked or not, because the release may have
// gone through before a failure.
// Throws if the person is not the host, the session is not voting or confirmed, the area is unknown, or the planner cannot answer.
// How to call: await changeMeetingPlace('s1', { meetBy: 'known', areaId: 'bugis' })
export async function changeMeetingPlace(id, { meetBy, areaId } = {}) {
  if (!MEET_BY.includes(meetBy)) throw new Error('Choose how to pick the meeting point.')
  if (meetBy === 'known' && !areaById(areaId)) throw new Error(SHARING_WORDS.noArea)
  if (onServer()) {
    // The version this person last read goes with the request: if the session moved on since (a retry after a timeout, say), the server refuses
    // and nothing is wiped.
    const planVersion = newestRead.get(id)?.version
    try {
      await remote.changeMeetingPlace(id, { meetBy, areaId, planVersion })
    } catch (err) {
      // The release may have been written before the known place failed: show the session as it is, and say so on the error (`released`), so
      // the screen the host lands on (Locate) can show what went wrong there.
      const now = await afterServerWrite(id, 'session').catch(() => null)
      if (meetBy === 'known' && now?.status === 'locating') err.released = true
      throw err
    }
    return afterServerWrite(id, 'session')
  }
  await wait(DELAY.write)
  requireMe()
  const session = sessionById(id)
  if (['completed', 'cancelled'].includes(session.status)) throw new Error(SESSION_ENDED)
  assertHost(session, 'change the meeting place')
  if (!['voting', 'confirmed'].includes(session.status)) throw new Error('The meeting place can only be changed while the group is voting on places or has a plan.')
  const facts = { hostName: nameOf(me()), status: session.status, hadVotes: hasVotes(session) }
  // A repeat naming the area the session is already voting at, chosen by the host's own "known", with no vote cast: nothing to clear.
  if (meetBy === 'known' && session.status === 'voting' && session.meetBy === 'known' && session.meeting?.method === 'chosen' && session.meeting.areaId === areaId && !facts.hadVotes) return summary(session)
  await orUndo(session, async () => {
    Object.assign(session, { status: 'locating', meetBy, meeting: null, spots: emptySpots(), options: {}, votes: {}, plan: null, replan: null, deletedSlots: [], banner: { text: releasedNotice(facts), at: Date.now(), released: true } })
    clearProposals(session)
    delete session.confirmedRanking
    delete session.weatherDismissed
    if (meetBy === 'fairest') await applyTrigger(session, { kind: 'added', personName: facts.hostName })
    return touch(session, 'session')
  })
  if (meetBy === 'fairest') return summary(session)
  try {
    return await setKnownPlace(id, areaId, { notice: { text: releasedNotice({ ...facts, placeName: areaById(areaId).name }), released: true, votesCleared: true } })
  } catch (err) {
    // The release stands (the session is locating with the host's choice): say so on the error, as for a session on the server.
    err.released = true
    throw err
  }
}

// A person steps out of a session. On the server that is the person themselves opting out (they keep their place and can
// rejoin), or the host carrying on without someone, which takes that person out of the session (they can come back with a link).
// How to call: await optOut('s1', 'faith')
export async function optOut(id, personId) {
  if (onServer()) {
    const mine = requireMe(personId)
    if (personId === mine) await remote.optOut(id)
    else await remote.removeMember(id, personId)
    return afterServerWrite(id, 'optout')
  }
  await wait(DELAY.write)
  requireMe(personId)
  const session = sessionById(id)
  if (['completed', 'cancelled'].includes(session.status)) throw new Error(SESSION_ENDED)
  const member = session.members.find((m) => m.id === personId)
  if (!member || member.role === 'host') throw new Error('The host cannot opt out.')
  // The proposals this write removes, kept so a failure puts back exactly these (see below).
  const theirProposals = proposalsOf(session).filter((p) => p.by === personId)
  return orUndo(session, async () => {
    member.state = 'opted_out'
    // Their approvals go, and while the group is choosing where to meet so does their suggestion (the list below is
    // worked out again, and approvals for a spot that leaves with it are removed).
    delete session.spots.approvals[personId]
    if (session.status === 'locating') delete session.spots.suggestions[personId]
    // The places they proposed as the next stop go with them.
    if (theirProposals.length) session.proposals = proposalsOf(session).filter((p) => p.by !== personId)
    try {
      await applyTrigger(session, { kind: 'optout', personName: nameOf(personId) })
      await syncOptions(session)
    } catch (err) {
      // If the write fails, their proposals come back, whatever others proposed while it waited on the planner. (orUndo puts
      // a list back only when no one changed it since, so it cannot do this: a place proposed meanwhile would keep theirs out.)
      // Not when the plan has since ended or gone back to voting: those clear the proposals on purpose.
      const now = proposalsOf(session)
      const back = session.status === 'confirmed' ? theirProposals.filter((p) => !now.some((n) => n.id === p.id)) : []
      if (back.length) session.proposals = [...back, ...now].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
      throw err
    }
    forgetUnusedVenues(theirProposals.map((p) => p.venueId))
    return touch(session, 'optout')
  })
}

// Rejoin a session of the server after opting out. The server allows it while inviting, locating and voting (the person comes back
// without their votes, which opting out took); once the plan is confirmed it answers not_yet, and the person is told they cannot.
// A meetup that overlaps another the person is in is refused with a ClashError, before anything is sent when the other is in the
// list and by the server (409 schedule_clash, with the meetup in `clash`) when it is not; there is no rejoin in a session of this
// browser, so this is for a real account only.
// How to call: await rejoinSession('3b1f...')
export async function rejoinSession(id) {
  needServer()
  const { date, start, end } = newestRead.get(id)?.session ?? (await getSession(id))
  await assertFree({ date, start, end }, { excludeId: id })
  await remote.rejoin(id)
  return afterServerWrite(id, 'session')
}

export async function dismissBanner(id) {
  // The server's banner is the group's, so dismissing it is this person's alone and kept in this browser.
  if (onServer()) {
    const current = await getSession(id)
    if (current.banner) rememberDismissed(id, current.banner.at)
    return getSession(id)
  }
  const session = sessionById(id)
  session.banner = null
  return touch(session, 'session')
}

export async function cancelSession(id) {
  if (onServer()) {
    const session = summary(fromServer(await remote.cancel(id)))
    broadcast({ type: 'session', sessionId: id })
    return session
  }
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.status === 'completed') throw new Error('A completed session cannot be cancelled.')
  session.status = 'cancelled'
  session.replan = null
  clearProposals(session)
  return touch(session, 'session')
}

// ── A shared session: invite links, invitations, joining, leaving ───────────

// Is there a server to share through? False for a copy of the app with no Supabase project (local accounts only), where a
// link cannot work. How to call: if (!sharingAvailable()) showNote()
export const sharingAvailable = () => auth.configured()

// The invite functions are for a real account's session on the server. For the demo account and local accounts, whose data is the
// sample person's, they send nothing anywhere: they say what to do.
// How to call: needServer() (throws unless a real account is signed in)
function needServer() {
  if (!onServer()) throw new Error(SHARING_WORDS.needsAccount)
}

// The session's invite link as the host sees it, or null when it has none: { token, path, expiresAt, expired }. `path` is
// the in-app address, "/join/<token>"; a screen adds its own origin to make the link to share.
// How to call: const link = await getInviteLink('3b1f...')
export async function getInviteLink(id) {
  needServer()
  const link = await remote.currentLink(id)
  return link && { ...link, path: `/join/${link.token}` }
}

// Make the link (or return the live one). How to call: const link = await makeInviteLink('3b1f...')
export async function makeInviteLink(id) {
  needServer()
  const link = await remote.makeLink(id)
  return { ...link, path: `/join/${link.token}` }
}

// Turn the link off. How to call: await revokeInviteLink('3b1f...')
export async function revokeInviteLink(id) {
  needServer()
  await remote.revoke(id)
}

// People whose username starts with what was typed, for the invite field: at most 5 of { id, name, username, avatarUrl,
// metBefore }, the exact match first, then people already met in a session, then the rest by username, never the signed-in
// person. Text that cannot start any username (under 3 characters, a space, a dot) is answered with none and asks nobody.
// A real account asks the server (GET /api/people/search); the demo and local accounts search their own people here, with no
// request. Rejects with a sentence when the server cannot answer, and with an AbortError when `signal` aborts first.
// How to call: const people = await searchPeople('@kim', { signal: controller.signal })
export async function searchPeople(text, { signal } = {}) {
  const term = searchTerm(text)
  if (!isSearchable(term)) return []
  if (isReal()) {
    needServer()
    const rows = await planner.searchPeopleByUsername(term, { signal })
    return rows.map((row) => ({
      ...personFromRow({ id: row.id, username: row.username, display_name: row.name, avatar_url: row.avatarUrl }, projectOrigin()),
      metBefore: row.metBefore === true,
    }))
  }
  await wait(DELAY.read)
  if (signal?.aborted) throw Object.assign(new Error('The search was cancelled.'), { name: 'AbortError' })
  const sample = PEOPLE.filter((p) => p.id !== (me() || HOST_ID)).map((p) => publicPerson(p.id))
  return rankPeople(sample.map((p) => ({ id: p.id, name: p.name, username: p.username, avatarUrl: p.photo })), term, { metIds: new Set(coMemberIds()), meId: me() })
}

// A real account's host invites friends by id, one invitation each, in the order picked. Only friends can be picked this way, so
// a stranger is reached by username or the link (refused before anything is sent). Someone already in the session or waiting on an
// invite is skipped. Someone who cannot be invited by name (opted out, or an invitation taken back, declined or used: the database
// keeps one per person) is counted, not tried. A refusal for one person does not stop the rest. The session is read again either way,
// so the screen shows who is Invited. Resolves with the session as it is then; if anyone could not be invited it rejects with one
// sentence that says how many and why, and the error's `invited`, `skipped` (already in) and `blocked` (cannot be invited by name) hold ids a retry should not send.
// How to call: await inviteFriendsOnServer('3b1f...', ['7f3c...', '9a2e...'])
async function inviteFriendsOnServer(id, personIds) {
  const friends = new Set(coMemberIds())
  if (personIds.some((personId) => !friends.has(personId))) throw new Error('Invite people you have not been out with by their username.')
  const invited = []
  const skipped = []
  const blocked = []
  const failed = []
  try {
    const session = await getSession(id)
    for (const personId of personIds) {
      if (isInOrInvited(session, personId)) skipped.push(personId)
      else if (!canInviteByName(session, personId)) blocked.push(personId)
      else {
        try {
          await remote.invitePerson(id, personId)
          invited.push(personId)
        } catch (e) {
          failed.push(e)
        }
      }
    }
  } finally {
    warmPeople(personIds)
    broadcast({ type: 'session', sessionId: id })
  }
  const session = await getSession(id)
  const left = blocked.length + failed.length
  if (!left) return session
  const reasons = []
  if (blocked.length) reasons.push("they were invited before or opted out, so only the session's link works for them")
  if (failed.length) reasons.push(String(failed[0]?.message || 'the invite did not go through').replace(/\.$/, ''))
  const who = left === 1 ? '1 person' : `${left} people`
  throw Object.assign(new Error(`${who} could not be invited: ${reasons.join('; ')}.${invited.length ? ' The rest are invited.' : ''}`), { invited, skipped, blocked })
}

// The host invites a person by id; they see it on Home. Resolves with the session as it is then.
// How to call: await inviteByUsername('3b1f...', '7f3c...')
export async function inviteByUsername(id, personId) {
  needServer()
  await remote.invitePerson(id, personId)
  warmPeople([personId])
  const session = await getSession(id)
  broadcast({ type: 'session', sessionId: id })
  return session
}

// The host takes back an invite that is still waiting for an answer, and the person leaves the list. For a real account the personal
// invitation is turned off on the server (it cannot be sent to them again; the session's link still works for them); for the demo and
// local accounts the invited row goes, and they can be invited again. Only the host, and only while the person has not joined.
// Resolves with the session as it is then. How to call: await revokeInvite('3b1f...', '7f3c...')
export async function revokeInvite(id, personId) {
  if (onServer()) {
    await remote.revokeInvitation(id, personId)
    broadcast({ type: 'session', sessionId: id })
    return getSession(id)
  }
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.hostId !== me()) throw new Error('Only the host can take back an invite.')
  const member = session.members.find((m) => m.id === personId)
  if (member?.state !== 'invited') throw new Error('They are not waiting on an invite. Reload to see who is in.')
  session.members = session.members.filter((m) => m !== member)
  return touch(session, 'session')
}

// What an invite link leads to, for anyone (signed in or not): { title, date, start, end, hostName }, or null when the link
// does not work. Rejects with a sentence when the server cannot be reached.
// How to call: const preview = await previewInvite(token)
export async function previewInvite(token) {
  return remote.preview(token)
}

// Join with a link or a personal invitation. Resolves with { sessionId, already }. Rejects with a sentence that says why not.
// How to call: const { sessionId } = await joinWithLink(token)
export async function joinWithLink(token) {
  if (!isReal()) throw new Error(sharingAvailable() ? 'Log in with a Jio account to join.' : SHARING_WORDS.offline)
  const joined = await remote.join(token)
  broadcast({ type: 'session', sessionId: joined.sessionId })
  return joined
}

// The invitations addressed to the signed-in person that are still open, newest first. An answer read for the account before
// is dropped (an empty list). How to call: const list = await listInvitations()
export async function listInvitations() {
  if (!onServer()) return []
  const asked = epoch
  const list = await remote.invitations()
  return asked === epoch ? list : []
}

// Say no to an invitation. How to call: await declineInvitation(token)
export async function declineInvitation(token) {
  needServer()
  await remote.decline(token)
  broadcast({ type: 'invitations' })
}

// The signed-in person leaves a session of the server (their member row goes), and it is no longer one they share. Resolves
// when it is done. How to call: await leaveSession('3b1f...')
export async function leaveSession(id) {
  needServer()
  await remote.removeMember(id, 'me')
  serverMembers.delete(id)
  forgetSlots(id)
  heldRows.delete(id)
  newestPlanRead.delete(id)
  forgetStops(id)
  broadcast({ type: 'session-gone', sessionId: id })
}

// The host removes a guest from a session of the server. The session is read again, so the guest is no longer someone the
// account shares it with. How to call: await removeFromSession('3b1f...', '7f3c...')
export async function removeFromSession(id, personId) {
  needServer()
  await remote.removeMember(id, personId)
  broadcast({ type: 'session', sessionId: id })
  return getSession(id)
}

// ── Step 6: categories, timing, suggestions and votes ──────────────────────

// The person's own picks for the plan (stage 4): written to their member row, then the server works the slots and places out again. If
// the server turns the request away (a 4xx with its code: it did nothing), the picks go back, only where the row still holds what this
// call wrote; if it did not answer, the picks stay, because the server may have worked from them, and the person is told so.
// How to call: await setPreferences('3b1f...', 'self', { categories: ['eat', 'drink'], until: 1020 })
const PICKS_SAVED = 'Your choices are saved. The places may take a moment to update.'

export async function setPreferences(id, personId, prefs) {
  if (onServer()) {
    requireMe(personId)
    if (personId !== me()) throw new Error(SHARING_WORDS.notAllowed)
    const before = await remote.setPrefs(id, prefs)
    let unsynced = false
    try {
      await remote.syncPlan(id)
    } catch (err) {
      if (refusedByServer(err)) {
        await remote.restorePrefs(id, before)
        throw err
      }
      unsynced = true
    }
    const session = await afterServerWrite(id, 'prefs')
    if (unsynced) throw Object.assign(new Error(PICKS_SAVED), { code: 'saved_not_synced', session })
    return session
  }
  await wait(DELAY.write)
  requireMe(personId)
  const session = sessionById(id)
  if (session.status !== 'voting') throw new Error('Categories can only change while voting.')
  return orUndo(session, async () => {
    session.prefs[personId] = { categories: [...prefs.categories], until: prefs.until ?? null }
    await syncOptions(session)
    return touch(session, 'prefs')
  })
}

export async function deleteSlot(id, slotId) {
  if (onServer()) {
    await remote.removeSlot(id, slotId)
    return afterServerWrite(id, 'slots')
  }
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
  if (onServer()) {
    await remote.restoreSlots(id)
    return afterServerWrite(id, 'slots')
  }
  await wait(DELAY.write)
  const session = sessionById(id)
  return orUndo(session, async () => {
    session.deletedSlots = []
    await syncOptions(session)
    return touch(session, 'slots')
  })
}

// The search radius around the meeting area, in metres (100 to 3000), or null to let the planner widen on its own.
// Options outside the new radius drop out, with their votes, and each slot tops up to three again. Any member may change it
// here (the server stage will decide who may). When votes were dropped, a banner says so for everyone, until it is dismissed or
// the next change; a banner about the meeting area moving is left alone.
// How to call: await setRadius('s1', 1000)
export async function setRadius(id, metres) {
  if (onServer()) {
    if (metres != null && !(metres >= 100 && metres <= 3000)) throw new Error('Pick a radius from 100 m to 3 km.')
    await remote.setRadius(id, metres ?? null)
    return afterServerWrite(id, 'options')
  }
  await wait(DELAY.write)
  const session = sessionById(id)
  if (metres != null && !(metres >= 100 && metres <= 3000)) throw new Error('Pick a radius from 100 m to 3 km.')
  return orUndo(session, async () => {
    const voted = voteCount(session)
    session.radius = metres ?? null
    await syncOptions(session)
    if (session.banner?.byRadius) session.banner = null
    if (voteCount(session) < voted) {
      const text = metres == null ? 'Votes for places that no longer fit were cleared.' : 'Votes for places outside the new ring were cleared.'
      session.banner = { text, at: Date.now(), votesCleared: true, byRadius: true }
    }
    return touch(session, 'options')
  })
}

// The words for a person who is not the host dropping someone else's need. How to call: throw new Error(DROP_HOST_ONLY)
const DROP_HOST_ONLY = "Only the host can change someone else's need."

// "Confirm dietary needs", asked once per outing of each person when it reaches voting (DietaryConfirm on the Vote page), and
// the Vote page's chips. The person confirms their own needs for this outing only: they are kept on the outing
// (`session.dietMine`), and the profile, the person's standing setting, is left as it is. Everyone changes their own; the others'
// needs are the host's to drop and no one else's. `dropped` (optional): the needs someone else in the outing has that the group should
// not filter for, after the dialog warned the host; a need nobody else has is ignored here, and a guest who sends a list other than
// the one the outing has is refused. Left out, the outing keeps what it had. A change ranks the outing's places again; places that no
// longer fit go with their votes, and a banner says the places changed, without naming anyone.
// For a session on the server the same is one write to the server (PUT /api/sessions/:id/dietary), which keeps the outing's needs,
// picks the places again while voting and answers with what it holds; nothing is kept here but the session read afterwards.
// `confirmed: false` (a tap on the Vote page's chips) saves the needs without marking the outing confirmed for the person, on the server.
// How to call: await confirmDiet('s1', ['vegan'], ['halal']); await confirmDiet('s1', ['vegan'], undefined, { confirmed: false })
export async function confirmDiet(id, dietary, dropped, { confirmed = true } = {}) {
  if (onServer() && serverMembers.has(id)) {
    requireMe()
    // A chip tap saves the needs without confirming them (`confirmed: false`); only "Confirm" marks the outing confirmed for the person.
    const planVersion = newestRead.get(id)?.version ?? newestPlanRead.get(id)?.version
    const body = { mine: cleanDietary(dietary), ...(confirmed ? { checked: true } : {}), ...(Number.isInteger(planVersion) ? { planVersion } : {}) }
    if (dropped !== undefined) {
      // Compared with the list the screen shows (the dropped needs that someone else has), not the server's raw one: a guest whose own need is
      // dropped sees none dropped, and sends the same. Only the host ever sends `dropped`; a guest who asks for a different list is refused.
      const wanted = cleanDietary(dropped)
      const seen = newestPlanRead.get(id)?.diet ?? (await dietaryStateOf(id))
      if (wanted.join() !== shownDropped(seen).join()) {
        const hostId = newestRead.get(id)?.session?.hostId ?? (await getSession(id)).hostId
        if (hostId !== me()) throw new Error(DROP_HOST_ONLY)
        body.dropped = wanted
      }
    }
    try {
      await remote.setDietary(id, body)
    } catch (err) {
      // The outing moved on since this page last read it: it is read again, so the page shows what is true now.
      if (err.code === 'stale_plan') await afterServerWrite(id, 'diet').catch(() => {})
      throw err
    }
    return afterServerWrite(id, 'diet')
  }
  await wait(DELAY.write)
  const session = sessionById(id)
  requireMe()
  if (!activeIds(session).includes(me())) throw new Error('Only people in this session can do that.')
  const next = cleanDietary(dietary)
  const mineChanged = next.join() !== dietaryOf(me(), session).join()
  const wantDropped = dropped === undefined ? droppedNeeds(session) : cleanDietary(dropped).filter((need) => othersNeeds(session).includes(need))
  if (wantDropped.join() !== droppedNeeds(session).join() && session.hostId !== me()) throw new Error(DROP_HOST_ONLY)
  return !mineChanged && wantDropped.join() === droppedNeeds(session).join()
    ? (() => {
        session.dietChecked = { ...(session.dietChecked || {}), [me()]: true }
        return touch(session, 'diet')
      })()
    : orUndo(session, async () => {
        const voted = voteCount(session)
        if (mineChanged) session.dietMine = { ...(session.dietMine || {}), [me()]: next }
        session.dietDropped = wantDropped
        session.dietChecked = { ...(session.dietChecked || {}), [me()]: true }
        await syncOptions(session, { fresh: true })
        const cleared = voteCount(session) < voted ? ' Votes for places that no longer fit were cleared.' : ''
        session.banner = { text: `The group's dietary needs changed, so places were ranked again.${cleared}`, at: Date.now(), votesCleared: true, byDiet: true }
        return touch(session, 'diet')
      })
}

// Show the food places we could not confirm for the group's dietary needs (on), or only the ones that fit (off). Asked for when
// fewer than 3 places fit. While on, each such place is labelled ("Halal not confirmed, check before you go"). Turning it off
// drops those places, with their votes, and a banner says votes were cleared, as the radius does.
// How to call: await setUnconfirmed('s1', true)
export async function setUnconfirmed(id, on) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.status !== 'voting') throw new Error('Places can only change while voting.')
  if (!!session.unconfirmed === !!on) return summary(session)
  return orUndo(session, async () => {
    const voted = voteCount(session)
    session.unconfirmed = !!on
    await syncOptions(session, { fresh: true })
    if (session.banner?.byDiet) session.banner = null
    if (voteCount(session) < voted) session.banner = { text: 'Votes for places we could not confirm were cleared.', at: Date.now(), votesCleared: true, byDiet: true }
    return touch(session, 'options')
  })
}

// A dietary need changed (the signed-in person's own, on their profile): every outing they are voting in is ranked again.
// Places that no longer fit drop out with their votes, the lists top up, and a banner tells the group that places were
// filtered, without saying whose need it was. Never throws: an outing the planner cannot answer for keeps its places, and
// the voting page shows only the ones that fit when it next ranks.
// It runs after the profile is saved, not before: saving a need never waits for the planner.
// How to call: refiltering = refilterForDiet()
async function refilterForDiet() {
  const mine = db.sessions.filter((s) => s.status === 'voting' && s.meeting && activeIds(s).includes(me()))
  await Promise.all(
    mine.map(async (session) => {
      try {
        await orUndo(session, async () => {
          const before = JSON.stringify(session.options)
          const voted = voteCount(session)
          await syncOptions(session, { fresh: true })
          if (JSON.stringify(session.options) === before) return summary(session)
          const cleared = voteCount(session) < voted ? ' Votes for places that no longer fit were cleared.' : ''
          session.banner = { text: `Places were filtered for a dietary need.${cleared}`, at: Date.now(), votesCleared: true, byDiet: true }
          return touch(session, 'options')
        })
      } catch {
        // Kept as it was: see above.
      }
    }),
  )
}

// The latest re-ranking a change of dietary need started (refilterForDiet), so a test or a screen can wait for it.
let refiltering = Promise.resolve()
// How to call: await whenRefiltered()
export const whenRefiltered = () => refiltering

// How many votes a session holds. How to call: voteCount(session) -> 4
const voteCount = (session) => Object.values(session.votes || {}).reduce((sum, byPerson) => sum + Object.keys(byPerson).length, 0)

// How many places a slot of a shared session shows, as last read: what the server is told so that asking again after a lost answer does
// not add places twice. From the newest plan handed out, else the newest session read, else read afresh.
// How to call: await optionsShown('3b1f...', '9a2c...') -> 3
async function optionsShown(id, slotId) {
  const plan = newestPlanRead.get(id)?.plan
  const slot = plan?.slots?.find((s) => s.id === slotId)
  if (slot) return slot.options.length
  const held = newestRead.get(id)?.session?.options?.[slotId]
  if (held) return held.length
  return ((await remote.readPlan(id)).options[slotId] || []).length
}

export async function addMoreOptions(id, slotId) {
  if (onServer()) {
    await remote.moreOptions(id, slotId, await optionsShown(id, slotId))
    return afterServerWrite(id, 'options')
  }
  await wait(DELAY.plan)
  const session = sessionById(id)
  const slots = slotsOf(session)
  const slot = slots.find((s) => s.id === slotId)
  const ranked = await rankSlot(session, slot, [])
  session.options[slotId] = P.moreOptions(session.options[slotId] || [], rankedIds(ranked))
  return touch(session, 'options')
}

// Search places to add to a slot. Each result says whether it fits, and why not. With `cdcOnly`, only places that take CDC vouchers.
// With `browse` and nothing typed, the nearest few places that fit, as the search box's suggestions.
// How to call: await searchVenuesForSlot('s1', 'eat-1', 'laksa', { cdcOnly: true }); await searchVenuesForSlot('s1', 'eat-1', '', { browse: true })
export async function searchVenuesForSlot(id, slotId, query, { cdcOnly = false, browse = false } = {}) {
  if (onServer()) {
    const q = query.trim()
    if (!q && !browse) return []
    const results = await remote.searchSlot(id, slotId, q, { cdcOnly, browse })
    for (const r of results) searchedNames.set(r.id, r.name)
    return results
  }
  const session = sessionById(id)
  const slots = slotsOf(session)
  const slot = slots.find((s) => s.id === slotId)
  const q = query.trim()
  if ((!q && !browse) || !slot) return []
  const results = await planner.searchSlot({
    query: q,
    members: rankingMembers(session),
    centre: areaById(session.meeting.areaId),
    date: session.date,
    slot,
    lastStop: false,
    maxKm: session.radius ? session.radius / 1000 : undefined,
    dietPolicy: dietPolicy(session, slot.category),
    cdcOnly,
    browse,
    ...(browse && !q ? { limit: 8 } : {}),
  })
  return Object.assign(results.map((r) => ({ ...r, added: (session.options[slotId] || []).includes(r.id) })), { google: results.google ?? null })
}

export async function addOption(id, slotId, venueId) {
  if (onServer()) {
    try {
      await remote.addOption(id, slotId, venueId)
    } catch (err) {
      // The refusal names the place, as the local one does.
      if (err?.code === 'venue_does_not_fit') throw Object.assign(new Error(`${searchedNames.get(venueId) || serverVenues.get(venueId)?.name || 'This place'} does not fit this slot.`), { code: err.code, status: err.status })
      throw err
    }
    return afterServerWrite(id, 'options')
  }
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
  // The place may have been added while the planner was answering (two taps in a row): look again before saving, so it is
  // never listed twice, and the limit still holds.
  const now = session.options[slotId] || []
  if (now.includes(venueId)) return touch(session, 'options')
  if (now.length >= P.OPTIONS_MAX) throw new Error('A slot holds up to 6 options.')
  session.options[slotId] = [...now, venueId]
  session.addedBy = { ...(session.addedBy || {}), [slotId]: { ...(session.addedBy?.[slotId] || {}), [venueId]: me() } }
  return touch(session, 'options')
}

// Take back a place the signed-in person added, while voting and while nobody else has voted for it; their own vote for it goes too.
// Refused for a place someone else added or the planner put there. A place that is not an option any more is left alone.
// How to call: await removeOption('s1', 'eat-1', 'v25')
export async function removeOption(id, slotId, venueId) {
  if (onServer()) {
    await remote.removeOption(id, slotId, venueId)
    return afterServerWrite(id, 'options')
  }
  await wait(DELAY.write)
  requireMe()
  const session = sessionById(id)
  if (session.status !== 'voting') throw new Error('Places can only be taken back while the group is voting.')
  const options = session.options[slotId] || []
  if (!options.includes(venueId)) return touch(session, 'options')
  if (session.addedBy?.[slotId]?.[venueId] !== me()) throw new Error('Only the person who added a place can take it back.')
  const votes = session.votes[slotId] || {}
  if (Object.entries(votes).some(([person, v]) => v === venueId && person !== me())) throw new Error('Someone has voted for this place, so it stays.')
  session.options[slotId] = options.filter((v) => v !== venueId)
  if (votes[me()] === venueId) delete votes[me()]
  delete session.addedBy[slotId][venueId]
  return touch(session, 'options')
}

// Replace an outdoor option with an indoor one when it rains. While voting this changes the options (and takes back the
// votes for the one that left). Once the plan is confirmed it changes the plan's stop for that slot, so only the host may,
// and asking again after the stop is already the indoor place changes nothing (the indoor swap is made once).
// How to call: await swapOption('s1', 'activity', 'east-coast-park', 'toa-payoh-library')
export async function swapOption(id, slotId, fromId, toId) {
  if (onServer()) {
    // A confirmed plan's stop is changed the one way there is (changeStopPlace); only while voting is it a swap of the group's options.
    const session = await planSession(id)
    if (session.status === 'confirmed' && session.plan?.stops.some((s) => s.slotId === slotId)) return swapPlannedStop(session, slotId, fromId, toId)
    await remote.swapOption(id, slotId, fromId, toId)
    return afterServerWrite(id, 'options')
  }
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.status === 'confirmed' && session.plan?.stops.some((s) => s.slotId === slotId)) return swapPlannedStop(session, slotId, fromId, toId)
  session.options[slotId] = (session.options[slotId] || []).map((v) => (v === fromId ? toId : v))
  const votes = session.votes[slotId] || {}
  for (const person of Object.keys(votes)) if (votes[person] === fromId) delete votes[person]
  return touch(session, 'options')
}

// One vote per person per category. Voting for another place in it moves the vote; voting for the same place
// again takes it back (a category nobody votes in stays out of the plan).
export async function vote(id, slotId, personId, venueId) {
  // A shared session: the person's own write to the votes table, with no request to the planner. Resolves with the place they have voted
  // for in this slot afterwards (or null). The screens hear of it as a change to the session, and read it again.
  if (onServer()) {
    requireMe(personId)
    if (personId !== me()) throw new Error(SHARING_WORDS.notAllowed)
    // One at a time for a slot in this browser, so the last tap wins: a second tap starts when the first has been written, and reads
    // the vote the first left (a move, or taking it back).
    const myVote = await inTurn(`${id}:vote:${slotId}`, () => remote.castVote(id, slotId, venueId))
    broadcast({ type: 'votes', sessionId: id })
    return { id, slotId, myVote }
  }
  await wait(DELAY.write)
  requireMe(personId)
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
  // The weather at that time, so the confirmed plan can show its marks without asking again. Left out when there was none.
  ...(o.weather ? { weather: o.weather } : {}),
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

// Hand out `make()` unless a newer plan of the session has been handed out already, in which case that one stands: a plan whose read began
// earlier and answers later (a live update, a reload) never goes over a newer one. A plan is older when it holds an older version of
// the session, or, at the same version (a vote raises none), began before the newest one.
// `held` is what the plan was made from (the rows read, and the needs that could be named), kept so that a live vote can read the votes
// alone and make the plan again (planFromServer with `votesOnly`).
// How to call: return newestPlan('3b1f...', ++readCount, 4, () => buildPlan(read), { read, named, diet })
function newestPlan(sessionId, ticket, version, make, held) {
  const have = newestPlanRead.get(sessionId)
  if (have && (version < have.version || (version === have.version && ticket < have.ticket))) return clone(have.plan)
  const plan = make()
  newestPlanRead.set(sessionId, { ticket: Math.max(ticket, have?.ticket ?? 0), version, plan: clone(plan), ...held })
  return plan
}

// What the server says of an outing's dietary needs for the signed-in person (GET /api/sessions/:id/dietary, no names): the needs in
// effect, everyone else's together, the person's own for this outing, whether they confirmed them, and the others' needs the host
// dropped. Asked again at every full read of a plan that is voting, because the host can change it from another device. When the
// server cannot answer (a failure, or the limit) the last good answer stays, so the chips and the cards do not change, and `failed`
// says so for the page to offer a retry; with no good answer yet `diet` is null.
// How to call: await readDiet('3b1f...') -> { diet: { dietary: ['halal'], others: ['halal'], mine: [], checked: false, dropped: [] }, failed: false }
async function readDiet(sessionId) {
  try {
    return { diet: await remote.dietary(sessionId), failed: false }
  } catch {
    return { diet: newestPlanRead.get(sessionId)?.diet ?? null, failed: true }
  }
}

// The same, without the failure flag, for a write that needs the outing's needs once. How to call: await dietaryStateOf('3b1f...')
async function dietaryStateOf(sessionId) {
  return (await readDiet(sessionId)).diet
}

// The dropped needs a screen shows: those the server lists that someone else has (a guest whose own need is dropped sees none).
// How to call: shownDropped({ others: ['halal'], dropped: ['halal', 'vegan'] }) -> ['halal']
const shownDropped = (state) => {
  const others = cleanDietary(state?.others)
  return cleanDietary(state?.dropped).filter((need) => others.includes(need))
}

// The dietary needs the signed-in person may name on the cards of a shared session: their own for this outing, and the others' only
// when the server gives them (three have joined), in which case every need of the group is named (`complete`). Otherwise a card can
// only say, in words that name no need, that a need of the group is unconfirmed for a place (`checkNeeds`). The server stores no need in
// a slot's places and sends none in a search, so in a group of two a need is never the other person's to read.
// How to call: namedNeedsOf(['u1', 'u2', 'u3'], state) -> { needs: ['halal'], complete: true }
function namedNeedsOf(joined, state) {
  const mine = cleanDietary(state?.mine ?? db.user?.dietary)
  if (!state || joined.length < MIN_MEMBERS_FOR_OTHERS) return { needs: mine, complete: false }
  return { needs: cleanDietary([...mine, ...state.others]), complete: true }
}

// The dietary part of a shared session's plan, for the chips and "Confirm dietary needs" on the Vote page: the group's needs in effect,
// the person's own for this outing, the others' together (only from three joined) and the ones the host dropped, and whether the person
// confirmed. With fewer than three joined `dietary` is the person's own alone, because the group's would be the other person's. An
// older server, or one that could not be asked, sends no `mine`, and then the plan has none of it and the page shows nothing.
// How to call: dietaryView({ dietary: ['halal'], others: ['halal'], mine: [], checked: false, dropped: [] }, 3) -> { dietary: ['halal'], myDietary: [], ... }
function dietaryView(state, joinedCount) {
  if (!state?.mine) return {}
  const open = joinedCount >= MIN_MEMBERS_FOR_OTHERS
  const others = open ? cleanDietary(state.others) : []
  return {
    dietary: open ? cleanDietary(state.dietary) : cleanDietary(state.mine),
    unconfirmed: false,
    myDietary: cleanDietary(state.mine),
    othersDietary: others,
    dietDropped: shownDropped({ others, dropped: state.dropped }),
    dietChecked: state.checked !== false,
  }
}

// The places of some options as the cards read them, asked for from the server once each. A place the server does not know is left
// out of the answer, and so out of the page. Rejects with the sentence for a failure, which the page shows with a retry.
// How to call: await ensureVenues(['v25', 'cdc_570511'])
async function ensureVenues(ids) {
  const missing = [...new Set(ids)].filter((venueId) => !serverVenues.has(venueId))
  if (!missing.length) return
  for (const venue of await remote.venues(missing)) serverVenues.set(venue.id, venue)
}

// A shared session's plan for the Vote page, in the shape the local getPlan makes. Read from the database (the slots, the places offered in
// each with what the planner said of them, and the votes) and from the server's description of each place; it asks the planner nothing,
// so it can be read as often as a vote or a live update asks, and a reload shows the same places as before. The weather, the notice about
// few places and the reason a slot is empty are what the server stored with the slot when it ranked it.
// With `votesOnly` (a live vote) it reads the votes alone and makes the plan again from the rows and needs of the plan last handed out;
// a plan never read before is read whole.
// The slots a live vote may name are remembered only when this plan is the newest handed out for its account (see rememberSlots).
// How to call: await planFromServer('3b1f...'); await planFromServer('3b1f...', { votesOnly: true })
async function planFromServer(id, { votesOnly = false } = {}) {
  const asked = epoch
  const ticket = ++readCount
  const held = votesOnly ? newestPlanRead.get(id) : null
  // The outing's needs are asked for only while the session is voting (only then can they change or be shown), and at the same time as the
  // plan's rows when the session is known to be voting, or not known yet. A session known to be in another state asks nothing; if the rows
  // then say it is voting, the needs are asked after. Otherwise the last answer stays.
  const known = newestRead.get(id)?.session?.status
  const early = held?.read ? null : known === undefined || known === 'voting' ? readDiet(id) : null
  const read = held?.read ? { ...held.read, votes: await remote.readSlotVotes(held.read.slotRows.map((slot) => slot.id), held.read.joined) } : await remote.readPlan(id)
  const { diet, failed: dietFailed } = held?.read
    ? { diet: held.diet, failed: held.dietFailed }
    : early
      ? await early
      : read.status === 'voting'
        ? await readDiet(id)
        : { diet: newestPlanRead.get(id)?.diet ?? null, failed: false }
  const named = held?.read ? held.named : namedNeedsOf(read.joined, diet)
  await ensureVenues(Object.values(read.optionRows).flatMap((rows) => rows.map((r) => r.venueId)))
  if (asked !== epoch) throw Object.assign(new Error('That was read for another account.'), { code: 'stale' })
  return newestPlan(
    id,
    ticket,
    read.version,
    () => {
      rememberSlots(id, read.slotRows)
      return planView(read, named, diet, dietFailed)
    },
    { read, named, diet, dietFailed },
  )
}

// A shared session's plan from the rows read for it. `named` is what the person may name of the group's dietary needs (namedNeedsOf):
// each food place's caveats are worked out here from the place's own diet levels for those needs, and a place the server flagged
// (`checkNeeds`) that these needs do not account for says only "check it fits everyone's needs". `diet` is the server's word on the
// outing's dietary needs (readDiet), or null, and `dietFailed` that the last ask for them failed (the page then says so and offers a retry).
// How to call: planView(await remote.readPlan('3b1f...'), { needs: ['halal'], complete: false }, null, false)
function planView(read, named = { needs: [], complete: false }, diet = null, dietFailed = false) {
  const area = read.meetingAreaId ? areaById(read.meetingAreaId) : null
  const ids = read.joined
  const startOf = P.toMinutes(read.start)
  const endOf = P.toMinutes(read.end)
  if (!area || !['voting', 'confirmed', 'completed'].includes(read.status)) {
    return { remote: true, slots: [], voters: [], prefs: clone(read.prefs), counts: P.categoryCounts(read.prefs), stayUntil: null }
  }
  const settled = read.status !== 'voting'
  const slots = read.slotRows.filter((slot) => !slot.deleted).map((slot) => {
    const details = slot.details || {}
    const shown = (read.optionRows[slot.id] || []).flatMap((row) => {
      const venue = serverVenues.get(row.venueId)
      if (!venue) return []
      const d = row.details || {}
      const weather = weatherFrom(d.weather, details.weather)
      const caveats = dietCaveats(venue, named.needs)
      return [{
        id: row.venueId,
        venue: clone(venue),
        score: row.score ?? 0,
        rank: row.rank,
        // Who added the place by hand (they may take it back); null for the planner's own.
        addedBy: row.source === 'member' ? row.addedBy ?? null : null,
        walk: d.walkMinutes ?? P.walkMinutes(area, venue),
        // As the crow flies from the meeting area, for the card ("180 m").
        distanceM: Math.round(P.distanceKm(area, venue) * 1000),
        reasons: d.reasons ?? [],
        warnings: d.warnings ?? [],
        swap: d.swap ? { id: d.swap.venueId, name: d.swap.name } : null,
        explanation: d.explanation ?? '',
        // Named from the place's own diet levels, for the needs the person may name; never read from the stored row, which names none.
        dietUnknown: caveats.dietUnknown,
        verify: caveats.verify,
        // A need of the group is unconfirmed for the place, and the person was not told whose (or all of them): a line that names none.
        checkNeeds: d.checkNeeds === true && !named.complete,
        approximate: !!d.approximate,
        ...(weather ? { weather } : {}),
      }]
    })
    // The planner's score is a penalty: lowest first is best first. A place with no score yet (just added) comes after the scored ones.
    shown.sort((a, b) => a.score - b.score || (a.rank ?? 1e9) - (b.rank ?? 1e9))
    // Only people who are in the session count: a vote of someone who has since gone is not one.
    const votes = Object.fromEntries(Object.entries(read.votes[slot.id] || {}).filter(([person]) => ids.includes(person)))
    const empty = details.empty
    const few = details.few
    return {
      id: slot.id,
      category: slot.category,
      start: slot.start,
      time: slot.time,
      duration: slot.duration,
      picks: slot.picks,
      isLast: slot.isLast,
      ...tallyOptions({ options: shown, votes, nameOf, me: me() }),
      canAddMore: !settled && shown.length < P.OPTIONS_MAX && details.moreAvailable !== false,
      // What the server stored with the slot (backend/docs/planner-api.md, "A slot's details"): `widened` (the planner widened the
      // search), `few` ({ found, widenToKm }: fewer than 3 places fit inside the radius), `empty` ({ reason, nearestKm, widenToKm }:
      // why the slot has no places), `moreAvailable` and `weather`.
      widened: details.widened === true,
      empty: empty ? { reason: empty.reason ?? null, nearestKm: empty.nearestKm ?? null, widenToKm: empty.widenToKm ?? null } : null,
      few: few ? { found: few.found, widenToKm: few.widenToKm ?? null } : null,
    }
  })
  const forecast = combineWeather(read.slotRows.filter((slot) => !slot.deleted).map((slot) => slot.details?.weather))
  return {
    remote: true,
    area: { ...area },
    radius: read.radius ?? null,
    ...dietaryView(diet, ids.length),
    ...(dietFailed ? { dietUnavailable: true } : {}),
    ...(forecast ? { weather: forecast } : {}),
    slots,
    voters: P.voters(read.votes, ids),
    prefs: clone(read.prefs),
    counts: P.categoryCounts(read.prefs),
    stayUntil: P.groupStayUntil(read.prefs, endOf),
    deletedSlots: [...read.deletedSlots],
    stayOptions: P.stayOptions(startOf, endOf),
    // The stops the votes so far would make: { category, time, duration } in order, at the times the server gave the slots.
    planned: slots.filter((slot) => slot.totalVotes > 0).map((slot) => ({ category: slot.category, start: slot.start, time: slot.time, duration: slot.duration })),
  }
}

// Everything the voting screen needs, ranked with the current weather. Once the plan is confirmed the stored
// options are returned as they were: only a session in Voting asks the planner.
export async function getPlan(id, { votesOnly = false } = {}) {
  if (onServer()) return planFromServer(id, { votesOnly })
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
    const ranked = settled ? { options: [], current: [], widened: false, few: null, empty: null, weather: null } : rankings[i]
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
          // Who added the place by hand (they may take it back); null for the planner's own.
          addedBy: session.addedBy?.[slot.id]?.[venueId] ?? null,
          // As the crow flies from the meeting area, for the card ("180 m").
          distanceM: Math.round(P.distanceKm(area, o.venue) * 1000),
          reasons: o.reasons,
          warnings: o.warnings,
          votes: counts[venueId] || 0,
          voters: Object.keys(votes).filter((p) => votes[p] === venueId).map((id) => ({ id, name: nameOf(id) })),
          swap: o.swap,
          explanation: o.explanation,
          // Drink places carry no dietary caveat (the planner sends none for them): only food is checked.
          dietUnknown: o.dietUnknown || [],
          verify: o.verify || [],
          approximate: o.approximate,
          ...(o.weather ? { weather: o.weather } : {}),
        }
      })
      // Places that likely meet more of the group's dietary needs first (only the unconfirmed ones shown on request miss any),
      // then by the planner's score, which is a penalty: lowest first is best first.
      .sort((a, b) => a.dietUnknown.length - b.dietUnknown.length || a.score - b.score)
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
      // Food places are filtered strictly for the group's needs and fewer than 3 fit: the screen says so and offers the places
      // we could not confirm (setUnconfirmed).
      dietFew: !settled && strictFor(session, slot.category) && rankedIds(ranked).length < DIET_FEW,
      leader: P.leader(optionIds, votes),
      // The most votes any option has, and the options sharing it when there is no single leader.
      topVotes: Math.max(0, ...optionIds.map((v) => counts[v] || 0)),
      tied: P.leader(optionIds, votes) ? [] : optionIds.filter((v) => counts[v] && counts[v] === Math.max(...optionIds.map((o) => counts[o] || 0))),
      totalVotes: Object.keys(votes).length,
      myVote: votes[me()] || null,
    }
  })
  // Where the forecast came from, once for the whole list: the planner's block for each slot while voting, what was kept with
  // each option once the plan is settled. Left out when there is none.
  const forecast = combineWeather(settled ? view.flatMap((v) => v.options.map((o) => o.weather)) : rankings.map((r) => r.weather))
  return {
    area: { ...area },
    radius: session.radius ?? null,
    // The group's dietary needs, for the line under Eat ("Showing places that fit halal and vegetarian"). No names, no count.
    dietary: groupNeeds(session),
    // Whether the group asked to see the food places we could not confirm for those needs.
    unconfirmed: !!session.unconfirmed,
    // For "Confirm dietary needs" (DietaryConfirm): the signed-in person's own needs, the needs of the others in the outing
    // together (no names), and whether the signed-in person has confirmed them for this outing.
    myDietary: dietaryOf(me(), session),
    othersDietary: othersNeeds(session),
    // The others' needs the group chose not to filter for (they stay in othersDietary, shown unselected).
    dietDropped: droppedNeeds(session),
    dietChecked: !!session.dietChecked?.[me()],
    ...(forecast ? { weather: forecast } : {}),
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
  // A session on the server: the host confirms and the server writes the stops from its own rows. The browser says only which order it
  // showed (the voted one, or the suggested one by its `basis`), never the stops, the reason or the source. A suggestion the votes have
  // since outdated is refused with 409 `order_stale` (nothing was written); the screen redraws the dialog and the host confirms again.
  if (onServer()) {
    const basis = typeof suggestion?.basis === 'string' ? suggestion.basis : null
    // The voted order carries the basis of the votes the host was shown (from the last question to the server, for an order or for none), so a
    // vote that moved a winner since is refused (409 `order_stale`, nothing written) and the host looks again.
    const seen = shownBasis.get(id)
    // The basis stays with the dialog's answer for every attempt (a retry after a network error or `plan_busy` still says which votes the host
    // was looking at); it goes when the confirm is done, or when the server says those votes are gone (`order_stale`).
    try {
      await remote.confirmPlan(id, basis ? { order: 'suggested', basis } : { order: 'voted', ...(seen && { basis: seen }) })
    } catch (err) {
      if (err?.code === 'order_stale') shownBasis.delete(id)
      throw err
    }
    shownBasis.delete(id)
    return afterServerWrite(id, 'session')
  }
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

// The session of the server a plan screen is about, read afresh, with the places of its stops and proposals described (the cards and the
// layout need them). Rejects with the sentence for a failure to read either, which the screen shows with a retry.
// `known` is a session just read by the caller (a live update read it and asks for the itinerary at once): it is used as it is, so one event is
// one read of the session, not two.
// How to call: const session = await planSession('3b1f...'); const same = await planSession('3b1f...', justRead)
async function planSession(id, known = null) {
  const session = known ?? (await getSession(id))
  await describePlaces(session)
  return session
}

// The session as last read (the newest handed out), with its places described, for a question that does not need a read of its own (the rain swap, the
// weather check): it asks the server only for a place it does not know, and reads the session afresh only when none was read. Rejects as planSession does.
// How to call: const session = await planSessionHeld('3b1f...')
async function planSessionHeld(id) {
  const held = newestRead.get(id)?.session
  if (!held) return planSession(id)
  const session = clone(held)
  await describePlaces(session)
  return session
}

// Asks for the places of a session's stops and proposals that the server has not described yet (once each), and stands in for a stop's place the
// server cannot describe. Rejects with the sentence for a failure to read.
// How to call: await describePlaces(session)
async function describePlaces(session) {
  const wanted = [...(session.plan?.stops || []).map((s) => s.venueId), ...(session.proposals || []).map((p) => p.venueId)]
  await ensureVenues(wanted)
  // A stop whose place the server cannot describe is drawn as "A place that is no longer listed", with its controls (the host can delete it or
  // put another place in it), instead of failing the whole plan.
  const at = session.meeting ? areaById(session.meeting.areaId) : null
  for (const stop of session.plan?.stops || []) {
    if (venueById(stop.venueId)) continue
    unlistedVenues.set(stop.venueId, { id: stop.venueId, name: SHARING_WORDS.placeUnlisted, category: stop.category, area: at?.name ?? '', lat: at?.lat ?? 1.3521, lng: at?.lng ?? 103.8198, price: 0, rating: null, hours: [], serves: [], tags: [], indoor: true, unlisted: true })
  }
}

// The itinerary of a confirmed or finished plan: the stops laid out in time (a meal at its time, a shop after it opens), the travel between
// them, the end, and each person's trip home. A session on the server is read from the database (planSession) and laid out by the same
// rules as a local one, from the same shape of plan; each stop also carries its `stopId`, which is what the server's routes name.
// How to call: await getItinerary('3b1f...')
// `session` may be a session of the server the caller has just read (a live update): it is laid out as it is, without reading it again.
// For a session on the server the itinerary is returned at once, with the trips home already known for this plan or none; when they have to be
// asked of the server (OneMap routes them, which can take seconds) `onTrips({ key, trips, tripsApproximate })` is called when they arrive, but
// only if no newer question has been asked for the session since, so an older answer never replaces a newer one. The itinerary says which
// question its trips belong to (`tripsKey`).
export async function getItinerary(id, { session, onTrips } = {}) {
  if (onServer()) {
    const held = await planSession(id, session ?? null)
    return withServerTrips(held, itineraryView(held), onTrips)
  }
  await wait(DELAY.read)
  return itineraryView(sessionById(id))
}

// The itinerary of a session on the server with its trips home from the server, the figures the finished outing's travel ledger keeps, not an
// estimate of the screen's own: the two would not agree. A confirmed plan asks the server (`GET .../trips-home`) without making anyone wait for
// it: the view has the trips known for this plan, or none, and `onTrips` hears the answer. A finished outing shows none (the person's own row
// of the ledger, "Your travel", is the record); a trip the server cannot give is left out rather than guessed. `tripsApproximate` says the
// figures are estimates ("about"); an approximate answer is asked for again after a few minutes.
// How to call: const view = withServerTrips(session, itineraryView(session), (late) => show(late.trips))
function withServerTrips(session, view, onTrips) {
  if (!view || !session.remote) return view
  if (session.status !== 'confirmed' || !view.stops.length) return { ...view, trips: [], tripsApproximate: true }
  const last = view.stops[view.stops.length - 1]
  const people = activeIds(session).map((pid) => ({ id: pid, name: nameOf(pid), place: endPlaceOf(session, pid) })).filter((p) => p.place)
  const key = JSON.stringify([session.id, last.venue?.id, last.end, people.map((p) => [p.id, p.place.id])])
  // The trips of a plan from what the server said: the people it gave minutes for.
  const tripsOf = (known) => ({
    trips: known
      ? people
          .filter((p) => Number.isFinite(known.minutes[String(p.id).toLowerCase()]))
          .map((p) => ({ id: p.id, name: p.name, place: p.place.name, minutes: known.minutes[String(p.id).toLowerCase()], long: known.minutes[String(p.id).toLowerCase()] > P.LONG_TRIP_MINUTES }))
      : [],
    tripsApproximate: known ? known.approximate : true,
  })
  const known = tripsHomeKnown.get(key)
  tripsHomeWanted.set(session.id, { key, onTrips })
  if ((!known || (known.approximate && Date.now() - known.at > TRIPS_RETRY_MS)) && !tripsHomeAsked.has(key)) {
    const asked = epoch
    if (tripsHomeKnown.size > 50) tripsHomeKnown.clear()
    const pending = remote
      .tripsHome(session.id)
      .then((answer) => {
        if (asked !== epoch) return
        const kept = { ...answer, at: Date.now() }
        tripsHomeKnown.set(key, kept)
        const wanted = tripsHomeWanted.get(session.id)
        if (wanted?.key === key) wanted.onTrips?.({ key, ...tripsOf(kept) })
      })
      .catch(() => {
        // The trips stay as they were (none, or the last answer); the next read of the plan asks again.
      })
      .finally(() => tripsHomeAsked.delete(key))
    tripsHomeAsked.set(key, pending)
  }
  return { ...view, ...tripsOf(known), tripsKey: key }
}

// How to call: itineraryView(session) -> { stops, weather, legs, end, trips, aiNote, area, starts } or null for a session with no plan
function itineraryView(session) {
  if (!session.plan) return null
  const stops = session.plan.stops.map((s) => ({ ...s, venue: venueById(s.venueId) }))
  const startAt = session.plan.startAt ?? Math.min(...session.plan.stops.map((s) => s.plannedStart))
  const bounds = { windowEnd: windowOf(session).windowEnd, stayUntil: P.groupStayUntil(activePrefs(session), windowOf(session).windowEnd) }
  const { stops: timed, legs } = P.buildItinerary(stops, session.plan.modes, startAt, bounds)
  const last = timed[timed.length - 1]?.venue || null
  const people = activeIds(session)
    .map((pid) => ({ id: pid, name: nameOf(pid), place: endPlaceOf(session, pid) }))
    .filter((p) => p.place)
    .map((p) => ({ id: p.id, name: p.name, end: { ...p.place } }))
  const area = session.meeting ? areaById(session.meeting.areaId) : null
  // The weather kept with each stop when the plan was confirmed. A plan confirmed before it was kept has none: null.
  // How to call: keptWeather(timed[0]) -> { state: 'dry', ... } or null
  const keptWeather = (s) => session.confirmedRanking?.[s.slotId]?.[s.venue?.id]?.weather ?? null
  return {
    stops: timed.map((s, index) => ({ index, slotId: s.slotId, ...(s.stopId ? { stopId: s.stopId } : {}), category: s.category, venue: clone(s.venue), start: s.start, end: s.end, duration: s.duration, open: s.open, withinWindow: s.withinWindow, withinStay: s.withinStay, weather: keptWeather(s) })),
    // Where the kept forecast came from, once for all stops, or null.
    weather: combineWeather(timed.map(keptWeather)),
    legs,
    end: P.endPoint(last),
    trips: P.tripsHome(last, people),
    tripsApproximate: true,
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

// ── Weather on the day ────────────────────────────────────────────────────

// The day the stops of a plan fall on: the session's date, or today when the demo's session-day switch is on.
// How to call: stopDay(session) -> '2026-10-11'
function stopDay(session) {
  return db.conditions.sessionDay && session.date !== todayKey() ? todayKey() : session.date
}

// A stop's start as the planner reads it, "YYYY-MM-DDTHH:MM" in Singapore time. A start past midnight is on the next day.
// How to call: localStart('2026-10-11', 1500) -> '2026-10-12T01:00'
function localStart(day, minutes) {
  const date = format(addDays(parseISO(day), Math.floor(minutes / 1440)), 'yyyy-MM-dd')
  return `${date}T${P.fromMinutes(minutes)}`
}

// The weather at the stops of a confirmed plan, asked of the planner now, for the times the itinerary shows. Nothing is
// written: the itinerary keeps the answer in its store. A failed request throws, and the caller keeps its last answer.
// Resolves { checkedAt, stops: { [slotId]: weather object }, weather: the answer's block }.
// How to call: await checkStopWeather('s1')
export async function checkStopWeather(id) {
  if (!onServer()) await wait(DELAY.read)
  const session = onServer() ? await planSessionHeld(id) : sessionById(id)
  const stops = timedStops(session).flatMap((s) => {
    const venue = venueById(s.venueId)
    if (!venue) return []
    const { indoor, exposure } = venueSetting(venue)
    return [{ id: s.slotId, point: { lat: venue.lat, lng: venue.lng }, start: localStart(stopDay(session), s.start), setting: indoor ? 'indoor' : 'outdoor', exposure }]
  })
  if (!stops.length) return { checkedAt: Date.now(), stops: {}, weather: null }
  const answer = await planner.stopsWeather({ stops, conditions: db.conditions })
  return { checkedAt: Date.now(), stops: answer.stops, weather: answer.weather }
}

// The weather at some places and times, for Home's map: the planner's answer for each stop, with the demo's rain switch applied.
// Nothing is written. A failed request throws.
//   stops: [{ id, point: { lat, lng }, start: 'YYYY-MM-DDTHH:MM' }], at most 8
// Resolves { stops: { [id]: weather object (lib/weatherText.js) }, weather: the answer's block }.
// How to call: await weatherAt([{ id: 'bishan', point: { lat: 1.3508, lng: 103.8485 }, start: '2026-10-11T15:00' }])
export async function weatherAt(stops) {
  await wait(DELAY.read)
  return planner.stopsWeather({ stops, conditions: db.conditions })
}

// The slot a plan stop is, as the planner ranks it: the stop's own time and length.
// How to call: slotOfStop(timed) -> { id: 'activity', category: 'activity', start: 900, time: '15:00', duration: 90 }
const slotOfStop = (stop) => ({ id: stop.slotId, category: stop.category, start: stop.start, time: P.fromMinutes(stop.start), duration: stop.duration })

// The indoor place the planner would swap a stop for in the rain, or null when it offers none. Asks the planner about this
// stop at its time on the day, with the stop's place as the one option: the same `swap` the voting card shows. Nothing is
// written. Resolves { id, name } or null; a failed request throws.
// How to call: await findRainSwap('s1', 'activity') -> { id: 'toa-payoh-library', name: 'Toa Payoh Public Library' }
export async function findRainSwap(id, slotId) {
  // A session on the server: the server's own ranking of the stop's place at its time; the indoor place it offers, or none.
  if (onServer()) {
    const session = await planSessionHeld(id)
    const stop = session.plan?.stops.find((s) => s.slotId === slotId)
    if (!stop) return null
    const answer = await remote.stopSwap(id, stop.stopId)
    const swap = answer?.swap
    if (!swap || typeof swap.venueId !== 'string') return null
    return { id: swap.venueId, name: String(swap.name ?? '') }
  }
  await wait(DELAY.read)
  const session = sessionById(id)
  const stop = timedStops(session).find((s) => s.slotId === slotId)
  if (!stop) return null
  const ranked = await rankSlot({ ...session, date: stopDay(session) }, slotOfStop(stop), [], [stop.venueId])
  const swap = ranked.current.find((o) => o.venue.id === stop.venueId)?.swap
  return swap ? { id: swap.id, name: swap.name } : null
}

// Change a confirmed plan's stop to another place: the one piece of code that does it, for the rain swap (swapPlannedStop)
// and for Replace (replaceStop), so the two keep the same things in step. Only the host. The new place is ranked for the stop's
// time on its day first, so its details are kept with the plan like the others, and it must fit. Asking again once the stop is
// the new place changes nothing. It is refused when the stop holds another place than `fromId`, the one the caller saw, either
// when asked or by the time the planner answered (so of two changes asked at once only one is made), or when the stop has moved.
// What it keeps in step: the stop's place and category; the stop's earliest start, which is the start the planner checked (so a
// meal held at 12:00 is never started earlier than the time it was checked for, and a stop added from Roam keeps meaning "not
// before the moment it was added"); the travel to and from the stop, back to its default modes; the AI's note about the order;
// the group's options for the slot (the place goes in the old one's place; for another category the old one just leaves);
// the details kept for the confirmed plan; and the rain warning the host dismissed for the stop.
// `last` ranks it as the plan's last stop; `verb` ('swap' or 'replace') is the word in the refusals.
// How to call: await changeStopPlace(session, 'activity', 'toa-payoh-library', { fromId: 'east-coast-park', verb: 'swap' })
async function changeStopPlace(session, slotId, toId, { fromId, category, last = false, verb = 'swap' } = {}) {
  if (session.hostId !== me()) throw new Error(`Only the host can ${verb} a stop.`)
  if (session.status !== 'confirmed') throw new Error('Only a confirmed plan can have a stop replaced.')
  const { stop: current, slot } = stopSlot(session, slotId, category)
  const seen = fromId ?? current.venueId
  if (current.venueId === toId && current.category === slot.category) return session.remote ? getSession(session.id) : summary(session)
  if (current.venueId !== seen) throw new Error('That stop has changed. Look at the plan again.')
  const taken = () => session.plan.stops.some((s) => s.slotId !== slotId && s.venueId === toId)
  if (taken()) throw new Error(`${venueById(toId)?.name || 'This place'} is already in the plan.`)
  // A session on the server: the server checks that the place exists and fits the stop's time on its day, that the stop still holds what the
  // caller saw, and keeps the stop from starting earlier than the time it was checked for (the server's own rule; the browser sends no time).
  if (session.remote) {
    await remote.changeStopPlace(session.id, current.stopId, { venueId: toId, seenVenueId: seen, category: slot.category })
    return afterServerWrite(session.id, 'options')
  }
  const ranked = await rankSlot({ ...session, date: stopDay(session) }, slot, last ? [slot] : [], [toId])
  const found = [...ranked.current, ...ranked.options].find((o) => o.venue.id === toId)
  if (!found) throw new Error(`${venueById(toId)?.name || 'That place'} does not fit this stop.${verb === 'replace' ? ' Choose another place.' : ''}`)
  // The plan may have changed while the planner answered: the stop must hold the place the caller saw, still at the time that was checked.
  const index = session.status === 'confirmed' ? (session.plan?.stops || []).findIndex((s) => s.slotId === slotId) : -1
  const now = index >= 0 ? session.plan.stops[index] : null
  if (!now || now.venueId !== seen || now.category !== current.category || timedStops(session)[index].start !== slot.start) throw new Error('That stop has changed. Look at the plan again.')
  if (taken()) throw new Error(`${venueById(toId)?.name || 'This place'} is already in the plan.`)
  session.plan.stops = session.plan.stops.map((s, i) => (i === index ? { ...s, venueId: toId, category: slot.category, notBefore: Math.max(s.notBefore ?? 0, slot.start) } : s))
  const modes = [...(session.plan.modes || [])]
  if (index > 0) modes[index - 1] = undefined
  if (index < modes.length) modes[index] = undefined
  session.plan.modes = modes
  session.plan.aiNote = null
  const options = session.options[slotId] || []
  session.options[slotId] = slot.category === current.category ? [...new Set(options.map((v) => (v === seen ? toId : v)))] : options.filter((v) => v !== seen)
  const { [seen]: _left, ...kept } = session.confirmedRanking?.[slotId] || {}
  session.confirmedRanking = { ...session.confirmedRanking, [slotId]: { ...kept, [toId]: rankedDetail(found) } }
  if (session.weatherDismissed) delete session.weatherDismissed[slotId]
  return touch(session, 'options')
}

// Change a confirmed plan's stop to another place in the rain: only the host, and only the place the stop now has. The work is
// changeStopPlace's, the same as Replace.
// How to call: await swapPlannedStop(session, 'activity', 'east-coast-park', 'toa-payoh-library')
async function swapPlannedStop(session, slotId, fromId, toId) {
  return changeStopPlace(session, slotId, toId, { fromId, verb: 'swap' })
}


// The host keeps a stop as it is in the rain. The warning stays dismissed for that stop until the forecast changes state
// (lib/weatherText.js isDismissed), so `state` is the forecast's state when it was dismissed. Only the host. For a session on the server it is
// stored on the session, so everyone's screens agree.
// How to call: await dismissRainWarning('s1', 'activity', 'showers')
export async function dismissRainWarning(id, slotId, state) {
  // A session on the server: the host's press is stored on the session (`sessions.weather_kept`, by the server), so every member and every
  // device of the host sees the warning put away; it comes back when the forecast changes state, and goes when the stop's place changes.
  if (onServer()) {
    const session = await planSession(id)
    if (session.hostId !== me()) throw new Error('Only the host can dismiss this.')
    const stop = session.status === 'confirmed' ? session.plan?.stops.find((s) => s.slotId === slotId) : null
    if (!stop?.stopId) throw new Error('This stop is not in the plan.')
    await remote.keepRain(id, stop.stopId, stateOf(state))
    return afterServerWrite(id, 'plan')
  }
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.hostId !== me()) throw new Error('Only the host can dismiss this.')
  if (session.status !== 'confirmed' || !session.plan?.stops.some((s) => s.slotId === slotId)) throw new Error('This stop is not in the plan.')
  session.weatherDismissed = { ...session.weatherDismissed, [slotId]: stateOf(state) }
  return touch(session, 'plan')
}

// Which stop of a session on the server is at `index` in the plan the person last saw, for the routes that name a stop. `seen` is the stop
// ids the caller drew its list from (when it knows them), which are the stops the index means.
// How to call: stopIdAt(newestRead.get(id)?.session, 2) -> '5d0c...'
function stopIdAt(session, index, seen) {
  const id = (seen || (session?.plan?.stops || []).map((s) => s.stopId))[index]
  if (!id) throw Object.assign(new Error(SHARING_WORDS.stopGone), { code: 'stop_not_found' })
  return id
}

// How the group gets to the stop after leg `legIndex`: 'walk', 'mrt' or 'car'. On the server this is the host's, and `stopId` (the stop
// the leg leads to, which the itinerary carries) says which stop, so a plan another device has changed is never written to by position.
// How to call: await setTravelMode('s1', 0, 'mrt'); await setTravelMode('3b1f...', 0, 'mrt', { stopId: '5d0c...' })
export async function setTravelMode(id, legIndex, mode, { stopId } = {}) {
  if (onServer()) {
    await remote.setTravelMode(id, stopId ?? stopIdAt(newestRead.get(id)?.session, legIndex + 1), mode)
    return afterServerWrite(id, 'plan')
  }
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
  if (onServer()) return suggestOrderOnServer(id)
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

// The server's answer for the Confirm dialog, in the shape the dialog reads: `voted` (the stops of the voted order with the starts the server
// will store, with the places' names) and, when the server has another order to offer, the suggestion (the local one's shape, plus the `basis`
// the confirm sends back). Both are the server's own rows laid out as a confirm will store them, so what the host reads is what is saved. The
// server sends slot ids, places, starts and lengths; the name is the place's (or "A place that is no longer listed"). Rejects when the answer
// has no voted order the dialog can draw, or the server refuses (the dialog says why), never rows it cannot vouch for.
// How to call: const answer = await suggestOrderOnServer('3b1f...') // { voted: [{ slotId, category, venueId, name, start, duration }], basis, order, stops, reason, source }
async function suggestOrderOnServer(id) {
  const asked = epoch
  let voted = null
  const answer = await remote.suggestOrder(id, { onBasis: (basis) => shownBasis.set(id, basis), onVoted: (rows) => { voted = rows } })
  // Asked for by the account before: not used, not shown.
  if (asked !== epoch) return null
  if (!voted) throw new Error('The order of the stops could not be shown. Try again.')
  // A place the list of places cannot describe (or cannot be asked about just now) is shown as "A place that is no longer listed": the order
  // is the server's and the host may confirm it, the basis protecting it; only the name is missing.
  await ensureVenues([...voted.map((s) => s.venueId), ...(answer?.stops || []).map((s) => s.venueId)]).catch(() => {})
  if (asked !== epoch) return null
  const nameOf = (venueId) => serverVenues.get(venueId)?.name || SHARING_WORDS.placeUnlisted
  const named = voted.map((s) => ({ ...s, name: nameOf(s.venueId) }))
  if (!answer) return { voted: named }
  const byslot = new Map(named.map((s) => [s.slotId, s]))
  const stops = answer.stops.map((s) => {
    const mine = byslot.get(s.slotId)
    return mine ? { slotId: s.slotId, category: mine.category, venueId: s.venueId, name: nameOf(s.venueId), start: s.start, duration: mine.duration } : null
  })
  if (stops.some((s) => !s)) return { voted: named }
  return { voted: named, order: answer.order, basis: answer.basis, stops, reason: P.cleanReason(answer.reason), source: answer.source === 'ai' ? 'ai' : 'rules' }
}

// Rearrange the itinerary: move the stop at `from` to `to`. The plan keeps its start time and every stop is
// re-timed after the one before it. Travel modes go back to their defaults, because the legs are new pairs.
// On the server the move is the host's, and `seen` (the stop ids as the caller drew its list) is checked against the stops now: a move made
// from a list another device has since changed is turned away (`plan_changed`) and nothing is written.
export async function reorderStops(id, from, to, { seen } = {}) {
  if (onServer()) {
    const now = await remote.stopIds(id)
    if (seen && (seen.length !== now.length || seen.some((stopId, i) => stopId !== now[i]))) throw Object.assign(new Error(SHARING_WORDS.planChanged), { code: 'plan_changed' })
    if (from === to || from < 0 || to < 0 || from >= now.length || to >= now.length) return getSession(id)
    await remote.reorderStops(id, P.moveItem(now, from, to))
    return afterServerWrite(id, 'plan')
  }
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.status !== 'confirmed') throw new Error('Only a confirmed plan can be rearranged.')
  const { stops } = session.plan
  if (from === to || from < 0 || to < 0 || from >= stops.length || to >= stops.length) return summary(session)
  if (session.plan.startAt == null) session.plan.startAt = Math.min(...stops.map((s) => s.plannedStart))
  session.plan.stops = P.moveItem(stops, from, to).map(withoutAiTime)
  session.plan.modes = []
  session.plan.aiNote = null
  return touch(session, 'plan')
}

// A stop without the earliest start the AI order gave it: moving or deleting a stop by hand clears that. A stop added from a
// proposal keeps its own, because it says the stop cannot start before the moment it was added (see resolveProposal).
// How to call: stops.map(withoutAiTime)
function withoutAiTime(stop) {
  if (isRoamStop(stop)) return stop
  const { notBefore, ...rest } = stop
  return rest
}

// On the server the stop is named by `stopId` (the itinerary carries it), and deleting one that is gone already is "that stop is not in
// the plan any more", not a delete of whichever stop took its place.
export async function deleteStop(id, index, { stopId } = {}) {
  if (onServer()) {
    await remote.deleteStop(id, stopId ?? stopIdAt(newestRead.get(id)?.session, index))
    return afterServerWrite(id, 'plan')
  }
  await wait(DELAY.write)
  const session = sessionById(id)
  const { stops, modes = [] } = planOf(session)
  if (!Number.isInteger(index) || index < 0 || index >= stops.length) throw new Error('This stop does not exist.')
  if (stops.length <= 1) throw new Error('A plan needs at least one stop.')
  session.plan.stops = stops.filter((_, i) => i !== index).map(withoutAiTime)
  session.plan.aiNote = null
  // The plan starts when its first stop does: if the first stop goes, the next one starts at its own planned time
  // instead of being pulled forward to the old start. A stop added from a proposal has no planned time of its own (its
  // `plannedStart` is when the plan ended then); what it carries is the earliest it may start, so the plan starts there.
  if (index === 0) {
    const first = session.plan.stops[0]
    session.plan.startAt = isRoamStop(first) && first.notBefore != null ? first.notBefore : first.plannedStart
  }
  // The legs on either side of the removed stop merge into one, which starts with its default mode.
  const nextModes = [...modes]
  if (index === 0) nextModes.splice(0, 1)
  else nextModes.splice(index - 1, 2, undefined)
  session.plan.modes = nextModes.slice(0, session.plan.stops.length - 1)
  return touch(session, 'plan')
}

// ── Roam: what next, and the places members propose ────────────────────────

// Places the planner sent for a Roam list, by id, for this visit only (never saved). Proposing one saves its venue with the
// proposal, so a list that was read never writes anything and a failed read leaves nothing half-written.
const roamed = new Map()
// The most places kept in `roamed`: the oldest are forgotten first, so a long visit does not grow without end. A list holds
// RANKED_MAX places at most, so this is several lists' worth.
const ROAMED_MAX = 200

// Remember a place the planner sent for a Roam list, forgetting the oldest beyond ROAMED_MAX.
// How to call: rememberRoamed(place.id, place.venue)
function rememberRoamed(id, venue) {
  roamed.delete(id)
  roamed.set(id, venue)
  while (roamed.size > ROAMED_MAX) roamed.delete(roamed.keys().next().value)
}

// Take the places no one uses any more out of the save. Proposing a place saves its venue with the proposal (`db.venues`),
// so when the proposal is dismissed, taken back or cleared, the venue goes too unless a stop, an option or another
// proposal in any session still needs it (or the place is one of the built-in ones, which are never saved).
// How to call: forgetUnusedVenues(['google-xyz'])
function forgetUnusedVenues(venueIds) {
  for (const venueId of new Set(venueIds)) {
    if (!(venueId in db.venues)) continue
    const used = db.sessions.some(
      (s) =>
        (s.plan?.stops || []).some((stop) => stop.venueId === venueId) ||
        Object.values(s.options || {}).some((list) => (list || []).includes(venueId)) ||
        Object.values(s.confirmedRanking || {}).some((byVenue) => venueId in (byVenue || {})) ||
        proposalsOf(s).some((p) => p.venueId === venueId),
    )
    if (!used) delete db.venues[venueId]
  }
}

// A session without proposals (saved before Roam) has the key missing; one with proposals keeps an empty list.
// How to call: clearProposals(session)
function clearProposals(session) {
  if (session.proposals === undefined) return
  const dropped = proposalsOf(session).map((p) => p.venueId)
  session.proposals = []
  forgetUnusedVenues(dropped)
}

// Is the plan under way, so places can be proposed? It is the moment the itinerary's footer says "Finish outing": a
// confirmed plan on the session's day. Throws a sentence for each way it is not.
// How to call: assertRoamOpen(session)
function assertRoamOpen(session) {
  if (['completed', 'cancelled'].includes(session.status)) throw new Error(SESSION_ENDED)
  if (session.status !== 'confirmed' || !session.plan) throw new Error('Places can be proposed once the plan is confirmed.')
  if (!isSessionDay(session)) throw new Error('Places can be proposed on the day of the outing.')
}

// The stops of the plan with their times, as the itinerary lays them out.
// How to call: timedStops(session) -> [{ slotId, venueId, venue, start, end, ... }]
function timedStops(session) {
  const { stops, modes = [] } = planOf(session)
  const startAt = session.plan.startAt ?? Math.min(...stops.map((s) => s.plannedStart))
  const windowEnd = windowOf(session).windowEnd
  const stayUntil = P.groupStayUntil(activePrefs(session), windowEnd)
  return P.buildItinerary(stops.map((s) => ({ ...s, venue: venueById(s.venueId) })), modes, startAt, { windowEnd, stayUntil }).stops
}

// "What next?" for a session on the server: the server ranks the places near the group (its own view of the group's needs), the list is
// centred on the meeting area unless `point` ({ lat, lng }, "Use my location") says otherwise (sent for this one request, never stored), and
// each place is marked as the plan and the proposals stand now. The people's dietary needs are the server's business here: the answer
// names none. Nothing is written.
// How to call: await roamOnServer('3b1f...', { point: { lat: 1.3521, lng: 103.8198 }, categories: ['eat'] })
async function roamOnServer(id, { point, categories } = {}) {
  const session = await planSession(id)
  assertRoamOpen(session)
  if (!session.meeting) throw new Error('There is no meeting area yet.')
  const own = point !== undefined && point !== null
  if (own && !(Number.isFinite(point.lat) && Number.isFinite(point.lng) && P.inSingapore(point))) throw new Error('That place is outside Singapore. Pick an area instead.')
  const answer = await remote.roam(id, { current: own ? { lat: point.lat, lng: point.lng } : undefined, categories })
  // The cards of the places listed are known now, so a place proposed from the list can be drawn at once.
  for (const place of answer.places) if (place.venue) serverVenues.set(place.id, place.venue)
  // The plan and the proposals as they stand now (read afresh by the answer's own time, not the page's).
  const now = await planSession(id)
  const meetingArea = areaById(now.meeting.areaId)
  const here = own ? { lat: point.lat, lng: point.lng } : { lat: meetingArea.lat, lng: meetingArea.lng }
  const stopIds = (now.plan?.stops || []).map((s) => s.venueId)
  const proposals = proposalsOf(now)
  const area = own ? areaForPoint(here) : meetingArea
  return {
    centre: { areaId: area.id, areaName: area.name },
    places: answer.places.map((place) => {
      const { state, proposal } = placeState(place.id, place.isStop ? [...stopIds, place.id] : stopIds, proposals)
      return { ...place, state, proposal: proposal ? { id: proposal.id, by: proposal.by, byName: nameOf(proposal.by) } : null }
    }),
    empty: answer.empty,
    widened: answer.widened,
    dietary: [],
    unconfirmed: false,
    dietFew: false,
    ...(answer.weather ? { weather: combineWeather([answer.weather]) } : {}),
    blocked: proposeBlock({ stops: stopIds.length, mine: proposals.filter((p) => p.by === me()).length, total: proposals.length }),
  }
}

// "What next?": ranked places near where the group is, for a plan that is under way. The list is centred on the meeting
// area unless `point` ({ lat, lng }, from "Use my location") says otherwise; the point goes to the planner for this one
// request and is never stored, logged or returned, so nobody else can see it. `categories` narrows the list (any of eat,
// drink, shop, activity); left out, the planner uses eat, drink and activity. The search is for the time the next stop
// would start: when the last stop ends, or now if that has passed.
// Each place is a voting-page card plus `id`, `travelMinutes`, `distanceM`, `state` ('stop' already in the plan, 'proposed',
// or 'free') and, when proposed, `proposal: { id, by, byName }`. `blocked` is why the signed-in person cannot propose now,
// or ''. `centre` names the area the list is about. Nothing is written.
// Dietary needs work as on the voting page: food places are filtered strictly for the group's needs, and halal keeps bars out.
// `unconfirmed: true` (this person's own choice, not saved) shows the food places we could not confirm too. The answer says
// `dietary` (the group's needs, no names), `unconfirmed`, and `dietFew` when fewer than 3 food places fit.
// How to call: await roamNearby('s1', { point: { lat: 1.3521, lng: 103.8198 }, categories: ['eat'] })
export async function roamNearby(id, { point, categories, unconfirmed = false } = {}) {
  if (onServer()) return roamOnServer(id, { point, categories })
  await wait(DELAY.read)
  const session = sessionById(id)
  assertRoamOpen(session)
  if (!session.meeting) throw new Error('There is no meeting area yet.')
  const own = point !== undefined && point !== null
  if (own && !(Number.isFinite(point.lat) && Number.isFinite(point.lng) && P.inSingapore(point))) throw new Error('That place is outside Singapore. Pick an area instead.')
  const meetingArea = areaById(session.meeting.areaId)
  const here = own ? { lat: point.lat, lng: point.lng } : { lat: meetingArea.lat, lng: meetingArea.lng }
  const lastEnd = timedStops(session).at(-1)?.end ?? 0
  const startsAt = Math.min(1439, nextStopStart(lastEnd, singaporeMinutes()))
  const needs = groupNeeds(session)
  const strict = needs.length > 0 && !unconfirmed
  const answer = await planner.roamNearby({
    members: withGroupNeeds(activeIds(session).map((pid) => ({ id: pid })), needs),
    dietPolicy: strict ? 'strict' : 'lenient',
    current: here,
    date: todayKey(),
    time: P.fromMinutes(startsAt),
    minutes: ROAM.minutes,
    categories,
    conditions: db.conditions,
    topN: RANKED_MAX,
  })
  for (const place of answer.places) rememberRoamed(place.id, place.venue)
  const stopIds = (session.plan?.stops || []).map((s) => s.venueId)
  const proposals = proposalsOf(session)
  const area = own ? areaForPoint(here) : meetingArea
  return {
    centre: { areaId: area.id, areaName: area.name },
    places: answer.places.map((place) => {
      const { state, proposal } = placeState(place.id, stopIds, proposals)
      return { ...place, state, proposal: proposal ? { id: proposal.id, by: proposal.by, byName: nameOf(proposal.by) } : null }
    }),
    empty: answer.empty,
    widened: answer.widened,
    dietary: needs,
    unconfirmed: needs.length > 0 && !!unconfirmed,
    // Food is asked for (or every category is) and fewer than 3 food places fit the group's needs.
    dietFew: strict && (!categories?.length || categories.includes('eat')) && answer.places.filter((p) => p.venue.category === 'eat').length < DIET_FEW,
    // Where the forecast came from, for the line under the list; left out when the planner sent none.
    ...(answer.weather ? { weather: combineWeather([answer.weather]) } : {}),
    blocked: proposeBlock({ stops: stopIds.length, mine: proposals.filter((p) => p.by === me()).length, total: proposals.length }),
  }
}

// A member puts a place from the Roam list forward as the next stop. Anyone in the session who has not opted out may,
// only while the plan is under way. A place already in the plan cannot be proposed; one that is already proposed stays
// the first person's proposal and this changes nothing (the answer says `applied: false`, otherwise `applied: true`). A member keeps at most 3 waiting, a session 10, and a full plan
// (8 stops) takes no more. The place must be one the planner sent in this visit, or one already known.
// How to call: await proposeStop('s1', 'faith', 'v25')
export async function proposeStop(id, personId, venueId) {
  // A session on the server: the server checks the place exists, is not in the plan, and the limits (3 a person, 10 a session, 8 stops).
  if (onServer()) {
    requireMe(personId)
    if (personId !== me()) throw new Error(SHARING_WORDS.notAllowed)
    const made = await remote.propose(id, venueId)
    return { ...(await afterServerWrite(id, 'plan')), applied: !made.existing }
  }
  await wait(DELAY.write)
  requireMe(personId)
  const session = sessionById(id)
  assertRoamOpen(session)
  if (!activeIds(session).includes(personId)) throw new Error('Only people in this session can do that.')
  const venue = venueById(venueId) || roamed.get(venueId)
  if (!venue) throw new Error('This place does not exist.')
  if (!P.CATEGORIES.includes(venue.category)) throw new Error('This kind of place cannot be added to a plan.')
  const { stops } = planOf(session)
  if (stops.some((s) => s.venueId === venueId)) throw new Error('That place is already in the plan.')
  const proposals = proposalsOf(session)
  if (proposals.some((p) => p.venueId === venueId)) return { ...summary(session), applied: false }
  const block = proposeBlock({ stops: stops.length, mine: proposals.filter((p) => p.by === personId).length, total: proposals.length, you: personId === me(), name: nameOf(personId) })
  if (block) throw new Error(block)
  db.venues[venueId] ||= clone(venue)
  session.proposals = [...proposals, { id: `pp${db.seq++}`, venueId, by: personId, at: Date.now() }]
  return { ...touch(session, 'plan'), applied: true }
}

// The host adds a proposed place to the plan (accept) or leaves it out (dismiss); the person who proposed it may also
// dismiss it, which is taking it back. Adding appends a stop at the end of the plan, in the place's own category, lasting 60
// minutes. The stop may not start before `notBefore`: when the last stop ends, or now if that has passed, the same time the
// list of places was ranked for (roamNearby), so what the list showed as open then is what the itinerary shows; without it a
// plan that ended hours ago would put the stop in the past. Adding clears the note about the suggested order (the stops
// still stand in the order they had).
// The answer is the session as getSession answers it, plus `applied`: true when there was a proposal and it was decided,
// false when there was none any more (already decided, or cleared by an opt-out, a re-plan, a finished or a cancelled
// outing), which changes nothing, so a second press is harmless and the screen can say that nothing happened.
// A waiting proposal can always be decided while the plan is confirmed, even after the session's day has passed: the day
// only decides whether new places can be proposed (assertRoamOpen), not whether the host may answer those already waiting.
// How to call: await resolveProposal('s1', 'pp7', true) -> { ...session, applied: true }
export async function resolveProposal(id, proposalId, accept) {
  // A session on the server: the host adds the place to the plan or leaves it out; the proposer may take their own back. A proposal that is
  // no longer there (another device answered it, or a re-plan took it) is a 200 from the server with `applied: false`, which changes nothing,
  // and the answer says so.
  if (onServer()) {
    requireMe()
    const answered = await remote.resolve(id, proposalId, accept)
    return { ...(await afterServerWrite(id, 'plan')), applied: answered?.applied !== false }
  }
  await wait(DELAY.write)
  requireMe()
  const session = sessionById(id)
  const proposals = proposalsOf(session)
  const proposal = proposals.find((p) => p.id === proposalId)
  if (!proposal) return { ...summary(session), applied: false }
  const isHost = session.hostId === me()
  if (accept && !isHost) throw new Error('Only the host can add a place to the plan.')
  if (!accept && !isHost && proposal.by !== me()) throw new Error('Only the host, or the person who proposed it, can dismiss it.')
  if (accept) {
    const { stops } = planOf(session)
    const venue = venueById(proposal.venueId)
    if (!venue) throw new Error('This place does not exist.')
    if (!stops.some((s) => s.venueId === proposal.venueId)) {
      if (stops.length >= ROAM.stops) throw new Error(proposeBlock({ stops: stops.length, mine: 0, total: 0 }))
      // A light meetup (startRoam) starts with no stops: its first stop starts now.
      const last = timedStops(session).at(-1)
      const notBefore = nextStopStart(last?.end, singaporeMinutes())
      session.plan.stops = [...stops, { slotId: `roam-${proposal.id}`, category: venue.category, venueId: proposal.venueId, plannedStart: last?.end ?? notBefore, duration: ROAM.minutes, notBefore }]
      if (!last) session.plan.startAt = notBefore
      // The note was about the order the stops had; the plan is no longer exactly that.
      session.plan.aiNote = null
    }
  }
  session.proposals = proposals.filter((p) => p.id !== proposalId)
  forgetUnusedVenues([proposal.venueId])
  return { ...touch(session, 'plan'), applied: true }
}

// "Already out? Find something nearby" on Home: a light meetup for today, hosted by the signed-in person, already under way
// around one area, so the Roam list opens at once. There is no location step and no vote: the area is the meeting area (the
// group sees its name, never the exact place it came from), the plan starts with no stops, and places are added through
// Roam's proposals. It runs from now for three hours (to 23:59 at the latest), so it finishes by itself after that like any
// confirmed outing. Inviting friends is optional: with one person it is not paused (lib/session.js isPaused). Local
// accounts only for now: a shared session's status is the server's to set.
// How to call: const session = await startRoam({ areaId: 'bugis' })
export async function startRoam({ areaId, title = '' } = {}) {
  if (onServer()) throw new Error('Finding something nearby is not ready for shared sessions yet.')
  await wait(DELAY.write)
  requireMe(undefined, 'Log in to find something nearby.')
  const area = areaById(areaId)
  if (!area) throw new Error('Pick an area first.')
  const name = String(title ?? '').trim() || `Out in ${area.name}`
  if (name.length > 60) throw new Error('A title can be at most 60 characters.')
  const from = Math.min(singaporeMinutes(), 23 * 60 + 58)
  const session = {
    id: `s${db.seq++}`,
    title: name,
    date: todayKey(),
    start: P.fromMinutes(from),
    end: P.fromMinutes(Math.min(from + 3 * 60, 23 * 60 + 59)),
    hostId: me(),
    status: 'confirmed',
    light: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    members: [{ id: me(), role: 'host', state: 'joined' }],
    locations: {},
    meeting: meetingAtSpot(area.id, 'chosen', { times: {}, worstMinutes: null, approximate: false }),
    spots: emptySpots(),
    prefs: {},
    deletedSlots: [],
    options: {},
    votes: {},
    plan: { stops: [], modes: [], startAt: from },
    proposals: [],
    banner: null,
    replan: null,
    photos: [],
    radius: null,
  }
  db.sessions.push(session)
  return touch(session, 'session')
}

// ── Replacing one stop of a confirmed plan ─────────────────────────────────
// Replace on the itinerary opens the voting page for one stop: the other places that fit that stop, at the time the
// stop has in the itinerary now (after any moves), ranked by the planner. The places the group voted on are among them,
// with their votes. Choosing one puts it in the stop's place; the stop keeps its start and length, and the plan stays
// confirmed: nobody votes again. Only the host may, like the rain swap; a member who wants another stop proposes one.
// The places can be of another category than the stop's (Activity instead of Drink): the stop then becomes that
// category, at the same time. A place already in the plan as another stop is never offered.

// The stop with this slot id in a confirmed plan, and the slot to rank for it: `category` (the stop's own when left
// out), and the time and length the stop has in the itinerary as it stands. Throws when the stop is gone, or for a
// category that does not exist.
// How to call: stopSlot(session, 'drink', 'activity') -> { index, stop, slot: { id, category, start, time, duration }, isLast, count }
function stopSlot(session, slotId, category) {
  const { stops } = planOf(session)
  const index = stops.findIndex((s) => s.slotId === slotId)
  if (index < 0) throw new Error('This stop is no longer in the plan.')
  const stop = stops[index]
  const kind = category || stop.category
  if (!P.CATEGORIES.includes(kind)) throw new Error('Choose Eat, Drink, Shop or Activity.')
  const timed = timedStops(session)[index]
  return { index, stop, slot: { ...slotOfStop(timed), category: kind }, isLast: index === stops.length - 1, count: stops.length }
}

// What could go in a confirmed stop's place: { stop, category, stopCount, options }. `stop` is the stop as the itinerary
// shows it ({ slotId, category, venue, start, time, duration }); `category` is the one the places are of (the stop's own
// when left out); `stopCount` is how many stops the plan has; `options` are the places of that category that fit the
// stop's time on its day, shaped like the voting page's options (with the weather it kept) and best first, each with the
// votes the group gave it in that category (0 for a place nobody voted on). Only the host. Throws unless the plan is
// confirmed and has this stop.
// How to call: const { stop, options } = await replaceChoices('s1', 'drink', 'activity')
// What could take a confirmed stop's place on the server: its own ranking for the stop's time on its day (every place the group voted on in
// that category among them, with its votes), as cards. The people who voted for a place are not named here, only how many did.
// How to call: await replaceChoicesOnServer('3b1f...', 'drink', 'activity')
async function replaceChoicesOnServer(id, slotId, category) {
  const session = await planSession(id)
  if (session.hostId !== me()) throw new Error('Only the host can replace a stop.')
  if (session.status !== 'confirmed') throw new Error('Only a confirmed plan can have a stop replaced.')
  const { stop, slot, count } = stopSlot(session, slotId, category)
  const answer = await remote.stopChoices(id, stop.stopId, { category: slot.category })
  await ensureVenues(answer.options.map((o) => o.venueId))
  const area = areaById(session.meeting.areaId)
  const options = answer.options.flatMap((o) => {
    const venue = serverVenues.get(o.venueId)
    if (!venue) return []
    const d = o.details && typeof o.details === 'object' ? o.details : {}
    const weather = weatherFrom(d.weather)
    return [{
      id: o.venueId,
      venue: clone(venue),
      score: Number(o.score) || 0,
      walk: d.walkMinutes ?? P.walkMinutes(area, venue),
      distanceM: Math.round(P.distanceKm(area, venue) * 1000),
      reasons: d.reasons ?? [],
      warnings: d.warnings ?? [],
      votes: Number(o.votes) || 0,
      voters: [],
      swap: null,
      explanation: d.explanation ?? '',
      dietUnknown: [],
      verify: [],
      checkNeeds: d.checkNeeds === true,
      approximate: !!d.approximate,
      ...(weather ? { weather } : {}),
    }]
  })
  options.sort((a, b) => b.votes - a.votes || a.score - b.score)
  return { stop: { slotId, category: stop.category, venue: clone(venueById(stop.venueId)), start: slot.start, time: slot.time, duration: stop.duration }, category: answer.category, stopCount: count, options }
}

export async function replaceChoices(id, slotId, category) {
  if (onServer()) return replaceChoicesOnServer(id, slotId, category)
  await wait(DELAY.plan)
  const session = sessionById(id)
  if (session.hostId !== me()) throw new Error('Only the host can replace a stop.')
  if (session.status !== 'confirmed') throw new Error('Only a confirmed plan can have a stop replaced.')
  const { stop, slot, isLast, count } = stopSlot(session, slotId, category)
  // The places the group voted on in that category, kept from voting.
  const voted = session.options[slot.category] || []
  const ranked = await rankSlot({ ...session, date: stopDay(session) }, slot, isLast ? [slot] : [], voted)
  if (session.status !== 'confirmed') throw new Error('Only a confirmed plan can have a stop replaced.')
  const area = areaById(session.meeting.areaId)
  const votes = session.votes[slot.category] || {}
  const counts = P.tally(votes)
  // Not the stop's own place, nor a place another stop already has.
  const seen = new Set(session.plan.stops.map((s) => s.venueId))
  const options = []
  for (const o of [...ranked.current, ...ranked.options]) {
    if (seen.has(o.venue.id)) continue
    seen.add(o.venue.id)
    options.push({
      id: o.venue.id,
      venue: clone(o.venue),
      score: o.score,
      walk: o.walk,
      distanceM: Math.round(P.distanceKm(area, o.venue) * 1000),
      reasons: o.reasons,
      warnings: o.warnings,
      votes: counts[o.venue.id] || 0,
      voters: Object.keys(votes).filter((p) => votes[p] === o.venue.id).map((pid) => ({ id: pid, name: nameOf(pid) })),
      // A rain swap belongs to voting; here the place is chosen outright.
      swap: null,
      explanation: o.explanation,
      dietUnknown: o.dietUnknown,
      verify: o.verify,
      approximate: o.approximate,
      // The weather at the stop's time, which the card's rain mark reads: without it an indoor place would be marked as outdoor in rain.
      ...(o.weather ? { weather: o.weather } : {}),
    })
  }
  // Places the group voted for first (most votes first), then the planner's order (its score is a penalty).
  options.sort((a, b) => b.votes - a.votes || a.score - b.score)
  return {
    stop: { slotId, category: stop.category, venue: clone(venueById(stop.venueId)), start: slot.start, time: slot.time, duration: stop.duration },
    category: slot.category,
    stopCount: count,
    options,
  }
}

// Put `venueId` in the place of a confirmed stop, as a place of `category` (the stop's own when left out; another one
// turns the stop into that category). Only the host. The planner is asked first whether it still fits the stop's time on its
// day; when it does not, nothing changes and this throws. A place another stop already has is refused. `seenId` is the place
// the caller saw in the stop (the stop's own when left out): a stop that holds another place by then is refused. The
// stop keeps its start and length (see changeStopPlace).
// How to call: await replaceStop('s1', 'drink', 'cdc_560160', 'activity', 'cdc_100001')
export async function replaceStop(id, slotId, venueId, category, seenId) {
  if (!onServer()) await wait(DELAY.write)
  const session = onServer() ? await planSession(id) : sessionById(id)
  const isLast = session.plan?.stops.at(-1)?.slotId === slotId
  return changeStopPlace(session, slotId, venueId, { fromId: seenId, category, last: isLast, verb: 'replace' })
}

// After Confirmed, a change asks "Re-plan?". Accepting returns the session to Voting; declining keeps the plan.
export async function respondReplan(id, accept) {
  // On the server the question is the host's to answer: re-planning takes the plan back to voting, and "keep the plan" only turns it off.
  if (onServer()) {
    await remote.replan(id, !!accept)
    return afterServerWrite(id, 'session')
  }
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
  if (onServer()) {
    await remote.replan(id, true)
    return afterServerWrite(id, 'session')
  }
  await wait(DELAY.write)
  const session = sessionById(id)
  return orUndo(session, async () => {
    await reopenVoting(session, null)
    return touch(session, 'session')
  })
}

async function reopenVoting(session, trigger) {
  const previous = session.meeting
  const { meeting: next, pinnedSpot } = await computeMeeting(session)
  session.status = 'voting'
  session.plan = null
  clearProposals(session)
  delete session.confirmedRanking
  delete session.weatherDismissed
  session.meeting = next
  if (pinnedSpot) refreshSpot(session, pinnedSpot)
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

// On the server only the host ends the outing, and the server writes everyone's travel ledger row (getLedger). No coins are paid: JioCoins
// are kept in each browser, and a finished outing cannot pay the people who are not in this one.
export async function endPlan(id) {
  if (onServer()) {
    await remote.complete(id)
    return afterServerWrite(id, 'session')
  }
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.status === 'completed') throw new Error('This outing has already finished.')
  if (session.status !== 'confirmed') throw new Error('Only a confirmed plan can be ended.')
  if (completeOuting(session, 'hand')) emit({ type: 'stats' })
  return touch(session, 'session')
}

// The signed-in person's own travel ledger row for a finished outing on the server: { minutesIn, minutesBetween, minutesHome, total, delta }
// (`delta` is minutes more than the group's average, or fewer when negative), or null while there is none (the outing is not finished, or the
// server wrote none). A local outing keeps no ledger: null. Their row only, whatever else the rules let them read.
// How to call: const ledger = await getLedger('3b1f...')
export async function getLedger(id) {
  if (!onServer()) return null
  const asked = epoch
  const row = await remote.myLedger(id)
  return asked === epoch ? row : null
}

// Completes an outing. `how` is kept as `endedBy`: 'hand' ("Finish outing"), 'auto' (its end time passed) or 'closed' (two days
// past its end with no confirmed plan). A confirmed plan pays every member who is in it, but only when at least two people are
// (lib/session.js earnsCoins): an outing of one is a way to find places, not a way to earn coins, so it can be repeated for
// nothing. A closed one pays nobody, and counts for nobody's Jio streak. The session keeps `paid` (whether coins were paid) so
// its page can say why none were. Saves nothing itself: the caller saves. Answers whether coins were paid.
// How to call: if (completeOuting(session, 'auto')) emit({ type: 'stats' })
function completeOuting(session, how) {
  const people = activeIds(session)
  const paid = session.status === 'confirmed' && earnsCoins(people.length)
  // A season that ran out before today closes first, so these points count for the season they were earned in.
  catchUpSeasons()
  session.status = 'completed'
  session.completedAt = Date.now()
  session.endedBy = how
  session.paid = paid
  session.replan = null
  clearProposals(session)
  if (!paid) return false
  for (const personId of people) {
    const stats = statsOf(personId)
    stats.meetups += 1
    stats.points += POINTS_PER_MEETUP
    stats.seasonPoints += POINTS_PER_MEETUP
  }
  return true
}

// Finishes every confirmed outing whose end time has passed, and closes every other one two days past its end
// (lib/session.js dueEnding). Run when the list or one session is read, so an outing finishes without anyone pressing "Finish
// outing" even when nobody had the app open at the time. A cancelled or completed session is never touched. Nothing is written
// unless something is due, and then the newer save of another tab is taken up first (adoptNewerSave) and what is due is worked
// out again against it, so a read never saves an old state over a newer one. It is part of a read, so a save that fails (the
// storage is full) keeps the change in memory instead of failing the read; the next write saves it.
// How to call: settleOutings()
function settleOutings(now = new Date()) {
  if (!db.sessions.some((s) => dueEnding(s, now))) return
  const before = stored
  if (!adoptNewerSave()) return
  const adopted = stored !== before
  let changed = false
  let paid = false
  for (const session of db.sessions) {
    const due = dueEnding(session, now)
    if (!due) continue
    // An invite whose time has passed counts as accepted, so the people paid are the people who joined.
    settleInvites(session)
    if (completeOuting(session, due === 'finish' ? 'auto' : 'closed')) paid = true
    session.updatedAt = Date.now()
    commits[session.id] = commitsOf(session) + 1
    changed = true
  }
  if (changed) save()
  if (paid || adopted) broadcast({ type: 'stats' })
}

// ── Photos: everyone in a session can post pictures from the day ────────────

// Everyone in a session can post up to PHOTOS_MAX pictures, from the outing's day on (not before, and none on a session on the
// server). src is a data URL (see image.js).
// How to call: await addPhoto('s1', 'ian', 'data:image/jpeg;base64,...')
export async function addPhoto(id, personId, src) {
  // Photos are not on the server yet: they would need their own private storage (the design leaves them out), so a session of the server says so.
  if (onServer() && !db.sessions.some((s) => s.id === id)) throw new Error(SHARING_WORDS.photosLater)
  await wait(DELAY.write)
  requireMe(personId)
  const session = sessionById(id)
  if (!['confirmed', 'completed'].includes(session.status)) throw new Error('Photos open once the plan is confirmed.')
  // From the outing's day on, for every member; a typed address gets no further than the screen's own check.
  if (!photosOpen({ date: session.date, isToday: isSessionDay(session) })) throw new Error(PHOTOS_BEFORE_DAY)
  // An outing that closed by itself never had a plan, so there was no outing to take pictures of.
  if (session.endedBy === 'closed') throw new Error('This outing closed without a plan, so it has no photos.')
  if ((session.photos || []).length >= PHOTOS_MAX) throw new Error(`A session holds up to ${PHOTOS_MAX} photos. Delete one to add another.`)
  session.photos = [...(session.photos || []), { id: `p${db.seq++}`, personId, src, at: Date.now() }]
  // One save: if storage is full it puts the photo back and this rejects.
  return touch(session, 'photos')
}

// The pictures of a session, oldest first, each with the poster's name. `latest` keeps only the newest few
// (the strip on the session and the card thumbnails). A session summary has only photoCount.
// How to call: await getPhotos('s1') or await getPhotos('s1', { latest: 4 })
export async function getPhotos(id, { latest } = {}) {
  if (onServer() && !db.sessions.some((s) => s.id === id)) return []
  await wait(DELAY.read)
  const photos = sessionById(id).photos || []
  return (latest ? photos.slice(-latest) : photos).map((p) => ({ ...p, name: nameOf(p.personId) }))
}

export async function deletePhoto(id, photoId) {
  if (onServer() && !db.sessions.some((s) => s.id === id)) throw new Error(SHARING_WORDS.photosLater)
  await wait(DELAY.write)
  const session = sessionById(id)
  session.photos = (session.photos || []).filter((p) => p.id !== photoId)
  return touch(session, 'photos')
}

// ── Reviews: each person gives a finished outing stars ──────────────────────

// The longest note a review may carry.
export const REVIEW_NOTE_MAX = 280

// Saves the signed-in person's review of a finished outing: `stars` for the outing (1 to 5), `stops` with stars for any stop
// ({ <slotId>: 1 to 5 }, each optional), and an optional `note`. Saving again replaces their review. Kept in the session as
// `reviews[personId]`, so every member's screen can read it. A shared outing has none yet: like photos, it would need a table of
// its own on the server, a later update.
// How to call: await saveReview('s1', 'ian', { stars: 5, stops: { eat: 4 }, note: 'Great laksa' })
export async function saveReview(id, personId, { stars, stops = {}, note = '' } = {}) {
  if (onServer() && !db.sessions.some((s) => s.id === id)) throw new Error(SHARING_WORDS.reviewsLater)
  await wait(DELAY.write)
  requireMe(personId)
  const session = sessionById(id)
  if (session.status !== 'completed') throw new Error('An outing can be reviewed once it has finished.')
  if (session.endedBy === 'closed') throw new Error('This outing closed without a plan, so there is nothing to review.')
  if (!activeIds(session).includes(personId)) throw new Error('Only the people who went can review this outing.')
  const whole = (n) => Number.isInteger(n) && n >= 1 && n <= 5
  if (!whole(stars)) throw new Error('Give the outing 1 to 5 stars.')
  const slotIds = new Set((session.plan?.stops || []).map((s) => s.slotId))
  const stopStars = Object.fromEntries(Object.entries(stops || {}).filter(([slotId, n]) => slotIds.has(slotId) && whole(n)))
  const text = String(note ?? '').trim()
  if (text.length > REVIEW_NOTE_MAX) throw new Error(`A note can be at most ${REVIEW_NOTE_MAX} characters.`)
  session.reviews = { ...(session.reviews || {}), [personId]: { stars, stops: stopStars, note: text, at: Date.now() } }
  return touch(session, 'session')
}

// ── Rewards ────────────────────────────────────────────────────────────────

export async function listRewards() {
  await wait(DELAY.read)
  return clone(REWARDS)
}

// Every voucher the signed-in person claimed, newest first, each with its reward and its last day (`validUntil`, worked out from
// the claim for a voucher claimed before claims carried one). `usedAt` is there once it was marked as used.
// How to call: await listRedemptions() -> [{ id: 'v3', code: 'JIO-AB12-CD34', at, validUntil: '2026-11-29', reward }]
export async function listRedemptions() {
  await wait(DELAY.read)
  return clone(db.redemptions).map((r) => ({ ...r, validUntil: validUntilOf(r), reward: REWARDS.find((x) => x.id === r.rewardId) }))
}

// Marks a claimed voucher as used, today. Refused when it is already used or past its last day.
// How to call: await markVoucherUsed('v3') -> { id: 'v3', usedAt: 1793325600000, ... }
export async function markVoucherUsed(redemptionId) {
  await wait(DELAY.write)
  requireMe()
  const redemption = db.redemptions.find((r) => r.id === redemptionId)
  if (!redemption) throw new Error('This voucher is not one of yours.')
  const state = voucherState(redemption)
  if (state === 'used') throw new Error('This voucher is already marked as used.')
  if (state === 'expired') throw new Error(`This voucher expired: it was valid until ${dayLabel(validUntilOf(redemption))}.`)
  redemption.usedAt = Date.now()
  emit({ type: 'stats' })
  return { ...clone(redemption), validUntil: validUntilOf(redemption), reward: clone(REWARDS.find((x) => x.id === redemption.rewardId)) }
}

export async function redeemReward(rewardId) {
  await wait(DELAY.write)
  const reward = REWARDS.find((r) => r.id === rewardId)
  const stats = statsOf(requireMe())
  if (!reward) throw new Error('This voucher does not exist.')
  if (stats.points < reward.cost) throw new Error(`You need ${coins(reward.cost - stats.points)} more for this voucher.`)
  stats.points -= reward.cost
  const code = `JIO-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  const now = Date.now()
  // The last day it can be used goes in with the claim (lib/vouchers.js says how long).
  const redemption = { id: `v${db.seq++}`, rewardId, code, at: now, validUntil: voucherValidUntil(now) }
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
    for (const session of db.sessions.filter((s) => s.status === 'locating')) {
      // A session the host confirmed a spot for while an earlier one was worked out is not asked about: its area stays.
      if (session.status !== 'locating') continue
      await latestAnswer(session, () => computeMeeting(session), ({ meeting, spots }) => {
        session.meeting = meeting
        // The travel times change with routing, and the app's three can too.
        const lost = spots ? applyPlannedSpots(session, spots) : []
        if (lost.length) session.banner = lostApprovalsBanner('Travel times were worked out again.', lost)
      })
    }
  }
  emit({ type: 'conditions' })
  return clone(db.conditions)
}

// Reset sessions, points and conditions. The account stays signed in.
export async function resetDemo() {
  db = freshDb({ user: db.user, friends: db.friends })
  emit({ type: 'reset' })
}
