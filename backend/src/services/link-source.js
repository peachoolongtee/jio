// Pure helpers for reading a place post from a link: which site and which post a link is, how old a post is, whether the
// place in it is open now, and how to compare names. No network, no keys. services/link-reader.js uses them.

// The sites a link may point to, and nothing else. Only these addresses are ever passed to a download tool or to an AI, so
// a link cannot make the server fetch an address inside our network.
const SITES = {
  youtube: ['youtube.com', 'youtu.be'],
  tiktok: ['tiktok.com'],
  instagram: ['instagram.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com'],
}

const hostIs = (host, domain) => host === domain || host.endsWith(`.${domain}`)

// Which site and which post a link is. `key` names the post itself, the same for every spelling of its link, so a post
// read once is never read again. It is null when the link is a short link that has to be followed first (vt.tiktok.com,
// xhslink.com): the post is then identified by the address.
//
// How to call:
//   parseLink('https://www.tiktok.com/@a/video/7690756962551680276?q=x&t=1')
//   // { ok: true, platform: 'tiktok', key: 'tiktok:7690756962551680276', kind: 'video', url: 'https://www.tiktok.com/@a/video/7690756962551680276' }
//   parseLink('https://example.com/x') // { ok: false, reason: 'unsupported_site' }
export function parseLink(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_a_link' }
  const text = raw.trim()
  if (text === '' || text.length > 600) return { ok: false, reason: 'not_a_link' }
  let url
  try { url = new URL(text) } catch { return { ok: false, reason: 'not_a_link' } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'not_a_link' }
  if (url.username || url.password || (url.port && url.port !== '80' && url.port !== '443')) return { ok: false, reason: 'not_a_link' }
  const host = url.hostname.toLowerCase()
  const platform = Object.keys(SITES).find((p) => SITES[p].some((d) => hostIs(host, d)))
  if (!platform) return { ok: false, reason: 'unsupported_site' }

  const path = url.pathname
  let key = null
  let kind = 'unknown'
  if (platform === 'youtube') {
    const id = host === 'youtu.be' ? path.split('/')[1] : url.searchParams.get('v') ?? path.match(/^\/(?:shorts|live|embed)\/([^/?]+)/)?.[1]
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) { key = `youtube:${id}`; kind = 'video' }
  } else if (platform === 'tiktok') {
    const m = path.match(/\/(video|photo)\/(\d{8,25})/)
    if (m) { key = `tiktok:${m[2]}`; kind = m[1] }
  } else if (platform === 'instagram') {
    const m = path.match(/^\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)
    if (m) { key = `instagram:${m[2]}`; kind = m[1] === 'p' ? 'photo' : 'video' }
  } else if (platform === 'xiaohongshu' && !hostIs(host, 'xhslink.com')) {
    const m = path.match(/\/(?:discovery\/item|explore|note)\/([0-9a-f]{12,32})/i)
    if (m) key = `xiaohongshu:${m[1].toLowerCase()}`
  }

  // The link without tracking parts (?q=, &t=, share ids): what is kept and handed on. YouTube's own address needs ?v=.
  const clean = new URL(url.origin + url.pathname)
  if (platform === 'youtube' && url.searchParams.get('v')) clean.searchParams.set('v', url.searchParams.get('v'))
  return { ok: true, platform, key, kind, url: clean.href, original: url.href }
}

// Do two names refer to the same place, allowing one or two misread letters ("Nbbies Cafe" for "Nibbies Cafe")? sameName(),
// or the names are at least 85% alike letter for letter (and at least 8 letters long, so short names never blur together).
//
// How to call:
//   closeName('Nibbies Cafe', 'Nbbies Cafe') // true
//   closeName('Mini One', 'Mimi One')        // false: too short to tell
export function closeName(a, b) {
  if (sameName(a, b)) return true
  const x = norm(a).replace(/ /g, '')
  const y = norm(b).replace(/ /g, '')
  if (Math.min(x.length, y.length) < 8 || Math.abs(x.length - y.length) > 2) return false
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const row = [i]
    for (let j = 1; j <= y.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    prev = row
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length) >= 0.85
}

// Is this address on one of the supported sites? The host only, for a page the browser tool ended up on after a redirect
// (those addresses can be longer than a pasted link may be).
//
// How to call:
//   onSupportedSite('https://www.xiaohongshu.com/explore/675061a600000000070315b4') // true
export function onSupportedSite(raw) {
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    return (url.protocol === 'https:' || url.protocol === 'http:') && Object.values(SITES).some((ds) => ds.some((d) => hostIs(host, d)))
  } catch { return false }
}

// ---------------------------------------------------------------- text

// Bidirectional-control characters: they can make text read in another order than it is written.
const BIDI_CONTROL = /[؜‎‏‪-‮⁦-⁩]/gu
const SPACE_RUN = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu

