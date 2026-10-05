<script setup>
// A grey placeholder row to show while a list loads.
//   <SkeletonRow v-for="n in 3" :key="n" avatar />
defineProps({
  avatar: { type: Boolean, default: false },
  lines: { type: Number, default: 2 },
})
</script>

<template>
  <div class="skeleton" aria-hidden="true">
    <span v-if="avatar" class="skeleton__dot" />
    <span class="skeleton__lines">
      <span v-for="n in lines" :key="n" class="skeleton__line" :style="{ width: n === 1 ? '60%' : '40%' }" />
    </span>
  </div>
</template>

<style scoped>
.skeleton { display: flex; align-items: center; gap: var(--spacing-md); min-height: 64px; border-bottom: 1px solid var(--hairline-soft); }
.skeleton__dot { flex-shrink: 0; width: 40px; height: 40px; border-radius: var(--rounded-full); background: var(--surface-strong); }
.skeleton__lines { flex: 1 1 0; display: flex; flex-direction: column; gap: var(--spacing-sm); }
.skeleton__line { height: var(--spacing-md); border-radius: var(--rounded-full); background: var(--surface-strong); animation: skeleton-pulse 1.2s ease-in-out infinite; }
.skeleton__dot { animation: skeleton-pulse 1.2s ease-in-out infinite; }
@keyframes skeleton-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
</style>
