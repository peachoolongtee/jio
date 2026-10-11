import { createHash } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { clock } from '../planner/arrange.js'
import { createCallBudget } from './budget.js'
import { createCache } from './cache.js'
import { ExternalApiError } from './errors.js'

// Picks the order of an itinerary with an AI (Gemini or Claude), and says why in one sentence.
//
// The AI never invents an order. planner/arrange.js lists the orders that keep every place open and every meal on
// time, and the AI only chooses among them, by what makes a nicer day out (an activity before the café rather than
// after it, the outdoor stop while it is dry, the shops near the MRT at the end...). Its answer is checked: a choice
// that is not on the list is never used, and its sentence is used only when it is plain text.
//
// Which AI: Gemini when GEMINI_API_KEY is set (it has a free tier), else Claude when ANTHROPIC_API_KEY is set. With
// neither (or in stub mode) the service still answers: it takes the order the rules score best (travel, plus half the
// waiting, plus a penalty when the last stop is far from an MRT station), and `source` says 'rules' instead of 'ai'.
// So confirming works in every setup, and tests never call an AI.
//
// Gemini is called through services/http.js like every other API. Claude is called through Anthropic's own SDK, with
// no retries of its own. Neither is called in stub mode.
//
// Cost and time are bounded, in the way services/google-places.js bounds Google:
//   - One budget for every AI call this server makes: ITINERARY_AI_CALLS_PER_MINUTE a minute (20 by default) and at
//     most 2 in flight. A request that finds the budget used up, or two calls already running, does not wait: it is
//     answered by the rules at once.
//   - Three failures in a row pause the AI for a minute (a circuit); then one call is tried, and a success closes it.
//   - An answer is kept for 10 minutes, so the same plan asked again makes no call. The key is a hash of the provider,
//     the model, the system prompt and the prompt, so anything that could change the answer is a new key.
//   - A call takes at most 8 seconds for both providers together. After that the rules answer.
//   - A failure is logged at most once a minute per reason, with a fixed sentence and a status or an error name. Never
//     the error's own message: for a bad header value undici puts the value (the key) in it.
//
// How to call:
//   const ai = createItineraryAi({ http, geminiKey: process.env.GEMINI_API_KEY })
//   const { index, reason, source } = await ai.choose({ options, rain: false })
//   options[index] // the order to use

// Claude's model, unless ANTHROPIC_MODEL says otherwise. The names here were not checked against the live APIs.
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5'

