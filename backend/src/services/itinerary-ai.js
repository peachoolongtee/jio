import Anthropic from '@anthropic-ai/sdk'

// Picks one rearranged itinerary with Claude, and says why in one sentence.
//
// Claude never invents an order. planner/arrange.js lists the orders that keep every place open and every meal on
// time, and Claude only chooses among them, by what makes a nicer day out (an activity before the café rather than
// after it, the outdoor stop while it is dry, the shops near the MRT at the end...). Its answer is checked: a choice
// that is not on the list is never used.
//
// Without ANTHROPIC_API_KEY (or in stub mode) the service still answers: it takes the order with the least travel,
// and `source` says 'rules' instead of 'ai'. So confirming works in every setup, and tests never call Claude.
//
// This is the one external call that does not go through services/http.js: Anthropic's own SDK sends it, with its
// own timeout and retries. It is never made in stub mode.
//
// How to call:
//   const ai = createItineraryAi({ apiKey: process.env.ANTHROPIC_API_KEY })
//   const { index, reason, source } = await ai.choose({ options, rain: false })
//   options[index] // the order to use

export const MODEL = 'claude-opus-5-5'

// The most orders Claude is shown. The best few by travel are enough to choose from, and keep the request small.
export const MAX_OPTIONS_SHOWN = 6

const SYSTEM = `You help a group of friends in Singapore order the stops of a day out.
You are given a few possible orders of the same stops. Every order is already checked: each place is open while the group is there and each meal is at a normal time. Choose the order that makes the most enjoyable day, thinking about the flow (for example, active things before relaxing ones, the outdoor stop while it is dry, a café or bar as a wind-down, ending somewhere easy to get home from), and less travel when the orders are otherwise similar.
Answer with the number of the order you choose and one short sentence (at most 25 words) for the group saying why. Do not mention clock times or numbers of minutes.`

// The answer Claude must give, checked by the API.
const ANSWER_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      choice: { type: 'integer', description: 'The number of the chosen order, as listed.' },
      reason: { type: 'string', description: 'One short sentence for the group.' },
    },
    required: ['choice', 'reason'],
    additionalProperties: false,
  },
}

const clock = (minutes) => {
  const m = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

const KIND_WORDS = { eat: 'food', drink: 'drinks', shop: 'shopping', activity: 'activity' }

// One order as plain text for the prompt.
//
// How to call:
//   describeOption(option, 0) // 'Order 1 (travel 22 min): 12:00 Lao Beijing (food, indoor) → 13:40 ...'
export function describeOption(option, i) {
  const stops = option.stops
    .map((s) => {
      const setting = s.indoor === true ? ', indoor' : s.indoor === false ? ', outdoor' : ''
      return `${clock(s.start)}-${clock(s.end)} ${s.name} (${KIND_WORDS[s.category] ?? s.category}${s.kind ? `: ${s.kind}` : ''}${setting})`
    })
    .join(' → ')
  const end = option.lastFarFromMrt ? ', last stop is far from an MRT station' : ''
  return `Order ${i + 1} (travel ${option.travelMinutes} min${end}): ${stops}`
}

// The order with the least travel, with a plain reason. Used without an API key, and when Claude cannot answer.
// The reason names no minutes: the itinerary screen times the legs its own way, so a number here could disagree.
function byRules(options) {
  const best = options[0]
  const reason =
    best.travelMinutes <= 10 ? 'This order keeps every stop a short walk from the next.' : 'Every place is open on time in this order, with little travel between stops.'
  return { index: 0, reason, source: 'rules' }
}

// Options:
//   apiKey  - ANTHROPIC_API_KEY. Without it (or with `stub`), every choice is made by the rules above.
//   stub    - true never calls Claude.
//   client  - an Anthropic client to use instead of building one (tests pass a fake).
export function createItineraryAi({ apiKey = null, stub = false, client = null } = {}) {
  const enabled = !stub && (Boolean(client) || Boolean(apiKey))
  const anthropic = enabled ? client ?? new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 }) : null

  // Chooses one of `options` (best first by travel). Never throws because Claude is down: it falls back to the rules.
  //
  // How to call:
  //   await ai.choose({ options, rain: true })
  //   // { index: 2, reason: 'Bowling first keeps you dry; the café is a calm end near the MRT.', source: 'ai' }
  async function choose({ options, rain = false }) {
    if (options.length === 0) throw new Error('There is no order to choose from.')
    const shown = options.slice(0, MAX_OPTIONS_SHOWN)
    if (!anthropic || shown.length === 1) return byRules(shown)

    const weather = rain ? 'Rain is expected today.' : 'No rain is expected today.'
    const prompt = `${weather}\n\n${shown.map(describeOption).join('\n')}`
    try {
      const response = await anthropic.beta.messages.create({
        model: MODEL,
        max_tokens: 2000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: ANSWER_FORMAT },
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      })
      if (response.stop_reason === 'refusal') return byRules(shown)
      const text = response.content.find((b) => b.type === 'text')?.text
      const answer = text ? JSON.parse(text) : null
      const index = Number(answer?.choice) - 1
      const reason = typeof answer?.reason === 'string' ? answer.reason.trim().slice(0, 200) : ''
      if (!Number.isInteger(index) || index < 0 || index >= shown.length || !reason) return byRules(shown)
      return { index, reason, source: 'ai' }
    } catch (err) {
      // Claude being down, slow or out of credit is not the caller's problem: the rules answer instead.
      // A bug in this code is not hidden.
      if (!(err instanceof Anthropic.APIError) && !(err instanceof SyntaxError)) throw err
      console.warn(`Itinerary AI unavailable, using the rules: ${err.message}`)
      return byRules(shown)
    }
  }

  return { enabled, choose }
}
