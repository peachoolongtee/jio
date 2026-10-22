<script setup>
// The spinner while the meeting spot is confirmed, over the Locate map only (lib/pageLoading.js decides when: once confirming
// has taken over 600 ms). It covers the map with a light wash and a spinner in the middle, above the map's own layers and
// buttons; the rest of the page, and the keyboard, carry on as usual. While it holds the map still (pageBlocking), the wash
// takes the map's clicks, taps and scrolls, so no pin is picked mid-confirm (the list's own controls are held by the events store's
// `confirming` flag). After 20 seconds (MAX_BLOCK_MS) the map
// can be used again, so a load that hangs never traps anyone. Its parent must be positioned (SplitView's map pane is).
// The map pane is hidden in the list view (phones and tablets), so this is only the map's own busy state: the confirm buttons
// say "Confirming…" themselves (SpotConfirm, SpotList), and the screen's own live region announces it.
// A screen reader hears it through one status region that is always there and empty until the spinner shows, then says "Loading…"
// (a region inserted already filled is often not announced). The wash is for the eye only.
// How to call: <MapLoading /> (beside PlannerMap, in the Locate page's map pane)
import { computed } from 'vue'
import { pageBlocking, pageSlow } from '@/lib/pageLoading.js'

const said = computed(() => (pageSlow.value ? 'Loading…' : ''))
</script>

<template>
  <p class="sr-only" role="status" aria-live="polite" data-testid="map-loading-status">{{ said }}</p>
  <Transition name="map-loading">
    <div
      v-if="pageSlow"
      class="map-loading"
      :class="{ 'is-blocking': pageBlocking }"
      aria-hidden="true"
      data-testid="map-loading"
      @wheel.prevent
      @touchmove.prevent
    >
      <div class="map-loading__card">
        <span class="map-loading__spinner" />
        <span class="map-loading__text title-sm">Loading…</span>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.map-loading {
  position: absolute;
  inset: 0;
  /* Above the map's layers and buttons (Leaflet's go up to 1000), inside the map pane only. */
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-base);
  border-radius: inherit;
  background: color-mix(in srgb, var(--canvas) 55%, transparent);
  pointer-events: none;
}
/* While it holds the map still, the wash takes the map's clicks, taps and scrolls. */
.map-loading.is-blocking { pointer-events: auto; cursor: progress; touch-action: none; }
.map-loading__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-lg) var(--spacing-xl);
  border-radius: var(--rounded-lg);
  background: var(--surface-card);
  box-shadow: var(--shadow-float);
}
.map-loading__spinner {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 4px solid var(--primary-disabled);
  border-top-color: var(--primary);
  animation: map-loading-spin 0.8s linear infinite;
}
.map-loading__text { color: var(--ink); }
@keyframes map-loading-spin { to { transform: rotate(360deg); } }

.map-loading-enter-active { transition: opacity var(--motion-fast) var(--ease-out); }
.map-loading-leave-active { transition: opacity 120ms ease-in; }
.map-loading-enter-from, .map-loading-leave-to { opacity: 0; }

/* The global rule in app.css stops the spin after one turn; keep it turning slowly instead, so it still says "working". */
@media (prefers-reduced-motion: reduce) {
  .map-loading__spinner { animation: map-loading-spin 2.4s linear infinite !important; }
}
</style>
