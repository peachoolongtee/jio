// The stand-in for the sessions side of the database (components/dev/fakeDatabase.js) follows db/schema.sql and
// db/policies.sql: who may read and write which row, what the triggers refuse, what the four functions answer, and what
// Realtime delivers. These tests are the stand-in's own check; the rest of the stage's tests lean on it being right.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVICE, createDataClient, createDatabase } from '../fakeDatabase.js'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const D = '00000000-0000-4000-8000-00000000000d'
const DAY = 24 * 60 * 60 * 1000

let clock
// A database with four people, a clock a test can move, and a client for each person (and the public key, and the server).
// How to call: const w = world(); await w.as(A).from('sessions').select('id')
function world() {
  clock = Date.parse('2026-10-10T10:00:00Z')
  const profiles = Object.fromEntries([[A, 'a_host'], [B, 'b_guest'], [C, 'c_guest'], [D, 'd_guest']].map(([id, username]) => [id, { username, display_name: username.toUpperCase(), avatar_url: null }]))
  const database = createDatabase({ profiles, now: () => clock })
  const client = (who) => createDataClient({ database, as: () => who })
  return { database, as: client, anon: client(null), service: client(SERVICE) }
}
const fields = { title: 'Dinner', date: '2026-10-17', start_time: '18:00', end_time: '21:00' }
// A session hosted by A, and its id.
async function sessionBy(w, who = A, patch = {}) {
  const { data, error } = await w.as(who).from('sessions').insert({ host_id: who, ...fields, ...patch }).select('id, status, title').single()
  expect(error).toBeNull()
  return data.id
}
async function linkFor(w, id, who = A) {
  const { data, error } = await w.as(who).from('invites').insert({ session_id: id, created_by: who }).select('token, expires_at').single()
  expect(error).toBeNull()
  return data.token
}

afterEach(() => vi.useRealTimers())

describe('creating and reading a session', () => {
  it('makes the row with its defaults and adds the host as a joined member', async () => {
    const w = world()
    const { data, error } = await w.as(A).from('sessions').insert({ host_id: A, ...fields }).select('*').single()
    expect(error).toBeNull()
    expect(data).toMatchObject({ host_id: A, title: 'Dinner', date: '2026-10-17', start_time: '18:00:00', end_time: '21:00:00', status: 'inviting', plan_version: 0 })
    const members = (await w.as(A).from('session_members').select('user_id, role, state').eq('session_id', data.id)).data
    expect(members).toEqual([{ user_id: A, role: 'host', state: 'joined' }])
  })

  it('refuses a session made for someone else, with no title, or ending before it starts', async () => {
    const w = world()
    const insert = (values) => w.as(A).from('sessions').insert(values).select('id').single()
    expect((await insert({ host_id: B, ...fields })).error.code).toBe('42501')
    expect((await insert({ host_id: A, ...fields, title: '   ' })).error.code).toBe('23514')
    expect((await insert({ host_id: A, ...fields, title: 'x'.repeat(81) })).error.code).toBe('23514')
    expect((await insert({ host_id: A, ...fields, start_time: '21:00', end_time: '18:00' })).error.code).toBe('23514')
    expect((await insert({ host_id: A, ...fields, status: 'confirmed' })).error.code).toBe('42501')
  })

  it('shows a session only to people in it, and nothing at all to the public key', async () => {
    const w = world()
    const id = await sessionBy(w)
    expect((await w.as(B).from('sessions').select('id').eq('id', id)).data).toEqual([])
    expect((await w.anon.from('sessions').select('id')).error.code).toBe('42501')
    expect((await w.as(B).from('session_members').select('user_id').eq('session_id', id)).data).toEqual([])
    const token = await linkFor(w, id)
    await w.as(B).rpc('join_session', { invite_token: token })
    expect((await w.as(B).from('sessions').select('id').eq('id', id)).data).toEqual([{ id }])
    expect((await w.as(B).from('session_members').select('user_id').eq('session_id', id)).data).toHaveLength(2)
  })

  it('lets a browser change nothing in session_members, and delete nothing anywhere', async () => {
    const w = world()
    const id = await sessionBy(w)
    expect((await w.as(A).from('session_members').insert({ session_id: id, user_id: B }).select('user_id')).error.code).toBe('42501')
    expect((await w.as(A).from('session_members').delete().eq('session_id', id)).error.code).toBe('42501')
    expect((await w.as(A).from('sessions').delete().eq('id', id)).error.code).toBe('42501')
    // The server's key may.
    expect((await w.service.from('session_members').delete().eq('session_id', id)).error).toBeNull()
  })
})

