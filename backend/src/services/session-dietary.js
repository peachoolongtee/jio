// What an outing's dietary needs look like to one member (ticket #107, and the changes for one outing). Pure functions over the rows the server
// reads (db/sessions.js loadOutingDietary); GET and PUT /api/sessions/:id/dietary and every ranking use them. The privacy rule is here: a need is
// private (profile_private is read by its owner and the server only), so no answer says whose a need is, how many people have it, or anything
// else of a member's private row, and with fewer than three joined nothing a member can read says anything about another member's needs.
//
// How to call:
//   const view = dietaryView({ me: userId, joined: 3, hostId, rows, saved, dropped })
//   // { dietary: ['halal'], others: ['halal'], mine: [], checked: false, dropped: [] }

// The dietary needs a person can have. Anything else in the database is left out of every answer.
export const NEEDS = ['halal', 'vegetarian', 'vegan']

// How many joined members an outing needs before the others' needs are told to a member, and before the host may drop a need. With fewer, the
// others' list would be one known person's own list (two members), so it is empty. How to call: joined >= MIN_MEMBERS_FOR_OTHERS
export const MIN_MEMBERS_FOR_OTHERS = 3

// Needs from many lists, each once, in the app's order. How to call: needsOf([['vegan'], ['halal', 'vegan'], null]) -> ['halal', 'vegan']
export const needsOf = (lists) => NEEDS.filter((need) => lists.some((list) => Array.isArray(list) && list.includes(need)))

// The needs in `list` that are not in `taken`, in the app's order. How to call: without(['halal', 'vegan'], ['vegan']) -> ['halal']
export const without = (list, taken) => list.filter((need) => !taken.includes(need))

// Do two lists of needs hold the same needs? How to call: sameNeeds(['vegan', 'halal'], ['halal', 'vegan']) -> true
export const sameNeeds = (a, b) => needsOf([a]).join() === needsOf([b]).join()

// Is this need held by a joined member other than the host? A drop is the host's about the needs of others, so a need only the host has (or
// nobody) is not one a drop can still be for. How to call: heldByOthers(rows, 'halal', hostId)
export const heldByOthers = (rows, need, hostId) =>
  rows.some((row) => String(row.user_id).toLowerCase() !== hostId && Array.isArray(row.dietary) && row.dietary.includes(need))

// The stored drops that are in force: none with fewer than three joined, and only those a joined member other than the host still holds. A
// drop that is not in force is ignored, and never outlives its need (db/sessions.js loadOutingDietary clears it).
// How to call: dropsInForce({ rows, dropped: ['halal'], joined: 3, hostId }) -> ['halal']
export const dropsInForce = ({ rows, dropped, joined, hostId }) =>
  joined >= MIN_MEMBERS_FOR_OTHERS ? dropped.filter((need) => heldByOthers(rows, need, hostId)) : []

// The needs the group is planned for: everyone's together, without the drops in force. How to call: effectiveNeeds({ rows, dropped, joined, hostId })
export const effectiveNeeds = ({ rows, dropped, joined, hostId }) => without(needsOf(rows.map((r) => r.dietary)), dropsInForce({ rows, dropped, joined, hostId }))

// The members' private needs as a ranking reads them: each row's dietary needs without the drops in force. `rows` are the joined members the
// ranking is for. How to call: needsInEffect({ rows, dropped: ['halal'], joined: 3, hostId }) -> [{ user_id, dietary: ['vegan'], … }, …]
export function needsInEffect({ rows, dropped, joined, hostId }) {
  const off = dropsInForce({ rows, dropped, joined, hostId })
  if (off.length === 0) return rows
  return rows.map((row) => ({ ...row, dietary: Array.isArray(row.dietary) ? row.dietary.filter((need) => !off.includes(need)) : row.dietary }))
}

// The answer for one member.
//   dietary  the group's needs in effect (everyone's for the outing, without the dropped ones); with fewer than three joined, the caller's own
//            list alone (the places are still picked for everyone's, but a list that said more would be the other person's)
//   others   everyone's but the caller's, dropped ones included so the host can take a drop back; empty under three joined
//   mine     the caller's own needs for the outing (their row for it, else their profile's)
//   checked  whether the caller confirmed their needs for this outing
//   dropped  the needs the host dropped that are in force: only with three or more joined, and only needs a member other than the host has
// `rows` are the joined members' needs ({ user_id, dietary }), `saved` is Map { lower-case user id => confirmed_at | null } of the members with a
// row of their own for the outing, `dropped` the stored drops.
//
// How to call:
//   dietaryView({ me: 'aaaa…', joined: 3, hostId: 'bbbb…', rows: [{ user_id: 'aaaa…', dietary: ['vegan'] }, …], saved: new Map(), dropped: [] })
export function dietaryView({ me, joined, hostId, rows, saved, dropped }) {
  const mineRow = rows.find((r) => String(r.user_id).toLowerCase() === me)
  const mine = needsOf([mineRow?.dietary])
  const checked = (saved.get(me) ?? null) !== null
  if (joined < MIN_MEMBERS_FOR_OTHERS) return { dietary: mine, others: [], mine, checked, dropped: [] }
  return {
    dietary: effectiveNeeds({ rows, dropped, joined, hostId }),
    others: needsOf(rows.filter((r) => String(r.user_id).toLowerCase() !== me).map((r) => r.dietary)),
    mine,
    checked,
    dropped: dropsInForce({ rows, dropped, joined, hostId }),
  }
}
