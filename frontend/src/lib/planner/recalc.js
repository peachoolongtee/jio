// Re-calculation: what happens when a person changes a start or end location, adds one late, or opts out.
//
// Before Confirmed
// - Re-calculate the meeting area at once.
// - If it stays the same, keep all votes.
// - If it moves, refresh the suggestions and clear the place votes. Category and timing choices stay.
// - Show a banner that says what changed and why.
// After Confirmed
// - Never change the plan silently. Ask "Re-plan?" with the reason. Accepting returns the session to Voting;
//   declining keeps the plan.

// trigger: { kind: 'start' | 'end' | 'added' | 'optout', personName }
export function describeTrigger(trigger) {
  const name = trigger.personName
  if (trigger.kind === 'start') return `${name}'s start location changed`
  if (trigger.kind === 'end') return `${name}'s end location changed`
  if (trigger.kind === 'added') return `${name} added a start location`
  if (trigger.kind === 'optout') return `${name} opted out`
  return 'the group changed'
}

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1)

// previousName / nextName: area names, or null when there is no meeting area.
export function recalcBanner({ previousName, nextName, trigger }) {
  const reason = describeTrigger(trigger)
  if (previousName && nextName && previousName !== nextName) return `Meeting area moved from ${previousName} to ${nextName} because ${reason}.`
  if (previousName && nextName) return `Meeting area stays at ${previousName}. ${capitalise(reason)}.`
  if (!previousName && nextName) return `Meeting area set to ${nextName} because ${reason}.`
  if (previousName && !nextName) return `Meeting area cleared because ${reason}. It needs at least 2 locations.`
  return `${capitalise(reason)}.`
}

// status: the session status. previous / next: meeting results ({ areaId }) or null.
// Returns what the session should do.
export function recalculate({ status, previous, next, trigger, previousName = null, nextName = null }) {
  const moved = (previous?.areaId ?? null) !== (next?.areaId ?? null)
  if (status === 'confirmed') {
    const outcome = moved && nextName ? `The fairest meeting area is now ${nextName}.` : nextName ? `The meeting area would stay at ${nextName}.` : ''
    return {
      mode: 'prompt',
      moved,
      keepPlan: true,
      reason: `${capitalise(describeTrigger(trigger))}.${outcome ? ' ' + outcome : ''}`,
    }
  }
  if (status === 'completed' || status === 'cancelled') return { mode: 'none', moved: false }
  const voting = status === 'voting'
  return {
    mode: 'apply',
    meeting: next,
    moved,
    clearVotes: voting && moved,
    refreshSuggestions: voting && moved,
    keepPreferences: true,
    // First locations arriving while Locating update the area live, without a banner.
    banner: trigger.kind === 'added' && status !== 'voting' ? null : recalcBanner({ previousName, nextName, trigger }),
  }
}
