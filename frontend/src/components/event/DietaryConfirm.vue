<script setup>
// "Confirm dietary needs" (ticket #107): asked of each person once per outing, when it reaches voting, on the Vote page. It
// opens with the outing's needs already selected, so the group's needs are in front of everyone before they vote. The chips
// are DietaryChips: a need someone else has is selected with no name, and taking it off asks first ("Unselect halal?"). The
// person's own picks are for this outing only (kept on the outing; the profile, their standing setting, is left as it is) and
// rank its places again. Closing it any other way confirms it as it is.
//   <DietaryConfirm v-model:open="open" :mine="plan.myDietary" :others="plan.othersDietary" :dropped="plan.dietDropped" @confirm="confirm" />
import { computed, ref, watch } from 'vue'
import AppButton from '../ui/AppButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import DietaryChips from './DietaryChips.vue'
import { cleanDietary } from '@/lib/signupRules.js'
import { needsText } from '@/lib/dietText.js'

const open = defineModel('open', { type: Boolean, default: false })
const props = defineProps({
  // The signed-in person's own needs, the needs of the others in the outing together, and those of the others' needs the
  // group already chose not to filter for.
  mine: { type: Array, default: () => [] },
  others: { type: Array, default: () => [] },
  dropped: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
  title: { type: String, default: 'Confirm dietary needs' },
})
// confirm({ mine, dropped }): the person's own needs, and the others' needs not to filter for.
const emit = defineEmits(['confirm'])

// The person's own picks and the dropped needs, from the outing each time the dialog opens; kept here until Confirm.
const picked = ref([])
const droppedNow = ref([])
watch(open, (now) => {
  if (!now) return
  picked.value = cleanDietary(props.mine)
  droppedNow.value = cleanDietary(props.dropped)
}, { immediate: true })

// How to call: keep({ mine: ['vegan'], dropped: ['halal'] })
function keep({ mine, dropped }) {
  picked.value = mine
  droppedNow.value = dropped
}

// How to call: capital('halal') -> 'Halal'
const capital = (text) => (text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : '')
// "Halal is needed by someone in this outing." for the needs still filtered; the dropped ones are said apart. No name, no count.
const sharedText = computed(() => {
  const kept = props.others.filter((n) => !droppedNow.value.includes(n))
  const text = needsText(kept)
  return text ? `${capital(text)} ${kept.length > 1 ? 'are' : 'is'} needed by someone in this outing.` : ''
})
const droppedText = computed(() => {
  const text = needsText(droppedNow.value.filter((n) => props.others.includes(n)))
  return text ? `Someone in this outing needs ${text}, but places will not be filtered for it.` : ''
})

// How to call: confirm()
function confirm() {
  if (!props.busy) emit('confirm', { mine: cleanDietary(picked.value), dropped: cleanDietary(droppedNow.value) })
}
</script>

<template>
  <ModalDialog v-model:open="open" :title="title" text="Food places for this outing will fit these needs. Your picks are for this outing only, and stay private: the group sees which needs places fit, never whose." @close="confirm">
    <template #content>
      <div data-testid="diet-confirm">
        <DietaryChips :mine="picked" :others="others" :dropped="droppedNow" :busy="busy" @change="keep" />
      </div>
      <p v-if="sharedText" class="caption-sm text-muted diet-note" data-testid="diet-locked">{{ sharedText }}</p>
      <p v-if="droppedText" class="caption-sm text-muted diet-note" data-testid="diet-dropped">{{ droppedText }}</p>
      <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    </template>
    <AppButton block :disabled="busy" data-testid="diet-confirm-button" @click="confirm">{{ busy ? 'Saving' : 'Confirm' }}</AppButton>
  </ModalDialog>
</template>

<style scoped>
.diet-note { margin: 0; }
</style>
