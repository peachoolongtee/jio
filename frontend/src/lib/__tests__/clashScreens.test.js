// The popups and messages for a clashing meetup, drawn for real on an in-memory page (domless.js) on the stand-in database and the
// stand-in Jio server: the dialog's two wordings (making or changing a meetup, and joining or coming back), what a dialog is described
// by, the Rejoin button of a person who opted out, a host's edit that the database refuses because a member is busy then, and the
// focus that goes back to the button that started the request. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import { OTHER, PROFILE, SESSION } from './authFixture.js'
import { mountScreen, until } from './domless.js'
import { world } from './sessionsWorld.js'
import { SERVICE, createDatabase } from '../../components/dev/fakeDatabase.js'
import { ClashError, clashWhen, shortTitle } from '../clash.js'
import { WORDS, plain, problem } from '../sessionsRemote.js'
import { useReturnFocus } from '../useReturnFocus.js'

// The map needs a real browser (Leaflet).
vi.mock('../../components/map/PlannerMap.vue', () => ({ default: { name: 'PlannerMap', render: () => null } }))
vi.mock('../../components/spots/SpotPins.vue', () => ({ default: { name: 'SpotPins', render: () => null } }))

vi.setConfig({ testTimeout: 40000 })
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

const press = (view, label) => view.all('button').find((b) => view.text(b).includes(label))
const SCREENS = {
  'views/GroupDetailView': () => import('@/views/GroupDetailView.vue'),
  'views/CreateEventView': () => import('@/views/CreateEventView.vue'),
  'components/group/ClashDialog': () => import('@/components/group/ClashDialog.vue'),
}
const CLASH = { id: 's-dinner', title: 'Kim\'s dinner', date: '2026-10-10', start: '19:00', end: '21:00' }

// Draw a screen of the app signed in as the person opened last.
// How to call: const t = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
async function draw(file, path, props = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const auth = useAuthStore()
  await auth.init()
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  await router.push(path)
  const { default: View } = await SCREENS[file]()
  const view = await mountScreen(View, { plugins: [pinia, router], props })
  return { view, router, auth }
}

describe('the clash dialog', () => {
  const open = (props) => draw('components/group/ClashDialog', '/', { open: true, ...props })

  it('says what is wrong when making or changing a meetup, with the whole sentence, the way to the other meetup and no middle dot', async () => {
    const { view } = await open({ clash: CLASH })
    const dialog = view.one('[role=dialog]')
    expect(view.text(view.one(`#${dialog.attrs['aria-labelledby']}`))).toBe('That time is taken')
    expect(view.text(view.one(`#${dialog.attrs['aria-describedby']}`))).toBe('You\'re already in "Kim\'s dinner" from 19:00 to 21:00 on Sat 10 Oct. Choose a time that doesn\'t overlap.')
    expect(view.text(dialog)).not.toContain('·')
    expect(view.text('[data-testid=clash-change]')).toBe('Change the time')
    expect(view.text('[data-testid=clash-open]')).toBe('Open "Kim\'s dinner"')
    expect(view.has('[data-testid=clash-close]')).toBe(false)
  })

  it('says it in the join wording when joining or coming back: look at the other meetup, or close', async () => {
    const { view } = await open({ clash: CLASH, mode: 'join' })
    const dialog = view.one('[role=dialog]')
    expect(view.text(view.one(`#${dialog.attrs['aria-labelledby']}`))).toBe('This meetup overlaps one you\'re in')
    expect(view.text(view.one(`#${dialog.attrs['aria-describedby']}`))).toBe('You\'re already in "Kim\'s dinner" from 19:00 to 21:00 on Sat 10 Oct, so you can\'t join this one as well.')
    expect(view.text('[data-testid=clash-open]')).toBe('View "Kim\'s dinner"')
    expect(view.text('[data-testid=clash-close]')).toBe('Close')
    expect(view.has('[data-testid=clash-change]')).toBe(false)
  })

  it('keeps going when the database did not say which meetup: no name, no way to it', async () => {
    const edit = await open({ clash: null })
    expect(edit.view.text(edit.view.one('[role=dialog]'))).toContain('You\'re already in a meetup at that time. Choose a time that doesn\'t overlap.')
    expect(edit.view.has('[data-testid=clash-open]')).toBe(false)
    const join = await open({ clash: null, mode: 'join' })
    expect(join.view.text(join.view.one('[role=dialog]'))).toContain('You\'re already in a meetup at that time, so you can\'t join this one as well.')
    expect(join.view.has('[data-testid=clash-open]')).toBe(false)
    expect(join.view.text('[data-testid=clash-close]')).toBe('Close')
  })

  it('cuts a long title to fit the button and keeps all of it in the sentence', async () => {
    const title = 'The annual reunion dinner of the whole extended family'
    const { view } = await open({ clash: { ...CLASH, title } })
    expect(view.text('[data-testid=clash-open]')).toBe(`Open "${shortTitle(title)}"`)
    expect(view.text('[data-testid=clash-open]').length).toBeLessThan(title.length)
    expect(view.text(view.one('[role=dialog]'))).toContain(`"${title}"`)
  })

  it('words where a meetup falls, and leaves out what is missing', () => {
    expect(clashWhen(CLASH)).toBe('from 19:00 to 21:00 on Sat 10 Oct')
    expect(clashWhen({ date: '2026-10-10' })).toBe('on Sat 10 Oct')
    expect(clashWhen({ start: '19:00', end: '21:00' })).toBe('from 19:00 to 21:00')
    expect(clashWhen()).toBe('')
    expect(shortTitle('Dinner')).toBe('Dinner')
    expect(shortTitle('a'.repeat(30))).toHaveLength(24)
  })
})

