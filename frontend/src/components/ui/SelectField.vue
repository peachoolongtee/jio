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
    >
      <option v-if="placeholder" value="">{{ placeholder }}</option>
      <option v-for="opt in items" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
    </select>
    <p v-if="error" class="field__error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.field__label { color: var(--muted); font: var(--text-caption); }
.field__input {
  width: 100%;
  height: 56px;
  margin: 0;
  padding: 14px 12px;
  border: 1px solid var(--hairline);
  border-radius: var(--rounded-sm);
  background: var(--canvas);
  color: var(--ink);
  font: var(--text-body-md);
}
.field__input.is-empty { color: var(--muted); }
.field__input:focus { padding: 13px 11px; border: 2px solid var(--ink); outline: none; }
.field__error { color: var(--primary-error-text); font: var(--text-body-sm); }
</style>
