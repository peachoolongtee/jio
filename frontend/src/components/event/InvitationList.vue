<script setup>
// The invitations other people made to this person by username, on Home and Sessions: the session's title and time, who
// invited them, and Join or Decline. It shows nothing when there are none, and for the demo account and local accounts,
// which have no invitations. A new invitation arrives while the page is open. Joining opens the session; a failure is said
// under the invitation, and an invitation that no longer works says so and can be declined.
//   <InvitationList />
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '../ui/AppButton.vue'
import { dateLine } from '@/lib/session.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'

const router = useRouter()
const auth = useAuthStore()
const events = useEventsStore()
// The invitation being answered, by token, and the sentence for one that failed.
const busy = ref('')
const problems = ref({})

const real = computed(() => auth.signedIn && !auth.sampleWorld)
onMounted(() => {
  if (real.value) events.loadInvitations().catch(() => {})
})

// How to call: await join(invitation)
async function join(invitation) {
  if (busy.value) return
  busy.value = invitation.token
  problems.value = { ...problems.value, [invitation.token]: '' }
  try {
    const session = await events.acceptInvitation(invitation)
    router.push(`/sessions/${session.id}`)
  } catch (e) {
    problems.value = { ...problems.value, [invitation.token]: e?.message || 'You could not join. Try again.' }
  }
  busy.value = ''
}

// How to call: await decline(invitation)
async function decline(invitation) {
  if (busy.value) return
  busy.value = invitation.token
  try {
    await events.declineInvitation(invitation)
  } catch (e) {
    problems.value = { ...problems.value, [invitation.token]: e?.message || 'The invitation could not be declined. Try again.' }
  }
  busy.value = ''
}
</script>

<template>
  <section v-if="real && events.invitations.length" id="invitations" class="invitations" aria-labelledby="invitations-head" data-testid="invitations">
    <h2 id="invitations-head" class="display-sm">Invitations</h2>
    <ul class="invitations__list">
      <li v-for="invitation in events.invitations" :key="invitation.token" class="card invitations__item">
        <div class="invitations__text">
          <span class="title-md clamp-2">{{ invitation.title }}</span>
          <span class="caption text-muted tnum">{{ dateLine(invitation) }}</span>
          <span class="caption text-muted">{{ invitation.hostName || 'Someone' }} invited you</span>
        </div>
        <p v-if="problems[invitation.token]" class="body-sm text-error" role="alert">{{ problems[invitation.token] }}</p>
        <div class="invitations__actions">
          <AppButton small :disabled="!!busy" :aria-label="`Join ${invitation.title}`" @click="join(invitation)">{{ busy === invitation.token ? 'Working' : 'Join' }}</AppButton>
          <AppButton small variant="secondary" :disabled="!!busy" :aria-label="`Decline ${invitation.title}`" @click="decline(invitation)">Decline</AppButton>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.invitations { display: flex; flex-direction: column; gap: var(--spacing-md); scroll-margin-top: var(--spacing-xl); }
.invitations h2 { margin: 0; }
.invitations__list { display: grid; grid-template-columns: 1fr; gap: var(--spacing-md); margin: 0; padding: 0; list-style: none; }
@media (min-width: 744px) { .invitations__list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.invitations__item { gap: var(--spacing-md); }
.invitations__text { display: flex; flex-direction: column; gap: var(--spacing-xxs); min-width: 0; }
.invitations__actions { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
</style>
