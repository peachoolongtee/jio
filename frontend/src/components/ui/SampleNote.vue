<script setup>
// A short caption that marks hand-written demo content, so it is never taken for real data.
//   <SampleNote />  <SampleNote>Sample places for the demo</SampleNote>
// Without a slot it reads "Sample data for the demo".
import AppIcon from './AppIcon.vue'
</script>

<template>
  <p class="sample-note caption-sm text-muted">
    <AppIcon name="info" :size="12" />
    <span><slot>Sample data for the demo</slot></span>
  </p>
</template>

<style scoped>
.sample-note { display: inline-flex; align-items: center; gap: var(--spacing-xs); margin: 0; }
</style>
