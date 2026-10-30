// What a screen says and does when the host has taken back an invite. The × that opened the question is gone by then (the person
// leaves the list), so focus would fall to the page. The screens show `takeBackNotice` in a polite status line that stays, and focus
// moves to the list's heading. It lives here, not in the dialog, because the dialog goes with the row.
//   <p class="sr-only" role="status">{{ takeBackNotice }}</p>
import { nextTick, ref } from 'vue'

export const takeBackNotice = ref('')
let timer = 0

// Says "Kim's invite taken back" and puts focus on the element with `focusId` (a heading with tabindex="-1"), once the row has gone.
// How to call: await announceTakeBack('Kim', 'invite-in')
export async function announceTakeBack(name, focusId = '') {
  clearTimeout(timer)
  // Empty first, so the same sentence said twice in a row is still read.
  takeBackNotice.value = ''
  await nextTick()
  takeBackNotice.value = name ? `${name}'s invite taken back` : 'Invite taken back'
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true })
  timer = setTimeout(() => { takeBackNotice.value = '' }, 6000)
}
