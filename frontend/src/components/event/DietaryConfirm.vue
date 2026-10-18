<script>
// The chips "Confirm dietary needs" shows: every need, selected when someone in the outing has it. A need someone else has is
// locked on (it is theirs, not the viewer's to take off); the viewer's own can be picked or taken off.
// How to call: dietChips({ mine: ['vegan'], others: ['halal'] })
//   -> [{ value: 'halal', label: 'Halal', selected: true, locked: true }, { value: 'vegetarian', ... }, { value: 'vegan', ..., selected: true, locked: false }]
import { DIETARY_OPTIONS } from '@/lib/signupRules.js'

export function dietChips({ mine = [], others = [] }) {
  return DIETARY_OPTIONS.map((o) => ({ ...o, selected: mine.includes(o.value) || others.includes(o.value), locked: others.includes(o.value) }))
}
</script>

<script setup>
// "Confirm dietary needs" (ticket #107): asked of each person once per outing, when it reaches voting, on the Vote page. It
// opens with the outing's needs already selected, so the group's needs are in front of everyone before they vote. A need
// someone else has is shown locked with no name; the person confirms or changes their own, which is saved on their profile
// (a standing setting) and ranks their outings again. Closing it any other way confirms it as it is.
//   <DietaryConfirm v-model:open="open" :mine="plan.myDietary" :others="plan.othersDietary" @confirm="confirm" />
import { computed, ref, watch } from 'vue'
import AppButton from '../ui/AppButton.vue'
import ChipButton from '../ui/ChipButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import { cleanDietary } from '@/lib/signupRules.js'
import { needsText } from '@/lib/dietText.js'

const open = defineModel('open', { type: Boolean, default: false })
const props = defineProps({
  // The signed-in person's own needs, and the needs of the others in the outing together.
  mine: { type: Array, default: () => [] },
  others: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})
// confirm(needs): the person's own needs, as picked.
const emit = defineEmits(['confirm'])

// The person's own picks, from their profile each time the dialog opens.
const picked = ref([])
watch(open, (now) => { if (now) picked.value = cleanDietary(props.mine) }, { immediate: true })

const chips = computed(() => dietChips({ mine: picked.value, others: props.others }))
// "Halal is needed by someone in this outing." No name, no count.
const lockedText = computed(() => {
  const text = needsText(props.others)
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)} ${props.others.length > 1 ? 'are' : 'is'} needed by someone in this outing.` : ''
})

// Pick one of your own needs, or take it off. A locked one does nothing.
// How to call: toggle('halal')
function toggle(chip) {
  if (chip.locked) return
  picked.value = picked.value.includes(chip.value) ? picked.value.filter((d) => d !== chip.value) : [...picked.value, chip.value]
}

// How to call: confirm()
function confirm() {
  if (!props.busy) emit('confirm', cleanDietary(picked.value))
}
</script>

<template>
  <ModalDialog v-model:open="open" title="Confirm dietary needs" text="Food places will fit these needs. Yours are saved on your profile and stay private: the group sees which needs places fit, never whose." @close="confirm">
    <template #content>
      <div class="diet-pick" role="group" aria-label="Dietary needs" data-testid="diet-confirm">
        <ChipButton v-for="chip in chips" :key="chip.value" check :selected="chip.selected" :disabled="chip.locked || busy" @click="toggle(chip)">
          {{ chip.label }}
        </ChipButton>
      </div>
      <p v-if="lockedText" class="caption-sm text-muted diet-locked" data-testid="diet-locked">{{ lockedText }}</p>
      <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    </template>
    <AppButton block :disabled="busy" data-testid="diet-confirm-button" @click="confirm">{{ busy ? 'Saving' : 'Confirm' }}</AppButton>
  </ModalDialog>
</template>

<style scoped>
.diet-pick { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
.diet-locked { margin: 0; }
</style>
