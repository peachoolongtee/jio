<script setup>
// "Change plan": the host's way back after the meeting place or the plan is set. A small button on the Vote and Itinerary screens, for the host
// only and only while the session is voting or confirmed (locating already has "We already have a place"; a finished or cancelled session never
// changes). It opens a question with up to two choices:
//   Choose places again    only from a confirmed plan: back to voting at the same meeting area. The stops go, the votes stay (the same route as
//                          the Itinerary's Re-plan).
//   Change meeting place   from voting or confirmed: a second question names what is lost in plain words (everyone's votes, the places to vote on,
//                          and with a plan its stops and any proposed places) and says everyone's starting places are kept. Confirming goes to
//                          the same two cards as Start ("Find the fairest spot", "We already know where"), at /sessions/:id/change-place; nothing
//                          is changed until the last button of that screen is pressed.
// A failure of "Choose places again" is said in the dialog, which stays open. Both questions are ModalDialogs: focus is trapped, Escape closes them.
//   <ChangePlan :session="session" />
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import { CHANGE_PLAN } from '@/lib/startChoice.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ session: { type: Object, required: true } })

const router = useRouter()
const auth = useAuthStore()
const events = useEventsStore()
const chooseOpen = ref(false)
const confirmOpen = ref(false)
const busy = ref(false)
const error = ref('')

const mayChange = computed(() => props.session.hostId === auth.myId && ['voting', 'confirmed'].includes(props.session.status))
const confirmed = computed(() => props.session.status === 'confirmed')
const lost = computed(() => CHANGE_PLAN.lost(confirmed.value))

// Opens the first question. How to call: open()
function open() {
  error.value = ''
  chooseOpen.value = true
}

// "Choose places again": the plan is opened for voting, and the host goes to the Vote screen. How to call: await again()
async function again() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await events.replan(props.session.id)
    chooseOpen.value = false
    await router.push(`/sessions/${props.session.id}/plan`)
  } catch (e) {
    error.value = e?.message || 'The plan could not be opened again. Try again.'
  } finally {
    busy.value = false
  }
}

// "Change meeting place": the first question closes and the second, which names what is lost, opens. How to call: await toConfirm()
async function toConfirm() {
  error.value = ''
  chooseOpen.value = false
  await nextTick()
  confirmOpen.value = true
}

// Confirmed: on to the cards. Nothing has been changed yet. How to call: await go()
async function go() {
  confirmOpen.value = false
  await router.push(`/sessions/${props.session.id}/change-place`)
}
</script>

<template>
  <div v-if="mayChange" class="change-plan">
    <AppButton variant="secondary" small class="change-plan__button" data-testid="change-plan" @click="open">
      <AppIcon name="edit" :size="16" />
      {{ CHANGE_PLAN.button }}
    </AppButton>

    <ModalDialog v-model:open="chooseOpen" :title="CHANGE_PLAN.title" :text="CHANGE_PLAN.text">
      <template #content>
        <div class="change-plan__choices">
          <button v-if="confirmed" type="button" class="change-plan__choice" :disabled="busy" data-testid="change-again" @click="again">
            <span class="title-sm">{{ busy ? 'Opening the plan' : CHANGE_PLAN.again.title }}</span>
            <span class="caption text-muted">{{ CHANGE_PLAN.again.text }}</span>
          </button>
          <button type="button" class="change-plan__choice" :disabled="busy" data-testid="change-place" @click="toConfirm">
            <span class="title-sm">{{ CHANGE_PLAN.place.title }}</span>
            <span class="caption text-muted">{{ CHANGE_PLAN.place.text }}</span>
          </button>
        </div>
        <p v-if="error" class="body-sm text-error" role="alert" data-testid="change-error">{{ error }}</p>
      </template>
      <AppButton block variant="secondary" @click="chooseOpen = false">Cancel</AppButton>
    </ModalDialog>

    <ModalDialog v-model:open="confirmOpen" :title="CHANGE_PLAN.confirmTitle">
      <template #content>
        <div class="change-plan__lost" data-testid="change-lost">
          <p class="body-md">This clears:</p>
          <ul class="change-plan__list body-md">
            <li v-for="item in lost" :key="item">{{ item }}</li>
          </ul>
          <p class="body-md">{{ CHANGE_PLAN.keeps }}</p>
        </div>
      </template>
      <AppButton block variant="secondary" @click="confirmOpen = false">{{ CHANGE_PLAN.keep }}</AppButton>
      <AppButton block variant="danger" data-testid="change-go" @click="go">{{ CHANGE_PLAN.go }}</AppButton>
    </ModalDialog>
  </div>
</template>

<style scoped>
.change-plan { display: flex; justify-content: flex-end; }
.change-plan__button { min-height: var(--tap-min); gap: var(--spacing-sm); }
.change-plan__choices { display: flex; flex-direction: column; gap: var(--spacing-sm); }
/* Each choice is one button, as tall as its words; 44px at least. */
.change-plan__choice {
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-xs);
  width: 100%; min-height: var(--tap-min); padding: var(--spacing-md) var(--spacing-base);
  border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); color: var(--ink);
  font: inherit; text-align: left; cursor: pointer;
}
.change-plan__choice:hover:not(:disabled) { border-color: var(--ink); }
.change-plan__choice:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.change-plan__choice:disabled { opacity: 0.6; cursor: default; }
.change-plan__lost p { margin: 0; }
.change-plan__list { margin: var(--spacing-xs) 0 var(--spacing-sm); padding-left: var(--spacing-lg); }
</style>
