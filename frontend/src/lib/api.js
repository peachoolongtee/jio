// Every read and write in the app goes through this file.
//
// For now it is a mock backend: the data lives in memory (and in localStorage, so a reload keeps the demo),
// and the planner rules from lib/planner run here, the way the Express planner will run them on the server.
// When Supabase and the backend exist, replace the bodies of these functions; the screens and stores do not change.
//
// Every function is async, like a network call. Writes notify subscribers, the way Supabase live updates will.
import { ADDRESSES, AREAS } from './mock/places.js'
import { VENUES } from './mock/venues.js'
import { HOST_ID, PAST_ACTIVITY, PEOPLE, POINTS_PER_MEETUP, STARTING_MEETUPS } from './mock/people.js'
import { REWARDS } from './mock/rewards.js'
import * as P from './planner/index.js'
import { format } from 'date-fns'
import axios from 'axios'

// Calls to the Jio backend (planner, geocode and weather proxy).
// Attaching the Supabase session token waits on the JWT verification decision.
// The mock functions below move onto this client as the backend endpoints land.
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  timeout: 15000,
})

const STORAGE_KEY = 'jio-demo-v1'
const VERSION = 3
const DELAY = { read: 80, plan: 300, write: 40 }

// ── Storage ────────────────────────────────────────────────────────────────

function freshDb(keep = {}) {
  return {
    version: VERSION,
    user: keep.user || null,
    friends: keep.friends || [],
    sessions: [],
    stats: Object.fromEntries(PEOPLE.map((p) => [p.id, { meetups: STARTING_MEETUPS[p.id], points: STARTING_MEETUPS[p.id] * POINTS_PER_MEETUP }])),
    redemptions: [],
    conditions: { rain: false, crowd: false, routing: true, sessionDay: false },
    seq: 1,
  }
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
    if (saved && saved.version === VERSION) return saved
  } catch {
    // No storage, or something unreadable: start fresh.
  }
  return freshDb()
}

