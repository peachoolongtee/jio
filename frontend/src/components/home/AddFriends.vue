<script setup>
// "Add friends" on Home (walkthrough, 30 October 2026): a round people button in the band's top corner (top left on phones, opposite
// the avatar; top right from 744px, where the avatar is in the top bar) that opens a sheet for finding people on Jio and adding them,
// the same people as the profile's Suggested.
//   <AddFriends />   or, in a test, <AddFriends :accept-after="50" />
// The demo and local accounts: a search box (name or @username) over everyone they are not friends with yet, each row opening that
// person's profile, with "Add friend". Pressing it sends a friend request (lib/friendRequests.js, shared with the profile's Suggested):
// the button reads "Requested" with a clock, and after `acceptAfter` (2 s) the person accepts, the row reads "Friends" with a tick, and
// they are a friend. A polite status line says "Friend request sent to Kai", then "Kai accepted your friend request". The acceptance
// still happens if the sheet is closed meanwhile. The row stays until the sheet closes, so the list does not jump under the finger. A real account's friends are the people it has been out with (CLAUDE.md, ticket #125), and a
// list of its own would need a table on the server, so its sheet says how people become friends and offers to start a session.
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import BottomSheet from '../ui/BottomSheet.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import { FRIEND_ACCEPT_MS, sendFriendRequest, useFriendRequests } from '@/lib/friendRequests.js'
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
// Requests waiting (from here or the profile) and the status line's words.
const { requested, announcement } = useFriendRequests()
// Friends now, from the store, so a request answered anywhere shows here.
const isFriend = (id) => !!groups.people.find((p) => p.id === id)?.isFriend
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

// Sends a friend request, which the person accepts after `acceptAfter`; then they are a friend. How to call: add({ id: 'kai', name: 'Kai' })
function add(person) {
  error.value = ''
  sendFriendRequest(person, groups.setFriend, { after: props.acceptAfter, onFailed: (message) => (error.value = message) })
}

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
      <ul v-else class="people" data-testid="add-friends-list">
        <li v-for="p in results" :key="p.id" class="people__row">
          <button type="button" class="people__who" @click="openProfile(p.id)">
            <UserAvatar :name="p.name" :src="p.photo" :person="p.id" :size="44" />
            <span class="stack people__text">
              <span class="title-sm truncate">{{ p.name }}</span>
              <span class="caption-sm text-muted truncate">@{{ p.username }}<template v-if="p.homeArea"> · {{ p.homeArea }}</template></span>
            </span>
          </button>
          <span v-if="isFriend(p.id)" class="people__done caption" data-testid="friend-added"><AppIcon name="check" :size="14" />Friends</span>
          <span v-else-if="requested.has(p.id)" class="people__pending caption" data-testid="friend-requested"><AppIcon name="clock" :size="14" />Requested</span>
          <AppButton v-else small variant="secondary" :aria-label="`Add ${p.name} as a friend`" @click="add(p)"><AppIcon name="plus" :size="16" />Add friend</AppButton>
        </li>
      </ul>
      <p class="sr-only" role="status" data-testid="add-friends-status">{{ announcement }}</p>
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
/* One row per person, as the profile's Suggested: who they are (opening their profile), then Add friend. */
.people { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.people__row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 68px; border-bottom: 1px solid var(--hairline-soft); }
.people__who { display: flex; flex: 1; align-items: center; gap: var(--spacing-md); min-width: 0; min-height: var(--tap-min); padding: 0; border: 0; background: transparent; color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.people__who:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: var(--rounded-sm); }
.people__text { min-width: 0; gap: 0; }
.people__pending { display: inline-flex; align-items: center; gap: var(--spacing-xs); min-height: 36px; padding: 0 var(--spacing-md); border: 1px dashed var(--border-strong); border-radius: var(--rounded-full); color: var(--muted); }
.people__done { display: inline-flex; align-items: center; gap: var(--spacing-xs); padding: 0 var(--spacing-sm); color: var(--ink); font-weight: 600; }
@media (prefers-reduced-motion: reduce) { .add-friends { transition: none; } }
</style>
