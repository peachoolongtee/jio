<script setup>
// Profiles, across the whole page.
//   The top: a banner in the person's own colour (the same as their avatar and map pin), their avatar overlapping
//   it, name, @username and home area, and a strip of three numbers (meetups, season rank, JioCoins). Someone else's
//   also has "Add friend" / "Friends" under the numbers (in the sample world only); the signed-in person's own has
//   "Edit profile" there (/profile/edit), and nobody else's does. The signed-in person's own
//   has no create button: the navbar has one.
//   Someone else's also has one line under the name, "3 outings together · last on 12 Oct 2026", when the two of them have been out
//   together (lib/hangouts.js outingsWith: finished outings with both in them, as the invite page counts them); with none, no line.
//   Then the meetup graph, and the signed-in person's sessions or the other person's recent activity. The sessions have
//   time chips, All, Upcoming and Completed (lib/profileSessions.js), styled like the ones on Rewards. The signed-in
//   person's own also lists their Friends (for a real account, the people they have shared a session with; the first six, and
//   "Show N more" for the rest; a friend they have been out with has the count of outings together beside the name), then
//   Suggested people (anyone they are not friends with yet), each opening their profile, with "Add friend" in the sample world. These used to be on the invite page, which now shows friends only (ticket #121).
//   The signed-in person's own (/profile) has Sign out on the banner; someone else's (/people/:id) has Back and a "Sample data for
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
import OutingsTogether from '@/components/group/OutingsTogether.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
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
import { outingsTogether, outingsWith, togetherLine } from '@/lib/hangouts.js'
import { personColour } from '@/lib/people.js'
import { visibleSessions } from '@/lib/sessionFilter.js'
import { EMPTY_TEXT, SESSION_FILTERS, profileSessions } from '@/lib/profileSessions.js'
import { useNow } from '@/lib/useNow.js'
import { vRadioGroup } from '@/lib/radioGroup.js'

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
    // The sessions are read on someone else's profile too, for the outings together; a failed read there only leaves that line out.
    // The sessions are read once: a profile opened again, or another person's after it, uses the list already read.
    const sessionsRead = events.loaded ? null : isMe.value ? events.loadSessions() : events.loadSessions().catch(() => null)
    await Promise.all([groups.loadProfile(personId.value), groups.loadPeople(), groups.loadLeaderboard(), sessionsRead])
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
// The time chip chosen, and the sessions it shows in its order. The clock moves a session to the top while it is live.
const sessionFilter = ref('all')
const now = useNow()
const shownSessions = computed(() => profileSessions(sessions.value, sessionFilter.value, now.value))
const nameOf = (id) => (id === auth.myId ? auth.user?.name ?? '' : groups.nameOf(id))
const dateText = (d) => format(parseISO(d), 'd MMM yyyy')
// Outings together: with each friend (beside their name in Friends), and with the person whose profile this is (the line under the name).
const togetherCounts = computed(() => (isMe.value ? outingsTogether(sessions.value, auth.myId) : {}))
const togetherWithThem = computed(() => (!isMe.value && auth.myId ? outingsWith(sessions.value, auth.myId, personId.value) : { count: 0, last: null }))
const togetherSentence = computed(() => togetherLine(togetherWithThem.value.count, togetherWithThem.value.last ? dateText(togetherWithThem.value.last) : ''))
const colour = computed(() => personColour(personId.value))
const rank = computed(() => groups.leaderboard.find((r) => r.id === personId.value)?.rank ?? null)
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
// The signed-in person's friends: the ones they added (the demo and local accounts), or the people they have shared a session
// with (a real account, ticket #125).
// Six show, as with Suggested below; "Show N more" opens the rest, and "Show fewer" closes them again.
const FRIENDS_SHOWN = 6
const allFriends = computed(() => (isMe.value ? groups.friends : []))
const showAllFriends = ref(false)
const friends = computed(() => (showAllFriends.value ? allFriends.value : allFriends.value.slice(0, FRIENDS_SHOWN)))
// People the signed-in person could add, at most six.
const suggested = computed(() => (isMe.value ? groups.suggested.slice(0, 6) : []))
const adding = ref('')
// How to call: addFriend('faith')
async function addFriend(id) {
  adding.value = id
  try {
    await groups.setFriend(id, true)
  } finally {
    adding.value = ''
  }
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
              <p v-if="togetherSentence" class="body-md" data-testid="outings-together-line">{{ togetherSentence }}</p>
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
              <AppButton v-else-if="isMe" block variant="secondary" to="/profile/edit" data-testid="edit-profile">
                <AppIcon name="edit" />
                Edit profile
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

        <!-- The signed-in person: their friends, opening each one's profile. -->
        <section v-if="allFriends.length" class="section" aria-labelledby="friends-head" data-testid="profile-friends">
          <div class="section__head">
            <h2 id="friends-head" class="display-sm">Friends</h2>
          </div>
          <ul class="suggested">
            <li v-for="p in friends" :key="p.id" class="suggested__row">
              <RouterLink :to="`/people/${p.id}`" class="suggested__who">
                <UserAvatar :name="p.name" :src="p.photo" :person="p.id" :size="44" />
                <span class="stack suggested__text">
                  <span class="suggested__name">
                    <span class="title-sm truncate">{{ p.name }}</span>
                    <OutingsTogether :count="togetherCounts[p.id]" />
                  </span>
                  <span class="caption-sm text-muted truncate">@{{ p.username }}<template v-if="p.homeArea"> · {{ p.homeArea }}</template></span>
                </span>
              </RouterLink>
            </li>
          </ul>
          <AppButton v-if="allFriends.length > FRIENDS_SHOWN" variant="tertiary" underline :aria-expanded="String(showAllFriends)" data-testid="profile-friends-more" @click="showAllFriends = !showAllFriends">
            {{ showAllFriends ? 'Show fewer friends' : `Show ${allFriends.length - FRIENDS_SHOWN} more` }}
          </AppButton>
        </section>

        <!-- The signed-in person: people they could add, opening each one's profile. -->
        <section v-if="suggested.length" class="section" aria-labelledby="suggested-head" data-testid="suggested-people">
          <div class="section__head">
            <h2 id="suggested-head" class="display-sm">Suggested</h2>
          </div>
          <ul class="suggested">
            <li v-for="p in suggested" :key="p.id" class="suggested__row">
              <RouterLink :to="`/people/${p.id}`" class="suggested__who">
                <UserAvatar :name="p.name" :src="p.photo" :person="p.id" :size="44" />
                <span class="stack suggested__text">
                  <span class="title-sm truncate">{{ p.name }}</span>
                  <span class="caption-sm text-muted truncate">@{{ p.username }}<template v-if="p.homeArea"> · {{ p.homeArea }}</template></span>
                </span>
              </RouterLink>
              <AppButton v-if="auth.sampleWorld" small variant="secondary" :disabled="adding === p.id" :aria-label="`Add ${p.name} as a friend`" @click="addFriend(p.id)">
                <AppIcon name="plus" :size="16" />Add friend
              </AppButton>
            </li>
          </ul>
        </section>

        <!-- The signed-in person: their sessions, once they have some. -->
        <section v-if="isMe && (!events.loaded || sessions.length)" class="section" aria-labelledby="my-sessions">
          <div class="section__head">
            <h2 id="my-sessions" class="display-sm">Sessions</h2>
          </div>
          <div v-if="!events.loaded" class="stack"><SkeletonRow v-for="n in 2" :key="n" :lines="3" /></div>
          <template v-else>
            <div class="scroll-x session-filters" role="radiogroup" v-radio-group aria-label="Show sessions">
              <ChipButton v-for="f in SESSION_FILTERS" :key="f.id" radio :selected="sessionFilter === f.id" @click="sessionFilter = f.id">{{ f.label }}</ChipButton>
            </div>
            <p v-if="!shownSessions.length" class="body-md text-muted">{{ EMPTY_TEXT[sessionFilter] }}</p>
            <ul v-else class="grid-3">
              <li v-for="s in shownSessions" :key="s.id"><SessionCard :session="s" :names="nameOf" /></li>
            </ul>
          </template>
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
/* The time chips above the Sessions grid, spaced as the filters on Rewards. */
.session-filters { margin-bottom: var(--spacing-base); }
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
.suggested { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--spacing-xs) var(--spacing-lg); margin: 0; padding: 0; list-style: none; }
@media (min-width: 744px) { .suggested { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.suggested__row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 68px; border-bottom: 1px solid var(--hairline-soft); }
.suggested__who { display: flex; flex: 1; align-items: center; gap: var(--spacing-md); min-width: 0; color: var(--ink); text-decoration: none; }
.suggested__text { min-width: 0; gap: 0; }
.suggested__name { display: flex; align-items: center; gap: var(--spacing-xs); min-width: 0; }
</style>
