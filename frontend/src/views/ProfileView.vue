<script setup>
// Profiles.
//   Ian's own (/profile): a host card (large photo, name, home area, meetups and points), the meetup graph
//   and his sessions.
//   Another person's (/people/:id): the same card and graph, and "Recent activity".
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
import MeetupGraph from '@/components/ui/MeetupGraph.vue'
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
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton v-if="!isMe" label="Back" @click="router.back()"><AppIcon name="back" /></IconButton>
        <h1 v-else class="display-xl">Profile</h1>
      </div>
    </header>

    <template v-if="person">
      <div class="screen__body">
        <!-- The host card: who they are on the left, their numbers stacked on the right. -->
        <section class="host rise" aria-label="About">
          <div class="host__who">
            <UserAvatar class="host__avatar" :name="person.name" :src="person.photo" :size="104" labelled />
            <h2 class="display-md">{{ person.name }}</h2>
            <p class="caption-sm text-muted">@{{ person.username }}</p>
            <p class="caption-sm host__area"><AppIcon name="pin" :size="12" /> {{ person.homeArea }}</p>
          </div>
          <dl class="host__stats">
            <div class="host__stat">
              <dd class="display-md tnum">{{ person.meetups }}</dd>
              <dt class="caption-sm">Meetups</dt>
            </div>
            <div class="host__stat">
              <dd class="display-md tnum">{{ person.points }}</dd>
              <dt class="caption-sm">Points</dt>
            </div>
          </dl>
        </section>
        <ChipButton v-if="!isMe" check class="host__friend" :selected="person.isFriend" @click="groups.setFriend(person.id, !person.isFriend).then(load)">
          {{ person.isFriend ? 'Friends' : 'Add friend' }}
        </ChipButton>

        <section class="card graph-card rise" style="--i: 1" aria-labelledby="graph-head">
          <h2 id="graph-head" class="sr-only">Meetup frequency</h2>
          <MeetupGraph :history="person.history" :planned="person.planned" />
        </section>

        <!-- Ian: his sessions -->
        <section v-if="isMe" class="section" aria-labelledby="my-sessions">
          <div class="section__head">
            <h2 id="my-sessions" class="display-sm">Sessions</h2>
            <IconButton label="Rewards" to="/leaderboard"><AppIcon name="gift" /></IconButton>
          </div>
          <div v-if="!events.loaded" class="stack"><SkeletonRow v-for="n in 2" :key="n" :lines="3" /></div>
          <EmptyState v-else-if="!events.sessions.length" title="No sessions yet">
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
      <AppButton block variant="secondary" @click="signOutOpen = false">Stay signed in</AppButton>
      <AppButton block variant="danger" @click="signOut">Sign out</AppButton>
    </ModalDialog>
  </main>
</template>

<style scoped>
/* host-card: white, 14px corners, 24px padding, the one shadow tier. */
.host { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); align-items: center; gap: var(--spacing-lg); max-width: 640px; padding: var(--spacing-lg); border-radius: var(--rounded-lg); background: var(--canvas); box-shadow: var(--shadow-float); }
.host__who { display: flex; flex-direction: column; align-items: center; gap: var(--spacing-xxs); text-align: center; min-width: 0; }
.host__avatar { margin-bottom: var(--spacing-sm); }
.host__area { display: inline-flex; align-items: center; gap: var(--spacing-xs); color: var(--body); }
.host__stats { display: flex; flex-direction: column; margin: 0; }
.host__stat { display: flex; flex-direction: column; padding: var(--spacing-sm) 0; }
.host__stat + .host__stat { border-top: 1px solid var(--hairline); }
.host__stat dd { margin: 0; line-height: 1.2; }
.host__stat dt { color: var(--body); }
.host__friend { align-self: flex-start; }
.graph-card { max-width: 640px; overflow: hidden; padding: var(--spacing-base); }
.activity { display: flex; flex-direction: column; }
.activity__row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 60px; border-bottom: 1px solid var(--hairline-soft); }
.activity__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); }
.activity__link { color: var(--ink); }
.profile__out { align-self: flex-start; }
</style>
