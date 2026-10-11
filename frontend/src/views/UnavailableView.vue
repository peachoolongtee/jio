<script setup>
// Shown instead of the whole app when a production build was made without its Supabase settings (see mustRefuse in
// lib/supabase.js): nobody can log in, so there is nothing to open. No links, no way on.
//   createApp(UnavailableView).mount('#app')
import JioLogo from '@/components/ui/JioLogo.vue'
</script>

<template>
  <main class="screen screen--form unavailable" data-testid="unavailable-view">
    <header class="screen__header">
      <div class="screen__bar"><JioLogo :height="36" /></div>
    </header>
    <div class="screen__body">
      <h1 class="display-xl">Jio is not available right now</h1>
      <p class="body-md text-muted">Try again later.</p>
    </div>
  </main>
</template>

<style scoped>
.unavailable { min-height: 100dvh; }
.unavailable .screen__body { padding-top: var(--spacing-lg); }
</style>
