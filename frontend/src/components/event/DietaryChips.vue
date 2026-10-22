<script>
// The chips for an outing's dietary needs: every need, selected when someone in the outing has it and the group has not
// dropped it, or when it is the viewer's own. `shared` marks a need someone else has, which needs a "Sure?" before it goes.
// How to call: dietChips({ mine: ['vegan'], others: ['halal'], dropped: [] })
//   -> [{ value: 'halal', label: 'Halal', selected: true, shared: true }, { value: 'vegetarian', ..., selected: false, shared: false }, { value: 'vegan', ..., selected: true, shared: false }]
import { DIETARY_OPTIONS } from '@/lib/signupRules.js'

export function dietChips({ mine = [], others = [], dropped = [] }) {
  return DIETARY_OPTIONS.map((o) => {
    const shared = others.includes(o.value)
    return { ...o, selected: (shared && !dropped.includes(o.value)) || (!shared && mine.includes(o.value)), shared }
  })
}
</script>

<script setup>
// The Halal, Vegetarian and Vegan chips of an outing (ticket #107), used inline on the Vote page and inside "Confirm dietary
// needs". A tap picks a need or takes it off. Taking off a need someone else in the outing has asks first, in a dialog that
// reminds the person someone needs it ("Unselect halal?"); then the group's places no longer have to fit it. Selecting it again
// brings it back with no question. It holds no state: each change is sent as `change({ mine, dropped })`, for the caller to keep
// or save.
//   <DietaryChips :mine="mine" :others="others" :dropped="dropped" label="Your dietary needs" @change="save" />
import { computed, ref } from 'vue'
import AppButton from '../ui/AppButton.vue'
import ChipButton from '../ui/ChipButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import { cleanDietary } from '@/lib/signupRules.js'
import { needsText } from '@/lib/dietText.js'

const props = defineProps({
  // The signed-in person's own needs, the needs of the others in the outing together, and those of the others' needs the
  // group chose not to filter for.
  mine: { type: Array, default: () => [] },
  others: { type: Array, default: () => [] },
  dropped: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  // The group's accessible name.
  label: { type: String, default: 'Dietary needs' },
})
// change({ mine, dropped }): the person's own needs and the others' needs not to filter for, after a tap.
const emit = defineEmits(['change'])

const chips = computed(() => dietChips({ mine: props.mine, others: props.others, dropped: props.dropped }))

// The need waiting for "Unselect halal?", or ''.
const asking = ref('')
const askingWord = computed(() => needsText([asking.value]))

// How to call: send(['vegan'], ['halal'])
const send = (mine, dropped) => emit('change', { mine: cleanDietary(mine), dropped: cleanDietary(dropped) })

// Pick a need or take it off. Taking off a need someone else has asks first.
// How to call: toggle(chip)
function toggle(chip) {
  if (props.busy) return
  const need = chip.value
  if (chip.selected && chip.shared) {
    asking.value = need
    return
  }
  // Back on, for a need someone else has: the group filters for it again.
  if (chip.shared) return send(props.mine, props.dropped.filter((n) => n !== need))
  send(props.mine.includes(need) ? props.mine.filter((n) => n !== need) : [...props.mine, need], props.dropped)
}

// "Unselect halal": the group's places no longer have to fit it, and if it is the person's own too, it comes off.
// How to call: dropAsked()
function dropAsked() {
  const need = asking.value
  asking.value = ''
  send(props.mine.filter((n) => n !== need), [...props.dropped, need])
}
</script>

<template>
  <div class="diet-chips" :class="{ 'is-busy': busy }" role="group" :aria-busy="busy ? 'true' : undefined" :aria-label="label" data-testid="diet-chips">
    <ChipButton v-for="chip in chips" :key="chip.value" check :selected="chip.selected" :disabled="busy" @click="toggle(chip)">
      {{ chip.label }}
    </ChipButton>
  </div>

  <!-- Taking off a need someone else in the outing has: the safer choice first. -->
  <ModalDialog
    :open="!!asking"
    :title="`Unselect ${askingWord}?`"
    :text="`Someone in this outing needs ${askingWord}. If you unselect it, the places suggested to the group may not be ${askingWord}.`"
    @update:open="(v) => { if (!v) asking = '' }"
  >
    <AppButton block data-testid="diet-keep" @click="asking = ''">Keep {{ askingWord }}</AppButton>
    <AppButton block variant="secondary" data-testid="diet-drop" @click="dropAsked">Unselect {{ askingWord }}</AppButton>
  </ModalDialog>
</template>

<style scoped>
.diet-chips { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
/* While a change is saved and the places load, every chip is off, the selected ones too. */
.diet-chips.is-busy { opacity: 0.5; transition: opacity var(--motion-fast) var(--ease-out); }
</style>
