// Profile photos, shared by sign-up and Edit profile. A chosen picture is cut to a square from its middle and shrunk to
// 160 by 160 pixels, as a JPEG data URL, small enough to keep in local storage with the rest of the account. It stays in
// this browser: it is never uploaded.

export const PHOTO_SIZE = 160

// The picture in `file` as a small square JPEG data URL. Rejects with a sentence fit to show when the file is not an
// image or cannot be opened.
// How to call: const photo = await shrinkPhoto(input.files[0])   -> 'data:image/jpeg;base64,...'
export function shrinkPhoto(file, size = PHOTO_SIZE) {
  return new Promise((resolve, reject) => {
    if (!file?.type?.startsWith('image/')) {
      reject(new Error('Choose an image file.'))
      return
    }
    const unreadable = () => reject(new Error('That picture could not be opened. Try another one.'))
    const reader = new FileReader()
    reader.onerror = unreadable
    reader.onload = () => {
      const img = new Image()
      img.onerror = unreadable
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const scale = Math.max(size / img.width, size / img.height)
        const w = img.width * scale
        const h = img.height * scale
        canvas.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.8))
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}