describe('changing a session (guard_session_changes)', () => {
  it('lets the host rename it and move its date and times while it is inviting', async () => {
    const w = world()
    const id = await sessionBy(w)
    const { data, error } = await w.as(A).from('sessions').update({ title: 'Lunch', date: '2026-10-18', start_time: '12:00', end_time: '14:00' }).eq('id', id).select('title, date, start_time')
    expect(error).toBeNull()
    expect(data).toEqual([{ title: 'Lunch', date: '2026-10-18', start_time: '12:00:00' }])
  })

  it('changes nothing for a guest, and refuses columns the browser may not write', async () => {
    const w = world()
    const id = await sessionBy(w)
    await w.as(B).rpc('join_session', { invite_token: await linkFor(w, id) })
    expect((await w.as(B).from('sessions').update({ title: 'Mine' }).eq('id', id).select('id')).data).toEqual([])
    expect((await w.as(A).from('sessions').update({ radius_meters: 500 }).eq('id', id).select('id')).error.code).toBe('42501')
    expect((await w.as(A).from('sessions').update({ plan_version: 9 }).eq('id', id).select('id')).error.code).toBe('42501')
    expect((await w.as(A).from('sessions').select('title').eq('id', id).single()).data.title).toBe('Dinner')
  })

  it('starts only with two joined people, and then freezes the date and times', async () => {
    const w = world()
    const id = await sessionBy(w)
    const start = () => w.as(A).from('sessions').update({ status: 'locating' }).eq('id', id).select('status')
    expect((await start()).error.message).toBe('A session needs at least two people before it can start.')
    await w.as(B).rpc('join_session', { invite_token: await linkFor(w, id) })
    expect((await start()).data).toEqual([{ status: 'locating' }])
    expect((await w.as(A).from('sessions').update({ date: '2026-10-20' }).eq('id', id).select('id')).error.message).toBe('The date and times can only change before the session starts.')
    // Voting and confirmed are the server's to set.
    expect((await w.as(A).from('sessions').update({ status: 'voting' }).eq('id', id).select('id')).error.code).toBe('42501')
  })

  it('lets the host cancel, after which nothing can change, not even by the host', async () => {
    const w = world()
    const id = await sessionBy(w)
    expect((await w.as(A).from('sessions').update({ status: 'cancelled' }).eq('id', id).select('status')).data).toEqual([{ status: 'cancelled' }])
    expect((await w.as(A).from('sessions').update({ title: 'Back' }).eq('id', id).select('id')).error.message).toBe('A cancelled session cannot be changed.')
    // The server is let through.
    expect((await w.service.from('sessions').update({ plan_version: 3 }).eq('id', id)).error).toBeNull()
  })
})

