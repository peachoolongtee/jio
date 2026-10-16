<script setup>
// Step 2: invite friends, and the Invite step of the steps bar at any later time. The host picks friends from a list;
// everyone on it already has the app. The back arrow goes to the Create form (title, day and times, filled in) for the
// host, and Home for a guest. One card, one column at every size: the session and how many are in it, a search box, who
// is already in (the host first, with a Host badge), then friends and suggested people to pick, and Send invites.
// After sending, the screen confirms each invite. Each friend shows as Invited until they accept (in the demo, on
// their own a moment later).
// Once the session has started the page still opens. The host can invite while the group is locating or voting (the data
// layer allows it, and the header's Invite button already does), and when a confirmed plan is left with too few people.
// Otherwise (a confirmed plan with enough people, a finished or cancelled session, or anyone but the host) the page lists
// who is in and says why invites are closed, with no picker and no Send button (inviteAccess in lib/session.js).
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import IllustrationBlob from '@/components/ui/IllustrationBlob.vue'
import ListRow from '@/components/ui/ListRow.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import InviteByUsername from '@/components/group/InviteByUsername.vue'
import RemoveMember from '@/components/group/RemoveMember.vue'
import ShareLink from '@/components/group/ShareLink.vue'
import SessionSteps, { backFor } from '@/components/event/SessionSteps.vue'
import { watchSessions } from '@/lib/api.js'
import { inviteAccess } from '@/lib/session.js'
import { exitFor, goBackIfBehind, isBehind } from '@/lib/stepNav.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'

const props = defineProps({ id: { type: String, required: true } })

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const events = useEventsStore()
const groups = useGroupsStore()

const picked = ref([])
const sent = ref([])
const busy = ref(false)
const error = ref('')

// A shared session changes under this page (someone joins, the host's link is used): the list follows.
let stopWatching = () => {}
onMounted(async () => {
  stopWatching = watchSessions()
  await Promise.all([events.loadSession(props.id).catch(() => null), groups.loadPeople()])
})
onBeforeUnmount(() => stopWatching())

const session = computed(() => events.byId[props.id])
// Back: the step before this one (backFor). For the host that is the create form, with the title, day and times filled
// in; it takes this screen's place in the browser's history (replace), so Back in the browser still goes to where the
// person came from and can never land on an empty create form. A guest goes Home.
const mine = computed(() => session.value?.hostId === auth.myId)
const back = computed(() => (session.value ? backFor(session.value, route.path, mine.value, exitFor()) : exitFor()))
const hostName = computed(() => (session.value?.hostId === auth.myId ? auth.user?.name : groups.people.find((p) => p.id === session.value?.hostId)?.name) || 'the host')
// Whether this person can add people now, and if not, why not.
const access = computed(() => (session.value ? inviteAccess(session.value, mine.value, hostName.value) : { open: false, text: '' }))
const inSession = (personId) => session.value?.members.some((m) => m.id === personId && ['joined', 'invited'].includes(m.state))
const isInvited = (personId) => session.value?.members.some((m) => m.id === personId && m.state === 'invited')
// Search by name or @username. Empty: everyone.
const query = ref('')
const matches = (p) => {
  const q = query.value.trim().toLowerCase().replace(/^@/, '')
  return !q || p.name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q)
}
// Already in the session: the host first, then everyone who has joined or been invited, as the session lists them.
// Everyone else can be picked.
const members = computed(() => {
  if (!session.value) return []
  const rows = session.value.members
    .filter((m) => ['joined', 'invited'].includes(m.state))
    .map((m) => {
      const me = m.id === auth.myId
      const p = me ? { name: auth.user?.name || 'You', username: auth.user?.username || '', homeArea: auth.user?.homeAreaName || '' } : groups.people.find((x) => x.id === m.id) || { name: groups.nameOf(m.id) || 'Someone', username: '', homeArea: '' }
      return { id: m.id, name: p.name, username: p.username || '', homeArea: p.homeArea || '', host: m.role === 'host', me }
    })
  return [...rows.filter((r) => r.host), ...rows.filter((r) => !r.host)]
})
const lists = computed(() => [
  { id: 'friends', title: 'Friends', people: groups.friends.filter((p) => !inSession(p.id) && matches(p)) },
  { id: 'more', title: 'Suggested', people: groups.suggested.filter((p) => !inSession(p.id) && matches(p)) },
])
const noMatches = computed(() => query.value.trim() && lists.value.every((l) => !l.people.length))
const initial = computed(() => (session.value?.title.trim()[0] || 'J').toUpperCase())
const available = computed(() => groups.people.filter((p) => !inSession(p.id)))
const allPicked = computed(() => available.value.length > 0 && available.value.every((p) => picked.value.includes(p.id)))

