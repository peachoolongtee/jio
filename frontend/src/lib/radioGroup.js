// Keyboard behaviour for a set of radio buttons drawn as buttons (chips, poll bars): one Tab stop for the whole set,
// and the arrow keys, Home and End move between its choices. Native <input type="radio"> sets do this already.
// Put `v-radio-group` on the element with role="radiogroup". With `v-radio-group="{ follow: false }"` the arrows
// only move focus and Space or Enter chooses, for sets where choosing writes something, such as a vote.

const KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']

// Whether a radio can be chosen: not disabled, natively or with aria-disabled.
// How to call: isEnabled({ disabled: false, ariaDisabled: false }) -> true
export function isEnabled(radio) {
  return !radio.disabled && !radio.ariaDisabled
}

// Which radio a key moves to, as an index, or -1 to leave the key alone. Disabled radios are skipped, and the arrows
// wrap round at either end. `items` are { disabled, ariaDisabled } in order, `current` is the focused one's index.
// How to call: moveIndex([{}, { disabled: true }, {}], 0, 'ArrowRight') -> 2
export function moveIndex(items, current, key) {
  if (!KEYS.includes(key)) return -1
  const enabled = items.map((item, i) => (isEnabled(item) ? i : -1)).filter((i) => i >= 0)
  if (!enabled.length) return -1
  if (key === 'Home') return enabled[0]
  if (key === 'End') return enabled[enabled.length - 1]
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1
  for (let n = 1; n <= items.length; n++) {
    const i = (current + step * n + items.length * n) % items.length
    if (isEnabled(items[i])) return i
  }
  return -1
}

// Which radio holds the set's one Tab stop: the chosen one (even while it is disabled, so focus is never lost),
// otherwise the first that can be chosen, otherwise the first. `items` are { checked, disabled, ariaDisabled }.
// How to call: tabStopIndex([{ checked: false }, { checked: true }]) -> 1
export function tabStopIndex(items) {
  if (!items.length) return -1
  const checked = items.findIndex((item) => item.checked)
  if (checked >= 0) return checked
  const enabled = items.findIndex(isEnabled)
  return enabled >= 0 ? enabled : 0
}

function state(el) {
  return { checked: el.getAttribute('aria-checked') === 'true', disabled: el.disabled === true, ariaDisabled: el.getAttribute('aria-disabled') === 'true' }
}

// The set's radios, leaving out any that belong to a radiogroup nested inside it.
function radiosOf(group) {
  return [...group.querySelectorAll('[role="radio"]')].filter((el) => el.closest('[role="radiogroup"]') === group)
}

function sync(group) {
  const radios = radiosOf(group)
  const stop = tabStopIndex(radios.map(state))
  radios.forEach((el, i) => el.setAttribute('tabindex', i === stop ? '0' : '-1'))
}

// How to call: import { vRadioGroup } from '@/lib/radioGroup.js' in <script setup>, then <div role="radiogroup" v-radio-group>
export const vRadioGroup = {
  mounted(group, binding) {
    // The screen tests render into a stand-in DOM without these; the chips still work there, without the arrows.
    if (typeof group.querySelectorAll !== 'function' || typeof MutationObserver === 'undefined') return
    group.__radioFollow = binding.value?.follow !== false
    const onKeydown = (event) => {
      const radios = radiosOf(group)
      const current = radios.indexOf(event.target)
      if (current < 0 || event.altKey || event.ctrlKey || event.metaKey) return
      const next = moveIndex(radios.map(state), current, event.key)
      if (next < 0) return
      event.preventDefault()
      radios[next].focus()
      if (group.__radioFollow && next !== current) radios[next].click()
    }
    // Chips are added, removed, chosen and disabled by Vue; the Tab stop follows each change.
    const observer = new MutationObserver(() => sync(group))
    observer.observe(group, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-checked', 'aria-disabled', 'disabled'] })
    group.addEventListener('keydown', onKeydown)
    group.__radioCleanup = () => {
      observer.disconnect()
      group.removeEventListener('keydown', onKeydown)
    }
    sync(group)
  },
  updated(group, binding) {
    group.__radioFollow = binding.value?.follow !== false
  },
  unmounted(group) {
    group.__radioCleanup?.()
  },
}
