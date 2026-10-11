<script setup>
// Profiles, across the whole page.
//   The top: a banner in the person's own colour (the same as their avatar and map pin), their avatar overlapping
//   it, name, @username and home area, and a strip of three numbers (meetups, season rank, JioCoins). Someone else's
//   also has "Add friend" / "Friends". Ian's own has no create button: the navbar has one.
//   Then the meetup graph, and Ian's sessions or the other person's recent activity.
//   Ian's own (/profile) has Sign out on the banner; someone else's (/people/:id) has Back and a "Sample data for
//   the demo" note, because other people's profiles are hand-written.
//   Signing out of a local account (one that lives only in this browser) erases everything saved here, so its dialog
//   says so. Signing out of a real account keeps its meetups on this device and the dialog says that instead. A local
//   account in a build with real accounts also gets a note saying it lives only in this browser. A person with no
//   season points has no rank: it reads "No rank yet".
//   Signing out empties the signed-in person while this screen is still drawn, so every read of the signed-in person
//   is guarded.
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { format, parseISO } from 'date-fns'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import CoinBadge from '@/components/ui/CoinBadge.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import GridPulse from '@/components/ui/GridPulse.vue'
import IconButton from '@/components/ui/IconButton.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import SampleNote from '@/components/ui/SampleNote.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import MeetupGraph from '@/components/ui/MeetupGraph.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import SessionCard from '@/components/event/SessionCard.vue'
import NotFoundView from './NotFoundView.vue'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'
import { personColour } from '@/lib/people.js'
import { visibleSessions } from '@/lib/sessionFilter.js'

const props = defineProps({ id: { type: String, default: '' } })

const router = useRouter()
const auth = useAuthStore()
const events = useEventsStore()
const groups = useGroupsStore()
const missing = ref(false)
const signOutOpen = ref(false)
// Which dialog was opened: 'real' (the account is kept, the meetups stay here) or 'local' (everything is erased). It is
// fixed when the dialog opens, because signing out empties the signed-in person while the dialog is still on screen.
const signOutKind = ref('local')
// A local account in a build where real accounts are on: it works, but only in this browser.
const localOnly = computed(() => auth.realAccounts && !!auth.user?.local)

// How to call: openSignOut()
function openSignOut() {
  signOutKind.value = auth.user && !auth.user.local ? 'real' : 'local'
  signOutOpen.value = true
}

const personId = computed(() => props.id || auth.myId)
const isMe = computed(() => personId.value === auth.myId)

async function load() {
  missing.value = false
  try {
    await Promise.all([groups.loadProfile(personId.value), groups.loadPeople(), groups.loadLeaderboard(), isMe.value ? events.loadSessions() : null])
  } catch {
    missing.value = true
  }
}
onMounted(load)
watch(personId, load)

// The signed-in person's own profile route is /profile; /people/<their id> goes there too.
watch(() => props.id, (id) => id === auth.myId && router.replace('/profile'), { immediate: true })

const person = computed(() => groups.profiles[personId.value])
// The sessions listed on your own profile: all of them, unless the demo tour is on (lib/sessionFilter.js).
const sessions = computed(() => visibleSessions(events.sessions))
const nameOf = (id) => (id === auth.myId ? auth.user?.name ?? '' : groups.nameOf(id))
const dateText = (d) => format(parseISO(d), 'd MMM yyyy')
const colour = computed(() => personColour(personId.value))
const rank = computed(() => groups.leaderboard.find((r) => r.id === personId.value)?.rank ?? null)
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
const friendBusy = ref(false)
async function toggleFriend() {
  friendBusy.value = true
  await groups.setFriend(person.value.id, !person.value.isFriend)
  await load()
  friendBusy.value = false
}

