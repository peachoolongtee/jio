<script setup>
// A banner across the top of a screen: the re-calculation message, a paused session or the weather.
//   <BannerNote icon="info" dismissible @dismiss="clear">Meeting area moved from Bishan to Serangoon because Jonathan opted out.</BannerNote>
// Tones: info (default), warning, error. Put buttons in the `actions` slot.
// An error banner is announced at once (role="alert"); the others wait their turn (role="status").
// An error that is a standing state, not an answer to something just done, passes role="status" so a screen load does not shout it.
import AppIcon from './AppIcon.vue'
import IconButton from './IconButton.vue'

defineProps({
  tone: { type: String, default: 'info', validator: (v) => ['info', 'warning', 'error'].includes(v) },
  icon: { type: String, default: 'info' },
  dismissible: { type: Boolean, default: false },
})
defineEmits(['dismiss'])
</script>

<template>
  <div class="banner" :class="`banner--${tone}`" :role="tone === 'error' ? 'alert' : 'status'">
    <AppIcon class="banner__icon" :name="icon" :size="18" />
    <div class="banner__text">
      <p class="body-sm"><slot /></p>
      <div v-if="$slots.actions" class="banner__actions"><slot name="actions" /></div>
    </div>
    <IconButton v-if="dismissible" class="banner__close" label="Dismiss" @click="$emit('dismiss')"><AppIcon name="close" :size="14" /></IconButton>
  </div>
</template>

<style scoped>
/* Banners sit on Surface Soft with ink text. Warnings and errors colour the icon (and only the icon) error red. */
.banner { display: flex; align-items: flex-start; gap: var(--spacing-md); padding: var(--spacing-md) var(--spacing-xs) var(--spacing-md) var(--spacing-base); border-radius: var(--rounded-md); background: var(--surface-soft); }
.banner__icon { margin-top: 1px; color: var(--ink); }
.banner__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-sm); padding-right: var(--spacing-md); color: var(--ink); }
.banner__actions { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
.banner__close { margin: calc(var(--spacing-md) * -1) 0; background: transparent; }
.banner--warning .banner__icon, .banner--error .banner__icon { color: var(--primary-error-text); }
.banner--error { box-shadow: inset 3px 0 0 var(--primary-error-text); }
</style>
