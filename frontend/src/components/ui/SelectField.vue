<script setup>
// A labelled dropdown that matches TextField.
// Usage: <SelectField v-model="area" label="Area" placeholder="Choose an area" :options="['Bugis', 'Orchard']" />
// Options can be plain strings or { value, label } objects.
import { computed, useId } from 'vue'

defineOptions({ inheritAttrs: false })

const model = defineModel({ type: [String, Number], default: '' })
const props = defineProps({
  label: { type: String, required: true },
  options: { type: Array, required: true },
  placeholder: { type: String, default: '' },
  error: { type: String, default: '' },
  id: { type: String, default: '' },
})

const auto = useId()
const fieldId = computed(() => props.id || `select-${auto}`)
const helpId = computed(() => (props.error ? `${fieldId.value}-help` : undefined))
const items = computed(() => props.options.map((opt) => (typeof opt === 'object' ? opt : { value: opt, label: String(opt) })))
</script>

<template>
  <div class="field">
    <label class="field__label" :for="fieldId">{{ label }}</label>
    <select
      v-bind="$attrs"
      :id="fieldId"
      v-model="model"
      class="field__input"
      :class="{ 'is-empty': model === '' }"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="helpId"
    >
      <option v-if="placeholder" value="">{{ placeholder }}</option>
      <option v-for="opt in items" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
    </select>
    <p v-if="error" :id="helpId" class="field__error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.field__label { color: var(--muted); font: var(--text-caption); }
/* The browser's own arrow sits hard against the edge, so it is replaced by a chevron drawn 16px in from the right (Faith, 31 October 2026). */
.field__input {
  width: 100%;
  height: 56px;
  margin: 0;
  padding: 14px 44px 14px 12px;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='%23222222' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 16px center;
  background-size: 16px 16px;
  border: 1px solid var(--border-control);
  border-radius: var(--rounded-sm);
  background-color: var(--canvas);
  color: var(--ink);
  font: var(--text-body-md);
  cursor: pointer;
}
.field__input.is-empty { color: var(--muted); }
.field__input:focus { padding: 13px 43px 13px 11px; border: 2px solid var(--ink); outline: none; background-position: right 15px center; }
.field__error { color: var(--primary-error-text); font: var(--text-body-sm); }
</style>
