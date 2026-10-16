<script setup>
// The host takes a guest out of a shared session: a small button beside their name, then a question.
//   <RemoveMember :session-id="session.id" :person="{ id, name }" />
// Only the host sees it, and never on themselves. The guest leaves the list at once for everyone; they can come back with
// the link while it works. A failure is said in the dialog, which stays open.
import { ref } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import IconButton from '../ui/IconButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({
  sessionId: { type: String, required: true },
  person: { type: Object, required: true },
})

const events = useEventsStore()
const open = ref(false)
const busy = ref(false)
const error = ref('')

// How to call: await remove()
async function remove() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await events.removeGuest(props.sessionId, props.person.id)
    open.value = false
  } catch (e) {
    error.value = e?.message || 'They could not be removed. Try again.'
  }
  busy.value = false
}
</script>

<template>
  <IconButton :label="`Remove ${person.name}`" @click="error = ''; open = true"><AppIcon name="close" :size="16" /></IconButton>
  <ModalDialog v-model:open="open" :title="`Remove ${person.name}?`" text="They leave this session and it disappears from their list. They can come back with the invite link while it works.">
    <template #content><p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p></template>
    <AppButton block variant="secondary" @click="open = false">Keep {{ person.name }}</AppButton>
    <AppButton block variant="danger" :disabled="busy" @click="remove">{{ busy ? 'Removing' : `Remove ${person.name}` }}</AppButton>
  </ModalDialog>
</template>
