<script setup>
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
</script>

<template>
  <main class="screen">
    <div class="screen__body not-found">
      <EmptyState title="Page not found" text="This page does not exist.">
        <AppButton variant="secondary" to="/">Go to Home</AppButton>
      </EmptyState>
    </div>
  </main>
</template>

<style scoped>
.not-found { padding-top: var(--spacing-xxl); }
</style>
