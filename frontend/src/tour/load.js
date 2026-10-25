// Fill the demo account with the tour: the story's ten saves, then the side cases, then one reward redeemed.
//   const manifest = await loadTour({ now, makePhotos, onProgress })
// It starts with resetDemo, so loading twice gives the same set (s1 to s11) and not twice as many. The account and friends
// stay; the sessions, JioCoins, rewards and demo switches go back to how a new demo account has them. Every session is built
// through the public functions of lib/api.js (tour/builders.js), never by writing the stored data.
//
// The planner is whatever answers when this runs: the backend if it does, otherwise the stand-in (tour/standIn.js), which
// the caller has installed. The store notes which answered, so the strip can say that places and times are rough.
//
// `now` decides the dates only. The data layer's own idea of "today" is the real clock, so a test that passes a fixed `now`
// also sets the system time (vi.setSystemTime) to the same moment.
import * as api from '@/lib/api.js'
import { assertAllBuilt, buildSessions } from './builders.js'
import { SIDE_SPECS, STORY_SPECS, STORY_TITLE } from './story.js'
import { makeDemoPhotos } from '@/components/dev/demoPhotos.js'

// The voucher redeemed so Rewards has a history.
const REWARD = 'r-nylon'

// Answers { story: [ten ids, in checkpoint order], side: [ids], title, redeemed }.
// Throws a ShowcaseError, after doing what it can, when a session could not be finished; the message says which.
// How to call: const { story, side } = await loadTour({ onProgress: ({ done, total }) => (note.value = `${done} of ${total}`) })
export async function loadTour({ now = new Date(), makePhotos = makeDemoPhotos, onProgress = () => {} } = {}) {
  if (!(await api.getUser())) throw new Error('Sign in first: the tour fills the signed-in account.')
  // From here the account's sessions, points and switches are replaced.
  await api.resetDemo()
  const specs = [...STORY_SPECS, ...SIDE_SPECS]
  const built = await buildSessions(specs, { now, makePhotos, onProgress })
  // The reward needs JioCoins the finished outing paid, so it comes after.
  const redeemed = await api.redeemReward(REWARD).then(() => true, () => false)
  assertAllBuilt(built, 'sessions')
  const ids = built.made.map((entry) => entry.id)
  return { story: ids.slice(0, STORY_SPECS.length), side: ids.slice(STORY_SPECS.length), title: STORY_TITLE, redeemed }
}
