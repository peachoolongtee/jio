<script setup>
// Edit profile, opened from "Edit profile" on the signed-in person's own Profile page. Two tabs, each with its own address
// and its own save button, in the manner of Instagram's settings:
//   Edit profile (/profile/edit): a card with the photo, @username and name, and Change photo; then name, home area and
//   dietary needs, starting from the signed-in person. Saved only when
//   something changed and the name keeps the sign-up rule, and only the fields that changed are sent, so a copy of the
//   page that is out of date never writes over what another device saved. The photo is shrunk the way sign-up shrinks it
//   (lib/photo.js) and, as at sign-up, stays in this browser: it is not uploaded. A real account's details also go to
//   Supabase; when that write fails the change is kept in this browser, the page says it did not reach the account, "Saved"
//   is not shown, and Save details stays usable: pressing it again sends the fields that did not arrive.
//   Password (/profile/edit/password): real accounts only. The current password, then a new one with the same live checklist as sign-up
//   (lib/signupRules.js), typed twice. Two new passwords that differ, or a new one equal to the old, are refused before
//   anything is sent and nothing typed is cleared. Otherwise the current one is checked with Supabase before the new one
//   is set, and all three fields are emptied after that attempt. A local account lives only in this browser and has no
//   password, so it gets a note instead.
// On a phone the two tabs sit across the top and the page takes the full width. From tablet up they are a menu down
// the left, and the open tab is on the right. Switching tabs replaces the address, so Back still goes to the Profile
// page, and what was typed in the other tab is kept until the page is left.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import IconButton from '@/components/ui/IconButton.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextField from '@/components/ui/TextField.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import * as api from '@/lib/api.js'
import { MESSAGES } from '@/lib/auth.js'
import { shrinkPhoto } from '@/lib/photo.js'
import { DIETARY_OPTIONS, NAME_MAX, cleanDietary, hiddenProblem, passwordRules, shownRules, validateName } from '@/lib/signupRules.js'
import { useAuthStore } from '@/stores/auth.js'

const auth = useAuthStore()
const route = useRoute()
// Which tab is open, from the address.
const tab = computed(() => (route.name === 'profile-password' ? 'password' : 'details'))
const TABS = [
  { id: 'details', label: 'Edit profile', icon: 'tab-profile', to: '/profile/edit' },
  { id: 'password', label: 'Password', icon: 'lock', to: '/profile/edit/password' },
]

// ── Your details ──
// A data URL, or '' for no photo (the avatar shows the first letter of the name).
const photo = ref(auth.user?.photo ?? '')
const photoError = ref('')
const name = ref(auth.user?.name ?? '')
const homeAreaId = ref(auth.user?.homeAreaId ?? '')
const dietary = ref(cleanDietary(auth.user?.dietary))
const areas = ref([])
const nameError = ref('')
const detailsError = ref('')
const savingDetails = ref(false)
const detailsSaved = ref(false)

onMounted(async () => {
  areas.value = await api.listAreas()
})
const areaOptions = computed(() => [...areas.value].sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({ value: a.id, label: a.name })))

// The fields that also go to the Supabase account. The photo does not: it stays in this browser.
const REMOTE_KEYS = ['name', 'homeAreaId', 'dietary']
// The account fields whose last write did not reach the account, if the last save failed. A real account whose sign-up
// write failed starts with all of them, since the same notice is showing.
const unsent = ref(auth.user?.authId && auth.syncNotice === MESSAGES.profile_not_saved ? [...REMOTE_KEYS] : [])
const notSaved = computed(() => unsent.value.length > 0)

// The fields of the form that differ from the signed-in person as the store holds them, and only those.
// How to call: changedFields() -> { name: 'Samantha' }
function changedFields() {
  const user = auth.user
  const patch = {}
  if (!user) return patch
  if (photo.value !== (user.photo ?? '')) patch.photo = photo.value
  if (name.value.trim() !== (user.name ?? '')) patch.name = name.value.trim()
  if (homeAreaId.value !== (user.homeAreaId ?? '')) patch.homeAreaId = homeAreaId.value
  if (cleanDietary(dietary.value).join() !== cleanDietary(user.dietary).join()) patch.dietary = cleanDietary(dietary.value)
  return patch
}

