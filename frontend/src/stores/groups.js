// People: friends, profiles, the leaderboard and its season, points and rewards.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/lib/api.js'
import { NEUTRAL_NAME } from '@/lib/peopleSource.js'
import { currentUserId } from '@/lib/currentUser.js'

export const useGroupsStore = defineStore('groups', () => {
  const people = ref([])
  const leaderboard = ref([])
  // The leaderboard season: { number, startsAt, endsAt, prize, past: [...] }.
  const season = ref(null)
  const profiles = ref({})
  const rewards = ref([])
  const redemptions = ref([])
  const loading = ref({ people: false, leaderboard: false, rewards: false })

  const me = computed(() => leaderboard.value.find((row) => row.isMe) || null)
  const friends = computed(() => people.value.filter((p) => p.isFriend))
  const suggested = computed(() => people.value.filter((p) => !p.isFriend))
  // Never blank: a person not on the list (not read yet, opted out of a session, or the signed-in person, whom a screen names from
  // the account) reads as "Someone".
  const nameOf = (id) => people.value.find((p) => p.id === id)?.name || NEUTRAL_NAME

  // Has the list been asked for? A real account's list can be empty and still need making again when someone joins a session,
  // so "empty" does not mean "never loaded".
  let peopleAsked = false

  async function loadPeople() {
    peopleAsked = true
    loading.value.people = true
    people.value = await api.listPeople()
    loading.value.people = false
  }

  async function loadLeaderboard() {
    loading.value.leaderboard = true
    leaderboard.value = await api.getLeaderboard()
    loading.value.leaderboard = false
  }

  async function loadSeason() {
    season.value = await api.getSeason()
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

  // A profile that cannot be read again (the person is not in this account's world any more, for example after another
  // account signed in) is dropped instead of being kept or thrown at nobody.
  // How to call: reloadProfiles()
  function reloadProfiles() {
    for (const id of Object.keys(profiles.value)) {
      loadProfile(id).catch(() => {
        const { [id]: _gone, ...rest } = profiles.value
        profiles.value = rest
      })
    }
  }

  // Whose people, standings, vouchers and profiles the store holds. A change of person, with or without a sign-out between,
  // empties them, so one account never shows another's, and what a screen had asked for is asked for again for the new person.
  // How to call: forgetEverything() (when the signed-in person changes)
  let owner = currentUserId()
  function forgetEverything() {
    const had = { people: people.value.length > 0 || peopleAsked, leaderboard: leaderboard.value.length > 0, season: !!season.value, rewards: rewards.value.length > 0 }
    people.value = []
    peopleAsked = false
    leaderboard.value = []
    season.value = null
    profiles.value = {}
    rewards.value = []
    redemptions.value = []
    if (had.people) loadPeople().catch(() => {})
    if (had.leaderboard) loadLeaderboard().catch(() => {})
    if (had.season) loadSeason().catch(() => {})
    if (had.rewards) loadRewards().catch(() => {})
  }

  api.subscribe((event) => {
    if (currentUserId() !== owner) {
      owner = currentUserId()
      forgetEverything()
    }
    if (['stats', 'reset', 'user', 'friends', 'people'].includes(event.type)) {
      if (people.value.length || peopleAsked) loadPeople()
      if (leaderboard.value.length) loadLeaderboard()
      if (season.value) loadSeason()
      if (rewards.value.length) loadRewards()
      reloadProfiles()
    }
    if (event.type === 'session' && Object.keys(profiles.value).length) reloadProfiles()
  })

  return { people, leaderboard, season, profiles, rewards, redemptions, loading, me, friends, suggested, nameOf, loadPeople, loadLeaderboard, loadSeason, loadProfile, loadRewards, setFriend, redeem }
})
