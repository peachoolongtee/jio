<script setup>
// "Any dietary needs?" (ticket #107): asked once, and skippable, the first time a person creates or joins an outing, in place
// of a question in sign-up. It opens on whatever page the outing lands on, while auth.dietAsk is true (auth.askDietOnce). The
// needs picked are saved on the profile, a standing private setting; "None, skip", the backdrop and Escape skip. Either way it
// is not asked again, and the needs can still be changed on the profile and on the Vote page.
//   <DietaryFirstAsk />   (once, in the app frame)
import { computed, ref, watch } from 'vue'
import AppButton from '../ui/AppButton.vue'
import ChipButton from '../ui/ChipButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import { DIETARY_OPTIONS, cleanDietary } from '@/lib/signupRules.js'
import { useAuthStore } from '@/stores/auth.js'

const auth = useAuthStore()
const picked = ref([])
const busy = ref(false)

// Starts empty each time it opens.
watch(() => auth.dietAsk, (now) => { if (now) picked.value = [] })

// The dialog stays up while the answer is saved.
const open = computed({
  get: () => auth.dietAsk || busy.value,
  set: (v) => { if (!v) answer([]) },
})

// How to call: toggle('halal')
function toggle(need) {
  picked.value = picked.value.includes(need) ? picked.value.filter((n) => n !== need) : [...picked.value, need]
}

// How to call: await answer(['halal']), or answer([]) to skip
async function answer(needs) {
  if (busy.value) return
  busy.value = true
  try {
    await auth.answerDietAsk(cleanDietary(needs))
  } catch {
    // Not saved: the profile page can still set them, and the question is not asked again.
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <ModalDialog
    v-model:open="open"
    title="Any dietary needs?"
    text="Food places for your outings will fit them. They stay private: the group sees which needs places fit, never whose. You can change them on your profile."
  >
    <template #content>
      <div class="first-ask__chips" role="group" aria-label="Dietary needs" data-testid="diet-first-ask">
        <ChipButton v-for="option in DIETARY_OPTIONS" :key="option.value" check :selected="picked.includes(option.value)" :disabled="busy" @click="toggle(option.value)">
          {{ option.label }}
        </ChipButton>
      </div>
    </template>
    <AppButton block :disabled="busy" data-testid="diet-first-save" @click="answer(picked)">{{ busy ? 'Saving' : picked.length ? 'Save' : 'None, skip' }}</AppButton>
  </ModalDialog>
</template>

<style scoped>
.first-ask__chips { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
</style>
