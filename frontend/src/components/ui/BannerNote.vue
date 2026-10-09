<script setup>
// A banner across the top of a screen: the re-calculation message, a paused session or the weather.
//   <BannerNote icon="info" dismissible @dismiss="clear">Meeting area moved from Bishan to Serangoon because Jonathan opted out.</BannerNote>
// Tones: lagoon (default), warning, error. Put buttons in the `actions` slot.
import AppIcon from './AppIcon.vue'
import IconButton from './IconButton.vue'

defineProps({
  tone: { type: String, default: 'lagoon', validator: (v) => ['lagoon', 'warning', 'error'].includes(v) },
  icon: { type: String, default: 'info' },
  dismissible: { type: Boolean, default: false },
})
defineEmits(['dismiss'])
</script>

<template>
  <div class="banner" :class="`banner--${tone}`" role="status">
    <AppIcon class="banner__icon" :name="icon" :size="18" />
    <div class="banner__text">
      <p class="body-sm"><slot /></p>
      <div v-if="$slots.actions" class="banner__actions"><slot name="actions" /></div>
    </div>
    <IconButton v-if="dismissible" class="banner__close" label="Dismiss" @click="$emit('dismiss')"><AppIcon name="close" :size="14" /></IconButton>
  </div>
</template>

<style scoped>
.banner { display: flex; align-items: flex-start; gap: var(--spacing-md); padding: var(--spacing-md) var(--spacing-xs) var(--spacing-md) var(--spacing-base); border-radius: var(--rounded-md); }
.banner__icon { margin-top: 1px; }
.banner__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-sm); padding-right: var(--spacing-md); color: var(--ink); }
.banner__actions { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
.banner__close { margin: calc(var(--spacing-md) * -1) 0; background: transparent; }
.banner--lagoon { background: var(--primary-tint); }
.banner--lagoon .banner__icon { color: var(--primary-active); }
.banner--warning { background: var(--warning-tint); }
.banner--warning .banner__icon { color: var(--warning-text); }
.banner--error { background: var(--error-tint); }
.banner--error .banner__icon { color: var(--primary-error-text); }
</style>
