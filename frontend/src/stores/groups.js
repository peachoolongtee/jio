// People: friends, profiles, the leaderboard, points and rewards.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/lib/api.js'

export const useGroupsStore = defineStore('groups', () => {
  const people = ref([])
  const leaderboard = ref([])
  const profiles = ref({})
  const rewards = ref([])
  const redemptions = ref([])
  const loading = ref({ people: false, leaderboard: false, rewards: false })

  const me = computed(() => leaderboard.value.find((row) => row.isMe) || null)
  const friends = computed(() => people.value.filter((p) => p.isFriend))
  const suggested = computed(() => people.value.filter((p) => !p.isFriend))
  const nameOf = (id) => people.value.find((p) => p.id === id)?.name || ''

  async function loadPeople() {
    loading.value.people = true
    people.value = await api.listPeople()
    loading.value.people = false
  }

  async function loadLeaderboard() {
    loading.value.leaderboard = true
    leaderboard.value = await api.getLeaderboard()
    loading.value.leaderboard = false
  }

  async function loadProfile(id) {
    profiles.value = { ...profiles.value, [id]: await api.getPerson(id) }
    return profiles.value[id]
  }

  async function loadRewards() {
    loading.value.rewards = true
    const [list, mine] = await Promise.all([api.listRewards(), api.listRedemptions()])
    rewards.value = list
    redemptions.value = mine
    loading.value.rewards = false
  }

  async function setFriend(id, isFriend) {
    await api.setFriend(id, isFriend)
    await loadPeople()
  }

  async function redeem(rewardId) {
    const redemption = await api.redeemReward(rewardId)
    await Promise.all([loadRewards(), loadLeaderboard()])
    return redemption
  }

  api.subscribe((event) => {
    if (['stats', 'reset', 'user', 'friends'].includes(event.type)) {
      if (people.value.length) loadPeople()
      if (leaderboard.value.length) loadLeaderboard()
      if (rewards.value.length) loadRewards()
      for (const id of Object.keys(profiles.value)) loadProfile(id)
    }
    if (event.type === 'session' && Object.keys(profiles.value).length) {
      for (const id of Object.keys(profiles.value)) loadProfile(id)
    }
  })

  return { people, leaderboard, profiles, rewards, redemptions, loading, me, friends, suggested, nameOf, loadPeople, loadLeaderboard, loadProfile, loadRewards, setFriend, redeem }
})
