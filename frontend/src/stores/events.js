// Sessions: create, invite, start, locations, the meeting area, confirm, the itinerary and the day itself.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/lib/api.js'
import { currentUserId } from '@/lib/currentUser.js'
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
  const orderSeq = {}
  const orderPending = {}
  // The Confirm dialog's suggested order by session: { key, loading, answer, failed } for the newest question asked.
  const orders = ref({})
  // Weather on the day, by session: the latest check of the plan's stops, { checkedAt, stops: { [slotId]: weather }, weather:
  // the answer's block, failed }. A failed check keeps the answer before it and says so in `failed`.
  const weatherChecks = ref({})
  // The indoor place offered for a stop in the rain, by session and slot: { key, status: 'loading' | 'ready' | 'none' | 'failed', swap }.
  const rainSwaps = ref({})
  const checkSeq = {}
  const swapSeq = {}

  // The signed-in person's current session: the newest one that is still going, otherwise the newest one.
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
  const setMyLocation = (id, which, place) => act(api.setLocation)(id, currentUserId(), which, place)
  const useArea = act(api.useMeetingArea)
  // Meeting spots. The first three act as the signed-in person; the host confirms a spot or sets a known place.
  // How to call: suggestMySpot('s1', 'bugis', { here: true }), approveMySpot('s1', 'bugis', true), withdrawMySpot('s1')
  const suggestMySpot = (id, areaId, options) => act(api.suggestSpot)(id, currentUserId(), areaId, options)
  const withdrawMySpot = (id) => act(api.withdrawSpot)(id, currentUserId())
  const approveMySpot = (id, areaId, on) => act(api.approveSpot)(id, currentUserId(), areaId, on)
  const confirmSpot = act(api.confirmSpot)
  const setKnownPlace = act(api.setKnownPlace)
  const cancel = act(api.cancelSession)
  // The host carries on without a member who has not shared where they start (they opt out of this session).
  const optOut = act(api.optOut)
  const dismissBanner = act(api.dismissBanner)
  const confirm = act(api.confirmPlan)
  const respondReplan = act(api.respondReplan)
  const replan = act(api.replan)
  const endPlan = act(api.endPlan)
  // Roam. The first acts as the signed-in person; the host adds a proposed place to the plan or leaves it out, and the
  // person who proposed it may take it back. How to call: proposeMyStop('s1', 'v25'), resolveProposal('s1', 'pp7', true)
  const proposeMyStop = (id, venueId) => act(api.proposeStop)(id, currentUserId(), venueId)
  const resolveProposal = act(api.resolveProposal)

  const addPhoto = (id, src) => act(api.addPhoto)(id, currentUserId(), src)
  const deletePhoto = act(api.deletePhoto)

  async function setTravelMode(id, legIndex, mode) {
    put(await api.setTravelMode(id, legIndex, mode))
    await loadItinerary(id)
  }

  // The order the Confirm dialog suggests (nothing is saved). `key` names the question (the voted stops and the
  // session's times): the same key reuses the answer already received, or the request still running, instead of
  // asking again. Only the newest question's answer and loading state are kept, so a late older answer is ignored.
  // A failure is not kept, so the next open asks again. Resolves to the answer, or null; never rejects.
  // How to call: const suggestion = await suggestOrder('s1', key)
  async function suggestOrder(id, key = '') {
    const have = orders.value[id]
    if (have && have.key === key && !have.failed) return have.loading ? orderPending[id] : have.answer
    const ticket = (orderSeq[id] = (orderSeq[id] || 0) + 1)
    const entry = (patch) => (orders.value = { ...orders.value, [id]: { key, loading: false, answer: null, failed: false, ...patch } })
    entry({ loading: true })
    const pending = (async () => api.suggestOrder(id))()
      .then((answer) => {
        if (ticket === orderSeq[id]) entry({ answer })
        return answer
      })
      .catch(() => {
        if (ticket === orderSeq[id]) entry({ failed: true })
        return null
      })
    orderPending[id] = pending
    return pending
  }

  // Asks the planner for the weather at the stops of a confirmed plan and keeps the answer with its time. A check that fails keeps
  // the answer before it and marks it `failed`; one that fails with nothing before it keeps an empty answer, `failed`. Only the
  // newest check of a session is kept. Never rejects (the schedule asks again in its own time).
  // How to call: await checkWeather('s1'); weatherChecks.value.s1.stops.eat.state
  async function checkWeather(id) {
    const ticket = (checkSeq[id] = (checkSeq[id] || 0) + 1)
    try {
      const answer = await api.checkStopWeather(id)
      if (ticket === checkSeq[id]) weatherChecks.value = { ...weatherChecks.value, [id]: { ...answer, failed: false } }
    } catch {
      if (ticket !== checkSeq[id]) return
      const before = weatherChecks.value[id]
      weatherChecks.value = { ...weatherChecks.value, [id]: { checkedAt: before?.checkedAt ?? null, stops: before?.stops ?? {}, weather: before?.weather ?? null, failed: true } }
    }
  }

  // Asks the planner which indoor place it would offer in place of a stop in the rain, once for each stop and forecast state
  // (`key` names them); the same key reuses the answer, or the request running. Never rejects: a failure is kept as 'failed'.
  // How to call: await loadRainSwap('s1', 'activity', 'east-coast-park:showers'); rainSwaps.value.s1.activity.swap.name
  async function loadRainSwap(id, slotId, key) {
    const have = rainSwaps.value[id]?.[slotId]
    if (have && have.key === key && have.status !== 'failed') return
    const ticket = (swapSeq[`${id}:${slotId}`] = (swapSeq[`${id}:${slotId}`] || 0) + 1)
    const set = (entry) => (rainSwaps.value = { ...rainSwaps.value, [id]: { ...rainSwaps.value[id], [slotId]: { key, swap: null, ...entry } } })
    set({ status: 'loading' })
    try {
      const swap = await api.findRainSwap(id, slotId)
      if (ticket === swapSeq[`${id}:${slotId}`]) set(swap ? { status: 'ready', swap } : { status: 'none' })
    } catch {
      if (ticket === swapSeq[`${id}:${slotId}`]) set({ status: 'failed' })
    }
  }

  // The host accepts the indoor swap: the stop becomes the indoor place (the data layer's swap), the itinerary is loaded again
  // and the offer is forgotten. Rejects with the data layer's message when it cannot.
  // How to call: await swapStop('s1', 'activity', 'east-coast-park', 'toa-payoh-library')
  async function swapStop(id, slotId, fromId, toId) {
    put(await api.swapOption(id, slotId, fromId, toId))
    swapSeq[`${id}:${slotId}`] = (swapSeq[`${id}:${slotId}`] || 0) + 1
    const { [slotId]: _done, ...rest } = rainSwaps.value[id] || {}
    rainSwaps.value = { ...rainSwaps.value, [id]: rest }
    await loadItinerary(id)
  }

  // The host keeps the stop in the rain: the warning stays dismissed until the forecast changes state (`state` is its state now).
  // How to call: await dismissRain('s1', 'activity', 'showers')
  async function dismissRain(id, slotId, state) {
    put(await api.dismissRainWarning(id, slotId, state))
    await loadItinerary(id)
  }

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

  // Forget everything kept for the sessions of the last account: the list, each session, its itinerary, its photos and the
  // suggested orders. Every account's first session is `s1`, so a kept `s1` would be shown as the next account's. Loads that
  // were still running for the last account find their ticket out of date and drop their answer.
  // `list` also empties the list and the sessions by id (a different person), where a reset leaves them for the load that follows.
  // How to call: forgetSessions({ list: true }) (when the signed-in person changes)
  function forgetSessions({ list = false } = {}) {
    for (const tickets of [seq, itinerarySeq, photoSeq, orderSeq]) for (const id of Object.keys(tickets)) tickets[id] += 1
    for (const id of Object.keys(orderPending)) delete orderPending[id]
    if (list) {
      sessions.value = []
      byId.value = {}
      loaded.value = false
    }
    for (const tickets of [checkSeq, swapSeq]) for (const key of Object.keys(tickets)) tickets[key] += 1
    itineraries.value = {}
    photos.value = {}
    orders.value = {}
    weatherChecks.value = {}
    rainSwaps.value = {}
  }
  // Whose sessions the store holds. A change of person, with or without a sign-out between, empties it (see forgetSessions).
  let owner = currentUserId()

  api.subscribe(async (event) => {
    if (currentUserId() !== owner) {
      owner = currentUserId()
      forgetSessions({ list: true })
      if (!['reset', 'user', 'conditions', 'people'].includes(event.type)) await loadSessions()
    }
    if (event.type === 'reset') {
      // A suggestion asked for before the reset belongs to data that is gone.
      forgetSessions()
      await loadSessions()
      return
    }
    if (event.sessionId) {
      try {
        await loadSession(event.sessionId)
        if (itineraries.value[event.sessionId] !== undefined) await loadItinerary(event.sessionId)
        if (event.type === 'photos' && photos.value[event.sessionId] !== undefined) await loadPhotos(event.sessionId)
      } catch {
        // The session is not there any more (the person changed or signed out since the write): nothing to refresh, and no
        // screen is waiting on this live update to report it to.
      }
    }
    // 'people': a real person's profile was read, so the names on every session may have changed.
    if (event.type === 'user' || event.type === 'conditions' || event.type === 'people') await loadSessions()
  })

  return {
    sessions, byId, itineraries, photos, loaded, current, weatherChecks, rainSwaps,
    loadSessions, loadSession, loadItinerary, loadPhotos, checkWeather, loadRainSwap, swapStop, dismissRain,
    create, update, invite, start, setMyLocation, useArea, suggestMySpot, withdrawMySpot, approveMySpot, confirmSpot, setKnownPlace, cancel, optOut, dismissBanner, confirm, respondReplan, replan, endPlan, proposeMyStop, resolveProposal, setTravelMode, deleteStop, reorderStops, orders, suggestOrder, addPhoto, deletePhoto,
  }
})
