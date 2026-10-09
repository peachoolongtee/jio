<script setup>
// Sign-up: one question per screen, with a back arrow and a progress bar.
// Email, password with a live checklist, name, username, profile photo (can be skipped), home area,
// location permission, contacts permission, suggested friends. It ends on Home.
// The answers live in the auth store's draft, so nothing is lost if the window is resized.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import IconButton from '@/components/ui/IconButton.vue'
import IllustrationBlob from '@/components/ui/IllustrationBlob.vue'
import ListRow from '@/components/ui/ListRow.vue'
import ProgressBar from '@/components/ui/ProgressBar.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextField from '@/components/ui/TextField.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import * as api from '@/lib/api.js'
import { useAuthStore } from '@/stores/auth.js'

const STEPS = ['email', 'password', 'name', 'username', 'photo', 'home', 'location', 'contacts', 'friends']

const router = useRouter()
const auth = useAuthStore()
const draft = computed(() => auth.draft)
const step = computed(() => STEPS[draft.value.step])

const areas = ref([])
const people = ref([])
const usernameError = ref('')
const photoError = ref('')
const busy = ref(false)
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

const emailValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.value.email.trim()))
const checks = computed(() => [
  { label: '8 or more characters', ok: draft.value.password.length >= 8 },
  { label: 'A letter', ok: /[a-z]/i.test(draft.value.password) },
  { label: 'A number', ok: /\d/.test(draft.value.password) },
  { label: 'A symbol', ok: /[^a-z0-9]/i.test(draft.value.password) },
])
const usernamePattern = /^[a-z0-9._]{3,20}$/

const canContinue = computed(() => {
  const d = draft.value
  switch (step.value) {
    case 'email': return emailValid.value
    case 'password': return checks.value.every((c) => c.ok)
    case 'name': return d.name.trim().length > 0
    case 'username': return usernamePattern.test(d.username)
    case 'home': return !!d.homeAreaId
    default: return true
  }
})

const areaOptions = computed(() => [...areas.value].sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({ value: a.id, label: a.name })))

function back() {
  if (draft.value.step > 0) draft.value.step -= 1
}

async function next() {
  if (!canContinue.value || busy.value) return
  if (step.value === 'username') {
    busy.value = true
    const { available } = await api.checkUsername(draft.value.username)
    busy.value = false
    if (!available) {
      usernameError.value = 'That username is taken. Try another one.'
      return
    }
  }
  if (draft.value.step < STEPS.length - 1) draft.value.step += 1
  else finish()
}

async function finish() {
  busy.value = true
  await auth.signUp()
  busy.value = false
  router.replace('/')
}

function onPhoto(event) {
  const file = event.target.files?.[0]
  photoError.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    photoError.value = 'Choose an image file.'
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    // Shrink the photo so it fits in local storage.
    const img = new Image()
    img.onload = () => {
      const size = 160
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const scale = Math.max(size / img.width, size / img.height)
      const w = img.width * scale
      const h = img.height * scale
      canvas.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
      draft.value.photo = canvas.toDataURL('image/jpeg', 0.8)
    }
    img.src = reader.result
  }
  reader.readAsDataURL(file)
}

function askLocation(allow) {
  draft.value.locationAllowed = allow
  if (allow && navigator.geolocation) {
    // Asks the browser for permission. The answer only matters later, when Ian uses his current location.
    navigator.geolocation.getCurrentPosition(() => {}, () => {}, { timeout: 8000 })
  }
  next()
}

function askContacts(allow) {
  draft.value.contactsAllowed = allow
  next()
}

function toggleFriend(id) {
  const list = draft.value.friends
  draft.value.friends = list.includes(id) ? list.filter((f) => f !== id) : [...list, id]
}

watch(() => draft.value.username, () => (usernameError.value = ''))
</script>

