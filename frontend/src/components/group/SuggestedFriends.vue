<script setup>
// "Suggested friends" in a sheet (walkthrough, 30 October 2026): Home's "Add friends" and the profile's Friends sheet. A heading, then a
// row per person (44px avatar, name, @username and area) that opens their profile, and on the right a round button with no words that
// sends a friend request (lib/friendRequests.js, accepted after 2 s):
//   red with a plus     "Add Kai as a friend"
//   dashed with a clock "Friend request sent to Kai" (waiting)
//   ink with a tick     "Kai is your friend" (accepted)
// The button's name says the state, and a polite status line says each change. `people` is the list as the sheet froze it when it
// opened, so a person just added stays on it, marked, until the sheet closes.
//   <SuggestedFriends :people="list" @open="(id) => router.push(`/people/${id}`)" />
import { useId } from 'vue'
import AppIcon from '../ui/AppIcon.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import { FRIEND_ACCEPT_MS, sendFriendRequest, useFriendRequests } from '@/lib/friendRequests.js'
import { useGroupsStore } from '@/stores/groups.js'

const props = defineProps({
  people: { type: Array, required: true },
  title: { type: String, default: 'Suggested friends' },
  // How long the other person takes to accept, in ms (shorter in tests).
  acceptAfter: { type: Number, default: FRIEND_ACCEPT_MS },
})
const emit = defineEmits(['open', 'error'])

const groups = useGroupsStore()
const { requested, announcement } = useFriendRequests()
const headId = `suggested-${useId()}`
// Friends now, from the store, so a request answered anywhere shows here.
const isFriend = (id) => !!groups.people.find((p) => p.id === id)?.isFriend
// How to call: add({ id: 'kai', name: 'Kai' })
function add(person) {
  emit('error', '')
  sendFriendRequest(person, groups.setFriend, { after: props.acceptAfter, onFailed: (message) => emit('error', message) })
}
</script>

<template>
  <section class="suggested-friends" :aria-labelledby="headId" data-testid="suggested-friends">
    <h3 :id="headId" class="caption text-muted suggested-friends__head">{{ title }}</h3>
    <ul class="suggested-friends__list">
      <li v-for="p in people" :key="p.id" class="suggested-friends__row">
        <button type="button" class="suggested-friends__who" @click="emit('open', p.id)">
          <UserAvatar :name="p.name" :src="p.photo" :person="p.id" :size="44" />
          <span class="stack suggested-friends__text">
            <span class="title-sm truncate">{{ p.name }}</span>
            <span class="caption-sm text-muted truncate">@{{ p.username }}<template v-if="p.homeArea"> · {{ p.homeArea }}</template></span>
          </span>
        </button>
        <span v-if="isFriend(p.id)" class="friend-btn friend-btn--done" role="img" :aria-label="`${p.name} is your friend`" data-testid="friend-added"><AppIcon name="check" :size="18" /></span>
        <span v-else-if="requested.has(p.id)" class="friend-btn friend-btn--waiting" role="img" :aria-label="`Friend request sent to ${p.name}`" data-testid="friend-requested"><AppIcon name="clock" :size="18" /></span>
        <button v-else type="button" class="friend-btn friend-btn--add" :aria-label="`Add ${p.name} as a friend`" :title="`Add ${p.name} as a friend`" @click="add(p)"><AppIcon name="plus" :size="20" /></button>
      </li>
    </ul>
    <p class="sr-only" role="status" data-testid="add-friends-status">{{ announcement }}</p>
  </section>
</template>

<style scoped>
.suggested-friends { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.suggested-friends__head { margin: 0; }
.suggested-friends__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.suggested-friends__row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 68px; border-bottom: 1px solid var(--hairline-soft); }
.suggested-friends__who { display: flex; flex: 1; align-items: center; gap: var(--spacing-md); min-width: 0; min-height: var(--tap-min); padding: 0; border: 0; background: transparent; color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.suggested-friends__who:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: var(--rounded-sm); }
.suggested-friends__text { min-width: 0; gap: 0; }
/* The round button: 44px, so it is a full tap target. The white plus on --primary is an icon, which needs 3:1 (it is 3.5:1). */
.friend-btn { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: var(--tap-min); height: var(--tap-min); padding: 0; border-radius: var(--rounded-full); }
.friend-btn--add { border: 0; background: var(--primary); color: var(--on-primary); cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out), transform 260ms var(--ease-spring); }
@media (hover: hover) { .friend-btn--add:hover { background: var(--primary-active); } }
.friend-btn--add:active { transform: scale(0.92); }
.friend-btn--add:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.friend-btn--waiting { border: 1px dashed var(--border-strong); background: var(--canvas); color: var(--muted); }
.friend-btn--done { border: 0; background: var(--selected); color: var(--on-selected); }
@media (prefers-reduced-motion: reduce) { .friend-btn--add { transition: none; } .friend-btn--add:active { transform: none; } }
</style>
