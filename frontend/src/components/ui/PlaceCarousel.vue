<script setup>
// A row of cards that scrolls sideways (walkthrough, 30 October 2026: Home's places near the meeting point came as one long grid,
// which was a lot to take in). Built for Jio from a card-carousel idea the team liked, with the app's own tokens and icons.
//   <PlaceCarousel :items="places" label="Places near Bishan" item-key="id"><template #item="{ item }">...</template></PlaceCarousel>
// The cards snap into place as the row scrolls. From 744px with a mouse, two round arrow buttons sit over the row's ends and move it by
// most of its width; each hides at its own end. On touch screens the row is swiped, and the arrows are not drawn. A last slot, `end`,
// holds what follows the cards (a "Show more" card). The row is a labelled list (the section around it is the region, by its heading);
// the cards' own links are its tab stops, and focusing one scrolls it into view. Under reduced motion the arrows jump instead of gliding.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  items: { type: Array, required: true },
  label: { type: String, required: true },
  itemKey: { type: String, default: 'id' },
})

const track = ref(null)
// Whether there is more to see on each side.
const atStart = ref(true)
const atEnd = ref(true)

// Reads where the row is scrolled to. How to call: measure()
function measure() {
  const el = track.value
  if (!el) return
  const left = el.scrollLeft || 0
  atStart.value = left <= 4
  atEnd.value = left + (el.clientWidth || 0) >= (el.scrollWidth || 0) - 4
}

// Moves the row by most of its visible width. How to call: scroll(1) (right) or scroll(-1) (left)
function scroll(direction) {
  const el = track.value
  if (!el) return
  const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollBy?.({ left: direction * (el.clientWidth || 0) * 0.8, behavior: still ? 'auto' : 'smooth' })
}

let resize = null
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && track.value) {
    resize = new ResizeObserver(measure)
    resize.observe(track.value)
  }
})
onBeforeUnmount(() => resize?.disconnect())
// New cards (a filter, "Show more") change how far the row reaches.
watch(() => props.items.length, async () => {
  await nextTick()
  measure()
})
</script>

<template>
  <div class="carousel">
    <button type="button" class="carousel__arrow carousel__arrow--prev" :class="{ 'is-hidden': atStart }" :tabindex="atStart ? -1 : 0" :aria-hidden="String(atStart)" aria-label="Show earlier places" data-testid="carousel-prev" @click="scroll(-1)">
      <AppIcon name="chevron-right" :size="20" />
    </button>
    <ul ref="track" class="carousel__track" :aria-label="label" data-testid="carousel-track" @scroll.passive="measure">
      <li v-for="(item, i) in items" :key="item[itemKey]" class="carousel__item">
        <slot name="item" :item="item" :index="i" />
      </li>
      <li v-if="$slots.end" class="carousel__item carousel__item--end"><slot name="end" /></li>
    </ul>
    <button type="button" class="carousel__arrow carousel__arrow--next" :class="{ 'is-hidden': atEnd }" :tabindex="atEnd ? -1 : 0" :aria-hidden="String(atEnd)" aria-label="Show more places" data-testid="carousel-next" @click="scroll(1)">
      <AppIcon name="chevron-right" :size="20" />
    </button>
  </div>
</template>

<style scoped>
.carousel { position: relative; }
/* The row: cards side by side, snapping to their start, with room below for a card's lift and shadow. No scrollbar. */
.carousel__track { display: flex; gap: var(--spacing-base); margin: 0; padding: var(--spacing-sm) 0 var(--spacing-base); overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x mandatory; scroll-padding-inline: 0; list-style: none; scrollbar-width: none; }
.carousel__track::-webkit-scrollbar { display: none; }
.carousel__item { flex: 0 0 auto; width: min(260px, 78vw); scroll-snap-align: start; }
.carousel__item--end { display: flex; width: min(180px, 50vw); }

/* The arrows: white circles over the row's ends, with the one float shadow. Only for a mouse, from 744px. */
.carousel__arrow { display: none; }
@media (min-width: 744px) and (hover: hover) {
  .carousel__arrow {
    position: absolute;
    top: 50%;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--tap-min);
    height: var(--tap-min);
    border: 1px solid var(--hairline);
    border-radius: var(--rounded-full);
    background: var(--canvas);
    box-shadow: var(--shadow-float);
    color: var(--ink);
    cursor: pointer;
    transform: translateY(-50%);
    transition: opacity var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out);
  }
  .carousel__arrow:hover { background: var(--surface-soft); }
  .carousel__arrow:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .carousel__arrow--prev { left: calc(var(--spacing-base) * -1); }
  .carousel__arrow--prev :deep(svg) { transform: rotate(180deg); }
  .carousel__arrow--next { right: calc(var(--spacing-base) * -1); }
  .carousel__arrow.is-hidden { opacity: 0; pointer-events: none; }
}
@media (prefers-reduced-motion: reduce) {
  .carousel__arrow { transition: none; }
}
</style>
