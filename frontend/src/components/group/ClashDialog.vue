<script setup>
// The popup for a meetup that falls on top of another one the person is already in. It names the meetup in the way and
// offers two ways on: change the time here, or go and look at the other meetup.
//   <ClashDialog v-model:open="showClash" :clash="clash" />
// `clash` is { id, title, date, start, end } (lib/clash.js), or null when the database refused without saying which.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import { dateLine } from '@/lib/session.js'

const open = defineModel('open', { type: Boolean, default: false })
const props = defineProps({ clash: { type: Object, default: null } })

const router = useRouter()
const text = computed(() =>
  props.clash
    ? `You're already in "${props.clash.title}" on ${dateLine(props.clash)}. Pick a time that doesn't overlap, or sort out that meetup first.`
    : "You're already in a meetup at that time. Pick a time that doesn't overlap, or sort out that meetup first.",
)

// How to call: openOther()
function openOther() {
  open.value = false
  if (props.clash?.id) router.push(`/sessions/${props.clash.id}`)
}
</script>

<template>
  <ModalDialog v-model:open="open" title="You have a clashing meetup" :text="text">
    <AppButton block data-testid="clash-change" @click="open = false">Change the time</AppButton>
    <AppButton v-if="clash?.id" block variant="secondary" data-testid="clash-open" @click="openOther">View that meetup</AppButton>
  </ModalDialog>
</template>
