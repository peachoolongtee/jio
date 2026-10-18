// Step 6: categories and timing, suggestions and votes, plus the demo weather conditions.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '@/lib/api.js'
import { currentUserId } from '@/lib/currentUser.js'

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
  const vote = (id, slotId, venueId) => api.vote(id, slotId, currentUserId(), venueId)
  const searchVenues = (id, slotId, query) => api.searchVenuesForSlot(id, slotId, query)
  const setRadius = (id, metres) => api.setRadius(id, metres)
  // Show the food places we could not confirm for the group's dietary needs, or only the ones that fit.
  // How to call: await planner.setUnconfirmed(id, true)
  const setUnconfirmed = (id, on) => api.setUnconfirmed(id, on)
  // Confirm the signed-in person's dietary needs for this outing (and save a change on their profile), and which of the
  // others' needs the group should not filter for.
  // How to call: await planner.confirmDiet(id, ['halal'], [])
  const confirmDiet = (id, dietary, dropped) => api.confirmDiet(id, dietary, dropped)

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
      loadConditions()
      return
    }
    if (event.type === 'conditions') {
      loadConditions()
      for (const id of Object.keys(plans.value)) reload(id)
      return
    }
    // The signed-in person's profile changed: a dietary need changes what every plan shows and ranks, even when no place
    // dropped out (and then no session event follows).
    if (event.type === 'user') {
      for (const id of Object.keys(plans.value)) reload(id)
      return
    }
    if (KEEPS_RANKING.has(event.type)) return
    if (event.sessionId && plans.value[event.sessionId]) reload(event.sessionId)
  })

  return { plans, loading, errors, conditions, loadPlan, loadConditions, setCondition, setMyPreferences, deleteSlot, restoreSlots, addMore, addOption, swapOption, vote, searchVenues, setRadius, setUnconfirmed, confirmDiet }
})