function toggle(personId) {
  picked.value = picked.value.includes(personId) ? picked.value.filter((x) => x !== personId) : [...picked.value, personId]
}

function toggleAll() {
  picked.value = allPicked.value ? [] : available.value.map((p) => p.id)
}

async function send() {
  if (!picked.value.length || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await events.invite(props.id, picked.value)
    sent.value = groups.people.filter((p) => picked.value.includes(p.id))
    picked.value = []
  } catch (e) {
    error.value = e.message
  }
  busy.value = false
}

// Back to the session. If it is the page just behind this one it goes Back, so the history has no repeat.
// How to call: done()
function done() {
  const to = `/sessions/${props.id}`
  if (isBehind(to)) router.back()
  else router.replace(to)
}
</script>

<template>
  <main class="screen screen--invite">
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton :label="back.label" :to="back.to" @click.capture="goBackIfBehind($event, router, back.to)"><AppIcon name="back" /></IconButton>
      </div>
      <!-- Before the title, as on every session screen, so the bar does not move between them. -->
      <SessionSteps v-if="session" :session="session" />
      <div class="screen__titles">
        <h1 class="display-xl">{{ sent.length ? 'Invites sent' : access.open ? 'Invite friends' : 'Who is in' }}</h1>
      </div>
    </header>

    <div v-if="!session" class="screen__body">
      <SkeletonRow v-for="n in 4" :key="n" avatar />
    </div>

    <!-- A shared session: invite with a link or a username. The list shows who is in, and the host can remove a guest. -->
    <div v-else-if="session.remote" class="screen__body">
      <BannerNote v-if="!access.open" icon="info">{{ access.text }}</BannerNote>
      <section class="invite card" aria-labelledby="invite-in">
        <header class="invite__session">
          <span class="invite__badge" aria-hidden="true">{{ initial }}</span>
          <div class="stack">
            <span class="title-md">{{ session.title }}</span>
            <span class="invite__count caption text-muted"><AppIcon name="people" :size="16" />{{ members.length }} in this session</span>
          </div>
        </header>
        <template v-if="access.open">
          <hr class="invite__rule" />
          <ShareLink :session-id="session.id" :title="session.title" />
          <hr class="invite__rule" />
          <InviteByUsername :session="session" />
        </template>
        <hr class="invite__rule" />
        <section class="invite__group" aria-labelledby="invite-in">
          <h2 id="invite-in" class="caption text-muted">In this session</h2>
          <ul class="invite__list">
            <li v-for="person in members" :key="person.id" class="invite__row">
              <UserAvatar :name="person.name" :person="person.id" :size="44" />
              <span class="invite__who">
                <span class="title-sm truncate">{{ person.name }}<template v-if="person.me"> (you)</template></span>
                <span class="caption-sm text-muted truncate"><template v-if="person.username">@{{ person.username }}</template><template v-if="person.username && person.homeArea"> · </template>{{ person.homeArea }}</span>
              </span>
              <span v-if="person.host" class="invite__tag invite__tag--host"><AppIcon name="crown" :size="14" />Host</span>
              <span v-else-if="isInvited(person.id)" class="invite__tag invite__tag--pending"><AppIcon name="clock" :size="14" />Invited</span>
              <span v-else class="invite__tag"><AppIcon name="check" :size="14" />Joined</span>
              <RemoveMember v-if="mine && !person.host && !isInvited(person.id)" :session-id="session.id" :person="person" />
            </li>
          </ul>
        </section>
      </section>
    </div>

    <!-- After sending: each friend was invited. -->
    <div v-else-if="sent.length" class="screen__body" role="status">
      <IllustrationBlob name="sent" />
      <ul>
        <ListRow v-for="person in sent" :key="person.id" as="li" :title="person.name" :meta="`@${person.username}`">
          <template #leading><UserAvatar :name="person.name" :person="person.id" /></template>
          <template #trailing>
            <span class="sent-mark caption"><AppIcon name="check" :size="14" /> Invited</span>
          </template>
        </ListRow>
      </ul>
    </div>

    <!-- Invites are closed (or this is a guest): who is in, and why nobody can be added. No picker, no Send button. -->
    <div v-else-if="!access.open" class="screen__body">
      <BannerNote icon="info">{{ access.text }}</BannerNote>
      <section class="invite card" aria-labelledby="invite-in">
        <header class="invite__session">
          <span class="invite__badge" aria-hidden="true">{{ initial }}</span>
          <div class="stack">
            <span class="title-md">{{ session.title }}</span>
            <span class="invite__count caption text-muted"><AppIcon name="people" :size="16" />{{ members.length }} in this session</span>
          </div>
        </header>
        <hr class="invite__rule" />
        <section class="invite__group">
          <h2 id="invite-in" class="caption text-muted">In this session</h2>
          <ul class="invite__list">
            <li v-for="person in members" :key="person.id" class="invite__row">
              <UserAvatar :name="person.name" :person="person.id" :size="44" />
              <span class="invite__who">
                <span class="title-sm truncate">{{ person.name }}<template v-if="person.me"> (you)</template></span>
                <span class="caption-sm text-muted truncate"><template v-if="person.username">@{{ person.username }}</template><template v-if="person.username && person.homeArea"> · </template>{{ person.homeArea }}</span>
              </span>
              <span v-if="person.host" class="invite__tag invite__tag--host"><AppIcon name="crown" :size="14" />Host</span>
              <span v-else-if="isInvited(person.id)" class="invite__tag invite__tag--pending"><AppIcon name="clock" :size="14" />Invited</span>
              <span v-else class="invite__tag"><AppIcon name="check" :size="14" />Joined</span>
            </li>
          </ul>
        </section>
      </section>
    </div>

    <div v-else class="screen__body">
      <section class="invite card" aria-labelledby="invite-head">
        <header class="invite__session">
          <span class="invite__badge" aria-hidden="true">{{ initial }}</span>
          <div class="stack">
            <span class="title-md">{{ session.title }}</span>
            <span class="invite__count caption text-muted"><AppIcon name="people" :size="16" />{{ members.length }} in this session</span>
          </div>
        </header>

        <div class="invite__find">
          <div class="row between">
            <h2 id="invite-head" class="title-sm">Invite friends</h2>
            <AppButton v-if="available.length" variant="tertiary" underline @click="toggleAll">{{ allPicked ? 'Clear selection' : 'Select all' }}</AppButton>
          </div>
          <label class="invite__search">
            <AppIcon name="search" :size="18" />
            <span class="sr-only">Search friends</span>
            <input v-model="query" type="search" placeholder="Search friends" autocomplete="off" />
          </label>
        </div>

        <hr class="invite__rule" />

        <section class="invite__group" aria-labelledby="invite-in">
          <h3 id="invite-in" class="caption text-muted">In this session</h3>
          <ul class="invite__list">
            <li v-for="person in members" :key="person.id" class="invite__row">
              <UserAvatar :name="person.name" :person="person.id" :size="44" />
              <span class="invite__who">
                <span class="title-sm truncate">{{ person.name }}<template v-if="person.me"> (you)</template></span>
                <span class="caption-sm text-muted truncate"><template v-if="person.username">@{{ person.username }}</template><template v-if="person.username && person.homeArea"> · </template>{{ person.homeArea }}</span>
              </span>
              <span v-if="person.host" class="invite__tag invite__tag--host"><AppIcon name="crown" :size="14" />Host</span>
              <span v-else-if="isInvited(person.id)" class="invite__tag invite__tag--pending"><AppIcon name="clock" :size="14" />Invited</span>
              <span v-else class="invite__tag"><AppIcon name="check" :size="14" />Joined</span>
            </li>
          </ul>
        </section>

        <EmptyState v-if="!groups.people.length && !groups.loading.people" title="No friends to invite" />
        <p v-else-if="noMatches" class="body-sm text-muted">Nobody matches “{{ query.trim() }}”.</p>
        <section v-for="list in lists" v-show="list.people.length" :key="list.id" class="invite__group" :aria-labelledby="`invite-${list.id}`">
          <h3 :id="`invite-${list.id}`" class="caption text-muted">{{ list.title }}</h3>
          <ul class="invite__list">
            <li v-for="person in list.people" :key="person.id" class="invite__row" :class="{ 'is-picked': picked.includes(person.id) }">
              <UserAvatar :name="person.name" :person="person.id" :size="44" />
              <span class="invite__who">
                <span class="title-sm truncate">{{ person.name }}</span>
                <span class="caption-sm text-muted truncate">@{{ person.username }} · {{ person.homeArea }}</span>
              </span>
              <ChipButton check :selected="picked.includes(person.id)" :aria-label="`Invite ${person.name}`" @click="toggle(person.id)">
                {{ picked.includes(person.id) ? 'Selected' : 'Select' }}
              </ChipButton>
            </li>
          </ul>
        </section>
        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
      </section>
    </div>

    <footer v-if="session?.remote" class="screen__footer">
      <AppButton next block @click="done">Done</AppButton>
    </footer>
    <footer v-else-if="session && access.open" class="screen__footer">
      <AppButton v-if="sent.length" next block @click="done">Done</AppButton>
      <template v-else>
        <span class="caption text-muted invite__picked" aria-live="polite">{{ picked.length }} selected</span>
        <AppButton block :disabled="!picked.length || busy" @click="send">
          {{ picked.length ? `Send ${picked.length} ${picked.length === 1 ? 'invite' : 'invites'}` : 'Send invites' }}
        </AppButton>
      </template>
    </footer>
  </main>
