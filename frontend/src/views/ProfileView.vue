<script setup>
// Profiles, across the whole page.
//   The top: a banner in the person's own colour (the same as their avatar and map pin), their avatar overlapping
//   it, name, @username and home area, and a strip of three numbers (meetups, season rank, JioCoins). Someone else's
//   also has "Add friend" / "Friends" under the numbers (in the sample world only); the signed-in person's own has
//   "Edit profile" there (/profile/edit), and nobody else's does. The signed-in person's own
//   has no create button: the navbar has one.
//   Someone else's also has one line under the name, "3 outings together · last on 12 Oct 2026", when the two of them have been out
//   together (lib/hangouts.js outingsWith: finished outings with both in them, as the invite page counts them); with none, no line.
//   The strip of numbers also has Friends (walkthrough, 30 October 2026, as Instagram's followers): pressing it opens a sheet listing
//   them, each opening their profile. On someone else's profile in a real account it is the friends in common, since another person's
//   friends cannot be read (lib/api.js friendsOf). The signed-in person's friends used to be a section of the page; the sheet replaced it,
//   and a friend they have been out with has the count of outings together beside the name there.
//   Then the meetup graph, and the signed-in person's sessions (in the demo, with sample past outings behind the graph's made-up bars).
//   A friend's profile lists a friend's sessions the same way (Faith, 4 November 2026): in the sample world their sample outings too, and
//   for a real account the sessions the two of them are in, the only ones it can read. A stranger's lists none: their graph shows how often
//   they go out, a day cannot be picked on it, and nothing is listed under it. The sessions have
//   time chips, All, Upcoming and Completed (lib/profileSessions.js), styled like the ones on Rewards, and a search box that
//   narrows them by title or meeting area. Clicking a day on the graph shows only that day's sessions and picks All, so the day is never hidden by a chip; the day shows as a chip with a × above the
//   list, and the × (or clicking the same day again) brings the whole list back (walkthrough, 30 October 2026). The signed-in
//   person's own has no Suggested section on the page any more (walkthrough, 30 October 2026): people to add are in the Friends sheet,
//   under your friends, and in Home's "Add friends", with a round red button that sends a friend request.
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
import BottomSheet from '@/components/ui/BottomSheet.vue'
import OutingsTogether from '@/components/group/OutingsTogether.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import CoinBadge from '@/components/ui/CoinBadge.vue'
import GridPulse from '@/components/ui/GridPulse.vue'
import IconButton from '@/components/ui/IconButton.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import SampleNote from '@/components/ui/SampleNote.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import MeetupGraph from '@/components/ui/MeetupGraph.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import SessionCard from '@/components/event/SessionCard.vue'
import SuggestedFriends from '@/components/group/SuggestedFriends.vue'
import NotFoundView from './NotFoundView.vue'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'
import { outingsTogether, outingsWith, togetherLine } from '@/lib/hangouts.js'
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
// Your sessions, and in the demo the sample past outings behind the graph's made-up bars (cards that open nothing).
const sessions = computed(() => [...visibleSessions(events.sessions), ...(isMe.value ? person.value?.pastSamples || [] : [])])
// Whose sessions this page may list: your own and a friend's, never a stranger's.
const seesSessions = computed(() => isMe.value || !!person.value?.isFriend)
// The sessions listed here: yours, or the ones a friend joined with their sample outings.
const listed = computed(() => {
  if (isMe.value) return sessions.value
  if (!seesSessions.value) return []
  const theirs = sessions.value.filter((s) => (s.members || []).some((m) => m.id === personId.value && m.state === 'joined'))
  return [...theirs, ...(person.value?.pastSamples || [])]
})
const sessionsTitle = computed(() => (isMe.value || auth.sampleWorld ? 'Sessions' : 'Sessions together'))
// The time chip chosen, and the sessions it shows in its order. The clock moves a session to the top while it is live.
const sessionFilter = ref('all')
const now = useNow()
// What was typed in the search box, and the day picked on the graph ('yyyy-MM-dd' or '').
const query = ref('')
const day = ref('')
const narrowing = computed(() => !!query.value.trim() || !!day.value)
const shownSessions = computed(() => narrowSessions(profileSessions(listed.value, sessionFilter.value, now.value), { query: query.value, day: day.value }, now.value))
const dayText = (d) => format(parseISO(d), 'EEE d MMM yyyy')
const emptyText = computed(() => (narrowing.value ? narrowedEmptyText({ query: query.value, day: day.value }, dayText) : EMPTY_TEXT[sessionFilter.value]))
// A day picked on the graph, or null when the same day was picked again. Picking a day shows All, so a past day is not hidden
// by Upcoming. How to call: pickDay('2026-09-11')
// The list sits below the graph on your own profile, so a picked day brings its heading into view (at once under reduced motion).
async function pickDay(picked) {
  day.value = picked || ''
  if (!picked) return
  sessionFilter.value = 'all'
  await nextTick()
  const head = typeof document !== 'undefined' ? document.getElementById('my-sessions') : null
  const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  head?.scrollIntoView?.({ behavior: still ? 'auto' : 'smooth', block: 'start' })
}
// The day goes when another person's profile opens, or when this person stops being a friend.
watch([personId, seesSessions], () => { day.value = ''; query.value = '' })
const nameOf = (id) => (id === auth.myId ? auth.user?.name ?? '' : groups.nameOf(id))
const dateText = (d) => format(parseISO(d), 'd MMM yyyy')
// Outings together: with each friend (beside their name in the Friends sheet), and with the person whose profile this is (the line under the name).
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
// The person's friends, in the sheet the Friends number opens: the ones the signed-in person added (or, for a real account, the
// people they have shared a session with), or, on someone else's profile, theirs or the friends in common (lib/api.js friendsOf).
const friends = computed(() => person.value?.friends || [])
const friendsTitle = computed(() => (person.value?.friendsInCommon ? 'Friends in common' : 'Friends'))
const friendsOpen = ref(false)
// Under your own friends, the sheet suggests people to add (SuggestedFriends, the same section as Home's "Add friends"; demo and local
// accounts only, as adding friends is). Fixed when the sheet opens, so a person just added stays, marked, until it closes.
const sheetSuggested = ref([])
const sheetError = ref('')
watch(friendsOpen, (isOpen) => {
  if (!isOpen) return
  sheetError.value = ''
  sheetSuggested.value = isMe.value && auth.sampleWorld ? [...groups.suggested] : []
})
// A friend's profile opens from the sheet: close it first. How to call: openFriend('faith')
function openFriend(id) {
  friendsOpen.value = false
  router.push(id === auth.myId ? '/profile' : `/people/${id}`)
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
          <!-- Who they are, the four numbers and the one action, in one white card with a bold ink border (Darius, 4 November 2026; it
               had a spotlight border for a while that day). -->
          <div class="hero__card ink-card">
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
                  <dt class="caption-sm">{{ rank == null ? 'No rank yet' : 'Season rank' }}</dt>
                  <dd class="stats__value tnum"><AppIcon name="trophy" :size="18" />{{ rank == null ? '–' : ordinal(rank) }}</dd>
                </div>
                <div class="stats__item">
                  <dt class="caption-sm">Balance</dt>
                  <dd class="stats__value tnum"><CoinBadge :size="18" />{{ person.points }}</dd>
                </div>
                <div class="stats__item">
                  <dt class="caption-sm">{{ person.friendsInCommon ? 'In common' : 'Friends' }}</dt>
                  <dd class="stats__value tnum">
                    <button type="button" class="stats__button" :aria-label="`${friends.length} ${person.friendsInCommon ? 'friends in common' : friends.length === 1 ? 'friend' : 'friends'}, show the list`" aria-haspopup="dialog" data-testid="friends-count" @click="friendsOpen = true"><AppIcon name="heart" :size="18" />{{ friends.length }}</button>
                  </dd>
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
        </div>
      </section>

      <div class="screen__body">
        <!-- The activity graph, in the same white card with a bold ink border as the header above, the same width (Darius, 4 November 2026). -->
        <div class="graph-card ink-card rise" style="--i: 1">
          <section class="graph-card__inner" aria-labelledby="graph-head">
            <h2 id="graph-head" class="sr-only">Meetup frequency</h2>
            <MeetupGraph :history="person.history" :planned="person.planned" :selected="day" :pickable="seesSessions" @select="pickDay" />
          </section>
        </div>

        <!-- The signed-in person or a friend: their sessions, once they have some. A stranger's are not listed. -->
        <!-- In one white card with a bold ink border, title, chips, search and all, as the graph above it and as Rewards' card (Darius,
             4 November 2026). -->
        <section v-if="seesSessions && (!events.loaded || listed.length)" class="section ink-card sessions-card" aria-labelledby="my-sessions" data-testid="profile-sessions">
          <div class="section__head">
            <h2 id="my-sessions" class="display-sm">{{ sessionsTitle }}</h2>
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
            <ul v-if="shownSessions.length" class="grid-3">
              <li v-for="s in shownSessions" :key="s.id"><SessionCard :session="s" :names="nameOf" /></li>
            </ul>
          </template>
        </section>

      </div>
    </template>
    <div v-else class="screen__body profile__loading"><SkeletonRow v-for="n in 3" :key="n" avatar /></div>

    <BottomSheet v-model:open="friendsOpen" :title="friendsTitle">
      <p v-if="!friends.length" class="body-md text-muted" data-testid="friends-empty">{{ person?.friendsInCommon ? 'No friends in common yet.' : isMe ? 'No friends yet. People you go out with show up here.' : 'No friends to show yet.' }}</p>
      <ul v-else class="friend-list" data-testid="friends-list">
        <li v-for="p in friends" :key="p.id">
          <button type="button" class="friend-list__row" @click="openFriend(p.id)">
            <UserAvatar :name="p.name" :src="p.photo" :person="p.id" :size="44" />
            <span class="stack friend-list__text">
              <span class="friend-list__name">
                <span class="title-sm truncate">{{ p.name }}<template v-if="p.id === auth.myId"> (you)</template></span>
                <OutingsTogether :count="togetherCounts[p.id]" />
              </span>
              <span class="caption-sm text-muted truncate"><template v-if="p.username">@{{ p.username }}</template><template v-if="p.username && p.homeArea"> · </template>{{ p.homeArea }}</span>
            </span>
            <AppIcon class="friend-list__go" name="chevron-right" :size="18" />
          </button>
        </li>
      </ul>
      <SampleNote v-if="!isMe && person?.sample && friends.length" />
      <SuggestedFriends v-if="sheetSuggested.length" class="sheet-suggested" :people="sheetSuggested" data-testid="friends-sheet-suggested" @open="openFriend" @error="sheetError = $event" />
      <p v-if="sheetError" class="body-sm text-error" role="alert">{{ sheetError }}</p>
    </BottomSheet>

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
#my-sessions { scroll-margin-top: calc(var(--topbar-real-height) + var(--spacing-base)); }
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
/* The two lit cards (the header and the graph): white, with a hairline border at rest that lights up under the pointer. */
/* The two cards (the header and the graph): white with a bold ink border, no glow (Darius, 4 November 2026). */
.ink-card { border: 2px solid var(--ink); border-radius: var(--rounded-lg); background: var(--canvas); }
/* The sessions' card: roomy inside, a little less on phones. */
.sessions-card { padding: var(--spacing-lg); }
@media (max-width: 743.98px) { .sessions-card { padding: var(--spacing-base) var(--spacing-md); } }
/* The header's card: roomy inside, a little more on wide screens. From 744px the header's column is indented further than the page
   body, so the card reaches back out by that much and lines up with the graph's card under it. */