// Gemini's model, unless GEMINI_MODEL says otherwise. A "flash" model is quick and is on the free tier.
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'
const GEMINI_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`

export const DEFAULT_ITINERARY_CALLS_PER_MINUTE = 20
export const ITINERARY_MAX_IN_FLIGHT = 2
export const ITINERARY_DEADLINE_MS = 8000 // The longest one choice may take, whichever provider answers.
export const ITINERARY_FAILURES_TO_OPEN = 3 // Failed calls in a row that open the circuit.
export const ITINERARY_CIRCUIT_OPEN_MS = 60 * 1000 // How long the AI is skipped once the circuit opens.
export const ITINERARY_CACHE_MS = 10 * 60 * 1000
export const ITINERARY_CACHE_MAX_ITEMS = 500
const WARN_EVERY_MS = 60 * 1000 // The same reason is logged at most once in this time.

// The answer is one number and one sentence of at most 200 characters: about 70 tokens as JSON. Claude's ceiling is
// that with room for the low-effort thinking that `output_config.effort: 'low'` still allows; an answer cut off by the
// ceiling is not valid JSON, so it falls back to the rules. Gemini counts its thinking tokens against its ceiling too.
export const CLAUDE_MAX_TOKENS = 400
export const GEMINI_MAX_OUTPUT_TOKENS = 512

// Changes when the system prompt or the answer format changes, so an answer cached under the old one is not reused.
export const PROMPT_VERSION = '2'

// The answer Gemini must give, in Gemini's schema format.
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    choice: { type: 'INTEGER', description: 'The number of the chosen order, as listed.' },
    reason: { type: 'STRING', description: 'One short sentence for the group.' },
  },
  required: ['choice', 'reason'],
}

// The most orders the AI is shown. The best few by score are enough to choose from, and keep the request small.
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

// The sentence of a rules answer. It claims only what is true of every order the rules list.
export const RULES_REASON = 'Every place is open and every meal is on time in this order.'

// The sentence used when the AI chose a valid order but its own sentence was not plain text.
export const NEUTRAL_REASON = 'The AI picked this order: every place is open and every meal is on time.'

// What each reason is called in the log. Never put a key, an error message or a response in these.
const FALLBACK_TEXT = {
  budget_empty: 'the AI call budget for this minute is used up',
  busy: 'two AI calls are already running',
  circuit_open: 'the AI failed several calls in a row, so it is skipped for a short while',
  deadline: 'the AI did not answer in time',
  upstream_error: 'the AI answered with an error or did not answer',
  bad_answer: 'the AI answered with something the planner cannot use',
  unexpected: 'the AI call failed in an unexpected way',
}

const KIND_WORDS = { eat: 'food', drink: 'drinks', shop: 'shopping', activity: 'activity' }

// Printable ASCII with no space: what a key may be made of.
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/

// A model name as it may appear in an address and a request: letters, digits, dots, dashes and underscores.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

// Bidirectional-control characters: they can make text read in another order than it is written.
const BIDI_CONTROL = /[؜‎‏‪-‮⁦-⁩]/gu

// Whitespace and control characters, which the prompt turns into one plain space.
const SPACE_RUN = /[\s\p{Cc}]+/gu

// A sentence from the AI is refused when it holds any of these: markup, a control, format or line-break character
// (this covers the bidirectional controls and zero-width characters), a link, or anything shaped like a domain name.
const REFUSED_REASON = /[<>]|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|:\/\/|www\.|[\p{L}\p{N}_-]\.\p{L}{2,}/iu

// Why the AI could not be used for a call. A subclass of ExternalApiError, so code that already falls back on "the
// API failed" covers it, and an uncaught one still answers 500. `reason` is a key of FALLBACK_TEXT. The message is
// fixed text: it never holds anything from the provider.
//
// How to call (this file throws it; choose() catches it):
//   try { await ask(prompt) } catch (err) { if (err instanceof ItineraryAiUnavailableError) console.log(err.reason) }
export class ItineraryAiUnavailableError extends ExternalApiError {
  constructor(reason, detail = '') {
    super(`Itinerary AI is not used (${reason})`, { service: 'itinerary-ai', status: null })
    this.name = 'ItineraryAiUnavailableError'
    this.reason = reason
    // A status such as "HTTP 429", or an error name such as "TypeError". Safe to log.
    this.detail = detail
  }
}

// A key that is trimmed and made only of printable ASCII, or null. `malformed` is true for a value that was set but
// holds a space, a control character or anything else outside printable ASCII.
//
// How to call:
//   cleanKey('  abc123 ') // { key: 'abc123', malformed: false }
//   cleanKey('ab c')      // { key: null, malformed: true }
//   cleanKey('   ')       // { key: null, malformed: false }
export function cleanKey(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') return { key: null, malformed: false }
  if (PRINTABLE_ASCII.test(value)) return { key: value, malformed: false }
  return { key: null, malformed: true }
}

// Reads the itinerary AI settings from the environment. Used by index.js at start-up.
//
// How to call:
//   const { geminiKey, anthropicKey, geminiModel, anthropicModel, callsPerMinute, warnings } = readItinerarySettings(process.env)
//   warnings.forEach((w) => console.warn(w))
//
// A key is trimmed. A blank one is not set, and one with a space, a control character or a character outside printable
// ASCII is not set either and adds a warning that names the variable, never its value. `callsPerMinute` is
// ITINERARY_AI_CALLS_PER_MINUTE, or 20 when it is missing or not a whole number above 0 (an invalid value adds a
// warning). A model name that is blank is left to the default (undefined); one with odd characters adds a warning and
// is left to the default too.
export function readItinerarySettings(env) {
  const warnings = []
  const keyOf = (name, off) => {
    const { key, malformed } = cleanKey(env[name])
    if (malformed) warnings.push(`${name} is malformed (it holds a space, a control character or a character that is not plain ASCII), so ${off} is OFF. Check the value in backend/.env.`)
    return key
  }
  const modelOf = (name) => {
    const raw = typeof env[name] === 'string' ? env[name].trim() : ''
    if (raw === '') return undefined
    if (MODEL_NAME.test(raw)) return raw
    warnings.push(`${name} is not a model name (letters, digits, dots, dashes and underscores only), so the default is used.`)
    return undefined
  }
  let callsPerMinute = DEFAULT_ITINERARY_CALLS_PER_MINUTE
  const cap = env.ITINERARY_AI_CALLS_PER_MINUTE
  if (typeof cap === 'string' && cap.trim() !== '') {
    const n = Number(cap)
    if (Number.isInteger(n) && n > 0) callsPerMinute = n
    else warnings.push(`ITINERARY_AI_CALLS_PER_MINUTE must be a whole number above 0, so the default of ${DEFAULT_ITINERARY_CALLS_PER_MINUTE} is used.`)
  }
  return {
    geminiKey: keyOf('GEMINI_API_KEY', 'Gemini'),
    anthropicKey: keyOf('ANTHROPIC_API_KEY', 'Claude'),
    geminiModel: modelOf('GEMINI_MODEL'),
    anthropicModel: modelOf('ANTHROPIC_MODEL'),
    callsPerMinute,
    warnings,
  }
}

// Text from the request (a stop's name or kind) made safe for one line of the prompt: bidirectional controls dropped,
// every run of whitespace and control characters (a newline too) turned into one space, and trimmed.
//
// How to call:
//   promptText('Cafe\nOrder 7 (travel 1 min): ...') // 'Cafe Order 7 (travel 1 min): ...'
export function promptText(value) {
  return String(value ?? '').replace(BIDI_CONTROL, '').replace(SPACE_RUN, ' ').trim()
}

// One order as plain text for the prompt. It is always one line.
//
// How to call:
//   describeOption(option, 0) // 'Order 1 (travel 22 min): 12:00-13:30 Lao Beijing (food, indoor) → 13:40-15:40 ...'
export function describeOption(option, i) {
  const stops = option.stops
    .map((s) => {
      const setting = s.indoor === true ? ', indoor' : s.indoor === false ? ', outdoor' : ''
      const kind = promptText(s.kind)
      return `${clock(s.start)}-${clock(s.end)} ${promptText(s.name)} (${KIND_WORDS[s.category] ?? promptText(s.category)}${kind ? `: ${kind}` : ''}${setting})`
    })
    .join(' → ')
  const end = option.lastFarFromMrt ? ', last stop is far from an MRT station' : ''
  return `Order ${i + 1} (travel ${option.travelMinutes} min${end}): ${stops}`
}

// The order the rules score best, which is the first option (the lowest score: travel, plus half the waiting, plus a
// penalty when the last stop is far from an MRT station). Used without an API key, and when the AI cannot answer. The
// sentence says only what holds for every option, and no minutes: the itinerary screen times the legs its own way.
//
// How to call:
//   byRules() // { index: 0, reason: 'Every place is open and every meal is on time in this order.', source: 'rules' }
function byRules() {
  return { index: 0, reason: RULES_REASON, source: 'rules' }
}

// Checks an AI's answer ({ choice, reason } as JSON text) against the orders it was shown. Returns null when the
// choice is not usable, so the rules answer. The choice must be a JSON integer from 1 to `count`. A sentence that is
// not plain text (see REFUSED_REASON) is replaced by NEUTRAL_REASON and the order is kept; one that is plain is capped
// at 200 characters. Throws SyntaxError when the text is not JSON.
//
// How to call:
//   readAnswer('{"choice":2,"reason":"A calm end."}', 6) // { index: 1, reason: 'A calm end.', source: 'ai' }
//   readAnswer('{"choice":"2","reason":"x"}', 6)          // null
export function readAnswer(text, count) {
  if (typeof text !== 'string' || text === '') return null
  const answer = JSON.parse(text)
  if (answer === null || typeof answer !== 'object') return null
  const { choice, reason } = answer
  if (!Number.isInteger(choice) || choice < 1 || choice > count) return null
  const sentence = typeof reason === 'string' ? reason.trim() : ''
  const plain = sentence !== '' && !REFUSED_REASON.test(sentence)
  return { index: choice - 1, reason: plain ? [...sentence].slice(0, 200).join('') : NEUTRAL_REASON, source: 'ai' }
}

// Thrown inside the provider boundary when the AI's answer cannot be used (not JSON, or a choice off the list).
//
// How to call (inside this file):
//   throw new UnusableAnswer()
class UnusableAnswer extends Error {}

// Thrown when the deadline for one choice passes.
//
// How to call (inside this file):
//   reject(new DeadlineError())
class DeadlineError extends Error {}

// An error's name when it is a plain word, else 'Error'. The name is safe to log; its message is not.
//
// How to call (inside this file):
//   nameOf(new TypeError('x')) // 'TypeError'
const nameOf = (err) => (typeof err?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : 'Error')

// Turns anything thrown inside the provider boundary into an ItineraryAiUnavailableError, with a reason and a detail
// that are safe to log.
//
// How to call (inside this file):
//   throw unavailableFrom(err)
function unavailableFrom(err) {
  if (err instanceof ItineraryAiUnavailableError) return err
  if (err instanceof DeadlineError || err instanceof Anthropic.APIUserAbortError || err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ItineraryAiUnavailableError('deadline')
  }
  if (err instanceof UnusableAnswer || err instanceof SyntaxError) return new ItineraryAiUnavailableError('bad_answer')
  if (err instanceof ExternalApiError || err instanceof Anthropic.APIError) {
    // The HTTP helper words its own timeout "timed out after Nms". Only this regex reads the message.
    if (err instanceof ExternalApiError && err.status === null && /timed out/.test(err.message)) return new ItineraryAiUnavailableError('deadline')
    const status = Number.isInteger(err.status) ? err.status : null
    return new ItineraryAiUnavailableError('upstream_error', status !== null ? `HTTP ${status}` : 'no response')
  }
  return new ItineraryAiUnavailableError('unexpected', nameOf(err))
}

// Options:
//   geminiKey      - GEMINI_API_KEY (see readItinerarySettings). When set, Gemini chooses.
//   geminiModel    - GEMINI_MODEL, or DEFAULT_GEMINI_MODEL.
//   http           - the shared HTTP helper (services/http.js), for Gemini.
//   apiKey         - ANTHROPIC_API_KEY. Used when there is no Gemini key.
//   anthropicModel - ANTHROPIC_MODEL, or DEFAULT_ANTHROPIC_MODEL.
//   client         - an Anthropic client to use instead of building one (tests pass a fake).
//   stub           - true never calls an AI.
//   callsPerMinute - The budget for every AI call from this server. Default 20.
//   deadlineMs     - The longest one choice may take. Default 8000. Tests shorten it.
//   now            - Returns the time in milliseconds. Tests pass a fake clock; it moves the budget, the circuit, the
//                    cache and the log's once-a-minute rule.
//   warn           - Where failures are logged, at most once a minute per reason. Defaults to console.warn.
//   cacheMaxItems  - The most answers kept. Default 500.
// A key that holds a space or a control character counts as not set. With no usable key at all, every choice is made
// by the rules above.
export function createItineraryAi({
  geminiKey: rawGeminiKey = null,
  geminiModel = DEFAULT_GEMINI_MODEL,
  http = null,
  apiKey: rawApiKey = null,
  anthropicModel = DEFAULT_ANTHROPIC_MODEL,
  client = null,
  stub = false,
  callsPerMinute = DEFAULT_ITINERARY_CALLS_PER_MINUTE,
  deadlineMs = ITINERARY_DEADLINE_MS,
  now = Date.now,
  warn = (...args) => console.warn(...args),
  cacheMaxItems = ITINERARY_CACHE_MAX_ITEMS,
} = {}) {
  const geminiKey = cleanKey(rawGeminiKey).key
  const apiKey = cleanKey(rawApiKey).key
  const provider = stub ? null : geminiKey && http ? 'gemini' : client || apiKey ? 'claude' : null
  const deadline = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : ITINERARY_DEADLINE_MS
  // No retries: a retry could sleep as long as the provider's retry-after header says, far past the deadline.
  const anthropic = provider === 'claude' ? client ?? new Anthropic({ apiKey, timeout: deadline, maxRetries: 0 }) : null
  const model = provider === 'gemini' ? geminiModel : anthropicModel

  const budget = createCallBudget({
    callsPerMinute: Number.isInteger(callsPerMinute) && callsPerMinute > 0 ? callsPerMinute : DEFAULT_ITINERARY_CALLS_PER_MINUTE,
    maxInFlight: ITINERARY_MAX_IN_FLIGHT,
    now,
    service: 'itinerary AI',
    unavailable: (reason) => new ItineraryAiUnavailableError(reason),
  })
  const cache = createCache({ ttlMs: ITINERARY_CACHE_MS, maxItems: cacheMaxItems, now })
  const circuit = { failures: 0, openUntil: 0, probing: false }
  const lastWarned = new Map() // reason -> time of the last log line
  let inFlight = 0

  // Runs `run(signal)` and gives up at the deadline: the signal is aborted and the promise rejects with DeadlineError,
  // even when `run` ignores the signal.
  //
  // How to call (inside this file):
  //   const text = await withDeadline((signal) => askClaude(prompt, signal))
  function withDeadline(run) {
    const controller = new AbortController()
    let timer
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new DeadlineError())
      }, deadline)
    })
    return Promise.race([(async () => run(controller.signal))(), expired]).finally(() => clearTimeout(timer))
  }

  // Asks Gemini. Returns its answer text, or '' when it sent none (a blocked answer has no candidates). The address and
  // the headers carry no text from the request.
  //
  // How to call (inside this file):
  //   const text = await askGemini(prompt)
  async function askGemini(prompt) {
    const body = await http.postJson(
      GEMINI_URL(geminiModel),
      {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // Low thinking: choosing one of a few orders needs little, and medium (the default) can take over 20 seconds.
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_SCHEMA,
          thinkingConfig: { thinkingLevel: 'low' },
          maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        },
      },
      // The key goes in a header, not the address, so it never appears in an error message or a log.
      { headers: { 'x-goog-api-key': geminiKey }, timeoutMs: deadline },
    )
    return (body?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')
  }

  // Asks Claude. Returns its answer text, or null when it declined. No retries, and the call is aborted at the deadline.
  //
  // How to call (inside this file):
  //   const text = await askClaude(prompt, signal)
  async function askClaude(prompt, signal) {
    const response = await anthropic.beta.messages.create(
      {
        model: anthropicModel,
        max_tokens: CLAUDE_MAX_TOKENS,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: ANSWER_FORMAT },
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal, maxRetries: 0 },
    )
    if (response.stop_reason === 'refusal') return null
    return response.content.find((b) => b.type === 'text')?.text ?? null
  }

  // Refuses while the circuit is open. Once the pause is over, lets exactly one call through as a probe.
  // Returns true when this call is that probe.
  //
  // How to call (inside this file):
  //   const probe = claimCircuit() // throws ItineraryAiUnavailableError('circuit_open') while paused
  function claimCircuit() {
    if (circuit.failures < ITINERARY_FAILURES_TO_OPEN) return false
    if (now() < circuit.openUntil || circuit.probing) throw new ItineraryAiUnavailableError('circuit_open')
    circuit.probing = true
    return true
  }

  // Asks the AI once, within the budget, the circuit and the deadline. Everything thrown from the provider, or from
  // reading its answer, comes out as ItineraryAiUnavailableError and counts as a failure for the circuit.
  //
  // How to call (inside this file):
  //   const { index, reason, source } = await ask(prompt, 6)
  async function ask(prompt, count) {
    // Never queue behind other calls: a request that finds both slots taken is answered by the rules at once.
    if (inFlight >= ITINERARY_MAX_IN_FLIGHT) throw new ItineraryAiUnavailableError('busy')
    const probe = claimCircuit()
    inFlight += 1
    try {
      return await budget.run(async () => {
        try {
          const text = await withDeadline((signal) => (provider === 'gemini' ? askGemini(prompt) : askClaude(prompt, signal)))
          const answer = readAnswer(text, count)
          if (!answer) throw new UnusableAnswer()
          circuit.failures = 0
          return answer
        } catch (err) {
          circuit.failures += 1
          // After the pause one more failure opens it again straight away, so a still-sick AI is probed by one call.
          if (circuit.failures >= ITINERARY_FAILURES_TO_OPEN) circuit.openUntil = now() + ITINERARY_CIRCUIT_OPEN_MS
          throw unavailableFrom(err)
        }
      })
    } finally {
      inFlight -= 1
      if (probe) circuit.probing = false
    }
  }

  // Logs why the AI was not used, at most once a minute per reason. Never logs a key, an error message or a response.
  //
  // How to call (inside this file):
  //   report(err) // err is an ItineraryAiUnavailableError
  function report({ reason, detail }) {
    const t = now()
    const last = lastWarned.get(reason)
    if (last !== undefined && t - last < WARN_EVERY_MS) return
    lastWarned.set(reason, t)
    warn(`Itinerary AI (${provider}) is not used (${reason}): ${FALLBACK_TEXT[reason] ?? reason}${detail ? ` [${detail}]` : ''}. The plan gets the order the rules score best.`)
  }

  // Chooses one of `options` (best first by score). Never throws because the AI is down, slow, paused or over budget:
  // it falls back to the rules, at once, and never waits more than the deadline. An error that is not about the AI
  // (a bug in this code or in the options) still propagates.
  //
  // How to call:
  //   await ai.choose({ options, rain: true })
  //   // { index: 2, reason: 'Bowling first keeps you dry; the café is a calm end near the MRT.', source: 'ai' }
  async function choose({ options, rain = false }) {
    if (options.length === 0) throw new Error('There is no order to choose from.')
    const shown = options.slice(0, MAX_OPTIONS_SHOWN)
    if (!provider || shown.length === 1) return byRules()

    const weather = rain ? 'Rain is expected today.' : 'No rain is expected today.'
    const prompt = `${weather}\n\n${shown.map(describeOption).join('\n')}`
    const key = createHash('sha256').update(JSON.stringify([provider, model, PROMPT_VERSION, SYSTEM, prompt])).digest('hex')
    try {
      const answer = await cache.getOrSet(key, () => ask(prompt, shown.length))
      return { ...answer }
    } catch (err) {
      if (!(err instanceof ItineraryAiUnavailableError)) throw err
      report(err)
      return byRules()
    }
  }

  return { enabled: Boolean(provider), provider, choose, cacheSize: cache.size }
}
