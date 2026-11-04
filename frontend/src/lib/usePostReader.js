// Whether to offer "Find places from a post" (the rainbow button on Home and in the top bar). A deployed Jio whose server cannot read
// posts (no LINK_READER=1, or no AI key) would send people to a page that only says "Reading posts is not available", so a production
// build offers it only once the server says it can read posts. A development build always offers it, so the button can be seen and
// worked on without the link reader running. The server is asked once per page load, for every button.
// How to call: const offerPosts = usePostReader()   <RainbowButton v-if="offerPosts" ... />
import { ref } from 'vue'
import { postReaderStatus } from './api.js'

const offer = ref(!!import.meta.env.DEV)
let asked = false

export function usePostReader() {
  if (!asked && !import.meta.env.DEV) {
    asked = true
    postReaderStatus()
      .then((caps) => { offer.value = !!caps?.enabled })
      // The server could not be asked: offer it, as the page itself does, and a read will say what is wrong.
      .catch(() => { offer.value = true })
  }
  return offer
}
