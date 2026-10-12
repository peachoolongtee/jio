import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

// Downloading a post's video with yt-dlp, for TikTok and Instagram. OFF by default.
//
// TikTok's and Instagram's terms do not allow downloading their videos, and the tool breaks whenever they change their
// pages. So it only runs when LINK_READER_YTDLP=1 is set, on a machine that has yt-dlp installed (brew install yt-dlp):
// for development and demos on a laptop, never on the deployed server. Without it, TikTok links are read from their
// caption alone, and Instagram and Xiaohongshu links cannot be read.
//
// Only addresses that parseLink() accepted ever get here, passed after "--" so they can never be read as an option.
// The video is read into memory and the download folder is deleted straight away.

export const MAX_VIDEO_BYTES = 18 * 1024 * 1024 // Gemini takes about 20 MB in one request, base64 included.
export const DOWNLOAD_TIMEOUT_MS = 90_000

const run = promisify(execFile)

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' }

// Makes the tool. `exec` is only for tests.
//
// How to call:
//   const tool = createYtDlp()
//   const post = await tool.download('https://www.tiktok.com/@a/video/123')
//   // { mime: 'video/mp4', data: '<base64>', bytes: 1048576, caption: '...', postDate: '2026-10-03' }
//
// Throws an Error with a plain reason when yt-dlp is missing, fails, or the video is over MAX_VIDEO_BYTES.
export function createYtDlp({ exec = run, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  async function download(url) {
    const dir = mkdtempSync(join(tmpdir(), 'jio-link-'))
    try {
      try {
        await exec(
          'yt-dlp',
          ['--no-playlist', '--max-filesize', '100M', '-f', 'b[ext=mp4]/b', '--write-info-json', '-o', join(dir, 'video.%(ext)s'), '--', url],
          { timeout: timeoutMs },
        )
      } catch (err) {
        throw new Error(err.code === 'ENOENT' ? 'yt-dlp is not installed' : 'yt-dlp could not download the video')
      }
      const names = readdirSync(dir)
      const video = names.find((n) => !n.endsWith('.json'))
      if (!video) throw new Error('yt-dlp saved no video')
      const ext = video.slice(video.lastIndexOf('.')).toLowerCase()
      const mime = MIME[ext]
      if (!mime) throw new Error('the video is in a format Gemini cannot read')
      const bytes = statSync(join(dir, video)).size
      if (bytes > MAX_VIDEO_BYTES) throw new Error(`the video is ${(bytes / 1048576).toFixed(0)} MB, over the ${MAX_VIDEO_BYTES / 1048576} MB limit`)
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