// Has anything changed from what the signed-in person has now?
const detailsChanged = computed(() => Object.keys(changedFields()).length > 0)
// Save stays usable while the last save did not reach the account, even with nothing new to send.
const canSave = computed(() => detailsChanged.value || notSaved.value)

// The signed-in person can change under the page: the profile read from Supabase after start-up arrives, or another
// tab saves. A field still showing the old value takes the new one; a field the person has edited is left alone.
watch(
  () => auth.user,
  (user, before) => {
    if (!user || !before) return
    const diet = (list) => cleanDietary(list).join()
    if (photo.value === (before.photo ?? '') && photo.value !== (user.photo ?? '')) photo.value = user.photo ?? ''
    if (name.value.trim() === (before.name ?? '') && name.value.trim() !== (user.name ?? '')) name.value = user.name ?? ''
    if (homeAreaId.value === (before.homeAreaId ?? '') && homeAreaId.value !== (user.homeAreaId ?? '')) homeAreaId.value = user.homeAreaId ?? ''
    if (diet(dietary.value) === diet(before.dietary) && diet(dietary.value) !== diet(user.dietary)) dietary.value = cleanDietary(user.dietary)
  },
)

watch([photo, name, homeAreaId, dietary], () => (detailsError.value = ''))
// "Saved" stays until the form differs from what is saved, not on every write to a field.
watch(detailsChanged, (changed) => {
  if (changed) detailsSaved.value = false
})
watch(name, () => (nameError.value = ''))

// Read the chosen picture and shrink it. It is saved with the other details. The input is emptied afterwards, so the
// same file can be chosen again after Remove photo.
// How to call: await onPhoto(event)   (the file input's change)
async function onPhoto(event) {
  const input = event.target
  const file = input.files?.[0]
  photoError.value = ''
  if (!file) return
  try {
    photo.value = await shrinkPhoto(file)
  } catch (err) {
    photoError.value = err.message
  } finally {
    input.value = ''
  }
}

// Pick a dietary need, or take it off. Any number can be picked, or none.
// How to call: toggleDiet('halal')
function toggleDiet(value) {
  const list = dietary.value
  dietary.value = list.includes(value) ? list.filter((d) => d !== value) : [...list, value]
}

// Save the details, when they changed (or the last save did not reach the account) and the name keeps the rule. Only the
// fields that changed are sent, with the ones that did not arrive last time.
// How to call: await saveDetails()   (the details form's submit)
async function saveDetails() {
  if (savingDetails.value || !canSave.value) return
  const patch = changedFields()
  // A field that did not reach the account is sent again with the value the browser kept for it.
  for (const key of unsent.value) {
    if (!(key in patch)) patch[key] = key === 'dietary' ? cleanDietary(auth.user?.[key]) : (auth.user?.[key] ?? '')
  }
  if (Object.keys(patch).length === 0) return
  if ('name' in patch) {
    nameError.value = validateName(patch.name)
    if (nameError.value) return
  }
  savingDetails.value = true
  detailsError.value = ''
  try {
    await auth.update(patch)
    // A failed Supabase write is shown by the app's sync notice and by the line beside the button; "Saved" would say otherwise.
    const sent = REMOTE_KEYS.filter((key) => key in patch)
    unsent.value = auth.syncNotice && auth.user?.authId && sent.length > 0 ? sent : []
    detailsSaved.value = !auth.syncNotice
  } catch (err) {
    detailsError.value = err?.message || MESSAGES.unknown
  } finally {
    savingDetails.value = false
  }
}

// ── Change password ──
// A local account has no password. With nobody signed in (the login ended while the page is open, and the app is on its
// way to the login screen) neither the note nor the form is shown.
const noPassword = computed(() => !!auth.user?.local)
const hasPassword = computed(() => !!auth.user && !auth.user.local)
const current = ref('')
const next = ref('')
const confirm = ref('')
// Each field has its own Show/Hide, so showing the new password never shows the current one.
const shown = ref({ current: false, next: false, confirm: false })
const currentError = ref('')
const nextError = ref('')
const confirmError = ref('')
const passwordError = ref('')
const changingPassword = ref(false)
const passwordChanged = ref(false)

const checks = computed(() => passwordRules(next.value))
const strong = computed(() => checks.value.every((c) => c.ok))
// The checklist leaves out the rule almost nobody breaks; when it is broken, it is said under the field instead.
const shownChecks = computed(() => shownRules(checks.value))
const nextProblem = computed(() => hiddenProblem(checks.value, next.value))

