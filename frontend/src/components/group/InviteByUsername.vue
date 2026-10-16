<script setup>
// Invite one person by their exact username to a shared session: type it, find the person, invite them. They see the
// invitation on Home and accept or decline it. Only a complete username is looked up, never a part of one.
//   <InviteByUsername :session="session" />
// States: idle, looking, found (the person with an Invite button, or why they cannot be invited), not found, a failed
// look-up or invitation (a sentence), and invited (a line that says so).
import { computed, ref } from 'vue'
import AppButton from '../ui/AppButton.vue'
import TextField from '../ui/TextField.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import * as api from '@/lib/api.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ session: { type: Object, required: true } })

const events = useEventsStore()
const text = ref('')
const found = ref(null)
const searching = ref(false)
const inviting = ref(false)
const error = ref('')
const done = ref('')

// Why the person found cannot be invited, or '' when they can.
// How to call: why.value -> 'Already in this session.'
const why = computed(() => {
  if (!found.value) return ''
  const member = props.session.members.find((m) => m.id === found.value.id)
  if (!member) return ''
  return member.state === 'invited' ? 'Already invited.' : 'Already in this session.'
})

// Look the person up. How to call: await look()
async function look() {
  if (searching.value) return
  found.value = null
  done.value = ''
  error.value = ''
  searching.value = true
  try {
    const person = await api.findByUsername(text.value)
    if (person) found.value = person
    else error.value = 'Nobody has that username. Check the spelling.'
  } catch (e) {
    error.value = e?.message || 'The username could not be looked up. Try again.'
  }
  searching.value = false
}

// Invite the person found. How to call: await invite()
async function invite() {
  if (!found.value || inviting.value || why.value) return
  inviting.value = true
  error.value = ''
  try {
    await events.inviteByUsername(props.session.id, found.value.id)
    done.value = `${found.value.name} is invited. They will see it on their Home screen.`
    found.value = null
    text.value = ''
  } catch (e) {
    error.value = e?.message || 'The invitation could not be sent. Try again.'
  }
  inviting.value = false
}
</script>

<template>
  <section class="byname" aria-labelledby="byname-head" data-testid="invite-by-username">
    <h3 id="byname-head" class="title-sm">Invite by username</h3>
    <form class="byname__form" novalidate @submit.prevent="look">
      <TextField v-model="text" label="Username" placeholder="for example sam_tan" autocomplete="off" autocapitalize="none" spellcheck="false" :error="error" @input="error = ''; done = ''" />
      <AppButton type="submit" small variant="secondary" :disabled="searching || !text.trim()">{{ searching ? 'Looking' : 'Find' }}</AppButton>
    </form>

    <div v-if="found" class="byname__found">
      <UserAvatar :name="found.name" :src="found.avatarUrl" :person="found.id" :size="44" />
      <span class="byname__who">
        <span class="title-sm truncate">{{ found.name }}</span>
        <span class="caption-sm text-muted truncate">@{{ found.username }}</span>
      </span>
      <span v-if="why" class="caption text-muted">{{ why }}</span>
      <AppButton v-else small :disabled="inviting" @click="invite">{{ inviting ? 'Inviting' : 'Invite' }}</AppButton>
    </div>

    <p v-if="done" class="body-sm" role="status">{{ done }}</p>
  </section>
</template>

<style scoped>
.byname { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.byname h3 { margin: 0; }
.byname__form { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-sm); }
.byname__form :deep(.field) { width: 100%; }
.byname__found { display: flex; align-items: center; gap: var(--spacing-md); min-height: 68px; }
.byname__who { display: flex; flex: 1 1 0; flex-direction: column; min-width: 0; }
</style>
