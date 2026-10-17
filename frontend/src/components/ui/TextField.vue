<script setup>
// A labelled text input: 56px tall, outlined, 2px ink border on focus.
// Usage: <TextField v-model="email" label="Email" type="email" :error="emailError" />
// Any other attribute (type, placeholder, autocomplete, inputmode ...) goes to the input itself.
import { computed, useId } from 'vue'

defineOptions({ inheritAttrs: false })

const model = defineModel({ type: [String, Number], default: '' })
const props = defineProps({
  label: { type: String, required: true },
  // Keep the label for screen readers but do not show it.
  hideLabel: { type: Boolean, default: false },
  hint: { type: String, default: '' },
  error: { type: String, default: '' },
  multiline: { type: Boolean, default: false },
  id: { type: String, default: '' },
})

const auto = useId()
const fieldId = computed(() => props.id || `field-${auto}`)
const helpId = computed(() => (props.error || props.hint ? `${fieldId.value}-help` : undefined))
</script>

<template>
  <div class="field">
    <label class="field__label" :class="{ 'sr-only': hideLabel }" :for="fieldId">{{ label }}</label>
    <div class="field__control">
      <textarea
        v-if="multiline"
        v-bind="$attrs"
        :id="fieldId"
        v-model="model"
        class="field__input field__input--area"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="helpId"
      />
      <input
        v-else
        v-bind="$attrs"
        :id="fieldId"
        v-model="model"
        class="field__input"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="helpId"
      />
      <slot name="trailing" />
    </div>
    <p v-if="error" :id="helpId" class="field__error" role="alert">{{ error }}</p>
    <p v-else-if="hint" :id="helpId" class="field__hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.field__label { color: var(--muted); font: var(--text-caption); }
.field__control { position: relative; }
.field__input {
  width: 100%;
  height: 56px;
  margin: 0;
  padding: 14px 12px;
  border: 1px solid var(--border-control);
  border-radius: var(--rounded-sm);
  background: var(--canvas);
  color: var(--ink);
  font: var(--text-body-md);
}
.field__input--area { height: 88px; resize: none; }
.field__input::placeholder { color: var(--muted); opacity: 1; }
/* The border grows from 1px to 2px on focus; the padding shrinks by 1px so the text does not move. */
.field__input:focus { padding: 13px 11px; border: 2px solid var(--ink); outline: none; }
.field__input[aria-invalid="true"] { border-color: var(--primary-error-text); }
.field__input:disabled { background: var(--surface-soft); cursor: not-allowed; }
.field__hint { color: var(--muted); font: var(--text-body-sm); }
.field__error { color: var(--primary-error-text); font: var(--text-body-sm); }
</style>
