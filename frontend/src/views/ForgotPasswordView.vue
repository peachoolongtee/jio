<script setup>
// Forgot password: one email field and one button. Supabase emails a link that opens /reset-password. The page says the
// same thing whether or not the email has an account, so this page gives nothing away about who is registered. The email
// typed on the login page arrives in the page's history state (never in the address) and fills the field.
// Only reached when accounts are real (the router sends this page to /signup otherwise).
import { nextTick, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import IconButton from '@/components/ui/IconButton.vue'
import TextField from '@/components/ui/TextField.vue'
import { validateEmail } from '@/lib/signupRules.js'
import { useAuthStore } from '@/stores/auth.js'

const auth = useAuthStore()

const handed = typeof window !== 'undefined' ? window.history.state?.email : ''
const email = ref(typeof handed === 'string' ? handed : '')
const emailError = ref('')
const error = ref('')
const busy = ref(false)
// The address the link was sent to, once it has been sent: "Check your email" replaces the form.
const sentTo = ref('')
const sentTitle = ref(null)

// How to call: await submit()   (the form's submit, which Enter in the field also triggers)
async function submit() {
  if (busy.value) return
  error.value = ''
  emailError.value = validateEmail(email.value)
  if (emailError.value) {
    await nextTick()
    document.getElementById('forgot-email')?.focus()
    return
  }
  busy.value = true
  try {
    await auth.requestPasswordReset(email.value.trim())
    sentTo.value = email.value.trim()
    await nextTick()
    sentTitle.value?.focus()
  } catch (err) {
    error.value = err?.message || 'Something went wrong. Try again.'
  } finally {
    busy.value = false
  }
}

// Back to the form, to send the link again or to another address.
// How to call: tryAgain()
function tryAgain() {
  sentTo.value = ''
}
</script>

<template>
  <main v-if="sentTo" class="screen screen--form forgot" data-testid="reset-sent">
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton label="Back to log in" to="/login"><AppIcon name="back" /></IconButton>
      </div>
    </header>
    <div class="screen__body forgot__body">
      <h1 ref="sentTitle" tabindex="-1" class="display-xl">Check your email</h1>
      <p class="body-md" role="status">
        If an account uses <strong class="forgot__address">{{ sentTo }}</strong>, we have sent it a link to choose a new password.
        The link works once. Check your spam folder if it does not arrive in a few minutes.
      </p>
    </div>
    <footer class="screen__footer forgot__footer">
      <AppButton next block to="/login">Back to log in</AppButton>
      <AppButton variant="tertiary" underline @click="tryAgain">Send it again</AppButton>
    </footer>
  </main>

  <main v-else class="screen screen--form forgot" data-testid="forgot-view">
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton label="Back to log in" to="/login"><AppIcon name="back" /></IconButton>
      </div>
    </header>

    <form id="forgot-form" class="screen__body forgot__body" novalidate @submit.prevent="submit">
      <h1 class="display-xl">Forgot password</h1>
      <p class="body-md text-muted">Enter the email you signed up with. We will send you a link to choose a new password.</p>
      <TextField
        id="forgot-email"
        v-model="email"
        label="Email"
        type="email"
        autocomplete="username"
        inputmode="email"
        autocapitalize="none"
        spellcheck="false"
        placeholder="name@example.com"
        :error="emailError"
        autofocus
        @input="emailError = ''"
      />
      <p v-if="error" class="body-sm text-error" role="alert" data-testid="forgot-error">{{ error }}</p>
    </form>

    <footer class="screen__footer forgot__footer">
      <AppButton next block type="submit" form="forgot-form" :disabled="busy">{{ busy ? 'Sending link' : 'Send reset link' }}</AppButton>
    </footer>
  </main>
</template>

<style scoped>
.forgot { min-height: 100dvh; }
.forgot__body { padding-top: var(--spacing-lg); }
.forgot__address { overflow-wrap: anywhere; }
.forgot__body h1:focus, .forgot__body h1:focus-visible { outline: none; }
/* On desktop the footer buttons stay in the form column. */
@media (min-width: 1128px) {
  .forgot__footer { flex-direction: column; align-items: stretch; border-top: 0; }
  .forgot__footer > :deep(.btn--block) { width: 100%; }
}
</style>