const signingOut = ref(false)
const signOutError = ref('')
async function signOut() {
  signingOut.value = true
  signOutError.value = ''
  try {
    // Rejects only when a real account's session could not be ended on this browser. Real accounts go to the login screen;
    // with local accounts only, there is nothing to log in to.
    const toLogin = auth.realAccounts
    await auth.signOut()
    await router.replace(toLogin ? '/login' : '/signup')
  } catch (err) {
    signOutError.value = err?.message || 'Could not sign out. Try again.'
  } finally {
    signingOut.value = false
  }
}
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else class="screen profile grid-page" data-testid="profile-view">
    <GridPulse class="page-grid" />
    <template v-if="person">
      <!-- The top: banner, avatar, who they are, three numbers and one action. -->
      <section class="hero" :style="{ '--pc': colour }" aria-label="About">
        <div class="hero__banner">
          <IconButton v-if="!isMe" label="Back" class="hero__btn hero__btn--left" @click="router.back()"><AppIcon name="back" /></IconButton>
          <IconButton v-else label="Sign out" class="hero__btn hero__btn--right" @click="openSignOut"><AppIcon name="logout" /></IconButton>
        </div>
        <div class="hero__body">
          <UserAvatar class="hero__avatar" :name="person.name" :src="person.photo" :person="person.id" :size="104" labelled />
          <div class="hero__grid">
            <div class="hero__who">
              <h1 class="hero__name" data-grid-avoid>{{ person.name }}<span v-if="isMe" class="hero__you caption">You</span></h1>
              <p class="body-md text-muted">@{{ person.username }}<template v-if="person.homeArea"> · {{ person.homeArea }}</template></p>
              <SampleNote v-if="person.sample" />
            </div>
            <div class="hero__side">
              <dl class="stats">
                <div class="stats__item">
                  <dt class="caption-sm">Meetups</dt>
                  <dd class="stats__value tnum"><AppIcon name="people" :size="18" />{{ person.meetups }}</dd>
                </div>
                <div class="stats__item">
                  <dt class="caption-sm">Season rank</dt>
                  <dd class="stats__value tnum" :class="{ 'stats__value--none': rank == null }"><AppIcon name="trophy" :size="18" />{{ rank == null ? 'No rank yet' : ordinal(rank) }}</dd>
                </div>
                <div class="stats__item">
                  <dt class="caption-sm">Balance</dt>
                  <dd class="stats__value tnum"><CoinBadge :size="18" />{{ person.points }}</dd>
                </div>
              </dl>
              <AppButton v-if="!isMe && auth.sampleWorld" block :variant="person.isFriend ? 'secondary' : 'primary'" :disabled="friendBusy" :aria-pressed="String(person.isFriend)" @click="toggleFriend">
                <AppIcon :name="person.isFriend ? 'check' : 'plus'" />
                {{ person.isFriend ? 'Friends' : 'Add friend' }}
              </AppButton>
            </div>
          </div>
        </div>
      </section>

      <div class="screen__body">
        <BannerNote v-if="isMe && localOnly" data-testid="local-account-note">This account lives only in this browser. Signing out erases it, and you cannot log in to it from another device.</BannerNote>
        <section class="card graph-card rise" style="--i: 1" aria-labelledby="graph-head">
          <h2 id="graph-head" class="sr-only">Meetup frequency</h2>
          <MeetupGraph :history="person.history" :planned="person.planned" />
        </section>

        <!-- The signed-in person: their sessions, once they have some. -->
        <section v-if="isMe && (!events.loaded || sessions.length)" class="section" aria-labelledby="my-sessions">
          <div class="section__head">
            <h2 id="my-sessions" class="display-sm">Sessions</h2>
          </div>
          <div v-if="!events.loaded" class="stack"><SkeletonRow v-for="n in 2" :key="n" :lines="3" /></div>
          <ul v-else class="grid-3">
            <li v-for="s in sessions" :key="s.id"><SessionCard :session="s" :names="nameOf" /></li>
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
      </div>
    </template>
    <div v-else class="screen__body profile__loading"><SkeletonRow v-for="n in 3" :key="n" avatar /></div>

    <ModalDialog v-model:open="signOutOpen" :title="signOutKind === 'real' ? 'Sign out?' : 'Erase everything and sign out?'">
      <template #content>
        <p v-if="signOutKind === 'real'" class="body-md">Your meetups, votes and points stay in this browser. Log in here again to get them back. They are not saved to your account yet, so another device will not have them.</p>
        <p v-else class="body-md">Signing out erases everything saved in this browser: your account, meetups, votes and points. There is no way to sign back in to get it back.</p>
        <p v-if="signOutError" class="body-sm text-error" role="alert">{{ signOutError }}</p>
      </template>
      <AppButton block variant="secondary" @click="signOutOpen = false">Stay signed in</AppButton>
      <AppButton block :variant="signOutKind === 'real' ? 'primary' : 'danger'" :disabled="signingOut" @click="signOut">{{ signOutKind === 'real' ? 'Sign out' : 'Erase and sign out' }}</AppButton>
    </ModalDialog>
  </main>
