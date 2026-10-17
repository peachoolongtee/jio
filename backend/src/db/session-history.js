import { createHash } from 'node:crypto'

const HISTORY_DAYS = 60
const SESSION_LIMIT = 500

function groupKey(memberIds) {
  return createHash('sha256').update([...memberIds].sort().join(':')).digest('hex')
}

// Completed outings count as the same group only when their joined member roster is identical.
// This gives the current schema a stable group identity without treating every session as its own group.
export async function loadCompletedGroupHistory({ supabase, userClient, sessionId, userId, today }) {
  const { data: current, error: currentError } = await userClient
    .from('sessions')
    .select('id')
    .eq('id', sessionId)
    .maybeSingle()
  if (currentError) throw new Error(`Could not load the session: ${currentError.message}`)
  if (!current) return { notFound: true, groupId: null, visitHistory: [] }

  const { data: currentMembers, error: currentMembersError } = await userClient
    .from('session_members')
    .select('user_id, state')
    .eq('session_id', sessionId)
  if (currentMembersError) throw new Error(`Could not load the session members: ${currentMembersError.message}`)

  const roster = (currentMembers ?? []).filter((m) => m.state === 'joined').map((m) => m.user_id.toLowerCase()).sort()
  if (!roster.includes(userId.toLowerCase()) || roster.length === 0) return { notFound: true, groupId: null, visitHistory: [] }
  const key = groupKey(roster)

  const cutoff = new Date(`${today}T00:00:00+08:00`)
  cutoff.setUTCDate(cutoff.getUTCDate() - HISTORY_DAYS)
  const cutoffDate = cutoff.toISOString().slice(0, 10)
  const { data: prior, error: priorError } = await supabase.service
    .from('sessions')
    .select('id, date, session_members(user_id, state)')
    .eq('status', 'completed')
    .gte('date', cutoffDate)
    .neq('id', sessionId)
    .order('date', { ascending: false })
    .limit(SESSION_LIMIT)
  if (priorError) throw new Error(`Could not load completed sessions: ${priorError.message}`)

  const rosterKey = (rows) => (rows ?? []).filter((m) => m.state === 'joined').map((m) => m.user_id.toLowerCase()).sort().join(':')
  const expected = roster.join(':')
  const matching = (prior ?? []).filter((s) => rosterKey(s.session_members) === expected)
  if (!matching.length) return { notFound: false, groupId: key, visitHistory: [] }

  const { data: stops, error: stopsError } = await supabase.service
    .from('stops')
    .select('session_id, venue_id')
    .in('session_id', matching.map((s) => s.id))
  if (stopsError) throw new Error(`Could not load completed stops: ${stopsError.message}`)
  const dateBySession = new Map(matching.map((s) => [s.id, s.date]))
  return {
    notFound: false,
    groupId: key,
    visitHistory: (stops ?? []).map((stop) => ({ venueId: stop.venue_id, groupId: key, date: dateBySession.get(stop.session_id) })),
  }
}