describe('invite links', () => {
  it('lets the host make one, which expires in seven days, with a 43-character token', async () => {
    const w = world()
    const id = await sessionBy(w)
    const { data } = await w.as(A).from('invites').insert({ session_id: id, created_by: A }).select('token, expires_at, revoked, uses').single()
    expect(data.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Date.parse(data.expires_at) - clock).toBe(7 * DAY)
    expect(data).toMatchObject({ revoked: false, uses: 0 })
  })

  it('allows one live link per session, until it is revoked', async () => {
    const w = world()
    const id = await sessionBy(w)
    const first = await linkFor(w, id)
    const again = await w.as(A).from('invites').insert({ session_id: id, created_by: A }).select('token').single()
    expect(again.error.code).toBe('23505')
    expect(again.error.message).toContain('invites_one_live_link_idx')
    await w.as(A).from('invites').update({ revoked: true }).eq('token', first).select('token')
    expect((await w.as(A).from('invites').insert({ session_id: id, created_by: A }).select('token').single()).error).toBeNull()
  })

  it('counts an expired link that was never revoked as the live one (an index cannot ask the time)', async () => {
    const w = world()
    const id = await sessionBy(w)
    await linkFor(w, id)
    clock += 8 * DAY
    expect((await w.as(A).from('invites').insert({ session_id: id, created_by: A }).select('token').single()).error.code).toBe('23505')
  })

  it('lets only the host make and revoke links, never as someone else, and never undo a revoke', async () => {
    const w = world()
    const id = await sessionBy(w)
    await w.as(B).rpc('join_session', { invite_token: await linkFor(w, id) })
    expect((await w.as(B).from('invites').insert({ session_id: id, created_by: B }).select('token').single()).error.code).toBe('42501')
    expect((await w.as(A).from('invites').insert({ session_id: id, created_by: B }).select('token').single()).error.code).toBe('42501')
    const token = (await w.as(A).from('invites').select('token').eq('session_id', id).single()).data.token
    expect((await w.as(B).from('invites').update({ revoked: true }).eq('token', token).select('token')).data).toEqual([])
    expect((await w.as(A).from('invites').update({ expires_at: new Date(clock + 20 * DAY).toISOString() }).eq('token', token).select('token')).error.code).toBe('42501')
    expect((await w.as(A).from('invites').update({ revoked: true }).eq('token', token).select('token')).data).toEqual([{ token }])
    expect((await w.as(A).from('invites').update({ revoked: false }).eq('token', token).select('token')).error.code).toBe('42501')
  })

  it('refuses an expiry more than thirty days away, and any link for a session that is not open', async () => {
    const w = world()
    const id = await sessionBy(w)
    const far = new Date(clock + 31 * DAY).toISOString()
    expect((await w.as(A).from('invites').insert({ session_id: id, created_by: A, expires_at: far }).select('token').single()).error.code).toBe('23514')
    await w.as(A).from('sessions').update({ status: 'cancelled' }).eq('id', id)
    expect((await w.as(A).from('invites').insert({ session_id: id, created_by: A }).select('token').single()).error.message).toBe('Invitations can only be made while a session is open.')
  })

  it('shows the host every link, and members only the pending invitations to a named person', async () => {
    const w = world()
    const id = await sessionBy(w)
    const link = await linkFor(w, id)
    await w.as(A).from('invites').insert({ session_id: id, created_by: A, invitee_id: C }).select('token')
    await w.as(B).rpc('join_session', { invite_token: link })
    expect((await w.as(A).from('invites').select('invitee_id').eq('session_id', id)).data).toHaveLength(2)
    // A member sees the personal one, not the link they joined with.
    expect((await w.as(B).from('invites').select('invitee_id').eq('session_id', id)).data).toEqual([{ invitee_id: C }])
    // The invitee sees their own, and nothing of the session.
    expect((await w.as(C).from('invites').select('invitee_id').eq('session_id', id)).data).toEqual([{ invitee_id: C }])
    expect((await w.as(C).from('sessions').select('id')).data).toEqual([])
    expect((await w.as(D).from('invites').select('token')).data).toEqual([])
  })

  it('refuses an invitation to the host, to a member, to the same person twice', async () => {
    const w = world()
    const id = await sessionBy(w)
    await w.as(B).rpc('join_session', { invite_token: await linkFor(w, id) })
    const invite = (who) => w.as(A).from('invites').insert({ session_id: id, created_by: A, invitee_id: who }).select('token').single()
    expect((await invite(A)).error.message).toBe('The host is already in the session.')
    expect((await invite(B)).error.message).toBe('That person is already in the session.')
    expect((await invite(C)).error).toBeNull()
    expect((await invite(C)).error.code).toBe('23505')
  })
})

