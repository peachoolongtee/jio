<script setup>
// A round 44px button that holds one icon. `label` is required: it is what a screen reader says.
// Pass `to` to make it a router link, for example the back arrow.
import { RouterLink } from 'vue-router'

defineProps({
  label: { type: String, required: true },
  outline: { type: Boolean, default: false },
  to: { type: [String, Object], default: null },
})
</script>

<template>
  <component
    :is="to ? RouterLink : 'button'"
    class="icon-btn"
    :class="{ 'icon-btn--outline': outline }"
    :to="to || undefined"
    :type="to ? undefined : 'button'"
    :aria-label="label"
  >
    <slot />
  </component>
</template>

<style scoped>
.icon-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--tap-min);
  height: var(--tap-min);
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--rounded-full);
  background: var(--surface-strong);
  color: var(--ink);
  cursor: pointer;
}
.icon-btn--outline { border: 1px solid var(--border-strong); background: var(--canvas); }
.icon-btn:disabled { color: var(--muted-soft); cursor: not-allowed; }
@media (hover: hover) {
  .icon-btn:not(:disabled):hover { background: var(--hairline); }
  .icon-btn--outline:not(:disabled):hover { border-color: var(--ink); background: var(--canvas); }
}
</style>
