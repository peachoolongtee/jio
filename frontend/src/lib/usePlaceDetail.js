// Opening a place's detail (components/event/PlaceDetail.vue) from a suggestion card, for the pages that draw cards
// (components/event/SuggestionCard.vue): the Vote page and the Roam page. The card sends `open` with the option and where
// it was pressed from ('name' for the photo and name, 'review' for the review line). Opening makes no planner request: the
// detail is built from the option, and the address is added from the place list when the place is in it. Closing puts focus
// back on the control that opened it.
//   const { detail, outing, open, close } = usePlaceDetail(() => session.value)
//   <SuggestionCard @open="open" /> <PlaceDetail v-if="detail" :place="detail.place" :reviews="detail.reviews" :outing="outing" @close="close" />
import { computed, nextTick, ref } from 'vue'
import { getPlace } from '@/lib/api.js'
import { reviewsFor } from '@/lib/mock/reviews.js'
import { placeFromOption } from '@/lib/reviewPick.js'
import { useAuthStore } from '@/stores/auth.js'

// The attribute each card control carries, by where the detail was opened from.
const CONTROL = { name: 'data-open-for', review: 'data-review-for' }

// `getSession` returns the session the cards belong to (its `activeIds` are the people in the outing, and its `area` is
// where the address lookup measures from). Call it from a component's setup.
// Returns { detail (null or { optionId, from, place, reviews }), outing (ids of the other people in the outing, for the
// detail's "In this outing" ordering), open(option, from), close(), reset() }.
// How to call: const { detail, outing, open, close } = usePlaceDetail(() => session.value)
export function usePlaceDetail(getSession) {
  const auth = useAuthStore()
  const detail = ref(null)
  const outing = computed(() => (getSession()?.activeIds || []).filter((id) => id !== auth.myId))

  // Open the place of an option. The address is looked up after, and kept only if the same place is still open.
  // How to call: open(option, 'name') (from a card's name or photo; 'review' from its review line, the default)
  function open(option, from = 'review') {
    const place = placeFromOption(option)
    detail.value = { optionId: option.id, from, place, reviews: reviewsFor(option.venue) }
    if (place.address) return
    getPlace(option.venue.id, getSession()?.area?.id)
      .then((known) => {
        if (detail.value?.optionId === option.id && known.address) detail.value.place = { ...detail.value.place, address: known.address }
      })
      .catch(() => {})
  }

  // Close the detail and put focus back on the control that opened it.
  // How to call: await close()
  async function close() {
    const id = detail.value?.optionId
    const attr = CONTROL[detail.value?.from] || CONTROL.review
    detail.value = null
    await nextTick()
    document.querySelector(`[${attr}="${CSS.escape(id ?? '')}"]`)?.focus({ preventScroll: true })
  }

  // Close the detail without moving focus, as when the page shows another session.
  // How to call: reset()
  function reset() {
    detail.value = null
  }

  return { detail, outing, open, close, reset }
}
