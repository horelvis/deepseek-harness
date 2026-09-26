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
import { buildQuestions, DEFAULT_THRESHOLDS, evaluate, scoreSummary, type Thresholds } from './policy.ts'
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

/** One consultation call over a state and its questions. */
export type Consult = (state: GateState, questions: QuestionMap, signal: AbortSignal) => Promise<ConsultResult>

/** Injectable seams for tests. */
export interface GateDeps {
  /** Provider call; defaults to {@link consultSystemOne}. */
  readonly consult?: Consult
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
    timeoutMs: config.timeoutMs ?? 8000,
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
  const scores = scoreSummary(outcome.answers)
  const finding = `Jev/Kev: ${outcome.hardening.reason}${scores ? ` · ${scores}` : ''}`
  if (outcome.hardening.kind === 'deny') {
    return { kind: 'deny', reason: `Decision consultant: ${outcome.hardening.reason}${scores ? ` (${scores})` : ''}` }
  }
  // The host already asks: KEEP its reason/title/details/body (what is being approved) and ADD the
  // consultant's finding. Replacing it would leave the human approving blind.
  if (downstream.kind === 'ask') {
    return { ...downstream, details: [...(downstream.details ?? []), finding] }
  }
  return {
    kind: 'ask',
    reason: `Decision consultant: ${outcome.hardening.reason}`,
    title: 'Revisar con Jev/Kev',
    details: [finding],
  }
}

/** Settings namespace this plugin owns and reads live. */
export const DECISION_CONSULTANT_NAMESPACE = 'decision-consultant'

/** Live-config handle so the settings scope can drive the gate without a reload. */
export interface GateHandle {
  /**
   * Replace the live config source (the settings scope); the composition entry
   * remains the fallback. An unusable value keeps the last good resolution.
   * @param current - thunk returning the currently authoritative config.
   */
  setSource(current: () => Config): void
}

/**
 * Install the prepended consultation gate.
 * @param ctx - Host context carrying the tools registry.
 * @param config - validated composition-entry configuration (fallback source).
 * @param deps - injectable provider and log seams (tests).
 * @returns the live-config handle the settings scope binds.
 */
export function installGate(ctx: Context, config: Config = {}, deps: GateDeps = {}): GateHandle {
  let resolved = resolve(config)
  const log = deps.log ?? appendDecision
  const injected = deps.consult
  const consultFor = (current: Resolved): Consult =>
    injected ?? ((state, questions, signal) => consultSystemOne(state, questions, {
      baseUrl: current.provider.baseUrl,
      model: current.provider.model,
      ...(current.provider.apiKey === undefined ? {} : { apiKey: current.provider.apiKey }),
      timeoutMs: current.timeoutMs,
    }, signal))

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const downstream = await next()
    const current = resolved
    if (current.mode === 'off' || !current.tools.has(exec.name)) return downstream
    const state = buildState(
      {
        name: exec.name,
        arguments: exec.arguments,
        ...(current.policy === undefined ? {} : { policy: current.policy }),
      },
      { maxArgChars: current.maxArgChars },
    )
    const questions = buildQuestions(current.policy)
    const consult = consultFor(current)
    if (current.mode === 'shadow') {
      void run(consult, current.thresholds, state, questions, exec.signal)
        .then(outcome => emit(log, current.logPath, record(current, exec, downstream, outcome)))
      return downstream
    }
    const outcome = await run(consult, current.thresholds, state, questions, exec.signal)
    await emit(log, current.logPath, record(current, exec, downstream, outcome))
    return harden(downstream, outcome, current)
  }, { prepend: true })

  return {
    setSource: (source) => {
      try {
        resolved = resolve(source())
      } catch {
        // An unusable live value keeps the last good resolution (settings semantics).
      }
    },
  }
}
