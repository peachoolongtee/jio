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
  // Distance from the bottom edge, to clear a footer or the tab bar. The home indicator's inset is added to it.
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
  <!-- The live region is always there, so screen readers are listening before the first toast arrives. -->
  <div class="toast-region" role="status" :style="{ bottom: `calc(${offset}px + env(safe-area-inset-bottom, 0px))` }">
    <Transition name="toast">
      <div v-if="show" class="toast">
        <AppIcon name="check" :size="14" />
        <span>{{ text }}</span>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.toast-region {
  position: fixed;
  left: calc(var(--spacing-lg) + env(safe-area-inset-left, 0px));
  right: calc(var(--spacing-lg) + env(safe-area-inset-right, 0px));
  z-index: 40;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
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
