// A real account's saved places: the same calls the live table answers, on the stand-in for Supabase, which follows the migration's rules
// (db/migrations/20261104000000_jio_saved_places.sql). The rules themselves are tested on Postgres in db/tests/saved_places.sql.
import { describe, expect, it, vi } from 'vitest'
import { OTHER, PROFILE, boot, fakeSupabase } from './authFixture.js'

vi.setConfig({ testTimeout: 20000 })

const PLACE = { name: 'Next Door Cafe', nameEnglish: 'Next Door Cafe', categories: ['eat', 'drink'], tip: 'Try the paella', locationHint: 'Katong', googlePlaceId: 'g_one', postKey: 'tiktok:1', postUrl: 'https://www.tiktok.com/@a/video/1' }

describe('a real account\'s saved places', () => {
  it('are kept in the table, with every field, and read back newest first', async () => {
    const fake = fakeSupabase({ uuidIds: true })
    const { api } = await boot(fake)
    await api.signUp(PROFILE)
    expect(await api.listSavedPlaces()).toEqual([])
    const [row] = await api.savePlaces([PLACE])
    expect(row).toMatchObject({ ...PLACE })
    expect(row.id).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await api.savePlaces([{ ...PLACE, name: 'Goliath Outdoor', nameEnglish: null, googlePlaceId: null, categories: ['shop'] }])
    const list = await api.listSavedPlaces()
    expect(list.map((p) => p.name)).toEqual(['Goliath Outdoor', 'Next Door Cafe'])
    expect(list[1].categories).toEqual(['eat', 'drink'])
    // Nothing of theirs went to this browser's own save.
    expect(JSON.stringify(api.storage.store)).not.toContain('Try the paella')
  })

  it('leaves a place already kept as it is, with no error', async () => {
    const { api } = await boot(fakeSupabase({ uuidIds: true }))
    await api.signUp(PROFILE)
    await api.savePlaces([PLACE])
    expect(await api.savePlaces([{ ...PLACE, name: 'Same id' }])).toEqual([])
    expect(await api.listSavedPlaces()).toHaveLength(1)
  })

  it('are removed for good', async () => {
    const { api } = await boot(fakeSupabase({ uuidIds: true }))
    await api.signUp(PROFILE)
    const [row] = await api.savePlaces([PLACE])
    await api.removeSavedPlace(row.id)
    expect(await api.listSavedPlaces()).toEqual([])
  })

  it('are not seen by anyone else', async () => {
    const fake = fakeSupabase({ uuidIds: true })
    const first = await boot(fake)
    await first.api.signUp(PROFILE)
    await first.api.savePlaces([PLACE])
    await first.api.signOut()
    const second = await boot(fake)
    await second.api.signUp(OTHER)
    expect(await second.api.listSavedPlaces()).toEqual([])
  })

  it('say in words what went wrong, and never show a raw error', async () => {
    const fake = fakeSupabase({ uuidIds: true })
    const { api, auth } = await boot(fake)
    await api.signUp(PROFILE)
    const answer = (result) => ({ select: () => ({ order: async () => result }) })
    const real = auth.dataClient()
    // A client that cannot even make the request.
    auth.useClient({ ...real, auth: real.auth, from: () => ({ select: () => ({}) }) })
    await expect(api.listSavedPlaces()).rejects.toThrow('Your saved places could not be reached. Try again.')
    // A table the project does not have yet.
    auth.useClient({ ...real, auth: real.auth, from: () => answer({ data: null, error: { code: 'PGRST205', message: 'not found' } }) })
    await expect(api.listSavedPlaces()).rejects.toThrow('Saved places are not available yet.')
  })
})
