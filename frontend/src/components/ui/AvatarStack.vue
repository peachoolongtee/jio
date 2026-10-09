<script setup>
// Overlapping avatars for "who is going". Pass names, or { name, src, id } objects (id colours each avatar).
// Usage: <AvatarStack :people="['Ian', 'Darius', 'Nicole']" />
import { computed } from 'vue'
import UserAvatar from './UserAvatar.vue'

const props = defineProps({
  people: { type: Array, required: true },
  size: { type: Number, default: 24 },
  // Show at most this many, then "+2".
  max: { type: Number, default: 5 },
})

const list = computed(() => props.people.map((p) => (typeof p === 'string' ? { name: p } : p)))
const shown = computed(() => list.value.slice(0, props.max))
const extra = computed(() => list.value.length - shown.value.length)
const label = computed(() => list.value.map((p) => p.name).join(', '))
</script>

<template>
  <span class="avatar-stack" role="img" :aria-label="label || 'Nobody yet'">
    <UserAvatar
      v-for="(person, i) in shown"
      :key="person.name + i"
      class="avatar-stack__item"
      :name="person.name"
      :src="person.src"
      :person="person.id"
      :size="size"
      :style="{ marginLeft: i ? -Math.round(size / 4) + 'px' : 0 }"
    />
    <span v-if="extra > 0" class="avatar-stack__more">+{{ extra }}</span>
  </span>
</template>

<style scoped>
.avatar-stack { display: inline-flex; align-items: center; min-height: 24px; }
.avatar-stack__item { box-shadow: 0 0 0 2px var(--canvas); }
.avatar-stack__more { margin-left: var(--spacing-xs); color: var(--muted); font: var(--text-caption-sm); }
</style>
