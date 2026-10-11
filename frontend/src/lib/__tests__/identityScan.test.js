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
// File -> why it may read HOST_ID, the constant that holds the sample person's id. The local account is the sample person,
// and the data layer says so in the four places pinned by the test below. A real account reaches none of them.
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

  it('keeps the data layer\'s reads of the sample person to the four places it needs', () => {
    const code = codeOf(readFileSync(join(SRC, 'lib/api.js'), 'utf8'))
    const uses = code.split('\n').filter((line) => AS_CONSTANT.test(line) && !line.startsWith('import '))
    expect(uses.map((line) => line.trim())).toEqual([
      'const seeded = (table, id, demo) => (id === HOST_ID && !demo ? 0 : table[id] ?? 0)',
      'id: HOST_ID,',
      "const taken = PEOPLE.some((p) => p.id !== HOST_ID && p.username === username)",
      'if (!isReal()) return PEOPLE.filter((p) => p.id !== (me() || HOST_ID)).map((p) => publicPerson(p.id))',
    ])
  })

  it('has the screens ask the account store, and the stores and helpers ask lib/currentUser.js', () => {
    const read = (path) => readFileSync(join(SRC, path), 'utf8')
    expect(read('stores/auth.js')).toContain("user.value?.id ?? ''")
    expect(read('stores/events.js')).toContain("from '@/lib/currentUser.js'")
    expect(read('stores/planner.js')).toContain("from '@/lib/currentUser.js'")
    expect(read('lib/reviewPick.js')).toContain("from './currentUser.js'")
    expect(read('lib/currentUser.js')).not.toMatch(/^import /m)
  })
})