describe('what a server refusal of a rejoin becomes', () => {
  it('is a ClashError naming the meetup, with the status kept', () => {
    const made = problem(Object.assign(new Error('x'), { code: 'schedule_clash', status: 409, clash: { id: 's1', title: 'Dinner', date: '2026-10-10', start: '19:00', end: '21:00' } }))
    expect(made).toBeInstanceOf(ClashError)
    expect(made).toMatchObject({ code: 'schedule_clash', status: 409, clash: { id: 's1', title: 'Dinner', start: '19:00', end: '21:00' } })
  })

  it('is still a clash, without a name, when the answer names none', () => {
    const made = problem(Object.assign(new Error('x'), { code: 'schedule_clash', status: 409 }))
    expect(made).not.toBeInstanceOf(ClashError)
    expect(made).toMatchObject({ code: 'schedule_clash', status: 409 })
  })

  it('tells the host a member is busy, under a code of its own', () => {
    const made = plain({ code: 'P0001', hint: 'member_clash', message: 'x' })
    expect(made.code).toBe('member_clash')
    expect(made.message).toBe(WORDS.memberClash)
  })
})

describe('focus after the popup', () => {
  // A stand-in for a button: `disabled` while the request runs.
  const button = () => ({ disabled: false, isConnected: true, focus: vi.fn() })

  it('goes back to the button that started the request, once it is enabled again', async () => {
    const open = ref(false)
    const { remember } = useReturnFocus(open)
    const next = button()
    remember({ currentTarget: next })
    next.disabled = true
    open.value = true
    await nextTick()
    next.disabled = false
    open.value = false
    await nextTick()
    await nextTick()
    expect(next.focus).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a button that is gone or still disabled, and forgets the button after one use', async () => {
    const open = ref(false)
    const { remember } = useReturnFocus(open)
    const gone = button()
    remember({ currentTarget: gone })
    gone.isConnected = false
    open.value = true
    await nextTick()
    open.value = false
    await nextTick()
    await nextTick()
    expect(gone.focus).not.toHaveBeenCalled()
    const again = button()
    remember({ currentTarget: again })
    open.value = true
    await nextTick()
    open.value = false
    await nextTick()
    await nextTick()
    expect(again.focus).toHaveBeenCalledTimes(1)
    open.value = true
    await nextTick()
    open.value = false
    await nextTick()
    await nextTick()
    expect(again.focus).toHaveBeenCalledTimes(1)
  })
})

// Sam hosts a session with Kim in it, still inviting, or under way (locating) when `started` is asked for. Kim is the app opened
// last, unless `host` is asked for.
// How to call: const { w, sam, kim, id } = await invited({ host: true, started: true })
async function invited({ host = false, started = false } = {}) {
  const w = world()
  let sam
  let kim
  if (host) {
    kim = await w.open(OTHER)
    sam = await w.open(PROFILE)
  } else {
    sam = await w.open(PROFILE)
    kim = await w.open(OTHER)
  }
  const { id } = await sam.api.createSession({ ...SESSION })
  await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
  if (started) await sam.api.startSession(id)
  return { w, sam, kim, id }
}

