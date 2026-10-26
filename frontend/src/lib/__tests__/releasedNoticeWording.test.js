// The sentence the group reads when the host changes the meeting place is written twice, once by the server (backend/src/services/session-plan.js
// releasedBannerText, for a session on the server) and once by the data layer (lib/startChoice.js releasedNotice, for a demo or local account). They
// must say the same words in every case, so a guest never reads a different sentence from the one the host's account would have written.
import { describe, expect, it } from 'vitest'
import { releasedBannerText } from '../../../../backend/src/services/session-plan.js'
import { releasedNotice } from '../startChoice.js'

const CASES = []
for (const status of ['voting', 'confirmed']) {
  for (const hadVotes of [true, false]) {
    for (const placeName of [null, 'Bugis']) CASES.push({ hostName: 'Ian', status, hadVotes, placeName })
  }
}

describe('the notice of a changed meeting place', () => {
  it.each(CASES)('is the same sentence on the server and in the browser: %j', (facts) => {
    expect(releasedNotice(facts)).toBe(releasedBannerText(facts))
  })

  it('names the host, says what went in plain words, and never says "chosen again" for a release that named no area', () => {
    expect(releasedNotice({ hostName: 'Ian', status: 'voting', hadVotes: false })).toBe('Ian changed the meeting place, so the places to vote on were cleared.')
    expect(releasedNotice({ hostName: 'Ian', status: 'voting', hadVotes: false, placeName: 'Bugis' })).toBe('Ian changed the meeting place to Bugis, so the places to vote on were chosen again.')
    expect(releasedNotice({ hostName: 'Ian', status: 'confirmed', hadVotes: true })).toBe('Ian changed the meeting place, so the votes and the plan were cleared.')
    expect(releasedNotice({ hostName: 'Ian', status: 'voting', hadVotes: true, placeName: 'Bugis' })).toBe('Ian changed the meeting place to Bugis, so the votes were cleared.')
  })
})
