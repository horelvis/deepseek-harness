/**
 * Minimal System One client. One POST carries the bounded state and typed
 * questions; the endpoint returns one typed answer per question id. The
 * transport is identical for Kev (local), Jev (OpenCode Zen / TypeSafe /
 * OpenRouter), and any Jev-compatible endpoint.
 *
 * @module @deepseek-ai/dsh-experimental-decision-consultant
 */

import type { AnswerMap, ConsultResult, GateState, QuestionMap } from './types.ts'

/** Provider failure that never grants permission. */
export class ConsultError extends Error {
  /** HTTP status when the failure was a non-2xx response. */
  readonly status?: number

  /**
   * @param message - human-readable failure.
   * @param status - HTTP status when the failure was a non-2xx response.
   */
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ConsultError'
    if (status !== undefined) this.status = status
  }
}

/** Resolved transport settings plus injectable seams for tests. */
export interface ConsultConfig {
  readonly baseUrl: string
  readonly model: string
  readonly apiKey?: string
  readonly timeoutMs: number
  /** Maximum Retry-After wait before giving up on a 429/529 retry. */
  readonly retryMaxWaitMs?: number
  /** Injectable delay; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * Parse a Retry-After header into milliseconds.
 * @param value - raw header value (seconds or HTTP date).
 * @param nowMs - current epoch milliseconds for the date form.
 * @returns the wait in milliseconds, or `undefined` when absent or unparseable.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs)
}

/** First present request id header. */
function requestIdOf(response: Response): string | undefined {
  return response.headers.get('x-typesafe-request-id')
    ?? response.headers.get('x-request-id')
    ?? undefined
}

/**
 * Ask the configured model one batch of typed questions about one state.
 * @param state - bounded, redacted state.
 * @param questions - typed questions keyed by id.
 * @param config - resolved route and transport seams.
 * @param signal - caller cancellation, fused with the request timeout.
 * @returns typed answers.
 * @throws ConsultError on a non-2xx response or a malformed body; the caller
 *   keeps the host decision (never the model's silence as approval).
 */
export async function consultSystemOne(
  state: GateState,
  questions: QuestionMap,
  config: ConsultConfig,
  signal: AbortSignal,
): Promise<ConsultResult> {
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const now = config.now ?? (() => Date.now())
  const retryMaxWaitMs = config.retryMaxWaitMs ?? 2000
  const started = now()

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.apiKey !== undefined) headers.authorization = `Bearer ${config.apiKey}`
  const body = JSON.stringify({ model: config.model, state, questions })

  const attempt = (): Promise<Response> =>
    globalThis.fetch(config.baseUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    })

  let response = await attempt()
  if (response.status === 429 || response.status === 529) {
    const wait = parseRetryAfter(response.headers.get('retry-after'), now())
    if (wait !== undefined && wait <= retryMaxWaitMs) {
      await sleep(wait)
      response = await attempt()
    }
  }
  if (!response.ok) throw new ConsultError(`decision endpoint responded ${response.status}`, response.status)

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new ConsultError('decision endpoint returned a non-JSON body')
  }
  const answers = (parsed as { readonly answers?: unknown }).answers
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new ConsultError('decision endpoint returned no typed answers')
  }
  const requestId = requestIdOf(response)
  return {
    answers: answers as AnswerMap,
    latencyMs: Math.max(0, now() - started),
    ...(requestId === undefined ? {} : { requestId }),
  }
}
