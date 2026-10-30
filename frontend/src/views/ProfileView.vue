<script setup>
// Profiles, across the whole page.
//   The top: a banner in the person's own colour (the same as their avatar and map pin), their avatar overlapping
//   it, name, @username and home area, and a strip of three numbers (meetups, season rank, JioCoins). Someone else's
//   also has "Add friend" / "Friends" under the numbers (in the sample world only); the signed-in person's own has
//   "Edit profile" there (/profile/edit), and nobody else's does. The signed-in person's own
//   has no create button: the navbar has one.
//   Then the meetup graph, and the signed-in person's sessions or the other person's recent activity. The sessions have
//   time chips, All, Upcoming and Completed (lib/profileSessions.js), styled like the ones on Rewards, and a search box that
//   narrows them by title or meeting area. Clicking a day on the graph shows only that day's sessions (or, on someone else's
//   profile, that day's activity) and picks All, so the day is never hidden by a chip; the day shows as a chip with a × above the
//   list, and the × (or clicking the same day again) brings the whole list back (walkthrough, 30 October 2026). The signed-in
//   person's own also lists their Friends (for a real account, the people they have shared a session with; the first six, and
//   "Show N more" for the rest), then
//   Suggested people (anyone they are not friends with yet), each opening their profile, with "Add friend" in the sample world. These used to be on the invite page, which now shows friends only (ticket #121).
//   The signed-in person's own (/profile) has Sign out on the banner; someone else's (/people/:id) has Back and a "Sample data for
//   the demo" note, because other people's profiles are hand-written.
//   Signing out of a local account (one that lives only in this browser) erases everything saved here, so its dialog
//   says so. Signing out of a real account keeps its meetups on this device and the dialog says that instead. The profile
//   itself carries no note about a local account (removed at the lead's walkthrough, 30 October 2026). A person with no
//   season points has no rank: it reads "No rank yet".
//   Signing out empties the signed-in person while this screen is still drawn, so every read of the signed-in person
//   is guarded.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { format, parseISO } from 'date-fns'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
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
import { personColour } from '@/lib/people.js'
import { visibleSessions } from '@/lib/sessionFilter.js'
import { EMPTY_TEXT, SESSION_FILTERS, narrowSessions, narrowedEmptyText, profileSessions } from '@/lib/profileSessions.js'
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
// The time chip chosen, and the sessions it shows in its order. The clock moves a session to the top while it is live.
const sessionFilter = ref('all')
const now = useNow()
// What was typed in the search box, and the day picked on the graph ('yyyy-MM-dd' or '').
const query = ref('')
const day = ref('')
const narrowing = computed(() => !!query.value.trim() || !!day.value)
const shownSessions = computed(() => narrowSessions(profileSessions(sessions.value, sessionFilter.value, now.value), { query: query.value, day: day.value }, now.value))
const shownActivity = computed(() => narrowSessions(person.value?.activity || [], { day: day.value }, now.value))
const dayText = (d) => format(parseISO(d), 'EEE d MMM yyyy')
const emptyText = computed(() => (narrowing.value ? narrowedEmptyText({ query: query.value, day: day.value }, dayText) : EMPTY_TEXT[sessionFilter.value]))
// A day picked on the graph, or null when the same day was picked again. Picking a day shows All, so a past day is not hidden
// by Upcoming. How to call: pickDay('2026-09-11')
// The list sits under Friends and Suggested on your own profile, so a picked day brings its heading into view (at once under reduced motion).
async function pickDay(picked) {
  day.value = picked || ''
  if (!picked) return
  sessionFilter.value = 'all'
  await nextTick()
  const head = typeof document !== 'undefined' ? document.getElementById(isMe.value ? 'my-sessions' : 'activity-head') : null
  const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  head?.scrollIntoView?.({ behavior: still ? 'auto' : 'smooth', block: 'start' })
}
// The day goes when another person's profile opens.
watch(personId, () => { day.value = ''; query.value = '' })
const nameOf = (id) => (id === auth.myId ? auth.user?.name ?? '' : groups.nameOf(id))
const dateText = (d) => format(parseISO(d), 'd MMM yyyy')
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
        <section class="card graph-card rise" style="--i: 1" aria-labelledby="graph-head">
          <h2 id="graph-head" class="sr-only">Meetup frequency</h2>
          <MeetupGraph :history="person.history" :planned="person.planned" :selected="day" @select="pickDay" />
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
                  <span class="title-sm truncate">{{ p.name }}</span>
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
            <div class="session-filters">
              <div class="scroll-x" role="radiogroup" v-radio-group aria-label="Show sessions">
                <ChipButton v-for="f in SESSION_FILTERS" :key="f.id" radio :selected="sessionFilter === f.id" @click="sessionFilter = f.id">{{ f.label }}</ChipButton>
              </div>
              <label class="session-search">
                <AppIcon name="search" :size="18" />
                <span class="sr-only">Search sessions</span>
                <input v-model="query" type="search" placeholder="Search by title or area" autocomplete="off" data-testid="session-search" />
              </label>
            </div>
            <p v-if="day" class="day-filter">
              <button type="button" class="day-chip caption" data-testid="day-filter" :aria-label="`Show every day, not only ${dayText(day)}`" @click="day = ''">
                <AppIcon name="calendar" :size="14" />{{ dayText(day) }}<AppIcon name="close" :size="14" />
              </button>
            </p>
            <p class="sr-only" role="status">{{ day ? `Showing ${dayText(day)} only` : '' }}</p>
            <p v-if="!shownSessions.length" class="body-md text-muted" data-testid="sessions-empty">{{ emptyText }}</p>
            <ul v-else class="grid-3">
              <li v-for="s in shownSessions" :key="s.id"><SessionCard :session="s" :names="nameOf" /></li>
            </ul>
          </template>
        </section>

        <!-- Someone else: recent activity -->
        <section v-else class="section" aria-labelledby="activity-head">
          <h2 id="activity-head" class="display-sm">Recent activity</h2>
          <p v-if="day" class="day-filter">
            <button type="button" class="day-chip caption" data-testid="day-filter" :aria-label="`Show every day, not only ${dayText(day)}`" @click="day = ''">
              <AppIcon name="calendar" :size="14" />{{ dayText(day) }}<AppIcon name="close" :size="14" />
            </button>
          </p>
          <EmptyState v-if="!person.activity.length" title="No activity yet" />
          <p v-else-if="!shownActivity.length" class="body-md text-muted" data-testid="activity-empty">No activity on {{ dayText(day) }}</p>
          <ul v-else class="activity">
            <li v-for="(item, i) in shownActivity" :key="i" class="activity__row">
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
/* The time chips and the search box above the Sessions grid, spaced as the filters on Rewards: one row from tablet up, the
   search under the chips on phones. */
