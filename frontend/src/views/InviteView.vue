<script setup>
// Step 2: invite friends. Ian picks friends from a list; everyone on it already has the app.
// After sending, the screen confirms each invite. Friends join automatically, with no action from them.
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
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'

const props = defineProps({ id: { type: String, required: true } })

const router = useRouter()
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
const inSession = (personId) => session.value?.members.some((m) => m.id === personId && m.state === 'joined')
const lists = computed(() => [
  { id: 'friends', title: 'Friends', people: groups.friends },
  { id: 'more', title: 'Suggested', people: groups.suggested },
])
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
  <main class="screen screen--wide-form">
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton label="Back" :to="`/sessions/${id}`"><AppIcon name="back" /></IconButton>
        <span v-if="session?.status === 'inviting'" class="caption text-muted">Step 2 of 2</span>
        <StatusPill v-if="session" :status="session.status" />
      </div>
      <div class="screen__titles">
        <h1 class="display-xl">{{ sent.length ? 'Invites sent' : 'Invite friends' }}</h1>
        <p v-if="session" class="body-sm text-muted">{{ session.title }}</p>
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
      <div class="row between">
        <span class="caption text-muted">{{ picked.length }} selected</span>
        <AppButton v-if="available.length" variant="tertiary" underline @click="toggleAll">{{ allPicked ? 'Clear selection' : 'Select all' }}</AppButton>
      </div>
      <EmptyState v-if="!groups.people.length && !groups.loading.people" title="No friends to invite" />
      <section v-for="list in lists" v-show="list.people.length" :key="list.id" class="section" :aria-labelledby="`invite-${list.id}`">
        <h2 :id="`invite-${list.id}`" class="title-md">{{ list.title }}</h2>
        <ul>
          <ListRow v-for="person in list.people" :key="person.id" as="li" :title="person.name" :meta="`@${person.username} · ${person.homeArea}`">
            <template #leading><UserAvatar :name="person.name" :person="person.id" /></template>
            <template #trailing>
              <span v-if="inSession(person.id)" class="caption text-muted">In session</span>
              <ChipButton v-else check :selected="picked.includes(person.id)" :aria-label="`Invite ${person.name}`" @click="toggle(person.id)">
                {{ picked.includes(person.id) ? 'Selected' : 'Select' }}
              </ChipButton>
            </template>
          </ListRow>
        </ul>
      </section>
      <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    </div>

    <footer v-if="session" class="screen__footer">
      <AppButton v-if="sent.length" block @click="done">Done</AppButton>
      <AppButton v-else block :disabled="!picked.length || busy" @click="send">
        {{ picked.length ? `Send ${picked.length} ${picked.length === 1 ? 'invite' : 'invites'}` : 'Send invites' }}
      </AppButton>
    </footer>
  </main>
</template>

<style scoped>
.sent-mark { display: inline-flex; align-items: center; gap: var(--spacing-xs); color: var(--ink); }
/* Desktop: friends in two columns, so the wider page is not one long thin list. */
@media (min-width: 1128px) {
  .section > ul { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: var(--spacing-xl); }
}
/* Tablet and up: the action follows the form, right-aligned at a normal width, instead of a full-width bar
   pinned to the bottom of the window. Phones keep the pinned bar, where the thumb is. */
@media (min-width: 744px) {
  .screen__body { flex: 0 0 auto; }
  .screen__footer { position: static; flex-direction: row; justify-content: flex-end; padding-top: 0; border-top: 0; }
}
</style>
