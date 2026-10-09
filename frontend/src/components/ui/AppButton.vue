<script setup>
// The four buttons of the design system.
//   primary   Lagoon fill. One per screen, for the main action.
//   secondary Ink outline on white.
//   tertiary  Text only. Add `underline` when it stands alone as a link.
//   pill      Small Lagoon pill, for example "Post".
//   danger    Error-red fill, for an action that cannot be undone, for example "Cancel session".
// `small` makes primary and secondary buttons 44px tall with smaller text, for actions inside cards.
// Pass `to` to make it a router link. A disabled button always renders as a real <button>.
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

const props = defineProps({
  variant: { type: String, default: 'primary', validator: (v) => ['primary', 'secondary', 'tertiary', 'pill', 'danger'].includes(v) },
  block: { type: Boolean, default: false },
  small: { type: Boolean, default: false },
  underline: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  to: { type: [String, Object], default: null },
  type: { type: String, default: 'button' },
})

const isLink = computed(() => !!props.to && !props.disabled)
</script>

<template>
  <component
    :is="isLink ? RouterLink : 'button'"
    class="btn"
    :class="[`btn--${variant}`, { 'btn--block': block, 'btn--underline': underline, 'btn--small': small }]"
    :to="isLink ? to : undefined"
    :type="isLink ? undefined : type"
    :disabled="isLink ? undefined : disabled"
  >
    <slot />
  </component>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  margin: 0;
  border: 0;
  font: var(--text-button-md);
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
.btn--block { display: flex; width: 100%; }

.btn--primary { height: 48px; padding: 0 var(--spacing-lg); border-radius: var(--rounded-sm); background: var(--primary); color: var(--on-primary); }
.btn--primary:active { background: var(--primary-active); }
.btn--primary:disabled { background: var(--primary-disabled); cursor: not-allowed; }

.btn--secondary { height: 48px; padding: 0 23px; border: 1px solid var(--ink); border-radius: var(--rounded-sm); background: var(--canvas); color: var(--ink); }
.btn--secondary:disabled { border-color: var(--border-strong); color: var(--muted-soft); cursor: not-allowed; }

.btn--tertiary { min-height: var(--tap-min); padding: 0; background: transparent; color: var(--ink); font: var(--text-button-sm); }
.btn--tertiary:hover, .btn--underline { text-decoration: underline; }
.btn--tertiary:disabled { color: var(--muted-soft); text-decoration: none; cursor: not-allowed; }

.btn--pill { height: var(--tap-min); padding: 0 20px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); font: var(--text-button-sm); }
.btn--pill:active { background: var(--primary-active); }
.btn--pill:disabled { background: var(--primary-disabled); cursor: not-allowed; }

.btn--danger { height: 48px; padding: 0 var(--spacing-lg); border-radius: var(--rounded-sm); background: var(--primary-error-text); color: var(--on-primary); }
.btn--danger:disabled { opacity: 0.5; cursor: not-allowed; }

.btn--small.btn--primary, .btn--small.btn--secondary, .btn--small.btn--danger { height: var(--tap-min); padding: 0 var(--spacing-base); font: var(--text-button-sm); }

@media (hover: hover) {
  .btn--primary:not(:disabled):hover, .btn--pill:not(:disabled):hover { background: var(--primary-active); }
  .btn--secondary:not(:disabled):hover { background: var(--surface-soft); }
  .btn--danger:not(:disabled):hover { background: var(--primary-error-text-hover); }
}
</style>