// Empty every message of the password part, before an attempt or when the person types again.
// How to call: clearPasswordMessages()
function clearPasswordMessages() {
  currentError.value = ''
  nextError.value = ''
  confirmError.value = ''
  passwordError.value = ''
  passwordChanged.value = false
}

// What the tab says when the login ended before the new password was set. The reset flow's "This reset link has expired"
// would be wrong here: nobody used a link.
const LOGIN_ENDED = 'Your login has ended. Log in again to change your password.'

// Check the current password and set the new one. The message goes under the field it is about. Two new passwords that
// differ, or a new one equal to the old, are refused first, before anything is sent, and nothing typed is cleared. After
// Supabase has been asked, all three fields are emptied, whether it worked or not, and a failed attempt puts the focus back
// in the current-password field, since the button has just become disabled.
// How to call: await savePassword()   (the password form's submit, which Enter in any of its fields also triggers)
async function savePassword() {
  if (changingPassword.value || !current.value || !strong.value || !confirm.value) return
  clearPasswordMessages()
  if (confirm.value !== next.value) {
    confirmError.value = 'The two passwords do not match.'
    return
  }
  if (next.value === current.value) {
    nextError.value = MESSAGES.same_password
    return
  }
  changingPassword.value = true
  let failed = false
  try {
    await auth.changeOwnPassword({ current: current.value, next: next.value })
    passwordChanged.value = true
  } catch (err) {
    failed = true
    const message = err?.message || MESSAGES.unknown
    if (err?.code === 'wrong_password') currentError.value = message
    else if (err?.code === 'same_password' || err?.code === 'weak_password') nextError.value = message
    else if (err?.code === 'reset_link_invalid') passwordError.value = LOGIN_ENDED
    else passwordError.value = message
  } finally {
    current.value = ''
    next.value = ''
    confirm.value = ''
    changingPassword.value = false
  }
  if (failed) {
    await nextTick()
    document.getElementById('edit-current')?.focus()
  }
}
</script>

