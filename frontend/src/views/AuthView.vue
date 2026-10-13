<script>
import { passwordRules } from '@/lib/signupRules.js'

// What the password step asks for. With a Supabase project behind sign-up: 8 to 72 characters with an uppercase letter,
// a lowercase letter, a number and a symbol (any printable character that is not a letter, number or space), and no
// space at either end (lib/signupRules.js, the same rule as the reset page). Anything else the server refuses comes back
// as a sentence (lib/auth.js) and is shown as it is. With local accounts the password is not used, so the older
// checklist stays as it was.
// How to call: passwordChecks('Abc1!xyz', true) -> [{ label: '8 or more characters', ok: true }, ...]
export function passwordChecks(password, realAccounts) {
  if (realAccounts) return passwordRules(password)
  return [
    { label: '8 or more characters', ok: password.length >= 8 },
    { label: 'A letter', ok: /[a-z]/i.test(password) },
    { label: 'A number', ok: /\d/.test(password) },
    { label: 'A symbol', ok: /[^a-z0-9]/i.test(password) },
  ]
}
</script>

<script setup>
// Sign-up: one question per screen, with a back arrow and a progress bar.
// Email, password with a live checklist, name, date of birth, username, profile photo (can be skipped), home area,
// dietary needs (can be skipped), suggested friends. It ends on Home.
// The answers live in the auth store's draft, so nothing is lost if the window is resized.
// With real accounts the password goes to Supabase and is emptied afterwards, whatever happens: after a failed attempt
// the screen goes back to the question the problem belongs to, keeps every other answer, and asks for the password again
// before it tries again. When the project wants the email confirmed first, "Check your email" replaces the questions.
import { computed, defineAsyncComponent, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import IconButton from '@/components/ui/IconButton.vue'
import JioLogo from '@/components/ui/JioLogo.vue'
import ListRow from '@/components/ui/ListRow.vue'
import ProgressBar from '@/components/ui/ProgressBar.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextField from '@/components/ui/TextField.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import * as api from '@/lib/api.js'
import { shrinkPhoto } from '@/lib/photo.js'
import { MESSAGES } from '@/lib/auth.js'
import {
  DIETARY_OPTIONS,
  dobToIso,
  fieldForSignUpError,
  formatDobInput,
  hiddenProblem,
  isoToDob,
  NAME_MAX,
  shownRules,
  USERNAME_HINT,
  usernameCandidates,
  validateDob,
  validateEmail,
  validateName,
  validateUsername,
} from '@/lib/signupRules.js'
import { useAuthStore } from '@/stores/auth.js'

const STEPS = ['email', 'password', 'name', 'dob', 'username', 'photo', 'home', 'diet', 'friends']

const router = useRouter()
const auth = useAuthStore()
const draft = computed(() => auth.draft)
const step = computed(() => STEPS[draft.value.step])

const areas = ref([])
const people = ref([])
// Messages under a field: from the data layer, shown on the question they belong to.
const usernameError = ref('')
// The username that could not be checked (Supabase did not answer): the person was told and may go on with it.
const usernameUnchecked = ref('')
// Free usernames like the one that was taken, offered under the field to tap.
const usernameSuggestions = ref([])
const nameError = ref('')
const dobError = ref('')
const submitError = ref('')
const emailError = ref('')
const passwordError = ref('')
// True after a failed attempt: the password was emptied, so the next time it is asked for the screen goes straight on to
// the last question instead of through every question again.
const reenter = ref(false)
const confirmTitle = ref(null)
// Why the demo tools' account (or "Start over") could not be created, shown above the buttons on every question.
const demoError = ref('')
const photoError = ref('')
const busy = ref(false)
// What the busy state is for, so the main button can say so: 'checking-email', 'checking' (the username) or 'creating'
// (the account).
const phase = ref('')
const showPassword = ref(false)
const stepTitle = ref(null)

onMounted(async () => {
  ;[areas.value, people.value] = await Promise.all([api.listAreas(), api.listPeople()])
})

// Move focus to the new question so keyboard and screen-reader users land on it.
watch(
  () => draft.value.step,
  async () => {
    await nextTick()
    stepTitle.value?.focus()
  },
)

const emailValid = computed(() => !validateEmail(draft.value.email))
// The email's message shows once the person has left the field (or pressed Enter) with an address that is not one.
const emailTouched = ref(false)
const emailShown = computed(() => emailError.value || (emailTouched.value && draft.value.email ? validateEmail(draft.value.email) : ''))
const checks = computed(() => passwordChecks(draft.value.password, auth.realAccounts))
// The checklist leaves out the rule almost nobody breaks; when it is broken, it is said under the field instead.
const shownChecks = computed(() => shownRules(checks.value))
const passwordProblem = computed(() => hiddenProblem(checks.value, draft.value.password))
// The date of birth as typed, DD/MM/YYYY. The draft keeps YYYY-MM-DD, and only once all 8 digits are there, so only a
// full but impossible date shows a message.
const dobText = ref(isoToDob(draft.value.dob))
const dobInvalid = computed(() => (draft.value.dob ? validateDob(draft.value.dob) : ''))

// Keep the typed date in DD/MM/YYYY form and the draft in step with it.
// How to call: onDobInput('18032004')
function onDobInput(value) {
  dobText.value = formatDobInput(value)
  draft.value.dob = dobToIso(dobText.value)
}

const canContinue = computed(() => {
  const d = draft.value
  switch (step.value) {
    case 'email': return emailValid.value
    case 'password': return checks.value.every((c) => c.ok)
    case 'name': return !validateName(d.name)
    case 'dob': return !validateDob(d.dob)
    case 'username': return !validateUsername(d.username)
    case 'home': return !!d.homeAreaId
    default: return true
  }
})

const areaOptions = computed(() => [...areas.value].sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({ value: a.id, label: a.name })))

