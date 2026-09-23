/**
 * Experimental decision consultant: a Jev/Kev (System One) second opinion
 * before configured tool calls. Installed unchanged from the host policy;
 * defaults to shadow and never grants approval.
 *
 * @module @deepseek-ai/dsh-experimental-decision-consultant
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installGate } from './gate.ts'
import type { ProviderName } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'decision-consultant'

/** The tools registry owns the pre-execute waterfall this gate prepends to. */
export const inject = ['tools']

/** Loader-validated plugin configuration. Every field has a safe default. */
export interface Config {
  /** `shadow` (default) logs only; `enforce` applies deny/ask; `off` installs nothing. */
  readonly mode?: 'off' | 'shadow' | 'enforce'
  /** System One provider preset. */
  readonly provider?: ProviderName
  /** Explicit endpoint; required for `custom`. */
  readonly baseUrl?: string
  /** Model id; defaults to the provider preset. */
  readonly model?: string
  /** Environment variable holding the bearer credential. */
  readonly keyEnv?: string
  /** Tool names to gate; defaults to the migrator write tools. */
  readonly tools?: string[]
  /** Per-attempt request timeout in milliseconds. */
  readonly timeoutMs?: number
  /** On a provider failure: `open` keeps the host decision; `closed-to-ask` escalates. */
  readonly failMode?: 'open' | 'closed-to-ask'
  /** Optional operator policy text forwarded to the model. */
  readonly policy?: string
  /** Explicit decision-log path. */
  readonly logPath?: string
  /** Per-string argument truncation budget. */
  readonly maxArgChars?: number
  /** Probability that the call text argues for its own approval. */
  readonly selfAdvocatingThreshold?: number
  /** Probability that the call reads or copies credentials. */
  readonly secretsThreshold?: number
  /** Probability that the call sends content off-machine. */
  readonly outboundThreshold?: number
  /** Probability that sensitive data crosses a trust boundary. */
  readonly exfiltrationThreshold?: number
  /** Probability that the call is destructive. */
  readonly destructiveThreshold?: number
  /** Severity score at which destructive calls escalate. */
  readonly impactThreshold?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  mode: z.union([z.const('off'), z.const('shadow'), z.const('enforce')]).default('shadow'),
  provider: z.union([
    z.const('opencode-zen'),
    z.const('kev'),
    z.const('typesafe'),
    z.const('openrouter'),
    z.const('custom'),
  ]).default('opencode-zen'),
  baseUrl: z.string(),
  model: z.string(),
  keyEnv: z.string(),
  tools: z.array(z.string()).default([
    'migrator_target',
    'migrator_run_steps',
    'migrator_backup',
    'migrator_reindex',
    'migrator_provision',
    'migrator_copy_content',
    'migrator_wizard',
  ]),
  timeoutMs: z.number().default(3000),
  failMode: z.union([z.const('open'), z.const('closed-to-ask')]).default('open'),
  policy: z.string(),
  logPath: z.string(),
  maxArgChars: z.number().default(600),
  selfAdvocatingThreshold: z.number().default(0.6),
  secretsThreshold: z.number().default(0.7),
  outboundThreshold: z.number().default(0.7),
  exfiltrationThreshold: z.number().default(0.7),
  destructiveThreshold: z.number().default(0.9),
  impactThreshold: z.number().default(2),
})

/**
 * @param ctx - Host context carrying the tools registry.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  installGate(ctx, config)
}
