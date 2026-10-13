import { execFile } from 'node:child_process'
import { lookup as dnsLookup } from 'node:dns/promises'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { allowedBrowserUrl, isPublicAddress, LinkToolError, onSupportedSite, parseLink, toolEnvironment } from './link-source.js'

// Opening a post in Chrome the way a person would, for the posts a download tool cannot get: TikTok photo posts (slides),
// Instagram photos and carousels, and Xiaohongshu. OFF by default.
//
// It opens the post in a phone-sized headless Chrome (no login, nothing typed, no cookies kept), reads the caption, and
// saves each slide as a picture (or the video, when the post has one), so Gemini can read the text on the slides.
//
// Opening these pages with automation goes against TikTok's, Instagram's and Xiaohongshu's terms, and it stops working
// whenever they change a page. So it only runs when LINK_READER_BROWSER=1 is set and NODE_ENV=development, on a machine with
// Google Chrome installed: for development and demos on a laptop, never on the deployed server (setUpLinkReader() ignores
// it anywhere else).
//
// Safety:
//   - Only addresses parseLink() accepted are opened. Every request the page makes, the page itself and a redirect included,
//     is checked before it leaves (a route on the whole context): over https, to a supported site or to one of their media
//     hosts (MEDIA_HOSTS in link-source.js), or it is aborted. A navigation that is aborted ends the read as "blocked". The
//     page's final address is checked before anything is read from it.
//   - The pictures and the video are fetched by this tool, outside the page, so the route does not see them. Each address is
//     checked the same way, its name is resolved and every address it resolves to must be public (not private, loopback,
//     link-local or unique-local), and a redirect is followed by hand, checked at each step, at most 3 times.
//   - Chrome starts with its sandbox on, no service workers, no downloads, and the minimal environment of toolEnvironment():
//     none of the server's keys. ffmpeg and sips get the same.
//   - Nothing is typed into any page, and one post is opened at a time. A read can be stopped from outside (an AbortSignal):
//     the browser is closed at once.
//   - What a program or a page says is never passed on: a failure is a LinkToolError with a fixed sentence.
// Needs Playwright: `playwright-core` if it is installed, else the copy the frontend's tests already use.

const run = promisify(execFile)

export const MAX_SLIDES = 12
export const MAX_IMAGE_BYTES = 1_500_000 // After shrinking: a slide is read fine at 1280 px.
export const MAX_IMAGE_DOWNLOAD_BYTES = 25 * 1024 * 1024 // A slide before it is shrunk.
export const MAX_VIDEO_BYTES = 17 * 1024 * 1024
export const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024
export const MAX_REDIRECTS = 3 // Redirects followed by hand when the tool fetches a picture or the video itself.
export const OPEN_TIMEOUT_MS = 30_000
export const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]

// The slides on screen: big pictures that fill the width of the phone, at the top of the page (the recommended posts below
// them are smaller). Runs inside the page.
const slidesOnScreen = () =>
  [...document.images]
    .map((i) => ({ i, r: i.getBoundingClientRect() }))
    .filter(({ i, r }) => i.naturalHeight > 600 && r.width >= 300 && r.top < 700)
    .sort((a, b) => a.r.left - b.r.left)
    .map(({ i }) => ({ src: i.currentSrc || i.src }))

// The Playwright library: playwright-core when installed, else the frontend's copy. Throws a plain Error when neither.
function loadPlaywright() {
  for (const from of [import.meta.url, join(dirname(fileURLToPath(import.meta.url)), '../../../frontend/package.json')]) {
    for (const name of ['playwright-core', '@playwright/test']) {
      try { return createRequire(from)(name) } catch { /* try the next */ }
    }
  }
  throw new Error('Playwright is not installed (run pnpm install in the Jio folder)')
}

// Addresses that make no request: data:, blob: and about: stay inside the browser.
const inert = (raw) => /^(?:data|blob|about):/i.test(raw)