</template>

<style scoped>
.sent-mark { display: inline-flex; align-items: center; gap: var(--spacing-xs); color: var(--ink); }

/* One column, no wider than a comfortable reading width: the title, the card and the actions share one edge. */
.screen--invite { max-width: calc(640px + var(--gutter) * 2); }
.invite { gap: var(--spacing-lg); }
.invite__session { display: flex; align-items: center; gap: var(--spacing-base); }
.invite__badge { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 56px; height: 56px; border-radius: var(--rounded-md); background: var(--primary); color: var(--on-primary); font: var(--text-display-sm); }
.invite__count { display: inline-flex; align-items: center; gap: var(--spacing-xs); }
.invite__find { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.invite__search { display: flex; align-items: center; gap: var(--spacing-sm); height: 48px; padding: 0 var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-sm); background: var(--canvas); color: var(--muted); }
.invite__search:focus-within { border-color: var(--ink); box-shadow: 0 0 0 1px var(--ink); }
.invite__search input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--ink); font: var(--text-body-md); outline: none; }
.invite__search input::placeholder { color: var(--muted); }
.invite__rule { margin: 0; border: 0; border-top: 1px solid var(--hairline); }
.invite__group { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.invite__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.invite__row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 68px; padding: var(--spacing-sm) var(--spacing-sm); border-radius: var(--rounded-sm); transition: background-color var(--motion-fast) var(--ease-out); }
.invite__row.is-picked { background: color-mix(in srgb, var(--primary) 6%, var(--canvas)); }
.invite__who { display: flex; flex: 1; flex-direction: column; min-width: 0; }
/* Who is already in: a quiet outlined tag, the host's with a Rausch crown. */
.invite__tag { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: 1px solid var(--hairline); border-radius: var(--rounded-full); color: var(--body); font: var(--text-caption); }
.invite__tag--pending { border-style: dashed; color: var(--muted); }
.invite__tag--host { border-color: color-mix(in srgb, var(--primary) 35%, var(--canvas)); color: var(--primary-active); }
.invite__picked { display: none; }

/* Tablet and up: the action follows the card: "N selected" on the left, Send invites on the right. Phones keep the
   pinned full-width Send button, where the thumb is. There is no Cancel: the back arrow already goes back a step. */
@media (min-width: 744px) {
  .screen__body { flex: 0 0 auto; }
  .screen__footer { position: static; flex-direction: row; justify-content: flex-end; align-items: center; padding-top: 0; border-top: 0; }
  .invite__picked { display: inline; margin-right: auto; }
}
</style>