// One question back.
// How to call: back()
function back() {
  submitError.value = ''
  if (draft.value.step > 0) draft.value.step -= 1
}

// The "Check your email" screen's way back to the first question.
// How to call: changeEmail()
function changeEmail() {
  auth.dismissConfirmation()
  draft.value.step = 0
}

// Focus "Check your email" when it appears, so a screen reader reads it.
watch(
  () => auth.pendingConfirmation,
  async (value) => {
    if (!value) return
    await nextTick()
    confirmTitle.value?.focus()
  },
)

// Ask for the password again: back to its question, with the reason on the field.
// How to call: askForPassword()
function askForPassword() {
  reenter.value = true
  passwordError.value = 'Enter your password again.'
  draft.value.step = STEPS.indexOf('password')
}

// What the username question says when the check could not be made. It is not a refusal: the next press of Next goes on,
// and the name is checked again when the account is created.
// Said under the email when an account already uses it; the "Log in" link sits just below.
const EMAIL_TAKEN = MESSAGES.email_taken

const UNCHECKED = 'Could not check that username right now. Press Next to carry on; it is checked again when you sign up.'

// Is this username free? True when it is, false (with the reason under the field) when it is taken, and false too, with a
// note, the first time the check itself fails; the person then presses Next again to go on with the name unchecked.
// How to call: if (await usernameFree()) draft.value.step += 1
async function usernameFree() {
  const name = draft.value.username
  if (usernameUnchecked.value === name) return true
  busy.value = true
  phase.value = 'checking'
  try {
    const { available } = await api.checkUsername(name)
    if (!available) {
      usernameError.value = 'That username is taken. Try another one.'
      suggestUsernames(name)
    }
    return available
  } catch (err) {
    if (err?.code) {
      usernameUnchecked.value = name
      usernameError.value = UNCHECKED
    } else {
      // A rule of the username itself (not a failed call): shown as it is.
      usernameError.value = err?.message || UNCHECKED
    }
    return false
  } finally {
    busy.value = false
    phase.value = ''
  }
}

// How many names to try, and how many free ones to offer. Four tried is the most that is ever asked of the database, and
// asking stops as soon as three are free.
const SUGGESTIONS_TRIED = 4
const SUGGESTIONS_OFFERED = 3

