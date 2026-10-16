// Profile photos, shared by sign-up and Edit profile. A chosen picture is cut to a square from its middle and shrunk to
// 160 by 160 pixels, as a JPEG data URL, small enough to keep in local storage with the rest of the account. It stays in
// this browser: it is never uploaded.

export const PHOTO_SIZE = 160
// The largest file that is read at all. A bigger one could use up the browser's memory when it is decoded.
export const PHOTO_MAX_BYTES = 15 * 1024 * 1024

// The picture in `file` as a small square JPEG data URL. Rejects with a sentence fit to show when the file is not an
// image, is over 15 MB, or cannot be opened or drawn. A transparent picture is drawn on white, because a JPEG has no
// transparency and would otherwise come out black.
// How to call: const photo = await shrinkPhoto(input.files[0])   -> 'data:image/jpeg;base64,...'
export function shrinkPhoto(file, size = PHOTO_SIZE) {
  return new Promise((resolve, reject) => {
    if (!file?.type?.startsWith('image/')) {
      reject(new Error('Choose an image file.'))
      return
    }
    if (file.size > PHOTO_MAX_BYTES) {
      reject(new Error('That picture is too large. Choose one under 15 MB.'))
      return
    }
    const unreadable = () => reject(new Error('That picture could not be opened. Try another one.'))
    const reader = new FileReader()
    reader.onerror = unreadable
    reader.onload = () => {
      const img = new Image()
      img.onerror = unreadable
      img.onload = () => {
        // Anything the browser throws while drawing (no 2D canvas, a canvas that will not export) is an unreadable picture,
        // not a promise that never answers.
        try {
          if (!(img.width > 0) || !(img.height > 0)) {
            unreadable()
            return
          }
          const canvas = document.createElement('canvas')
          canvas.width = size
          canvas.height = size
          const context = canvas.getContext('2d')
          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, size, size)
          const scale = Math.max(size / img.width, size / img.height)
          const w = img.width * scale
          const h = img.height * scale
          context.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
          resolve(canvas.toDataURL('image/jpeg', 0.8))
        } catch {
          unreadable()
        }
      }
      img.src = reader.result
    }
    try {
      reader.readAsDataURL(file)
    } catch {
      unreadable()
    }
  })
}
