<script setup>
// A voucher code a person must be able to read out at a till: the code as selectable text (one click selects all of it, to copy by hand)
// with a Copy button after it. A copy says "Copied" beside the code for a moment, then goes back; the code is never replaced.
//   <CopyCode code="JIO-AAAA-BBBB" label="SGD 3 off any coffee" />
// `code` is what is shown and copied; `label` names the voucher for a screen reader. What is said to a screen reader is in a live region
// beside the button, not inside it.
import { computed, onBeforeUnmount, ref } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  code: { type: String, required: true },
  label: { type: String, default: '' },
})

const codeText = ref(null)
const copied = ref(false)
const announcement = ref('')

// How long "Copied" stays beside the code, in ms.
const NOTE_MS = 2500
let noteTimer = 0
onBeforeUnmount(() => clearTimeout(noteTimer))

const copyName = computed(() => `Copy code ${props.code}${props.label ? `, ${props.label}` : ''}`)

// Select the whole code, so it can be copied by hand. How to call: selectCode()
function selectCode() {
  const selection = typeof window !== 'undefined' ? window.getSelection?.() : null
  if (!selection || !codeText.value) return
  selection.removeAllRanges()
  const range = document.createRange()
  range.selectNodeContents(codeText.value)
  selection.addRange(range)
}

// Copy the code. When the browser refuses, the code is selected and a sentence says to copy it by hand. How to call: <button @click="copy">
async function copy() {
  try {
    await navigator.clipboard.writeText(props.code)
    copied.value = true
    announcement.value = 'Copied'
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => { copied.value = false }, NOTE_MS)
  } catch {
    // Copying is refused here (an older browser, or no permission): the code is selected on screen to copy by hand.
    selectCode()
    announcement.value = `Could not copy. The code ${props.code} is selected: copy it by hand.`
  }
}
</script>

<template>
  <div class="copy-code" :class="{ 'is-copied': copied }" data-testid="copy-code">
    <code ref="codeText" class="copy-code__text" data-testid="code-text" @click="selectCode">{{ code }}</code>
    <button type="button" class="copy-code__button" :aria-label="copyName" data-testid="code-copy" @click="copy">
      <AppIcon :name="copied ? 'check' : 'copy'" :size="16" />
    </button>
    <span v-if="copied" class="copy-code__note" aria-hidden="true" data-testid="code-copied">Copied</span>
    <span class="sr-only" role="status">{{ announcement }}</span>
  </div>
</template>

<style scoped>
.copy-code { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs); min-width: 0; }
/* The code stays: one click selects all of it, so it can be copied by hand. */
.copy-code__text { min-width: 0; padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--rounded-xs); background: var(--surface-strong); color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; letter-spacing: 0.04em; overflow-wrap: anywhere; user-select: all; -webkit-user-select: all; cursor: text; }
.copy-code__note { color: var(--ink); font-size: 13px; font-weight: 600; }
.copy-code__button { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; border: 0; border-radius: var(--rounded-full); background: transparent; color: var(--ink); cursor: pointer; }
.copy-code.is-copied .copy-code__button { background: var(--selected); color: var(--on-selected); }
.copy-code__button:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
@media (hover: hover) {
  .copy-code__button:hover { background: color-mix(in srgb, var(--ink) 10%, transparent); }
  .copy-code.is-copied .copy-code__button:hover { background: var(--selected); }
}
</style>