describe('coming back after opting out', () => {
  it('is refused before anything is sent when the person is in another meetup then, and the popup says so', async () => {
    const { w, kim, id } = await invited({ started: true })
    await kim.api.optOut(id, kim.id)
    // Opted out holds no time, so Kim can make a meetup at the same time.
    await kim.api.createSession({ ...SESSION, title: 'Kim\'s dinner', start: '19:00', end: '21:00' })
    const sent = w.server.calls.length
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('You opted out of this session'))
    await view.click(press(view, 'Rejoin'))
    await until(() => view.has('[data-testid=clash-open]'))
    const dialog = view.one('[role=dialog]')
    expect(view.text(view.one(`#${dialog.attrs['aria-labelledby']}`))).toBe('This meetup overlaps one you\'re in')
    expect(view.text('[data-testid=clash-open]')).toBe('View "Kim\'s dinner"')
    expect(view.text('[data-testid=clash-close]')).toBe('Close')
    expect(w.server.calls.slice(sent).some((c) => c.route === 'rejoin')).toBe(false)
    expect(w.database.tables.session_members.find((m) => m.user_id === kim.id && m.session_id === id).state).toBe('opted_out')
    expect(view.text()).toContain('You opted out of this session')
  })

  it('is refused by the server too, with the meetup in the answer, when the browser did not see it', async () => {
    const { w, kim, id } = await invited()
    await kim.api.optOut(id, kim.id)
    const other = await kim.api.createSession({ ...SESSION, title: 'Kim\'s dinner', start: '19:00', end: '21:00' })
    // Past the browser's own check (as when the other meetup was joined from another device a moment ago): the same call as
    // rejoinSession's, straight to the server.
    const { rejoinSession } = await import('../plannerApi.js')
    const refused = await rejoinSession(id).catch((e) => e)
    expect(refused).toMatchObject({ code: 'schedule_clash', status: 409, clash: { id: other.id, title: 'Kim\'s dinner', date: '2026-10-10', start: '19:00', end: '21:00' } })
    expect(w.database.tables.session_members.find((m) => m.user_id === kim.id && m.session_id === id).state).toBe('opted_out')
    // And the data layer's own call turns it into the same ClashError.
    const early = await kim.api.rejoinSession(id).catch((e) => e)
    expect(early).toMatchObject({ name: 'ClashError', code: 'schedule_clash' })
    expect(early.clash).toMatchObject({ id: other.id, title: 'Kim\'s dinner' })
  })

  it('goes through when the other meetup is over, or back to back', async () => {
    const { w, kim, id } = await invited()
    await kim.api.optOut(id, kim.id)
    const back = await kim.api.createSession({ ...SESSION, title: 'Late', start: '20:00', end: '22:00' })
    await expect(kim.api.rejoinSession(id)).resolves.toBeTruthy()
    expect(w.database.tables.session_members.find((m) => m.user_id === kim.id && m.session_id === id).state).toBe('joined')
    await kim.api.optOut(id, kim.id)
    await kim.api.updateSession(back.id, { title: 'Late', date: '2026-10-10', start: '19:00', end: '21:00' })
    await expect(kim.api.rejoinSession(id)).rejects.toMatchObject({ code: 'schedule_clash' })
    await kim.api.cancelSession(back.id)
    await expect(kim.api.rejoinSession(id)).resolves.toBeTruthy()
  })
})

describe('the create form', () => {
  const next = (view) => view.all('button').find((b) => view.text(b).includes('Next'))
  // Sets a time field the way a person does. How to call: setTime(view, 0, '13:00') (0 is the start, 1 the end)
  const setTime = (view, which, value) => {
    const field = view.all('.tp__input')[which]
    field.value = value
    field.dispatch('input')
    field.dispatch('blur')
  }

  it('opens "That time is taken" with the whole sentence when the host moves a meetup onto another of their own', async () => {
    const { sam } = await invited({ host: true })
    const early = await sam.api.createSession({ ...SESSION, title: 'Brunch', start: '08:00', end: '09:00' })
    const { view, router } = await draw('views/CreateEventView', `/sessions/${early.id}/edit`, { id: early.id })
    await until(() => view.has('input') && view.all('input')[0].value === 'Brunch')
    setTime(view, 0, '11:00')
    setTime(view, 1, '13:00')
    await view.tick()
    await view.click(next(view))
    await until(() => view.has('[data-testid=clash-change]'))
    const dialog = view.one('[role=dialog]')
    expect(view.text(view.one(`#${dialog.attrs['aria-labelledby']}`))).toBe('That time is taken')
    expect(view.text(view.one(`#${dialog.attrs['aria-describedby']}`))).toBe('You\'re already in "Saturday" from 12:00 to 20:00 on Sat 10 Oct. Choose a time that doesn\'t overlap.')
    expect(view.text('[data-testid=clash-open]')).toBe('Open "Saturday"')
    expect(router.currentRoute.value.path).toBe(`/sessions/${early.id}/edit`)
    await view.click(view.one('[data-testid=clash-change]'))
    await until(() => !view.has('[role=dialog]'))
  })

  it('says under the end time that someone in the meetup is busy when the database refuses a host\'s edit, and clears it when a time changes', async () => {
    const { w, sam, kim, id } = await invited({ host: true })
    // Kim has an evening meetup; Sam's edit stretches the afternoon into it.
    await kim.api.createSession({ ...SESSION, title: 'Kim\'s dinner', start: '21:00', end: '22:00' })
    const { view, router } = await draw('views/CreateEventView', `/sessions/${id}/edit`, { id })
    await until(() => view.has('input') && view.all('input')[0].value === 'Saturday')
    setTime(view, 1, '21:30')
    await view.tick()
    await view.click(next(view))
    await until(() => view.text().includes(WORDS.memberClash))
    const note = view.all('[role=alert]').find((n) => view.text(n) === WORDS.memberClash)
    expect(note.attrs.id).toMatch(/-note$/)
    expect(view.has('[role=dialog]')).toBe(false)
    expect(router.currentRoute.value.path).toBe(`/sessions/${id}/edit`)
    expect(w.database.tables.sessions.find((s) => s.id === id).end_time).toMatch(/^20:00/)
    expect(sam.user.id).toBeTruthy()
    setTime(view, 1, '20:30')
    await view.tick()
    expect(view.text()).not.toContain(WORDS.memberClash)
  })
})