// Find up to 3 free usernames like a taken one (the same name with _<number>, see usernameCandidates) and offer them
// under the field. At most 4 names are tried: the first 3 together, and the fourth only if one of those was taken. Quiet
// when the checks fail: the person types another name instead. Dropped when the name was changed in the meantime.
// How to call: suggestUsernames('testuser_887')
async function suggestUsernames(taken) {
  usernameSuggestions.value = []
  const candidates = usernameCandidates(taken, { count: SUGGESTIONS_TRIED }).slice(0, SUGGESTIONS_TRIED)
  const free = []
  let next = 0
  while (next < candidates.length && free.length < SUGGESTIONS_OFFERED) {
    // Ask only for as many as are still needed, so a name is never checked once three are free.
    const wave = candidates.slice(next, next + SUGGESTIONS_OFFERED - free.length)
    next += wave.length
    const answers = await Promise.allSettled(wave.map((candidate) => api.checkUsername(candidate)))
    if (draft.value.username !== taken) return
    wave.forEach((candidate, i) => {
      if (answers[i].status === 'fulfilled' && answers[i].value.available) free.push(candidate)
    })
  }
  usernameSuggestions.value = free.slice(0, SUGGESTIONS_OFFERED)
}

// Use a suggested username. The field changes, so the "taken" message and the suggestions go away.
// How to call: pickUsername('testuser_888')
function pickUsername(name) {
  draft.value.username = name
}

// Is this email free to sign up with? False (with "already exists" under the field, beside the Log in link) when an
// account already uses it. The answer comes from the Jio backend, which allows only a few asks a minute for each caller,
// so this screen does say whether an email has an account; that is the one place it does. When the check cannot be made
// (no connection, over that limit, the backend or database not answering) the person goes on: the sign-up checks the
// email again at the end.
// How to call: if (await emailFree()) draft.value.step += 1
async function emailFree() {
  busy.value = true
  phase.value = 'checking-email'
  try {
    const { registered } = await api.checkEmail(draft.value.email.trim())
    if (registered) emailError.value = EMAIL_TAKEN
    return !registered
  } catch {
    return true
  } finally {
    busy.value = false
    phase.value = ''
  }
}

// The Next / Finish button: check this question, then go on to the next one, or create the account on the last.
// How to call: await next()
async function next() {
  if (step.value === 'email') emailTouched.value = true
  if (!canContinue.value || busy.value) return
  submitError.value = ''
  if (step.value === 'password' && reenter.value) {
    reenter.value = false
    draft.value.step = STEPS.length - 1
    return
  }
  if (step.value === 'email' && !(await emailFree())) return
  if (step.value === 'username' && !(await usernameFree())) return
  if (draft.value.step < STEPS.length - 1) draft.value.step += 1
  else finish()
}

// What the main button says: its usual word, or what is happening while it waits.
const buttonLabel = computed(() => {
  if (phase.value === 'checking') return 'Checking username'
  if (phase.value === 'checking-email') return 'Checking email'
  if (phase.value === 'creating') return 'Creating your account'
  return step.value === 'friends' ? 'Finish' : 'Next'
})

// Development builds only: the first question also offers the demo account, with or without showcase data
// (components/dev/DemoSignIn.vue). In a production build this is null, so the buttons and their words are left out.
const DemoSignIn = import.meta.env.DEV ? defineAsyncComponent(() => import('@/components/dev/DemoSignIn.vue')) : null

// Development builds only: skip the steps with a ready-made demo account. In a production build this is null, so the
// button and the demo account are left out.
const quickAccount = import.meta.env.DEV
  ? async () => {
      busy.value = true
      demoError.value = ''
      try {
        const { DEMO_ACCOUNT } = await import('@/components/dev/demoAccount.js')
        await auth.signUpAs(DEMO_ACCOUNT)
        router.replace('/')
      } catch (err) {
        demoError.value = err?.message || 'Could not create the demo account. Try again.'
      } finally {
        busy.value = false
      }
    }
  : null