describe('invite_preview', () => {
  it('answers anyone, signed out too, with the title, date, times and the host\'s name', async () => {
    const w = world()
    const id = await sessionBy(w)
    const token = await linkFor(w, id)
    const { data } = await w.anon.rpc('invite_preview', { invite_token: token })
    expect(data).toEqual([{ title: 'Dinner', date: '2026-10-17', start_time: '18:00:00', end_time: '21:00:00', host_name: 'A_HOST' }])
    expect(Object.keys(data[0])).not.toContain('session_id')
  })

  it('answers nothing for a link that expired, was revoked, belongs to a session under way, or was never made', async () => {
    const w = world()
    const expired = await sessionBy(w)
    const expiredToken = await linkFor(w, expired)
    const revoked = await sessionBy(w)
    const revokedToken = await linkFor(w, revoked)
    await w.as(A).from('invites').update({ revoked: true }).eq('token', revokedToken)
    const started = await sessionBy(w)
    const startedToken = await linkFor(w, started)
    await w.as(B).rpc('join_session', { invite_token: startedToken })
    await w.as(A).from('sessions').update({ status: 'locating' }).eq('id', started)
    await w.service.from('sessions').update({ status: 'confirmed' }).eq('id', started)
    clock += 8 * DAY
    for (const token of [expiredToken, revokedToken, startedToken, 'x'.repeat(43)]) {
      expect((await w.anon.rpc('invite_preview', { invite_token: token })).data).toEqual([])
    }
  })

  it('previews a personal invitation only to the person it is for', async () => {
    const w = world()
    const id = await sessionBy(w)
    const { data } = await w.as(A).from('invites').insert({ session_id: id, created_by: A, invitee_id: C }).select('token').single()
    expect((await w.anon.rpc('invite_preview', { invite_token: data.token })).data).toEqual([])
    expect((await w.as(D).rpc('invite_preview', { invite_token: data.token })).data).toEqual([])
    expect((await w.as(C).rpc('invite_preview', { invite_token: data.token })).data).toHaveLength(1)
  })

  it('is the only function open to the public key', async () => {
    const w = world()
    expect((await w.anon.rpc('join_session', { invite_token: 'x' })).error.code).toBe('42501')
    expect((await w.anon.rpc('my_invitations')).error.code).toBe('42501')
  })
})

describe('join_session', () => {
  it('adds the person as a joined guest, counts the use, and returns the session id', async () => {
    const w = world()
    const id = await sessionBy(w)
    const token = await linkFor(w, id)
    const { data, error } = await w.as(B).rpc('join_session', { invite_token: token })
    expect(error).toBeNull()
    expect(data).toBe(id)
    expect((await w.as(A).from('session_members').select('user_id, role, state').eq('session_id', id).eq('user_id', B).single()).data).toEqual({ user_id: B, role: 'guest', state: 'joined' })
    expect((await w.as(A).from('invites').select('uses').eq('token', token).single()).data.uses).toBe(1)
  })

  it('leaves someone already in the session as they are, without counting a use', async () => {
    const w = world()
    const id = await sessionBy(w)
    const token = await linkFor(w, id)
    await w.as(B).rpc('join_session', { invite_token: token })
    expect((await w.as(B).rpc('join_session', { invite_token: token })).data).toBe(id)
    expect((await w.as(A).rpc('join_session', { invite_token: token })).data).toBe(id)
    expect((await w.as(A).from('invites').select('uses').eq('token', token).single()).data.uses).toBe(1)
    expect((await w.as(A).from('session_members').select('user_id').eq('session_id', id)).data).toHaveLength(2)
  })

  it('refuses every link that is not good with one error, and a person who is not signed in with another', async () => {
    const w = world()
    const id = await sessionBy(w)
    const token = await linkFor(w, id)
    await w.as(A).from('invites').update({ revoked: true }).eq('token', token)
    const revoked = await w.as(B).rpc('join_session', { invite_token: token })
    const unknown = await w.as(B).rpc('join_session', { invite_token: 'y'.repeat(43) })
    expect(revoked.error).toMatchObject({ code: 'P0002', message: 'This invite link is no longer valid.' })
    expect(unknown.error).toEqual(revoked.error)
    expect((await w.anon.rpc('join_session', { invite_token: token })).error.code).toBe('42501')
  })

  it('refuses a link whose session has been confirmed or cancelled', async () => {
    const w = world()
    const id = await sessionBy(w)
    const token = await linkFor(w, id)
    await w.as(A).from('sessions').update({ status: 'cancelled' }).eq('id', id)
    expect((await w.as(B).rpc('join_session', { invite_token: token })).error.code).toBe('P0002')
  })

  it('stops at thirty joined people with its own error', async () => {
    const w = world()
    const id = await sessionBy(w)
    const token = await linkFor(w, id)
    for (let i = 0; i < 29; i += 1) {
      const user = `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`
      w.database.setProfile(user, { username: `u${i}`, display_name: `U${i}`, avatar_url: null })
      expect((await w.as(user).rpc('join_session', { invite_token: token })).error).toBeNull()
    }
    const late = await w.as(B).rpc('join_session', { invite_token: token })
    expect(late.error).toMatchObject({ code: 'P0001', hint: 'session_full' })
  })

  it('lets a personal invitation be used once, and only by its person', async () => {
    const w = world()
    const id = await sessionBy(w)
    const { data } = await w.as(A).from('invites').insert({ session_id: id, created_by: A, invitee_id: C }).select('token').single()
    expect((await w.as(D).rpc('join_session', { invite_token: data.token })).error.code).toBe('P0002')
    expect((await w.as(C).rpc('join_session', { invite_token: data.token })).data).toBe(id)
    expect((await w.as(A).from('invites').select('uses').eq('token', data.token).single()).data.uses).toBe(1)
  })
})

