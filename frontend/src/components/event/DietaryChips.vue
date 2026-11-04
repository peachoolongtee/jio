<script>
// The chips for an outing's dietary needs: every need, selected when someone in the outing has it and the group has not
// dropped it, or when it is the viewer's own. `shared` marks a need someone else has, which needs a "Sure?" before the host drops it,
// and which a guest cannot change at all (`locked`): only the host drops someone else's need. The viewer's own need that the host
// dropped (`droppedMine`) is still theirs but not filtered for, so it shows unselected; selecting it again brings it back for the group.
// How to call: dietChips({ mine: ['vegan'], others: ['halal'], dropped: [], canDrop: false })
//   -> [{ value: 'halal', label: 'Halal', selected: true, shared: true, locked: true, droppedMine: false }, { value: 'vegetarian', ..., selected: false, shared: false, locked: false, droppedMine: false }, { value: 'vegan', ..., selected: true, shared: false, locked: false, droppedMine: false }]
import { DIETARY_OPTIONS } from '@/lib/signupRules.js'

export function dietChips({ mine = [], others = [], dropped = [], canDrop = false }) {
  return DIETARY_OPTIONS.map((o) => {
    const shared = others.includes(o.value)
    const droppedMine = !shared && mine.includes(o.value) && dropped.includes(o.value)
    const selected = (shared && !dropped.includes(o.value)) || (!shared && mine.includes(o.value) && !droppedMine)
    // A guest cannot take a need off that someone else has; their own need, dropped or not, stays theirs to select.
    return { ...o, selected, shared, locked: shared && !canDrop, droppedMine }
  })
}
</script>

<script setup>
// The Halal, Vegetarian and Vegan chips of an outing (ticket #107), used inline on the Vote page and inside "Confirm dietary
// needs". A tap picks a need or takes it off, at once: taking off a need someone else in the outing has no longer asks first (Darius,
// 4 November 2026: the "Unselect halal?" dialog was a step too many); the group's places then no longer have to fit it. Selecting it
// again brings it back. Only the host (`canDrop`) can do that: to a guest a need someone else has is selected and
// locked, with a line that says why. Everyone changes their own needs. It holds no state: each change is sent as
// `change({ mine, dropped })`, for the caller to keep or save.
//   <DietaryChips :mine="mine" :others="others" :dropped="dropped" :can-drop="isHost" label="Your dietary needs" @change="save" />
import { computed, useId } from 'vue'
import AppIcon from '../ui/AppIcon.vue'
import ChipButton from '../ui/ChipButton.vue'
import { cleanDietary } from '@/lib/signupRules.js'
import { needsText } from '@/lib/dietText.js'

const props = defineProps({
  // The signed-in person's own needs, the needs of the others in the outing together, and those of the others' needs the
  // group chose not to filter for.
  mine: { type: Array, default: () => [] },
  others: { type: Array, default: () => [] },
  dropped: { type: Array, default: () => [] },
  // Whether the person may drop a need someone else has: the host only.
  canDrop: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  // The group's accessible name.
  label: { type: String, default: 'Dietary needs' },
})
// change({ mine, dropped }): the person's own needs and the others' needs not to filter for, after a tap.
const emit = defineEmits(['change'])

const chips = computed(() => dietChips({ mine: props.mine, others: props.others, dropped: props.dropped, canDrop: props.canDrop }))
// The line under the chips for a guest, while a need someone else has is locked (also when it is the guest's own need too); it names no
// one. Each locked chip points to it.
const noteId = useId()
const locked = computed(() => chips.value.some((c) => c.locked))
// The viewer's own needs the host dropped, and the line that says the places may not fit them until they select it again. Each such chip
// points to it.
const droppedNoteId = useId()
const droppedMine = computed(() => chips.value.filter((c) => c.droppedMine).map((c) => c.value))
const droppedMineWord = computed(() => needsText(droppedMine.value))

// How to call: send(['vegan'], ['halal'])
const send = (mine, dropped) => emit('change', { mine: cleanDietary(mine), dropped: cleanDietary(dropped) })

// Pick a need or take it off. Taking off a need someone else has stops the group filtering for it (and takes it off the person's own
// needs too, if it is theirs).
// How to call: toggle(chip)
function toggle(chip) {
  if (props.busy || chip.locked) return
  const need = chip.value
  if (chip.selected && chip.shared) return send(props.mine.filter((n) => n !== need), [...props.dropped, need])
  // Back on, for a need someone else has, or the person's own that the host dropped: the group filters for it again.
  if (chip.shared || chip.droppedMine) return send(props.mine, props.dropped.filter((n) => n !== need))
  send(props.mine.includes(need) ? props.mine.filter((n) => n !== need) : [...props.mine, need], props.dropped)
}
</script>

<template>
  <div class="diet-chips-block">
    <div class="diet-chips" :class="{ 'is-busy': busy }" role="group" :aria-busy="busy ? 'true' : undefined" :aria-label="label" data-testid="diet-chips">
      <ChipButton v-for="chip in chips" :key="chip.value" check :selected="chip.selected" :disabled="busy || chip.locked" :aria-describedby="chip.droppedMine ? droppedNoteId : chip.locked ? noteId : undefined" @click="toggle(chip)">
        {{ chip.label }}
        <!-- A chip that is on and cannot be turned off carries a small lock, so it does not look like a choice. -->
        <AppIcon v-if="chip.locked && chip.selected" name="lock" :size="12" aria-hidden="true" data-testid="diet-lock" />
      </ChipButton>
    </div>
    <p v-if="locked" :id="noteId" class="caption-sm text-muted" data-testid="diet-locked-reason">Someone in the outing needs this, so it stays on. Only the host can change that.</p>
    <p v-if="droppedMine.length" :id="droppedNoteId" class="caption-sm text-muted" data-testid="diet-dropped-mine">The host stopped filtering places for {{ droppedMineWord }}, so they may not be {{ droppedMineWord }}. Select it to have them fit it again.</p>
  </div>
</template>

<style scoped>
.diet-chips-block { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.diet-chips-block > p { margin: 0; }
.diet-chips { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
/* While a change is saved and the places load, every chip is off, the selected ones too. */
.diet-chips.is-busy { opacity: 0.5; transition: opacity var(--motion-fast) var(--ease-out); }
</style>
