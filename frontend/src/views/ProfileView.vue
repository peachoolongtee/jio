<script setup>
// Profiles.
//   Ian's own (/profile): a coloured header band, a large photo, name, home area, stat tiles for
//   successful meetups and points, and his sessions.
//   Another person's (/people/:id): the same header, their stats and "Recent activity".
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { format, parseISO } from 'date-fns'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import StatTile from '@/components/ui/StatTile.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import SessionCard from '@/components/event/SessionCard.vue'
import NotFoundView from './NotFoundView.vue'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'

const props = defineProps({ id: { type: String, default: '' } })

const router = useRouter()
const auth = useAuthStore()
const events = useEventsStore()
const groups = useGroupsStore()
const missing = ref(false)
const signOutOpen = ref(false)

const personId = computed(() => props.id || 'ian')
const isMe = computed(() => personId.value === 'ian')

async function load() {
  missing.value = false
  try {
    await Promise.all([groups.loadProfile(personId.value), groups.loadPeople(), isMe.value ? events.loadSessions() : null])
  } catch {
    missing.value = true
  }
}
onMounted(load)
watch(personId, load)

// Ian's own profile route is /profile; /people/ian goes there too.
watch(() => props.id, (id) => id === 'ian' && router.replace('/profile'), { immediate: true })

const person = computed(() => groups.profiles[personId.value])
const nameOf = (id) => (id === 'ian' ? auth.user.name : groups.nameOf(id))
const dateText = (d) => format(parseISO(d), 'd MMM yyyy')

async function signOut() {
  await auth.signOut()
  router.replace('/signup')
}
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else class="screen profile" data-testid="profile-view">
    <div class="profile__band">
      <IconButton v-if="!isMe" class="profile__back" label="Back" @click="router.back()"><AppIcon name="back" /></IconButton>
    </div>

    <template v-if="person">
      <header class="screen__header profile__head">
        <UserAvatar class="profile__avatar" :name="person.name" :src="person.photo" :size="96" labelled />
        <div class="screen__titles">
          <h1 class="display-xl">{{ person.name }}</h1>
          <p class="body-sm text-muted">@{{ person.username }} · <AppIcon name="pin" :size="12" class="profile__inline" /> {{ person.homeArea }}</p>
        </div>
        <div v-if="!isMe" class="row">
          <ChipButton check :selected="person.isFriend" @click="groups.setFriend(person.id, !person.isFriend).then(load)">
            {{ person.isFriend ? 'Friends' : 'Add friend' }}
          </ChipButton>
        </div>
      </header>

      <div class="screen__body">
        <div class="stats">
          <StatTile label="Successful meetups" :value="person.meetups" icon="trophy" />
          <StatTile label="Points" :value="person.points" icon="gift" tone="warm" />
        </div>

        <!-- Ian: his sessions -->
        <section v-if="isMe" class="section" aria-labelledby="my-sessions">
          <div class="section__head">
            <h2 id="my-sessions" class="display-sm">Sessions</h2>
            <AppButton variant="secondary" small to="/leaderboard">
              <AppIcon name="gift" />
              Rewards
            </AppButton>
          </div>
          <div v-if="!events.loaded" class="stack"><SkeletonRow v-for="n in 2" :key="n" :lines="3" /></div>
          <EmptyState v-else-if="!events.sessions.length" title="No sessions yet" text="Sessions you create show up here.">
            <AppButton variant="secondary" to="/sessions/new">Create session</AppButton>
          </EmptyState>
          <ul v-else class="grid-3">
            <li v-for="s in events.sessions" :key="s.id"><SessionCard :session="s" :names="nameOf" /></li>
          </ul>
        </section>

        <!-- Someone else: recent activity -->
        <section v-else class="section" aria-labelledby="activity-head">
          <h2 id="activity-head" class="display-sm">Recent activity</h2>
          <EmptyState v-if="!person.activity.length" title="No activity yet" />
          <ul v-else class="activity">
            <li v-for="(item, i) in person.activity" :key="i" class="activity__row">
              <span class="activity__icon"><AppIcon :name="item.text.startsWith('Redeemed') ? 'gift' : 'trophy'" :size="16" /></span>
              <span class="stack">
                <RouterLink v-if="item.sessionId" :to="`/sessions/${item.sessionId}/itinerary`" class="title-sm activity__link">{{ item.text }}</RouterLink>
                <span v-else class="title-sm">{{ item.text }}</span>
                <span class="caption-sm text-muted">{{ dateText(item.date) }}</span>
              </span>
            </li>
          </ul>
        </section>

        <AppButton v-if="isMe" variant="tertiary" underline class="profile__out" @click="signOutOpen = true">
          <AppIcon name="logout" />
          Sign out
        </AppButton>
      </div>
    </template>
    <div v-else class="screen__body"><SkeletonRow v-for="n in 3" :key="n" avatar /></div>

    <ModalDialog v-model:open="signOutOpen" title="Sign out?">
      <template #content><p class="body-md">This demo account and its sessions are removed</p></template>
      <AppButton block variant="secondary" @click="signOutOpen = false">Stay signed in</AppButton>
      <AppButton block variant="danger" @click="signOut">Sign out</AppButton>
    </ModalDialog>
  </main>
</template>

<style scoped>
.profile__band { position: relative; height: 136px; background: linear-gradient(135deg, var(--primary), var(--primary-active)); }
@media (min-width: 1128px) { .profile__band { margin: var(--spacing-lg) var(--gutter) 0; border-radius: var(--rounded-lg); } }
.profile__back { position: absolute; top: var(--spacing-md); left: var(--gutter); background: var(--canvas); }
.profile__head { position: relative; margin-top: -56px; }
.profile__avatar { border: 4px solid var(--canvas); box-shadow: var(--shadow-float); }
.profile__inline { display: inline-block; vertical-align: -1px; }
.stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); max-width: 560px; }
.activity { display: flex; flex-direction: column; }
.activity__row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 60px; border-bottom: 1px solid var(--hairline-soft); }
.activity__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: var(--rounded-full); background: var(--primary-tint); color: var(--primary-active); }
.activity__link { color: var(--ink); }
.profile__out { align-self: flex-start; }
</style>
