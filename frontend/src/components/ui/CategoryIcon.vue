<script>
// Kept outside <script setup> so the prop validator below can use it.
const NAMES = { eat: 'Eat', drink: 'Drink', shop: 'Shop', activity: 'Activity' }
</script>

<script setup>
// A category shown as an icon on a circle in the category's colour: cutlery for Eat (orange), a cup for Drink (blue),
// a bag for Shop (purple), a ticket for Activity (green), matching card stripes, stop numbers and map pins.
// Screen readers hear the category name.
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
/* The category's tint behind its colour: the same colours as the card stripes, stop numbers and map pins. */
.cat--eat { background: var(--cat-eat-bg); color: var(--cat-eat-fg); }
.cat--drink { background: var(--cat-drink-bg); color: var(--cat-drink-fg); }
.cat--shop { background: var(--cat-shop-bg); color: var(--cat-shop-fg); }
.cat--activity { background: var(--cat-activity-bg); color: var(--cat-activity-fg); }
</style>
