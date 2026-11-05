// No screen, store, component or helper holds the sample person's id as the signed-in person. Who is signed in comes from
// one place (lib/currentUser.js, and `auth.myId` in a component), so a real account's own id reaches every screen. This
// reads the source files and fails when the literal id, or the constant that holds it, turns up where it must not.
//
// Where it may be: lib/mock/ (the sample people themselves), components/dev/ and tour/ (the demo tools and the demo tour are
// made of the sample people), the tests, and the two places below that give a reason.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ALLOWED_DIRS = ['lib/mock/', 'components/dev/', 'tour/']
// File -> why it may name the sample person.
const ALLOWED_FILES = {
  // The design page draws sample sessions of the sample people, to show the components; it signs nobody in.
  'views/DesignSystemView.vue': 'sample data for the design page',
}
// File -> why it may read HOST_ID, the constant that holds the sample person's id. The local account is the sample person, and
// the data layer says so where it makes a local account, seeds the sample history, checks a username and lists sample people.
// Those are covered by behaviour tests (accounts.test.js, realAccountData.test.js, api.season.test.js), not by pinning lines.
const ALLOWED_CONSTANT_FILES = { 'lib/api.js': 'the local account and the sample history' }

const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'assets') continue
      walk(path)
    } else if (/\.(vue|js)$/.test(name)) {
      files.push(path)
    }
  }
}
walk(SRC)
const rel = (path) => relative(SRC, path).split('\\').join('/')
const inAllowedDir = (path) => ALLOWED_DIRS.some((dir) => rel(path).startsWith(dir))
const allowed = (path) => inAllowedDir(path) || rel(path) in ALLOWED_FILES
const allowedConstant = (path) => allowed(path) || rel(path) in ALLOWED_CONSTANT_FILES

// The code of a file with its comments taken out. `//` comments are cut where they begin, unless the `//` is inside a
// string or a web address (a quote or a colon before it); block and HTML comments are removed whole.
// How to call: codeOf("const a = 1 // 'ian'") -> 'const a = 1 '
function codeOf(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\w])\/\/.*$/, '$1'))
    .join('\n')
}

// The sample person's id as a string, as a property or a key, or the constant that holds it.
const AS_STRING = /(['"`])ian\1/
const AS_PROPERTY = /\.ian\b|\bian\s*:/
const AS_CONSTANT = /\bHOST_ID\b/
// A form field's example text is not an identity.
const PLACEHOLDER = /placeholder="ian"/g

describe('the signed-in person is never the sample person Ian in the source', () => {
  it('found the source files to read', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => rel(f) === 'lib/api.js')).toBe(true)
  })

  it('names the sample person, as a string or a key, only in the sample data, the demo tools, the tour and the design page', () => {
    const found = files
      .filter((path) => !allowed(path))
      .flatMap((path) => {
        const code = codeOf(readFileSync(path, 'utf8')).replace(PLACEHOLDER, '')
        return code.split('\n').flatMap((line, i) => (AS_STRING.test(line) || AS_PROPERTY.test(line) ? [`${rel(path)}:${i + 1}: ${line.trim()}`] : []))
      })
    expect(found).toEqual([])
  })

  it('reads the sample person\'s constant only where it belongs', () => {
    const found = files
      .filter((path) => !allowedConstant(path))
      .flatMap((path) => codeOf(readFileSync(path, 'utf8')).split('\n').flatMap((line, i) => (AS_CONSTANT.test(line) ? [`${rel(path)}:${i + 1}: ${line.trim()}`] : [])))
    expect(found).toEqual([])
  })
})
