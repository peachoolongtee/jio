// The pure parts of "Places from a post": checking a pasted link before it is sent, and turning the link reader's answer
// (backend/docs/link-reader-api.md) into the lines a card shows. No network and no component here, so each is tested alone.
// api.js (placesFromPost) sends the link; views/PostPlacesView.vue shows what comes back.

// The most characters the server reads in a link.
export const POST_LINK_MAX_CHARS = 600

// The sites whose posts the deployed server can read. A subdomain counts (www.youtube.com).
// The server also knows Instagram, Xiaohongshu and TikTok (backend/src/services/link-source.js), but reading them needs the development
// tools that only run on a developer's laptop (backend/docs/link-reader-api.md), so the screen does not offer them. TikTok's own caption
// service stopped giving captions to any server on 14 November 2026, so a TikTok link ends "nothing to read" after a wait: it is turned
// away at once, in its own words. To offer TikTok again, move it from TIKTOK_SITES to SITES.
const SITES = ['youtube.com', 'youtu.be']
const TIKTOK_SITES = ['tiktok.com']
const onSite = (host, sites) => sites.some((site) => host === site || host.endsWith(`.${site}`))

// What is wrong with a pasted link, or '' when it is worth sending. The server checks it again and more closely (a profile
// or a home page is not a post), so this only catches what is plainly not a supported link.
// How to call: postLinkProblem('tiktok.com/@a/video/1') -> 'Paste the whole link, starting with https://'
export function postLinkProblem(text) {
  const link = String(text ?? '').trim()
  if (!link) return 'Paste a link to a post.'
  if (link.length > POST_LINK_MAX_CHARS) return 'That link is too long to be a post.'
  let url
  try {
    url = new URL(link)
  } catch {
    return 'Paste the whole link, starting with https://'
  }
  if (url.protocol !== 'https:') return 'Paste the whole link, starting with https://'
  const host = url.hostname.toLowerCase()
  if (onSite(host, TIKTOK_SITES)) return "TikTok links can't be read yet. Try a YouTube link."
  if (!onSite(host, SITES)) return 'Only YouTube links can be read.'
  return ''
}

// Why a post could not be read, in words a person can act on. `reason` is the server's (link-reader-api.md, "unreadable").
const UNREADABLE = {
  ai_unavailable: 'Reading posts is busy right now. Try again in a minute.',
  busy: 'Jio is reading other posts right now. Try again in a moment.',
  post_unreadable: 'This post could not be read. It may be private, removed, age-restricted or too long.',
  site_not_supported: 'This kind of post is not supported yet.',
  instagram_needs_video_tool: 'Instagram posts are not supported yet.',
  login_required: 'This site asked for a login, so the post could not be read.',
  nothing_to_read: 'This post has nothing Jio can read.',
}

// The sentence for an answer whose status is 'unreadable'.
// How to call: unreadableText({ status: 'unreadable', reason: 'busy' }) -> 'Jio is reading other posts right now. Try again in a moment.'
export function unreadableText(answer) {
  return UNREADABLE[answer?.reason] || 'This post could not be read.'
}

// The sentence for a read that failed outright: too many reads, a server that cannot read posts, or the client's own sentence.
// How to call: readErrorText(Object.assign(new Error('x'), { code: 'rate_limited' })) -> 'You can read 3 posts a minute. Try again in a minute.'
export function readErrorText(err) {
  if (err?.code === 'rate_limited') return 'You can read 3 posts a minute. Try again in a minute.'
  if (err?.code === 'link_reader_unavailable' || err?.code === 'not_found') return 'Reading posts is not available right now.'
  return err?.message || 'The post could not be read. Try again.'
}

// What the post was read from, when it was less than the whole video: a caption only. '' otherwise.
// How to call: sourceNote({ how: 'caption' }) -> 'Read from the caption only, so a place only said or shown in the video may be missing.'
export function sourceNote(source) {
  return source?.how === 'caption' ? 'Read from the caption only, so a place only said or shown in the video may be missing.' : ''
}

// Google's rating as the card shows it: '4.5 ★ (66)', 'New' when Google has the place and no rating, and null when there is
// no match (no stars, never a zero). `dim` is true under 10 ratings, because a 5.0 from three people says little.
// How to call: ratingLine({ rating: 4.5, ratingCount: 66 }) -> { text: '4.5 ★ (66)', label: 'Rated 4.5 by 66 people on Google', dim: false }
export function ratingLine(match) {
  if (!match) return null
  const { rating, ratingCount } = match
  if (typeof rating !== 'number') return { text: 'New', label: 'New on Google, no ratings yet', dim: false }
  const count = typeof ratingCount === 'number' ? ratingCount : 0
  return {
    text: `${rating.toFixed(1)} ★ (${count.toLocaleString('en-SG')})`,
    label: `Rated ${rating.toFixed(1)} by ${count.toLocaleString('en-SG')} ${count === 1 ? 'person' : 'people'} on Google`,
    dim: count < 10,
  }
}

// Where a place is, as the card says it: Google's address when there is a match, else what the post said, else ''.
// How to call: placeAddress({ match: { address: '9 Example Road' }, locationHint: 'Orchard' }) -> '9 Example Road'
export function placeAddress(place) {
  return place?.match?.address || place?.locationHint || ''
}

// A Google Maps link that opens the place: by its Google place id when it was matched, else a search for its name in Singapore.
// Linking to Google Maps keeps nothing of Google's data, so it is allowed where storing it is not.
// How to call: mapsUrl({ name: 'Starlight', match: { placeId: 'abc', name: 'Starlight', address: '9 Example Road' } })
//   -> 'https://www.google.com/maps/search/?api=1&query=Starlight%209%20Example%20Road&query_place_id=abc'
export function mapsUrl(place) {
  const match = place?.match
  if (match?.placeId) {
    const query = encodeURIComponent([match.name, match.address].filter(Boolean).join(' '))
    return `https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=${encodeURIComponent(match.placeId)}`
  }
  const query = encodeURIComponent([place?.nameEnglish || place?.name, place?.locationHint, 'Singapore'].filter(Boolean).join(' '))
  return `https://www.google.com/maps/search/?api=1&query=${query}`
}

// The warnings a place carries, as sentences, without repeats: not open now, an old post, a viewer's note. `postWarning` is
// the warning already shown for the whole post, so a place whose own warning says the same thing does not say it again.
// How to call: placeNotes({ availability: { usableNow: false, line: 'Ended on 1 Oct.' } }) -> ['Ended on 1 Oct.']
export function placeNotes(place, postWarning = '') {
  const out = []
  const add = (line) => {
    const text = String(line ?? '').trim()
    if (text && !out.includes(text)) out.push(text)
  }
  if (place?.availability && place.availability.usableNow === false) add(place.availability.line || 'May not be open now.')
  if (place?.freshness?.warning !== postWarning) add(place?.freshness?.warning)
  const comment = String(place?.commentNote ?? '').trim()
  if (comment) add(/^a viewer\b/i.test(comment) ? comment : `A viewer says: ${comment}`)
  return out
}

// Does Google's match need the person to check it? Its name differs from the post's, or there are several branches.
// How to call: matchQuestion({ nameMatches: false }) -> 'Google lists it under another name. Is this it?'
export function matchQuestion(match) {
  if (!match) return ''
  if (match.ambiguous) return 'One of several branches. Check it is the right one.'
  if (match.nameMatches === false) return 'Google lists it under another name. Is this it?'
  return ''
}
