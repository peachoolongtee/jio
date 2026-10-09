<script setup>
// The Jio logo: "Jio" in rounded strokes, with a crown over the i in place of its dot. Drawn from the official
// logo (assets/brand/jio-logo.png), so it stays sharp at any size.
//   <JioLogo :height="28" />                   in the logo pink, read out as "Jio"
//   <JioLogo :height="28" title="Jio home" />  inside a link: the name the link should have
//   <JioLogo class="on-red" decorative />      white on red, hidden from screen readers (the parent names it)
// It takes the text colour (currentColor), set to the logo pink by default; give it a class with `color` to change.
defineProps({
  height: { type: Number, default: 28 },
  title: { type: String, default: 'Jio' },
  decorative: { type: Boolean, default: false },
})
</script>

<template>
  <svg
    class="jio-logo"
    viewBox="208 350 824 506"
    :height="height"
    :width="Math.round((height * 824) / 506)"
    :role="decorative ? undefined : 'img'"
    :aria-label="decorative ? undefined : title"
    :aria-hidden="decorative ? 'true' : undefined"
    focusable="false"
  >
    <g fill="none" stroke="currentColor">
      <path d="M465 499V690a100 100 0 0 1-200 4" stroke-width="108" stroke-linecap="round" />
      <path d="M622 546V785" stroke-width="109" stroke-linecap="round" />
      <circle cx="866" cy="692" r="118" stroke-width="86" />
    </g>
    <path
      fill="currentColor"
      stroke="currentColor"
      stroke-width="8"
      stroke-linejoin="round"
      d="M553 452 535 390q-3-12 9-8l41 21 31-40q7-9 14 0l31 40 41-21q12-4 9 8l-20 62q-3 9-12 9H565q-9 0-12-9Z"
    />
  </svg>
</template>

<style scoped>
.jio-logo { display: block; flex: none; color: var(--brand-logo); }
</style>
