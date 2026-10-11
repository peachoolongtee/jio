<script>
// The banner to show while voting: only the one that says the meeting area moved and the votes for places were
// cleared (the data layer marks it votesCleared). The other re-calculation banners stay out of the way.
// How to call: votesClearedBanner({ status: 'voting', banner: { text, votesCleared: true } }) -> the banner
export function votesClearedBanner(session) {
  return session.status === 'voting' && session.banner?.votesCleared ? session.banner : null
}
</script>

<script setup>
// The notices at the top of every session screen:
//   - Votes cleared, while voting, when the meeting area moved and took the votes with it (dismissible)
//   - Re-plan? after Confirmed, when a location changes or someone opts out
//   - Not enough people, when an opt-out leaves fewer than 2
//   - Cancelled
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '../ui/AppButton.vue'
import BannerNote from '../ui/BannerNote.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import { CANCEL_OUTING, isPaused } from '@/lib/session.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ session: { type: Object, required: true } })
const router = useRouter()
const events = useEventsStore()
const cancelOpen = ref(false)
const busy = ref(false)

const paused = computed(() => isPaused(props.session))
const clearedBanner = computed(() => votesClearedBanner(props.session))

async function dismissBanner() {
  try {
    await events.dismissBanner(props.session.id)
  } catch {
    // The banner stays; dismissing it again is the retry.
  }
}

async function answerReplan(accept) {
  busy.value = true
  await events.respondReplan(props.session.id, accept)
  busy.value = false
  if (accept) router.push(`/sessions/${props.session.id}/plan`)
}

async function cancel() {
  busy.value = true
  await events.cancel(props.session.id)
  busy.value = false
  cancelOpen.value = false
}
</script>

<template>
  <div v-if="session.status === 'cancelled' || paused || clearedBanner || (session.replan && session.status === 'confirmed')" class="notices">
    <BannerNote v-if="session.status === 'cancelled'" tone="error" icon="close">Session cancelled</BannerNote>

    <BannerNote v-if="clearedBanner" icon="info" dismissible @dismiss="dismissBanner">{{ clearedBanner.text }}</BannerNote>

    <BannerNote v-if="session.replan && session.status === 'confirmed'" tone="warning" icon="warning">
      <strong>Re-plan?</strong> {{ session.replan.reason }}
      <template #actions>
        <AppButton small :disabled="busy" @click="answerReplan(true)">Re-plan</AppButton>
        <AppButton small variant="secondary" :disabled="busy" @click="answerReplan(false)">Keep plan</AppButton>
      </template>
    </BannerNote>

    <BannerNote v-if="paused" tone="error" icon="people">
      Not enough people. Invite someone or cancel.
      <template #actions>
        <AppButton small :to="`/sessions/${session.id}/invite`">Invite someone</AppButton>
        <AppButton small variant="secondary" @click="cancelOpen = true">{{ CANCEL_OUTING.action }}</AppButton>
      </template>
    </BannerNote>


    <ModalDialog v-model:open="cancelOpen" :title="CANCEL_OUTING.title" :text="CANCEL_OUTING.text">
      <AppButton block variant="secondary" @click="cancelOpen = false">{{ CANCEL_OUTING.keep }}</AppButton>
      <AppButton block variant="danger" :disabled="busy" @click="cancel">{{ CANCEL_OUTING.confirm }}</AppButton>
    </ModalDialog>
  </div>
</template>

<style scoped>
.notices { display: flex; flex-direction: column; gap: var(--spacing-sm); }
</style>