// Create the account from the draft. On a problem, go back to the question it belongs to with the reason on the field.
// How to call: await finish()
async function finish() {
  // The password is emptied after every attempt, so a retry asks for it again before anything is sent.
  if (auth.realAccounts && !draft.value.password) {
    askForPassword()
    return
  }
  busy.value = true
  phase.value = 'creating'
  submitError.value = ''
  try {
    const account = await auth.signUp()
    // No account yet means the email must be confirmed first: "Check your email" is shown instead of the questions.
    if (account) router.replace('/')
  } catch (err) {
    // Show the data layer's message under the question it is about; otherwise above the button.
    const message = err?.message || 'Could not create your account. Try again.'
    const field = fieldForSignUpError(message)
    if (field === 'username') {
      usernameError.value = message
      if (err?.code === 'username_taken') suggestUsernames(draft.value.username)
    }
    else if (field === 'name') nameError.value = message
    else if (field === 'dob') dobError.value = message
    else submitError.value = message
    if (field) draft.value.step = STEPS.indexOf(field)
    if (auth.realAccounts) {
      reenter.value = true
      if (err?.code === 'email_taken' || err?.code === 'email_invalid') {
        // This email is already registered, or is not one: back to the email question, where the "Log in" link is.
        submitError.value = ''
        emailError.value = message
        draft.value.step = STEPS.indexOf('email')
      } else if (err?.code === 'signup_paused') {
        // Supabase is over a limit, which no answer can fix: stay on the last question with the message above the button.
        // The password was emptied, so pressing Finish again asks for it once and comes straight back here.
      } else if (!field) {
        // Nothing to fix in an answer (a weak password, no connection): the password is the thing to retype.
        askForPassword()
      }
    }
  } finally {
    busy.value = false
    phase.value = ''
  }
}

// Read the chosen picture, shrink it (lib/photo.js), and keep it in the draft.
// How to call: await onPhoto(event) (the file input's change)
async function onPhoto(event) {
  const file = event.target.files?.[0]
  photoError.value = ''
  if (!file) return
  try {
    draft.value.photo = await shrinkPhoto(file)
  } catch (err) {
    photoError.value = err.message
  }
}

// Pick a dietary need, or take it off. Any number can be picked, or none.
// How to call: toggleDiet('halal')
function toggleDiet(value) {
  const list = draft.value.dietary
  draft.value.dietary = list.includes(value) ? list.filter((d) => d !== value) : [...list, value]
}

// Add a suggested friend, or take them off the list.
// How to call: toggleFriend('darius')
function toggleFriend(id) {
  const list = draft.value.friends
  draft.value.friends = list.includes(id) ? list.filter((f) => f !== id) : [...list, id]
}

watch(() => draft.value.username, () => {
  usernameError.value = ''
  usernameUnchecked.value = ''
  usernameSuggestions.value = []
})
watch(() => draft.value.name, () => (nameError.value = ''))
watch(() => draft.value.dob, () => (dobError.value = ''))
</script>