<template>
  <main class="screen screen--form signup" data-testid="auth-view">
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton v-if="draft.step > 0" label="Back" @click="back"><AppIcon name="back" /></IconButton>
        <span v-else class="display-xl text-brand" aria-label="Jio">Jio</span>
        <span class="caption text-muted">Step {{ draft.step + 1 }} of {{ STEPS.length }}</span>
      </div>
      <ProgressBar :value="draft.step + 1" :max="STEPS.length" label="Sign-up progress" />
    </header>

    <form class="screen__body signup__body" novalidate @submit.prevent="next">
      <template v-if="step === 'email'">
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Your email</h1>
        <TextField v-model="draft.email" label="Email" type="email" autocomplete="email" inputmode="email" placeholder="name@example.com" autofocus />
      </template>

      <template v-else-if="step === 'password'">
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Create a password</h1>
        <TextField v-model="draft.password" label="Password" :type="showPassword ? 'text' : 'password'" autocomplete="new-password">
          <template #trailing>
            <button type="button" class="signup__peek" :aria-pressed="String(showPassword)" @click="showPassword = !showPassword">{{ showPassword ? 'Hide' : 'Show' }}</button>
          </template>
        </TextField>
        <ul class="checklist" aria-label="Password checklist" aria-live="polite">
          <li v-for="check in checks" :key="check.label" class="checklist__item" :class="{ 'is-ok': check.ok }">
            <span class="checklist__mark"><AppIcon v-if="check.ok" name="check" :size="10" /></span>
            <span class="body-sm">{{ check.label }}</span>
            <span class="sr-only">{{ check.ok ? 'done' : 'not yet' }}</span>
          </li>
        </ul>
      </template>

      <template v-else-if="step === 'name'">
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Your name</h1>
        <TextField v-model="draft.name" label="Name" autocomplete="given-name" placeholder="Ian" />
      </template>

      <template v-else-if="step === 'username'">
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Pick a username</h1>
        <TextField
          v-model="draft.username"
          label="Username"
          autocomplete="username"
          autocapitalize="none"
          placeholder="ian"
          hint="3 to 20 letters, numbers, dots or underscores"
          :error="usernameError"
          @input="draft.username = draft.username.toLowerCase()"
        />
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

      <template v-else-if="step === 'location'">
        <IllustrationBlob name="invite" />
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Location</h1>
        <p class="body-md text-muted">Friends only see your area.</p>
      </template>

      <template v-else-if="step === 'contacts'">
        <IllustrationBlob name="profile" />
        <h1 ref="stepTitle" tabindex="-1" class="display-xl">Contacts</h1>

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
      <template v-if="step === 'location'">
        <AppButton block @click="askLocation(true)">Allow location</AppButton>
        <AppButton block variant="secondary" @click="askLocation(false)">Not now</AppButton>
      </template>
      <template v-else-if="step === 'contacts'">
        <AppButton block @click="askContacts(true)">Allow contacts</AppButton>
        <AppButton block variant="secondary" @click="askContacts(false)">Not now</AppButton>
      </template>
      <template v-else-if="step === 'photo'">
        <AppButton block @click="next">{{ draft.photo ? 'Next' : 'Skip' }}</AppButton>
      </template>
      <template v-else>
        <AppButton block :disabled="!canContinue || busy" @click="next">{{ step === 'friends' ? 'Finish' : 'Next' }}</AppButton>
      </template>
    </footer>
  </main>
</template>

<style scoped>
.signup { min-height: 100dvh; }
.signup__body { padding-top: var(--spacing-lg); }
/* The question heading takes focus for screen readers; it is not a control, so it shows no ring. */
.signup__body h1:focus, .signup__body h1:focus-visible { outline: none; }
.signup__peek { position: absolute; top: 6px; right: 6px; min-width: var(--tap-min); height: var(--tap-min); padding: 0 var(--spacing-md); border: 0; border-radius: var(--rounded-sm); background: transparent; color: var(--ink); font: var(--text-button-sm); text-decoration: underline; }
.checklist { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.checklist__item { display: flex; align-items: center; gap: var(--spacing-sm); color: var(--muted); }
.checklist__item.is-ok { color: var(--ink); }
.checklist__mark { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: 1.5px solid var(--border-strong); border-radius: var(--rounded-full); color: var(--on-primary); }
.checklist__item.is-ok .checklist__mark { border-color: var(--selected); background: var(--selected); }
.signup__photo { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-base); }
.signup__upload { display: inline-flex; align-items: center; gap: var(--spacing-sm); min-height: 48px; padding: 0 var(--spacing-lg); border: 1px solid var(--ink); border-radius: var(--rounded-sm); font: var(--text-button-md); cursor: pointer; }
.signup__upload:focus-within { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (hover: hover) { .signup__upload:hover { background: var(--surface-soft); } }
.signup__uses { display: grid; grid-template-columns: auto 1fr; gap: var(--spacing-sm) var(--spacing-base); align-items: baseline; margin: 0; }
.signup__uses dd { margin: 0; }
/* On desktop the footer buttons stay in the form column. */
@media (min-width: 1128px) {
  .signup__footer { flex-direction: column; align-items: stretch; border-top: 0; }
  .signup__footer > :deep(.btn--block) { width: 100%; }
}
</style>
