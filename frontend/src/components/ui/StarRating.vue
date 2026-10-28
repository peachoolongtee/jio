<script setup>
// One to five stars, chosen by pressing a star. A radio group: one Tab stop, the arrow keys move between the stars and choose
// as they go (lib/radioGroup.js), and each star says its number to a screen reader ("4 stars"). The stars up to the chosen one
// are filled in Rausch; hovering a star previews it, until the pointer leaves it or focus moves away. The empty stars use the control outline colour (3:1). 0 is nothing chosen yet.
//   <StarRating v-model="stars" label="The outing" />
//   <StarRating v-model="stopStars.eat" label="Maxwell Food Centre" small />
import { ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { vRadioGroup } from '@/lib/radioGroup.js'

const model = defineModel({ type: Number, default: 0 })
defineProps({
  // What is being rated, for screen readers: "<label>, stars".
  label: { type: String, required: true },
  // Smaller stars, for a row in a list.
  small: { type: Boolean, default: false },
})

const hover = ref(0)
const STARS = [1, 2, 3, 4, 5]
// What a star is called, for screen readers and the tooltip.
// How to call: words(1) -> '1 star'
const words = (n) => `${n} ${n === 1 ? 'star' : 'stars'}`
</script>

<template>
  <div class="stars" :class="{ 'stars--small': small }" role="radiogroup" v-radio-group :aria-label="`${label}, stars`" @mouseleave="hover = 0" @focusout="hover = 0">
    <button
      v-for="n in STARS"
      :key="n"
      type="button"
      role="radio"
      class="stars__star"
      :class="{ 'is-on': n <= (hover || model) }"
      :aria-checked="String(model === n)"
      :aria-label="words(n)"
      :title="words(n)"
      @pointerenter="hover = n"
      @pointerleave="hover = 0"
      @click="model = n"
    >
      <AppIcon name="star" :size="small ? 22 : 34" />
    </button>
  </div>
</template>

<style scoped>
.stars { display: inline-flex; align-items: center; gap: var(--spacing-xxs); }
/* Each star is a 44px target however small it is drawn. */
.stars__star { display: inline-flex; align-items: center; justify-content: center; min-width: var(--tap-min); min-height: var(--tap-min); padding: 0; border: 0; border-radius: var(--rounded-full); background: none; color: var(--border-control); cursor: pointer; transition: color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
.stars__star.is-on { color: var(--primary); }
.stars__star:active { transform: scale(0.9); }
.stars__star:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .stars__star { transition: none; } }
</style>