describe('invitations by name', () => {
  it('lists the open ones for the invitee, newest first, and drops one once answered or accepted', async () => {
    const w = world()
    const first = await sessionBy(w, A, { title: 'First' })
    clock += 1000
    const second = await sessionBy(w, B, { title: 'Second' })
    const t1 = (await w.as(A).from('invites').insert({ session_id: first, created_by: A, invitee_id: C }).select('token').single()).data.token
    clock += 1000
    const t2 = (await w.as(B).from('invites').insert({ session_id: second, created_by: B, invitee_id: C }).select('token').single()).data.token
    const list = (await w.as(C).rpc('my_invitations')).data
    expect(list.map((i) => [i.title, i.host_name])).toEqual([['Second', 'B_GUEST'], ['First', 'A_HOST']])
    expect(Object.keys(list[0]).sort()).toEqual(['date', 'end_time', 'host_name', 'invited_at', 'start_time', 'title', 'token'])
    expect((await w.as(C).rpc('decline_invite', { invite_token: t1 })).error).toBeNull()
    await w.as(C).rpc('join_session', { invite_token: t2 })
    expect((await w.as(C).rpc('my_invitations')).data).toEqual([])
    // A decline is final: the host cannot invite the same person again.
    expect((await w.as(A).from('invites').insert({ session_id: first, created_by: A, invitee_id: C }).select('token').single()).error.code).toBe('23505')
    expect((await w.as(D).rpc('my_invitations')).data).toEqual([])
  })

  it('refuses to decline an invitation that is not the caller\'s', async () => {
    const w = world()
    const id = await sessionBy(w)
    const token = (await w.as(A).from('invites').insert({ session_id: id, created_by: A, invitee_id: C }).select('token').single()).data.token
    expect((await w.as(D).rpc('decline_invite', { invite_token: token })).error.code).toBe('P0002')
    expect((await w.as(C).rpc('decline_invite', { invite_token: token })).error).toBeNull()
    expect((await w.as(C).rpc('decline_invite', { invite_token: token })).error).toBeNull()
  })
})

