<script setup>
// Invite friends without leaving the session: a dialog over the page, so who is already in stays in view behind it.
//   <InviteDialog v-model:open="inviteOpen" :session="session" />
// An icon and a close button at the top, the title and a line on what happens, a search box, then friends (and
// suggested people) who are not in the session yet, each picked with a tap. At the bottom: how many are picked and
// Send invites (the close button is the way out, so there is no Cancel as well). Invites are pending until each friend accepts.
import { computed, nextTick, ref, useId, watch } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'

const open = defineModel('open', { type: Boolean, default: false })
const props = defineProps({ session: { type: Object, required: true } })

const events = useEventsStore()
const groups = useGroupsStore()
const titleId = `invite-${useId()}`
const panel = ref(null)
const search = ref(null)
const query = ref('')
const picked = ref([])
const busy = ref(false)
const error = ref('')
let opener = null

watch(open, async (isOpen) => {
  if (isOpen) {
    opener = document.activeElement
    query.value = ''
    picked.value = []
    error.value = ''
    if (!groups.people.length) groups.loadPeople()
    await nextTick()
    search.value?.focus()
  } else if (opener && typeof opener.focus === 'function') {
    opener.focus()
    opener = null
  }
})

// Anyone joined or already invited is not offered again.
const taken = (id) => props.session.members.some((m) => m.id === id && ['joined', 'invited'].includes(m.state))
const matches = (p) => {
  const q = query.value.trim().toLowerCase().replace(/^@/, '')
  return !q || p.name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q)
}
const lists = computed(() =>
  [
    { id: 'friends', title: 'Friends', people: groups.friends.filter((p) => !taken(p.id) && matches(p)) },
    { id: 'suggested', title: 'Suggested', people: groups.suggested.filter((p) => !taken(p.id) && matches(p)) },
  ].filter((l) => l.people.length),
)
const nobodyLeft = computed(() => !query.value.trim() && !lists.value.length)

function toggle(id) {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id]
}

function close() {
  open.value = false
}

async function send() {
  if (!picked.value.length || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await events.invite(props.session.id, picked.value)
    close()
  } catch (e) {
    error.value = e.message
  }
  busy.value = false
}
</script>

<template>
  <Teleport to="body">
    <Transition name="invite">
      <div v-if="open" class="invite-dialog" @keydown.esc="close">
        <button class="invite-dialog__scrim" type="button" tabindex="-1" aria-label="Close" @click="close" />
        <section ref="panel" class="invite-dialog__panel" role="dialog" aria-modal="true" :aria-labelledby="titleId">
          <header class="invite-dialog__head">
            <span class="invite-dialog__icon" aria-hidden="true"><AppIcon name="people" :size="22" /></span>
            <button type="button" class="invite-dialog__close" aria-label="Close" @click="close"><AppIcon name="close" :size="18" /></button>
          </header>
          <div class="invite-dialog__text">
            <h2 :id="titleId" class="title-md">Invite friends</h2>
            <p class="body-md text-muted">Add friends to {{ session.title }}. They join once they accept.</p>
          </div>

          <label class="invite-dialog__search">
            <span class="title-sm">Search</span>
            <span class="invite-dialog__field">
              <AppIcon name="search" :size="18" />
              <input ref="search" v-model="query" type="search" placeholder="Name or @username" autocomplete="off" />
            </span>
          </label>

          <div class="invite-dialog__lists">
            <p v-if="nobodyLeft" class="body-sm text-muted">Everyone you know is already in this session.</p>
            <p v-else-if="!lists.length" class="body-sm text-muted">Nobody matches “{{ query.trim() }}”.</p>
            <section v-for="list in lists" :key="list.id" class="invite-dialog__group" :aria-label="list.title">
              <h3 class="caption text-muted">{{ list.title }}</h3>
              <ul class="invite-dialog__list">
                <li v-for="person in list.people" :key="person.id">
                  <button type="button" class="invite-dialog__row" :class="{ 'is-picked': picked.includes(person.id) }" :aria-pressed="String(picked.includes(person.id))" @click="toggle(person.id)">
                    <UserAvatar :name="person.name" :person="person.id" :size="40" />
                    <span class="invite-dialog__who">
                      <span class="title-sm truncate">{{ person.name }}</span>
                      <span class="caption-sm text-muted truncate">@{{ person.username }}<template v-if="person.homeArea"> · {{ person.homeArea }}</template></span>
                    </span>
                    <span class="invite-dialog__check" aria-hidden="true"><AppIcon name="check" :size="14" /></span>
                  </button>
                </li>
              </ul>
            </section>
          </div>

          <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
          <footer class="invite-dialog__foot">
            <span class="caption text-muted tnum" aria-live="polite">{{ picked.length }} selected</span>
            <AppButton :disabled="!picked.length || busy" @click="send">Send invites</AppButton>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.invite-dialog { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; padding: var(--spacing-base); }
