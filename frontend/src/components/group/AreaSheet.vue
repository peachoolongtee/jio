<script setup>
// Choose a different meeting area than the fairest one, or go back to the fairest.
// Areas are listed fairest first, each with the longest trip anyone in the group would make.
//   <AreaSheet v-model:open="open" :session-id="id" :current="session.area.id" :chosen="session.areaChosen" />
import { computed, ref, watch } from 'vue'
import AppIcon from '../ui/AppIcon.vue'
import AppButton from '../ui/AppButton.vue'
import BottomSheet from '../ui/BottomSheet.vue'
import InfoTag from '../ui/InfoTag.vue'
import TextField from '../ui/TextField.vue'
import { useEventsStore } from '@/stores/events.js'

const open = defineModel('open', { type: Boolean, default: false })
const props = defineProps({
  sessionId: { type: String, required: true },
  current: { type: String, default: '' },
  chosen: { type: Boolean, default: false },
})

const events = useEventsStore()
const options = ref([])
const query = ref('')
const busy = ref(false)
const error = ref('')

watch(open, async (isOpen) => {
  if (!isOpen) return
  query.value = ''
  error.value = ''
  options.value = await events.areaOptions(props.sessionId)
})

const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? options.value.filter((o) => o.name.toLowerCase().includes(q)) : options.value.slice(0, 8)
})

async function pick(areaId) {
  busy.value = true
  error.value = ''
  try {
    await events.setArea(props.sessionId, areaId)
    open.value = false
  } catch (e) {
    error.value = e.message
  }
  busy.value = false
}
</script>

<template>
  <BottomSheet v-model:open="open" title="Meeting area" tall>
    <TextField v-model="query" label="Search areas" hide-label placeholder="Search areas" type="text" inputmode="search" autocomplete="off" />
    <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    <ul class="areas" aria-label="Areas">
      <li v-for="o in shown" :key="o.id">
        <button type="button" class="area" :class="{ 'is-current': o.id === current }" :aria-pressed="String(o.id === current)" :disabled="busy" @click="pick(o.fairest ? null : o.id)">
          <span class="area__text">
            <span class="title-sm">{{ o.name }}</span>
            <span class="caption-sm text-muted">Longest trip {{ o.maxMinutes }} min</span>
          </span>
          <InfoTag v-if="o.fairest" tone="strong">Fairest</InfoTag>
          <AppIcon v-if="o.id === current" name="check" class="area__check" />
        </button>
      </li>
    </ul>
    <p v-if="!shown.length" class="body-sm text-muted">No areas match "{{ query.trim() }}".</p>
    <template v-if="chosen" #footer>
      <AppButton block variant="secondary" :disabled="busy" @click="pick(null)">Use fairest area</AppButton>
    </template>
  </BottomSheet>
</template>

<style scoped>
.areas { display: flex; flex-direction: column; }
.area { display: flex; align-items: center; gap: var(--spacing-md); width: 100%; min-height: 60px; padding: var(--spacing-sm) var(--spacing-md); border: 0; border-radius: var(--rounded-sm); background: transparent; color: var(--ink); text-align: left; }
.area__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
.area.is-current { background: var(--surface-soft); box-shadow: inset 0 0 0 2px var(--ink); }
.area__check { color: var(--ink); }
@media (hover: hover) { .area:not(.is-current):not(:disabled):hover { background: var(--surface-soft); } }
</style>