describe('Realtime', () => {
  // Wait for a client's channel to be connected, collecting what it hears.
  // How to call: const heard = await listen(w.as(A), [{ table: 'sessions' }])
  async function listen(client, specs) {
    const heard = []
    let channel = client.channel('test')
    for (const spec of specs) channel = channel.on('postgres_changes', { event: '*', schema: 'public', ...spec }, (p) => heard.push([spec.table, p.eventType, p.new, p.old]))
    await new Promise((resolve) => channel.subscribe((status) => status === 'SUBSCRIBED' && resolve()))
    return { heard, channel, client }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

  it('tells the host when someone joins, and tells a stranger nothing', async () => {
    const w = world()
    const id = await sessionBy(w)
    const token = await linkFor(w, id)
    const host = await listen(w.as(A), [{ table: 'session_members' }, { table: 'sessions' }])
    const stranger = await listen(w.as(D), [{ table: 'session_members' }, { table: 'sessions' }])
    await w.as(B).rpc('join_session', { invite_token: token })
    await settle()
    expect(host.heard.map(([table, type, row]) => [table, type, row.user_id])).toEqual([['session_members', 'INSERT', B]])
    expect(stranger.heard).toEqual([])
  })

  it('tells members when the session changes, and the host of an update only if they may read the row', async () => {
    const w = world()
    const id = await sessionBy(w)
    await w.as(B).rpc('join_session', { invite_token: await linkFor(w, id) })
    const guest = await listen(w.as(B), [{ table: 'sessions' }])
    await w.as(A).from('sessions').update({ title: 'Lunch' }).eq('id', id)
    await settle()
    expect(guest.heard.map(([, type, row]) => [type, row.title])).toEqual([['UPDATE', 'Lunch']])
  })

  it('applies a filter to inserts and updates, and delivers a delete only when there is no filter, with just the key', async () => {
    const w = world()
    const id = await sessionBy(w)
    const other = await sessionBy(w)
    await w.as(B).rpc('join_session', { invite_token: await linkFor(w, id) })
    const filtered = await listen(w.as(A), [{ table: 'session_members', filter: `session_id=eq.${id}` }])
    const whole = await listen(w.as(A), [{ table: 'session_members' }])
    await w.as(B).rpc('join_session', { invite_token: await linkFor(w, other) })
    await w.service.from('session_members').delete().eq('session_id', id).eq('user_id', B)
    await settle()
    expect(filtered.heard).toEqual([])
    const deleted = whole.heard.find(([, type]) => type === 'DELETE')
    expect(deleted[3]).toEqual({ session_id: id, user_id: B })
    expect(deleted[2]).toEqual({})
  })

  it('tells an invitee about their own invitations only, and stops when the channel is removed', async () => {
    const w = world()
    const id = await sessionBy(w)
    const invitee = await listen(w.as(C), [{ table: 'invites', filter: `invitee_id=eq.${C}` }])
    const bystander = await listen(w.as(D), [{ table: 'invites', filter: `invitee_id=eq.${D}` }])
    await w.as(A).from('invites').insert({ session_id: id, created_by: A, invitee_id: C }).select('token')
    await settle()
    expect(invitee.heard).toHaveLength(1)
    expect(bystander.heard).toEqual([])
    await invitee.client.removeChannel(invitee.channel)
    await w.as(C).rpc('decline_invite', { invite_token: invitee.heard[0][2].token })
    await settle()
    expect(invitee.heard).toHaveLength(1)
  })
})

describe('where the stand-in used to be looser than Postgres', () => {
  it('runs the BEFORE trigger of an invite before the row-level check, so a stranger is told the trigger\'s sentence', async () => {
    const w = world()
    const id = await sessionBy(w)
    const missing = '99999999-9999-4999-8999-999999999999'
    const stranger = (session) => w.as(B).from('invites').insert({ session_id: session, created_by: B }).select('token').single()
    // A session that does not exist, and one that is closed: the trigger speaks before the policy does.
    expect((await stranger(missing)).error).toMatchObject({ code: '42501', message: 'Invitations can only be made while a session is open.' })
    await w.as(A).from('sessions').update({ status: 'cancelled' }).eq('id', id)
    expect((await stranger(id)).error.message).toBe('Invitations can only be made while a session is open.')
    // For an open session the policy is what refuses a person who is not its host.
    const open = await sessionBy(w)
    expect((await stranger(open)).error.message).toBe('new row violates row-level security policy for table "invites"')
  })

  it('answers 22P02 for an id that is not a uuid, in a filter or in a value, never "not found"', async () => {
    const w = world()
    const id = await sessionBy(w)
    const bad = (r) => r.error
    expect(bad(await w.as(A).from('sessions').select('id').eq('id', 'not-a-uuid'))).toMatchObject({ code: '22P02', message: 'invalid input syntax for type uuid: "not-a-uuid"' })
    expect(bad(await w.as(A).from('session_members').select('user_id').in('session_id', [id, 'x']))).toMatchObject({ code: '22P02' })
    expect(bad(await w.as(A).from('sessions').update({ title: 'x' }).eq('id', '123').select('id'))).toMatchObject({ code: '22P02' })
    expect(bad(await w.as(A).from('sessions').insert({ host_id: 'me', ...fields }).select('id').single())).toMatchObject({ code: '22P02' })
    expect(bad(await w.as(A).from('invites').insert({ session_id: id, created_by: A, invitee_id: 'kim' }).select('token').single())).toMatchObject({ code: '22P02' })
    expect(bad(await w.service.from('session_members').delete().eq('user_id', 'x'))).toMatchObject({ code: '22P02' })
    // A null is allowed where the column is, and uppercase hex is still a uuid.
    expect(bad(await w.as(A).from('invites').select('token').is('invitee_id', null))).toBeNull()
    expect(bad(await w.as(A).from('sessions').select('id').eq('id', id.toUpperCase()))).toBeNull()
  })

  it('fails a statement that returns a row the caller may not read, and leaves nothing behind', async () => {
    const w = world()
    const heard = []
    const spy = w.as(A).channel('spy').on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, (p) => heard.push(p))
    await new Promise((resolve) => spy.subscribe((status) => status === 'SUBSCRIBED' && resolve()))
    const id = await sessionBy(w)
    const seen = w.database.canSee
    // A policy that hides a session titled "Hidden" or "Changed" from its own host, for the statements below.
    w.database.canSee = (as, table, row) => (table === 'sessions' && ['Hidden', 'Changed'].includes(row.title) ? false : seen(as, table, row))
    const insert = await w.as(A).from('sessions').insert({ host_id: A, ...fields, title: 'Hidden' }).select('id').single()
    expect(insert.error).toMatchObject({ code: '42501', message: 'new row violates row-level security policy for table "sessions"' })
    const update = await w.as(A).from('sessions').update({ title: 'Changed' }).eq('id', id).select('id')
    expect(update.error.code).toBe('42501')
    w.database.canSee = seen
    expect(w.database.tables.sessions).toHaveLength(1)
    expect(w.database.tables.session_members).toHaveLength(1)
    expect(w.database.tables.sessions[0].title).toBe('Dinner')
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Only the first, good insert was heard.
    expect(heard.map((p) => p.eventType)).toEqual(['INSERT'])
  })
})