// Do all the addresses this host name resolves to belong to the public internet? False when it resolves to none, to any
// private, loopback, link-local or unique-local address, or cannot be resolved. `lookup` is only for tests.
//
// How to call:
//   await resolvesPublic('p16-sign.tiktokcdn.com') // true
//   await resolvesPublic('localhost')              // false
export async function resolvesPublic(host, lookup = dnsLookup) {
  try {
    const found = await lookup(host, { all: true })
    return Array.isArray(found) && found.length > 0 && found.every((f) => isPublicAddress(f.address))
  } catch { return false }
}

// Fetches an address the page pointed at (a picture or the video), outside the page. The address must be allowed, every
// address its name resolves to must be public, and a redirect is followed by hand, checked again at each step. Returns the
// response, or null when anything is refused or fails.
//
// How to call:
//   const res = await fetchChecked(ctx, 'https://p16-sign.tiktokcdn.com/x.jpeg', { referer: page.url(), timeout: 20000, lookup: dnsLookup })
export async function fetchChecked(ctx, start, { referer, timeout, lookup = dnsLookup }) {
  let current = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedBrowserUrl(current) || !(await resolvesPublic(new URL(current).hostname, lookup))) return null
    const res = await ctx.request.get(current, { headers: { referer }, timeout, maxRedirects: 0 }).catch(() => null)
    if (!res) return null
    if (res.status() >= 300 && res.status() < 400) {
      const to = res.headers()?.location
      if (!to) return null
      try { current = new URL(to, current).href } catch { return null }
      continue
    }
    return res
  }
  return null
}

// Is a response small enough to read into memory? Judged by its declared size when it has one.
const smallEnough = (res, max) => {
  const declared = Number(res.headers()?.['content-length'])
  return !Number.isFinite(declared) || declared <= max
}