<template>
  <main v-if="auth.pendingConfirmation" class="screen screen--form signup" data-testid="check-email">
    <header class="screen__header">
      <div class="screen__bar"><JioLogo :height="36" /></div>
    </header>
    <div class="screen__body signup__body">
      <h1 ref="confirmTitle" tabindex="-1" class="display-xl">Check your email</h1>
      <p class="body-md" role="status">We sent a link to <strong class="signup__address">{{ auth.pendingConfirmation.email }}</strong>. Open it to confirm your account, then log in.</p>
    </div>
    <footer class="screen__footer signup__footer">
      <AppButton next block to="/login">Log in</AppButton>
      <AppButton variant="tertiary" underline @click="changeEmail">Use a different email</AppButton>
    </footer>
  </main>

  <main v-else class="screen screen--form signup" data-testid="auth-view">
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton v-if="draft.step > 0" label="Back" @click="back"><AppIcon name="back" /></IconButton>
        <JioLogo v-else :height="36" />
      </div>
      <ProgressBar :value="draft.step + 1" :max="STEPS.length" label="Sign-up progress" />
    </header>

    <form class="screen__body signup__body" novalidate @submit.prevent="next">
      <template v-if="step === 'email'">
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Your email</h1>
        <TextField
          v-model="draft.email"
          label="Email"
          type="email"
          autocomplete="email"
          inputmode="email"
          autocapitalize="none"
          spellcheck="false"
          placeholder="name@example.com"
          :error="emailShown"
          autofocus
          @input="emailError = ''"
          @blur="emailTouched = true"
        />
        <div v-if="auth.realAccounts" class="signup__have">
          <span class="body-md text-muted">Already have an account?</span>
          <AppButton variant="tertiary" underline to="/login">Log in</AppButton>
        </div>
        <component :is="DemoSignIn" v-if="DemoSignIn" />
      </template>

      <template v-else-if="step === 'password'">
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Create a password</h1>
        <TextField v-model="draft.password" label="Password" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" :error="passwordError || passwordProblem" @input="passwordError = ''">
          <template #trailing>
            <button type="button" class="signup__peek" @click="showPassword = !showPassword">{{ showPassword ? 'Hide' : 'Show' }}</button>
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
      </template>

      <template v-else-if="step === 'name'">
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Your name</h1>
        <TextField v-model="draft.name" label="Name" autocomplete="given-name" placeholder="Ian" :maxlength="NAME_MAX" :hint="`Up to ${NAME_MAX} characters`" :error="nameError" />
      </template>

      <template v-else-if="step === 'dob'">
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Date of birth</h1>
        <TextField
          :model-value="dobText"
          label="Date of birth"
          inputmode="numeric"
          autocomplete="bday"
          placeholder="DD/MM/YYYY"
          maxlength="10"
          hint="DD/MM/YYYY, for example 18/03/2004. We need this to create your account."
          :error="dobError || dobInvalid"
          @update:model-value="onDobInput"
        />
      </template>

      <template v-else-if="step === 'username'">
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Pick a username</h1>
        <TextField
          v-model="draft.username"
          label="Username"
          autocomplete="nickname"
          autocapitalize="none"
          placeholder="ian"
          :hint="USERNAME_HINT"
          :error="usernameError"
          @input="draft.username = draft.username.toLowerCase()"
        />
        <div v-if="usernameSuggestions.length" class="signup__suggest" data-testid="username-suggestions">
          <p id="username-suggest-label" class="body-sm text-muted">These are free:</p>
          <div class="signup__chips" role="group" aria-labelledby="username-suggest-label">
            <ChipButton v-for="suggestion in usernameSuggestions" :key="suggestion" class="signup__suggestion" @click="pickUsername(suggestion)">{{ suggestion }}</ChipButton>
          </div>
        </div>
      </template>

      <template v-else-if="step === 'photo'">
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Profile photo</h1>
        <div class="signup__photo">
          <UserAvatar :name="draft.name || 'Ian'" :src="draft.photo" :size="96" />
          <label class="signup__upload">
            <AppIcon name="camera" />
            <span>{{ draft.photo ? 'Change photo' : 'Choose photo' }}</span>
            <input class="sr-only" type="file" accept="image/*" @change="onPhoto" />
          </label>
          <AppButton v-if="draft.photo" variant="tertiary" underline @click="draft.photo = ''">Remove photo</AppButton>
        </div>
        <p v-if="photoError" class="body-sm text-error" role="alert">{{ photoError }}</p>
      </template>

      <template v-else-if="step === 'home'">
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Home area</h1>
        <SelectField v-model="draft.homeAreaId" label="Area" placeholder="Choose an area" :options="areaOptions" />
      </template>

      <template v-else-if="step === 'diet'">
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Dietary needs</h1>
        <p id="diet-hint" class="body-md text-muted">Pick any that apply, or skip if none do.</p>
        <div class="signup__diet" role="group" aria-labelledby="diet-hint">
          <ChipButton
            v-for="option in DIETARY_OPTIONS"
            :key="option.value"
            check
            :selected="draft.dietary.includes(option.value)"
            @click="toggleDiet(option.value)"
          >
            {{ option.label }}
          </ChipButton>
        </div>
      </template>

      <template v-else-if="step === 'friends'">
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Suggested friends</h1>
        <ul>
          <ListRow v-for="person in people" :key="person.id" as="li" :title="person.name" :meta="`@${person.username} · ${person.homeArea}`">
            <template #leading><UserAvatar :name="person.name" /></template>
            <template #trailing>
              <ChipButton check :selected="draft.friends.includes(person.id)" @click="toggleFriend(person.id)">
                {{ draft.friends.includes(person.id) ? 'Added' : 'Add' }}
              </ChipButton>
            </template>
          </ListRow>
        </ul>
      </template>
    </form>

    <footer class="screen__footer signup__footer">
      <p v-if="demoError || auth.startOverError" class="body-sm text-error" role="alert">{{ demoError || auth.startOverError }}</p>
      <p v-if="submitError" class="body-sm text-error" role="alert" data-testid="signup-error">{{ submitError }}</p>
      <p v-if="phase" class="sr-only" role="status">{{ buttonLabel }}</p>
      <template v-if="step === 'photo'">
        <AppButton next block @click="next">{{ draft.photo ? 'Next' : 'Skip' }}</AppButton>
      </template>
      <template v-else-if="step === 'diet'">
        <AppButton next block @click="next">{{ draft.dietary.length ? 'Next' : 'None, skip' }}</AppButton>
      </template>
      <template v-else>
        <AppButton next block :disabled="!canContinue || busy" @click="next">{{ buttonLabel }}</AppButton>
      </template>
      <AppButton v-if="quickAccount && step !== 'email'" variant="tertiary" underline small class="signup__dev" :disabled="busy" @click="quickAccount">Dev: create a demo account</AppButton>
    </footer>
  </main>
