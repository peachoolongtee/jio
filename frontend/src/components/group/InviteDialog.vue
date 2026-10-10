<script setup>
// Invite friends without leaving the session: a small popover beside the Invite button, with no backdrop, so the
// session stays in view around it.
//   <InviteDialog v-model:open="inviteOpen" :session="session" />
// A search box, then friends (and, when searching, other people on Jio) who are not in the session yet, each
// picked with a tap. At the bottom: how many are picked and Send invites. Invites are pending until each accepts.
import { computed, nextTick, ref, watch } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import PopoverPanel from '../ui/PopoverPanel.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'

const open = defineModel('open', { type: Boolean, default: false })
const props = defineProps({ session: { type: Object, required: true } })

const events = useEventsStore()
const groups = useGroupsStore()
const search = ref(null)
const query = ref('')
const picked = ref([])
const busy = ref(false)
const error = ref('')
// Fresh each time it opens, with the search box ready. (The popover takes focus back to the button on close.)
watch(open, async (isOpen) => {
  if (!isOpen) return
  query.value = ''
  picked.value = []
  error.value = ''
  if (!groups.people.length) groups.loadPeople()
  await nextTick()
  await nextTick()
  search.value?.focus()
})

// Anyone joined or already invited is not offered again.
const taken = (id) => props.session.members.some((m) => m.id === id && ['joined', 'invited'].includes(m.state))
const matches = (p) => {
  const q = query.value.trim().toLowerCase().replace(/^@/, '')
  return !q || p.name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q)
}
const lists = computed(() =>
  [
    { id: 'friends', title: 'Friends', people: groups.friends.filter((p) => !taken(p.id) && matches(p)) },
    // Other people on Jio only when you search for them; the list is about your friends.
    { id: 'suggested', title: 'Other people on Jio', people: query.value.trim() ? groups.suggested.filter((p) => !taken(p.id) && matches(p)) : [] },
  ].filter((l) => l.people.length),
)
const nobodyLeft = computed(() => !query.value.trim() && !lists.value.length)

function toggle(id) {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id]
}

function close() {
  open.value = false
}

async function send() {
  if (!picked.value.length || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await events.invite(props.session.id, picked.value)
    close()
  } catch (e) {
    error.value = e.message
  }
  busy.value = false
}
</script>

<template>
  <PopoverPanel v-model:open="open" title="Invite friends" :width="380">
    <p class="body-sm text-muted">They join {{ session.title }} once they accept.</p>
    <label class="invite__field">
      <AppIcon name="search" :size="16" />
      <input ref="search" v-model="query" type="search" placeholder="Search name or @username" aria-label="Search people" autocomplete="off" />
    </label>

    <p v-if="nobodyLeft" class="body-sm text-muted">Everyone you know is already in this session.</p>
    <p v-else-if="!lists.length" class="body-sm text-muted">Nobody matches “{{ query.trim() }}”.</p>
    <section v-for="list in lists" :key="list.id" class="invite__group" :aria-label="list.title">
      <h3 class="caption-sm text-muted">{{ list.title }}</h3>
      <ul class="invite__list">
        <li v-for="person in list.people" :key="person.id">
          <button type="button" class="invite__row" :class="{ 'is-picked': picked.includes(person.id) }" :aria-pressed="String(picked.includes(person.id))" @click="toggle(person.id)">
            <UserAvatar :name="person.name" :person="person.id" :size="36" />
            <span class="invite__who">
              <span class="title-sm truncate">{{ person.name }}</span>
              <span class="caption-sm text-muted truncate">@{{ person.username }}</span>
            </span>
            <span class="invite__check" aria-hidden="true"><AppIcon name="check" :size="12" /></span>
          </button>
        </li>
      </ul>
    </section>
    <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>

    <template #footer>
      <span class="caption text-muted tnum invite__count" aria-live="polite">{{ picked.length ? `${picked.length} selected` : '' }}</span>
      <AppButton small :disabled="!picked.length || busy" @click="send">Send invites</AppButton>
    </template>
  </PopoverPanel>
</template>

<style scoped>
.invite__field { display: flex; align-items: center; gap: var(--spacing-sm); height: 44px; padding: 0 var(--spacing-md); border-radius: var(--rounded-full); background: var(--surface-soft); color: var(--muted); }
.invite__field:focus-within { box-shadow: 0 0 0 2px var(--ink); }
.invite__field input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--ink); font: var(--text-body-sm); outline: none; }
.invite__field input::placeholder { color: var(--muted); }
.invite__group { display: flex; flex-direction: column; gap: var(--spacing-xxs); }
.invite__group h3 { margin: 0; }
.invite__list { display: flex; flex-direction: column; margin: 0 calc(var(--spacing-sm) * -1); padding: 0; list-style: none; }
.invite__row { display: flex; align-items: center; gap: var(--spacing-md); width: 100%; min-height: 52px; padding: var(--spacing-xs) var(--spacing-sm); border: 0; border-radius: var(--rounded-sm); background: transparent; color: var(--ink); text-align: left; cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out); }
@media (hover: hover) { .invite__row:hover { background: var(--surface-soft); } }
.invite__row:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
.invite__who { display: flex; flex: 1; flex-direction: column; min-width: 0; }
/* A round check on the right: an empty ring, filled in Rausch when picked. */
.invite__check { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1.5px solid var(--border-strong); border-radius: var(--rounded-full); color: transparent; transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
.is-picked .invite__check { border-color: var(--primary); background: var(--primary); color: var(--on-primary); }
.invite__count { margin-right: auto; }
</style>