describe('the stand-in database refuses what the clash trigger refuses', () => {
  const A = '00000000-0000-4000-8000-00000000000a'
  const B = '00000000-0000-4000-8000-00000000000b'
  const profile = (name) => ({ username: name, display_name: name, avatar_url: null })
  const eq = (col, value) => ({ col, op: 'eq', value })

  // A hosts "Lunch" (12:00 to 14:00, tomorrow) with B joined; B then opts out; B hosts "Dinner" at 13:00 to 15:00 the same day.
  function seeded() {
    const db = createDatabase({ profiles: { [A]: profile('a'), [B]: profile('b') }, now: () => Date.parse('2026-10-20T10:00:00.000Z') })
    const made = (as, title, start, end) => db.run({ as, kind: 'insert', table: 'sessions', values: { host_id: as, title, date: '2026-10-21', start_time: start, end_time: end }, returning: true, columns: 'id' }).data[0].id
    const lunch = made(A, 'Lunch', '12:00', '14:00')
    const { token } = db.run({ as: A, kind: 'insert', table: 'invites', values: { session_id: lunch, created_by: A }, returning: true, columns: 'token' }).data[0]
    db.run({ as: B, kind: 'rpc', fn: 'join_session', args: { invite_token: token } })
    db.run({ as: SERVICE, kind: 'update', table: 'session_members', values: { state: 'opted_out' }, filters: [eq('session_id', lunch), eq('user_id', B)] })
    const dinner = made(B, 'Dinner', '13:00', '15:00')
    const rejoin = () => db.run({ as: SERVICE, kind: 'rpc', fn: 'apply_session_plan', args: { sid: lunch, expected_version: 0, expected_status: 'inviting', patch: { ops: [{ op: 'rejoin', user_id: B }] } } })
    return { db, lunch, dinner, rejoin }
  }

  it('refuses the server\'s rejoin of a member who is in another meetup then, naming it, and keeps them out', () => {
    const { db, lunch, dinner, rejoin } = seeded()
    const answer = rejoin()
    expect(answer.error).toMatchObject({ code: 'P0001', hint: 'schedule_clash' })
    expect(JSON.parse(answer.error.details)).toMatchObject({ id: dinner, title: 'Dinner' })
    expect(db.tables.session_members.find((m) => m.session_id === lunch && m.user_id === B).state).toBe('opted_out')
  })

  it('lets the rejoin through when the other meetup is over, and a plain update by the server is checked the same', () => {
    const { db, lunch, dinner, rejoin } = seeded()
    const direct = db.run({ as: SERVICE, kind: 'update', table: 'session_members', values: { state: 'joined' }, filters: [eq('session_id', lunch), eq('user_id', B)] })
    expect(direct.error).toMatchObject({ hint: 'schedule_clash' })
    db.run({ as: B, kind: 'update', table: 'sessions', values: { status: 'cancelled' }, filters: [eq('id', dinner)] })
    expect(rejoin().data).toBe(1)
    expect(db.tables.session_members.find((m) => m.session_id === lunch && m.user_id === B).state).toBe('joined')
  })
})

describe('a dialog with text', () => {
  it('is described by its text, and one without text is not described', async () => {
    const { default: ModalDialog } = await import('@/components/ui/ModalDialog.vue')
    const withText = await mountScreen(ModalDialog, { props: { open: true, title: 'Cancel outing?', text: 'Nobody earns anything.' } })
    const dialog = withText.one('[role=dialog]')
    expect(withText.text(withText.one(`#${dialog.attrs['aria-describedby']}`))).toBe('Nobody earns anything.')
    expect(withText.text(withText.one(`#${dialog.attrs['aria-labelledby']}`))).toBe('Cancel outing?')
    withText.unmount()
    const without = await mountScreen(ModalDialog, { props: { open: true, title: 'Confirm plan?' } })
    expect('aria-describedby' in without.one('[role=dialog]').attrs).toBe(false)
  })
})
