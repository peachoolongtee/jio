<script>
// Kept outside <script setup> so the prop validator below can use it.
const DRAWINGS = {
  // Two friends and a map pin.
  invite: '<circle cx="42" cy="60" r="6" class="fill"/><path d="M32 82a10 10 0 0 1 20 0"/><circle cx="118" cy="60" r="6" class="fill"/><path d="M108 82a10 10 0 0 1 20 0"/><path d="M80 90c-13-15-21-25-21-37a21 21 0 0 1 42 0c0 12-8 22-21 37Z" class="fill"/><circle cx="80" cy="53" r="7"/>',
  // A name card.
  profile: '<rect x="40" y="32" width="80" height="54" rx="8" class="fill"/><circle cx="62" cy="52" r="7"/><path d="M51 74a11 11 0 0 1 22 0"/><path d="M86 50h22M86 62h14"/>',
  // A paper plane: sent.
  sent: '<path d="M44 54 118 30 90 92 74 66Z" class="fill"/><path d="M74 66 118 30"/>',
  // A flag: done.
  done: '<path d="M62 90V28"/><path d="M62 30h44l-9 13 9 13H62Z" class="fill"/><path d="M50 90h24"/>',
}
</script>

<script setup>
// A Rausch line drawing on a pale Rausch blob, for empty states and the top of sign-up steps.
//   <IllustrationBlob name="invite" />
// To draw a new one, pass SVG shapes in the default slot. The canvas is 160 by 112.
// Shapes take the Rausch stroke; add class="fill" to a shape that should be white inside.

defineProps({
  name: { type: String, default: 'invite', validator: (v) => v in DRAWINGS },
})
</script>

<template>
  <svg class="blob" viewBox="0 0 160 112" width="160" height="112" fill="none" aria-hidden="true">
    <path class="blob__wash" d="M28 54C22 30 44 10 72 12c18 1 28-8 46-2 22 7 34 30 26 52-7 20-28 34-54 36-30 2-56-16-62-44Z" />
    <g class="blob__lines" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <slot><g v-html="DRAWINGS[name]" /></slot>
    </g>
  </svg>
</template>

<style scoped>
.blob__wash { fill: var(--primary-disabled); }
.blob__lines { stroke: var(--primary); }
.blob__lines :deep(.fill) { fill: var(--canvas); }
</style>