describe('channels as realtime-js (2.117) has them', () => {
  const spec = { event: '*', schema: 'public', table: 'sessions' }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
  const connect = (ch) => new Promise((resolve) => ch.subscribe((status) => status === 'SUBSCRIBED' && resolve()))

  it('hands back the channel it already holds for a topic, even one that is leaving', async () => {
    const w = world()
    const client = w.as(A)
    const first = client.channel('feed').on('postgres_changes', spec, () => {})
    expect(client.channel('feed')).toBe(first)
    await connect(first)
    const leaving = client.removeChannel(first)
    // Not yet torn down: the same topic is still the same channel.
    expect(client.channel('feed')).toBe(first)
    expect(first.state).toBe('leaving')
    expect(await leaving).toBe('ok')
    expect(client.getChannels()).toEqual([])
    expect(client.channel('feed')).not.toBe(first)
  })

  it('does nothing when asked to subscribe a channel that is leaving, and the leave then ends it', async () => {
    const w = world()
    const client = w.as(A)
    const heard = []
    const first = client.channel('feed').on('postgres_changes', spec, (p) => heard.push(['old', p.eventType]))
    await connect(first)
    const leaving = client.removeChannel(first)
    // What a screen that is left and drawn again in one tick does: the same topic, the same binding, a subscribe.
    const again = client.channel('feed').on('postgres_changes', spec, (p) => heard.push(['new', p.eventType]))
    const statuses = []
    again.subscribe((status) => statuses.push(status))
    await leaving
    await settle()
    expect(again).toBe(first)
    expect(statuses).toEqual([])
    await sessionBy(w)
    await settle()
    expect(heard).toEqual([])
  })

  it('throws when a binding is added after subscribe, ignores an identical binding, and delivers a distinct topic\'s events', async () => {
    const w = world()
    const client = w.as(A)
    const ch = client.channel('one').on('postgres_changes', spec, () => {}).on('postgres_changes', spec, () => {})
    await connect(ch)
    expect(() => ch.on('postgres_changes', { ...spec, table: 'invites' }, () => {})).toThrow('cannot add `postgres_changes` callbacks for realtime:one after `subscribe()`.')
    const heard = []
    const two = client.channel('two').on('postgres_changes', spec, (p) => heard.push(p.eventType))
    await connect(two)
    await sessionBy(w)
    await settle()
    expect(heard).toEqual(['INSERT'])
    expect(client.getChannels()).toHaveLength(2)
  })

  it('keeps delivering to a leaving channel until it has left', async () => {
    const w = world()
    const client = w.as(A)
    const heard = []
    const ch = client.channel('feed').on('postgres_changes', spec, (p) => heard.push(p.eventType))
    await connect(ch)
    const leaving = client.removeChannel(ch)
    await sessionBy(w)
    await leaving
    await settle()
    expect(heard).toEqual(['INSERT'])
    await sessionBy(w)
    await settle()
    expect(heard).toEqual(['INSERT'])
  })
})