<template>
  <main class="screen edit" data-testid="edit-profile-view">
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton label="Back" to="/profile"><AppIcon name="back" /></IconButton>
      </div>
    </header>

    <div class="screen__body edit__layout">
      <nav class="edit__nav" aria-label="Profile settings">
        <RouterLink
          v-for="item in TABS"
          :key="item.id"
          :to="item.to"
          replace
          class="edit__tab"
          :class="{ 'is-active': tab === item.id }"
          :aria-current="tab === item.id ? 'page' : undefined"
          :data-testid="`tab-${item.id}`"
        >
          <AppIcon :name="item.icon" :size="20" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <form v-if="tab === 'details'" id="details-form" class="edit__panel" aria-labelledby="details-head" novalidate @submit.prevent="saveDetails">
        <h1 id="details-head" class="display-lg">Edit profile</h1>
        <div class="edit__card" role="group" aria-label="Profile photo">
          <UserAvatar :name="name.trim() || auth.user?.name || '?'" :src="photo" :person="auth.myId" :size="64" />
          <span class="edit__who">
            <span class="title-md truncate" data-testid="card-username">{{ auth.user?.username ? `@${auth.user.username}` : '' }}</span>
            <span class="body-sm text-muted truncate" data-testid="card-name">{{ name.trim() || auth.user?.name }}</span>
          </span>
          <span class="edit__card-actions">
            <label class="edit__upload">
              <span>{{ photo ? 'Change photo' : 'Add photo' }}</span>
              <input id="edit-photo" class="sr-only" type="file" accept="image/*" @change="onPhoto" />
            </label>
            <AppButton v-if="photo" variant="tertiary" underline data-testid="remove-photo" @click="photo = ''">Remove</AppButton>
          </span>
        </div>
        <p v-if="photoError" class="body-sm text-error" role="alert" data-testid="photo-error">{{ photoError }}</p>
        <TextField id="edit-name" v-model="name" label="Name" autocomplete="given-name" :maxlength="NAME_MAX" :hint="`Up to ${NAME_MAX} characters`" :error="nameError" />
        <SelectField id="edit-area" v-model="homeAreaId" label="Home area" placeholder="Choose an area" :options="areaOptions" />
        <div class="edit__group">
          <p id="edit-diet-label" class="field-label caption">Dietary needs</p>
          <div class="edit__diet" role="group" aria-labelledby="edit-diet-label">
            <ChipButton v-for="option in DIETARY_OPTIONS" :key="option.value" check :selected="dietary.includes(option.value)" @click="toggleDiet(option.value)">
              {{ option.label }}
            </ChipButton>
          </div>
        </div>
        <p v-if="detailsError" class="body-sm text-error" role="alert" data-testid="details-error">{{ detailsError }}</p>
        <p v-if="notSaved" class="body-sm text-error" role="alert" data-testid="details-not-saved">Saved on this device, but not to your account. Press Save details to try again.</p>
        <p v-if="detailsSaved" class="body-sm edit__done" role="status" data-testid="details-saved"><AppIcon name="check" :size="16" />Saved</p>
        <AppButton block type="submit" :disabled="savingDetails || !canSave" data-testid="save-details">{{ savingDetails ? 'Saving' : 'Save details' }}</AppButton>
      </form>

      <section v-else class="edit__panel" aria-labelledby="password-head">
        <h1 id="password-head" class="display-lg">Password</h1>
        <BannerNote v-if="noPassword" data-testid="no-password-note">This account lives only in this browser and has no password to change.</BannerNote>
        <form v-else-if="hasPassword" id="password-form" class="edit__form" novalidate @submit.prevent="savePassword">
          <p class="body-md text-muted">Type your current password, then the new one twice.</p>
          <!-- Not seen or reached by Tab: it tells a password manager which login the password belongs to. -->
          <input class="sr-only" type="text" name="username" autocomplete="username" readonly tabindex="-1" aria-hidden="true" :value="auth.user?.email ?? ''" data-testid="password-username" />
          <TextField
            id="edit-current"
            v-model="current"
            label="Current password"
            :type="shown.current ? 'text' : 'password'"
            autocomplete="current-password"
            :error="currentError"
            @input="clearPasswordMessages"
          >
            <template #trailing>
              <button type="button" class="edit__peek" :aria-label="`${shown.current ? 'Hide' : 'Show'} current password`" data-testid="peek-current" @click="shown.current = !shown.current">{{ shown.current ? 'Hide' : 'Show' }}</button>
            </template>
          </TextField>
          <TextField
            id="edit-new"
            v-model="next"
            label="New password"
            :type="shown.next ? 'text' : 'password'"
            autocomplete="new-password"
            :error="nextError || nextProblem"
            @input="clearPasswordMessages"
          >
            <template #trailing>
              <button type="button" class="edit__peek" :aria-label="`${shown.next ? 'Hide' : 'Show'} new password`" data-testid="peek-next" @click="shown.next = !shown.next">{{ shown.next ? 'Hide' : 'Show' }}</button>
            </template>
          </TextField>
          <ul class="checklist" aria-label="Password checklist" aria-live="polite">
            <li v-for="check in shownChecks" :key="check.label" class="checklist__item" :class="{ 'is-ok': check.ok }">
              <span class="checklist__mark"><AppIcon v-if="check.ok" name="check" :size="10" /></span>
              <span class="checklist__text">
                <span class="body-sm">{{ check.label }}</span>
                <span v-if="check.hint" class="checklist__hint">{{ check.hint }}</span>
              </span>
              <span class="sr-only">{{ check.ok ? 'done' : 'not yet' }}</span>
            </li>
          </ul>
          <TextField
            id="edit-confirm"
            v-model="confirm"
            label="Type it again"
            :type="shown.confirm ? 'text' : 'password'"
            autocomplete="new-password"
            :error="confirmError"
            @input="clearPasswordMessages"
          >
            <template #trailing>
              <button type="button" class="edit__peek" :aria-label="`${shown.confirm ? 'Hide' : 'Show'} the second new password`" data-testid="peek-confirm" @click="shown.confirm = !shown.confirm">{{ shown.confirm ? 'Hide' : 'Show' }}</button>
            </template>
          </TextField>
          <p v-if="passwordError" class="body-sm text-error" role="alert" data-testid="password-error">{{ passwordError }}</p>
          <p v-if="passwordChanged" class="body-sm edit__done" role="status" data-testid="password-changed"><AppIcon name="check" :size="16" />Password changed. Use it the next time you log in.</p>
          <AppButton block type="submit" :disabled="changingPassword || !current || !strong || !confirm" data-testid="save-password">{{ changingPassword ? 'Saving' : 'Change password' }}</AppButton>
        </form>
      </section>
    </div>
  </main>
