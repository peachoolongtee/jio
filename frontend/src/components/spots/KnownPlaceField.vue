<script setup>
// "We already have a place", on the create form: the host names the area now, and when the session starts the group goes
// straight to choosing places, with no list of spots to choose from. Optional; leave it alone and nothing changes.
//   <KnownPlaceField v-model="areaId" />
// v-model is the area's id, or '' for none. The area picker opens in a popover beside the button (LocationSheet).
// Only an area is kept, never a place.
import { computed, ref } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import LocationSheet from '../group/LocationSheet.vue'
import { AREAS } from '@/lib/mock/places.js'

const areaId = defineModel({ type: String, default: '' })
const open = ref(false)
const area = computed(() => AREAS.find((a) => a.id === areaId.value) || null)

// How to call: pick({ areaId: 'bugis' })
function pick(place) {
  areaId.value = place.areaId
}
</script>

<template>
  <section class="known" aria-labelledby="known-head">
    <h2 id="known-head" class="title-md">Already know where to meet?</h2>
    <template v-if="area">
      <p class="known__area"><AppIcon name="pin" :size="18" /><span class="title-md">{{ area.name }}</span></p>
      <p class="body-sm text-muted">When the session starts, the group goes straight to choosing places. Everyone can still add where they start.</p>
      <div class="known__actions">
        <AppButton variant="secondary" small @click="open = true">Change place</AppButton>
        <AppButton variant="tertiary" @click="areaId = ''">Remove<span class="sr-only"> {{ area.name }}</span></AppButton>
      </div>
    </template>
    <template v-else>
      <p class="body-sm text-muted">Skip the list of spots and go straight to choosing places.</p>
      <div class="known__actions">
        <AppButton variant="secondary" small @click="open = true">We already have a place</AppButton>
      </div>
    </template>
    <LocationSheet v-model:open="open" which="spot" title="Where is the place?" @select="pick" />
  </section>
</template>

<style scoped>
.known { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-sm); min-width: 0; }
.known h2, .known p { margin: 0; }
.known__area { display: flex; align-items: center; gap: var(--spacing-sm); min-width: 0; overflow-wrap: anywhere; }
.known__actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-base); }
</style>
