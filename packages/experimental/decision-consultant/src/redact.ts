/**
 * Bounded, redacted gate state. Only the facts a risk judgment needs leave the
 * machine: the tool name and bounded arguments, with key-shaped values masked.
 *
 * @module @deepseek-ai/dsh-experimental-decision-consultant
 */

import type { GateState } from './types.ts'

/** Key names whose values are never sent to the provider. */
const SECRET_KEY = /(pass(word|phrase)?|pwd|secret|token|api[_-]?key|credential|authorization|bearer|cookie)/i

/** Marker appended to every truncated string. */
export const TRUNCATION_MARKER = '…[truncated]'

/** Maximum policy characters forwarded to the provider. */
const MAX_POLICY_CHARS = 1000

/**
 * Recursively mask secret-shaped keys and truncate long strings.
 * @param value - value to redact.
 * @param maxString - maximum characters retained per string.
 * @returns the redacted copy.
 */
export function redactValue(value: unknown, maxString: number): unknown {
  if (typeof value === 'string') {
    return value.length > maxString ? `${value.slice(0, maxString)}${TRUNCATION_MARKER}` : value
  }
  if (Array.isArray(value)) return value.map(entry => redactValue(entry, maxString))
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SECRET_KEY.test(key) ? '***' : redactValue(entry, maxString)
    }
    return output
  }
  return value
}

/**
 * Serialize redacted arguments within a total character budget.
 * @param args - raw tool arguments.
 * @param maxString - maximum characters retained per string.
 * @param maxTotal - maximum characters for the serialized result.
 * @returns the redacted JSON string.
 */
export function redactArguments(args: unknown, maxString: number, maxTotal = 4000): string {
  const serialized = args === undefined ? 'null' : JSON.stringify(redactValue(args, maxString))
  return serialized.length > maxTotal ? `${serialized.slice(0, maxTotal)}${TRUNCATION_MARKER}` : serialized
}

/**
 * Build the bounded state for one gated call.
 * @param input - tool name, raw arguments, and optional operator policy.
 * @param options - per-string truncation budget.
 * @returns the redacted state forwarded to the provider.
 */
export function buildState(
  input: { readonly name: string; readonly arguments: unknown; readonly policy?: string },
  options: { readonly maxArgChars?: number } = {},
): GateState {
  const maxArgChars = options.maxArgChars ?? 600
  const state: GateState = {
    tool: input.name,
    arguments: redactArguments(input.arguments, maxArgChars),
  }
  if (input.policy !== undefined && input.policy.length > 0) {
    return {
      ...state,
      policy: input.policy.length > MAX_POLICY_CHARS
        ? `${input.policy.slice(0, MAX_POLICY_CHARS)}${TRUNCATION_MARKER}`
        : input.policy,
    }
  }
  return state
}
