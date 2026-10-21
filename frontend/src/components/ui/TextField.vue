<script setup>
// A labelled text input: 56px tall, outlined, 2px ink border on focus.
// Usage: <TextField v-model="email" label="Email" type="email" :error="emailError" />
// Any other attribute (type, placeholder, autocomplete, inputmode ...) goes to the input itself.
// Slot `leading` is a decorative icon at the start of the field (not clickable; it gives the text room). Slot `trailing` is a control at the
// end, placed by the caller (absolute inside the field), which also makes room for it.
//   <TextField v-model="q" label="Search" hide-label><template #leading><AppIcon name="search" /></template></TextField>
import { computed, useId, useSlots } from 'vue'

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

const slots = useSlots()
const auto = useId()
const fieldId = computed(() => props.id || `field-${auto}`)
const helpId = computed(() => (props.error || props.hint ? `${fieldId.value}-help` : undefined))
</script>

<template>
  <div class="field">
    <label class="field__label" :class="{ 'sr-only': hideLabel }" :for="fieldId">{{ label }}</label>
    <div class="field__control" :class="{ 'field__control--lead': !!slots.leading }">
      <span v-if="slots.leading" class="field__lead" aria-hidden="true"><slot name="leading" /></span>
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
/* A leading icon: 16px of icon between 14px and 12px of space, so the text starts at 42px (41px on focus, as the border grows). */
.field__lead { position: absolute; top: 0; bottom: 0; left: 14px; display: flex; align-items: center; color: var(--muted); pointer-events: none; }
.field__control--lead .field__input { padding-left: 42px; }
.field__input::placeholder { color: var(--muted); opacity: 1; }
/* The border grows from 1px to 2px on focus; the padding shrinks by 1px so the text does not move. */
.field__input:focus { padding: 13px 11px; border: 2px solid var(--ink); outline: none; }
.field__control--lead .field__input:focus { padding-left: 41px; }
.field__input[aria-invalid="true"] { border-color: var(--primary-error-text); }
.field__input:disabled { background: var(--surface-soft); cursor: not-allowed; }
.field__hint { color: var(--muted); font: var(--text-body-sm); }
.field__error { color: var(--primary-error-text); font: var(--text-body-sm); }
</style>
