// One shared clock for countdowns. Ticks every 30 seconds while any component uses it.
import { onBeforeUnmount, onMounted, ref } from 'vue'

const now = ref(new Date())
let users = 0
let timer = null

export function useNow() {
  onMounted(() => {
    users += 1
    now.value = new Date()
    if (!timer) timer = setInterval(() => (now.value = new Date()), 30000)
  })
  onBeforeUnmount(() => {
    users -= 1
    if (!users) {
      clearInterval(timer)
      timer = null
    }
  })
  return now
}
