<script setup>
// The app-wide spinner: shown when confirming the meeting spot on Locate has taken over 600 ms (lib/pageLoading.js
// decides when). It covers the page with a light wash and a spinner in the middle, above everything
// else (dialogs and maps included). While it holds the page still (pageBlocking), nothing else can be used: the wash
// takes every click, tap and scroll, and every key press meant for the page is stopped before it reaches it (the
// browser's own shortcuts still work: reload, zoom, a new tab, anything with Ctrl, Alt or Cmd, and F1 to F12). Focus stays where it was,
// so the person carries on from there once it goes. After 20 seconds (MAX_BLOCK_MS) it lets the page be used again,
// so a load that hangs never traps anyone.
// How to call: <PageLoading /> (once, in App.vue)
import { onBeforeUnmount, watch } from 'vue'
import { pageBlocking, pageSlow } from '@/lib/pageLoading.js'

// The browser's own shortcuts, which the page never uses: anything held with Ctrl, Alt or Cmd, and the function keys.
// How to call: browserShortcut({ key: 'F5' }) -> true
const browserShortcut = (event) => !!(event.ctrlKey || event.metaKey || event.altKey) || /^F\d{1,2}$/.test(event.key || '')

// Stop a key press meant for the page before anything on the page sees it (listened for first, on the window). The
// browser's own shortcuts go through, so the spinner never stops anyone reloading, zooming or leaving.
// How to call: window.addEventListener('keydown', stopKey, true)
function stopKey(event) {
  if (browserShortcut(event)) return
  event.preventDefault()
  event.stopImmediatePropagation()
}
const KEY_EVENTS = ['keydown', 'keypress', 'keyup']
watch(
  pageBlocking,
  (on) => {
    if (typeof window === 'undefined') return
    for (const name of KEY_EVENTS) {
      if (on) window.addEventListener(name, stopKey, true)
      else window.removeEventListener(name, stopKey, true)
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  if (typeof window === 'undefined') return
  for (const name of KEY_EVENTS) window.removeEventListener(name, stopKey, true)
})
</script>

<template>
  <Transition name="page-loading">
    <div
      v-if="pageSlow"
      class="page-loading"
      :class="{ 'is-blocking': pageBlocking }"
      role="status"
      aria-live="polite"
      :aria-busy="pageBlocking ? 'true' : undefined"
      data-testid="page-loading"
      @wheel.prevent
      @touchmove.prevent
    >
      <div class="page-loading__card">
        <span class="page-loading__spinner" aria-hidden="true" />
        <span class="page-loading__text title-sm">Loading…</span>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.page-loading {
  position: fixed;
  inset: 0;
  /* Above dialogs (50) and the maps' own layers and buttons (up to 500 and more). */
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-base);
  background: color-mix(in srgb, var(--canvas) 55%, transparent);
  pointer-events: none;
}
/* While it holds the page still, the wash takes every click, tap and scroll. */
.page-loading.is-blocking { pointer-events: auto; cursor: progress; touch-action: none; }
.page-loading__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-lg) var(--spacing-xl);
  border-radius: var(--rounded-lg);
  background: var(--surface-card);
  box-shadow: var(--shadow-float);
}
.page-loading__spinner {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 4px solid var(--primary-disabled);
  border-top-color: var(--primary);
  animation: page-loading-spin 0.8s linear infinite;
}
.page-loading__text { color: var(--ink); }
@keyframes page-loading-spin { to { transform: rotate(360deg); } }

.page-loading-enter-active { transition: opacity var(--motion-fast) var(--ease-out); }
.page-loading-leave-active { transition: opacity 120ms ease-in; }
.page-loading-enter-from, .page-loading-leave-to { opacity: 0; }

/* The global rule in app.css stops the spin after one turn; keep it turning slowly instead, so it still says "working". */
@media (prefers-reduced-motion: reduce) {
  .page-loading__spinner { animation: page-loading-spin 2.4s linear infinite !important; }
}
</style>
