<script setup>
// What a list shows when it has nothing in it: a short title, one line of help and one action.
//   <EmptyState title="No plans yet" text="Start a plan and invite friends. It will show up here.">
//     <AppButton variant="secondary" to="/events/new">Start a plan</AppButton>
//   </EmptyState>
// Add `illustration` to show a drawing above the title.
import IllustrationBlob from './IllustrationBlob.vue'

defineProps({
  title: { type: String, required: true },
  text: { type: String, default: '' },
  illustration: { type: String, default: '' },
})
</script>

<template>
  <section class="empty">
    <IllustrationBlob v-if="illustration" :name="illustration" />
    <h2 class="display-sm">{{ title }}</h2>
    <p v-if="text" class="body-md text-muted">{{ text }}</p>
    <slot />
  </section>
</template>

<style scoped>
.empty { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-md); padding: var(--spacing-lg) 0; }
</style>
