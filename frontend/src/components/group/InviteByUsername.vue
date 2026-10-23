<script setup>
// Invite a person to a shared session by their username: type the start of it, pick the person from what comes up, invite
// them. They see the invitation on Home and accept or decline it. From the third character, a moment after the last key, up to
// five people whose username starts with what was typed appear (the exact match first, then people the host has met in a
// session). Nothing is invited by typing or by Enter.
//   <InviteByUsername :session="session" />
// Keyboard: this is a plain list of rows, each with an Invite button, not a combobox. A row holds a button and a sentence, which
// an ARIA listbox option may not, and the order of Tab is already the order of the screen. Enter or the down arrow in the field
// moves to the first Invite button; the up and down arrows move between the buttons, and up from the first returns to the field.
// States: under three letters (a hint), looking (a spinner replaces the magnifier), found (people with an Invite button, or why a
// person cannot be invited), nobody found, a failed search (with Try again), a failed invitation (a sentence), invited (a line
// that says so). A screen reader hears the count, or the failure, as a polite status.
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import TextField from '../ui/TextField.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import * as api from '@/lib/api.js'
import { PEOPLE_SEARCH_MAX, PEOPLE_SEARCH_MIN, createPeopleSearch } from '@/lib/peopleSearch.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ session: { type: Object, required: true } })

const events = useEventsStore()
// The field and the list are found by id (not by a template ref), so a second copy of this component on the page keeps its own.
const fieldId = `byname-field-${useId()}`
const listId = `byname-list-${useId()}`
const { text, phase, people, error: searchError, retry, clear, dispose } = createPeopleSearch({ search: (term, options) => api.searchPeople(term, options) })
const invitingId = ref('')
const inviteError = ref('')
const done = ref('')

// A search is wanted or running; the list is dimmed and cannot be pressed until it answers.
const pending = computed(() => phase.value === 'waiting' || phase.value === 'looking')
const empty = computed(() => phase.value === 'done' && !people.value.length)
const NOBODY = "Nobody's username starts with that."
// What a screen reader hears when a search ends: how many came back, or what went wrong. Nothing while it is still going.
const announcement = computed(() => {
  if (phase.value === 'failed') return searchError.value
  if (phase.value !== 'done') return ''
  const count = people.value.length
  return count ? `${count} ${count === 1 ? 'person' : 'people'} found` : NOBODY
})

// Why this person cannot be invited, or '' when they can.
// How to call: why({ id: '7f3c...' }) -> 'Already in this session.'
function why(person) {
  const member = props.session.members.find((m) => m.id === person.id)
  if (!member) return ''
  return member.state === 'invited' ? 'Already invited.' : 'Already in this session.'
}

// The field's input, or null. How to call: inputEl()?.focus()
const inputEl = () => document.getElementById(fieldId)
const buttons = () => [...(document.getElementById(listId)?.querySelectorAll('button') ?? [])]

// Empty the field and put the cursor back in it, so a keyboard user carries on typing. How to call: clearAndFocus()
function clearAndFocus() {
  clear()
  inputEl()?.focus()
}

// Move to the first Invite button, or try the search again when it failed. Enter and the down arrow do this and nothing else.
// How to call: onFieldKey(event)
function onFieldKey(event) {
  if (event.key === 'Enter' || event.key === 'ArrowDown') {
    event.preventDefault()
    const first = buttons()[0]
    if (first) first.focus()
    else if (event.key === 'Enter' && phase.value === 'failed') retry()
  }
}

// The arrow keys move between the Invite buttons; up from the first goes back to the field. How to call: onListKey(event)
function onListKey(event) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const all = buttons()
  const at = all.indexOf(event.target.closest('button'))
  if (at < 0) return
  event.preventDefault()
  if (event.key === 'ArrowDown') all[Math.min(at + 1, all.length - 1)].focus()
  else if (at === 0) inputEl()?.focus()
  else all[at - 1].focus()
}

onBeforeUnmount(dispose)

// Invite this person. A second press while it is sent does nothing (the button is not disabled, so focus stays on it).
// How to call: await invite({ id: '7f3c...', name: 'Sam Tan' })
async function invite(person) {
  if (invitingId.value || why(person)) return
  invitingId.value = person.id
  inviteError.value = ''
  try {
    await events.inviteByUsername(props.session.id, person.id)
    clear()
    done.value = `${person.name} is invited. They will see it on their Home screen.`
    invitingId.value = ''
    // The row that held focus is gone, so focus goes back to the field.
    await nextTick()
    inputEl()?.focus()
  } catch (e) {
    inviteError.value = e?.message || 'The invitation could not be sent. Try again.'
    invitingId.value = ''
  }
}
</script>

