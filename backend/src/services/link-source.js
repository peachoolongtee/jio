// Pure helpers for reading a place post from a link: which site and which post a link is, how old a post is, whether the
// place in it is open now, and how to compare names. No network, no keys. services/link-reader.js uses them.
import { BlockList, isIP } from 'node:net'

// The sites a link may point to, and nothing else. Only these addresses are ever passed to a download tool or to an AI, so
// a link cannot make the server fetch an address inside our network.
const SITES = {
  youtube: ['youtube.com', 'youtu.be'],
  tiktok: ['tiktok.com'],
  instagram: ['instagram.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com'],
}

// The servers the browser tool may also load things from while it opens a post: the pictures, videos and scripts of those
// same sites. Anything else is refused, so a page cannot make the tool fetch from anywhere it likes. The list is short on
// purpose: a page that needs a server not named here loads less, and the read falls back to the caption.
export const MEDIA_HOSTS = [
  'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokv.com', 'tiktokv.us', 'ibytedtos.com', 'byteoversea.com', 'muscdn.com', 'ttwstatic.com', // TikTok
  'cdninstagram.com', 'fbcdn.net', // Instagram
  'xhscdn.com', // Xiaohongshu
]

const hostIs = (host, domain) => host === domain || host.endsWith(`.${domain}`)
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/

// A fixed sentence for each way a download or browser tool can fail, so what the tool says (a path, an address, a message from
// a program) never reaches the person who pasted the link. `detail` is for the server's log only.
//
// How to call:
//   throw new LinkToolError('not_installed', 'yt-dlp is not installed')
//   throw new LinkToolError('failed', 'The video could not be downloaded.', err.message)
export class LinkToolError extends Error {
  constructor(code, message, detail = '') {
    super(message)
    this.name = 'LinkToolError'
    this.code = code // 'not_installed', 'refused', 'blocked_site', 'login_required', 'too_big', 'timed_out' or 'failed'
    this.detail = String(detail ?? '')
  }
}

// The environment a download or browser tool is started with: enough to run, and none of the server's secrets (its keys, its
// service key). Only these names are copied from `env`.
//
// How to call:
//   execFile('yt-dlp', args, { env: toolEnvironment(process.env) })
export function toolEnvironment(env = process.env) {
  const out = { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'USERPROFILE']) {
    if (typeof env[name] === 'string' && env[name] !== '') out[name] = env[name]
  }
  return out
}

// Which site and which post a link is. `key` names the post itself, the same for every spelling of its link, so a post
// read once is never read again. It is null only for a short link that has to be followed first (vt.tiktok.com,
// xhslink.com): `short` is then true and the post is identified by the address. A link on a supported site that names no
// post (a home page, a profile, a feed, a post id too long to be real) is `not_a_link`.
//
// Only https on the default port is accepted: the link is rebuilt from its host and path, so nothing else is kept.
//
// How to call:
//   parseLink('https://www.tiktok.com/@a/video/7690756962551680276?q=x&t=1')
//   // { ok: true, platform: 'tiktok', key: 'tiktok:7690756962551680276', kind: 'video', short: false, url: 'https://www.tiktok.com/@a/video/7690756962551680276', original: '...' }
//   parseLink('https://example.com/x') // { ok: false, reason: 'unsupported_site' }
//   parseLink('https://www.youtube.com/') // { ok: false, reason: 'not_a_link' }
export function parseLink(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_a_link' }
  const text = raw.trim()
  if (text === '' || text.length > 600) return { ok: false, reason: 'not_a_link' }
  let url
  try { url = new URL(text) } catch { return { ok: false, reason: 'not_a_link' } }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_a_link' }
  if (url.username || url.password || url.port) return { ok: false, reason: 'not_a_link' } // a default port is not kept by URL
  const host = url.hostname.toLowerCase()
  const platform = Object.keys(SITES).find((p) => SITES[p].some((d) => hostIs(host, d)))
  if (!platform) return { ok: false, reason: 'unsupported_site' }

  const path = url.pathname
  const unusable = { ok: false, reason: 'not_a_link' }
  let key = null
  let kind = 'unknown'
  let short = false
  let youtubeId = null
  if (platform === 'youtube') {
    const candidates = host === 'youtu.be' ? [path.split('/')[1]] : [url.searchParams.get('v'), path.match(/^\/(?:shorts|live|embed)\/([^/?]+)/)?.[1]]
    youtubeId = candidates.find((c) => typeof c === 'string' && YOUTUBE_ID.test(c)) ?? null
    if (!youtubeId) return unusable
    key = `youtube:${youtubeId}`
    kind = 'video'
  } else if (platform === 'tiktok') {
    // A TikTok post id is a 64-bit number, so at most 19 digits: a longer run is not an id.
    const m = path.match(/\/(video|photo)\/(\d{8,19})(?!\d)/)
    if (m) { key = `tiktok:${m[2]}`; kind = m[1] }
    else if (/^\/(?:t\/)?[A-Za-z0-9]{6,20}\/?$/.test(path) && (/^(?:vm|vt)\./.test(host) || path.startsWith('/t/'))) short = true
    else return unusable
  } else if (platform === 'instagram') {
    const m = path.match(/^\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{8,40})(?:\/|$)/)
    if (!m) return unusable
    key = `instagram:${m[2]}`
    kind = m[1] === 'p' ? 'photo' : 'video'
  } else if (hostIs(host, 'xhslink.com')) {
    if (!/^\/(?:[A-Za-z]\/)?[A-Za-z0-9]{4,40}\/?$/.test(path)) return unusable
    short = true
  } else {
    const m = path.match(/\/(?:discovery\/item|explore|note)\/([0-9a-f]{12,32})(?![0-9a-f])/i) ?? path.match(/\/user\/profile\/[0-9a-f]{8,32}\/([0-9a-f]{12,32})(?![0-9a-f])/i)
    if (!m) return unusable
    key = `xiaohongshu:${m[1].toLowerCase()}`
  }

  // The link without tracking parts (?q=, &t=, share ids): what is kept and handed on. YouTube's own address needs ?v=.
  const clean = new URL(url.origin + url.pathname)
  if (platform === 'youtube' && youtubeId && url.searchParams.get('v') === youtubeId) clean.searchParams.set('v', youtubeId)
  return { ok: true, platform, key, kind, short, url: clean.href, original: url.href }
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
// (those addresses can be longer than a pasted link may be). https on the default port, no login in it.
//
// How to call:
//   onSupportedSite('https://www.xiaohongshu.com/explore/675061a600000000070315b4') // true
//   onSupportedSite('http://www.tiktok.com/@a/video/1')                              // false: not https
export function onSupportedSite(raw) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
    const host = url.hostname.toLowerCase()
    return Object.values(SITES).some((ds) => ds.some((d) => hostIs(host, d)))
  } catch { return false }
}