/* A light scrim, so the session behind (who is already in) stays readable. */
.invite-dialog__scrim { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; background: var(--scrim); opacity: 0.32; cursor: default; }
.invite-dialog__panel { position: relative; display: flex; flex-direction: column; gap: var(--spacing-base); width: 100%; max-width: 480px; max-height: calc(100dvh - var(--spacing-base) * 2); padding: var(--spacing-lg); border: 1px solid var(--hairline); border-radius: var(--rounded-lg); background: var(--canvas); box-shadow: var(--shadow-float); }
.invite-dialog__head { display: flex; align-items: flex-start; justify-content: space-between; }
.invite-dialog__icon { display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); }
.invite-dialog__close { display: inline-flex; align-items: center; justify-content: center; width: var(--tap-min); height: var(--tap-min); margin: -8px -8px 0 0; border: 0; border-radius: var(--rounded-full); background: transparent; color: var(--ink); cursor: pointer; }
@media (hover: hover) { .invite-dialog__close:hover { background: var(--surface-soft); } }
.invite-dialog__text { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.invite-dialog__text h2, .invite-dialog__text p { margin: 0; }
.invite-dialog__search { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.invite-dialog__field { display: flex; align-items: center; gap: var(--spacing-sm); height: 48px; padding: 0 var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-sm); background: var(--canvas); color: var(--muted); }
.invite-dialog__field:focus-within { border-color: var(--ink); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink) 12%, transparent); }
.invite-dialog__field input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--ink); font: var(--text-body-md); outline: none; }
.invite-dialog__field input::placeholder { color: var(--muted); }
/* The people: the list scrolls inside the dialog, so the buttons stay in view. */
.invite-dialog__lists { display: flex; flex-direction: column; gap: var(--spacing-base); min-height: 0; overflow-y: auto; margin: 0 calc(var(--spacing-sm) * -1); padding: 0 var(--spacing-sm); }
.invite-dialog__group { display: flex; flex-direction: column; gap: var(--spacing-xxs); }
.invite-dialog__group h3 { margin: 0; }
.invite-dialog__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.invite-dialog__row { display: flex; align-items: center; gap: var(--spacing-md); width: 100%; min-height: 60px; padding: var(--spacing-xs) var(--spacing-sm); border: 0; border-radius: var(--rounded-sm); background: transparent; color: var(--ink); text-align: left; cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out); }
@media (hover: hover) { .invite-dialog__row:hover { background: var(--surface-soft); } }
.invite-dialog__row.is-picked { background: color-mix(in srgb, var(--primary) 7%, var(--canvas)); }
.invite-dialog__who { display: flex; flex: 1; flex-direction: column; min-width: 0; }
/* A round check on the right: an empty ring, filled in Rausch when picked. */
.invite-dialog__check { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 1.5px solid var(--border-strong); border-radius: var(--rounded-full); color: transparent; transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
.is-picked .invite-dialog__check { border-color: var(--primary); background: var(--primary); color: var(--on-primary); }
.invite-dialog__foot { display: flex; align-items: center; gap: var(--spacing-sm); padding-top: var(--spacing-xs); }
.invite-dialog__foot > :first-child { margin-right: auto; }


.invite-enter-active { transition: opacity var(--motion-fast) var(--ease-out); }
.invite-leave-active { transition: opacity 150ms var(--ease-out); }
.invite-enter-active .invite-dialog__panel { transition: transform var(--motion-medium) var(--ease-sheet); }
.invite-enter-from, .invite-leave-to { opacity: 0; }
.invite-enter-from .invite-dialog__panel { transform: translateY(12px) scale(0.98); }
@media (prefers-reduced-motion: reduce) { .invite-enter-active .invite-dialog__panel { transition: none; } }
</style>
