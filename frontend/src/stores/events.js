// Sessions: create, invite, start, locations, the meeting area, confirm, the itinerary and the day itself.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/lib/api.js'
import { HOST_ID } from '@/lib/mock/people.js'
import { moveItem } from '@/lib/planner/itinerary.js'

// Who a session in Locating is waiting for: the people in it who have not set where they start. The meeting area
// appears once this is empty. How to call: waitingFor(session) -> ['faith']
export function waitingFor(session) {
  if (session.status !== 'locating' || session.meeting) return []
  return (session.activeIds || []).filter((id) => !session.locations?.[id]?.start)
}

export const useEventsStore = defineStore('events', () => {
  const sessions = ref([])
  const byId = ref({})
  const itineraries = ref({})
  // Photos by session, loaded with loadPhotos: a session summary carries only photoCount.
  const photos = ref({})
  const loaded = ref(false)
  const seq = {}
  const itinerarySeq = {}
  const photoSeq = {}

  // Ian's current session: the newest one that is still going, otherwise the newest one.
  const current = computed(() => {
    const live = sessions.value.find((s) => !['completed', 'cancelled'].includes(s.status))
    return live || sessions.value[0] || null
  })

  function put(session) {
    byId.value = { ...byId.value, [session.id]: session }
    const i = sessions.value.findIndex((s) => s.id === session.id)
    if (i === -1) sessions.value = [session, ...sessions.value]
    else sessions.value = sessions.value.map((s) => (s.id === session.id ? session : s))
    return session
  }

  async function loadSessions() {
    sessions.value = await api.listSessions()
    byId.value = Object.fromEntries(sessions.value.map((s) => [s.id, s]))
    loaded.value = true
  }

  // Only the newest answer for a session is kept, so quick live updates never show older data.
  async function loadSession(id) {
    const ticket = (seq[id] = (seq[id] || 0) + 1)
    const session = await api.getSession(id)
    if (ticket === seq[id]) put(session)
    return session
  }

  // Only the newest load of an itinerary applies, so an older answer never overwrites a newer one.
  async function loadItinerary(id) {
    const ticket = (itinerarySeq[id] = (itinerarySeq[id] || 0) + 1)
    const itinerary = await api.getItinerary(id)
    if (ticket !== itinerarySeq[id]) return itineraries.value[id]
    itineraries.value = { ...itineraries.value, [id]: itinerary }
    return itinerary
  }

  // All the pictures of a session, oldest first. The same ticket rule as the others.
  async function loadPhotos(id) {
    const ticket = (photoSeq[id] = (photoSeq[id] || 0) + 1)
    const list = await api.getPhotos(id)
    if (ticket !== photoSeq[id]) return photos.value[id]
    photos.value = { ...photos.value, [id]: list }
    return list
  }

  const act = (fn) => async (id, ...args) => put(await fn(id, ...args))

  const create = async (data) => put(await api.createSession(data))
  // The host changes the title, day and times while the session is still inviting. How to call: update('s1', { title, date, start, end })
  const update = act(api.updateSession)
  // Invites from the app are pending until each friend accepts.
  const invite = act((id, personIds) => api.inviteFriends(id, personIds, { pending: true }))
  const start = act(api.startSession)
  const setMyLocation = (id, which, place) => act(api.setLocation)(id, HOST_ID, which, place)
  const useArea = act(api.useMeetingArea)
  const cancel = act(api.cancelSession)
  // The host carries on without a member who has not shared where they start (they opt out of this session).
  const optOut = act(api.optOut)
  const dismissBanner = act(api.dismissBanner)
  const confirm = act(api.confirmPlan)
  const respondReplan = act(api.respondReplan)
  const replan = act(api.replan)
  const endPlan = act(api.endPlan)

  const addPhoto = (id, src) => act(api.addPhoto)(id, HOST_ID, src)
  const deletePhoto = act(api.deletePhoto)

  async function setTravelMode(id, legIndex, mode) {
    put(await api.setTravelMode(id, legIndex, mode))
    await loadItinerary(id)
  }

  // The order the Confirm dialog suggests (nothing is saved). How to call: const suggestion = await suggestOrder('s1')
  const suggestOrder = (id) => api.suggestOrder(id)

  // Moves the stop on screen straight away, then saves and re-times from the server's answer.
  // If the save fails, the old order comes back, the itinerary is loaded again, and the error is thrown.
  async function reorderStops(id, from, to) {
    const before = itineraries.value[id]
    if (before) {
      // A load that started earlier must not put the old order back over the move.
      itinerarySeq[id] = (itinerarySeq[id] || 0) + 1
      itineraries.value = { ...itineraries.value, [id]: { ...before, stops: moveItem(before.stops, from, to) } }
    }
    try {
      put(await api.reorderStops(id, from, to))
      await loadItinerary(id)
    } catch (err) {
      if (before) itineraries.value = { ...itineraries.value, [id]: before }
      // Show what is really stored. If that fails too, the first error is the one to report.
      await loadItinerary(id).catch(() => {})
      throw err
    }
  }

  async function deleteStop(id, index) {
    put(await api.deleteStop(id, index))
    await loadItinerary(id)
  }

  api.subscribe(async (event) => {
    if (event.type === 'reset') {
      itineraries.value = {}
      photos.value = {}
      await loadSessions()
      return
    }
    if (event.sessionId) {
      await loadSession(event.sessionId)
      if (itineraries.value[event.sessionId] !== undefined) await loadItinerary(event.sessionId)
      if (event.type === 'photos' && photos.value[event.sessionId] !== undefined) await loadPhotos(event.sessionId)
    }
    if (event.type === 'user' || event.type === 'conditions') await loadSessions()
  })

  return {
    sessions, byId, itineraries, photos, loaded, current,
    loadSessions, loadSession, loadItinerary, loadPhotos,
    create, update, invite, start, setMyLocation, useArea, cancel, optOut, dismissBanner, confirm, respondReplan, replan, endPlan, setTravelMode, deleteStop, reorderStops, suggestOrder, addPhoto, deletePhoto,
  }
})