</template>

<style scoped>
.signup { min-height: 100dvh; }
.signup__body { padding-top: var(--spacing-lg); }
.signup__dev { align-self: center; }
.signup__have { display: flex; flex-wrap: wrap; align-items: center; column-gap: var(--spacing-sm); }
/* The link is one short word, so it is given the smallest size a finger can press. */
.signup__have .btn { min-width: var(--tap-min); }
.signup__address { overflow-wrap: anywhere; }
/* The question heading takes focus for screen readers; it is not a control, so it shows no ring. */
.signup__body h1:focus, .signup__body h1:focus-visible { outline: none; }
.signup__peek { position: absolute; top: 6px; right: 6px; min-width: var(--tap-min); height: var(--tap-min); padding: 0 var(--spacing-md); border: 0; border-radius: var(--rounded-sm); background: transparent; color: var(--ink); font: var(--text-button-sm); text-decoration: underline; }
.checklist { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.checklist__item { display: flex; align-items: flex-start; gap: var(--spacing-sm); color: var(--muted); }
.checklist__text { display: flex; flex-direction: column; }
.checklist__hint { font: var(--text-caption); color: var(--muted); }
.checklist__item.is-ok { color: var(--ink); }
.checklist__mark { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: 1.5px solid var(--border-strong); border-radius: var(--rounded-full); color: var(--on-primary); }
.checklist__item.is-ok .checklist__mark { border-color: var(--selected); background: var(--selected); }
.signup__diet, .signup__chips { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
.signup__suggest { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.signup__photo { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-base); }
.signup__upload { display: inline-flex; align-items: center; gap: var(--spacing-sm); min-height: 48px; padding: 0 var(--spacing-lg); border: 1px solid var(--ink); border-radius: var(--rounded-sm); font: var(--text-button-md); cursor: pointer; }
.signup__upload:focus-within { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (hover: hover) { .signup__upload:hover { background: var(--surface-soft); } }
/* On desktop the footer buttons stay in the form column. */
@media (min-width: 1128px) {
  .signup__footer { flex-direction: column; align-items: stretch; border-top: 0; }
  .signup__footer > :deep(.btn--block) { width: 100%; }
}
</style>
