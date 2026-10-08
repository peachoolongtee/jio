// Step 6: categories and timing, suggestions and votes, plus the demo weather and crowd conditions.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '@/lib/api.js'
import { HOST_ID } from '@/lib/mock/people.js'

export const usePlannerStore = defineStore('planner', () => {
  const plans = ref({})
  const loading = ref({})
  const conditions = ref({ rain: false, crowd: false, routing: true, sessionDay: false })
  const seq = {}

  async function loadPlan(id, { quiet = false } = {}) {
    const ticket = (seq[id] = (seq[id] || 0) + 1)
    if (!quiet || !plans.value[id]) loading.value = { ...loading.value, [id]: true }
    const plan = await api.getPlan(id)
    if (ticket !== seq[id]) return plans.value[id]
    plans.value = { ...plans.value, [id]: plan }
    loading.value = { ...loading.value, [id]: false }
    return plan
  }

  async function loadConditions() {
    conditions.value = await api.getConditions()
  }

  async function setCondition(key, value) {
    conditions.value = await api.setConditions({ [key]: value })
  }

  const setMyPreferences = (id, prefs) => api.setPreferences(id, HOST_ID, prefs)
  const deleteSlot = (id, slotId) => api.deleteSlot(id, slotId)
  const restoreSlots = (id) => api.restoreSlots(id)
  const addMore = (id, slotId) => api.addMoreOptions(id, slotId)
  const addOption = (id, slotId, venueId) => api.addOption(id, slotId, venueId)
  const swapOption = (id, slotId, fromId, toId) => api.swapOption(id, slotId, fromId, toId)
  const vote = (id, slotId, venueId) => api.vote(id, slotId, HOST_ID, venueId)
  const searchVenues = (id, slotId, query) => api.searchVenuesForSlot(id, slotId, query)
  const setRadius = (id, metres) => api.setRadius(id, metres)

  // Live updates: any change to a session refreshes its plan; weather and crowd refresh every plan.
  api.subscribe((event) => {
    // "pending" only shows work in progress (the meeting area being found); the plan has not changed yet.
    if (event.type === 'pending') return
    if (event.type === 'reset') {
      plans.value = {}
      loadConditions()
      return
    }
    if (event.type === 'conditions') {
      loadConditions()
      for (const id of Object.keys(plans.value)) loadPlan(id, { quiet: true })
      return
    }
    if (event.sessionId && plans.value[event.sessionId]) loadPlan(event.sessionId, { quiet: true })
  })

  return { plans, loading, conditions, loadPlan, loadConditions, setCondition, setMyPreferences, deleteSlot, restoreSlots, addMore, addOption, swapOption, vote, searchVenues, setRadius }
})
