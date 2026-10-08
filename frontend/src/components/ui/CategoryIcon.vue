<script>
// Kept outside <script setup> so the prop validator below can use it.
const NAMES = { eat: 'Eat', drink: 'Drink', shop: 'Shop', activity: 'Activity' }
</script>

<script setup>
// A category shown as an icon only, ink on a Surface Strong circle: a cup for Drink, a bag for Shop,
// cutlery for Eat, a ticket for Activity. Screen readers hear the category name.
//   <CategoryIcon category="drink" />  or  <CategoryIcon category="eat" :size="40" />
defineProps({
  category: { type: String, required: true, validator: (v) => v in NAMES },
  size: { type: Number, default: 32 },
})
import AppIcon from './AppIcon.vue'
</script>

<template>
  <span
    class="cat"
    :class="`cat--${category}`"
    role="img"
    :aria-label="NAMES[category]"
    :style="{ width: size + 'px', height: size + 'px' }"
  >
    <AppIcon :name="category" :size="Math.round(size / 2)" />
  </span>
</template>

<style scoped>
.cat { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--rounded-full); }
/* One accent only: categories are told apart by their glyph, not by colour. */
.cat { background: var(--surface-strong); color: var(--ink); }
</style>