// Text from a post, a comment or the AI made safe to show and to put in a prompt: control and bidirectional characters
// dropped, runs of whitespace (a newline too) turned into one space, angle brackets removed, and cut to `max` characters.
//
// How to call:
//   cleanText('  Nice <b>place</b>\nOpen late ', 40) // 'Nice bplace/b Open late'
export function cleanText(value, max = 300) {
  const text = String(value ?? '').replace(BIDI_CONTROL, '').replace(SPACE_RUN, ' ').replace(/[<>]/g, '').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

// A name boiled down so two spellings of one place compare equal: lower case, no brackets or punctuation.
const norm = (t) => String(t ?? '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// Do two names refer to the same place? The same words after dropping case, punctuation and branch brackets, or one holds
// the other, or at least 60% of the words are shared.
//
// How to call:
//   sameName('Ah Chew Dessert', 'Ah Chew Desserts (Liang Seah)') // true
export function sameName(a, b) {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  if (x.includes(y) || y.includes(x)) return true
  const tx = new Set(x.split(' '))
  const ty = new Set(y.split(' '))
  const shared = [...tx].filter((w) => ty.has(w)).length
  return shared / Math.max(tx.size, ty.size) >= 0.6
}

// ---------------------------------------------------------------- dates

const MS_DAY = 86400000

// Today in Singapore as YYYY-MM-DD.
//
// How to call:
//   todayInSingapore() // '2026-10-12'
export const todayInSingapore = (now = Date.now()) => new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10)

export const validDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))
const dayNumber = (d) => Date.parse(`${d}T00:00:00Z`) / MS_DAY

// Whole days from `from` to `to` (both YYYY-MM-DD). Negative when `to` is earlier.
export const daysBetween = (from, to) => Math.round(dayNumber(to) - dayNumber(from))

// "3 months ago", for a number of days.
//
// How to call:
//   agoText(0) // 'today'     agoText(45) // '1 month ago'     agoText(400) // 'over a year ago'
export function agoText(days) {
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  if (days < 365) return `${Math.floor(days / 30)} months ago`
  return 'over a year ago'
}

export const STALE_AFTER_DAYS = 30 // A temporary or coming-soon place with no dates in a post older than this has probably changed.
export const OLD_AFTER_DAYS = 365 // Any place in a post older than this: its details may have changed.

// How much to trust a post by its age. Returns { level, ageDays, postedAgo, warning }; level is 'unknown' (no post date),
// 'fresh', 'aging' (temporary or coming soon, no dates, over 30 days), 'stale' (the same, over 90 days) or 'old' (over a
// year). `warning` is a sentence for the screen, or null.
//
// How to call:
//   freshnessOf({ postDate: '2026-05-15', status: 'temporary', hasDates: false }, '2026-10-12')
//   // { level: 'stale', ageDays: 150, postedAgo: '5 months ago', warning: 'Posted 5 months ago and gives no dates: it has probably changed. Check before going.' }
export function freshnessOf({ postDate, status, hasDates }, today) {
  if (!validDay(postDate) || daysBetween(postDate, today) < 0) return { level: 'unknown', ageDays: null, postedAgo: null, warning: null }
  const ageDays = daysBetween(postDate, today)
  const postedAgo = agoText(ageDays)
  const shortLived = (status === 'temporary' || status === 'coming_soon') && !hasDates
  if (shortLived && ageDays > 90) return { level: 'stale', ageDays, postedAgo, warning: `Posted ${postedAgo} and gives no dates: it has probably changed. Check before going.` }
  if (shortLived && ageDays > STALE_AFTER_DAYS) return { level: 'aging', ageDays, postedAgo, warning: `Posted ${postedAgo} and gives no dates: it may have changed. Check before going.` }
  if (ageDays > OLD_AFTER_DAYS) return { level: 'old', ageDays, postedAgo, warning: `From a post ${postedAgo}: its details may have changed.` }
  return { level: 'fresh', ageDays, postedAgo, warning: null }
}

// What to tell people about when a place is available, from the dates the post states and today's date. The AI only
// reads the dates; the comparison with today is made here. Returns { state, usableNow, line }:
//   state      'open', 'not_open_yet', 'temporary_now', 'ended', or 'unverified' (temporary or coming soon with nothing
//              that says it is open now)
//   usableNow  whether the app may put the place in a plan
//   line       a sentence for the screen, or '' for an ordinary open place
//
// How to call:
//   availabilityOf({ status: 'temporary', opensOn: '2026-10-20', closesOn: '2026-10-25', note: '' }, '2026-10-13')
//   // { state: 'not_open_yet', usableNow: false, line: 'Not open yet: temporary, starts on 2026-10-20 (in 7 days), until 2026-10-25.' }
export function availabilityOf({ status, opensOn, closesOn, note, freshness }, today) {
  const from = validDay(opensOn) ? opensOn : ''
  const until = validDay(closesOn) ? closesOn : ''
  const extra = note ? ` ${note}` : ''
  const inDays = (d) => { const n = daysBetween(today, d); return n === 1 ? 'tomorrow' : `in ${n} days` }
  if (status === 'closed' || (until && daysBetween(today, until) < 0)) {
    return { state: 'ended', usableNow: false, line: `Not available: ${until ? `ended on ${until}` : 'closed'}.${extra}` }
  }
  if (from && daysBetween(today, from) > 0) {
    return { state: 'not_open_yet', usableNow: false, line: `Not open yet: ${status === 'temporary' ? 'temporary, starts' : 'opens'} on ${from} (${inDays(from)})${until ? `, until ${until}` : ''}.${extra}` }
  }
  if (status === 'coming_soon') {
    return { state: 'not_open_yet', usableNow: false, line: `Not open yet: ${from ? `opens on ${from}` : 'no opening date announced'}. Check again later.${extra}` }
  }
  if (status === 'temporary') {
    if (until && (freshness?.level !== 'stale')) return { state: 'temporary_now', usableNow: true, line: `Temporary, open now until ${until} (${daysBetween(today, until)} days left).${extra}` }
    return { state: 'unverified', usableNow: false, line: `Temporary and the post gives no end date: check it is still on before going.${extra}` }
  }
  return { state: 'open', usableNow: true, line: '' }
}
