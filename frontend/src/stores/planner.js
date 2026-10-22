// Step 6: categories and timing, suggestions and votes, plus the demo weather conditions.
import { defineStore } from 'pinia'
import { ref, toRaw } from 'vue'
import * as api from '@/lib/api.js'
import { useAuthStore } from '@/stores/auth.js'
import { currentUserId } from '@/lib/currentUser.js'
import { withMyVote } from '@/lib/planVotes.js'

// Changes that cannot alter what the planner would rank: photos, and the itinerary (order, travel modes, deleted stops).
const KEEPS_RANKING = new Set(['photos', 'plan'])

export const usePlannerStore = defineStore('planner', () => {
  const plans = ref({})
  const loading = ref({})
  // The message of the last failed load of each plan, or '' once a load has worked.
  const errors = ref({})
  const conditions = ref({ rain: false, routing: true, sessionDay: false })
  const seq = {}

  // Only the newest load of a plan applies. A load that fails sets errors[id] and still throws, so the caller can react.
  async function loadPlan(id, { quiet = false } = {}) {
    const ticket = (seq[id] = (seq[id] || 0) + 1)
    if (!quiet || !plans.value[id]) loading.value = { ...loading.value, [id]: true }
    try {
      const plan = await api.getPlan(id)
      if (ticket !== seq[id]) return plans.value[id]
      plans.value = { ...plans.value, [id]: plan }
      errors.value = { ...errors.value, [id]: '' }
      return plan
    } catch (err) {
      if (ticket === seq[id]) errors.value = { ...errors.value, [id]: err.message }
      throw err
    } finally {
      // A newer load that is still running keeps the spinner.
      if (ticket === seq[id]) loading.value = { ...loading.value, [id]: false }
    }
  }

  async function loadConditions() {
    conditions.value = await api.getConditions()
  }

  async function setCondition(key, value) {
    conditions.value = await api.setConditions({ [key]: value })
  }

  const setMyPreferences = (id, prefs) => api.setPreferences(id, currentUserId(), prefs)
  const deleteSlot = (id, slotId) => api.deleteSlot(id, slotId)
  const restoreSlots = (id) => api.restoreSlots(id)
  const addMore = (id, slotId) => api.addMoreOptions(id, slotId)
  const addOption = (id, slotId, venueId) => api.addOption(id, slotId, venueId)
  const swapOption = (id, slotId, fromId, toId) => api.swapOption(id, slotId, fromId, toId)
  // The answers of the server that prove it changed nothing: a vote refused for these reasons was not saved, so what was shown for it is
  // taken back. Any other failure (no connection, a timeout, a server error) says nothing about whether it was saved.
  const REFUSED = new Set(['wrong_status', 'not_joined', 'slot_not_found', 'option_not_found', 'session_not_found'])

  // One vote. In a shared session the person's own vote shows at once, before the database has answered (the plan is read again when it
  // has); if the database refuses it the plan goes back to what it was, but only if nothing has replaced it meanwhile. A failure that does
  // not prove the vote was not saved leaves what is shown and reads the plan again to find out. A local session waits for its own answer.
  // How to call: await vote('3b1f...', '9a2c...', 'v25')
  async function vote(id, slotId, venueId) {
    const before = toRaw(plans.value[id])
    if (!before?.remote) return api.vote(id, slotId, currentUserId(), venueId)
    const shown = withMyVote(before, slotId, venueId, currentUserId(), myName())
    if (shown !== before) plans.value = { ...plans.value, [id]: shown }
    try {
      return await api.vote(id, slotId, currentUserId(), venueId)
    } catch (err) {
      if (REFUSED.has(err?.code) && toRaw(plans.value[id]) === shown) plans.value = { ...plans.value, [id]: before }
      reload(id)
      throw err
    }
  }
  // The signed-in person's own name, for their vote on the card until the plan is read again. How to call: myName() -> 'Sam'
  const myName = () => useAuthStore().user?.name ?? ''
  const searchVenues = (id, slotId, query) => api.searchVenuesForSlot(id, slotId, query)
  const setRadius = (id, metres) => api.setRadius(id, metres)

  // A live reload that fails has nowhere to throw to: the failure is in errors[id].
  const reload = (id) => loadPlan(id, { quiet: true }).catch(() => {})

  // Live updates: a change to a session that can alter its ranking refreshes its plan; weather refreshes every plan.
  // Whose plans the store holds. A change of person, with or without a sign-out between, empties them: every account's first
  // session is `s1`, so a kept plan of `s1` would be shown as the next account's. A load still running finds its ticket out
  // of date and drops its answer.
  let owner = currentUserId()
  function forgetPlans() {
    for (const id of Object.keys(seq)) seq[id] += 1
    plans.value = {}
    loading.value = {}
    errors.value = {}
  }

  api.subscribe((event) => {
    if (currentUserId() !== owner) {
      owner = currentUserId()
      forgetPlans()
    }
    // "pending" only shows work in progress (the meeting area being found); the plan has not changed yet.
    if (event.type === 'pending') return
    if (event.type === 'reset') {
      plans.value = {}
      errors.value = {}
      loadConditions().catch(() => {})
      return
    }
    // The channel of a shared session connected, or the tab came back into view: what happened while nobody listened is read again.
    if (event.type === 'resync') {
      for (const id of Object.keys(plans.value)) reload(id)
      return
    }
    if (event.type === 'conditions') {
      loadConditions().catch(() => {})
      for (const id of Object.keys(plans.value)) reload(id)
      return
    }
    if (KEEPS_RANKING.has(event.type)) return
    if (event.sessionId && plans.value[event.sessionId]) reload(event.sessionId)
  })

  return { plans, loading, errors, conditions, loadPlan, loadConditions, setCondition, setMyPreferences, deleteSlot, restoreSlots, addMore, addOption, swapOption, vote, searchVenues, setRadius }
})
