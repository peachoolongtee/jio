import { NEEDS } from '../db/sessions.js'

// What an outing's dietary needs look like to one member (ticket #107, and the changes for one outing). Pure functions over the rows the server
// reads (db/sessions.js loadOutingDietary); GET and PUT /api/sessions/:id/dietary answer with them. The privacy rule is here: a need is private
// (profile_private is read by its owner and the server only), so no answer says whose a need is, how many people have it, or anything else of a
// member's private row, and with fewer than three joined nobody else's needs are told.
//
// How to call:
//   const view = dietaryView({ me: userId, joined: 3, rows, saved, dropped })
//   // { dietary: ['halal'], others: ['halal'], mine: [], checked: false, dropped: [] }

// How many joined members an outing needs before the others' needs are told to a member. With fewer, the others' list would be one known
// person's own list (two members), so it is empty. How to call: joined >= MIN_MEMBERS_FOR_OTHERS
export const MIN_MEMBERS_FOR_OTHERS = 3

// Needs from many lists, each once, in the app's order. How to call: needsOf([['vegan'], ['halal', 'vegan'], null]) -> ['halal', 'vegan']
export const needsOf = (lists) => NEEDS.filter((need) => lists.some((list) => Array.isArray(list) && list.includes(need)))

// The needs in `list` that are not in `taken`, in the app's order. How to call: without(['halal', 'vegan'], ['vegan']) -> ['halal']
export const without = (list, taken) => list.filter((need) => !taken.includes(need))

// Do two lists of needs hold the same needs? How to call: sameNeeds(['vegan', 'halal'], ['halal', 'vegan']) -> true
export const sameNeeds = (a, b) => needsOf([a]).join() === needsOf([b]).join()

// The needs the group is planned for: everyone's together, without the ones the host dropped. How to call: effectiveNeeds(rows, ['halal'])
export const effectiveNeeds = (rows, dropped) => without(needsOf(rows.map((r) => r.dietary)), dropped)

// The answer for one member.
//   dietary  the group's needs in effect (everyone's for the outing, without the dropped ones)
//   others   everyone's but the caller's, dropped ones included so the host can take a drop back; empty under three joined
//   mine     the caller's own needs for the outing (their row for it, else their profile's)
//   checked  whether the caller confirmed their needs for this outing
//   dropped  the needs the host dropped, only while three or more have joined and only those someone has (the caller's own included): with
//            fewer, naming a dropped need would tell the caller it is the other person's
// `rows` are the joined members' needs ({ user_id, dietary }), `saved` is Map { lower-case user id => confirmed_at | null } of the members with a
// row of their own for the outing, `dropped` the host's dropped needs.
//
// How to call:
//   dietaryView({ me: 'aaaa…', joined: 3, rows: [{ user_id: 'aaaa…', dietary: ['vegan'] }, …], saved: new Map(), dropped: [] })
export function dietaryView({ me, joined, rows, saved, dropped }) {
  const mineRow = rows.find((r) => String(r.user_id).toLowerCase() === me)
  const enough = joined >= MIN_MEMBERS_FOR_OTHERS
  const others = enough ? needsOf(rows.filter((r) => String(r.user_id).toLowerCase() !== me).map((r) => r.dietary)) : []
  const everyones = needsOf(rows.map((r) => r.dietary))
  return {
    dietary: without(everyones, dropped),
    others,
    mine: needsOf([mineRow?.dietary]),
    checked: (saved.get(me) ?? null) !== null,
    dropped: enough ? dropped.filter((need) => everyones.includes(need)) : [],
  }
}
