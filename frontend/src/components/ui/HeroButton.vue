<script setup>
// The one big action at the top of a screen: a solid Rausch pill with the label and an arrow in a white circle.
//   <HeroButton to="/sessions/new">Start a session</HeroButton>
// Calm at rest; on hover it lifts a little and the arrow nudges forward.
import AppIcon from './AppIcon.vue'

defineProps({
  to: { type: [String, Object], required: true },
})
</script>

<template>
  <RouterLink :to="to" class="hero-btn">
    <span class="hero-btn__label"><slot /></span>
    <span class="hero-btn__arrow" aria-hidden="true"><AppIcon name="arrow-right" :size="18" /></span>
  </RouterLink>
</template>

<style scoped>
.hero-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-base);
  min-height: 60px;
  padding: 0 8px 0 var(--spacing-lg);
  border-radius: var(--rounded-full);
  background: var(--primary);
  box-shadow: 0 10px 28px -12px color-mix(in srgb, var(--primary) 70%, transparent);
  color: var(--on-primary);
  font: var(--text-title-md);
  text-decoration: none;
  white-space: nowrap;
  transition: transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out);
  -webkit-tap-highlight-color: transparent;
}
.hero-btn__arrow { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: var(--rounded-full); background: var(--canvas); color: var(--primary); transition: transform var(--motion-fast) var(--ease-out); }
@media (hover: hover) {
  .hero-btn:hover { transform: translateY(-2px); box-shadow: 0 16px 32px -12px color-mix(in srgb, var(--primary) 75%, transparent); }
  .hero-btn:hover .hero-btn__arrow { transform: translateX(3px); }
}
.hero-btn:active { transform: scale(0.98); background: var(--primary-active); }
.hero-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--canvas), 0 0 0 5px var(--ink); }
@media (prefers-reduced-motion: reduce) { .hero-btn, .hero-btn__arrow { transition: none; } }
</style>