let db = load()
const listeners = new Set()

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  } catch {
    // Private windows can refuse storage. The demo still works for this visit.
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
const venueById = (id) => VENUES.find((v) => v.id === id)

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

// ── Planner, run on the "server" ───────────────────────────────────────────

function origins(session) {
  return activeIds(session)
    .filter((id) => session.locations[id]?.start)
    .map((id) => {
      const { lat, lng } = areaById(session.locations[id].start.areaId)
      return { id, lat, lng }
    })
}

function computeMeeting(session) {
  return P.chooseMeetingArea({ origins: origins(session), candidates: AREAS, routing: db.conditions.routing })
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

function homes(session) {
  return activeIds(session)
    .map((id) => ({ id, name: nameOf(id), place: endPlaceOf(session, id) }))
    .filter((h) => h.place)
    .map((h) => ({ id: h.id, name: h.name, lat: h.place.lat, lng: h.place.lng }))
}

function rankSlot(session, slot, slots) {
  const area = areaById(session.meeting.areaId)
  const isLast = slots[slots.length - 1]?.id === slot.id
  return P.rankForSlot(VENUES, { slot, area, isLast, conditions: db.conditions, homes: homes(session) })
}

// Keep the options in step with the current slots: drop options that no longer fit, top up to three,
// and drop votes for options or people that are gone.
function syncOptions(session) {
  if (!session.meeting || !['voting'].includes(session.status)) return
  const slots = slotsOf(session)
  const ids = activeIds(session)
  const nextOptions = {}
  const nextVotes = {}
  for (const slot of slots) {
    const ranked = rankSlot(session, slot, slots).options.map((o) => o.venue.id)
    nextOptions[slot.id] = P.reconcileOptions(session.options[slot.id], ranked)
    const votes = session.votes[slot.id] || {}
    nextVotes[slot.id] = Object.fromEntries(Object.entries(votes).filter(([person, venue]) => ids.includes(person) && nextOptions[slot.id].includes(venue)))
  }
  session.options = nextOptions
  session.votes = nextVotes
}

// A start or end location changed, a late location arrived, or someone opted out.
function applyTrigger(session, trigger) {
  const previous = session.meeting
  const next = computeMeeting(session)
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
  syncOptions(session)
  if (outcome.banner) session.banner = { text: outcome.banner, at: Date.now() }
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
  ].sort((a, b) => b.date.localeCompare(a.date))
  return { ...publicPerson(id), sessions, activity }
}

export async function setFriend(id, isFriend) {
  await wait(DELAY.write)
  db.friends = isFriend ? [...new Set([...db.friends, id])] : db.friends.filter((f) => f !== id)
  emit({ type: 'friends' })
  return [...db.friends]
}

// One ranking: successful meetups. Ties share a rank.
export async function getLeaderboard() {
  await wait(DELAY.read)
  const rows = PEOPLE.map((p) => publicPerson(p.id)).sort((a, b) => b.meetups - a.meetups || (a.id === HOST_ID ? -1 : b.id === HOST_ID ? 1 : a.name.localeCompare(b.name)))
  let rank = 0
  let last = null
  return rows.map((row, i) => {
    if (row.meetups !== last) {
      rank = i + 1
      last = row.meetups
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
export async function nearbyPlaces(areaId) {
  await wait(DELAY.plan)
  const home = areaById(areaId) || AREAS[0]
  return VENUES.map((v) => ({ ...clone(v), distanceKm: Math.round(P.distanceKm(home, v) * 10) / 10 })).sort((a, b) => a.distanceKm - b.distanceKm)
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
    resultLine: area ? P.meetingResultLine(session.meeting, area.name) : '',
    activeIds: activeIds(session),
    areaName: session.meeting ? areaById(session.meeting.areaId).name : '',
    isToday: isSessionDay(session),
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
  const loc = session.locations[personId] || { start: null, end: null }
  const hadStart = !!loc.start
  loc[which] = place ? { areaId: place.areaId, label: place.label || areaById(place.areaId).name } : null
  session.locations[personId] = loc
  const kind = which === 'end' ? 'end' : hadStart ? 'start' : 'added'
  applyTrigger(session, { kind, personName: nameOf(personId) })
  return touch(session, 'location')
}

export async function useMeetingArea(id) {
  await wait(DELAY.write)
  const session = sessionById(id)
  if (!session.meeting) throw new Error('The meeting area needs at least 2 locations.')
  session.status = 'voting'
  session.banner = null
  syncOptions(session)
  return touch(session, 'session')
}

export async function optOut(id, personId) {
  await wait(DELAY.write)
  const session = sessionById(id)
  const member = session.members.find((m) => m.id === personId)
  if (!member || member.role === 'host') throw new Error('The host cannot opt out.')
  member.state = 'opted_out'
  applyTrigger(session, { kind: 'optout', personName: nameOf(personId) })
  syncOptions(session)
  return touch(session, 'optout')
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
  session.prefs[personId] = { categories: [...prefs.categories], until: prefs.until ?? null }
  syncOptions(session)
  return touch(session, 'prefs')
}

export async function deleteSlot(id, slotId) {
  await wait(DELAY.write)
  const session = sessionById(id)
  session.deletedSlots = [...new Set([...session.deletedSlots, slotId])]
  delete session.options[slotId]
  delete session.votes[slotId]
  syncOptions(session)
  return touch(session, 'slots')
}

export async function restoreSlots(id) {
  await wait(DELAY.write)
  const session = sessionById(id)
  session.deletedSlots = []
  syncOptions(session)
  return touch(session, 'slots')
}

export async function addMoreOptions(id, slotId) {
  await wait(DELAY.plan)
  const session = sessionById(id)
  const slots = slotsOf(session)
  const slot = slots.find((s) => s.id === slotId)
  const ranked = rankSlot(session, slot, slots).options.map((o) => o.venue.id)
  session.options[slotId] = P.moreOptions(session.options[slotId] || [], ranked)
  return touch(session, 'options')
}

// Search places to add to a slot. Each result says whether it fits, and why not.
export async function searchVenuesForSlot(id, slotId, query) {
  await wait(DELAY.read)
  const session = sessionById(id)
  const slots = slotsOf(session)
  const slot = slots.find((s) => s.id === slotId)
  const isLast = slots[slots.length - 1]?.id === slotId
  const q = query.trim().toLowerCase()
  if (!q || !slot) return []
  const area = areaById(session.meeting.areaId)
  return VENUES.filter((v) => v.name.toLowerCase().includes(q) || v.area.toLowerCase().includes(q))
    .map((v) => ({
      id: v.id,
      name: v.name,
      area: v.area,
      category: v.category,
      walk: P.walkMinutes(area, v),
      // Searched places follow the same rules as suggestions, including staying near the meeting area.
      unfit: P.unfitReason(v, slot, { isLast }) || (P.distanceKm(area, v) > P.WIDE_RADIUS_KM ? 'far' : ''),
      added: (session.options[slotId] || []).includes(v.id),
    }))
    .sort((a, b) => Number(!!a.unfit) - Number(!!b.unfit) || a.walk - b.walk)
    .slice(0, 12)
}

export async function addOption(id, slotId, venueId) {
  await wait(DELAY.write)
  const session = sessionById(id)
  const slots = slotsOf(session)
  const slot = slots.find((s) => s.id === slotId)
  const venue = venueById(venueId)
  const isLast = slots[slots.length - 1]?.id === slotId
  const area = areaById(session.meeting.areaId)
  if (P.unfitReason(venue, slot, { isLast }) || P.distanceKm(area, venue) > P.WIDE_RADIUS_KM) throw new Error(`${venue.name} does not fit this slot.`)
  const options = session.options[slotId] || []
  if (options.length >= P.OPTIONS_MAX) throw new Error('A slot holds up to 6 options.')
  if (!options.includes(venueId)) session.options[slotId] = [...options, venueId]
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
  const view = slots.map((slot) => {
    const ranked = rankSlot(session, slot, slots)
    const byId = Object.fromEntries(ranked.options.map((o) => [o.venue.id, o]))
    const optionIds = (session.options[slot.id] || []).filter((v) => byId[v])
    const votes = session.votes[slot.id] || {}
    const counts = P.tally(votes)
    const options = optionIds
      .map((venueId) => {
        const o = byId[venueId]
        const swap = o.warnings.includes('rain') ? P.indoorSwap(ranked.options, optionIds) : null
        return {
          id: venueId,
          venue: clone(o.venue),
          score: o.score,
          walk: o.walk,
          crowd: o.crowd,
          reasons: o.reasons,
          warnings: o.warnings,
          votes: counts[venueId] || 0,
          voters: Object.keys(votes).filter((p) => votes[p] === venueId).map(nameOf),
          swap: swap ? { id: swap.venue.id, name: swap.venue.name } : null,
        }
      })
      .sort((a, b) => b.score - a.score)
    return {
      ...slot,
      isLast: slots[slots.length - 1].id === slot.id,
      options,
      canAddMore: options.length < P.OPTIONS_MAX && ranked.options.length > options.length,
      widened: ranked.widened,
      leader: P.leader(optionIds, votes),
      totalVotes: Object.keys(votes).length,
      myVote: votes[HOST_ID] || null,
    }
  })
  return {
    area: { ...area },
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
  const stops = []
  for (const slot of slots) {
    const ranked = rankSlot(session, slot, slots).options
    const scores = Object.fromEntries(ranked.map((o) => [o.venue.id, o.score]))
    const winner = P.pickWinner(session.options[slot.id] || [], session.votes[slot.id], scores)
    if (winner) stops.push({ slotId: slot.id, category: slot.category, venueId: winner, plannedStart: slot.start, duration: slot.duration })
  }
  session.plan = { stops, modes: [] }
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
  const { stops: timed, legs } = P.buildItinerary(stops, session.plan.modes)
  const last = timed[timed.length - 1]?.venue || null
  const people = activeIds(session)
    .map((pid) => ({ id: pid, name: nameOf(pid), place: endPlaceOf(session, pid) }))
    .filter((p) => p.place)
    .map((p) => ({ id: p.id, name: p.name, end: { ...p.place } }))
  const area = session.meeting ? areaById(session.meeting.areaId) : null
  return {
    stops: timed.map((s, index) => ({ index, slotId: s.slotId, category: s.category, venue: clone(s.venue), start: s.start, end: s.end, duration: s.duration })),
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
  session.replan = null
  if (accept) reopenVoting(session, trigger)
  return touch(session, 'session')
}

// Edit → Re-plan from the itinerary.
export async function replan(id) {
  await wait(DELAY.write)
  const session = sessionById(id)
  reopenVoting(session, null)
  return touch(session, 'session')
}

function reopenVoting(session, trigger) {
  const previous = session.meeting
  const next = computeMeeting(session)
  session.status = 'voting'
  session.plan = null
  session.meeting = next
  const moved = (previous?.areaId ?? null) !== (next?.areaId ?? null)
  if (moved) {
    session.votes = {}
    session.options = {}
  }
  syncOptions(session)
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
  }
  emit({ type: 'stats' })
  return touch(session, 'session')
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
  if (stats.points < reward.cost) throw new Error(`You need ${reward.cost - stats.points} more points for this voucher.`)
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
    for (const session of db.sessions.filter((s) => s.status === 'locating')) session.meeting = computeMeeting(session)
  }
  emit({ type: 'conditions' })
  return clone(db.conditions)
}

// Reset sessions, points and conditions. The account stays signed in.
export async function resetDemo() {
  db = freshDb({ user: db.user, friends: db.friends })
  emit({ type: 'reset' })
}
