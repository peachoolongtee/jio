<script setup>
// A round avatar. Shows the photo when there is one, otherwise the first letter of the name.
// Usage: <UserAvatar name="Ian" /> or <UserAvatar name="Darius" :size="32" />
// Pass `person` (their id) to colour the avatar in that person's colour, the same as their pin on the map.
import { computed } from 'vue'
import { personColour } from '@/lib/people.js'

const props = defineProps({
  name: { type: String, required: true },
  src: { type: String, default: '' },
  // 24, 32, 40 (default), 64 or 96.
  size: { type: Number, default: 40 },
  // Avatars usually sit beside the name, so they are hidden from screen readers by default.
  labelled: { type: Boolean, default: false },
  person: { type: String, default: '' },
})
const colour = computed(() => personColour(props.person))

const initial = computed(() => (props.name.trim()[0] || '?').toUpperCase())
const fontSize = computed(() => (props.size >= 96 ? 36 : props.size >= 64 ? 20 : props.size <= 24 ? 11 : 14))
</script>

<template>
  <span
    class="avatar"
    :class="{ 'avatar--colour': colour && !src }"
    :style="{ width: size + 'px', height: size + 'px', fontSize: fontSize + 'px', fontWeight: size >= 64 ? 600 : 500, '--avatar-colour': colour || undefined }"
    :role="labelled ? 'img' : undefined"
    :aria-label="labelled ? name : undefined"
    :aria-hidden="labelled ? undefined : 'true'"
  >
    <img v-if="src" :src="src" alt="" />
    <template v-else>{{ initial }}</template>
  </span>
</template>

<style scoped>
.avatar {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: var(--rounded-full);
  background: var(--surface-strong);
  color: var(--ink);
  line-height: 1.29;
}
.avatar > img { width: 100%; height: 100%; object-fit: cover; }
.avatar--colour { background: var(--avatar-colour); color: var(--on-dark); }
</style>
