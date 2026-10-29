<script setup>
// The popup for a meetup that falls on top of another one the person is already in. It names the meetup in the way and says what
// to do, which depends on where the person is.
//   mode "edit" (the default): making or changing a meetup. "That time is taken": change the time, or open the other meetup.
//   mode "join": joining one (a link, or coming back after opting out). "This meetup overlaps one you're in": look at the one
//   they are in, or close.
//   <ClashDialog v-model:open="showClash" :clash="clash" />
//   <ClashDialog v-model:open="showClash" :clash="clash" mode="join" />
// `clash` is { id, title, date, start, end } (lib/clash.js), or null when the database refused without saying which.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import { clashWhen, shortTitle } from '@/lib/clash.js'

const open = defineModel('open', { type: Boolean, default: false })
const props = defineProps({
  clash: { type: Object, default: null },
  mode: { type: String, default: 'edit', validator: (v) => ['edit', 'join'].includes(v) },
})

const router = useRouter()
const joining = computed(() => props.mode === 'join')
const title = computed(() => (joining.value ? "This meetup overlaps one you're in" : 'That time is taken'))
// "You're already in "Dinner" from 19:00 to 21:00 on Sat 10 Oct. Choose a time that doesn't overlap."
const text = computed(() => {
  const where = props.clash ? `"${props.clash.title}" ${clashWhen(props.clash)}`.trim() : 'a meetup at that time'
  return `You're already in ${where}${joining.value ? ", so you can't join this one as well." : ". Choose a time that doesn't overlap."}`
})
// The button that goes to the other meetup says which one: Open "Dinner" (View "Dinner" when joining). A long title is cut with an
// ellipsis to fit the button; the sentence above it has the whole title.
const otherLabel = computed(() => `${joining.value ? 'View' : 'Open'} "${shortTitle(props.clash?.title)}"`)

// How to call: openOther()
function openOther() {
  open.value = false
  if (props.clash?.id) router.push(`/sessions/${props.clash.id}`)
}
</script>

<template>
  <ModalDialog v-model:open="open" :title="title" :text="text">
    <template v-if="joining">
      <AppButton v-if="clash?.id" block data-testid="clash-open" @click="openOther">{{ otherLabel }}</AppButton>
      <AppButton block :variant="clash?.id ? 'secondary' : 'primary'" data-testid="clash-close" @click="open = false">Close</AppButton>
    </template>
    <template v-else>
      <AppButton block data-testid="clash-change" @click="open = false">Change the time</AppButton>
      <AppButton v-if="clash?.id" block variant="secondary" data-testid="clash-open" @click="openOther">{{ otherLabel }}</AppButton>
    </template>
  </ModalDialog>
</template>
