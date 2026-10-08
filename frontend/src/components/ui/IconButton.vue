<script setup>
// A round 44px button that holds one icon. `label` is required: screen readers say it and it shows as a tooltip.
// Pass `to` to make it a router link, for example the back arrow.
import { RouterLink } from 'vue-router'

defineProps({
  label: { type: String, required: true },
  outline: { type: Boolean, default: false },
  tone: { type: String, default: '' },
  to: { type: [String, Object], default: null },
})
</script>

<template>
  <component
    :is="to ? RouterLink : 'button'"
    class="icon-btn"
    :class="{ 'icon-btn--outline': outline, 'icon-btn--brand': tone === 'brand' }"
    :to="to || undefined"
    :type="to ? undefined : 'button'"
    :aria-label="label"
    :title="label"
  >
    <slot />
  </component>
</template>

<style scoped>
/* icon-button-circle: a Surface Strong circle with an ink icon. The tap area is 44px. */
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
  transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}
/* The press shows at once (a darker circle); letting go eases back. */
.icon-btn:not(:disabled):active { background: var(--hairline); transition-duration: 0ms; }
.icon-btn--outline:not(:disabled):active { border-color: var(--ink); background: var(--surface-soft); }
/* `tone="brand"`: the Rausch orb, for the one main icon action on a screen (Create, Add photos). */
.icon-btn--brand { background: var(--primary); color: var(--on-primary); }
.icon-btn--brand:not(:disabled):active { background: var(--primary-active); }
/* icon-button-outline: white with a hairline ring. */
.icon-btn--outline { border: 1px solid var(--hairline); background: var(--canvas); }
.icon-btn:disabled { color: var(--muted-soft); cursor: not-allowed; }
@media (hover: hover) {
  .icon-btn:not(:disabled):hover { background: var(--hairline-soft); }
  .icon-btn--brand:not(:disabled):hover { background: var(--primary-active); }
  .icon-btn--outline:not(:disabled):hover { border-color: var(--ink); background: var(--canvas); }
}
</style>
