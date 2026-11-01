<script setup>
// "Add friends" on Home (walkthrough, 30 October 2026): a round people button in the band's top corner (top left on phones, opposite
// the avatar; top right from 744px, where the avatar is in the top bar) that opens a sheet for finding people on Jio and adding them,
// the same people as the profile's Suggested.
//   <AddFriends />   or, in a test, <AddFriends :accept-after="50" />
// The demo and local accounts: a search box (name or @username) over "Suggested friends", everyone they are not friends with yet
// (SuggestedFriends: each row opens that person's profile, and a round red button sends a friend request, accepted after
// `acceptAfter`, 2 s; the profile's Friends sheet has the same section). The acceptance still happens if the sheet is closed meanwhile.
// The rows are fixed when the sheet opens, so the list does not jump under the finger. A real account's friends are the people it has
// been out with (CLAUDE.md, ticket #125), and a
// list of its own would need a table on the server, so its sheet says how people become friends and offers to start a session.
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import BottomSheet from '../ui/BottomSheet.vue'
import SuggestedFriends from '../group/SuggestedFriends.vue'
import { FRIEND_ACCEPT_MS } from '@/lib/friendRequests.js'
import { useAuthStore } from '@/stores/auth.js'
import { useGroupsStore } from '@/stores/groups.js'

const props = defineProps({
  // How long the other person takes to accept a friend request, in ms.
  acceptAfter: { type: Number, default: FRIEND_ACCEPT_MS },
})

const router = useRouter()
const auth = useAuthStore()
const groups = useGroupsStore()
const open = ref(false)
const query = ref('')
// The people shown while the sheet is open: fixed when it opens, so a person just added stays on the list, marked.
const shown = ref([])
const error = ref('')

watch(open, (isOpen) => {
  if (!isOpen) return
  query.value = ''
  error.value = ''
  shown.value = [...groups.suggested]
})

// Search by name or username, any case, with or without the @. How to call: matches({ name: 'Mei Ling', username: 'meiling' })
const matches = (p) => {
  const q = query.value.trim().toLowerCase().replace(/^@/, '')
  return !q || p.name.toLowerCase().includes(q) || (p.username || '').toLowerCase().includes(q)
}
const results = computed(() => shown.value.filter(matches))

// A name opens that person's profile; the sheet closes first. How to call: openProfile('meiling')
function openProfile(id) {
  open.value = false
  router.push(`/people/${id}`)
}
// A real account: start a session to go out with people (and so become friends). How to call: startSession()
function startSession() {
  open.value = false
  router.push('/sessions/new')
}
</script>

<template>
  <div>
  <button type="button" class="add-friends" aria-label="Add friends" title="Add friends" aria-haspopup="dialog" data-testid="add-friends" @click="open = true">
    <AppIcon name="user-plus" :size="20" />
  </button>
  <BottomSheet v-model:open="open" title="Add friends">
    <template v-if="auth.sampleWorld">
      <label class="find">
        <AppIcon name="search" :size="18" />
        <span class="sr-only">Search people</span>
        <input v-model="query" type="search" placeholder="Search by name or @username" autocomplete="off" data-testid="add-friends-search" />
      </label>
      <p v-if="!shown.length" class="body-md text-muted" data-testid="add-friends-none">You are friends with everyone on Jio here.</p>
      <p v-else-if="!results.length" class="body-md text-muted">Nobody matches “{{ query.trim() }}”.</p>
      <SuggestedFriends v-else :people="results" :accept-after="acceptAfter" data-testid="add-friends-list" @open="openProfile" @error="error = $event" />
      <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    </template>
    <div v-else class="stack gap-md" data-testid="add-friends-real">
      <p class="body-md">Your friends on Jio are the people you go out with. Start a session and invite someone by their username, and once they join you are friends.</p>
      <AppButton block @click="startSession">Start a session</AppButton>
    </div>
  </BottomSheet>
  </div>
</template>

<style scoped>
/* A white circle with the float shadow, as the buttons on the profile's banner, so it reads over the band and the map. */
.add-friends { display: inline-flex; align-items: center; justify-content: center; width: var(--tap-min); height: var(--tap-min); padding: 0; border: 1px solid var(--hairline); border-radius: var(--rounded-full); background: var(--canvas); box-shadow: var(--shadow-float); color: var(--ink); cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out); }
@media (hover: hover) { .add-friends:hover { background: var(--surface-soft); } }
.add-friends:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
/* The search box: the profile's pill search. */
.find { display: flex; align-items: center; gap: var(--spacing-sm); min-height: var(--tap-min); margin-bottom: var(--spacing-sm); padding: 0 var(--spacing-base); border: 1px solid var(--border-control); border-radius: var(--rounded-full); background: var(--canvas); color: var(--muted); }
.find:focus-within { border-color: var(--ink); box-shadow: 0 0 0 1px var(--ink); }
.find input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--ink); font: var(--text-body-md); outline: none; }
.find input::placeholder { color: var(--muted); }
@media (prefers-reduced-motion: reduce) { .add-friends { transition: none; } }
</style>
