<script setup>
// A labelled slider with its current value written on the right. Ink track, white thumb with the one shadow tier.
//   <RangeSlider v-model="budget" label="Budget per person" :min="5" :max="60" :step="5" :format="(v) => `Up to SGD ${v}`" />
// `disabled` greys it out and ignores input (a switch elsewhere, such as "Auto", is in charge).
// The model moves with the thumb; `commit` fires when the person lets go, or presses an arrow key, for work too slow to do on every move.
import { computed, useId } from 'vue'

const model = defineModel({ type: Number, required: true })
defineEmits(['commit'])
const props = defineProps({
  label: { type: String, required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 100 },
  step: { type: Number, default: 1 },
  // Turns the number into the words shown and read out, for example "Up to SGD 25".
  format: { type: Function, default: (v) => String(v) },
  disabled: { type: Boolean, default: false },
})
const id = `range-${useId()}`
const text = computed(() => props.format(model.value))
const fill = computed(() => `${((model.value - props.min) / (props.max - props.min)) * 100}%`)
</script>

<template>
  <div class="range" :class="{ 'is-disabled': disabled }">
    <div class="range__head">
      <label :for="id" class="caption">{{ label }}</label>
      <span class="caption" aria-hidden="true">{{ text }}</span>
    </div>
    <input
      :id="id"
      v-model.number="model"
      class="range__input"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :aria-valuetext="text"
      :style="{ '--fill': fill }"
      @change="$emit('commit')"
    />
  </div>
</template>

<style scoped>
.range { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.range__head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); }
.range__input { width: 100%; height: var(--tap-min); margin: 0; background: transparent; cursor: pointer; appearance: none; -webkit-appearance: none; }
.range__input::-webkit-slider-runnable-track { height: 6px; border-radius: var(--rounded-full); background: linear-gradient(to right, var(--ink) var(--fill), var(--hairline) var(--fill)); }
.range__input::-moz-range-track { height: 6px; border-radius: var(--rounded-full); background: var(--hairline); }
.range__input::-moz-range-progress { height: 6px; border-radius: var(--rounded-full); background: var(--ink); }
.range__input::-webkit-slider-thumb { width: 24px; height: 24px; margin-top: -9px; border: 1px solid var(--hairline); border-radius: var(--rounded-full); background: var(--canvas); box-shadow: var(--shadow-float); -webkit-appearance: none; }
.range__input::-moz-range-thumb { width: 22px; height: 22px; border: 1px solid var(--hairline); border-radius: var(--rounded-full); background: var(--canvas); box-shadow: var(--shadow-float); }
.range__input:focus-visible { outline-offset: 0; }
.range.is-disabled { opacity: 0.45; }
.range.is-disabled .range__input { cursor: not-allowed; }
@media (hover: hover) {
  .range__input:hover::-webkit-slider-thumb { border-color: var(--ink); }
  .range__input:hover::-moz-range-thumb { border-color: var(--ink); }
}
</style>
