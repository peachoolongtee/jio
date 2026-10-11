<script setup>
// Log in: an email and a password, one button, a link to sign up. Only reached when accounts are real (the router sends
// /login to /signup otherwise). On success it goes to the page the person was heading for (?next=, checked to be a path
// inside this app) or to Home. The email and password are never put in the address.
// A wrong password and an unknown email give the same sentence (lib/auth.js), shown as it is under the fields.
import { nextTick, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import JioLogo from '@/components/ui/JioLogo.vue'
import TextField from '@/components/ui/TextField.vue'
import { safeNext } from '@/router/guard.js'
import { useAuthStore } from '@/stores/auth.js'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// After a sign-up that needed the email confirmed, the address typed there is already filled in.
const email = ref(auth.pendingConfirmation?.email || '')
const password = ref('')
const error = ref('')
const busy = ref(false)
const showPassword = ref(false)

const emailValid = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())

// Where to go once signed in: the remembered page when it is a real screen of this app, otherwise Home.
// How to call: afterLogin() -> '/sessions/s1'
function afterLogin() {
  const next = safeNext(route.query.next)
  if (!next || router.resolve(next).name === 'not-found') return '/'
  return next
}

// Focus the password again after a failed attempt (it was emptied), or the email when that is what needs fixing.
// How to call: await refocus('login-password')
async function refocus(id) {
  await nextTick()
  document.getElementById(id)?.focus()
}

// How to call: await submit()   (the form's submit, which Enter in either field also triggers)
async function submit() {
  if (busy.value) return
  error.value = ''
  if (!emailValid(email.value)) {
    error.value = 'Enter the email address you signed up with.'
    await refocus('login-email')
    return
  }
  if (!password.value) {
    error.value = 'Enter your password.'
    await refocus('login-password')
    return
  }
  busy.value = true
  try {
    await auth.signIn(email.value, password.value)
    password.value = ''
    await router.replace(afterLogin())
  } catch (err) {
    // Show the data layer's sentence as it is. The password is emptied; the email stays.
    error.value = err?.message || 'Something went wrong. Try again.'
    password.value = ''
    await refocus('login-password')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="screen screen--form login" data-testid="login-view">
    <header class="screen__header">
      <div class="screen__bar"><JioLogo :height="36" /></div>
    </header>

    <form id="login-form" class="screen__body login__body" novalidate @submit.prevent="submit">
      <h1 class="display-xl">Log in</h1>
      <TextField
        id="login-email"
        v-model="email"
        label="Email"
        type="email"
        autocomplete="username"
        inputmode="email"
        autocapitalize="none"
        spellcheck="false"
        placeholder="name@example.com"
        autofocus
      />
      <TextField id="login-password" v-model="password" label="Password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password">
        <template #trailing>
          <button type="button" class="login__peek" :aria-pressed="String(showPassword)" @click="showPassword = !showPassword">{{ showPassword ? 'Hide' : 'Show' }}</button>
        </template>
      </TextField>
      <p v-if="error" class="body-sm text-error" role="alert" data-testid="login-error">{{ error }}</p>
    </form>

    <footer class="screen__footer login__footer">
      <AppButton next block type="submit" form="login-form" :disabled="busy">{{ busy ? 'Logging in' : 'Log in' }}</AppButton>
      <AppButton variant="tertiary" underline to="/signup" class="login__alt">New to Jio? Sign up</AppButton>
    </footer>
  </main>
</template>

<style scoped>
.login { min-height: 100dvh; }
.login__body { padding-top: var(--spacing-lg); }
.login__alt { align-self: center; }
.login__peek { position: absolute; top: 6px; right: 6px; min-width: var(--tap-min); height: var(--tap-min); padding: 0 var(--spacing-md); border: 0; border-radius: var(--rounded-sm); background: transparent; color: var(--ink); font: var(--text-button-sm); text-decoration: underline; }
/* On desktop the footer buttons stay in the form column. */
@media (min-width: 1128px) {
  .login__footer { flex-direction: column; align-items: stretch; border-top: 0; }
  .login__footer > :deep(.btn--block) { width: 100%; }
}
</style>