<template>
  <section class="byname" aria-labelledby="byname-head" data-testid="invite-by-username">
    <h3 id="byname-head" class="title-sm"><label :for="fieldId">Invite by username</label></h3>
    <TextField
      v-model="text"
      :id="fieldId"
      label="Search by username"
      hide-label
      type="text"
      placeholder="Search by username"
      autocomplete="off"
      autocapitalize="none"
      spellcheck="false"
      :maxlength="PEOPLE_SEARCH_MAX + 1"
      :hint="phase === 'short' ? `Type at least ${PEOPLE_SEARCH_MIN} letters of their username` : ''"
      @keydown="onFieldKey"
      @input="inviteError = ''; done = ''"
    >
      <template #leading>
        <span v-if="pending" class="byname__spin" data-testid="invite-searching" />
        <AppIcon v-else name="search" :size="16" />
      </template>
      <template #trailing>
        <button v-if="text" type="button" class="byname__clear" aria-label="Clear search" @click="clearAndFocus">
          <AppIcon name="close" :size="16" />
        </button>
      </template>
    </TextField>

    <div class="byname__results" :aria-busy="pending ? 'true' : undefined">
      <ul v-if="people.length && phase !== 'failed'" :id="listId" class="byname__list" :class="{ 'is-waiting': pending }" :inert="pending || undefined" aria-label="People found" @keydown="onListKey">
        <li v-for="person in people" :key="person.id" class="byname__found" data-testid="invite-result">
          <UserAvatar :name="person.name" :src="person.avatarUrl" :person="person.id" :size="44" />
          <span class="byname__who">
            <span class="title-sm truncate">{{ person.name }}</span>
            <span class="caption-sm text-muted truncate">@{{ person.username }}</span>
          </span>
          <span v-if="why(person)" class="caption text-muted">{{ why(person) }}</span>
          <AppButton v-else small :aria-label="`Invite ${person.name}`" :aria-busy="invitingId === person.id ? 'true' : undefined" @click="invite(person)">{{ invitingId === person.id ? 'Inviting' : 'Invite' }}</AppButton>
        </li>
      </ul>
      <p v-if="empty" class="body-sm text-muted">{{ NOBODY }}</p>
      <div v-if="phase === 'failed'" class="byname__failed">
        <p class="body-sm text-error">{{ searchError }}</p>
        <AppButton small variant="secondary" @click="retry">Try again</AppButton>
      </div>
    </div>

    <p v-if="inviteError" class="body-sm text-error" role="alert">{{ inviteError }}</p>
    <p class="sr-only" role="status">{{ announcement }}</p>
    <p v-if="done" class="body-sm" role="status">{{ done }}</p>
  </section>
</template>

<style scoped>
.byname { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.byname h3 { margin: 0; }
/* Room on the right for the clear button; the 1px the focus border adds comes out of the padding, as in TextField. */
.byname :deep(.field__control .field__input) { padding-right: 52px; }
.byname :deep(.field__control .field__input:focus) { padding-right: 51px; }
.byname__spin { width: 16px; height: 16px; border: 2px solid var(--hairline); border-top-color: var(--ink); border-radius: var(--rounded-full); animation: byname-spin 800ms linear infinite; }
@keyframes byname-spin { to { transform: rotate(360deg); } }
.byname__clear { position: absolute; top: 6px; right: 6px; display: inline-flex; align-items: center; justify-content: center; width: var(--tap-min); height: var(--tap-min); margin: 0; padding: 0; border: 0; border-radius: var(--rounded-full); background: transparent; color: var(--muted); cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
@media (hover: hover) {
  .byname__clear:hover { background: var(--hairline-soft); color: var(--ink); }
}
.byname__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; transition: opacity var(--motion-fast) var(--ease-out); }
.byname__list.is-waiting { opacity: 0.6; }
.byname__found { display: flex; align-items: center; gap: var(--spacing-md); min-height: 68px; }
.byname__who { display: flex; flex: 1 1 0; flex-direction: column; min-width: 0; }
.byname__failed { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-sm); }
</style>