</template>

<style scoped>
/* ── The top ── */
.hero { margin-bottom: var(--spacing-lg); }
/* The banner: the person's colour, deep at one corner and light at the other, with two soft shapes for depth. */
.hero__banner { position: relative; height: clamp(150px, 26vw, 240px); background:
  radial-gradient(60% 120% at 85% 0%, color-mix(in srgb, var(--pc) 35%, white) 0%, transparent 60%),
  radial-gradient(45% 90% at 10% 100%, color-mix(in srgb, var(--pc) 70%, black) 0%, transparent 70%),
  linear-gradient(135deg, color-mix(in srgb, var(--pc) 80%, black), var(--pc) 55%, color-mix(in srgb, var(--pc) 60%, white)); }
@media (min-width: 744px) { .hero__banner { margin: var(--spacing-base) var(--gutter) 0; border-radius: var(--rounded-lg); } }
.hero__btn { position: absolute; top: var(--spacing-base); background: color-mix(in srgb, var(--canvas) 85%, transparent); box-shadow: var(--shadow-float); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
.hero__btn--left { left: var(--spacing-base); }
.hero__btn--right { right: var(--spacing-base); }
.hero__body { display: flex; flex-direction: column; gap: var(--spacing-base); padding: 0 var(--gutter); }
@media (min-width: 744px) { .hero__body { padding: 0 calc(var(--gutter) + var(--spacing-lg)); } }
/* The avatar overlaps the banner's bottom edge, ringed in white. */
.hero__avatar { position: relative; z-index: 1; margin-top: -52px; box-shadow: 0 0 0 4px var(--canvas), var(--shadow-float); }
.hero__grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--spacing-lg); }
@media (min-width: 1128px) { .hero__grid { grid-template-columns: minmax(0, 1fr) minmax(0, 460px); align-items: start; } }
.hero__who { display: flex; flex-direction: column; gap: var(--spacing-xxs); min-width: 0; }
.hero__who p { margin: 0; }
.hero__name { display: flex; align-items: center; gap: var(--spacing-sm); margin: 0; font: var(--text-display-xl); overflow-wrap: anywhere; }
.hero__you { padding: 2px var(--spacing-sm); border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--muted); font-weight: 600; }
.hero__side { display: flex; flex-direction: column; gap: var(--spacing-md); }

/* Three numbers in a bordered strip, split by thin lines. */
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; padding: var(--spacing-md) 0; border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.stats__item { display: flex; flex-direction: column; align-items: center; gap: var(--spacing-xxs); padding: 0 var(--spacing-sm); text-align: center; }
.stats__item + .stats__item { border-left: 1px solid var(--hairline); }
.stats__value { display: inline-flex; align-items: center; gap: 6px; margin: 0; color: var(--ink); font: var(--text-display-sm); }
.stats__value :deep(svg) { color: var(--pc); }
.stats__value--none { font: var(--text-title-md); }
/* The label comes first in the markup (for screen readers) and shows under its number. */
.stats__item dt { order: 2; color: var(--muted); }
.stats__item dd { order: 1; }

.graph-card { overflow: hidden; padding: var(--spacing-base); }
.activity { display: flex; flex-direction: column; }
.activity__row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 60px; border-bottom: 1px solid var(--hairline-soft); }
.activity__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); }
.activity__link { color: var(--ink); }
.profile__loading { padding-top: var(--spacing-xl); }
</style>
