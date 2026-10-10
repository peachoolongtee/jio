<script setup>
// A short confirmation that appears above the bottom of the screen and leaves by itself.
//   <ToastMessage v-model:show="copied" text="Link copied" />
// It hides after `duration` milliseconds. Pass 0 to keep it until `show` is set to false.
import { onBeforeUnmount, watch } from 'vue'
import AppIcon from './AppIcon.vue'

const show = defineModel('show', { type: Boolean, default: false })
const props = defineProps({
  text: { type: String, required: true },
  duration: { type: Number, default: 2500 },
  // Distance from the bottom edge, to clear a footer or the tab bar.
  offset: { type: Number, default: 96 },
})

let timer = null
watch(show, (visible) => {
  clearTimeout(timer)
  if (visible && props.duration > 0) timer = setTimeout(() => { show.value = false }, props.duration)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <Transition name="toast">
    <div v-if="show" class="toast" role="status" :style="{ bottom: offset + 'px' }">
      <AppIcon name="check" :size="14" />
      <span>{{ text }}</span>
    </div>
  </Transition>
</template>

<style scoped>
.toast {
  position: fixed;
  left: var(--spacing-lg);
  right: var(--spacing-lg);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  /* Only as wide as its text, centred, and never wider than the phone column. */
  width: fit-content;
  max-width: var(--dialog-max-width);
  margin: 0 auto;
  min-height: 40px;
  padding: var(--spacing-sm) var(--spacing-base);
  border-radius: var(--rounded-full);
  background: var(--ink);
  color: var(--on-dark);
  font: var(--text-caption);
}
.toast-enter-active, .toast-leave-active { transition: opacity var(--motion-fast) var(--ease-out); }
.toast-enter-from, .toast-leave-to { opacity: 0; }
</style>