.session-filters { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--spacing-sm) var(--spacing-md); margin-bottom: var(--spacing-base); }
.session-filters .scroll-x { min-width: 0; flex: 1 1 auto; }
.session-search { display: flex; flex: 1 1 260px; align-items: center; gap: var(--spacing-sm); max-width: 360px; min-height: var(--tap-min); padding: 0 var(--spacing-base); border: 1px solid var(--border-control); border-radius: var(--rounded-full); background: var(--canvas); color: var(--muted); }
@media (max-width: 743.98px) { .session-search { max-width: none; } }
.session-search:focus-within { border-color: var(--ink); box-shadow: 0 0 0 1px var(--ink); }
.session-search input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--ink); font: var(--text-body-md); outline: none; }
.session-search input::placeholder { color: var(--muted); }
/* The headings a picked day scrolls to, clear of the top bar. */
#my-sessions, #activity-head { scroll-margin-top: calc(var(--topbar-real-height) + var(--spacing-base)); }
/* The day picked on the graph: an ink chip, like a selected one, whose × lets it go. 44px tall to tap. */
.day-filter { margin: 0 0 var(--spacing-base); }
.day-chip { display: inline-flex; align-items: center; gap: var(--spacing-xs); min-height: var(--tap-min); padding: 0 var(--spacing-md); border: 0; border-radius: var(--rounded-full); background: var(--selected); color: var(--on-selected); cursor: pointer; }
.day-chip:hover { background: var(--body); }
.day-chip:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
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
</style>
