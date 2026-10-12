<script setup>
// Choose a new password: the page the reset email's link opens. Supabase reads the token in the link and signs the
// person in for this, so a signed-in person here means the link worked. Without one (the link was used, has expired, or
// this page was opened by hand) it says so and offers a new link.
// The new password follows the sign-up rule (lib/signupRules.js) and is typed twice. It goes to Supabase and is kept
// nowhere else; both fields are emptied after every attempt that fails.
import { computed, nextTick, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import JioLogo from '@/components/ui/JioLogo.vue'
import TextField from '@/components/ui/TextField.vue'
import { passwordRules } from '@/lib/signupRules.js'
import { useAuthStore } from '@/stores/auth.js'

const auth = useAuthStore()

const password = ref('')
const confirm = ref('')
const showPassword = ref(false)
const confirmError = ref('')
const error = ref('')
const busy = ref(false)
const done = ref(false)
// Set when Supabase says the session is gone, so the page turns into "this link has expired".
const expired = ref(false)
const doneTitle = ref(null)

const checks = computed(() => passwordRules(password.value))
const strong = computed(() => checks.value.every((c) => c.ok))
const linkWorks = computed(() => auth.signedIn && !expired.value)

// How to call: await submit()   (the form's submit, which Enter in either field also triggers)
async function submit() {
  if (busy.value || !strong.value) return
  error.value = ''
  confirmError.value = ''
  if (confirm.value !== password.value) {
    confirmError.value = 'The two passwords do not match.'
    return
  }
  busy.value = true
  try {
    await auth.changePassword(password.value)
    done.value = true
    await nextTick()
    doneTitle.value?.focus()
  } catch (err) {
    if (err?.code === 'reset_link_invalid') expired.value = true
    error.value = err?.message || 'Something went wrong. Try again.'
  } finally {
    password.value = ''
    confirm.value = ''
    busy.value = false
  }
}
</script>

<template>
  <main v-if="done" class="screen screen--form reset" data-testid="reset-done">
    <header class="screen__header">
      <div class="screen__bar"><JioLogo :height="36" /></div>
    </header>
    <div class="screen__body reset__body">
      <h1 ref="doneTitle" tabindex="-1" class="display-xl">Password changed</h1>
      <p class="body-md" role="status">Your new password is set. Use it the next time you log in.</p>
    </div>
    <footer class="screen__footer reset__footer">
      <AppButton next block to="/">Continue to Jio</AppButton>
    </footer>
  </main>

  <main v-else-if="!linkWorks" class="screen screen--form reset" data-testid="reset-link-invalid">
    <header class="screen__header">
      <div class="screen__bar"><JioLogo :height="36" /></div>
    </header>
    <div class="screen__body reset__body">
      <h1 class="display-xl">Link expired</h1>
      <p class="body-md" role="alert">This reset link has expired or has already been used. Ask for a new one.</p>
    </div>
    <footer class="screen__footer reset__footer">
      <AppButton next block to="/forgot-password">Send a new link</AppButton>
      <AppButton variant="tertiary" underline to="/login">Back to log in</AppButton>
    </footer>
  </main>

  <main v-else class="screen screen--form reset" data-testid="reset-view">
    <header class="screen__header">
      <div class="screen__bar"><JioLogo :height="36" /></div>
    </header>

    <form id="reset-form" class="screen__body reset__body" novalidate @submit.prevent="submit">
      <h1 class="display-xl">Choose a new password</h1>
      <TextField id="reset-password" v-model="password" label="New password" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" autofocus @input="error = ''">
        <template #trailing>
          <button type="button" class="reset__peek" @click="showPassword = !showPassword">{{ showPassword ? 'Hide' : 'Show' }}</button>
        </template>
      </TextField>
      <ul class="checklist" aria-label="Password checklist" aria-live="polite">
        <li v-for="check in checks" :key="check.label" class="checklist__item" :class="{ 'is-ok': check.ok }">
          <span class="checklist__mark"><AppIcon v-if="check.ok" name="check" :size="10" /></span>
          <span class="body-sm">{{ check.label }}</span>
          <span class="sr-only">{{ check.ok ? 'done' : 'not yet' }}</span>
        </li>
      </ul>
      <TextField
        id="reset-confirm"
        v-model="confirm"
        label="Type it again"
        :type="showPassword ? 'text' : 'password'"
        autocomplete="new-password"
        :error="confirmError"
        @input="confirmError = ''"
      />
      <p v-if="error" class="body-sm text-error" role="alert" data-testid="reset-error">{{ error }}</p>
    </form>

    <footer class="screen__footer reset__footer">
      <AppButton next block type="submit" form="reset-form" :disabled="busy || !strong || !confirm">{{ busy ? 'Saving' : 'Save new password' }}</AppButton>
    </footer>
  </main>
</template>

<style scoped>
.reset { min-height: 100dvh; }
.reset__body { padding-top: var(--spacing-lg); }
.reset__body h1:focus, .reset__body h1:focus-visible { outline: none; }
.reset__peek { position: absolute; top: 6px; right: 6px; min-width: var(--tap-min); height: var(--tap-min); padding: 0 var(--spacing-md); border: 0; border-radius: var(--rounded-sm); background: transparent; color: var(--ink); font: var(--text-button-sm); text-decoration: underline; }
.checklist { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.checklist__item { display: flex; align-items: center; gap: var(--spacing-sm); color: var(--muted); }
.checklist__item.is-ok { color: var(--ink); }
.checklist__mark { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: 1.5px solid var(--border-strong); border-radius: var(--rounded-full); color: var(--on-primary); }
.checklist__item.is-ok .checklist__mark { border-color: var(--selected); background: var(--selected); }
/* On desktop the footer buttons stay in the form column. */
@media (min-width: 1128px) {
  .reset__footer { flex-direction: column; align-items: stretch; border-top: 0; }
  .reset__footer > :deep(.btn--block) { width: 100%; }
}
</style>
