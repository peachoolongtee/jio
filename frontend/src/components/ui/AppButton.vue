<script setup>
// The four buttons of the design system.
//   primary   The main action, one per screen. A white pill with a Rausch dot; on hover (or keyboard focus) the dot
//             swells to fill it Rausch and the label slides out as it slides back in with an arrow. Touch screens,
//             which cannot hover, show the filled Rausch pill with its arrow from the start.
//   secondary Ink outline on white.
//   tertiary  Text only. Add `underline` when it stands alone as a link.
//   pill      Small Rausch pill, for example "Set".
//   danger    Error-red fill, for an action that cannot be undone, for example "Cancel session".
// `small` makes primary and secondary buttons 44px tall with smaller text, for actions inside cards.
// Pass `to` to make it a router link, or `href` for a link to another site (add target="_blank" to open a new tab;
// it gets rel="noopener"). A disabled button always renders as a real <button>.
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  variant: { type: String, default: 'primary', validator: (v) => ['primary', 'secondary', 'tertiary', 'pill', 'danger'].includes(v) },
  block: { type: Boolean, default: false },
  small: { type: Boolean, default: false },
  underline: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  to: { type: [String, Object], default: null },
  href: { type: String, default: null },
  type: { type: String, default: 'button' },
})

const isLink = computed(() => !!props.to && !props.disabled)
const isAnchor = computed(() => !!props.href && !props.disabled)
</script>

<template>
  <component
    :is="isLink ? RouterLink : isAnchor ? 'a' : 'button'"
    class="btn"
    :class="[`btn--${variant}`, { 'btn--block': block, 'btn--underline': underline, 'btn--small': small }]"
    :to="isLink ? to : undefined"
    :href="isAnchor ? href : undefined"
    :rel="isAnchor ? 'noopener' : undefined"
    :type="isLink || isAnchor ? undefined : type"
    :disabled="isLink || isAnchor ? undefined : disabled"
  >
    <template v-if="variant === 'primary'">
      <span class="btn__dot" aria-hidden="true" />
      <span class="btn__label"><slot /></span>
      <span class="btn__reveal" aria-hidden="true"><slot /><AppIcon name="arrow-right" :size="18" /></span>
    </template>
    <slot v-else />
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
  transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), transform 260ms var(--ease-spring), box-shadow var(--motion-fast) var(--ease-out);
}
/* The press shows at once (darker, and the button gives a little); letting go springs back. */
.btn:not(:disabled):active { transform: scale(0.97); transition-duration: 0ms, 0ms, 0ms, 80ms, 0ms; }
.btn--block { display: flex; width: 100%; }

/* button-primary: the interactive hover pill. 48px tall, fully round, ink label beside a small Rausch dot.
   Hover or keyboard focus: the dot swells to fill the pill, the label slides right and fades, and a white copy
   with an arrow slides in from the right. */
.btn--primary { position: relative; isolation: isolate; overflow: hidden; height: 48px; min-width: 160px; padding: 0 var(--spacing-lg) 0 calc(var(--spacing-base) + 18px); border: 1px solid var(--border-strong); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); font-weight: 600; }
.btn__dot { position: absolute; top: calc(50% - 4px); left: var(--spacing-base); z-index: -1; width: 8px; height: 8px; border-radius: var(--rounded-full); background: var(--primary); transition: all 300ms var(--ease-out); }
.btn__label { display: inline-flex; align-items: center; gap: var(--spacing-sm); transform: translateX(0); transition: transform 300ms var(--ease-out), opacity 300ms var(--ease-out); }
.btn__reveal { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: var(--spacing-sm); color: var(--on-primary); opacity: 0; transform: translateX(48px); transition: transform 300ms var(--ease-out), opacity 300ms var(--ease-out); }
.btn--primary:not(:disabled):focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
@media (hover: hover) {
  .btn--primary:not(:disabled):hover, .btn--primary:not(:disabled):focus-visible { border-color: var(--primary); }
  .btn--primary:not(:disabled):is(:hover, :focus-visible) .btn__dot { top: 0; left: 0; width: 100%; height: 100%; border-radius: 0; transform: scale(1.8); }
  .btn--primary:not(:disabled):is(:hover, :focus-visible) .btn__label { opacity: 0; transform: translateX(48px); }
  .btn--primary:not(:disabled):is(:hover, :focus-visible) .btn__reveal { opacity: 1; transform: translateX(-4px); }
}
/* Touch screens: no hover to reveal it, so start filled, with the arrow. */
@media (hover: none) {
  .btn--primary:not(:disabled) { border-color: var(--primary); }
  .btn--primary:not(:disabled) .btn__dot { top: 0; left: 0; width: 100%; height: 100%; border-radius: 0; transform: scale(1.8); transition: none; }
  .btn--primary:not(:disabled) .btn__label { opacity: 0; }
  .btn--primary:not(:disabled) .btn__reveal { opacity: 1; transform: none; transition: none; }
  .btn--primary:not(:disabled):active .btn__dot { background: var(--primary-active); }
}
.btn--primary:disabled { border-color: var(--hairline); color: var(--muted-soft); cursor: not-allowed; }
.btn--primary:disabled .btn__dot { background: var(--primary-disabled); }

/* button-secondary: white, ink text, 1px ink outline. */
.btn--secondary { height: 48px; padding: 0 23px; border: 1px solid var(--ink); border-radius: var(--rounded-sm); background: var(--canvas); color: var(--ink); }
.btn--secondary:not(:disabled):active { background: var(--surface-strong); }
.btn--secondary:disabled { border-color: var(--border-strong); color: var(--muted-soft); cursor: not-allowed; }

/* button-tertiary-text: plain ink, underlined on hover. */
.btn--tertiary { min-height: var(--tap-min); padding: 0; background: transparent; color: var(--ink); font: var(--text-button-sm); }
.btn--tertiary:hover, .btn--underline { text-decoration: underline; }
.btn--tertiary:not(:disabled):active { color: var(--muted); }
.btn--tertiary:disabled { color: var(--muted-soft); text-decoration: none; cursor: not-allowed; }

/* button-pill-rausch: small Rausch pill. */
.btn--pill { height: var(--tap-min); padding: 0 20px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); font: var(--text-button-sm); }
.btn--pill:not(:disabled):active { background: var(--primary-active); }
.btn--pill:disabled { background: var(--primary-disabled); cursor: not-allowed; }

/* Destructive confirmation, always with words ("Cancel session", "Delete"). */
.btn--danger { height: 48px; padding: 0 var(--spacing-lg); border-radius: var(--rounded-sm); background: var(--primary-error-text); color: var(--on-primary); }
.btn--danger:not(:disabled):active { background: var(--primary-error-text-hover); }
.btn--danger:disabled { opacity: 0.5; cursor: not-allowed; }

.btn--small.btn--primary, .btn--small.btn--secondary, .btn--small.btn--danger { height: var(--tap-min); padding: 0 var(--spacing-base); font: var(--text-button-sm); }
.btn--small.btn--primary { min-width: 120px; padding: 0 var(--spacing-base) 0 calc(var(--spacing-base) + 12px); font-weight: 600; }
.btn--small .btn__dot { left: var(--spacing-md); }

@media (hover: hover) {
  .btn--pill:not(:disabled):hover { background: var(--primary-active); }
  .btn--secondary:not(:disabled):hover { background: var(--surface-soft); }
  .btn--danger:not(:disabled):hover { background: var(--primary-error-text-hover); }
}
</style>
