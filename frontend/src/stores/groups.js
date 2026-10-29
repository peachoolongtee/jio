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

  // Each load below clears its flag whether it worked or not, and still throws, so a screen can show the failure and offer a retry.
  // How to call: await loadPeople()
  async function loadPeople() {
    peopleAsked = true
    loading.value.people = true
    try {
      people.value = await api.listPeople()
    } finally {
      loading.value.people = false
    }
  }

  // How to call: await loadLeaderboard()
  async function loadLeaderboard() {
    loading.value.leaderboard = true
    try {
      leaderboard.value = await api.getLeaderboard()
    } finally {
      loading.value.leaderboard = false
    }
  }

  async function loadSeason() {
    season.value = await api.getSeason()
  }

  async function loadProfile(id) {
    profiles.value = { ...profiles.value, [id]: await api.getPerson(id) }
    return profiles.value[id]
  }

  // How to call: await loadRewards()
  async function loadRewards() {
    loading.value.rewards = true
    try {
      const [list, mine] = await Promise.all([api.listRewards(), api.listRedemptions()])
      rewards.value = list
      redemptions.value = mine
    } finally {
      loading.value.rewards = false
    }
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

  // Marks a claimed voucher as used, then reads the vouchers again so it moves to "Used".
  // How to call: await markUsed('v3')
  async function markUsed(redemptionId) {
    const used = await api.markVoucherUsed(redemptionId)
    await loadRewards()
    return used
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
    if (had.people) quietly(loadPeople)
    if (had.leaderboard) quietly(loadLeaderboard)
    if (had.season) quietly(loadSeason)
    if (had.rewards) quietly(loadRewards)
  }

  // A refresh nobody is waiting for (a live update): a failure keeps what is shown and is not an unhandled rejection.
  // How to call: quietly(loadPeople)
  const quietly = (load) => load().catch(() => {})

  api.subscribe((event) => {
    if (currentUserId() !== owner) {
      owner = currentUserId()
      forgetEverything()
    }
    if (['stats', 'reset', 'user', 'friends', 'people'].includes(event.type)) {
      if (people.value.length || peopleAsked) quietly(loadPeople)
      if (leaderboard.value.length) quietly(loadLeaderboard)
      if (season.value) quietly(loadSeason)
      if (rewards.value.length) quietly(loadRewards)
      reloadProfiles()
    }
    if (event.type === 'session' && Object.keys(profiles.value).length) reloadProfiles()
  })

  return { people, leaderboard, season, profiles, rewards, redemptions, loading, me, friends, suggested, nameOf, loadPeople, loadLeaderboard, loadSeason, loadProfile, loadRewards, setFriend, redeem, markUsed }
})
