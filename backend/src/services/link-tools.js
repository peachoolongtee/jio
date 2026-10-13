import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { LinkToolError, parseLink, toolEnvironment } from './link-source.js'

// Downloading a post's video with yt-dlp, for TikTok and Instagram. OFF by default.
//
// TikTok's and Instagram's terms do not allow downloading their videos, and the tool breaks whenever they change their
// pages. So it only runs when LINK_READER_YTDLP=1 is set and NODE_ENV=development, on a machine that has yt-dlp installed
// (brew install yt-dlp): for development and demos on a laptop, never on the deployed server. Without it, TikTok links are
// read from their caption alone, and Instagram and Xiaohongshu links cannot be read.
//
// Safety:
//   - Only a single post on TikTok or Instagram (or a short link to one) is downloaded. parseLink() decides: a profile, a
//     feed, a playlist or anything that does not start with https:// is refused before yt-dlp runs. The address handed on is
//     the one parseLink() rebuilt, passed after "--" so it can never be read as an option.
//   - yt-dlp is told to take one video of one post and stop (--no-playlist, --playlist-items 1, --max-downloads 1), to ignore
//     any configuration file on the machine, and to give up on a file over 100 MB.
//   - It is started with a minimal environment (toolEnvironment), never the server's keys, and it is stopped at the deadline.
//   - What it says is never passed on: a failure is a LinkToolError with a fixed sentence, and its own message is only kept
//     as `detail` for the server's log.
// The video is read into memory and the download folder is deleted straight away.

export const MAX_VIDEO_BYTES = 18 * 1024 * 1024 // Gemini takes about 20 MB in one request, base64 included.
export const DOWNLOAD_TIMEOUT_MS = 50_000

const run = promisify(execFile)

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' }

// yt-dlp exits with 101 when it stops because --max-downloads was reached, which for a download of one video is how it
// finishes. It is not a failure.
const MAX_DOWNLOADS_REACHED = 101

// Makes the tool. `exec` is only for tests.
//
// How to call:
//   const tool = createYtDlp()
//   const post = await tool.download('https://www.tiktok.com/@a/video/123', { signal })
//   // { mime: 'video/mp4', data: '<base64>', bytes: 1048576, caption: '...', postDate: '2026-10-03' }
//
// `signal` is an AbortSignal that stops yt-dlp when it fires (the reader's deadline for gathering).
//
// Throws a LinkToolError with a fixed sentence when the address is not a single post, yt-dlp is missing, fails or is stopped,
// or the video is over MAX_VIDEO_BYTES.
export function createYtDlp({ exec = run, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  async function download(url, { signal } = {}) {
    const parsed = parseLink(url)
    if (!parsed.ok || (parsed.platform !== 'tiktok' && parsed.platform !== 'instagram') || (!parsed.key && !parsed.short)) {
      throw new LinkToolError('refused', 'That address is not a single TikTok or Instagram post, so nothing was downloaded.')
    }
    const dir = mkdtempSync(join(tmpdir(), 'jio-link-'))
    try {
      try {
        await exec(
          'yt-dlp',
          [
            '--ignore-config', '--no-playlist', '--playlist-items', '1', '--max-downloads', '1', '--max-filesize', '100M',
            '--no-progress', '-f', 'b[ext=mp4]/b', '--write-info-json', '-o', join(dir, 'video.%(ext)s'), '--', parsed.url,
          ],
          { timeout: timeoutMs, env: toolEnvironment(process.env), signal },
        )
      } catch (err) {
        if (err.code === MAX_DOWNLOADS_REACHED) {
          // One video was downloaded and yt-dlp stopped as told: go on and read it.
        } else if (err.code === 'ENOENT') {
          throw new LinkToolError('not_installed', 'yt-dlp is not installed')
        } else if (err.name === 'AbortError' || err.killed) {
          throw new LinkToolError('timed_out', 'yt-dlp took too long and was stopped', err.message)
        } else {
          throw new LinkToolError('failed', 'yt-dlp could not download the video', err.message)
        }
      }
      const names = readdirSync(dir)
      const video = names.find((n) => !n.endsWith('.json'))
      if (!video) throw new LinkToolError('failed', 'yt-dlp saved no video')
      const ext = video.slice(video.lastIndexOf('.')).toLowerCase()
      const mime = MIME[ext]
      if (!mime) throw new LinkToolError('failed', 'the video is in a format Gemini cannot read', ext)
      const bytes = statSync(join(dir, video)).size
      if (bytes > MAX_VIDEO_BYTES) throw new LinkToolError('too_big', `the video is over the ${MAX_VIDEO_BYTES / 1048576} MB limit`)
      let caption = ''
      let postDate = ''
      const info = names.find((n) => n.endsWith('.info.json'))
      if (info) {
        try {
          const meta = JSON.parse(readFileSync(join(dir, info), 'utf8'))
          caption = String(meta.description || meta.title || '')
          if (/^\d{8}$/.test(meta.upload_date ?? '')) postDate = `${meta.upload_date.slice(0, 4)}-${meta.upload_date.slice(4, 6)}-${meta.upload_date.slice(6, 8)}`
          else if (Number.isFinite(meta.timestamp)) postDate = new Date((meta.timestamp + 8 * 3600) * 1000).toISOString().slice(0, 10)
        } catch { /* a post with unreadable details is still read from its video */ }
      }
      return { mime, data: readFileSync(join(dir, video)).toString('base64'), bytes, caption, postDate }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return { download }
}