.hero__card { padding: var(--spacing-lg); }
@media (min-width: 744px) { .hero__card { margin-right: calc(var(--spacing-lg) * -1); margin-left: calc(var(--spacing-lg) * -1); padding: var(--spacing-lg) var(--spacing-xl); } }

/* Three numbers in a bordered strip, split by thin lines. */
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; padding: var(--spacing-md) 0; border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.stats__item { display: flex; flex-direction: column; align-items: center; gap: var(--spacing-xxs); padding: 0 var(--spacing-sm); text-align: center; }
.stats__item + .stats__item { border-left: 1px solid var(--hairline); }
.stats__value { display: inline-flex; align-items: center; gap: 6px; margin: 0; color: var(--ink); font: var(--text-display-sm); }
.stats__value :deep(svg) { color: var(--pc); }
/* The label comes first in the markup (for screen readers) and shows under its number. */
.stats__item dt { order: 2; color: var(--muted); }
.stats__item dd { order: 1; }
/* Friends opens the list: the number is a button that looks like the others, underlined on hover. 44px to tap. */
/* The Friends number is a button, but sits exactly like the other three numbers: no padding or margin of its own, and its 44px tap
   area drawn around it (::after), so the four line up (Faith, 31 October 2026). */
.stats__button { position: relative; display: inline-flex; align-items: center; gap: 6px; margin: 0; padding: 0; border: 0; border-radius: var(--rounded-sm); background: transparent; color: inherit; font: inherit; line-height: inherit; cursor: pointer; }
.stats__button::after { content: ""; position: absolute; inset: -10px -12px; }
.stats__button :deep(svg) { color: var(--pc); }
@media (hover: hover) { .stats__button:hover { text-decoration: underline; } }
.stats__button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
/* The friends sheet: one row per friend, opening their profile. */
.sheet-suggested { margin-top: var(--spacing-lg); }
.friend-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.friend-list__row { display: flex; align-items: center; gap: var(--spacing-md); width: 100%; min-height: 64px; padding: var(--spacing-sm) 0; border: 0; border-bottom: 1px solid var(--hairline-soft); background: transparent; color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
@media (hover: hover) { .friend-list__row:hover { background: var(--surface-soft); } }
.friend-list__row:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
.friend-list__text { flex: 1; min-width: 0; gap: 0; }
.friend-list__name { display: flex; align-items: center; gap: var(--spacing-xs); min-width: 0; }
.friend-list__go { flex-shrink: 0; color: var(--muted); }

.graph-card { padding: var(--spacing-base); }
/* The graph is clipped by its own box, inside the card's padding. */
.graph-card__inner { min-width: 0; overflow: hidden; border-radius: var(--rounded-md); }
.profile__loading { padding-top: var(--spacing-xl); }
</style>
