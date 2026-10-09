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
import { HOST_ID, PAST_ACTIVITY, PEOPLE, POINTS_PER_MEETUP, STARTING_MEETUPS } from './mock/people.js'
import { REWARDS } from './mock/rewards.js'
import { pastMeetupDates } from './mock/history.js'
import { reviewsFor } from './mock/reviews.js'
import * as Season from './season.js'
import * as P from './planner/index.js'
import * as planner from './plannerApi.js'
import { format } from 'date-fns'

export { api } from './plannerApi.js'

const STORAGE_KEY = 'jio-demo-v1'
// 5: the backend planner (db.venues) and photos, itinerary order and seasons. Older saves start fresh.
const VERSION = 5
// How many ranked places to ask for per slot: enough to top a slot up to its maximum.
const RANKED_MAX = 10
// meeting: the least time the "finding the meeting point" animation shows. The planner answers in milliseconds
// with estimated travel times; with real routing it takes longer on its own.
const DELAY = { read: 80, plan: 300, write: 40, meeting: 700 }

// ── Storage ────────────────────────────────────────────────────────────────

// The leaderboard season now, and how many points each person earned in it so far: their past meetups since
// the season began (the same dates as their profile graph).
function freshSeason(now = new Date()) {
  const season = { number: 1, ...Season.quarterOf(now) }
  const since = format(new Date(season.startsAt), 'yyyy-MM-dd')
  const earned = (id) => pastMeetupDates(id, STARTING_MEETUPS[id], now).filter((d) => d >= since).length * POINTS_PER_MEETUP
  return { season, earned }
}

function freshDb(keep = {}) {
  const { season, earned } = freshSeason()
  return {
    version: VERSION,
    user: keep.user || null,
    friends: keep.friends || [],
    sessions: [],
    // points: what each person can spend. seasonPoints: what they earned this season, for the leaderboard.
    stats: Object.fromEntries(PEOPLE.map((p) => [p.id, { meetups: STARTING_MEETUPS[p.id], points: STARTING_MEETUPS[p.id] * POINTS_PER_MEETUP, seasonPoints: earned(p.id) }])),
    season,
    // Past seasons, latest first: { number, startsAt, endsAt, winners: [{ id, seasonPoints }], prize }.
    pastSeasons: [],
    redemptions: [],
    conditions: { rain: false, crowd: false, routing: true, sessionDay: false },
    // Every venue the planner has sent, by id. Suggestions can be any of the backend's venues, not only VENUES.
    venues: {},
    seq: 1,
  }
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
    if (saved && saved.version === VERSION) return saved
    // An older save: its sessions point at venues this version cannot look up. Keep the account, start fresh.
    if (saved && saved.version < VERSION) return freshDb({ user: saved.user, friends: saved.friends })
  } catch {
    // No storage, or something unreadable: start fresh.
  }
  return freshDb()
}

let db = load()
const listeners = new Set()

// Returns false when storage refuses the write (full, or a private window). The demo still works for this visit.
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
    return true
  } catch {
    return false
  }
}