// Makes a picture small enough to send: at most 1280 px on its longest side, as a JPEG. macOS's own tool first, ffmpeg if
// that cannot read the format. Throws when neither can.
async function shrink(from, to, exec) {
  try { await exec('sips', ['-Z', '1280', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', from, '--out', to]) } catch {
    await exec('ffmpeg', ['-y', '-loglevel', 'error', '-i', from, '-vf', "scale='min(1280,iw)':-2", '-q:v', '4', to])
  }
}

// Makes a video small enough to send: scaled down in steps until it fits. Returns the file to send.
async function fitVideo(file, maxBytes, exec) {
  if (statSync(file).size <= maxBytes) return file
  const out = file.replace(/\.[^.]+$/, '') + '-small.mp4'
  for (const width of [720, 540, 360]) {
    await exec('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', `scale='min(${width},iw)':-2`, '-r', '10', '-c:v', 'libx264', '-crf', '32', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '48k', '-ac', '1', out], { timeout: 180000 })
    if (statSync(out).size <= maxBytes) return out
  }
  throw new LinkToolError('too_big', 'the video is too long to send')
}

// Makes the tool. `load`, `exec` and `lookup` are only for tests.
//
// How to call:
//   const browser = createBrowserReader()
//   const post = await browser.read('https://www.tiktok.com/@a/photo/123', { signal })
//   // { caption, images: [{ mime: 'image/jpeg', data: '<base64>' }], video: null, total: 7 }
//   // or, for a post with a video: { caption, images: [], video: { mime: 'video/mp4', data: '<base64>' }, total: null }
//
// `signal` is an AbortSignal that closes the browser when it fires (the reader's deadline for gathering).
//
// Throws a LinkToolError with a fixed sentence when Chrome or Playwright is missing, the link is not a post on a supported
// site, the page leads off the supported sites, the page cannot be opened or was stopped, or it holds no slide and no video.
// Reads one post at a time.
export function createBrowserReader({
  load = loadPlaywright,
  chrome = process.env.LINK_READER_CHROME || CHROME_PATHS.find((p) => existsSync(p)),
  exec: baseExec = null,
  lookup = dnsLookup,
} = {}) {
  let queue = Promise.resolve()
  // ffmpeg and sips run without the server's secrets, and stop with the read.
  const execFor = (signal) => (cmd, args, options = {}) =>
    baseExec ? baseExec(cmd, args, { ...options, env: toolEnvironment(process.env), signal }) : run(cmd, args, { ...options, env: toolEnvironment(process.env), signal })

  async function open(url, dir, signal) {
    let library
    try { library = load() } catch (err) {
      throw new LinkToolError('not_installed', 'Playwright is not installed (run pnpm install in the Jio folder)', err.message)
    }
    const { chromium } = library
    if (!chrome) throw new LinkToolError('not_installed', 'Google Chrome was not found')
    const exec = execFor(signal)
    const start = new URL(url)
    if (/instagram\.com$/i.test(start.hostname)) start.search = '' // ?img_index=2 would start the post at slide 2
    if (signal?.aborted) throw new LinkToolError('timed_out', 'The page took too long and was stopped.')
    const browser = await chromium.launch({ headless: true, executablePath: chrome, chromiumSandbox: true, env: toolEnvironment(process.env) })
    const stop = () => { browser.close().catch(() => {}) }
    signal?.addEventListener('abort', stop, { once: true })
    try {
      const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, userAgent: PHONE, locale: 'en-SG', serviceWorkers: 'block', acceptDownloads: false })
      // Nothing leaves the browser for an address that is not a supported site or one of its media hosts, over https. A
      // navigation that is refused ends the read, even when the page carries on without it.
      let blockedNavigation = false
      await ctx.route('**/*', async (route) => {
        const request = route.request()
        if (allowedBrowserUrl(request.url()) || inert(request.url())) return route.continue()
        if (request.isNavigationRequest()) blockedNavigation = true
        return route.abort('blockedbyclient')
      })
      const page = await ctx.newPage()
      const blockedSite = () => new LinkToolError('blocked_site', 'The link leads to a page that is not supported.')
      // A post with a video plays it from a file on the network: note its address as it goes by, if it is allowed.
      let videoUrl = null
      page.on('response', (r) => {
        if (!videoUrl && r.status() < 400 && /^video\/(mp4|webm|quicktime)/i.test(r.headers()['content-type'] || '') && allowedBrowserUrl(r.url())) videoUrl = r.url()
      })
      let openError = null
      try { await page.goto(start.href, { waitUntil: 'domcontentloaded', timeout: OPEN_TIMEOUT_MS }) } catch (err) { openError = err }
      // After any redirect (a short link) the page must still be one of the supported sites, before anything is read from it.
      if (blockedNavigation) throw blockedSite()
      if (openError) throw openError
      if (!onSupportedSite(page.url())) throw blockedSite()
      await page.waitForTimeout(4000)
      if (blockedNavigation || !onSupportedSite(page.url())) throw blockedSite()
      // A login or captcha page is not something this tool completes: it stops there and says so.
      if (/captcha|\/login|website-login/i.test(new URL(page.url()).pathname)) throw new LinkToolError('login_required', 'The site asked for a login or a captcha, which cannot be completed.')
      // TikTok asks "View this post on TikTok?" on top of the post: a plain "Not now" closes it.
      await page.getByText('Not now', { exact: true }).click({ timeout: 1500 }).catch(() => {})

      const caption = await page.evaluate(() => (document.querySelector('meta[property="og:description"]')?.content || '') + '\n' + (document.querySelector('meta[name="description"]')?.content || '') + '\n' + (document.title || ''))
      const total = await page.evaluate(() => {
        const t = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /^\d+\s*\/\s*\d+$/.test(e.textContent.trim()))
        return t ? Number(t.textContent.split('/')[1]) : null
      })

      // Collect the slides in order. TikTok has every slide on the page; Instagram loads a few at a time, so step through.
      const seen = new Map()
      const keyOf = (src) => { try { const u = new URL(src); return u.origin + u.pathname } catch { return null } }
      const note = (src) => { const key = keyOf(src); if (key && !seen.has(key) && seen.size < MAX_SLIDES) seen.set(key, src) }
      let quiet = 0
      for (let step = 0; step < 14 && seen.size < MAX_SLIDES && quiet < 2; step++) {
        const before = seen.size
        for (const s of await page.evaluate(slidesOnScreen)) note(s.src)
        quiet = seen.size === before ? quiet + 1 : 0
        if (seen.size >= (total ?? Infinity)) break
        // Move on one slide. A plain click can be blocked by a login popup, so the page's own "Next" button is pressed with a
        // script. With no such button, scroll the row of slides along by one phone width.
        const pressed = await page.evaluate(() => { const b = document.querySelector('button[aria-label="Next"]'); if (b) b.click(); return !!b })
        if (!pressed) {
          const moved = await page.evaluate(() => {
            const first = [...document.images].find((i) => i.naturalHeight > 600 && i.getBoundingClientRect().width >= 300)
            for (let e = first?.parentElement; e; e = e.parentElement) {
              if (e.scrollWidth > e.clientWidth + 10) { const x = e.scrollLeft; e.scrollBy({ left: e.clientWidth, behavior: 'instant' }); return e.scrollLeft !== x }
            }
            return false
          })
          if (!moved) await page.keyboard.press('ArrowRight')
        }
        await page.waitForTimeout(900)
      }
      // A busy page sometimes shows nothing the first time: one more look.
      if (seen.size === 0 && !videoUrl) {
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(4000)
        for (const s of await page.evaluate(slidesOnScreen)) note(s.src)
      }
      if (blockedNavigation || !onSupportedSite(page.url())) throw blockedSite()

      // A post with slides is its slides: a photo post plays music from a file that looks like a video.
      let video = null
      if (videoUrl && seen.size < 2 && !/\/photo\//.test(page.url())) {
        const res = await fetchChecked(ctx, videoUrl, { referer: page.url(), timeout: 60000, lookup })
        if (res?.ok() && smallEnough(res, MAX_DOWNLOAD_BYTES)) {
          const body = await res.body()
          if (body.length <= MAX_DOWNLOAD_BYTES) {
            const raw = join(dir, 'post-video.mp4')
            writeFileSync(raw, body)
            try { video = { mime: 'video/mp4', data: readFileSync(await fitVideo(raw, MAX_VIDEO_BYTES, exec)).toString('base64') }; seen.clear() } catch { /* too long: the cover picture is used */ }
          }
        }
      }

      const images = []
      for (const src of seen.values()) {
        const res = await fetchChecked(ctx, src, { referer: page.url(), timeout: 20000, lookup })
        if (!res || !res.ok() || !smallEnough(res, MAX_IMAGE_DOWNLOAD_BYTES)) continue
        const raw = join(dir, `raw-${images.length + 1}`)
        const out = join(dir, `slide-${images.length + 1}.jpg`)
        writeFileSync(raw, await res.body())
        try { await shrink(raw, out, exec) } catch { continue } // a picture that cannot be read is skipped
        if (statSync(out).size <= MAX_IMAGE_BYTES) images.push({ mime: 'image/jpeg', data: readFileSync(out).toString('base64') })
      }
      return { caption: [...new Set(caption.split('\n').map((l) => l.trim()).filter(Boolean))].join('\n'), images, video, total }
    } finally {
      signal?.removeEventListener('abort', stop)
      await browser.close().catch(() => {})
    }
  }

  async function read(url, { signal } = {}) {
    const parsed = parseLink(url)
    if (!parsed.ok) throw new LinkToolError('refused', 'That is not a supported link: the browser opens only a single post on a supported site.')
    // Xiaohongshu needs the share token that comes with its link, or it sends a login page.
    const target = parsed.platform === 'xiaohongshu' ? parsed.original : parsed.url
    const turn = queue.then(async () => {
      if (signal?.aborted) throw new LinkToolError('timed_out', 'The page took too long and was stopped.')
      const dir = mkdtempSync(join(tmpdir(), 'jio-browser-'))
      try {
        const got = await open(target, dir, signal)
        if (got.images.length === 0 && !got.video) throw new LinkToolError('failed', 'The page showed no slides or video (it may need a login).')
        return got
      } catch (err) {
        if (err instanceof LinkToolError) throw err
        throw new LinkToolError(signal?.aborted ? 'timed_out' : 'failed', signal?.aborted ? 'The page took too long and was stopped.' : 'The page could not be opened in a browser.', err?.message)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
    queue = turn.catch(() => {})
    return turn
  }

  return { read }
}
