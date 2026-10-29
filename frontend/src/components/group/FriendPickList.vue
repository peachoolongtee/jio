<script setup>
// The friends a host can pick on the Invite page, in their groups ("Frequent hangouts", then "All friends", or one "Friends"
// list), each with their Jio streak and a Select chip. The page keeps who is picked; this only draws the lists and says which
// row was pressed. Used for the demo's sessions and for a real account's shared ones alike.
//   <FriendPickList :lists="lists" :picked="picked" @toggle="toggle" />
// lists: [{ id, title, people: [{ id, name, username, homeArea, streak }] }]; a list with nobody in it is hidden.
import AppIcon from '@/components/ui/AppIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { streakText } from '@/lib/hangouts.js'

defineProps({
  lists: { type: Array, required: true },
  picked: { type: Array, required: true },
})
const emit = defineEmits(['toggle'])
</script>

<template>
  <section v-for="list in lists" v-show="list.people.length" :key="list.id" class="invite__group" :aria-labelledby="`invite-${list.id}`">
    <h3 :id="`invite-${list.id}`" class="caption text-muted">{{ list.title }}</h3>
    <ul class="invite__list">
      <li v-for="person in list.people" :key="person.id" class="invite__row" :class="{ 'is-picked': picked.includes(person.id) }">
        <UserAvatar :name="person.name" :person="person.id" :size="44" />
        <span class="invite__who">
          <span class="invite__name">
            <span class="title-sm truncate">{{ person.name }}</span>
            <span v-if="person.streak" class="invite__streak caption-sm tnum" :title="`Jio streak: ${streakText(person.streak)}`" data-testid="jio-streak">
              <AppIcon name="sparkle" :size="12" /><span class="sr-only">Jio streak: {{ streakText(person.streak) }}</span><span aria-hidden="true">{{ person.streak }}</span>
            </span>
          </span>
          <span class="caption-sm text-muted truncate">@{{ person.username }}<template v-if="person.homeArea"> · {{ person.homeArea }}</template></span>
        </span>
        <ChipButton check :selected="picked.includes(person.id)" :aria-label="`Invite ${person.name}`" @click="emit('toggle', person.id)">
          {{ picked.includes(person.id) ? 'Selected' : 'Select' }}
        </ChipButton>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.invite__group { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.invite__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.invite__row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 68px; padding: var(--spacing-sm) var(--spacing-sm); border-radius: var(--rounded-sm); transition: background-color var(--motion-fast) var(--ease-out); }
.invite__row.is-picked { background: color-mix(in srgb, var(--primary) 6%, var(--canvas)); }
.invite__who { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.invite__name { display: flex; align-items: center; gap: var(--spacing-xs); min-width: 0; }
/* The Jio streak: a small count of outings together beside the name, in the brand's soft tint. */
.invite__streak { flex-shrink: 0; display: inline-flex; align-items: center; gap: 2px; height: 20px; padding: 0 6px; border-radius: var(--rounded-full); background: color-mix(in srgb, var(--primary) 10%, var(--canvas)); color: var(--primary-active); font-weight: 600; }
</style>