// May the browser tool load this address? A supported site, or one of the servers that carry the same sites' pictures and
// videos (MEDIA_HOSTS), over https on the default port. Anything else (another site, an IP address, localhost, a scheme that
// is not https) is refused. A host given as an IP address never matches a name, so it is always refused.
//
// How to call:
//   allowedBrowserUrl('https://p16-sign.tiktokcdn.com/obj/x.jpeg') // true
//   allowedBrowserUrl('https://169.254.169.254/latest')            // false
export function allowedBrowserUrl(raw) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
    const host = url.hostname.toLowerCase()
    return [...Object.values(SITES).flat(), ...MEDIA_HOSTS].some((d) => hostIs(host, d))
  } catch { return false }
}

// IPv4 ranges that are not the public internet: this network, private, shared (carrier) space, loopback, link-local (cloud
// metadata), protocol and documentation ranges, benchmarking, multicast and reserved.
const NOT_PUBLIC_V4 = new BlockList()
for (const [start, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) NOT_PUBLIC_V4.addSubnet(start, bits, 'ipv4')

// IPv6 is allowed only inside global unicast (2000::/3), minus the ranges inside it that are not for the public internet
// (Teredo, documentation, 6to4). Everything else, including loopback, unique-local, link-local and mapped IPv4, is refused.
const GLOBAL_V6 = new BlockList()
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6')
const NOT_PUBLIC_V6 = new BlockList()
for (const [start, bits] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]]) NOT_PUBLIC_V6.addSubnet(start, bits, 'ipv6')

// Is this a public internet address (not private, loopback, link-local, unique-local, multicast or reserved)? A name, or an
// address with a zone (fe80::1%eth0), is false.
//
// How to call:
//   isPublicAddress('93.184.216.34') // true
//   isPublicAddress('169.254.169.254') // false
//   isPublicAddress('::ffff:127.0.0.1') // false
export function isPublicAddress(address) {
  const version = isIP(String(address))
  if (version === 4) return !NOT_PUBLIC_V4.check(address, 'ipv4')
  if (version === 6) return GLOBAL_V6.check(address, 'ipv6') && !NOT_PUBLIC_V6.check(address, 'ipv6')
  return false
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

// Text with web addresses taken out (https://..., www....). The AI's sentences are shown to people and its answer may carry
// a link that a stranger's caption told it to repeat, so none is kept.
//
// How to call:
//   withoutLinks('Best laksa, order at https://evil.example/x now') // 'Best laksa, order at now'
export function withoutLinks(value) {
  return String(value ?? '').replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
}

// A comment with the @handles taken out, so what is passed on says nothing about who wrote it or who it was written to.
//
// How to call:
//   withoutHandles('@someone_sg the queue is long') // ' the queue is long'
export function withoutHandles(value) {
  return String(value ?? '').replace(/@[\p{L}\p{N}_.]{2,}/gu, ' ')
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
