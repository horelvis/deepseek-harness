/**
 * Prepended `tools/pre-execute` gate. The host decides first (`next()`); the
 * consultant then adds a conservative Jev/Kev second opinion. It can only
 * harden that decision — `deny` or `ask` — and never grants approval. Provider
 * failures never grant permission and, by default, change nothing.
 *
 * @module @deepseek-ai/dsh-experimental-decision-consultant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { buildQuestions, DEFAULT_THRESHOLDS, evaluate, type Thresholds } from './policy.ts'
import { resolveProvider, type ProviderConfig } from './provider.ts'
import { buildState } from './redact.ts'
import { consultSystemOne } from './systemone.ts'
import { appendDecision, resolveLogPath } from './log.ts'
import type { Config } from './index.ts'
import type { AnswerMap, ConsultResult, GateState, Hardening, QuestionMap } from './types.ts'

/** Migrator write tools gated by default. */
export const MIGRATOR_WRITE_TOOLS = [
  'migrator_target',
  'migrator_run_steps',
  'migrator_backup',
  'migrator_reindex',
  'migrator_provision',
  'migrator_copy_content',
  'migrator_wizard',
] as const

/** Injectable seams for tests. */
export interface GateDeps {
  /** Provider call; defaults to {@link consultSystemOne}. */
  readonly consult?: (state: GateState, questions: QuestionMap, signal: AbortSignal) => Promise<ConsultResult>
  /** Decision sink; defaults to {@link appendDecision}. */
  readonly log?: (logPath: string, record: Record<string, unknown>) => Promise<void>
}

interface Resolved {
  readonly mode: 'off' | 'shadow' | 'enforce'
  readonly tools: ReadonlySet<string>
  readonly provider: ProviderConfig
  readonly thresholds: Thresholds
  readonly timeoutMs: number
  readonly failMode: 'open' | 'closed-to-ask'
  readonly policy?: string
  readonly logPath: string
  readonly maxArgChars: number
}

/** Fold validated config and environment into one resolved shape. */
function resolve(config: Config): Resolved {
  const thresholds: Thresholds = {
    selfAdvocating: config.selfAdvocatingThreshold ?? DEFAULT_THRESHOLDS.selfAdvocating,
    secrets: config.secretsThreshold ?? DEFAULT_THRESHOLDS.secrets,
    outbound: config.outboundThreshold ?? DEFAULT_THRESHOLDS.outbound,
    exfiltration: config.exfiltrationThreshold ?? DEFAULT_THRESHOLDS.exfiltration,
    destructive: config.destructiveThreshold ?? DEFAULT_THRESHOLDS.destructive,
    impact: config.impactThreshold ?? DEFAULT_THRESHOLDS.impact,
  }
  const provider = resolveProvider({
    ...(config.provider === undefined ? {} : { provider: config.provider }),
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.keyEnv === undefined ? {} : { keyEnv: config.keyEnv }),
  })
  return {
    mode: config.mode ?? 'shadow',
    tools: new Set(config.tools ?? [...MIGRATOR_WRITE_TOOLS]),
    provider,
    thresholds,
    timeoutMs: config.timeoutMs ?? 3000,
    failMode: config.failMode ?? 'open',
    ...(config.policy === undefined ? {} : { policy: config.policy }),
    logPath: resolveLogPath(config.logPath === undefined ? {} : { logPath: config.logPath }),
    maxArgChars: config.maxArgChars ?? 600,
  }
}

interface Outcome {
  readonly hardening?: Hardening
  readonly answers?: AnswerMap
  readonly error?: string
  readonly latencyMs?: number
}

/** One consultation that never throws: failures become an error outcome. */
async function run(
  consult: (state: GateState, questions: QuestionMap, signal: AbortSignal) => Promise<ConsultResult>,
  thresholds: Thresholds,
  state: GateState,
  questions: QuestionMap,
  signal: AbortSignal,
): Promise<Outcome> {
  try {
    const result = await consult(state, questions, signal)
    const hardening = evaluate(result.answers, thresholds)
    return {
      ...(hardening === undefined ? {} : { hardening }),
      answers: result.answers,
      latencyMs: result.latencyMs,
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Build one durable decision record. */
function record(
  resolved: Resolved,
  exec: ToolExecution,
  downstream: PreToolDecision,
  outcome: Outcome,
): Record<string, unknown> {
  return {
    at: new Date().toISOString(),
    tool: exec.name,
    mode: resolved.mode,
    provider: resolved.provider.provider,
    model: resolved.provider.model,
    downstream: downstream.kind,
    hardening: outcome.hardening?.kind,
    rule: outcome.hardening?.reason,
    error: outcome.error,
    answers: outcome.answers,
    latencyMs: outcome.latencyMs,
  }
}

/** Write one record; logging failures never change approval behavior. */
async function emit(
  log: (logPath: string, record: Record<string, unknown>) => Promise<void>,
  logPath: string,
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    await log(logPath, entry)
  } catch {
    // The audit sink is best-effort; the gate's decision is already made.
  }
}

/** Apply the conservative hardening on top of the host decision. */
function harden(downstream: PreToolDecision, outcome: Outcome, resolved: Resolved): PreToolDecision {
  if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream
  if (outcome.hardening === undefined) {
    if (outcome.error !== undefined && resolved.failMode === 'closed-to-ask') {
      return {
        kind: 'ask',
        reason: `Decision consultant no disponible (${outcome.error}); confirma manualmente.`,
        title: 'Revisar con Jev/Kev',
        details: [`Proveedor ${resolved.provider.provider} sin respuesta utilizable.`],
      }
    }
    return downstream
  }
  if (outcome.hardening.kind === 'deny') {
    return { kind: 'deny', reason: `Decision consultant: ${outcome.hardening.reason}` }
  }
  return {
    kind: 'ask',
    reason: `Decision consultant: ${outcome.hardening.reason}`,
    title: 'Revisar con Jev/Kev',
    details: [outcome.hardening.reason],
  }
}

/**
 * Install the prepended consultation gate.
 * @param ctx - Host context carrying the tools registry.
 * @param config - validated plugin configuration.
 * @param deps - injectable provider and log seams (tests).
 */
export function installGate(ctx: Context, config: Config = {}, deps: GateDeps = {}): void {
  const resolved = resolve(config)
  if (resolved.mode === 'off') return
  const log = deps.log ?? appendDecision
  const consult = deps.consult ?? ((state, questions, signal) => consultSystemOne(state, questions, {
    baseUrl: resolved.provider.baseUrl,
    model: resolved.provider.model,
    ...(resolved.provider.apiKey === undefined ? {} : { apiKey: resolved.provider.apiKey }),
    timeoutMs: resolved.timeoutMs,
  }, signal))

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const downstream = await next()
    if (!resolved.tools.has(exec.name)) return downstream
    const state = buildState(
      {
        name: exec.name,
        arguments: exec.arguments,
        ...(resolved.policy === undefined ? {} : { policy: resolved.policy }),
      },
      { maxArgChars: resolved.maxArgChars },
    )
    const questions = buildQuestions(resolved.policy)
    if (resolved.mode === 'shadow') {
      void run(consult, resolved.thresholds, state, questions, exec.signal)
        .then(outcome => emit(log, resolved.logPath, record(resolved, exec, downstream, outcome)))
      return downstream
    }
    const outcome = await run(consult, resolved.thresholds, state, questions, exec.signal)
    await emit(log, resolved.logPath, record(resolved, exec, downstream, outcome))
    return harden(downstream, outcome, resolved)
  }, { prepend: true })
}
