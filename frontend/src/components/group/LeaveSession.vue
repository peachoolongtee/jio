<script setup>
// A guest leaves a shared session: a quiet button, then a question. Leaving takes them off the list for everyone and the
// session disappears from theirs. The host cannot leave (they cancel the session instead), so it is not shown to them.
//   <LeaveSession :session-id="session.id" />
// A failure is said in the dialog, which stays open. After leaving, the person goes Home.
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '../ui/AppButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ sessionId: { type: String, required: true } })

const router = useRouter()
const events = useEventsStore()
const open = ref(false)
const busy = ref(false)
const error = ref('')

// How to call: await leave()
async function leave() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await events.leave(props.sessionId)
    open.value = false
    router.replace('/')
  } catch (e) {
    error.value = e?.message || 'You could not leave. Try again.'
  }
  busy.value = false
}
</script>

<template>
  <AppButton variant="tertiary" underline @click="error = ''; open = true">Leave session</AppButton>
  <ModalDialog v-model:open="open" title="Leave this session?" text="You will no longer see it, and the others will see that you left. You can join again with the invite link while it works.">
    <template #content><p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p></template>
    <AppButton block variant="secondary" @click="open = false">Stay</AppButton>
    <AppButton block variant="danger" :disabled="busy" @click="leave">{{ busy ? 'Leaving' : 'Leave session' }}</AppButton>
  </ModalDialog>
</template>
