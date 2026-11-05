<script>
// The banner to show while voting: only the one that says places changed under the group and votes may have gone with them
// (the data layer marks it votesCleared): the meeting area moved, the radius changed, or a dietary need changed. The last one
// (byDiet, which never says whose) shows whether or not a vote went with the places, because the places the group sees changed.
// The other re-calculation banners stay out of the way.
// How to call: votesClearedBanner({ status: 'voting', banner: { text, votesCleared: true } }) -> the banner
export function votesClearedBanner(session) {
  return session.status === 'voting' && (session.banner?.votesCleared || session.banner?.byDiet) ? session.banner : null
}
</script>

<script setup>
// The notices at the top of every session screen:
//   - Votes cleared, while voting, when the meeting area moved and took the votes with it (dismissible)
//   - Re-plan? after Confirmed, when a location changes or someone opts out. On the server only the host answers it (the others are told
//     who decides); a refusal or a failure is one line under the question, with the buttons still there to try again.
//   - Not enough people, when an opt-out leaves fewer than 2
//   - Cancelled
//   - Closed, for an outing completed two days past its end with no confirmed plan (lib/api.js settleOutings)
//   - No coins, for an outing of one person that finished (by hand or by itself): outings with friends earn JioCoins
// Cancelled and paused are states the session is in, not news: they say role="status", so they are not read out as an
// alert each time the screen loads.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '../ui/AppButton.vue'
import BannerNote from '../ui/BannerNote.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import { CANCEL_OUTING, NO_COINS, isPaused } from '@/lib/session.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ session: { type: Object, required: true } })
const router = useRouter()
const events = useEventsStore()
const auth = useAuthStore()
const cancelOpen = ref(false)
const busy = ref(false)
const replanError = ref('')
// Who answers "Re-plan?": anyone in a session of this browser; only the host in a shared one (the server's rule).
const mayAnswer = computed(() => !props.session.remote || props.session.hostId === auth.myId)

const paused = computed(() => isPaused(props.session))
const clearedBanner = computed(() => votesClearedBanner(props.session))
const closed = computed(() => props.session.status === 'completed' && props.session.endedBy === 'closed')
// A finished outing that paid nothing because only one person was in it (`paid` is absent on a session saved before it was kept).
const noCoins = computed(() => props.session.status === 'completed' && props.session.endedBy !== 'closed' && props.session.paid === false)

async function dismissBanner() {
  try {
    await events.dismissBanner(props.session.id)
  } catch {
    // The banner stays; dismissing it again is the retry.
  }
}

async function answerReplan(accept) {
  busy.value = true
  replanError.value = ''
  try {
    await events.respondReplan(props.session.id, accept)
  } catch (e) {
    replanError.value = e.message
    return
  } finally {
    busy.value = false
  }
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
  <div v-if="session.status === 'cancelled' || closed || noCoins || paused || clearedBanner || (session.replan && session.status === 'confirmed')" class="notices">
    <BannerNote v-if="session.status === 'cancelled'" tone="error" icon="close" role="status">Session cancelled</BannerNote>
    <BannerNote v-if="closed" icon="clock" role="status">This outing closed by itself two days after its end time, without a confirmed plan.</BannerNote>
    <BannerNote v-if="noCoins" icon="info" role="status" data-testid="no-coins-notice">{{ NO_COINS.done }}</BannerNote>

    <BannerNote v-if="clearedBanner" icon="info" dismissible @dismiss="dismissBanner">{{ clearedBanner.text }}</BannerNote>

    <BannerNote v-if="session.replan && session.status === 'confirmed'" tone="warning" icon="warning">
      <strong>Re-plan?</strong> {{ session.replan.reason }}
      <template v-if="!mayAnswer"> {{ session.hostName || 'The host' }} decides.</template>
      <template v-if="replanError"><span class="replan-error text-error" role="alert" data-testid="replan-error">{{ replanError }}</span></template>
      <template v-if="mayAnswer" #actions>
        <AppButton small :disabled="busy" @click="answerReplan(true)">Re-plan</AppButton>
        <AppButton small variant="secondary" :disabled="busy" @click="answerReplan(false)">Keep plan</AppButton>
      </template>
    </BannerNote>

    <BannerNote v-if="paused" tone="error" icon="people" role="status">
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
.replan-error { display: block; }
</style>