function emit(event) {
  save()
  for (const fn of listeners) fn(event)
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
const areaById = (id) => AREAS.find((a) => a.id === id)
const venueById = (id) => db.venues[id] || VENUES.find((v) => v.id === id)

function nameOf(id) {
  if (id === HOST_ID && db.user) return db.user.name
  return personById(id)?.name || ''
}

function sessionById(id) {
  const session = db.sessions.find((s) => s.id === id)
  if (!session) throw new Error('This session does not exist.')
  return session
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
  emit({ type: 'pending', sessionId: session.id })
  let data
  try {
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

function slotsOf(session) {
  return P.buildSlots({ prefs: activePrefs(session), ...windowOf(session), deleted: session.deletedSlots })
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
  const rankings = await rankAll(session, slots)
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
  if (outcome.clearVotes) session.votes = {}
  if (outcome.refreshSuggestions) session.options = {}
  await syncOptions(session)
  if (outcome.banner) session.banner = { text: outcome.banner, at: Date.now() }
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
    emit({ type: 'pending', sessionId: session.id })
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

// The account, with its home area's name.
function account() {
  if (!db.user) return null
  return { ...clone(db.user), homeAreaName: areaById(db.user.homeAreaId)?.name || '' }
}

export async function getUser() {
  await wait(DELAY.read)
  return account()
}

export async function signUp(profile) {
  await wait(DELAY.write)
  // The real app creates a Supabase account here. The demo account is always the host, Ian's id.
  db.user = {
    id: HOST_ID,
    email: profile.email,
    name: profile.name,
    username: profile.username,
    photo: profile.photo || '',
    homeAreaId: profile.homeAreaId,
    permissions: { location: !!profile.locationAllowed, contacts: !!profile.contactsAllowed },
  }
  db.friends = [...(profile.friends || [])]
  emit({ type: 'user' })
  return account()
}

export async function updateUser(patch) {
  await wait(DELAY.write)
  db.user = { ...db.user, ...patch }
  emit({ type: 'user' })
  return account()
}

export async function signOut() {
  await wait(DELAY.write)
  db = freshDb()
  emit({ type: 'reset' })
}

export async function checkUsername(username) {
  await wait(DELAY.read)
  const taken = PEOPLE.some((p) => p.id !== HOST_ID && p.username === username.toLowerCase())
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
  for (const date of pastMeetupDates(id, STARTING_MEETUPS[id])) counts[date] = (counts[date] || 0) + 1
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

// End the current season at `at`: the winners get the prize to spend, then season points start again.
function closeSeason(at) {
  const ended = { ...db.season, endsAt: at }
  const winners = Season.seasonWinners(PEOPLE.map((p) => ({ id: p.id, seasonPoints: db.stats[p.id].seasonPoints })))
  for (const id of winners) db.stats[id].points += Season.SEASON_PRIZE
  // standings: everyone's season total, so the leaderboard can show a past season in full.
  const standings = PEOPLE.map((p) => ({ id: p.id, seasonPoints: db.stats[p.id].seasonPoints }))
  db.pastSeasons.unshift({ ...ended, prize: Season.SEASON_PRIZE, winners: winners.map((id) => ({ id, seasonPoints: db.stats[id].seasonPoints })), standings })
  for (const p of PEOPLE) db.stats[p.id].seasonPoints = 0
  db.season = Season.nextSeason(db.season, at)
}

// Seasons that ran out while nobody had the app open end now, in order. Returns true when one ended.
function catchUpSeasons(now = Date.now()) {
  let ended = false
  while (now >= db.season.endsAt) {
    closeSeason(db.season.endsAt)
    ended = true
  }
  if (ended) save()
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
export async function endSeason() {
  await wait(DELAY.write)
  closeSeason(Date.now())
  emit({ type: 'stats' })
  return publicSeason(db.pastSeasons[0])
}

// One ranking: points earned this season. Ties share a rank.
export async function getLeaderboard() {
  await wait(DELAY.read)
  if (catchUpSeasons()) emit({ type: 'stats' })
  return ranked(PEOPLE.map((p) => ({ id: p.id, seasonPoints: db.stats[p.id].seasonPoints })))
}

// A past season's final ranking, the same shape as getLeaderboard. [] for a season with no standings kept.
export async function getSeasonStandings(number) {
  await wait(DELAY.read)
  const past = db.pastSeasons.find((s) => s.number === number)
  return past?.standings ? ranked(past.standings) : []
}

// rows: [{ id, seasonPoints }], ranked highest first. Ties share a rank; within a tie, whoever has more meetups
// overall is listed first, then by name. seasonMeetups: meetups finished this season. Season JioCoins only come
// from finished meetups, so it is always seasonPoints / POINTS_PER_MEETUP and the two never disagree.
function ranked(rows) {
  const sorted = rows
    .map((r) => ({ ...publicPerson(r.id), seasonPoints: r.seasonPoints, seasonMeetups: Math.round(r.seasonPoints / POINTS_PER_MEETUP) }))
    .sort((a, b) => b.seasonPoints - a.seasonPoints || b.meetups - a.meetups || a.name.localeCompare(b.name))
  let rank = 0
  let last = null
  return sorted.map((row, i) => {
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

function summary(session) {
  const slots = session.status === 'voting' && session.meeting ? slotsOf(session) : []
  const area = session.meeting ? areaById(session.meeting.areaId) : null
  return {
    ...clone(session),
    locations: publicLocations(session),
    area: area ? { ...area } : null,
    photos: (session.photos || []).map((p) => ({ ...p, name: nameOf(p.personId) })),
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
  return db.sessions.map(summary).sort((a, b) => b.createdAt - a.createdAt)
}

export async function getSession(id) {
  await wait(DELAY.read)
  return summary(sessionById(id))
}

export async function createSession({ title, date, start, end }) {
  await wait(DELAY.write)
  const session = {
    id: `s${db.seq++}`,
    title: title.trim(),
    date,
    start,
    end,
    hostId: HOST_ID,
    status: 'inviting',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    members: [{ id: HOST_ID, role: 'host', state: 'joined' }],
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

// Invited friends accept automatically: they already have the app.
export async function inviteFriends(id, personIds) {
  await wait(DELAY.write)
  const session = sessionById(id)
  for (const personId of personIds) {
    const member = session.members.find((m) => m.id === personId)
    if (member) member.state = 'joined'
    else session.members.push({ id: personId, role: 'guest', state: 'joined' })
  }
  return touch(session, 'session')
}

export async function startSession(id) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (activeIds(session).length < 2) throw new Error('A session needs at least 2 people.')
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
  const ranked = await rankSlot(session, slot, slots)
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
    lastStop: slots[slots.length - 1]?.id === slotId,
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
  const ranked = await rankSlot(session, slot, slots, [...options, venueId])
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

// One vote per person per slot. Voting again in the same slot changes the vote.
export async function vote(id, slotId, personId, venueId) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.status !== 'voting') throw new Error('Votes are read-only once the plan is confirmed.')
  if (!(session.options[slotId] || []).includes(venueId)) throw new Error('That place is no longer an option.')
  session.votes[slotId] = { ...(session.votes[slotId] || {}), [personId]: venueId }
  return touch(session, 'vote')
}

// Everything the voting screen needs, ranked with the current weather and crowd.
export async function getPlan(id) {
  await wait(DELAY.plan)
  const session = sessionById(id)
  const ids = activeIds(session)
  if (!session.meeting || !['voting', 'confirmed', 'completed'].includes(session.status)) {
    return { slots: [], voters: [], prefs: clone(session.prefs), counts: P.categoryCounts(activePrefs(session)), stayUntil: null }
  }
  const slots = slotsOf(session)
  const area = areaById(session.meeting.areaId)
  const rankings = await rankAll(session, slots)
  const view = slots.map((slot, i) => {
    const ranked = rankings[i]
    const byId = Object.fromEntries([...ranked.options, ...ranked.current].map((o) => [o.venue.id, o]))
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
          crowd: o.crowd,
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
      canAddMore: options.length < P.OPTIONS_MAX && rankedIds(ranked).length > options.length,
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
  }
}

// ── Step 7 and after: confirm, the itinerary, the day itself ───────────────

export async function confirmPlan(id) {
  await wait(DELAY.plan)
  const session = sessionById(id)
  const ids = activeIds(session)
  if (session.status !== 'voting') throw new Error('Only a session in Voting can be confirmed.')
  if (!P.canConfirm(session.votes, ids)) throw new Error('At least 2 people need to vote first.')
  const slots = slotsOf(session)
  const rankings = await rankAll(session, slots)
  if (session.status !== 'voting') throw new Error('Only a session in Voting can be confirmed.')
  const stops = []
  slots.forEach((slot, i) => {
    // pickWinner breaks a tie on the higher score. The planner's score is a penalty, so flip it.
    const scores = Object.fromEntries([...rankings[i].options, ...rankings[i].current].map((o) => [o.venue.id, -o.score]))
    const winner = P.pickWinner(session.options[slot.id] || [], session.votes[slot.id], scores)
    if (winner) stops.push({ slotId: slot.id, category: slot.category, venueId: winner, plannedStart: slot.start, duration: slot.duration })
  })
  session.plan = { stops, modes: [], startAt: stops[0]?.plannedStart ?? null }
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
    area: area ? { ...area } : null,
    starts: activeIds(session)
      .filter((pid) => session.locations[pid]?.start)
      .map((pid) => ({ id: pid, name: nameOf(pid), area: { ...areaById(session.locations[pid].start.areaId) } })),
  }
}

export async function setTravelMode(id, legIndex, mode) {
  await wait(DELAY.write)
  const session = sessionById(id)
  const modes = [...(session.plan.modes || [])]
  modes[legIndex] = mode
  session.plan.modes = modes
  return touch(session, 'plan')
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
  session.plan.stops = P.moveItem(stops, from, to)
  session.plan.modes = []
  return touch(session, 'plan')
}

export async function deleteStop(id, index) {
  await wait(DELAY.write)
  const session = sessionById(id)
  const { stops, modes = [] } = session.plan
  if (stops.length <= 1) throw new Error('A plan needs at least one stop.')
  session.plan.stops = stops.filter((_, i) => i !== index)
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
  session.meeting = next
  const moved = (previous?.areaId ?? null) !== (next?.areaId ?? null)
  if (moved) {
    session.votes = {}
    session.options = {}
  }
  await syncOptions(session)
  session.banner = trigger
    ? {
        text: P.recalcBanner({ previousName: previous ? areaById(previous.areaId).name : null, nextName: next ? areaById(next.areaId).name : null, trigger }),
        at: Date.now(),
      }
    : null
}

export async function endPlan(id) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (session.status !== 'confirmed') throw new Error('Only a confirmed plan can be ended.')
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

export async function addPhoto(id, personId, src) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (!['confirmed', 'completed'].includes(session.status)) throw new Error('Photos open once the plan is confirmed.')
  session.photos = [...(session.photos || []), { id: `p${db.seq++}`, personId, src, at: Date.now() }]
  if (!save()) {
    // Local storage is full: drop the new photo so the rest of the demo keeps saving.
    session.photos.pop()
    throw new Error('There is no room left for more photos in this demo.')
  }
  return touch(session, 'photos')
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

// ── Demo conditions (weather, crowd, routing, the session day) ─────────────

export async function getConditions() {
  return clone(db.conditions)
}

export async function setConditions(patch) {
  db.conditions = { ...db.conditions, ...patch }
  // Routing changes how the meeting area is found, so sessions still locating are re-calculated.
  if ('routing' in patch) {
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
