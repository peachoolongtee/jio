import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { onSupportedSite, parseLink } from './link-source.js'

// Opening a post in Chrome the way a person would, for the posts a download tool cannot get: TikTok photo posts (slides),
// Instagram photos and carousels, and Xiaohongshu. OFF by default.
//
// It opens the post in a phone-sized headless Chrome (no login, nothing typed, no cookies kept), reads the caption, and
// saves each slide as a picture (or the video, when the post has one), so Gemini can read the text on the slides.
//
// Opening these pages with automation goes against TikTok's, Instagram's and Xiaohongshu's terms, and it stops working
// whenever they change a page. So it only runs when LINK_READER_BROWSER=1 is set, on a machine with Google Chrome
// installed: for development and demos on a laptop, never on the deployed server (index.js ignores it in production).
//
// Safety: only addresses parseLink() accepted are opened, the page is checked again after every redirect, only https
// pictures from a public host are fetched, nothing is typed into any page, and one post is opened at a time.
// Needs Playwright: `playwright-core` if it is installed, else the copy the frontend's tests already use.

const run = promisify(execFile)

export const MAX_SLIDES = 12
export const MAX_IMAGE_BYTES = 1_500_000 // After shrinking: a slide is read fine at 1280 px.
export const MAX_VIDEO_BYTES = 17 * 1024 * 1024
export const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024
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

// A picture address that is safe to fetch: https, a name (not an IP address or localhost).
function publicHttps(src) {
  try {
    const u = new URL(src)
    return u.protocol === 'https:' && !/^[\d.]+$|^\[|^localhost$|\.local$|\.internal$/i.test(u.hostname)
  } catch { return false }
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
  throw new Error('the video is too long to send')
}

// Makes the tool. `load` and `exec` are only for tests.
//
// How to call:
//   const browser = createBrowserReader()
//   const post = await browser.read('https://www.tiktok.com/@a/photo/123')
//   // { caption, images: [{ mime: 'image/jpeg', data: '<base64>' }], video: null, total: 7 }
//   // or, for a post with a video: { caption, images: [], video: { mime: 'video/mp4', data: '<base64>' }, total: null }
//
// Throws an Error with a plain reason when Chrome or Playwright is missing, the page cannot be opened, or it holds no slide
// and no video. Reads one post at a time.
export function createBrowserReader({ load = loadPlaywright, chrome = process.env.LINK_READER_CHROME || CHROME_PATHS.find((p) => existsSync(p)), exec = run } = {}) {
  let queue = Promise.resolve()

  async function open(url, dir) {
    const { chromium } = load()
    if (!chrome) throw new Error('Google Chrome was not found')
    const start = new URL(url)
    if (/instagram\.com$/i.test(start.hostname)) start.search = '' // ?img_index=2 would start the post at slide 2
    const browser = await chromium.launch({ headless: true, executablePath: chrome })
    try {
      const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, userAgent: PHONE, locale: 'en-SG' })
      const page = await ctx.newPage()
      // A post with a video plays it from a file on the network: note its address as it goes by.
      let videoUrl = null
      page.on('response', (r) => {
        if (!videoUrl && r.status() < 400 && /^video\/(mp4|webm|quicktime)/i.test(r.headers()['content-type'] || '')) videoUrl = r.url()
      })
      await page.goto(start.href, { waitUntil: 'domcontentloaded', timeout: OPEN_TIMEOUT_MS })
      await page.waitForTimeout(4000)
      // After any redirect (a short link) the page must still be one of the supported sites.
      if (!onSupportedSite(page.url())) throw new Error('the link leads to a page that is not supported')
      // A login or captcha page is not something this tool completes: it stops there and says so.
      if (/captcha|\/login|website-login/i.test(new URL(page.url()).pathname)) throw new Error('the site asked for a login or a captcha, which cannot be completed')
      // TikTok asks "View this post on TikTok?" on top of the post: a plain "Not now" closes it.
      await page.getByText('Not now', { exact: true }).click({ timeout: 1500 }).catch(() => {})

      const caption = await page.evaluate(() => (document.querySelector('meta[property="og:description"]')?.content || '') + '\n' + (document.querySelector('meta[name="description"]')?.content || '') + '\n' + (document.title || ''))
      const total = await page.evaluate(() => {
        const t = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /^\d+\s*\/\s*\d+$/.test(e.textContent.trim()))
        return t ? Number(t.textContent.split('/')[1]) : null
      })

      // Collect the slides in order. TikTok has every slide on the page; Instagram loads a few at a time, so step through.
      const seen = new Map()
      const keyOf = (src) => { const u = new URL(src); return u.origin + u.pathname }
      let quiet = 0
      for (let step = 0; step < 14 && seen.size < MAX_SLIDES && quiet < 2; step++) {
        const before = seen.size
        for (const s of await page.evaluate(slidesOnScreen)) if (!seen.has(keyOf(s.src)) && seen.size < MAX_SLIDES) seen.set(keyOf(s.src), s.src)
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
        for (const s of await page.evaluate(slidesOnScreen)) if (seen.size < MAX_SLIDES) seen.set(keyOf(s.src), s.src)
      }

      // A post with slides is its slides: a photo post plays music from a file that looks like a video.
      let video = null
      if (videoUrl && seen.size < 2 && !/\/photo\//.test(page.url())) {
        const res = await ctx.request.get(videoUrl, { headers: { referer: page.url() }, timeout: 60000 }).catch(() => null)
        if (res?.ok()) {
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
        if (!publicHttps(src)) continue
        const res = await ctx.request.get(src, { headers: { referer: page.url() }, timeout: 20000 }).catch(() => null)
        if (!res || !res.ok()) continue
        const raw = join(dir, `raw-${images.length + 1}`)
        const out = join(dir, `slide-${images.length + 1}.jpg`)
        writeFileSync(raw, await res.body())
        try { await shrink(raw, out, exec) } catch { continue } // a picture that cannot be read is skipped
        if (statSync(out).size <= MAX_IMAGE_BYTES) images.push({ mime: 'image/jpeg', data: readFileSync(out).toString('base64') })
      }
      return { caption: [...new Set(caption.split('\n').map((l) => l.trim()).filter(Boolean))].join('\n'), images, video, total }
    } finally {
      await browser.close()
    }
  }

  async function read(url) {
    const parsed = parseLink(url)
    if (!parsed.ok) throw new Error('not a supported link')
    // Xiaohongshu needs the share token that comes with its link, or it sends a login page.
    const target = parsed.platform === 'xiaohongshu' ? new URL(url.trim()).href : parsed.url
    const turn = queue.then(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'jio-browser-'))
      try {
        const got = await open(target, dir)
        if (got.images.length === 0 && !got.video) throw new Error('the page showed no slides or video (it may need a login)')
        return got
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
    queue = turn.catch(() => {})
    return turn
  }

  return { read }
}
