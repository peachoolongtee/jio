<script setup>
// Step 2: invite friends. Ian picks friends from a list; everyone on it already has the app.
// One card, one column at every size: the session and how many are in it, a search box, who is already in
// (the host first, with a Host badge), then friends and suggested people to pick, and Cancel / Send invites.
// After sending, the screen confirms each invite. Each friend shows as Invited until they accept (in the demo, on
// their own a moment later).
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import IllustrationBlob from '@/components/ui/IllustrationBlob.vue'
import ListRow from '@/components/ui/ListRow.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import StatusPill from '@/components/ui/StatusPill.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'

const props = defineProps({ id: { type: String, required: true } })

const router = useRouter()
const auth = useAuthStore()
const events = useEventsStore()
const groups = useGroupsStore()

const picked = ref([])
const sent = ref([])
const busy = ref(false)
const error = ref('')

onMounted(async () => {
  await Promise.all([events.loadSession(props.id).catch(() => null), groups.loadPeople()])
})

const session = computed(() => events.byId[props.id])
const inSession = (personId) => session.value?.members.some((m) => m.id === personId && ['joined', 'invited'].includes(m.state))
const isInvited = (personId) => session.value?.members.some((m) => m.id === personId && m.state === 'invited')
// Search by name or @username. Empty: everyone.
const query = ref('')
const matches = (p) => {
  const q = query.value.trim().toLowerCase().replace(/^@/, '')
  return !q || p.name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q)
}
// Already in the session: the host (Ian), then anyone who has joined. Everyone else can be picked.
const members = computed(() => {
  if (!session.value) return []
  const joined = groups.people.filter((p) => inSession(p.id))
  return [{ id: auth.user?.id || 'ian', name: auth.user?.name || 'You', username: auth.user?.username || '', homeArea: auth.user?.homeAreaName || '', host: true }, ...joined]
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

function done() {
  router.replace(`/sessions/${props.id}`)
}
</script>

<template>
  <main class="screen screen--invite">
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton label="Back to session" :to="`/sessions/${id}`"><AppIcon name="back" /></IconButton>
        <span v-if="session?.status === 'inviting'" class="caption text-muted">Step 2 of 2</span>
        <StatusPill v-if="session" :status="session.status" />
      </div>
      <div class="screen__titles">
        <h1 class="display-xl">{{ sent.length ? 'Invites sent' : 'Invite friends' }}</h1>
      </div>
    </header>

    <div v-if="!session" class="screen__body">
      <SkeletonRow v-for="n in 4" :key="n" avatar />
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
                <span class="title-sm truncate">{{ person.name }}<template v-if="person.host"> (you)</template></span>
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

    <footer v-if="session" class="screen__footer">
      <AppButton v-if="sent.length" block @click="done">Done</AppButton>
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
   pinned full-width Send button, where the thumb is. There is no Cancel: the back arrow already returns to the session. */
@media (min-width: 744px) {
  .screen__body { flex: 0 0 auto; }
  .screen__footer { position: static; flex-direction: row; justify-content: flex-end; align-items: center; padding-top: 0; border-top: 0; }
  .invite__picked { display: inline; margin-right: auto; }
}
</style>