</template>

<style scoped>
.edit { min-height: 100dvh; }
.edit__layout { gap: var(--spacing-lg); }

/* The two tabs. On a phone: across the top, muted labels, the open one in ink with a 2px rule under it. */
.edit__nav { display: flex; gap: var(--spacing-lg); border-bottom: 1px solid var(--hairline); }
.edit__tab { display: inline-flex; align-items: center; gap: var(--spacing-sm); min-height: var(--tap-min); margin-bottom: -1px; padding: var(--spacing-md) 0; border-bottom: 2px solid transparent; color: var(--muted); font: var(--text-button-sm); text-decoration: none; white-space: nowrap; }
.edit__tab.is-active { border-bottom-color: var(--ink); color: var(--ink); font-weight: 600; }
@media (hover: hover) { .edit__tab:not(.is-active):hover { color: var(--ink); } }

/* The open tab: one column of fields, no wider than a form. */
.edit__panel { display: flex; flex-direction: column; gap: var(--spacing-lg); width: 100%; max-width: var(--form-max-width); }
.edit__panel h1, .edit__panel > p { margin: 0; }

/* Tablet and up: the tabs become a menu down the left, and the open tab sits beside it. */
@media (min-width: 744px) {
  .edit__layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); align-items: start; column-gap: var(--spacing-xl); }
  .edit__nav { position: sticky; top: calc(var(--topbar-real-height) + var(--spacing-base)); flex-direction: column; gap: var(--spacing-xs); border-bottom: 0; }
  .edit__tab { min-height: 48px; margin: 0; padding: 0 var(--spacing-base); border-bottom: 0; border-radius: var(--rounded-sm); color: var(--ink); font: var(--text-body-md); }
  .edit__tab.is-active { background: var(--surface-strong); font-weight: 600; }
  @media (hover: hover) { .edit__tab:not(.is-active):hover { background: var(--surface-soft); } }
  .edit__panel { justify-self: center; }
}
@media (min-width: 1128px) {
  .edit__layout { grid-template-columns: 260px minmax(0, 1fr); column-gap: var(--spacing-xxl); }
}

.edit__form, .edit__group { display: flex; flex-direction: column; gap: var(--spacing-md); }
.edit__form > p { margin: 0; }
.edit__group .field-label { margin: 0; color: var(--muted); }
/* The photo card: the avatar, @username and name, and Change photo on the right. On a narrow phone the button wraps
   under the name. */
.edit__card { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-md) var(--spacing-base); padding: var(--spacing-base); border-radius: var(--rounded-md); background: var(--surface-soft); }
.edit__who { display: flex; flex: 1 1 120px; flex-direction: column; min-width: 0; }
.edit__card-actions { display: flex; align-items: center; gap: var(--spacing-base); }
/* Outlined, as the upload label at sign-up is, so "Save details" is the one red action on the page. */
.edit__upload { display: inline-flex; align-items: center; min-height: var(--tap-min); padding: 0 var(--spacing-base); border: 1px solid var(--ink); border-radius: var(--rounded-sm); color: var(--ink); font: var(--text-button-sm); white-space: nowrap; cursor: pointer; }
.edit__upload:focus-within { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (hover: hover) { .edit__upload:hover { background: var(--surface-soft); } }
.edit__diet { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
.edit__done { display: inline-flex; align-items: center; gap: var(--spacing-xs); margin: 0; color: var(--ink); }
.edit__done :deep(svg) { color: var(--selected); }
.edit__peek { position: absolute; top: 6px; right: 6px; min-width: var(--tap-min); height: var(--tap-min); padding: 0 var(--spacing-md); border: 0; border-radius: var(--rounded-sm); background: transparent; color: var(--ink); font: var(--text-button-sm); text-decoration: underline; }
.checklist { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.checklist__item { display: flex; align-items: flex-start; gap: var(--spacing-sm); color: var(--muted); }
.checklist__text { display: flex; flex-direction: column; }
.checklist__hint { font: var(--text-caption); color: var(--muted); }
.checklist__item.is-ok { color: var(--ink); }
.checklist__mark { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: 1.5px solid var(--border-strong); border-radius: var(--rounded-full); color: var(--on-primary); }
.checklist__item.is-ok .checklist__mark { border-color: var(--selected); background: var(--selected); }
</style>
