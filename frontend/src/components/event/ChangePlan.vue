<script setup>
// "Change plan": the host's way back after the meeting place or the plan is set. A small button on the Vote and Itinerary screens, for the host
// only, never a light meetup, and only while the session is voting or confirmed (locating has "Pick the place yourself"; a finished or cancelled session never
// changes). It opens a question with up to two choices:
//   Choose places again    only from a confirmed plan: back to voting at the same meeting area. The stops go, the votes stay (the same route as
//                          the Itinerary's Re-plan).
//   Change meeting place   from voting or confirmed: a second question names what is lost in plain words (everyone's votes, the places to vote on,
//                          and with a plan its stops and any proposed places) and says everyone's starting places are kept. Confirming goes to
//                          the same two cards as Start ("Find the fairest spot", "We already know where"), at /sessions/:id/change-place; nothing
//                          is changed until the last button of that screen is pressed.
// A failure of "Choose places again" is said in the dialog, which stays open. Both questions are ONE ModalDialog whose content changes (so two dialogs
// never overlap while one leaves): focus is trapped, Escape closes it, and when the question replaces the choices focus moves to its safer button.
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
const dialogOpen = ref(false)
// Which question the dialog asks: 'choose' (what to change) or 'confirm' (what is lost).
const step = ref('choose')
const busy = ref(false)
const error = ref('')

// A light meetup ("Already out?" on Home) has no votes and no meeting place to change, so it never has the button.
const mayChange = computed(() => !props.session.light && props.session.hostId === auth.myId && ['voting', 'confirmed'].includes(props.session.status))
const confirmed = computed(() => props.session.status === 'confirmed')
const lost = computed(() => CHANGE_PLAN.lost(confirmed.value))

// Opens the first question. How to call: open()
function open() {
  error.value = ''
  step.value = 'choose'
  dialogOpen.value = true
}

// "Choose places again": the plan is opened for voting, and the host goes to the Vote screen. How to call: await again()
async function again() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await events.replan(props.session.id)
    dialogOpen.value = false
    await router.push(`/sessions/${props.session.id}/plan`)
  } catch (e) {
    error.value = e?.message || 'The plan could not be opened again. Try again.'
  } finally {
    busy.value = false
  }
}

// "Change meeting place": the second question, which names what is lost, replaces the first, and focus goes to its safer button.
// How to call: await toConfirm()
async function toConfirm() {
  error.value = ''
  step.value = 'confirm'
  await nextTick()
  document.querySelector('[data-testid=change-keep]')?.focus?.()
}

// Confirmed: on to the cards. Nothing has been changed yet. How to call: await go()
async function go() {
  dialogOpen.value = false
  await router.push(`/sessions/${props.session.id}/change-place`)
}
</script>

<template>
  <div v-if="mayChange" class="change-plan">
    <AppButton variant="secondary" small class="change-plan__button" :aria-label="CHANGE_PLAN.button" :title="CHANGE_PLAN.button" data-testid="change-plan" @click="open">
      <AppIcon name="edit" :size="16" />
      <span class="change-plan__word">{{ CHANGE_PLAN.button }}</span>
    </AppButton>

    <!-- Escape and the backdrop are ignored while "Choose places again" runs: the plan would still open, the page would jump, and a failure would land on a closed dialog. -->
    <ModalDialog :open="dialogOpen" :title="step === 'choose' ? CHANGE_PLAN.title : CHANGE_PLAN.confirmTitle" :text="step === 'choose' ? CHANGE_PLAN.text : ''" @update:open="(on) => { if (on || !busy) dialogOpen = on }">
      <template #content>
        <div v-if="step === 'choose'" class="change-plan__choices">
          <button v-if="confirmed" type="button" class="change-plan__choice" :disabled="busy" data-testid="change-again" @click="again">
            <span class="title-sm">{{ busy ? 'Opening the plan' : CHANGE_PLAN.again.title }}</span>
            <span class="caption text-muted">{{ CHANGE_PLAN.again.text }}</span>
          </button>
          <button type="button" class="change-plan__choice" :disabled="busy" data-testid="change-place" @click="toConfirm">
            <span class="title-sm">{{ CHANGE_PLAN.place.title }}</span>
            <span class="caption text-muted">{{ CHANGE_PLAN.place.text }}</span>
          </button>
        </div>
        <div v-else class="change-plan__lost" data-testid="change-lost">
          <p class="body-md">This clears:</p>
          <ul class="change-plan__list body-md">
            <li v-for="item in lost" :key="item">{{ item }}</li>
          </ul>
          <p class="body-md">{{ CHANGE_PLAN.keeps }}</p>
        </div>
        <p v-if="error" class="body-sm text-error" role="alert" data-testid="change-error">{{ error }}</p>
      </template>
      <template v-if="step === 'choose'">
        <AppButton block variant="secondary" :disabled="busy" @click="dialogOpen = false">Cancel</AppButton>
      </template>
      <template v-else>
        <AppButton block variant="secondary" data-testid="change-keep" @click="dialogOpen = false">{{ CHANGE_PLAN.keep }}</AppButton>
        <AppButton block variant="danger" data-testid="change-go" @click="go">{{ CHANGE_PLAN.go }}</AppButton>
      </template>
    </ModalDialog>
  </div>
</template>

<style scoped>
.change-plan { display: flex; justify-content: flex-end; }
.change-plan__button { min-height: var(--tap-min); gap: var(--spacing-sm); }
/* Phones: in the header beside Hold to cancel there is room only for the pencil, a round button; its name stays its label and tooltip. */
@media (max-width: 743.98px) {
  .change-plan__button { width: var(--tap-min); min-width: var(--tap-min); padding: 0; }
  .change-plan__word { display: none; }
}
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
.change-plan__list { margin: var(--spacing-xs) 0 var(--spacing-sm); padding-left: var(--spacing-lg); list-style: disc; }
</style>
