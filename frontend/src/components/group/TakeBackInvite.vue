<script setup>
// The host takes back an invite nobody has answered yet: a small × beside an "Invited" name, then a question.
//   <TakeBackInvite :session-id="session.id" :person="{ id, name }" :remote="session.remote" />
// Only the host sees it, and only on a row that is still Invited. After "Take back" the person leaves the list. A real account's
// invitation cannot be sent to the same person again (the database keeps one per person per session), so the words say the link
// still works for them; the demo and local accounts can invite them again. A failure is said in the dialog, which stays open.
// It looks like RemoveMember, its neighbour on joined rows.
import { computed, ref } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import IconButton from '../ui/IconButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({
  sessionId: { type: String, required: true },
  person: { type: Object, required: true },
  remote: { type: Boolean, default: false },
})

const events = useEventsStore()
const open = ref(false)
const busy = ref(false)
const error = ref('')

const name = computed(() => props.person.name || 'This person')
const text = computed(() =>
  props.remote
    ? `${name.value} won't be able to join from this invite. They can still join with the session's link.`
    : `${name.value} won't be able to join from this invite. You can invite them again.`,
)

// How to call: await takeBack()
async function takeBack() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await events.revokeInvite(props.sessionId, props.person.id)
    open.value = false
  } catch (e) {
    error.value = e?.message || 'The invite could not be taken back. Try again.'
  }
  busy.value = false
}
</script>

<template>
  <IconButton :label="`Take back the invite to ${name}`" @click="error = ''; open = true"><AppIcon name="close" :size="16" /></IconButton>
  <ModalDialog v-model:open="open" title="Take back the invite?" :text="text">
    <template #content><p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p></template>
    <AppButton block variant="secondary" @click="open = false">Keep invite</AppButton>
    <AppButton block variant="danger" :disabled="busy" @click="takeBack">{{ busy ? 'Taking back' : 'Take back' }}</AppButton>
  </ModalDialog>
</template>
