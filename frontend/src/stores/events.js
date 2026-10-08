// Sessions: create, invite, start, locations, the meeting area, confirm, the itinerary and the day itself.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/lib/api.js'
import { HOST_ID } from '@/lib/mock/people.js'
import { moveItem } from '@/lib/planner/itinerary.js'

export const useEventsStore = defineStore('events', () => {
  const sessions = ref([])
  const byId = ref({})
  const itineraries = ref({})
  const loaded = ref(false)
  const seq = {}

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

  async function loadItinerary(id) {
    const itinerary = await api.getItinerary(id)
    itineraries.value = { ...itineraries.value, [id]: itinerary }
    return itinerary
  }

  const act = (fn) => async (id, ...args) => put(await fn(id, ...args))

  const create = async (data) => put(await api.createSession(data))
  const invite = act(api.inviteFriends)
  const start = act(api.startSession)
  const setMyLocation = (id, which, place) => act(api.setLocation)(id, HOST_ID, which, place)
  const useArea = act(api.useMeetingArea)
  const cancel = act(api.cancelSession)
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

  // Moves the stop on screen straight away, then saves and re-times from the server's answer.
  async function reorderStops(id, from, to) {
    const current = itineraries.value[id]
    if (current) itineraries.value = { ...itineraries.value, [id]: { ...current, stops: moveItem(current.stops, from, to) } }
    put(await api.reorderStops(id, from, to))
    await loadItinerary(id)
  }

  async function deleteStop(id, index) {
    put(await api.deleteStop(id, index))
    await loadItinerary(id)
  }

  api.subscribe(async (event) => {
    if (event.type === 'reset') {
      itineraries.value = {}
      await loadSessions()
      return
    }
    if (event.sessionId) {
      await loadSession(event.sessionId)
      if (itineraries.value[event.sessionId] !== undefined) await loadItinerary(event.sessionId)
    }
    if (event.type === 'user' || event.type === 'conditions') await loadSessions()
  })

  return {
    sessions, byId, itineraries, loaded, current,
    loadSessions, loadSession, loadItinerary,
    create, invite, start, setMyLocation, useArea, cancel, dismissBanner, confirm, respondReplan, replan, endPlan, setTravelMode, deleteStop, reorderStops, addPhoto, deletePhoto,
  }
})
