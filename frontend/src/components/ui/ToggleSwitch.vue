<script setup>
// An on/off switch with its label on the left. Ink when on.
//   <ToggleSwitch v-model="rain" label="Simulate rain" />
// `hint` adds a muted line under the label.
import { useId } from 'vue'

const model = defineModel({ type: Boolean, default: false })
defineProps({
  label: { type: String, required: true },
  hint: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
})
const id = `switch-${useId()}`
</script>

<template>
  <div class="switch-row">
    <label :for="id" class="switch-row__text">
      <span class="body-md">{{ label }}</span>
      <span v-if="hint" class="caption-sm text-muted">{{ hint }}</span>
    </label>
    <button
      :id="id"
      type="button"
      role="switch"
      class="switch"
      :class="{ 'is-on': model }"
      :aria-checked="String(model)"
      :disabled="disabled"
      @click="model = !model"
    >
      <span class="switch__knob" />
    </button>
  </div>
</template>

<style scoped>
.switch-row { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); min-height: var(--tap-min); }
.switch-row__text { display: flex; flex-direction: column; gap: var(--spacing-xxs); cursor: pointer; }
.switch {
  position: relative;
  flex-shrink: 0;
  width: 48px;
  height: 28px;
  margin: 8px 0;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--rounded-full);
  background: var(--surface-strong);
  transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}
/* The tap area reaches 44px without making the switch bigger. */
.switch::after { content: ""; position: absolute; inset: -9px -2px; }
.switch__knob { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: var(--rounded-full); background: var(--canvas); box-shadow: var(--shadow-float); transition: transform var(--motion-fast) var(--ease-out); }
.switch.is-on { border-color: var(--selected); background: var(--selected); }
.switch.is-on .switch__knob { transform: translateX(20px); }
.switch:disabled { opacity: 0.5; cursor: not-allowed; }
@media (hover: hover) {
  .switch:not(:disabled):hover { border-color: var(--ink); }
  .switch.is-on:not(:disabled):hover { border-color: var(--body); background: var(--body); }
}
</style>
