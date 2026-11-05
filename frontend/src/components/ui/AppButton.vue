<script setup>
// The buttons of the design system.
//   primary   The main action, one per screen: a plain Rausch button with white text.
//             Add `next` when it takes you on to the next page or step ("Next", "Start session", "Itinerary"):
//             a white pill with the label and an arrow after it; on hover (or keyboard focus) a hidden Rausch dot swells to fill it and
//             the label slides out as it slides back in with an arrow. Touch screens, which cannot hover, show the
//             filled Rausch pill with its arrow from the start. Keep it for moving on, so it stays meaningful.
//   secondary Ink outline on white.
//   tertiary  Text only. Add `underline` when it stands alone as a link.
//   pill      Small Rausch pill, for example "Set".
//   danger    Error-red fill, for an action that cannot be undone, for example "Cancel outing".
// `small` makes primary and secondary buttons 44px tall with smaller text, for actions inside cards. A small secondary button is a
// dark pill instead, ink with white text ("Add a spot", "Try again", "Share"; walkthrough, 1 November 2026).
// Pass `to` to make it a router link, or `href` for a link to another site (add target="_blank" to open a new tab;
// it gets rel="noopener noreferrer"). A disabled button always renders as a real <button>.
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
  // Primary only: the animated "go on to the next page" pill.
  next: { type: Boolean, default: false },
})

const kind = computed(() => (props.variant === 'primary' && props.next ? 'next' : props.variant))

const isLink = computed(() => !!props.to && !props.disabled)
const isAnchor = computed(() => !!props.href && !props.disabled)
// Only the attributes each element uses. Passing href: undefined to a RouterLink overrode the href it renders,
// which left an <a> with no href: not reachable with Tab, and not a link to screen readers.
const attrs = computed(() =>
  isLink.value ? { to: props.to } : isAnchor.value ? { href: props.href, rel: 'noopener noreferrer' } : { type: props.type, disabled: props.disabled },
)
</script>

<template>
  <component
    :is="isLink ? RouterLink : isAnchor ? 'a' : 'button'"
    class="btn"
    :class="[`btn--${kind}`, { 'btn--block': block, 'btn--underline': underline, 'btn--small': small }]"
    v-bind="attrs"
  >
    <template v-if="kind === 'next'">
      <span class="btn__dot" aria-hidden="true" />
      <span class="btn__label"><slot /><AppIcon name="arrow-right" :size="18" /></span>
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

/* button-primary: a plain Rausch button, white text, 8px corners like the others. Darker when pressed. */
.btn--primary { height: 48px; padding: 0 var(--spacing-lg); border-radius: var(--rounded-sm); background: var(--primary); color: var(--on-primary); font-weight: 600; }
.btn--primary:not(:disabled):active { background: var(--primary-active); }
.btn--primary:not(:disabled):focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.btn--primary:disabled { background: var(--primary-disabled); cursor: not-allowed; }

/* button-next: the interactive hover pill, for moving on to the next page. 48px tall, fully round, ink label. The Rausch dot that fills it on hover stays hidden at rest.
   Hover or keyboard focus: the dot swells to fill the pill, the label slides right and fades, and a white copy
   with an arrow slides in from the right. */
.btn--next { position: relative; isolation: isolate; overflow: hidden; height: 48px; min-width: 160px; padding: 0 var(--spacing-lg); border: 1px solid var(--border-strong); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); font-weight: 600; }
.btn__dot { position: absolute; top: calc(50% - 4px); left: var(--spacing-base); z-index: -1; width: 8px; height: 8px; border-radius: var(--rounded-full); background: var(--primary); transform: scale(0); transition: all 300ms var(--ease-out); }
.btn__label { display: inline-flex; align-items: center; gap: var(--spacing-sm); transform: translateX(0); transition: transform 300ms var(--ease-out), opacity 300ms var(--ease-out); }
.btn__reveal { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: var(--spacing-sm); color: var(--on-primary); opacity: 0; transform: translateX(48px); transition: transform 300ms var(--ease-out), opacity 300ms var(--ease-out); }
.btn--next:not(:disabled):focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
@media (hover: hover) {
  .btn--next:not(:disabled):hover, .btn--next:not(:disabled):focus-visible { border-color: var(--primary); }
  .btn--next:not(:disabled):is(:hover, :focus-visible) .btn__dot { top: 0; left: 0; width: 100%; height: 100%; border-radius: 0; transform: scale(1.8); }
  .btn--next:not(:disabled):is(:hover, :focus-visible) .btn__label { opacity: 0; transform: translateX(48px); }
  .btn--next:not(:disabled):is(:hover, :focus-visible) .btn__reveal { opacity: 1; transform: translateX(-4px); }
}
/* Touch screens: no hover to reveal it, so start filled, with the arrow. */
@media (hover: none) {
  /* Nothing to animate without hover: switch straight between states, for example disabled to ready. */
  .btn__dot, .btn__label, .btn__reveal { transition: none; }
  .btn--next:not(:disabled) { border-color: var(--primary); }
  .btn--next:not(:disabled) .btn__dot { top: 0; left: 0; width: 100%; height: 100%; border-radius: 0; transform: scale(1.8); transition: none; }
  .btn--next:not(:disabled) .btn__label { opacity: 0; transition: none; }
  .btn--next:not(:disabled) .btn__reveal { opacity: 1; transform: none; transition: none; }
  .btn--next:not(:disabled):active .btn__dot { background: var(--primary-active); }
}
.btn--next:disabled { border-color: var(--hairline); color: var(--muted-soft); cursor: not-allowed; }
.btn--next:disabled .btn__dot { background: var(--primary-disabled); }

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

/* Destructive confirmation, always with words ("Cancel outing", "Delete"). */
.btn--danger { height: 48px; padding: 0 var(--spacing-lg); border-radius: var(--rounded-sm); background: var(--primary-error-text); color: var(--on-primary); }
.btn--danger:not(:disabled):active { background: var(--primary-error-text-hover); }
.btn--danger:disabled { opacity: 0.5; cursor: not-allowed; }

.btn--small.btn--primary, .btn--small.btn--secondary, .btn--small.btn--danger { height: var(--tap-min); padding: 0 var(--spacing-base); font: var(--text-button-sm); }
.btn--small.btn--primary { font-weight: 600; }
/* button-secondary-small: a dark pill, ink with white text and fully round corners. Lifts a shade on hover, darker when pressed. */
.btn--small.btn--secondary { border: 0; border-radius: var(--rounded-full); padding: 0 20px; background: var(--ink); color: var(--on-dark); font-weight: 600; }
.btn--small.btn--secondary:not(:disabled):active { background: #000000; }
.btn--small.btn--secondary:not(:disabled):focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.btn--small.btn--secondary:disabled { background: var(--surface-strong); color: var(--muted-soft); }
.btn--small.btn--next { height: var(--tap-min); min-width: 120px; padding: 0 var(--spacing-base); font: var(--text-button-sm); font-weight: 600; }
.btn--small .btn__dot { left: var(--spacing-md); }

@media (hover: hover) {
  .btn--pill:not(:disabled):hover, .btn--primary:not(:disabled):hover { background: var(--primary-active); }
  .btn--secondary:not(:disabled):hover { background: var(--surface-soft); }
  .btn--small.btn--secondary:not(:disabled):hover { background: color-mix(in srgb, var(--ink) 85%, var(--canvas)); }
  .btn--danger:not(:disabled):hover { background: var(--primary-error-text-hover); }
}
</style>
