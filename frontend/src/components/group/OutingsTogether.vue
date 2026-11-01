<script setup>
// How many outings two people have had together: a small count beside a name, in the brand's soft tint, with the words for screen
// readers and the title ("3 outings together"). Nothing is drawn for none. Used beside each friend on the invite page and on the
// profile's Friends list.
//   <OutingsTogether :count="person.together" />
import AppIcon from '@/components/ui/AppIcon.vue'
import { togetherText } from '@/lib/hangouts.js'

defineProps({ count: { type: Number, default: 0 } })
</script>

<template>
  <span v-if="count > 0" class="together caption-sm tnum" :title="togetherText(count)" data-testid="outings-together">
    <AppIcon name="sparkle" :size="12" /><span class="sr-only">{{ togetherText(count) }}</span><span aria-hidden="true">{{ count }}</span>
  </span>
</template>

<style scoped>
/* The text is the error red, 4.85:1 on the tint (Rausch pressed was 4.3:1). */
.together { flex-shrink: 0; display: inline-flex; align-items: center; gap: 2px; height: 20px; padding: 0 6px; border-radius: var(--rounded-full); background: color-mix(in srgb, var(--primary) 10%, var(--canvas)); color: var(--primary-error-text); font-weight: 600; }
</style>
